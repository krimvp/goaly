/**
 * Seam #4a. The reducer never reads a clock; only the Driver does, through this. Timestamps
 * in the run log come from here, so replay is reproducible (a ManualClock yields fixed ts).
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
