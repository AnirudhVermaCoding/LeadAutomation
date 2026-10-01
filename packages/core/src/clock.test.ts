import { expect, test } from 'vitest';
import { DAY, FakeClock, HOUR } from './clock.ts';

test('FakeClock advances and refuses to go backwards', () => {
  const clock = new FakeClock('2026-10-01T09:00:00+05:30');
  clock.advance(DAY + 2 * HOUR);
  expect(clock.now().toISOString()).toBe('2026-10-02T05:30:00.000Z');
  expect(() => clock.advance(-1)).toThrow();
});
