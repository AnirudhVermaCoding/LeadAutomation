import { describe, expect, test } from 'vitest';
import { HOUR, MINUTE } from './clock.ts';
import {
  chooseOutbound,
  isOptOutMessage,
  isWindowOpen,
  OutsideServiceWindowError,
  windowExpiresAt,
} from './messaging.ts';
import { fromWaId, toE164 } from './phone.ts';

describe('24-hour service window', () => {
  const inbound = new Date('2026-10-05T10:00:00Z');
  const expires = windowExpiresAt(inbound);

  test('open until exactly 24h after the last inbound message', () => {
    expect(isWindowOpen(expires, new Date(inbound.getTime() + 24 * HOUR - MINUTE))).toBe(true);
    expect(isWindowOpen(expires, new Date(inbound.getTime() + 24 * HOUR))).toBe(false);
    expect(isWindowOpen(null, inbound)).toBe(false);
  });

  test('free-form inside the window, template outside, refuse when neither is allowed', () => {
    const inside = new Date(inbound.getTime() + HOUR);
    const outside = new Date(inbound.getTime() + 25 * HOUR);
    expect(chooseOutbound({ windowExpires: expires, now: inside, freeForm: 'hi', template: 't' })).toEqual({
      kind: 'free_form',
      content: 'hi',
    });
    expect(chooseOutbound({ windowExpires: expires, now: outside, freeForm: 'hi', template: 't' })).toEqual({
      kind: 'template',
      template: 't',
    });
    expect(() => chooseOutbound({ windowExpires: expires, now: outside, freeForm: 'hi' })).toThrow(
      OutsideServiceWindowError,
    );
    expect(() => chooseOutbound({ windowExpires: null, now: inside, freeForm: 'hi' })).toThrow(
      OutsideServiceWindowError,
    );
  });
});

describe('opt-out keywords', () => {
  const keywords = ['stop', 'unsubscribe', 'stop messages', 'band karo', 'बंद', 'मैसेज बंद करो'];

  test.each(['STOP', ' Stop! ', 'unsubscribe', 'please stop messages', 'Band karo', 'बंद', 'मैसेज बंद करो।'])(
    'opts out: %s',
    (text) => expect(isOptOutMessage(text, keywords)).toBe(true),
  );

  test.each(["don't stop, I want to book", 'stopwatch', 'bandra west', 'kab band hota hai clinic?', ''])(
    'does not opt out: %s',
    (text) => expect(isOptOutMessage(text, keywords)).toBe(false),
  );
});

describe('phone normalisation', () => {
  test.each([
    ['98765 43210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['+1 (650) 555-1234', '+16505551234'],
  ])('%s -> %s', (raw, e164) => expect(toE164(raw)).toBe(e164));

  test.each(['12345', '1234567890', 'call me', ''])('rejects %s', (raw) => expect(toE164(raw)).toBeNull());

  test('WhatsApp wa_id', () => expect(fromWaId('919876543210')).toBe('+919876543210'));
});
