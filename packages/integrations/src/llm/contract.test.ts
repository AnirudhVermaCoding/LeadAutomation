/**
 * Live contract tests: the same checks against every real provider that has a key.
 * They cost a few cents, so they only run on request:
 *   RUN_LLM_EVALS=1 node --env-file=.env node_modules/vitest/vitest.mjs run packages/integrations/src/llm/contract.test.ts
 * CI covers the adapters with stub clients (llm.test.ts).
 */
import { describe, expect, test } from 'vitest';
import { providerForModel } from './index.ts';
import type { LlmRequest } from './types.ts';

const keys = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  xai: process.env.XAI_API_KEY,
};
// One representative model per provider (the cheap one where there is one).
const MODELS_UNDER_TEST = ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'gemini-3.1-flash-lite', 'grok-4.7'];
const enabled = process.env.RUN_LLM_EVALS === '1';

const weather = {
  name: 'get_slots',
  description: 'Free appointment times for a service on a date.',
  inputSchema: {
    type: 'object',
    properties: { service: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } },
    required: ['service', 'date'],
    additionalProperties: false,
  },
};

for (const model of MODELS_UNDER_TEST) {
  const llm = enabled ? providerForModel(model, keys) : null;
  describe.skipIf(!llm)(`contract: ${model}`, () => {
    const base: Omit<LlmRequest, 'turns'> = {
      task: 'agent_reply',
      system: 'You are a clinic receptionist. Keep replies under 20 words.',
      maxTokens: 400,
    };

    test('plain text reply with usage', async () => {
      const r = await llm!.complete({ ...base, turns: [{ role: 'user', text: 'Say hello.' }] });
      expect(r.stop).toBe('end');
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.usage.inputTokens + r.usage.cacheReadTokens).toBeGreaterThan(0);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
    }, 60_000);

    test('tool call, then a tool-result round trip', async () => {
      const ask = {
        ...base,
        tools: [weather],
        turns: [{ role: 'user' as const, text: 'Any free Consultation slots on 2026-11-02? Use the tool.' }],
      };
      const first = await llm!.complete(ask);
      expect(first.stop).toBe('tool_use');
      const call = first.toolCalls[0]!;
      expect(call).toMatchObject({
        name: 'get_slots',
        input: { service: expect.any(String), date: '2026-11-02' },
      });
      const second = await llm!.complete({
        ...ask,
        turns: [
          ...ask.turns,
          { role: 'assistant', text: first.text, toolCalls: first.toolCalls, raw: first.raw },
          { role: 'tool_results', results: [{ id: call.id, content: '{"slots":["10:00","11:30"]}' }] },
        ],
      });
      expect(second.stop).toBe('end');
      expect(second.text).toMatch(/10(:00)?|11(:30)?/);
    }, 60_000);

    test('structured output matches the schema', async () => {
      const r = await llm!.complete({
        ...base,
        task: 'intent_classify',
        turns: [{ role: 'user', text: 'Classify: "We offer SEO services for your website, cheap rates!"' }],
        output: {
          name: 'intent',
          schema: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: ['genuine', 'spam', 'vendor'] },
              confidence: { type: 'number' },
            },
            required: ['category', 'confidence'],
            additionalProperties: false,
          },
        },
      });
      const parsed = JSON.parse(r.text) as { category: string; confidence: number };
      expect(['spam', 'vendor']).toContain(parsed.category);
      expect(typeof parsed.confidence).toBe('number');
    }, 60_000);
  });
}
