import { createHmac } from 'node:crypto';
import type { Language } from '@instantlead/config';
import {
  InvalidTransitionError,
  toE164,
  transition,
  type Clock,
  type LeadEvent,
  type LeadStatus,
} from '@instantlead/core';
import { and, eq } from 'drizzle-orm';
import type { TenantTx, Tx } from './db/client.ts';
import { consents, events, leads, suppressions, type LeadSource } from './db/schema.ts';
import { QUEUES, type Enqueue } from './jobs.ts';
import type { SecretsKey } from './secrets.ts';
import { stopEnrollments, stopOnLeadEvent } from './sequences.ts';

export interface LeadDeps {
  clock: Clock;
  secretsKey: SecretsKey;
  /** Keys the opt-out phone hashes. Stable: never rotated with SECRETS_KEY. */
  hashKey: Buffer;
  enqueue: Enqueue;
}

export class IntakeError extends Error {}

/** Keyed hash: Indian phone numbers are too few for a plain hash to hide them. */
export const hashPhone = (key: Buffer, tenantId: string, e164: string) =>
  createHmac('sha256', key).update(`${tenantId}:${e164}`).digest('hex');

export async function emit(tx: Tx, clock: Clock, type: string, payload: Record<string, unknown>) {
  const leadId = typeof payload.leadId === 'string' ? payload.leadId : null;
  await tx.insert(events).values({ type, payload, leadId, occurredAt: clock.now() });
}

export async function isSuppressed(tx: Tx, deps: LeadDeps, tenantId: string, e164: string) {
  const [row] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.phoneHash, hashPhone(deps.hashKey, tenantId, e164)));
  return Boolean(row);
}

/** Apply a state-machine event to a stored lead (row-locked). Returns the new status. */
export async function transitionLead(tx: Tx, leadId: string, event: LeadEvent): Promise<LeadStatus> {
  const [lead] = await tx
    .select({ state: leads.state, tier: leads.tier, aiPaused: leads.aiPaused })
    .from(leads)
    .where(eq(leads.id, leadId))
    .for('update');
  if (!lead) throw new Error(`lead ${leadId} not found`);
  const next = transition(lead, event);
  if (next.state !== lead.state || next.tier !== lead.tier || next.aiPaused !== lead.aiPaused)
    await tx.update(leads).set(next).where(eq(leads.id, leadId));
  await stopOnLeadEvent(tx, leadId, event.type);
  return next;
}

/** Opt-out always wins: suppress the phone for this tenant and move the lead to opted_out. */
export async function optOut(
  tx: Tx,
  deps: LeadDeps,
  tenantId: string,
  lead: { id: string; phoneE164: string },
  reason: 'keyword' | 'button' | 'manual' | 'provider',
) {
  await tx
    .insert(suppressions)
    .values({
      phoneHash: hashPhone(deps.hashKey, tenantId, lead.phoneE164),
      reason,
      optedOutAt: deps.clock.now(),
    })
    .onConflictDoNothing();
  await transitionLead(tx, lead.id, { type: 'OPTED_OUT' });
  await emit(tx, deps.clock, 'lead.opted_out', { leadId: lead.id, reason });
}

/**
 * The customer asked to hear from the business again (or staff recorded that they did): lift the
 * suppression, record fresh consent with the evidence, and restart as a new conversation.
 */
export async function optIn(
  tx: Tx,
  deps: LeadDeps,
  tenantId: string,
  lead: { id: string; phoneE164: string },
  consent: { source: string; noticeText: string; evidence: Record<string, unknown> },
) {
  await tx
    .delete(suppressions)
    .where(eq(suppressions.phoneHash, hashPhone(deps.hashKey, tenantId, lead.phoneE164)));
  await transitionLead(tx, lead.id, { type: 'OPTED_IN' });
  await tx.insert(consents).values({ leadId: lead.id, ...consent, grantedAt: deps.clock.now() });
  await emit(tx, deps.clock, 'lead.opted_in', { leadId: lead.id, source: consent.source });
}

/**
 * WhatsApp says this customer stopped marketing messages (error 131050 on a send, or the
 * user_preferences webhook). Marketing-category templates and the follow-up / review sequences stop;
 * utility messages (reminders, confirmations) and replies inside a chat they started are unaffected.
 */
export async function setMarketingOptOut(
  tx: Tx,
  deps: Pick<LeadDeps, 'clock'>,
  leadId: string,
  optedOut: boolean,
  reason: string,
) {
  const [lead] = await tx
    .update(leads)
    .set({ marketingOptOutAt: optedOut ? deps.clock.now() : null })
    .where(eq(leads.id, leadId))
    .returning({ id: leads.id });
  if (!lead) return;
  if (optedOut) await stopEnrollments(tx, leadId, ['followup', 'review_request'], 'marketing_opt_out');
  await emit(tx, deps.clock, optedOut ? 'lead.marketing_opted_out' : 'lead.marketing_opted_in', {
    leadId,
    reason,
  });
}

export interface IntakeInput {
  phone: string;
  name?: string | undefined;
  email?: string | undefined;
  language?: Language | undefined;
  source: LeadSource;
  sourceDetails?: Record<string, unknown> | undefined;
  consent: {
    source: string;
    noticeText: string;
    evidence: Record<string, unknown>;
    /** Conversation consent (lead messaged first) is recorded once, not per message. */
    onlyIfNew?: boolean;
  };
}

/**
 * Every intake path (API, hosted form, Lead Ads, CSV) ends here. Dedupes by E.164 phone,
 * records consent evidence, and — for a new, non-suppressed lead — enqueues the instant
 * first reply in the same transaction.
 */
export async function intakeLead(tx: TenantTx, deps: LeadDeps, tenantId: string, input: IntakeInput) {
  const phone = toE164(input.phone);
  if (!phone) throw new IntakeError(`"${input.phone}" is not a valid phone number`);
  const now = deps.clock.now();
  const suppressed = await isSuppressed(tx, deps, tenantId, phone);

  const [existing] = await tx
    .select({ id: leads.id, name: leads.name, email: leads.email, language: leads.language })
    .from(leads)
    .where(eq(leads.phoneE164, phone));

  let leadId: string;
  let created = false;
  if (existing) {
    leadId = existing.id;
    // Fill gaps only; never overwrite what the lead told us before.
    await tx
      .update(leads)
      .set({
        name: existing.name ?? input.name ?? null,
        email: existing.email ?? input.email ?? null,
        language: existing.language ?? input.language ?? null,
      })
      .where(and(eq(leads.id, existing.id)));
  } else {
    const [row] = await tx
      .insert(leads)
      .values({
        phoneE164: phone,
        name: input.name ?? null,
        email: input.email ?? null,
        language: input.language ?? null,
        source: input.source,
        sourceDetails: input.sourceDetails ?? null,
        state: suppressed ? 'opted_out' : 'new',
        receivedAt: now,
      })
      .returning({ id: leads.id });
    if (!row) throw new Error('lead insert failed');
    leadId = row.id;
    created = true;
  }

  if (created || !input.consent.onlyIfNew)
    await tx.insert(consents).values({
      leadId,
      source: input.consent.source,
      noticeText: input.consent.noticeText,
      evidence: input.consent.evidence,
      grantedAt: now,
    });

  if (created) {
    await emit(tx, deps.clock, 'lead.created', { leadId, source: input.source });
    if (!suppressed && input.source !== 'click_to_whatsapp' && input.source !== 'whatsapp')
      await deps.enqueue(tx, QUEUES.firstReply, { tenantId, leadId });
  }
  return { leadId, created, suppressed };
}

/** Like transitionLead, but a no-op when the lead has already moved on (e.g. replied before the send finished). */
export async function transitionLeadIfAllowed(tx: Tx, leadId: string, event: LeadEvent) {
  try {
    return await transitionLead(tx, leadId, event);
  } catch (err) {
    if (err instanceof InvalidTransitionError) return null;
    throw err;
  }
}
