import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromWaId } from '@instantlead/core';
import { z } from 'zod';

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw request body). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GET verification handshake: echo hub.challenge when the verify token matches. */
export function metaVerificationChallenge(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verifyToken
    ? String(query['hub.challenge'] ?? '')
    : null;
}

export interface Referral {
  sourceType?: string;
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  ctwaClid?: string;
}

export type MetaEvent =
  | {
      type: 'message';
      phoneNumberId: string;
      from: string; // E.164
      providerMessageId: string;
      timestamp: Date;
      profileName?: string;
      /** Text body, a media caption, or a placeholder like "[image]". */
      text: string;
      /** Set for non-text messages (photo, voice note, sticker…). Captions arrive in text. */
      mediaType?: MediaType;
      /** Quick-reply payload (template button) or interactive reply id. */
      buttonPayload?: string;
      referral?: Referral;
    }
  | {
      type: 'status';
      phoneNumberId: string;
      providerMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      timestamp: Date;
      errors?: { code?: number; title?: string; message?: string }[];
      pricingCategory?: string;
      billable?: boolean;
    }
  | { type: 'leadgen'; pageId: string; leadgenId: string; formId?: string };

/** WhatsApp message types we answer specially (voice notes arrive as audio). */
export const MEDIA_TYPES = [
  'image',
  'video',
  'document',
  'audio',
  'sticker',
  'location',
  'contacts',
  'reaction',
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const Caption = z.looseObject({ caption: z.string().optional() }).optional();

// Lenient schemas: only what we use, unknown fields ignored.
const Message = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: Caption,
  video: Caption,
  document: Caption,
  reaction: z.looseObject({ emoji: z.string().optional() }).optional(),
  button: z.looseObject({ payload: z.string(), text: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  referral: z
    .looseObject({
      source_type: z.string().optional(),
      source_id: z.string().optional(),
      source_url: z.string().optional(),
      headline: z.string().optional(),
      ctwa_clid: z.string().optional(),
    })
    .optional(),
});
const Status = z.looseObject({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.string(),
  errors: z
    .array(
      z.looseObject({
        code: z.number().optional(),
        title: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
  pricing: z.looseObject({ category: z.string().optional(), billable: z.boolean().optional() }).optional(),
});
const MessagesValue = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }),
  contacts: z.array(z.looseObject({ profile: z.looseObject({ name: z.string() }).optional() })).optional(),
  messages: z.array(Message).optional(),
  statuses: z.array(Status).optional(),
});
const LeadgenValue = z.looseObject({
  leadgen_id: z.union([z.string(), z.number()]),
  page_id: z.union([z.string(), z.number()]),
  form_id: z.union([z.string(), z.number()]).optional(),
});
const Payload = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({ changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).default([]) }),
  ),
});

const toDate = (unixSeconds: string) => new Date(Number(unixSeconds) * 1000);

function messageEvent(
  phoneNumberId: string,
  m: z.infer<typeof Message>,
  profileName?: string,
): MetaEvent | null {
  const from = fromWaId(m.from);
  if (!from) return null;
  const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
  const r = m.referral;
  return {
    type: 'message',
    phoneNumberId,
    from,
    providerMessageId: m.id,
    timestamp: toDate(m.timestamp),
    profileName,
    text:
      m.text?.body ??
      m.button?.text ??
      reply?.title ??
      m.image?.caption ??
      m.video?.caption ??
      m.document?.caption ??
      m.reaction?.emoji ??
      `[${m.type}]`,
    mediaType: (MEDIA_TYPES as readonly string[]).includes(m.type) ? (m.type as MediaType) : undefined,
    buttonPayload: m.button?.payload ?? reply?.id,
    referral: r && {
      sourceType: r.source_type,
      sourceId: r.source_id,
      sourceUrl: r.source_url,
      headline: r.headline,
      ctwaClid: r.ctwa_clid,
    },
  };
}

/** Flatten a WhatsApp or Page (leadgen) webhook into the events we act on. Throws on a malformed envelope. */
export function parseMetaWebhook(body: unknown): MetaEvent[] {
  const payload = Payload.parse(body);
  const events: MetaEvent[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field === 'messages') {
        const v = MessagesValue.safeParse(change.value);
        if (!v.success) continue;
        const phoneNumberId = v.data.metadata.phone_number_id;
        const profileName = v.data.contacts?.[0]?.profile?.name;
        for (const m of v.data.messages ?? []) {
          const e = messageEvent(phoneNumberId, m, profileName);
          if (e) events.push(e);
        }
        for (const s of v.data.statuses ?? [])
          events.push({
            type: 'status',
            phoneNumberId,
            providerMessageId: s.id,
            status: s.status,
            timestamp: toDate(s.timestamp),
            errors: s.errors,
            pricingCategory: s.pricing?.category,
            billable: s.pricing?.billable,
          });
      } else if (change.field === 'leadgen') {
        const v = LeadgenValue.safeParse(change.value);
        if (v.success)
          events.push({
            type: 'leadgen',
            pageId: String(v.data.page_id),
            leadgenId: String(v.data.leadgen_id),
            formId: v.data.form_id === undefined ? undefined : String(v.data.form_id),
          });
      }
    }
  }
  return events;
}
