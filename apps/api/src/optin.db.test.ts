import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { consents, enrollments, leads, messages, suppressions } from './db/schema.ts';

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

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const say = async (from: string, text: string, button_payload?: string) => {
  const res = await api('POST', '/v1/dev/whatsapp/inbound', {
    from,
    text,
    ...(button_payload ? { button_payload } : {}),
  });
  await t.drainAssistant();
  await t.drainJobs();
  return res.json() as { action: string; leadId?: string };
};
const phoneN = () => `98740${String(++n).padStart(5, '0')}`;
const leadOf = (phone: string) =>
  withTenant(
    t.ctx.db,
    A,
    async (tx) =>
      (
        await tx
          .select()
          .from(leads)
          .where(eq(leads.phoneE164, `+91${phone}`))
      )[0]!,
  );
const outs = (leadId: string) =>
  withTenant(t.ctx.db, A, async (tx) =>
    (
      await tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, leadId))
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt))
    ).filter((m) => m.direction === 'out'),
  );

describe('opt-out confirmation and re-opt-in', () => {
  test('STOP is confirmed, follow-ups stop, START brings them back, and the new consent is on record', async () => {
    const phone = phoneN();
    await api('POST', '/v1/leads', { phone, name: 'Gita', consent: { granted: true } });
    await t.drainJobs(); // first reply + follow-up enrolment
    const lead = await leadOf(phone);

    expect(await say(phone, 'STOP')).toMatchObject({ action: 'opted_out' });
    expect((await outs(lead.id)).at(-1)!.body).toMatch(/unsubscribed from Smile Dental.*reply START/);
    const [enr] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(enrollments).where(eq(enrollments.leadId, lead.id)),
    );
    expect(enr).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });

    // Anything but START is recorded and ignored (no reply, still opted out).
    const before = (await outs(lead.id)).length;
    expect(await say(phone, 'hello? are you there')).toMatchObject({ action: 'ignored_opted_out' });
    expect((await outs(lead.id)).length).toBe(before);
    expect((await leadOf(phone)).state).toBe('opted_out');

    expect(await say(phone, 'START')).toMatchObject({ action: 'opted_in' });
    expect((await leadOf(phone)).state).toBe('contacted');
    expect((await outs(lead.id)).at(-1)!.body).toMatch(/Welcome back! You'll hear from Smile Dental again/);
    expect(await withTenant(t.ctx.db, A, (tx) => tx.select().from(suppressions))).toHaveLength(0);
    const cs = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(consents).where(eq(consents.leadId, lead.id)),
    );
    expect(cs.at(-1)).toMatchObject({ source: 'whatsapp_opt_in' });
    expect(JSON.stringify(cs.at(-1)!.evidence)).toContain('START');

    // They are a normal conversation again: the assistant answers, and STOP still works.
    const answered = (await outs(lead.id)).length;
    await say(phone, 'I would like to book a cleaning');
    expect((await outs(lead.id)).length).toBeGreaterThan(answered);
    expect(await say(phone, 'x', 'first_reply:stop')).toMatchObject({ action: 'opted_out' });
  });

  test('the confirmation follows the customer language', async () => {
    const phone = phoneN();
    await say(phone, 'नमस्ते, मुझे दांत साफ़ करवाने हैं');
    await say(phone, 'बंद करो');
    const lead = await leadOf(phone);
    expect((await outs(lead.id)).at(-1)!.body).toMatch(/अनसब्सक्राइब/);
    expect(await say(phone, 'शुरू करो')).toMatchObject({ action: 'opted_in' });
  });

  test('"start" from someone who has not opted out is just a message for the assistant', async () => {
    const phone = phoneN();
    await say(phone, 'hi, I want to start with a cleaning');
    expect((await leadOf(phone)).state).not.toBe('opted_out');
    expect(await say(phone, 'start')).toMatchObject({ action: 'recorded' });
  });

  test('after an erasure the opt-out still holds, and START re-subscribes the new lead', async () => {
    const phone = phoneN();
    await say(phone, 'hello');
    await say(phone, 'stop');
    const old = await leadOf(phone);
    await t.owner.query('delete from leads where id = $1', [old.id]);
    expect(await say(phone, 'hi again')).toMatchObject({ action: 'ignored_opted_out' }); // suppressed hash survives
    expect((await leadOf(phone)).state).toBe('opted_out');
    expect(await say(phone, 'START')).toMatchObject({ action: 'opted_in' });
    expect((await leadOf(phone)).state).toBe('contacted');
  });
});

describe('staff recording an opt-out / opt-in', () => {
  test('opt-out any time; opt-in needs a note, only for opted-out leads, and keeps it as evidence', async () => {
    const phone = phoneN();
    const lead = (
      await api('POST', '/v1/leads', { phone, name: 'Hari', consent: { granted: true } })
    ).json() as { lead_id: string };
    await t.drainJobs();
    expect(
      (await api('POST', `/v1/leads/${lead.lead_id}/opt-in`, { note: 'called us on Monday' })).statusCode,
    ).toBe(409);
    expect((await api('POST', `/v1/leads/${lead.lead_id}/opt-out`)).json()).toEqual({ opted_out: true });
    expect((await leadOf(phone)).state).toBe('opted_out');
    expect((await api('POST', `/v1/leads/${lead.lead_id}/opt-in`, { note: 'x' })).statusCode).toBe(400); // needs a real note
    expect(
      (
        await api('POST', `/v1/leads/${lead.lead_id}/opt-in`, {
          note: 'Asked at the front desk to be messaged again',
        })
      ).json(),
    ).toEqual({ opted_in: true });
    expect((await leadOf(phone)).state).toBe('contacted');
    const cs = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(consents).where(eq(consents.leadId, lead.lead_id)),
    );
    expect(cs.at(-1)).toMatchObject({ source: 'staff_recorded' });
    expect(JSON.stringify(cs.at(-1)!.evidence)).toContain('front desk');
  });
});
