// Wind layer: open-air wind with slow gusts; rushes past the ears with skate speed.
//
// Four fixed-filter noise bands (low body / mid / high whoosh / narrow whistle) per ear.
// Speed is expressed by cross-fading the bands: overall +12 dB from 0 to 15 m/s, with the
// high bands rising much faster (spectrum brightens => "rushing" wind). Gusts are random
// walks (0.05..0.3 Hz), independent per ear, plus one shared swell. Leaning shifts the
// image a little toward the outside of the turn. Under canopy: quieter and darker.
import { makeChain } from './chains.js';
import { Wander, Smooth, clamp, db } from './util.js';

const TRIM = 1.0;
const V_MAX = 15;

// g0: linear gain at rest; sp: extra dB gained between 0 and 15 m/s; gust: modulation depth
const BANDS = [
  { name: 'low', type: 'brown', seconds: 5.3, filters: [{ type: 'lowpass', f: 320, q: 0.7 }], g0: 0.42, sp: 9, gust: 0.32, wf: 0.07 },
  { name: 'mid', type: 'pink', seconds: 6.1, filters: [{ type: 'bandpass', f: 850, q: 0.6 }], g0: 0.36, sp: 14, gust: 0.3, wf: 0.11 },
  { name: 'high', type: 'white', seconds: 4.7, filters: [{ type: 'highpass', f: 2000, q: 0.6 }, { type: 'lowpass', f: 9500, q: 0.5 }], g0: 0.028, sp: 24, gust: 0.28, wf: 0.17 },
  { name: 'whistle', type: 'pink', seconds: 5.7, filters: [{ type: 'bandpass', f: 3700, q: 3.5 }], g0: 0.05, sp: 28, gust: 0.4, wf: 0.23 },
];

export function createWindLayer(engine) {
  const { ac } = engine;
  const out = engine.makeLayer('wind', TRIM);
  const merger = ac.createChannelMerger(2);
  merger.connect(out.dry);

  const bands = BANDS.map((def, bi) => {
    const sides = [0, 1].map((side) => {
      const c = makeChain(engine, { type: def.type, seconds: def.seconds + side * 0.83, filters: def.filters, seed: 3000 + bi * 17 + side * 5 });
      c.out.gain.value = 0;
      c.connect(merger, 0, side);
      return { c, w: new Wander(def.wf * (side ? 1.19 : 0.85)) };
    });
    return { def, sides };
  });

  const shared = new Wander(0.06);
  const speed = new Smooth(0), lean = new Smooth(0);
  let acc = 0, healT = 0;

  return {
    name: 'wind',
    out,
    update(dt, now, env) {
      healT += dt;
      if (healT > 1) { healT = 0; for (const b of bands) for (const s of b.sides) s.c.heal(); }
      acc += dt;
      if (acc < 0.08) return;
      const step = acc; acc = 0;

      const sp = speed.step(clamp(env.speed, 0, V_MAX + 5), step, 0.35);
      const sN = clamp(sp / V_MAX, 0, 1.3);
      const ln = lean.step(clamp(env.lean / 0.45, -1, 1), step, 0.3);
      const fjord = env.scene === 'fjord';
      const canopy = env.canopy;
      // rest-level of the breeze: strong on open ground, weak in the forest
      const base = fjord ? 1.0 : 0.8 * (1 - 0.6 * canopy);
      const gsh = shared.step(step);
      const tc = 0.14;

      for (const b of bands) {
        const d = b.def;
        // speed adds dB (per-band), canopy removes the bright bands first
        // inside a tunnel the wind is muffled and smaller; on exit it rushes back with a bright burst
        const tun = env.tunnel, pulse = env.tunnelExit;
        let lvl = base * db(d.sp * sN) * (1 - 0.4 * tun) * (1 + 0.5 * pulse);
        if (d.name === 'high') lvl *= (1 - 0.85 * canopy) * (1 - 0.92 * tun) * (1 + 0.8 * pulse);
        else if (d.name === 'whistle') lvl *= (1 - tun) * ((1 - 0.95 * canopy) * clamp((sN - 0.15) * 1.6, 0, 1.2) + 0.15 * (1 - canopy) * (fjord ? 1 : 0));
        else if (d.name === 'mid') lvl *= 1 - 0.5 * canopy;
        b.sides.forEach((sd, side) => {
          const x = sd.w.step(step) + 0.3 * gsh;
          const m = Math.max(0.12, 1 + d.gust * x * 1.5);
          // lean: outside-of-turn ear gets more wind (lean>0 = leaning right => left ear louder)
          const pan = (side === 0 ? 1 : -1) * 0.28 * ln;
          const gTarget = d.g0 * lvl * m * (1 + pan);
          sd.c.out.gain.setTargetAtTime(gTarget, now, tc);
          sd.c.setLevel(d.g0 * lvl, step); // idle out of the graph when silent (e.g. whistle at rest)
        });
      }
    },
    dispose() {
      for (const b of bands) for (const s of b.sides) s.c.stop();
      out.dispose();
    },
  };
}

