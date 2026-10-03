import type { TenantConfig } from '@instantlead/config';
import { createFakeCalendar } from '@instantlead/integrations';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots, rescheduleLeadAppointment, updateAppointment } from './booking.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { appointments, leads, messages, opportunities, slotOffers, waitlistEntries } from './db/schema.ts';
import { answerSlotOffer, joinWaitlist, runSlotRecovery } from './waitlist.ts';

const calendar = createFakeCalendar();
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  // Mon 5 Oct 2026, 10:00 IST. Auto-confirm so bookings are 'scheduled'; offers go to 2 people at a time.
  t = await createTestContext({ calendarFor: () => Promise.resolve(calendar) });
  A = (
    await t.ctx.system.createTenant(
      {
        slug: 'a',
        name: 'Smile Dental',
        preset: 'clinic_dental',
        admin: { email: 'admin@a.test', name: 'A', password: PASSWORD },
      },
      { type: 'system' },
    )
  ).tenant.id;
  cookie = await t.signIn('admin@a.test');
  await setConfig((c) => ({
    ...c,
    booking: { ...c.booking, mode: 'auto_confirm' },
    journeys: {
      stall_grace_days: 7,
      recall_months: 6,
      lost_lead_after_hours: 48,
      max_outreach_per_day: 30,
      waitlist_offer_minutes: 30,
      waitlist_batch: 2,
    },
  }));
});
afterAll(() => t.close());

async function setConfig(change: (c: TenantConfig) => TenantConfig) {
  await withTenant(t.ctx.db, A, async (tx) => {
    const config = change(structuredClone((await getActiveConfig(tx))!.config));
    await saveConfig(tx, t.clock, { type: 'system' }, config);
  });
}
const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
async function newLead(name: string) {
  const phone = `98755${String(++n).padStart(5, '0')}`;
  const res = await api('POST', '/v1/leads', { phone, name, consent: { granted: true } });
  await t.drainJobs();
  return { leadId: (res.json() as { lead_id: string }).lead_id, phone };
}
/** A booking on Wednesday, the idx-th free Consultation slot of that day. */
async function bookWed(leadId: string, idx = 0, date = '2026-10-07') {
  const slot = (await findSlots(t.ctx, A, { service: 'Consultation', date, limit: 200, spread: false }))
    .slots[idx]!;
  const r = await bookSlot(t.ctx, A, {
    leadId,
    service: 'Consultation',
    date: slot.date,
    time: slot.time,
    source: 'staff',
  });
  await t.drainJobs();
  return r.appointment;
}
const wait = (leadId: string, extra: Partial<Parameters<typeof joinWaitlist>[2]> = {}) =>
  joinWaitlist(t.ctx, A, { leadId, service: 'Consultation', source: 'staff', ...extra });
const slotOpp = (appointmentId: string) =>
  withTenant(t.ctx.db, A, async (tx) => {
    const [o] = await tx
      .select()
      .from(opportunities)
      .where(
        and(eq(opportunities.kind, 'EMPTY_SLOT'), eq(opportunities.subjectKey, `slot:${appointmentId}`)),
      );
    return o;
  });
const offersFor = (opportunityId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx
      .select()
      .from(slotOffers)
      .where(eq(slotOffers.opportunityId, opportunityId))
      .orderBy(asc(slotOffers.createdAt)),
  );
const clearWaitlist = () =>
  withTenant(t.ctx.db, A, (tx) => tx.update(waitlistEntries).set({ status: 'removed' }));
const activeAt = (startsAt: Date) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.startsAt, startsAt),
          inArray(appointments.status, ['pending', 'scheduled', 'confirmed']),
        ),
      ),
  );
const tap = (phone: string, payload: string) =>
  api('POST', '/v1/dev/whatsapp/inbound', { from: phone, button_payload: payload });

describe('cancellation → waitlist recovery', () => {
  test('a cancelled slot is offered to the first eligible waiters; the first to accept is booked (calendar too); others are superseded', async () => {
    const owner = await newLead('Owner');
    const appt = await bookWed(owner.leadId, 3);
    const w1 = await newLead('Waiter One');
    const w2 = await newLead('Waiter Two');
    const w3 = await newLead('Waiter Three');
    const tooLate = await newLead('Only Next Week');
    await wait(w1.leadId);
    await wait(tooLate.leadId, { fromDate: '2026-10-12' }); // window excludes Wednesday
    await wait(w2.leadId);
    await wait(w3.leadId);

    await updateAppointment(t.ctx, A, appt.id, 'cancelled', { cancelReason: 'customer' });
    await t.drainJobs(); // cancellation notice + slot-recovery
    const opp = (await slotOpp(appt.id))!;
    expect(opp).toMatchObject({ status: 'actioned', aiActed: true, slotService: 'Consultation' });
    const offers = await offersFor(opp.id);
    expect(offers.map((o) => o.leadId).sort()).toEqual([w1.leadId, w2.leadId].sort()); // batch 2, FIFO, window respected
    // Running the job again (retry, sweep) sends nothing more while offers are outstanding.
    await runSlotRecovery(t.ctx, { tenantId: A, opportunityId: opp.id });
    expect(await offersFor(opp.id)).toHaveLength(2);

    const offerTo2 = offers.find((o) => o.leadId === w2.leadId)!;
    await tap(w2.phone, `slot_offer:accept:${offerTo2.id}`);
    await t.drainAssistant();
    await t.drainJobs();
    const booked = await activeAt(appt.startsAt);
    expect(booked.map((a) => a.leadId)).toEqual([w2.leadId]);
    expect(booked[0]!.googleEventId).toBeTruthy();
    expect(calendar.events.has(booked[0]!.googleEventId!)).toBe(true);
    expect(await slotOpp(appt.id)).toMatchObject({
      status: 'won',
      outcome: 'filled from the waitlist',
      leadId: w2.leadId,
    });
    const after = await offersFor(opp.id);
    expect(after.find((o) => o.leadId === w2.leadId)?.status).toBe('accepted');
    expect(after.find((o) => o.leadId === w1.leadId)?.status).toBe('superseded');

    // The superseded person taps too late: told it is taken, nothing booked.
    const offerTo1 = offers.find((o) => o.leadId === w1.leadId)!;
    await tap(w1.phone, `slot_offer:accept:${offerTo1.id}`);
    await t.drainAssistant();
    expect((await activeAt(appt.startsAt)).map((a) => a.leadId)).toEqual([w2.leadId]);
    const [last] = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(eq(messages.leadId, w1.leadId), eq(messages.direction, 'out'))),
    ).then((rows) => rows.slice(-1));
    expect(last?.body).toMatch(/someone else just took that time/);
  });

  test('two people accepting at the same moment: exactly one booking', async () => {
    await clearWaitlist();
    const owner = await newLead('Owner 2');
    const appt = await bookWed(owner.leadId, 6);
    const a = await newLead('Racer A');
    const b = await newLead('Racer B');
    await wait(a.leadId);
    await wait(b.leadId);
    await updateAppointment(t.ctx, A, appt.id, 'cancelled', { cancelReason: 'staff' });
    await t.drainJobs();
    const opp = (await slotOpp(appt.id))!;
    const offers = (await offersFor(opp.id)).filter((o) => [a.leadId, b.leadId].includes(o.leadId));
    expect(offers).toHaveLength(2);
    const results = await Promise.all(
      offers.map((o) => answerSlotOffer(t.ctx, A, { offerId: o.id, leadId: o.leadId, accept: true })),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['booked', 'taken']);
    expect(await activeAt(appt.startsAt)).toHaveLength(1);
  });

  test('declining moves on to the next person; an offer nobody answers expires and the next batch is offered', async () => {
    // Earlier tests' waiters are booked or superseded but still waiting; clear the list for a clean run.
    await clearWaitlist();
    const owner = await newLead('Owner 3');
    const appt = await bookWed(owner.leadId, 9);
    const ws = [await newLead('D1'), await newLead('D2'), await newLead('D3'), await newLead('D4')];
    for (const w of ws) await wait(w.leadId);
    await updateAppointment(t.ctx, A, appt.id, 'cancelled', { cancelReason: 'staff' });
    await t.drainJobs();
    const opp = (await slotOpp(appt.id))!;
    let offers = await offersFor(opp.id);
    expect(offers.map((o) => o.leadId)).toEqual([ws[0]!.leadId, ws[1]!.leadId]);
    expect(
      await answerSlotOffer(t.ctx, A, { offerId: offers[0]!.id, leadId: ws[0]!.leadId, accept: false }),
    ).toEqual({
      status: 'declined',
    });
    // One offer still outstanding: wait for it.
    await runSlotRecovery(t.ctx, { tenantId: A, opportunityId: opp.id });
    expect(await offersFor(opp.id)).toHaveLength(2);
    t.clock.advance(31 * 60_000); // the other offer expires unanswered
    await runSlotRecovery(t.ctx, { tenantId: A, opportunityId: opp.id });
    offers = await offersFor(opp.id);
    expect(offers.map((o) => [o.leadId, o.status])).toEqual([
      [ws[0]!.leadId, 'declined'],
      [ws[1]!.leadId, 'expired'],
      [ws[2]!.leadId, 'sent'],
      [ws[3]!.leadId, 'sent'],
    ]);
    // An expired offer can't be accepted.
    expect(
      await answerSlotOffer(t.ctx, A, { offerId: offers[1]!.id, leadId: ws[1]!.leadId, accept: true }),
    ).toEqual({
      status: 'expired',
    });
  });

  test('opted-out or paused patients are never offered; waitlist offers off = detected only', async () => {
    await clearWaitlist();
    const stop = await newLead('Stopped');
    const paused = await newLead('Paused');
    await wait(stop.leadId);
    await wait(paused.leadId);
    await api('POST', `/v1/leads/${stop.leadId}/opt-out`);
    await api('POST', `/v1/leads/${paused.leadId}/takeover`);
    const owner = await newLead('Owner 4');
    const appt = await bookWed(owner.leadId, 12);
    await updateAppointment(t.ctx, A, appt.id, 'cancelled', { cancelReason: 'staff' });
    await t.drainJobs();
    const opp = (await slotOpp(appt.id))!;
    expect(await offersFor(opp.id)).toEqual([]);
    expect(opp.outcome).toMatch(/Nobody on the waitlist/);

    await setConfig((c) => ({ ...c, autonomy: { waitlist_offer: 'off' } }));
    const fresh = await newLead('Fresh');
    await wait(fresh.leadId);
    expect(await runSlotRecovery(t.ctx, { tenantId: A, opportunityId: opp.id })).toEqual({
      status: 'waitlist offers are off',
    });
    expect(await offersFor(opp.id)).toEqual([]);
    await setConfig((c) => ({ ...c, autonomy: {} }));
  });

  test('someone waiting for an earlier time is moved, and their old (later) slot is freed in turn', async () => {
    await clearWaitlist();
    const early = await newLead('Wants Earlier');
    const later = await bookWed(early.leadId, 2, '2026-10-09'); // Friday
    expect((await wait(early.leadId)).wants_earlier_than_current_booking).toBe(true);
    const owner = await newLead('Owner 5');
    const appt = await bookWed(owner.leadId, 15);
    // Rescheduling also frees a slot: the owner moves to Thursday.
    const slotThu = (
      await findSlots(t.ctx, A, { service: 'Consultation', date: '2026-10-08', limit: 1, spread: false })
    ).slots[0]!;
    await rescheduleLeadAppointment(t.ctx, A, {
      leadId: owner.leadId,
      date: slotThu.date,
      time: slotThu.time,
      source: 'staff',
    });
    await t.drainJobs();
    const opp = (await slotOpp(appt.id))!;
    const [offer] = await offersFor(opp.id);
    expect(offer?.leadId).toBe(early.leadId);
    const r = await answerSlotOffer(t.ctx, A, { offerId: offer!.id, leadId: early.leadId, accept: true });
    expect(r.status).toBe('booked');
    const mine = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.leadId, early.leadId),
            inArray(appointments.status, ['scheduled', 'confirmed']),
          ),
        ),
    );
    expect(mine.map((a) => a.startsAt.getTime())).toEqual([appt.startsAt.getTime()]);
    expect(await slotOpp(later.id)).toMatchObject({ kind: 'EMPTY_SLOT' });
    const [l] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(leads).where(eq(leads.id, early.leadId)),
    );
    expect(l?.state).toBe('booked');
  });
});

describe('waitlist offers need staff approval', () => {
  test('the freed slot waits under Recovery; approving it sends the offers', async () => {
    await clearWaitlist();
    await setConfig((c) => ({ ...c, autonomy: { waitlist_offer: 'approval' } }));
    const w = await newLead('Approve Me');
    await wait(w.leadId);
    const owner = await newLead('Owner 6');
    const appt = await bookWed(owner.leadId, 18);
    await updateAppointment(t.ctx, A, appt.id, 'cancelled', { cancelReason: 'staff' });
    await t.drainJobs();
    const opp = (await slotOpp(appt.id))!;
    expect(opp.status).toBe('needs_approval');
    expect(await offersFor(opp.id)).toEqual([]);
    expect((await api('POST', `/v1/opportunities/${opp.id}/approve`)).statusCode).toBe(200);
    await t.drainJobs();
    expect((await offersFor(opp.id)).map((o) => o.leadId)).toEqual([w.leadId]);
    await setConfig((c) => ({ ...c, autonomy: {} }));
  });
});
