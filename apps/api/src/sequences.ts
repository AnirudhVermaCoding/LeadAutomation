import { renderTemplateBody, TEMPLATES, type TemplateKey, type TenantConfig } from '@instantlead/config';
import { formatSlot, HOUR, nextSendTime, type Clock, type LeadEventType } from '@instantlead/core';
import { and, eq, inArray } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Tx } from './db/client.ts';
import { appointments, enrollments, enrollmentSteps, leads, type SequenceKind } from './db/schema.ts';
import { emit, transitionLeadIfAllowed } from './leads.ts';
import type { NotifyDeps } from './notify.ts';
import { QUEUES, type Enqueue } from './jobs.ts';
import { sendToLead } from './outbound.ts';

/** After the last follow-up, how long silence lasts before the lead is marked unresponsive. */
const UNRESPONSIVE_AFTER_LAST_FOLLOWUP = 48 * HOUR;

interface StepPlan {
  action: 'message' | 'mark_unresponsive';
  templateKey?: TemplateKey;
  channel?: 'whatsapp' | 'email' | 'email_or_whatsapp';
  dueAt: Date;
  deadlineAt?: Date;
}

async function enroll(
  tx: Tx,
  clock: Clock,
  input: { leadId: string; kind: SequenceKind; appointmentId?: string; steps: StepPlan[] },
) {
  if (!input.steps.length) return null;
  const [enrollment] = await tx
    .insert(enrollments)
    .values({
      leadId: input.leadId,
      kind: input.kind,
      appointmentId: input.appointmentId ?? null,
      startedAt: clock.now(),
    })
    .returning({ id: enrollments.id });
  if (!enrollment) throw new Error('enrollment insert failed');
  await tx.insert(enrollmentSteps).values(
    input.steps.map((s, i) => ({
      enrollmentId: enrollment.id,
      step: i + 1,
      action: s.action,
      templateKey: s.templateKey ?? null,
      channel: s.channel ?? null,
      dueAt: s.dueAt,
      deadlineAt: s.deadlineAt ?? null,
    })),
  );
  return enrollment.id;
}

/** Stop active enrollments (and cancel their unsent steps). */
export async function stopEnrollments(
  tx: Tx,
  leadId: string,
  kinds: readonly SequenceKind[] | 'all',
  reason: string,
) {
  const stopped = await tx
    .update(enrollments)
    .set({ status: 'stopped', stopReason: reason })
    .where(
      and(
        eq(enrollments.leadId, leadId),
        eq(enrollments.status, 'active'),
        ...(kinds === 'all' ? [] : [inArray(enrollments.kind, [...kinds])]),
      ),
    )
    .returning({ id: enrollments.id });
  if (stopped.length)
    await tx
      .update(enrollmentSteps)
      .set({ status: 'cancelled' })
      .where(
        and(
          inArray(
            enrollmentSteps.enrollmentId,
            stopped.map((e) => e.id),
          ),
          inArray(enrollmentSteps.status, ['pending', 'queued']),
        ),
      );
  return stopped.length;
}

/** Day-2 / day-5 follow-ups after the first reply, then "unresponsive" if they never answer. */
export async function enrollFollowups(tx: Tx, clock: Clock, config: TenantConfig, leadId: string) {
  const steps = [...config.sequences.followup.steps].sort((a, b) => a.after_hours - b.after_hours);
  if (!steps.length) return null;
  const start = clock.now().getTime();
  const plan: StepPlan[] = steps.map((s, i) => ({
    action: 'message',
    templateKey: i === steps.length - 1 && steps.length > 1 ? 'followup_day5' : 'followup_day2',
    channel: s.channel,
    dueAt: new Date(start + s.after_hours * HOUR),
  }));
  const last = steps.at(-1)!;
  plan.push({
    action: 'mark_unresponsive',
    dueAt: new Date(start + last.after_hours * HOUR + UNRESPONSIVE_AFTER_LAST_FOLLOWUP),
  });
  return enroll(tx, clock, { leadId, kind: 'followup', steps: plan });
}

/** 24 h / 2 h reminders (as configured) before a scheduled appointment; replaces earlier reminders. */
export async function enrollReminders(
  tx: Tx,
  clock: Clock,
  config: TenantConfig,
  appt: { id: string; leadId: string; startsAt: Date },
) {
  await stopEnrollments(tx, appt.leadId, ['reminders'], 'appointment changed');
  const now = clock.now().getTime();
  const plan: StepPlan[] = [...config.sequences.reminders.before_hours]
    .sort((a, b) => b - a)
    .map((h) => ({
      action: 'message' as const,
      templateKey: (h >= 12 ? 'reminder_24h' : 'reminder_2h') as TemplateKey,
      channel: 'whatsapp' as const,
      dueAt: new Date(appt.startsAt.getTime() - h * HOUR),
      deadlineAt: appt.startsAt,
    }))
    .filter((s) => s.dueAt.getTime() > now);
  return enroll(tx, clock, { leadId: appt.leadId, kind: 'reminders', appointmentId: appt.id, steps: plan });
}

/** No-show recovery (after staff mark a no-show) or review request (after a completed visit). */
export async function enrollAfterVisit(
  tx: Tx,
  clock: Clock,
  config: TenantConfig,
  appt: { id: string; leadId: string },
  kind: 'no_show_recovery' | 'review_request',
) {
  const settings = config.sequences[kind];
  if (!settings.enabled) return null;
  if (kind === 'review_request' && !config.sequences.review_request.google_review_link) return null;
  return enroll(tx, clock, {
    leadId: appt.leadId,
    kind,
    appointmentId: appt.id,
    steps: [
      {
        action: 'message',
        templateKey: kind,
        channel: 'whatsapp',
        dueAt: new Date(clock.now().getTime() + settings.after_hours * HOUR),
      },
    ],
  });
}

// ---- Running a due step ----

export type StepResult = {
  status: 'sent' | 'skipped' | 'failed' | 'cancelled' | 'deferred' | 'ignored';
  reason?: string;
};

const finish = async (
  tx: Tx,
  clock: Clock,
  stepId: string,
  enrollmentId: string,
  status: 'sent' | 'skipped' | 'failed' | 'cancelled',
  error?: string,
) => {
  await tx
    .update(enrollmentSteps)
    .set({ status, doneAt: clock.now(), lastError: error ?? null })
    .where(eq(enrollmentSteps.id, stepId));
  const open = await tx
    .select({ id: enrollmentSteps.id })
    .from(enrollmentSteps)
    .where(
      and(
        eq(enrollmentSteps.enrollmentId, enrollmentId),
        inArray(enrollmentSteps.status, ['pending', 'queued']),
      ),
    );
  if (!open.length)
    await tx
      .update(enrollments)
      .set({ status: 'completed' })
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.status, 'active')));
};

/**
 * One due step. Re-checks everything at send time: the enrollment is still active, the lead
 * hasn't opted out, the deadline hasn't passed, and it's not quiet hours (then it's moved to
 * the end of quiet hours instead). Transient send failures throw so the job retries.
 */
export async function runStep(
  deps: NotifyDeps,
  job: { tenantId: string; stepId: string },
): Promise<StepResult> {
  const { tenantId, stepId } = job;
  const { clock } = deps;
  const plan = await withTenant(deps.db, tenantId, async (tx) => {
    const [step] = await tx
      .select()
      .from(enrollmentSteps)
      .where(eq(enrollmentSteps.id, stepId))
      .for('update');
    if (!step || step.status !== 'queued')
      return { done: { status: 'ignored' as const, reason: 'not queued' } };
    const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, step.enrollmentId));
    const [lead] = await tx
      .select()
      .from(leads)
      .where(eq(leads.id, enrollment?.leadId ?? stepId));
    const config = (await getActiveConfig(tx))?.config;
    if (!enrollment || !lead || !config) return { done: { status: 'ignored' as const, reason: 'gone' } };
    const close = async (status: 'skipped' | 'cancelled', reason: string) => {
      await finish(tx, clock, step.id, enrollment.id, status, reason);
      return { done: { status, reason } };
    };

    if (enrollment.status !== 'active') return close('cancelled', `enrollment ${enrollment.status}`);
    if (lead.state === 'opted_out') return close('cancelled', 'opted out');
    const now = clock.now();
    if (step.deadlineAt && now >= step.deadlineAt) return close('skipped', 'deadline passed');

    if (step.action === 'mark_unresponsive') {
      const moved = await transitionLeadIfAllowed(tx, lead.id, { type: 'MARK_UNRESPONSIVE' });
      if (moved?.state === 'unresponsive') await emit(tx, clock, 'lead.unresponsive', { leadId: lead.id });
      await finish(tx, clock, step.id, enrollment.id, 'sent');
      return { done: { status: 'sent' as const } };
    }

    const sendAt = nextSendTime(now, config.locale.timezone, config.locale.quiet_hours);
    if (sendAt > now) {
      if (step.deadlineAt && sendAt >= step.deadlineAt)
        return close('skipped', 'quiet hours until the deadline');
      await tx
        .update(enrollmentSteps)
        .set({ status: 'pending', dueAt: sendAt })
        .where(eq(enrollmentSteps.id, step.id));
      return { done: { status: 'deferred' as const, reason: 'quiet hours' } };
    }

    const [appt] = enrollment.appointmentId
      ? await tx.select().from(appointments).where(eq(appointments.id, enrollment.appointmentId))
      : [];
    return { step, enrollment, lead, config, appt };
  });
  if ('done' in plan) return plan.done as StepResult;

  const { step, enrollment, lead, config, appt } = plan;
  const key = step.templateKey as TemplateKey;
  const idempotencyKey = `enrollment:${enrollment.id}:step:${step.step}`;
  const values: Record<string, string> = {
    business_name: config.brand.business_name,
    ...(lead.name?.trim() ? { first_name: lead.name.trim().split(/\s+/)[0] ?? '' } : {}),
    ...(appt
      ? {
          'appointment.service': appt.service,
          'appointment.time': formatSlot(appt.startsAt, config.locale.timezone),
        }
      : {}),
  };

  let status: 'sent' | 'skipped' | 'failed';
  let reason: string | undefined;
  if (lead.email && (step.channel === 'email' || step.channel === 'email_or_whatsapp')) {
    const text = renderTemplateBody(key, 'en', templateValues(key, values, lead.name));
    await deps.email.send({
      to: [lead.email],
      subject: `${config.brand.business_name}`,
      text,
      idempotencyKey,
    });
    status = 'sent';
  } else {
    const r = await sendToLead(deps, tenantId, {
      leadId: lead.id,
      idempotencyKey,
      template: { key, values },
    });
    status = r.status;
    reason = r.status === 'sent' ? undefined : r.reason;
  }

  await withTenant(deps.db, tenantId, (tx) => finish(tx, clock, step.id, enrollment.id, status, reason));
  return { status, reason };
}

/** Positional values for an email rendering of a WhatsApp template. */
function templateValues(key: TemplateKey, values: Record<string, string>, name: string | null) {
  const defaults: Record<string, string> = { first_name: name?.split(/\s+/)[0] ?? 'there' };
  const order: readonly string[] = TEMPLATES[key].variables;
  return order.map((v) => values[v] ?? defaults[v] ?? '');
}

const FOLLOWUP_STOPS: Partial<Record<LeadEventType, 'replied' | 'booked' | 'disqualified'>> = {
  LEAD_REPLIED: 'replied',
  BOOKED: 'booked',
  DISQUALIFIED: 'disqualified',
};

/** Called on every lead state event: opt-out stops everything; replies/bookings stop follow-ups. */
export async function stopOnLeadEvent(tx: Tx, leadId: string, event: LeadEventType) {
  if (event === 'OPTED_OUT') {
    await stopEnrollments(tx, leadId, 'all', 'opted_out');
    return;
  }
  const reason = FOLLOWUP_STOPS[event];
  if (!reason) return;
  const config = (await getActiveConfig(tx))?.config;
  if (config && !config.sequences.followup.stop_on.includes(reason)) return;
  await stopEnrollments(tx, leadId, ['followup'], reason);
}

/** Claim due steps and queue one job each (the per-minute cron, and the demo's fast-forward). */
export async function sweepDueSteps(ctx: {
  clock: Clock;
  system: { claimDueSteps(now: Date): Promise<{ stepId: string; tenantId: string }[]> };
  enqueue: Enqueue;
}) {
  const due = await ctx.system.claimDueSteps(ctx.clock.now());
  for (const d of due) await ctx.enqueue(null, QUEUES.sequenceStep, d);
  return due.length;
}
