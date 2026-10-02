import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from './models.ts';
import {
  errorKind,
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type Turn,
} from './types.ts';

/** Turns -> Messages API params. Same-provider assistant turns replay their raw content (thinking blocks included). */
export function toAnthropicMessages(turns: Turn[], model: string): Anthropic.MessageParam[] {
  return turns.map((t): Anthropic.MessageParam => {
    switch (t.role) {
      case 'user':
        return { role: 'user', content: t.text };
      case 'system':
        return { role: 'system', content: t.text };
      case 'tool_results':
        return {
          role: 'user',
          content: t.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
            is_error: r.isError ?? false,
          })),
        };
      case 'assistant': {
        if (t.raw?.provider === 'anthropic' && t.raw.model === model)
          return { role: 'assistant', content: t.raw.data as Anthropic.ContentBlockParam[] };
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (t.text) blocks.push({ type: 'text', text: t.text });
        for (const c of t.toolCalls)
          blocks.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.input as Record<string, unknown>,
          });
        return { role: 'assistant', content: blocks.length ? blocks : t.text };
      }
    }
  });
}

export function fromAnthropicMessage(m: Anthropic.Message, model: string): LlmResponse {
  const text = m.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  const toolCalls = m.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const stop =
    m.stop_reason === 'refusal'
      ? 'refusal'
      : m.stop_reason === 'max_tokens'
        ? 'max_tokens'
        : toolCalls.length
          ? 'tool_use'
          : 'end';
  return {
    text,
    toolCalls,
    stop,
    refusalCategory: m.stop_details?.category ?? undefined,
    usage: {
      inputTokens: m.usage.input_tokens,
      outputTokens: m.usage.output_tokens,
      cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
    },
    raw: { provider: 'anthropic', model, data: m.content },
    requestId: m.id,
  };
}

export function createAnthropicProvider(opts: {
  apiKey: string;
  model: string;
  client?: Pick<Anthropic, 'messages'>;
}): LlmProvider {
  // SDK retries 408/409/429/5xx and connection errors twice before we see an error.
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 45_000 });
  const spec = MODELS[opts.model];
  return {
    provider: 'anthropic',
    model: opts.model,
    async complete(req: LlmRequest) {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: opts.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(req.turns, opts.model),
      };
      if (req.tools?.length) {
        params.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }));
        if (spec?.anthropic?.thinkingBetweenTools) params.thinking = { type: 'between_tools' };
      }
      const outputConfig: Anthropic.OutputConfig = {};
      if (req.effort && spec?.anthropic?.effort) outputConfig.effort = req.effort;
      if (req.output) outputConfig.format = { type: 'json_schema', schema: req.output.schema };
      if (Object.keys(outputConfig).length) params.output_config = outputConfig;
      try {
        return fromAnthropicMessage(await client.messages.create(params), opts.model);
      } catch (err) {
        if (err instanceof Anthropic.APIError)
          throw new LlmError(errorKind(err.status, err.message), err.message, err.status);
        throw new LlmError('server', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
