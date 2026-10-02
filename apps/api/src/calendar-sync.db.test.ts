import { createFakeEmail, type FakeGoogle } from '@instantlead/integrations';
import { zonedTimeToUtc } from '@instantlead/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { BookingError, bookSlot, findSlots } from './booking.ts';
import { withTenant } from './db/client.ts';
import {
  appointments,
  blockedTimes,
  calendarLinks,
  googleConnections,
  leads,
  messages,
} from './db/schema.ts';
import { runMonitor } from './monitoring.ts';

let t: TestContext;
let A: string; // single resource ("default")
let B: string; // two doctors, a calendar each
let cookieA: string;
let cookieB: string;
let ga: FakeGoogle;
let gb: FakeGoogle;
let n = 0;

const WED = '2026-10-07';
/** Earlier tests move the clock ~6 days, so the per-doctor tests use a later Wednesday. */
const LATE_WED = '2026-10-21';
const ist = (date: string, time: string) => zonedTimeToUtc(date, time, 'Asia/Kolkata');

beforeAll(async () => {
  t = await createTestContext();
  const mk = async (slug: string) =>
    (
      await t.ctx.system.createTenant(
        {
          slug,
          name: `Clinic ${slug}`,
          preset: 'clinic_dental',
          admin: { email: `admin@${slug}.test`, name: slug, password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
  A = await mk('a');
  B = await mk('b');
  cookieA = await t.signIn('admin@a.test');
  cookieB = await t.signIn('admin@b.test');
  ga = t.ctx.fakeGoogleFor(A);
  gb = t.ctx.fakeGoogleFor(B);
});
afterAll(() => t.close());

const api = (
  cookie: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  headers = {},
) =>
  t.app.inject({
    method,
    url,
    headers: { cookie, ...headers },
    ...(payload ? { payload: payload as object } : {}),
  });

const times = async (tenant: string, date = WED, resource?: string) =>
  (
    await findSlots(t.ctx, tenant, { service: 'Consultation', date, limit: 200, spread: false, resource })
  ).slots.map((s) => s.time);
const googleBlocks = (tenant: string) =>
  withTenant(t.ctx.db, tenant, (tx) =>
    tx.select().from(blockedTimes).where(eq(blockedTimes.source, 'google')),
  );
const link = async (tenant: string) =>
  (await withTenant(t.ctx.db, tenant, (tx) => tx.select().from(calendarLinks)))[0]!;
const sync = async (cookie: string) => {
  await api(cookie, 'POST', '/v1/integrations/google/sync');
  await t.drainJobs();
};
async function newLead(tenant: string, cookie: string, name = 'Priya') {
  const phone = `98720${String(++n).padStart(5, '0')}`;
  const res = await api(cookie, 'POST', '/v1/leads', { phone, name, consent: { granted: true } });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
}

describe('connecting and importing busy time', () => {
  test('a pre-existing Google event blocks slots after the first sync; nothing is offered over it', async () => {
    expect(await times(A)).toContain('14:00');
    ga.addExternalEvent({ start: ist(WED, '14:00'), end: ist(WED, '15:00') });
    expect((await api(cookieA, 'POST', '/v1/dev/google/connect')).json()).toEqual({ connected: true });
    await t.drainJobs();
    const after = await times(A);
    expect(after).not.toContain('14:00');
    expect(after).not.toContain('14:30');
    expect(after).toContain('16:00');
    const [l, ...rest] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(calendarLinks));
    expect(rest).toHaveLength(0);
    expect(l).toMatchObject({ calendarId: 'primary', resource: null, readBusy: true });
    expect(l?.syncToken).toBeTruthy();
    expect(l?.channelId).toBeTruthy(); // push channel created
    expect((await googleBlocks(A))[0]).toMatchObject({ reason: 'Google Calendar', resource: null });
  });

  test('an event moved or deleted in Google updates the blocks (incremental sync)', async () => {
    const id = ga.addExternalEvent({ start: ist(WED, '11:00'), end: ist(WED, '12:00') });
    await sync(cookieA);
    expect(await times(A)).not.toContain('11:00');
    ga.updateExternalEvent('primary', id, { start: ist(WED, '12:00'), end: ist(WED, '13:00') });
    await sync(cookieA);
    const moved = await times(A);
    expect(moved).toContain('11:00');
    expect(moved).not.toContain('12:00');
    ga.deleteExternalEvent('primary', id);
    await sync(cookieA);
    expect(await times(A)).toContain('12:00');
  });

  test('free, declined and all-day events: free and declined are ignored, all-day blocks the day', async () => {
    ga.addExternalEvent({ start: ist(WED, '17:00'), end: ist(WED, '18:00'), transparency: 'transparent' });
    ga.addExternalEvent({ start: ist(WED, '18:00'), end: ist(WED, '19:00'), declinedBySelf: true });
    ga.addExternalEvent({ start: '2026-10-09', end: '2026-10-10' }); // all day Fri 9 Oct
    await sync(cookieA);
    const wed = await times(A);
    expect(wed).toContain('17:00');
    expect(wed).toContain('18:00');
    expect(await times(A, '2026-10-09')).toEqual([]);
    expect((await times(A, '2026-10-10')).length).toBeGreaterThan(0);
  });

  test('re-syncing the same events is idempotent', async () => {
    const before = (await googleBlocks(A)).map((b) => `${b.externalId}:${b.startsAt.toISOString()}`).sort();
    await sync(cookieA);
    await api(cookieA, 'POST', '/v1/integrations/google/sync');
    await t.drainJobs();
    expect((await googleBlocks(A)).map((b) => `${b.externalId}:${b.startsAt.toISOString()}`).sort()).toEqual(
      before,
    );
  });

  test('410: sync tokens expire, everything is re-imported and stale blocks disappear', async () => {
    const id = ga.addExternalEvent({ start: ist(WED, '19:00'), end: ist(WED, '19:30') });
    await sync(cookieA);
    expect(await times(A)).not.toContain('19:00');
    // Deleted in Google while our token is already dead: incremental sync could never tell us.
    ga.deleteExternalEvent('primary', id);
    ga.expireSyncTokens();
    await sync(cookieA);
    expect(await times(A)).toContain('19:00');
    expect((await googleBlocks(A)).some((b) => b.externalId === id)).toBe(false);
  });
});

describe('our own events', () => {
  test('are never read back as busy time', async () => {
    const leadId = await newLead(A, cookieA, 'Meera');
    const slot = (await times(A, '2026-10-12'))[4]!;
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: '2026-10-12',
      time: slot,
      source: 'staff',
    });
    await t.drainJobs(); // writes our event to Google
    const [row] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appointment.id)),
    );
    expect(ga.live().some((e) => e.id === row!.googleEventId)).toBe(true);
    await sync(cookieA);
    expect((await googleBlocks(A)).some((b) => b.externalId === row!.googleEventId)).toBe(false);
  });
});

describe('conflicts with existing bookings', () => {
  test('an event created over a booking is shown as affected, and nobody is messaged until staff choose to', async () => {
    const leadId = await newLead(A, cookieA, 'Ravi');
    const slot = (await times(A, '2026-10-14'))[2]!;
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: '2026-10-14',
      time: slot,
      source: 'staff',
    });
    await t.drainJobs();
    const sentBefore = t.ctx.fakeChannel.sent.length;
    const msgsBefore = (await withTenant(t.ctx.db, A, (tx) => tx.select().from(messages))).length;

    ga.addExternalEvent({ start: ist('2026-10-14', slot), end: ist('2026-10-14', '23:00') });
    await sync(cookieA);

    const avail = (await api(cookieA, 'GET', '/v1/availability')).json() as {
      blocked: { source: string; affected: { id: string }[] }[];
    };
    const block = avail.blocked.find((b) => b.affected.some((a) => a.id === appointment.id));
    expect(block?.source).toBe('google');
    // Never auto-message.
    expect(t.ctx.fakeChannel.sent.length).toBe(sentBefore);
    expect((await withTenant(t.ctx.db, A, (tx) => tx.select().from(messages))).length).toBe(msgsBefore);
    // Staff choose "Tell them & offer new times".
    const blockId = (
      await withTenant(t.ctx.db, A, (tx) =>
        tx.select().from(blockedTimes).where(eq(blockedTimes.source, 'google')),
      )
    ).find((b) => b.startsAt.getTime() === ist('2026-10-14', slot).getTime())!.id;
    expect((await api(cookieA, 'POST', `/v1/blocked-times/${blockId}/notify`)).statusCode).toBe(200);
    await t.drainJobs();
    expect(t.ctx.fakeChannel.sent.length).toBeGreaterThan(sentBefore);
  });
});

describe('the check right before booking', () => {
  test('catches an event the sync has not delivered yet', async () => {
    const leadId = await newLead(A, cookieA, 'Sana');
    await sync(cookieA);
    t.clock.advance(5 * 60_000); // last sync is now > 1 minute old
    ga.addExternalEvent({ start: ist('2026-10-15', '10:00'), end: ist('2026-10-15', '11:00') }); // no sync yet
    expect(await times(A, '2026-10-15')).toContain('10:00'); // we don't know yet
    const calls = ga.requests.length;
    const err = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: '2026-10-15',
      time: '10:00',
      source: 'assistant',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe('unavailable');
    expect(ga.requests.length).toBeGreaterThan(calls); // it asked Google
    expect(await times(A, '2026-10-15')).not.toContain('10:00');
  });

  test('if Google is down the booking still goes through (fail open); the database constraint still holds', async () => {
    const leadId = await newLead(A, cookieA, 'Tara');
    t.clock.advance(5 * 60_000);
    ga.failNext(500);
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: '2026-10-16',
      time: '12:00',
      source: 'staff',
    });
    expect(appointment.status).toBe('scheduled');
  });
});

describe('push notifications', () => {
  test('the webhook checks the channel id and token, and a burst collapses into one sync', async () => {
    const l = await link(A);
    const headers = ga.notification(l.channelId!);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/webhooks/google-calendar',
          headers: { ...headers, 'x-goog-channel-token': 'wrong' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/webhooks/google-calendar',
          headers: { 'x-goog-channel-id': 'nope', 'x-goog-channel-token': 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/webhooks/google-calendar' })).statusCode).toBe(400);

    const id = ga.addExternalEvent({ start: ist('2026-10-20', '10:00'), end: ist('2026-10-20', '11:00') });
    for (let i = 0; i < 3; i++)
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: '/webhooks/google-calendar',
            headers: ga.notification(l.channelId!),
          })
        ).statusCode,
      ).toBe(200);
    const results = await t.drainJobs();
    expect(results.filter((r) => r.queue === 'calendar-sync')).toHaveLength(1);
    expect((await googleBlocks(A)).some((b) => b.externalId === id)).toBe(true);
    // The initial `sync` handshake message does nothing.
    await t.app.inject({
      method: 'POST',
      url: '/webhooks/google-calendar',
      headers: ga.notification(l.channelId!, 'sync'),
    });
    expect((await t.drainJobs()).filter((r) => r.queue === 'calendar-sync')).toHaveLength(0);
  });

  test('channels are renewed before they expire, and the old one is stopped', async () => {
    const before = (await link(A)).channelId!;
    t.clock.advance(6 * 24 * 3_600_000); // 6 days into a 7-day channel
    await t.drainJobs(); // nothing queued yet
    await t.advance(0); // sweep: the channel is within 48 h of expiry
    const after = await link(A);
    expect(after.channelId).not.toBe(before);
    expect(ga.channels.has(before)).toBe(false);
    expect(ga.channels.size).toBe(1);
    expect(after.channelExpiresAt!.getTime()).toBeGreaterThan(t.clock.now().getTime() + 5 * 24 * 3_600_000);
  });
});

describe('Google access lost', () => {
  test('invalid_grant stops syncing, flags the connection, alerts the agency, and reconnecting recovers', async () => {
    ga.revoked = true;
    await sync(cookieA);
    const [conn] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(googleConnections));
    expect(conn?.status).toBe('reauth_needed');
    const state = (await api(cookieA, 'GET', '/v1/integrations/google')).json() as {
      status: string;
      last_error: string;
    };
    expect(state.status).toBe('reauth_needed');
    expect(state.last_error).toMatch(/revoked or expired/);

    const email = createFakeEmail();
    await runMonitor({
      system: t.ctx.system,
      email,
      alertEmail: 'ops@agency.test',
      now: () => t.clock.now(),
    });
    expect(email.sent.some((m) => /Google Calendar access was revoked/.test(m.text))).toBe(true);

    // While flagged, the sweep leaves it alone (no retry storm).
    const calls = ga.requests.length;
    await t.advance(1);
    expect(ga.requests.length).toBe(calls);

    ga.revoked = false;
    await api(cookieA, 'POST', '/v1/dev/google/connect'); // the OAuth callback does the same
    await t.drainJobs();
    expect((await withTenant(t.ctx.db, A, (tx) => tx.select().from(googleConnections)))[0]?.status).toBe(
      'ok',
    );
  });
});

describe('one calendar per doctor', () => {
  const rules = ['Dr Rao', 'Dr Mehta'].flatMap((resource) =>
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((weekday) => ({
      weekday,
      start_time: '10:00',
      end_time: '20:00',
      resource,
    })),
  );

  test("mapping is validated; an event on a doctor's calendar blocks only that doctor", async () => {
    expect((await api(cookieB, 'PUT', '/v1/availability', rules)).statusCode).toBe(200);
    await api(cookieB, 'POST', '/v1/dev/google/connect');
    await t.drainJobs();
    gb.addCalendar('rao@clinic.test', 'Dr Rao');
    gb.addCalendar('mehta@clinic.test', 'Dr Mehta');

    const bad = await api(cookieB, 'PUT', '/v1/integrations/google/links', [
      { calendar_id: 'rao@clinic.test', resource: 'Dr Nobody' },
    ]);
    expect(bad.statusCode).toBe(422);
    const dup = await api(cookieB, 'PUT', '/v1/integrations/google/links', [
      { calendar_id: 'x', resource: null },
      { calendar_id: 'x', resource: null },
    ]);
    expect(dup.statusCode).toBe(422);

    const ok = await api(cookieB, 'PUT', '/v1/integrations/google/links', [
      { calendar_id: 'rao@clinic.test', label: 'Dr Rao', resource: 'Dr Rao' },
      { calendar_id: 'mehta@clinic.test', label: 'Dr Mehta', resource: 'Dr Mehta' },
    ]);
    expect(ok.statusCode).toBe(200);
    await t.drainJobs();
    expect(
      (await withTenant(t.ctx.db, B, (tx) => tx.select().from(calendarLinks)))
        .map((l) => l.calendarId)
        .sort(),
    ).toEqual(['mehta@clinic.test', 'rao@clinic.test']); // the default primary link was replaced

    gb.addExternalEvent({
      calendarId: 'rao@clinic.test',
      start: ist(LATE_WED, '15:00'),
      end: ist(LATE_WED, '16:00'),
    });
    await sync(cookieB);
    expect(await times(B, LATE_WED, 'Dr Rao')).not.toContain('15:00');
    expect(await times(B, LATE_WED, 'Dr Mehta')).toContain('15:00');
    expect(await times(B, LATE_WED)).toContain('15:00'); // someone is still free
  });

  test("bookings are written to the doctor's own calendar, not read back, and move with a reassignment", async () => {
    const leadId = await newLead(B, cookieB, 'Uma');
    const { appointment } = await bookSlot(t.ctx, B, {
      leadId,
      service: 'Consultation',
      date: '2026-10-22',
      time: '11:00',
      source: 'staff',
      resource: 'Dr Mehta',
    });
    await t.drainJobs();
    const [row] = await withTenant(t.ctx.db, B, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appointment.id)),
    );
    expect(row?.googleCalendarId).toBe('mehta@clinic.test');
    expect(gb.live('mehta@clinic.test').some((e) => e.id === row!.googleEventId)).toBe(true);
    expect(gb.live('rao@clinic.test').some((e) => e.id === row!.googleEventId)).toBe(false);
    await sync(cookieB);
    expect((await googleBlocks(B)).some((b) => b.externalId === row!.googleEventId)).toBe(false);
  });
});

describe('disconnecting', () => {
  test('stops channels, forgets busy time and the token; our bookings keep working without Google', async () => {
    expect((await api(cookieB, 'POST', '/v1/integrations/google/disconnect')).json()).toEqual({
      disconnected: true,
    });
    expect(gb.channels.size).toBe(0);
    expect(await withTenant(t.ctx.db, B, (tx) => tx.select().from(calendarLinks))).toHaveLength(0);
    expect(await googleBlocks(B)).toHaveLength(0);
    expect((await api(cookieB, 'GET', '/v1/integrations/google')).json()).toMatchObject({ connected: false });
    // Still able to book.
    const leadId = await newLead(B, cookieB, 'Vik');
    await bookSlot(t.ctx, B, {
      leadId,
      service: 'Consultation',
      date: '2026-10-23',
      time: '12:00',
      source: 'staff',
    });
    expect(
      (
        await withTenant(t.ctx.db, B, (tx) =>
          tx
            .select()
            .from(leads)
            .where(and(eq(leads.id, leadId))),
        )
      ).length,
    ).toBe(1);
  });
});
