import { DAY } from '@instantlead/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { isSuppressed } from './leads.ts';
import { runRetention } from './privacy.ts';
import { decryptSecret, encryptSecret, getTenantSecret, setTenantSecret } from './secrets.ts';
import { dispatchWebhookEvents, signWebhook } from './webhooks-out.ts';

let t: TestContext;
let A: string;
let admin: string;
let staff: string;
let agency: string;
let hookStatus = 200;
const delivered: { url: string; headers: Record<string, string>; body: string }[] = [];

beforeAll(async () => {
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    delivered.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    return new Response('{}', { status: hookStatus });
  }) as typeof globalThis.fetch;
  t = await createTestContext({ fetch });
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
  await t.ctx.system.createUser({
    email: 'staff@a.test',
    name: 'S',
    password: PASSWORD,
    role: 'client_staff',
    tenantId: A,
  });
  await t.ctx.system.createUser({
    email: 'ag@x.test',
    name: 'G',
    password: PASSWORD,
    role: 'agency_admin',
    tenantId: null,
  });
  [admin, staff, agency] = [
    await t.signIn('admin@a.test'),
    await t.signIn('staff@a.test'),
    await t.signIn('ag@x.test'),
  ];
});
afterAll(() => t.close());

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const newLead = async (phone: string, name = 'Priya Sharma') =>
  (
    (await call('POST', '/v1/leads', admin, { phone, name, consent: { granted: true } })).json() as {
      lead_id: string;
    }
  ).lead_id;

test('security headers; the public form may be framed, nothing else', async () => {
  const health = await t.app.inject({ url: '/healthz' });
  expect(health.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
  expect(health.headers['content-security-policy']).toMatch(/default-src 'self'.*frame-ancestors 'none'/);
  const form = await t.app.inject({ url: '/f/nope' });
  expect(form.headers['x-frame-options']).toBeUndefined();
  expect(form.headers['content-security-policy']).toMatch(/frame-ancestors */);
});

describe('outbound webhooks', () => {
  let secret: string;
  let endpointId: string;

  test('admins register an endpoint; the signing secret is shown once', async () => {
    expect((await call('POST', '/v1/webhooks', staff, { url: 'https://crm.test/hook' })).statusCode).toBe(
      403,
    );
    const bad = await call('POST', '/v1/webhooks', admin, {
      url: 'https://crm.test/h',
      events: ['lead.nope'],
    });
    expect(bad.statusCode).toBe(400);
    const res = await call('POST', '/v1/webhooks', admin, {
      url: 'https://crm.test/hook',
      events: ['lead.created', 'lead.opted_out'],
    });
    expect(res.statusCode).toBe(201);
    ({ secret, id: endpointId } = res.json() as { secret: string; id: string });
    expect(secret).toMatch(/^whsec_/);
    const list = (await call('GET', '/v1/webhooks', admin)).json() as object[];
    expect(list).toEqual([expect.not.objectContaining({ secret: expect.anything() })]);
  });

  test('a new lead is delivered once, signed, with the lead details', async () => {
    const leadId = await newLead('9811100001');
    await t.drainJobs(); // first reply: lead.contacted is not subscribed
    expect(await dispatchWebhookEvents(t.ctx)).toBeGreaterThanOrEqual(1);
    expect(await dispatchWebhookEvents(t.ctx)).toBe(0); // each event fans out once
    await t.drainJobs();

    expect(delivered).toHaveLength(1);
    const [hit] = delivered;
    const body = JSON.parse(hit!.body) as { type: string; data: { leadId: string; lead: object } };
    expect(body).toMatchObject({
      type: 'lead.created',
      data: { leadId, lead: { name: 'Priya Sharma', phone: '+919811100001', state: 'contacted' } },
    });
    const ts = Number(/t=(\d+)/.exec(hit!.headers['x-instantlead-signature']!)![1]);
    expect(hit!.headers['x-instantlead-signature']).toBe(signWebhook(secret, hit!.body, ts));
  });

  test('4xx is final and recorded; the endpoint shows the last status', async () => {
    hookStatus = 410;
    await call('POST', '/v1/dev/whatsapp/inbound', admin, { from: '9811100001', text: 'STOP' });
    await dispatchWebhookEvents(t.ctx);
    const results = await t.drainJobs();
    expect(results.find((r) => r.queue === 'webhook-deliver')?.error).toMatchObject({ retryable: false });
    const [ep] = (await call('GET', '/v1/webhooks', admin)).json() as {
      lastStatus: number;
      lastError: string;
    }[];
    expect(ep).toMatchObject({ lastStatus: 410, lastError: 'HTTP 410' });
    hookStatus = 200;
  });

  test('deleting an endpoint removes its secret', async () => {
    expect((await call('DELETE', `/v1/webhooks/${endpointId}`, admin)).json()).toEqual({ deleted: true });
    const secretRow = await withTenant(t.ctx.db, A, (tx) =>
      getTenantSecret(tx, t.ctx.secretsKey, A, `webhook:${endpointId}`),
    );
    expect(secretRow).toBeNull();
  });
});

describe('DPDP', () => {
  test('erasure deletes the lead and its messages but an opt-out stays opted out', async () => {
    const [{ id } = { id: '' }] = (
      await t.owner.query<{ id: string }>(`select id from leads where phone_e_164 = '+919811100001'`)
    ).rows;
    expect((await call('DELETE', `/v1/leads/${id}`, staff)).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/leads/${id}`, admin)).json()).toEqual({ erased: true });
    expect((await call('DELETE', `/v1/leads/${id}`, admin)).statusCode).toBe(404);
    const left = await t.owner.query('select 1 from messages where lead_id = $1', [id]);
    expect(left.rowCount).toBe(0);
    expect(await withTenant(t.ctx.db, A, (tx) => isSuppressed(tx, t.ctx, A, '+919811100001'))).toBe(true);
    const audit = await t.owner.query(
      `select 1 from audit_log where action = 'lead.erased' and entity_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  test('export returns everything the tenant holds as a download', async () => {
    const leadId = await newLead('9811100002', 'Export Me');
    const res = await call('GET', '/v1/export', admin);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="instantlead-export-/);
    const data = res.json() as { leads: { id: string }[]; config: object };
    expect(data.leads.map((l) => l.id)).toContain(leadId);
    expect(data.config).toMatchObject({ brand: { business_name: expect.any(String) } });
  });

  test('retention anonymizes leads idle past the configured period, keeping the counts', async () => {
    await withTenant(t.ctx.db, A, async (tx) => {
      const config = (await getActiveConfig(tx))!.config;
      await saveConfig(
        tx,
        t.clock,
        { type: 'system' },
        { ...config, privacy: { retention_days: 30, mode: 'anonymize' } },
      );
    });
    await t.drainJobs();
    expect(await runRetention(t.ctx)).toEqual({ [A]: 0 });

    t.clock.advance(31 * DAY);
    const fresh = await newLead('9811100003', 'Still Active');
    expect(await runRetention(t.ctx)).toEqual({ [A]: 1 });
    const rows = (
      await t.owner.query<{ id: string; name: string | null; phone_e_164: string }>(
        'select id, name, phone_e_164 from leads where tenant_id = $1',
        [A],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === fresh)).toMatchObject({ name: 'Still Active' });
    const old = rows.find((r) => r.id !== fresh)!;
    expect(old).toMatchObject({ name: null, phone_e_164: `anonymized:${old.id}` });
    const bodies = await t.owner.query<{ body: string }>(
      'select distinct body from messages where lead_id = $1',
      [old.id],
    );
    expect(bodies.rows).toEqual([{ body: '[removed]' }]);
    expect(await runRetention(t.ctx)).toEqual({ [A]: 0 }); // already anonymized
  });

  test('breach register is agency-only', async () => {
    const entry = {
      detectedAt: '2026-11-01T10:00:00+05:30',
      description: 'Staff laptop with an export was stolen',
      tenantId: A,
    };
    expect((await call('POST', '/v1/admin/breaches', admin, entry)).statusCode).toBe(403);
    expect((await call('POST', '/v1/admin/breaches', agency, entry)).statusCode).toBe(201);
    expect((await call('GET', '/v1/admin/breaches', agency)).json()).toEqual([
      expect.objectContaining({ description: entry.description, tenantId: A, reportedToBoardAt: null }),
    ]);
  });
});

test('secrets key rotation: old ciphertexts decrypt during rotation and are re-encrypted', async () => {
  const oldKey = t.ctx.secretsKey as Buffer;
  const newKey = Buffer.alloc(32, 9);
  await withTenant(t.ctx.db, A, (tx) => setTenantSecret(tx, oldKey, A, 'rotate-me', 'value-1'));
  const ring = [newKey, oldKey];
  expect(await t.ctx.system.rotateSecrets(ring)).toBeGreaterThanOrEqual(1);
  const [row] = (
    await t.owner.query<{ value_enc: string }>(
      `select value_enc from tenant_secrets where name = 'rotate-me'`,
    )
  ).rows;
  expect(decryptSecret(newKey, A, 'rotate-me', row!.value_enc)).toBe('value-1');
  expect(() => decryptSecret(oldKey, A, 'rotate-me', row!.value_enc)).toThrow();
  expect(decryptSecret(ring, A, 'x', encryptSecret(oldKey, A, 'x', 'v'))).toBe('v');
});
