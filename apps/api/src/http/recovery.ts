import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { withTenant } from '../db/client.ts';
import { BookingError } from '../booking.ts';
import { commandCenter } from '../command-center.ts';
import { getActiveConfig } from '../config-store.ts';
import {
  leads,
  OPPORTUNITY_KINDS,
  OPPORTUNITY_STATUSES,
  opportunities,
  waitlistEntries,
} from '../db/schema.ts';
import { joinWaitlist } from '../waitlist.ts';
import { QUEUES } from '../jobs.ts';
import { emit } from '../leads.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);

export function registerRecoveryRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;
  const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;

  // Today → command center: today's numbers, what needs a person, and the assistant's impact.
  app.get('/v1/command-center', { preHandler: staff }, (req) =>
    withTenant(ctx.db, tenantOf(req), async (tx) => {
      const config = (await getActiveConfig(tx))?.config;
      if (!config) throw new Error('tenant has no config');
      return commandCenter(tx, config, ctx.clock.now());
    }),
  );

  app.get('/v1/opportunities', { preHandler: staff }, (req) => {
    const q = z
      .object({
        status: z.enum(['active', 'closed', ...OPPORTUNITY_STATUSES]).default('active'),
        kind: z.enum(OPPORTUNITY_KINDS).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    const statuses =
      q.status === 'active'
        ? (['open', 'needs_approval', 'actioned'] as const)
        : q.status === 'closed'
          ? (['won', 'lost', 'dismissed'] as const)
          : [q.status];
    return withTenant(ctx.db, tenantOf(req), (tx) =>
      tx
        .select({
          id: opportunities.id,
          kind: opportunities.kind,
          status: opportunities.status,
          priority: opportunities.priority,
          reason: opportunities.reason,
          recommendedAction: opportunities.recommendedAction,
          detectedAt: opportunities.detectedAt,
          aiActed: opportunities.aiActed,
          actedAt: opportunities.actedAt,
          outcome: opportunities.outcome,
          outcomeAt: opportunities.outcomeAt,
          valueInr: opportunities.valueInr,
          valueSource: opportunities.valueSource,
          slotStartsAt: opportunities.slotStartsAt,
          slotService: opportunities.slotService,
          slotResource: opportunities.slotResource,
          leadId: opportunities.leadId,
          leadName: leads.name,
          leadPhone: leads.phoneE164,
        })
        .from(opportunities)
        .leftJoin(leads, eq(leads.id, opportunities.leadId))
        .where(
          and(
            inArray(opportunities.status, [...statuses]),
            q.kind ? eq(opportunities.kind, q.kind) : undefined,
          ),
        )
        .orderBy(desc(opportunities.priority), desc(opportunities.detectedAt))
        .limit(q.limit),
    );
  });

  // Staff approve the assistant's action (needs-approval items, or a send that failed and was fixed).
  app.post('/v1/opportunities/:id/approve', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const tenantId = tenantOf(req);
    const by = req.principal?.kind === 'user' ? req.principal.userId : 'api';
    const done = await withTenant(ctx.db, tenantId, async (tx) => {
      const [o] = await tx.select().from(opportunities).where(eq(opportunities.id, id)).for('update');
      if (!o) return 'missing' as const;
      if (!['open', 'needs_approval'].includes(o.status) || (!o.leadId && o.kind !== 'EMPTY_SLOT'))
        return 'not_actionable' as const;
      if (o.kind === 'EMPTY_SLOT')
        await ctx.enqueue(
          tx,
          QUEUES.slotRecovery,
          { tenantId, opportunityId: id, approved: true },
          { singletonKey: `${id}:approved` },
        );
      else
        await ctx.enqueue(
          tx,
          QUEUES.opportunityAct,
          { tenantId, opportunityId: id, approvedBy: by },
          { singletonKey: `${id}:approved` },
        );
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'opportunity.approved',
        entityType: 'opportunity',
        entityId: id,
      });
      return 'ok' as const;
    });
    if (done === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (done === 'not_actionable') return reply.code(409).send({ error: 'not_actionable' });
    return { queued: true };
  });

  // ---- Waitlist (staff view; patients join through the assistant) ----

  app.get('/v1/waitlist', { preHandler: staff }, (req) =>
    withTenant(ctx.db, tenantOf(req), (tx) =>
      tx
        .select({
          id: waitlistEntries.id,
          leadId: waitlistEntries.leadId,
          leadName: leads.name,
          leadPhone: leads.phoneE164,
          service: waitlistEntries.service,
          resource: waitlistEntries.resource,
          attendeeName: waitlistEntries.attendeeName,
          fromDate: waitlistEntries.fromDate,
          toDate: waitlistEntries.toDate,
          partOfDay: waitlistEntries.partOfDay,
          wantsEarlier: sql<boolean>`${waitlistEntries.appointmentId} is not null`,
          source: waitlistEntries.source,
          joinedAt: waitlistEntries.joinedAt,
        })
        .from(waitlistEntries)
        .innerJoin(leads, eq(leads.id, waitlistEntries.leadId))
        .where(eq(waitlistEntries.status, 'waiting'))
        .orderBy(asc(waitlistEntries.joinedAt)),
    ),
  );

  app.post('/v1/waitlist', { preHandler: staff }, async (req, reply) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
    const b = z
      .strictObject({
        lead_id: z.uuid(),
        service: z.string().min(1).max(80),
        from_date: date.optional(),
        to_date: date.optional(),
        part_of_day: z.enum(['morning', 'afternoon', 'evening']).optional(),
        for_name: z.string().trim().min(1).max(60).optional(),
        resource: z.string().trim().min(1).max(60).optional(),
      })
      .parse(req.body);
    try {
      const r = await joinWaitlist(ctx, tenantOf(req), {
        leadId: b.lead_id,
        service: b.service,
        fromDate: b.from_date,
        toDate: b.to_date,
        partOfDay: b.part_of_day,
        forName: b.for_name,
        resource: b.resource,
        source: 'staff',
      });
      return reply.code(201).send(r);
    } catch (err) {
      if (err instanceof BookingError)
        return reply
          .code(err.code === 'no_appointment' ? 404 : 422)
          .send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.delete('/v1/waitlist/:id', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const rows = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const r = await tx
        .update(waitlistEntries)
        .set({ status: 'removed' })
        .where(and(eq(waitlistEntries.id, id), eq(waitlistEntries.status, 'waiting')))
        .returning({ id: waitlistEntries.id });
      if (r.length)
        await audit(tx, ctx.clock, actor(req.principal), {
          action: 'waitlist.removed',
          entityType: 'waitlist_entry',
          entityId: id,
        });
      return r;
    });
    return rows.length ? { removed: true } : reply.code(404).send({ error: 'not_found' });
  });

  // Staff close it themselves: they called and booked (won), it went nowhere (lost), or it was not worth doing (dismissed).
  for (const status of ['won', 'lost', 'dismissed'] as const)
    app.post(
      `/v1/opportunities/:id/${status === 'dismissed' ? 'dismiss' : status}`,
      { preHandler: staff },
      async (req, reply) => {
        const id = idParam(req);
        const { note } = z
          .strictObject({ note: z.string().trim().max(300).optional() })
          .parse(req.body ?? {});
        const row = await withTenant(ctx.db, tenantOf(req), async (tx) => {
          const [o] = await tx
            .update(opportunities)
            .set({ status, outcome: note ?? `marked ${status} by staff`, outcomeAt: ctx.clock.now() })
            .where(
              and(
                eq(opportunities.id, id),
                inArray(opportunities.status, ['open', 'needs_approval', 'actioned']),
              ),
            )
            .returning();
          if (!o) return null;
          if (status === 'won')
            await emit(tx, ctx.clock, 'opportunity.won', {
              leadId: o.leadId,
              opportunityId: id,
              kind: o.kind,
              by: 'staff',
            });
          await audit(tx, ctx.clock, actor(req.principal), {
            action: `opportunity.${status}`,
            entityType: 'opportunity',
            entityId: id,
          });
          return o;
        });
        return row ?? reply.code(404).send({ error: 'not_found_or_closed' });
      },
    );
}
