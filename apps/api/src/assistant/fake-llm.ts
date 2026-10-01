import { randomUUID } from 'node:crypto';
import type { TenantConfig } from '@instantlead/config';
import type { Anthropic, LlmProvider, LlmRequest } from '@instantlead/integrations';

/** What the agent passes the fake provider instead of making it parse prompts. */
export interface TurnHints {
  config: TenantConfig;
  answers: Record<string, string>;
  missing: string[];
  lastInbound: string;
}

// A few Hindi/Hinglish synonyms so the demo understands common replies.
const SYNONYMS: Record<string, string[]> = {
  today: ['today', 'aaj', 'abhi', 'asap', 'urgent', 'right now'],
  this_week: ['this week', 'tomorrow', 'kal', 'hafte', 'week'],
  this_month: ['this month', 'month', 'mahine'],
  just_exploring: ['exploring', 'just looking', 'later', 'baad mein', 'dekh'],
  immediately: ['immediately', 'asap', 'abhi', 'right now'],
  tooth_pain: ['pain', 'dard', 'ache', 'hurts'],
  checkup_cleaning: ['cleaning', 'checkup', 'check up', 'saaf'],
  root_canal: ['root canal', 'rct'],
  whitening: ['whitening', 'white', 'safed'],
  braces_aligners: ['braces', 'aligner'],
  implants: ['implant'],
  morning: ['morning', 'subah'],
  afternoon: ['afternoon', 'dopahar'],
  evening: ['evening', 'shaam'],
  yes: ['yes', 'haan', 'han', 'yeah', 'yep', 'first time', 'pehli baar'],
  no: ['no', 'nahi', 'nope', 'been before', 'pehle aaya'],
};
const HUMAN = /\b(human|person|someone|staff|call me|phone me|real person|insaan|baat karni|baat karo)\b/i;
const FACTS: [RegExp, string][] = [
  [/(price|cost|fee|charge|how much|kitna|kitne|rate|₹)/i, 'price'],
  [/(address|where|location|kahan|parking|map)/i, 'address'],
  [/(doctor|dr\b|dentist|specialist)/i, 'doctor'],
  [/(timing|open|close|hours|sunday|kab)/i, 'timing'],
];

const spaced = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
/** Whole-word match, so "no" doesn't match "know". */
const has = (text: string, phrase: string) => spaced(text).includes(spaced(phrase));

function mapAnswer(q: TenantConfig['qualification']['questions'][number], text: string): string | null {
  if (q.type === 'yes_no') {
    if ((SYNONYMS.yes ?? []).some((s) => has(text, s))) return 'yes';
    if ((SYNONYMS.no ?? []).some((s) => has(text, s))) return 'no';
    return null;
  }
  if (q.options) {
    for (const o of q.options) {
      const words = [...(SYNONYMS[o] ?? []), o.replaceAll('_', ' ')];
      if (words.some((w) => has(text, w))) return o;
    }
    return null;
  }
  return text.includes('?') ? null : text.trim().slice(0, 300);
}

function ask(config: TenantConfig, key: string) {
  const q = config.qualification.questions.find((x) => x.key === key);
  if (!q) return '';
  const options = q.options ? ` (${q.options.map((o) => o.replaceAll('_', ' ')).join(' / ')})` : '';
  return `Could you tell me: ${q.hint.toLowerCase()}${options}?`;
}

function message(content: unknown[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: `fake_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (name: string, input: object) => ({
  type: 'tool_use',
  id: `toolu_${randomUUID()}`,
  name,
  input,
});

/**
 * Mock-mode assistant: a rule-based receptionist that drives the same tools as the real model,
 * so tests, the simulator and the demo sandbox run the full flow with zero credentials.
 */
export function createFakeLlm(): LlmProvider {
  return {
    name: 'fake',
    model: 'fake',
    complete(request: LlmRequest, rawHints?: unknown) {
      const h = rawHints as TurnHints;
      const nonSystem = request.messages.filter((m) => (m.role as string) !== 'system');
      const last = nonSystem.at(-1);
      const toolResults = Array.isArray(last?.content)
        ? last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
        : [];

      // Second step of a turn: tools ran, now talk.
      if (toolResults.length) {
        const prev = nonSystem.at(-2);
        const calls = Array.isArray(prev?.content)
          ? prev.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
          : [];
        const results = toolResults.map((r) => (typeof r.content === 'string' ? r.content : ''));
        if (calls.some((c) => c.name === 'escalate_to_human'))
          return Promise.resolve(
            message([text('Sure — a member of our team will reply to you here shortly.')], 'end_turn'),
          );
        const info = calls.some((c) => c.name === 'lookup_knowledge') ? `${results.join(' ')} ` : '';
        const state = results
          .map((r) => {
            try {
              return JSON.parse(r) as { still_missing?: string[]; status?: string };
            } catch {
              return {};
            }
          })
          .find((r) => r.status);
        if (state?.status === 'disqualified')
          return Promise.resolve(
            message(
              [
                text(
                  'Thanks for letting me know. This may not be the right fit for you, but our team can call you if you would like.',
                ),
              ],
              'end_turn',
            ),
          );
        const missing = state?.still_missing ?? h.missing;
        const next = missing[0];
        return Promise.resolve(
          message(
            [
              text(
                next
                  ? `${info}${info ? '' : 'Thanks! '}${ask(h.config, next)}`
                  : `${info}Thank you! That's everything I need — our team will share available times shortly.`,
              ),
            ],
            'end_turn',
          ),
        );
      }

      const inbound = h.lastInbound;
      if (HUMAN.test(inbound))
        return Promise.resolve(
          message([toolUse('escalate_to_human', { reason: 'Lead asked for a person' })], 'tool_use'),
        );
      const fact = FACTS.find(([re]) => re.test(inbound));
      if (fact)
        return Promise.resolve(message([toolUse('lookup_knowledge', { query: fact[1] })], 'tool_use'));

      const records = h.config.qualification.questions
        .filter((q) => h.answers[q.key] === undefined)
        .map((q) => ({ q, value: mapAnswer(q, inbound) }))
        .filter(
          (x): x is { q: typeof x.q; value: string } =>
            x.value !== null && (x.q.type !== 'text' || x.q.key === h.missing[0]),
        );
      if (records.length)
        return Promise.resolve(
          message(
            records.map((r) => toolUse('record_answer', { key: r.q.key, value: r.value })),
            'tool_use',
          ),
        );

      const next = h.missing[0];
      const name = h.config.brand.assistant_name;
      return Promise.resolve(
        message(
          [
            text(
              next
                ? `Hi! I'm ${name} from ${h.config.brand.business_name}. ${ask(h.config, next)}`
                : 'Thanks! Our team will share available times shortly.',
            ),
          ],
          'end_turn',
        ),
      );
    },
  };
}
