import { autonomyOf, journeysOf } from '@instantlead/config';
import { formatSlot, localParts, MINUTE, nextSendTime, partOfDay, type Clock } from '@instantlead/core';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import {
  attendeeOf,
  BookingError,
  bookSlot,
  findSlots,
  rescheduleLeadAppointment,
  type BookingDeps,
} from './booking.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type TenantTx } from './db/client.ts';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  appointments,
  leads,
  opportunities,
  slotOffers,
  waitlistEntries,
} from './db/schema.ts';
import { QUEUES, type Enqueue } from './jobs.ts';
import { emit } from './leads.ts';
import { recordOpportunity } from './opportunities.ts';
import { sendToLead, type MessagingDeps } from './outbound.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Put someone on the waitlist for a service (assistant tool or staff). If they already hold an upcoming
 * booking for that service, the entry is for an earlier time and accepting an offer moves that booking.
 * One open entry per person and service (partial unique index): joining twice is a no-op.
 */
export async function joinWaitlist(
  deps: BookingDeps,
  tenantId: string,
  input: {
    leadId: string;
    service: string;
    fromDate?: string | undefined;
    toDate?: string | undefined;
    partOfDay?: 'morning' | 'afternoon' | 'evening' | undefined;
    forName?: string | null | undefined;
    resource?: string | undefined;
    source: 'assistant' | 'staff';
  },
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    if (!config) throw new Error('tenant has no config');
    const service = config.booking.services.find((s) => s.name.toLowerCase() === input.service.toLowerCase());
    if (!service) throw new BookingError('unknown_service', `Unknown service "${input.service}"`);
    for (const d of [input.fromDate, input.toDate])
      if (d !== undefined && !DATE.test(d)) throw new BookingError('unavailable', `Bad date ${d}`);
    const [lead] = await tx.select({ name: leads.name }).from(leads).where(eq(leads.id, input.leadId));
    if (!lead) throw new BookingError('no_appointment', 'Lead not found');
    const attendee = attendeeOf(lead, input.forName) ?? null;
    const [held] = (
      await tx
        .select({ id: appointments.id, attendee: appointments.attendeeName })
        .from(appointments)
        .where(
          and(
            eq(appointments.leadId, input.leadId),
            eq(appointments.service, service.name),
            inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
          ),
        )
    ).filter((a) => (a.attendee ?? '').toLowerCase() === (attendee ?? '').toLowerCase());
    const [row] = await tx
      .insert(waitlistEntries)
      .values({
        leadId: input.leadId,
        service: service.name,
        resource: input.resource ?? null,
        attendeeName: attendee,
        appointmentId: held?.id ?? null,
        fromDate: input.fromDate ?? null,
        toDate: input.toDate ?? null,
        partOfDay: input.partOfDay ?? null,
        source: input.source,
        joinedAt: deps.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: waitlistEntries.id });
    if (row)
      await emit(tx, deps.clock, 'waitlist.joined', {
        leadId: input.leadId,
        entryId: row.id,
        service: service.name,
      });
    return { joined: true, already_waiting: !row, wants_earlier_than_current_booking: Boolean(held) };
  });
}

// ---- Freed slots: detect, offer to the waitlist, first acceptance books it ----

/** Closer than this to the slot, nobody can reasonably take it (same as the booking minimum notice). */
const OFFER_MIN_NOTICE_MS = 60 * MINUTE;

/**
 * A booking was cancelled (or moved away): its time is free again. Records an EMPTY_SLOT opportunity
 * (one per cancelled appointment, so a slot freed twice is two opportunities) and queues the waitlist
 * offer job, in the caller's transaction. Slots about to start are not worth offering.
 */
export async function recordEmptySlot(
  tx: TenantTx,
  deps: { clock: Clock; enqueue: Enqueue },
  tenantId: string,
  appt: { id: string; startsAt: Date; resource: string; service: string },
) {
  const now = deps.clock.now();
  if (appt.startsAt.getTime() - now.getTime() < OFFER_MIN_NOTICE_MS) return null;
  const id = await recordOpportunity(tx, deps.clock, {
    kind: 'EMPTY_SLOT',
    subjectKey: `slot:${appt.id}`,
    appointmentId: appt.id,
    slotStartsAt: appt.startsAt,
    slotResource: appt.resource,
    slotService: appt.service,
    reason: `A ${appt.service} slot was freed by a cancellation`,
    recommendedAction: 'Offer it to people on the waitlist (first to accept gets it)',
    priorityFacts: { hoursUntilSlot: (appt.startsAt.getTime() - now.getTime()) / 3_600_000 },
  });
  if (id) await deps.enqueue(tx, QUEUES.slotRecovery, { tenantId, opportunityId: id }, { singletonKey: id });
  return id;
}

type SlotDeps = MessagingDeps & BookingDeps;

/**
 * Offer a freed slot to the next waiting people. The opportunity row is locked while offers are chosen
 * and recorded; `slot_offers` is unique per (slot, person), so a retried job never offers twice. While
 * offers are outstanding nothing more is sent; after the offer window the job runs again and moves on.
 */
export async function runSlotRecovery(
  deps: SlotDeps,
  job: { tenantId: string; opportunityId: string; approved?: boolean },
): Promise<{ status: string; offered?: number }> {
  const { tenantId, opportunityId } = job;
  const now = deps.clock.now();
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [o] = await tx
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId))
      .for('update');
    const config = (await getActiveConfig(tx))?.config;
    if (!o || !config || o.kind !== 'EMPTY_SLOT' || !o.slotStartsAt) return { done: 'gone' };
    if (!['open', 'needs_approval', 'actioned'].includes(o.status)) return { done: `already ${o.status}` };
    if (o.slotStartsAt.getTime() - now.getTime() < OFFER_MIN_NOTICE_MS) {
      await tx
        .update(opportunities)
        .set({ status: 'lost', outcome: 'slot passed without a taker', outcomeAt: now })
        .where(eq(opportunities.id, o.id));
      await tx
        .update(slotOffers)
        .set({ status: 'expired' })
        .where(and(eq(slotOffers.opportunityId, o.id), eq(slotOffers.status, 'sent')));
      return { done: 'slot passed' };
    }
    const mode = autonomyOf(config, 'waitlist_offer');
    if (mode === 'off') return { done: 'waitlist offers are off' };
    if (mode === 'approval' && !job.approved) {
      if (o.status === 'open')
        await tx.update(opportunities).set({ status: 'needs_approval' }).where(eq(opportunities.id, o.id));
      return { done: 'waiting for staff approval' };
    }
    await tx
      .update(slotOffers)
      .set({ status: 'expired' })
      .where(
        and(
          eq(slotOffers.opportunityId, o.id),
          eq(slotOffers.status, 'sent'),
          lte(slotOffers.expiresAt, now),
        ),
      );
    const [pending] = await tx
      .select({ expiresAt: slotOffers.expiresAt })
      .from(slotOffers)
      .where(and(eq(slotOffers.opportunityId, o.id), eq(slotOffers.status, 'sent')))
      .orderBy(asc(slotOffers.expiresAt))
      .limit(1);
    if (pending) return { done: 'offers outstanding', retryAt: pending.expiresAt };
    if (nextSendTime(now, config.locale.timezone, config.locale.quiet_hours) > now)
      return { done: 'quiet hours' }; // the 15-minute sweep re-queues it
    const offered = new Set(
      (
        await tx
          .select({ leadId: slotOffers.leadId })
          .from(slotOffers)
          .where(eq(slotOffers.opportunityId, o.id))
      ).map((r) => r.leadId),
    );
    const tz = config.locale.timezone;
    const slot = localParts(o.slotStartsAt, tz);
    const waiting = await tx
      .select({ entry: waitlistEntries, lead: leads })
      .from(waitlistEntries)
      .innerJoin(leads, eq(leads.id, waitlistEntries.leadId))
      .where(eq(waitlistEntries.status, 'waiting'))
      .orderBy(asc(waitlistEntries.joinedAt), asc(waitlistEntries.createdAt));
    // Deterministic order: same service first, then same doctor, then who waited longest.
    const candidates = waiting
      .filter(
        ({ entry, lead }) =>
          !offered.has(lead.id) &&
          lead.state !== 'opted_out' &&
          !lead.aiPaused &&
          !lead.notALead &&
          (!entry.fromDate || entry.fromDate <= slot.date) &&
          (!entry.toDate || slot.date <= entry.toDate) &&
          (!entry.partOfDay || partOfDay(slot.time) === entry.partOfDay) &&
          (!entry.resource || entry.resource === o.slotResource),
      )
      .sort(
        (a, b) =>
          Number(b.entry.service === o.slotService) - Number(a.entry.service === o.slotService) ||
          Number(b.entry.resource === o.slotResource) - Number(a.entry.resource === o.slotResource) ||
          a.entry.joinedAt.getTime() - b.entry.joinedAt.getTime() ||
          a.entry.createdAt.getTime() - b.entry.createdAt.getTime(),
      );
    return { o, config, slot, candidates, batch: journeysOf(config).waitlist_batch };
  });
  if (!loaded.candidates) {
    if (loaded.retryAt)
      await deps.enqueue(
        null,
        QUEUES.slotRecovery,
        { tenantId, opportunityId },
        {
          startAfter: loaded.retryAt,
          singletonKey: `${opportunityId}:${loaded.retryAt.toISOString()}`,
        },
      );
    return { status: loaded.done ?? 'skipped' };
  }
  const { o, config, slot, candidates, batch } = loaded;

  // The slot must really be free for that person's service (it may fit a shorter service only).
  const chosen: typeof candidates = [];
  for (const c of candidates) {
    if (chosen.length >= batch) break;
    const { slots } = await findSlots(deps, tenantId, {
      service: c.entry.service,
      date: slot.date,
      resource: o.slotResource ?? undefined,
      spread: false,
    });
    if (slots.some((s) => s.time === slot.time)) chosen.push(c);
  }
  if (!chosen.length) {
    // Free for nobody waiting (or taken meanwhile): record why; new waitlist joins are picked up by the sweep.
    const stillFree = (
      await findSlots(deps, tenantId, {
        service: o.slotService ?? config.booking.services[0]!.name,
        date: slot.date,
        resource: o.slotResource ?? undefined,
        spread: false,
      })
    ).slots.some((s) => s.time === slot.time);
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(opportunities)
        .set(
          stillFree
            ? { outcome: 'Nobody on the waitlist fits this slot yet' }
            : { status: 'won', outcome: 'filled by a regular booking', outcomeAt: now },
        )
        .where(eq(opportunities.id, o.id)),
    );
    return { status: stillFree ? 'no candidates' : 'filled' };
  }

  const expiresAt = new Date(now.getTime() + journeysOf(config).waitlist_offer_minutes * MINUTE);
  let sent = 0;
  for (const { entry, lead } of chosen) {
    const [offer] = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .insert(slotOffers)
        .values({
          opportunityId: o.id,
          leadId: lead.id,
          waitlistEntryId: entry.id,
          offeredAt: now,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: slotOffers.id }),
    );
    if (!offer) continue;
    const r = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey: `offer:${offer.id}`,
      template: {
        key: 'slot_offer',
        values: {
          'appointment.service': entry.service,
          'appointment.time': formatSlot(o.slotStartsAt!, config.locale.timezone),
          business_name: config.brand.business_name,
        },
        // The button payload carries the offer id, so a tap acts on exactly this offer.
        appointmentId: offer.id,
      },
    });
    await withTenant(deps.db, tenantId, async (tx) => {
      if (r.status !== 'sent') {
        await tx.update(slotOffers).set({ status: 'failed' }).where(eq(slotOffers.id, offer.id));
        return;
      }
      sent++;
      await emit(tx, deps.clock, 'slot.offered', { leadId: lead.id, opportunityId: o.id, offerId: offer.id });
    });
  }
  await withTenant(deps.db, tenantId, (tx) =>
    tx
      .update(opportunities)
      .set(
        sent
          ? { status: 'actioned', aiActed: true, actedAt: now, outcome: null }
          : { outcome: 'Offers could not be sent' },
      )
      .where(eq(opportunities.id, o.id)),
  );
  // After the offer window: expire unanswered offers and offer the next people.
  await deps.enqueue(
    null,
    QUEUES.slotRecovery,
    { tenantId, opportunityId: o.id },
    {
      startAfter: expiresAt,
      singletonKey: `${o.id}:${expiresAt.toISOString()}`,
    },
  );
  return { status: 'offered', offered: sent };
}

export type OfferAnswer =
  | { status: 'booked'; label: string; appointmentId: string }
  | { status: 'taken' | 'expired' | 'not_found' | 'declined' };

/**
 * The patient tapped "Book it" (or "No thanks") on a slot offer. Booking goes through the normal engine;
 * Postgres' exclusion constraint decides between two people accepting at once, so the slot is never
 * double-booked. The winner's offer is accepted, everyone else's is superseded, the opportunity is won.
 */
export async function answerSlotOffer(
  deps: SlotDeps,
  tenantId: string,
  input: { offerId: string; leadId: string; accept: boolean },
): Promise<OfferAnswer> {
  const now = deps.clock.now();
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ offer: slotOffers, o: opportunities, entry: waitlistEntries })
      .from(slotOffers)
      .innerJoin(opportunities, eq(opportunities.id, slotOffers.opportunityId))
      .innerJoin(waitlistEntries, eq(waitlistEntries.id, slotOffers.waitlistEntryId))
      .where(and(eq(slotOffers.id, input.offerId), eq(slotOffers.leadId, input.leadId)));
    if (!row) return null;
    const config = (await getActiveConfig(tx))?.config;
    return config ? { ...row, config } : null;
  });
  if (!loaded) return { status: 'not_found' };
  const { offer, o, entry, config } = loaded;
  if (o.status === 'won') return { status: 'taken' };
  if (offer.status !== 'sent' || offer.expiresAt <= now || !o.slotStartsAt) return { status: 'expired' };

  if (!input.accept) {
    await withTenant(deps.db, tenantId, async (tx) => {
      await tx
        .update(slotOffers)
        .set({ status: 'declined', respondedAt: now })
        .where(eq(slotOffers.id, offer.id));
      await deps.enqueue(
        tx,
        QUEUES.slotRecovery,
        { tenantId, opportunityId: o.id },
        { singletonKey: `${o.id}:declined:${offer.id}` },
      );
    });
    return { status: 'declined' };
  }

  const { date, time } = localParts(o.slotStartsAt, config.locale.timezone);
  let booked;
  try {
    booked = entry.appointmentId
      ? await rescheduleLeadAppointment(deps, tenantId, {
          leadId: input.leadId,
          appointmentId: entry.appointmentId,
          date,
          time,
          source: 'assistant',
        })
      : await bookSlot(deps, tenantId, {
          leadId: input.leadId,
          service: entry.service,
          date,
          time,
          source: 'assistant',
          resource: o.slotResource ?? undefined,
          forName: entry.attendeeName,
          requireApproval: autonomyOf(config, 'book') === 'approval',
        });
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;
    await withTenant(deps.db, tenantId, (tx) =>
      tx.update(slotOffers).set({ status: 'expired', respondedAt: now }).where(eq(slotOffers.id, offer.id)),
    );
    return { status: err.code === 'taken' || err.code === 'unavailable' ? 'taken' : 'expired' };
  }
  await withTenant(deps.db, tenantId, async (tx) => {
    await tx
      .update(slotOffers)
      .set({ status: 'accepted', respondedAt: now })
      .where(eq(slotOffers.id, offer.id));
    await tx
      .update(slotOffers)
      .set({ status: 'superseded' })
      .where(and(eq(slotOffers.opportunityId, o.id), eq(slotOffers.status, 'sent')));
    await tx
      .update(opportunities)
      .set({
        status: 'won',
        outcome: 'filled from the waitlist',
        outcomeAt: now,
        aiActed: true,
        leadId: input.leadId,
        appointmentId: booked.appointment.id,
      })
      .where(eq(opportunities.id, o.id));
    await tx.update(waitlistEntries).set({ status: 'booked' }).where(eq(waitlistEntries.id, entry.id));
    await emit(tx, deps.clock, 'slot.recovered', {
      leadId: input.leadId,
      opportunityId: o.id,
      appointmentId: booked.appointment.id,
    });
  });
  return { status: 'booked', label: booked.label, appointmentId: booked.appointment.id };
}
