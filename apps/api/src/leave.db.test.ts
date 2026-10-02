import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, enrollments, enrollmentSteps, leads, messages } from './db/schema.ts';

// Doctor on leave / clinic closed after people booked. Clock: Mon 5 Oct 2026, 10:00 IST.
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

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

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function booked(date: string, time: string) {
  const phone = `98762${String(++n).padStart(5, '0')}`;
  const res = await call('POST', '/v1/leads', { phone, name: 'Priya Sharma', consent: { granted: true } });
  const leadId = (res.json() as { lead_id: string }).lead_id;
  await t.drainJobs();
  const r = await bookSlot(t.ctx, A, { leadId, service: 'Consultation', date, time, source: 'staff' });
  await t.drainJobs();
  return { leadId, phone, appt: r.appointment };
}
const appt = async (id: string) =>
  (await withTenant(t.ctx.db, A, (tx) => tx.select().from(appointments).where(eq(appointments.id, id))))[0]!;
const out = async (leadId: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, leadId))
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
    )
  ).filter((m) => m.direction === 'out');
/** IST wall time -> ISO. */
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).toISOString();

describe('one doctor on leave', () => {
  test('blocking shows affected bookings; nothing is sent until staff choose to notify', async () => {
    const { leadId, appt: a } = await booked('2026-10-07', '15:00'); // Wed
    const before = (await out(leadId)).length;
    const res = await call('POST', '/v1/blocked-times', {
      starts_at: ist('2026-10-07', '00:00'),
      ends_at: ist('2026-10-08', '00:00'),
      reason: 'Doctor on leave',
    });
    expect(res.statusCode).toBe(201);
    const block = res.json() as { id: string; affected: { id: string }[] };
    expect(block.affected.map((x) => x.id)).toEqual([a.id]);
    const avail = (await call('GET', '/v1/availability')).json() as { blocked: { affected: unknown[] }[] };
    expect(avail.blocked[0]?.affected).toHaveLength(1);
    await t.drainJobs();
    expect(await out(leadId)).toHaveLength(before); // staff review first

    const notify = await call('POST', `/v1/blocked-times/${block.id}/notify`);
    expect(notify.json()).toEqual({ results: [{ appointmentId: a.id, action: 'notified' }] });
    await t.drainJobs();
    expect(await appt(a.id)).toMatchObject({ status: 'cancelled', cancelReason: 'clinic_unavailable' });
    expect((await out(leadId)).at(-1)).toMatchObject({ templateKey: 'appointment_change' });
    const reminders = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select({ status: enrollmentSteps.status })
        .from(enrollmentSteps)
        .innerJoin(enrollments, eq(enrollments.id, enrollmentSteps.enrollmentId))
        .where(eq(enrollments.leadId, leadId)),
    );
    expect(reminders.some((r) => r.status === 'pending')).toBe(false);
    // Idempotent: nothing left inside the block.
    expect((await call('POST', `/v1/blocked-times/${block.id}/notify`)).json()).toEqual({ results: [] });
  });

  test('[Show new times] offers free times outside the leave, and picking one books it', async () => {
    const { leadId, phone } = await (async () => {
      const [l] = await withTenant(t.ctx.db, A, (tx) =>
        tx
          .select()
          .from(leads)
          .where(eq(leads.phoneE164, `+9198762${String(n).padStart(5, '0')}`)),
      );
      return { leadId: l!.id, phone: `98762${String(n).padStart(5, '0')}` };
    })();
    await call('POST', '/v1/dev/whatsapp/inbound', {
      from: phone,
      button_payload: 'appointment_change:times',
      text: 'Show new times',
    });
    await t.drainAssistant();
    const offer = (await out(leadId)).at(-1)!.body;
    expect(offer).toMatch(/Here are the next free times for your Consultation: 1\) /);
    expect(offer).not.toMatch(/7 Oct/); // the leave day
    await call('POST', '/v1/dev/whatsapp/inbound', { from: phone, text: '1' });
    await t.drainAssistant();
    await t.drainJobs();
    const [l] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId)));
    expect(l?.state).toBe('booked');
  });
});

describe('two doctors', () => {
  test('a booking moves to the other free doctor at the same time; a whole-clinic closure affects everyone', async () => {
    const rules = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].flatMap((weekday) =>
      ['Dr Mehta', 'Dr Rao'].map((resource) => ({
        weekday,
        start_time: '10:00',
        end_time: '20:00',
        resource,
      })),
    );
    expect((await call('PUT', '/v1/availability', rules)).statusCode).toBe(200);
    const first = await booked('2026-10-08', '15:00'); // Thu
    const second = await booked('2026-10-08', '15:00'); // same time, the other doctor
    const docOf = async (id: string) => (await appt(id)).resource;
    const onMehta = (await docOf(first.appt.id)) === 'Dr Mehta' ? first : second;
    const onRao = onMehta === first ? second : first;
    expect(await docOf(onRao.appt.id)).toBe('Dr Rao');

    // Mehta on leave at 15:00, but Rao is busy then too: Mehta's patient can't be moved.
    const leave = (
      await call('POST', '/v1/blocked-times', {
        starts_at: ist('2026-10-08', '14:00'),
        ends_at: ist('2026-10-08', '17:00'),
        resource: 'Dr Mehta',
      })
    ).json() as { id: string; affected: { id: string }[] };
    expect(leave.affected.map((x) => x.id)).toEqual([onMehta.appt.id]);

    // Free Rao at 15:00 by booking him elsewhere? Simpler: cancel Rao's patient, then Mehta's can move.
    await call('POST', `/v1/appointments/${onRao.appt.id}/cancel`);
    await t.drainJobs();
    const before = (await out(onMehta.leadId)).length;
    expect((await call('POST', `/v1/blocked-times/${leave.id}/notify`)).json()).toEqual({
      results: [{ appointmentId: onMehta.appt.id, action: 'moved', to: 'Dr Rao' }],
    });
    await t.drainJobs();
    expect(await appt(onMehta.appt.id)).toMatchObject({ status: 'scheduled', resource: 'Dr Rao' });
    expect(await out(onMehta.leadId)).toHaveLength(before); // same time, nothing to tell them

    // Clinic closed on Friday: every booking that day is affected, whichever doctor.
    const f1 = await booked('2026-10-09', '11:00');
    const f2 = await booked('2026-10-09', '11:00');
    const closure = (
      await call('POST', '/v1/blocked-times', {
        starts_at: ist('2026-10-09', '00:00'),
        ends_at: ist('2026-10-10', '00:00'),
        reason: 'Diwali',
      })
    ).json() as { affected: { id: string }[] };
    expect(closure.affected.map((x) => x.id).sort()).toEqual([f1.appt.id, f2.appt.id].sort());
  });
});
