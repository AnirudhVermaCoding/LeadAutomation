import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, test } from 'vitest';
import { createAnthropicProvider, fromAnthropicMessage, toAnthropicMessages } from './anthropic.ts';
import { costUsd, MODELS } from './models.ts';
import { createOpenAICompatProvider, fromChatCompletion, toChatMessages } from './openai-compat.ts';
import { LlmError, type LlmRequest, type Turn } from './types.ts';

// Recorded-shape fixtures: the same assistant turn as each wire format returns it.
const anthropicMsg = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: 'ok', signature: 'sig' },
    { type: 'text', text: 'Let me check.', citations: null },
    { type: 'tool_use', id: 'call_a', name: 'lookup_knowledge', input: { query: 'price' } },
    { type: 'tool_use', id: 'call_b', name: 'get_available_slots', input: { service: 'Consultation' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  },
} as unknown as Anthropic.Message;

const chatCompletion = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-6.1-sol',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      logprobs: null,
      message: {
        role: 'assistant',
        content: 'Let me check.',
        refusal: null,
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'lookup_knowledge', arguments: '{"query":"price"}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'get_available_slots', arguments: '{"service":"Consultation"}' },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 20,
    total_tokens: 1020,
    prompt_tokens_details: { cached_tokens: 900 },
  },
} as unknown as OpenAI.Chat.Completions.ChatCompletion;

describe('normalization', () => {
  test('parallel tool calls normalize identically from both wire formats', () => {
    const a = fromAnthropicMessage(anthropicMsg, 'claude-sonnet-5-5');
    const o = fromChatCompletion(chatCompletion, 'openai', 'gpt-6.1-sol');
    for (const r of [a, o]) {
      expect(r).toMatchObject({
        text: 'Let me check.',
        stop: 'tool_use',
        toolCalls: [
          { id: 'call_a', name: 'lookup_knowledge', input: { query: 'price' } },
          { id: 'call_b', name: 'get_available_slots', input: { service: 'Consultation' } },
        ],
      });
      // Uncached input counted once, cache reads separately (OpenAI includes them in prompt_tokens).
      expect(r.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      });
    }
  });

  test('malformed tool arguments are invalid output (failover), not a crash', () => {
    const bad = structuredClone(chatCompletion);
    bad.choices[0]!.message.tool_calls![0]!.type = 'function';
    (bad.choices[0]!.message.tool_calls![0] as { function: { arguments: string } }).function.arguments =
      '{oops';
    expect(() => fromChatCompletion(bad, 'openai', 'gpt-6.1-sol')).toThrow(
      expect.objectContaining({ kind: 'invalid_output' }),
    );
  });

  test('turns -> each wire format; raw replays only to the same provider and model', () => {
    const raw = fromAnthropicMessage(anthropicMsg, 'claude-sonnet-5-5').raw;
    const turns: Turn[] = [
      { role: 'user', text: 'hi' },
      {
        role: 'assistant',
        text: 'Let me check.',
        toolCalls: [{ id: 'call_a', name: 'lookup_knowledge', input: { query: 'price' } }],
        raw,
      },
      { role: 'tool_results', results: [{ id: 'call_a', content: 'Prices: …', isError: false }] },
      { role: 'system', text: 'CRM state' },
    ];
    const same = toAnthropicMessages(turns, 'claude-sonnet-5-5');
    expect(same[1]?.content).toEqual(anthropicMsg.content); // thinking blocks preserved
    const other = toAnthropicMessages(turns, 'claude-haiku-4-5-20251001');
    expect(other[1]?.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_a', name: 'lookup_knowledge', input: { query: 'price' } },
    ]);
    expect(same[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_a' }],
    });
    expect(same[3]).toEqual({ role: 'system', content: 'CRM state' });

    expect(toChatMessages('SYS', turns)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'lookup_knowledge', arguments: '{"query":"price"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'Prices: …' },
      { role: 'system', content: 'CRM state' },
    ]);
  });

  test('cost uses registry prices and every default model is registered', () => {
    expect(
      costUsd('claude-sonnet-5-5', {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(12);
    expect(
      costUsd('unknown', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(0);
    for (const m of Object.values(MODELS)) expect(m.price.input).toBeGreaterThanOrEqual(0);
  });
});

const request: LlmRequest = {
  task: 'agent_reply',
  system: 'SYS',
  turns: [{ role: 'user', text: 'hi' }],
  tools: [{ name: 'cancel', description: 'Cancel', inputSchema: { type: 'object', properties: {} } }],
  maxTokens: 300,
  effort: 'low',
};

describe('adapters (stub clients, no network)', () => {
  test('Anthropic: cached system, thinking only for capable models with tools, structured output via output_config', async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client = {
      messages: {
        create: (p: Anthropic.MessageCreateParamsNonStreaming) => {
          calls.push(p);
          return Promise.resolve(anthropicMsg);
        },
      },
    } as unknown as Pick<Anthropic, 'messages'>;
    await createAnthropicProvider({ apiKey: 'x', model: 'claude-sonnet-5-5', client }).complete(request);
    expect(calls[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 300,
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
    });
    await createAnthropicProvider({ apiKey: 'x', model: 'claude-haiku-4-5-20251001', client }).complete({
      ...request,
      tools: undefined,
      output: { name: 'intent', schema: { type: 'object' } },
    });
    expect(calls[1]?.thinking).toBeUndefined();
    expect(calls[1]?.output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } });
  });

  test('OpenAI-compatible: tools, parallel calls, strict json_schema; max token parameter per provider', async () => {
    const calls: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
    const client = {
      chat: {
        completions: {
          create: (p: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => {
            calls.push(p);
            return Promise.resolve(chatCompletion);
          },
        },
      },
    } as unknown as Pick<OpenAI, 'chat'>;
    await createOpenAICompatProvider({
      provider: 'openai',
      apiKey: 'x',
      model: 'gpt-6.1-sol',
      client,
    }).complete(request);
    expect(calls[0]).toMatchObject({ max_completion_tokens: 300, parallel_tool_calls: true });
    await createOpenAICompatProvider({
      provider: 'gemini',
      apiKey: 'x',
      model: 'gemini-3.8-flash',
      client,
    }).complete({
      ...request,
      tools: undefined,
      output: { name: 'intent', schema: { type: 'object' } },
    });
    expect(calls[1]).toMatchObject({
      max_tokens: 300,
      response_format: { type: 'json_schema', json_schema: { name: 'intent', strict: true } },
    });
  });

  test('provider errors map to normalized kinds (retryable vs not)', async () => {
    const failing = (err: Error) =>
      ({ messages: { create: () => Promise.reject(err) } }) as unknown as Pick<Anthropic, 'messages'>;
    const overloaded = new Anthropic.InternalServerError(529, {}, 'Overloaded', new Headers());
    await expect(
      createAnthropicProvider({
        apiKey: 'x',
        model: 'claude-sonnet-5-5',
        client: failing(overloaded),
      }).complete(request),
    ).rejects.toMatchObject({ kind: 'server', retryable: true, failover: true });
    const bad = new Anthropic.BadRequestError(400, {}, 'bad', new Headers());
    await expect(
      createAnthropicProvider({ apiKey: 'x', model: 'claude-sonnet-5-5', client: failing(bad) }).complete(
        request,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false, failover: false });

    const limited = new OpenAI.RateLimitError(429, {}, 'slow down', new Headers());
    const oai = { chat: { completions: { create: () => Promise.reject(limited) } } } as unknown as Pick<
      OpenAI,
      'chat'
    >;
    await expect(
      createOpenAICompatProvider({ provider: 'xai', apiKey: 'x', model: 'grok-4.7', client: oai }).complete(
        request,
      ),
    ).rejects.toBeInstanceOf(LlmError);

    // 404 (no access to a model, e.g. Gemini 2.5 on a new project): fail over, don't retry.
    const missing = new OpenAI.NotFoundError(404, {}, 'model not found', new Headers());
    const gone = { chat: { completions: { create: () => Promise.reject(missing) } } } as unknown as Pick<
      OpenAI,
      'chat'
    >;
    await expect(
      createOpenAICompatProvider({
        provider: 'gemini',
        apiKey: 'x',
        model: 'gemini-2.5-flash-lite',
        client: gone,
      }).complete(request),
    ).rejects.toMatchObject({ kind: 'unavailable', retryable: false, failover: true });
  });

  test('a critical-path call (timeoutMs) gets that timeout and no SDK retries', async () => {
    const options: unknown[] = [];
    const client = {
      chat: {
        completions: {
          create: (_p: unknown, o: unknown) => {
            options.push(o);
            return Promise.resolve(chatCompletion);
          },
        },
      },
    } as unknown as Pick<OpenAI, 'chat'>;
    const p = createOpenAICompatProvider({
      provider: 'gemini',
      apiKey: 'x',
      model: 'gemini-2.5-flash-lite',
      client,
    });
    await p.complete({ ...request, timeoutMs: 5_000 });
    await p.complete(request);
    expect(options).toEqual([{ timeout: 5_000, maxRetries: 0 }, undefined]);
  });
});
