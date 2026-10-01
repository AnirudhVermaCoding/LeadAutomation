import { describe, expect, test } from 'vitest';
import {
  availableSlots,
  localParts,
  pickOffers,
  zonedTimeToUtc,
  type AvailabilityRule,
  type SlotQuery,
} from './availability.ts';

const IST = 'Asia/Kolkata';
const rules: AvailabilityRule[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((weekday) => ({
  weekday: weekday as AvailabilityRule['weekday'],
  start: '10:00',
  end: '13:00',
  resource: 'chair-1',
}));
// Monday 6 Oct 2026, 09:00 IST
const now = zonedTimeToUtc('2026-10-05', '09:00', IST);
const base: SlotQuery = {
  now,
  timeZone: IST,
  rules,
  blocked: [],
  busy: [],
  durationMin: 30,
  slotMin: 30,
  bufferMin: 0,
  days: 1,
  minNoticeMin: 60,
};
const times = (q: Partial<SlotQuery>) =>
  availableSlots({ ...base, ...q }).map((s) => localParts(s.start, IST).time);

describe('time zones', () => {
  test('IST wall clock <-> UTC', () => {
    expect(zonedTimeToUtc('2026-10-05', '10:00', IST).toISOString()).toBe('2026-10-05T04:30:00.000Z');
    expect(localParts(new Date('2026-10-05T04:30:00Z'), IST)).toEqual({
      date: '2026-10-05',
      weekday: 'mon',
      time: '10:00',
    });
  });

  test('handles DST zones (both sides of the change)', () => {
    expect(zonedTimeToUtc('2026-03-07', '10:00', 'America/New_York').toISOString()).toBe(
      '2026-03-07T15:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-09', '10:00', 'America/New_York').toISOString()).toBe(
      '2026-03-09T14:00:00.000Z',
    );
  });
});

describe('availability', () => {
  test('slots inside the rule, after the minimum notice', () => {
    expect(times({})).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
    expect(times({ minNoticeMin: 90 })).toEqual(['10:30', '11:00', '11:30', '12:00', '12:30']);
  });

  test('a 60-minute service must fit before closing', () => {
    expect(times({ durationMin: 60 })).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']);
  });

  test('existing appointments (plus buffer) and blocked times are removed', () => {
    const busy = [
      {
        start: zonedTimeToUtc('2026-10-05', '11:00', IST),
        end: zonedTimeToUtc('2026-10-05', '11:30', IST),
        resource: 'chair-1',
      },
    ];
    expect(times({ busy, bufferMin: 15 })).toEqual(['10:00', '11:30', '12:00', '12:30']);
    const blocked = [
      {
        start: zonedTimeToUtc('2026-10-05', '12:00', IST),
        end: zonedTimeToUtc('2026-10-05', '13:00', IST),
        resource: null,
      },
    ];
    expect(times({ blocked })).toEqual(['10:00', '10:30', '11:00', '11:30']);
  });

  test('a second resource keeps a slot open; Sunday has no rules', () => {
    const two = [...rules, { weekday: 'mon' as const, start: '11:00', end: '12:00', resource: 'chair-2' }];
    const busy = [
      {
        start: zonedTimeToUtc('2026-10-05', '11:00', IST),
        end: zonedTimeToUtc('2026-10-05', '11:30', IST),
        resource: 'chair-1',
      },
    ];
    const slot = availableSlots({ ...base, rules: two, busy }).find(
      (s) => localParts(s.start, IST).time === '11:00',
    );
    expect(slot?.resources).toEqual(['chair-2']);
    expect(availableSlots({ ...base, fromDate: '2026-10-11' })).toEqual([]);
  });

  test('offers are spread out and honour the preferred part of day', () => {
    const slots = availableSlots({ ...base, days: 2 });
    expect(pickOffers(slots, 3, { timeZone: IST }).map((s) => localParts(s.start, IST).time)).toEqual([
      '10:00',
      '11:30',
      '10:00',
    ]);
    const pm = availableSlots({ ...base, rules: rules.map((r) => ({ ...r, end: '19:00' })), days: 1 });
    expect(
      pickOffers(pm, 2, { timeZone: IST, prefer: 'evening' }).map((s) => localParts(s.start, IST).time),
    ).toEqual(['17:00', '18:30']);
  });
});
