/**
 * Runs every catalog scenario in the realistic world across many seeds and prints how the
 * loops fared and which real-world imperfections they hit.
 * Run: npx tsx examples/realistic-report.ts [seeds=30]
 */
import { DAY } from '../src/core/time.js';
import { SCENARIOS } from '../src/fakes/catalog.js';
import { runRealistic } from '../src/fakes/realistic/harness.js';
import type { WorldStats } from '../src/fakes/realistic/world.js';

const seeds = Number(process.argv[2] ?? 30);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };

const totals: Partial<Record<keyof WorldStats, number>> = {};
let shippedHarm = 0, closedUnverified = 0, fixedBugs = 0;
console.log(`${'scenario'.padEnd(28)} ${'outcomes'.padEnd(40)} ${'median'.padEnd(8)} shipped-harm  closed-unverified`);
for (const sc of SCENARIOS) {
  const outcomes: Record<string, number> = {};
  const days: number[] = [];
  let errors = 0, harm = 0, unverified = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await runRealistic(sc, seed);
    const status = r.error ? 'sim-error' : r.result?.status ?? 'unfinished';
    outcomes[status] = (outcomes[status] ?? 0) + 1;
    if (r.error) { errors++; if (errors === 1) console.log(`  ${sc.id} seed ${seed}: ${r.error}`); }
    days.push(r.sim.now / DAY);
    for (const [k, v] of Object.entries(r.world.stats)) totals[k as keyof WorldStats] = (totals[k as keyof WorldStats] ?? 0) + v;

    // Outcome quality, judged against ground truth.
    const exp = r.world.exps.get('E1')!;
    if (status === 'done' && [...r.world.defects.values()].some((d) => r.world.harmOf(d, exp, r.sim.now) > 0)) harm++;
    for (const i of r.world.tracker.issues.values()) {
      if (i.status !== 'FIXED' || !i.truth) continue;
      fixedBugs++;
      if (r.world.cureFraction(r.world.defects.get(i.truth)!, i.closedAt!) < 1) unverified++;
    }
  }
  shippedHarm += harm;
  closedUnverified += unverified;
  const out = Object.entries(outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${sc.title.padEnd(28)} ${out.padEnd(40)} ${(median(days).toFixed(1) + 'd').padEnd(8)} ${String(harm).padEnd(13)} ${unverified}`);
}
console.log(`\nshipped-harm: ramp concluded at 100% while a planted defect still did real harm (${shippedHarm} runs)`);
console.log(`closed-unverified: bug closed FIXED before its defect was actually cured (${closedUnverified} of ${fixedBugs} fixed bugs)`);
console.log(`\nImperfections across ${SCENARIOS.length * seeds} runs:`);
for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(22)} ${v}`);

