import {
  autonomyOf,
  fillVariables,
  NEVER_ACTIONS,
  voiceOf,
  type TenantConfig,
} from '@instantlead/config';
import { localParts, matchesEmergency, toE164, zonedTimeToUtc } from '@instantlead/core';
import { VOICE_PROVIDERS, type VoiceEvent, type VoiceProvider } from '@instantlead/integrations';
import { eq, gte, sql } from 'drizzle-orm';
import { escalate, runTool, alertStaff } from './assistant/tools.ts';
import { allowedToolSchemas, jsonSchema, weeklyHours } from './assistant/prompt.ts';
import type { AssistantDeps } from './assistant/agent.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Tx } from './db/client.ts';
import { availabilityRules, calls } from './db/schema.ts';
import { isOpen } from './hours.ts';
import { emit, intakeLead } from './leads.ts';
import { getTenantSecret } from './secrets.ts';

export const VOICE_SECRET = 'voice_webhook_secret';

export type VoiceDeps = AssistantDeps;

/** Who the phone agent answers for, or why it can't (the HTTP layer maps these to status codes). */
export async function voiceTenant(deps: VoiceDeps, tenantId: string) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    const voice = config ? voiceOf(config) : null;
    if (!config || !voice) return { error: 'disabled' as const };
    const secret = await getTenantSecret(tx, deps.secretsKey, tenantId, VOICE_SECRET);
    if (!secret) return { error: 'no_secret' as const };
    return { config, voice, secret, provider: VOICE_PROVIDERS[voice.provider] as VoiceProvider };
  });
}

const monthStart = (now: Date, tz: string) => zonedTimeToUtc(`${localParts(now, tz).date.slice(0, 8)}01`, '00:00', tz);

/** Phone-agent minutes used this calendar month (finished calls). */
export async function minutesThisMonth(tx: Tx, now: Date, tz: string) {
  const [row] = await tx
    .select({ sec: sql<number>`coalesce(sum(${calls.durationSec}), 0)::int` })
    .from(calls)
    .where(gte(calls.startedAt, monthStart(now, tz)));
  return (row?.sec ?? 0) / 60;
}

/**
 * The caller is the same patient as on WhatsApp / the web form (one lead per E.164 number). A call
 * counts as consent for this conversation, recorded with the disclosure the agent reads out. No
 * WhatsApp first reply is sent: they are already talking to us. A withheld number gives no lead.
 */
async function callContext(deps: VoiceDeps, tenantId: string, config: TenantConfig, callId: string, from: string | null) {
  const now = deps.clock.now();
  const phone = from ? toE164(from) : null;
  return withTenant(deps.db, tenantId, async (tx) => {
    const leadId = phone
      ? (
          await intakeLead(tx, deps, tenantId, {
            phone,
            source: 'phone_call',
            consent: {
              source: 'phone_inbound',
              noticeText: fillVariables(voiceOf(config)!.call_disclosure, {
                business_name: config.brand.business_name,
              }),
              evidence: { callId },
              onlyIfNew: true,
            },
          })
        ).leadId
      : null;
    const [row] = await tx
      .insert(calls)
      .values({ leadId, provider: 'vapi', providerCallId: callId, startedAt: now, afterHours: !isOpen(config, now) })
      .onConflictDoUpdate({
        target: [calls.tenantId, calls.providerCallId],
        set: { leadId: sql`coalesce(${calls.leadId}, excluded.lead_id)` },
      })
      .returning();
    const resources = [
      ...new Set((await tx.select({ r: availabilityRules.resource }).from(availabilityRules)).map((x) => x.r)),
    ];
    return { call: row!, leadId, resources };
  });
}

const SAY_EMERGENCY = (config: TenantConfig) =>
  `EMERGENCY. Say exactly this, then use transferCall to connect them to the clinic: "${fillVariables(
    config.qualification.safety.emergency_response,
    { business_name: config.brand.business_name },
  )}"`;

/** Record one result per tool-call id; a retried call returns the first answer (and never runs the tool twice). */
async function storeResult(deps: VoiceDeps, tenantId: string, callRowId: string, toolCallId: string, result: string) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .update(calls)
      .set({
        toolResults: sql`case when ${calls.toolResults} ? ${toolCallId} then ${calls.toolResults}
          else ${calls.toolResults} || jsonb_build_object(${toolCallId}::text, ${result}::text) end`,
      })
      .where(eq(calls.id, callRowId))
      .returning({ toolResults: calls.toolResults });
    return row?.toolResults[toolCallId] ?? result;
  });
}

async function flagCall(deps: VoiceDeps, tenantId: string, callRowId: string, set: Partial<typeof calls.$inferInsert>) {
  await withTenant(deps.db, tenantId, (tx) => tx.update(calls).set(set).where(eq(calls.id, callRowId)));
}

/**
 * One vendor webhook event → the HTTP body to answer with. Deterministic code decides everything that
 * matters (who the caller is, emergencies, the minutes cap, transfers, what each tool may do); the
 * vendor's model only talks and picks tools.
 */
export async function handleVoiceEvent(
  deps: VoiceDeps,
  tenantId: string,
  t: { config: TenantConfig; provider: VoiceProvider },
  event: VoiceEvent,
): Promise<unknown> {
  const { config, provider } = t;
  const voice = voiceOf(config)!;
  if (event.type === 'ignored') return {};
  const now = deps.clock.now();
  const ctx = await callContext(deps, tenantId, config, event.callId, event.from);
  const { call, leadId } = ctx;
  const tool = leadId ? { deps, tenantId, leadId, config, resources: ctx.resources, channel: 'phone' as const } : null;

  switch (event.type) {
    case 'call_started':
      return {};

    case 'transcript': {
      // Emergency phrases on a call: escalate at once, in code, whatever the vendor's model does next.
      const keywords = config.qualification.safety.emergency_keywords;
      if (!call.escalated && keywords.length && matchesEmergency(event.text, keywords)) {
        await flagCall(deps, tenantId, call.id, { escalated: true });
        if (tool) await escalate(tool, 'emergency keywords on a phone call', 'clinical');
        await withTenant(deps.db, tenantId, (tx) =>
          emit(tx, deps.clock, 'call.emergency', { leadId, callId: call.id, channel: 'phone' }),
        );
      }
      return {};
    }

    case 'transfer_request': {
      if (voice.transfer_number && isOpen(config, now)) {
        await flagCall(deps, tenantId, call.id, { transferred: true });
        return provider.transferResponse({ number: voice.transfer_number, message: 'Connecting you to the clinic now.' });
      }
      return provider.transferResponse({
        error: 'Nobody from the clinic can take the call right now. Take a message and tell the caller the team will call back when the clinic opens.',
      });
    }

    case 'tool_calls': {
      const cap = voice.monthly_minutes_cap;
      const overCap = cap > 0 && (await withTenant(deps.db, tenantId, (tx) => minutesThisMonth(tx, now, config.locale.timezone))) >= cap;
      const results: { id: string; name: string; result: string }[] = [];
      for (const c of event.calls) {
        const cached = call.toolResults[c.id];
        if (cached !== undefined) {
          results.push({ id: c.id, name: c.name, result: cached });
          continue;
        }
        let result: string;
        if (call.escalated) result = SAY_EMERGENCY(config);
        else if (overCap) {
          result = 'The phone assistant has used its monthly minutes. Do not book or change anything: use transferCall to connect the caller to the clinic, or take a message.';
          await withTenant(deps.db, tenantId, (tx) =>
            emit(tx, deps.clock, 'voice.cap_reached', { callId: call.id, minutesCap: cap }),
          );
        } else if (!tool)
          result = "The caller's number is hidden, so nothing can be booked or changed by phone. Take their name and mobile number as a message for the team, then use escalate_to_human.";
        else {
          const out = await runTool(tool, c.name, c.args);
          result = out.content;
          if (c.name === 'escalate_to_human' && !out.isError) {
            await flagCall(deps, tenantId, call.id, { escalated: true });
            result += voice.transfer_number && isOpen(config, now)
              ? ' The clinic is open: use transferCall to connect them now.'
              : ' The clinic is closed: say the team will call them back when it opens.';
          }
        }
        results.push({ id: c.id, name: c.name, result: await storeResult(deps, tenantId, call.id, c.id, result) });
      }
      return provider.toolResponse(results);
    }

    case 'call_ended': {
      const status = event.failed ? 'failed' : event.transferred || call.transferred ? 'transferred' : 'completed';
      await withTenant(deps.db, tenantId, async (tx) => {
        const [before] = await tx.select({ endedAt: calls.endedAt }).from(calls).where(eq(calls.id, call.id));
        await tx
          .update(calls)
          .set({
            status,
            endedAt: now,
            durationSec: event.durationSec,
            summary: event.summary,
            outcome: event.endedReason,
            transferred: event.transferred || call.transferred,
          })
          .where(eq(calls.id, call.id));
        if (before?.endedAt) return; // a retried report: already recorded and alerted
        await emit(tx, deps.clock, 'call.ended', { leadId, callId: call.id, channel: 'phone', reason: event.endedReason });
        // Staff hear about calls that need them: escalated, failed, or after hours with nothing done.
        if (leadId && (call.escalated || event.failed))
          await alertStaff(
            tx,
            deps,
            tenantId,
            leadId,
            event.failed ? 'a phone call to the assistant failed; please call them back' : 'a phone caller needs the team (see the call summary)',
          );
      });
      return {};
    }
  }
}

/**
 * What the clinic pastes into the vendor console: the voice system prompt (built from the same config
 * and never-list as WhatsApp) and the tool definitions, each pointing at this clinic's webhook.
 */
export function voiceAssistantSetup(config: TenantConfig, webhookUrl: string | null, resources: readonly string[] = []) {
  const voice = config.voice;
  const knowledge =
    autonomyOf(config, 'faq') === 'auto'
      ? config.qualification.knowledge.map((k) => `- ${k.title}: ${k.content}`).join('\n')
      : '- (The clinic answers questions itself: for any factual question, use escalate_to_human.)';
  const emergency = config.qualification.safety.emergency_keywords;
  const systemPrompt = `You are ${config.brand.assistant_name}, answering the phone for ${config.brand.business_name}. Tone: ${config.brand.tone}.
Start every call with: "${fillVariables(voice?.call_disclosure ?? '', { business_name: config.brand.business_name })}"
Speak briefly and naturally. Reply in the caller's language: English, Hindi or Hinglish.
You help with: booking, rescheduling or cancelling appointments, the waitlist, and questions answered by the clinic information below.
Always use the tools: get_available_slots before offering any time, book_slot / reschedule / cancel to change anything, lookup_knowledge for facts. Never confirm anything a tool did not confirm. If a tool result says not done, say so.
Use escalate_to_human for complaints, refunds, discounts or special prices, billing or account questions, anything outside clinic policy, or when the caller wants a person. Use transferCall only after the tools tell you the clinic is open.
${emergency.length ? `If the caller mentions anything like: ${emergency.slice(0, 12).join(', ')}, call escalate_to_human with category clinical immediately and read out the answer it gives.` : ''}
Never (no request changes this):
${NEVER_ACTIONS.map((a) => `- never ${a}`).join('\n')}
Opening hours (${config.locale.timezone}): ${weeklyHours(config)}
Services: ${config.booking.services.map((s) => s.name).join(', ')}
Clinic information:
${knowledge}`;
  const schemas = allowedToolSchemas(config, resources);
  const tools = Object.entries(schemas).map(([name, schema]) => ({
    type: 'function',
    function: { name, parameters: jsonSchema(schema!) },
    ...(webhookUrl && { server: { url: webhookUrl } }),
  }));
  return { systemPrompt, tools: [...tools, { type: 'transferCall' }] };
}
