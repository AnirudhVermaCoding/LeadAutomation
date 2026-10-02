import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DAY, HOUR, MINUTE, zonedTimeToUtc, type Clock } from '@instantlead/core';
import {
  ChannelError,
  GoogleAuthError,
  SyncTokenGoneError,
  type CalendarProvider,
  type ExternalEvent,
} from '@instantlead/integrations';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Db, type TenantTx, type Tx } from './db/client.ts';
import {
  appointments,
  availabilityRules,
  blockedTimes,
  calendarLinks,
  googleConnections,
} from './db/schema.ts';
import { QUEUES, type Enqueue, type JobData } from './jobs.ts';

export type CalendarFor = (tx: Tx, tenantId: string) => Promise<CalendarProvider | null>;

export interface CalendarDeps {
  db: Db;
  clock: Clock;
  hashKey: Buffer;
  enqueue: Enqueue;
  calendarFor: CalendarFor;
  env: { APP_URL: string };
  system: {
    calendarLinksForSweep(): Promise<
      {
        tenantId: string;
        linkId: string;
        lastSyncedAt: Date | null;
        lastFullSyncAt: Date | null;
        channelId: string | null;
        channelExpiresAt: Date | null;
      }[]
    >;
  };
}

/** Events from [now - 1 day, now + 60 days) are mirrored. // ponytail: slot search looks 14 days ahead; the nightly full sync moves the window. */
const PAST_MS = DAY;
const FUTURE_MS = 60 * DAY;
const CHANNEL_TTL_S = 7 * 24 * 3600;
const RENEW_BEFORE_MS = 48 * HOUR;
/** With a live push channel the sweep is only a backstop. */
const BACKSTOP_MS = 15 * MINUTE;
export const WEBHOOK_PATH = '/webhooks/google-calendar';

// ---- event -> blocked time ----

/**
 * What an external event means for slot-finding. `null` = it blocks nothing (deleted, free, declined,
 * ours, not a time commitment). All-day busy events block the whole local day(s).
 */
export function blockFor(ev: ExternalEvent, tz: string): { startsAt: Date; endsAt: Date } | null {
  if (ev.status === 'cancelled' || ev.appointmentId || ev.transparent || ev.declinedBySelf || ev.ignorable)
    return null;
  if (ev.timed)
    return ev.timed.end > ev.timed.start ? { startsAt: ev.timed.start, endsAt: ev.timed.end } : null;
  if (ev.allDay)
    return {
      startsAt: zonedTimeToUtc(ev.allDay.startDate, '00:00', tz),
      endsAt: zonedTimeToUtc(ev.allDay.endDate, '00:00', tz),
    };
  return null;
}

// ---- push channel auth ----

/** The channel token Google echoes back: derived from the channel id, so nothing extra is stored. */
export const channelToken = (hashKey: Buffer, channelId: string) =>
  createHmac('sha256', hashKey).update(`gcal-channel:${channelId}`).digest('base64url');

export function channelTokenValid(hashKey: Buffer, channelId: string, given: string | undefined) {
  const expected = Buffer.from(channelToken(hashKey, channelId));
  const got = Buffer.from(given ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---- where bookings go ----

/**
 * The calendar a booking for `resource` is written to: that resource's own link, else the
 * clinic-wide one, else null (the account's primary calendar: the original one-way behaviour).
 */
export async function calendarTargetFor(tx: Tx, resource: string): Promise<string | null> {
  const links = await tx.select().from(calendarLinks).where(eq(calendarLinks.writeBookings, true));
  return (
    links.find((l) => l.resource === resource)?.calendarId ??
    links.find((l) => l.resource === null)?.calendarId ??
    null
  );
}

// ---- connection state ----

export async function markReauthNeeded(tx: Tx, message: string) {
  await tx
    .insert(googleConnections)
    .values({ status: 'reauth_needed', lastError: message })
    .onConflictDoUpdate({
      target: googleConnections.tenantId,
      set: { status: 'reauth_needed', lastError: message },
    });
}

/** After a successful OAuth grant: record it and make sure there is something to sync. */
export async function recordGoogleConnected(
  tx: TenantTx,
  enqueue: Enqueue,
  tenantId: string,
  scopes: string | undefined,
) {
  await tx
    .insert(googleConnections)
    .values({ status: 'ok', scopes: scopes ?? null, lastError: null })
    .onConflictDoUpdate({
      target: googleConnections.tenantId,
      set: { status: 'ok', scopes: scopes ?? null, lastError: null },
    });
  let links = await tx.select().from(calendarLinks);
  // Default: the account's primary calendar is the clinic-wide calendar (staff refine it in Settings).
  if (!links.length)
    links = await tx
      .insert(calendarLinks)
      .values({ calendarId: 'primary', label: 'Primary calendar', resource: null })
      .returning();
  for (const l of links)
    await enqueue(tx, QUEUES.calendarSync, { tenantId, linkId: l.id, full: true }, { singletonKey: l.id });
}

// ---- sync ----

type SyncResult =
  { skipped: string } | { error: string } | { upserted: number; deleted: number; full: boolean };

export async function syncLink(
  deps: CalendarDeps,
  tenantId: string,
  linkId: string,
  opts: { full?: boolean } = {},
): Promise<SyncResult> {
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [link] = await tx.select().from(calendarLinks).where(eq(calendarLinks.id, linkId));
    const [conn] = await tx.select().from(googleConnections);
    const tz = (await getActiveConfig(tx))?.config.locale.timezone;
    const calendar = link ? await deps.calendarFor(tx, tenantId) : null;
    const own = await tx
      .select({ id: appointments.googleEventId })
      .from(appointments)
      .where(isNotNull(appointments.googleEventId));
    return { link, conn, tz, calendar, own: new Set(own.map((r) => r.id)) };
  });
  const { link, conn, tz, calendar, own } = loaded;
  if (!link || !tz || !calendar) return { skipped: 'not connected' };
  if (!link.readBusy) return { skipped: 'write-only calendar' };
  if (conn?.status === 'reauth_needed') return { skipped: 'reauth_needed' };

  const now = deps.clock.now();
  const window = { from: new Date(now.getTime() - PAST_MS), to: new Date(now.getTime() + FUTURE_MS) };
  let full = Boolean(opts.full) || !link.syncToken;
  let fetched: { events: ExternalEvent[]; nextSyncToken: string } | undefined;
  for (let attempt = 0; !fetched; attempt++) {
    try {
      fetched = await calendar.listChanges(link.calendarId, {
        syncToken: full ? null : link.syncToken,
        ...window,
      });
    } catch (err) {
      if (err instanceof SyncTokenGoneError && !full && attempt < 2) {
        full = true; // 410: forget everything we knew and start over
        continue;
      }
      await withTenant(deps.db, tenantId, async (tx) => {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof GoogleAuthError) await markReauthNeeded(tx, message);
        await tx.update(calendarLinks).set({ lastError: message }).where(eq(calendarLinks.id, linkId));
      });
      if (err instanceof GoogleAuthError || (err instanceof ChannelError && !err.retryable))
        return { error: (err as Error).message };
      throw err; // transient: pg-boss retries
    }
  }

  const { events: changed, nextSyncToken } = fetched;
  return withTenant(deps.db, tenantId, async (tx) => {
    if (full)
      await tx
        .delete(blockedTimes)
        .where(and(eq(blockedTimes.linkId, linkId), eq(blockedTimes.source, 'google')));
    const counts = await applyEvents(tx, link, changed, tz, own);
    await tx
      .update(calendarLinks)
      .set({
        syncToken: nextSyncToken || null,
        lastSyncedAt: now,
        ...(full ? { lastFullSyncAt: now } : {}),
        lastError: null,
      })
      .where(eq(calendarLinks.id, linkId));
    return { ...counts, full };
  });
}

/** Idempotent: re-applying the same events changes nothing. */
async function applyEvents(
  tx: Tx,
  link: typeof calendarLinks.$inferSelect,
  events: ExternalEvent[],
  tz: string,
  own: Set<string | null>,
) {
  let upserted = 0;
  const toDelete: string[] = [];
  for (const ev of events) {
    const block = own.has(ev.id) ? null : blockFor(ev, tz);
    if (!block) {
      toDelete.push(ev.id);
      continue;
    }
    await tx
      .insert(blockedTimes)
      .values({
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        resource: link.resource,
        reason: 'Google Calendar', // never the event title: it can be private
        source: 'google',
        externalId: ev.id,
        linkId: link.id,
      })
      .onConflictDoUpdate({
        target: [blockedTimes.linkId, blockedTimes.externalId],
        targetWhere: sql`source = 'google'`,
        set: { startsAt: block.startsAt, endsAt: block.endsAt, resource: link.resource },
      });
    upserted++;
  }
  if (toDelete.length)
    await tx
      .delete(blockedTimes)
      .where(
        and(
          eq(blockedTimes.linkId, link.id),
          eq(blockedTimes.source, 'google'),
          inArray(blockedTimes.externalId, toDelete),
        ),
      );
  return { upserted, deleted: toDelete.length };
}

// ---- push channels ----

/** Keep one live `events.watch` channel per link (renewed ~2 days before the 7-day expiry). Never fatal: polling covers a failure. */
export async function ensureChannel(deps: CalendarDeps, tenantId: string, linkId: string) {
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [link] = await tx.select().from(calendarLinks).where(eq(calendarLinks.id, linkId));
    const [conn] = await tx.select().from(googleConnections);
    return { link, conn, calendar: link ? await deps.calendarFor(tx, tenantId) : null };
  });
  const { link, conn, calendar } = loaded;
  if (!link?.readBusy || !calendar || conn?.status === 'reauth_needed') return 'skipped';
  const address = `${deps.env.APP_URL}${WEBHOOK_PATH}`;
  // Google only delivers to HTTPS with a valid certificate; locally we poll.
  if (calendar.provider !== 'fake' && !address.startsWith('https://')) return 'no public https url';
  const now = deps.clock.now().getTime();
  if (link.channelId && link.channelExpiresAt && link.channelExpiresAt.getTime() - now > RENEW_BEFORE_MS)
    return 'live';
  try {
    const channelId = randomUUID();
    const ch = await calendar.watch(link.calendarId, {
      channelId,
      token: channelToken(deps.hashKey, channelId),
      address,
      ttlSeconds: CHANNEL_TTL_S,
    });
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(calendarLinks)
        .set({ channelId: ch.channelId, channelResourceId: ch.resourceId, channelExpiresAt: ch.expiresAt })
        .where(eq(calendarLinks.id, linkId)),
    );
    // Overlap, then retire the old channel.
    if (link.channelId && link.channelResourceId)
      await calendar.stopChannel(link.channelId, link.channelResourceId).catch(() => undefined);
    return 'renewed';
  } catch (err) {
    if (err instanceof GoogleAuthError) throw err;
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(calendarLinks)
        .set({ lastError: `push notifications unavailable (polling instead): ${(err as Error).message}` })
        .where(eq(calendarLinks.id, linkId)),
    );
    return 'watch failed';
  }
}

export async function runCalendarSync(deps: CalendarDeps, job: JobData['calendar-sync']) {
  const sync = await syncLink(deps, job.tenantId, job.linkId, { full: job.full ?? false });
  const channel = await ensureChannel(deps, job.tenantId, job.linkId).catch(() => 'auth');
  return { sync, channel };
}

/** Every 5 minutes: queue a sync for each link that is due (the poll fallback, channel renewal, nightly full sync). */
export async function sweepCalendars(deps: CalendarDeps) {
  const now = deps.clock.now().getTime();
  let queued = 0;
  for (const l of await deps.system.calendarLinksForSweep()) {
    const live = Boolean(l.channelId && l.channelExpiresAt && l.channelExpiresAt.getTime() > now);
    const expiring = !l.channelExpiresAt || l.channelExpiresAt.getTime() - now < RENEW_BEFORE_MS;
    const full = !l.lastFullSyncAt || now - l.lastFullSyncAt.getTime() > DAY;
    const stale = !l.lastSyncedAt || now - l.lastSyncedAt.getTime() >= (live ? BACKSTOP_MS : 0);
    if (!(full || stale || expiring)) continue;
    await deps.enqueue(
      null,
      QUEUES.calendarSync,
      { tenantId: l.tenantId, linkId: l.linkId, full },
      { singletonKey: l.linkId },
    );
    queued++;
  }
  return { queued };
}

// ---- before booking ----

/**
 * Right before a booking: ask Google about the chosen time, so an event the push notification has not
 * delivered yet still blocks it. Only for calendars not synced in the last minute; 3 s cap; if Google is
 * unreachable we proceed (the sync and the staff conflict flow are the safety net, and the database
 * exclusion constraint still prevents double bookings among ourselves).
 */
export async function recheckExternalBusy(
  deps: Pick<CalendarDeps, 'db' | 'clock' | 'calendarFor'>,
  tenantId: string,
  input: { service: string; date: string; time: string },
) {
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const links = (await tx.select().from(calendarLinks).where(eq(calendarLinks.readBusy, true))).filter(
      (l) => l.syncToken, // never synced = nothing to compare against yet
    );
    if (!links.length) return null;
    const config = (await getActiveConfig(tx))?.config;
    const calendar = await deps.calendarFor(tx, tenantId);
    return config && calendar ? { links, config, calendar } : null;
  });
  if (!loaded) return;
  const { links, config, calendar } = loaded;
  const service = config.booking.services.find(
    (s) => s.name.toLowerCase() === input.service.trim().toLowerCase(),
  );
  if (!service) return;
  const now = deps.clock.now().getTime();
  const start = zonedTimeToUtc(input.date, input.time, config.locale.timezone);
  const end = new Date(start.getTime() + (service.duration_minutes + config.booking.buffer_minutes) * MINUTE);
  for (const link of links) {
    if (link.lastSyncedAt && now - link.lastSyncedAt.getTime() < MINUTE) continue;
    try {
      const found = await Promise.race([
        calendar.listWindow(link.calendarId, start, end),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      const own = new Set(
        (
          await withTenant(deps.db, tenantId, (tx) =>
            tx
              .select({ id: appointments.googleEventId })
              .from(appointments)
              .where(isNotNull(appointments.googleEventId)),
          )
        ).map((r) => r.id),
      );
      await withTenant(deps.db, tenantId, (tx) => applyEvents(tx, link, found, config.locale.timezone, own));
    } catch {
      // fail open: see above
    }
  }
}

// ---- who has which resource ----

export async function knownResources(tx: Tx) {
  const rows = await tx.selectDistinct({ resource: availabilityRules.resource }).from(availabilityRules);
  return rows.map((r) => r.resource);
}
