import { DEFAULT_LLM_ROUTING } from '@instantlead/config';
import {
  createFakeEmail,
  errorKind,
  LlmError,
  type LlmProvider,
  type LlmRequest,
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
  raw: { provider: 'gemini', model: 'x', data: null },
});

/** The judge's answer for message_route; anything else says hello. */
const judge =
  (complexity: string, hello = 'Hello') =>
  (req: LlmRequest) =>
    Promise.resolve(
      res(req.task === 'message_route' ? JSON.stringify({ complexity }) : `${hello} from ${req.task}`),
    );

/** A stand-in for a real model id: behaviour is whatever the test sets. */
function stub(model: string, provider: LlmProvider['provider']) {
  const s = {
    provider,
    model,
    calls: 0,
    tasks: [] as string[],
    behave: (_req: LlmRequest): Promise<LlmResponse> => Promise.resolve(res(`Hello from ${model}`)),
    complete(req: LlmRequest) {
      s.calls++;
      s.tasks.push(req.task);
      return s.behave(req);
    },
  };
  return s;
}
const lite31 = stub('gemini-3.1-flash-lite', 'gemini');
const lite35 = stub('gemini-3.5-flash-lite', 'gemini');
const lite25 = stub('gemini-2.5-flash-lite', 'gemini');
const gpt = stub('gpt-6.1-sol', 'openai');
const sonnet = stub('claude-sonnet-5-5', 'anthropic');
const all = [lite31, lite35, lite25, gpt, sonnet];
const outage = () => Promise.reject(new LlmError('server', 'overloaded', 529));
/** 13 to 60 words, one question at most, nothing delicate: the rules can't tell, so the judge decides. */
const AMBIGUOUS =
  'hello I saw your clinic on the way to work and was wondering what would suit my teeth best for a wedding next month';

let t: TestContext;
let A: string;
let cookie: string;
let n = 9700000000;

beforeAll(async () => {
  t = await createTestContext({ llmProviders: all });
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
  for (const s of all) {
    s.calls = 0;
    s.tasks = [];
    s.behave = (req) =>
      Promise.resolve(
        res(
          req.task === 'message_route' ? JSON.stringify({ complexity: 'simple' }) : `Hello from ${s.model}`,
        ),
      );
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
const setConsent = (text: string) =>
  withTenant(t.ctx.db, A, async (tx) => {
    const config = (await getActiveConfig(tx))!.config;
    await saveConfig(
      tx,
      t.clock,
      { type: 'system' },
      { ...config, intake: { ...config.intake, consent_notice_text: text } },
    );
  });

describe('defaults', () => {
  test('no Claude model in any default chain; Gemini Flash-Lite tiers per task', () => {
    expect(
      Object.values(DEFAULT_LLM_ROUTING)
        .flat()
        .filter((m) => m.startsWith('claude')),
    ).toEqual([]);
    expect(DEFAULT_LLM_ROUTING.agent_reply[0]).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_LLM_ROUTING.agent_reply_complex[0]).toBe('gemini-3.5-flash-lite');
    expect(DEFAULT_LLM_ROUTING.message_route[0]).toBe('gemini-2.5-flash-lite');
  });
});

describe('failover', () => {
  test('primary outage: the fallback answers, and the run is logged as a fallback', async () => {
    lite31.behave = outage;
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({ status: 'replied' });
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.5-flash-lite']);
    expect(await runs(leadId)).toEqual([
      expect.objectContaining({ model: 'gemini-3.1-flash-lite', fallbackUsed: false, error: 'overloaded' }),
      expect.objectContaining({
        model: 'gemini-3.5-flash-lite',
        fallbackUsed: true,
        error: null,
        task: 'agent_reply',
      }),
    ]);
  });

  test('repeated invalid tool arguments: the next model redoes the turn', async () => {
    lite31.behave = () =>
      Promise.resolve(
        res('', [
          { id: 'a', name: 'record_answer', input: { key: 'urgency', value: 'yesterday' } },
          { id: 'b', name: 'book_slot', input: { when: 'soon' } },
        ]),
      );
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({ status: 'replied' });
    expect(lite35.calls).toBe(1);
  });

  test('whole chain down: retried by the job, and on the last attempt the lead still hears back', async () => {
    lite31.behave = outage;
    lite35.behave = outage;
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

  test('a model the project cannot access (404) fails over instead of failing the turn', async () => {
    lite31.behave = () => Promise.reject(new LlmError(errorKind(404), 'model not found', 404));
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({ status: 'replied' });
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.5-flash-lite']);
  });
});

describe('turn routing', () => {
  test('obvious simple turn: 3.1 Flash-Lite answers, the judge is never called', async () => {
    const leadId = await inbound('hi, what time do you open?');
    await runAssistantTurn(t.ctx, A, leadId);
    expect(lite25.tasks).not.toContain('message_route'); // (the junk screen may run; the judge must not)
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.1-flash-lite']);
  });

  test('obvious complex turn (a refund): 3.5 Flash-Lite answers, no judge, logged as agent_reply_complex', async () => {
    const leadId = await inbound('I want a refund, the cleaning last week was badly done');
    await runAssistantTurn(t.ctx, A, leadId);
    expect(lite25.tasks).not.toContain('message_route'); // (the junk screen may run; the judge must not)
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.5-flash-lite']);
    expect((await runs(leadId)).map((r) => r.task)).toEqual(['agent_reply_complex']);
  });

  test('ambiguous turn: the 2.5 Flash-Lite judge decides, once', async () => {
    lite25.behave = judge('complex');
    const leadId = await inbound(AMBIGUOUS);
    await runAssistantTurn(t.ctx, A, leadId);
    expect(lite25.tasks.filter((x) => x === 'message_route')).toHaveLength(1);
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.5-flash-lite']);
    expect((await runs(leadId)).map((r) => [r.task, r.promptVersion])).toEqual([
      ['message_route', 'route-v1'],
      ['agent_reply_complex', expect.any(String)],
    ]);

    lite25.behave = judge('simple');
    const other = await inbound(AMBIGUOUS);
    await runAssistantTurn(t.ctx, A, other);
    expect(await outbound(other)).toEqual(['Hello from gemini-3.1-flash-lite']);
  });

  test('no 2.5 access (404): 3.1 judges instead; a judge that times out means the default model', async () => {
    lite25.behave = () => Promise.reject(new LlmError(errorKind(404), 'model not found', 404));
    lite31.behave = judge('complex', 'Judged by 3.1');
    const leadId = await inbound(AMBIGUOUS);
    await runAssistantTurn(t.ctx, A, leadId);
    expect(lite31.tasks).toContain('message_route');
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.5-flash-lite']);

    lite25.behave = () => Promise.reject(new LlmError('timeout', 'timed out'));
    lite31.behave = (req) =>
      req.task === 'message_route'
        ? Promise.reject(new LlmError('timeout', 'timed out'))
        : Promise.resolve(res('Hello from 3.1'));
    const other = await inbound(AMBIGUOUS);
    expect(await runAssistantTurn(t.ctx, A, other)).toMatchObject({ status: 'replied' });
    expect(await outbound(other)).toEqual(['Hello from 3.1']);
  });

  test('the judge gets a short timeout and only the redacted customer text', async () => {
    let seen: LlmRequest | undefined;
    lite25.behave = (req) => {
      seen = req;
      return judge('simple')(req);
    };
    await runAssistantTurn(t.ctx, A, await inbound(`${AMBIGUOUS} mail me at someone@example.com`));
    expect(seen?.timeoutMs).toBe(5_000);
    expect(seen?.tools).toBeUndefined();
    expect(seen?.turns).toHaveLength(1);
    expect(JSON.stringify(seen?.turns)).not.toContain('someone@example.com');
  });
});

describe('allowed providers and consent', () => {
  test('a provider the tenant has not allowed is never called, even when routed first and keyed', async () => {
    await setAi({
      allowed_providers: ['gemini'],
      monthly_cost_cap_usd: 50,
      routing: { agent_reply: ['gpt-6.1-sol', 'gemini-3.1-flash-lite'] },
    });
    const leadId = await inbound();
    await runAssistantTurn(t.ctx, A, leadId);
    expect(gpt.calls).toBe(0);
    expect(await outbound(leadId)).toEqual(['Hello from gemini-3.1-flash-lite']);
  });

  test('an allowed provider the consent notice does not name never gets customer text; once named, it is used', async () => {
    await setAi({
      allowed_providers: ['openai', 'gemini'],
      monthly_cost_cap_usd: 50,
      routing: { agent_reply: ['gpt-6.1-sol', 'gemini-3.1-flash-lite'] },
    });
    await runAssistantTurn(t.ctx, A, await inbound());
    expect(gpt.calls).toBe(0);

    await setConsent('Replies may be written by an AI assistant (processed by Google Gemini and OpenAI).');
    await runAssistantTurn(t.ctx, A, await inbound());
    expect(gpt.calls).toBe(1);
  });

  test('no eligible model at all hands over to staff', async () => {
    await setAi({ allowed_providers: ['xai'], monthly_cost_cap_usd: 50 });
    const leadId = await inbound();
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({
      status: 'escalated',
      reason: 'no AI model available',
    });
    expect(all.reduce((sum, s) => sum + s.calls, 0)).toBe(0);
  });

  test('the router itself refuses with a clear error; no keys at all = mock mode on the fake', async () => {
    const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
    const router = createLlmRouter({ keys: { gemini: 'k', openai: 'k' }, fake: lite31 });
    expect(() =>
      router.chain('agent_reply', {
        ...config,
        ai: { allowed_providers: ['anthropic'], monthly_cost_cap_usd: 5 },
      }),
    ).toThrow(NoModelAvailableError);
    const gemini = { ...config, ai: { allowed_providers: ['gemini' as const], monthly_cost_cap_usd: 5 } };
    expect(router.chain('agent_reply', gemini).map((p) => p.model)).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
    ]);
    // A notice written for Anthropic (configs from before the switch) never silently covers Google.
    expect(() =>
      router.chain('agent_reply', {
        ...gemini,
        intake: { ...config.intake, consent_notice_text: 'Replies may be processed by Anthropic.' },
      }),
    ).toThrow(NoModelAvailableError);
    const mock = createLlmRouter({ keys: {}, fake: lite25 });
    expect(mock.mockOnly).toBe(true);
    expect(mock.chain('intent_classify', config)).toEqual([lite25]);
  });
});

describe('monthly AI budget', () => {
  test('warning alert at 80%, staff handover at 100%', async () => {
    await setAi({ allowed_providers: ['gemini'], monthly_cost_cap_usd: 1 });
    const leadId = await inbound();
    await withTenant(t.ctx.db, A, (tx) =>
      tx.insert(llmRuns).values({
        leadId: null,
        provider: 'gemini',
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
        provider: 'gemini',
        model: 'x',
        latencyMs: 1,
        costUsd: 0.5,
        occurredAt: t.clock.now(),
      }),
    );
    const before = lite31.calls;
    expect(await runAssistantTurn(t.ctx, A, leadId)).toMatchObject({
      status: 'escalated',
      reason: 'monthly AI budget reached',
    });
    expect(lite31.calls).toBe(before);
    const usage = await t.ctx.system.usageBetween(new Date(0), new Date('2100-01-01'));
    expect(usage.find((u) => u.tenantId === A)).toMatchObject({
      llmCapUsd: 1,
      llmProviders: expect.stringContaining('gemini'),
    });
  });
});
