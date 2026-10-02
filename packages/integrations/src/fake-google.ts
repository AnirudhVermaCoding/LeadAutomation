import { randomUUID } from 'node:crypto';
import { createGoogleCalendar, type CalendarProvider, type GoogleOAuthClient } from './calendar.ts';

interface RawEvent {
  id: string;
  seq: number;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  transparency?: string;
  eventType?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

export interface FakeChannel {
  id: string;
  calendarId: string;
  resourceId: string;
  token: string;
  address: string;
  expiration: number;
}

export interface ExternalEventSpec {
  id?: string;
  calendarId?: string;
  start: Date | string; // a Date (timed) or a YYYY-MM-DD string (all-day)
  end: Date | string;
  status?: 'confirmed' | 'tentative';
  transparency?: 'opaque' | 'transparent';
  declinedBySelf?: boolean;
  eventType?: string;
  summary?: string;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * In-memory Google (OAuth token endpoint + Calendar API v3 subset) behind an injectable `fetch`.
 * Tests and mock mode run the real `createGoogleCalendar` against it, so the HTTP code is
 * exercised too. Models what we depend on: sync tokens and 410, deleted events as tombstones,
 * push channels, a revoked refresh token, and injected failures.
 */
export class FakeGoogle {
  readonly events = new Map<string, Map<string, RawEvent>>();
  readonly calendars = new Map<string, { summary: string; primary: boolean }>([
    ['primary', { summary: 'Primary', primary: true }],
  ]);
  readonly channels = new Map<string, FakeChannel>();
  /** Every Calendar API call, for assertions ("did we hit Google before booking?"). */
  readonly requests: { method: string; path: string; query: URLSearchParams }[] = [];
  revoked = false;
  /** false = the granted scopes don't include calendarList (403 on the picker). */
  calendarListAllowed = true;
  /** Events per list page (small values test pagination). */
  pageSize = 250;
  private seq = 0;
  private goneBelow = 0;
  private forced: { status: number; reason: string }[] = [];
  private messageNumber = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- test helpers ----

  /** Someone creates an event in Google Calendar (not through us). Returns its id. */
  addExternalEvent(spec: ExternalEventSpec) {
    const id = spec.id ?? `ext-${randomUUID().slice(0, 8)}`;
    const point = (v: Date | string) => (v instanceof Date ? { dateTime: v.toISOString() } : { date: v });
    this.put(spec.calendarId ?? 'primary', {
      id,
      status: spec.status ?? 'confirmed',
      summary: spec.summary ?? 'Busy',
      transparency: spec.transparency ?? 'opaque',
      ...(spec.eventType ? { eventType: spec.eventType } : {}),
      start: point(spec.start),
      end: point(spec.end),
      ...(spec.declinedBySelf ? { attendees: [{ self: true, responseStatus: 'declined' }] } : {}),
    });
    return id;
  }

  /** Move or edit an existing event. */
  updateExternalEvent(
    calendarId: string,
    id: string,
    patch: Partial<Pick<ExternalEventSpec, 'start' | 'end'>>,
  ) {
    const ev = this.events.get(calendarId)?.get(id);
    if (!ev) throw new Error(`no event ${id}`);
    const point = (v: Date | string) => (v instanceof Date ? { dateTime: v.toISOString() } : { date: v });
    this.put(calendarId, {
      ...ev,
      ...(patch.start ? { start: point(patch.start) } : {}),
      ...(patch.end ? { end: point(patch.end) } : {}),
    });
  }

  /** Staff delete an event in Google: incremental sync reports it as cancelled. */
  deleteExternalEvent(calendarId: string, id: string) {
    const ev = this.events.get(calendarId)?.get(id);
    if (ev) this.put(calendarId, { ...ev, status: 'cancelled' });
  }

  /** Every stored sync token now answers 410, like after an ACL change or token expiry. */
  expireSyncTokens() {
    this.goneBelow = this.seq + 1;
  }

  /** The next Calendar API call fails with this status (reason is Google's `errors[0].reason`). */
  failNext(status: number, reason = 'backendError') {
    this.forced.push({ status, reason });
  }

  addCalendar(id: string, summary: string) {
    this.calendars.set(id, { summary, primary: false });
  }

  /** Headers Google would send for a change on `channelId`. */
  notification(channelId: string, state: 'exists' | 'sync' = 'exists') {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`no channel ${channelId}`);
    return {
      'x-goog-channel-id': ch.id,
      'x-goog-channel-token': ch.token,
      'x-goog-resource-id': ch.resourceId,
      'x-goog-resource-state': state,
      'x-goog-message-number': String(++this.messageNumber),
    };
  }

  /** Non-deleted events on a calendar, for assertions. */
  live(calendarId = 'primary') {
    return [...(this.events.get(calendarId)?.values() ?? [])].filter((e) => e.status !== 'cancelled');
  }

  private put(calendarId: string, ev: Omit<RawEvent, 'seq'> | RawEvent) {
    if (!this.calendars.has(calendarId))
      this.calendars.set(calendarId, { summary: calendarId, primary: false });
    const map = this.events.get(calendarId) ?? new Map<string, RawEvent>();
    this.events.set(calendarId, map);
    const stored = { ...ev, seq: ++this.seq } as RawEvent;
    map.set(ev.id, stored);
    return stored;
  }

  // ---- the HTTP surface ----

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.hostname === 'oauth2.googleapis.com')
      return this.token(new URLSearchParams(String(init?.body ?? '')));
    if (url.hostname !== 'www.googleapis.com') return json(404, { error: 'unexpected host' });
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== 'Bearer fake-access')
      return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    const path = url.pathname.replace('/calendar/v3', '');
    this.requests.push({ method, path, query: url.searchParams });
    const forced = this.forced.shift();
    if (forced)
      return json(forced.status, { error: { code: forced.status, errors: [{ reason: forced.reason }] } });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return this.route(method, path, url.searchParams, body);
  };

  private token(form: URLSearchParams) {
    const grant = form.get('grant_type');
    if (grant === 'refresh_token') {
      if (this.revoked || form.get('refresh_token') !== 'fake-refresh')
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' });
    }
    const code = form.get('code');
    if (code === 'good-code' || code === 'no-refresh-code')
      return json(200, {
        access_token: 'fake-access',
        expires_in: 3600,
        ...(code === 'good-code' ? { refresh_token: 'fake-refresh' } : {}),
      });
    return json(400, { error: 'invalid_grant' });
  }

  private route(method: string, path: string, q: URLSearchParams, body: Record<string, unknown>) {
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/calendars\/([^/]+)\/events\/watch$/)) && method === 'POST') {
      const calendarId = decodeURIComponent(m[1]!);
      const ttl = Number((body.params as { ttl?: string } | undefined)?.ttl ?? 604800);
      const ch: FakeChannel = {
        id: String(body.id),
        calendarId,
        resourceId: `res-${String(body.id)}`,
        token: String(body.token ?? ''),
        address: String(body.address),
        expiration: this.now() + ttl * 1000,
      };
      this.channels.set(ch.id, ch);
      return json(200, {
        kind: 'api#channel',
        id: ch.id,
        resourceId: ch.resourceId,
        expiration: String(ch.expiration),
      });
    }
    if (path === '/channels/stop' && method === 'POST') {
      this.channels.delete(String(body.id));
      return json(204, null);
    }
    if (path === '/users/me/calendarList' && method === 'GET') {
      if (!this.calendarListAllowed)
        return json(403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } });
      return json(200, {
        items: [...this.calendars].map(([id, c]) => ({
          id,
          summary: c.summary,
          primary: c.primary,
          accessRole: 'owner',
        })),
      });
    }
    if ((m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/))) {
      const calendarId = decodeURIComponent(m[1]!);
      const eventId = m[2] ? decodeURIComponent(m[2]) : null;
      if (!eventId && method === 'GET') return this.list(calendarId, q);
      if (!eventId && method === 'POST') {
        const id = `evt-${randomUUID().slice(0, 8)}`;
        this.put(calendarId, { id, status: 'confirmed', ...this.fromBody(body) });
        return json(200, { id });
      }
      const existing = eventId ? this.events.get(calendarId)?.get(eventId) : undefined;
      if (eventId && method === 'PATCH') {
        if (!existing || existing.status === 'cancelled') return json(404, { error: { code: 404 } });
        this.put(calendarId, { ...existing, ...this.fromBody(body) });
        return json(200, { id: eventId });
      }
      if (eventId && method === 'DELETE') {
        if (!existing || existing.status === 'cancelled') return json(410, { error: { code: 410 } });
        this.put(calendarId, { ...existing, status: 'cancelled' });
        return json(204, null);
      }
    }
    return json(404, { error: { code: 404, message: `fake google: no route ${method} ${path}` } });
  }

  private fromBody(body: Record<string, unknown>): Partial<RawEvent> {
    const { summary, description, start, end, extendedProperties } = body as Partial<RawEvent>;
    return {
      ...(summary !== undefined ? { summary } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(extendedProperties ? { extendedProperties } : {}),
    };
  }

  private list(calendarId: string, q: URLSearchParams) {
    const all = [...(this.events.get(calendarId)?.values() ?? [])];
    const syncToken = q.get('syncToken');
    let items: RawEvent[];
    if (syncToken) {
      const since = Number(syncToken.split('-').pop());
      if (!Number.isFinite(since) || since < this.goneBelow)
        return json(410, { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } });
      items = all.filter((e) => e.seq > since);
    } else {
      const from = q.get('timeMin') ? new Date(q.get('timeMin')!).getTime() : -Infinity;
      const to = q.get('timeMax') ? new Date(q.get('timeMax')!).getTime() : Infinity;
      items = all.filter((e) => e.status !== 'cancelled' && overlaps(e, from, to));
    }
    items.sort((a, b) => a.seq - b.seq);
    const offset = Number(q.get('pageToken')?.replace('page-', '') ?? 0);
    const page = items.slice(offset, offset + this.pageSize);
    const last = offset + this.pageSize >= items.length;
    return json(200, {
      items: page.map(({ seq: _seq, summary: _s, description: _d, ...rest }) => rest),
      ...(last
        ? { nextSyncToken: `sync-${calendarId}-${this.seq}` }
        : { nextPageToken: `page-${offset + this.pageSize}` }),
    });
  }
}

function overlaps(e: RawEvent, from: number, to: number) {
  const s = e.start?.dateTime
    ? new Date(e.start.dateTime).getTime()
    : e.start?.date
      ? Date.parse(e.start.date)
      : NaN;
  const en = e.end?.dateTime
    ? new Date(e.end.dateTime).getTime()
    : e.end?.date
      ? Date.parse(e.end.date)
      : NaN;
  // All-day events are compared as UTC midnights; the 1-day slop is fine for a fake.
  return Number.isNaN(s) || Number.isNaN(en) ? true : s < to + 86_400_000 && en > from - 86_400_000;
}

const FAKE_CLIENT = (fetch: typeof globalThis.fetch): GoogleOAuthClient => ({
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  redirectUri: 'http://localhost/v1/integrations/google/callback',
  fetch,
});

/** A CalendarProvider backed by `FakeGoogle` through the real Google adapter. */
export function createFakeCalendar(google: FakeGoogle = new FakeGoogle()) {
  const real = createGoogleCalendar({ client: FAKE_CLIENT(google.fetch), refreshToken: 'fake-refresh' });
  const calendar: CalendarProvider & {
    google: FakeGoogle;
    /** The primary calendar's live events (our appointments), for assertions. */
    readonly events: Map<string, { summary: string; description: string; start: Date; end: Date }>;
  } = {
    ...real,
    provider: 'fake',
    google,
    get events() {
      return new Map(
        google.live('primary').map((e) => [
          e.id,
          {
            summary: e.summary ?? '',
            description: e.description ?? '',
            start: new Date(e.start?.dateTime ?? ''),
            end: new Date(e.end?.dateTime ?? ''),
          },
        ]),
      );
    },
  };
  return calendar;
}
