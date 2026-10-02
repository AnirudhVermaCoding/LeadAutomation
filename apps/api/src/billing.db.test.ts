import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { leads, messages } from './db/schema.ts';

let t: TestContext;
let B: string;
let agency: string;
let adminA: string;

beforeAll(async () => {
  t = await createTestContext();
  const mk = async (slug: string, name: string) =>
    (
      await t.ctx.system.createTenant(
        {
          slug,
          name,
          preset: 'clinic_dental',
          admin: { email: `admin@${slug}.test`, name: slug, password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
  await mk('a', 'Smile Dental');
  B = await mk('b', 'Other, "Quoted" Clinic');
  await t.ctx.system.createUser({
    email: 'agency@x.test',
    name: 'Agency',
    password: PASSWORD,
    role: 'agency_admin',
    tenantId: null,
  });
  agency = await t.signIn('agency@x.test');
  adminA = await t.signIn('admin@a.test');
});
afterAll(() => t.close());

const lead = async (cookie: string, phone: string) => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone, consent: { granted: true } },
  });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
};

describe('usage history and invoicing', () => {
  test('usage for any month, as JSON and CSV (quoting handled)', async () => {
    await lead(adminA, '9881100001');
    await lead(adminA, '9881100002');
    t.clock.advance(40 * 24 * 3_600_000); // into the next month
    await lead(adminA, '9881100003');

    const thisMonth = (
      await t.app.inject({ url: '/v1/admin/usage', headers: { cookie: agency } })
    ).json() as {
      since: string;
      tenants: { name: string; leads: number; status: string }[];
    };
    expect(thisMonth.tenants.find((x) => x.name === 'Smile Dental')).toMatchObject({
      leads: 1,
      status: 'active',
    });
    const past = (
      await t.app.inject({ url: '/v1/admin/usage?month=2026-10', headers: { cookie: agency } })
    ).json() as typeof thisMonth;
    expect(past.tenants.find((x) => x.name === 'Smile Dental')!.leads).toBe(2);

    const csv = await t.app.inject({
      url: '/v1/admin/usage?month=2026-10&format=csv',
      headers: { cookie: agency },
    });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toContain('usage-2026-10.csv');
    const lines = csv.body.split('\n');
    expect(lines[0]).toBe(
      'month,client,slug,status,leads,bookings,whatsapp_messages_sent,whatsapp_cost_inr,ai_cost_usd,ai_providers',
    );
    expect(lines.some((l) => l.startsWith('2026-10,Smile Dental,a,active,2,'))).toBe(true);
    expect(lines.some((l) => l.includes('"Other, ""Quoted"" Clinic"'))).toBe(true);
    expect(
      (await t.app.inject({ url: '/v1/admin/usage?month=2026-13', headers: { cookie: agency } })).statusCode,
    ).toBe(400);
    expect((await t.app.inject({ url: '/v1/admin/usage', headers: { cookie: adminA } })).statusCode).toBe(
      403,
    );
  });
});

describe('paused accounts', () => {
  test('a paused client sends nothing and the assistant is silent, but leads are still recorded and the dashboard says so', async () => {
    const setStatus = (id: string, status: string) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/admin/tenants/${id}/status`,
        headers: { cookie: agency },
        payload: { status },
      });
    expect((await setStatus(B, 'paused')).json()).toEqual({ status: 'paused' });
    const adminB = await t.signIn('admin@b.test');
    expect(
      (
        (await t.app.inject({ url: '/v1/config', headers: { cookie: adminB } })).json() as {
          tenant_status: string;
        }
      ).tenant_status,
    ).toBe('paused');
    expect(
      (
        (await t.app.inject({ url: '/v1/config', headers: { cookie: adminA } })).json() as {
          tenant_status: string;
        }
      ).tenant_status,
    ).toBe('active');

    const before = t.ctx.fakeChannel.sent.length;
    const leadId = await lead(adminB, '9881100010');
    const rows = await withTenant(t.ctx.db, B, (tx) => tx.select().from(leads).where(eq(leads.id, leadId)));
    expect(rows).toHaveLength(1); // recorded
    expect(
      await withTenant(t.ctx.db, B, (tx) => tx.select().from(messages).where(eq(messages.leadId, leadId))),
    ).toHaveLength(0);
    expect(t.ctx.fakeChannel.sent.length).toBe(before);

    await t.app.inject({
      method: 'POST',
      url: '/v1/dev/whatsapp/inbound',
      headers: { cookie: adminB },
      payload: { from: '9881100010', text: 'hello' },
    });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'skipped', reason: 'account paused' }]);

    // Resumed: the next lead gets its first reply again.
    expect((await setStatus(B, 'active')).json()).toEqual({ status: 'active' });
    const next = await lead(adminB, '9881100011');
    expect(
      (
        await withTenant(t.ctx.db, B, (tx) => tx.select().from(messages).where(eq(messages.leadId, next)))
      ).some((m) => m.templateKey === 'first_reply'),
    ).toBe(true);
    expect((await setStatus('00000000-0000-4000-8000-000000000000', 'paused')).statusCode).toBe(404);
  });
});
