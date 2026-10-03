import type { TenantConfig } from '@instantlead/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { findSlots } from './booking.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { appointments, calls, events, leads } from './db/schema.ts';
import type { TimelineEntry } from './journey.ts';
import { deleteTenantSecret } from './secrets.ts';
import { VOICE_SECRET } from './voice.ts';

let t: TestContext;
let A: string;
let B: string;
let cookieA: string;
let cookieB: string;
let hookA: { url: string; secret: string };
let hookB: { url: string; secret: string };
let n = 0;

const VOICE = {
  enabled: true,
  provider: 'vapi' as const,
  transfer_number: '+919800000001',
  call_disclosure: 'Hello, this is the {{business_name}} assistant. This call is handled by an AI assistant.',
  monthly_minutes_cap: 0,
};

beforeAll(async () => {
  // Mon 5 Oct 2026, 10:00 IST: the clinic is open.
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
  const rotate = async (cookie: string) => {
    const r = (await api(cookie, 'POST', '/v1/voice/rotate')).json() as { webhook_url: string; secret: string };
    return { url: new URL(r.webhook_url).pathname, secret: r.secret };
  };
  hookA = await rotate(cookieA);
  hookB = await rotate(cookieB);
});
afterAll(() => t.close());

const api = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
async function setConfig(tenantId: string, change: (c: TenantConfig) => TenantConfig) {
  await withTenant(t.ctx.db, tenantId, async (tx) => {
    const config = change(structuredClone((await getActiveConfig(tx))!.config));
    await saveConfig(tx, t.clock, { type: 'system' }, config);
  });
}
/** Post one Vapi server message for a call from `from`. */
const vapi = (message: Record<string, unknown>, callId: string, from: string | null, hook = hookA, secret = hook.secret) =>
  t.app.inject({
    method: 'POST',
    url: hook.url,
    headers: { authorization: `Bearer ${secret}` },
    payload: { message: { ...message, call: { id: callId, ...(from && { customer: { number: from } }) } } },
  });
const toolCall = (callId: string, from: string | null, calls: { id: string; name: string; parameters: object }[]) =>
  vapi({ type: 'tool-calls', toolCallList: calls }, callId, from);
const resultOf = (res: { json(): unknown }, i = 0) =>
  (res.json() as { results: { toolCallId: string; result: string }[] }).results[i]!.result;
const newPhone = () => `+9198766${String(++n).padStart(5, '0')}`;

describe('optional module', () => {
  test('off: the webhook is 404 and nothing is recorded; misconfigured: 503; wrong credential: 401', async () => {
    const res = await toolCall('c-off', newPhone(), [{ id: 'x', name: 'lookup_knowledge', parameters: { query: 'timings' } }]);
    expect(res.statusCode).toBe(404);
    expect(await withTenant(t.ctx.db, A, (tx) => tx.select().from(calls))).toEqual([]);

    await setConfig(A, (c) => ({ ...c, voice: VOICE }));
    expect((await vapi({ type: 'status-update', status: 'in-progress' }, 'c1', newPhone(), hookA, 'wrong')).statusCode).toBe(401);
    await withTenant(t.ctx.db, A, (tx) => deleteTenantSecret(tx, A, VOICE_SECRET));
    expect((await vapi({ type: 'status-update', status: 'in-progress' }, 'c1', newPhone())).statusCode).toBe(503);
    hookA = await (async () => {
      const r = (await api(cookieA, 'POST', '/v1/voice/rotate')).json() as { webhook_url: string; secret: string };
      return { url: new URL(r.webhook_url).pathname, secret: r.secret };
    })();
    expect((await vapi({ type: 'status-update', status: 'in-progress' }, 'c1', newPhone())).statusCode).toBe(200);
  });

  test('setup gives the vendor prompt (disclosure, never-list) and tools pointing at this clinic', async () => {
    const setup = (await api(cookieA, 'GET', '/v1/voice/setup')).json() as {
      enabled: boolean;
      has_secret: boolean;
      systemPrompt: string;
      tools: { type: string; function?: { name: string }; server?: { url: string } }[];
    };
    expect(setup).toMatchObject({ enabled: true, has_secret: true });
    expect(setup.systemPrompt).toContain('Hello, this is the Clinic a assistant');
    expect(setup.systemPrompt).toMatch(/never diagnose a condition/);
    expect(setup.tools.map((x) => x.function?.name ?? x.type)).toEqual(
      expect.arrayContaining(['get_available_slots', 'book_slot', 'escalate_to_human', 'transferCall']),
    );
    expect(setup.tools[0]!.server!.url).toContain(hookA.url);
  });
});

describe('one patient across WhatsApp and phone', () => {
  test('a WhatsApp patient who calls is the same lead; booking by phone uses the normal engine; one timeline', async () => {
    const phone = newPhone();
    await api(cookieA, 'POST', '/v1/dev/whatsapp/inbound', { from: phone, text: 'hi, do you do cleaning?', profile_name: 'Ritu' });
    await t.drainAssistant();
    const [slot] = (await findSlots(t.ctx, A, { service: 'Consultation', date: '2026-10-07', limit: 1, spread: false })).slots;

    await vapi({ type: 'status-update', status: 'in-progress' }, 'call-ritu', phone);
    const res = await toolCall('call-ritu', phone, [
      { id: 't1', name: 'book_slot', parameters: { service: 'Consultation', date: slot!.date, time: slot!.time } },
    ]);
    expect(JSON.parse(resultOf(res))).toMatchObject({ status: 'pending staff confirmation' });
    await vapi(
      { type: 'end-of-call-report', endedReason: 'customer-ended-call', analysis: { summary: 'Booked a consultation on Wednesday.' }, durationSeconds: 95 },
      'call-ritu',
      phone,
    );
    await t.drainJobs();

    const rows = await withTenant(t.ctx.db, A, async (tx) => ({
      leads: await tx.select().from(leads).where(eq(leads.phoneE164, phone)),
      appts: await tx.select().from(appointments),
      call: (await tx.select().from(calls).where(eq(calls.providerCallId, 'call-ritu')))[0],
    }));
    expect(rows.leads).toHaveLength(1);
    expect(rows.leads[0]!.source).toBe('whatsapp'); // first seen on WhatsApp; the call did not create another patient
    expect(rows.appts.filter((a) => a.leadId === rows.leads[0]!.id)).toHaveLength(1);
    expect(rows.call).toMatchObject({ status: 'completed', durationSec: 95, summary: 'Booked a consultation on Wednesday.' });

    const { entries } = (await api(cookieA, 'GET', `/v1/leads/${rows.leads[0]!.id}/timeline`)).json() as { entries: TimelineEntry[] };
    expect(entries.some((e) => e.channel === 'whatsapp')).toBe(true);
    const callEntry = entries.find((e) => e.channel === 'phone');
    expect(callEntry?.detail).toBe('Booked a consultation on Wednesday.');
    expect(entries.map((e) => e.title)).toContain('Appointment booked');
  });

  test('a new caller becomes a lead without a WhatsApp first reply (they are already talking to us)', async () => {
    const phone = newPhone();
    await toolCall('call-new', phone, [{ id: 't1', name: 'lookup_knowledge', parameters: { query: 'opening hours' } }]);
    await t.drainJobs();
    const [lead] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.phoneE164, phone)));
    expect(lead).toMatchObject({ source: 'phone_call' });
    const evs = await withTenant(t.ctx.db, A, (tx) => tx.select().from(events).where(eq(events.leadId, lead!.id)));
    expect(evs.map((e) => e.type)).not.toContain('lead.contacted');
  });
});

describe('idempotency and limits', () => {
  test('a retried tool call (same id) runs once and returns the same answer; a retried end report alerts once', async () => {
    const phone = newPhone();
    const [slot] = (await findSlots(t.ctx, A, { service: 'Consultation', date: '2026-10-08', limit: 1, spread: false })).slots;
    const body = [{ id: 'dup-1', name: 'book_slot', parameters: { service: 'Consultation', date: slot!.date, time: slot!.time } }];
    const first = resultOf(await toolCall('call-dup', phone, body));
    const second = resultOf(await toolCall('call-dup', phone, body));
    expect(second).toBe(first);
    const appts = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(inArray(appointments.status, ['pending', 'scheduled'])),
    );
    const mine = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.phoneE164, phone)));
    expect(appts.filter((a) => a.leadId === mine[0]!.id)).toHaveLength(1);
    const report = { type: 'end-of-call-report', endedReason: 'customer-ended-call', durationSeconds: 30 };
    await vapi(report, 'call-dup', phone);
    await vapi(report, 'call-dup', phone);
    const ended = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(events).where(and(eq(events.type, 'call.ended'), eq(events.leadId, mine[0]!.id))),
    );
    expect(ended).toHaveLength(1);
  });

  test('the monthly minutes cap stops bookings by phone and points the caller to the clinic', async () => {
    await setConfig(A, (c) => ({ ...c, voice: { ...VOICE, monthly_minutes_cap: 2 } }));
    const res = await toolCall('call-cap', newPhone(), [{ id: 'cap', name: 'get_available_slots', parameters: { service: 'Consultation' } }]);
    expect(resultOf(res)).toMatch(/monthly minutes/); // 95 s + 30 s already used this month
    await setConfig(A, (c) => ({ ...c, voice: VOICE }));
  });

  test('clinic autonomy applies to the phone too: a tool set to off cannot be called', async () => {
    await setConfig(A, (c) => ({ ...c, voice: VOICE, autonomy: { cancel: 'off' } }));
    const res = await toolCall('call-off', newPhone(), [{ id: 'o1', name: 'cancel', parameters: {} }]);
    expect(resultOf(res)).toMatch(/Unknown tool/);
    await setConfig(A, (c) => ({ ...c, autonomy: {} }));
  });

  test('a hidden caller number can not book anything', async () => {
    const res = await toolCall('call-hidden', null, [{ id: 'h1', name: 'cancel', parameters: {} }]);
    expect(resultOf(res)).toMatch(/number is hidden/);
  });
});

describe('safety and hand-off', () => {
  test('an emergency phrase on a call escalates in code; every later tool answer is the fixed emergency reply', async () => {
    const phone = newPhone();
    await vapi({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'my swelling is spreading to my eye' }, 'call-em', phone);
    const [lead] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.phoneE164, phone)));
    expect(lead?.aiPaused).toBe(true);
    const res = await toolCall('call-em', phone, [{ id: 'e1', name: 'get_available_slots', parameters: { service: 'Consultation' } }]);
    expect(resultOf(res)).toMatch(/^EMERGENCY/);
    const jobs = await t.drainJobs();
    expect(jobs.some((j) => j.queue === 'staff-alert')).toBe(true);
  });

  test('transfer goes to the clinic number while open; after hours the caller leaves a message', async () => {
    const open = (await vapi({ type: 'transfer-destination-request' }, 'call-tr', newPhone())).json();
    expect(open).toMatchObject({ destination: { type: 'number', number: '+919800000001' } });
    t.clock.advance(12 * 3_600_000); // 22:00 IST
    const closed = (await vapi({ type: 'transfer-destination-request' }, 'call-tr2', newPhone())).json() as { error?: string };
    expect(closed.error).toMatch(/Take a message/);
    const [c] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(calls).where(eq(calls.providerCallId, 'call-tr2')));
    expect(c?.afterHours).toBe(true);
    t.clock.advance(12 * 3_600_000);
  });

  test("clinic B's webhook and credential never reach clinic A's patients", async () => {
    await setConfig(B, (c) => ({ ...c, voice: VOICE }));
    const phone = newPhone();
    await vapi({ type: 'status-update', status: 'in-progress' }, 'call-b', phone, hookB);
    expect((await vapi({ type: 'status-update', status: 'in-progress' }, 'call-x', phone, hookA, hookB.secret)).statusCode).toBe(401);
    const aSees = await withTenant(t.ctx.db, A, (tx) => tx.select().from(calls).where(eq(calls.providerCallId, 'call-b')));
    const bSees = await withTenant(t.ctx.db, B, (tx) => tx.select().from(calls).where(eq(calls.providerCallId, 'call-b')));
    expect(aSees).toEqual([]);
    expect(bSees).toHaveLength(1);
    expect((await api(cookieB, 'GET', '/v1/voice/setup')).json()).toMatchObject({ webhook_url: expect.stringContaining(hookB.url) });
  });
});
