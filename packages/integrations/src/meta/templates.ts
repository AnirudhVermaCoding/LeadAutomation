import { ChannelError } from '../channel.ts';
import { GRAPH_BASE_URL, GRAPH_VERSION, type Fetch } from './graph.ts';

export interface MetaTemplate {
  name: string;
  /** Meta's code, e.g. `en`, `en_US`, `hi`. */
  language: string;
  /** APPROVED, PENDING, REJECTED, PAUSED, DISABLED, … */
  status: string;
  category: string;
}

/** Every message template on a WhatsApp Business Account, following pagination (needs `whatsapp_business_management`). */
export async function listMessageTemplates(opts: {
  wabaId: string;
  accessToken: string;
  fetch?: Fetch;
  baseUrl?: string;
}): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let next: string | null =
    `${opts.baseUrl ?? GRAPH_BASE_URL}/${GRAPH_VERSION}/${encodeURIComponent(opts.wabaId)}/message_templates?fields=name,language,status,category&limit=200`;
  for (let page = 0; next && page < 20; page++) {
    const res: Response = await (opts.fetch ?? globalThis.fetch)(next, {
      headers: { authorization: `Bearer ${opts.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }).catch((err: unknown) => {
      throw new ChannelError(`Template list failed: ${String(err)}`, { retryable: true });
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: MetaTemplate[];
      paging?: { next?: string };
      error?: { code?: number; message?: string };
    };
    if (!res.ok || !json.data)
      throw new ChannelError(`Template list error: ${json.error?.message ?? `HTTP ${res.status}`}`, {
        code: json.error?.code,
        retryable: res.status === 429 || res.status >= 500,
      });
    out.push(
      ...json.data.map(({ name, language, status, category }) => ({ name, language, status, category })),
    );
    next = json.paging?.next ?? null;
  }
  return out;
}
