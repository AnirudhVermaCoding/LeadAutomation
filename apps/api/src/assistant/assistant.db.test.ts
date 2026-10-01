import type { Anthropic, LlmProvider, LlmRequest } from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';
import { withTenant } from '../db/client.ts';
import { answers, leads, llmRuns, messages } from '../db/schema.ts';
import { createFakeLlm } from './fake-llm.ts';

// The fake receptionist by default; individual tests can script the model's responses.
const fake = createFakeLlm();
let script: ((req: LlmRequest) => Anthropic.Message) | null = null;
const seen: LlmRequest[] = [];
const llm: LlmProvider = {
  name: 'fake',
  model: 'fake',
  complete(req, hints) {
    seen.push(structuredClone(req));
    return script ? Promise.resolve(script(req)) : fake.complete(req, hints);
  },
};
const reply = (content: object[], stop: Anthropic.StopReason, extra: object = {}) =>
  ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  }) as unknown as Anthropic.Message;

let t: TestContext;
let A: string;
let cookie: string;

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

const say = async (from: string, text: string) => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/dev/whatsapp/inbound',
    headers: { cookie },
    payload: { from, text },
  });
  expect(res.statusCode).toBe(200);
};
const lead = async (phone: string) =>
  (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.phoneE164, phone))))[0]!;
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

describe('qualification conversation (mock-mode assistant)', () => {
  test('extracts answers, scores deterministically, and asks the next question', async () => {
    await say('9800000001', 'Hi, I want teeth whitening');
    expect(await t.drainAssistant()).toMatchObject([{ status: 'replied' }]);
    const l = await lead('+919800000001');
    expect((await outbound(l.id)).at(-1)).toMatch(/how soon/i);

    await say('9800000001', 'today if possible');
    await t.drainAssistant();
    const after = await lead('+919800000001');
    // Qualified (deterministic score), then straight on to offering times.
    expect(after).toMatchObject({ state: 'booking_offered', tier: 'hot', score: 7 });
    const saved = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(answers).where(eq(answers.leadId, l.id)),
    );
    expect(Object.fromEntries(saved.map((a) => [a.key, a.value]))).toEqual({
      treatment_interest: 'whitening',
      urgency: 'today',
    });
    expect((await outbound(l.id)).at(-1)).toMatch(/I have these times free: 1\) /);
  });

  test('the request keeps a cacheable prefix: stable system + tools, per-turn state as a trailing system message', async () => {
    const last = seen.at(-1)!;
    expect(last.system).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
    expect(JSON.stringify(last.system)).not.toMatch(/Local time/);
    expect(last.thinking).toEqual({ type: 'between_tools' });
    const systemMsg = last.messages.find((m) => (m.role as string) === 'system');
    expect(String(systemMsg?.content)).toMatch(/Local time/);
    expect(last.messages[0]?.role).toBe('user');
  });

  test('a burst of messages becomes one turn and one reply', async () => {
    await say('9800000002', 'hello');
    await say('9800000002', 'are you there?');
    await say('9800000002', 'need braces');
    const results = await t.drainAssistant();
    expect(results).toHaveLength(1);
    expect(await outbound((await lead('+919800000002')).id)).toHaveLength(1);
  });

  test('every model call is logged with tokens and cost', async () => {
    const runs = await withTenant(t.ctx.db, A, (tx) => tx.select().from(llmRuns));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toMatchObject({ provider: 'fake', latencyMs: expect.any(Number), costUsd: 0 });
  });
});

describe('safety', () => {
  test('emergency keywords: fixed emergency reply and immediate human takeover, without asking the model', async () => {
    const before = seen.length;
    await say('9800000003', 'my gum is bleeding a lot and swelling');
    expect(await t.drainAssistant()).toMatchObject([{ status: 'escalated', reason: 'emergency' }]);
    expect(seen.length).toBe(before);
    const l = await lead('+919800000003');
    expect(l.aiPaused).toBe(true);
    expect((await outbound(l.id))[0]).toMatch(/call 112/);

    // While a human has taken over, new messages don't trigger the assistant.
    await say('9800000003', 'hello??');
    expect(await t.drainAssistant()).toEqual([]);
  });

  test('asking for a person escalates via the tool', async () => {
    await say('9800000004', 'can I talk to a real person please');
    expect(await t.drainAssistant()).toMatchObject([{ status: 'escalated' }]);
    expect((await lead('+919800000004')).aiPaused).toBe(true);
  });

  test('invalid tool arguments go back to the model as an error instead of being saved', async () => {
    let call = 0;
    script = (req) => {
      call++;
      if (call === 1)
        return reply(
          [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'record_answer',
              input: { key: 'urgency', value: 'yesterday' },
            },
          ],
          'tool_use',
        );
      const results = req.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
      expect(results[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/not an option/) });
      return reply(
        [{ type: 'text', text: 'How soon would you like to come in?', citations: null }],
        'end_turn',
      );
    };
    await say('9800000005', 'yesterday');
    await t.drainAssistant();
    script = null;
    const l = await lead('+919800000005');
    expect(
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(answers).where(eq(answers.leadId, l.id))),
    ).toEqual([]);
  });

  test('a model refusal hands over to staff with a polite holding message', async () => {
    script = () =>
      reply([], 'refusal', {
        stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
      });
    await say('9800000006', 'something odd');
    expect(await t.drainAssistant()).toMatchObject([{ status: 'escalated', reason: 'refusal' }]);
    script = null;
    const l = await lead('+919800000006');
    expect(l.aiPaused).toBe(true);
    expect(await outbound(l.id)).toEqual([expect.stringMatching(/team will get back to you/)]);
  });

  test('per-lead cost cap: over budget goes to staff instead of the model', async () => {
    await say('9800000007', 'hi');
    await t.drainAssistant();
    const l = await lead('+919800000007');
    await withTenant(t.ctx.db, A, (tx) =>
      tx.insert(llmRuns).values({
        leadId: l.id,
        provider: 'anthropic',
        model: 'x',
        latencyMs: 1,
        costUsd: 5,
        occurredAt: t.clock.now(),
      }),
    );
    await say('9800000007', 'whitening please');
    expect(await t.drainAssistant()).toMatchObject([{ status: 'escalated', reason: 'cost cap' }]);
  });

  test('the reply language follows the lead (Hindi holding message)', async () => {
    script = () => reply([], 'refusal', { stop_details: null });
    await say('9800000008', 'मुझे कल दांत दिखाना है');
    await t.drainAssistant();
    script = null;
    const l = await lead('+919800000008');
    expect(l.language).toBe('hi');
    expect((await outbound(l.id))[0]).toMatch(/धन्यवाद/);
  });
});
