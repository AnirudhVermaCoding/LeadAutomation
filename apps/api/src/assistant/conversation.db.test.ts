import { PRESETS } from '@instantlead/config';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';
import { withTenant } from '../db/client.ts';
import { leads, messages } from '../db/schema.ts';
import { buildSystemPrompt, openingStatus } from './prompt.ts';

// Mock mode (rule-based model): proves the conversation paths; real-model quality is in pnpm evals.
let t: TestContext;
let A: string;
let cookie: string;
let n = 9500000000;

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

async function chat(from: string, text: string) {
  await t.app.inject({
    method: 'POST',
    url: '/v1/dev/whatsapp/inbound',
    headers: { cookie },
    payload: { from, text },
  });
  await t.drainAssistant();
  const [lead] = await withTenant(t.ctx.db, A, (tx) =>
    tx
      .select()
      .from(leads)
      .where(eq(leads.phoneE164, `+91${from}`)),
  );
  const out = (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, lead!.id))
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
    )
  ).filter((m) => m.direction === 'out');
  return { lead: lead!, last: out.at(-1)?.body ?? '' };
}

describe('sounds like a person, steers to the right appointment', () => {
  test('a symptom in their own words: empathy, no diagnosis, the right service, an offer; "yes" finds times', async () => {
    const from = String(n++);
    const first = await chat(from, 'my gums bleed when I brush, is that bad?');
    expect(first.last).toMatch(/^Sorry to hear that/);
    expect(first.last).toMatch(/can't say what's causing it/);
    expect(first.last).toMatch(/find you a consultation slot/i);
    expect(first.lead.aiPaused).toBe(false); // not an emergency
    const second = await chat(from, 'yes please');
    expect(second.last).toMatch(/I have these times free: 1\)/);
    expect(second.lead.state).toBe('booking_offered');
  });

  test('"are you a bot?" gets an honest, friendly answer (no hand-over)', async () => {
    const { last, lead } = await chat(String(n++), 'are you a real person?');
    expect(last).toMatch(/virtual assistant/);
    expect(last).not.toMatch(/as an AI/i);
    expect(lead.aiPaused).toBe(false);
  });

  test('several questions in one message are all answered, then one question back', async () => {
    const { last } = await chat(String(n++), 'how much is cleaning and where are you located?');
    expect(last).toMatch(/Cleaning ₹1,500/);
    expect(last).toMatch(/Address/);
    expect(last.trim().endsWith('?')).toBe(true); // then one question back
  });

  test('questions are asked conversationally, not as a form', async () => {
    const from = String(n++);
    await chat(from, 'hello');
    const { last } = await chat(from, 'I want whitening');
    expect(last).toMatch(/How soon would you like to come in/);
    expect(last).not.toMatch(/Could you tell me:|\(today \/ this week/);
  });

  test('blue ticks and "typing…" are shown on their message while the reply is prepared', async () => {
    const before = t.ctx.fakeChannel.read.length;
    await chat(String(n++), 'hi there');
    expect(t.ctx.fakeChannel.read.length).toBe(before + 1);
    expect(t.ctx.fakeChannel.read.at(-1)).toMatch(/^fake\.in\./);
  });
});

describe('prompt v2', () => {
  const config = PRESETS.clinic_dental('Smile Dental');

  test('carries the services’ concerns, examples and honesty rules in the cached prefix', () => {
    const p = buildSystemPrompt(config);
    expect(p).toMatch(/Consultation \(20 min\) — right first step for: tooth pain/);
    expect(p).toMatch(/EXAMPLES/);
    expect(p).toMatch(/virtual assistant/);
    expect(p).not.toMatch(/Local time/); // per-turn state stays out of the cache
    expect(buildSystemPrompt(PRESETS.real_estate('Skyline'))).toMatch(/site visit/i);
  });

  test('opening status from business hours (IST)', () => {
    // Mon 5 Oct 2026. Preset: Mon–Sat 10:00–20:00.
    expect(openingStatus(config, new Date('2026-10-05T06:30:00Z'))).toBe('open now (until 20:00)'); // 12:00
    expect(openingStatus(config, new Date('2026-10-05T15:30:00Z'))).toBe(
      'closed now; opens tomorrow at 10:00',
    ); // 21:00
    expect(openingStatus(config, new Date('2026-10-05T03:00:00Z'))).toBe('closed now; opens today at 10:00'); // 08:30
  });
});
