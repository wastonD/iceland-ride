// Electric longboard layer: wheel roll (soft low "呼——" rumble + a whisper of fine road grain),
// joint / pebble / bridge clicks, brake scuff, urethane slide (only when the board really
// slides sideways: env.slip), wobble knocks, landing, tumble (body thud, jacket slide, board
// clatter), get-up steps and footsteps for walk mode. Silent when stopped.
//
// Real polyurethane wheels on asphalt are a low, soft, continuous rolling sound (80-400 Hz,
// a little fine grain), NOT hiss: everything above ~2 kHz is kept very quiet on purpose.
// Continuous parts (all volume ~ speed^1.15, monotone; brightness grows with speed by
// cross-fading fixed low-passed bands, since biquads must not be automated):
//   roll-low   brown noise LP 260 Hz, playbackRate follows speed, gentle wheel-rotation AM
//   roll-mid   pink noise band 150-700 Hz ("body"), fades in with speed = pitch feels higher
//   hum        two sine oscillators, f ~ speed (very quiet)
//   tex        impact beds low-passed at ~1.8-2.4 kHz (asphalt = fine; gravel = coarser)
//   dirt       dull low thumps
// Surface changes cross-fade the component weights; leaning adds a little grit.
import { makeChain, Gate } from './chains.js';
import { makeImpactBed } from './buffers.js';
import { createPoisson } from './engine.js';
import { createVoices } from './voice.js';
import { createLoop } from './loops.js';
import { Smooth, clamp, rnd } from './util.js';

const TRIM = 1.0;
const V_REF = 15;

// per-surface weights: low, mid, hum, texAsphalt, texGravel, dirt
const SURF = {
  asphalt: [1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
  gravel: [1.1, 0.8, 0.5, 0.3, 1.0, 0.0],
  dirt: [1.1, 0.3, 0.25, 0.1, 0.25, 1.0],
};
const AMP = { low: 0.34, mid: 0.17, hum: 0.021, texA: 0.36, texG: 0.47, dirt: 0.38, brake: 0.2, skid: 0.44, slide: 0.9 };
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function createBoardLayer(engine) {
  const { ac } = engine;
  const out = engine.makeLayer('board', TRIM);
  const { voice, canSpawn } = createVoices(engine, out, 30);
  const master = ac.createGain(); master.gain.value = 0;
  const mpan = ac.createStereoPanner(); // board flies off to one side when the rider falls
  master.connect(mpan); mpan.connect(out.dry);
  const send = ac.createGain(); send.gain.value = 0.05; mpan.connect(send); send.connect(out.wet);

  // wheel-rotation AM (frequency follows speed)
  const lfo = ac.createOscillator(); lfo.frequency.value = 8; lfo.start();
  const depthLow = ac.createGain(); depthLow.gain.value = 0.14;
  const depthMid = ac.createGain(); depthMid.gain.value = 0.1;
  lfo.connect(depthLow); lfo.connect(depthMid);
  const lfoSlow = ac.createOscillator(); lfoSlow.frequency.value = 3; lfoSlow.type = 'triangle'; lfoSlow.start();
  const depthDirt = ac.createGain(); depthDirt.gain.value = 0.7; lfoSlow.connect(depthDirt);

  const chains = [];
  const part = (spec, depth) => {
    const c = makeChain(engine, spec); chains.push(c);
    const am = ac.createGain(); am.gain.value = 1;
    if (depth) depth.connect(am.gain);
    const g = ac.createGain(); g.gain.value = 0;
    c.connect(am); am.connect(g); g.connect(master);
    return { c, g };
  };
  const low = part({ type: 'brown', seconds: 4.9, filters: [{ type: 'highpass', f: 65, q: 0.6 }, { type: 'lowpass', f: 260, q: 0.6 }] }, depthLow);
  const mid = part({ type: 'pink', seconds: 5.7, filters: [{ type: 'highpass', f: 150, q: 0.6 }, { type: 'lowpass', f: 700, q: 0.6 }, { type: 'lowpass', f: 900, q: 0.5 }] }, depthMid);
  const dirt = part({ type: 'pink', seconds: 6.3, filters: [{ type: 'lowpass', f: 230, q: 0.7 }] }, depthDirt);
  // foot brake: shoe sole scuffing the road, a soft "嚓——" mostly 500-1800 Hz
  const brake = part({ type: 'pink', seconds: 4.3, filters: [{ type: 'highpass', f: 450, q: 0.6 }, { type: 'lowpass', f: 1900, q: 0.6 }, { type: 'lowpass', f: 2400, q: 0.5 }] }, null);

  // fall: jacket sliding on asphalt ("沙沙")
  const slide = part({ type: 'pink', seconds: 5.5, filters: [{ type: 'highpass', f: 500, q: 0.6 }, { type: 'bandpass', f: 1900, q: 0.55 }] }, null);
  // urethane wheels sliding sideways: broad, low-ish "嘶——" (1.5-3 kHz) with slight chatter
  const chat = ac.createOscillator(); chat.frequency.value = 27; chat.start();
  const depthSkid = ac.createGain(); depthSkid.gain.value = 0.22; chat.connect(depthSkid);
  const skid = part({ type: 'pink', seconds: 4.1, filters: [{ type: 'highpass', f: 700, q: 0.6 }, { type: 'bandpass', f: 1900, q: 0.45 }, { type: 'lowpass', f: 3200, q: 0.6 }] }, depthSkid);
  const skidLow = part({ type: 'pink', seconds: 5.9, filters: [{ type: 'bandpass', f: 520, q: 0.7 }] }, depthSkid); // scrubbing body under the hiss

  // hum: two slightly detuned sines through a lowpass
  const humG = ac.createGain(); humG.gain.value = 0;
  const humLp = ac.createBiquadFilter(); humLp.type = 'lowpass'; humLp.frequency.value = 450; humLp.Q.value = 0.5;
  const humOsc = [0, 1].map((i) => { const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = 80 * (i ? 2.01 : 1); o.connect(humLp); o.start(); return o; });
  const humGate = new Gate(humG); humGate.connect(master);
  humLp.connect(humG);

  // texture beds
  const bed = (gen, lpF) => { // impact bed -> gain -> fixed low-pass (nothing above lpF gets through)
    const src = createLoop(engine, makeImpactBed(ac, gen));
    const g = ac.createGain(); g.gain.value = 0; src.out.connect(g);
    const lp1 = ac.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = lpF; lp1.Q.value = 0.6;
    const lp2 = ac.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = lpF * 1.15; lp2.Q.value = 0.5;
    g.connect(lp1); lp1.connect(lp2);
    const gate = new Gate(lp2); gate.connect(master);
    return { src, g, gate };
  };
  const texA = bed({ seconds: 5.3, perSec: 1800, seed: 7101, fLo: 220, fHi: 1500, tauLo: 0.6, tauHi: 2.2, k: 0.45, noiseMix: 0.3, bodyProb: 0, spread: 0.5, hard: 0.1, rms: 0.1 }, 1800);
  const texG = bed({ seconds: 6.1, perSec: 520, seed: 7102, fLo: 300, fHi: 2600, tauLo: 0.6, tauHi: 2.5, k: 0.8, noiseMix: 0.4, bodyProb: 0.15, bodyAmp: 0.5, spread: 0.6, hard: 0.2, rms: 0.1 }, 2400);

  const sm = { v: new Smooth(0), lean: new Smooth(0), brake: new Smooth(0), air: new Smooth(1), w: SURF.asphalt.map((x) => new Smooth(x)) };
  let acc = 0, healT = 0;
  let envRef = { speed: 0, grounded: true, surface: 'asphalt', lean: 0 };
  const away = { v: 0, side: 0 }; // the board rolling off on its own after a fall

  /* ---- discrete events ---- */
  const clickV = (t, amp, kind, pan) => {
    if (!canSpawn()) return;
    if (kind === 'thump') { // dirt clod
      const v = voice(t, 0.18, 0.02, pan, { wet: 0.2 });
      const o = v.osc('sine'); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.05);
      o.connect(v.gain(0.003, amp * 0.9, 0.09));
      v.seal(); return;
    }
    if (kind === 'plank') { // hollow wooden bridge plank: "咚"
      const v = voice(t, 0.3, 0.04, pan, { wet: 0.5 });
      const f0 = 150 + rnd() * 90;
      const o = v.osc('sine'); o.frequency.setValueAtTime(f0 * 1.25, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.03);
      o.connect(v.gain(0.003, amp * 1.4, 0.16));
      const bp = v.filter('bandpass', 420 + rnd() * 200, 5);
      v.noiseSrc(engine.noise.pink).connect(bp); bp.connect(v.gain(0.001, amp * 3.5, 0.09));
      v.seal(); return;
    }
    if (kind === 'knock') { // loose trucks / wobble rattle
      const v = voice(t, 0.12, 0.03, pan, { wet: 0.3 });
      const bp = v.filter('bandpass', 450 + rnd() * 650, 2.5);
      v.noiseSrc().connect(bp); bp.connect(v.gain(0.001, amp * 2.6, 0.02));
      const o = v.osc('sine'); o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.04);
      o.connect(v.gain(0.001, amp * 0.6, 0.05));
      v.seal(); return;
    }
    const gravel = kind === 'pebble-g';
    const dec = gravel ? 0.014 + rnd() * 0.014 : 0.008 + rnd() * 0.012;
    const v = voice(t, dec + 0.1, 0.03, pan, { wet: 0.3 });
    const bp = v.filter('bandpass', gravel ? 800 + rnd() * 1600 : kind === 'joint' ? 350 + rnd() * 400 : 600 + rnd() * 1100, gravel ? 1.3 : 1.6);
    v.noiseSrc().connect(bp);
    bp.connect(v.gain(0.0008, amp * (kind === 'joint' ? 3.2 : gravel ? 2.2 : 1.3), dec));
    if (kind === 'joint') { // low "tk-dunk" body
      const o = v.osc('sine'); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(75, t + 0.04);
      o.connect(v.gain(0.002, amp * 0.5, 0.06));
    }
    v.seal();
  };
  const vf = (v) => Math.pow(clamp(v / V_REF, 0, 1.4), 0.9);
  const active = () => envRef.grounded && !envRef.fallen && envRef.speed > 0.6;
  const forestBridge = () => envRef.onBridge && envRef.scene !== 'fjord';
  const joints = createPoisson(() => {
    if (!active()) return 0;
    if (forestBridge()) return envRef.speed / 0.85;                 // plank seams
    if (envRef.onBridge) return envRef.speed / 2.3;                 // expansion joints, close together
    return envRef.surface === 'asphalt' ? envRef.speed / 4.6 : 0;
  }, (t) => {
    const s = envRef.speed, d = clamp(0.62 / Math.max(s, 1), 0.02, 0.15), p = (rnd() * 2 - 1) * 0.15;
    if (forestBridge()) {
      const a = (0.6 + 0.4 * rnd()) * vf(s);
      clickV(t, a, 'plank', p); clickV(t + d, a * 0.8, 'plank', p);
      return;
    }
    const a = (0.4 + 0.6 * rnd()) * vf(s) * (envRef.onBridge ? 1.8 : 1);
    clickV(t, a, 'joint', p); clickV(t + d, a * 0.85, 'joint', p); // front truck then rear truck
  });
  // trucks / wheels rattling when the board starts to shake
  const knocks = createPoisson(() => (envRef.grounded && !envRef.fallen && envRef.speed > 2 && envRef.wobble > 0.15 ? 3 + 11 * envRef.wobble : 0), (t) => {
    clickV(t, (0.25 + 0.5 * envRef.wobble) * (0.6 + 0.4 * rnd()), 'knock', (rnd() - 0.5) * 0.4);
  });
  const pebbles = createPoisson(() => {
    if (!active()) return 0;
    const s = envRef.speed;
    return envRef.surface === 'gravel' ? 3 + s * 2.6 : envRef.surface === 'dirt' ? 0.8 + s * 0.35 : 0.3 + s * 0.22;
  }, (t) => {
    const a = (0.25 + 0.75 * Math.pow(rnd(), 1.5)) * vf(envRef.speed), p = (rnd() * 2 - 1) * 0.3;
    clickV(t, a, envRef.surface === 'gravel' ? 'pebble-g' : envRef.surface === 'dirt' ? 'thump' : 'pebble', p);
  });

  function landHit(a) { // wheels/board hit the ground: "咚" + board "啪"
    if (!canSpawn()) return;
    const t = ac.currentTime + 0.005;
    const v = voice(t, 0.5, 0.02, 0, { wet: 0.35 });
    const o = v.osc('sine'); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    o.connect(v.gain(0.003, 1.5 * a, 0.28));
    const lp = v.filter('lowpass', 600, 0.7);
    v.noiseSrc(engine.noise.pink).connect(lp); lp.connect(v.gain(0.002, 1.8 * a, 0.16));
    const bp = v.filter('bandpass', 1300, 1.0);
    v.noiseSrc().connect(bp); bp.connect(v.gain(0.001, 1.6 * a, 0.045));
    v.seal();
    clickV(t + 0.09, 0.5 * a, 'joint', -0.1); clickV(t + 0.17, 0.3 * a, 'joint', 0.1); // wheels bounce
  }
  function bodyHit(t, a, pan) { // a person hitting the ground: dull, no voice
    const v = voice(t, 0.7, 0.02, pan, { wet: 0.25 });
    const o = v.osc('sine'); o.frequency.setValueAtTime(75, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    o.connect(v.gain(0.004, 2.0 * a, 0.35));
    const lp = v.filter('lowpass', 420, 0.8);
    v.noiseSrc(engine.noise.pink).connect(lp); lp.connect(v.gain(0.004, 2.6 * a, 0.28));
    const bp = v.filter('bandpass', 1100, 0.7); // jacket flap / gear rattle
    v.noiseSrc().connect(bp); bp.connect(v.gain(0.004, 0.9 * a, 0.12));
    v.seal();
  }
  function clang(t, a, pan) { // board tumbling on asphalt: "哐啷"
    if (!canSpawn()) return;
    const v = voice(t, 0.5, 0.05, pan, { wet: 0.5 });
    const f = 600 + rnd() * 900;
    const bp = v.filter('bandpass', f, 7);
    v.noiseSrc().connect(bp); bp.connect(v.gain(0.001, a * 5.5, 0.16));
    const o = v.osc('triangle'); o.frequency.setValueAtTime(f * 0.6, t); o.frequency.exponentialRampToValueAtTime(f * 0.4, t + 0.1);
    o.connect(v.gain(0.001, a * 0.7, 0.12));
    const lp = v.filter('lowpass', 500, 0.7);
    v.noiseSrc(engine.noise.pink).connect(lp); lp.connect(v.gain(0.001, a * 1.6, 0.07));
    v.seal();
  }
  function onEvent(name, rs, env) {
    if (name === 'land') landHit(clamp(Math.max(rs?.landing ?? env.landing ?? 0, 0.25), 0, 1));
    else if (name === 'takeoff') {
      if (!canSpawn()) return;
      const t = ac.currentTime + 0.005, v = voice(t, 0.15, 0.02, 0);
      const bp = v.filter('bandpass', 1400, 1.0); v.noiseSrc().connect(bp); bp.connect(v.gain(0.002, 0.45, 0.05)); v.seal();
    } else if (name === 'wobbleStart') {
      for (let i = 0; i < 3; i++) clickV(ac.currentTime + 0.01 + i * 0.07, 0.5 - i * 0.1, 'knock', (i % 2 ? 1 : -1) * 0.25);
    } else if (name === 'fall') {
      const v0 = rs?.speed ?? env.speed ?? 8, side = rs?.fall?.side ?? 1, k = clamp(0.45 + v0 / 14, 0.45, 1.3), t = ac.currentTime + 0.01;
      bodyHit(t, k, -side * 0.15);
      bodyHit(t + 0.22, 0.55 * k, -side * 0.2);
      [0.12, 0.38, 0.72, 1.2, 1.9, 2.7].forEach((dt, i) => clang(t + dt, k * Math.pow(0.72, i), side * (0.3 + 0.1 * i)));
      away.v = v0; away.side = side;
    } else if (name === 'getup') {
      footstep('asphalt', 0.1); footstep('asphalt', 0.5); footstep('asphalt', 0.95);
    }
  }

  /** Footstep for walk mode. surface: mud|leaf|wood|stone|water|asphalt|gravel|grass|dirt */
  function footstep(surface = 'mud', delay = 0) {
    if (!canSpawn()) return;
    const t = ac.currentTime + 0.005 + delay, pan = (rnd() * 2 - 1) * 0.12;
    const S = {
      mud: { thump: 0.6, f: [400, 0.8], dec: 0.13, lo: true, peak: 1.4, pink: true },
      leaf: { thump: 0.15, f: [3000, 0.9], dec: 0.16, crackle: 3, peak: 1.6 },
      wood: { thump: 0.7, f: [520, 6], dec: 0.09, peak: 3.2, pink: true },
      stone: { thump: 0.35, f: [1500, 2], dec: 0.05, peak: 2.6, ring: 1100 },
      water: { thump: 0.25, f: [1800, 0.7], dec: 0.24, peak: 1.6, splash: true },
      asphalt: { thump: 0.5, f: [1800, 1.2], dec: 0.05, peak: 1.6 },
      gravel: { thump: 0.25, f: [2300, 1.2], dec: 0.06, crackle: 5, peak: 1.8 },
      grass: { thump: 0.3, f: [1200, 0.8], dec: 0.14, peak: 1.0, pink: true },
      dirt: { thump: 0.55, f: [600, 0.8], dec: 0.1, peak: 1.3, pink: true },
    }[surface] || { thump: 0.5, f: [1200, 1], dec: 0.08, peak: 1.4 };
    const n = S.crackle || 1;
    for (let i = 0; i < n; i++) {
      const tt = t + (i ? rnd() * 0.09 : 0);
      const v = voice(tt, S.dec + 0.12, 0.02, pan, { wet: S.splash ? 0.6 : 0.25 });
      const bp = v.filter('bandpass', S.f[0] * (0.8 + rnd() * 0.5), S.f[1]);
      v.noiseSrc(S.pink ? engine.noise.pink : engine.noise.white).connect(bp);
      bp.connect(v.gain(0.003, S.peak * (i ? 0.5 * rnd() : 1), S.dec * (n > 1 ? 0.5 : 1)));
      if (!i) {
        const o = v.osc('sine'); o.frequency.setValueAtTime(110, tt); o.frequency.exponentialRampToValueAtTime(55, tt + 0.06);
        o.connect(v.gain(0.004, S.thump, 0.09));
        if (S.ring) { const r = v.osc('sine'); r.frequency.value = S.ring; r.connect(v.gain(0.001, 0.12, 0.05)); }
      }
      v.seal();
    }
  }

  const motSm = { sq: new Smooth(0), slide: new Smooth(0), pan: new Smooth(0) };
  let lastFall = false, fallT0 = 0;

  return {
    name: 'board',
    out,
    footstep,
    onEvent,
    update(dt, now, env, ahead) {
      envRef = env;
      if (env.fallen && !lastFall) { fallT0 = now; }
      lastFall = env.fallen;
      if (env.speed > 0.6 && env.grounded && !env.fallen) { joints.tick(now, ahead); pebbles.tick(now, ahead); }
      knocks.tick(now, ahead);

      healT += dt;
      if (healT > 1) { healT = 0; for (const c of chains) c.heal(); }
      acc += dt;
      if (acc < 0.06) return;
      const step = acc; acc = 0;

      // While the rider is down the board rolls away on its own and slowly stops.
      const ph = env.fall?.phase;
      if (env.fallen) away.v *= Math.exp(-step / 2.2); else away.v = 0;
      const speedNow = env.fallen ? away.v : env.speed;
      const v = sm.v.step(speedNow, step, 0.18);
      const leanA = sm.lean.step(Math.min(1, Math.abs(env.lean) / 0.4), step, 0.25);
      const air = sm.air.step(env.airborne ? 0.03 : 1, step, env.airborne ? 0.05 : 0.08); // wheels stop rolling in the air
      const target = SURF[env.surface] || SURF.asphalt;
      const w = sm.w.map((s, i) => s.step(target[i], step, 0.25));
      const be = sm.brake.step(env.braking && env.speed > 0.4 && !env.fallen ? 1 : 0, step, env.braking ? 0.08 : 0.25);
      const be0 = be * clamp(v / 6, 0, 1);
      const level = v < 0.15 ? 0 : Math.pow((v - 0.15) / V_REF, 1.15);
      const bridgeBoost = env.onBridge && env.scene !== 'fjord' ? 1.15 : 1;
      const L = level * air * bridgeBoost, tc = 0.1;
      const rate = 0.5 + 0.075 * v;
      const midK = 0.25 + 1.25 * sstep(2, 15, v); // body band: barely there when slow, fuller when fast

      const gate = (part, lvl) => part.c.setLevel(lvl, step);
      gate(low, AMP.low * L * w[0]); gate(mid, AMP.mid * L * w[1] * midK); gate(dirt, AMP.dirt * L * w[5]); gate(brake, AMP.brake * be0 * air);
      humGate.update(AMP.hum * Math.pow(L, 1.3) * w[2], step);
      texA.gate.update(AMP.texA * L * w[3], step); texG.gate.update(AMP.texG * L * w[4], step);
      low.g.gain.setTargetAtTime(AMP.low * L * w[0], now, tc);
      mid.g.gain.setTargetAtTime(AMP.mid * L * w[1] * midK * (1 + 0.3 * leanA), now, tc);
      humG.gain.setTargetAtTime(AMP.hum * Math.pow(L, 1.3) * w[2], now, tc);
      texA.g.gain.setTargetAtTime(AMP.texA * L * w[3] * (1 + 0.4 * leanA), now, tc);
      texG.g.gain.setTargetAtTime(AMP.texG * L * w[4] * (1 + 0.25 * leanA), now, tc);
      dirt.g.gain.setTargetAtTime(AMP.dirt * L * w[5], now, tc);
      low.c.src.playbackRate.setTargetAtTime(rate, now, 0.15);
      mid.c.src.playbackRate.setTargetAtTime(0.75 + 0.05 * v, now, 0.15);
      texA.src.playbackRate.setTargetAtTime(0.4 + 0.085 * v, now, 0.15);
      texG.src.playbackRate.setTargetAtTime(0.35 + 0.075 * v, now, 0.15);
      lfo.frequency.setTargetAtTime(clamp(v / 0.22, 2, 60), now, 0.2);
      lfoSlow.frequency.setTargetAtTime(clamp(v * 0.5, 1, 9), now, 0.3);
      const hf = 70 + v * 7;
      humOsc[0].frequency.setTargetAtTime(hf, now, 0.2);
      humOsc[1].frequency.setTargetAtTime(hf * 2.013, now, 0.2);
      brake.g.gain.setTargetAtTime(AMP.brake * be * clamp(v / 6, 0, 1) * air, now, 0.1);

      const riding = !env.fallen;
      const spd = env.speed;

      // ---- urethane slide: ONLY when the board really slides sideways (env.slip, m/s; 0 = gripping).
      // slip 0.4 -> 3 maps to 0 -> 1. Plain cornering (grip high, slip 0) is silent.
      const slipIn = riding && env.grounded ? Math.max(0, env.slip ?? 0) : 0;
      const sk = motSm.sq.step(sstep(0.4, 3, slipIn), step, 0.12) * (0.35 + 0.65 * clamp(spd / 9, 0, 1));
      gate(skid, AMP.skid * sk); gate(skidLow, AMP.skid * sk);
      skid.g.gain.setTargetAtTime(AMP.skid * sk, now, 0.05);
      skidLow.g.gain.setTargetAtTime(AMP.skid * 0.5 * sk, now, 0.05);
      skid.c.src.playbackRate.setTargetAtTime(0.85 + 0.3 * sk, now, 0.2);
      chat.frequency.setTargetAtTime(18 + 22 * sk, now, 0.3);

      // ---- fall: jacket sliding on asphalt until the tumble ends
      const tumble = env.fallen && ph === 'tumble';
      const tsec = env.fall?.t ?? (now - fallT0);
      const slideLvl = tumble ? AMP.slide * Math.max(clamp(env.speed / 8, 0, 1) ** 0.8, 0.55 * Math.exp(-tsec / 1.6)) : 0;
      const sl = motSm.slide.step(slideLvl, step, tumble ? 0.08 : 0.25);
      gate(slide, sl); slide.g.gain.setTargetAtTime(sl, now, 0.06);

      // board pans to the side it flew off to
      const panT = env.fallen ? clamp(away.side * 0.5, -0.6, 0.6) : 0;
      mpan.pan.setTargetAtTime(motSm.pan.step(panT, step, 0.3), now, 0.1);
      master.gain.setTargetAtTime(1, now, 0.2);
    },
    dispose() {
      for (const c of chains) c.stop();
      for (const o of [lfo, lfoSlow, chat, ...humOsc]) { try { o.stop(); } catch (e) { /* */ } }
      for (const b of [texA, texG]) { try { b.src.stop(); } catch (e) { /* */ } }
      out.dispose();
    },
  };
}
