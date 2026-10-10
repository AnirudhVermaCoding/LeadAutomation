import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_LLM_ROUTING,
  providerDisclosed,
  type LlmProviderName,
  type TenantConfig,
} from '@instantlead/config';
import {
  costUsd,
  LlmError,
  MODELS,
  providerForModel,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmTask,
  type ProviderKeys,
} from '@instantlead/integrations';
import type { Clock } from '@instantlead/core';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { withTenant, type Db, type Tx } from './db/client.ts';
import { llmRuns } from './db/schema.ts';

/** Capabilities a task needs; models without them are never routed that task. */
const NEEDS: Record<LlmTask, { tools?: boolean; structured?: boolean }> = {
  agent_reply: { tools: true },
  agent_reply_complex: { tools: true },
  message_route: { structured: true },
  intent_classify: { structured: true },
  language_detect: { structured: true },
  memory_summarize: {},
  report_text: {},
};

export const aiSettings = (config: TenantConfig) => config.ai ?? DEFAULT_AI_SETTINGS;

export class NoModelAvailableError extends Error {}

export interface LlmRouter {
  /** Eligible models for a task, primary first. Throws NoModelAvailableError when none is. */
  chain(task: LlmTask, config: TenantConfig): LlmProvider[];
  /** True when no real provider has a key: everything runs on the rule-based fake. */
  readonly mockOnly: boolean;
  /**
   * The router for a tenant on the mock WhatsApp channel (demo clinics): the free fake model only,
   * so demos never spend real AI money. Injected test providers (not billed) are kept.
   */
  forMockChannel(): LlmRouter;
}

/**
 * Routing = the task's model list (tenant override, else global default), filtered to models
 * that are registered, have the task's capabilities, belong to an allowed provider named in the
 * consent notice and have a key. Only Gemini models are ever eligible (decision 141): there is no
 * fallback to any other provider. With no keys at all, the fake model (mock mode) answers everything.
 */
export function createLlmRouter(opts: {
  keys: ProviderKeys;
  fake: LlmProvider;
  /** Tests: use these instances (by model id) instead of building providers from keys. */
  providers?: LlmProvider[];
}): LlmRouter {
  const injected = new Map(opts.providers?.map((p) => [p.model, p]));
  const cache = new Map<string, LlmProvider | null>();
  const instance = (model: string) => {
    if (opts.providers) return injected.get(model) ?? null;
    if (!cache.has(model)) cache.set(model, providerForModel(model, opts.keys));
    return cache.get(model) ?? null;
  };
  const mockOnly = opts.providers
    ? opts.providers.every((p) => p.provider === 'fake')
    : !Object.values(opts.keys).some(Boolean);

  const fakeOnly: LlmRouter = { mockOnly: true, chain: () => [opts.fake], forMockChannel: () => fakeOnly };
  const router: LlmRouter = {
    mockOnly,
    forMockChannel: () => (opts.providers ? router : fakeOnly),
    chain(task, config) {
      if (mockOnly) return [opts.fake];
      const ai = aiSettings(config);
      const models = ai.routing?.[task] ?? DEFAULT_LLM_ROUTING[task];
      const needs = NEEDS[task];
      const chain = models.flatMap((id) => {
        const spec = MODELS[id];
        // Gemini only, whatever a stored config or routing override names.
        if (!spec || spec.provider !== 'gemini') return [];
        if (!(ai.allowed_providers as string[]).includes(spec.provider)) return [];
        // Consent is code: a provider the customer wasn't told about never receives their text.
        if (!providerDisclosed(config.intake.consent_notice_text, spec.provider as LlmProviderName))
          return [];
        if ((needs.tools && !spec.supportsTools) || (needs.structured && !spec.supportsStructuredOutput))
          return [];
        const p = instance(id);
        return p?.provider === 'gemini' ? [p] : [];
      });
      if (!chain.length)
        throw new NoModelAvailableError(
          `No AI model available for ${task}: allowed providers ${ai.allowed_providers.join(', ')} have no API key, no capable model, or are not named in the consent notice`,
        );
      return chain;
    },
  };
  return router;
}

export interface RunMeta {
  tenantId: string;
  leadId: string | null;
  task: LlmTask;
  promptVersion?: string;
  fallbackUsed: boolean;
}

/** One logged model call: provider, model, task, prompt version, tokens, cost, latency, fallback. */
export async function loggedCall(
  deps: { db: Db; clock: Clock },
  llm: LlmProvider,
  req: LlmRequest,
  meta: RunMeta,
  hints?: unknown,
): Promise<LlmResponse & { runId: string }> {
  const started = performance.now();
  const record = (fields: Partial<typeof llmRuns.$inferInsert>) =>
    withTenant(deps.db, meta.tenantId, (tx) =>
      tx
        .insert(llmRuns)
        .values({
          leadId: meta.leadId,
          provider: llm.provider,
          model: llm.model,
          task: meta.task,
          promptVersion: meta.promptVersion ?? null,
          fallbackUsed: meta.fallbackUsed,
          latencyMs: Math.round(performance.now() - started),
          occurredAt: deps.clock.now(),
          ...fields,
        })
        .returning({ id: llmRuns.id }),
    );
  try {
    const res = await llm.complete(req, hints);
    const [run] = await record({
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens,
      cacheWriteTokens: res.usage.cacheWriteTokens,
      costUsd: costUsd(llm.model, res.usage),
      stopReason: res.stop,
      providerRequestId: res.requestId ?? null,
    });
    return { ...res, runId: run!.id };
  } catch (err) {
    await record({ error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    throw err;
  }
}

/**
 * A single-call task with JSON output (classification, summary…): try each model in the chain,
 * fail over on outages and on output that doesn't match the schema. Throws the last error when
 * the whole chain fails.
 */
export async function runStructured<T>(
  deps: { db: Db; clock: Clock; router: LlmRouter },
  config: TenantConfig,
  req: Omit<LlmRequest, 'output'> & { output: { name: string; schema: Record<string, unknown> } },
  parse: z.ZodType<T>,
  meta: Omit<RunMeta, 'fallbackUsed' | 'task'>,
  hints?: unknown,
): Promise<T> {
  let last: unknown;
  for (const [i, llm] of deps.router.chain(req.task, config).entries()) {
    try {
      const res = await loggedCall(deps, llm, req, { ...meta, task: req.task, fallbackUsed: i > 0 }, hints);
      let json: unknown;
      try {
        json = JSON.parse(res.text);
      } catch {
        throw new LlmError('invalid_output', `${llm.model}: output is not JSON`);
      }
      const parsed = parse.safeParse(json);
      if (!parsed.success) throw new LlmError('invalid_output', `${llm.model}: ${parsed.error.message}`);
      return parsed.data;
    } catch (err) {
      last = err;
      if (!(err instanceof LlmError && err.failover)) throw err;
    }
  }
  throw last;
}

/** This month's LLM spend for the tenant (calendar month, UTC). */
export async function monthSpendUsd(tx: Tx, now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await tx.execute<{ total: string | null }>(
    sql`select sum(cost_usd) as total from llm_runs where occurred_at >= ${start}`,
  );
  return Number(r.rows[0]?.total ?? 0);
}
