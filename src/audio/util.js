// Small shared helpers for the audio modules.
import { randn } from './buffers.js';

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const db = (x) => Math.pow(10, x / 20);
export const rnd = Math.random;

/** Ornstein-Uhlenbeck random walk, std ~ 0.5, correlation time ~ 1/(2 pi f). */
export class Wander {
  constructor(f) { this.th = 2 * Math.PI * f; this.x = (Math.random() - 0.5); }
  step(dt) {
    const s = Math.sqrt(2 * this.th) * 0.5;
    this.x += -this.th * this.x * dt + s * Math.sqrt(dt) * randn();
    this.x = clamp(this.x, -1.4, 1.4);
    return this.x;
  }
}

/** Exponentially smoothed scalar, time constant tc seconds. */
export class Smooth {
  constructor(v = 0) { this.v = v; }
  step(target, dt, tc) { this.v += (target - this.v) * (1 - Math.exp(-dt / tc)); return this.v; }
}
