import { PRESETS, PRESET_KEYS } from '@instantlead/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { createFakeLlm } from './assistant/fake-llm.ts';
import { runAssistantTurn } from './assistant/agent.ts';
import { withTenant } from './db/client.ts';
import { leads, llmRuns } from './db/schema.ts';
import { aiSettings } from './llm-router.ts';

// Any network call (Meta, Gemini) would land here: the dev tools must never make one.
const network: string[] = [];
const fetch = ((url: URL | string) => {
  network.push(String(url));
  return Promise.reject(new Error('no network in tests'));
}) as typeof globalThis.fetch;

let t: TestContext;
let demo: string;
let pilot: string;
let demoCookie: string;
let pilotCookie: string;

beforeAll(async () => {
  t = await createTestContext({ fetch, llm: createFakeLlm() });
  const create = async (slug: string) =>
    (
      await t.ctx.system.createTenant(
        {
          slug,
          name: slug,
          preset: 'clinic_dental',
          admin: { email: `admin@${slug}.test`, name: 'A', password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
  demo = await create('demo');
  pilot = await create('pilot');
  demoCookie = await t.signIn('admin@demo.test');
  pilotCookie = await t.signIn('admin@pilot.test');
});
afterAll(() => t.close());

const post = (cookie: string, url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
const get = (cookie: string, url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
const leadCount = async (tenantId: string) =>
  (await withTenant(t.ctx.db, tenantId, (tx) => tx.select().from(leads))).length;

describe('demo clinics: mock WhatsApp, Gemini as the configured provider, the fake model in practice', () => {
  test('every preset is configured for Gemini only', () => {
    for (const key of PRESET_KEYS) expect(aiSettings(PRESETS[key]()).allowed_providers).toEqual(['gemini']);
  });

  test('a demo clinic chats on the mock channel and the free fake model; demo time can advance', async () => {
    expect((await get(demoCookie, '/v1/integrations')).json()).toMatchObject({ channel: 'fake' });
    const res = await post(demoCookie, '/v1/dev/whatsapp/inbound', { from: '9800000001', text: 'hi' });
    expect(res.statusCode).toBe(200);
    const leadId = (res.json() as { leadId: string }).leadId;
    expect(await runAssistantTurn(t.ctx, demo, leadId)).toMatchObject({ status: 'replied' });
    const runs = await withTenant(t.ctx.db, demo, (tx) =>
      tx.select().from(llmRuns).where(eq(llmRuns.leadId, leadId)),
    );
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.provider === 'fake')).toBe(true);

    expect((await get(demoCookie, '/v1/dev/clock')).json()).toMatchObject({ canAdvance: true });
    expect((await post(demoCookie, '/v1/dev/clock/advance', { hours: 1 })).statusCode).toBe(200);
  });
});

describe('a clinic on real WhatsApp: dev tools refuse it, and demo time freezes for everyone', () => {
  beforeAll(async () => {
    const connected = await t.app.inject({
      method: 'PUT',
      url: '/v1/integrations/whatsapp',
      headers: { cookie: pilotCookie },
      payload: { id: '123456789012345', access_token: 'test-token-not-real-0000000' },
    });
    expect(connected.statusCode).toBe(200);
    expect((await get(pilotCookie, '/v1/integrations')).json()).toMatchObject({ channel: 'meta' });
    expect((await get(demoCookie, '/v1/integrations')).json()).toMatchObject({ channel: 'fake' });
  });

  test('the dev inbound route refuses the real-WhatsApp clinic: no lead, no AI turn, no send', async () => {
    const res = await post(pilotCookie, '/v1/dev/whatsapp/inbound', { from: '9800000002', text: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'real_whatsapp_connected' });
    expect(await leadCount(pilot)).toBe(0);
    const jobs = await t.owner.query(`select name from pgboss.job where data->>'tenantId' = $1`, [pilot]);
    expect(jobs.rows).toEqual([]);
    // Demo clinics keep working.
    expect(
      (await post(demoCookie, '/v1/dev/whatsapp/inbound', { from: '9800000003', text: 'hi' })).statusCode,
    ).toBe(200);
  });

  test('the shared demo clock cannot be advanced while any clinic is on real WhatsApp', async () => {
    const before = t.ctx.clock.now().getTime();
    for (const cookie of [demoCookie, pilotCookie]) {
      expect((await get(cookie, '/v1/dev/clock')).json()).toMatchObject({ canAdvance: false });
      const res = await post(cookie, '/v1/dev/clock/advance', { hours: 48 });
      expect(res.statusCode).toBe(409);
    }
    expect(t.ctx.clock.now().getTime()).toBe(before);
  });

  test('the fake-Google dev routes refuse the real-WhatsApp clinic, not demo clinics', async () => {
    expect((await post(pilotCookie, '/v1/dev/google/connect')).statusCode).toBe(409);
    expect((await post(demoCookie, '/v1/dev/google/connect')).statusCode).toBe(200);
  });

  test('none of this touched the network (no Meta send, no Gemini call)', () => {
    expect(network).toEqual([]);
  });
});
