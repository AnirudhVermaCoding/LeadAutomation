import { ChannelError } from './channel.ts';

/** An appointment as the clinic's calendar sees it (our side of the sync). */
export interface CalendarEvent {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  /** Written to extendedProperties.private so our own events are never read back as "busy". */
  appointmentId?: string;
}

/** Someone else's event on a synced calendar: only what slot-finding needs (no titles, no attendees). */
export interface ExternalEvent {
  id: string;
  /** `cancelled` = deleted (incremental sync reports deletions this way). */
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** Free (not busy) events don't block anything. */
  transparent: boolean;
  /** The calendar owner declined the invitation. */
  declinedBySelf: boolean;
  /** Set when the event is one of ours (`extendedProperties.private.instantlead_appt`). */
  appointmentId: string | null;
  /** Meeting-style events: exact instants. */
  timed: { start: Date; end: Date } | null;
  /** All-day events: local dates, `endDate` exclusive. */
  allDay: { startDate: string; endDate: string } | null;
  /** `workingLocation` and similar are not time commitments. */
  ignorable: boolean;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

export interface WatchChannel {
  channelId: string;
  resourceId: string;
  expiresAt: Date;
}

/** The stored sync token is no longer valid (HTTP 410): wipe and sync from scratch. */
export class SyncTokenGoneError extends Error {
  constructor() {
    super('Google sync token expired (410)');
  }
}

/** The refresh token is dead (revoked, expired, 7-day "testing" limit): the clinic must reconnect. */
export class GoogleAuthError extends ChannelError {
  constructor(message: string) {
    super(message, { retryable: false });
  }
}

export interface CalendarProvider {
  readonly provider: 'fake' | 'google';
  /** `calendarId` defaults to the account's primary calendar. */
  upsert(event: CalendarEvent, existingId?: string | null, calendarId?: string): Promise<{ id: string }>;
  remove(id: string, calendarId?: string): Promise<void>;
  /**
   * Other people's events. With `syncToken`: only what changed since (deletions as `cancelled`);
   * throws SyncTokenGoneError on 410. Without: a full sync of [from, to) that yields a new token.
   */
  listChanges(
    calendarId: string,
    opts: { syncToken: string | null; from: Date; to: Date },
  ): Promise<{ events: ExternalEvent[]; nextSyncToken: string }>;
  /** Events overlapping [from, to), recurring ones expanded. For the check right before booking. */
  listWindow(calendarId: string, from: Date, to: Date): Promise<ExternalEvent[]>;
  /** Push notifications: Google POSTs (without a body) to `address` whenever the calendar changes. */
  watch(
    calendarId: string,
    opts: { channelId: string; token: string; address: string; ttlSeconds: number },
  ): Promise<WatchChannel>;
  stopChannel(channelId: string, resourceId: string): Promise<void>;
  listCalendars(): Promise<CalendarListEntry[]>;
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_CALENDAR = `${GOOGLE_API}/calendars`;
/** Read + write events (also authorizes events.list and events.watch). FreeBusy is deliberately not used: it needs a wider scope. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
/** Optional: only to list the account's calendars in the Settings picker. */
export const GOOGLE_CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
}

/** Consent URL; `state` must be verified on the callback (CSRF). */
export function googleConsentUrl(client: GoogleOAuthClient, state: string): string {
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_CALENDAR_LIST_SCOPE}`,
    access_type: 'offline', // we need a refresh token: syncing happens without the user present
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

async function tokenRequest(client: GoogleOAuthClient, params: Record<string, string>) {
  const res = await (client.fetch ?? globalThis.fetch)(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  // invalid_grant = revoked / expired refresh token: retrying never helps, the clinic must reconnect.
  if (json.error === 'invalid_grant') throw new GoogleAuthError('Google access was revoked or expired');
  if (!res.ok || !json.access_token)
    throw new ChannelError(`Google token error: ${json.error ?? res.status}`, {
      retryable: res.status >= 500 || res.status === 429,
    });
  return { ...json, access_token: json.access_token };
}

export const exchangeGoogleCode = (client: GoogleOAuthClient, code: string) =>
  tokenRequest(client, { code, redirect_uri: client.redirectUri, grant_type: 'authorization_code' });

const LIST_FIELDS =
  'nextPageToken,nextSyncToken,items(id,status,transparency,eventType,start,end,attendees(self,responseStatus),extendedProperties/private)';

interface GoogleEvent {
  id: string;
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

function toExternal(e: GoogleEvent): ExternalEvent | null {
  const status =
    e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed';
  const base = {
    id: e.id,
    status,
    transparent: e.transparency === 'transparent',
    declinedBySelf: Boolean(e.attendees?.some((a) => a.self && a.responseStatus === 'declined')),
    appointmentId: e.extendedProperties?.private?.instantlead_appt ?? null,
    ignorable: e.eventType === 'workingLocation' || e.eventType === 'birthday',
  } as const;
  if (e.start?.dateTime && e.end?.dateTime)
    return {
      ...base,
      timed: { start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) },
      allDay: null,
    };
  if (e.start?.date && e.end?.date)
    return { ...base, timed: null, allDay: { startDate: e.start.date, endDate: e.end.date } };
  // A deleted event in an incremental sync carries only an id and status.
  return status === 'cancelled' ? { ...base, timed: null, allDay: null } : null;
}

/** Google Calendar via a stored refresh token. */
export function createGoogleCalendar(opts: {
  client: GoogleOAuthClient;
  refreshToken: string;
  calendarId?: string;
}): CalendarProvider {
  const doFetch = opts.client.fetch ?? globalThis.fetch;
  const defaultCalendar = opts.calendarId ?? 'primary';
  let cached: { token: string; expiresAt: number } | null = null;
  const accessToken = async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const t = await tokenRequest(opts.client, {
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    });
    cached = { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
    return cached.token;
  };
  /** Returns null for "gone" (404 / 410) so callers decide what that means. */
  const call = async (
    method: string,
    url: string,
    body?: object,
  ): Promise<Record<string, unknown> | null> => {
    const res = await doFetch(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status === 401) {
      cached = null;
      throw new GoogleAuthError('Google rejected the access token');
    }
    if (!res.ok)
      throw new ChannelError(`Google Calendar HTTP ${res.status}`, {
        code: res.status,
        // 403 is retryable only for rate limits; a missing scope or no access never fixes itself.
        retryable:
          res.status === 429 || res.status >= 500 || (res.status === 403 && (await isRateLimit(res))),
      });
    return res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
  };
  const events = (calendarId: string) => `${GOOGLE_CALENDAR}/${encodeURIComponent(calendarId)}/events`;

  const toGoogle = (e: CalendarEvent) => ({
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
    end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
    ...(e.appointmentId ? { extendedProperties: { private: { instantlead_appt: e.appointmentId } } } : {}),
  });

  async function list(calendarId: string, params: Record<string, string>) {
    const out: ExternalEvent[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({
        singleEvents: 'true',
        maxResults: '250',
        fields: LIST_FIELDS,
        ...params,
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = (await call('GET', `${events(calendarId)}?${qs}`)) as {
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      } | null;
      if (!page) {
        if (params.syncToken) throw new SyncTokenGoneError();
        throw new ChannelError(`Calendar ${calendarId} not found or no access`, {
          code: 404,
          retryable: false,
        });
      }
      for (const item of page.items ?? []) {
        const ev = toExternal(item);
        if (ev) out.push(ev);
      }
      if (!page.nextPageToken) return { events: out, nextSyncToken: page.nextSyncToken ?? '' };
      pageToken = page.nextPageToken;
    }
  }

  return {
    provider: 'google',
    async upsert(event, existingId, calendarId = defaultCalendar) {
      const updated = existingId
        ? await call('PATCH', `${events(calendarId)}/${encodeURIComponent(existingId)}`, toGoogle(event))
        : null;
      const result = (updated ?? (await call('POST', events(calendarId), toGoogle(event)))) as {
        id?: string;
      } | null;
      if (!result?.id) throw new ChannelError('Google Calendar returned no event id', { retryable: true });
      return { id: result.id };
    },
    async remove(id, calendarId = defaultCalendar) {
      await call('DELETE', `${events(calendarId)}/${encodeURIComponent(id)}`);
    },
    async listChanges(calendarId, { syncToken, from, to }) {
      if (syncToken) return list(calendarId, { syncToken });
      // Full sync. A syncToken request may not carry timeMin/timeMax, but the token inherits them from here.
      return list(calendarId, { timeMin: from.toISOString(), timeMax: to.toISOString() });
    },
    async listWindow(calendarId, from, to) {
      const { events: found } = await list(calendarId, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
      });
      return found;
    },
    async watch(calendarId, { channelId, token, address, ttlSeconds }) {
      const r = (await call('POST', `${events(calendarId)}/watch`, {
        id: channelId,
        type: 'web_hook',
        address,
        token,
        params: { ttl: String(ttlSeconds) },
      })) as { resourceId?: string; expiration?: string } | null;
      if (!r?.resourceId) throw new ChannelError('Google watch returned no resource id', { retryable: true });
      return {
        channelId,
        resourceId: r.resourceId,
        expiresAt: new Date(Number(r.expiration) || Date.now() + ttlSeconds * 1000),
      };
    },
    async stopChannel(channelId, resourceId) {
      await call('POST', `${GOOGLE_API}/channels/stop`, { id: channelId, resourceId });
    },
    async listCalendars() {
      const r = (await call('GET', `${GOOGLE_API}/users/me/calendarList?minAccessRole=reader`)) as {
        items?: { id: string; summary?: string; primary?: boolean; accessRole?: string }[];
      } | null;
      return (r?.items ?? []).map((c) => ({
        id: c.id,
        summary: c.summary ?? c.id,
        primary: Boolean(c.primary),
        accessRole: c.accessRole ?? 'reader',
      }));
    },
  };
}

async function isRateLimit(res: Response) {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
  return Boolean(
    body?.error?.errors?.some(
      (e) => e.reason === 'rateLimitExceeded' || e.reason === 'userRateLimitExceeded',
    ),
  );
}
