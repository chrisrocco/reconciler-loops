/** Seeded randomness. Every realistic run is reproducible from its seed. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }

  /** mulberry32: uniform in [0, 1). */
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number) { return this.next() < p; }
  uniform(lo: number, hi: number) { return lo + (hi - lo) * this.next(); }
  normal(mean = 0, sd = 1) {
    const u = 1 - this.next(), v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Durations: right-skewed, `median` in the middle, `sigma` ≈ 0.5 means most within ×0.4–×2.7. */
  lognormal(median: number, sigma: number) { return median * Math.exp(sigma * this.normal()); }
  pick<T>(xs: readonly T[]) { return xs[Math.floor(this.next() * xs.length)]!; }
}

/**
 * An independent stream keyed by its parts. Draws from it don't depend on what else was
 * drawn first, so e.g. metric noise is the same however often the loop polls.
 */
export function rngFor(...parts: (string | number)[]) {
  let h = 2166136261;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return new Rng(h >>> 0);
}
