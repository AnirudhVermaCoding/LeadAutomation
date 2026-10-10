import type { ProviderName, Usage } from './types.ts';

export interface ModelSpec {
  id: string;
  provider: ProviderName;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  /** Explicit prompt-cache control. Gemini's compatible endpoint has none. */
  supportsCaching: boolean;
  contextWindow: number;
  /** USD per million tokens. */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Model registry: Gemini only (decision 141). VERIFY against current pricing/docs before changing defaults.
 * Gemini Flash-Lite ids, status and prices checked 2026-10-04 on ai.google.dev/gemini-api/docs/models
 * + /pricing. Prices are standard tier, prompts under 200k tokens.
 */
export const MODELS: Record<string, ModelSpec> = {
  // Gemini 3.8 Flash price: introductory rate through 2026-12-31 (doubles on 2027-01-01).
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    provider: 'gemini',
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    price: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  },
  // Default conversational model (agent_reply). Flash-Lite prices are standard (no introductory rate).
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    price: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  },
  // Genuinely complex turns (agent_reply_complex).
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    price: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  },
  // Router / judge and small structured tasks. Google limits 2.5 access to projects that used it
  // before: a 404 fails over to 3.1 Flash-Lite (errorKind 'unavailable').
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    price: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  },
  fake: {
    id: 'fake',
    provider: 'fake',
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
};

/** Uncached input + cache reads/writes + output, in USD. Unknown models cost 0 (and are refused by the router). */
export function costUsd(model: string, u: Usage): number {
  const p = MODELS[model]?.price;
  if (!p) return 0;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite) /
    1e6
  );
}
