import { fillVariables, parseButtonPayload } from '@instantlead/config';
import { detectLanguage, displayStatus, formatSlot, matchesEmergency, scoreLead } from '@instantlead/core';
import { LlmError, type LlmProvider, type LlmRequest, type Turn } from '@instantlead/integrations';
import { asc, eq, sum } from 'drizzle-orm';
import { getActiveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import { leads, llmRuns, messages } from '../db/schema.ts';
import {
  aiSettings,
  loggedCall,
  monthSpendUsd,
  NoModelAvailableError,
  type LlmRouter,
} from '../llm-router.ts';
import { sendToLead, type MessagingDeps } from '../outbound.ts';
import type { TurnHints } from './fake-llm.ts';
import { buildSystemPrompt, buildTools, stateMessage } from './prompt.ts';
import { activeAppointment, BookingError, updateAppointment } from '../booking.ts';
import { escalate, loadAnswers, runTool } from './tools.ts';

export interface AssistantDeps extends MessagingDeps {
  router: LlmRouter;
  /** Per-lead LLM spend ceiling; above it the conversation goes to staff. */
  llmCostCapUsd: number;
}

const MAX_STEPS = 6; // model calls per turn
const HISTORY = 40; // messages of context
/** Logged on every model call, so evals and incidents can be tied to the prompt that produced them. */
export const PROMPT_VERSION = 'agent-v1';

const HOLDING = {
  en: 'Thanks for your message! A member of our team will get back to you shortly.',
  hi: 'आपके संदेश के लिए धन्यवाद! हमारी टीम का कोई सदस्य जल्द ही आपसे संपर्क करेगा।',
  hinglish: 'Message ke liye thank you! Hamari team ka koi member jaldi aapse baat karega.',
} as const;

export type TurnResult =
  | { status: 'skipped'; reason: string }
  | { status: 'replied' | 'escalated'; reason?: string; messageId?: string };

/**
 * One assistant turn for a lead who wrote in (debounced by the job queue, one at a time per lead).
 * Deterministic guards run first (takeover, opt-out, emergency, cost cap); then a bounded
 * tool-use loop; the reply goes out through sendToLead (window, opt-out, idempotency).
 */
export async function runAssistantTurn(
  deps: AssistantDeps,
  tenantId: string,
  leadId: string,
  /** The job's last attempt: never throw for a retry; the lead gets the holding reply instead. */
  opts: { finalAttempt?: boolean } = {},
): Promise<TurnResult> {
  const ctx = await withTenant(deps.db, tenantId, async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
    const active = await getActiveConfig(tx);
    if (!lead || !active) return null;
    const history = (
      await tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, leadId))
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt))
    ).slice(-HISTORY);
    const [spend] = await tx
      .select({ total: sum(llmRuns.costUsd) })
      .from(llmRuns)
      .where(eq(llmRuns.leadId, leadId));
    const tenantSpendUsd = await monthSpendUsd(tx, deps.clock.now());
    const answers = await loadAnswers(tx, leadId);
    const appt = await activeAppointment(tx, leadId);
    const appointment = appt && {
      service: appt.service,
      label: `${appt.service}, ${formatSlot(appt.startsAt, active.config.locale.timezone)}${appt.status === 'pending' ? ' (pending staff confirmation)' : ''}`,
    };

    // Only reply to messages that haven't been answered yet (debounced bursts become one turn).
    const lastOut = history.findLastIndex((m) => m.direction === 'out');
    const unanswered = history.slice(lastOut + 1).filter((m) => m.direction === 'in');
    const inboundText = unanswered.map((m) => m.body).join('\n');
    const language = detectLanguage(inboundText) ?? lead.language;
    if (language && language !== lead.language)
      await tx.update(leads).set({ language }).where(eq(leads.id, leadId));

    return {
      lead: { ...lead, language },
      config: active.config,
      history,
      unanswered,
      inboundText,
      answers,
      spentUsd: Number(spend?.total ?? 0),
      tenantSpendUsd,
      appointment,
      appointmentId: appt?.id ?? null,
    };
  });

  if (!ctx) return { status: 'skipped', reason: 'lead or config not found' };
  const { lead, config, unanswered } = ctx;
  if (lead.state === 'opted_out') return { status: 'skipped', reason: 'opted out' };
  if (lead.aiPaused) return { status: 'skipped', reason: 'human takeover' };
  const lastInbound = unanswered.at(-1);
  if (!lastInbound) return { status: 'skipped', reason: 'nothing to answer' };

  const tool = { deps, tenantId, leadId, config };
  const reply = (body: string, suffix = 'reply') =>
    sendToLead(deps, tenantId, {
      leadId,
      idempotencyKey: `ai:${lastInbound.id}:${suffix}`,
      freeForm: { kind: 'text', body },
    });
  const holding =
    HOLDING[(lead.language ?? config.brand.default_language) as keyof typeof HOLDING] ?? HOLDING.en;

  // Safety first, without the model: emergencies get the fixed reply and a person, immediately.
  const safety = config.qualification.safety;
  if (safety.emergency_keywords.length && matchesEmergency(ctx.inboundText, safety.emergency_keywords)) {
    await reply(
      fillVariables(safety.emergency_response, { business_name: config.brand.business_name }),
      'emergency',
    );
    await escalate(tool, 'emergency keywords');
    return { status: 'escalated', reason: 'emergency' };
  }
  // Quick-reply buttons with a fixed meaning are handled in code, not by the model.
  const payload = (lastInbound.payload as { buttonPayload?: string } | null)?.buttonPayload;
  const button = payload ? parseButtonPayload(payload) : null;
  if (button) {
    const aboutAppointment = ['reminder_24h', 'reminder_2h', 'booking_confirmed'].includes(button.key);
    if (button.buttonId === 'call') {
      await escalate(tool, 'lead asked for a call');
      await reply('Sure — someone from our team will call you shortly.', 'button');
      return { status: 'escalated', reason: 'call requested' };
    }
    if (aboutAppointment && (button.buttonId === 'confirm' || button.buttonId === 'cancel')) {
      if (!ctx.appointmentId) {
        await reply("I couldn't find an upcoming appointment for you. Would you like to book one?", 'button');
        return { status: 'replied' };
      }
      try {
        if (button.buttonId === 'cancel') {
          // The cancellation message itself is sent by the appointment-notify job.
          await updateAppointment(deps, tenantId, ctx.appointmentId, 'cancelled');
          return { status: 'replied', reason: 'cancelled by button' };
        }
        await updateAppointment(deps, tenantId, ctx.appointmentId, 'lead_confirmed');
        await reply(
          `Thanks for confirming! See you on ${ctx.appointment?.label ?? 'your appointment'}.`,
          'button',
        );
        return { status: 'replied', reason: 'confirmed by button' };
      } catch (err) {
        if (!(err instanceof BookingError)) throw err;
        await reply(
          button.buttonId === 'confirm' && ctx.appointment?.label.includes('pending')
            ? 'Thanks! Your booking is still waiting for the team to confirm — we will message you shortly.'
            : 'Thanks — noted.',
          'button',
        );
        return { status: 'replied', reason: err.code };
      }
    }
  }

  const handover = async (reason: string): Promise<TurnResult> => {
    await escalate(tool, reason);
    await reply(holding, 'holding');
    return { status: 'escalated', reason };
  };

  if (ctx.spentUsd >= deps.llmCostCapUsd) return handover('cost cap');
  const cap = aiSettings(config).monthly_cost_cap_usd;
  if (cap > 0 && ctx.tenantSpendUsd >= cap) return handover('monthly AI budget reached');

  let chain: LlmProvider[];
  try {
    chain = deps.router.chain('agent_reply', config);
  } catch (err) {
    if (err instanceof NoModelAvailableError) return handover('no AI model available');
    throw err;
  }

  const scored = scoreLead(config.qualification, ctx.answers);
  const system = buildSystemPrompt(config);
  const tools = buildTools(config);
  const state: Turn = {
    role: 'system',
    text: stateMessage({
      now: deps.clock.now().toLocaleString('en-IN', { timeZone: config.locale.timezone }),
      name: lead.name,
      language: lead.language,
      answers: ctx.answers,
      missing: scored.status === 'incomplete' ? scored.missing : [],
      status: displayStatus(lead),
      appointment: ctx.appointment?.label ?? null,
    }),
  };

  /** One model drives the whole turn (bounded tool loop). Throws LlmError to fail over. */
  const converse = async (llm: LlmProvider, fallbackUsed: boolean): Promise<TurnResult> => {
    const request: LlmRequest = {
      task: 'agent_reply',
      system,
      tools,
      turns: [...toConversation(ctx.history), state],
      maxTokens: 1024,
      effort: 'low', // short, fast WhatsApp replies
    };
    let answers = ctx.answers;
    let invalidCalls = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const sc = scoreLead(config.qualification, answers);
      const hints: TurnHints = {
        config,
        answers,
        missing: sc.status === 'incomplete' ? sc.missing : [],
        lastInbound: ctx.inboundText,
        status: displayStatus(lead),
        appointment: ctx.appointment,
      };
      const response = await loggedCall(
        deps,
        llm,
        request,
        { tenantId, leadId, task: 'agent_reply', promptVersion: PROMPT_VERSION, fallbackUsed },
        hints,
      );

      if (response.stop === 'refusal')
        return handover(`model declined (${response.refusalCategory ?? 'unknown'})`);

      if (response.stop !== 'tool_use' || !response.toolCalls.length) {
        if (!response.text) throw new LlmError('invalid_output', `${llm.model} returned no text`);
        const fresh = await withTenant(deps.db, tenantId, (tx) =>
          tx.select().from(leads).where(eq(leads.id, leadId)),
        );
        const sent = await reply(response.text);
        return {
          status: fresh[0]?.aiPaused ? 'escalated' : 'replied',
          messageId: 'messageId' in sent ? sent.messageId : undefined,
        };
      }

      // Append-only: the assistant turn goes back unchanged (raw keeps provider extras), then all results.
      request.turns.push({
        role: 'assistant',
        text: response.text,
        toolCalls: response.toolCalls,
        raw: response.raw,
      });
      const results: { id: string; content: string; isError?: boolean }[] = [];
      for (const call of response.toolCalls) {
        const out = await runTool(tool, call.name, call.input);
        if (out.invalidArguments) invalidCalls++;
        results.push({ id: call.id, content: out.content, isError: out.isError });
      }
      // One bad call is fed back so the model can correct itself; a second means this model is unreliable here.
      if (invalidCalls >= 2)
        throw new LlmError('invalid_output', `${llm.model}: repeated invalid tool arguments`);
      request.turns.push({ role: 'tool_results', results });
      answers = await withTenant(deps.db, tenantId, (tx) => loadAnswers(tx, leadId));
    }
    return handover('assistant did not finish within the step limit');
  };

  // Failover: on an outage or bad output, the next model in the chain redoes the turn from the stored conversation.
  let lastError: unknown;
  for (const [i, llm] of chain.entries()) {
    try {
      return await converse(llm, i > 0);
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      lastError = err;
      if (!err.failover) break;
    }
  }
  // The whole chain failed. A transient outage is retried by the job, unless this is the last attempt.
  if (lastError instanceof LlmError && lastError.retryable && !opts.finalAttempt) throw lastError;
  const why = lastError instanceof Error ? lastError.message.slice(0, 120) : 'unknown';
  return handover(`all AI models failed (${why})`);
}

/** Stored messages -> alternating user/assistant turns (providers need a user turn first). */
function toConversation(history: { direction: 'in' | 'out'; body: string }[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of history) {
    const prev = turns.at(-1);
    if (m.direction === 'in') {
      if (prev?.role === 'user') prev.text += `\n${m.body}`;
      else turns.push({ role: 'user', text: m.body });
    } else if (prev?.role === 'assistant') prev.text += `\n${m.body}`;
    else turns.push({ role: 'assistant', text: m.body, toolCalls: [] });
  }
  if (turns[0]?.role === 'assistant')
    turns.unshift({ role: 'user', text: '(The customer submitted an enquiry form.)' });
  return turns;
}
