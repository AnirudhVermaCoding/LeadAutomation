export interface Clock {
  now(): Date;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const systemClock: Clock = { now: () => new Date() };

/** Settable clock for tests, the simulator and the demo's "fast-forward time". */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: Date | string) {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  set(to: Date | string): void {
    this.#ms = new Date(to).getTime();
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('FakeClock cannot go backwards');
    this.#ms += ms;
  }
}

/**
 * Real time plus a shift that only moves forward: the demo's "fast-forward" control.
 * Only used in mock mode; production runs on systemClock.
 */
export class OffsetClock implements Clock {
  #offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.#offsetMs);
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('OffsetClock cannot go backwards');
    this.#offsetMs += ms;
  }
}
