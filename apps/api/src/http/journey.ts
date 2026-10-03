import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { withTenant } from '../db/client.ts';
import { leads, TREATMENT_PLAN_STATUSES, treatmentPlans } from '../db/schema.ts';
import {
  listInstallments,
  listPlans,
  markInstallment,
  ScheduleError,
  setInstallments,
  timeline,
} from '../journey.ts';
import { emit } from '../leads.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);
const userId = (p: Principal | null) => (p?.kind === 'user' ? p.userId : null);

const money = z.number().min(0).max(100_000_000).nullable();
/** What staff can set on a plan. Everything is the clinic's own information; the AI never writes plans. */
const PlanFields = z.strictObject({
  title: z.string().trim().min(2).max(120),
  service: z.string().trim().min(1).max(80).nullable(),
  attendee_name: z.string().trim().min(1).max(60).nullable(),
  status: z.enum(TREATMENT_PLAN_STATUSES),
  visits_planned: z.int().min(1).max(50).nullable(),
  visits_done: z.int().min(0).max(50),
  visit_interval_days: z.int().min(1).max(365).nullable(),
  next_visit_due_at: z.iso.datetime({ offset: true }).nullable(),
  recall_due_at: z.iso.datetime({ offset: true }).nullable(),
  value_inr: money,
  paid_inr: money,
  notes: z.string().trim().max(1000).nullable(),
});
type PlanInput = Partial<z.infer<typeof PlanFields>>;

const toRow = (b: PlanInput) => ({
  ...(b.title !== undefined && { title: b.title }),
  ...(b.service !== undefined && { service: b.service }),
  ...(b.attendee_name !== undefined && { attendeeName: b.attendee_name }),
  ...(b.status !== undefined && { status: b.status }),
  ...(b.visits_planned !== undefined && { visitsPlanned: b.visits_planned }),
  ...(b.visits_done !== undefined && { visitsDone: b.visits_done }),
  ...(b.visit_interval_days !== undefined && { visitIntervalDays: b.visit_interval_days }),
  ...(b.next_visit_due_at !== undefined && {
    nextVisitDueAt: b.next_visit_due_at ? new Date(b.next_visit_due_at) : null,
  }),
  ...(b.recall_due_at !== undefined && { recallDueAt: b.recall_due_at ? new Date(b.recall_due_at) : null }),
  ...(b.value_inr !== undefined && { valueInr: b.value_inr }),
  ...(b.paid_inr !== undefined && { paidInr: b.paid_inr }),
  ...(b.notes !== undefined && { notes: b.notes }),
});

export function registerJourneyRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;
  const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;

  // One patient across WhatsApp, phone, web and staff actions.
  app.get('/v1/leads/:id/timeline', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const out = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.select({ id: leads.id }).from(leads).where(eq(leads.id, id));
      if (!lead) return null;
      return {
        entries: await timeline(tx, id),
        plans: await listPlans(tx, id),
        installments: await listInstallments(tx, id),
      };
    });
    return out ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/v1/leads/:id/treatment-plans', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const body = PlanFields.partial({
      service: true,
      attendee_name: true,
      status: true,
      visits_planned: true,
      visits_done: true,
      visit_interval_days: true,
      next_visit_due_at: true,
      recall_due_at: true,
      value_inr: true,
      paid_inr: true,
      notes: true,
    }).parse(req.body);
    const plan = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.select({ id: leads.id }).from(leads).where(eq(leads.id, id));
      if (!lead) return null;
      const [row] = await tx
        .insert(treatmentPlans)
        .values({ leadId: id, title: body.title, ...toRow(body), createdBy: userId(req.principal) })
        .returning();
      await emit(tx, ctx.clock, 'treatment.created', { leadId: id, planId: row!.id, by: 'staff' });
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'treatment_plan.created',
        entityType: 'treatment_plan',
        entityId: row!.id,
      });
      return row!;
    });
    return plan ? reply.code(201).send(plan) : reply.code(404).send({ error: 'not_found' });
  });

  app.patch('/v1/treatment-plans/:id', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const body = PlanFields.partial().parse(req.body);
    const plan = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [before] = await tx.select().from(treatmentPlans).where(eq(treatmentPlans.id, id)).for('update');
      if (!before) return null;
      const [row] = await tx
        .update(treatmentPlans)
        .set(toRow(body))
        .where(and(eq(treatmentPlans.id, id)))
        .returning();
      await emit(tx, ctx.clock, 'treatment.updated', {
        leadId: before.leadId,
        planId: id,
        by: 'staff',
        fields: Object.keys(body),
        ...(body.status &&
          body.status !== before.status && { reason: `status ${before.status} -> ${body.status}` }),
      });
      if (body.paid_inr !== undefined && (body.paid_inr ?? 0) > (before.paidInr ?? 0))
        await emit(tx, ctx.clock, 'payment.recorded', { leadId: before.leadId, planId: id, by: 'staff' });
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'treatment_plan.updated',
        entityType: 'treatment_plan',
        entityId: id,
        details: { fields: Object.keys(body) },
      });
      return row!;
    });
    return plan ?? reply.code(404).send({ error: 'not_found' });
  });

  // Payment schedule (braces, implants): replaces the pending instalments, keeps paid / waived ones.
  app.post('/v1/treatment-plans/:id/installments', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const b = z
      .strictObject({
        count: z.int().min(1).max(60),
        first_due: z.iso.date(),
        interval_days: z.int().min(7).max(365),
        amount_inr: z.number().min(1).max(100_000_000).optional(),
      })
      .parse(req.body);
    try {
      const rows = await withTenant(ctx.db, tenantOf(req), async (tx) => {
        const r = await setInstallments(tx, ctx.clock, id, {
          count: b.count,
          firstDue: new Date(`${b.first_due}T09:00:00+05:30`),
          intervalDays: b.interval_days,
          amountInr: b.amount_inr,
        });
        if (r)
          await audit(tx, ctx.clock, actor(req.principal), {
            action: 'treatment_plan.installments_set',
            entityType: 'treatment_plan',
            entityId: id,
            details: { count: b.count },
          });
        return r;
      });
      return rows ? reply.code(201).send(rows) : reply.code(404).send({ error: 'not_found' });
    } catch (err) {
      if (err instanceof ScheduleError)
        return reply.code(422).send({ error: 'invalid_schedule', message: err.message });
      throw err;
    }
  });

  app.patch('/v1/installments/:id', { preHandler: staff }, async (req, reply) => {
    const id = idParam(req);
    const { status } = z.strictObject({ status: z.enum(['paid', 'waived', 'pending']) }).parse(req.body);
    const row = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const r = await markInstallment(tx, ctx.clock, id, status);
      if (r)
        await audit(tx, ctx.clock, actor(req.principal), {
          action: `installment.${status}`,
          entityType: 'installment',
          entityId: id,
        });
      return r;
    });
    return row ?? reply.code(404).send({ error: 'not_found' });
  });
}
