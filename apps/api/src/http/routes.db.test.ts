import { PRESETS } from '@instantlead/config';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';

let t: TestContext;
let A: string;
let B: string;
let staffA: string;
let adminA: string;
let agency: string;
let keyA: string;

beforeAll(async () => {
  t = await createTestContext();
  const { system } = t.ctx;
  const actor = { type: 'system' } as const;
  await system.createUser({
    email: 'agency@test.dev',
    name: 'Agency',
    password: PASSWORD,
    role: 'agency_admin',
    tenantId: null,
  });
  A = (
    await system.createTenant(
      {
        slug: 'clinic-a',
        name: 'Clinic A',
        preset: 'clinic_dental',
        admin: { email: 'admin@a.test', name: 'Admin A', password: PASSWORD },
      },
      actor,
    )
  ).tenant.id;
  B = (await system.createTenant({ slug: 'clinic-b', name: 'Clinic B', preset: 'clinic_hair' }, actor)).tenant
    .id;
  await system.createUser({
    email: 'staff@a.test',
    name: 'Staff A',
    password: PASSWORD,
    role: 'client_staff',
    tenantId: A,
  });
  keyA = await system.createApiKey(A, 'key', actor);
  [staffA, adminA, agency] = await Promise.all([
    t.signIn('staff@a.test'),
    t.signIn('admin@a.test'),
    t.signIn('agency@test.dev'),
  ]);
});
afterAll(() => t.close());

const get = (url: string, cookie?: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
const put = (url: string, cookie: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'PUT', url, payload: payload as object, headers: { ...headers, cookie } });
const businessName = (res: { json(): unknown }) =>
  (res.json() as { config: { brand: { business_name: string } } }).config.brand.business_name;

describe('auth', () => {
  test('public sign-up is disabled', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'http://localhost:3000' },
      payload: { email: 'new@x.test', password: PASSWORD, name: 'New' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('wrong password is rejected', async () => {
    await expect(t.signIn('admin@a.test', 'wrong-password-123')).rejects.toThrow(/sign-in failed/);
  });

  test('unauthenticated requests get 401', async () => {
    expect((await get('/v1/config')).statusCode).toBe(401);
    expect((await get('/v1/me')).statusCode).toBe(401);
  });

  test('/v1/me describes the signed-in user', async () => {
    const res = await get('/v1/me', staffA);
    expect(res.json()).toMatchObject({ principal: { kind: 'user', role: 'client_staff', tenantId: A } });
  });
});

describe('config', () => {
  test('staff can read their tenant config but not change it', async () => {
    const res = await get('/v1/config', staffA);
    expect(res.statusCode).toBe(200);
    expect(businessName(res)).toBe('Clinic A');
    expect((await put('/v1/config', staffA, PRESETS.clinic_dental('X'))).statusCode).toBe(403);
  });

  test('client users cannot switch tenants with x-tenant-id', async () => {
    const res = await get('/v1/config', adminA, { 'x-tenant-id': B });
    expect(businessName(res)).toBe('Clinic A');
  });

  test('agency admin must pick a tenant, and can pick any', async () => {
    expect((await get('/v1/config', agency)).statusCode).toBe(400);
    expect(businessName(await get('/v1/config', agency, { 'x-tenant-id': B }))).toBe('Clinic B');
  });

  test('API keys cannot use dashboard routes', async () => {
    const res = await get('/v1/config', undefined, { authorization: `Bearer ${keyA}` });
    expect(res.statusCode).toBe(403);
  });

  test('invalid config is rejected with readable errors', async () => {
    const bad = PRESETS.clinic_dental('Clinic A');
    bad.locale.timezone = 'Mars/Olympus';
    const res = await put('/v1/config', adminA, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_config',
      errors: ['locale.timezone: "Mars/Olympus" is not a known timezone (e.g. "Asia/Kolkata")'],
    });
  });

  test('valid config becomes a new revision and is audited', async () => {
    const next = PRESETS.clinic_dental('Clinic A Renamed');
    const res = await put('/v1/config', adminA, next);
    expect(res.json()).toEqual({ revision: 2 });
    expect(businessName(await get('/v1/config', staffA))).toBe('Clinic A Renamed');

    const { rows } = await t.owner.query(
      `select action, actor_type, details from audit_log where tenant_id = $1 and action = 'config.saved'`,
      [A],
    );
    expect(rows).toEqual([{ action: 'config.saved', actor_type: 'user', details: { revision: 2 } }]);
  });
});

describe('agency admin', () => {
  test('lists and creates tenants from presets; clients cannot', async () => {
    expect((await get('/v1/admin/tenants', adminA)).statusCode).toBe(403);
    const listed = (await get('/v1/admin/tenants', agency)).json() as { slug: string }[];
    expect(listed.map((x) => x.slug)).toEqual(['clinic-a', 'clinic-b']);

    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: { cookie: agency },
      payload: { slug: 'skyline', name: 'Skyline Realty', preset: 'real_estate' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { tenant: { id: string } }).tenant.id;
    expect(businessName(await get('/v1/config', agency, { 'x-tenant-id': id }))).toBe('Skyline Realty');

    const dup = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: { cookie: agency },
      payload: { slug: 'skyline', name: 'Again', preset: 'real_estate' },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: { cookie: agency },
      payload: { slug: 'Bad Slug', name: 'x', preset: 'bakery' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
