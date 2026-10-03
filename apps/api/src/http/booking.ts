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
  appointmentsAffectedBy,
  handleBlockedAppointments,
  notifyRunningLate,
} from '../booking.ts';
import { withTenant } from '../db/client.ts';
import { appointments, availabilityRules, blockedTimes, leads } from '../db/schema.ts';
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
  ambiguous: 409,
  too_late: 409,
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
          attendeeName: appointments.attendeeName,
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
      .strictObject({
        lead_id: z.uuid(),
        service: z.string().min(1),
        date,
        time,
        /** The visit is for someone else (a child): their name. */
        for_name: z.string().trim().min(1).max(60).optional(),
        /** The clinic's treatment plan this visit is for. */
        treatment_plan_id: z.uuid().optional(),
      })
      .parse(req.body);
    return bookingErrors(reply, async () => {
      const r = await bookSlot(ctx, tenantOf(req), {
        leadId: body.lead_id,
        service: body.service,
        date: body.date,
        time: body.time,
        source: 'staff',
        forName: body.for_name,
        treatmentPlanId: body.treatment_plan_id,
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
      return rescheduleLeadAppointment(ctx, tenantOf(req), {
        leadId: appt.leadId,
        ...body,
        source: 'staff',
        appointmentId: appt.id,
      });
    });
  });

  // Today -> Running late: today's remaining booked people get the running_late template (once per delay).
  app.post('/v1/appointments/running-late', { preHandler: staff }, async (req) => {
    const body = z
      .strictObject({
        minutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
        resource: z.string().min(1).optional(),
      })
      .parse(req.body);
    const sent = await notifyRunningLate(ctx, tenantOf(req), body);
    await withTenant(ctx.db, tenantOf(req), (tx) =>
      audit(tx, ctx.clock, actor(req.principal), {
        action: 'appointments.running_late',
        entityType: 'appointment',
        details: { minutes: body.minutes, resource: body.resource ?? null, notified: sent.length },
      }),
    );
    return { notified: sent.filter((s) => s.status === 'sent').length, results: sent };
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
        const updated = await updateAppointment(
          ctx,
          tenantOf(req),
          id,
          kind,
          kind === 'cancelled' ? { cancelReason: 'staff' } : {},
        );
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
      // Each upcoming block with the bookings still inside it (staff decide whether to notify).
      blocked: await (async () => {
        const rows = await tx
          .select()
          .from(blockedTimes)
          .where(gte(blockedTimes.endsAt, ctx.clock.now()))
          .orderBy(asc(blockedTimes.startsAt));
        const out = [];
        for (const b of rows) out.push({ ...b, affected: await appointmentsAffectedBy(tx, b) });
        return out;
      })(),
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
    // Bookings already inside the new block: shown to staff, who choose to notify (nothing is sent yet).
    const affected = await withTenant(ctx.db, tenantOf(req), (tx) => appointmentsAffectedBy(tx, row!));
    return reply.code(201).send({ ...row, affected });
  });

  // "Tell patients & offer new times": move each booking to another free doctor at the same time, or
  // cancel it as clinic_unavailable and send the appointment_change template. Idempotent.
  app.post('/v1/blocked-times/:id/notify', { preHandler: admins }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return bookingErrors(reply, async () => {
      const results = await handleBlockedAppointments(ctx, tenantOf(req), id);
      await withTenant(ctx.db, tenantOf(req), (tx) =>
        audit(tx, ctx.clock, actor(req.principal), {
          action: 'blocked_time.notified',
          entityType: 'blocked_time',
          entityId: id,
          details: {
            moved: results.filter((r) => r.action === 'moved').length,
            notified: results.filter((r) => r.action === 'notified').length,
          },
        }),
      );
      return { results };
    });
  });

  app.delete('/v1/blocked-times/:id', { preHandler: admins }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const rows = await withTenant(ctx.db, tenantOf(req), (tx) =>
      tx.delete(blockedTimes).where(eq(blockedTimes.id, id)).returning(),
    );
    return rows.length ? { deleted: true } : reply.code(404).send({ error: 'not_found' });
  });
}
