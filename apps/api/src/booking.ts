import type { TenantConfig } from '@instantlead/config';
import {
  addDays,
  availableSlots,
  formatSlot,
  localParts,
  MINUTE,
  pickOffers,
  zonedTimeToUtc,
  type LeadEvent,
  type PartOfDay,
  type Slot,
} from '@instantlead/core';
import { and, asc, desc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { sendToLead, type MessagingDeps } from './outbound.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type TenantTx, type Tx } from './db/client.ts';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  answers,
  appointments,
  availabilityRules,
  blockedTimes,
  leads,
  type AppointmentStatus,
} from './db/schema.ts';
import { QUEUES } from './jobs.ts';
import { emit, transitionLeadIfAllowed, type LeadDeps } from './leads.ts';
import {
  enrollAfterVisit,
  enrollConfirmWatch,
  enrollPendingWatch,
  enrollReminders,
  stopEnrollments,
} from './sequences.ts';
import type { Db } from './db/client.ts';

export type BookingDeps = LeadDeps & { db: Db };
export type AppointmentChange =
  | 'booked'
  | 'confirmed'
  | 'lead_confirmed'
  | 'rescheduled'
  | 'cancelled'
  | 'completed'
  | 'no_show'
  /** Cancelled by the business (doctor / agent unavailable, closure): the person is offered new times. */
  | 'displaced';

/** Answer key holding the doctor / agent a lead asked for (set by book_slot with a resource). */
export const PREFERRED_RESOURCE = 'preferred_resource';

const MIN_NOTICE_MIN = 60;
const SEARCH_DAYS = 14;

export class BookingError extends Error {
  readonly code:
    'unknown_service' | 'unavailable' | 'taken' | 'already_booked' | 'no_appointment' | 'invalid_status';
  constructor(code: BookingError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const serviceOf = (config: TenantConfig, name: string) => {
  const s = config.booking.services.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!s)
    throw new BookingError(
      'unknown_service',
      `Unknown service "${name}". Services: ${config.booking.services.map((x) => x.name).join(', ')}`,
    );
  return s;
};

async function slotsFor(
  tx: Tx,
  deps: BookingDeps,
  config: TenantConfig,
  service: string,
  fromDate?: string,
  days = SEARCH_DAYS,
  ignoreAppointmentId?: string,
) {
  const tz = config.locale.timezone;
  const start = fromDate ?? localParts(deps.clock.now(), tz).date;
  const windowStart = zonedTimeToUtc(start, '00:00', tz);
  const windowEnd = zonedTimeToUtc(addDays(start, days + 1), '00:00', tz);
  // Sequential: a transaction is one connection.
  const rules = await tx.select().from(availabilityRules);
  const blocked = await tx
    .select()
    .from(blockedTimes)
    .where(and(lt(blockedTimes.startsAt, windowEnd), gt(blockedTimes.endsAt, windowStart)));
  const busy = await tx
    .select()
    .from(appointments)
    .where(
      and(
        inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
        lt(appointments.startsAt, windowEnd),
        gt(appointments.busyUntil, windowStart),
      ),
    );
  return availableSlots({
    now: deps.clock.now(),
    timeZone: tz,
    rules: rules.map((r) => ({
      weekday: r.weekday,
      start: r.startTime,
      end: r.endTime,
      resource: r.resource,
    })),
    blocked: blocked.map((b) => ({ start: b.startsAt, end: b.endsAt, resource: b.resource })),
    busy: busy
      .filter((a) => a.id !== ignoreAppointmentId)
      .map((a) => ({ start: a.startsAt, end: a.busyUntil, resource: a.resource })),
    durationMin: serviceOf(config, service).duration_minutes,
    slotMin: config.booking.slot_minutes,
    bufferMin: config.booking.buffer_minutes,
    fromDate: start,
    days,
    minNoticeMin: MIN_NOTICE_MIN,
  });
}

const describeSlot = (s: Slot, tz: string) => ({
  ...localParts(s.start, tz),
  label: formatSlot(s.start, tz),
});

/** Slots to offer a lead (or list in the dashboard), in tenant-local date/time. */
export async function findSlots(
  deps: BookingDeps,
  tenantId: string,
  q: {
    service: string;
    date?: string | undefined;
    prefer?: PartOfDay | undefined;
    limit?: number | undefined;
    /** false = every free slot (dashboard); true = a few spread-out offers (chat). */
    spread?: boolean;
    /** Only this doctor / agent. */
    resource?: string | undefined;
  },
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    if (!config) throw new Error('tenant has no config');
    const tz = config.locale.timezone;
    const all = (await slotsFor(tx, deps, config, q.service, q.date, q.date ? 1 : SEARCH_DAYS)).filter(
      (s) => !q.resource || s.resources.includes(q.resource),
    );
    const offers =
      q.spread === false
        ? all.slice(0, q.limit ?? 200)
        : pickOffers(all, q.limit ?? config.booking.offer_slots, { timeZone: tz, prefer: q.prefer });
    return {
      timeZone: tz,
      slots: offers.map((s) => {
        const d = describeSlot(s, tz);
        return q.resource ? { ...d, resource: q.resource, label: `${d.label} with ${q.resource}` } : d;
      }),
    };
  });
}

export async function activeAppointment(tx: Tx, leadId: string) {
  const [row] = await tx
    .select()
    .from(appointments)
    .where(
      and(eq(appointments.leadId, leadId), inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES])),
    );
  return row ?? null;
}

/** Deadlock / serialization failure: concurrent bookings collided; retrying gives the real answer. */
const isTransientConflict = (err: unknown) =>
  ['40P01', '40001'].includes(
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? '',
  );

const isOverlapViolation = (err: unknown) =>
  (err as { code?: string; cause?: { code?: string } }).code === '23P01' ||
  (err as { cause?: { code?: string } }).cause?.code === '23P01';

async function change(
  tx: TenantTx,
  deps: BookingDeps,
  tenantId: string,
  appointmentId: string,
  leadId: string,
  kind: AppointmentChange,
  leadEvent: LeadEvent | null,
) {
  if (leadEvent) await transitionLeadIfAllowed(tx, leadId, leadEvent);
  await emit(tx, deps.clock, `appointment.${kind}`, { appointmentId, leadId });

  // Sequences: reminders for confirmed bookings; recovery or review after the visit.
  const [appt] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
  const config = (await getActiveConfig(tx))?.config;
  if (appt && config) {
    if (appt.status === 'pending') {
      await enrollPendingWatch(tx, deps.clock, config, appt);
    } else if (appt.status === 'scheduled' || appt.status === 'confirmed') {
      await stopEnrollments(tx, leadId, ['pending_watch'], 'confirmed');
      if (kind === 'lead_confirmed') await stopEnrollments(tx, leadId, ['confirm_watch'], 'lead confirmed');
      else {
        await enrollReminders(tx, deps.clock, config, appt);
        await enrollConfirmWatch(tx, deps.clock, config, appt);
      }
    } else {
      await stopEnrollments(
        tx,
        leadId,
        ['reminders', 'pending_watch', 'confirm_watch'],
        `appointment ${appt.status}`,
      );
      if (kind === 'completed') await enrollAfterVisit(tx, deps.clock, config, appt, 'review_request');
      if (kind === 'no_show') await enrollAfterVisit(tx, deps.clock, config, appt, 'no_show_recovery');
    }
  }
  // Lead message, staff alert and calendar sync happen in a job (network calls, retries).
  await deps.enqueue(tx, QUEUES.appointmentNotify, { tenantId, appointmentId, kind });
}

/**
 * Book `date` + `time` (tenant-local) for a lead. Re-checks availability inside the transaction;
 * if another booking wins the race, Postgres' exclusion constraint rejects this one ('taken').
 */
export async function bookSlot(
  deps: BookingDeps,
  tenantId: string,
  input: {
    leadId: string;
    service: string;
    date: string;
    time: string;
    source: 'assistant' | 'staff';
    replaceAppointmentId?: string;
    /** A specific doctor / agent the person asked for (remembered for rebooking). */
    resource?: string | undefined;
  },
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bookOnce(deps, tenantId, input);
    } catch (err) {
      if (isOverlapViolation(err))
        throw new BookingError('taken', 'That time was just taken by someone else');
      if (attempt < 3 && isTransientConflict(err)) continue;
      throw err;
    }
  }
}

function bookOnce(deps: BookingDeps, tenantId: string, input: Parameters<typeof bookSlot>[2]) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    if (!config) throw new Error('tenant has no config');
    const service = serviceOf(config, input.service);
    const existing = await activeAppointment(tx, input.leadId);
    if (existing && existing.id !== input.replaceAppointmentId)
      throw new BookingError(
        'already_booked',
        `Lead already has an appointment on ${formatSlot(existing.startsAt, config.locale.timezone)}; reschedule it instead`,
      );

    const tz = config.locale.timezone;
    const start = zonedTimeToUtc(input.date, input.time, tz);
    const slot = (
      await slotsFor(tx, deps, config, service.name, input.date, 1, input.replaceAppointmentId)
    ).find(
      (s) =>
        s.start.getTime() === start.getTime() && (!input.resource || s.resources.includes(input.resource)),
    );
    if (!slot)
      throw new BookingError(
        'unavailable',
        `${formatSlot(start, tz)} is not available for ${service.name}${input.resource ? ` with ${input.resource}` : ''}`,
      );
    if (input.resource)
      await tx
        .insert(answers)
        .values({
          leadId: input.leadId,
          key: PREFERRED_RESOURCE,
          value: input.resource,
          answeredAt: deps.clock.now(),
        })
        .onConflictDoUpdate({ target: [answers.leadId, answers.key], set: { value: input.resource } });

    if (input.replaceAppointmentId)
      await tx
        .update(appointments)
        .set({ status: 'cancelled' })
        .where(eq(appointments.id, input.replaceAppointmentId));
    const status: AppointmentStatus =
      config.booking.mode === 'staff_confirm' && input.source === 'assistant' ? 'pending' : 'scheduled';
    const [appt] = await tx
      .insert(appointments)
      .values({
        leadId: input.leadId,
        service: service.name,
        resource: input.resource ?? slot.resources[0] ?? 'default',
        startsAt: slot.start,
        endsAt: slot.end,
        busyUntil: new Date(slot.end.getTime() + config.booking.buffer_minutes * MINUTE),
        status,
        source: input.source,
      })
      .returning();
    if (!appt) throw new Error('appointment insert failed');
    const rescheduled = Boolean(input.replaceAppointmentId);
    await change(tx, deps, tenantId, appt.id, input.leadId, rescheduled ? 'rescheduled' : 'booked', {
      type: rescheduled ? 'RESCHEDULED' : 'BOOKED',
    });
    return { appointment: appt, label: formatSlot(appt.startsAt, tz), pending: status === 'pending' };
  });
}

export async function rescheduleLeadAppointment(
  deps: BookingDeps,
  tenantId: string,
  input: { leadId: string; date: string; time: string; source: 'assistant' | 'staff' },
) {
  const current = await withTenant(deps.db, tenantId, (tx) => activeAppointment(tx, input.leadId));
  if (!current) throw new BookingError('no_appointment', 'There is no upcoming appointment to reschedule');
  // Someone who asked for a specific doctor stays with them when they reschedule.
  const [pref] = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select({ value: answers.value })
      .from(answers)
      .where(and(eq(answers.leadId, input.leadId), eq(answers.key, PREFERRED_RESOURCE))),
  );
  return bookSlot(deps, tenantId, {
    ...input,
    service: current.service,
    replaceAppointmentId: current.id,
    resource: pref?.value === current.resource ? current.resource : undefined,
  });
}

const NEXT: Partial<
  Record<
    AppointmentChange,
    { from: readonly AppointmentStatus[]; to: AppointmentStatus; lead: LeadEvent | null }
  >
> = {
  confirmed: { from: ['pending'], to: 'scheduled', lead: null }, // staff approved a pending booking
  lead_confirmed: { from: ['scheduled'], to: 'confirmed', lead: { type: 'CONFIRMED' } }, // reminder button
  cancelled: { from: ['pending', 'scheduled', 'confirmed'], to: 'cancelled', lead: { type: 'CANCELLED' } },
  displaced: { from: ['pending', 'scheduled', 'confirmed'], to: 'cancelled', lead: { type: 'CANCELLED' } },
  // Pending too: if staff never confirmed but the visit happened (or didn't), they can still mark it.
  completed: { from: ['pending', 'scheduled', 'confirmed'], to: 'completed', lead: { type: 'COMPLETED' } },
  no_show: { from: ['pending', 'scheduled', 'confirmed'], to: 'no_show', lead: { type: 'NO_SHOW' } },
};

/** Staff (dashboard) or lead (chat / reminder buttons) moves an appointment along. */
export async function updateAppointment(
  deps: BookingDeps,
  tenantId: string,
  appointmentId: string,
  kind: 'confirmed' | 'lead_confirmed' | 'cancelled' | 'completed' | 'no_show' | 'displaced',
  opts: { cancelReason?: string } = {},
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const [appt] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .for('update');
    if (!appt) throw new BookingError('no_appointment', 'Appointment not found');
    const rule = NEXT[kind];
    if (!rule || !rule.from.includes(appt.status))
      throw new BookingError('invalid_status', `Can't mark a ${appt.status} appointment as ${kind}`);
    const [updated] = await tx
      .update(appointments)
      .set({ status: rule.to, ...(opts.cancelReason ? { cancelReason: opts.cancelReason } : {}) })
      .where(eq(appointments.id, appointmentId))
      .returning();
    await change(tx, deps, tenantId, appointmentId, appt.leadId, kind, rule.lead);
    return updated!;
  });
}

export async function cancelLeadAppointment(deps: BookingDeps, tenantId: string, leadId: string) {
  const current = await withTenant(deps.db, tenantId, (tx) => activeAppointment(tx, leadId));
  if (!current) throw new BookingError('no_appointment', 'There is no upcoming appointment to cancel');
  return updateAppointment(deps, tenantId, current.id, 'cancelled');
}

/** Default availability for a new tenant: its business hours, one resource. */
export function rulesFromBusinessHours(config: TenantConfig) {
  return config.locale.business_hours.flatMap((h) =>
    h.days.map((weekday) => ({ weekday, startTime: h.open, endTime: h.close, resource: 'default' })),
  );
}

// ---- Doctor / agent unavailable, clinic closed: bookings inside a blocked period ----

/** Active appointments overlapping a blocked period: on its resource, or every resource when it has none. */
export function appointmentsAffectedBy(
  tx: Tx,
  block: { startsAt: Date; endsAt: Date; resource: string | null },
) {
  return tx
    .select({
      id: appointments.id,
      leadId: appointments.leadId,
      leadName: leads.name,
      leadPhone: leads.phoneE164,
      service: appointments.service,
      resource: appointments.resource,
      startsAt: appointments.startsAt,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(leads, eq(leads.id, appointments.leadId))
    .where(
      and(
        inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
        lt(appointments.startsAt, block.endsAt),
        gt(appointments.endsAt, block.startsAt),
        block.resource ? eq(appointments.resource, block.resource) : undefined,
      ),
    )
    .orderBy(asc(appointments.startsAt));
}

/**
 * Staff tapped "Tell patients & offer new times". Per affected booking: if another doctor /
 * agent is free at the same time (and the person didn't ask for this one), it moves there and
 * keeps its time; otherwise it's cancelled as `clinic_unavailable` and the person gets the
 * appointment_change template with a [Show new times] button. Safe to run twice.
 */
export async function handleBlockedAppointments(deps: BookingDeps, tenantId: string, blockId: string) {
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [block] = await tx.select().from(blockedTimes).where(eq(blockedTimes.id, blockId));
    const config = (await getActiveConfig(tx))?.config;
    return block && config ? { block, config, affected: await appointmentsAffectedBy(tx, block) } : null;
  });
  if (!loaded) throw new BookingError('no_appointment', 'Blocked time not found');
  const { config, affected } = loaded;
  const tz = config.locale.timezone;
  const results: { appointmentId: string; action: 'moved' | 'notified'; to?: string }[] = [];
  for (const a of affected) {
    const movedTo = await withTenant(deps.db, tenantId, async (tx) => {
      const [pref] = await tx
        .select({ value: answers.value })
        .from(answers)
        .where(and(eq(answers.leadId, a.leadId), eq(answers.key, PREFERRED_RESOURCE)));
      if (pref?.value === a.resource) return null; // they asked for this doctor: offer new times instead
      const slots = await slotsFor(tx, deps, config, a.service, localParts(a.startsAt, tz).date, 1, a.id);
      const other = slots
        .find((s) => s.start.getTime() === a.startsAt.getTime())
        ?.resources.find((r) => r !== a.resource);
      if (!other) return null;
      await tx.update(appointments).set({ resource: other }).where(eq(appointments.id, a.id));
      await emit(tx, deps.clock, 'appointment.reassigned', {
        appointmentId: a.id,
        from: a.resource,
        to: other,
      });
      return other;
    });
    if (movedTo) {
      results.push({ appointmentId: a.id, action: 'moved', to: movedTo });
      continue;
    }
    await updateAppointment(deps, tenantId, a.id, 'displaced', { cancelReason: 'clinic_unavailable' });
    results.push({ appointmentId: a.id, action: 'notified' });
  }
  return results;
}

/** The person's last appointment that the business cancelled (for "Show new times"). */
export async function lastDisplacedAppointment(tx: Tx, leadId: string) {
  const [row] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.leadId, leadId), eq(appointments.cancelReason, 'clinic_unavailable')))
    .orderBy(desc(appointments.updatedAt))
    .limit(1);
  return row ?? null;
}

// ---- Running late: tell today's remaining booked people ----

/**
 * Staff tapped "Running late": every active appointment later today (optionally one doctor /
 * agent) gets the running_late template once per delay value. A bigger delay later in the day
 * sends again; the same or a smaller one doesn't.
 */
export async function notifyRunningLate(
  deps: MessagingDeps,
  tenantId: string,
  input: { minutes: number; resource?: string | undefined },
) {
  const now = deps.clock.now();
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    if (!config) return null;
    const tz = config.locale.timezone;
    const today = localParts(now, tz).date;
    const endOfDay = zonedTimeToUtc(addDays(today, 1), '00:00', tz);
    const rows = await tx
      .select({ appt: appointments, lead: leads })
      .from(appointments)
      .innerJoin(leads, eq(leads.id, appointments.leadId))
      .where(
        and(
          inArray(appointments.status, ['scheduled', 'confirmed']),
          gte(appointments.startsAt, new Date(now.getTime() - 15 * MINUTE)), // includes anyone just arriving
          lt(appointments.startsAt, endOfDay),
          input.resource ? eq(appointments.resource, input.resource) : undefined,
        ),
      )
      .orderBy(asc(appointments.startsAt));
    return { config, rows: rows.filter((r) => (r.appt.lateNoticeMinutes ?? 0) < input.minutes) };
  });
  if (!loaded) return [];
  const { config, rows } = loaded;
  const sent: { appointmentId: string; status: string }[] = [];
  for (const { appt, lead } of rows) {
    const time = formatSlot(appt.startsAt, config.locale.timezone).split(', ').at(-1) ?? '';
    const r = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey: `late:${appt.id}:${input.minutes}`,
      template: {
        key: 'running_late',
        values: {
          ...(lead.name?.trim() ? { first_name: lead.name.trim().split(/\s+/)[0] ?? '' } : {}),
          business_name: config.brand.business_name,
          delay_minutes: String(input.minutes),
          'appointment.time': time,
        },
      },
    });
    if (r.status === 'sent')
      await withTenant(deps.db, tenantId, (tx) =>
        tx.update(appointments).set({ lateNoticeMinutes: input.minutes }).where(eq(appointments.id, appt.id)),
      );
    sent.push({ appointmentId: appt.id, status: r.status });
  }
  return sent;
}
