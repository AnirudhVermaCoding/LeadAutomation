import { journeysOf, type TenantConfig } from '@instantlead/config';
import { DAY, type Clock } from '@instantlead/core';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Tx } from './db/client.ts';
import { appointments, calls, events, messages, treatmentPlans } from './db/schema.ts';
import { emit } from './leads.ts';

/** What one timeline entry is about (the dashboard groups and colours by it). */
export type JourneyStage =
  | 'enquiry'
  | 'qualification'
  | 'booking'
  | 'confirmation'
  | 'attendance'
  | 'cancellation'
  | 'no_show'
  | 'treatment'
  | 'follow_up'
  | 'recall'
  | 'payment'
  | 'human'
  | 'consent'
  | 'communication';

export interface TimelineEntry {
  at: Date;
  stage: JourneyStage;
  /** whatsapp | phone | staff | system */
  channel: string;
  title: string;
  detail?: string | null;
  ref?: { kind: 'event' | 'message' | 'call'; id: string };
}

/** Domain event type -> how the timeline shows it. Unlisted types (internal bookkeeping) are left out. */
const EVENT_STAGES: Record<string, [JourneyStage, string]> = {
  'lead.created': ['enquiry', 'Enquiry received'],
  'lead.contacted': ['enquiry', 'First reply sent'],
  'lead.qualified': ['qualification', 'Qualified'],
  'lead.disqualified': ['qualification', 'Marked not a fit'],
  'lead.not_a_lead': ['qualification', 'Tagged as not a real enquiry'],
  'lead.unresponsive': ['follow_up', 'No reply after follow-ups'],
  'lead.escalated': ['human', 'Handed to the team'],
  'lead.takeover': ['human', 'Staff took over the conversation'],
  'lead.resumed': ['human', 'Assistant resumed'],
  'lead.opted_out': ['consent', 'Opted out of messages'],
  'lead.opted_in': ['consent', 'Opted back in'],
  'lead.marketing_opted_out': ['consent', 'Stopped marketing messages'],
  'appointment.booked': ['booking', 'Appointment booked'],
  'appointment.rescheduled': ['booking', 'Appointment rescheduled'],
  'appointment.confirmed': ['confirmation', 'Booking confirmed by staff'],
  'appointment.lead_confirmed': ['confirmation', 'Patient confirmed'],
  'appointment.completed': ['attendance', 'Visit completed'],
  'appointment.no_show': ['no_show', 'Missed the appointment'],
  'appointment.cancelled': ['cancellation', 'Appointment cancelled'],
  'appointment.displaced': ['cancellation', 'Cancelled by the clinic (unavailable)'],
  'appointment.lapsed': ['attendance', 'Visit never marked; closed'],
  'treatment.created': ['treatment', 'Treatment plan added'],
  'treatment.updated': ['treatment', 'Treatment plan updated'],
  'treatment.visit_done': ['treatment', 'Treatment visit done'],
  'treatment.completed': ['treatment', 'Treatment completed'],
  'opportunity.acted': ['follow_up', 'Follow-up sent by the assistant'],
  'opportunity.won': ['follow_up', 'Recovered'],
  'waitlist.joined': ['booking', 'Joined the waitlist'],
  'slot.offered': ['booking', 'Offered an earlier slot'],
  'slot.recovered': ['booking', 'Took a freed slot'],
  'payment.recorded': ['payment', 'Payment recorded'],
};

const RECALL_KINDS = new Set(['RECALL_DUE']);
const PAYMENT_KINDS = new Set(['PAYMENT_FOLLOWUP']);

/**
 * One patient, every channel: domain events, WhatsApp messages (AI, staff, templates) and phone calls,
 * newest last. Read-only; built from records the system already keeps, so it can't drift from them.
 */
export async function timeline(tx: Tx, leadId: string, limit = 500): Promise<TimelineEntry[]> {
  const evs = await tx
    .select({ id: events.id, type: events.type, payload: events.payload, at: events.occurredAt })
    .from(events)
    .where(eq(events.leadId, leadId))
    .orderBy(desc(events.occurredAt))
    .limit(limit);
  const msgs = await tx
    .select({
      id: messages.id,
      direction: messages.direction,
      kind: messages.kind,
      body: messages.body,
      status: messages.status,
      templateKey: messages.templateKey,
      key: messages.idempotencyKey,
      at: messages.occurredAt,
    })
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(desc(messages.occurredAt))
    .limit(limit);
  const phone = await tx
    .select()
    .from(calls)
    .where(eq(calls.leadId, leadId))
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  const out: TimelineEntry[] = [];
  for (const e of evs) {
    const p = e.payload;
    const kind = typeof p.kind === 'string' ? p.kind : '';
    let mapped = EVENT_STAGES[e.type];
    if (e.type === 'opportunity.acted' && RECALL_KINDS.has(kind)) mapped = ['recall', 'Recall reminder sent'];
    if (e.type === 'opportunity.acted' && PAYMENT_KINDS.has(kind))
      mapped = ['payment', 'Payment reminder sent'];
    if (!mapped) continue;
    const reason =
      typeof p.reason === 'string' ? p.reason : typeof p.category === 'string' ? p.category : null;
    out.push({
      at: e.at,
      stage: mapped[0],
      channel: p.channel === 'phone' ? 'phone' : p.by === 'staff' ? 'staff' : 'system',
      title: mapped[1],
      detail: reason,
      ref: { kind: 'event', id: e.id },
    });
  }
  for (const m of msgs) {
    const staff = m.key?.startsWith('staff:') ?? false;
    out.push({
      at: m.at,
      stage: 'communication',
      channel: staff ? 'staff' : 'whatsapp',
      title:
        m.direction === 'in'
          ? 'Patient wrote on WhatsApp'
          : staff
            ? 'Staff replied on WhatsApp'
            : m.templateKey
              ? `Template sent: ${m.templateKey}`
              : 'Assistant replied on WhatsApp',
      detail: m.status === 'failed' ? `Not delivered. ${m.body}` : m.body,
      ref: { kind: 'message', id: m.id },
    });
  }
  for (const c of phone) {
    const minutes = c.durationSec ? ` (${Math.max(1, Math.round(c.durationSec / 60))} min)` : '';
    out.push({
      at: c.startedAt,
      stage: c.escalated || c.transferred ? 'human' : 'communication',
      channel: 'phone',
      title: `${c.afterHours ? 'After-hours call' : 'Phone call'}${minutes}: ${c.status.replace('_', ' ')}${c.transferred ? ', transferred to the clinic' : ''}`,
      detail: c.summary,
      ref: { kind: 'call', id: c.id },
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-limit);
}

export const listPlans = (tx: Tx, leadId: string) =>
  tx
    .select()
    .from(treatmentPlans)
    .where(eq(treatmentPlans.leadId, leadId))
    .orderBy(asc(treatmentPlans.createdAt));

/**
 * A visit that belongs to a treatment plan was completed: count it, then either schedule when the next
 * one is due or close the plan and set the recall date. Clinical content is never inferred: only the
 * counts and intervals the clinic entered are used.
 */
export async function advancePlan(
  tx: Tx,
  clock: Clock,
  config: TenantConfig,
  planId: string,
  leadId: string,
) {
  const [plan] = await tx.select().from(treatmentPlans).where(eq(treatmentPlans.id, planId)).for('update');
  if (!plan || plan.status === 'completed' || plan.status === 'declined') return;
  const now = clock.now();
  const done = plan.visitsDone + 1;
  const finished = plan.visitsPlanned !== null && done >= plan.visitsPlanned;
  const recallMonths = journeysOf(config).recall_months;
  await tx
    .update(treatmentPlans)
    .set(
      finished
        ? {
            visitsDone: done,
            status: 'completed',
            nextVisitDueAt: null,
            recallDueAt: new Date(now.getTime() + recallMonths * 30 * DAY),
          }
        : {
            visitsDone: done,
            status: 'in_progress',
            nextVisitDueAt: plan.visitIntervalDays
              ? new Date(now.getTime() + plan.visitIntervalDays * DAY)
              : null,
          },
    )
    .where(eq(treatmentPlans.id, planId));
  await emit(tx, clock, finished ? 'treatment.completed' : 'treatment.visit_done', {
    leadId,
    planId,
    visitsDone: done,
  });
}

/** What to offer when a follow-up's "Book a time" is tapped: the open treatment's service, else their last visit's. */
export async function lastAppointmentOrPlan(tx: Tx, leadId: string) {
  const [plan] = await tx
    .select({ service: treatmentPlans.service })
    .from(treatmentPlans)
    .where(
      and(eq(treatmentPlans.leadId, leadId), inArray(treatmentPlans.status, ['accepted', 'in_progress'])),
    )
    .orderBy(desc(treatmentPlans.updatedAt))
    .limit(1);
  const [last] = await tx
    .select({ service: appointments.service, startsAt: appointments.startsAt })
    .from(appointments)
    .where(eq(appointments.leadId, leadId))
    .orderBy(desc(appointments.startsAt))
    .limit(1);
  if (plan?.service) return { service: plan.service, startsAt: last?.startsAt ?? null };
  return last ?? null;
}
