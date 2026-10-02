// Offline objective checks for the quiet composer (node, no browser):
//   node src/audio/music/selftest.mjs
// Checks: in-key notes, register, note density (/s) vs energy / rain / scene, rests, longest silence,
// harmonic rhythm, motif/repeat statistics, Karplus-Strong pitch / NaN.
import { createQuiet, MAJOR, mulberry32 } from './quiet.js';
import { renderPluck, midiToHz } from './ks.js';

const inKey = (key, m) => MAJOR.includes(((m - key) % 12 + 12) % 12);
const SEEDS = 24, SECS = 600;

function run(scene, energy, rain) {
  let notes = 0, gestures = 0, off = 0, lo = 999, hi = -1, chords = 0, bigLeap = 0, leaps = 0, sumAbs = 0;
  let totalT = 0, longest = 0, quietTime = 0, dyads = 0;
  const kinds = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    const c = createQuiet(seed * 7919);
    let t = 0, prev = null;
    let lastEnd = 0;
    while (t < SECS) {
      const g = c.next({ energy, rain, scene });
      t += g.dt;
      gestures++;
      if (g.chord) { chords++; dyads += g.chord.low.length; for (const m of g.chord.low) { lo = Math.min(lo, m); if (!inKey(c.keyPc, m)) off++; } }
      // silence = time between the end of the last sounding gesture (approx 3 s ring) and the next one
      longest = Math.max(longest, g.dt);
      for (const n of g.notes) {
        notes++; kinds[n.kind] = (kinds[n.kind] || 0) + 1;
        if (!inKey(c.keyPc, n.midi)) off++;
        lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi);
        if (n.kind !== 'chime' || n.dt === 0) { if (prev !== null) { const d = Math.abs(n.midi - prev); sumAbs += d; leaps++; if (d > 7) bigLeap++; } prev = n.midi; }
      }
    }
    totalT += t;
  }
  return { rate: notes / totalT, gapMean: totalT / gestures, off, lo, hi, chordEvery: totalT / chords, longest, kinds, leapMean: sumAbs / leaps, bigLeapPct: 100 * bigLeap / leaps };
}

console.log('scene     energy rain  notes/s  mean-gap  chord-every  longest-gap  off-key  range      mean-leap  leaps>5th%');
for (const scene of ['rainforest', 'fjord'])
  for (const [e, r] of [[0, 0], [0.5, 0], [1, 0], [0, 0.8], [1, 0.8]]) {
    const x = run(scene, e, r);
    console.log(scene.padEnd(10), String(e).padEnd(6), String(r).padEnd(5), x.rate.toFixed(3).padStart(7), x.gapMean.toFixed(2).padStart(9), x.chordEvery.toFixed(1).padStart(12), x.longest.toFixed(1).padStart(12), String(x.off).padStart(8), `${x.lo}-${x.hi}`.padStart(9), x.leapMean.toFixed(2).padStart(10), x.bigLeapPct.toFixed(1).padStart(10));
  }
console.log('kinds (fjord e=0):', JSON.stringify(run('fjord', 0, 0).kinds), ' rainforest:', JSON.stringify(run('rainforest', 0, 0).kinds));

// ---- repetition: how often does an exact 6-note pitch sequence recur within one 10-min piece?
{
  let rep = 0, tot = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const c = createQuiet(seed * 31);
    const seq = []; let t = 0;
    while (t < SECS) { const g = c.next({ energy: 0.3, rain: 0, scene: 'fjord' }); t += g.dt; for (const n of g.notes) if (n.kind !== 'chime') seq.push(n.midi); }
    const seen = new Set();
    for (let i = 0; i + 6 <= seq.length; i++) { const k = seq.slice(i, i + 6).join(','); tot++; if (seen.has(k)) rep++; seen.add(k); }
  }
  console.log(`exact 6-note repeats: ${rep}/${tot} (${(100 * rep / tot).toFixed(1)}%)`);
}

// ---- Karplus-Strong sample checks (dark pluck options too)
const sr = 48000;
let nan = 0, worstCents = 0, worstAt = 0, peak = 0;
for (let m = 55; m <= 88; m++) {
  const buf = renderPluck(sr, m, 2.6, { bright: 0.16, t60Scale: 0.75 });
  for (let i = 0; i < buf.length; i++) { const v = buf[i]; if (!Number.isFinite(v)) nan++; peak = Math.max(peak, Math.abs(v)); }
  const f = midiToHz(m), a0 = Math.round(0.06 * sr), n = Math.round(0.3 * sr);
  const lagLo = Math.floor(sr / (f * 1.06)), lagHi = Math.ceil(sr / (f / 1.06));
  let best = -1, bl = 0; const cor = {};
  for (let lag = lagLo - 1; lag <= lagHi + 1; lag++) {
    let s = 0; for (let i = 0; i < n; i += 1) s += buf[a0 + i] * buf[a0 + i + lag];
    cor[lag] = s; if (lag >= lagLo && lag <= lagHi && s > best) { best = s; bl = lag; }
  }
  const y0 = cor[bl - 1], y1 = cor[bl], y2 = cor[bl + 1];
  const est = sr / (bl + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2));
  const cents = 1200 * Math.log2(est / f);
  if (Math.abs(cents) > Math.abs(worstCents)) { worstCents = cents; worstAt = m; }
}
console.log(`KS(dark): 34 notes, NaN=${nan}, peak=${peak.toFixed(3)}, worst pitch error ${worstCents.toFixed(1)} cents (midi ${worstAt})`);
