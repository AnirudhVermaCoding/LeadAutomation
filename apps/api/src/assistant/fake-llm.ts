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
  /** Bookable doctors / agents. */
  resources?: readonly string[];
}

// A few Hindi/Hinglish synonyms so the demo understands common replies.
const SYNONYMS: Record<string, string[]> = {
  today: ['today', 'aaj', 'abhi', 'asap', 'urgent', 'right now'],
  this_week: ['this week', 'tomorrow', 'kal', 'hafte', 'week'],
  this_month: ['this month', 'month', 'mahine'],
  just_exploring: ['exploring', 'just looking', 'later', 'baad mein', 'dekh'],
  immediately: ['immediately', 'asap', 'abhi', 'right now', 'now', 'ready to buy', 'urgent', 'turant'],
  tooth_pain: ['pain', 'dard', 'ache', 'hurts'],
  checkup_cleaning: ['cleaning', 'checkup', 'check up', 'saaf'],
  root_canal: ['root canal', 'rct'],
  whitening: ['whitening', 'white', 'safed'],
  braces_aligners: ['braces', 'aligner'],
  implants: ['implant'],
  morning: ['morning', 'subah'],
  afternoon: ['afternoon', 'dopahar'],
  evening: ['evening', 'shaam'],
  // Real estate
  under_40l: ['under 40', 'below 40', '30 lakh', '35 lakh', '25 lakh', '30l', '35l'],
  '40l_75l': [
    '40 lakh',
    '45 lakh',
    '50 lakh',
    '55 lakh',
    '60 lakh',
    '65 lakh',
    '70 lakh',
    '50l',
    '60l',
    '70l',
  ],
  '75l_1_5cr': [
    '75 lakh',
    '80 lakh',
    '90 lakh',
    '1 crore',
    '1 cr',
    'one crore',
    '1.2 cr',
    '1.25 cr',
    '1.5 cr',
    '1 karod',
    'ek crore',
  ],
  above_1_5cr: ['2 crore', '2 cr', '3 crore', 'above 1.5', 'more than 1.5', '2 karod'],
  '1bhk': ['1bhk', '1 bhk', 'one bhk'],
  '2bhk': ['2bhk', '2 bhk', 'two bhk'],
  '3bhk': ['3bhk', '3 bhk', 'three bhk'],
  '4bhk_plus': ['4bhk', '4 bhk', '5bhk', 'villa', 'penthouse'],
  within_3_months: ['3 months', 'three months', 'next month', 'soon', 'jaldi'],
  within_6_months: ['6 months', 'six months', 'this year'],
  self_use: ['self', 'own use', 'to live', 'family', 'rehne', 'khud'],
  investment: ['invest', 'investment', 'rental', 'returns'],
  yes: ['yes', 'haan', 'han', 'yeah', 'yep', 'first time', 'pehli baar'],
  no: ['no', 'nahi', 'nope', 'been before', 'pehle aaya'],
};
const HUMAN =
  /\b(human|person|someone|staff|agent|broker|manager|owner|call me|phone me|real person|insaan|baat karni|baat karo)\b/i;
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

/** How a receptionist would ask, for the common preset questions; a gentle generic fallback otherwise. */
const PHRASES: Record<string, string> = {
  urgency: 'How soon would you like to come in — today, sometime this week, or later on?',
  timeline: 'When are you planning to buy — right away, in the next few months, or still exploring?',
  treatment_interest: 'What would you like help with?',
  concern: 'What would you like help with?',
  first_visit: 'Will this be your first visit with us?',
  preferred_time: 'Do mornings, afternoons or evenings suit you better?',
  budget: 'Roughly what budget do you have in mind?',
  budget_range: 'Roughly what budget do you have in mind?',
  purpose: 'Is this for your own use or as an investment?',
  loan_needed: 'Will you need a home loan? We can help with that too.',
  location: 'Which areas are you looking at?',
  bhk: 'How many bedrooms are you looking for?',
};
function ask(config: TenantConfig, key: string) {
  const q = config.qualification.questions.find((x) => x.key === key);
  if (!q) return '';
  return PHRASES[key] ?? `Could you tell me a little about ${q.hint.toLowerCase().replace(/[?.]$/, '')}?`;
}

const BOT =
  /\b(are you (a |an )?(bot|robot|ai|machine|real( person)?|human)|(talking|chatting) (to|with) a (bot|robot|machine|real person|human)|is this (a )?(bot|automated)|kya (aap|tum) (bot|insaan))\b/i;
const YES = /^(yes|yeah|yep|sure|ok(ay)?|please|haan|han|ji|ha|theek hai|thik hai|chalega)\b/i;
const SYMPTOM =
  /\b(pain|paining|hurts?|hurting|ache|aching|decay|bleed(s|ing)?|swollen|swelling|sensitiv\w*|broken|chipped|cavity|loose|bad breath|yellow|stain\w*|crooked|gap|acne|pimples?|scars?|spots?|black spot|pigment\w*|rash\w*|itch\w*|dark circles|hair ?fall|thinning|dandruff|bald\w*|grey|gray|dard|khoon|daant)\b/i;

/** The service whose suitable_for best matches what they wrote (word overlap), if any. */
function serviceForConcern(config: TenantConfig, text: string): string | null {
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length > 3),
  );
  let best: { name: string; score: number } | null = null;
  for (const svc of config.booking.services) {
    const score = (svc.suitable_for ?? []).reduce(
      (n, c) =>
        n +
        c
          .toLowerCase()
          .split(/[^\p{L}]+/u)
          .filter((w) => w.length > 3 && [...words].some((x) => x.startsWith(w.slice(0, 5)))).length,
      0,
    );
    if (score > 0 && (!best || score > best.score)) best = { name: svc.name, score };
  }
  return best?.name ?? null;
}
/** A doctor / agent the customer named anywhere in the conversation ("Dr Rao", "rao"). */
function requestedResource(h: TurnHints, request: LlmRequest): string | undefined {
  const text = request.turns
    .filter((t) => t.role === 'user')
    .map((t) => (t.role === 'user' ? t.text : ''))
    .join(' ')
    .toLowerCase();
  return (h.resources ?? [])
    .filter((r) => r !== 'default')
    .find((r) => {
      const last = r.toLowerCase().split(/\s+/).at(-1) ?? '';
      return last.length > 2 && text.includes(last);
    });
}
const withResource = (h: TurnHints, request: LlmRequest) => {
  const r = requestedResource(h, request);
  return r ? { resource: r } : {};
};
const lastAssistantText = (request: LlmRequest) => {
  const t = request.turns.filter((x) => x.role === 'assistant').at(-1);
  return t?.role === 'assistant' ? t.text : '';
};

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

const PAST_VISIT =
  /\b(last time|last visit|previous|earlier visit|my treatment|next sitting|pichli baar|pichhli baar)\b/i;
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
      if (request.task === 'message_route')
        return Promise.resolve(
          message(
            JSON.stringify({
              complexity: /\b(but|unless|except|also)\b/i.test(userText) ? 'complex' : 'simple',
            }),
          ),
        );
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

        if (names.includes('get_patient_history')) {
          const r = parse<{
            past_visits: { service: string; when: string; status: string }[];
            treatment_plans: { treatment: string; visits: string }[];
          }>(results[0] ?? '');
          const plan = r?.treatment_plans[0];
          const visit = r?.past_visits[0];
          return reply(
            plan
              ? `Your ${plan.treatment} is ${plan.visits}. Would you like me to find a time for the next visit?`
              : visit
                ? `Your last visit was ${visit.service} on ${visit.when}. Would you like to book a follow-up?`
                : "I couldn't find an earlier visit. Would you like to book one?",
          );
        }
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
              : call('book_slot', {
                  service: serviceFor(h),
                  date: chosen.date,
                  time: chosen.time,
                  ...withResource(h, request),
                });
          return reply(
            `I have these times free: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join(', ')}. Which one suits you?`,
          );
        }

        // Never echo the tool's internal "no information" note to the customer.
        const found = results.filter((r) => !r.startsWith('No information'));
        const info = names.includes('lookup_knowledge')
          ? found.length
            ? `${found
                .flatMap((r) => r.split(/\r?\n/))
                .map((l) => l.replace(/^[^:]{1,60}: /, '')) // drop the entry titles
                .join(' ')} `
            : "I'll check that with the team and get back to you. "
          : '';
        const state = results
          .map((r) => parse<{ still_missing?: string[]; status?: string }>(r) ?? {})
          .find((r) => r.status);
        if (state?.status === 'disqualified')
          return reply(
            'Thanks for letting me know. This may not be the right fit for you, but our team can call you if you would like.',
          );
        const next = (state?.still_missing ?? h.missing)[0];
        if (next)
          return reply(
            `${info}${info ? '' : SYMPTOM.test(inbound) && h.config.qualification.safety.no_medical_advice ? 'Sorry to hear that — our doctor can take a proper look. ' : 'Thanks! '}${ask(h.config, next)}`,
          );
        if (state?.status === 'qualified' && !h.appointment)
          return call('get_available_slots', { service: serviceFor(h), ...withResource(h, request) });
        return reply(
          h.appointment
            ? `${info}Anything else I can help with before your visit?`
            : `${info}Would you like me to find you a time to come in?`,
        );
      }

      // First step: decide what to do with the new message.
      const { assistant_name: me, business_name: biz } = h.config.brand;
      if (BOT.test(inbound))
        return reply(
          `I'm ${me}, ${biz}'s virtual assistant — I can answer most questions and book ${h.config.qualification.safety.no_medical_advice ? 'appointments' : 'visits'}, and someone from our team can step in anytime. How can I help?`,
        );
      if (HUMAN.test(inbound)) return call('escalate_to_human', { reason: 'Lead asked for a person' });
      // "Yes" to "shall I find you a <service> slot?": go find times for that service.
      const offered = /find you a (.+?) slot/i.exec(lastAssistantText(request));
      if (offered && YES.test(inbound.trim()) && !h.appointment) {
        const svc = h.config.booking.services.find((x) => x.name.toLowerCase() === offered[1]!.toLowerCase());
        return call('get_available_slots', {
          service: svc?.name ?? serviceFor(h),
          ...withResource(h, request),
        });
      }
      // Property buyers far away: offer the video walkthrough service if the business has one.
      const video = h.config.booking.services.find((s) => /video|virtual/i.test(s.name));
      if (
        video &&
        !h.appointment &&
        /\b(video|virtual|abroad|another city|outside india|nri|dubai|usa|uk|canada)\b/i.test(inbound)
      )
        return reply(
          `Of course! We can do a ${video.name.toLowerCase()} so you can see the property from wherever you are. Would you like me to find you a slot?`,
        );
      // A problem in their own words: empathy, no diagnosis, the right service, an offer to book.
      // Older configs have no suitable_for: the first service (usually the general consultation) is the safe default.
      const concernService = SYMPTOM.test(inbound)
        ? (serviceForConcern(h.config, inbound) ?? h.config.booking.services[0]?.name ?? null)
        : null;
      if (concernService && !h.appointment && h.config.qualification.safety.no_medical_advice)
        return reply(
          `Sorry to hear that — that's worth getting checked properly. I can't say what's causing it, but our doctor can take a proper look. Would you like me to find you a ${concernService.toLowerCase()} slot this week?`,
        );
      if (PAST_VISIT.test(inbound) && request.tools?.some((t) => t.name === 'get_patient_history'))
        return call('get_patient_history', {});
      if (h.appointment && CANCEL.test(inbound)) return call('cancel', {});
      if (h.appointment && RESCHEDULE.test(inbound))
        return call('get_available_slots', { service: h.appointment.service, ...withResource(h, request) });
      if (picking)
        return call('get_available_slots', {
          service: h.appointment?.service ?? serviceFor(h),
          ...withResource(h, request),
        });
      const facts = FACTS.filter(([re]) => re.test(inbound)).map(([, q]) => q);
      if (facts.length) return call('lookup_knowledge', { query: facts.join(' ') });

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
        return call('get_available_slots', { service: serviceFor(h), ...withResource(h, request) });
      if (h.appointment)
        return reply(`You're booked for ${h.appointment.label}. Anything else I can help with?`);
      const greeted = request.turns.some((t) => t.role === 'assistant');
      return reply(
        next
          ? `${greeted ? '' : `Hi! I'm ${me} from ${biz}. `}${ask(h.config, next)}`
          : 'How can I help you today?',
      );
    },
  };
}
