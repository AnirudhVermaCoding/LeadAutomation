import type { ExternalEvent } from '@instantlead/integrations';
import { describe, expect, test } from 'vitest';
import { blockFor, channelToken, channelTokenValid } from './calendar-sync.ts';

const base: ExternalEvent = {
  id: 'e1',
  status: 'confirmed',
  transparent: false,
  declinedBySelf: false,
  appointmentId: null,
  timed: { start: new Date('2026-10-07T08:30:00Z'), end: new Date('2026-10-07T09:30:00Z') },
  allDay: null,
  ignorable: false,
};
const TZ = 'Asia/Kolkata';

describe('blockFor', () => {
  test('a meeting blocks its exact time', () => {
    expect(blockFor(base, TZ)).toEqual({
      startsAt: new Date('2026-10-07T08:30:00Z'),
      endsAt: new Date('2026-10-07T09:30:00Z'),
    });
  });
  test('tentative still blocks (conservative)', () => {
    expect(blockFor({ ...base, status: 'tentative' }, TZ)).not.toBeNull();
  });
  test.each([
    ['deleted', { status: 'cancelled' as const }],
    ['free / transparent', { transparent: true }],
    ['declined by the owner', { declinedBySelf: true }],
    ['one of ours', { appointmentId: 'appt-1' }],
    ['working location', { ignorable: true }],
  ])('%s blocks nothing', (_name, patch) => {
    expect(blockFor({ ...base, ...patch }, TZ)).toBeNull();
  });
  test('an all-day event blocks the whole local day (end date exclusive)', () => {
    const ev = { ...base, timed: null, allDay: { startDate: '2026-10-08', endDate: '2026-10-09' } };
    expect(blockFor(ev, TZ)).toEqual({
      startsAt: new Date('2026-10-07T18:30:00Z'), // 00:00 IST on the 8th
      endsAt: new Date('2026-10-08T18:30:00Z'),
    });
  });
  test('a zero-length or inverted timed event blocks nothing', () => {
    expect(blockFor({ ...base, timed: { start: base.timed!.end, end: base.timed!.start } }, TZ)).toBeNull();
  });
});

describe('channel token', () => {
  const key = Buffer.alloc(32, 1);
  test('valid only for its own channel id', () => {
    const token = channelToken(key, 'chan-1');
    expect(channelTokenValid(key, 'chan-1', token)).toBe(true);
    expect(channelTokenValid(key, 'chan-2', token)).toBe(false);
    expect(channelTokenValid(key, 'chan-1', undefined)).toBe(false);
    expect(channelTokenValid(key, 'chan-1', 'x'.repeat(token.length))).toBe(false);
    expect(channelTokenValid(Buffer.alloc(32, 2), 'chan-1', token)).toBe(false);
  });
});
