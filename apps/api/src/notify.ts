import { buttonPayload, renderTemplateBody, TEMPLATES, type TemplateKey } from '@instantlead/config';
import { formatSlot } from '@instantlead/core';
import { ChannelError, type CalendarProvider, type EmailProvider } from '@instantlead/integrations';
import { and, eq } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Tx } from './db/client.ts';
import { ACTIVE_APPOINTMENT_STATUSES, appointments, leads, templates } from './db/schema.ts';
import type { JobData } from './jobs.ts';
import { channelFor, sendToLead, type MessagingDeps } from './outbound.ts';

export interface NotifyDeps extends MessagingDeps {
  email: EmailProvider;
  /** The tenant's calendar if they connected one, else null. */
  calendarFor: (tx: Tx, tenantId: string) => Promise<CalendarProvider | null>;
}

/**
 * After an appointment changes: tell the lead (approved template), alert staff
 * (WhatsApp template or email, per config) and sync the tenant's calendar.
 * Each step is idempotent so job retries are safe.
 */
export async function notifyAppointmentChange(deps: NotifyDeps, job: JobData['appointment-notify']) {
  const { tenantId, appointmentId, kind } = job;
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [appt] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
    if (!appt) return null;
    const [lead] = await tx.select().from(leads).where(eq(leads.id, appt.leadId));
    const config = (await getActiveConfig(tx))?.config;
    const calendar = await deps.calendarFor(tx, tenantId);
    return lead && config ? { appt, lead, config, calendar } : null;
  });
  if (!loaded) return { skipped: 'appointment gone' };
  const { appt, lead, config, calendar } = loaded;
  const tz = config.locale.timezone;
  const values = {
    // Absent (not empty) when unknown, so the template's default greeting is used.
    ...(lead.name?.trim() ? { first_name: lead.name.trim().split(/\s+/)[0] ?? '' } : {}),
    'appointment.service': appt.service,
    'appointment.time': formatSlot(appt.startsAt, tz),
    'appointment.date': formatSlot(appt.startsAt, tz).split(',')[0] ?? '',
    business_name: config.brand.business_name,
  };
  const results: Record<string, unknown> = {};

  // 1. The lead.
  const leadTemplate: TemplateKey | null =
    kind === 'booked' && appt.status === 'pending'
      ? 'booking_pending'
      : kind === 'booked' || kind === 'rescheduled' || (kind === 'confirmed' && appt.status === 'scheduled')
        ? 'booking_confirmed'
        : kind === 'displaced'
          ? 'appointment_change'
          : null;
  if (leadTemplate)
    results.lead = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey: `appt:${appt.id}:${kind}`,
      template: { key: leadTemplate, values },
    });
  else if (kind === 'cancelled')
    // No cancellation template: only possible while the conversation window is open.
    results.lead = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey: `appt:${appt.id}:cancelled`,
      freeForm: {
        kind: 'text',
        body: `Your ${appt.service} on ${values['appointment.time']} has been cancelled. Reply here any time to book again.`,
      },
    });

  // 2. Staff.
  if (kind === 'booked' || kind === 'rescheduled' || kind === 'cancelled' || kind === 'lead_confirmed') {
    const notify = config.booking.staff_notify;
    const summary = `${kind === 'lead_confirmed' ? 'Confirmed by the customer' : kind === 'cancelled' ? 'Cancelled' : kind === 'rescheduled' ? 'Rescheduled' : appt.status === 'pending' ? 'Needs confirmation' : 'New booking'}: ${lead.name ?? lead.phoneE164} — ${appt.service}, ${values['appointment.time']}`;
    if (notify.channel === 'email') {
      results.staff = await deps.email.send({
        to: [notify.to],
        subject: `${config.brand.business_name}: ${summary}`,
        text: `${summary}\n\nOpen the InstantLead dashboard to see the conversation.`,
        idempotencyKey: `appt:${appt.id}:${kind}:staff`,
      });
    } else {
      results.staff = await sendStaffWhatsApp(deps, tenantId, notify.to, 'staff_new_booking', [
        values.first_name ?? lead.phoneE164,
        appt.service,
        values['appointment.time'],
      ]);
    }
  }

  // 3. Calendar (one-way).
  if (calendar) {
    const active = (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(appt.status);
    if (active) {
      const { id } = await calendar.upsert(
        {
          summary: `${appt.service} — ${lead.name ?? lead.phoneE164}`,
          description: `Booked via InstantLead (${appt.status}). Phone: ${lead.phoneE164}`,
          start: appt.startsAt,
          end: appt.endsAt,
          timeZone: tz,
        },
        appt.googleEventId,
      );
      if (id !== appt.googleEventId)
        await withTenant(deps.db, tenantId, (tx) =>
          tx.update(appointments).set({ googleEventId: id }).where(eq(appointments.id, appt.id)),
        );
      results.calendar = id;
    } else if (appt.googleEventId) {
      await calendar.remove(appt.googleEventId);
      results.calendar = 'removed';
    }
  }
  return results;
}

/**
 * A conversation needs a person (handover, emergency, a photo or voice note the AI doesn't read).
 * Goes to the clinic's staff alert channel; the reason is in the email and the inbox.
 */
export async function notifyStaffAlert(deps: NotifyDeps, job: JobData['staff-alert']) {
  const loaded = await withTenant(deps.db, job.tenantId, async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, job.leadId));
    const config = (await getActiveConfig(tx))?.config;
    return lead && config ? { lead, config } : null;
  });
  if (!loaded) return { skipped: 'lead gone' };
  const { lead, config } = loaded;
  const who = lead.name?.trim() || lead.phoneE164;
  const notify = config.booking.staff_notify;
  if (notify.channel === 'email')
    return deps.email.send({
      to: [notify.to],
      subject: `${config.brand.business_name}: ${who} needs a reply`,
      text: `${who} needs a reply from the team on WhatsApp.\nReason: ${job.reason}\n\nOpen the InstantLead inbox to see the conversation.`,
      idempotencyKey: `staff-alert:${job.leadId}:${job.at}`,
    });
  return sendStaffWhatsApp(deps, job.tenantId, notify.to, 'staff_handover', [
    lead.name?.trim().split(/\s+/)[0] || lead.phoneE164,
  ]);
}

/** A short note to the clinic's staff channel (email, or the staff_update WhatsApp template). */
export async function sendStaffNote(
  deps: NotifyDeps,
  tenantId: string,
  note: string,
  idempotencyKey: string,
) {
  const config = await withTenant(deps.db, tenantId, async (tx) => (await getActiveConfig(tx))?.config);
  if (!config) return null;
  const notify = config.booking.staff_notify;
  if (notify.channel === 'email')
    return deps.email.send({
      to: [notify.to],
      subject: `${config.brand.business_name}: ${note.slice(0, 80)}`,
      text: `${note}.\n\nOpen the InstantLead dashboard for details.`,
      idempotencyKey,
    });
  return sendStaffWhatsApp(deps, tenantId, notify.to, 'staff_update', [note]);
}

/** Staff alerts go out as an approved template (staff aren't in a conversation window). */
async function sendStaffWhatsApp(
  deps: MessagingDeps,
  tenantId: string,
  to: string,
  key: TemplateKey,
  values: string[],
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const channel = await channelFor(tx, deps, tenantId);
    const [row] = await tx
      .select()
      .from(templates)
      .where(and(eq(templates.key, key), eq(templates.language, 'en')));
    if (channel.provider === 'meta' && row?.status !== 'approved')
      throw new ChannelError(`Template ${key} is not approved, staff alert not sent`, { retryable: false });
    return channel.send(to, {
      kind: 'template',
      name: row?.providerName ?? TEMPLATES[key].providerName,
      language: 'en',
      bodyParams: values,
      buttonPayloads: TEMPLATES[key].buttons.map((b: { id: string }) => buttonPayload(key, b.id)),
    });
  }).then((r) => ({ ...r, body: renderTemplateBody(key, 'en', values) }));
}
