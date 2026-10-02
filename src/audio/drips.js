// Drip layer: discrete water-drop events on three surfaces (leaf / water / wood),
// scheduled ahead of the audio clock. Surface mix follows the listener's
// surroundings (env.canopy, env.water, env.wood); event rate follows rain.
import { createPoisson } from './engine.js';
import { createVoices, clamp } from './voice.js';

const TRIM = 1.0;
const MAX_ACTIVE = 36;
const rnd = Math.random;

export function createDripsLayer(engine) {
  const { noise } = engine;
  const out = engine.makeLayer('drips', TRIM);
  const { voice, canSpawn } = createVoices(engine, out, MAX_ACTIVE);
  const ac = engine.ac;
  let envRef = { rain: 0.5, canopy: 0.3, water: 0, wood: 0, scene: 'rainforest', speed: 0, surface: 'asphalt' };

  /* ---- 打叶子: soft, low-Q broadband leaf pats (no ringing "ting"; centres mostly 400-2500 Hz) ---- */
  function leaf(t, amp, dn, pan, second = false) {
    const size = rnd();
    const dec = 0.025 + 0.05 * size;
    const v = voice(t, dec + 0.1, dn, pan, { wet: 1.5 });
    const f = 400 * Math.pow(6.2, Math.pow(rnd(), 1.3)) * (1 - 0.25 * size); // ~400..2500, skewed low
    const bp = v.filter('bandpass', f, 0.5 + rnd() * 0.9);
    v.noiseSrc(rnd() < 0.5 ? noise.pink : noise.white).connect(bp);
    bp.connect(v.gain(0.003, amp * 2.8, dec));
    // dull body of the leaf: low-passed noise, not a pitched sine
    const lp = v.filter('lowpass', 500 + rnd() * 400, 0.6);
    v.noiseSrc(noise.pink).connect(lp);
    lp.connect(v.gain(0.004, amp * 1.6, dec * 1.2));
    v.seal();
    if (!second && rnd() < 0.35) leaf(t + 0.04 + rnd() * 0.07, amp * (0.35 + rnd() * 0.3), dn, pan, true);
  }

  /* ---- 落水面: soft "plip" (only very near water); no pitch glide ---- */
  function water(t, amp, dn, pan) {
    const dec = 0.05 + rnd() * 0.05;
    const v = voice(t, dec + 0.12, dn, pan, { wet: 1.2 });
    const bp = v.filter('bandpass', 500 + rnd() * 1200, 0.9);
    v.noiseSrc(noise.pink).connect(bp);
    bp.connect(v.gain(0.004, amp * 1.8, dec));
    const o = v.osc('sine'); // a whisper of body, short, no glide
    o.frequency.value = 300 + rnd() * 400;
    o.connect(v.gain(0.004, amp * 0.12, 0.04));
    v.seal();
  }

  /* ---- 打木头: dull thud, low-Q knock ---- */
  function wood(t, amp, dn, pan) {
    const dec = 0.08 + rnd() * 0.1;
    const v = voice(t, dec + 0.08, dn, pan);
    const f = 90 + rnd() * 110;
    const o = v.osc('triangle');
    o.frequency.setValueAtTime(f * 1.15, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    o.connect(v.gain(0.003, amp * 0.5, dec));
    const knock = v.filter('bandpass', 300 + rnd() * 500, 2.2);
    v.noiseSrc(noise.pink).connect(knock);
    knock.connect(v.gain(0.002, amp * 2.6, 0.07));
    v.seal();
  }

  /* ---- open air (fjord): rain on asphalt / grass / the rider's jacket ---- */
  function asphalt(t, amp, dn, pan) {
    const dec = 0.012 + 0.02 * rnd();
    const v = voice(t, dec + 0.08, dn, pan, { wet: 0.5 });
    const bp = v.filter('bandpass', 1500 * Math.pow(3.7, rnd()), 0.7 + rnd() * 0.8); // ~1.5..5.5 kHz, low Q
    v.noiseSrc(noise.white).connect(bp);
    bp.connect(v.gain(0.001, amp * 2.6, dec));
    v.seal();
  }
  function grass(t, amp, dn, pan) {
    const dec = 0.03 + 0.05 * rnd();
    const v = voice(t, dec + 0.08, dn, pan, { wet: 0.7 });
    const bp = v.filter('bandpass', 700 + rnd() * 1800, 0.9);
    v.noiseSrc(noise.pink).connect(bp);
    bp.connect(v.gain(0.004, amp * 2.4, dec));
    v.seal();
  }
  function jacket(t, amp, dn, pan) { // close, dry, dull "pup" on fabric / helmet
    const dec = 0.02 + 0.02 * rnd();
    const v = voice(t, dec + 0.08, 0.02, pan * 0.6, { wet: 0.15 });
    const o = v.osc('sine');
    const f0 = 130 + rnd() * 200;
    o.frequency.setValueAtTime(f0 * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.015);
    o.connect(v.gain(0.001, amp * 0.5, dec + 0.02));
    const bp = v.filter('bandpass', 500 + rnd() * 1200, 1.2);
    v.noiseSrc(noise.pink).connect(bp);
    bp.connect(v.gain(0.001, amp * 1.6, dec));
    v.seal();
  }

  function fire(t) {
    if (!canSpawn()) return;
    const e = envRef;
    // distance: mostly near, a tail of far events that get more reverb
    const d = 0.6 + 24 * Math.pow(rnd(), 2);
    const dn = clamp(d / 25, 0, 1);
    const pan = (rnd() * 2 - 1) * (0.95 - 0.35 * dn);
    const amp = (0.3 + 0.7 * Math.pow(rnd(), 1.5)) * (0.7 + 0.5 * e.rain) / (1 + 0.2 * d);
    if (e.scene === 'fjord') {
      const wA = e.surface === 'asphalt' ? 0.55 : 0.2, wG = e.surface === 'asphalt' ? 0.25 : 0.55;
      const wJ = 0.22 * (0.5 + Math.min(1, e.speed / 10));
      const wW = 0.02 + 1.2 * Math.pow(e.water, 3);
      let pick = rnd() * (wA + wG + wJ + wW) * 1;
      if ((pick -= wA) < 0) asphalt(t, amp, dn, pan);
      else if ((pick -= wG) < 0) grass(t, amp, dn, pan);
      else if ((pick -= wJ) < 0) jacket(t, amp * 0.9, 0, pan);
      else water(t, amp * 1.1, dn, pan);
      return;
    }
    const wl = 0.15 + 0.9 * e.canopy;
    // water plips only within ~5 m of water and stay sparse
    const near = e.waterDist != null ? clamp((5 - e.waterDist) / 5, 0, 1) : 0;
    const ww = 0.01 + 0.9 * Math.pow(near, 1.2);
    const wd = 0.04 + 0.28 * e.canopy + 0.6 * e.wood;
    let pick = rnd() * (wl + ww + wd);
    if ((pick -= wl) < 0) leaf(t, amp, dn, pan);
    else if ((pick -= ww) < 0) water(t, amp * 1.15, dn, pan);
    else wood(t, amp, dn, pan);
  }

  const poisson = createPoisson(() => {
    const e = envRef;
    const base = 0.6 + 7.5 * Math.pow(e.rain, 1.1);
    if (e.scene === 'fjord') return Math.min(14, base * 0.85 * (1 + 0.5 * e.water) * (1 + 0.3 * Math.min(1, e.speed / 12)));
    const mult = (0.55 + 0.9 * e.canopy) * (1 + 0.5 * clamp((5 - (e.waterDist ?? 99)) / 5, 0, 1));
    return Math.min(16, base * mult);
  }, fire);

  return {
    name: 'drips',
    out,
    update(dt, now, env, ahead) {
      envRef = env;
      poisson.tick(now, ahead);
    },
    /** Trigger a single drip of the given surface right now (debug / gameplay hooks). */
    trigger(kind, dn = 0.1, pan = 0) {
      const t = ac.currentTime + 0.01, amp = 0.8;
      ({ leaf, water, wood, asphalt, grass, jacket }[kind] || leaf)(t, amp, dn, pan);
    },
    dispose() { out.dispose(); },
  };
}
