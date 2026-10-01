import { toWaId } from '@instantlead/core';
import { ChannelError, type MessagingChannel, type OutboundContent } from '../channel.ts';
import { GRAPH_BASE_URL, GRAPH_VERSION, type Fetch } from './graph.ts';

// Error codes that will not succeed on retry.
// 131047: outside the 24 h window · 131026: undeliverable · 131050: user stopped marketing messages
// 132000-132015: template problems · 100: invalid parameter · 190: bad/expired token
const PERMANENT = new Set([100, 131026, 131047, 131050, 131051, 190]);
const isPermanent = (code: number | undefined) =>
  code !== undefined && (PERMANENT.has(code) || (code >= 132000 && code <= 132015));

export function buildMessageBody(to: string, content: OutboundContent) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to) };
  switch (content.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: content.body, preview_url: false } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.body },
          action: {
            buttons: content.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
          },
        },
      };
    case 'template': {
      const components: object[] = [];
      if (content.bodyParams.length)
        components.push({
          type: 'body',
          parameters: content.bodyParams.map((text) => ({ type: 'text', text })),
        });
      content.buttonPayloads.forEach((payload, i) =>
        components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(i),
          parameters: [{ type: 'payload', payload }],
        }),
      );
      return {
        ...base,
        type: 'template',
        template: { name: content.name, language: { code: content.language }, components },
      };
    }
  }
}

interface GraphResponse {
  messages?: { id: string }[];
  error?: { code?: number; message?: string; error_data?: { details?: string } };
}

/** WhatsApp Cloud API (Meta direct). */
export function createMetaCloudChannel(opts: {
  accessToken: string;
  phoneNumberId: string;
  fetch?: Fetch;
  baseUrl?: string;
}): MessagingChannel {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = `${opts.baseUrl ?? GRAPH_BASE_URL}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;

  return {
    provider: 'meta',
    async send(to, content) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(buildMessageBody(to, content)),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new ChannelError(`WhatsApp request failed: ${String(err)}`, { retryable: true });
      }
      const json = (await res.json().catch(() => ({}))) as GraphResponse;
      const id = json.messages?.[0]?.id;
      if (res.ok && id) return { providerMessageId: id };

      const code = json.error?.code;
      const detail = json.error?.error_data?.details ?? json.error?.message ?? `HTTP ${res.status}`;
      throw new ChannelError(`WhatsApp error${code ? ` ${code}` : ''}: ${detail}`, {
        code,
        retryable:
          !isPermanent(code) &&
          (res.status === 429 || res.status >= 500 || code === 130429 || code === 131000),
      });
    },
  };
}

/** Check credentials without sending anything: read the phone number's details. */
export async function verifyWhatsAppNumber(opts: {
  accessToken: string;
  phoneNumberId: string;
  fetch?: Fetch;
  baseUrl?: string;
}): Promise<{ displayPhoneNumber?: string; verifiedName?: string; qualityRating?: string }> {
  const url = new URL(
    `${opts.baseUrl ?? GRAPH_BASE_URL}/${GRAPH_VERSION}/${encodeURIComponent(opts.phoneNumberId)}`,
  );
  url.searchParams.set('fields', 'display_phone_number,verified_name,quality_rating');
  const res = await (opts.fetch ?? globalThis.fetch)(url, {
    headers: { authorization: `Bearer ${opts.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    error?: { code?: number; message?: string };
  };
  if (!res.ok)
    throw new ChannelError(`WhatsApp check failed: ${json.error?.message ?? `HTTP ${res.status}`}`, {
      code: json.error?.code,
      retryable: res.status >= 500,
    });
  return {
    displayPhoneNumber: json.display_phone_number,
    verifiedName: json.verified_name,
    qualityRating: json.quality_rating,
  };
}
