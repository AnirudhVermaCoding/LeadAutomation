import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { exchangeGoogleCode, googleConsentUrl } from '@instantlead/integrations';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import {
  BookingError,
  bookSlot,
  findSlots,
  rescheduleLeadAppointment,
  updateAppointment,
} from '../booking.ts';
import { withTenant } from '../db/client.ts';
import { appointments, availabilityRules, blockedTimes, leads } from '../db/schema.ts';
import { setTenantSecret } from '../secrets.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);

const STATUS_FOR_ERROR: Record<BookingError['code'], number> = {
  unknown_service: 422,
  unavailable: 409,
  taken: 409,
  already_booked: 409,
  no_appointment: 404,
  invalid_status: 409,
};
async function bookingErrors<T>(reply: FastifyReply, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BookingError)
      return reply.code(STATUS_FOR_ERROR[err.code]).send({ error: err.code, message: err.message });
    throw err;
  }
}

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
  const [tenantId, expiresAt] = payload.split('.');
  if (i < 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return tenantId && Number(expiresAt) > now ? tenantId : null;
}

export function registerBookingRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true });
  const admins = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;

  app.get('/v1/slots', { preHandler: staff }, async (req, reply) => {
    const q = z
      .object({
        service: z.string().min(1),
        date: date.optional(),
        prefer: z.enum(['morning', 'afternoon', 'evening']).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(req.query);
    // With an explicit limit the dashboard wants the raw list; without, chat-style offers.
    return bookingErrors(reply, () => findSlots(ctx, tenantOf(req), { ...q, spread: q.limit === undefined }));
  });

  app.get('/v1/appointments', { preHandler: staff }, async (req) => {
    const q = z
      .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
      .parse(req.query);
    return withTenant(ctx.db, tenantOf(req), (tx) =>
      tx
        .select({
          id: appointments.id,
          leadId: appointments.leadId,
          leadName: leads.name,
          leadPhone: leads.phoneE164,
          service: appointments.service,
          resource: appointments.resource,
          startsAt: appointments.startsAt,
          endsAt: appointments.endsAt,
          status: appointments.status,
          source: appointments.source,
        })
        .from(appointments)
        .innerJoin(leads, eq(leads.id, appointments.leadId))
        .where(and(gte(appointments.startsAt, new Date(q.from)), lt(appointments.startsAt, new Date(q.to))))
        .orderBy(asc(appointments.startsAt)),
    );
  });

  // Staff booking (e.g. a patient who called). Always confirmed: staff are the confirmation.
  app.post('/v1/appointments', { preHandler: staff }, async (req, reply) => {
    const body = z
      .strictObject({ lead_id: z.uuid(), service: z.string().min(1), date, time })
      .parse(req.body);
    return bookingErrors(reply, async () => {
      const r = await bookSlot(ctx, tenantOf(req), {
        leadId: body.lead_id,
        service: body.service,
        date: body.date,
        time: body.time,
        source: 'staff',
      });
      return reply.code(201).send(r);
    });
  });

  app.post('/v1/appointments/:id/reschedule', { preHandler: staff }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.strictObject({ date, time }).parse(req.body);
    return bookingErrors(reply, async () => {
      const [appt] = await withTenant(ctx.db, tenantOf(req), (tx) =>
        tx.select().from(appointments).where(eq(appointments.id, id)),
      );
      if (!appt) throw new BookingError('no_appointment', 'Appointment not found');
      return rescheduleLeadAppointment(ctx, tenantOf(req), { leadId: appt.leadId, ...body, source: 'staff' });
    });
  });

  // One-tap actions from the dashboard's Today view.
  for (const [path, kind] of [
    ['confirm', 'confirmed'],
    ['cancel', 'cancelled'],
    ['complete', 'completed'],
    ['no-show', 'no_show'],
  ] as const) {
    app.post(`/v1/appointments/:id/${path}`, { preHandler: staff }, async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      return bookingErrors(reply, async () => {
        const updated = await updateAppointment(ctx, tenantOf(req), id, kind);
        await withTenant(ctx.db, tenantOf(req), (tx) =>
          audit(tx, ctx.clock, actor(req.principal), {
            action: `appointment.${kind}`,
            entityType: 'appointment',
            entityId: id,
          }),
        );
        return updated;
      });
    });
  }

  // ---- Availability (replace-all; the dashboard edits the whole weekly table) ----

  app.get('/v1/availability', { preHandler: staff }, (req) =>
    withTenant(ctx.db, tenantOf(req), async (tx) => ({
      rules: await tx
        .select()
        .from(availabilityRules)
        .orderBy(asc(availabilityRules.resource), asc(availabilityRules.weekday)),
      blocked: await tx
        .select()
        .from(blockedTimes)
        .where(gte(blockedTimes.endsAt, ctx.clock.now()))
        .orderBy(asc(blockedTimes.startsAt)),
    })),
  );

  const Rule = z
    .strictObject({
      weekday: z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
      start_time: time,
      end_time: time,
      resource: z.string().trim().min(1).max(60).default('default'),
    })
    .refine((r) => r.start_time < r.end_time, 'start_time must be before end_time');
  app.put('/v1/availability', { preHandler: admins }, async (req) => {
    const rules = z.array(Rule).max(200).parse(req.body);
    return withTenant(ctx.db, tenantOf(req), async (tx) => {
      await tx.delete(availabilityRules);
      if (rules.length)
        await tx.insert(availabilityRules).values(
          rules.map((r) => ({
            weekday: r.weekday,
            startTime: r.start_time,
            endTime: r.end_time,
            resource: r.resource,
          })),
        );
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'availability.updated',
        entityType: 'availability',
        details: { rules: rules.length },
      });
      return { rules: rules.length };
    });
  });

  app.post('/v1/blocked-times', { preHandler: admins }, async (req, reply) => {
    const b = z
      .strictObject({
        starts_at: z.iso.datetime({ offset: true }),
        ends_at: z.iso.datetime({ offset: true }),
        resource: z.string().min(1).optional(),
        reason: z.string().max(200).optional(),
      })
      .refine((x) => x.starts_at < x.ends_at, 'starts_at must be before ends_at')
      .parse(req.body);
    const [row] = await withTenant(ctx.db, tenantOf(req), (tx) =>
      tx
        .insert(blockedTimes)
        .values({
          startsAt: new Date(b.starts_at),
          endsAt: new Date(b.ends_at),
          resource: b.resource ?? null,
          reason: b.reason ?? null,
        })
        .returning(),
    );
    return reply.code(201).send(row);
  });

  app.delete('/v1/blocked-times/:id', { preHandler: admins }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const rows = await withTenant(ctx.db, tenantOf(req), (tx) =>
      tx.delete(blockedTimes).where(eq(blockedTimes.id, id)).returning(),
    );
    return rows.length ? { deleted: true } : reply.code(404).send({ error: 'not_found' });
  });

  // ---- Google Calendar (optional one-way sync) ----

  app.get('/v1/integrations/google/start', { preHandler: admins }, (req, reply) => {
    if (!ctx.googleOAuth) return reply.code(503).send({ error: 'google_not_configured' });
    const state = makeState(ctx.secretsKey, tenantOf(req), ctx.clock.now().getTime() + 10 * 60_000);
    return { url: googleConsentUrl(ctx.googleOAuth, state) };
  });

  app.get('/v1/integrations/google/callback', async (req, reply) => {
    const oauth = ctx.googleOAuth;
    const q = z
      .object({ code: z.string().min(1).optional(), state: z.string().min(1), error: z.string().optional() })
      .parse(req.query);
    const tenantId = readState(ctx.secretsKey, q.state, ctx.clock.now().getTime());
    if (!oauth || !tenantId)
      return reply.code(400).type('text/plain').send('This link has expired. Start again from Settings.');
    if (q.error || !q.code) return reply.redirect(`${ctx.env.APP_URL}/settings?google=denied`);
    const tokens = await exchangeGoogleCode(oauth, q.code);
    if (!tokens.refresh_token) return reply.redirect(`${ctx.env.APP_URL}/settings?google=no_refresh_token`);
    const refreshToken = tokens.refresh_token;
    await withTenant(ctx.db, tenantId, async (tx) => {
      await setTenantSecret(tx, ctx.secretsKey, tenantId, 'google_refresh_token', refreshToken);
      await audit(
        tx,
        ctx.clock,
        { type: 'system' },
        { action: 'integration.google.connected', entityType: 'integration', entityId: 'google' },
      );
    });
    return reply.redirect(`${ctx.env.APP_URL}/settings?google=connected`);
  });
}
