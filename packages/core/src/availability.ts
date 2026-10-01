import { MINUTE } from './clock.ts';

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

// ---- Time zones without a library: Intl gives the wall clock, we solve for the instant. ----

const partsCache = new Map<string, Intl.DateTimeFormat>();
function wallClock(at: Date, timeZone: string) {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: String(p.weekday).toLowerCase() as Weekday,
  };
}

const offsetMs = (at: Date, timeZone: string) => {
  const w = wallClock(at, timeZone);
  return (
    Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at.getTime() / 1000) * 1000
  );
};

/** The instant at which the wall clock in `timeZone` reads `date` `time` (YYYY-MM-DD, HH:MM). */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const [h = 0, min = 0] = time.split(':').map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, h, min);
  const first = asIfUtc - offsetMs(new Date(asIfUtc), timeZone);
  // Second pass corrects for a DST change between the guess and the answer.
  return new Date(asIfUtc - offsetMs(new Date(first), timeZone));
}

/** Calendar date, weekday and HH:MM of an instant in `timeZone`. */
export function localParts(at: Date, timeZone: string) {
  const w = wallClock(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    weekday: w.weekday,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
  };
}

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---- Availability ----

export interface AvailabilityRule {
  weekday: Weekday;
  start: string; // HH:MM local
  end: string; // HH:MM local
  resource: string;
}

export interface Interval {
  start: Date;
  end: Date;
  /** For busy intervals: which resource. For blocked times: null blocks every resource. */
  resource?: string | null;
}

export interface SlotQuery {
  now: Date;
  timeZone: string;
  rules: readonly AvailabilityRule[];
  blocked: readonly Interval[];
  busy: readonly Interval[];
  durationMin: number;
  slotMin: number;
  bufferMin: number;
  /** Search from this local date (default: today) for `days` days. */
  fromDate?: string;
  days: number;
  /** Don't offer anything sooner than this. */
  minNoticeMin: number;
}

export interface Slot {
  start: Date;
  end: Date;
  /** Resources free for the whole slot (plus buffer). */
  resources: string[];
}

const overlaps = (aStart: number, aEnd: number, b: Interval) =>
  aStart < b.end.getTime() && b.start.getTime() < aEnd;

/**
 * Bookable slots: availability rules, minus blocked times, minus existing appointments
 * (each holding its resource until end + buffer). Pure; the database's exclusion constraint
 * is what finally prevents double booking.
 */
export function availableSlots(q: SlotQuery): Slot[] {
  const slots: Slot[] = [];
  const earliest = q.now.getTime() + q.minNoticeMin * MINUTE;
  const startDate = q.fromDate ?? localParts(q.now, q.timeZone).date;

  for (let i = 0; i < q.days; i++) {
    const date = addDays(startDate, i);
    const weekday = localParts(zonedTimeToUtc(date, '12:00', q.timeZone), q.timeZone).weekday;
    const byStart = new Map<number, Set<string>>();

    for (const rule of q.rules.filter((r) => r.weekday === weekday)) {
      const open = zonedTimeToUtc(date, rule.start, q.timeZone).getTime();
      const close = zonedTimeToUtc(date, rule.end, q.timeZone).getTime();
      for (let t = open; t + q.durationMin * MINUTE <= close; t += q.slotMin * MINUTE) {
        if (t < earliest) continue;
        const end = t + q.durationMin * MINUTE;
        const held = end + q.bufferMin * MINUTE;
        if (
          q.blocked.some((b) => (b.resource == null || b.resource === rule.resource) && overlaps(t, held, b))
        )
          continue;
        if (q.busy.some((b) => b.resource === rule.resource && overlaps(t, held, b))) continue;
        const free = byStart.get(t) ?? new Set<string>();
        free.add(rule.resource);
        byStart.set(t, free);
      }
    }
    for (const [t, resources] of [...byStart.entries()].sort((a, b) => a[0] - b[0]))
      slots.push({
        start: new Date(t),
        end: new Date(t + q.durationMin * MINUTE),
        resources: [...resources].sort(),
      });
  }
  return slots;
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening';
export const partOfDay = (time: string): PartOfDay =>
  time < '12:00' ? 'morning' : time < '17:00' ? 'afternoon' : 'evening';

/**
 * A few slots to offer: earliest first, at least `minGapMin` apart so the choices are real
 * alternatives, preferring the lead's part of day when they said one.
 */
export function pickOffers(
  slots: readonly Slot[],
  n: number,
  opts: { timeZone: string; prefer?: PartOfDay | undefined; minGapMin?: number },
): Slot[] {
  const gap = (opts.minGapMin ?? 90) * MINUTE;
  const preferred = opts.prefer
    ? slots.filter((s) => partOfDay(localParts(s.start, opts.timeZone).time) === opts.prefer)
    : [];
  const picked: Slot[] = [];
  for (const s of [...preferred, ...slots]) {
    if (picked.length >= n) break;
    if (picked.some((p) => Math.abs(p.start.getTime() - s.start.getTime()) < gap)) continue;
    picked.push(s);
  }
  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** "Tue 7 Oct, 11:30 am" in the tenant's time zone. */
export function formatSlot(at: Date, timeZone: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}
