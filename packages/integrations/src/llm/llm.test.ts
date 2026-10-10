import OpenAI from 'openai';
import { describe, expect, test } from 'vitest';
import { costUsd, MODELS } from './models.ts';
import { providerForModel } from './index.ts';
import { createOpenAICompatProvider, fromChatCompletion, toChatMessages } from './openai-compat.ts';
import { LlmError, type LlmRequest, type Turn } from './types.ts';

// Recorded-shape fixture: an assistant turn as Gemini's OpenAI-compatible endpoint returns it.
const chatCompletion = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 0,
  model: 'gemini-3.1-flash-lite',
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
  test('parallel tool calls normalize', () => {
    {
      const r = fromChatCompletion(chatCompletion, 'gemini', 'gemini-3.1-flash-lite');
      expect(r).toMatchObject({
        text: 'Let me check.',
        stop: 'tool_use',
        toolCalls: [
          { id: 'call_a', name: 'lookup_knowledge', input: { query: 'price' } },
          { id: 'call_b', name: 'get_available_slots', input: { service: 'Consultation' } },
        ],
      });
      // Uncached input counted once, cache reads separately (prompt_tokens includes them).
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
    expect(() => fromChatCompletion(bad, 'gemini', 'gemini-3.1-flash-lite')).toThrow(
      expect.objectContaining({ kind: 'invalid_output' }),
    );
  });

  test('turns -> chat messages', () => {
    const raw = fromChatCompletion(chatCompletion, 'gemini', 'gemini-3.1-flash-lite').raw;
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
      costUsd('gemini-3.1-flash-lite', {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(1.75);
    expect(
      costUsd('unknown', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(0);
    for (const m of Object.values(MODELS)) expect(m.price.input).toBeGreaterThanOrEqual(0);
  });

  test('Gemini only: every registered model is Gemini (or the free fake), and nothing else can be built', () => {
    expect(new Set(Object.values(MODELS).map((m) => m.provider))).toEqual(new Set(['gemini', 'fake']));
    for (const id of ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'gpt-6.1-sol', 'grok-4.7'])
      expect(providerForModel(id, { gemini: 'k', anthropic: 'k', openai: 'k' } as never)).toBeNull();
    expect(providerForModel('gemini-3.1-flash-lite', { gemini: 'k' })?.provider).toBe('gemini');
    expect(providerForModel('gemini-3.1-flash-lite', {})).toBeNull(); // no key: disabled, no other provider
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
  test('Gemini: tools, parallel calls, strict json_schema, max_tokens', async () => {
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
      provider: 'gemini',
      apiKey: 'x',
      model: 'gemini-3.1-flash-lite',
      client,
    }).complete(request);
    expect(calls[0]).toMatchObject({ max_tokens: 300, parallel_tool_calls: true });
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
    const limited = new OpenAI.RateLimitError(429, {}, 'slow down', new Headers());
    const oai = { chat: { completions: { create: () => Promise.reject(limited) } } } as unknown as Pick<
      OpenAI,
      'chat'
    >;
    await expect(
      createOpenAICompatProvider({
        provider: 'gemini',
        apiKey: 'x',
        model: 'gemini-3.1-flash-lite',
        client: oai,
      }).complete(request),
    ).rejects.toBeInstanceOf(LlmError);
    const overloaded = new OpenAI.InternalServerError(503, {}, 'Overloaded', new Headers());
    const busy = { chat: { completions: { create: () => Promise.reject(overloaded) } } } as unknown as Pick<
      OpenAI,
      'chat'
    >;
    await expect(
      createOpenAICompatProvider({
        provider: 'gemini',
        apiKey: 'x',
        model: 'gemini-3.1-flash-lite',
        client: busy,
      }).complete(request),
    ).rejects.toMatchObject({ kind: 'server', retryable: true, failover: true });
    const bad = new OpenAI.BadRequestError(400, {}, 'bad', new Headers());
    const refused = { chat: { completions: { create: () => Promise.reject(bad) } } } as unknown as Pick<
      OpenAI,
      'chat'
    >;
    await expect(
      createOpenAICompatProvider({
        provider: 'gemini',
        apiKey: 'x',
        model: 'gemini-3.1-flash-lite',
        client: refused,
      }).complete(request),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false, failover: false });

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
