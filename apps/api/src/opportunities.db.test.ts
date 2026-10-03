import type { TenantConfig } from '@instantlead/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots, updateAppointment } from './booking.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { leads, messages, opportunities, treatmentPlans } from './db/schema.ts';
import { sweepOpportunities } from './opportunities.ts';

let t: TestContext;
let A: string;
let B: string;
let cookieA: string;
let cookieB: string;
let n = 0;
const DAY = 86_400_000;

beforeAll(async () => {
  // Mon 5 Oct 2026, 10:00 IST (quiet hours end at 09:00): every advance below is whole days.
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
  await setConfig((c) => ({ ...c, booking: { ...c.booking, mode: 'auto_confirm' } }));
});
afterAll(() => t.close());

async function setConfig(change: (c: TenantConfig) => TenantConfig) {
  await withTenant(t.ctx.db, A, async (tx) => {
    const config = change(structuredClone((await getActiveConfig(tx))!.config));
    await saveConfig(tx, t.clock, { type: 'system' }, config);
  });
}
const api = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
async function newLead(name = 'Priya') {
  const res = await api(cookieA, 'POST', '/v1/leads', {
    phone: `98744${String(++n).padStart(5, '0')}`,
    name,
    consent: { granted: true },
  });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
}
async function book(leadId: string, service = 'Consultation') {
  const [slot] = (await findSlots(t.ctx, A, { service, limit: 1, spread: false })).slots;
  const r = await bookSlot(t.ctx, A, { leadId, service, date: slot!.date, time: slot!.time, source: 'staff' });
  await t.drainJobs();
  return r.appointment;
}
const sweep = async () => {
  const r = await sweepOpportunities(t.ctx);
  await t.drainJobs();
  return r;
};
const oppsOf = (leadId: string) =>
  withTenant(t.ctx.db, A, (tx) => tx.select().from(opportunities).where(eq(opportunities.leadId, leadId)));
const templatesSent = (leadId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx
      .select({ key: messages.templateKey, body: messages.body, status: messages.status })
      .from(messages)
      .where(and(eq(messages.leadId, leadId), eq(messages.direction, 'out'))),
  ).then((rows) => rows.filter((r) => r.key && r.status === 'sent'));
const addPlan = (leadId: string, payload: object) =>
  api(cookieA, 'POST', `/v1/leads/${leadId}/treatment-plans`, payload).then((r) => r.json() as { id: string });

describe('no-show → recovery', () => {
  test('a no-show becomes an opportunity handled by the recovery sequence, and is won when they rebook', async () => {
    const leadId = await newLead('Nisha');
    const appt = await book(leadId);
    t.clock.advance(2 * DAY);
    await updateAppointment(t.ctx, A, appt.id, 'no_show');
    await sweep();
    let [o] = await oppsOf(leadId);
    expect(o).toMatchObject({ kind: 'NO_SHOW', status: 'actioned', aiActed: true });
    await book(leadId);
    await sweep();
    [o] = await oppsOf(leadId);
    expect(o).toMatchObject({ status: 'won', outcome: 'booked again' });
  });
});

describe('treatment journeys', () => {
  test('a stalled treatment gets one clinic-approved follow-up; sweeping again sends nothing more', async () => {
    const leadId = await newLead('Meera');
    await addPlan(leadId, { title: 'Root canal, 3 visits', service: 'Root canal consultation', status: 'accepted', visits_planned: 3 });
    t.clock.advance(8 * DAY);
    await sweep();
    const [o] = await oppsOf(leadId);
    expect(o).toMatchObject({ kind: 'STALLED_TREATMENT', status: 'actioned', aiActed: true, valueInr: null });
    expect(o!.valueSource).toBeNull(); // no value entered: unavailable, never estimated
    await sweep();
    await sweep();
    const sent = await templatesSent(leadId);
    expect(sent.filter((m) => m.key === 'treatment_followup')).toHaveLength(1);
    expect(sent.find((m) => m.key === 'treatment_followup')?.body).toContain('Root canal, 3 visits');
  });

  test('recall due after a completed plan → reminder → rebooking wins it', async () => {
    const leadId = await newLead('Kavya');
    const plan = await addPlan(leadId, {
      title: 'Scaling',
      status: 'completed',
      recall_due_at: new Date(t.clock.now().getTime() + DAY).toISOString(),
    });
    await sweep();
    expect(await oppsOf(leadId)).toEqual([]); // not due yet
    t.clock.advance(2 * DAY);
    await sweep();
    let [o] = await oppsOf(leadId);
    expect(o).toMatchObject({ kind: 'RECALL_DUE', status: 'actioned', treatmentPlanId: plan.id });
    expect((await templatesSent(leadId)).map((m) => m.key)).toContain('recall_due');
    await book(leadId);
    await sweep();
    [o] = await oppsOf(leadId);
    expect(o?.status).toBe('won');
  });

  test('payment: only from clinic-recorded amounts; no link = staff call; with a link the reminder carries the exact balance', async () => {
    const leadId = await newLead('Farah');
    await addPlan(leadId, { title: 'Crown', status: 'in_progress', value_inr: 8000, paid_inr: 3000, visits_done: 1 });
    const noValue = await newLead('Gita');
    await addPlan(noValue, { title: 'Crown', status: 'in_progress', visits_done: 1 });
    await sweep();
    let [o] = await oppsOf(leadId);
    expect(o).toMatchObject({ kind: 'PAYMENT_FOLLOWUP', status: 'open', valueInr: 5000, valueSource: 'treatment_plan' });
    expect(o!.recommendedAction).toMatch(/Call about the balance/);
    expect((await oppsOf(noValue)).filter((x) => x.kind === 'PAYMENT_FOLLOWUP')).toEqual([]);
    expect((await templatesSent(leadId)).map((m) => m.key)).toEqual(['first_reply']);

    await setConfig((c) => ({ ...c, journeys: { ...c.journeys!, ...JOURNEYS, payment_url: 'https://pay.example.in/smile' } }));
    await sweep();
    [o] = await oppsOf(leadId);
    expect(o?.status).toBe('actioned');
    const reminder = (await templatesSent(leadId)).find((m) => m.key === 'payment_reminder');
    expect(reminder?.body).toContain('Rs. 5,000');
    expect(reminder?.body).toContain('https://pay.example.in/smile');
  });
});

const JOURNEYS = {
  stall_grace_days: 7,
  recall_months: 6,
  lost_lead_after_hours: 48,
  max_outreach_per_day: 30,
  waitlist_offer_minutes: 30,
  waitlist_batch: 3,
};

describe('lost leads, approval, caps and opt-out', () => {
  const qualify = (leadId: string, tier: 'hot' | 'warm') =>
    withTenant(t.ctx.db, A, (tx) => tx.update(leads).set({ state: 'qualified', tier }).where(eq(leads.id, leadId)));

  test('approval mode waits for staff; approving sends it; clinic B can neither see nor approve it', async () => {
    await setConfig((c) => ({ ...c, autonomy: { reactivate: 'approval' } }));
    const leadId = await newLead('Lata');
    await qualify(leadId, 'hot');
    t.clock.advance(3 * DAY);
    await sweep();
    const [o] = await oppsOf(leadId);
    expect(o).toMatchObject({ kind: 'LOST_LEAD', status: 'needs_approval', aiActed: false });
    expect(await templatesSent(leadId)).toHaveLength(1); // only the first reply

    const listB = (await api(cookieB, 'GET', '/v1/opportunities')).json() as unknown[];
    expect(listB).toEqual([]);
    expect((await api(cookieB, 'POST', `/v1/opportunities/${o!.id}/approve`)).statusCode).toBe(404);

    expect((await api(cookieA, 'POST', `/v1/opportunities/${o!.id}/approve`)).statusCode).toBe(200);
    await t.drainJobs();
    expect((await oppsOf(leadId))[0]).toMatchObject({ status: 'actioned', aiActed: true });
    expect((await templatesSent(leadId)).map((m) => m.key)).toContain('lead_reactivation');
    await setConfig((c) => ({ ...c, autonomy: {} }));
  });

  test('the daily outreach cap bounds how much the assistant sends', async () => {
    await setConfig((c) => ({ ...c, journeys: { ...JOURNEYS, max_outreach_per_day: 1 } }));
    const ids = [await newLead('C1'), await newLead('C2'), await newLead('C3')];
    for (const id of ids) await qualify(id, 'warm');
    t.clock.advance(3 * DAY);
    await sweep();
    await sweep();
    const sent = (await Promise.all(ids.map(templatesSent))).flat().filter((m) => m.key === 'lead_reactivation');
    expect(sent).toHaveLength(1);
    await setConfig((c) => ({ ...c, journeys: JOURNEYS }));
  });

  test('STOP and staff takeover stop outreach for good', async () => {
    const stopped = await newLead('Opt');
    const paused = await newLead('Paused');
    for (const id of [stopped, paused]) await qualify(id, 'hot');
    await api(cookieA, 'POST', `/v1/leads/${stopped}/opt-out`);
    await api(cookieA, 'POST', `/v1/leads/${paused}/takeover`);
    // The opted-out lead is no longer "qualified", so it is never even detected.
    t.clock.advance(3 * DAY);
    await sweep();
    expect(await oppsOf(stopped)).toEqual([]);
    const [o] = await oppsOf(paused);
    expect(o?.outcome).toMatch(/taken over/);
    expect((await templatesSent(paused)).map((m) => m.key)).not.toContain('lead_reactivation');
    expect((await templatesSent(stopped)).map((m) => m.key)).not.toContain('lead_reactivation');
  });

  test('detection is idempotent (unique kind + subject per clinic)', async () => {
    const before = await withTenant(t.ctx.db, A, (tx) => tx.select().from(opportunities));
    const r = await sweepOpportunities(t.ctx);
    const after = await withTenant(t.ctx.db, A, (tx) => tx.select().from(opportunities));
    expect(r.found).toBe(0);
    expect(after.length).toBe(before.length);
    await expect(
      t.owner.query(
        `insert into opportunities (tenant_id, kind, subject_key, priority, reason, recommended_action, detected_at)
         select tenant_id, kind, subject_key, 1, 'x', 'x', now() from opportunities limit 1`,
      ),
    ).rejects.toThrow(/duplicate key/);
    const [plan] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(treatmentPlans).limit(1));
    expect(plan).toBeDefined();
  });
});
