// 'stream' layer: running water, waterfalls, steam vents, lake and sea.
//   rainforest: brook babble near the stream, waterfall roar (distance + direction)
//   fjord:      river (distance to world.riverX(z)), hairpin waterfall (111 m, thunderous up close),
//               gorge-head waterfall with canyon echo, geothermal steam + mud plops, lake lapping,
//               sea surf (closer and clearer on the black-sand beach)
// Everything is fixed-filter noise (independent per ear) with gains driven from the listener
// position; source direction is applied with an equal-power pan relative to the camera.
import { makeChain, panGains } from './chains.js';
import { Wander, Smooth, clamp, sstep, lerp, rnd } from './util.js';
import { createPoisson } from './engine.js';
import { createVoices } from './voice.js';

const TRIM = 1.0;

const BANDS = [
  { name: 'flow', type: 'pink', seconds: 5.3, filters: [{ type: 'highpass', f: 220, q: 0.6 }, { type: 'bandpass', f: 1500, q: 0.45 }], wf: 0.12, depth: 0.25 },
  { name: 'gurgle', type: 'white', seconds: 4.1, filters: [{ type: 'highpass', f: 3000, q: 0.6 }, { type: 'lowpass', f: 9000, q: 0.5 }], wf: 0.4, depth: 0.5 },
  { name: 'roar', type: 'brown', seconds: 6.1, filters: [{ type: 'lowpass', f: 520, q: 0.7 }], wf: 0.07, depth: 0.2 },
  { name: 'surf', type: 'pink', seconds: 5.9, filters: [{ type: 'lowpass', f: 750, q: 0.6 }], wf: 0.05, depth: 0.1 },
  { name: 'spray', type: 'white', seconds: 4.3, filters: [{ type: 'highpass', f: 2200, q: 0.6 }, { type: 'lowpass', f: 9500, q: 0.5 }], wf: 0.22, depth: 0.25 },
  { name: 'steam', type: 'white', seconds: 5.1, filters: [{ type: 'highpass', f: 3200, q: 0.6 }, { type: 'bandpass', f: 5200, q: 0.9 }], wf: 0.15, depth: 0.35 },
  { name: 'foam', type: 'white', seconds: 4.7, filters: [{ type: 'highpass', f: 1400, q: 0.6 }, { type: 'bandpass', f: 3000, q: 0.5 }], wf: 0.1, depth: 0.2 },
];

export function createWaterLayer(engine) {
  const { ac } = engine;
  const out = engine.makeLayer('stream', TRIM);
  const merger = ac.createChannelMerger(2);
  merger.connect(out.dry);
  const wetSend = ac.createGain(); wetSend.gain.value = 0.12;
  const { voice, canSpawn } = createVoices(engine, out, 12); merger.connect(wetSend); wetSend.connect(out.wet);

  const bands = BANDS.map((def, bi) => {
    const sides = [0, 1].map((side) => {
      const c = makeChain(engine, { type: def.type, seconds: def.seconds + side * 0.91, filters: def.filters, seed: 4000 + bi * 19 + side * 7 });
      c.out.gain.value = 0;
      c.connect(merger, 0, side);
      return { c, w: new Wander(def.wf * (side ? 1.17 : 0.88)) };
    });
    return { def, sides, pan: new Smooth(0), lvl: new Smooth(0) };
  });
  const B = Object.fromEntries(bands.map((b) => [b.def.name, b]));
  const foamS = new Smooth(0);
  let envRef = { geo: 0 };
  function plop(t) { // geothermal mud pot: low "咕嘟" bubble
    if (!canSpawn()) return;
    const dn = 0.1 + rnd() * 0.3, f0 = 70 + rnd() * 110;
    const v = voice(t, 0.45, dn, (rnd() * 2 - 1) * 0.7, { wet: 0.6 });
    const o = v.osc('sine');
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 2.4, t + 0.07); o.frequency.exponentialRampToValueAtTime(f0 * 1.2, t + 0.25);
    o.connect(v.gain(0.006, 0.55 * (0.5 + rnd()), 0.22));
    const hp = v.filter('highpass', 700, 0.7); v.noiseSrc().connect(hp); hp.connect(v.gain(0.001, 0.12, 0.03)); // surface pop
    v.seal();
  }
  const plops = createPoisson(() => 0.15 + 4.5 * envRef.geo * envRef.geo, plop);
  let acc = 0, healT = 0;

  function setBand(b, level, pan, now, step) {
    const [gl, gr] = panGains(b.pan.step(pan, step, 0.15));
    const lv = b.lvl.step(level, step, 0.4);
    b.sides.forEach((sd, side) => {
      const x = sd.w.step(step);
      const m = Math.max(0.1, 1 + b.def.depth * x * 1.5);
      sd.c.out.gain.setTargetAtTime(lv * m * (side ? gr : gl) * Math.SQRT2, now, 0.15);
      sd.c.setLevel(lv, step);
    });
  }

  return {
    name: 'stream',
    out,
    update(dt, now, env, ahead) {
      healT += dt;
      if (healT > 1) { healT = 0; for (const b of bands) for (const s of b.sides) s.c.heal(); }
      acc += dt;
      if (acc < 0.1) return;
      const step = acc; acc = 0;
      const lv = { flow: 0, gurgle: 0, roar: 0, surf: 0, foam: 0, spray: 0, steam: 0 };
      let pan = 0, seaPan = 0, geoProx = 0, wetT = 0.12;

      if (env.scene === 'fjord') {
        const world = env.world, F = world?.features;
        let pNum = 0, pDen = 0;
        const dirPan = (tx, tz, d) => clamp(((tx - env.x) * env.rightX + (tz - env.z) * env.rightZ) / Math.max(d, 10), -1, 1) * 0.9;
        const src = (flow, gurgle, roar, spray, p) => { // one point-ish source: add its band levels, weight its pan
          lv.flow += flow; lv.gurgle += gurgle; lv.roar += roar; lv.spray += spray;
          const w = flow + roar + spray * 0.5 + 1e-6; pNum += p * w; pDen += w;
        };
        // river
        const rx = world?.riverX ? world.riverX(env.z) : 1e4;
        const dx = rx - env.x, dr = Math.abs(dx);
        const inValley = sstep(-1330, -1200, env.z) * (1 - sstep(820, 900, env.z));
        const near = inValley / (1 + Math.pow(dr / 26, 1.5));
        const far = inValley * (0.16 + 0.5 * Math.exp(-dr / 110));
        src(0.62 * near, 0.16 * near, 0.5 * near + 0.45 * far, 0, clamp((dx * env.rightX) / (18 + dr * 0.6), -1, 1) * 0.85);
        if (F) {
          // hairpin waterfall: thunder that grows as you approach the plunge pool, spray hiss up close
          const H = F.hairpinFall, hp = H.pool || H;
          const dh = Math.hypot(env.x - hp.x, env.z - hp.z);
          src(0.8 / (1 + Math.pow(dh / 45, 1.5)), 0.22 / (1 + Math.pow(dh / 30, 2)), 1.7 / (1 + Math.pow(dh / 55, 1.4)), 1.1 / (1 + Math.pow(dh / 24, 2)), dirPan(hp.x, hp.z, dh));
          // gorge-head waterfall (Svartifoss-like): smaller, with canyon echo
          const G = F.gorge;
          const dg = Math.hypot(env.x - G.ax, env.z - G.az);
          src(0.5 / (1 + Math.pow(dg / 55, 1.5)), 0.12 / (1 + Math.pow(dg / 40, 2)), 1.0 / (1 + Math.pow(dg / 75, 1.4)), 0.55 / (1 + Math.pow(dg / 30, 2)), dirPan(G.ax, G.az, dg));
          const inGorge = world.gorgeAt ? world.gorgeAt(env.x, env.z) : 0;
          wetT = 0.12 + 0.5 * clamp(inGorge, 0, 1);
          // geothermal steam vents
          const T = F.geothermal, dt2 = Math.hypot(env.x - T.x, env.z - T.z);
          geoProx = 1 / (1 + Math.pow(dt2 / (T.r * 0.9), 2.5));
          lv.steam = 0.75 * geoProx;
          // lake lapping: small, quick wavelets (only near the shore)
          const Lk = F.lake, q = Math.hypot((env.x - Lk.x) / Lk.rx, (env.z - Lk.z) / Lk.rz);
          const lake = 1 - sstep(0.9, 2.0, q);
          lv.surf += 0.32 * lake * (0.55 + 0.45 * Math.sin((2 * Math.PI * now) / 3.1));
          lv.foam += 0.08 * lake * Math.max(0, Math.sin((2 * Math.PI * now) / 3.1 - 0.6));
        }
        pan = pDen > 0 ? clamp(pNum / pDen, -1, 1) : 0;
        // sea surf: slow swells, foam trailing the swell; nearer and crisper on the black-sand beach
        const sea = sstep(650, 900, env.z);
        const beach = env.beach || 0;
        const swell = Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * now) / 7.3), 1.6) * (0.65 + 0.35 * Math.sin((2 * Math.PI * now) / 17.1 + 0.7));
        const foam = foamS.step(Math.max(0, swell - 0.3) * 1.4, step, 0.9);
        lv.surf += sea * (0.28 + 0.75 * swell) * (1 + 0.8 * beach);
        lv.foam += sea * 0.5 * foam * (1 + 1.8 * beach);
        seaPan = clamp(env.rightZ * 0.7, -0.7, 0.7);
        wetSend.gain.setTargetAtTime(wetT, now, 0.6);
      } else {
        const wd = env.waterDist;
        const brook = Math.exp(-Math.max(0, wd) / 9);
        lv.flow = 0.55 * brook;
        lv.gurgle = 0.14 * brook;
        const wf = env.world?.landmarks?.waterfall;
        if (wf) {
          const dx = wf.x - env.x, dz = wf.z - env.z, d = Math.hypot(dx, dz);
          const k = 1 / (1 + Math.pow(d / 32, 1.6));
          lv.roar = 0.8 * k;
          lv.flow += 0.3 * k; lv.gurgle += 0.14 * k;
          pan = clamp((dx * env.rightX + dz * env.rightZ) / Math.max(d, 8), -1, 1) * 0.75;
        }
        lv.flow *= 1 - 0.0 * env.canopy;
      }
      // rain masks a little; gentle wet-air boost of the wash
      const rainMask = lerp(1, 0.85, env.rain);
      setBand(B.flow, lv.flow * rainMask, pan, now, step);
      setBand(B.gurgle, lv.gurgle * rainMask, pan, now, step);
      setBand(B.roar, lv.roar, pan, now, step);
      setBand(B.spray, lv.spray * rainMask, pan, now, step);
      setBand(B.steam, lv.steam, 0, now, step);
      envRef = { geo: geoProx };
      plops.tick(now, ahead ?? 0.15);
      setBand(B.surf, lv.surf, seaPan, now, step);
      setBand(B.foam, lv.foam, seaPan, now, step);
    },
    dispose() {
      for (const b of bands) for (const s of b.sides) s.c.stop();
      out.dispose();
    },
  };
}
