import {
  buttonPayload,
  renderTemplateBody,
  TEMPLATES,
  type TemplateKey,
  type TemplateLanguage,
  type TenantConfig,
} from '@instantlead/config';
import { chooseOutbound, isWindowOpen, OutsideServiceWindowError } from '@instantlead/core';
import {
  ChannelError,
  createMetaCloudChannel,
  type MessagingChannel,
  type OutboundContent,
} from '@instantlead/integrations';
import { and, eq } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Db, type TenantTx, type Tx } from './db/client.ts';
import { conversations, leads, messages, templates, tenants } from './db/schema.ts';
import { isSuppressed, type LeadDeps } from './leads.ts';
import { getTenantSecret } from './secrets.ts';

export interface MessagingDeps extends LeadDeps {
  db: Db;
  /** Used when a tenant has no WhatsApp credentials (mock mode). */
  fakeChannel: MessagingChannel;
  allowFakeChannel: boolean;
  fetch?: typeof globalThis.fetch;
}

// ponytail: Meta's India per-template rates as estimates (INR); refresh from Meta's rate card.
// Utility templates and free-form messages inside an open service window are free.
const TEMPLATE_COST_INR = { marketing: 0.8631, utility: 0.115 } as const;

/** Meta Cloud API when the tenant has connected WhatsApp, otherwise the fake channel (if allowed). */
/** Blue ticks + "typing…" on the lead's message while the assistant works on a reply. Best effort. */
export async function showTyping(deps: MessagingDeps, tenantId: string, providerMessageId: string | null) {
  if (!providerMessageId) return;
  const channel = await withTenant(deps.db, tenantId, (tx) => channelFor(tx, deps, tenantId));
  await channel.markRead(providerMessageId).catch(() => undefined);
}

export async function channelFor(tx: Tx, deps: MessagingDeps, tenantId: string): Promise<MessagingChannel> {
  const [tenant] = await tx.select({ phoneNumberId: tenants.waPhoneNumberId }).from(tenants);
  const token = await getTenantSecret(tx, deps.secretsKey, tenantId, 'whatsapp_access_token');
  if (tenant?.phoneNumberId && token)
    return createMetaCloudChannel({
      accessToken: token,
      phoneNumberId: tenant.phoneNumberId,
      fetch: deps.fetch,
    });
  if (deps.allowFakeChannel) return deps.fakeChannel;
  throw new ChannelError('WhatsApp is not connected for this tenant', { retryable: false });
}

const templateLanguage = (lang: string | null | undefined): TemplateLanguage => (lang === 'hi' ? 'hi' : 'en');

function variableValue(
  name: string,
  lead: { name: string | null },
  config: TenantConfig,
  lang: TemplateLanguage,
) {
  switch (name) {
    case 'first_name':
      return lead.name?.trim().split(/\s+/)[0] || (lang === 'hi' ? 'जी' : 'there');
    case 'business_name':
      return config.brand.business_name;
    case 'assistant_name':
      return config.brand.assistant_name;
    case 'review_link':
      return config.sequences.review_request.google_review_link ?? '';
    default:
      return '';
  }
}

export interface SendRequest {
  leadId: string;
  /** Unique per tenant; a retry with the same key never sends twice once a send succeeded. */
  idempotencyKey: string;
  template?: { key: TemplateKey; values?: Record<string, string> };
  freeForm?: Extract<OutboundContent, { kind: 'text' | 'buttons' }>;
  /** Runs in the same transaction that records a successful send (e.g. lead state change). */
  onSent?: (tx: TenantTx) => Promise<void>;
}

export type SendResult =
  | { status: 'sent'; messageId: string; providerMessageId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; messageId?: string; reason: string };

/**
 * The only way a message reaches a lead. Enforces opt-out, the 24 h window (template vs
 * free-form, refusing anything else) and template approval; records every attempt.
 * Throws only for retryable channel errors, so job retries handle transient outages.
 */
export async function sendToLead(
  deps: MessagingDeps,
  tenantId: string,
  req: SendRequest,
): Promise<SendResult> {
  const prepared = await withTenant(deps.db, tenantId, async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, req.leadId));
    if (!lead) return { kind: 'skip', reason: 'lead not found' } as const;
    if (lead.state === 'opted_out' || (await isSuppressed(tx, deps, tenantId, lead.phoneE164)))
      return { kind: 'skip', reason: 'opted out' } as const;

    const [previous] = await tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(eq(messages.idempotencyKey, req.idempotencyKey));
    if (previous && !['queued', 'failed'].includes(previous.status))
      return { kind: 'skip', reason: 'already sent' } as const;

    const active = await getActiveConfig(tx);
    if (!active) throw new Error('tenant has no config');
    const config = active.config;
    const [conv] = await tx
      .select({ windowExpiresAt: conversations.windowExpiresAt })
      .from(conversations)
      .where(eq(conversations.leadId, lead.id));
    const windowExpires = conv?.windowExpiresAt ?? null;
    const now = deps.clock.now();

    const record = async (
      fields: Omit<typeof messages.$inferInsert, 'leadId' | 'direction' | 'occurredAt'>,
    ) => {
      const values = { ...fields, leadId: lead.id, direction: 'out' as const, occurredAt: now };
      const [row] = await tx
        .insert(messages)
        .values(values)
        .onConflictDoUpdate({ target: [messages.tenantId, messages.idempotencyKey], set: values })
        .returning({ id: messages.id });
      if (!row) throw new Error('message insert failed');
      return row.id;
    };

    let choice;
    try {
      choice = chooseOutbound({ windowExpires, now, freeForm: req.freeForm, template: req.template });
    } catch (err) {
      if (!(err instanceof OutsideServiceWindowError)) throw err;
      const id = await record({
        kind: 'text',
        body: req.freeForm?.body ?? '',
        idempotencyKey: req.idempotencyKey,
        status: 'failed',
        error: { message: err.message },
      });
      return { kind: 'fail', reason: err.message, messageId: id } as const;
    }

    const channel = await channelFor(tx, deps, tenantId);

    if (choice.kind === 'free_form') {
      const content = choice.content;
      const messageId = await record({
        kind: content.kind,
        body: content.body,
        payload: content.kind === 'buttons' ? { buttons: content.buttons } : null,
        provider: channel.provider,
        idempotencyKey: req.idempotencyKey,
        status: 'queued',
        estCostInr: 0,
      });
      return { kind: 'send', messageId, channel, to: lead.phoneE164, content } as const;
    }

    const { key, values: overrides = {} } = choice.template;
    const def = TEMPLATES[key];
    const lang = templateLanguage(lead.language ?? config.brand.default_language);
    const rows = await tx
      .select()
      .from(templates)
      .where(and(eq(templates.key, key)));
    const row = rows.find((r) => r.language === lang) ?? rows.find((r) => r.language === 'en');
    const language = (row?.language ?? lang) as TemplateLanguage;
    const values = def.variables.map((v) => overrides[v] ?? variableValue(v, lead, config, language));
    const base = {
      kind: 'template' as const,
      body: renderTemplateBody(key, language, values),
      templateKey: key,
      templateCategory: def.category,
      // Kept so the inbox and demo sandbox can show (and tap) the quick-reply buttons.
      payload: {
        buttons: (def.buttons as readonly { id: string; text: Record<string, string> }[]).map((b) => ({
          id: buttonPayload(key, b.id),
          title: b.text[language] ?? b.text.en ?? b.id,
        })),
      },
      language,
      provider: channel.provider,
      idempotencyKey: req.idempotencyKey,
      estCostInr:
        def.category === 'utility' && isWindowOpen(windowExpires, now) ? 0 : TEMPLATE_COST_INR[def.category],
    };
    if (channel.provider === 'meta' && row?.status !== 'approved') {
      const reason = `Template ${row?.providerName ?? def.providerName} (${language}) is not approved yet`;
      const messageId = await record({ ...base, status: 'failed', error: { message: reason } });
      return { kind: 'fail', reason, messageId } as const;
    }
    const content: OutboundContent = {
      kind: 'template',
      name: row?.providerName ?? def.providerName,
      language,
      bodyParams: values,
      buttonPayloads: def.buttons.map((b) => buttonPayload(key, b.id)),
    };
    const messageId = await record({ ...base, status: 'queued' });
    return { kind: 'send', messageId, channel, to: lead.phoneE164, content } as const;
  });

  if (prepared.kind === 'skip') return { status: 'skipped', reason: prepared.reason };
  if (prepared.kind === 'fail')
    return { status: 'failed', reason: prepared.reason, messageId: prepared.messageId };

  // Network call outside any transaction.
  // ponytail: a crash between send and the update below can re-send on retry (at-least-once).
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await prepared.channel.send(prepared.to, prepared.content));
  } catch (err) {
    const error =
      err instanceof ChannelError ? { code: err.code, message: err.message } : { message: String(err) };
    await withTenant(deps.db, tenantId, (tx) =>
      tx.update(messages).set({ status: 'failed', error }).where(eq(messages.id, prepared.messageId)),
    );
    if (err instanceof ChannelError && !err.retryable)
      return { status: 'failed', reason: err.message, messageId: prepared.messageId };
    throw err;
  }

  await withTenant(deps.db, tenantId, async (tx) => {
    await tx
      .update(messages)
      .set({ status: 'sent', providerMessageId, error: null, occurredAt: deps.clock.now() })
      .where(eq(messages.id, prepared.messageId));
    await req.onSent?.(tx);
  });
  return { status: 'sent', messageId: prepared.messageId, providerMessageId };
}
