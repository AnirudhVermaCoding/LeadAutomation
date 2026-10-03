import { autonomyOf, journeysOf, type AutonomyAction, type TemplateKey, type TenantConfig } from '@instantlead/config';
import {
  DAY,
  HOUR,
  isLostLead,
  isRecallDue,
  isStalled,
  localParts,
  nextSendTime,
  opportunityPriority,
  zonedTimeToUtc,
  type Clock,
} from '@instantlead/core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type TenantTx, type Tx } from './db/client.ts';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  appointments,
  conversations,
  events,
  leads,
  opportunities,
  treatmentPlans,
  type OpportunityKind,
} from './db/schema.ts';
import { QUEUES, type Enqueue } from './jobs.ts';
import { emit } from './leads.ts';
import { sendToLead, type MessagingDeps } from './outbound.ts';

/** How long an opportunity may stay open without a result before it counts as lost. */
const LOSE_AFTER_DAYS = 30;
/** Detection looks this far back for no-shows (older ones are history, not opportunities). */
const NO_SHOW_LOOKBACK_DAYS = 30;

/** The message the assistant may send for each kind, and the autonomy setting that allows it. NO_SHOW and EMPTY_SLOT act elsewhere. */
const ACTIONS: Partial<Record<OpportunityKind, { template: TemplateKey; autonomy: AutonomyAction }>> = {
  LOST_LEAD: { template: 'lead_reactivation', autonomy: 'reactivate' },
  STALLED_TREATMENT: { template: 'treatment_followup', autonomy: 'follow_up' },
  RECALL_DUE: { template: 'recall_due', autonomy: 'reactivate' },
  PAYMENT_FOLLOWUP: { template: 'payment_reminder', autonomy: 'payment_reminder' },
};

type NewOpportunity = Omit<typeof opportunities.$inferInsert, 'tenantId' | 'detectedAt' | 'priority'> & {
  kind: OpportunityKind;
  priorityFacts?: Parameters<typeof opportunityPriority>[1];
};

/** Insert unless the same (kind, subject) is already known: detection is idempotent. Returns the new row id or null. */
export async function recordOpportunity(tx: Tx, clock: Clock, o: NewOpportunity) {
  const { priorityFacts, ...row } = o;
  const [inserted] = await tx
    .insert(opportunities)
    .values({ ...row, priority: opportunityPriority(o.kind, priorityFacts), detectedAt: clock.now() })
    .onConflictDoNothing({ target: [opportunities.tenantId, opportunities.kind, opportunities.subjectKey] })
    .returning({ id: opportunities.id });
  return inserted?.id ?? null;
}

const upcomingByLead = async (tx: Tx, now: Date) =>
  new Set(
    (
      await tx
        .select({ leadId: appointments.leadId, attendee: appointments.attendeeName })
        .from(appointments)
        .where(and(inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]), gte(appointments.endsAt, now)))
    ).map((a) => `${a.leadId}:${(a.attendee ?? '').toLowerCase()}`),
  );
const inr = (v: number) => Math.round(v).toLocaleString('en-IN');

/** Every rule, for one tenant. Deterministic SQL + the pure rules in packages/core; no model is involved. */
export async function detectOpportunities(tx: Tx, clock: Clock, config: TenantConfig) {
  const now = clock.now();
  const j = journeysOf(config);
  const upcoming = await upcomingByLead(tx, now);
  const has = (leadId: string, attendee: string | null = null) =>
    upcoming.has(`${leadId}:${(attendee ?? '').toLowerCase()}`);
  let found = 0;
  const add = async (o: NewOpportunity) => {
    if (await recordOpportunity(tx, clock, o)) found++;
  };

  // Qualified enquiries that went quiet and never booked.
  const quiet = await tx
    .select({
      id: leads.id,
      tier: leads.tier,
      receivedAt: leads.receivedAt,
      lastInboundAt: conversations.lastInboundAt,
      // Qualified column names: inside a correlated subquery drizzle would print a bare "id".
      booked: sql<boolean>`exists (select 1 from appointments a where a.lead_id = "leads"."id")`,
    })
    .from(leads)
    .leftJoin(conversations, eq(conversations.leadId, leads.id))
    .where(
      and(
        inArray(leads.state, ['qualified', 'booking_offered', 'unresponsive', 'nurturing']),
        inArray(leads.tier, ['hot', 'warm']),
        isNull(leads.notALead),
        lt(leads.receivedAt, new Date(now.getTime() - j.lost_lead_after_hours * HOUR)),
      ),
    )
    .limit(500);
  for (const l of quiet) {
    const last = l.lastInboundAt && l.lastInboundAt > l.receivedAt ? l.lastInboundAt : l.receivedAt;
    if (!isLostLead({ lastContactAt: last, everBooked: l.booked, tier: l.tier }, now, j.lost_lead_after_hours))
      continue;
    await add({
      kind: 'LOST_LEAD',
      leadId: l.id,
      subjectKey: `lead:${l.id}`,
      reason: `${l.tier === 'hot' ? 'Hot' : 'Warm'} enquiry, qualified but never booked; quiet for over ${j.lost_lead_after_hours} hours`,
      recommendedAction: 'Send one reminder that times are available (lead_reactivation)',
      priorityFacts: { tier: l.tier },
    });
  }

  // Missed visits: the no-show recovery sequence is the action; the opportunity tracks whether they come back.
  const missed = await tx
    .select({
      id: appointments.id,
      leadId: appointments.leadId,
      service: appointments.service,
      enrolled: sql<boolean>`exists (select 1 from enrollments e where e.appointment_id = "appointments"."id" and e.kind = 'no_show_recovery')`,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'no_show'),
        gte(appointments.startsAt, new Date(now.getTime() - NO_SHOW_LOOKBACK_DAYS * DAY)),
      ),
    );
  for (const a of missed)
    await add({
      kind: 'NO_SHOW',
      leadId: a.leadId,
      appointmentId: a.id,
      subjectKey: `appt:${a.id}`,
      status: a.enrolled ? 'actioned' : 'open',
      aiActed: a.enrolled,
      actedAt: a.enrolled ? now : null,
      reason: `Missed their ${a.service}`,
      recommendedAction: a.enrolled
        ? 'No-show recovery message is scheduled; call if they do not rebook'
        : 'Call to rebook (no-show recovery messages are off)',
    });

  // Treatment journeys: stalled, recall due, balance pending.
  const plans = await tx
    .select()
    .from(treatmentPlans)
    .where(inArray(treatmentPlans.status, ['accepted', 'in_progress', 'completed']));
  for (const p of plans) {
    const booked = has(p.leadId, p.attendeeName);
    const who = p.attendeeName ? ` for ${p.attendeeName}` : '';
    const value = p.valueInr !== null ? { valueInr: p.valueInr, valueSource: 'treatment_plan' as const } : {};
    if (
      isStalled(
        { status: p.status, visitsDone: p.visitsDone, nextVisitDueAt: p.nextVisitDueAt, since: p.createdAt },
        now,
        booked,
        j.stall_grace_days,
      )
    )
      await add({
        kind: 'STALLED_TREATMENT',
        leadId: p.leadId,
        treatmentPlanId: p.id,
        subjectKey: `plan:${p.id}:visit:${p.visitsDone}`,
        reason: `"${p.title}"${who} appears stalled: next visit ${p.nextVisitDueAt ? 'overdue' : 'never booked'}, nothing booked`,
        recommendedAction: 'Send the clinic-approved follow-up (treatment_followup) or call',
        ...value,
      });
    if (p.status === 'completed' && isRecallDue(p.recallDueAt, now, booked))
      await add({
        kind: 'RECALL_DUE',
        leadId: p.leadId,
        treatmentPlanId: p.id,
        subjectKey: `recall:plan:${p.id}:${p.recallDueAt!.toISOString().slice(0, 10)}`,
        reason: `Recall due after "${p.title}"${who}`,
        recommendedAction: 'Send the recall reminder (recall_due)',
      });
    if (
      p.valueInr !== null &&
      p.paidInr !== null &&
      p.valueInr > p.paidInr &&
      (p.status === 'in_progress' || p.status === 'completed')
    ) {
      const due = p.valueInr - p.paidInr;
      await add({
        kind: 'PAYMENT_FOLLOWUP',
        leadId: p.leadId,
        treatmentPlanId: p.id,
        subjectKey: `pay:${p.id}:${p.paidInr}`,
        reason: `₹${inr(due)} pending on "${p.title}" (clinic records: ₹${inr(p.valueInr)} total, ₹${inr(p.paidInr)} paid)`,
        recommendedAction: j.payment_url
          ? 'Send a payment reminder with the clinic payment link'
          : 'Call about the balance (add a payment link in Settings to let the assistant remind)',
        valueInr: due,
        valueSource: 'treatment_plan',
      });
    }
  }

  // Dormant patients without a plan: last completed visit older than the recall interval, nothing since.
  const dormant = await tx.execute<{ id: string; lead_id: string; starts_at: Date }>(sql`
    select distinct on (a.lead_id) a.id, a.lead_id, a.starts_at
    from appointments a
    where a.status = 'completed'
      and not exists (select 1 from treatment_plans p where p.lead_id = a.lead_id and p.status <> 'declined')
    order by a.lead_id, a.starts_at desc`);
  for (const d of dormant.rows) {
    const recallAt = new Date(new Date(d.starts_at).getTime() + j.recall_months * 30 * DAY);
    if (!isRecallDue(recallAt, now, has(d.lead_id))) continue;
    await add({
      kind: 'RECALL_DUE',
      leadId: d.lead_id,
      appointmentId: d.id,
      subjectKey: `recall:appt:${d.id}`,
      reason: `Last visit over ${j.recall_months} months ago, nothing booked since`,
      recommendedAction: 'Send the recall reminder (recall_due)',
    });
  }
  return found;
}

/** Close what has a result: they booked (or paid) after it was found = won; nothing for 30 days, or opted out = lost. */
export async function resolveOutcomes(tx: Tx, clock: Clock) {
  const now = clock.now();
  const open = await tx
    .select({ o: opportunities, plan: treatmentPlans, leadState: leads.state })
    .from(opportunities)
    .leftJoin(treatmentPlans, eq(treatmentPlans.id, opportunities.treatmentPlanId))
    .leftJoin(leads, eq(leads.id, opportunities.leadId))
    .where(
      and(
        inArray(opportunities.status, ['open', 'needs_approval', 'actioned']),
        isNotNull(opportunities.leadId),
      ),
    );
  let won = 0;
  for (const { o, plan, leadState } of open) {
    let outcome: { status: 'won' | 'lost'; text: string } | null = null;
    if (o.kind === 'PAYMENT_FOLLOWUP') {
      if (plan && plan.valueInr !== null && (plan.paidInr ?? 0) >= plan.valueInr)
        outcome = { status: 'won', text: 'balance paid' };
      else if (plan && plan.paidInr !== null && `pay:${plan.id}:${plan.paidInr}` !== o.subjectKey)
        outcome = { status: 'won', text: 'part payment recorded' };
    } else {
      const [booked] = await tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.leadId, o.leadId!),
            eq(events.type, 'appointment.booked'),
            gte(events.occurredAt, o.detectedAt),
          ),
        )
        .limit(1);
      if (booked) outcome = { status: 'won', text: 'booked again' };
    }
    if (!outcome && leadState === 'opted_out') outcome = { status: 'lost', text: 'opted out' };
    if (!outcome && now.getTime() - o.detectedAt.getTime() > LOSE_AFTER_DAYS * DAY)
      outcome = { status: 'lost', text: `no result in ${LOSE_AFTER_DAYS} days` };
    if (!outcome) continue;
    await tx
      .update(opportunities)
      .set({ status: outcome.status, outcome: outcome.text, outcomeAt: now })
      .where(eq(opportunities.id, o.id));
    if (outcome.status === 'won') {
      won++;
      await emit(tx, clock, 'opportunity.won', { leadId: o.leadId, opportunityId: o.id, kind: o.kind });
    }
  }
  return won;
}

/** Start of today in the clinic's timezone. */
const localDayStart = (now: Date, tz: string) => zonedTimeToUtc(localParts(now, tz).date, '00:00', tz);

/** Outreach the assistant already sent today (the daily cap applies across kinds). */
async function actedToday(tx: Tx, now: Date, tz: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.type, 'opportunity.acted'), gte(events.occurredAt, localDayStart(now, tz))));
  return row?.n ?? 0;
}

/**
 * Decide what happens to open opportunities: allowed + under the daily cap → queue the action;
 * needs approval → shown to staff; off → shown only. Never touches one already attempted.
 */
export async function scheduleActions(tx: TenantTx, deps: { clock: Clock; enqueue: Enqueue }, tenantId: string, config: TenantConfig) {
  const now = deps.clock.now();
  let budget = journeysOf(config).max_outreach_per_day - (await actedToday(tx, now, config.locale.timezone));
  const open = await tx
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.status, 'open'), isNull(opportunities.actedAt), isNotNull(opportunities.leadId)))
    .orderBy(desc(opportunities.priority), asc(opportunities.detectedAt))
    .limit(200);
  let queued = 0;
  // Freed slots still in play: offer again (new waitlist joins, offers deferred by quiet hours, expired offers).
  const slots = await tx
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.kind, 'EMPTY_SLOT'),
        inArray(opportunities.status, ['open', 'actioned']),
        gte(opportunities.slotStartsAt, now),
      ),
    );
  for (const s of slots)
    await deps.enqueue(tx, QUEUES.slotRecovery, { tenantId, opportunityId: s.id }, { singletonKey: `${s.id}:sweep` });
  for (const o of open) {
    const action = ACTIONS[o.kind];
    if (!action) continue;
    const mode = autonomyOf(config, action.autonomy);
    if (mode === 'approval' || (o.kind === 'PAYMENT_FOLLOWUP' && !journeysOf(config).payment_url)) {
      if (mode === 'approval')
        await tx.update(opportunities).set({ status: 'needs_approval' }).where(eq(opportunities.id, o.id));
      continue;
    }
    if (mode === 'off' || budget <= 0) continue;
    budget--;
    queued++;
    await deps.enqueue(tx, QUEUES.opportunityAct, { tenantId, opportunityId: o.id }, { singletonKey: o.id });
  }
  return queued;
}

/** The per-tenant sweep (cron every 15 minutes, and the demo's fast-forward). */
export async function sweepOpportunities(
  deps: { db: MessagingDeps['db']; clock: Clock; enqueue: Enqueue; system: { listTenants(): Promise<{ id: string }[]> } },
) {
  const out = { found: 0, won: 0, queued: 0 };
  for (const { id: tenantId } of await deps.system.listTenants()) {
    await withTenant(deps.db, tenantId, async (tx) => {
      const config = (await getActiveConfig(tx))?.config;
      if (!config) return;
      out.found += await detectOpportunities(tx, deps.clock, config);
      out.won += await resolveOutcomes(tx, deps.clock);
      out.queued += await scheduleActions(tx, deps, tenantId, config);
    });
  }
  return out;
}

export type ActResult = { status: 'sent' | 'skipped' | 'failed' | 'deferred'; reason?: string };

/**
 * Send the one message an opportunity calls for. Every condition is re-checked at send time (the row is
 * locked): still open, patient not opted out / paused / already booked, autonomy (unless staff approved it),
 * quiet hours, the daily cap. The send goes through sendToLead (opt-out, marketing opt-out, window,
 * template approval, idempotency key `opp:<id>`). A send that can't go out is recorded on the
 * opportunity for staff; it is not retried by the sweep.
 */
export async function actOnOpportunity(
  deps: MessagingDeps,
  job: { tenantId: string; opportunityId: string; approvedBy?: string },
): Promise<ActResult> {
  const { tenantId, opportunityId } = job;
  const now = deps.clock.now();
  const plan = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ o: opportunities, lead: leads, plan: treatmentPlans })
      .from(opportunities)
      .innerJoin(leads, eq(leads.id, opportunities.leadId))
      .leftJoin(treatmentPlans, eq(treatmentPlans.id, opportunities.treatmentPlanId))
      .where(eq(opportunities.id, opportunityId))
      .for('update', { of: opportunities });
    const config = (await getActiveConfig(tx))?.config;
    if (!row || !config) return { done: { status: 'skipped', reason: 'gone' } as ActResult };
    const { o, lead } = row;
    const action = ACTIONS[o.kind];
    const skip = async (reason: string, close = false) => {
      await tx
        .update(opportunities)
        .set({ actedAt: now, outcome: `Not sent: ${reason}`, ...(close && { status: 'lost' as const, outcomeAt: now }) })
        .where(eq(opportunities.id, o.id));
      return { done: { status: 'skipped', reason } as ActResult };
    };
    if (!action) return { done: { status: 'skipped', reason: 'no message for this kind' } as ActResult };
    const allowedStatus = job.approvedBy ? ['open', 'needs_approval'] : ['open'];
    if (!allowedStatus.includes(o.status) || (o.actedAt && !job.approvedBy))
      return { done: { status: 'skipped', reason: `already ${o.status}` } as ActResult };
    if (!job.approvedBy && autonomyOf(config, action.autonomy) !== 'auto')
      return { done: { status: 'skipped', reason: 'autonomy no longer allows it' } as ActResult };
    if (lead.state === 'opted_out') return skip('opted out', true);
    if (lead.aiPaused) return skip('a team member has taken over this conversation');
    if (lead.notALead) return skip('not a real enquiry', true);
    const upcoming = await upcomingByLead(tx, now);
    if (upcoming.has(`${lead.id}:${(row.plan?.attendeeName ?? '').toLowerCase()}`) && o.kind !== 'PAYMENT_FOLLOWUP')
      return skip('already booked');
    if (nextSendTime(now, config.locale.timezone, config.locale.quiet_hours) > now)
      return { done: { status: 'deferred', reason: 'quiet hours' } as ActResult }; // the next sweep re-queues it
    if (!job.approvedBy && (await actedToday(tx, now, config.locale.timezone)) >= journeysOf(config).max_outreach_per_day)
      return { done: { status: 'deferred', reason: 'daily outreach cap reached' } as ActResult };
    const values: Record<string, string> = { business_name: config.brand.business_name };
    if (o.kind === 'STALLED_TREATMENT') values.treatment = row.plan?.title ?? 'your treatment';
    if (o.kind === 'PAYMENT_FOLLOWUP') {
      const url = journeysOf(config).payment_url;
      // Money only from the clinic's records, never estimated.
      if (!url || o.valueInr === null) return skip('no payment link or amount recorded');
      values.amount = inr(o.valueInr);
      values.payment_link = url;
    }
    return { send: { leadId: lead.id, template: action.template, values, kind: o.kind } };
  });
  if (plan.done || !plan.send) return plan.done ?? { status: 'skipped' };
  const { send } = plan;
  const r = await sendToLead(deps, tenantId, {
    leadId: send.leadId,
    idempotencyKey: `opp:${opportunityId}`,
    template: { key: send.template, values: send.values },
  });
  await withTenant(deps.db, tenantId, async (tx) => {
    await tx
      .update(opportunities)
      .set(
        r.status === 'sent'
          ? { status: 'actioned', aiActed: true, actedAt: now, outcome: null }
          : { actedAt: now, outcome: `Not sent: ${r.reason}` },
      )
      .where(eq(opportunities.id, opportunityId));
    if (r.status === 'sent')
      await emit(tx, deps.clock, 'opportunity.acted', {
        leadId: send.leadId,
        opportunityId,
        kind: send.kind,
        ...(job.approvedBy && { approvedBy: job.approvedBy }),
      });
  });
  return r.status === 'sent' ? { status: 'sent' } : { status: r.status, reason: r.reason };
}
