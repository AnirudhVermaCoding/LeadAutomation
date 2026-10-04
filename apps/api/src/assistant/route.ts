import type { TenantConfig } from '@instantlead/config';
import { z } from 'zod';
import { runStructured, type LlmRouter } from '../llm-router.ts';
import type { Db } from '../db/client.ts';
import type { Clock } from '@instantlead/core';
import { redact } from './guard.ts';
import { jsonSchema } from './prompt.ts';

/** Which model tier answers a turn. Safety, booking and money never depend on this: only reply quality. */
export type Complexity = 'simple' | 'complex';

export interface TurnSignals {
  /** The unanswered customer text of this turn. */
  text: string;
  upcomingAppointments: number;
  /** A reminder button that needs interpreting (e.g. "reschedule", or unclear which appointment). */
  buttonNote: boolean;
  /** Returning after 14+ days with answers older than 60 days to re-confirm. */
  staleReturning: boolean;
}

// Things a person must decide go to staff anyway (prompt + escalate tool); the stronger model handles that hand-over better.
const DELICATE =
  /\b(complain\w*|complaint|refund\w*|money back|discount|cheaper|negotiat\w*|bill(ing)?|invoice|charged|overcharg\w*|insurance|emi|instal+ments?|unhappy|disappointed|worst|rude|angry|lawyer|consumer court|shikayat|paisa wapas)\b/i;
const SIMPLE_MAX_WORDS = 12;
const COMPLEX_MIN_WORDS = 60;

/** Deterministic first: obvious turns never reach the judge. */
export function classifyTurn(s: TurnSignals): Complexity | 'ambiguous' {
  const words = s.text.split(/\s+/).filter(Boolean).length;
  const questions = (s.text.match(/\?/g) ?? []).length;
  if (
    s.upcomingAppointments >= 2 ||
    s.buttonNote ||
    s.staleReturning ||
    DELICATE.test(s.text) ||
    questions >= 2 ||
    words > COMPLEX_MIN_WORDS
  )
    return 'complex';
  if (words <= SIMPLE_MAX_WORDS) return 'simple';
  return 'ambiguous';
}

const JudgeSchema = z.strictObject({ complexity: z.enum(['simple', 'complex']) });
export const JUDGE_TIMEOUT_MS = 5_000;

/**
 * Rules first; the message_route judge (a small, cheap model) only for turns the rules can't call.
 * The judge sees only the redacted customer text, never patient records. Any judge failure means
 * "simple": it chooses a model tier, never whether to answer or what is allowed.
 */
export async function routeTurn(
  deps: { db: Db; clock: Clock; router: LlmRouter },
  config: TenantConfig,
  meta: { tenantId: string; leadId: string },
  signals: TurnSignals,
): Promise<Complexity> {
  const rule = classifyTurn(signals);
  if (rule !== 'ambiguous') return rule;
  try {
    const out = await runStructured(
      deps,
      config,
      {
        task: 'message_route',
        system: `You route WhatsApp messages sent to ${config.brand.business_name}. Answer "complex" only if a good reply needs careful reasoning: several requests at once, conditions or constraints to juggle, an unclear or emotional situation, or a misunderstanding to untangle. Plain questions, booking a time, and small talk are "simple".`,
        turns: [{ role: 'user', text: redact(signals.text).slice(0, 1500) }],
        // Thinking counts toward max_tokens on Gemini 3.x (minimal, cannot be turned off) when 3.1 stands in as judge.
        maxTokens: 256,
        timeoutMs: JUDGE_TIMEOUT_MS,
        output: { name: 'route', schema: jsonSchema(JudgeSchema) },
      },
      JudgeSchema,
      { ...meta, promptVersion: 'route-v1' },
    );
    return out.complexity;
  } catch {
    return 'simple';
  }
}
