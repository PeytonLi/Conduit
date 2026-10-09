export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function dateFromClock(clock: Clock = systemClock): Date {
  return clock.now();
}
