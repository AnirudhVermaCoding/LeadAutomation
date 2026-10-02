import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ChannelError,
  exchangeGoogleCode,
  googleConsentUrl,
  GOOGLE_CALENDAR_LIST_SCOPE,
} from '@instantlead/integrations';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { channelTokenValid, knownResources, recordGoogleConnected } from '../calendar-sync.ts';
import { withTenant } from '../db/client.ts';
import { appointments, blockedTimes, calendarLinks, googleConnections, oauthNonces } from '../db/schema.ts';
import { QUEUES } from '../jobs.ts';
import { deleteTenantSecret, getTenantSecret, setTenantSecret } from '../secrets.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);

// OAuth state = tenant + expiry, HMAC-signed: proves the callback belongs to a flow we started.
const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');
function makeState(key: Buffer, tenantId: string, expiresAt: number) {
  const payload = `${tenantId}.${expiresAt}.${randomBytes(8).toString('base64url')}`;
  return `${payload}.${sign(key, payload)}`;
}
function readState(key: Buffer, state: string, now: number) {
  const i = state.lastIndexOf('.');
  const payload = state.slice(0, i);
  const given = Buffer.from(state.slice(i + 1));
  const expected = Buffer.from(sign(key, payload));
  const [tenantId, expiresAt, nonce] = payload.split('.');
  if (i < 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return tenantId && nonce && Number(expiresAt) > now ? { tenantId, nonce } : null;
}

const LinkBody = z.strictObject({
  calendar_id: z.string().trim().min(1).max(300),
  label: z.string().trim().max(100).optional(),
  /** A doctor / agent name from the availability table, or null = clinic-wide (blocks everyone). */
  resource: z.string().trim().min(1).max(60).nullable(),
  read_busy: z.boolean().default(true),
  write_bookings: z.boolean().default(true),
});

/** Google Calendar: connect, map calendars to doctors / agents, status, push notifications. */
export function registerGoogleRoutes(app: FastifyInstance, ctx: AppContext) {
  const admins = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const staff = guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;
  const available = () => Boolean(ctx.googleOAuth) || ctx.allowFakeChannel;

  app.get('/v1/integrations/google/start', { preHandler: admins }, (req, reply) => {
    if (!ctx.googleOAuth) return reply.code(503).send({ error: 'google_not_configured' });
    const state = makeState(ctx.hashKey, tenantOf(req), ctx.clock.now().getTime() + 10 * 60_000);
    return { url: googleConsentUrl(ctx.googleOAuth, state) };
  });

  app.get('/v1/integrations/google/callback', async (req, reply) => {
    const oauth = ctx.googleOAuth;
    const q = z
      .object({ code: z.string().min(1).optional(), state: z.string().min(1), error: z.string().optional() })
      .parse(req.query);
    const state = readState(ctx.hashKey, q.state, ctx.clock.now().getTime());
    if (!oauth || !state)
      return reply.code(400).type('text/plain').send('This link has expired. Start again from Settings.');
    const { tenantId } = state;
    // Single use: a replayed callback (browser history, a leaked URL) must do nothing.
    const fresh = await withTenant(ctx.db, tenantId, async (tx) => {
      const rows = await tx
        .insert(oauthNonces)
        .values({ nonce: state.nonce })
        .onConflictDoNothing()
        .returning({ id: oauthNonces.id });
      return rows.length > 0;
    });
    if (!fresh)
      return reply
        .code(400)
        .type('text/plain')
        .send('This link was already used. Start again from Settings.');
    if (q.error || !q.code) return reply.redirect(`${ctx.env.APP_URL}/settings?google=denied`);
    const tokens = await exchangeGoogleCode(oauth, q.code).catch(() => null);
    if (!tokens) return reply.redirect(`${ctx.env.APP_URL}/settings?google=error`);
    if (!tokens.refresh_token) return reply.redirect(`${ctx.env.APP_URL}/settings?google=no_refresh_token`);
    const refreshToken = tokens.refresh_token;
    await withTenant(ctx.db, tenantId, async (tx) => {
      await setTenantSecret(tx, ctx.secretsKey, tenantId, 'google_refresh_token', refreshToken);
      await recordGoogleConnected(tx, ctx.enqueue, tenantId, tokens.scope);
      await audit(
        tx,
        ctx.clock,
        { type: 'system' },
        { action: 'integration.google.connected', entityType: 'integration', entityId: 'google' },
      );
    });
    return reply.redirect(`${ctx.env.APP_URL}/settings?google=connected`);
  });

  // Connection state, the calendar → doctor / agent mapping and what each calendar is doing.
  app.get('/v1/integrations/google', { preHandler: staff }, async (req) => {
    const tenantId = tenantOf(req);
    return withTenant(ctx.db, tenantId, async (tx) => {
      const [conn] = await tx.select().from(googleConnections);
      const hasSecret =
        (await getTenantSecret(tx, ctx.secretsKey, tenantId, 'google_refresh_token')) !== null;
      const links = await tx.select().from(calendarLinks).orderBy(calendarLinks.createdAt);
      const blocks = await tx
        .select({ linkId: blockedTimes.linkId, n: count() })
        .from(blockedTimes)
        .where(eq(blockedTimes.source, 'google'))
        .groupBy(blockedTimes.linkId);
      const now = ctx.clock.now().getTime();
      return {
        available: available(),
        /** No Google client configured: the in-memory demo Google (mock mode). */
        mock: ctx.googleOAuth === null,
        connected: Boolean(conn) || hasSecret,
        status: conn?.status ?? (hasSecret ? 'ok' : null),
        last_error: conn?.lastError ?? null,
        // Connections made before the picker scope existed can still type a calendar id.
        can_list_calendars:
          ctx.googleOAuth === null
            ? ctx.allowFakeChannel
            : (conn?.scopes ?? '').includes(GOOGLE_CALENDAR_LIST_SCOPE),
        resources: await knownResources(tx),
        links: links.map((l) => ({
          id: l.id,
          calendar_id: l.calendarId,
          label: l.label,
          resource: l.resource,
          read_busy: l.readBusy,
          write_bookings: l.writeBookings,
          last_synced_at: l.lastSyncedAt,
          last_error: l.lastError,
          push: Boolean(l.channelId && l.channelExpiresAt && l.channelExpiresAt.getTime() > now),
          blocked_events: Number(blocks.find((b) => b.linkId === l.id)?.n ?? 0),
        })),
      };
    });
  });

  app.get('/v1/integrations/google/calendars', { preHandler: admins }, async (req, reply) => {
    const tenantId = tenantOf(req);
    const calendar = await withTenant(ctx.db, tenantId, (tx) => ctx.calendarFor(tx, tenantId));
    if (!calendar) return reply.code(409).send({ error: 'google_not_connected' });
    try {
      return { items: await calendar.listCalendars() };
    } catch (err) {
      if (err instanceof ChannelError && !err.retryable) return { items: [], error: 'picker_unavailable' };
      throw err;
    }
  });

  // Replace the whole mapping (the Settings table edits it as a unit). Sync state of kept calendars survives.
  app.put('/v1/integrations/google/links', { preHandler: admins }, async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = z.array(LinkBody).max(30).parse(req.body);
    if (new Set(body.map((b) => b.calendar_id)).size !== body.length)
      return reply
        .code(422)
        .send({ error: 'duplicate_calendar', message: 'Each calendar can be linked once' });
    const result = await withTenant(ctx.db, tenantId, async (tx) => {
      const known = await knownResources(tx);
      const bad = body.find((b) => b.resource !== null && !known.includes(b.resource));
      if (bad)
        return { error: `Unknown doctor / agent "${bad.resource}". Add them under Bookable hours first.` };
      const existing = await tx.select().from(calendarLinks);
      const keep = new Set(body.map((b) => b.calendar_id));
      const gone = existing.filter((l) => !keep.has(l.calendarId));
      if (gone.length)
        await tx.delete(calendarLinks).where(
          inArray(
            calendarLinks.id,
            gone.map((l) => l.id),
          ),
        ); // its Google-sourced blocks cascade
      const changed: string[] = [];
      for (const b of body) {
        const prev = existing.find((l) => l.calendarId === b.calendar_id);
        const values = {
          label: b.label ?? null,
          resource: b.resource,
          readBusy: b.read_busy,
          writeBookings: b.write_bookings,
        };
        if (prev) {
          await tx.update(calendarLinks).set(values).where(eq(calendarLinks.id, prev.id));
          // Moved to another doctor: its blocks follow.
          if (prev.resource !== b.resource)
            await tx
              .update(blockedTimes)
              .set({ resource: b.resource })
              .where(and(eq(blockedTimes.linkId, prev.id), eq(blockedTimes.source, 'google')));
          if (prev.readBusy !== b.read_busy) changed.push(prev.id);
        } else {
          const [row] = await tx
            .insert(calendarLinks)
            .values({ calendarId: b.calendar_id, ...values })
            .returning();
          if (row) changed.push(row.id);
        }
      }
      for (const id of changed)
        await ctx.enqueue(
          tx,
          QUEUES.calendarSync,
          { tenantId, linkId: id, full: true },
          { singletonKey: id },
        );
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'integration.google.links_updated',
        entityType: 'integration',
        entityId: 'google',
        details: { links: body.length },
      });
      return { ok: true as const, gone };
    });
    if ('error' in result) return reply.code(422).send({ error: 'invalid_mapping', message: result.error });
    // Retire push channels of unlinked calendars (best effort).
    const calendar = await withTenant(ctx.db, tenantId, (tx) => ctx.calendarFor(tx, tenantId));
    for (const l of result.gone)
      if (calendar && l.channelId && l.channelResourceId)
        await calendar.stopChannel(l.channelId, l.channelResourceId).catch(() => undefined);
    return { links: body.length };
  });

  app.post('/v1/integrations/google/sync', { preHandler: admins }, async (req) => {
    const tenantId = tenantOf(req);
    return withTenant(ctx.db, tenantId, async (tx) => {
      const links = await tx.select().from(calendarLinks).where(eq(calendarLinks.readBusy, true));
      for (const l of links)
        await ctx.enqueue(
          tx,
          QUEUES.calendarSync,
          { tenantId, linkId: l.id, full: true },
          { singletonKey: l.id },
        );
      return { queued: links.length };
    });
  });

  // Revoke our access: stop push channels, forget busy time and the token. Events we wrote stay in their calendar.
  app.post('/v1/integrations/google/disconnect', { preHandler: admins }, async (req) => {
    const tenantId = tenantOf(req);
    const calendar = await withTenant(ctx.db, tenantId, (tx) => ctx.calendarFor(tx, tenantId));
    const links = await withTenant(ctx.db, tenantId, (tx) => tx.select().from(calendarLinks));
    for (const l of links)
      if (calendar && l.channelId && l.channelResourceId)
        await calendar.stopChannel(l.channelId, l.channelResourceId).catch(() => undefined);
    await withTenant(ctx.db, tenantId, async (tx) => {
      await tx.delete(calendarLinks); // blocks cascade
      await tx.delete(googleConnections);
      await deleteTenantSecret(tx, tenantId, 'google_refresh_token');
      await tx.update(appointments).set({ googleEventId: null, googleCalendarId: null });
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'integration.google.disconnected',
        entityType: 'integration',
        entityId: 'google',
      });
    });
    return { disconnected: true };
  });

  // Google's push notifications: no body, just headers. The token proves it is our channel.
  app.post('/webhooks/google-calendar', async (req, reply) => {
    const channelId = req.headers['x-goog-channel-id'];
    if (typeof channelId !== 'string') return reply.code(400).send({ error: 'bad_request' });
    const link = await ctx.system.findCalendarChannel(channelId);
    if (!link) return reply.code(404).send({ error: 'unknown_channel' });
    const token = req.headers['x-goog-channel-token'];
    if (!channelTokenValid(ctx.hashKey, channelId, typeof token === 'string' ? token : undefined))
      return reply.code(403).send({ error: 'bad_token' });
    // `sync` is just "channel created". Anything else: sync now (a burst collapses into one job).
    if (req.headers['x-goog-resource-state'] !== 'sync')
      await ctx.enqueue(
        null,
        QUEUES.calendarSync,
        { tenantId: link.tenantId, linkId: link.linkId },
        { singletonKey: link.linkId },
      );
    return reply.code(200).send();
  });

  // ---- Mock mode only: play Google (demo sandbox, simulator, tests) ----
  const mock = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const mockOnly = (reply: FastifyReply) =>
    ctx.allowFakeChannel && !ctx.googleOAuth ? null : reply.code(404).send({ error: 'not_found' });

  app.post('/v1/dev/google/connect', { preHandler: mock }, async (req, reply) => {
    if (mockOnly(reply)) return reply;
    const tenantId = tenantOf(req);
    ctx.fakeGoogleFor(tenantId);
    await withTenant(ctx.db, tenantId, (tx) =>
      recordGoogleConnected(tx, ctx.enqueue, tenantId, `calendar.events ${GOOGLE_CALENDAR_LIST_SCOPE}`),
    );
    return { connected: true };
  });

  // Someone creates an event in Google Calendar (not through InstantLead); the sync picks it up.
  app.post('/v1/dev/google/external-event', { preHandler: mock }, async (req, reply) => {
    if (mockOnly(reply)) return reply;
    const b = z
      .strictObject({
        starts_at: z.iso.datetime({ offset: true }),
        ends_at: z.iso.datetime({ offset: true }),
        calendar_id: z.string().default('primary'),
      })
      .parse(req.body);
    const id = ctx.fakeGoogleFor(tenantOf(req)).addExternalEvent({
      start: new Date(b.starts_at),
      end: new Date(b.ends_at),
      calendarId: b.calendar_id,
    });
    await withTenant(ctx.db, tenantOf(req), async (tx) => {
      for (const l of await tx
        .select()
        .from(calendarLinks)
        .where(eq(calendarLinks.calendarId, b.calendar_id)))
        await ctx.enqueue(
          tx,
          QUEUES.calendarSync,
          { tenantId: tenantOf(req), linkId: l.id },
          { singletonKey: l.id },
        );
    });
    return { id };
  });

  app.post('/v1/dev/google/revoke', { preHandler: mock }, (req, reply) => {
    if (mockOnly(reply)) return reply;
    ctx.fakeGoogleFor(tenantOf(req)).revoked = true;
    return { revoked: true };
  });
}
