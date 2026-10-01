import { HOUR } from './clock.ts';

/**
 * WhatsApp rule: free-form messages only within 24 h of the lead's last inbound message;
 * outside that window only approved templates may be sent.
 */
export const SERVICE_WINDOW_MS = 24 * HOUR;

export const windowExpiresAt = (lastInboundAt: Date) => new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);

export const isWindowOpen = (windowExpires: Date | null, now: Date) =>
  windowExpires !== null && now.getTime() < windowExpires.getTime();

export class OutsideServiceWindowError extends Error {
  constructor() {
    super('The 24-hour WhatsApp service window is closed and no approved template was provided');
  }
}

export type OutboundChoice<F, T> = { kind: 'free_form'; content: F } | { kind: 'template'; template: T };

/**
 * Pick what may legally be sent. Prefers free-form inside the window (cheaper, more natural);
 * falls back to the template; refuses when neither is allowed.
 */
export function chooseOutbound<F, T>(opts: {
  windowExpires: Date | null;
  now: Date;
  freeForm?: F;
  template?: T;
}): OutboundChoice<F, T> {
  if (opts.freeForm !== undefined && isWindowOpen(opts.windowExpires, opts.now))
    return { kind: 'free_form', content: opts.freeForm };
  if (opts.template !== undefined) return { kind: 'template', template: opts.template };
  throw new OutsideServiceWindowError();
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Opt-out detection. A one-word keyword ("stop", "बंद") must be the whole message so that
 * "don't stop, I want to book" doesn't unsubscribe anyone; multi-word phrases
 * ("stop messages", "band karo") may appear anywhere in the message.
 */
export function isOptOutMessage(text: string, keywords: readonly string[]): boolean {
  const msg = normalise(text);
  if (!msg) return false;
  return keywords.some((k) => {
    const kw = normalise(k);
    if (!kw) return false;
    return kw.includes(' ') ? ` ${msg} `.includes(` ${kw} `) : msg === kw;
  });
}
