import { autonomyOf, fillVariables, parseButtonPayload, type TenantConfig } from '@instantlead/config';
import {
  detectLanguage,
  displayStatus,
  formatSlot,
  localParts,
  matchesEmergency,
  scoreLead,
} from '@instantlead/core';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type MediaType,
  type Turn,
} from '@instantlead/integrations';
import { and, asc, desc, eq, gte, inArray, sum } from 'drizzle-orm';
import { z } from 'zod';
import { getActiveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import {
  answers as answersTable,
  appointments,
  availabilityRules,
  conversations,
  leads,
  llmRuns,
  messages,
  tenants,
} from '../db/schema.ts';
import { emit, transitionLeadIfAllowed } from '../leads.ts';
import {
  aiSettings,
  loggedCall,
  monthSpendUsd,
  NoModelAvailableError,
  runStructured,
  type LlmRouter,
} from '../llm-router.ts';
import { sendToLead, showTyping, type MessagingDeps } from '../outbound.ts';
import type { TurnHints } from './fake-llm.ts';
import {
  checkReply,
  cleanReply,
  hasCustomerSignal,
  isEmojiOnly,
  mediaResponse,
  NOT_A_LEAD,
  notALeadReply,
  redact,
  ruleBasedIntent,
  sameReply,
  type NotALead,
} from './guard.ts';
import { buildSystemPrompt, buildTools, jsonSchema, openingStatus, stateMessage } from './prompt.ts';
import {
  PREFERRED_RESOURCE,
  upcomingAppointments,
  BookingError,
  findSlots,
  lastCancelledAppointment,
  updateAppointment,
} from '../booking.ts';
import { alertStaff, escalate, loadAnswers, runTool } from './tools.ts';

export interface AssistantDeps extends MessagingDeps {
  router: LlmRouter;
  /** Per-lead LLM spend ceiling; above it the conversation goes to staff. */
  llmCostCapUsd: number;
}

const MAX_STEPS = 6; // model calls per turn
/** More inbound messages than this in 10 minutes = a flood (or another bot): hand over once. */
const FLOOD_LIMIT = 15;
/** Logged on every model call, so evals and incidents can be tied to the prompt that produced them. */
export const PROMPT_VERSION = 'agent-v3';

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
    const all = await tx
      .select()
      .from(messages)
      .where(eq(messages.leadId, leadId))
      .orderBy(asc(messages.occurredAt), asc(messages.createdAt));
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.leadId, leadId));
    const [spend] = await tx
      .select({ total: sum(llmRuns.costUsd) })
      .from(llmRuns)
      .where(eq(llmRuns.leadId, leadId));
    const tenantSpendUsd = await monthSpendUsd(tx, deps.clock.now());
    const resources = [
      ...new Set(
        (await tx.select({ r: availabilityRules.resource }).from(availabilityRules)).map((x) => x.r),
      ),
    ];
    const [account] = await tx.select({ status: tenants.status }).from(tenants);
    const answers = await loadAnswers(tx, leadId);
    // Returning customers: how old are the answers, and what happened at past visits?
    const sixtyDaysAgo = deps.clock.now().getTime() - 60 * 86_400_000;
    const staleAnswers = (
      await tx
        .select({ key: answersTable.key, answeredAt: answersTable.answeredAt })
        .from(answersTable)
        .where(eq(answersTable.leadId, leadId))
    )
      .filter((a) => a.answeredAt.getTime() < sixtyDaysAgo && a.key !== PREFERRED_RESOURCE)
      .map((a) => a.key);
    const pastVisits = (
      await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.leadId, leadId),
            inArray(appointments.status, ['completed', 'no_show', 'cancelled', 'lapsed']),
          ),
        )
        .orderBy(desc(appointments.startsAt))
        .limit(3)
    ).map(
      (a) =>
        `${a.service}${a.attendeeName ? ` for ${a.attendeeName}` : ''}, ${formatSlot(a.startsAt, active.config.locale.timezone)} (${a.status.replace('_', '-')})`,
    );
    const upcoming = await upcomingAppointments(tx, leadId, deps.clock.now());
    const apptList = upcoming.map((a) => ({
      id: a.id,
      service: a.service,
      label: `${a.service}, ${formatSlot(a.startsAt, active.config.locale.timezone)}${a.attendeeName ? ` (for ${a.attendeeName})` : ''}${a.status === 'pending' ? ' (pending staff confirmation)' : ''}`,
    }));
    const appointment = apptList[0] ?? null; // the single-appointment view (mock assistant, simple cases)

    // Only reply to messages that haven't been answered yet (debounced bursts become one turn).
    const lastOut = all.findLastIndex((m) => m.direction === 'out');
    const unanswered = all.slice(lastOut + 1).filter((m) => m.direction === 'in');
    // What the AI reads: text, and captions of media (photos and voice notes themselves are never sent to a model).
    const inboundText = unanswered
      .map((m) => {
        const media = mediaOf(m);
        if (!media) return m.body;
        return m.body.startsWith('[') ? '' : `(sent a ${media === 'image' ? 'photo' : media}) ${m.body}`;
      })
      .filter(Boolean)
      .join('\n');
    // How long since we last spoke before this message (a customer returning after months).
    const answeredIds = new Set(unanswered.map((m) => m.id));
    const lastBefore = all.filter((m) => !answeredIds.has(m.id)).at(-1);
    const daysSinceBefore = lastBefore
      ? Math.floor((deps.clock.now().getTime() - lastBefore.occurredAt.getTime()) / 86_400_000)
      : null;
    const language = detectLanguage(inboundText) ?? lead.language;
    if (language && language !== lead.language)
      await tx.update(leads).set({ language }).where(eq(leads.id, leadId));

    // Flood / bot-loop signals.
    const inbound = all.filter((m) => m.direction === 'in');
    const tenMinutesAgo = deps.clock.now().getTime() - 10 * 60_000;
    const lastThree = inbound.slice(-3).map((m) => m.body.trim().toLowerCase());
    const flooding =
      inbound.filter((m) => m.occurredAt.getTime() >= tenMinutesAgo).length > FLOOD_LIMIT ||
      (lastThree.length === 3 && lastThree[0] !== '' && lastThree.every((b) => b === lastThree[0]));

    return {
      lead: { ...lead, language },
      config: active.config,
      all,
      conversation: conversation ?? null,
      unanswered,
      inboundText,
      firstContact: inbound.length === unanswered.length,
      flooding,
      answers,
      spentUsd: Number(spend?.total ?? 0),
      tenantSpendUsd,
      resources,
      paused: account?.status === 'paused',
      appointment,
      appointments: apptList,
      staleAnswers,
      pastVisits,
      daysSinceBefore,
    };
  });

  if (!ctx) return { status: 'skipped', reason: 'lead or config not found' };
  if (ctx.paused) return { status: 'skipped', reason: 'account paused' };
  const { lead, config, unanswered } = ctx;
  if (lead.state === 'opted_out') return { status: 'skipped', reason: 'opted out' };
  if (lead.aiPaused) return { status: 'skipped', reason: 'human takeover' };
  const lastInbound = unanswered.at(-1);
  if (!lastInbound) return { status: 'skipped', reason: 'nothing to answer' };

  const tool = { deps, tenantId, leadId, config, resources: ctx.resources };
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
    // In the customer's own language when the clinic wrote that version; English otherwise.
    const text =
      (lead.language === 'hi' ? safety.emergency_response_i18n?.hi : undefined) ??
      (lead.language === 'hinglish' ? safety.emergency_response_i18n?.hinglish : undefined) ??
      safety.emergency_response;
    await reply(fillVariables(text, { business_name: config.brand.business_name }), 'emergency');
    await escalate(tool, 'emergency keywords');
    return { status: 'escalated', reason: 'emergency' };
  }
  // Quick-reply buttons with a fixed meaning are handled in code, not by the model.
  let buttonNote: string | null = null;
  const payload = (lastInbound.payload as { buttonPayload?: string } | null)?.buttonPayload;
  const button = payload ? parseButtonPayload(payload) : null;
  if (button) {
    const aboutAppointment = ['reminder_24h', 'reminder_2h', 'booking_confirmed'].includes(button.key);
    if (button.buttonId === 'call') {
      await escalate(tool, 'lead asked for a call');
      await reply('Sure — someone from our team will call you shortly.', 'button');
      return { status: 'escalated', reason: 'call requested' };
    }
    if (
      (button.key === 'appointment_change' && button.buttonId === 'times') ||
      (button.key === 'cancellation' && button.buttonId === 'rebook')
    ) {
      // Rebooking after a cancellation: same service, similar time of day if possible.
      const old = await withTenant(deps.db, tenantId, (tx) => lastCancelledAppointment(tx, leadId));
      const service = old?.service ?? config.booking.services[0]?.name ?? '';
      const hour = old ? Number(localParts(old.startsAt, config.locale.timezone).time.slice(0, 2)) : 12;
      const prefer = hour < 12 ? 'morning' : hour < 16 ? 'afternoon' : 'evening';
      const { slots } = await findSlots(deps, tenantId, { service, prefer });
      if (!slots.length) {
        await escalate(tool, 'no free times to rebook after a cancellation');
        await reply(
          "I'm sorry, I couldn't find a free time right now. Someone from our team will call you to sort it out.",
          'button',
        );
        return { status: 'escalated', reason: 'no slots to rebook' };
      }
      await withTenant(deps.db, tenantId, (tx) =>
        transitionLeadIfAllowed(tx, leadId, { type: 'SLOTS_OFFERED' }),
      );
      await reply(
        `Here are the next free times for your ${service}: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join(', ')}. Which one suits you?`,
        'button',
      );
      return { status: 'replied', reason: 'rebooking offered' };
    }
    if (aboutAppointment && !ctx.appointments.length && button.buttonId !== 'reschedule') {
      await reply("I couldn't find an upcoming appointment for you. Would you like to book one?", 'button');
      return { status: 'replied' };
    }
    if (aboutAppointment) {
      // The button says which appointment it was about; without that (older messages) it is unambiguous only if they have one.
      const target = button.appointmentId
        ? ctx.appointments.find((a) => a.id === button.appointmentId)
        : ctx.appointments.length === 1
          ? ctx.appointments[0]
          : undefined;
      if (button.buttonId === 'reschedule' || !target) {
        buttonNote = target
          ? `They tapped "${button.buttonId}" on: ${target.label}`
          : `They tapped "${button.buttonId}" on an appointment reminder, but it is not clear which appointment (they may have several, or that one was already changed). Ask which one they mean.`;
      } else {
        try {
          if (button.buttonId === 'cancel') {
            // The cancellation message itself is sent by the appointment-notify job.
            await updateAppointment(deps, tenantId, target.id, 'cancelled', {
              cancelReason: 'customer',
              byCustomer: true,
            });
            return { status: 'replied', reason: 'cancelled by button' };
          }
          if (button.buttonId === 'confirm') {
            await updateAppointment(deps, tenantId, target.id, 'lead_confirmed');
            await reply(`Thanks for confirming! See you on ${target.label}.`, 'button');
            return { status: 'replied', reason: 'confirmed by button' };
          }
        } catch (err) {
          if (!(err instanceof BookingError)) throw err;
          if (err.code === 'too_late') {
            await escalate(tool, 'customer tried to cancel inside the notice window');
            await reply(
              `Sorry, ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)} A team member will contact you shortly.`,
              'button',
            );
            return { status: 'escalated', reason: 'too late to cancel' };
          }
          await reply(
            button.buttonId === 'confirm' && target.label.includes('pending')
              ? 'Thanks! Your booking is still waiting for the team to confirm — we will message you shortly.'
              : 'Thanks — noted.',
            'button',
          );
          return { status: 'replied', reason: err.code };
        }
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

  // Not a real enquiry (tagged earlier): stay quiet; staff still see it in the inbox.
  if (lead.notALead) return { status: 'skipped', reason: `not a lead (${lead.notALead})` };

  // Floods and other bots' auto-replies: hand over once instead of replying to every message.
  if (ctx.flooding) {
    await escalate(tool, 'flood of messages or the same message repeated');
    await reply(holding, 'holding');
    return { status: 'escalated', reason: 'flood' };
  }

  // Media without text: a warm fixed reply (and a heads-up to staff), no AI.
  const textless = unanswered.every((m) => mediaOf(m) && m.body.startsWith('['));
  if (textless) {
    const media = mediaOf(lastInbound)!;
    const r = mediaResponse(media, lead.language, config.qualification.safety.no_medical_advice);
    if (r.alertStaff)
      await withTenant(deps.db, tenantId, (tx) =>
        alertStaff(tx, deps, tenantId, leadId, media === 'audio' ? 'sent a voice note' : `sent a ${media}`),
      );
    if (!r.reply) return { status: 'skipped', reason: `${media} needs no reply` };
    await reply(r.reply, 'media');
    return { status: 'replied', reason: `media: ${media}` };
  }
  if (unanswered.every((m) => isEmojiOnly(m.body) || mediaOf(m) === 'sticker'))
    return { status: 'skipped', reason: 'emoji only' };

  // Is this a real enquiry? Obvious junk on any message; the classifier on a WhatsApp-first contact.
  const junk = await screenForJunk(deps, tenantId, leadId, ctx);
  if (junk) {
    await withTenant(deps.db, tenantId, async (tx) => {
      await tx.update(leads).set({ notALead: junk }).where(eq(leads.id, leadId));
      await transitionLeadIfAllowed(tx, leadId, { type: 'DISQUALIFIED' });
      await emit(tx, deps.clock, 'lead.not_a_lead', { leadId, category: junk });
    });
    const line = notALeadReply(junk, config.brand.business_name, lead.language);
    if (!line) return { status: 'skipped', reason: `not a lead (${junk})` };
    await reply(line, 'not-a-lead');
    return { status: 'replied', reason: `not a lead (${junk})` };
  }

  await showTyping(deps, tenantId, lastInbound.providerMessageId);

  let chain: LlmProvider[];
  try {
    chain = deps.router.chain('agent_reply', config);
  } catch (err) {
    if (err instanceof NoModelAvailableError) return handover('no AI model available');
    throw err;
  }

  const memory = await conversationMemory(deps, tenantId, leadId, config, ctx.all, ctx.conversation);
  // Facts the reply may use: the clinic's knowledge, unless the clinic answers questions itself (FAQ autonomy).
  const knowledgeText =
    autonomyOf(config, 'faq') === 'auto'
      ? config.qualification.knowledge.map((k) => `${k.title}: ${k.content}`).join('\n')
      : '';
  const allowedUrls = [config.sequences.review_request.google_review_link ?? ''].filter(Boolean);

  const scored = scoreLead(config.qualification, ctx.answers);
  const system = buildSystemPrompt(config);
  const tools = buildTools(config, ctx.resources);
  const state: Turn = {
    role: 'system',
    text: stateMessage({
      now: deps.clock.now().toLocaleString('en-IN', { timeZone: config.locale.timezone }),
      openNow: openingStatus(config, deps.clock.now()),
      name: lead.name,
      language: lead.language,
      answers: ctx.answers,
      missing: scored.status === 'incomplete' ? scored.missing : [],
      status: displayStatus(lead),
      appointments: ctx.appointments.map((a) => a.label),
      pastVisits: ctx.pastVisits,
      staleAnswers: ctx.staleAnswers,
      daysSinceLastContact: ctx.daysSinceBefore,
      buttonNote,
      resources: ctx.resources,
    }),
  };

  /** One model drives the whole turn (bounded tool loop). Throws LlmError to fail over. */
  const converse = async (llm: LlmProvider, fallbackUsed: boolean): Promise<TurnResult> => {
    const request: LlmRequest = {
      task: 'agent_reply',
      system,
      tools,
      turns: [
        ...(memory.summary
          ? [{ role: 'system' as const, text: `Summary of the earlier conversation: ${memory.summary}` }]
          : []),
        ...toConversation(memory.recent),
        state,
      ],
      maxTokens: 1024,
      effort: 'low', // short, fast WhatsApp replies
    };
    let answers = ctx.answers;
    let invalidCalls = 0;
    let repaired = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      const sc = scoreLead(config.qualification, answers);
      const hints: TurnHints = {
        config,
        answers,
        missing: sc.status === 'incomplete' ? sc.missing : [],
        lastInbound: ctx.inboundText,
        status: displayStatus(lead),
        appointment: ctx.appointment,
        resources: ctx.resources,
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
        const text = cleanReply(response.text);

        // Hard rules on every reply. One repair attempt, then a safe hand-over: nothing unchecked is sent.
        const sources = [
          knowledgeText,
          ...request.turns.flatMap((t) => (t.role === 'tool_results' ? t.results.map((r) => r.content) : [])),
        ].join('\n');
        const problems = checkReply(text, {
          sources,
          allowedUrls,
          noMedicalAdvice: config.qualification.safety.no_medical_advice,
          language: lead.language,
        });
        if (problems.length) {
          await recordViolations(deps, tenantId, response.runId, problems);
          if (repaired) return handover(`reply failed safety checks: ${problems.join('; ')}`);
          repaired = true;
          request.turns.push(
            { role: 'assistant', text: response.text, toolCalls: [], raw: response.raw },
            {
              role: 'system',
              text: `Your last reply was NOT sent: it ${problems.join('; ')}. Write a new reply to the customer that follows the rules (only facts from KNOWLEDGE or tool results; no medicines; reply in the customer's language). Reply with the message only.`,
            },
          );
          continue;
        }

        // A newer message arrived while we were thinking: the queued turn answers everything together.
        const fresh = await withTenant(deps.db, tenantId, async (tx) => ({
          lead: (await tx.select().from(leads).where(eq(leads.id, leadId)))[0],
          newer: (
            await tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.leadId, leadId),
                  eq(messages.direction, 'in'),
                  gte(messages.occurredAt, lastInbound.occurredAt),
                ),
              )
          ).filter((m) => !ctx.all.some((seenMsg) => seenMsg.id === m.id)), // arrived after this turn loaded
        }));
        if (fresh.newer.length)
          return { status: 'skipped', reason: 'newer message arrived; the next turn answers it' };

        // Saying the same thing again means we're stuck: bring in a person instead.
        const recentOut = ctx.all.filter((m) => m.direction === 'out').slice(-2);
        if (recentOut.some((m) => sameReply(m.body, text)))
          return handover('conversation stuck (same reply again)');

        const sent = await reply(text);
        return {
          status: fresh.lead?.aiPaused ? 'escalated' : 'replied',
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

type StoredMessage = { direction: 'in' | 'out'; body: string; payload: Record<string, unknown> | null };

const mediaOf = (m: { payload: Record<string, unknown> | null }) =>
  (m.payload?.mediaType as MediaType | undefined) ?? null;

/** Stored messages -> alternating user/assistant turns (providers need a user turn first). Customer text is redacted. */
function toConversation(history: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of history) {
    const prev = turns.at(-1);
    if (m.direction === 'in') {
      const media = mediaOf(m);
      const body = redact(
        media ? (m.body.startsWith('[') ? `(sent a ${media})` : `(sent a ${media}) ${m.body}`) : m.body,
      );
      if (prev?.role === 'user') prev.text += `\n${body}`;
      else turns.push({ role: 'user', text: body });
    } else if (prev?.role === 'assistant') prev.text += `\n${m.body}`;
    else turns.push({ role: 'assistant', text: m.body, toolCalls: [] });
  }
  if (turns[0]?.role === 'assistant')
    turns.unshift({ role: 'user', text: '(The customer submitted an enquiry form.)' });
  return turns;
}

const IntentSchema = z.strictObject({
  category: z.enum(['genuine', ...NOT_A_LEAD]),
  confidence: z.number().min(0).max(1),
});

/**
 * Not a real enquiry? Obvious cases (auto-replies, link spam) on any message; the
 * intent_classify model only on the first messages of a WhatsApp-first contact. Anything that
 * sounds like a customer, or a classifier that isn't sure (< 0.8), counts as genuine.
 */
async function screenForJunk(
  deps: AssistantDeps,
  tenantId: string,
  leadId: string,
  ctx: { lead: { source: string }; config: TenantConfig; inboundText: string; firstContact: boolean },
): Promise<NotALead | null> {
  const text = ctx.inboundText;
  const serviceWords = ctx.config.booking.services.map((s) => s.name);
  const obvious = ruleBasedIntent(text);
  if (obvious.category !== 'genuine' && obvious.confidence >= 0.95 && !hasCustomerSignal(text, serviceWords))
    return obvious.category;
  if (!ctx.firstContact || !['whatsapp', 'click_to_whatsapp'].includes(ctx.lead.source)) return null;
  if (hasCustomerSignal(text, serviceWords)) return null;
  // "hi", "hello?", "ok": too little to judge, and a greeting is how most real enquiries start.
  if (text.split(/\s+/).filter(Boolean).length < 4) return null;
  try {
    const out = await runStructured(
      deps,
      ctx.config,
      {
        task: 'intent_classify',
        system: `You screen the first WhatsApp message(s) sent to ${ctx.config.brand.business_name}, which offers: ${serviceWords.join(', ')}. Classify the sender:
- genuine: a possible customer (any question about services, prices, timings, location, booking, a problem or symptom, a greeting, or anything unclear)
- wrong_number: says they reached the wrong number or didn't mean to message
- vendor: selling services or products to the business (marketing, SEO, software, supplies, partnerships)
- job_seeker: asking for a job or internship
- spam: scams, links, money offers, unrelated promotions
- auto_reply: an automated message from another business's system
When in doubt, choose genuine. Confidence is your probability (0-1) that the category is right.`,
        turns: [{ role: 'user', text: redact(text) }],
        maxTokens: 200,
        output: { name: 'intent', schema: jsonSchema(IntentSchema) },
      },
      IntentSchema,
      { tenantId, leadId, promptVersion: 'intent-v1' },
    );
    return out.category !== 'genuine' && out.confidence >= 0.8 ? out.category : null;
  } catch {
    return null; // the classifier is a filter, never a gate: on any failure, treat as genuine
  }
}

const SummarySchema = z.strictObject({ summary: z.string().max(2000) });
const SUMMARIZE_AFTER = 40; // messages
const KEEP_RECENT = 30;
const RESUMMARIZE_EVERY = 20;

/**
 * Long conversations: older messages are folded into a short summary (memory_summarize task),
 * refreshed every 20 messages; the model then sees the summary plus the last 30 messages.
 */
async function conversationMemory(
  deps: AssistantDeps,
  tenantId: string,
  leadId: string,
  config: TenantConfig,
  all: (StoredMessage & { occurredAt: Date })[],
  conversation: { summary: string | null; summaryUpTo: Date | null } | null,
): Promise<{ summary: string | null; recent: StoredMessage[] }> {
  if (all.length <= SUMMARIZE_AFTER) return { summary: null, recent: all };
  const older = all.slice(0, -KEEP_RECENT);
  const recent = all.slice(-KEEP_RECENT);
  const upTo = older.at(-1)!.occurredAt;
  const unsummarized = conversation?.summaryUpTo
    ? older.filter((m) => m.occurredAt > conversation.summaryUpTo!).length
    : older.length;
  if (conversation?.summary && unsummarized < RESUMMARIZE_EVERY)
    return { summary: conversation.summary, recent };
  try {
    const transcript = older
      .map(
        (m) =>
          `${m.direction === 'in' ? 'Customer' : 'Assistant'}: ${m.direction === 'in' ? redact(m.body) : m.body}`,
      )
      .join('\n');
    const { summary } = await runStructured(
      deps,
      config,
      {
        task: 'memory_summarize',
        system:
          'Summarise this WhatsApp conversation between a customer and a business assistant in under 120 words: what the customer wants, facts they gave (no phone numbers or emails), what was offered or agreed, and anything still open.',
        turns: [{ role: 'user', text: transcript }],
        maxTokens: 400,
        output: { name: 'summary', schema: jsonSchema(SummarySchema) },
      },
      SummarySchema,
      { tenantId, leadId, promptVersion: 'summary-v1' },
    );
    await withTenant(deps.db, tenantId, (tx) =>
      tx.update(conversations).set({ summary, summaryUpTo: upTo }).where(eq(conversations.leadId, leadId)),
    );
    return { summary, recent };
  } catch {
    return { summary: conversation?.summary ?? null, recent }; // fall back to the last known summary
  }
}

async function recordViolations(deps: AssistantDeps, tenantId: string, runId: string, problems: string[]) {
  await withTenant(deps.db, tenantId, (tx) =>
    tx.update(llmRuns).set({ guardViolations: problems }).where(eq(llmRuns.id, runId)),
  );
}
