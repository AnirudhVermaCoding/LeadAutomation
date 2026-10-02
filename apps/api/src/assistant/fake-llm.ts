import { randomUUID } from 'node:crypto';
import type { TenantConfig } from '@instantlead/config';
import type { LlmProvider, LlmRequest, LlmResponse, ToolCall } from '@instantlead/integrations';
import { ruleBasedIntent } from './guard.ts';

/** What the agent passes the fake provider instead of making it parse prompts. */
export interface TurnHints {
  config: TenantConfig;
  answers: Record<string, string>;
  missing: string[];
  lastInbound: string;
  /** Lead display status at the start of the turn (e.g. booking_offered, booked). */
  status: string;
  appointment: { service: string; label: string } | null;
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

function message(text: string, toolCalls: ToolCall[] = []): LlmResponse {
  return {
    text,
    toolCalls,
    stop: toolCalls.length ? 'tool_use' : 'end',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    raw: { provider: 'fake', model: 'fake', data: null },
    requestId: `fake_${randomUUID()}`,
  };
}
const toolUse = (name: string, input: object): ToolCall => ({ id: `toolu_${randomUUID()}`, name, input });

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const HINDI_ORDINALS = ['pehla', 'doosra', 'teesra'];
/** "2", "option 2", "the second one", "doosra" -> 1 (zero-based). */
function choiceIndex(text: string): number | null {
  const digit = /(^|\D)([1-5])(\D|$)/.exec(text);
  if (digit?.[2] && text.trim().length <= 20) return Number(digit[2]) - 1;
  const i = ORDINALS.findIndex((o) => has(text, o));
  if (i >= 0) return i;
  const j = HINDI_ORDINALS.findIndex((o) => has(text, o));
  return j >= 0 ? j : null;
}

/** Best-guess service for the lead's treatment answer (first service otherwise). */
function serviceFor(h: TurnHints): string {
  const services = h.config.booking.services;
  const answer = Object.values(h.answers).join(' ').replaceAll('_', ' ');
  const words = answer.split(/\s+/).filter((w) => w.length > 3);
  return (services.find((s) => words.some((w) => has(s.name, w))) ?? services[0])?.name ?? '';
}

const CANCEL = /\b(cancel|radd|nahi aa paunga|nahi aa paungi)\b/i;
const RESCHEDULE = /\b(reschedule|change|another time|different time|postpone|badal|shift)\b/i;
const BOOK = /\b(book|slot|appointment|available|time)\b/i;

type Slot = { date: string; time: string; label: string };
const parse = <T>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};
const reply = (t: string) => Promise.resolve(message(t));
const call = (name: string, input: object) => Promise.resolve(message('', [toolUse(name, input)]));

/**
 * Mock-mode assistant: a rule-based receptionist that drives the same tools as the real model,
 * so tests, the simulator and the demo sandbox run the full flow with zero credentials.
 */
export function createFakeLlm(): LlmProvider {
  return {
    provider: 'fake',
    model: 'fake',
    complete(request: LlmRequest, rawHints?: unknown) {
      // Single-call tasks: rule-based stand-ins so mock mode exercises the same code paths.
      const lastUser = request.turns.filter((t) => t.role === 'user').at(-1);
      const userText = lastUser?.role === 'user' ? lastUser.text : '';
      if (request.task === 'intent_classify')
        return Promise.resolve(message(JSON.stringify(ruleBasedIntent(userText))));
      if (request.task === 'memory_summarize')
        return Promise.resolve(
          message(
            JSON.stringify({
              summary: `Earlier the customer said: ${userText
                .split('\n')
                .filter((l) => l.startsWith('Customer:'))
                .map((l) => l.slice(10))
                .slice(-5)
                .join(' / ')
                .slice(0, 600)}`,
            }),
          ),
        );
      const h = rawHints as TurnHints;
      const inbound = h.lastInbound;
      const choice = choiceIndex(inbound);
      const picking = choice !== null && (h.status === 'booking_offered' || h.appointment !== null);
      const turns = request.turns.filter((t) => t.role !== 'system');
      const last = turns.at(-1);
      const toolResults = last?.role === 'tool_results' ? last.results : [];

      // Second step of a turn: tools ran, now act on their results.
      if (toolResults.length) {
        const prev = turns.at(-2);
        const names = prev?.role === 'assistant' ? prev.toolCalls.map((c) => c.name) : [];
        const results = toolResults.map((r) => r.content);
        const failed = toolResults.some((r) => r.isError);

        if (names.includes('escalate_to_human'))
          return reply('Sure — a member of our team will reply to you here shortly.');
        if (names.includes('cancel'))
          return reply(
            failed
              ? "I couldn't find an upcoming appointment to cancel."
              : 'Your appointment is cancelled. Message us any time to book again.',
          );
        if (names.includes('book_slot') || names.includes('reschedule')) {
          if (failed)
            return reply('Sorry, that time is no longer free. Would you like me to share other times?');
          const r =
            parse<{ booked?: string; rescheduled_to?: string; status?: string }>(results[0] ?? '') ?? {};
          if (r.rescheduled_to) return reply(`Done! Your appointment is moved to ${r.rescheduled_to}.`);
          return reply(
            r.status === 'confirmed'
              ? `Done! You're booked for ${r.booked}. See you then!`
              : `Thanks! I've requested ${r.booked} for you — the team will confirm shortly.`,
          );
        }
        if (names.includes('get_available_slots')) {
          const slots = parse<{ slots: Slot[] }>(results[0] ?? '')?.slots ?? [];
          if (!slots.length)
            return reply('Sorry, there are no free times in the next two weeks. Shall the team call you?');
          const chosen = picking && choice !== null ? slots[choice] : undefined;
          if (chosen)
            return h.appointment
              ? call('reschedule', { date: chosen.date, time: chosen.time })
              : call('book_slot', { service: serviceFor(h), date: chosen.date, time: chosen.time });
          return reply(
            `I have these times free: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join(', ')}. Which one suits you?`,
          );
        }

        const info = names.includes('lookup_knowledge') ? `${results.join(' ')} ` : '';
        const state = results
          .map((r) => parse<{ still_missing?: string[]; status?: string }>(r) ?? {})
          .find((r) => r.status);
        if (state?.status === 'disqualified')
          return reply(
            'Thanks for letting me know. This may not be the right fit for you, but our team can call you if you would like.',
          );
        const next = (state?.still_missing ?? h.missing)[0];
        if (next) return reply(`${info}${info ? '' : 'Thanks! '}${ask(h.config, next)}`);
        if (state?.status === 'qualified' && !h.appointment)
          return call('get_available_slots', { service: serviceFor(h) });
        return reply(`${info}Is there anything else I can help you with?`);
      }

      // First step: decide what to do with the new message.
      if (HUMAN.test(inbound)) return call('escalate_to_human', { reason: 'Lead asked for a person' });
      if (h.appointment && CANCEL.test(inbound)) return call('cancel', {});
      if (h.appointment && RESCHEDULE.test(inbound))
        return call('get_available_slots', { service: h.appointment.service });
      if (picking) return call('get_available_slots', { service: h.appointment?.service ?? serviceFor(h) });
      const fact = FACTS.find(([re]) => re.test(inbound));
      if (fact) return call('lookup_knowledge', { query: fact[1] });

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
            '',
            records.map((r) => toolUse('record_answer', { key: r.q.key, value: r.value })),
          ),
        );

      const next = h.missing[0];
      if (!next && !h.appointment && (BOOK.test(inbound) || h.status === 'qualified'))
        return call('get_available_slots', { service: serviceFor(h) });
      if (h.appointment)
        return reply(`You're booked for ${h.appointment.label}. Anything else I can help with?`);
      const name = h.config.brand.assistant_name;
      return reply(
        next
          ? `Hi! I'm ${name} from ${h.config.brand.business_name}. ${ask(h.config, next)}`
          : 'How can I help you today?',
      );
    },
  };
}
