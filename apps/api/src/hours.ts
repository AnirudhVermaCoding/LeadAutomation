import type { TenantConfig } from '@instantlead/config';
import { localParts, MINUTE } from '@instantlead/core';

// Staff-facing timers (nudges, auto-confirm deadlines, digests) run on *opening hours*, not the
// patient quiet hours: a front desk can only act while the business is open.
// ponytail: 5-minute stepping through the week; exact enough for staff nudges, and bounded.

const STEP = 5 * MINUTE;
const WEEK_STEPS = (7 * 24 * 60) / 5;

/** Is the business open at `at` (tenant-local business_hours)? */
export function isOpen(config: TenantConfig, at: Date): boolean {
  const p = localParts(at, config.locale.timezone);
  return config.locale.business_hours.some(
    (h) => h.days.includes(p.weekday) && h.open <= p.time && p.time < h.close,
  );
}

/** `from` plus `minutes` of opening time (time while closed doesn't count). Null if never open. */
export function addOpenMinutes(config: TenantConfig, from: Date, minutes: number): Date | null {
  let t = from.getTime();
  let left = minutes;
  for (let i = 0; i < WEEK_STEPS * 2; i++) {
    if (isOpen(config, new Date(t))) {
      if (left <= 0) return new Date(t);
      left -= 5;
    }
    t += STEP;
  }
  return null;
}

/** The latest moment at or before `at` when the business is open (looks back up to a week). */
export function lastOpenBefore(config: TenantConfig, at: Date): Date | null {
  let t = at.getTime() - STEP;
  for (let i = 0; i < WEEK_STEPS; i++) {
    if (isOpen(config, new Date(t))) return new Date(t);
    t -= STEP;
  }
  return null;
}
