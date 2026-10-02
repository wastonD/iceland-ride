// Procedural AudioBuffer generators (noise, rain grains, reverb impulse).
// Nothing here loads a file: every sample is computed from a seeded RNG.
import { mulberry32 } from '../core/noise.js';

/** Gaussian-ish random from an rng function (Box-Muller). */
export function randn(rng = Math.random) {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalizeRms(data, rms) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  const cur = Math.sqrt(s / data.length) || 1;
  const k = rms / cur;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}

/**
 * Seamlessly loopable mono noise. type: 'white' | 'pink' | 'brown'.
 * The tail is equal-power cross-faded into the head so the loop point is inaudible.
 */
export function makeNoiseBuffer(ac, type, seconds, seed, rms = 0.25) {
  const sr = ac.sampleRate;
  // Odd length on purpose: a looping buffer of exactly 235200 samples made Chrome's
  // BiquadFilter blow up to NaN after the first loop wrap (observed at 48 kHz).
  const n = Math.round(seconds * sr) | 1;
  const xf = Math.round(0.2 * sr);
  const rng = mulberry32(seed);
  const raw = new Float32Array(n + xf);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = rng() * 2 - 1;
    if (type === 'white') {
      raw[i] = w;
    } else if (type === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      brown = brown * 0.996 + w * 0.05;
      raw[i] = brown;
    }
  }
  const buf = ac.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw[i];
  for (let i = 0; i < xf; i++) {
    const a = (i / xf) * Math.PI * 0.5;
    d[i] = raw[i] * Math.sin(a) + raw[n + i] * Math.cos(a);
  }
  normalizeRms(d, rms);
  return buf;
}

/**
 * Stereo buffer full of tiny rain-drop "ticks" (independent L/R), perSec grains
 * per channel. Grains wrap around the end so the loop is seamless.
 */
export function makeGrainBuffer(ac, seconds, perSec, seed, rms = 0.15) {
  const sr = ac.sampleRate;
  const n = Math.round(seconds * sr);
  const buf = ac.createBuffer(2, n, sr);
  const rng = mulberry32(seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const count = Math.round(perSec * seconds);
    for (let k = 0; k < count; k++) {
      const pos = Math.floor(rng() * n);
      const amp = Math.pow(rng(), 2.6) * 0.9 + 0.03;
      if (rng() < 0.6) {
        // noise pop: differentiated noise with fast decay
        const len = Math.floor(sr * (0.0015 + rng() * 0.006));
        const tau = len * 0.35;
        let prev = 0;
        for (let j = 0; j < len; j++) {
          const w = rng() * 2 - 1;
          const hp = w - prev; prev = w;
          d[(pos + j) % n] += amp * hp * Math.exp(-j / tau);
        }
      } else {
        // tiny ringing "tink"
        const f = 2500 + rng() * 6500;
        const len = Math.floor(sr * 0.006);
        const tau = sr * (0.0006 + rng() * 0.0012);
        const ph = rng() * 6.283;
        for (let j = 0; j < len; j++) {
          d[(pos + j) % n] += amp * 0.8 * Math.sin(ph + (2 * Math.PI * f * j) / sr) * Math.exp(-j / tau);
        }
      }
    }
    normalizeRms(d, rms);
  }
  return buf;
}

/** A bank of short single-drop grains (peak-normalised mono buffers, ~70 ms). */
export function makeGrainBank(ac, count, seed) {
  const sr = ac.sampleRate;
  const rng = mulberry32(seed);
  const bank = [];
  for (let b = 0; b < count; b++) {
    const n = Math.floor(sr * 0.07);
    const buf = ac.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const f = 1800 + rng() * 5200;
    const tauT = sr * (0.0012 + rng() * 0.004);
    const tauN = sr * (0.0008 + rng() * 0.0025);
    const mixN = 0.2 + rng() * 0.8;
    const ph = rng() * 6.283;
    let prev = 0;
    for (let j = 0; j < n; j++) {
      const w = rng() * 2 - 1;
      const hp = w - prev; prev = w;
      d[j] = Math.sin(ph + (2 * Math.PI * f * j) / sr) * Math.exp(-j / tauT) * (1 - mixN * 0.5)
        + hp * 0.5 * Math.exp(-j / tauN) * mixN;
    }
    let pk = 0;
    for (let j = 0; j < n; j++) pk = Math.max(pk, Math.abs(d[j]));
    for (let j = 0; j < n; j++) d[j] /= pk || 1;
    bank.push(buf);
  }
  return bank;
}

/** Stereo diffuse-tail impulse response with high-frequency damping. */
export function makeReverbIR(ac, rt60 = 3.0, seed = 77) {
  const sr = ac.sampleRate;
  const n = Math.round(sr * rt60 * 1.15);
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(seed + ch * 101);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp((-6.91 * t) / rt60);
      const a = 0.09 + 0.8 * Math.exp(-t / 0.7); // darker as it decays
      lp += a * ((rng() * 2 - 1) - lp);
      const x = Math.min(1, Math.max(0, (t - 0.01) / 0.05));
      d[i] = lp * env * x * x * (3 - 2 * x) * 1.6;
    }
    // sparse early reflections
    for (let k = 0; k < 14; k++) {
      const idx = Math.floor((0.012 + rng() * 0.08) * sr);
      d[idx] += (rng() * 2 - 1) * 0.5;
    }
  }
  return buf;
}

/**
 * Stereo bed of discrete rain-drop impacts (shot noise). Each impact is a very
 * short resonant burst (random centre frequency / damping) with a lognormal
 * amplitude, so a few loud drops stand out over many small ones (high kurtosis,
 * like real rain). Impacts are panned by equal-power law (stereo correlation
 * ~0.3 for a wide spread). Wraps around so the loop is seamless.
 *
 * o: { seconds, perSec, seed, fLo, fHi, tauLo, tauHi (ms), k (lognormal sigma),
 *      noiseMix 0..1, bodyProb, bodyAmp, spread 0..1, rms }
 */
export function makeImpactBed(ac, o) {
  const sr = ac.sampleRate;
  const n = Math.round(o.seconds * sr);
  const buf = ac.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const rng = mulberry32(o.seed);
  const count = Math.round(o.perSec * o.seconds);
  const nm = o.noiseMix ?? 0.3;
  for (let k = 0; k < count; k++) {
    const pos = Math.floor(rng() * n);
    const a = Math.min(Math.exp(o.k * randn(rng)), 6); // capped: no single drop dominates the peak level
    let th = Math.PI / 4 + (rng() * 2 - 1) * (o.spread ?? 1) * (Math.PI / 4);
    if (rng() < (o.hard ?? 0)) th = rng() < 0.5 ? 0.12 : Math.PI / 2 - 0.12; // drop right beside one ear
    const gl = Math.cos(th) * Math.SQRT2, gr = Math.sin(th) * Math.SQRT2;
    const f = o.fLo * Math.pow(o.fHi / o.fLo, rng());
    let tauS = (o.tauLo + (o.tauHi - o.tauLo) * rng()) * 1e-3;
    // optional resonance cap: Q = pi*f*tau <= qMax keeps the impact a soft broadband pulse
    // (high-Q resonant impacts ring like glass / a tuned "ting")
    if (o.qMax) tauS = Math.min(tauS, o.qMax / (Math.PI * f));
    const tau = Math.max(3, tauS * sr);
    const len = Math.max(8, Math.min(Math.floor(tau * 7), Math.floor(sr * 0.05)));
    const w = (2 * Math.PI * f) / sr, ph = rng() * 6.283;
    for (let j = 0; j < len; j++) {
      const s = ((1 - nm) * Math.sin(ph + w * j) + nm * (rng() * 2 - 1)) * Math.exp(-j / tau) * (1 - Math.exp(-j / 4)) * a;
      const idx = (pos + j) % n;
      L[idx] += s * gl; R[idx] += s * gr;
    }
    if (o.bodyProb && rng() < o.bodyProb) {
      const f2 = 120 + rng() * 420;
      let tau2s = (2.5 + rng() * 4) * 1e-3;
      if (o.qMax) tau2s = Math.min(tau2s, (o.qMax * 1.5) / (Math.PI * f2));
      const tau2 = Math.max(3, tau2s * sr);
      const w2 = (2 * Math.PI * f2) / sr, len2 = Math.floor(tau2 * 6), b = a * (o.bodyAmp ?? 1);
      for (let j = 0; j < len2; j++) {
        const s = Math.sin(w2 * j) * Math.exp(-j / tau2) * (1 - Math.exp(-j / 8)) * b;
        const idx = (pos + j) % n;
        L[idx] += s * gl; R[idx] += s * gr;
      }
    }
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += L[i] * L[i] + R[i] * R[i];
  const k = (o.rms ?? 0.1) / (Math.sqrt(s / (2 * n)) || 1);
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  return buf;
}

/**
 * Road-tunnel impulse response: short (~1.7 s) and dense, bright concrete reflections
 * with a slight flutter echo between the walls (~40 ms).
 */
export function makeTunnelIR(ac, seed = 313) {
  const sr = ac.sampleRate;
  const n = Math.round(sr * 1.9);
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(seed + ch * 53);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp((-6.91 * t) / 1.5);
      const a = 0.35 + 0.5 * Math.exp(-t / 0.5); // stays bright (hard concrete)
      lp += a * ((rng() * 2 - 1) - lp);
      const x = Math.min(1, t / 0.006);
      d[i] = lp * env * x * 1.2;
    }
    // flutter echo: discrete decaying reflections ~40 ms apart, slightly different per ear
    const gap = 0.038 + ch * 0.004;
    for (let k = 1; k < 30; k++) {
      const idx = Math.floor(k * gap * sr);
      if (idx < n) d[idx] += (rng() > 0.5 ? 1 : -1) * 0.9 * Math.pow(0.8, k);
    }
  }
  return buf;
}
