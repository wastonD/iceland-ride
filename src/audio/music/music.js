// Quiet generative background music (original, all synthesis).
// Soft felt piano, an occasional dark nylon pluck or glass chime, a barely audible breath of air.
// Very sparse: short phrases of 2-5 notes separated by long silences, slow open harmony,
// mid/high register, almost no bass. Riding speed changes almost nothing (a little more often,
// a little brighter, never louder); rain makes it sparser and quieter.
//
//   createMusicLayer(engine, getRide) -> { name:'music', out, update(dt, now, env, ahead), dispose(), setEnabled(on), info }
//
// Composition logic: quiet.js (pure, node-testable). Sound: felt.js / ks.js.
import { createQuiet, smoothstep } from './quiet.js';
import { createFelt } from './felt.js';

export const MUSIC_TRIM = 1.9;  // (+6 dB so the sparse notes stay audible over wind) layer trim: tune overall music loudness here (state.vol.music is the user fader)

export function createMusicLayer(engine, getRide) {
  const out = engine.makeLayer('music', MUSIC_TRIM);
  const inst = createFelt(engine, out);
  const comp = createQuiet();
  const rnd = Math.random;

  let energy = 0;          // smoothed 0..1, very slow
  let tNext = 0;           // AudioContext time of the next gesture
  let started = false;
  let enabled = true;
  let duckTarget = 1;
  let scene = 'rainforest';
  const pending = [];      // { t, fn } sorted by time
  const info = { key: comp.keyPc, energy: 0, chord: null, notes: 0, events: 0 }; // events = every sounding piano/pluck/chime onset scheduled

  const enqueue = (t, fn) => {
    let i = pending.length;
    while (i > 0 && pending[i - 1].t > t) i--;
    pending.splice(i, 0, { t, fn });
  };

  function schedule(t0, rain) {
    const g = comp.next({ energy, rain, scene });
    const t = t0 + g.dt;
    if (g.chord) {
      info.chord = g.chord.name;
      if (comp.wantsDyad()) {
        const [a, b] = g.chord.low;
        info.events += 2;
        enqueue(t - 1.4, (tt) => inst.piano(tt, a, 0.18 + 0.06 * rnd(), -0.15));
        enqueue(t - 0.9, (tt) => inst.piano(tt, b, 0.15 + 0.06 * rnd(), -0.05));
      }
      if (comp.wantsAir(scene)) {
        const root = 60 + ((((g.chord.low[0] - 60) % 12) + 12) % 12);   // octave 4 (60..71), never higher
        enqueue(t - 3, (tt) => inst.air(tt, [root, root + 7], 14));
      }
    }
    for (const n of g.notes) {
      const tn = t + n.dt + (rnd() - 0.5) * 0.03;
      const pan = Math.max(-0.35, Math.min(0.35, (n.midi - 72) / 50 + (rnd() - 0.5) * 0.2));
      info.notes++; info.events++;
      if (n.kind === 'pluck') {
        inst.prewarm([n.midi]);
        enqueue(tn, (tt) => inst.pluck(tt, n.midi, n.vel, pan));
      } else if (n.kind === 'chime') enqueue(tn, (tt) => inst.chime(tt, n.midi, n.vel, pan));
      else enqueue(tn, (tt) => inst.piano(tt, n.midi, n.vel, pan));
    }
    return t;
  }

  return {
    name: 'music',
    out,
    info,

    setEnabled(on) {
      enabled = !!on;
      inst.setEnabled(enabled);
      if (!enabled) pending.length = 0;
    },

    update(dt, now, env, ahead) {
      // ---- energy follows speed with a very slow glide (~9 s); the musical effect is tiny anyway
      const ride = getRide && getRide();
      const speed = ride && Number.isFinite(ride.speed) ? ride.speed : 0;
      const target = smoothstep(1, 14, speed);
      energy += (target - energy) * (1 - Math.exp(-dt / 9));
      info.energy = energy;
      inst.setEnergy(energy);

      const rain = env && Number.isFinite(env.rain) ? env.rain : 0;
      if (env && env.scene) scene = env.scene === 'fjord' ? 'fjord' : 'rainforest';
      const duck = 1 - 0.3 * rain;
      if (Math.abs(duck - duckTarget) > 0.02) { duckTarget = duck; inst.setDuck(duck); }

      inst.pump(1);
      if (!enabled) return;

      // ---- catch up after a suspended / throttled context
      if (!started || tNext < now - 2) {
        started = true;
        pending.length = 0;
        tNext = now + 1.5 + rnd() * 2;   // first gesture a moment after start
      }
      let guard = 0;
      while (tNext < now + ahead + 3 && guard++ < 4) tNext = schedule(tNext, rain);
      guard = 0;
      while (pending.length && pending[0].t < now + ahead && guard++ < 24) {
        const ev = pending.shift();
        ev.fn(Math.max(ev.t, now + 0.005));
      }
    },

    dispose() {
      pending.length = 0;
      inst.dispose();
      out.dispose();
    },
  };
}
