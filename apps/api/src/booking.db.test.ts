import { createFakeCalendar } from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { BookingError, bookSlot, findSlots } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, leads, messages } from './db/schema.ts';

const calendar = createFakeCalendar();
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  // Clock: Mon 5 Oct 2026, 10:00 IST. Dental preset: staff_confirm, Mon-Sat 10:00-20:00.
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
});
afterAll(() => t.close());

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function newLead(name = 'Priya') {
  const phone = `98700${String(++n).padStart(5, '0')}`;
  const res = await api('POST', '/v1/leads', { phone, name, consent: { granted: true } });
  await t.drainJobs(); // first reply
  return (res.json() as { lead_id: string }).lead_id;
}
const slotsFor = async (service = 'Consultation', date?: string) =>
  (await findSlots(t.ctx, A, { service, date, limit: 200, spread: false })).slots;
const thread = (leadId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx
      .select()
      .from(messages)
      .where(eq(messages.leadId, leadId))
      .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
  );

describe('availability', () => {
  test('slots respect business hours and minimum notice', async () => {
    const slots = await slotsFor('Consultation', '2026-10-05');
    expect(slots[0]).toMatchObject({ date: '2026-10-05', time: '11:00' });
    expect(slots.at(-1)?.time).toBe('19:30'); // the 20-minute service must end by 20:00
    expect((await slotsFor('Consultation', '2026-10-11')).at(-1)?.time).toBe('13:30'); // Sunday 10:00-14:00
  });

  test('blocked times remove slots; availability can be replaced', async () => {
    const block = await api('POST', '/v1/blocked-times', {
      starts_at: '2026-10-06T04:30:00Z', // Tue 10:00 IST
      ends_at: '2026-10-06T14:30:00Z', // Tue 20:00 IST
      reason: 'Doctor on leave',
    });
    expect(block.statusCode).toBe(201);
    expect(await slotsFor('Consultation', '2026-10-06')).toEqual([]);
    await api('DELETE', `/v1/blocked-times/${(block.json() as { id: string }).id}`);
    expect((await slotsFor('Consultation', '2026-10-06')).length).toBeGreaterThan(0);
  });
});

describe('no double booking', () => {
  test('ten leads racing for the same slot: exactly one wins', async () => {
    const [slot] = await slotsFor('Consultation', '2026-10-07');
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => newLead(`Racer ${i}`)));
    const results = await Promise.allSettled(
      ids.map((leadId) =>
        bookSlot(t.ctx, A, {
          leadId,
          service: 'Consultation',
          date: slot!.date,
          time: slot!.time,
          source: 'staff',
        }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BookingError);
    expect((await slotsFor('Consultation', '2026-10-07'))[0]?.time).not.toBe(slot!.time);
    await t.drainJobs();
  });

  test('a lead can only hold one active appointment (reschedule instead)', async () => {
    const leadId = await newLead();
    const [a, b] = await slotsFor('Consultation', '2026-10-08');
    await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: a!.date,
      time: a!.time,
      source: 'staff',
    });
    await expect(
      bookSlot(t.ctx, A, { leadId, service: 'Consultation', date: b!.date, time: b!.time, source: 'staff' }),
    ).rejects.toMatchObject({ code: 'already_booked' });
    await t.drainJobs();
  });
});

describe('booking lifecycle', () => {
  test('staff-confirm mode: pending -> lead told it is pending, staff alerted, calendar synced; confirm -> confirmed message', async () => {
    const leadId = await newLead('Kavya Rao');
    const [slot] = await slotsFor('Teeth whitening', '2026-10-09');
    const booked = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Teeth whitening',
      date: slot!.date,
      time: slot!.time,
      source: 'assistant',
    });
    expect(booked.pending).toBe(true);
    expect(
      (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))))[0]?.state,
    ).toBe('booked');

    const staffBefore = t.ctx.fakeChannel.sent.length;
    await t.drainJobs();
    expect((await thread(leadId)).find((m) => m.templateKey === 'booking_pending')?.body).toMatch(
      /Kavya.*Teeth whitening.*will confirm/,
    );
    const alert = t.ctx.fakeChannel.sent.slice(staffBefore).find((s) => s.to === '+910000000000');
    expect(alert?.content).toMatchObject({ kind: 'template', name: 'il_staff_new_booking' });
    const eventId = (
      await withTenant(t.ctx.db, A, (tx) =>
        tx.select().from(appointments).where(eq(appointments.id, booked.appointment.id)),
      )
    )[0]?.googleEventId;
    expect(calendar.events.get(eventId ?? '')?.summary).toBe('Teeth whitening — Kavya Rao');

    const confirm = await api('POST', `/v1/appointments/${booked.appointment.id}/confirm`);
    expect(confirm.json()).toMatchObject({ status: 'scheduled' });
    await t.drainJobs();
    expect((await thread(leadId)).some((m) => m.templateKey === 'booking_confirmed')).toBe(true);
  });

  test('reschedule frees the old slot; cancel returns the lead to qualified and removes the calendar event', async () => {
    const leadId = await newLead('Ravi');
    const all = await slotsFor('Consultation', '2026-10-10');
    const [first, second] = [all[0], all[8]]; // two hours apart, so the buffers don't overlap
    const r1 = await api('POST', '/v1/appointments', {
      lead_id: leadId,
      service: 'Consultation',
      date: first!.date,
      time: first!.time,
    });
    expect(r1.statusCode).toBe(201);
    const id1 = (r1.json() as { appointment: { id: string } }).appointment.id;
    await t.drainJobs();
    const oldEventId = (
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(appointments).where(eq(appointments.id, id1)))
    )[0]!.googleEventId!;
    expect(calendar.events.has(oldEventId)).toBe(true);

    const moved = await api('POST', `/v1/appointments/${id1}/reschedule`, {
      date: second!.date,
      time: second!.time,
    });
    expect(moved.statusCode).toBe(200);
    const id2 = (moved.json() as { appointment: { id: string } }).appointment.id;
    expect((await slotsFor('Consultation', '2026-10-10')).some((s) => s.time === first!.time)).toBe(true);
    await t.drainJobs();
    expect(calendar.events.has(oldEventId)).toBe(false); // the old slot's event is removed, not left behind

    const eventId = (
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(appointments).where(eq(appointments.id, id2)))
    )[0]!.googleEventId!;
    expect(calendar.events.has(eventId)).toBe(true);
    expect((await api('POST', `/v1/appointments/${id2}/cancel`)).json()).toMatchObject({
      status: 'cancelled',
    });
    await t.drainJobs();
    expect(calendar.events.has(eventId)).toBe(false);
    expect(
      (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))))[0]?.state,
    ).toBe('qualified');
  });

  test('completed and no-show come from staff; invalid moves are refused', async () => {
    const leadId = await newLead();
    const [slot] = await slotsFor('Consultation', '2026-10-12');
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: slot!.date,
      time: slot!.time,
      source: 'staff',
    });
    expect((await api('POST', `/v1/appointments/${appointment.id}/complete`)).json()).toMatchObject({
      status: 'completed',
    });
    const again = await api('POST', `/v1/appointments/${appointment.id}/no-show`);
    expect(again.statusCode).toBe(409);
    await t.drainJobs();
  });

  test('the Today list joins lead names', async () => {
    const res = await api('GET', '/v1/appointments?from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z');
    expect(res.json()).toEqual([expect.objectContaining({ leadName: 'Kavya Rao', status: 'scheduled' })]);
  });
});

describe('booking through the assistant (mock mode)', () => {
  test('qualify -> offered slots -> pick "2" -> booked (pending), then reschedule and cancel by chat', async () => {
    const say = async (text: string) => {
      await api('POST', '/v1/dev/whatsapp/inbound', { from: '9811122233', text });
      await t.drainAssistant();
      await t.drainJobs();
      const [l] = await withTenant(t.ctx.db, A, (tx) =>
        tx.select().from(leads).where(eq(leads.phoneE164, '+919811122233')),
      );
      const out = (await thread(l!.id)).filter((m) => m.direction === 'out').map((m) => m.body);
      return { lead: l!, last: out.at(-1) ?? '' };
    };
    await say('Hi, I want teeth whitening');
    const offered = await say('this week please');
    expect(offered.lead.state).toBe('booking_offered');
    expect(offered.last).toMatch(/1\) .*2\) .*3\) /);

    const booked = await say('2');
    expect(booked.lead.state).toBe('booked');
    const all = (await thread(booked.lead.id)).filter((m) => m.direction === 'out').map((m) => m.body);
    expect(all.some((b) => /requested .* for you/.test(b))).toBe(true);
    expect(all.some((b) => /will confirm it shortly/.test(b))).toBe(true); // booking_pending template

    await say('can I reschedule?');
    await say('1');
    const after = (await thread((await say('thanks')).lead.id)).map((m) => m.body);
    expect(after.some((b) => /moved to/.test(b))).toBe(true);

    const cancelled = await say('please cancel my appointment');
    expect(cancelled.lead.state).toBe('qualified');
    expect(cancelled.last).toMatch(/cancelled/);
  });
});
