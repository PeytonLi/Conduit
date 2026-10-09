export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(iso: string | Date): Clock {
  const at = new Date(iso);
  return { now: () => new Date(at) };
}
