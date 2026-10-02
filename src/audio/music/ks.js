// Karplus-Strong plucked-string sample renderer (pure JS, no Web Audio dependency,
// so it can be unit-tested in node). Returns a Float32Array with a built-in envelope:
// the layer only needs to play it back through a gain node.
import { mulberry32 } from './quiet.js';

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * @param {number} sr       sample rate
 * @param {number} midi     pitch
 * @param {number} seconds  buffer length
 */
export function renderPluck(sr, midi, seconds = 2.4, opts = {}) {
  const f = midiToHz(midi);
  const L = sr / f;                           // total loop length in samples
  const N = Math.max(2, Math.floor(L - 1));   // integer delay line
  const frac = L - 0.5 - N;                   // remainder (0.5..1.5): the averaging filter adds 0.5
  const a = (1 - frac) / (1 + frac);          // 1st-order allpass fractional delay
  const rng = mulberry32(0x9e3779b1 ^ (midi * 2654435761));

  // ---- excitation: soft (low-passed) noise burst, pick-position comb, DC removed
  const d = new Float32Array(N);
  let y = 0;
  // opts.bright (0..1) overrides the excitation low-pass coefficient: ~0.2 = dark nylon / thumb pluck
  const bright = opts.bright ?? (0.5 + 0.25 * Math.min(1, Math.max(0, (midi - 40) / 40))); // higher notes a bit brighter
  for (let i = 0; i < N; i++) { y += bright * ((rng() * 2 - 1) - y); d[i] = y; }
  const k = Math.max(1, Math.round(N * 0.16));
  const tmp = Float32Array.from(d);
  let mean = 0;
  for (let i = 0; i < N; i++) { d[i] = tmp[i] - 0.85 * tmp[(i - k + N) % N]; mean += d[i]; }
  mean /= N;
  for (let i = 0; i < N; i++) d[i] -= mean;

  // ---- per-pitch decay (low strings ring longer)
  const t60 = (opts.t60Scale ?? 1) * Math.max(1.1, 3.6 - 2.4 * Math.min(1, Math.max(0, (midi - 40) / 44)));
  const rho = Math.pow(10, (-3 / f) / t60);

  const len = Math.round(seconds * sr);
  const out = new Float32Array(len);
  let idx = 0, prev = 0, apx = 0, apy = 0;
  for (let n = 0; n < len; n++) {
    const x = d[idx];
    out[n] = x;
    const lp = 0.5 * (x + prev); prev = x;
    const ap = a * lp + apx - a * apy; apx = lp; apy = ap;
    d[idx] = ap * rho;
    if (++idx === N) idx = 0;
  }

  // ---- normalise (RMS of the first 0.4 s), soft-limit, fade the tail
  const nr = Math.min(len, Math.round(0.4 * sr));
  let s = 0;
  for (let i = 0; i < nr; i++) s += out[i] * out[i];
  const rms = Math.sqrt(s / nr) || 1;
  let g = 0.16 / rms;
  let pk = 0;
  for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(out[i]));
  if (pk * g > 0.95) g = 0.95 / pk;
  const fade = Math.round(0.35 * sr);
  const fadeStart = len - fade;
  for (let i = 0; i < len; i++) {
    let v = out[i] * g;
    if (i >= fadeStart) { const u = (i - fadeStart) / fade; v *= 0.5 + 0.5 * Math.cos(Math.PI * u); }
    // 2 ms attack ramp removes the click of a non-zero first sample
    if (i < 96) v *= i / 96;
    out[i] = v;
  }
  return out;
}
