import { HOUR } from '@instantlead/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { updateAppointment } from './booking.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { appointments, leads, messages } from './db/schema.ts';
import { computeReport } from './reports.ts';
import { runStaffDigest } from './staff-digest.ts';

// A property business through its whole lifecycle (mock assistant): nothing a customer or the
// agent receives may sound like a clinic. Clock: Mon 5 Oct 2026, 10:00 IST.
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  t = await createTestContext();
  A = (
    await t.ctx.system.createTenant(
      {
        slug: 'sky',
        name: 'Skyline Realty',
        preset: 'real_estate',
        admin: { email: 'admin@sky.test', name: 'S', password: PASSWORD },
      },
      { type: 'system' },
    )
  ).tenant.id;
  cookie = await t.signIn('admin@sky.test');
});
afterAll(() => t.close());

const CLINIC_WORDS = /\b(patients?|doctors?|dentist|clinic|treatment|dental)\b/i;
const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const phone = () => `98763${String(++n).padStart(5, '0')}`;
async function chat(from: string, ...texts: (string | object)[]) {
  for (const x of texts) {
    await call('POST', '/v1/dev/whatsapp/inbound', { from, ...(typeof x === 'string' ? { text: x } : x) });
    await t.drainAssistant();
    await t.drainJobs();
  }
  return (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(leads)
        .where(eq(leads.phoneE164, `+91${from}`)),
    )
  )[0]!;
}

test('the full lifecycle of a property customer never mentions patients, doctors or clinics', async () => {
  // Form lead -> first reply -> qualified -> site visit booked (auto-confirm) -> confirmation.
  const p1 = phone();
  await call('POST', '/v1/leads', { phone: p1, name: 'Rohit Mehra', consent: { granted: true } });
  await t.drainJobs();
  const buyer = await chat(
    p1,
    'Hi, looking for a 3BHK',
    'budget around 1 crore',
    'Baner or Aundh',
    'immediately',
    '1',
  );
  expect(buyer).toMatchObject({ state: 'booked', tier: 'hot' });
  const [visit] = await withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(appointments).where(eq(appointments.leadId, buyer.id)),
  );
  expect(visit?.status).toBe('scheduled'); // real estate confirms instantly

  // Reminder, the visit happens, review request.
  await t.advance((visit!.startsAt.getTime() - t.clock.now().getTime()) / HOUR + 0.5);
  await updateAppointment(t.ctx, A, visit!.id, 'completed');
  await t.drainJobs();
  await t.advance(4);

  // Another buyer: booked, then the agent is unavailable that day -> told, offered new times.
  const p2 = phone();
  const second = await chat(p2, 'need a 2bhk', 'around 60 lakh', 'Wakad', 'immediately', '2');
  const [v2] = await withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(appointments).where(eq(appointments.leadId, second.id)),
  );
  const day = new Date(v2!.startsAt.getTime());
  const block = (
    await call('POST', '/v1/blocked-times', {
      starts_at: new Date(day.getTime() - HOUR).toISOString(),
      ends_at: new Date(day.getTime() + 2 * HOUR).toISOString(),
      reason: 'Agent at another site',
    })
  ).json() as { id: string };
  await call('POST', `/v1/blocked-times/${block.id}/notify`);
  await t.drainJobs();
  await chat(p2, { button_payload: 'appointment_change:times', text: 'Show new times' });

  // Photo, voice note, running late, a vendor, a no-show, the evening digest.
  await chat(phone(), { media_type: 'image' }, { media_type: 'audio' });
  await chat(phone(), 'Hello sir we provide digital marketing and lead generation services for builders');
  await call('POST', '/v1/appointments/running-late', { minutes: 30 });
  await runStaffDigest(t.ctx);

  const sentToCustomers = (
    await withTenant(t.ctx.db, A, (tx) =>
      tx.select({ body: messages.body }).from(messages).where(eq(messages.direction, 'out')),
    )
  ).map((m) => m.body);
  const sentToStaff = t.ctx.fakeChannel.sent
    .filter((s) => s.to === '+910000000000')
    .map((s) =>
      s.content.kind === 'template' ? (s.content.bodyParams ?? []).join(' ') : JSON.stringify(s.content),
    );
  expect(sentToCustomers.length).toBeGreaterThan(10);
  expect(sentToCustomers.filter((b) => CLINIC_WORDS.test(b))).toEqual([]);
  expect(sentToStaff.filter((b) => CLINIC_WORDS.test(b))).toEqual([]);
  expect(sentToCustomers.join('\n')).toMatch(/Site visit/);
  expect(sentToCustomers.join('\n')).toMatch(/cannot go ahead as planned/); // agent unavailable
  expect(sentToCustomers.join('\n')).toMatch(/Here are the next free times/); // rebooking offered
});

test('the weekly report groups property questions, not clinic ones', async () => {
  const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
  await chat(phone(), 'what is the price per sq ft and is it ready to move? any home loan tie-ups?');
  const now = t.clock.now();
  const r = await withTenant(t.ctx.db, A, (tx) =>
    computeReport(tx, config, new Date(now.getTime() - 30 * 24 * HOUR), new Date(now.getTime() + HOUR), now),
  );
  const topics = r.topTopics.map((x) => x.topic);
  expect(topics).toEqual(
    expect.arrayContaining(['Prices / budget', 'Possession / ready to move', 'Loan / EMI']),
  );
  expect(topics).not.toContain('Doctors');
});
