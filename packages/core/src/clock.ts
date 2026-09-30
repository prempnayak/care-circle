/** All code reads time through a Clock so tests and the demo controls can move it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that can be pinned to an instant or shifted by an offset (dev demo controls and tests). */
export class AdjustableClock implements Clock {
  private fixed: Date | null = null;
  private offsetMs = 0;

  constructor(private readonly base: Clock = systemClock) {}

  now(): Date {
    if (this.fixed) return new Date(this.fixed.getTime() + this.offsetMs);
    return new Date(this.base.now().getTime() + this.offsetMs);
  }

  /** Pin the clock to an instant; later offsets apply on top of it. */
  set(instant: Date): void {
    this.fixed = instant;
    this.offsetMs = 0;
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  reset(): void {
    this.fixed = null;
    this.offsetMs = 0;
  }
}
