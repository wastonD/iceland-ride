// 'insects' layer = living things.
//   rainforest: soft insect bed + cricket trills + frogs (more at night / near water, less in rain)
//   fjord:      sparse golden-plover whistles, snow-bunting phrases, gulls near the sea,
//               Icelandic horses (whinny, snort) and sheep (bleat) in the pasture
// Everything is synthesised (oscillators + pulse envelopes) and routed through the shared
// distance/pan/reverb voice stage.
import { makeChain } from './chains.js';
import { createPoisson } from './engine.js';
import { createVoices, clamp } from './voice.js';
import { Wander, Smooth, rnd, sstep } from './util.js';

const TRIM = 1.6;

/** Apply n short pulses (attack/decay) to a gain param, starting at t. */
function pulses(g, t, n, period, peak, atk, dec, decay = 1) {
  const p = g.gain;
  p.setValueAtTime(0.0001, t);
  for (let k = 0; k < n; k++) {
    const tk = t + k * period, pk = peak * Math.pow(decay, k);
    p.setValueAtTime(0.0001, tk);
    p.linearRampToValueAtTime(Math.max(0.0002, pk), tk + atk);
    p.exponentialRampToValueAtTime(0.0002, tk + atk + dec);
  }
}

export function createFaunaLayer(engine) {
  const { ac } = engine;
  const out = engine.makeLayer('insects', TRIM);
  const { voice, canSpawn } = createVoices(engine, out, 24);
  let envRef = { rain: 0, scene: 'rainforest', tod: 'day', water: 0, sea: 0, speed: 0 };

  /* ---- continuous insect bed (rainforest): band-limited noise, ~40 Hz buzz AM ---- */
  const merger = ac.createChannelMerger(2);
  merger.connect(out.dry);
  const chains = [];
  const lfoA = ac.createOscillator(); lfoA.frequency.value = 41; lfoA.start();
  const lfoB = ac.createOscillator(); lfoB.frequency.value = 23; lfoB.start();
  const dA = ac.createGain(); dA.gain.value = 0.55; lfoA.connect(dA);
  const dB = ac.createGain(); dB.gain.value = 0.7; lfoB.connect(dB);
  const bed = [0, 1].map((side) => {
    const mk = (spec, depth, band) => {
      const c = makeChain(engine, spec); chains.push(c);
      const am = ac.createGain(); am.gain.value = 1; depth.connect(am.gain);
      const g = ac.createGain(); g.gain.value = 0;
      c.connect(am); am.connect(g); g.connect(merger, 0, side);
      return { g, c, w: new Wander(band) };
    };
    return [
      mk({ type: 'pink', seconds: 5.1 + side * 0.7, filters: [{ type: 'bandpass', f: 5300, q: 5 }], seed: 5200 + side }, dA, 0.09),
      mk({ type: 'pink', seconds: 6.3 + side * 0.9, filters: [{ type: 'bandpass', f: 3400, q: 6 }], seed: 5210 + side }, dB, 0.06),
    ];
  });

  /* ---- events ---- */
  function trill(t, amp) { // cricket-like trill: sine pulses
    if (!canSpawn()) return;
    const n = 3 + ((rnd() * 5) | 0), per = 0.04 + rnd() * 0.03;
    const dur = n * per + 0.1;
    const dn = 0.15 + rnd() * 0.7;
    const v = voice(t, dur, dn, rnd() * 2 - 1);
    const o = v.osc('sine');
    o.frequency.value = 3600 + rnd() * 1800;
    const g = v.node(ac.createGain()); g.gain.value = 0.0001; o.connect(g); g.connect(v.input);
    pulses(g, t, n, per, amp * 0.5, 0.006, 0.02);
    v.seal();
  }
  function frog(t, amp) {
    if (!canSpawn()) return;
    const groups = 1 + ((rnd() * 2) | 0), dn = 0.2 + rnd() * 0.6;
    const f0 = 170 + rnd() * 150;
    const dur = groups * 0.34 + 0.15;
    const v = voice(t, dur, dn, rnd() * 2 - 1);
    const o = v.osc('sawtooth'); o.frequency.value = f0;
    const bp = v.filter('bandpass', 520 + rnd() * 300, 2.2);
    const g = v.node(ac.createGain()); g.gain.value = 0.0001;
    o.connect(bp); bp.connect(g); g.connect(v.input);
    for (let k = 0; k < groups; k++) pulses(g, t + k * 0.34, 9, 0.028, amp * 0.9, 0.006, 0.02, 0.985);
    o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * 1.25, t + dur);
    v.seal();
  }
  function plover(t, amp) { // golden plover: mournful falling whistle, sometimes a second lower note
    if (!canSpawn()) return;
    const f0 = 2500 + rnd() * 400, dn = 0.35 + rnd() * 0.5;
    const two = rnd() < 0.7;
    const dur = 0.62 + (two ? 0.45 : 0) + 0.1;
    const v = voice(t, dur, dn, rnd() * 2 - 1, { wet: 1.2 });
    const o = v.osc('sine');
    o.frequency.setValueAtTime(f0 * 0.97, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.06, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.86, t + 0.55);
    const vib = v.osc('sine'); vib.frequency.value = 6 + rnd() * 2;
    const vg = v.node(ac.createGain()); vg.gain.value = f0 * 0.012; vib.connect(vg); vg.connect(o.frequency);
    const g = v.node(ac.createGain()); g.gain.value = 0.0001; o.connect(g); g.connect(v.input);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(amp * 0.5, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0002, t + 0.58);
    if (two) {
      const t2 = t + 0.62;
      o.frequency.setValueAtTime(f0 * 0.74, t2);
      o.frequency.linearRampToValueAtTime(f0 * 0.68, t2 + 0.3);
      g.gain.setValueAtTime(0.0001, t2); g.gain.linearRampToValueAtTime(amp * 0.4, t2 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0002, t2 + 0.34);
    }
    v.seal();
  }
  function bunting(t, amp) { // snow bunting: a quick tinkling phrase of short chirps
    if (!canSpawn()) return;
    const n = 6 + ((rnd() * 6) | 0), per = 0.07 + rnd() * 0.03, dn = 0.3 + rnd() * 0.5;
    const dur = n * per + 0.15;
    const v = voice(t, dur, dn, rnd() * 2 - 1);
    const o = v.osc('sine');
    const g = v.node(ac.createGain()); g.gain.value = 0.0001; o.connect(g); g.connect(v.input);
    let f = 3800 + rnd() * 700;
    for (let k = 0; k < n; k++) {
      const tk = t + k * per;
      f = clamp(f + (rnd() - 0.5) * 900, 3000, 5200);
      o.frequency.setValueAtTime(f, tk);
      o.frequency.linearRampToValueAtTime(f * (0.9 + rnd() * 0.25), tk + 0.045);
    }
    pulses(g, t, n, per, amp * 0.32, 0.006, 0.04, 0.97);
    v.seal();
  }
  function gull(t, amp) { // herring-gull-ish "keeow" calls
    if (!canSpawn()) return;
    const calls = 2 + ((rnd() * 3) | 0), gap = 0.55 + rnd() * 0.2, dn = 0.3 + rnd() * 0.5;
    const dur = calls * gap + 0.9;
    const v = voice(t, dur, dn, rnd() * 2 - 1, { wet: 1.3 });
    const o = v.osc('sawtooth');
    const vib = v.osc('sine'); vib.frequency.value = 13;
    const vg = v.node(ac.createGain()); vg.gain.value = 40; vib.connect(vg); vg.connect(o.frequency);
    const bp = v.filter('bandpass', 1700, 1.6);
    const lp = v.filter('lowpass', 4200, 0.6);
    const g = v.node(ac.createGain()); g.gain.value = 0.0001;
    o.connect(bp); bp.connect(lp); lp.connect(g); g.connect(v.input);
    const f0 = 750 + rnd() * 150;
    for (let k = 0; k < calls; k++) {
      const tk = t + k * gap, a = amp * 0.6 * (1 - 0.15 * k);
      o.frequency.setValueAtTime(f0 * 0.8, tk);
      o.frequency.linearRampToValueAtTime(f0 * 1.45, tk + 0.12);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.95, tk + 0.6);
      g.gain.setValueAtTime(0.0001, tk);
      g.gain.linearRampToValueAtTime(a, tk + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0002, tk + 0.62);
    }
    v.seal();
  }

  function whinny(t, amp) { // Icelandic horse: rising squeal, held with flutter, falling off
    if (!canSpawn()) return;
    const dur = 1.5, dn = 0.25 + rnd() * 0.55, f0 = 430 + rnd() * 120;
    const v = voice(t, dur, dn, rnd() * 2 - 1, { wet: 1.1 });
    const o = v.osc('sawtooth');
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.1, t + 0.35);
    o.frequency.setValueAtTime(f0 * 2.05, t + 0.5);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 1.3);
    const vib = v.osc('sine'); vib.frequency.value = 26; const vg = v.node(ac.createGain()); vg.gain.value = f0 * 0.09; vib.connect(vg); vg.connect(o.frequency);
    const f1 = v.filter('bandpass', 1250, 2.5), f2 = v.filter('bandpass', 2700, 3);
    const g = v.node(ac.createGain()); g.gain.value = 0.0001;
    o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g); g.connect(v.input);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(amp * 1.0, t + 0.08);
    g.gain.setValueAtTime(amp * 0.9, t + 0.7); g.gain.exponentialRampToValueAtTime(0.0002, t + 1.4);
    v.seal();
  }
  function snort(t, amp) { // horse snort: two puffs of breathy noise
    if (!canSpawn()) return;
    const v = voice(t, 0.7, 0.15 + rnd() * 0.4, rnd() * 2 - 1, { wet: 0.7 });
    const bp = v.filter('bandpass', 650 + rnd() * 300, 1.1);
    v.noiseSrc(engine.noise.pink).connect(bp);
    const g = v.node(ac.createGain()); g.gain.value = 0.0001; bp.connect(g); g.connect(v.input);
    pulses(g, t, 2, 0.24, amp * 1.6, 0.03, 0.16, 0.7);
    v.seal();
  }
  function bleat(t, amp) { // sheep: nasal "mäh" with fast flutter
    if (!canSpawn()) return;
    const n = rnd() < 0.35 ? 2 : 1, dn = 0.25 + rnd() * 0.55, f0 = (rnd() < 0.25 ? 520 : 340) + rnd() * 60;
    const v = voice(t, n * 0.85 + 0.2, dn, rnd() * 2 - 1, { wet: 1.0 });
    const o = v.osc('sawtooth');
    const vib = v.osc('sine'); vib.frequency.value = 27 + rnd() * 6; const vg = v.node(ac.createGain()); vg.gain.value = f0 * 0.14; vib.connect(vg); vg.connect(o.frequency);
    const f1 = v.filter('bandpass', 850, 4), f2 = v.filter('bandpass', 1750, 4), f3 = v.filter('bandpass', 2900, 3);
    const g = v.node(ac.createGain()); g.gain.value = 0.0001;
    for (const f of [f1, f2, f3]) { o.connect(f); f.connect(g); }
    g.connect(v.input);
    for (let k = 0; k < n; k++) {
      const tk = t + k * 0.8;
      o.frequency.setValueAtTime(f0 * 1.15, tk); o.frequency.linearRampToValueAtTime(f0 * 0.9, tk + 0.55);
      g.gain.setValueAtTime(0.0001, tk); g.gain.linearRampToValueAtTime(amp * 0.9, tk + 0.06);
      g.gain.setValueAtTime(amp * 0.8, tk + 0.4); g.gain.exponentialRampToValueAtTime(0.0002, tk + 0.62);
    }
    v.seal();
  }

  let pasture = 0; // 0..1 proximity to the pasture rectangle (fjord)
  const tod = (e, night, dusk, day) => (e.tod === 'night' ? night : e.tod === 'dusk' ? dusk : day);
  const quiet = (e) => 1 - 0.85 * e.rain;
  const amp = () => 0.5 + 0.5 * rnd();
  const P = {
    trill: createPoisson(() => (envRef.scene === 'fjord' ? 0 : tod(envRef, 1.4, 0.7, 0.18) * quiet(envRef)), (t) => trill(t, amp())),
    frog: createPoisson(() => (envRef.scene === 'fjord' ? 0 : tod(envRef, 0.3, 0.16, 0.03) * (0.3 + 1.6 * envRef.water) * (1 - 0.4 * envRef.rain)), (t) => frog(t, amp())),
    plover: createPoisson(() => (envRef.scene !== 'fjord' ? 0 : tod(envRef, 0.005, 0.03, 0.07) * quiet(envRef) / (1 + envRef.speed / 12)), (t) => plover(t, amp())),
    bunting: createPoisson(() => (envRef.scene !== 'fjord' ? 0 : tod(envRef, 0.005, 0.03, 0.08) * quiet(envRef) / (1 + envRef.speed / 12)), (t) => bunting(t, amp())),
    sheep: createPoisson(() => (envRef.scene !== 'fjord' ? 0 : 0.16 * pasture * (1 - 0.6 * envRef.rain) * tod(envRef, 0.1, 0.5, 1)), (t) => bleat(t, amp())),
    horse: createPoisson(() => (envRef.scene !== 'fjord' ? 0 : 0.045 * pasture * (1 - 0.6 * envRef.rain) * tod(envRef, 0.1, 0.5, 1)), (t) => whinny(t, amp())),
    snort: createPoisson(() => (envRef.scene !== 'fjord' ? 0 : 0.08 * pasture * tod(envRef, 0.1, 0.5, 1)), (t) => snort(t, amp())),
    gull: createPoisson(() => (envRef.scene !== 'fjord' ? 0 : (0.02 + 0.13 * sstep(600, 850, envRef.z ?? 0)) * (1 - 0.6 * envRef.rain) * tod(envRef, 0.2, 0.7, 1)), (t) => gull(t, amp())),
  };

  const bedLvl = new Smooth(0);
  let acc = 0, healT = 0;
  return {
    name: 'insects',
    out,
    /** debug / gameplay: trigger one call by name */
    trigger(kind) { const t = ac.currentTime + 0.02; ({ trill, frog, plover, bunting, gull, whinny, snort, bleat }[kind] || trill)(t, 0.8); },
    update(dt, now, env, ahead) {
      envRef = env;
      const pa = env.world?.features?.pasture;
      if (pa && env.scene === 'fjord') {
        const dx = Math.max(pa.x0 - env.x, 0, env.x - pa.x1), dz = Math.max(pa.z0 - env.z, 0, env.z - pa.z1);
        pasture = 1 - sstep(0, 260, Math.hypot(dx, dz));
      } else pasture = 0;
      for (const p of Object.values(P)) p.tick(now, ahead);
      healT += dt;
      if (healT > 1) { healT = 0; for (const c of chains) c.heal(); }
      acc += dt;
      if (acc < 0.1) return;
      const step = acc; acc = 0;
      const rain = env.rain;
      const target = env.scene === 'fjord' ? 0 : tod(env, 0.5, 0.32, 0.1) * (1 - 0.75 * rain) * (1 - 0.3 * env.canopy * 0);
      const lv = bedLvl.step(target, step, 1.0);
      bed.forEach((pair, side) => pair.forEach((b, i) => {
        const x = b.w.step(step);
        b.g.gain.setTargetAtTime(lv * (i ? 0.5 : 0.7) * Math.max(0.15, 1 + 0.45 * x * 1.6) * (side ? 1 : 0.92), now, 0.2);
        b.c.setLevel(lv, step);
      }));
    },
    dispose() {
      for (const c of chains) c.stop();
      for (const o of [lfoA, lfoB]) { try { o.stop(); } catch (e) { /* */ } }
      out.dispose();
    },
  };
}
