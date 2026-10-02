import {
  createFakeEmail,
  LlmError,
  type LlmProvider,
  type LlmResponse,
  type ToolCall,
} from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { runAssistantTurn } from './assistant/agent.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { leads, llmRuns, messages } from './db/schema.ts';
import { createLlmRouter, NoModelAvailableError } from './llm-router.ts';
import { runMonitor } from './monitoring.ts';

const res = (text: string, toolCalls: ToolCall[] = []): LlmResponse => ({
  text,
  toolCalls,
  stop: toolCalls.length ? 'tool_use' : 'end',
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  raw: { provider: 'anthropic', model: 'x', data: null },
});

/** A stand-in for a real model id: behaviour is whatever the test sets. */
function stub(model: string, provider: LlmProvider['provider']) {
  const s = {
    provider,
    model,
    calls: 0,
    behave: (): Promise<LlmResponse> => Promise.resolve(res(`Hello from ${model.split('-')[1]}`)),
    complete() {
      s.calls++;
      return s.behave();
    },
  };
  return s;
}
const sonnet = stub('claude-sonnet-5-5', 'anthropic');
const haiku = stub('claude-haiku-4-5-20251001', 'anthropic');
const gpt = stub('gpt-6.1-sol', 'openai');
const outage = () => Promise.reject(new LlmError('server', 'overloaded', 529));

let t: TestContext;
let A: string;
let cookie: string;
let n = 9700000000;

beforeAll(async () => {
  t = await createTestContext({ llmProviders: [sonnet, haiku, gpt] });
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
  for (const s of [sonnet, haiku, gpt]) {
    s.calls = 0;
    s.behave = () => Promise.resolve(res(`Hello from ${s.model.split('-')[1]}`));
  }
});

/** A new lead says something; returns its id (the assistant turn is run by the test). */
async function inbound(text = 'hi') {
  const from = String(n++);
  await t.app.inject({
    method: 'POST',
    url: '/v1/dev/whatsapp/inbound',
    headers: { cookie },
    payload: { from, text },
  });
  const [l] = await withTenant(t.ctx.db, A, (tx) =>
    tx
      .select()
      .from(leads)
      .where(eq(leads.phoneE164, `+91${from}`)),
  );
  // Run the turn directly (the queued job is left alone).
  return l!.id;
}
const outbound = async (leadId: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.occurredAt)),
    )
  )
    .filter((m) => m.direction === 'out')
    .map((m) => m.body);
const runs = (leadId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(llmRuns).where(eq(llmRuns.leadId, leadId)).orderBy(asc(llmRuns.createdAt)),
  );
const setAi = (ai: object) =>
  withTenant(t.ctx.db, A, async (tx) => {
    const config = (await getActiveConfig(tx))!.config;
    await saveConfig(tx, t.clock, { type: 'system' }, { ...config, ai: ai as never });
  });

describe('failover', () => {
  test('primary outage: the fallback answers, and the run is logged as a fallback', async () => {
    sonnet.behave = outage;
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({ status: 'replied' });
    expect(await outbound(leadId)).toEqual(['Hello from haiku']);
    expect(await runs(leadId)).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-5-5', fallbackUsed: false, error: 'overloaded' }),
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        fallbackUsed: true,
        error: null,
        task: 'agent_reply',
      }),
    ]);
  });

  test('repeated invalid tool arguments: the next model redoes the turn', async () => {
    sonnet.behave = () =>
      Promise.resolve(
        res('', [
          { id: 'a', name: 'record_answer', input: { key: 'urgency', value: 'yesterday' } },
          { id: 'b', name: 'book_slot', input: { when: 'soon' } },
        ]),
      );
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({ status: 'replied' });
    expect(haiku.calls).toBe(1);
  });

  test('whole chain down: retried by the job, and on the last attempt the lead still hears back', async () => {
    sonnet.behave = outage;
    haiku.behave = outage;
    const leadId = await inbound();
    await expect(runAssistantTurn(t.ctx, A, leadId)).rejects.toMatchObject({ kind: 'server' });
    expect(await outbound(leadId)).toEqual([]);
    expect(await runAssistantTurn(t.ctx, A, leadId, { finalAttempt: true })).toMatchObject({
      status: 'escalated',
      reason: expect.stringMatching(/all AI models failed/),
    });
    expect(await outbound(leadId)).toEqual([expect.stringMatching(/team will get back to you/)]);
    const [l] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId)));
    expect(l?.aiPaused).toBe(true);
  });
});

describe('allowed providers', () => {
  test('a provider the tenant has not allowed is never called, even when routed first and keyed', async () => {
    await setAi({
      allowed_providers: ['anthropic'],
      monthly_cost_cap_usd: 50,
      routing: { agent_reply: ['gpt-6.1-sol', 'claude-sonnet-5-5'] },
    });
    const leadId = await inbound();
    await runAssistantTurn(t.ctx, A, leadId);
    expect(gpt.calls).toBe(0);
    expect(await outbound(leadId)).toEqual(['Hello from sonnet']);
  });

  test('allowing it routes to it; no eligible model at all hands over to staff', async () => {
    await setAi({
      allowed_providers: ['openai', 'anthropic'],
      monthly_cost_cap_usd: 50,
      routing: { agent_reply: ['gpt-6.1-sol'] },
    });
    await runAssistantTurn(t.ctx, A, await inbound());
    expect(gpt.calls).toBe(1);

    await setAi({ allowed_providers: ['gemini'], monthly_cost_cap_usd: 50 });
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({
      status: 'escalated',
      reason: 'no AI model available',
    });
    expect(sonnet.calls + haiku.calls + gpt.calls).toBe(1);
  });

  test('the router itself refuses with a clear error; no keys at all = mock mode on the fake', async () => {
    const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
    const router = createLlmRouter({ keys: { openai: 'k' }, fake: sonnet });
    expect(() =>
      router.chain('agent_reply', {
        ...config,
        ai: { allowed_providers: ['anthropic'], monthly_cost_cap_usd: 5 },
      }),
    ).toThrow(NoModelAvailableError);
    expect(
      router
        .chain('agent_reply', { ...config, ai: { allowed_providers: ['openai'], monthly_cost_cap_usd: 5 } })
        .map((p) => p.model),
    ).toEqual(['gpt-6.1-sol']);
    const mock = createLlmRouter({ keys: {}, fake: haiku });
    expect(mock.mockOnly).toBe(true);
    expect(mock.chain('intent_classify', config)).toEqual([haiku]);
  });
});

describe('monthly AI budget', () => {
  test('warning alert at 80%, staff handover at 100%', async () => {
    await setAi({ allowed_providers: ['anthropic'], monthly_cost_cap_usd: 1 });
    const leadId = await inbound();
    await withTenant(t.ctx.db, A, (tx) =>
      tx.insert(llmRuns).values({
        leadId: null,
        provider: 'anthropic',
        model: 'x',
        latencyMs: 1,
        costUsd: 0.85,
        occurredAt: t.clock.now(),
      }),
    );
    const email = createFakeEmail();
    const deps = { system: t.ctx.system, email, alertEmail: 'ops@agency.test', now: () => new Date() };
    await runMonitor(deps);
    expect(email.sent.map((m) => m.text).join('\n')).toMatch(
      /Smile Dental: \d+% of this month's AI budget used/,
    );

    await withTenant(t.ctx.db, A, (tx) =>
      tx.insert(llmRuns).values({
        leadId: null,
        provider: 'anthropic',
        model: 'x',
        latencyMs: 1,
        costUsd: 0.5,
        occurredAt: t.clock.now(),
      }),
    );
    const before = sonnet.calls;
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({
      status: 'escalated',
      reason: 'monthly AI budget reached',
    });
    expect(sonnet.calls).toBe(before);
    const usage = await t.ctx.system.usageSince(new Date(0));
    expect(usage.find((u) => u.tenantId === A)).toMatchObject({
      llmCapUsd: 1,
      llmProviders: expect.stringContaining('anthropic'),
    });
  });
});
