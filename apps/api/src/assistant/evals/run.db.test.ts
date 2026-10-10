/**
 * Gemini eval suite. Costs real money, so it only runs on request:
 *   pnpm evals                  (RUN_LLM_EVALS=1; needs GEMINI_API_KEY in .env)
 *   EVAL_DRY_RUN=1 pnpm evals   (no keys needed: the mock model plays both roles; checks the harness)
 * Budget: EVAL_BUDGET_USD (default 8) across all models AND the judge; it aborts when reached.
 * Writes docs/EVALS.md. Defaults are never changed automatically.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LLM_ROUTING, PROVIDER_NAMES, type LlmTaskName } from '@instantlead/config';
import {
  costUsd,
  MODELS,
  providerForModel,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createTestContext, PASSWORD } from '../../../test/context.ts';
import { getActiveConfig, saveConfig } from '../../config-store.ts';
import { withTenant } from '../../db/client.ts';
import { leads, llmRuns, messages } from '../../db/schema.ts';
import { createFakeLlm } from '../fake-llm.ts';
import { jsonSchema } from '../prompt.ts';
import { BASELINE, CASES, RE_BASELINE, RE_CASES, type EvalCase, type Outcome } from './cases.ts';

/** Each business type has its own conversations and baseline checks. */
const SUITES = [
  { preset: 'clinic_dental' as const, name: 'Smile Dental', cases: CASES, baseline: BASELINE },
  { preset: 'real_estate' as const, name: 'Skyline Realty', cases: RE_CASES, baseline: RE_BASELINE },
];
type Suite = (typeof SUITES)[number];

const enabled = process.env.RUN_LLM_EVALS === '1';
const dryRun = process.env.EVAL_DRY_RUN === '1';
const BUDGET = Number(process.env.EVAL_BUDGET_USD ?? 8);
const keys = { gemini: process.env.GEMINI_API_KEY };
/** Under test: the default and the complex-turn agent models (each runs every task in its run). */
const UNDER_TEST = dryRun
  ? ['fake']
  : [...new Set([DEFAULT_LLM_ROUTING.agent_reply[0]!, DEFAULT_LLM_ROUTING.agent_reply_complex[0]!])];
/** One fixed judge for every run (comparable scores): a stronger Gemini than the models under test. */
const JUDGE_PREFERENCE = ['gemini-3.8-flash'];

// ---------------------------------------------------------------- budget

class BudgetExceeded extends Error {}
const spend = { usd: 0 };
/** Estimate before (input chars/3 tokens + max output), refuse beyond the cap, add the real cost after. */
function metered(llm: LlmProvider): LlmProvider {
  return {
    provider: llm.provider,
    model: llm.model,
    async complete(req: LlmRequest, hints?: unknown) {
      const p = MODELS[llm.model]?.price ?? { input: 0, output: 0 };
      const inputTokens = JSON.stringify(req).length / 3;
      const estimate = (inputTokens * p.input + req.maxTokens * p.output) / 1e6;
      if (spend.usd + estimate > BUDGET)
        throw new BudgetExceeded(`eval budget $${BUDGET} reached ($${spend.usd.toFixed(2)} spent)`);
      const res = await llm.complete(req, hints);
      spend.usd += costUsd(llm.model, res.usage);
      return res;
    },
  };
}

// ---------------------------------------------------------------- judge

const Rubric = z.strictObject({
  natural: z.int().min(1).max(5),
  empathetic: z.int().min(1).max(5),
  helpful: z.int().min(1).max(5),
  on_brand: z.int().min(1).max(5),
  note: z.string().max(300),
});
type Rubric = z.infer<typeof Rubric>;

const JUDGE_SYSTEM = `You grade WhatsApp replies written by a dental clinic's assistant to real customers.
Score 1-5 (5 = excellent) on:
- natural: reads like a warm, competent receptionist, not a bot or a form; WhatsApp-short; one question at a time
- empathetic: acknowledges feelings and concerns where relevant
- helpful: answers what was asked and moves toward the right next step (often booking) without pushing
- on_brand: polite, accurate, no invented facts, no medical advice, replies in the customer's language
Be strict and consistent. A perfect 5 is rare. Give a one-sentence note on the main weakness.`;

async function judge(llm: LlmProvider, c: EvalCase, o: Outcome): Promise<Rubric | null> {
  if (!o.replies.length) return null; // silence is graded by the hard checks
  const transcript = c.messages
    .map(
      (m, i) =>
        `Customer: ${typeof m === 'string' ? m : `[${m.media}] ${m.caption ?? ''}`}\nAssistant: ${o.replies[i] ?? '(no reply)'}`,
    )
    .join('\n');
  const res = await llm.complete({
    task: 'report_text',
    system: JUDGE_SYSTEM,
    turns: [{ role: 'user', text: transcript }],
    maxTokens: 300,
    output: { name: 'rubric', schema: jsonSchema(Rubric) },
  });
  const parsed = Rubric.safeParse(JSON.parse(res.text || '{}'));
  return parsed.success ? parsed.data : null;
}
/** Dry run: the mock model can't judge; a fixed middling score keeps the report shape honest. */
const dryJudge: LlmProvider = {
  provider: 'fake',
  model: 'fake-judge',
  complete: (): Promise<LlmResponse> =>
    Promise.resolve({
      text: JSON.stringify({
        natural: 3,
        empathetic: 3,
        helpful: 3,
        on_brand: 3,
        note: 'dry run (mock judge)',
      }),
      toolCalls: [],
      stop: 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      raw: { provider: 'fake', model: 'fake-judge', data: null },
    }),
};

// ---------------------------------------------------------------- run one model

interface CaseResult {
  id: string;
  topic: string;
  failures: string[];
  rubric: Rubric | null;
  turnMs: number[];
  costUsd: number;
  replies: string[];
}

async function runModel(model: string, judgeLlm: LlmProvider, suite: Suite): Promise<CaseResult[]> {
  const real = model === 'fake' ? createFakeLlm() : providerForModel(model, keys);
  if (!real) throw new Error(`no key for ${model}`);
  const llm = metered(real);
  const t = await createTestContext(model === 'fake' ? { llm } : { llmProviders: [llm] });
  try {
    const A = (
      await t.ctx.system.createTenant(
        {
          slug: 'eval',
          name: suite.name,
          preset: suite.preset,
          admin: { email: 'e@eval.test', name: 'E', password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
    // Every task on the model under test, its provider allowed, generous budget caps.
    await withTenant(t.ctx.db, A, async (tx) => {
      const config = (await getActiveConfig(tx))!.config;
      const tasks = Object.keys(DEFAULT_LLM_ROUTING) as LlmTaskName[];
      await saveConfig(
        tx,
        t.clock,
        { type: 'system' },
        {
          ...config,
          // The router only sends text to providers the consent notice names.
          intake: {
            ...config.intake,
            consent_notice_text: `${config.intake.consent_notice_text} (${model === 'fake' ? '' : PROVIDER_NAMES[MODELS[model]!.provider as 'gemini']})`,
          },
          ai: {
            allowed_providers: ['gemini'],
            monthly_cost_cap_usd: 1000,
            routing: Object.fromEntries(tasks.map((k) => [k, [model]])),
          },
        },
      );
    });
    const cookie = await t.signIn('e@eval.test');
    const results: CaseResult[] = [];
    let phone = 9100000000;
    for (const c of suite.cases) {
      const from = String(phone++);
      const turnMs: number[] = [];
      for (const m of c.messages) {
        const payload =
          typeof m === 'string'
            ? { text: m }
            : { media_type: m.media, ...(m.caption ? { text: m.caption } : {}) };
        await t.app.inject({
          method: 'POST',
          url: '/v1/dev/whatsapp/inbound',
          headers: { cookie },
          payload: { from, ...payload },
        });
        const started = performance.now();
        await t.drainAssistant();
        turnMs.push(performance.now() - started);
        await t.drainJobs();
      }
      const outcome = await withTenant(t.ctx.db, A, async (tx) => {
        const [lead] = await tx
          .select()
          .from(leads)
          .where(eq(leads.phoneE164, `+91${from}`));
        const msgs = await tx
          .select()
          .from(messages)
          .where(eq(messages.leadId, lead!.id))
          .orderBy(asc(messages.occurredAt), asc(messages.createdAt));
        const runs = await tx.select().from(llmRuns).where(eq(llmRuns.leadId, lead!.id));
        return {
          o: {
            replies: msgs.filter((x) => x.direction === 'out').map((x) => x.body),
            lead: {
              state: lead!.state,
              aiPaused: lead!.aiPaused,
              notALead: lead!.notALead,
              language: lead!.language,
            },
            guardViolations: runs.flatMap((r) => r.guardViolations ?? []),
          } satisfies Outcome,
          cost: runs.reduce((s, r) => s + Number(r.costUsd), 0),
        };
      });
      const failures = [...suite.baseline, ...c.checks]
        .map((check) => check(outcome.o))
        .filter((f): f is string => f !== null);
      if (outcome.o.guardViolations.length)
        failures.push(`first draft needed the output guard: ${outcome.o.guardViolations.join('; ')}`);
      results.push({
        id: c.id,
        topic: c.topic,
        failures,
        rubric: await judge(judgeLlm, c, outcome.o).catch(() => null),
        turnMs,
        costUsd: outcome.cost,
        replies: outcome.o.replies,
      });
    }
    return results;
  } finally {
    await t.close();
  }
}

// ---------------------------------------------------------------- report

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : 0;
};
interface Summary {
  model: string;
  passRate: number;
  rubric: number | null;
  p50: number;
  p95: number;
  costPerConversation: number;
  results: CaseResult[];
}
function summarize(model: string, results: CaseResult[]): Summary {
  const scored = results.flatMap((r) =>
    r.rubric ? [(r.rubric.natural + r.rubric.empathetic + r.rubric.helpful + r.rubric.on_brand) / 4] : [],
  );
  const turns = results.flatMap((r) => r.turnMs);
  return {
    model,
    passRate: results.filter((r) => !r.failures.length).length / results.length,
    rubric: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
    p50: pct(turns, 50) / 1000,
    p95: pct(turns, 95) / 1000,
    costPerConversation: results.reduce((s, r) => s + r.costUsd, 0) / results.length,
    results,
  };
}

function report(summaries: Summary[], judgeModel: string, aborted: string | null) {
  const ranked = [...summaries].sort(
    (a, b) =>
      b.passRate - a.passRate ||
      (b.rubric ?? 0) - (a.rubric ?? 0) ||
      a.costPerConversation - b.costPerConversation,
  );
  const judgeProvider = MODELS[judgeModel]?.provider;
  const lines = [
    '# Assistant evals',
    '',
    `<!-- Generated by pnpm evals on ${new Date().toISOString().slice(0, 10)}. -->`,
    '',
    `${CASES.length} dental + ${RE_CASES.length} real-estate scripted customer conversations per model (apps/api/src/assistant/evals/cases.ts), run through the real pipeline (guardrails, tools, booking) on a throwaway database.`,
    `Hard checks are deterministic; the rubric (natural, empathetic, helpful, on-brand; 1-5) is scored by one fixed judge: **${judgeModel}**.`,
    ...(summaries.some((s) => MODELS[s.model]?.provider === judgeProvider && judgeProvider !== 'fake')
      ? [
          `Note: the judge shares a provider with ${summaries
            .filter((s) => MODELS[s.model]?.provider === judgeProvider)
            .map((s) => s.model)
            .join(', ')}; models may favour their own provider's style, so read that rubric score with care.`,
        ]
      : []),
    ...(dryRun
      ? [
          '',
          '> **Dry run on the rule-based mock model.** This only proves the harness works; it says nothing about real-model quality. Add provider keys to .env and run `pnpm evals` for real results.',
          '',
        ]
      : []),
    `Total spend: $${spend.usd.toFixed(2)} of the $${BUDGET} cap.${aborted ? ` **Aborted early: ${aborted}.**` : ''}`,
    '',
    '| Model | Hard checks passed | Rubric (1-5) | Turn latency p50 / p95 | Cost per conversation |',
    '|---|---|---|---|---|',
    ...ranked.map(
      (s) =>
        `| ${s.model} | ${(s.passRate * 100).toFixed(0)}% | ${s.rubric?.toFixed(2) ?? '—'} | ${s.p50.toFixed(1)} s / ${s.p95.toFixed(1)} s | $${s.costPerConversation.toFixed(4)} |`,
    ),
    '',
    '## Recommendation',
    '',
    ranked.length
      ? `Default agent model: **${ranked[0]!.model}**; fallback order: ${
          ranked
            .slice(1)
            .map((s) => s.model)
            .join(' → ') || '—'
        }. (Ranked by hard-check pass rate, then rubric, then cost. Not applied automatically: change \`DEFAULT_LLM_ROUTING\` in packages/config/src/llm.ts, or a tenant's \`ai.routing\`, after review.)`
      : 'Nothing ran.',
    '',
    '## Failures by model',
    '',
    ...ranked.flatMap((s) => [
      `### ${s.model}`,
      '',
      ...(s.results.some((r) => r.failures.length)
        ? s.results
            .filter((r) => r.failures.length)
            .map(
              (r) =>
                `- **${r.id}** (${r.topic}): ${r.failures.join('; ')}  \n  last reply: "${(r.replies.at(-1) ?? '(none)').replace(/\n/g, ' ').slice(0, 200)}"`,
            )
        : ['All hard checks passed.']),
      '',
    ]),
  ];
  writeFileSync(fileURLToPath(new URL('../../../../../docs/EVALS.md', import.meta.url)), lines.join('\n'));
}

// ---------------------------------------------------------------- the run

describe.skipIf(!enabled)('assistant evals across providers', () => {
  test(
    'run the suite on every keyed provider, judge, and write docs/EVALS.md',
    async () => {
      const models = UNDER_TEST.filter((m) => m === 'fake' || providerForModel(m, keys));
      expect(models.length, 'no provider keys in .env (or use EVAL_DRY_RUN=1)').toBeGreaterThan(0);
      const judgeModel = dryRun ? 'fake-judge' : JUDGE_PREFERENCE.find((m) => providerForModel(m, keys))!;
      const judgeLlm = dryRun ? dryJudge : metered(providerForModel(judgeModel, keys)!);
      const summaries: Summary[] = [];
      let aborted: string | null = null;
      for (const model of models) {
        try {
          for (const suite of SUITES)
            summaries.push(summarize(`${model} · ${suite.preset}`, await runModel(model, judgeLlm, suite)));
        } catch (err) {
          if (!(err instanceof BudgetExceeded)) throw err;
          aborted = err.message;
          break;
        }
      }
      report(summaries, judgeModel, aborted);
      console.log(
        `evals: ${summaries.map((s) => `${s.model} ${(s.passRate * 100).toFixed(0)}%`).join(', ')}; spent $${spend.usd.toFixed(2)}`,
      );
      expect(spend.usd).toBeLessThanOrEqual(BUDGET);
    },
    60 * 60_000,
  );
});
