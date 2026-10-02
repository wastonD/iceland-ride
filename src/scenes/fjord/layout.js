// Fjord valley design (Walter-Mitty-style longboard descent in Iceland).
// Coordinates: metres, +X east, +Z south, +Y up. Sea level y = 0.
//
//   north  z≈-1500  highland plateau (≈200 m) — ride starts here
//          z≈-1250  valley head wall: switchbacks descend ≈110 m
//          z -900…850  U-shaped glacial valley, terraced basalt walls, river, waterfalls
//   south  z≈850    colourful village + church on the shore, fjord opens to the sea
//
// Same world API shape as the rainforest layout (heightAt, normalAt, waterLevelAt…),
// plus `path` — the rideable road used by the skate controller.

import * as THREE from 'three';
import { fbm2f as fbm2, noise2f, smoothstep, clamp, lerp } from '../../core/noise.js';

export const HALF = 2048;             // heightfield covers [-2048,2048]²
const RES = 4;                        // metres per sample
const N = (HALF * 2) / RES + 1;       // 1025
export const SEA_LEVEL = 0;

/* ------------------------------------------------------------ valley macro */
// Valley centre line x(z) — gentle S-bend so the view keeps changing.
const valleyX = (z) => 120 * Math.sin(z * 0.0016 + 0.6) + 60 * Math.sin(z * 0.0041);
// Valley floor elevation along z.
function floorY(z) {
  const plateau = 205;
  const headWall = lerp(plateau, 92, smoothstep(-1330, -880, z));          // head-wall drop
  const run = lerp(92, 2, smoothstep(-880, 820, z));                        // long gentle run
  const fjord = lerp(0, -45, smoothstep(820, 1250, z));                     // floor sinks into the fjord
  if (z < -880) return headWall;
  if (z < 820) return run;
  return Math.min(run, 2) + fjord;
}

function macroHeight(x, z) {
  const cx = valleyX(z);
  const dx = Math.abs(x - cx);
  // valley half-width widens toward the sea
  const halfFloor = lerp(260, 420, smoothstep(-900, 1200, z));
  const wallRise = smoothstep(halfFloor, halfFloor + 780, dx);
  const ridgeH = 620 + 180 * fbm2(x * 0.0012, z * 0.0012, 3, 41);
  let h = floorY(z) + Math.pow(wallRise, 1.55) * ridgeH;

  // The plateau is open highland: fade the walls out north of the head wall
  const onPlateau = 1 - smoothstep(-1500, -1250, z);
  h = lerp(h, 205 + 40 * wallRise, onPlateau * 0.85);

  // Basalt terraces (Iceland's stepped mountains) on the walls — irregular: the step
  // height, phase and strength wander so the layers read as geology, not stripes.
  const stepH = 34 + 16 * fbm2(x * 0.0009, z * 0.0009, 2, 44);
  const t = (h + 22 * fbm2(x * 0.0025, z * 0.0025, 3, 45)) / stepH;
  const terr = (Math.floor(t) + smoothstep(0.2, 0.8, t - Math.floor(t))) * stepH;
  const terrStrength = 0.32 * smoothstep(-0.35, 0.35, fbm2(x * 0.0015, z * 0.0015, 2, 46));
  const terrMask = smoothstep(0.2, 0.55, wallRise) * (1 - onPlateau);
  h = lerp(h, terr, terrStrength * terrMask);

  // Rolling detail: soft on the floor, stronger on the walls
  h += fbm2(x * 0.004, z * 0.004, 5, 42) * lerp(6, 28, wallRise);
  h += fbm2(x * 0.02, z * 0.02, 3, 43) * lerp(1.2, 4, wallRise);

  // River channel down the valley floor
  const rx = cx + 40 * Math.sin(z * 0.006);
  const rd = Math.abs(x - rx);
  if (z > -900) h -= 3.2 * (1 - smoothstep(4, 22, rd)) * (1 - onPlateau);
  return h;
}

/* ------------------------------------------------------------------ road */
// Hand-designed control points (x, z). Heights come from the terrain, smoothed.
const ROAD_XZ = [
  [-260, -1560], [-230, -1480], [-180, -1400], [-150, -1330],            // plateau run-in
  // head-wall switchbacks (west ↔ east legs, descending southward)
  [-60, -1290], [110, -1250], [180, -1210], [150, -1170], [40, -1150],
  [-160, -1120], [-260, -1085], [-270, -1040], [-190, -1010], [0, -985],
  [160, -950], [205, -905], [150, -865], [20, -845], [-140, -820],
  // valley run along the west side, above the river
  [-250, -760], [-300, -620], [-310, -460], [-285, -300], [-300, -140],
  [-330, 20], [-320, 180], [-290, 340], [-300, 480], [-280, 600],
  [-230, 700], [-170, 770], [-120, 820], [-80, 850],                     // into the village
];

const roadCurve = new THREE.CatmullRomCurve3(ROAD_XZ.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
const ROAD_LEN = roadCurve.getLength();
const ROAD_STEP = 1;                                    // one sample per metre
const ROAD_N = Math.floor(ROAD_LEN / ROAD_STEP);
const roadPts = roadCurve.getSpacedPoints(ROAD_N);      // y filled below
export const ROAD_WIDTH = 7.5;                          // asphalt width (m)
const SHOULDER = 1.5;

// Road elevation: base terrain (no set-piece features) sampled along the road, heavily
// smoothed and grade-limited, then shaped with designed rollers: climbs that bleed speed,
// dips, and short crests that throw a fast rider into the air.
// Each bump: { s, A (m, + = crest), sig (m) } — gaussian in arc length.
export const ROAD_BUMPS = [
  // kickers: rise over `run` m to height A with a lip, then fall away over `land` m —
  // a fast rider leaves the lip going up and lands on the down-slope (real air, soft landing)
  { s: 820, A: 1.6, run: 14, land: 22, kick: true },   // switchback straights
  { s: 965, A: 1.6, run: 14, land: 22, kick: true },
  { s: 1290, A: 1.6, run: 14, land: 22, kick: true },
  { s: 1440, A: 1.6, run: 14, land: 22, kick: true },
  { s: 2470, A: 1.6, run: 14, land: 22, kick: true },  // out of the tunnel, down toward the canyon
  { s: 2575, A: 1.6, run: 14, land: 22, kick: true },
  { s: 3080, A: 1.6, run: 14, land: 22, kick: true },  // pasture
  { s: 3235, A: 1.6, run: 14, land: 22, kick: true },
  { s: 3395, A: 1.6, run: 14, land: 22, kick: true },
  { s: 3480, A: 1.6, run: 14, land: 22, kick: true },  // black-sand coast
];
/** Height offset (m) of one bump at arc length x. `s` is the lip. */
export function bumpAt(b, x) {
  if (!b.kick) return b.A * Math.exp(-(((x - b.s) / b.sig) ** 2));
  const d = x - b.s;
  if (d < -b.run || d > b.land) return 0;
  if (d <= 0) { const u = 1 + d / b.run; return b.A * u * u; }          // quadratic ramp → slope 2A/run at the lip
  const u = 1 - d / b.land; return b.A * u * u;                         // landing: steepest at the lip, flattening out
}
// Segments replaced by a straight grade so the whole ride keeps falling (no climbs):
// [s0, s1, raise at s0 (m)] — the start sits a little higher and rolls off on its own.
const ROAD_LINEAR = [[0, 450, 7], [1650, 2620, 0]];
(function profileRoad() {
  const raw = roadPts.map((p) => macroHeight(p.x, p.z));
  const sm = raw.slice();
  for (let pass = 0; pass < 3; pass++) {
    const src = sm.slice();
    const W = 40;
    for (let i = 0; i < sm.length; i++) {
      let s = 0, n = 0;
      for (let k = -W; k <= W; k++) { const j = clamp(i + k, 0, sm.length - 1); s += src[j]; n++; }
      sm[i] = s / n;
    }
  }
  const MAX_GRADE = 0.09;
  for (let i = 1; i < sm.length; i++) sm[i] = clamp(sm[i], sm[i - 1] - MAX_GRADE * ROAD_STEP, sm[i - 1] + MAX_GRADE * ROAD_STEP);
  if (globalThis.__rawProfile) globalThis.__rawProfile(sm);
  for (const [s0, s1, raise] of ROAD_LINEAR) {
    const i0 = Math.round(s0 / ROAD_STEP), i1 = Math.min(sm.length - 1, Math.round(s1 / ROAD_STEP));
    const y0 = sm[i0] + raise, y1 = sm[i1];
    for (let i = i0; i <= i1; i++) sm[i] = y0 + (y1 - y0) * ((i - i0) / (i1 - i0));
  }
  for (let i = 0; i < sm.length; i++) {
    for (const b of ROAD_BUMPS) sm[i] += bumpAt(b, i * ROAD_STEP);
    sm[i] = Math.max(sm[i], 2.5);                         // never below the shore
  }
  for (let i = 0; i < roadPts.length; i++) roadPts[i].y = sm[i] + 0.25;
})();

/* ------------------------------------------------------------- landmarks */
const endP = roadPts[roadPts.length - 1];
export const landmarks = {
  pass: { x: roadPts[0].x, z: roadPts[0].z, radius: 30, label: '山口' },
  village: { x: -40, z: 900, radius: 140, label: '峡湾小镇' },
  church: { x: -95, z: 885, radius: 10, label: '蓝色教堂' },
  roadEnd: { x: endP.x, z: endP.z, radius: 20, label: '终点' },
};


/* -------------------------------------------------------------- set pieces */
// Scenic beats along the ride, north → south. Other modules (water, flora, props,
// audio) read these to build the actual content.
const segDist = (x, z, ax, az, bx, bz) => {
  const abx = bx - ax, abz = bz - az;
  const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1);
  return { d: Math.hypot(ax + abx * t - x, az + abz * t - z), t };
};
export const features = {
  // snow peaks NE of the plateau, with a valley glacier whose tongue ends above the lake
  peaks: [
    { x: 820, z: -1860, h: 780, r: 380 }, { x: 1260, z: -1440, h: 900, r: 420 },
    { x: 1560, z: -1960, h: 1000, r: 520 }, { x: 640, z: -1290, h: 480, r: 240 },
  ],
  glacier: { ax: 1180, az: -1680, bx: 430, bz: -1545, yTop: 760, yEnd: 238, wTop: 170, wEnd: 70 },
  // mirror lake on the plateau (water surface at `level`)
  lake: { x: -60, z: -1480, rx: 115, rz: 62, level: 203.2 },
  // geothermal field + hot spring pool beside the plateau road
  geothermal: { x: -128, z: -1358, r: 46, pool: { x: -120, z: -1352, r: 11, level: 203.8 } },
  // waterfall right beside the eastern hairpin: cliff top → pool by the road
  // (top.y / bottom.y are filled in after the terrain is built)
  hairpinFall: { x: 236, z: -957, top: { x: 262, y: 0, z: -952 }, bottom: { x: 228, y: 0, z: -904 }, width: 9, pool: { x: 228, z: -904, r: 8 } },
  // basalt-column canyon crossed by the road on a bridge; Svartifoss-style fall at its head
  gorge: { ax: -520, az: -228, bx: -60, bz: -150, depthHead: 24, depthMouth: 7, wTopHead: 21, wTopMouth: 15, wFloor: 5 },
  farm: { x: -190, z: 420, r: 45, label: '草皮屋农场' },
  pasture: { x0: -260, x1: -40, z0: 230, z1: 660 },       // horses + sheep roam here
  bay: { x: -20, z: 700, rx: 200, rz: 130 },               // sea inlet, black-sand beach on its west shore
  lighthouse: { x: 205, z: 688 },                          // red/white, across the bay from the road
};

function featureHeight(x, z, h) {
  const F = features;
  // peaks
  for (const p of F.peaks) {
    const d2 = ((x - p.x) ** 2 + (z - p.z) ** 2) / (p.r * p.r);
    if (d2 < 9) h = Math.max(h, 205 + p.h * Math.exp(-d2 * 1.6) * (0.9 + 0.1 * fbm2(x * 0.004, z * 0.004, 3, 60)));
  }
  // glacier: smooth ice valley descending between the peaks
  {
    const G = F.glacier, { d, t } = segDist(x, z, G.ax, G.az, G.bx, G.bz);
    const w = lerp(G.wTop, G.wEnd, t) * (1 + 0.18 * fbm2(x * 0.008, z * 0.008, 2, 71)), iceY = lerp(G.yTop, G.yEnd, Math.pow(t, 0.8));
    const m = 1 - smoothstep(w * 0.75, w * 1.35, d);
    if (m > 0) h = lerp(h, iceY + 12 * (1 - (d / w) ** 2), m);
  }
  // plateau lake basin
  {
    const L = F.lake, r = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz) * (1 + 0.16 * fbm2(x * 0.012, z * 0.012, 3, 66));
    if (r < 1.6) h = lerp(h, L.level - 3.5 * (1 - r * r), 1 - smoothstep(0.85, 1.35, r));
  }
  // geothermal field: low mound, pool basin
  {
    const G = F.geothermal, d = Math.hypot(x - G.x, z - G.z) * (1 + 0.3 * fbm2(x * 0.03, z * 0.03, 3, 67));
    if (d < G.r * 1.5) {
      h += 1.2 * (1 - smoothstep(0, G.r, d)) * (0.6 + 0.4 * fbm2(x * 0.08, z * 0.08, 2, 61));
      const P = G.pool, dp = Math.hypot(x - P.x, z - P.z);
      h = lerp(h, P.level - 1.4, 1 - smoothstep(P.r * 0.7, P.r * 1.25, dp));
    }
  }
  // hairpin waterfall: a 28 m basalt cliff above the hairpin, plunge pool at its foot
  {
    const W = F.hairpinFall;
    const mx = 1 - smoothstep(26, 44, Math.abs(x - W.x));
    if (mx > 0) h += 28 * mx * smoothstep(-947, -962, z) * (1 - smoothstep(-1010, -1060, z));
    const dp = Math.hypot(x - W.pool.x, z - W.pool.z);
    if (dp < W.pool.r * 1.6) h -= 2.2 * (1 - smoothstep(W.pool.r * 0.6, W.pool.r * 1.4, dp));
  }
  // rock ridge the road tunnels through (~300 m): flat-ish crown, steep rocky faces at both
  // ends so the portals sit in a natural cliff instead of a retaining wall
  {
    const along = Math.abs(z + 655) + 10 * fbm2(x * 0.02, z * 0.02, 2, 63);
    const face = 1 - smoothstep(118, 150, along);
    const east = 1 - smoothstep(-210, -110, x + 25 * fbm2(x * 0.01, z * 0.01, 2, 64));
    if (face * east > 0) h += (46 + 10 * fbm2(x * 0.012, z * 0.012, 3, 65)) * face * east;
  }
  // basalt canyon: near-vertical walls, depth falling toward the river
  {
    const G = F.gorge, { d, t } = segDist(x, z, G.ax, G.az, G.bx, G.bz);
    const wTop = lerp(G.wTopHead, G.wTopMouth, t);
    if (d < wTop) {
      const prof = Math.pow(clamp((wTop - d) / (wTop - G.wFloor), 0, 1), 0.3);
      h -= lerp(G.depthHead, G.depthMouth, t) * prof;
    }
  }
  // farm: gentle flat
  {
    const Fm = F.farm, d = Math.hypot(x - Fm.x, z - Fm.z) * (1 + 0.25 * fbm2(x * 0.02, z * 0.02, 2, 68));
    if (d < Fm.r * 2.2) h = lerp(h, floorY(z) + 4 + 0.8 * fbm2(x * 0.05, z * 0.05, 2, 69), (1 - smoothstep(Fm.r * 0.8, Fm.r * 2.2, d)) * 0.45);
  }
  // bay + black-sand beach
  {
    const B = F.bay, r = Math.hypot((x - B.x) / B.rx, (z - B.z) / B.rz) * (1 + 0.1 * fbm2(x * 0.01, z * 0.01, 3, 70));
    if (r < 1.25) {
      const target = r < 0.92 ? -4.5 * smoothstep(0.92, 0.65, r) - 0.4 : (r - 0.92) / 0.13 * 2.2;
      h = lerp(h, target, 1 - smoothstep(1.0, 1.22, r));
    }
  }
  // lighthouse point
  {
    const Lh = F.lighthouse, d = Math.hypot(x - Lh.x, z - Lh.z);
    if (d < 40) h = Math.max(h, 5.5 * (1 - smoothstep(12, 38, d)) + 0.5 * fbm2(x * 0.1, z * 0.1, 2, 62));
  }
  return h;
}

/* ------------------------------------------------------ water-cut relief */
// Post-pass on the finished macro grid (terrain-owned): gullies down the fall line of every
// steep slope, so the walls read as water-cut basalt (fluted faces, notched skyline) instead
// of smooth dough. Never within 150 m of the road (the road profile and cut banks are
// designed there), fades out on gentle ground and around the set pieces.
function sculptMountains(H, roadD) {
  const t0 = performance.now();
  // Work on an 8 m grid (gullies are ≥ 40 m wide), then upsample the cut onto the 4 m grid.
  const C = 2, NC = (N - 1) / C + 1, RC = RES * C;
  // 1. smoothed heights (box blur, 88 m wide) → large-scale fall line
  const S = new Float32Array(NC * NC), T = new Float32Array(NC * NC), R = 5, inv = 1 / (2 * R + 1);
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) S[j * NC + i] = H[j * C * N + i * C];
  {
    for (let j = 0; j < NC; j++) {
      const o = j * NC; let s = 0;
      for (let i = -R; i <= R; i++) s += S[o + clamp(i, 0, NC - 1)];
      for (let i = 0; i < NC; i++) { T[o + i] = s * inv; s += S[o + Math.min(i + R + 1, NC - 1)] - S[o + Math.max(i - R, 0)]; }
    }
    for (let i = 0; i < NC; i++) {
      let s = 0;
      for (let j = -R; j <= R; j++) s += T[clamp(j, 0, NC - 1) * NC + i];
      for (let j = 0; j < NC; j++) { S[j * NC + i] = s * inv; s += T[Math.min(j + R + 1, NC - 1) * NC + i] - T[Math.max(j - R, 0) * NC + i]; }
    }
  }
  const F = features, GO = F.gorge, GL = F.glacier;
  const gox = GO.bx - GO.ax, goz = GO.bz - GO.az, goL2 = 1 / (gox * gox + goz * goz);
  const glx = GL.bx - GL.ax, glz = GL.bz - GL.az, glL2 = 1 / (glx * glx + glz * glz);
  const TAU = Math.PI * 2, NDIR = 16;
  const dcos = new Float64Array(NDIR), dsin = new Float64Array(NDIR);
  for (let k = 0; k < NDIR; k++) { dcos[k] = Math.cos((k / NDIR) * TAU); dsin[k] = Math.sin((k / NDIR) * TAU); }
  // Ridged, strongly anisotropic noise → long grooves along fall direction k. Each gully
  // gets its own strength (some deep ravines, many shallow runnels), minor rills between.
  const flute = (x, z, k, wc) => {
    const dx = dcos[k], dz = dsin[k];
    const c = -x * dz + z * dx + wc, f = x * dx + z * dz;
    const a = 1 - Math.abs(noise2f(c / 105, f / 560, 91 + k));
    const st = 0.6 + 0.5 * noise2f(c / 240, f / 1500, 151 + k);
    const b = 1 - Math.abs(noise2f(c / 40 + 7.3, f / 230, 131 + k));
    const a2 = a * a, b2 = b * b;
    return a2 * a2 * (st < 0.15 ? 0.15 : st) + b2 * b2 * b * 0.28 * (st < 0.3 ? 0 : st - 0.3);
  };
  // 2. cut depth on the coarse grid
  const D = new Float32Array(NC * NC);
  let n = 0;
  for (let j = 1; j < NC - 1; j++) {
    const z = -HALF + j * RC;
    for (let i = 1; i < NC - 1; i++) {
      const kc = j * NC + i, kf = j * C * N + i * C;
      const rd = roadD[kf];
      if (rd < 160) continue;
      const gx = (S[kc + 1] - S[kc - 1]) / (2 * RC), gz = (S[kc + NC] - S[kc - NC]) / (2 * RC);
      const g = Math.sqrt(gx * gx + gz * gz);
      if (g < 0.2) continue;
      const x = -HALF + i * RC;
      let m = smoothstep(0.2, 0.5, g) * smoothstep(160, 270, rd);
      // set pieces keep their designed shapes (canyon, glacier tongue)
      let t = clamp(((x - GO.ax) * gox + (z - GO.az) * goz) * goL2, 0, 1);
      let ex = GO.ax + gox * t - x, ez = GO.az + goz * t - z;
      m *= smoothstep(45 * 45, 110 * 110, ex * ex + ez * ez);
      t = clamp(((x - GL.ax) * glx + (z - GL.az) * glz) * glL2, 0, 1);
      ex = GL.ax + glx * t - x; ez = GL.az + glz * t - z;
      m *= smoothstep(1.1, 1.6, Math.sqrt(ex * ex + ez * ez) / lerp(GL.wTop, GL.wEnd, t));
      if (m <= 0) continue;
      // deeper high on the wall, shallow toward the foot (debris fills the gully mouths)
      const rel = H[kf] - floorY(clamp(z, -1500, 1200));
      const depth = (5 + 21 * smoothstep(50, 420, rel)) * m;
      const ang = Math.atan2(-gz, -gx) / TAU * NDIR;
      const a0 = Math.floor(ang), af = smoothstep(0.25, 0.75, ang - a0);
      const k0 = ((a0 % NDIR) + NDIR) % NDIR, k1 = (k0 + 1) % NDIR;
      const wc = 40 * noise2f(x / 380, z / 380, 97);
      let v = af < 1 ? flute(x, z, k0, wc) * (1 - af) : 0;
      if (af > 0) v += flute(x, z, k1, wc) * af;
      D[kc] = depth * v;
      n++;
    }
  }
  // 3. upsample (bilinear) onto the height grid
  for (let j = 0; j < N - 1; j++) {
    const jc = j >> 1, tz = (j & 1) * 0.5;
    for (let i = 0; i < N - 1; i++) {
      const ic = i >> 1, tx = (i & 1) * 0.5, kc = jc * NC + ic;
      const d00 = D[kc], d10 = D[kc + 1], d01 = D[kc + NC], d11 = D[kc + NC + 1];
      if (d00 + d10 + d01 + d11 === 0) continue;
      H[j * N + i] -= lerp(lerp(d00, d10, tx), lerp(d01, d11, tx), tz);
    }
  }
  console.info(`[fjord layout] sculpted ${n} cells in ${Math.round(performance.now() - t0)} ms`);
}

/* ---------------------------------------------------------- grid fields */
const heightGrid = new Float32Array(N * N);
const roadDistGrid = new Float32Array(N * N);
const roadSGrid = new Float32Array(N * N);

const pathExtras = { tunnels: [], bridges: [] };
(function build() {
  const path = pathExtras;
  // 1. macro terrain
  for (let j = 0; j < N; j++) {
    const z = -HALF + j * RES;
    for (let i = 0; i < N; i++) { const x = -HALF + i * RES; heightGrid[j * N + i] = featureHeight(x, z, macroHeight(x, z)); }
  }
  // 1b. tunnels (terrain far above the road) and bridges (terrain far below)
  const above = roadPts.map((p) => sample(heightGrid, p.x, p.z) - (p.y - 0.25));
  // only inside the designed windows (switchbacks naturally sit in deep cuts / on fills)
  const runs = (pred, minLen, w0, w1) => {
    const out = []; let a = -1;
    for (let i = 0; i <= above.length; i++) {
      const on = i < above.length && i * ROAD_STEP >= w0 && i * ROAD_STEP <= w1 && pred(above[i]);
      if (on && a < 0) a = i;
      if (!on && a >= 0) { if (i - a >= minLen) out.push({ s0: a * ROAD_STEP, s1: (i - 1) * ROAD_STEP }); a = -1; }
    }
    return out;
  };
  path.tunnels = runs((v) => v > 9, 40, 1980, 2520);
  path.bridges = runs((v) => v < -4, 6, 2650, 2800).map((b) => ({ s0: b.s0 - 6, s1: b.s1 + 6 }));
  // 2. road distance field: splat exact distances near the road, then chamfer outward
  roadDistGrid.fill(1e9);
  const R = 64; // exact distance + arc length within R metres (carving needs valid s)
  for (let k = 0; k < roadPts.length - 1; k++) {
    const a = roadPts[k], b = roadPts[k + 1];
    const i0 = Math.floor((Math.min(a.x, b.x) - R + HALF) / RES), i1 = Math.ceil((Math.max(a.x, b.x) + R + HALF) / RES);
    const j0 = Math.floor((Math.min(a.z, b.z) - R + HALF) / RES), j1 = Math.ceil((Math.max(a.z, b.z) + R + HALF) / RES);
    for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) {
      const x = -HALF + i * RES, z = -HALF + j * RES;
      const abx = b.x - a.x, abz = b.z - a.z;
      const t = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
      const d = Math.hypot(a.x + abx * t - x, a.z + abz * t - z);
      const idx = j * N + i;
      if (d < roadDistGrid[idx]) { roadDistGrid[idx] = d; roadSGrid[idx] = (k + t) * ROAD_STEP; }
    }
  }
  // chamfer (approx Euclidean) — two passes
  const D = RES, DD = RES * Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i; let v = roadDistGrid[k];
    if (i > 0) v = Math.min(v, roadDistGrid[k - 1] + D);
    if (j > 0) v = Math.min(v, roadDistGrid[k - N] + D);
    if (i > 0 && j > 0) v = Math.min(v, roadDistGrid[k - N - 1] + DD);
    if (i < N - 1 && j > 0) v = Math.min(v, roadDistGrid[k - N + 1] + DD);
    roadDistGrid[k] = v;
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i; let v = roadDistGrid[k];
    if (i < N - 1) v = Math.min(v, roadDistGrid[k + 1] + D);
    if (j < N - 1) v = Math.min(v, roadDistGrid[k + N] + D);
    if (i < N - 1 && j < N - 1) v = Math.min(v, roadDistGrid[k + N + 1] + DD);
    if (i > 0 && j < N - 1) v = Math.min(v, roadDistGrid[k + N - 1] + DD);
    roadDistGrid[k] = v;
  }
  // 2b. water-cut gullies on the mountain walls (≥ 150 m from the road)
  sculptMountains(heightGrid, roadDistGrid);
  // 3. carve the road bed: flat under the asphalt + shoulders, smooth cut/fill banks
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, d = roadDistGrid[k];
    if (d > 60) continue;
    const s = clamp(Math.round(roadSGrid[k] / ROAD_STEP), 0, roadPts.length - 1);
    // keep the mountain over tunnels and the canyon under bridges
    if (path.tunnels.some((T) => s > T.s0 + 3 && s < T.s1 - 3)) continue;
    const ry = roadPts[s].y - 0.25;
    if (heightGrid[k] < ry - 2 && path.bridges.some((B) => s >= B.s0 && s <= B.s1)) continue;
    const inner = ROAD_WIDTH / 2 + SHOULDER;
    const bank = Math.max(8, Math.abs(heightGrid[k] - ry) * 1.3);   // 1:1.3 embankment
    const w = 1 - smoothstep(inner, inner + bank, d);
    heightGrid[k] = lerp(heightGrid[k], ry - (d < inner ? 0.05 : 0), w);
  }
  // 3b. over the tunnel the road is buried: don't let "near the road" rules (gravel shoulders,
  // no-plant strips) paint the ridge top
  for (let k = 0; k < N * N; k++) {
    if (roadDistGrid[k] > 40) continue;
    const s = roadSGrid[k];
    if (!path.tunnels.some((T) => s > T.s0 + 4 && s < T.s1 - 4)) continue;
    const q = roadPts[clamp(Math.round(s / ROAD_STEP), 0, roadPts.length - 1)];
    if (heightGrid[k] - q.y > 3) roadDistGrid[k] = 999;
  }
  // 4. village terrace: a gentle flat shelf by the shore
  const V = landmarks.village;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -HALF + i * RES, z = -HALF + j * RES;
    const d = Math.hypot(x - V.x, (z - V.z) * 1.4);
    if (d > V.radius * 1.6) continue;
    const k = j * N + i;
    const target = 3.2 + 0.012 * Math.max(0, V.z - z);
    const w = 1 - smoothstep(V.radius * 0.8, V.radius * 1.6, d);
    if (roadDistGrid[k] > ROAD_WIDTH) heightGrid[k] = lerp(heightGrid[k], Math.max(target, heightGrid[k] * 0.3 + target * 0.7), w);
  }
})();

// Fill in heights of set pieces that depend on the finished terrain.
{
  const W = features.hairpinFall;
  W.top.y = sample(heightGrid, W.top.x, W.top.z);
  W.bottom.y = sample(heightGrid, W.bottom.x, W.bottom.z) + 1.4;   // pool surface
  W.pool.level = W.bottom.y;
  const G = features.gorge;
  G.headTop = sample(heightGrid, G.ax - 25, G.az - 3);              // lip of the canyon-head fall
  G.headFloor = sample(heightGrid, G.ax + 6, G.az + 1);
}

function sample(grid, x, z) {
  const fx = clamp((x + HALF) / RES, 0, N - 1.001), fz = clamp((z + HALF) / RES, 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * N + i;
  return lerp(lerp(grid[k], grid[k + 1], tx), lerp(grid[k + N], grid[k + N + 1], tx), tz);
}

/* ------------------------------------------------------------------ path */
// Rideable path shared with the skate controller (same shape in every scene).
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
export const path = {
  closed: false,
  tunnels: pathExtras.tunnels,          // [{s0,s1}] road runs inside the mountain
  bridges: pathExtras.bridges,          // [{s0,s1}] road spans the canyon
  isTunnel(s) { return this.tunnels.some((T) => s >= T.s0 && s <= T.s1); },
  isBridge(s) { return this.bridges.some((B) => s >= B.s0 && s <= B.s1); },
  length: (roadPts.length - 1) * ROAD_STEP,
  width: ROAD_WIDTH,
  points: roadPts,                       // Vector3 with y = road surface
  /** Position on the centre line at arc length s (m). */
  pointAt(s, out = new THREE.Vector3()) {
    const f = clamp(s / ROAD_STEP, 0, roadPts.length - 1.001), i = Math.floor(f);
    return out.copy(roadPts[i]).lerp(roadPts[i + 1], f - i);
  },
  /** Unit tangent (direction of travel, includes slope) at s. */
  tangentAt(s, out = new THREE.Vector3()) {
    const s0 = clamp(s - 2, 0, this.length), s1 = clamp(s + 2, 0, this.length);
    return out.subVectors(this.pointAt(s1, tmpA), this.pointAt(s0, tmpB)).normalize();
  },
  /** Surface height at lateral offset d (m, + = right of travel) from the centre at s. */
  heightAt(s) { return this.pointAt(s, tmpA).y; },
  /** Nearest arc length for a world x,z (fast, grid based). */
  nearestS: (x, z) => sample(roadSGrid, x, z),
};

/* --------------------------------------------------------------- world API */
export const world = {
  id: 'fjord',
  WORLD_HALF: HALF,
  gridSize: N,
  gridRes: RES,
  heightGrid,
  seaLevel: SEA_LEVEL,

  heightAt: (x, z) => sample(heightGrid, x, z),
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = RES;
    return out.set(sample(heightGrid, x - e, z) - sample(heightGrid, x + e, z), 2 * e, sample(heightGrid, x, z - e) - sample(heightGrid, x, z + e)).normalize();
  },
  /** Lake / sea surface at x,z or null (river + pools handled by the water module). */
  waterLevelAt(x, z) {
    const L = features.lake;
    if (Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz) < 0.95 && sample(heightGrid, x, z) < L.level) return L.level;
    return sample(heightGrid, x, z) < SEA_LEVEL ? SEA_LEVEL : null;
  },
  /** Set pieces along the ride (see `features` above) and helper masks. */
  features,
  glacierAt(x, z) {
    const G = features.glacier, { d, t } = segDist(x, z, G.ax, G.az, G.bx, G.bz);
    return 1 - smoothstep(lerp(G.wTop, G.wEnd, t) * 0.7, lerp(G.wTop, G.wEnd, t) * 1.05, d);
  },
  beachAt(x, z) {
    const B = features.bay, r = Math.hypot((x - B.x) / B.rx, (z - B.z) / B.rz);
    return smoothstep(0.86, 0.93, r) * (1 - smoothstep(1.02, 1.1, r));
  },
  gorgeAt(x, z) {
    const G = features.gorge, { d, t } = segDist(x, z, G.ax, G.az, G.bx, G.bz);
    return 1 - smoothstep(lerp(G.wTopHead, G.wTopMouth, t) * 0.8, lerp(G.wTopHead, G.wTopMouth, t) * 1.3, d);
  },
  waterDistAt(x, z) { return sample(heightGrid, x, z) - SEA_LEVEL; }, // crude: height above sea
  roadDistAt: (x, z) => sample(roadDistGrid, x, z),
  trailDistAt: (x, z) => sample(roadDistGrid, x, z),                  // alias for shared modules
  /** Valley centre x at z, and the river's x at z (for water / vegetation placement). */
  valleyX,
  riverX: (z) => valleyX(z) + 40 * Math.sin(z * 0.006),
  floorY,
  canopyAt: () => 0,                    // open sky everywhere (rain + audio read this)
  understoryAt: () => 0,
  inBounds: (x, z) => Math.abs(x) < HALF - 50 && Math.abs(z) < HALF - 50,
  landmarks,
  path,
  spawn: { x: roadPts[0].x, z: roadPts[0].z, yaw: 0 },
  addCollider() {},
  resolveCollision(p) { return p; },
};
