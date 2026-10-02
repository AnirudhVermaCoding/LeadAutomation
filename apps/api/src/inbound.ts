import { parseButtonPayload } from '@instantlead/config';
import { isOptOutMessage, windowExpiresAt } from '@instantlead/core';
import type { MediaType, Referral } from '@instantlead/integrations';
import { normalizeInbound } from './assistant/guard.ts';
import { eq } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Db } from './db/client.ts';
import { conversations, leads, messages, type MessageStatus } from './db/schema.ts';
import { QUEUES } from './jobs.ts';
import { emit, intakeLead, optOut, transitionLead, type LeadDeps } from './leads.ts';

export interface InboundMessage {
  provider: 'meta' | 'fake';
  providerMessageId: string;
  from: string; // E.164
  text: string;
  buttonPayload?: string | undefined;
  mediaType?: MediaType | undefined;
  referral?: Referral | undefined;
  profileName?: string | undefined;
}

class DuplicateMessage extends Error {}

export const CONVERSATION_CONSENT_TEXT =
  'The lead started this WhatsApp conversation; replies are limited to this conversation and its purpose.';

/**
 * A lead's WhatsApp message (webhook or demo sandbox). Idempotent on providerMessageId:
 * Meta retries webhooks, so the same message may arrive more than once.
 */
export async function handleInboundMessage(
  deps: LeadDeps & { db: Db },
  tenantId: string,
  msg: InboundMessage,
) {
  try {
    return await withTenant(deps.db, tenantId, async (tx) => {
      const [dup] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.providerMessageId, msg.providerMessageId));
      if (dup) throw new DuplicateMessage();

      const active = await getActiveConfig(tx);
      if (!active) throw new Error('tenant has no config');
      const now = deps.clock.now();
      const text = normalizeInbound(msg.text);

      // A lead who messages first needs no template: their message opens the service window
      // and counts as consent for this conversation.
      const { leadId } = await intakeLead(tx, deps, tenantId, {
        phone: msg.from,
        name: msg.profileName,
        source: msg.referral ? 'click_to_whatsapp' : 'whatsapp',
        sourceDetails: msg.referral ? { referral: msg.referral } : undefined,
        consent: {
          source: 'whatsapp_inbound',
          noticeText: CONVERSATION_CONSENT_TEXT,
          evidence: { providerMessageId: msg.providerMessageId },
          onlyIfNew: true,
        },
      });
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      if (!lead) throw new Error('lead vanished');

      const [inserted] = await tx
        .insert(messages)
        .values({
          leadId,
          direction: 'in',
          kind: msg.buttonPayload
            ? 'button_reply'
            : msg.mediaType
              ? 'media'
              : text.startsWith('[')
                ? 'unsupported'
                : 'text',
          body: text,
          payload:
            msg.buttonPayload || msg.referral || msg.mediaType
              ? { buttonPayload: msg.buttonPayload, referral: msg.referral, mediaType: msg.mediaType }
              : null,
          provider: msg.provider,
          providerMessageId: msg.providerMessageId,
          status: 'received',
          occurredAt: now,
        })
        .onConflictDoNothing({ target: messages.providerMessageId })
        .returning({ id: messages.id });
      if (!inserted) throw new DuplicateMessage(); // concurrent delivery of the same webhook

      await tx
        .insert(conversations)
        .values({ leadId, lastInboundAt: now, windowExpiresAt: windowExpiresAt(now) })
        .onConflictDoUpdate({
          target: conversations.leadId,
          set: { lastInboundAt: now, windowExpiresAt: windowExpiresAt(now) },
        });

      const button = msg.buttonPayload ? parseButtonPayload(msg.buttonPayload) : null;
      const optingOut =
        button?.buttonId === 'stop' || isOptOutMessage(text, active.config.intake.opt_out_keywords);

      if (lead.state === 'opted_out')
        return { leadId, messageId: inserted.id, action: 'ignored_opted_out' } as const;
      if (optingOut) {
        await optOut(tx, deps, tenantId, lead, button ? 'button' : 'keyword');
        return { leadId, messageId: inserted.id, action: 'opted_out' } as const;
      }
      // A reaction (👍 on our message) is not a reply to answer.
      if (msg.mediaType === 'reaction')
        return { leadId, messageId: inserted.id, action: 'recorded' } as const;
      const status = await transitionLead(tx, leadId, { type: 'LEAD_REPLIED' });
      // Debounce ~3 s so a burst of messages gets one reply; skipped while a human has taken over.
      if (!status.aiPaused)
        await deps.enqueue(
          tx,
          QUEUES.assistantTurn,
          { tenantId, leadId },
          { singletonKey: leadId, startAfter: 3 },
        );
      await emit(tx, deps.clock, 'lead.replied', {
        leadId,
        messageId: inserted.id,
        buttonPayload: msg.buttonPayload ?? null,
      });
      return { leadId, messageId: inserted.id, action: 'recorded' } as const;
    });
  } catch (err) {
    if (err instanceof DuplicateMessage) return { action: 'duplicate' } as const;
    throw err;
  }
}

const RANK: Record<MessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
  received: 0,
};

/** Delivery status callback. Never moves a message backwards (webhooks can arrive out of order). */
export async function handleStatusUpdate(
  deps: { db: Db },
  tenantId: string,
  update: {
    providerMessageId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    errors?:
      { code?: number | undefined; title?: string | undefined; message?: string | undefined }[] | undefined;
    pricingCategory?: string | undefined;
  },
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: messages.id, status: messages.status, payload: messages.payload })
      .from(messages)
      .where(eq(messages.providerMessageId, update.providerMessageId));
    if (!row) return false;
    // A message that was read can't later "fail"; otherwise failures win.
    const advance =
      update.status === 'failed' ? row.status !== 'read' : RANK[update.status] > RANK[row.status];
    if (!advance) return false;
    const first = update.errors?.[0];
    await tx
      .update(messages)
      .set({
        status: update.status,
        error: first ? { code: first.code, message: first.message ?? first.title ?? 'failed' } : undefined,
        payload: update.pricingCategory
          ? { ...row.payload, pricingCategory: update.pricingCategory }
          : undefined,
      })
      .where(eq(messages.id, row.id));
    return true;
  });
}
