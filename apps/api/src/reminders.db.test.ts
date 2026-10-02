import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, rescheduleLeadAppointment, updateAppointment } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, enrollments, enrollmentSteps, messages } from './db/schema.ts';
import { sweepDueSteps } from './sequences.ts';
import { createAppContext } from './system/context.ts';

// Do reminders survive restarts, reschedules, cancels, quiet hours and leave?
// Clock: Mon 5 Oct 2026, 10:00 IST. Dental preset: staff_confirm, Mon-Sat 10:00-20:00, quiet hours 21:00-09:00.
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;
const HOUR = 3_600_000;
const ist = (iso: string) => new Date(`${iso}+05:30`);

beforeAll(async () => {
  t = await createTestContext();
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

const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const newLead = async () => {
  const phone = `98770${String(++n).padStart(5, '0')}`;
  const res = await api('POST', '/v1/leads', { phone, name: 'Gauri', consent: { granted: true } });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
};
const book = async (leadId: string, date: string, time: string, source: 'staff' | 'assistant' = 'staff') =>
  (await bookSlot(t.ctx, A, { leadId, service: 'Consultation', date, time, source })).appointment;
const reminderMessages = async (leadId: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.occurredAt)),
    )
  ).filter((m) => m.templateKey === 'reminder_24h' || m.templateKey === 'reminder_2h');
const stepsOf = (appointmentId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx
      .select({ e: enrollments, s: enrollmentSteps })
      .from(enrollmentSteps)
      .innerJoin(enrollments, eq(enrollments.id, enrollmentSteps.enrollmentId))
      .where(and(eq(enrollments.appointmentId, appointmentId), eq(enrollments.kind, 'reminders')))
      .orderBy(asc(enrollmentSteps.dueAt)),
  );

describe('server restarts', () => {
  test('reminders live in the database: a step claimed by a worker that died is reclaimed and sent by a brand-new process', async () => {
    const leadId = await newLead();
    const appt = await book(leadId, '2026-10-08', '12:00'); // Thu 12:00 -> 24 h reminder Wed 12:00
    const before = await stepsOf(appt.id);
    expect(before.map((r) => r.s.status)).toEqual(['pending', 'pending']);

    // Wed 12:30: the 24 h reminder is due. A worker claims it ("queued") and then the process dies.
    t.clock.advance(ist('2026-10-07T12:30:00').getTime() - t.clock.now().getTime());
    await t.owner.query(
      `update enrollment_steps set status = 'queued', attempts = 1, updated_at = now() - interval '20 minutes' where id = $1`,
      [before[0]!.s.id],
    );
    expect(await reminderMessages(leadId)).toHaveLength(0);

    // A new process (new connections, new job runner) starts and sweeps.
    const second = createAppContext(t.ctx.env, t.clock, {});
    await second.start();
    try {
      expect(await sweepDueSteps(second)).toBe(1);
      const results = await t.drainJobs(); // the queued job is plain data in Postgres
      expect(results.some((r) => r.queue === 'sequence-step')).toBe(true);
    } finally {
      await second.close();
    }
    expect((await reminderMessages(leadId)).map((m) => m.templateKey)).toEqual(['reminder_24h']);
    expect((await stepsOf(appt.id))[0]!.s.status).toBe('sent');
    // And it is not sent twice if the job runs again (idempotency key).
    await t.owner.query(`update enrollment_steps set status = 'queued' where id = $1`, [before[0]!.s.id]);
    await t.drainJobs();
    await sweepDueSteps(t.ctx);
    await t.drainJobs();
    expect(await reminderMessages(leadId)).toHaveLength(1);
  });
});

describe('reschedule', () => {
  test("staff-confirm mode: the old appointment's reminders stop at once, the new ones start only when staff confirm it", async () => {
    const leadId = await newLead();
    const first = await book(leadId, '2026-10-15', '14:00', 'staff'); // staff bookings are confirmed immediately
    expect((await stepsOf(first.id)).every((r) => r.s.status === 'pending')).toBe(true);

    // The assistant (customer) reschedules: staff_confirm makes the new booking pending.
    const moved = (
      await rescheduleLeadAppointment(t.ctx, A, {
        leadId,
        date: '2026-10-16',
        time: '15:00',
        source: 'assistant',
      })
    ).appointment;
    expect(moved.status).toBe('pending');
    const old = await stepsOf(first.id);
    expect(old.every((r) => r.e.status === 'stopped' && r.e.stopReason === 'rescheduled')).toBe(true);
    expect(old.every((r) => r.s.status === 'cancelled')).toBe(true);
    expect(await stepsOf(moved.id)).toHaveLength(0); // nothing for the new time until it is confirmed

    await updateAppointment(t.ctx, A, moved.id, 'confirmed');
    const fresh = await stepsOf(moved.id);
    expect(fresh).toHaveLength(2);
    expect(fresh[0]!.s.dueAt!.getTime()).toBe(ist('2026-10-15T15:00:00').getTime()); // 24 h before the NEW time
  });

  test('a reminder that was already queued for the old time is dropped at send time (the appointment is not on any more)', async () => {
    const leadId = await newLead();
    const first = await book(leadId, '2026-10-19', '12:00');
    const [due] = await stepsOf(first.id);
    // Move it, but pretend the old reminder had been claimed just before the move.
    await rescheduleLeadAppointment(t.ctx, A, { leadId, date: '2026-10-20', time: '12:00', source: 'staff' });
    await t.owner.query(`update enrollment_steps set status = 'queued' where id = $1`, [due!.s.id]);
    t.clock.advance(ist('2026-10-18T13:00:00').getTime() - t.clock.now().getTime());
    await t.drainJobs();
    await sweepDueSteps(t.ctx);
    await t.drainJobs();
    const sentFor = (await reminderMessages(leadId)).filter((m) => /19 Oct|Mon, 19/.test(m.body));
    expect(sentFor).toHaveLength(0);
  });
});

describe('cancel and leave', () => {
  test('cancelling stops the reminders and nothing is sent afterwards', async () => {
    const leadId = await newLead();
    const appt = await book(leadId, '2026-10-22', '12:00');
    await updateAppointment(t.ctx, A, appt.id, 'cancelled', { cancelReason: 'staff' });
    expect(
      (await stepsOf(appt.id)).every((r) => r.e.status === 'stopped' && r.s.status === 'cancelled'),
    ).toBe(true);
    await t.advance((ist('2026-10-22T11:00:00').getTime() - t.clock.now().getTime()) / HOUR);
    expect(await reminderMessages(leadId)).toHaveLength(0);
  });

  test("doctor leave: the displaced booking's reminders stop and the patient gets the change notice instead", async () => {
    const leadId = await newLead();
    const appt = await book(leadId, '2026-10-26', '12:00');
    const block = (
      await api('POST', '/v1/blocked-times', {
        starts_at: ist('2026-10-26T11:00:00').toISOString(),
        ends_at: ist('2026-10-26T13:00:00').toISOString(),
        reason: 'Leave',
      })
    ).json() as { id: string };
    // Nothing happens until staff decide.
    expect((await stepsOf(appt.id)).every((r) => r.s.status === 'pending')).toBe(true);
    await api('POST', `/v1/blocked-times/${block.id}/notify`);
    await t.drainJobs();
    expect((await stepsOf(appt.id)).every((r) => r.e.status === 'stopped')).toBe(true);
    await t.advance((ist('2026-10-26T11:30:00').getTime() - t.clock.now().getTime()) / HOUR);
    expect(await reminderMessages(leadId)).toHaveLength(0);
    const all = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, leadId)),
    );
    expect(all.some((m) => m.templateKey === 'appointment_change')).toBe(true);
    const [row] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appt.id)),
    );
    expect(row?.status).toBe('cancelled');
  });
});

describe('quiet hours', () => {
  test('a reminder due while the customer is asleep waits until 09:00 and is still sent before the visit', async () => {
    const leadId = await newLead();
    await book(leadId, '2026-11-03', '10:00'); // 2 h reminder due 08:00 = inside quiet hours (21:00-09:00)
    await t.advance((ist('2026-11-02T12:00:00').getTime() - t.clock.now().getTime()) / HOUR); // the 24 h reminder goes out
    await t.advance((ist('2026-11-03T08:05:00').getTime() - t.clock.now().getTime()) / HOUR);
    expect((await reminderMessages(leadId)).map((m) => m.templateKey)).toEqual(['reminder_24h']); // the 24 h one went the day before; the 2 h one is waiting
    const waiting = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(enrollmentSteps)
        .where(and(eq(enrollmentSteps.templateKey, 'reminder_2h'), eq(enrollmentSteps.status, 'pending'))),
    );
    expect(waiting.some((s) => s.dueAt!.getTime() === ist('2026-11-03T09:00:00').getTime())).toBe(true);
    await t.advance(1);
    expect((await reminderMessages(leadId)).map((m) => m.templateKey)).toEqual([
      'reminder_24h',
      'reminder_2h',
    ]);
  });

  test('if quiet hours last until after the visit, the reminder is skipped rather than sent late', async () => {
    const cfg = (
      (await api('GET', '/v1/config')).json() as {
        config: { locale: { quiet_hours: { start: string; end: string } } };
      }
    ).config;
    cfg.locale.quiet_hours = { start: '20:00', end: '11:00' };
    expect((await api('PUT', '/v1/config', cfg)).statusCode).toBe(200);
    const leadId = await newLead();
    const appt = await book(leadId, '2026-11-05', '10:00');
    await t.advance((ist('2026-11-05T09:30:00').getTime() - t.clock.now().getTime()) / HOUR);
    const steps = await stepsOf(appt.id);
    const twoHour = steps.find((r) => r.s.templateKey === 'reminder_2h')!;
    expect(twoHour.s.status).toBe('skipped');
    expect(twoHour.s.lastError).toMatch(/quiet hours until the deadline/);
    expect((await reminderMessages(leadId)).map((m) => m.templateKey)).not.toContain('reminder_2h');
  });
});
