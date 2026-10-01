import Anthropic from '@anthropic-ai/sdk';

/** The qualification agent. Model id per the Claude API docs (no date suffix). */
export const AGENT_MODEL = 'claude-sonnet-5-5';

// USD per million tokens, Claude API list prices (refresh from the pricing page when they change).
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

export type LlmRequest = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>;

/**
 * One model call. `hints` is ignored by real models; the fake provider (mock mode, tests,
 * demo sandbox) uses it instead of parsing prompts.
 */
export interface LlmProvider {
  readonly name: 'anthropic' | 'fake';
  readonly model: string;
  complete(request: LlmRequest, hints?: unknown): Promise<Anthropic.Message>;
}

export function createAnthropicProvider(opts: { apiKey: string; model?: string }): LlmProvider {
  // SDK retries 408/409/429/5xx and connection errors twice; job retries cover the rest.
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 45_000 });
  const model = opts.model ?? AGENT_MODEL;
  return {
    name: 'anthropic',
    model,
    complete: (request) => client.messages.create({ ...request, model }),
  };
}

export function llmCostUsd(model: string, usage: Anthropic.Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const cost =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead;
  return cost / 1e6;
}

export { Anthropic };
