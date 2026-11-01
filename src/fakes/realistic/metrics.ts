/**
 * Experiment analysis, the way a large-scale A/B platform reports guardrails:
 *
 * - Each guardrail is a relative treatment-vs-control change with a 95%/99% confidence
 *   interval. Noise shrinks with traffic share × hours of data, so a 1% arm is noisy and
 *   a 50% arm is precise.
 * - The estimate is the cumulative mean of hourly buckets since the last change to the
 *   treatment (stage change or a fix fully landing). Old buckets keep dragging the mean
 *   after a fix starts rolling out.
 * - Data lands a few hours late, the pipeline occasionally stalls for hours (results go
 *   stale), and a single metric's job sometimes fails for an hour.
 * - Verdicts: `fail` = significant harm beyond the threshold; `pass` = harm ruled out
 *   beyond the threshold; anything else is `insufficient`. False positives happen at the
 *   rate the statistics imply, peeking included.
 */
import { DAY, HOUR } from '../../core/time.js';
import type { GuardrailReading } from '../../scenarios/experiment.js';
import { Rng, rngFor } from './rng.js';

export interface GuardrailSpec {
  name: string;
  /** +1 if an increase is harm (latency), −1 if a decrease is harm (revenue). */
  harmSign: 1 | -1;
  /** Largest acceptable harm, relative %. */
  thresholdPct: number;
  /** Standard error of one hourly bucket at 1% traffic, relative %. */
  noisePct: number;
}

export const GUARDRAILS: GuardrailSpec[] = [
  { name: 'latency_p99', harmSign: 1, thresholdPct: 2, noisePct: 0.8 },
  { name: 'error_rate', harmSign: 1, thresholdPct: 5, noisePct: 3 },
  { name: 'crash_rate', harmSign: 1, thresholdPct: 5, noisePct: 4 },
  { name: 'revenue_per_user', harmSign: -1, thresholdPct: 0.5, noisePct: 1.2 },
  { name: 'cpu_per_query', harmSign: 1, thresholdPct: 2, noisePct: 0.5 },
];

export const FRESHNESS_LAG_MS = 2 * HOUR;
export const MIN_DATA_MS = 6 * HOUR;
export const STALE_AFTER_MS = 12 * HOUR;

/** What the analysis needs to know about the treatment (the world supplies ground truth). */
export interface Treatment {
  /** Traffic share (percent) actually receiving the treatment at t. */
  trafficPct(t: number): number;
  /** Start of the analysis window in effect at t: the last change to the treatment. */
  windowStart(t: number): number;
  /** True harm (relative %, positive = worse) on a guardrail at t. */
  harm(guardrail: string, t: number): number;
}

export interface Readout { readings: GuardrailReading[]; dataUntil: number; stale: boolean }

export class MetricsPipeline {
  readonly outages: { from: number; to: number }[] = [];
  private noise = new Map<string, { rng: Rng; eps: number[] }>();

  constructor(private seed: number, horizonDays = 180) {
    // Roughly one multi-hour pipeline stall every few weeks.
    const rng = rngFor(seed, 'metrics-outages');
    for (let d = 0; d < horizonDays; d++) {
      if (rng.chance(0.04)) {
        const from = d * DAY + rng.uniform(0, DAY);
        this.outages.push({ from, to: from + rng.lognormal(10 * HOUR, 0.5) });
      }
    }
  }

  outageAt(t: number) { return this.outages.find((o) => o.from <= t && t < o.to); }

  /** Latest event time whose data has been processed. */
  dataUntil(now: number) { return (this.outageAt(now)?.from ?? now) - FRESHNESS_LAG_MS; }

  readout(tr: Treatment, now: number): Readout {
    const dataUntil = this.dataUntil(now);
    const stale = now - dataUntil > STALE_AFTER_MS;
    const ws = tr.windowStart(dataUntil);
    const traffic = tr.trafficPct(ws + 1);
    const buckets = Math.floor(Math.max(0, dataUntil - ws) / HOUR);

    const readings = GUARDRAILS.map((g): GuardrailReading => {
      const base = { guardrail: g.name, threshold: g.harmSign * g.thresholdPct, severity: 'mild' as const };
      const jobFailed = rngFor(this.seed, 'metric-job', g.name, Math.floor(now / HOUR)).chance(0.01);
      if (stale || jobFailed || buckets * HOUR < MIN_DATA_MS || traffic <= 0) return { ...base, verdict: 'insufficient', value: 0 };

      const eps = this.bucketNoise(g, ws, traffic, buckets);
      let sum = 0;
      for (let j = 0; j < buckets; j++) sum += tr.harm(g.name, ws + (j + 0.5) * HOUR) + eps[j]!;
      const harm = sum / buckets;
      const se = g.noisePct / Math.sqrt(traffic * buckets);

      const verdict = harm - 2.58 * se > 0 && harm > g.thresholdPct ? 'fail'
        : harm + 1.96 * se < g.thresholdPct ? 'pass' : 'insufficient';
      return {
        ...base, verdict,
        value: Math.round(g.harmSign * harm * 100) / 100,
        severity: harm > 4 * g.thresholdPct ? 'severe' : 'mild',
      };
    });
    return { readings, dataUntil, stale };
  }

  /** Hourly bucket noise for one analysis window, generated once and extended as data arrives. */
  private bucketNoise(g: GuardrailSpec, ws: number, traffic: number, n: number) {
    const key = `${g.name}@${ws}@${traffic}`;
    let s = this.noise.get(key);
    if (!s) this.noise.set(key, (s = { rng: rngFor(this.seed, 'noise', key), eps: [] }));
    while (s.eps.length < n) s.eps.push(s.rng.normal(0, g.noisePct / Math.sqrt(traffic)));
    return s.eps;
  }
}
