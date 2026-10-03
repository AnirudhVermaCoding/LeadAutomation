import { DAY, HOUR } from './clock.ts';

export type RecoveryKind =
  'LOST_LEAD' | 'EMPTY_SLOT' | 'NO_SHOW' | 'STALLED_TREATMENT' | 'RECALL_DUE' | 'PAYMENT_FOLLOWUP';

/**
 * Deterministic priority (higher first). A freed slot is perishable, so it outranks everything and gets
 * more urgent as it nears; then missed visits and stalled treatments; then money owed; then hot/warm
 * enquiries that never booked; recalls last. Money never changes the order (it is often unknown).
 */
export function opportunityPriority(
  kind: RecoveryKind,
  facts: { hoursUntilSlot?: number; tier?: 'hot' | 'warm' | 'cold' | null } = {},
): number {
  switch (kind) {
    case 'EMPTY_SLOT': {
      const h = Math.max(0, Math.min(72, facts.hoursUntilSlot ?? 72));
      return Math.round(100 - (h / 72) * 30); // 70 (3 days out) .. 100 (now)
    }
    case 'NO_SHOW':
      return 65;
    case 'STALLED_TREATMENT':
      return 60;
    case 'LOST_LEAD':
      return facts.tier === 'hot' ? 55 : facts.tier === 'warm' ? 40 : 25;
    case 'PAYMENT_FOLLOWUP':
      return 50;
    case 'RECALL_DUE':
      return 30;
  }
}

export interface PlanFacts {
  status: 'proposed' | 'accepted' | 'in_progress' | 'completed' | 'declined';
  visitsDone: number;
  nextVisitDueAt: Date | null;
  /** When the clinic recorded the plan (business time). */
  since: Date;
}

/**
 * A treatment journey has stalled when the clinic expects another visit, nothing is booked, and the
 * due date (or, for an accepted plan with no date, the day it was accepted) is more than `graceDays` behind.
 * Purely administrative: it never decides whether treatment is needed.
 */
export function isStalled(plan: PlanFacts, now: Date, hasUpcoming: boolean, graceDays: number): boolean {
  if (hasUpcoming || !['accepted', 'in_progress'].includes(plan.status)) return false;
  const due = plan.nextVisitDueAt ?? (plan.visitsDone === 0 ? plan.since : null);
  return due !== null && now.getTime() - due.getTime() > graceDays * DAY;
}

/** Recall is due when its date has come and nothing is booked. */
export const isRecallDue = (recallDueAt: Date | null, now: Date, hasUpcoming: boolean) =>
  !hasUpcoming && recallDueAt !== null && recallDueAt.getTime() <= now.getTime();

/** A qualified enquiry that went quiet without booking for longer than `afterHours`. */
export const isLostLead = (
  lead: { lastContactAt: Date; everBooked: boolean; tier: string | null },
  now: Date,
  afterHours: number,
) =>
  !lead.everBooked &&
  (lead.tier === 'hot' || lead.tier === 'warm') &&
  now.getTime() - lead.lastContactAt.getTime() > afterHours * HOUR;
