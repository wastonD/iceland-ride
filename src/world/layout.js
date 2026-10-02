// The valley's design: stream, waterfall cliff, trail, landmarks and density
// maps. Everything else (terrain mesh, vegetation, player, audio) queries this.
// Coordinates: metres, +X east, +Z south, +Y up. Playable area ≈ radius 135.

import * as THREE from 'three';
import { fbm2, smoothstep, clamp, lerp } from '../core/noise.js';

export const WORLD_HALF = 160;          // grid covers [-160,160]²
const RES = 1;                          // grid spacing (m)
const N = WORLD_HALF * 2 / RES + 1;     // 321 samples per side

/* ---------------------------------------------------------------- stream */
// North → south. Waterfall cliff sits around z ≈ -125.
const STREAM_PTS = [
  [-6, -158], [-4, -146], [-1, -132], [0, -121], [0, -114], [9, -98], [14, -84],
  [8, -60], [-10, -36], [-17, -8], [-7, 20], [12, 46], [19, 72], [8, 104], [-8, 130], [-14, 160],
].map(([x, z]) => new THREE.Vector3(x, 0, z));

const WATERFALL_Z = -124.5;
const TOP_Y = 13.5, POOL_Y = 1.6, END_Y = -2.6;

export const streamCurve = new THREE.CatmullRomCurve3(STREAM_PTS, false, 'centripetal');
const STREAM_SAMPLES = 700;
const streamPts = streamCurve.getSpacedPoints(STREAM_SAMPLES); // uniform arc length
export const STREAM_LENGTH = streamCurve.getLength();

// Water surface height as a function of arc-length parameter s ∈ [0,1].
function streamYAtZ(z) {
  // plateau above the cliff, sharp step at the fall, gentle fall afterwards
  const fall = smoothstep(WATERFALL_Z - 1.6, WATERFALL_Z + 1.6, z);
  const plateau = lerp(TOP_Y + 1.5, TOP_Y, smoothstep(-160, WATERFALL_Z, z));
  const lower = lerp(POOL_Y, END_Y, smoothstep(-112, 160, z));
  return lerp(plateau, lower, fall);
}
export function streamWidthAt(s) {
  // wider at the plunge pool, narrow on the plateau
  const z = streamPts[Math.round(clamp(s, 0, 1) * STREAM_SAMPLES)].z;
  const pool = Math.exp(-((z + 116) ** 2) / 60);
  return lerp(3.2, 5.5, smoothstep(-130, 40, z)) + 9 * pool + 1.2 * Math.sin(s * 37.0);
}

/* ----------------------------------------------------------------- trail */
// Closed loop: spawn → giant tree → waterfall pool → east bank → hut → stepping stones → spawn
const TRAIL_PTS = [
  [-26, 16], [-38, -6], [-40, -34], [-30, -62], [-22, -86], [-14, -104], [-3, -104],
  [12, -104], [26, -94], [36, -70], [40, -40], [44, -8], [44, 20], [38, 42],
  [28, 62], [19, 72], [6, 70], [-8, 56], [-20, 36],
].map(([x, z]) => new THREE.Vector3(x, 0, z));
export const trailCurve = new THREE.CatmullRomCurve3(TRAIL_PTS, true, 'centripetal');
const trailPts = trailCurve.getSpacedPoints(500);
const TRAIL_LEN = trailCurve.getLength();

// Rideable relief along the trail (for the e-board): rolling rises + three kickers
// that launch a fast rider. Periodic in arc length so the loop has no seam.
export const TRAIL_KICKERS = [95, 300, 395];
function trailRelief(s) {
  const L = TRAIL_LEN;
  let h = 1.0 * Math.sin((2 * Math.PI * 6 * s) / L) + 0.45 * Math.sin((2 * Math.PI * 14 * s) / L + 1.3);
  for (const k of TRAIL_KICKERS) {
    let u = s - k;
    if (u > L / 2) u -= L; if (u < -L / 2) u += L;
    if (u > -12 && u <= 0) h += 1.6 * Math.pow((u + 12) / 12, 1.6);    // ramp up
    else if (u > 0 && u < 4) h += 1.6 * (1 - u / 4) ** 2;               // sharp lip, then drop away
  }
  return h;
}

/* ------------------------------------------------------------- landmarks */
export const landmarks = {
  waterfall: { x: 0, z: -118, radius: 12, label: '瀑布潭' },       // plunge pool centre
  giantTree: { x: -47, z: -24, radius: 7, label: '空心巨树' },      // hollow buttressed giant
  hut: { x: 54, z: 26, radius: 8, yaw: -Math.PI / 2, label: '雨林小屋' }, // veranda faces west (toward trail)
  streamStones: { x: 19, z: 72, radius: 5, label: '溪中石' },       // stepping stones across the stream
  poolStones: { x: -3, z: -104, radius: 4, label: '潭边石' },       // stones at the pool outlet
};

export const spawn = { x: -22, z: 28, yaw: 0.35 }; // yaw 0 = looking toward −Z (north)

/* ----------------------------------------------------------- grid fields */
const heightGrid = new Float32Array(N * N);
const streamDistGrid = new Float32Array(N * N); // signed-ish: distance to water edge (neg = in water)
const streamSGrid = new Float32Array(N * N);
const trailDistGrid = new Float32Array(N * N);
const trailSGrid = new Float32Array(N * N);
const canopyGrid = new Float32Array(N * N);
const understoryGrid = new Float32Array(N * N);

// Coarse chunks so the per-cell nearest search can skip most of the polyline.
function chunked(pts, closed, size = 20) {
  const n = closed ? pts.length : pts.length - 1;
  const chunks = [];
  for (let i = 0; i < n; i += size) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = i; k <= Math.min(i + size, n); k++) {
      const p = pts[k % pts.length];
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    chunks.push({ i0: i, i1: Math.min(i + size, n), minX, maxX, minZ, maxZ });
  }
  return { pts, n, chunks };
}
function nearestChunked(C, x, z) {
  let best = Infinity, bestS = 0;
  const order = C.chunks
    .map((c) => {
      const dx = Math.max(c.minX - x, 0, x - c.maxX), dz = Math.max(c.minZ - z, 0, z - c.maxZ);
      return { c, d: dx * dx + dz * dz };
    })
    .sort((a, b) => a.d - b.d);
  for (const { c, d } of order) {
    if (d > best) break;
    for (let i = c.i0; i < c.i1; i++) {
      const a = C.pts[i], b = C.pts[(i + 1) % C.pts.length];
      const abx = b.x - a.x, abz = b.z - a.z;
      const t = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz || 1), 0, 1);
      const dx = a.x + abx * t - x, dz = a.z + abz * t - z;
      const dd = dx * dx + dz * dz;
      if (dd < best) { best = dd; bestS = (i + t) / C.n; }
    }
  }
  return { dist: Math.sqrt(best), s: bestS };
}

function computeHeight(x, z, sd, s) {
  const zOnStream = streamPts[Math.round(s * STREAM_SAMPLES)].z;
  const baseY = streamYAtZ(zOnStream);
  const w = streamWidthAt(s) * 0.5;
  const d = sd; // distance to centreline

  // Cross-section of the stream valley: bed → bank lip → rising valley floor
  const bed = -1.1 - 0.9 * Math.exp(-((x - landmarks.waterfall.x) ** 2 + (z - landmarks.waterfall.z) ** 2) / 50);
  const bank = 0.55;
  let prof;
  if (d < w) prof = lerp(bed, bank * 0.3, smoothstep(w * 0.55, w, d));
  else prof = bank + 0.9 * smoothstep(w, w + 5, d) + 0.055 * Math.max(0, d - w - 5);

  // Organic undulation grows away from the water
  const away = smoothstep(w + 1, w + 18, d);
  const undul = away * (fbm2(x * 0.018, z * 0.018, 4, 11) * 5.5 + fbm2(x * 0.08, z * 0.08, 3, 12) * 1.1);
  const fine = fbm2(x * 0.35, z * 0.35, 2, 13) * 0.12;

  // Bowl rim: rounded-square ridge that closes the valley
  const rim = Math.max(Math.abs(x), Math.abs(z)) * 0.55 + Math.hypot(x, z) * 0.45;
  // The stream cuts a gorge through the rim instead of being buried by it
  const ridge = 48 * Math.pow(smoothstep(112, 162, rim + fbm2(x * 0.02, z * 0.02, 3, 14) * 12), 1.4) * smoothstep(w + 2, w + 30, d);

  // Hut sits on a small flattened knoll
  const hk = Math.hypot(x - landmarks.hut.x, z - landmarks.hut.z);
  const knoll = 1.2 * (1 - smoothstep(6, 16, hk));

  let h = baseY + prof + undul + fine + ridge + knoll;

  return h;
}

(function buildGrids() {
  const S = chunked(streamPts, false);
  const T = chunked(trailPts, true);
  for (let j = 0; j < N; j++) {
    const z = -WORLD_HALF + j * RES;
    for (let i = 0; i < N; i++) {
      const x = -WORLD_HALF + i * RES;
      const k = j * N + i;
      const st = nearestChunked(S, x, z);
      const tr = nearestChunked(T, x, z);
      streamSGrid[k] = st.s;
      streamDistGrid[k] = st.dist - streamWidthAt(st.s) * 0.5;
      trailDistGrid[k] = tr.dist;
      trailSGrid[k] = tr.s * TRAIL_LEN;
      heightGrid[k] = computeHeight(x, z, st.dist, st.s);
    }
  }
  // Trail smoothing: blur heights along the trail corridor (3×3 box, 2 passes)
  for (let pass = 0; pass < 2; pass++) {
    const src = heightGrid.slice();
    for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      const wgt = 1 - smoothstep(1.5, 3.5, trailDistGrid[k]);
      if (wgt <= 0 || streamDistGrid[k] < 0.5) continue;
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += src[k + dj * N + di];
      heightGrid[k] = lerp(src[k], sum / 9, wgt);
    }
  }
  // Trail relief (after smoothing so the kickers keep their lips); fades out at stream crossings
  for (let k = 0; k < N * N; k++) {
    const w = (1 - smoothstep(3, 16, trailDistGrid[k])) * smoothstep(4, 10, streamDistGrid[k]);
    if (w > 0) heightGrid[k] += w * trailRelief(trailSGrid[k]);
  }
  // Density maps (design intent — vegetation places by these; audio reads canopy)
  for (let j = 0; j < N; j++) {
    const z = -WORLD_HALF + j * RES;
    for (let i = 0; i < N; i++) {
      const x = -WORLD_HALF + i * RES;
      const k = j * N + i;
      const sd = streamDistGrid[k], td = trailDistGrid[k];
      const n = fbm2(x * 0.03, z * 0.03, 3, 21) * 0.5 + 0.5;
      let clear = 1;
      clear *= smoothstep(2, 10, sd);                         // open sky over the water
      for (const L of Object.values(landmarks)) {
        const d = Math.hypot(x - L.x, z - L.z);
        clear *= smoothstep(L.radius * 0.6, L.radius * 1.8, d);
      }
      canopyGrid[k] = clamp((0.35 + 0.8 * n) * lerp(0.15, 1, clear), 0, 1);
      understoryGrid[k] = clamp(
        (0.45 + 0.7 * (fbm2(x * 0.07, z * 0.07, 3, 22) * 0.5 + 0.5)) *
          smoothstep(1.2, 3.5, td) * smoothstep(-0.2, 1.5, sd),
        0, 1,
      );
    }
  }
})();

function sample(grid, x, z) {
  const fx = clamp((x + WORLD_HALF) / RES, 0, N - 1.001);
  const fz = clamp((z + WORLD_HALF) / RES, 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const k = j * N + i;
  return lerp(lerp(grid[k], grid[k + 1], tx), lerp(grid[k + N], grid[k + N + 1], tx), tz);
}

/* ------------------------------------------------------------ public API */
export const world = {
  WORLD_HALF,
  gridSize: N,
  gridRes: RES,
  heightGrid,                         // Float32Array N×N, row-major (z rows, x cols)

  /** Ground height (m) at x,z — the terrain mesh is built from exactly this. */
  heightAt: (x, z) => sample(heightGrid, x, z),

  /** Surface normal at x,z (writes into out: THREE.Vector3). */
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.5;
    const hl = sample(heightGrid, x - e, z), hr = sample(heightGrid, x + e, z);
    const hd = sample(heightGrid, x, z - e), hu = sample(heightGrid, x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  },

  /** Distance (m) to the water edge; negative inside the stream. */
  waterDistAt: (x, z) => sample(streamDistGrid, x, z),

  /** Water surface height at x,z, or null when not over water. */
  waterLevelAt(x, z) {
    if (sample(streamDistGrid, x, z) > 0.4) return null;
    const s = sample(streamSGrid, x, z);
    return streamYAtZ(streamPts[Math.round(clamp(s, 0, 1) * STREAM_SAMPLES)].z) - 0.25;
  },

  /** Stream parameter s ∈ [0,1] of the nearest stream point (0 = source). */
  streamSAt: (x, z) => sample(streamSGrid, x, z),
  streamYAtZ,
  streamPoints: streamPts,            // 701 evenly spaced Vector3 (y = 0)

  /** Distance (m) to the trail centreline. */
  trailDistAt: (x, z) => sample(trailDistGrid, x, z),
  trailPoints: trailPts,

  /** 0..1 design density of tall canopy / understory at x,z. */
  canopyAt: (x, z) => sample(canopyGrid, x, z),
  understoryAt: (x, z) => sample(understoryGrid, x, z),

  /** True if (x,z) is inside the playable bowl (not up on the rim). */
  inBounds(x, z) {
    const rim = Math.max(Math.abs(x), Math.abs(z)) * 0.55 + Math.hypot(x, z) * 0.45;
    return rim < 122;
  },

  landmarks,
  spawn,
  waterfallZ: WATERFALL_Z,
};

/* ------------------------------------------------------------- colliders */
// Circles in XZ. Vegetation/props register trunks, rocks, hut posts here.
const CELL = 8;
const colliderHash = new Map();
export const colliders = [];
world.addCollider = function (x, z, r) {
  const c = { x, z, r };
  colliders.push(c);
  const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
  const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const key = i * 4096 + j;
    if (!colliderHash.has(key)) colliderHash.set(key, []);
    colliderHash.get(key).push(c);
  }
  return c;
};
/** Push a moving circle (pos: {x,z}, radius) out of colliders. Mutates pos. */
world.resolveCollision = function (pos, radius) {
  const key = Math.floor(pos.x / CELL) * 4096 + Math.floor(pos.z / CELL);
  const seen = new Set();
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    const list = colliderHash.get(key + di * 4096 + dj);
    if (!list) continue;
    for (const c of list) {
      if (seen.has(c)) continue;
      seen.add(c);
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d = Math.hypot(dx, dz), min = c.r + radius;
      if (d < min && d > 1e-5) { pos.x = c.x + (dx / d) * min; pos.z = c.z + (dz / d) * min; }
    }
  }
  return pos;
};
