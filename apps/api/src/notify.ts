import { buttonPayload, renderTemplateBody, TEMPLATES, type TemplateKey } from '@instantlead/config';
import { formatSlot } from '@instantlead/core';
import { ChannelError, type CalendarProvider, type EmailProvider } from '@instantlead/integrations';
import { and, eq } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Tx } from './db/client.ts';
import { calendarTargetFor } from './calendar-sync.ts';
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
  // A parent booking for a child: "Consultation for Rhea" everywhere the visit is named.
  const serviceLabel = appt.attendeeName ? `${appt.service} for ${appt.attendeeName}` : appt.service;
  const values = {
    // Absent (not empty) when unknown, so the template's default greeting is used.
    ...(lead.name?.trim() ? { first_name: lead.name.trim().split(/\s+/)[0] ?? '' } : {}),
    'appointment.service': serviceLabel,
    'appointment.time': formatSlot(appt.startsAt, tz),
    'appointment.date': formatSlot(appt.startsAt, tz).split(',')[0] ?? '',
    business_name: config.brand.business_name,
  };
  const results: Record<string, unknown> = {};

  // 1. The lead.
  const leadTemplate: TemplateKey | null =
    (kind === 'booked' || kind === 'rescheduled') && appt.status === 'pending'
      ? 'booking_pending'
      : kind === 'booked' || kind === 'rescheduled' || (kind === 'confirmed' && appt.status === 'scheduled')
        ? 'booking_confirmed'
        : kind === 'displaced'
          ? 'appointment_change'
          : null;
  if (kind === 'calendar_sync') {
    // Only the calendar needs to catch up (old slot after a reschedule, doctor reassigned).
  } else if (leadTemplate)
    results.lead = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey: `appt:${appt.id}:${kind}`,
      template: { key: leadTemplate, values, appointmentId: appt.id },
    });
  else if (kind === 'cancelled')
    // Plain text while the chat window is open, the approved template once it has closed.
    results.lead = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey: `appt:${appt.id}:cancelled`,
      freeForm: {
        kind: 'text',
        body: `Your ${serviceLabel} on ${values['appointment.time']} has been cancelled. Reply here any time to book again.`,
      },
      template: { key: 'cancellation', values },
    });

  // A message that could not go out (template not approved, window closed) must never fail silently.
  const sent = results.lead as { status?: string; reason?: string } | undefined;
  if (sent?.status === 'failed')
    results.leadFailed = await sendStaffNote(
      deps,
      tenantId,
      `Could not message ${lead.name?.trim() || lead.phoneE164} about their ${serviceLabel} on ${values['appointment.time']} (${sent.reason}). Please call them`,
      `appt:${appt.id}:${kind}:lead-failed`,
    ).catch((err: unknown) => ({ error: String(err) }));

  // 2. Staff.
  if (kind === 'booked' || kind === 'rescheduled' || kind === 'cancelled' || kind === 'lead_confirmed') {
    const notify = config.booking.staff_notify;
    const summary = `${kind === 'lead_confirmed' ? 'Confirmed by the customer' : kind === 'cancelled' ? 'Cancelled' : kind === 'rescheduled' ? 'Rescheduled' : appt.status === 'pending' ? 'Needs confirmation' : 'New booking'}: ${lead.name ?? lead.phoneE164} — ${serviceLabel}${appt.resource !== 'default' ? ` with ${appt.resource}` : ''}, ${values['appointment.time']}`;
    if (notify.channel === 'email') {
      results.staff = await deps.email.send({
        to: [notify.to],
        subject: `${config.brand.business_name}: ${summary}`,
        text: `${summary}\n\nOpen the InstantLead dashboard to see the conversation.`,
        idempotencyKey: `appt:${appt.id}:${kind}:staff`,
      });
    } else if (kind === 'booked') {
      results.staff = await sendStaffWhatsApp(deps, tenantId, notify.to, 'staff_new_booking', [
        values.first_name ?? lead.phoneE164,
        serviceLabel,
        values['appointment.time'],
      ]);
    } else {
      // Cancelled / rescheduled / confirmed: not a "new booking request", so the generic staff update.
      results.staff = await sendStaffWhatsApp(deps, tenantId, notify.to, 'staff_update', [summary]);
    }
  }

  // 3. Calendar: the appointment is mirrored while it is upcoming or was held; cancelled ones are removed.
  if (calendar) results.calendar = await syncCalendarEvent(deps, tenantId, calendar, { appt, lead, tz });
  return results;
}

/** Visits that happened (or were missed) stay on the calendar, marked; cancelled ones go. */
const CALENDAR_PREFIX: Record<string, string> = { completed: 'Done — ', no_show: 'No-show — ' };

async function syncCalendarEvent(
  deps: NotifyDeps,
  tenantId: string,
  calendar: CalendarProvider,
  { appt, lead, tz }: { appt: typeof appointments.$inferSelect; lead: typeof leads.$inferSelect; tz: string },
) {
  const keep =
    (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(appt.status) ||
    appt.status in CALENDAR_PREFIX;
  if (!keep) {
    if (!appt.googleEventId) return 'none';
    await calendar.remove(appt.googleEventId, appt.googleCalendarId ?? undefined);
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(appointments)
        .set({ googleEventId: null, googleCalendarId: null })
        .where(eq(appointments.id, appt.id)),
    );
    return 'removed';
  }
  // Which calendar: the doctor's / agent's own, else the clinic-wide one, else primary.
  const target = await withTenant(deps.db, tenantId, (tx) => calendarTargetFor(tx, appt.resource));
  let existingId = appt.googleEventId;
  if (existingId && (appt.googleCalendarId ?? null) !== target) {
    // Reassigned to another doctor: the event moves with them.
    await calendar.remove(existingId, appt.googleCalendarId ?? undefined);
    existingId = null;
  }
  const { id } = await calendar.upsert(
    {
      summary: `${CALENDAR_PREFIX[appt.status] ?? ''}${appt.attendeeName ? `${appt.service} for ${appt.attendeeName}` : appt.service} — ${lead.name ?? lead.phoneE164}`,
      description: `Booked via InstantLead (${appt.status}). Phone: ${lead.phoneE164}`,
      start: appt.startsAt,
      end: appt.endsAt,
      timeZone: tz,
      appointmentId: appt.id,
    },
    existingId,
    target ?? undefined,
  );
  if (id !== appt.googleEventId || (appt.googleCalendarId ?? null) !== target)
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(appointments)
        .set({ googleEventId: id, googleCalendarId: target })
        .where(eq(appointments.id, appt.id)),
    );
  return id;
}

/** Erasure / retention: take the person's events out of the clinic's Google Calendar. */
export async function removeCalendarEvents(deps: NotifyDeps, job: JobData['calendar-remove']) {
  const calendar = await withTenant(deps.db, job.tenantId, (tx) => deps.calendarFor(tx, job.tenantId));
  if (!calendar) return { skipped: 'no calendar' };
  for (const e of job.events) await calendar.remove(e.eventId, e.calendarId ?? undefined);
  return { removed: job.events.length };
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
