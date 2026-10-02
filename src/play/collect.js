// 光点收集 + 一程统计（轻量玩法层）。createCollect(ctx) -> { update(dt,t), dispose() }
//
// 沿路分布发光小光点：一串串沿好线路（弯道内侧/外侧交替、直道上左右摆动），坡顶上方较高处放几颗
// （腾空时才吃得到）。碰到就收集：光点炸开 + 五声音阶的"叮"（连续收集音阶上行）。
// 全部只用一个 Points（光点）+ 一个小 Points（火花），CPU 侧只做 ~90 个点的线段距离检测。
//
// 对外：ctx.play = {
//   total, count, run{ time,maxSpeed,maxAir,falls,collected,total,finished }, best(km/h),
//   on(name, fn) -> off      name: 'collect' | 'reset' | 'finish' | 'record'
// }
// 事件来源：ctx.skate.on('start'|'finish'|'fall'|'land')（'start'/'finish' 若不存在则用状态边沿兜底）。
import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';
import { FOG_PARS_GLSL, fogUniforms } from '../render/fog.js';
import { createRider } from '../player/skate/physics.js';

const G = 9.81;
const PICK_R = 1.25;          // 收集半径 (m)
const VERT_W = 1.5;           // 垂直距离加权
const BODY_UP = 0.55;         // 骑手"身体中心"高出板面
const WALK_BODY = 0.95;
const MAX_ORBS = 120;
const MAX_SPARKS = 160;
const PENTA = [0, 2, 4, 7, 9];
const COMBO_GAP = 2.2;        // s；超过则音阶回到起点
const STORE_KEY = 'rainforest.play.v1';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  read() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } },
  write(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch { /* 忽略 */ } },
};

/* ------------------------------------------------------------------ 着色器 */
const ORB_VERT = /* glsl */ `
attribute vec4 aData;   // x 相位, y 大小系数, z 已收集时间(<0 未收集), w 类型(0 地面 1 空中)
uniform float uTime, uScale;
varying float vAlpha, vKind, vCore;
varying vec3 vWP;
void main() {
  float ph = aData.x;
  vec3 p = position;
  p.y += sin(uTime * 1.25 + ph) * 0.13 + sin(uTime * 2.3 + ph * 2.1) * 0.03;
  float breath = 0.5 + 0.5 * sin(uTime * 1.9 + ph * 1.7);
  float size = 1.0 * aData.y * (1.0 + 0.10 * breath);
  float a = 1.0;
  float ct = aData.z;
  if (ct >= 0.0) {
    float k = clamp(ct / 0.5, 0.0, 1.0);
    size *= 1.0 + 2.6 * k;
    a = (1.0 - k) * (1.0 - k);
    p.y += k * 0.7;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.2);
  float px = size * uScale / dist;
  float minPx = 6.0;
  gl_PointSize = clamp(max(px, minPx), 1.0, 96.0);
  vAlpha = a * clamp(px / minPx, 0.55, 1.0);
  vCore = 0.8 + 0.3 * breath;
  vKind = aData.w;
  vWP = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;

const ORB_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
varying float vAlpha, vKind, vCore;
varying vec3 vWP;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 16.0);
  float halo = exp(-r2 * 4.2);
  float edge = 1.0 - smoothstep(0.7, 1.0, sqrt(r2));
  vec3 gold = mix(vec3(1.0, 0.72, 0.30), vec3(0.75, 0.92, 1.0), vKind * 0.55);
  vec3 col = (gold * halo * 1.15 + vec3(1.0, 0.96, 0.85) * core * 2.4 * vCore) * edge;
  // 远处被雾吸收一部分，但不会消失
  float T = exp(-fogOpticalDepth(uCamPos, vWP));
  col *= 0.45 + 0.55 * T;
  gl_FragColor = vec4(col, vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SPARK_VERT = /* glsl */ `
attribute vec2 aSpark;  // x 剩余寿命 0..1, y 大小
uniform float uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.2);
  gl_PointSize = clamp(aSpark.y * uScale / dist, 0.0, 40.0) * step(0.001, aSpark.x);
  vA = aSpark.x * aSpark.x;
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAG = /* glsl */ `
varying float vA;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 5.0);
  gl_FragColor = vec4(vec3(1.0, 0.85, 0.5) * g * 2.2, vA * g);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* -------------------------------------------------------------------- 主体 */
export function createCollect(ctx) {
  const { world, state, scene, camera } = ctx;
  const path = world.path;
  const closed = !!path.closed;
  const L = path.length;
  const W = path.width;
  const forest = closed;
  const vRef = forest ? 6.5 : 12;          // 参考速度：用来算坡顶抛物线
  const lane = Math.min(W * 0.22, 1.8);    // 被动巡航车道（与物理一致）
  const latMax = forest ? W / 2 - 0.35 : Math.max(0.8, W / 2 - 0.9);
  const pickR = forest ? 0.8 : PICK_R;   // 步道窄：半径小一点，才需要左右走位
  const rand = mulberry32(forest ? 4242 : 20260930);
  const wrapS = (s) => (closed ? ((s % L) + L) % L : clamp(s, 0, L));

  const C = new THREE.Vector3(), Tt = new THREE.Vector3(), Ta = new THREE.Vector3(), Tb = new THREE.Vector3();
  const roadY = (s) => path.pointAt(wrapS(s), C).y;
  const curvature = (s) => {   // 右转为正（同 physics.js）
    path.tangentAt(wrapS(s - 3), Ta); path.tangentAt(wrapS(s + 3), Tb);
    return Math.atan2(-(Ta.z * Tb.x - Ta.x * Tb.z), Ta.x * Tb.x + Ta.z * Tb.z) / 6;
  };
  const place = (s, lat, dy) => {
    s = wrapS(s);
    path.pointAt(s, C); path.tangentAt(s, Tt);
    let hx = Tt.x, hz = Tt.z; const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    return new THREE.Vector3(C.x - hz * lat, C.y + dy, C.z + hx * lat);
  };

  /* ---- 找凸坡（腾空点）：路面高程二阶导的强负极小值 ---- */
  function findCrests() {
    const N = Math.floor(L);
    const Y = new Float32Array(N + 8);
    for (let i = 0; i < Y.length; i++) Y[i] = roadY(i - 4);
    const ypp = new Float32Array(N);
    for (let i = 3; i < N - 3; i++) ypp[i] = (Y[i + 4 + 3] - 2 * Y[i + 4] + Y[i + 4 - 3]) / 9;
    const thr = -(G * 0.85 / (vRef * vRef)) * 0.6;
    const cands = [];
    for (let i = 20; i < N - (closed ? 3 : 90); i++) {
      if (ypp[i] > thr) continue;
      let ok = true;
      for (let k = -12; k <= 12; k++) { const j = i + k; if (j >= 3 && j < N - 3 && ypp[j] < ypp[i] - 1e-9) { ok = false; break; } }
      if (ok) cands.push({ s: i, v: ypp[i] });
    }
    const out = [];
    for (const c of cands.sort((a, b) => a.v - b.v)) if (out.every((o) => Math.abs(o.s - c.s) > 30)) out.push(c);
    return out.sort((a, b) => a.s - b.s).map((c) => c.s);
  }

  /* ---- 布点 ---- */
  const orbs = [];   // { p: Vector3, air: bool, got: bool, ct: -1, s }
  const add = (p, air, s) => { if (orbs.length < MAX_ORBS) orbs.push({ p, air, got: false, ct: -1, s }); };

  /* 用一个私有骑手（同一套物理）预演过坡：返回 [{ds, gap}]（相对坡顶的飞行轨迹，板面高出路面）；飞不起来返回 null。 */
  function flightArc(cs) {
    const speeds = forest ? [6, 7.5, 9] : [13, 15, 17.5];
    for (const v0 of speeds) {
      try {
        const rider = createRider(world);
        const st = rider.state;
        rider.place(cs - 25, lane, v0);
        const samples = [];
        for (let i = 0; i < 60 * 6 && st.s < cs + 35; i++) {
          if (!samples.length && st.s > cs + 8) break;   // 没起飞就不用往下预演
          rider.step(1 / 60, { throttle: 0.5 });
          if (st.airborne && !st.fallen) samples.push({ ds: st.s - cs, gap: st.position.y - 0.13 - roadY(st.s) });
          else if (samples.length) break;
        }
        const maxGap = samples.reduce((m, q) => Math.max(m, q.gap), 0);
        if (samples.length >= 8) return samples;   // 真的离地过（空中光点本身要求 airborne 才能吃）
      } catch (e) { /* 物理接口变了：走抛物线兜底 */ break; }
    }
    return null;
  }

  function layout() {
    const crests = findCrests();
    const budget = Math.round(closed ? clamp(L / 16, 18, 24) : clamp(L / 45, 60, 90));
    const per = 2;
    // 每个坡顶：先算空中弧线；飞不起来的坡不放空中光点
    const arcs = crests.map((cs) => {
      const smp = flightArc(cs);
      if (!smp) return null;
      const pick = [0.22, 0.5, 0.78].map((f) => smp[Math.min(smp.length - 1, Math.floor(f * smp.length))]);
      return pick;
    });
    const nAir = arcs.reduce((n, a) => n + (a ? 3 : 0), 0);
    const nGround = Math.max(budget - crests.length * per - nAir, closed ? 8 : 30);
    const spacing = 5;
    const chainLen = 5;
    const nChains = Math.max(2, Math.round(nGround / chainLen));

    crests.forEach((cs, ci) => {
      // 助跑：两颗，左右交替（不全在被动车道上）
      const side = ci % 2 ? -1 : 1;
      for (let i = 0; i < per; i++) add(place(cs - 14 + i * 7, side * lane * 0.9, 0.78), false, cs - 14 + i * 7);
      const arc = arcs[ci];
      if (arc) arc.forEach((q, i) => add(place(cs + q.ds, (ci % 2 ? -lane * 0.8 : lane) + (i - 1) * 0.2, q.gap + 0.13 + BODY_UP + 0.3), true, cs + q.ds));
    });

    // 地面串：均匀铺开，避开坡顶簇
    const s0 = closed ? 8 : 70, s1 = closed ? L - 8 : L - 90;
    const stepC = (s1 - s0) / nChains;
    let flip = rand() < 0.5 ? 1 : -1;
    for (let c = 0; c < nChains; c++) {
      let sc = s0 + stepC * (c + 0.5) + (rand() - 0.5) * stepC * 0.4;
      // 若落在坡顶簇内则挪开
      for (const cs of crests) {
        const d = sc - cs;
        if (d > -30 && d < 20) sc = cs + (d < -5 ? -34 : 24);
      }
      const n = closed ? 4 + (c % 2) : 5 + (rand() < 0.35 ? 1 : 0);
      const start = sc - ((n - 1) * spacing) / 2;
      let kAvg = 0;
      for (let i = 0; i < n; i++) kAvg += curvature(start + i * spacing) / n;
      let mode;
      if (Math.abs(kAvg) > (forest ? 0.012 : 0.004)) mode = 'curve';
      else mode = !forest && rand() < 0.16 ? 'lane' : 'sweep';
      const dirSweep = rand() < 0.5 ? 1 : -1;
      let inside = 0;
      if (mode === 'curve') { flip = -flip; inside = Math.sign(kAvg) * flip; }   // 内侧/外侧交替
      for (let i = 0; i < n; i++) {
        const s = start + i * spacing, u = n > 1 ? i / (n - 1) : 0;
        let lat;
        if (mode === 'curve') lat = lane + (inside * latMax * 0.95 - lane) * Math.min(1, i / 1.5);
        else if (mode === 'lane') lat = lane + Math.sin(u * Math.PI * 2) * latMax * 0.28;
        else lat = dirSweep * latMax * (1 - 2 * u) * 0.95;
        add(place(s, clamp(lat - (forest ? 0.3 : 0), -latMax - (forest ? 0.3 : 0), latMax), 0.78 + 0.1 * Math.sin(i * 1.7)), false, s);
      }
    }
    orbs.sort((a, b) => a.s - b.s);
  }
  layout();
  const total = orbs.length;

  /* ---- 渲染对象 ---- */
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(total * 3), data = new Float32Array(total * 4);
  orbs.forEach((o, i) => {
    pos.set([o.p.x, o.p.y, o.p.z], i * 3);
    data.set([rand() * 6.283, o.air ? 1.15 : 1, -1, o.air ? 1 : 0], i * 4);
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dataAttr = new THREE.BufferAttribute(data, 4);
  dataAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aData', dataAttr);
  const uScale = { value: 800 };
  const orbMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale, ...fogUniforms() },
    vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, orbMat);
  points.frustumCulled = false; points.renderOrder = 8;
  scene.add(points);

  const sparkPos = new Float32Array(MAX_SPARKS * 3), sparkAttr = new Float32Array(MAX_SPARKS * 2);
  const sparkVel = new Float32Array(MAX_SPARKS * 3), sparkAge = new Float32Array(MAX_SPARKS), sparkLife = new Float32Array(MAX_SPARKS).fill(1);
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
  sgeo.setAttribute('aSpark', new THREE.BufferAttribute(sparkAttr, 2).setUsage(THREE.DynamicDrawUsage));
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { uScale }, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sgeo, sparkMat);
  sparks.frustumCulled = false; sparks.renderOrder = 9;
  scene.add(sparks);
  let sparkHead = 0, sparkLive = 0;
  for (let i = 0; i < MAX_SPARKS; i++) sparkPos[i * 3 + 1] = -9999;

  function burst(p, air) {
    const n = air ? 12 : 9;
    for (let k = 0; k < n; k++) {
      const i = sparkHead; sparkHead = (sparkHead + 1) % MAX_SPARKS;
      const a = rand() * 6.283, e = (rand() - 0.35) * 1.6, sp = 1.2 + rand() * 2.2;
      sparkPos.set([p.x, p.y, p.z], i * 3);
      sparkVel.set([Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 0.6, Math.sin(a) * Math.cos(e) * sp], i * 3);
      sparkAge[i] = 0; sparkLife[i] = 0.5 + rand() * 0.4;
      sparkAttr[i * 2] = 1; sparkAttr[i * 2 + 1] = 0.10 + rand() * 0.09;
    }
    sparkLive = 1.2;
  }

  /* ---- 声音：挂在 audio 引擎的一个小 layer 上（跟随总音量/静音/隧道以外的一切） ---- */
  let layer = null, dingBus = null, lastEngine = null;
  let combo = 0, lastCollectAt = -99;
  function audioBus() {
    const eng = ctx.audio?.engine;
    if (!eng || eng.ac.state !== 'running') return null;
    if (eng !== lastEngine) {
      lastEngine = eng;
      layer = eng.makeLayer('collect', 0.85);
      layer.setVolume(0.75, true);
      const ac = eng.ac;
      dingBus = ac.createBiquadFilter();
      dingBus.type = 'lowpass'; dingBus.frequency.value = 4200; dingBus.Q.value = 0.4;
      const send = ac.createGain(); send.gain.value = 0.32;
      dingBus.connect(layer.dry); dingBus.connect(send); send.connect(layer.wet);
    }
    return eng;
  }
  const noteOf = (n) => 523.25 * 2 ** ((PENTA[n % 5] + 12 * Math.floor(n / 5)) / 12);
  function ding(air) {
    const eng = audioBus();
    if (!eng) return;
    const ac = eng.ac, now = ac.currentTime;
    const idx = combo < 8 ? combo : [5, 7, 8, 7][(combo - 8) % 4];
    const f = noteOf(idx) * (rand() < 0.5 ? 1 : 1.002);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(air ? 0.2 : 0.16, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    g.connect(dingBus);
    for (const [mul, amp, dec] of [[1, 1, 0.6], [2, 0.32, 0.32], [3.01, 0.1, 0.16]]) {
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = 'sine'; o.frequency.value = f * mul;
      og.gain.setValueAtTime(amp, now); og.gain.exponentialRampToValueAtTime(0.001, now + dec);
      o.connect(og); og.connect(g);
      o.start(now); o.stop(now + dec + 0.05);
    }
    setTimeout(() => { try { g.disconnect(); } catch { /* ok */ } }, 900);
  }

  /* ---- 事件 / 统计 ---- */
  const listeners = {};
  const emit = (name, arg) => { const a = listeners[name]; if (a) for (const f of a) { try { f(arg); } catch (e) { console.warn('[play]', e); } } };
  const saved = store.read();
  const best = { kmh: saved.best?.[ctx.sceneId] || 0 };
  const run = { time: 0, maxSpeed: 0, maxAir: 0, falls: 0, collected: 0, total, finished: false, record: false };
  let startBest = best.kmh;
  const play = {
    total, count: 0, run, get best() { return best.kmh; },
    on(name, fn) { (listeners[name] ||= new Set()).add(fn); return () => listeners[name].delete(fn); },
  };
  ctx.play = play;

  let recordPending = false, recordFlashAt = -99, flashedThisRun = false;
  function saveBest(kmh) {
    best.kmh = kmh;
    const s = store.read(); s.best = { ...(s.best || {}), [ctx.sceneId]: Math.round(kmh * 10) / 10 }; store.write(s);
  }

  function reset() {
    for (let i = 0; i < total; i++) { orbs[i].got = false; orbs[i].ct = -1; data[i * 4 + 2] = -1; }
    dataAttr.needsUpdate = true;
    animating.length = 0;
    play.count = 0; combo = 0;
    run.time = 0; run.maxSpeed = 0; run.maxAir = 0; run.falls = 0; run.collected = 0; run.finished = false; run.record = false; startBest = best.kmh;
    recordPending = false; flashedThisRun = false; latch = false;
    emit('reset');
  }

  let latch = false;
  function finish() {
    if (latch) return;
    latch = true; run.finished = true;
    const kmh = run.maxSpeed * 3.6;
    run.record = startBest > 0 && kmh > startBest + 0.8;
    recordPending = false;
    if (kmh > best.kmh) saveBest(kmh);
    emit('finish', { ...run });
  }
  function flushRecord() {
    if (!recordPending) return;
    recordPending = false;
    const kmh = run.maxSpeed * 3.6;
    const had = best.kmh > 0;
    saveBest(kmh);
    if (had) emit('record', kmh);
  }

  const offs = [];
  const sk = ctx.skate;
  if (sk?.on) {
    for (const n of ['start']) offs.push(sk.on(n, reset));
    offs.push(sk.on('finish', finish));
    offs.push(sk.on('fall', () => { if (!run.finished) run.falls++; }));
    offs.push(sk.on('land', (rs) => { const a = (rs || sk.state).airTime || 0; if (a > run.maxAir && !run.finished) run.maxAir = a; }));
  }

  /* ---- 收集 ---- */
  const animating = [];
  const body = new THREE.Vector3(), prev = new THREE.Vector3(), seg = new THREE.Vector3(), tmp = new THREE.Vector3();
  let havePrev = false, prevS = 0, prevFinished = false, prevFallen = false;
  function segDist2(o) {
    // 点到线段 prev→body 的加权距离（水平 + VERT_W × 竖直）
    const ax = prev.x, ay = prev.y * VERT_W, az = prev.z;
    const bx = body.x, by = body.y * VERT_W, bz = body.z;
    const px = o.p.x, py = o.p.y * VERT_W, pz = o.p.z;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    let t = l2 > 1e-8 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - px, cy = ay + dy * t - py, cz = az + dz * t - pz;
    return cx * cx + cy * cy + cz * cz;
  }
  function collect(i, t) {
    const o = orbs[i];
    o.got = true; o.ct = 0; animating.push(i);
    data[i * 4 + 2] = 0; dataAttr.needsUpdate = true;
    play.count++; run.collected = play.count;
    if (t - lastCollectAt > COMBO_GAP) combo = 0;
    lastCollectAt = t;
    burst(o.p, o.air);
    ding(o.air);
    combo++;
    emit('collect', { count: play.count, total, air: o.air });
  }

  let clock = 0;
  const _sz = new THREE.Vector2();
  function update(dt, t) {
    clock = t;
    const skating = !!sk && sk.enabled;
    const rs = sk?.state;
    if (skating) {
      body.copy(rs.position).addScaledVector(rs.up, BODY_UP);
    } else if (ctx.player) {
      body.copy(ctx.player.position); body.y += WALK_BODY;
    } else return;
    if (!havePrev) { prev.copy(body); havePrev = true; }

    if (skating && rs) {
      // 兜底：没有 'start' 事件时，用状态边沿判断重新开始
      if (!closed && (rs.s < prevS - 300 || (prevFinished && !rs.finished && rs.s < 200))) reset();
      if (rs.finished && !prevFinished) finish();
      prevFinished = !!rs.finished; prevS = rs.s;
      if (!run.finished && sk.inputEnabled) {
        run.time += dt;
        if (!rs.fallen) {
          const v = rs.speed || 0;
          if (v > run.maxSpeed) run.maxSpeed = v;
        }
        if (rs.airborne && rs.airTime > run.maxAir) run.maxAir = rs.airTime;
        if (rs.fallen && !prevFallen && !sk.on) run.falls++;
        // 破纪录：超过历史最高后，等速度回落（或落地/到终点）再闪一下；避免持续刷屏
        const kmh = run.maxSpeed * 3.6;
        if (best.kmh > 0 && kmh > best.kmh + 0.8) recordPending = true;
        if (recordPending && !flashedThisRun && (rs.speed * 3.6 < kmh - 2.5) && clock - recordFlashAt > 6) {
          flashedThisRun = true; recordFlashAt = clock; flushRecord();
        }
        if (best.kmh === 0 && kmh > 5) { /* 首次：静默，终点时写入 */ }
      }
      prevFallen = !!rs.fallen;
    }

    // 碰撞
    if (!(skating && rs.fallen)) {
      for (let i = 0; i < total; i++) {
        const o = orbs[i];
        if (o.got || (o.air && !(skating && rs.airborne))) continue;   // 空中光点只有腾空时才吃得到
        const dxs = o.p.x - body.x; if (dxs > 30 || dxs < -30) continue;
        if (segDist2(o) < pickR * pickR) collect(i, t);
      }
    }
    prev.copy(body);

    // 动画
    if (animating.length) {
      for (let k = animating.length - 1; k >= 0; k--) {
        const i = animating[k];
        orbs[i].ct += dt;
        data[i * 4 + 2] = orbs[i].ct;
        if (orbs[i].ct > 0.55) { data[i * 4 + 2] = 99; animating.splice(k, 1); }
      }
      dataAttr.needsUpdate = true;
    }
    if (sparkLive > 0) {
      sparkLive -= dt;
      for (let i = 0; i < MAX_SPARKS; i++) {
        if (sparkAttr[i * 2] <= 0) continue;
        sparkAge[i] += dt;
        const k = 1 - sparkAge[i] / sparkLife[i];
        if (k <= 0) { sparkAttr[i * 2] = 0; sparkPos[i * 3 + 1] = -9999; continue; }
        sparkAttr[i * 2] = k;
        const dmp = Math.exp(-2.2 * dt);
        sparkVel[i * 3] *= dmp; sparkVel[i * 3 + 1] = sparkVel[i * 3 + 1] * dmp - 1.2 * dt; sparkVel[i * 3 + 2] *= dmp;
        sparkPos[i * 3] += sparkVel[i * 3] * dt; sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt; sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
      }
      sgeo.attributes.position.needsUpdate = true; sgeo.attributes.aSpark.needsUpdate = true;
    }

    // 着色器统一量
    orbMat.uniforms.uTime.value = t;
    const r = ctx.renderer;
    if (r) { r.getSize(_sz); uScale.value = (_sz.y * r.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360)); }
  }

  function dispose() {
    for (const off of offs) off?.();
    scene.remove(points, sparks);
    geo.dispose(); sgeo.dispose(); orbMat.dispose(); sparkMat.dispose();
    try { layer?.dispose(); } catch { /* ok */ }
    if (ctx.play === play) ctx.play = null;
  }

  return { update, dispose, _orbs: orbs, _reset: reset, _emit: emit };   // _ 开头的仅供测试
}
