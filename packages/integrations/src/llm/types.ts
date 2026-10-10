/**
 * Provider-neutral LLM types. The app speaks only these; the adapter translates to and from
 * Gemini's OpenAI-compatible wire format, so provider quirks never leak past this folder.
 */

/** Gemini is the only real provider (decision 141); 'fake' is the rule-based mock-mode model. */
export type ProviderName = 'gemini' | 'fake';

/** What a call is for. Routing (primary model + fallbacks) is configured per task. */
export type LlmTask =
  | 'agent_reply'
  /** A turn the turn router judged complex: a stronger model, same tools and guards. */
  | 'agent_reply_complex'
  /** The router / judge for turns the deterministic rules can't classify. */
  | 'message_route'
  | 'intent_classify'
  | 'memory_summarize'
  | 'language_detect'
  | 'report_text';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (from zod via z.toJSONSchema). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Untrusted: validate with zod before use. */
  input: unknown;
}

/** The provider's own form of an assistant turn, replayed verbatim to the same provider. */
export interface RawTurn {
  provider: ProviderName;
  model: string;
  data: unknown;
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: RawTurn }
  | { role: 'tool_results'; results: { id: string; content: string; isError?: boolean }[] }
  /** Mid-conversation facts from our database (not from the customer); keeps the system prefix cacheable. */
  | { role: 'system'; text: string };

export interface LlmRequest {
  task: LlmTask;
  /** Stable instructions; cached where the provider supports it. */
  system: string;
  turns: Turn[];
  tools?: ToolSpec[];
  /** Ask for JSON matching this schema instead of free text. */
  output?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  /** Fail-fast budget for a call on the reply's critical path (the judge): this timeout, no SDK retries (the chain still fails over). Default 45 s with 2 retries. */
  timeoutMs?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: 'end' | 'tool_use' | 'refusal' | 'max_tokens';
  refusalCategory?: string | undefined;
  usage: Usage;
  raw: RawTurn;
  requestId?: string | undefined;
}

export type LlmErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'auth'
  /** 404: the model doesn't exist or this project has no access to it (e.g. Gemini 2.5 for new projects). */
  | 'unavailable'
  | 'bad_request'
  | 'refusal'
  | 'invalid_output';

/** Normalized failure. `retryable` = worth trying again later or on another model. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
  get retryable() {
    return this.kind === 'timeout' || this.kind === 'rate_limit' || this.kind === 'server';
  }
  /** Failover to the next model helps for outages and bad output, not for our own bad requests. */
  get failover() {
    return (
      this.retryable || this.kind === 'invalid_output' || this.kind === 'auth' || this.kind === 'unavailable'
    );
  }
}

/** HTTP status / network error -> normalized kind (shared by adapters). */
export function errorKind(status: number | undefined, message = ''): LlmErrorKind {
  if (status === undefined) return /timeout|timed out/i.test(message) ? 'timeout' : 'server';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'unavailable';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/**
 * One model. `hints` is ignored by real models; the fake provider (mock mode, tests, demo
 * sandbox) uses it instead of parsing prompts.
 */
export interface LlmProvider {
  readonly provider: ProviderName;
  readonly model: string;
  complete(request: LlmRequest, hints?: unknown): Promise<LlmResponse>;
}
