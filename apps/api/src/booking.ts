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
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type TenantTx, type Tx } from './db/client.ts';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  appointments,
  availabilityRules,
  blockedTimes,
  type AppointmentStatus,
} from './db/schema.ts';
import { QUEUES } from './jobs.ts';
import { emit, transitionLeadIfAllowed, type LeadDeps } from './leads.ts';
import { enrollAfterVisit, enrollReminders, stopEnrollments } from './sequences.ts';
import type { Db } from './db/client.ts';

export type BookingDeps = LeadDeps & { db: Db };
export type AppointmentChange =
  'booked' | 'confirmed' | 'lead_confirmed' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';

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
  },
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    if (!config) throw new Error('tenant has no config');
    const tz = config.locale.timezone;
    const all = await slotsFor(tx, deps, config, q.service, q.date, q.date ? 1 : SEARCH_DAYS);
    const offers =
      q.spread === false
        ? all.slice(0, q.limit ?? 200)
        : pickOffers(all, q.limit ?? config.booking.offer_slots, { timeZone: tz, prefer: q.prefer });
    return { timeZone: tz, slots: offers.map((s) => describeSlot(s, tz)) };
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
    if (appt.status === 'scheduled' || appt.status === 'confirmed') {
      if (kind !== 'lead_confirmed') await enrollReminders(tx, deps.clock, config, appt);
    } else {
      await stopEnrollments(tx, leadId, ['reminders'], `appointment ${appt.status}`);
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
  },
) {
  try {
    return await withTenant(deps.db, tenantId, async (tx) => {
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
      ).find((s) => s.start.getTime() === start.getTime());
      if (!slot)
        throw new BookingError(
          'unavailable',
          `${formatSlot(start, tz)} is not available for ${service.name}`,
        );

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
          resource: slot.resources[0] ?? 'default',
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
  } catch (err) {
    if (isOverlapViolation(err)) throw new BookingError('taken', 'That time was just taken by someone else');
    throw err;
  }
}

export async function rescheduleLeadAppointment(
  deps: BookingDeps,
  tenantId: string,
  input: { leadId: string; date: string; time: string; source: 'assistant' | 'staff' },
) {
  const current = await withTenant(deps.db, tenantId, (tx) => activeAppointment(tx, input.leadId));
  if (!current) throw new BookingError('no_appointment', 'There is no upcoming appointment to reschedule');
  return bookSlot(deps, tenantId, { ...input, service: current.service, replaceAppointmentId: current.id });
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
  completed: { from: ['scheduled', 'confirmed'], to: 'completed', lead: { type: 'COMPLETED' } },
  no_show: { from: ['scheduled', 'confirmed'], to: 'no_show', lead: { type: 'NO_SHOW' } },
};

/** Staff (dashboard) or lead (chat / reminder buttons) moves an appointment along. */
export async function updateAppointment(
  deps: BookingDeps,
  tenantId: string,
  appointmentId: string,
  kind: 'confirmed' | 'lead_confirmed' | 'cancelled' | 'completed' | 'no_show',
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
      .set({ status: rule.to })
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
