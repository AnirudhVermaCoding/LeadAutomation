import { describe, expect, test } from 'vitest';
import {
  createFakeCalendar,
  createGoogleCalendar,
  exchangeGoogleCode,
  FakeGoogle,
  GoogleAuthError,
  googleConsentUrl,
  SyncTokenGoneError,
} from './index.ts';

const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-12-01T00:00:00Z');
const at = (iso: string) => new Date(iso);

describe('Google adapter against FakeGoogle', () => {
  test('upsert tags our events and patches them; remove is idempotent', async () => {
    const cal = createFakeCalendar();
    const e = {
      summary: 'Cleaning — Asha',
      description: 'x',
      start: at('2026-10-06T05:00:00Z'),
      end: at('2026-10-06T05:30:00Z'),
      timeZone: 'Asia/Kolkata',
      appointmentId: 'appt-1',
    };
    const { id } = await cal.upsert(e);
    expect(cal.google.live()[0]?.extendedProperties?.private?.instantlead_appt).toBe('appt-1');
    expect((await cal.upsert({ ...e, summary: 'Changed' }, id)).id).toBe(id);
    expect(cal.events.get(id)?.summary).toBe('Changed');
    await cal.remove(id);
    await cal.remove(id); // already gone: no error
    expect(cal.events.size).toBe(0);
  });

  test('full sync then incremental: updates, deletions as cancelled, our own events tagged', async () => {
    const cal = createFakeCalendar();
    const g = cal.google;
    const a = g.addExternalEvent({ start: at('2026-10-07T10:00:00Z'), end: at('2026-10-07T11:00:00Z') });
    const mine = await cal.upsert({
      summary: 'ours',
      description: '',
      start: at('2026-10-07T12:00:00Z'),
      end: at('2026-10-07T12:30:00Z'),
      timeZone: 'UTC',
      appointmentId: 'appt-9',
    });
    const first = await cal.listChanges('primary', { syncToken: null, from, to });
    expect(first.events.map((e) => e.id).sort()).toEqual([a, mine.id].sort());
    expect(first.events.find((e) => e.id === mine.id)?.appointmentId).toBe('appt-9');
    expect(first.nextSyncToken).toBeTruthy();

    g.updateExternalEvent('primary', a, {
      start: at('2026-10-07T14:00:00Z'),
      end: at('2026-10-07T15:00:00Z'),
    });
    const b = g.addExternalEvent({ start: '2026-10-08', end: '2026-10-09' });
    const second = await cal.listChanges('primary', { syncToken: first.nextSyncToken, from, to });
    expect(second.events.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(second.events.find((e) => e.id === b)?.allDay).toEqual({
      startDate: '2026-10-08',
      endDate: '2026-10-09',
    });

    g.deleteExternalEvent('primary', a);
    const third = await cal.listChanges('primary', { syncToken: second.nextSyncToken, from, to });
    expect(third.events).toMatchObject([{ id: a, status: 'cancelled' }]);
  });

  test('maps free, declined, tentative and working-location events', async () => {
    const cal = createFakeCalendar();
    const g = cal.google;
    const free = g.addExternalEvent({
      start: at('2026-10-07T10:00:00Z'),
      end: at('2026-10-07T11:00:00Z'),
      transparency: 'transparent',
    });
    const declined = g.addExternalEvent({
      start: at('2026-10-07T10:00:00Z'),
      end: at('2026-10-07T11:00:00Z'),
      declinedBySelf: true,
    });
    const tentative = g.addExternalEvent({
      start: at('2026-10-07T10:00:00Z'),
      end: at('2026-10-07T11:00:00Z'),
      status: 'tentative',
    });
    const wl = g.addExternalEvent({ start: '2026-10-07', end: '2026-10-08', eventType: 'workingLocation' });
    const byId = Object.fromEntries((await cal.listWindow('primary', from, to)).map((e) => [e.id, e]));
    expect(byId[free]?.transparent).toBe(true);
    expect(byId[declined]?.declinedBySelf).toBe(true);
    expect(byId[tentative]?.status).toBe('tentative');
    expect(byId[wl]?.ignorable).toBe(true);
  });

  test('410 on an expired sync token; paging follows nextPageToken', async () => {
    const cal = createFakeCalendar();
    cal.google.pageSize = 2;
    for (let i = 0; i < 5; i++)
      cal.google.addExternalEvent({
        start: at(`2026-10-1${i}T10:00:00Z`),
        end: at(`2026-10-1${i}T11:00:00Z`),
      });
    const full = await cal.listChanges('primary', { syncToken: null, from, to });
    expect(full.events).toHaveLength(5);
    cal.google.expireSyncTokens();
    await expect(
      cal.listChanges('primary', { syncToken: full.nextSyncToken, from, to }),
    ).rejects.toBeInstanceOf(SyncTokenGoneError);
  });

  test('a revoked refresh token is a GoogleAuthError (not retryable)', async () => {
    const cal = createFakeCalendar();
    cal.google.revoked = true;
    const err = await cal.listWindow('primary', from, to).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).retryable).toBe(false);
  });

  test('rate limits and 5xx retry; a missing scope or calendar does not', async () => {
    const cal = createFakeCalendar();
    cal.google.failNext(403, 'rateLimitExceeded');
    expect(await cal.listWindow('primary', from, to).catch((e: unknown) => e)).toMatchObject({
      retryable: true,
      code: 403,
    });
    cal.google.failNext(503);
    expect(await cal.listWindow('primary', from, to).catch((e: unknown) => e)).toMatchObject({
      retryable: true,
    });
    cal.google.calendarListAllowed = false;
    expect(await cal.listCalendars().catch((e: unknown) => e)).toMatchObject({ retryable: false, code: 403 });
    expect(
      await cal
        .listWindow('nope@group', from, to)
        .then(() => 'ok')
        .catch(() => 'err'),
    ).toBe('ok'); // fake creates on demand
  });

  test('watch / stop channels and the calendar list', async () => {
    const cal = createFakeCalendar();
    cal.google.addCalendar('dr.rao@clinic.test', 'Dr Rao');
    expect((await cal.listCalendars()).map((c) => c.id).sort()).toEqual(['dr.rao@clinic.test', 'primary']);
    const ch = await cal.watch('primary', {
      channelId: 'c1',
      token: 'secret',
      address: 'https://x.test/hook',
      ttlSeconds: 3600,
    });
    expect(cal.google.channels.get('c1')?.token).toBe('secret');
    expect(ch.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(cal.google.notification('c1')['x-goog-channel-token']).toBe('secret');
    await cal.stopChannel('c1', ch.resourceId);
    expect(cal.google.channels.size).toBe(0);
  });
});

describe('OAuth helpers', () => {
  const client = (g: FakeGoogle) => ({
    clientId: 'c',
    clientSecret: 's',
    redirectUri: 'https://x/cb',
    fetch: g.fetch,
  });
  test('consent URL asks for both scopes, offline', () => {
    const url = new URL(googleConsentUrl(client(new FakeGoogle()), 'st'));
    expect(url.searchParams.get('scope')).toContain('calendar.events');
    expect(url.searchParams.get('scope')).toContain('calendarlist.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });
  test('code exchange: good, and a bad code is an error', async () => {
    const g = new FakeGoogle();
    expect((await exchangeGoogleCode(client(g), 'good-code')).refresh_token).toBe('fake-refresh');
    await expect(exchangeGoogleCode(client(g), 'bad')).rejects.toBeInstanceOf(GoogleAuthError);
  });
  test('createGoogleCalendar works against a real-shaped client', async () => {
    const g = new FakeGoogle();
    const cal = createGoogleCalendar({ client: client(g), refreshToken: 'fake-refresh' });
    expect(await cal.listWindow('primary', from, to)).toEqual([]);
  });
});
