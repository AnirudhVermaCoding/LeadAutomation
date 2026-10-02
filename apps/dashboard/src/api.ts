import type { TenantConfig } from '@instantlead/config';

export type { TenantConfig };

const TENANT_KEY = 'instantlead.tenant';

/** Agency admins pick a tenant (sent as x-tenant-id); client users are pinned server-side. */
export const tenantSelection = {
  get: () => {
    try {
      return localStorage.getItem(TENANT_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string | null) => {
    try {
      if (id) localStorage.setItem(TENANT_KEY, id);
      else localStorage.removeItem(TENANT_KEY);
    } catch {
      /* private mode: selection lasts for this page only */
    }
  },
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? `Request failed (${status})`));
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const tenant = tenantSelection.get();
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(tenant ? { 'x-tenant-id': tenant } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (json ?? {}) as Record<string, unknown>);
  return json as T;
}

// ---- Response shapes (what the API returns; kept minimal) ----

export type Role = 'agency_admin' | 'client_admin' | 'client_staff';
export interface Me {
  principal: { kind: 'user'; userId: string; role: Role; tenantId: string | null };
}
export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export type LeadState =
  | 'new'
  | 'contacted'
  | 'qualifying'
  | 'qualified'
  | 'disqualified'
  | 'booking_offered'
  | 'booked'
  | 'confirmed'
  | 'completed'
  | 'no_show'
  | 'nurturing'
  | 'unresponsive'
  | 'opted_out';

export interface InboxRow {
  id: string;
  name: string | null;
  phone: string;
  source: string;
  state: LeadState;
  tier: 'hot' | 'warm' | 'cold' | null;
  score: number | null;
  aiPaused: boolean;
  /** Tagged as not a real enquiry (spam, vendor, wrong number…). */
  notALead: 'wrong_number' | 'vendor' | 'job_seeker' | 'spam' | 'auto_reply' | null;
  receivedAt: string;
  lastInboundAt: string | null;
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  kind: string;
  body: string;
  templateKey: string | null;
  status: string;
  provider: string | null;
  payload: { buttons?: { id: string; title: string }[]; buttonPayload?: string } | null;
  error: { message: string } | null;
  occurredAt: string;
}

export interface Appointment {
  id: string;
  leadId: string;
  leadName?: string | null;
  leadPhone?: string;
  service: string;
  resource: string;
  startsAt: string;
  endsAt: string;
  status: 'pending' | 'scheduled' | 'confirmed' | 'completed' | 'no_show' | 'cancelled' | 'lapsed';
  /** Who the visit is for when it is not the person who booked (a child). */
  attendeeName?: string | null;
}

export interface LeadDetail {
  lead: InboxRow & { email: string | null; language: string | null; phoneE164: string };
  conversation: { windowExpiresAt: string | null } | null;
  answers: { key: string; value: string }[];
  appointment: Appointment | null;
  messages: Message[];
}

export interface Slot {
  date: string;
  time: string;
  label: string;
}
