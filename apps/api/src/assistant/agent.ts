import { fillVariables } from '@instantlead/config';
import { detectLanguage, displayStatus, formatSlot, matchesEmergency, scoreLead } from '@instantlead/core';
import { Anthropic, llmCostUsd, type LlmProvider, type LlmRequest } from '@instantlead/integrations';
import { asc, eq, sum } from 'drizzle-orm';
import { getActiveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import { leads, llmRuns, messages } from '../db/schema.ts';
import { sendToLead, type MessagingDeps } from '../outbound.ts';
import type { TurnHints } from './fake-llm.ts';
import { buildSystemPrompt, buildTools, stateMessage } from './prompt.ts';
import { activeAppointment } from '../booking.ts';
import { escalate, loadAnswers, runTool } from './tools.ts';

export interface AssistantDeps extends MessagingDeps {
  llm: LlmProvider;
  /** Per-lead LLM spend ceiling; above it the conversation goes to staff. */
  llmCostCapUsd: number;
}

const MAX_STEPS = 6; // model calls per turn
const HISTORY = 40; // messages of context

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
      appointment,
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
  if (ctx.spentUsd >= deps.llmCostCapUsd) {
    await escalate(tool, 'LLM cost cap reached');
    await reply(holding, 'holding');
    return { status: 'escalated', reason: 'cost cap' };
  }

  const scored = scoreLead(config.qualification, ctx.answers);
  const request: LlmRequest = {
    max_tokens: 1024,
    // Sonnet 5.5: no extended thinking, low effort — short, fast WhatsApp replies.
    thinking: { type: 'between_tools' },
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: buildSystemPrompt(config), cache_control: { type: 'ephemeral' } }],
    tools: buildTools(config),
    messages: [
      ...toConversation(ctx.history),
      {
        role: 'system',
        content: stateMessage({
          now: deps.clock.now().toLocaleString('en-IN', { timeZone: config.locale.timezone }),
          name: lead.name,
          language: lead.language,
          answers: ctx.answers,
          missing: scored.status === 'incomplete' ? scored.missing : [],
          status: displayStatus(lead),
          appointment: ctx.appointment?.label ?? null,
        }),
      } as unknown as Anthropic.MessageParam,
    ],
  };

  try {
    let answers = ctx.answers;
    for (let step = 0; step < MAX_STEPS; step++) {
      const hints: TurnHints = {
        config,
        answers,
        missing: (() => {
          const s = scoreLead(config.qualification, answers);
          return s.status === 'incomplete' ? s.missing : [];
        })(),
        lastInbound: ctx.inboundText,
        status: displayStatus(lead),
        appointment: ctx.appointment,
      };
      const response = await callModel(deps, tenantId, leadId, request, hints);

      if (response.stop_reason === 'refusal') {
        await escalate(tool, `model declined (${response.stop_details?.category ?? 'unknown'})`);
        await reply(holding, 'holding');
        return { status: 'escalated', reason: 'refusal' };
      }

      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !calls.length) {
        const body = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text.trim())
          .join('\n')
          .trim();
        const fresh = await withTenant(deps.db, tenantId, (tx) =>
          tx.select().from(leads).where(eq(leads.id, leadId)),
        );
        if (!body) return { status: 'skipped', reason: 'model returned no text' };
        const sent = await reply(body);
        return {
          status: fresh[0]?.aiPaused ? 'escalated' : 'replied',
          messageId: 'messageId' in sent ? sent.messageId : undefined,
        };
      }

      // Append-only: the assistant turn goes back unchanged (thinking blocks included), then all results in one message.
      request.messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const out = await runTool(tool, call.name, call.input);
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: out.content,
          is_error: out.isError,
        });
      }
      request.messages.push({ role: 'user', content: results });
      answers = await withTenant(deps.db, tenantId, (tx) => loadAnswers(tx, leadId));
    }
    await escalate(tool, 'assistant did not finish within the step limit');
    await reply(holding, 'holding');
    return { status: 'escalated', reason: 'step limit' };
  } catch (err) {
    // Requests that will never succeed (bad request, auth): hand to staff instead of retrying.
    if (
      err instanceof Anthropic.APIError &&
      err.status !== undefined &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 408 &&
      err.status !== 429
    ) {
      await escalate(tool, `assistant error ${err.status}`);
      await reply(holding, 'holding');
      return { status: 'escalated', reason: `api error ${err.status}` };
    }
    throw err; // transient: the job retries
  }
}

/** Stored messages -> alternating user/assistant turns (the API needs a user turn first). */
function toConversation(history: { direction: 'in' | 'out'; body: string }[]): Anthropic.MessageParam[] {
  const turns: Anthropic.MessageParam[] = [];
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const prev = turns.at(-1);
    if (prev?.role === role) prev.content = `${String(prev.content)}\n${m.body}`;
    else turns.push({ role, content: m.body });
  }
  if (turns[0]?.role === 'assistant')
    turns.unshift({ role: 'user', content: '(The customer submitted an enquiry form.)' });
  return turns;
}

async function callModel(
  deps: AssistantDeps,
  tenantId: string,
  leadId: string,
  request: LlmRequest,
  hints: TurnHints,
) {
  const started = performance.now();
  const record = (fields: Partial<typeof llmRuns.$inferInsert>) =>
    withTenant(deps.db, tenantId, (tx) =>
      tx.insert(llmRuns).values({
        leadId,
        provider: deps.llm.name,
        model: deps.llm.model,
        latencyMs: Math.round(performance.now() - started),
        occurredAt: deps.clock.now(),
        ...fields,
      }),
    );
  try {
    const response = await deps.llm.complete(request, hints);
    const u = response.usage;
    await record({
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: llmCostUsd(deps.llm.model, u),
      stopReason: response.stop_reason,
      providerRequestId: response.id,
    });
    return response;
  } catch (err) {
    await record({ error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    throw err;
  }
}
