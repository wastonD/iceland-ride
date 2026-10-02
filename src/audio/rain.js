// Rain body layer.
//
// Real rain is a superposition of huge numbers of discrete drop impacts, not
// stationary noise. So the main body here is made of pre-rendered "impact beds"
// (Poisson shot noise with lognormal amplitudes and randomised resonances =>
// high kurtosis, sparse loud drops over many small ones), layered by drop
// class. A darker, quieter continuous noise "curtain" fills the far field.
// Everything is driven continuously by env.rain (0..1) with slow, independent
// L/R random-walk modulation for showery swells.
import { makeNoiseBuffer, makeImpactBed } from './buffers.js';
import { Wander } from './util.js';
import { Gate } from './chains.js';
import { createLoop } from './loops.js';

const TRIM = 2.8; // layer trim (tune overall rain loudness here)

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const db = (x) => Math.pow(10, x / 20);

/** Overall rain level (dB re. medium rain) as a function of intensity. */
const LEVEL_PTS = [[0, -13], [0.12, -9], [0.5, 0], [0.95, 2.0], [1, 2.4]];
export function levelDb(r) {
  for (let i = 1; i < LEVEL_PTS.length; i++) {
    if (r <= LEVEL_PTS[i][0]) {
      const [x0, y0] = LEVEL_PTS[i - 1], [x1, y1] = LEVEL_PTS[i];
      return lerp(y0, y1, (r - x0) / (x1 - x0));
    }
  }
  return LEVEL_PTS[LEVEL_PTS.length - 1][1];
}

/* ---- continuous far-field curtain (quiet, dark) ---------------------------------- */
export const BANDS = [
  { // high hiss, very low: only a faint air
    name: 'hiss', src: 'white', depth: 0.10, wf: 0.21, a: 0.045, shape: (r) => 6 * (r - 0.5),
    filters: [{ type: 'highpass', f: (r) => lerp(4000, 3000, r), q: () => 0.6 }, { type: 'lowpass', f: () => 7500, q: () => 0.5 }],
  },
  { // distant rain on the canopy overhead: soft dense wide-band hiss of many leaf layers, slow swell
    name: 'canopy', src: 'pink', depth: 0.3, wf: 0.07, a: 0.2, shape: (r) => 8 * (r - 0.5),
    filters: [{ type: 'bandpass', f: () => 2200, q: () => 0.4 }],
  },
  { // mid wash
    name: 'wash', src: 'pink', common: 0.2, depth: 0.25, wf: 0.08, a: 0.19, shape: (r) => 14 * (r - 0.5),
    filters: [{ type: 'bandpass', f: (r) => lerp(1100, 700, r), q: (r) => lerp(0.8, 0.55, r) }],
  },
  { // low rumble, mostly in heavy rain
    name: 'rumble', src: 'brown', common: 0.4, depth: 0.30, wf: 0.06, a: 0.07, shape: (r) => 20 * (r - 0.5),
    filters: [{ type: 'highpass', f: () => 38, q: () => 0.7, fixed: true }, { type: 'lowpass', f: (r) => lerp(130, 300, r), q: () => 0.7 }],
  },
];

/* ---- impact beds by drop class ---------------------------------------------------- */
// far = passes the canopy muffle; near (large leaf-splats) stays crisp.
export const BEDS = [
  {
    name: 'small', far: true, a: 0.3, wf: 0.17, depth: 0.35, shape: (r) => 12 * (r - 0.5),
    gen: { seconds: 6.1, perSec: 2400, seed: 5101, fLo: 1400, fHi: 9500, tauLo: 0.2, tauHi: 0.6, qMax: 1.5, k: 0.4, noiseMix: 0.6, bodyProb: 0, spread: 1, hard: 0.75, rms: 0.1 },
  },
  {
    name: 'mid', far: true, a: 0.26, wf: 0.11, depth: 0.4, shape: (r) => 0,
    gen: { seconds: 7.3, perSec: 45, seed: 5102, fLo: 400, fHi: 2600, tauLo: 0.5, tauHi: 2.0, qMax: 2, k: 0.55, noiseMix: 0.55, bodyProb: 0.15, bodyAmp: 0.5, spread: 1, hard: 0.75, rms: 0.1 },
  },
  {
    name: 'large', far: false, a: 0.25, wf: 0.07, depth: 0.45, shape: (r) => -4 * (r - 0.5),
    gen: { seconds: 8.9, perSec: 8, seed: 5103, fLo: 350, fHi: 2200, tauLo: 1.0, tauHi: 4.0, qMax: 2, k: 0.4, noiseMix: 0.55, bodyProb: 0.5, bodyAmp: 0.6, spread: 1, hard: 0.75, rms: 0.1 },
  },
  { // hard-surface patter (asphalt / rock / rain jacket): only used in open scenes (fjord)
    name: 'hard', far: true, open: true, a: 0.2, wf: 0.13, depth: 0.35, shape: (r) => 6 * (r - 0.5),
    gen: { seconds: 6.7, perSec: 900, seed: 5105, fLo: 1200, fHi: 6500, tauLo: 0.15, tauHi: 0.5, qMax: 1.5, k: 0.5, noiseMix: 0.6, bodyProb: 0, spread: 1, hard: 0.75, rms: 0.1 },
  },
  { // rare, sharp, bright leaf ticks: these give the sparse high-frequency spikes
    name: 'tick', far: false, a: 0.22, wf: 0.09, depth: 0.5, shape: (r) => 0,
    gen: { seconds: 9.7, perSec: 5, seed: 5104, fLo: 1500, fHi: 5200, tauLo: 0.3, tauHi: 0.9, qMax: 1.5, k: 0.85, noiseMix: 0.5, bodyProb: 0, spread: 1, hard: 0.75, rms: 0.1 },
  },
];

/**
 * Static mix targets for a given rain intensity + environment.
 * Shared by the live graph and the offline simulator (tools / debugging).
 */
export function rainMix(r, env = {}) {
  const canopy = env.canopy ?? 0, water = env.water ?? 0;
  const L = levelDb(r);
  const farDb = L - 2 * canopy;
  const bands = BANDS.map((b) => {
    let g = b.a * db(farDb + b.shape(r));
    if (b.name === 'hiss') g *= 1 + 0.25 * water;
    if (b.name === 'canopy') g *= 0.5 + 1.0 * canopy;
    if (b.name === 'wash') g *= 1 + 0.15 * canopy + (env.scene === 'fjord' ? 0.35 : 0);
    return g;
  });
  const open = env.scene === 'fjord' ? 1 : 0; // no canopy: fewer near big drops, more distant curtain
  const beds = BEDS.map((b) => {
    if (b.open) return open * b.a * db(farDb + b.shape(r));
    let g;
    if (b.far) g = b.a * db(farDb + b.shape(r));
    else g = b.a * db(L + b.shape(r) + (b.name === 'tick' ? 11 : 5) * canopy);
    if (open) g *= b.name === 'large' ? 0.3 : b.name === 'tick' ? 0.4 : b.name === 'mid' ? 0.7 : 0.5;
    return g;
  });
  return {
    bands, beds,
    muffleHz: lerp(17000, 8500, Math.pow(canopy, 0.8)),
    wet: open ? 0.08 : lerp(0.2, 0.55, canopy),
  };
}

export function createRainLayer(engine) {
  const { ac } = engine;
  const out = engine.makeLayer('rain', TRIM);
  let lastR = -1;

  // far group -> canopy muffle -> post ;  near group -> post
  const farSum = ac.createGain(), nearSum = ac.createGain();
  const muffle = ac.createBiquadFilter();
  muffle.type = 'lowpass'; muffle.frequency.value = 17000; muffle.Q.value = 0.5;
  const post = ac.createGain();
  const wetSend = ac.createGain();
  wetSend.gain.value = 0.16;
  farSum.connect(muffle); muffle.connect(post); nearSum.connect(post);
  post.connect(out.dry); post.connect(wetSend); wetSend.connect(out.wet);

  // ---- continuous curtain, independent mono chain per ear -------------------
  const merger = ac.createChannelMerger(2);
  merger.connect(farSum);
  const durs = [4.3, 4.9, 5.7, 6.3, 5.1, 6.9, 7.3, 5.9, 6.7, 5.3, 6.1, 7.1];
  const bands = BANDS.map((def, bi) => {
    // sides 0/1 = independent left/right; side 2 (optional) = shared component in both ears
    const sides = (def.common ? [0, 1, 2] : [0, 1]).map((side) => {
      const si = bi * 3 + side;
      const src = createLoop(engine, makeNoiseBuffer(ac, def.src, durs[si], si * 91 + 17));
      const g = ac.createGain();
      g.gain.value = 0;
      if (side < 2) g.connect(merger, 0, side);
      else { g.connect(merger, 0, 0); g.connect(merger, 0, 1); }
      // A looping BufferSource wired straight into a BiquadFilter can blow the filter up
      // to NaN in Chrome after the first loop wrap; a plain gain node in between avoids it.
      const buffer = ac.createGain();
      src.out.connect(buffer);
      const filters = [];
      const wire = () => { // (re)build the filter chain buffer -> f... -> g
        filters.length = 0;
        let node = buffer;
        for (const fd of def.filters) {
          const f = ac.createBiquadFilter();
          f.type = fd.type; f.frequency.value = fd.f(lastR < 0 ? 0.5 : lastR); f.Q.value = fd.q(lastR < 0 ? 0.5 : lastR);
          node.connect(f); node = f; filters.push(f);
        }
        node.connect(g);
      };
      wire();
      const probe = ac.createAnalyser(); probe.fftSize = 256; g.connect(probe);
      const heal = () => { // watchdog: a biquad that went NaN never recovers, so rebuild it
        const a = new Float32Array(256); probe.getFloatTimeDomainData(a);
        if (a.every(Number.isFinite)) return;
        console.warn('[audio] rain filter went NaN, rebuilding');
        buffer.disconnect(); for (const f of filters) f.disconnect();
        wire();
      };
      return { src, filters, g, heal, w: new Wander(def.wf * (side ? 1.23 : 0.87)) };
    });
    return { def, sides };
  });

  // ---- impact beds ------------------------------------------------------------
  const beds = BEDS.map((def) => {
    const src = createLoop(engine, makeImpactBed(ac, def.gen));
    const g = ac.createGain(); g.gain.value = 0;
    src.out.connect(g);
    const gate = new Gate(g); gate.connect(def.far ? farSum : nearSum);
    return { def, src, g, gate, w: new Wander(def.wf) };
  });

  const gust = new Wander(0.11);   // shared swell over the whole field (~9 s)
  const flutter = new Wander(0.42); // shared faster surge (~2 s)
  let acc = 0, lastMuffle = 17000, healT = 0;

  return {
    name: 'rain',
    out,
    debug: { bands, beds, muffle, farSum, nearSum, merger, post },
    update(dt, now, env, ahead) {
      healT += dt;
      if (healT > 1.0) { healT = 0; for (const b of bands) for (const sd of b.sides) sd.heal(); }

      acc += dt;
      if (acc < 0.08) return;
      const step = acc; acc = 0;
      const r = clamp(env.rain, 0, 1);
      const mix = rainMix(r, env);
      const gx = gust.step(step);
      // shower swells: deeper in heavy rain
      const swell = 0.28 + 0.30 * r;
      const fx = flutter.step(step);
      const gm = Math.max(0.15, 1 + swell * gx * 1.6 + 0.06 * r * r * fx * 1.6);
      const tc = 0.14;
      const retune = Math.abs(r - lastR) > 0.004;
      if (retune) lastR = r;

      BANDS.forEach((def, bi) => {
        const depth = def.depth * (0.75 + 0.5 * r);
        for (let s = 0; s < bands[bi].sides.length; s++) {
          const sd = bands[bi].sides[s];
          const cshare = def.common ? (s < 2 ? Math.sqrt(1 - def.common) : Math.sqrt(def.common)) : 1;
          const x = sd.w.step(step);
          const m = Math.max(0.12, 1 + depth * x * 1.6) * gm;
          sd.g.gain.setTargetAtTime(mix.bands[bi] * m * cshare, now, tc);
          // Filter params only move when the rain intensity changes, and slowly:
          // fast/continuous automation makes Chrome's biquads go unstable (NaN).
          if (retune) {
            for (let k = 0; k < sd.filters.length; k++) {
              const fd = def.filters[k];
              if (fd.fixed) continue;
              sd.filters[k].frequency.setTargetAtTime(fd.f(r), now, 0.5);
              sd.filters[k].Q.setTargetAtTime(fd.q(r), now, 0.5);
            }
          }
        }
      });

      // density modulation: each drop class swells on its own
      beds.forEach((bd, i) => {
        const x = bd.w.step(step);
        const m = Math.max(0.1, 1 + bd.def.depth * (0.8 + 0.5 * r) * x * 1.6) * gm;
        bd.g.gain.setTargetAtTime(mix.beds[i] * m, now, 0.18);
        bd.gate.update(mix.beds[i], step);
      });

      // Under canopy the curtain reaches you dark and distant; near leaf drops stay crisp.
      if (Math.abs(mix.muffleHz - lastMuffle) > lastMuffle * 0.01) {
        lastMuffle = mix.muffleHz;
        muffle.frequency.setTargetAtTime(mix.muffleHz, now, 0.9);
      }
      wetSend.gain.setTargetAtTime(mix.wet, now, 0.9);
    },
    dispose() {
      for (const b of bands) for (const s of b.sides) { try { s.src.stop(); } catch (e) { /* */ } }
      for (const b of beds) { try { b.src.stop(); } catch (e) { /* */ } }
      out.dispose();
    },
  };
}
