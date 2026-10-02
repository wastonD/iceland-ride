// Behaviour + locomotion for the pasture animals (CPU side, no per-frame allocation).
// Horses: graze / look at the player / walk / (herd) tolt / stand back-to-wind in rain.
// Sheep : graze / walk / flock cohesion + run to catch up / look / startle / huddle in rain.
import * as THREE from 'three';
import { mulberry32 } from '../../../core/noise.js';
import { balePlan } from '../build/farmGeo.js';

const TAU = Math.PI * 2;
const wrap = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (c, t, k, dt) => c + (t - c) * (1 - Math.exp(-k * dt));

/* ----------------------------------------------------------- walkable mask */
const segDist2 = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
  const px = ax + dx * t - x, pz = az + dz * t - z;
  return px * px + pz * pz;
};

export class Ground {
  /**
   * Walkable mask over the pasture. Blocks: road, water, steep ground, the farmyard (buildings, yard walls,
   * bales), and the dry-stone field walls that flora.js draws inside the pasture (same line list).
   */
  constructor(world, opts = {}) {
    this.world = world;
    const F = world.features, P = F.pasture, farm = F.farm;
    this.P = P;
    this.cell = 3;
    this.nx = Math.ceil((P.x1 - P.x0) / this.cell) + 1;
    this.nz = Math.ceil((P.z1 - P.z0) / this.cell) + 1;
    // obstacles
    const walls = world.id === 'fjord' ? [
      [[P.x0 + 12, P.z0 + 20], [P.x1 - 10, P.z0 + 35]],
      [[P.x1 - 10, P.z0 + 35], [P.x1 - 25, P.z1 - 40]],
      [[P.x0 + 20, (P.z0 + P.z1) / 2 + 30], [P.x1 - 25, (P.z0 + P.z1) / 2 + 10]],
      [[P.x0 + 15, P.z1 - 30], [P.x1 - 25, P.z1 - 40]],
    ] : [];
    const fs = farm ? farm.r / 45 : 1;
    const yard = farm ? { x0: farm.x - 50 * fs, x1: farm.x + 36 * fs, z0: farm.z - 28 * fs, z1: farm.z + 38 * fs } : null;
    let bales = [];
    if (world.id === 'fjord' && opts.bales !== false) { try { bales = balePlan(world); } catch { bales = []; } }
    const ok = new Uint8Array(this.nx * this.nz);
    const nrm = new THREE.Vector3();
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const x = P.x0 + i * this.cell, z = P.z0 + j * this.cell;
      let pass = x > P.x0 + 2 && x < P.x1 - 2 && z > P.z0 + 2 && z < P.z1 - 2;
      if (pass) pass = world.roadDistAt(x, z) > 9 && world.waterLevelAt(x, z) == null && world.heightAt(x, z) > 1.6;
      if (pass && yard) pass = !(x > yard.x0 && x < yard.x1 && z > yard.z0 && z < yard.z1);
      if (pass) for (const [a, b] of walls) if (segDist2(x, z, a[0], a[1], b[0], b[1]) < 3.4 * 3.4) { pass = false; break; }
      if (pass) for (const bl of bales) if ((bl.x - x) ** 2 + (bl.z - z) ** 2 < 2.6 * 2.6) { pass = false; break; }
      if (pass) { world.normalAt(x, z, nrm); pass = nrm.y > 0.9; }
      ok[j * this.nx + i] = pass ? 1 : 0;
    }
    // erode by one cell so bodies keep a margin from water / road / walls
    this.ok = new Uint8Array(ok.length);
    for (let j = 1; j < this.nz - 1; j++) for (let i = 1; i < this.nx - 1; i++) {
      let all = 1;
      for (let dj = -1; dj <= 1 && all; dj++) for (let di = -1; di <= 1; di++) if (!ok[(j + dj) * this.nx + i + di]) { all = 0; break; }
      this.ok[j * this.nx + i] = all;
    }
    this.hAt = (x, z) => world.heightAt(x, z);
  }
  can(x, z) {
    const i = Math.round((x - this.P.x0) / this.cell), j = Math.round((z - this.P.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false;
    return this.ok[j * this.nx + i] === 1;
  }
  clear(x0, z0, x1, z1, canFn) {
    const d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / 2.5));
    for (let k = 1; k <= n; k++) { const t = k / n; if (!canFn(lerp(x0, x1, t), lerp(z0, z1, t))) return false; }
    return true;
  }
}

/* ---------------------------------------------------------------- species */
const HORSE = {
  kind: 'horse', radius: 0.62, legLen: 0.95, stance: 0.55, walkAmp: 0.36, toltAmp: 0.54,
  turnStill: 0.8, turnMoving: 1.1, accel: 0.7, decel: 1.4,
  grazeNeck: 1.36, grazeHead: -0.78, alertNeck: -0.04, alertHead: 0.1,
};
const SHEEP = {
  kind: 'sheep', radius: 0.42, legLen: 0.44, stance: 0.55, walkAmp: 0.42, toltAmp: 0.6,
  turnStill: 1.5, turnMoving: 2.0, accel: 1.4, decel: 2.5,
  grazeNeck: 0.85, grazeHead: 0.62, alertNeck: -0.05, alertHead: -0.1,
};

/* ------------------------------------------------------------------- sim */
export class Sim {
  constructor(ctx, ground, seed = 99) {
    this.ctx = ctx; this.G = ground; this.rnd = mulberry32(seed);
    this.agents = []; this.horses = []; this.sheep = []; this.herds = []; this.flocks = [];
    this.px = 0; this.pz = 0; this.pvx = 0; this.pvz = 0; this.pSpeed = 0; this.hasPlayer = false;
    this.rainMode = false; this.windH = Math.atan2(1, 0.3);
    this.frame = 0;
    this.horseZoneX = ground.P.x0 + Math.max(60, (ground.P.x1 - ground.P.x0) * 0.28);
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._m = new THREE.Matrix4();
    this._pos = new THREE.Vector3(); this._sc = new THREE.Vector3();
  }
  ok(a, x, z) { return this.G.can(x, z) && (a.kind !== 'horse' || x < this.horseZoneX); }

  /* ---- setup */
  addAgent(spec) {
    const P = spec.kind === 'horse' ? HORSE : SHEEP;
    const a = {
      P, kind: spec.kind, i: spec.i, sc: spec.sc, x: spec.x, z: spec.z, y: 0, h: spec.h, pitch: 0, roll: 0,
      speed: 0, vT: 0, hT: NaN, turnV: 0, state: 'graze', t: 2 + this.rnd() * 10, cd: this.rnd() * 6, dest: null,
      herd: spec.herd ?? null, flock: spec.flock ?? null, active: true, acc: 0,
      neck: 0, head: 0, yaw: 0, tail: 0, tailLift: 0, earL: 0, earR: 0, stance: 0, horn: spec.horn ?? 0,
      neckT: 0, headT: 0, yawT: 0, earLT: 0, earRT: 0, stanceT: 0, tailLiftT: 0,
      gPhase: this.rnd(), gAmp: 0, gType: 0, bob: 0,
      chew: this.rnd(), tear: 2 + this.rnd() * 3, tearU: 1, grazeYaw: 0, tYaw: this.rnd() * 5,
      earTL: 1 + this.rnd() * 4, earTR: 1 + this.rnd() * 4, earFL: 0, earFR: 0,
      swish: 0, swishDur: 1, swishAmp: 0, tailTimer: 1 + this.rnd() * 6,
      curious: 0.6 + this.rnd() * 0.8, walkSpeed: 1.0 + this.rnd() * 0.3, grazeWalk: false, look: 'random', randYaw: 0,
      rainWait: 0, scareCD: 0, sT: 0, startleDelay: 0, pendDest: null, pendDelay: 0, dP: 999,
      moved: true, forced: false, hop: 0,
    };
    if (a.kind === 'sheep') a.walkSpeed = 0.55 + this.rnd() * 0.25;
    a.grazeYaw = (this.rnd() - 0.5) * 0.8;
    this.agents.push(a);
    (a.kind === 'horse' ? this.horses : this.sheep).push(a);
    return a;
  }

  /* ---- per frame */
  updatePlayer(dt) {
    const c = this.ctx;
    const st = c.skate?.state;
    let x, z, has = false;
    if (st?.position) { x = st.position.x; z = st.position.z; has = true; }
    else if (c.camera) { x = c.camera.position.x; z = c.camera.position.z; has = true; }
    if (has) {
      if (this.hasPlayer && dt > 0) {
        const vx = (x - this.px) / dt, vz = (z - this.pz) / dt;
        this.pvx = damp(this.pvx, vx, 8, dt); this.pvz = damp(this.pvz, vz, 8, dt);
      }
      this.px = x; this.pz = z; this.hasPlayer = true;
      this.pSpeed = st && typeof st.speed === 'number' ? Math.abs(st.speed) : Math.hypot(this.pvx, this.pvz);
    }
    const rain = c.state ? c.state.get('rain') : 0;
    if (!this.rainMode && rain > 0.5) this.rainMode = true;
    else if (this.rainMode && rain < 0.35) this.rainMode = false;
    if (this.forceRain !== undefined) this.rainMode = this.forceRain;
    const w = c.uniforms?.uWind?.value;
    if (w && (Math.abs(w.x) + Math.abs(w.z)) > 0.01) this.windH = Math.atan2(w.x, w.z);
  }

  update(dt) {
    this.frame++;
    this.updatePlayer(dt);
    // player far away from the pasture: nothing is visible, so only tick once in a while
    if (this.hasPlayer) {
      const P = this.G.P, dc = Math.hypot(this.px - (P.x0 + P.x1) / 2, this.pz - (P.z0 + P.z1) / 2);
      if (dc > 800) {
        this.skipAcc = (this.skipAcc || 0) + dt;
        if (this.frame % 30 !== 0) return this;
        dt = Math.min(this.skipAcc, 0.25); this.skipAcc = 0;
      }
    }
    this.updateHerds(dt);
    this.updateFlocks(dt);
    const cx = this.px, cz = this.pz;
    for (const a of this.agents) {
      if (!a.active) continue;
      const dx = a.x - cx, dz = a.z - cz, d2 = dx * dx + dz * dz;
      a.dP = Math.sqrt(d2);
      const period = !this.hasPlayer || d2 < 120 * 120 ? 1 : d2 < 250 * 250 ? 3 : 10;
      a.acc += dt;
      if (period > 1 && (this.frame + a.i) % period !== 0) continue;
      const step = Math.min(a.acc, 0.25); a.acc = 0;
      if (a.kind === 'horse') this.thinkHorse(a, step); else this.thinkSheep(a, step);
      this.locomote(a, step);
      this.poseStep(a, step);
      a.dirty = true;
    }
    this.separate();
    return this;
  }

  /* ---- helpers */
  bearingToPlayer(a) { return Math.atan2(this.px - a.x, this.pz - a.z); }
  pickDest(a, dmin, dmax, biasX, biasZ, bias = 0) {
    for (let tries = 0; tries < 8; tries++) {
      const ang = this.rnd() * TAU, d = dmin + this.rnd() * (dmax - dmin);
      let x = a.x + Math.sin(ang) * d, z = a.z + Math.cos(ang) * d;
      if (bias > 0) { x = lerp(x, biasX, bias); z = lerp(z, biasZ, bias); }
      if (this.ok(a, x, z) && this.G.clear(a.x, a.z, x, z, (px, pz) => this.ok(a, px, pz))) return { x, z };
    }
    return null;
  }
  ears(a, dt, fwdL, fwdR, scale = 1) {
    a.earTL -= dt; a.earTR -= dt;
    if (a.earTL <= 0) { a.earTL = 1.5 + this.rnd() * 5; a.earFL = (this.rnd() - 0.5) * 0.9 * scale; a.earFLd = 0.25 + this.rnd() * 0.5; }
    if (a.earTR <= 0) { a.earTR = 1.5 + this.rnd() * 5; a.earFR = (this.rnd() - 0.5) * 0.9 * scale; a.earFRd = 0.25 + this.rnd() * 0.5; }
    a.earLT = fwdL + (a.earTL < (a.earFLd ?? 0) ? a.earFL : 0);
    a.earRT = fwdR + (a.earTR < (a.earFRd ?? 0) ? a.earFR : 0);
  }
  tailStep(a, dt, allow) {
    a.tailTimer -= dt;
    if (allow && a.tailTimer <= 0 && a.swish <= 0) { a.tailTimer = 2 + this.rnd() * 8; a.swish = a.swishDur = 0.9 + this.rnd() * 0.9; a.swishAmp = 0.3 + this.rnd() * 0.35; }
    if (a.swish > 0) {
      a.swish -= dt;
      const u = 1 - Math.max(0, a.swish) / a.swishDur;
      a.tailY = a.swishAmp * Math.sin(u * 5 * TAU * 0.9) * Math.sin(Math.PI * u);
    } else a.tailY = 0;
  }

  /* ---- horse */
  thinkHorse(a, dt) {
    const P = a.P;
    a.t -= dt; a.cd -= dt;
    if (this.rainMode && a.state !== 'rain') { a.state = 'rain'; a.dest = null; a.rainWait = this.rnd() * 5; }
    if (!this.rainMode && a.state === 'rain') { a.state = 'graze'; a.t = 1 + this.rnd() * 6; }
    a.vT = 0; a.hT = NaN;
    let tailAllow = true, earF = 0, tl = 0.0;
    switch (a.state) {
      case 'graze': {
        a.neckT = P.grazeNeck; a.headT = P.grazeHead; a.stanceT = 1;
        a.tYaw -= dt; if (a.tYaw <= 0) { a.tYaw = 3 + this.rnd() * 6; a.grazeYaw = (this.rnd() - 0.5) * 1.0; }
        a.yawT = a.grazeYaw;
        a.chew += dt * 1.8; a.tear -= dt;
        if (a.tear <= 0) { a.tear = 2.5 + this.rnd() * 4; a.tearU = 0; }
        a.tearU = Math.min(1, a.tearU + dt * 1.6);
        const chew = 0.045 * Math.sin(a.chew * TAU) + 0.12 * Math.sin(Math.PI * a.tearU) * (a.tearU < 1 ? 1 : 0);
        a.neckT += chew; a.headT -= chew * 0.5;
        if (a.cd <= 0 && a.dP < 60 && !this.forceQuiet) {
          const k = 1 - a.dP / 60;
          if (this.rnd() < dt * (0.13 + 0.35 * k * k) * a.curious) this.startLook(a, 'player');
        }
        if (a.t <= 0) {
          const r = this.rnd();
          if (r < 0.5) a.t = 6 + this.rnd() * 12;
          else if (r < 0.85) this.startWalk(a, this.rnd() < 0.6);
          else if (r < 0.95) this.startLook(a, 'random');
          else this.startWalk(a, false);
        }
        break;
      }
      case 'look': {
        a.neckT = P.alertNeck + 0.04 * Math.sin(this.frame * 0.02 + a.i); a.headT = P.alertHead; a.stanceT = 0;
        earF = 0.55; tl = 0.12;
        if (a.look === 'player' && this.hasPlayer) {
          const b = this.bearingToPlayer(a), rel = wrap(b - a.h);
          a.yawT = clamp(rel, -1.15, 1.15);
          if (Math.abs(rel) > 0.95) a.hT = b;
          if (a.dP > 110 && !a.forced) a.t = Math.min(a.t, 0);
        } else {
          a.tYaw -= dt;
          if (a.tYaw <= 0) { a.tYaw = 1.5 + this.rnd() * 2; a.randYaw = (this.rnd() - 0.5) * 1.8; }
          a.yawT = a.randYaw;
        }
        if (a.t <= 0) { a.state = 'graze'; a.t = 5 + this.rnd() * 8; a.cd = 8 + this.rnd() * 10; a.forced = false; }
        break;
      }
      case 'walk': case 'tolt': {
        const fast = a.state === 'tolt';
        if (!a.dest) { a.state = 'graze'; a.t = 4; break; }
        const dx = a.dest.x - a.x, dz = a.dest.z - a.z, d = Math.hypot(dx, dz);
        if (d < (fast ? 1.4 : 0.8) || (fast && a.t <= 0)) { a.dest = null; a.state = 'graze'; a.t = 5 + this.rnd() * 8; a.stanceT = 0; break; }
        a.hT = Math.atan2(dx, dz);
        const dh = Math.abs(wrap(a.hT - a.h));
        let v = fast ? (d < 7 ? 1.7 : a.toltSpeed) : (a.grazeWalk ? 0.42 : a.walkSpeed);
        v *= dh > 0.9 ? 0.25 : 1;
        v *= Math.min(1, 0.4 + d / 2.5);
        a.vT = v;
        if (fast) { a.neckT = -0.2 + 0.05 * Math.sin(a.gPhase * TAU * 2); a.headT = 0.32; earF = 0.4; tl = 0.5; tailAllow = false; a.stanceT = 0; }
        else if (a.grazeWalk) { a.neckT = 1.15; a.headT = -0.62; a.stanceT = 0; a.yawT = 0.2 * Math.sin(a.gPhase * TAU); }
        else { a.neckT = 0.05 + 0.05 * Math.sin(a.gPhase * TAU); a.headT = 0.1; a.stanceT = 0; a.yawT = 0; earF = 0.15; }
        break;
      }
      case 'rain': {
        a.rainWait -= dt;
        if (a.rainWait <= 0) a.hT = this.windH;
        a.neckT = 0.6; a.headT = 0.15; a.stanceT = 0; earF = -0.6; tl = -0.3; tailAllow = false; a.yawT = 0;
        break;
      }
    }
    this.ears(a, dt, earF, earF, this.rainMode ? 0.2 : 1);
    this.tailStep(a, dt, tailAllow);
    const walk = Math.abs(a.speed) > 0.1;
    a.tailT = a.tailY + (walk ? (a.state === 'tolt' ? 0.16 : 0.06) * Math.sin(a.gPhase * TAU) : 0);
    a.tailLiftT = tl;
  }
  startLook(a, who) {
    a.state = 'look'; a.look = who; a.t = who === 'player' ? 3.5 + this.rnd() * 4 : 2 + this.rnd() * 3;
    a.randYaw = (this.rnd() - 0.5) * 1.8; a.tYaw = 1;
    // herd mates nearby get curious too
    if (who === 'player' && a.herd) for (const m of a.herd.members) if (m !== a && m.state === 'graze' && m.cd <= 0 && Math.hypot(m.x - a.x, m.z - a.z) < 15 && this.rnd() < 0.65) { m.state = 'look'; m.look = 'player'; m.t = 2.5 + this.rnd() * 3.5; }
  }
  startWalk(a, grazeWalk) {
    const H = a.herd;
    const d = grazeWalk ? this.pickDest(a, 1.5, 4.5, H?.ax, H?.az, 0) : this.pickDest(a, 4, 13, H?.ax, H?.az, H && Math.hypot(a.x - H.ax, a.z - H.az) > 22 ? 0.5 : 0);
    if (!d) { a.t = 4 + this.rnd() * 4; return false; }
    a.dest = d; a.state = 'walk'; a.grazeWalk = grazeWalk; a.t = 30;
    a.walkSpeed = 0.95 + this.rnd() * 0.3;
    return true;
  }
  updateHerds(dt) {
    for (const H of this.herds) {
      H.next -= dt;
      if (H.next > 0) continue;
      H.next = 15;
      if (this.rainMode || (this.hasPlayer && Math.hypot(H.ax - this.px, H.az - this.pz) > 300)) continue;
      const pool = H.members.filter((m) => m.active && (m.state === 'graze' || m.state === 'walk'));
      if (pool.length < 2) continue;
      const lead = pool[Math.floor(this.rnd() * pool.length)];
      let cand = null;
      for (let tries = 0; tries < 12 && !cand; tries++) {
        const ang = this.rnd() * TAU, d = 16 + this.rnd() * 16;
        const x = lead.x + Math.sin(ang) * d, z = lead.z + Math.cos(ang) * d;
        if (this.ok(lead, x, z) && this.G.clear(lead.x, lead.z, x, z, (px, pz) => this.ok(lead, px, pz))) cand = { x, z };
      }
      if (!cand) continue;
      const k = Math.min(pool.length, 2 + (this.rnd() < 0.45 ? 1 : 0));
      pool.sort((p, q) => Math.hypot(p.x - lead.x, p.z - lead.z) - Math.hypot(q.x - lead.x, q.z - lead.z));
      for (let n = 0; n < k; n++) this.startTolt(pool[n], cand.x + (this.rnd() - 0.5) * 4, cand.z + (this.rnd() - 0.5) * 4);
      H.ax = cand.x; H.az = cand.z;
      H.next = 110 + this.rnd() * 150;
    }
  }
  startTolt(m, x, z) {
    const okp = (px, pz) => this.ok(m, px, pz);
    if (!this.ok(m, x, z) || !this.G.clear(m.x, m.z, x, z, okp)) { x = m.x + Math.sin(m.h) * 15; z = m.z + Math.cos(m.h) * 15; if (!this.ok(m, x, z) || !this.G.clear(m.x, m.z, x, z, okp)) return false; }
    m.dest = { x, z }; m.state = 'tolt'; m.t = 18; m.toltSpeed = 3.3 + this.rnd() * 0.6; m.grazeWalk = false;
    return true;
  }

  /* ---- sheep */
  updateFlocks(dt) {
    for (const F of this.flocks) {
      let sx = 0, sz = 0, n = 0;
      for (const m of F.members) if (m.active) { sx += m.x; sz += m.z; n++; }
      if (!n) continue;
      F.cx = sx / n; F.cz = sz / n;
      F.R = damp(F.R, this.rainMode ? 1.6 : 3.2 + 0.25 * F.members.length, 0.6, dt);
      F.next -= dt; F.sinceMove += dt;
      if (F.next <= 0) {
        F.next = 15;
        if (this.rainMode || (this.hasPlayer && Math.hypot(F.ax - this.px, F.az - this.pz) > 320)) continue;
        // pick a new grazing spot 10-26 m away
        let nx = 0, nz = 0, found = false;
        const probe = { kind: 'sheep' };
        for (let tries = 0; tries < 10 && !found; tries++) {
          const ang = this.rnd() * TAU, d = 9 + this.rnd() * 14;
          nx = F.ax + Math.sin(ang) * d; nz = F.az + Math.cos(ang) * d;
          found = this.ok(probe, nx, nz) && this.ok(probe, nx + 3, nz) && this.ok(probe, nx - 3, nz) && this.ok(probe, nx, nz + 3) && this.ok(probe, nx, nz - 3)
            && this.G.clear(F.ax, F.az, nx, nz, (px, pz) => this.ok(probe, px, pz));
        }
        if (!found) continue;
        F.ax = nx; F.az = nz;
        F.next = 90 + this.rnd() * 120; F.sinceMove = 0;
        for (const m of F.members) if (m.active) { m.pendDest = this.diskAround(F, m); m.pendDelay = this.rnd() * 7; }
      }
    }
  }
  diskAround(F, m) {
    for (let t = 0; t < 8; t++) {
      const ang = this.rnd() * TAU, r = Math.sqrt(this.rnd()) * F.R;
      const x = F.ax + Math.sin(ang) * r, z = F.az + Math.cos(ang) * r;
      if (this.ok(m, x, z) && this.G.clear(m.x, m.z, x, z, (px, pz) => this.ok(m, px, pz))) return { x, z };
    }
    return { x: F.ax, z: F.az };
  }
  startSheepWalk(a, dest, grazeWalk) {
    if (!dest) return;
    a.dest = dest; a.state = 'walk'; a.grazeWalk = !!grazeWalk; a.t = 25; a.walkSpeed = 0.5 + this.rnd() * 0.3;
  }
  startRun(a, dest) {
    a.dest = dest; a.state = 'run'; a.t = 9; a.runSpeed = 2.4 + this.rnd() * 0.5;
  }
  startle(a, playerPos = true) {
    a.state = 'startle'; a.sT = 0; a.t = 2.4; a.scareCD = 14 + this.rnd() * 8; a.dest = null; a.pendDest = null;
    const F = a.flock;
    if (F && playerPos) for (const m of F.members) if (m !== a && m.active && m.state !== 'startle' && m.scareCD <= 0 && Math.hypot(m.x - a.x, m.z - a.z) < 14) m.startleDelay = 0.12 + this.rnd() * 0.5;
  }
  thinkSheep(a, dt) {
    const P = a.P, F = a.flock;
    a.t -= dt; a.cd -= dt; a.scareCD -= dt;
    if (this.rainMode && a.state !== 'rain') { a.state = 'rain'; a.dest = null; a.pendDest = null; a.rainWait = this.rnd() * 4; }
    if (!this.rainMode && a.state === 'rain') { a.state = 'graze'; a.t = 1 + this.rnd() * 4; }
    if (a.startleDelay > 0) { a.startleDelay -= dt; if (a.startleDelay <= 0 && a.state !== 'startle') this.startle(a, false); }
    // fast player close by
    if (a.state !== 'startle' && a.scareCD <= 0 && a.dP < 55 && this.pSpeed > 7 && !this.forceQuiet) {
      if (this.rnd() < dt * 4 * (1 - a.dP / 62)) this.startle(a, true);
    }
    a.vT = 0; a.hT = NaN;
    let earF = 0.05, tailAllow = true;
    a.gTypeT = 0;
    if (a.pendDest) { a.pendDelay -= dt; if (a.pendDelay <= 0 && (a.state === 'graze' || a.state === 'look')) { this.startSheepWalk(a, a.pendDest, this.rnd() < 0.4); a.pendDest = null; } }
    switch (a.state) {
      case 'graze': {
        a.neckT = P.grazeNeck; a.headT = P.grazeHead; a.yawT = a.grazeYaw;
        a.tYaw -= dt; if (a.tYaw <= 0) { a.tYaw = 2 + this.rnd() * 4; a.grazeYaw = (this.rnd() - 0.5) * 0.8; }
        a.chew += dt * 2.6;
        a.neckT += 0.03 * Math.sin(a.chew * TAU); a.headT += 0.05 * Math.sin(a.chew * TAU + 1);
        earF = 0.05;
        if (a.cd <= 0 && a.dP < 55 && !this.forceQuiet && this.rnd() < dt * 0.12 * (1 - a.dP / 55) * a.curious) { a.state = 'look'; a.look = 'player'; a.t = 2 + this.rnd() * 3; }
        // stay with the flock
        if (F && !a.pendDest && F.sinceMove > 14) {
          const dA = Math.hypot(a.x - F.ax, a.z - F.az);
          if (dA > F.R + 8) { this.startRun(a, this.diskAround(F, a)); break; }
          if (dA > F.R + 3) { this.startSheepWalk(a, this.diskAround(F, a), false); break; }
        }
        if (a.t <= 0) {
          const r = this.rnd();
          if (r < 0.62) a.t = 4 + this.rnd() * 9;
          else if (r < 0.85 && F) { const d = this.diskAround(F, a); if (Math.hypot(d.x - a.x, d.z - a.z) > 0.8 && Math.hypot(d.x - a.x, d.z - a.z) < 6) this.startSheepWalk(a, d, true); else a.t = 4; }
          else if (r < 0.92) { a.state = 'look'; a.look = 'random'; a.t = 1.5 + this.rnd() * 2.5; a.randYaw = (this.rnd() - 0.5) * 1.6; }
          else a.t = 3 + this.rnd() * 3;
        }
        break;
      }
      case 'look': {
        a.neckT = P.alertNeck; a.headT = P.alertHead; earF = 0.5;
        if (a.look === 'player' && this.hasPlayer) {
          const b = this.bearingToPlayer(a), rel = wrap(b - a.h);
          a.yawT = clamp(rel, -1.1, 1.1); if (Math.abs(rel) > 1.0) a.hT = b;
          if (a.dP > 90 && !a.forced) a.t = Math.min(a.t, 0);
        } else a.yawT = a.randYaw;
        if (a.t <= 0) { a.state = 'graze'; a.t = 3 + this.rnd() * 5; a.cd = 10 + this.rnd() * 10; a.forced = false; }
        break;
      }
      case 'walk': {
        if (!a.dest) { a.state = 'graze'; a.t = 2; break; }
        const dx = a.dest.x - a.x, dz = a.dest.z - a.z, d = Math.hypot(dx, dz);
        if (d < 0.7 || a.t <= 0) { a.dest = null; a.state = 'graze'; a.t = 2 + this.rnd() * 5; break; }
        a.hT = Math.atan2(dx, dz);
        const dh = Math.abs(wrap(a.hT - a.h));
        a.vT = (a.grazeWalk ? 0.28 : a.walkSpeed) * (dh > 0.9 ? 0.3 : 1) * Math.min(1, 0.4 + d / 2);
        if (a.grazeWalk) { a.neckT = 0.75; a.headT = 0.5; a.yawT = 0; } else { a.neckT = 0.2; a.headT = 0.15; a.yawT = 0; earF = 0.15; }
        break;
      }
      case 'run': {
        if (!a.dest) { a.state = 'graze'; a.t = 2; break; }
        const dx = a.dest.x - a.x, dz = a.dest.z - a.z, d = Math.hypot(dx, dz);
        if (d < 1.3 || a.t <= 0) { a.dest = null; a.state = 'graze'; a.t = 2 + this.rnd() * 4; break; }
        a.hT = Math.atan2(dx, dz);
        const dh = Math.abs(wrap(a.hT - a.h));
        a.vT = (d < 4 ? 1.2 : a.runSpeed) * (dh > 1.0 ? 0.3 : 1);
        a.gTypeT = 1.4; a.neckT = -0.12; a.headT = 0.0; a.yawT = 0; earF = 0.5; tailAllow = false;
        break;
      }
      case 'startle': {
        a.sT += dt;
        a.neckT = -0.12; a.headT = -0.15; earF = 0.7; a.yawT = 0;
        if (this.hasPlayer) a.hT = this.bearingToPlayer(a);
        a.vT = a.sT > 0.2 && a.sT < 1.2 ? -0.9 : 0;
        a.gTypeT = 0;
        if (a.t <= 0) {
          a.state = 'look'; a.look = 'player'; a.t = 2 + this.rnd() * 2; a.cd = 12; a.forced = false;
          if (F && this.rnd() < 0.4 && Math.hypot(a.x - F.ax, a.z - F.az) > 3) { this.startRun(a, this.diskAround(F, a)); }
        }
        break;
      }
      case 'rain': {
        a.rainWait -= dt;
        if (a.rainWait <= 0) a.hT = this.windH;
        a.neckT = 0.8; a.headT = 0.5; earF = -0.3; tailAllow = false; a.yawT = 0;
        if (F) {
          const dA = Math.hypot(a.x - F.ax, a.z - F.az);
          if (dA > F.R + 1.2 && a.rainWait <= 0) { a.dest = this.diskAround(F, a); a.state = 'walk'; a.grazeWalk = false; a.t = 20; a.walkSpeed = 0.7; this.rainWalk = true; }
        }
        break;
      }
    }
    this.ears(a, dt, earF, earF, 0.6);
    this.tailStep(a, dt, tailAllow);
    a.tailT = a.tailY * 0.6;
    a.tailLiftT = 0;
    // hop while startled
    a.hop = a.state === 'startle' && a.sT < 0.32 ? 0.07 * Math.sin(Math.PI * a.sT / 0.32) : 0;
    // sheep return to 'rain' after walking into place during rain
    if (this.rainMode && a.state === 'graze') a.state = 'rain';
  }

  /* ---- locomotion */
  locomote(a, dt) {
    const P = a.P;
    if (!Number.isNaN(a.hT)) {
      const dh = wrap(a.hT - a.h);
      const rate = Math.abs(a.speed) > 0.3 ? P.turnMoving : P.turnStill;
      const tv = clamp(dh * 2.5, -rate, rate);
      a.turnV = damp(a.turnV, tv, 6, dt);
      const step = a.turnV * dt;
      a.h = wrap(a.h + (Math.abs(step) > Math.abs(dh) ? dh : step));
    } else a.turnV = damp(a.turnV, 0, 8, dt);
    const dv = a.vT - a.speed;
    a.speed += clamp(dv, -P.decel * dt, (a.state === 'tolt' || a.state === 'run' ? 1.6 : P.accel) * dt);
    if (Math.abs(a.speed) > 0.005) {
      const nx = a.x + Math.sin(a.h) * a.speed * dt, nz = a.z + Math.cos(a.h) * a.speed * dt;
      if (this.ok(a, nx, nz)) { a.x = nx; a.z = nz; a.moved = true; }
      else { a.speed = 0; if (a.state === 'walk' || a.state === 'tolt' || a.state === 'run') { a.dest = null; a.state = 'graze'; a.t = 3; } }
    }
    if (Math.abs(a.turnV) > 0.02) a.moved = true;
    // gait
    const sp = Math.abs(a.speed);
    const moving = sp > 0.06;
    const turning = !moving && Math.abs(a.turnV) > 0.3;
    let ampT = 0;
    if (moving) ampT = lerp(P.walkAmp * 0.85, P.toltAmp, clamp((sp - (a.kind === 'horse' ? 0.6 : 0.5)) / (a.kind === 'horse' ? 2.6 : 1.9), 0, 1));
    else if (turning) ampT = P.walkAmp * 0.6;
    a.gAmp = damp(a.gAmp, ampT, 7, dt);
    let rate = 0;
    if (moving) rate = Math.sign(a.speed) * sp * P.stance / (2 * Math.max(a.gAmp, 0.3) * P.legLen);
    else if (turning) rate = 0.7;
    else if (a.gAmp > 0.02) rate = 0.5;
    a.gPhase = (a.gPhase + rate * dt) % 1; if (a.gPhase < 0) a.gPhase += 1;
    a.gType = damp(a.gType, a.gTypeT ?? 0, 5, dt);
    // body bob (double-time), hop
    const amp = a.kind === 'horse' ? (a.state === 'tolt' ? 0.018 : 0.01) : 0.012;
    a.bob = a.hop + (moving ? amp * Math.abs(Math.sin(a.gPhase * TAU * 2)) * clamp(sp / 0.8, 0, 1) : 0);
  }

  poseStep(a, dt) {
    const P = a.P;
    const kn = a.neckT > a.neck ? 1.5 : 3.0, kh = a.headT > a.head ? 1.6 : 3.2;
    a.neck = damp(a.neck, a.neckT, a.state === 'startle' ? 9 : kn, dt);
    a.head = damp(a.head, a.headT, a.state === 'startle' ? 9 : kh, dt);
    a.yaw = damp(a.yaw, a.yawT, 3, dt);
    a.earL = damp(a.earL, a.earLT, 8, dt); a.earR = damp(a.earR, a.earRT, 8, dt);
    a.tail = a.tailT ?? 0;
    a.tailLift = damp(a.tailLift, a.tailLiftT, 3, dt);
    if (a.kind === 'horse') a.stance = damp(a.stance, a.stanceT, 1.2, dt);
    // terrain fit
    if (a.moved) {
      const s = Math.sin(a.h), c = Math.cos(a.h), L = (a.kind === 'horse' ? 0.62 : 0.3) * a.sc, W = (a.kind === 'horse' ? 0.28 : 0.2) * a.sc;
      const G = this.G;
      const hF = G.hAt(a.x + s * L, a.z + c * L), hR = G.hAt(a.x - s * L, a.z - c * L);
      const hL = G.hAt(a.x + c * W, a.z - s * W), hRt = G.hAt(a.x - c * W, a.z + s * W);
      a.y = (hF + hR) * 0.5;
      const pt = Math.atan2(hR - hF, 2 * L), rt = Math.atan2(hL - hRt, 2 * W);
      a.pitch = damp(a.pitch, pt, 8, dt); a.roll = damp(a.roll, rt, 8, dt);
      a.moved = Math.abs(a.pitch - pt) > 0.002 || Math.abs(a.roll - rt) > 0.002 || Math.abs(a.speed) > 0.005 || Math.abs(a.turnV) > 0.02;
      a.mDirty = true;
    }
  }

  /* ---- separation (soft, circle-based) */
  separate() {
    const A = this.agents;
    for (let i = 0; i < A.length; i++) {
      const a = A[i]; if (!a.active) continue;
      for (let j = i + 1; j < A.length; j++) {
        const b = A[j]; if (!b.active) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const r = a.P.radius * a.sc + b.P.radius * b.sc + (a.kind !== b.kind ? 0.15 : 0);
        if (dx > r || dx < -r || dz > r || dz < -r) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2) || 0.001, push = (r - d) * 0.5, nx = dx / d, nz = dz / d;
        // heavier (horse) moves less
        const wa = a.kind === 'horse' ? 0.35 : 0.65, wb = b.kind === 'horse' ? 0.35 : 0.65, sum = wa + wb;
        const ax = a.x - nx * push * 2 * wa / sum, az = a.z - nz * push * 2 * wa / sum;
        const bx = b.x + nx * push * 2 * wb / sum, bz = b.z + nz * push * 2 * wb / sum;
        if (this.ok(a, ax, az)) { a.x = ax; a.z = az; a.moved = true; }
        if (this.ok(b, bx, bz)) { b.x = bx; b.z = bz; b.moved = true; }
      }
    }
  }

  /* ---- write to instance buffers */
  writeAll(buf) {
    const m = this._m, q = this._q, e = this._e, pos = this._pos, sc = this._sc;
    for (const a of this.agents) {
      const i = a.i, arr = buf[a.kind];
      if (a.mDirty || a.first === undefined) {
        e.set(a.pitch, a.h, a.roll, 'YXZ'); q.setFromEuler(e);
        pos.set(a.x, a.y, a.z); sc.set(a.sc, a.sc, a.sc);
        m.compose(pos, q, sc); m.toArray(arr.matrix.array, i * 16);
        a.mDirty = false; a.first = 1; arr.matrixDirty = true;
      }
      if (a.dirty || a.first === 1) {
        const o = i * 4;
        arr.p0[o] = a.neck; arr.p0[o + 1] = a.head; arr.p0[o + 2] = a.yaw; arr.p0[o + 3] = a.tail;
        arr.p1[o] = a.gPhase; arr.p1[o + 1] = a.gAmp; arr.p1[o + 2] = a.gType; arr.p1[o + 3] = a.bob;
        arr.p2[o] = a.earL; arr.p2[o + 1] = a.earR; arr.p2[o + 2] = a.tailLift; arr.p2[o + 3] = a.kind === 'horse' ? a.stance : a.horn;
        a.dirty = false; a.first = 2; arr.poseDirty = true;
      }
    }
  }

  /* ---- debug / preview helpers */
  force(kind, what) {
    const list = kind === 'horse' ? this.horses : kind === 'sheep' ? this.sheep : this.agents;
    for (const a of list) {
      if (!a.active) continue;
      a.forced = true; a.dest = null; a.pendDest = null;
      if (what === 'graze') { a.state = 'graze'; a.t = 12; a.cd = 30; }
      else if (what === 'look') { if (a.kind === 'horse') this.startLook(a, 'player'); else { a.state = 'look'; a.look = 'player'; a.t = 5; } a.t = 6; }
      else if (what === 'walk') { if (a.kind === 'horse') this.startWalk(a, false); else { const d = this.pickDest(a, 4, 9, 0, 0, 0); if (d) this.startSheepWalk(a, d, false); } }
      else if (what === 'tolt') { if (a.kind === 'horse') { const x = a.x + Math.sin(a.h) * 18, z = a.z + Math.cos(a.h) * 18; const d = this.ok(a, x, z) ? { x, z } : this.pickDest(a, 14, 22, 0, 0, 0); if (d) this.startTolt(a, d.x, d.z); } else { const d = this.pickDest(a, 8, 14, 0, 0, 0); if (d) this.startRun(a, d); } }
      else if (what === 'startle') { if (a.kind === 'sheep') this.startle(a, false); else this.startLook(a, 'player'); }
      a.forced = false;
    }
  }
}
