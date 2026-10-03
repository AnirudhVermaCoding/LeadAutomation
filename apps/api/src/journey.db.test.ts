import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots, updateAppointment } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, treatmentPlans } from './db/schema.ts';
import type { TimelineEntry } from './journey.ts';

let t: TestContext;
let A: string;
let B: string;
let cookieA: string;
let cookieB: string;
let n = 0;

beforeAll(async () => {
  // Mon 5 Oct 2026, 10:00 IST; dental preset (staff_confirm).
  t = await createTestContext();
  const mk = async (slug: string) =>
    (
      await t.ctx.system.createTenant(
        {
          slug,
          name: `Clinic ${slug}`,
          preset: 'clinic_dental',
          admin: { email: `admin@${slug}.test`, name: slug, password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
  A = await mk('a');
  B = await mk('b');
  cookieA = await t.signIn('admin@a.test');
  cookieB = await t.signIn('admin@b.test');
});
afterAll(() => t.close());

const api = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function newLead(name = 'Priya') {
  const res = await api(cookieA, 'POST', '/v1/leads', {
    phone: `98711${String(++n).padStart(5, '0')}`,
    name,
    consent: { granted: true },
  });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
}
const firstSlot = async (service: string, date?: string) =>
  (await findSlots(t.ctx, A, { service, date, limit: 1, spread: false })).slots[0]!;
const timelineOf = async (leadId: string, cookie = cookieA) =>
  (await api(cookie, 'GET', `/v1/leads/${leadId}/timeline`)).json() as {
    entries: TimelineEntry[];
    plans: (typeof treatmentPlans.$inferSelect)[];
  };

describe('patient timeline', () => {
  test('enquiry → qualification → booking → attendance show up in order, one patient', async () => {
    const leadId = await newLead();
    const slot = await firstSlot('Consultation', '2026-10-06');
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: slot.date,
      time: slot.time,
      source: 'staff',
    });
    await t.drainJobs();
    t.clock.advance(30 * 3_600_000);
    await updateAppointment(t.ctx, A, appointment.id, 'completed');
    const { entries } = await timelineOf(leadId);
    const titles = entries.map((e) => e.title);
    expect(titles).toContain('Enquiry received');
    expect(titles).toContain('Appointment booked');
    expect(titles).toContain('Visit completed');
    expect(titles.indexOf('Enquiry received')).toBeLessThan(titles.indexOf('Appointment booked'));
    expect(titles.indexOf('Appointment booked')).toBeLessThan(titles.indexOf('Visit completed'));
    // WhatsApp messages are on the same timeline.
    expect(entries.some((e) => e.channel === 'whatsapp' && e.title.startsWith('Template sent'))).toBe(true);
  });

  test('staff takeover and hand-back are recorded as human intervention', async () => {
    const leadId = await newLead('Ravi');
    expect((await api(cookieA, 'POST', `/v1/leads/${leadId}/takeover`)).statusCode).toBe(200);
    expect((await api(cookieA, 'POST', `/v1/leads/${leadId}/resume`)).statusCode).toBe(200);
    const human = (await timelineOf(leadId)).entries.filter((e) => e.stage === 'human').map((e) => e.title);
    expect(human).toEqual(['Staff took over the conversation', 'Assistant resumed']);
  });
});

describe('treatment plans', () => {
  test('staff create a plan; a matching booking links to it; completed visits advance it, then set recall', async () => {
    const leadId = await newLead('Meera');
    const created = await api(cookieA, 'POST', `/v1/leads/${leadId}/treatment-plans`, {
      title: 'Root canal, 2 visits',
      service: 'Root canal consultation',
      status: 'accepted',
      visits_planned: 2,
      visit_interval_days: 7,
      value_inr: 8000,
      paid_inr: 3000,
    });
    expect(created.statusCode).toBe(201);
    const planId = (created.json() as { id: string }).id;

    const slot = await firstSlot('Root canal consultation', '2026-10-07');
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Root canal consultation',
      date: slot.date,
      time: slot.time,
      source: 'assistant',
    });
    expect(appointment.treatmentPlanId).toBe(planId);
    await t.drainJobs();

    t.clock.advance(3 * 86_400_000);
    await updateAppointment(t.ctx, A, appointment.id, 'completed');
    let plan = (await timelineOf(leadId)).plans[0]!;
    expect(plan).toMatchObject({ visitsDone: 1, status: 'in_progress' });
    expect(new Date(plan.nextVisitDueAt!).getTime()).toBe(t.clock.now().getTime() + 7 * 86_400_000);

    const slot2 = await firstSlot('Root canal consultation', '2026-10-12');
    const second = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Root canal consultation',
      date: slot2.date,
      time: slot2.time,
      source: 'staff',
      treatmentPlanId: planId,
    });
    t.clock.advance(5 * 86_400_000);
    await updateAppointment(t.ctx, A, second.appointment.id, 'completed');
    plan = (await timelineOf(leadId)).plans[0]!;
    expect(plan).toMatchObject({ visitsDone: 2, status: 'completed', nextVisitDueAt: null });
    expect(plan.recallDueAt).not.toBeNull();
    const titles = (await timelineOf(leadId)).entries.map((e) => e.title);
    expect(titles).toContain('Treatment plan added');
    expect(titles).toContain('Treatment completed');
  });

  test('a plan cannot be attached to another patient, and validation rejects bad input', async () => {
    const a = await newLead('Asha');
    const b = await newLead('Bina');
    const plan = (
      await api(cookieA, 'POST', `/v1/leads/${a}/treatment-plans`, {
        title: 'Braces review',
        status: 'accepted',
      })
    ).json() as { id: string };
    const slot = await firstSlot('Consultation');
    const res = await api(cookieA, 'POST', '/v1/appointments', {
      lead_id: b,
      service: 'Consultation',
      date: slot.date,
      time: slot.time,
      treatment_plan_id: plan.id,
    });
    expect(res.statusCode).toBe(404);
    const bad = await api(cookieA, 'POST', `/v1/leads/${a}/treatment-plans`, { title: 'x', value_inr: -5 });
    expect(bad.statusCode).toBe(400);
  });

  test('clinic B cannot read or change clinic A plans or timelines', async () => {
    const leadId = await newLead('Zoya');
    const plan = (
      await api(cookieA, 'POST', `/v1/leads/${leadId}/treatment-plans`, {
        title: 'Implant',
        status: 'proposed',
      })
    ).json() as { id: string };
    expect((await api(cookieB, 'GET', `/v1/leads/${leadId}/timeline`)).statusCode).toBe(404);
    expect(
      (await api(cookieB, 'PATCH', `/v1/treatment-plans/${plan.id}`, { status: 'declined' })).statusCode,
    ).toBe(404);
    expect(
      (await api(cookieB, 'POST', `/v1/leads/${leadId}/treatment-plans`, { title: 'Steal' })).statusCode,
    ).toBe(404);
    const [row] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(treatmentPlans).where(eq(treatmentPlans.id, plan.id)),
    );
    expect(row?.status).toBe('proposed');
    // RLS: B's transaction sees none of A's plans or appointments.
    const seen = await withTenant(t.ctx.db, B, async (tx) => ({
      plans: await tx.select().from(treatmentPlans),
      appts: await tx.select().from(appointments),
    }));
    expect(seen).toEqual({ plans: [], appts: [] });
  });
});

describe('payment schedules', () => {
  type Inst = { id: string; seq: number; amountInr: number; status: string; dueAt: string };
  const schedule = (leadId: string) =>
    timelineOf(leadId).then((r) => (r as unknown as { installments: Inst[] }).installments);

  test('a braces plan split into instalments: amounts add up to what is owed; paying moves the plan total; rescheduling keeps paid ones', async () => {
    const leadId = await newLead('Isha');
    const plan = (
      await api(cookieA, 'POST', `/v1/leads/${leadId}/treatment-plans`, {
        title: 'Braces (metal)',
        service: 'Braces adjustment',
        status: 'in_progress',
        visits_planned: 18,
        visit_interval_days: 30,
        value_inr: 45000,
        paid_inr: 10000,
      })
    ).json() as { id: string };
    const res = await api(cookieA, 'POST', `/v1/treatment-plans/${plan.id}/installments`, {
      count: 6,
      first_due: '2026-11-01',
      interval_days: 30,
    });
    expect(res.statusCode).toBe(201);
    let rows = await schedule(leadId);
    expect(rows.map((r) => r.amountInr)).toEqual([5833, 5833, 5833, 5833, 5833, 5835]);
    expect(rows.reduce((s, r) => s + r.amountInr, 0)).toBe(35000);

    expect(
      (await api(cookieA, 'PATCH', `/v1/installments/${rows[0]!.id}`, { status: 'paid' })).statusCode,
    ).toBe(200);
    expect((await timelineOf(leadId)).plans[0]!.paidInr).toBe(15833);
    // Undo, then pay again: the total follows.
    await api(cookieA, 'PATCH', `/v1/installments/${rows[0]!.id}`, { status: 'pending' });
    expect((await timelineOf(leadId)).plans[0]!.paidInr).toBe(10000);
    await api(cookieA, 'PATCH', `/v1/installments/${rows[0]!.id}`, { status: 'paid' });

    // Re-plan the rest as 2 bigger instalments: the paid one stays, numbering continues.
    await api(cookieA, 'POST', `/v1/treatment-plans/${plan.id}/installments`, {
      count: 2,
      first_due: '2026-12-01',
      interval_days: 30,
    });
    rows = await schedule(leadId);
    expect(rows.map((r) => [r.seq, r.status, r.amountInr])).toEqual([
      [1, 'paid', 5833],
      [2, 'pending', 14583],
      [3, 'pending', 14584],
    ]);
    const titles = (await timelineOf(leadId)).entries.map((e) => e.title);
    expect(titles).toContain('Payment schedule set');
    expect(titles).toContain('Payment recorded');
  });

  test('no total and no amount: refused with a clear message; clinic B cannot touch A instalments', async () => {
    const leadId = await newLead('Nina');
    const plan = (
      await api(cookieA, 'POST', `/v1/leads/${leadId}/treatment-plans`, {
        title: 'Implant',
        status: 'accepted',
      })
    ).json() as { id: string };
    const bad = await api(cookieA, 'POST', `/v1/treatment-plans/${plan.id}/installments`, {
      count: 3,
      first_due: '2026-11-01',
      interval_days: 30,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ message: expect.stringMatching(/treatment total/) });
    await api(cookieA, 'POST', `/v1/treatment-plans/${plan.id}/installments`, {
      count: 3,
      first_due: '2026-11-01',
      interval_days: 30,
      amount_inr: 20000,
    });
    const [first] = await schedule(leadId);
    expect(
      (await api(cookieB, 'PATCH', `/v1/installments/${first!.id}`, { status: 'paid' })).statusCode,
    ).toBe(404);
    expect(
      (
        await api(cookieB, 'POST', `/v1/treatment-plans/${plan.id}/installments`, {
          count: 1,
          first_due: '2026-11-01',
          interval_days: 30,
          amount_inr: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect((await schedule(leadId))[0]!.status).toBe('pending');
  });
});
