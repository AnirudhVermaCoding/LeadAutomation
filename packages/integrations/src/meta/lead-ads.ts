import { ChannelError } from '../channel.ts';
import { GRAPH_BASE_URL, GRAPH_VERSION, type Fetch } from './graph.ts';

export interface MetaLead {
  phone?: string;
  name?: string;
  email?: string;
  formId?: string;
  createdTime?: string;
  /** All submitted fields, lower-cased names -> first value. */
  fields: Record<string, string>;
}

/** Fetch a Lead Ads submission by leadgen_id (needs a Page access token with leads_retrieval). */
export async function fetchMetaLead(opts: {
  leadgenId: string;
  pageAccessToken: string;
  fetch?: Fetch;
  baseUrl?: string;
}): Promise<MetaLead> {
  const url = new URL(
    `${opts.baseUrl ?? GRAPH_BASE_URL}/${GRAPH_VERSION}/${encodeURIComponent(opts.leadgenId)}`,
  );
  url.searchParams.set('fields', 'field_data,created_time,form_id');
  const res = await (opts.fetch ?? globalThis.fetch)(url, {
    headers: { authorization: `Bearer ${opts.pageAccessToken}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((err: unknown) => {
    throw new ChannelError(`Lead fetch failed: ${String(err)}`, { retryable: true });
  });
  const json = (await res.json().catch(() => ({}))) as {
    field_data?: { name: string; values?: string[] }[];
    created_time?: string;
    form_id?: string;
    error?: { code?: number; message?: string };
  };
  if (!res.ok || !json.field_data)
    throw new ChannelError(`Lead fetch error: ${json.error?.message ?? `HTTP ${res.status}`}`, {
      code: json.error?.code,
      retryable: res.status === 429 || res.status >= 500,
    });

  const fields = Object.fromEntries(json.field_data.map((f) => [f.name.toLowerCase(), f.values?.[0] ?? '']));
  const first = (...names: string[]) => names.map((n) => fields[n]).find((v) => v?.trim());
  const name =
    first('full_name', 'name') ??
    ([fields.first_name, fields.last_name].filter(Boolean).join(' ') || undefined);
  return {
    phone: first('phone_number', 'phone', 'mobile_number', 'whatsapp_number'),
    name,
    email: first('email', 'email_address'),
    formId: json.form_id,
    createdTime: json.created_time,
    fields,
  };
}
