/**
 * Deterministic PRNG (mulberry32). Every visual randomisation in the pack
 * animation pulls from one of these, seeded off `PackOutcome.seed`, so a replay
 * reproduces the previous run exactly.
 */

export interface Rng {
  /** Next float in [0, 1). */
  next: () => number;
  /** Next float in [min, max). */
  range: (min: number, max: number) => number;
  /** Next integer in [min, max]. */
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly [T, ...T[]]) => T;
  /** Random unit-ish signed value in [-1, 1). */
  signed: () => number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + next() * (max - min);

  return {
    next,
    range,
    int: (min, max) => Math.floor(range(min, max + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] ?? items[0],
    signed: () => next() * 2 - 1,
  };
}

/**
 * Derives a stable child seed from a parent seed plus a salt, so independent
 * effects (pack burst vs. card #3 sparkles) get uncorrelated but still
 * reproducible streams.
 */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hashes a string into a seed, for deriving a seed from a card/pack id. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
