import { describe, expect, test } from 'vitest';
import { isLostLead, isRecallDue, isStalled, opportunityPriority } from './opportunities.ts';

const now = new Date('2026-10-20T06:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe('opportunity priority', () => {
  test('empty slots outrank everything and grow more urgent as they near', () => {
    expect(opportunityPriority('EMPTY_SLOT', { hoursUntilSlot: 2 })).toBeGreaterThan(
      opportunityPriority('EMPTY_SLOT', { hoursUntilSlot: 48 }),
    );
    expect(opportunityPriority('EMPTY_SLOT', { hoursUntilSlot: 500 })).toBe(70);
    expect(opportunityPriority('EMPTY_SLOT', { hoursUntilSlot: 0 })).toBe(100);
    expect(opportunityPriority('EMPTY_SLOT', { hoursUntilSlot: 72 })).toBeGreaterThan(
      opportunityPriority('NO_SHOW'),
    );
  });
  test('fixed order for the rest; tier only moves lost leads', () => {
    const order = [
      opportunityPriority('NO_SHOW'),
      opportunityPriority('STALLED_TREATMENT'),
      opportunityPriority('LOST_LEAD', { tier: 'hot' }),
      opportunityPriority('PAYMENT_FOLLOWUP'),
      opportunityPriority('LOST_LEAD', { tier: 'warm' }),
      opportunityPriority('RECALL_DUE'),
    ];
    expect([...order].sort((a, b) => b - a)).toEqual(order);
  });
});

describe('stalled treatment', () => {
  const plan = {
    status: 'in_progress' as const,
    visitsDone: 1,
    nextVisitDueAt: daysAgo(8),
    since: daysAgo(40),
  };
  test('overdue by more than the grace period with nothing booked', () => {
    expect(isStalled(plan, now, false, 7)).toBe(true);
    expect(isStalled(plan, now, false, 10)).toBe(false);
    expect(isStalled(plan, now, true, 7)).toBe(false);
    expect(isStalled({ ...plan, status: 'completed' }, now, false, 7)).toBe(false);
    expect(isStalled({ ...plan, status: 'declined' }, now, false, 7)).toBe(false);
  });
  test('an accepted plan never started counts from acceptance; no date and visits done = not stalled', () => {
    expect(
      isStalled(
        { status: 'accepted', visitsDone: 0, nextVisitDueAt: null, since: daysAgo(9) },
        now,
        false,
        7,
      ),
    ).toBe(true);
    expect(
      isStalled(
        { status: 'in_progress', visitsDone: 2, nextVisitDueAt: null, since: daysAgo(90) },
        now,
        false,
        7,
      ),
    ).toBe(false);
  });
});

test('recall and lost-lead rules', () => {
  expect(isRecallDue(daysAgo(1), now, false)).toBe(true);
  expect(isRecallDue(daysAgo(1), now, true)).toBe(false);
  expect(isRecallDue(daysAgo(-3), now, false)).toBe(false);
  expect(isRecallDue(null, now, false)).toBe(false);
  expect(isLostLead({ lastContactAt: daysAgo(3), everBooked: false, tier: 'hot' }, now, 48)).toBe(true);
  expect(isLostLead({ lastContactAt: daysAgo(1), everBooked: false, tier: 'hot' }, now, 48)).toBe(false);
  expect(isLostLead({ lastContactAt: daysAgo(3), everBooked: true, tier: 'hot' }, now, 48)).toBe(false);
  expect(isLostLead({ lastContactAt: daysAgo(3), everBooked: false, tier: 'cold' }, now, 48)).toBe(false);
});
