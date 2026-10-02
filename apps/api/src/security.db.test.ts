import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { leads, oauthNonces } from './db/schema.ts';
import { serializeError } from './log-scrub.ts';

let t: TestContext;
let A: string;
let cookie: string;
let apiKey: string;

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
  apiKey = await t.ctx.system.createApiKey(A, 'k', { type: 'system' });
});
afterAll(() => t.close());

const post = (headers: Record<string, string>) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/blocked-times',
    headers,
    payload: { starts_at: '2026-12-01T05:00:00Z', ends_at: '2026-12-01T06:00:00Z' },
  });

describe('cross-site request forgery', () => {
  test('a cookie session cannot be driven from another site', async () => {
    expect((await post({ cookie, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ cookie, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({ cookie, 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
  });
  test('our own pages, and non-browser clients, work', async () => {
    expect((await post({ cookie, origin: t.ctx.env.APP_URL })).statusCode).toBe(201);
    expect((await post({ cookie, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
    expect((await post({ cookie })).statusCode).toBe(201); // curl, scripts: no Origin
  });
  test('API keys carry no cookie, so they are not subject to it', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/leads',
      headers: { authorization: `Bearer ${apiKey}`, origin: 'https://their-site.example' },
      payload: { phone: '9879900001', consent: { granted: true } },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('rate limits', () => {
  test('a client that hammers the API gets 429s; health checks are never throttled', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 620; i++)
      codes.push(
        (await t.app.inject({ url: '/v1/me', headers: { cookie }, remoteAddress: '203.0.113.9' })).statusCode,
      );
    expect(codes[0]).toBe(200);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect((await t.app.inject({ url: '/healthz', remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
  });
});

describe('observability', () => {
  test('every response carries a request id, and a caller trace id is honoured', async () => {
    const a = await t.app.inject({ url: '/healthz' });
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const b = await t.app.inject({ url: '/healthz', headers: { 'x-request-id': 'trace-1234abcd' } });
    expect(b.headers['x-request-id']).toBe('trace-1234abcd');
  });
  test('security headers', async () => {
    const r = await t.app.inject({ url: '/healthz' });
    expect(r.headers['permissions-policy']).toContain('camera=()');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  test('a real database error, as the app would log it, carries no customer data', async () => {
    // A lead without its required columns, with a phone number and name as bound parameters.
    const err = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .insert(leads)
        .values({ phoneE164: '+919876500001', name: 'Priya Sharma', receivedAt: new Date() } as never),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const logged = JSON.stringify(serializeError(err));
    expect(logged).not.toMatch(/9876500001|Priya Sharma/);
    expect(logged).toMatch(/23502/); // the pg error code survives: useful, not personal
  });
  test('/readyz also checks the job queue', async () => {
    expect((await t.app.inject({ url: '/readyz' })).statusCode).toBe(200);
  });
});

describe('accounts', () => {
  test('passwords need 12+ characters', async () => {
    await expect(
      t.ctx.system.createUser({
        email: 'short@a.test',
        name: 'S',
        password: 'short-pw-1',
        role: 'client_staff',
        tenantId: A,
      }),
    ).rejects.toThrow();
  });

  test('the agency can reset a locked-out user password; old sessions and the old password stop working', async () => {
    await t.ctx.system.createUser({
      email: 'agency@x.test',
      name: 'Agency',
      password: PASSWORD,
      role: 'agency_admin',
      tenantId: null,
    });
    const agency = await t.signIn('agency@x.test');
    const call = (payload: object, c = agency) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/admin/users/reset-password',
        headers: { cookie: c },
        payload,
      });
    expect((await call({ email: 'admin@a.test', password: 'short' })).statusCode).toBe(400);
    expect((await call({ email: 'nobody@a.test', password: 'a-brand-new-password' })).statusCode).toBe(404);
    expect((await call({ email: 'admin@a.test', password: 'a-brand-new-password' })).json()).toEqual({
      reset: true,
    });
    expect((await t.app.inject({ url: '/v1/me', headers: { cookie } })).statusCode).toBe(401); // signed out everywhere
    await expect(t.signIn('admin@a.test')).rejects.toThrow(); // the old password
    expect(await t.signIn('admin@a.test', 'a-brand-new-password')).toContain('=');
    const clientCookie = await t.signIn('admin@a.test', 'a-brand-new-password');
    expect(
      (await call({ email: 'x@y.test', password: 'a-brand-new-password' }, clientCookie)).statusCode,
    ).toBe(403); // not an agency admin
  });
});

describe('Google OAuth callback state', () => {
  test('a refused callback does not consume the one-time state', async () => {
    const payload = `${A}.${t.clock.now().getTime() + 600_000}.nonce-1`;
    const state = `${payload}.${createHmac('sha256', t.ctx.hashKey).update(payload).digest('base64url')}`;
    // Google is not configured in tests, so the callback refuses before the exchange.
    const res = await t.app.inject({
      url: `/v1/integrations/google/callback?code=x&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(400);
    const rows = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(oauthNonces)
        .where(and(eq(oauthNonces.nonce, 'nonce-1'))),
    );
    expect(rows).toHaveLength(0);
  });
});
