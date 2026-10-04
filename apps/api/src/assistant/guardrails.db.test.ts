import type { LlmProvider, LlmRequest, LlmResponse } from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';
import { withTenant } from '../db/client.ts';
import { conversations, leads, llmRuns, messages } from '../db/schema.ts';
import { handleInboundMessage } from '../inbound.ts';
import { computeReport } from '../reports.ts';
import { getActiveConfig } from '../config-store.ts';
import { createFakeLlm } from './fake-llm.ts';

// The rule-based fake by default; a test can script the agent_reply model.
const fake = createFakeLlm();
let script: ((req: LlmRequest) => Promise<LlmResponse> | LlmResponse) | null = null;
const seen: LlmRequest[] = [];
const llm: LlmProvider = {
  provider: 'fake',
  model: 'fake',
  async complete(req, hints) {
    seen.push(structuredClone(req));
    return script && req.task.startsWith('agent_reply') ? script(req) : fake.complete(req, hints);
  },
};
const text = (t: string): LlmResponse => ({
  text: t,
  toolCalls: [],
  stop: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  raw: { provider: 'fake', model: 'fake', data: null },
});

let t: TestContext;
let A: string;
let cookie: string;
let n = 9600000000;

beforeAll(async () => {
  t = await createTestContext({ llm });
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
beforeEach(() => {
  script = null;
});

const newPhone = () => String(n++);
const say = (from: string, payload: object) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/dev/whatsapp/inbound',
    headers: { cookie },
    payload: { from, ...payload },
  });
const leadOf = async (from: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(leads)
        .where(eq(leads.phoneE164, `+91${from}`)),
    )
  )[0]!;
const outbound = async (leadId: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, leadId))
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
    )
  )
    .filter((m) => m.direction === 'out')
    .map((m) => m.body);
const agentCalls = () => seen.filter((r) => r.task.startsWith('agent_reply')).length;

describe('media', () => {
  test('a photo without a caption: warm fixed reply, staff alerted, no AI call', async () => {
    const from = newPhone();
    const before = seen.length;
    await say(from, { media_type: 'image' });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'replied', reason: 'media: image' }]);
    expect(seen.length).toBe(before);
    const lead = await leadOf(from);
    expect(await outbound(lead.id)).toEqual([expect.stringMatching(/doctor will look at it/)]);
    const staffBefore = t.ctx.fakeChannel.sent.length;
    await t.drainJobs();
    expect(t.ctx.fakeChannel.sent.slice(staffBefore)).toContainEqual(
      expect.objectContaining({ to: '+910000000000' }),
    );
    expect(lead.aiPaused).toBe(false); // the conversation carries on
  });

  test('voice note: asks them to type; sticker: nothing; reaction: not even a turn', async () => {
    const from = newPhone();
    await say(from, { media_type: 'audio' });
    await t.drainAssistant();
    expect(await outbound((await leadOf(from)).id)).toEqual([expect.stringMatching(/voice notes/)]);

    const s = newPhone();
    await say(s, { media_type: 'sticker' });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'skipped' }]);
    await say(s, { media_type: 'reaction', text: '👍' });
    expect(await t.drainAssistant()).toEqual([]);
  });

  test('a captioned photo goes to the AI as text, flagged as a photo', async () => {
    const from = newPhone();
    await say(from, { media_type: 'image', text: 'is this tooth decay?' });
    await t.drainAssistant();
    const req = seen.filter((r) => r.task.startsWith('agent_reply')).at(-1)!;
    expect(JSON.stringify(req.turns)).toMatch(/\(sent a image\) is this tooth decay\?/);
  });
});

describe('not a real enquiry', () => {
  test('vendor pitch: one polite line, tagged, follow-ups stop, then silence', async () => {
    const from = newPhone();
    await say(from, { text: 'Hello sir, we provide digital marketing services for clinics at best rates' });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'replied', reason: 'not a lead (vendor)' }]);
    const lead = await leadOf(from);
    expect(lead).toMatchObject({ notALead: 'vendor', state: 'disqualified' });
    expect(await outbound(lead.id)).toEqual([expect.stringMatching(/customer enquiries/)]);
    await say(from, { text: 'sir please reply, very good offer for you' });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'skipped' }]);
    expect(await outbound(lead.id)).toHaveLength(1);
  });

  test("another business's auto-reply gets no reply at all", async () => {
    const from = newPhone();
    await say(from, { text: 'Thank you for contacting ABC Motors. Our team will get back to you shortly.' });
    expect(await t.drainAssistant()).toMatchObject([
      { status: 'skipped', reason: 'not a lead (auto_reply)' },
    ]);
    expect(await outbound((await leadOf(from)).id)).toEqual([]);
  });

  test('anything that sounds like a patient stays genuine', async () => {
    const from = newPhone();
    await say(from, { text: 'we provide SEO services, but also my tooth is paining badly since yesterday' });
    await t.drainAssistant();
    expect((await leadOf(from)).notALead).toBeNull();
  });

  test('junk is left out of reports; staff can mark a lead as real', async () => {
    const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
    const now = t.clock.now();
    const report = await withTenant(t.ctx.db, A, (tx) =>
      computeReport(tx, config, new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 1), now),
    );
    const all = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads));
    expect(report.leads).toBe(all.filter((l) => !l.notALead).length);

    const vendor = all.find((l) => l.notALead === 'vendor')!;
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/leads/${vendor.id}/real-lead`,
      headers: { cookie },
    });
    expect(res.json()).toMatchObject({ state: 'qualifying', aiPaused: false });
    expect((await leadOf(vendor.phoneE164.slice(3))).notALead).toBeNull();
  });
});

describe('flood and loops', () => {
  test('a flood of messages: one holding reply and a hand-over, not a reply storm', async () => {
    const from = newPhone();
    for (let i = 0; i < 16; i++) await say(from, { text: `msg ${i} hello??` });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'escalated', reason: 'flood' }]);
    const lead = await leadOf(from);
    expect(lead.aiPaused).toBe(true);
    expect(await outbound(lead.id)).toEqual([expect.stringMatching(/team will get back to you/)]);
  });

  test('saying the same thing again: a person takes over', async () => {
    const from = newPhone();
    script = () => text('Could you tell me which treatment you are interested in?');
    await say(from, { text: 'hello there' });
    await t.drainAssistant();
    await say(from, { text: 'umm not sure' });
    expect(await t.drainAssistant()).toMatchObject([
      { status: 'escalated', reason: 'conversation stuck (same reply again)' },
    ]);
  });
});

describe('output guard', () => {
  test('an invented price is repaired once, never sent, and logged on the run', async () => {
    const from = newPhone();
    let call = 0;
    script = (req) => {
      call++;
      if (call === 1) return text('**Implants** cost ₹25,000 at our clinic.');
      const last = req.turns.at(-1);
      expect(last?.role === 'system' && last.text).toMatch(/NOT sent: it states a price \(₹25000\)/);
      return text(
        'The dentist gives the exact implant price after a check-up (consultation ₹500). Shall I find you a time?',
      );
    };
    await say(from, { text: 'how much are implants' });
    expect(await t.drainAssistant()).toMatchObject([{ status: 'replied' }]);
    const lead = await leadOf(from);
    expect(await outbound(lead.id)).toEqual([expect.stringMatching(/exact implant price after a check-up/)]);
    const runs = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(llmRuns).where(eq(llmRuns.leadId, lead.id)).orderBy(asc(llmRuns.createdAt)),
    );
    expect(runs.find((r) => r.guardViolations)?.guardViolations).toEqual([
      expect.stringMatching(/price \(₹25000\)/),
    ]);
  });

  test('still breaking the rules after the repair: a safe hand-over instead', async () => {
    const from = newPhone();
    script = () => text('Take paracetamol 500 mg and rest.');
    await say(from, { text: 'my tooth hurts what should i take' });
    expect(await t.drainAssistant()).toMatchObject([
      { status: 'escalated', reason: expect.stringMatching(/reply failed safety checks: names a medicine/) },
    ]);
    expect(await outbound((await leadOf(from)).id)).toEqual([
      expect.stringMatching(/team will get back to you/),
    ]);
  });

  test('a message that arrives mid-turn: this reply is dropped and the next turn answers both', async () => {
    const from = newPhone();
    await say(from, { text: 'hi, do you do braces?' });
    script = async () => {
      script = null;
      await handleInboundMessage(t.ctx, A, {
        provider: 'fake',
        providerMessageId: `mid-${from}`,
        from: `+91${from}`,
        text: 'also, are you open on sunday?',
      });
      return text('Yes, we do braces!');
    };
    const results = await t.drainAssistant();
    expect(results[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/newer message/) });
    expect(results.length).toBe(2);
    expect(await outbound((await leadOf(from)).id)).toHaveLength(1);
  });
});

describe('memory', () => {
  test('long conversations: older messages are summarised, recent ones kept verbatim', async () => {
    const from = newPhone();
    await say(from, { text: 'hello' });
    await t.drainAssistant();
    const lead = await leadOf(from);
    await withTenant(t.ctx.db, A, async (tx) => {
      for (let i = 0; i < 45; i++)
        await tx.insert(messages).values({
          leadId: lead.id,
          direction: i % 2 ? 'out' : 'in',
          kind: 'text',
          body: i % 2 ? `answer ${i}` : `question ${i}`,
          status: i % 2 ? 'sent' : 'received',
          occurredAt: new Date(t.clock.now().getTime() - (50 - i) * 3_600_000),
        });
    });
    t.clock.advance(60_000);
    await say(from, { text: 'and what about whitening?' });
    await t.drainAssistant();
    const [conv] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(conversations).where(eq(conversations.leadId, lead.id)),
    );
    expect(conv?.summary).toMatch(/Earlier the customer said/);
    const req = seen.filter((r) => r.task.startsWith('agent_reply')).at(-1)!;
    expect(req.turns[0]).toMatchObject({
      role: 'system',
      text: expect.stringMatching(/^Summary of the earlier/),
    });
    expect(seen.some((r) => r.task === 'memory_summarize')).toBe(true);
  });
});

test('customer identifiers are redacted before any prompt leaves the app', async () => {
  const from = newPhone();
  await say(from, { text: 'please call me on 98765 43210 or mail priya@example.com about braces' });
  await t.drainAssistant();
  const req = seen.filter((r) => r.task.startsWith('agent_reply')).at(-1)!;
  const sent = JSON.stringify(req.turns);
  expect(sent).toMatch(/\[phone\].*\[email\]/);
  expect(sent).not.toMatch(/98765|priya@/);
  expect(agentCalls()).toBeGreaterThan(0);
});
