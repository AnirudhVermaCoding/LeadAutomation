import { ChannelError } from './channel.ts';

/** One-way sync: our appointments -> the clinic's calendar. */
export interface CalendarEvent {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
}

export interface CalendarProvider {
  readonly provider: 'fake' | 'google';
  upsert(event: CalendarEvent, existingId?: string | null): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

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
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline', // we need a refresh token: syncing happens without the user present
    prompt: 'consent',
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(client: GoogleOAuthClient, params: Record<string, string>) {
  const res = await (client.fetch ?? globalThis.fetch)(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok || !json.access_token)
    throw new ChannelError(`Google token error: ${json.error ?? res.status}`, {
      retryable: res.status >= 500,
    });
  return json;
}

export const exchangeGoogleCode = (client: GoogleOAuthClient, code: string) =>
  tokenRequest(client, { code, redirect_uri: client.redirectUri, grant_type: 'authorization_code' });

/** Google Calendar via a stored refresh token (one access token per operation; low volume). */
export function createGoogleCalendar(opts: {
  client: GoogleOAuthClient;
  refreshToken: string;
  calendarId?: string;
}): CalendarProvider {
  const doFetch = opts.client.fetch ?? globalThis.fetch;
  const base = `${GOOGLE_CALENDAR}/${encodeURIComponent(opts.calendarId ?? 'primary')}/events`;
  const call = async (method: string, path: string, body?: object) => {
    const { access_token } = await tokenRequest(opts.client, {
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 410) return null; // event already gone
    if (!res.ok)
      throw new ChannelError(`Google Calendar HTTP ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    return res.status === 204 ? {} : ((await res.json()) as { id?: string });
  };
  const toGoogle = (e: CalendarEvent) => {
    const local = (d: Date) => d.toISOString().slice(0, 19) + 'Z';
    return {
      summary: e.summary,
      description: e.description,
      start: { dateTime: local(e.start), timeZone: e.timeZone },
      end: { dateTime: local(e.end), timeZone: e.timeZone },
    };
  };
  return {
    provider: 'google',
    async upsert(event, existingId) {
      const updated = existingId
        ? await call('PATCH', `/${encodeURIComponent(existingId)}`, toGoogle(event))
        : null;
      const result = updated ?? (await call('POST', '', toGoogle(event)));
      if (!result?.id && !existingId)
        throw new ChannelError('Google Calendar returned no event id', { retryable: true });
      return { id: result?.id ?? existingId ?? '' };
    },
    async remove(id) {
      await call('DELETE', `/${encodeURIComponent(id)}`);
    },
  };
}

export function createFakeCalendar() {
  const events = new Map<string, CalendarEvent>();
  const calendar: CalendarProvider & { events: typeof events } = {
    provider: 'fake',
    events,
    upsert(event, existingId) {
      const id = existingId ?? `fake-event-${events.size + 1}`;
      events.set(id, event);
      return Promise.resolve({ id });
    },
    remove(id) {
      events.delete(id);
      return Promise.resolve();
    },
  };
  return calendar;
}
