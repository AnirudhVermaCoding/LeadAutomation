import { HOUR } from '@instantlead/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';

let t: TestContext;
let A: string;
let admin: string;
let staff: string;
let agency: string;

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
  await t.ctx.system.createUser({
    email: 'staff@a.test',
    name: 'S',
    password: PASSWORD,
    role: 'client_staff',
    tenantId: A,
  });
  await t.ctx.system.createUser({
    email: 'agency@x.test',
    name: 'Ag',
    password: PASSWORD,
    role: 'agency_admin',
    tenantId: null,
  });
  [admin, staff, agency] = await Promise.all([
    t.signIn('admin@a.test'),
    t.signIn('staff@a.test'),
    t.signIn('agency@x.test'),
  ]);
});
afterAll(() => t.close());

const req = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: object,
  headers: Record<string, string> = {},
) => t.app.inject({ method, url, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });

describe('inbox actions', () => {
  test('lead detail, takeover/resume, manual send only inside the 24 h window', async () => {
    await req('POST', '/v1/dev/whatsapp/inbound', staff, { from: '9811100001', text: 'hello' });
    const [row] = (await req('GET', '/v1/inbox', staff)).json() as { id: string; state: string }[];
    expect(row).toMatchObject({ state: 'qualifying' });

    expect((await req('POST', `/v1/leads/${row!.id}/takeover`, staff)).json()).toMatchObject({
      aiPaused: true,
    });
    const sent = await req('POST', `/v1/leads/${row!.id}/messages`, staff, {
      text: 'Hi, this is Dr Mehta’s assistant.',
    });
    expect(sent.statusCode).toBe(200);
    const detail = (await req('GET', `/v1/leads/${row!.id}`, staff)).json() as {
      messages: { body: string }[];
      lead: { aiPaused: boolean };
    };
    expect(detail.lead.aiPaused).toBe(true);
    expect(detail.messages.at(-1)?.body).toMatch(/Dr Mehta/);
    expect((await req('POST', `/v1/leads/${row!.id}/resume`, staff)).json()).toMatchObject({
      aiPaused: false,
    });

    t.clock.advance(25 * HOUR);
    const closed = await req('POST', `/v1/leads/${row!.id}/messages`, staff, { text: 'still there?' });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ message: expect.stringMatching(/24-hour/) });
  });
});

describe('settings helpers', () => {
  test('onboarding checklist reflects the preset placeholders', async () => {
    const res = (await req('GET', '/v1/onboarding', admin)).json() as {
      steps: { key: string; done: boolean }[];
      done: number;
    };
    const done = Object.fromEntries(res.steps.map((s) => [s.key, s.done]));
    expect(done).toMatchObject({
      hours: true,
      knowledge: false,
      staff: false,
      whatsapp: false,
      templates: false,
    });
  });

  test('API keys: created once, listed by prefix, revoked; staff cannot manage them', async () => {
    const created = await req('POST', '/v1/api-keys', admin, { name: 'Website' });
    const { key } = created.json() as { key: string };
    expect(key).toMatch(/^il_/);
    const list = (await req('GET', '/v1/api-keys', admin)).json() as { id: string; prefix: string }[];
    expect(list.some((k) => key.startsWith(k.prefix))).toBe(true);
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await req('GET', '/v1/api-keys', staff)).statusCode).toBe(403);
    await req('DELETE', `/v1/api-keys/${list[0]!.id}`, admin);
    expect(await t.ctx.system.resolveApiKey(key)).toBeNull();
  });

  test('integration test buttons report mock mode honestly', async () => {
    expect((await req('POST', '/v1/integrations/test', admin, { kind: 'whatsapp' })).json()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/mock mode/),
    });
    expect((await req('POST', '/v1/integrations/test', admin, { kind: 'email' })).json()).toMatchObject({
      ok: true,
      message: expect.stringMatching(/owner@example.com.*mock mode/),
    });
  });
});

describe('agency', () => {
  test('usage per tenant is agency-only', async () => {
    expect((await req('GET', '/v1/admin/usage', admin)).statusCode).toBe(403);
    const usage = (await req('GET', '/v1/admin/usage', agency)).json() as {
      tenants: { slug: string; leads: number; messagesOut: number }[];
    };
    expect(usage.tenants).toEqual([
      expect.objectContaining({ slug: 'a', leads: 1, messagesOut: expect.any(Number) }),
    ]);
  });
});
