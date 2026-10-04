import OpenAI from 'openai';
import {
  errorKind,
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ProviderName,
  type Turn,
} from './types.ts';

/**
 * OpenAI Chat Completions, also spoken by Gemini (`/v1beta/openai/`, beta) and xAI (`/v1`).
 * Base URLs checked against each provider's docs on 2026-10-02.
 */
export const OPENAI_COMPAT_BASE_URLS: Record<'openai' | 'gemini' | 'xai', string | undefined> = {
  openai: undefined, // SDK default
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  xai: 'https://api.x.ai/v1',
};

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toChatMessages(system: string, turns: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    switch (t.role) {
      case 'user':
        out.push({ role: 'user', content: t.text });
        break;
      case 'system':
        out.push({ role: 'system', content: t.text });
        break;
      case 'assistant':
        out.push({
          role: 'assistant',
          content: t.text || null,
          ...(t.toolCalls.length
            ? {
                tool_calls: t.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
                })),
              }
            : {}),
        });
        break;
      case 'tool_results':
        for (const r of t.results)
          out.push({
            role: 'tool',
            tool_call_id: r.id,
            content: r.isError ? `ERROR: ${r.content}` : r.content,
          });
        break;
    }
  }
  return out;
}

export function fromChatCompletion(
  c: OpenAI.Chat.Completions.ChatCompletion,
  provider: ProviderName,
  model: string,
): LlmResponse {
  const choice = c.choices[0];
  if (!choice) throw new LlmError('invalid_output', 'no choices in response');
  const msg = choice.message;
  const toolCalls = (msg.tool_calls ?? []).flatMap((tc) => {
    if (tc.type !== 'function') return [];
    let input: unknown;
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      throw new LlmError('invalid_output', `tool ${tc.function.name}: arguments are not JSON`);
    }
    return [{ id: tc.id, name: tc.function.name, input }];
  });
  const refused = Boolean(msg.refusal) || choice.finish_reason === 'content_filter';
  const cached = c.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: (msg.content ?? '').trim(),
    toolCalls,
    stop: refused
      ? 'refusal'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : toolCalls.length
          ? 'tool_use'
          : 'end',
    refusalCategory: refused ? (msg.refusal ?? 'content_filter') : undefined,
    usage: {
      inputTokens: Math.max(0, (c.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: c.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    raw: { provider, model, data: msg },
    requestId: c.id,
  };
}

export function createOpenAICompatProvider(opts: {
  provider: 'openai' | 'gemini' | 'xai';
  apiKey: string;
  model: string;
  client?: Pick<OpenAI, 'chat'>;
}): LlmProvider {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: OPENAI_COMPAT_BASE_URLS[opts.provider],
      maxRetries: 2,
      timeout: 45_000,
    });
  return {
    provider: opts.provider,
    model: opts.model,
    async complete(req: LlmRequest) {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: opts.model,
        messages: toChatMessages(req.system, req.turns),
        // OpenAI deprecated max_tokens; the compatibility endpoints document max_tokens.
        ...(opts.provider === 'openai'
          ? { max_completion_tokens: req.maxTokens }
          : { max_tokens: req.maxTokens }),
      };
      if (req.tools?.length) {
        params.tools = req.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
        params.parallel_tool_calls = true;
      }
      if (req.output)
        params.response_format = {
          type: 'json_schema',
          json_schema: { name: req.output.name, schema: req.output.schema, strict: true },
        };
      try {
        return fromChatCompletion(
          await client.chat.completions.create(
            params,
            req.timeoutMs ? { timeout: req.timeoutMs, maxRetries: 0 } : undefined,
          ),
          opts.provider,
          opts.model,
        );
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (err instanceof OpenAI.APIError)
          throw new LlmError(errorKind(err.status, err.message), err.message, err.status);
        throw new LlmError('server', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
