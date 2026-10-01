import type { Tier } from './lead-state.ts';

/** The slice of tenant config scoring needs (kept structural so core stays dependency-free). */
export interface ScoringConfig {
  questions: readonly {
    key: string;
    required: boolean;
    weight: number;
    /** 0..1 per option; options not listed count as 1 (any answer is a full answer). */
    option_scores?: Readonly<Record<string, number>> | undefined;
  }[];
  scoring: {
    hot: number;
    warm: number;
    disqualifiers: readonly { question: string; any_of: readonly string[] }[];
  };
}

export type ScoreResult =
  | { status: 'incomplete'; missing: string[]; score: number }
  | { status: 'disqualified'; question: string; answer: string }
  | { status: 'qualified'; score: number; tier: Tier };

/**
 * Deterministic lead score: the LLM only extracts answers, this decides.
 * score = Σ weight × option score; tier from the configured thresholds.
 * Not qualified until every required question is answered.
 */
export function scoreLead(config: ScoringConfig, answers: Readonly<Record<string, string>>): ScoreResult {
  for (const d of config.scoring.disqualifiers) {
    const answer = answers[d.question];
    if (answer !== undefined && d.any_of.includes(answer))
      return { status: 'disqualified', question: d.question, answer };
  }

  let score = 0;
  const missing: string[] = [];
  for (const q of config.questions) {
    const answer = answers[q.key];
    if (answer === undefined || answer.trim() === '') {
      if (q.required) missing.push(q.key);
      continue;
    }
    score += q.weight * (q.option_scores?.[answer] ?? 1);
  }
  score = Math.round(score * 100) / 100;

  if (missing.length) return { status: 'incomplete', missing, score };
  const tier: Tier = score >= config.scoring.hot ? 'hot' : score >= config.scoring.warm ? 'warm' : 'cold';
  return { status: 'qualified', score, tier };
}
