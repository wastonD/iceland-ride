// Longboard: pintail deck (wood + black griptape), two trucks, four soft wheels.
// Local frame: origin = centre of the deck top surface, +Z = nose, +Y = up.
// Wheel contact patch is at y = -GROUND.

import * as THREE from 'three';
import { noise2, fbm2, smoothstep, clamp } from '../core/noise.js';
import { Builder, loft, ellipsoid, roundBox, tube } from './builders.js';
import { NOZZLE_X, NOZZLE_Y, NOZZLE_Z } from './nitro.js';

export const GROUND = 0.101;       // deck top → ground
export const WHEEL_R = 0.0355;
export const WHEEL_X = 0.114;      // wheel centre x
export const TRUCK_Z = 0.30;
export const AXLE_Y = -(GROUND - WHEEL_R); // -0.0655

const HALF_LEN = 0.5;

const WIDTH_KEYS = [
  [-0.5, 0.050], [-0.42, 0.062], [-0.30, 0.080], [-0.15, 0.099], [0.0, 0.110],
  [0.20, 0.117], [0.36, 0.108], [0.5, 0.072],
];

function halfWidth(z) {
  z = clamp(z, -HALF_LEN, HALF_LEN);
  let w = WIDTH_KEYS[WIDTH_KEYS.length - 1][1];
  for (let i = 0; i < WIDTH_KEYS.length - 1; i++) {
    const [z0, w0] = WIDTH_KEYS[i], [z1, w1] = WIDTH_KEYS[i + 1];
    if (z <= z1) { w = w0 + (w1 - w0) * smoothstep(z0, z1, z); break; }
  }
  // round the ends
  const L = z < 0 ? 0.07 : 0.10;
  const d = HALF_LEN - Math.abs(z);
  if (d < L) w *= Math.sqrt(Math.max(0, 1 - Math.pow((L - d) / L, 2)));
  return w;
}

const kick = (z) => 0.030 * Math.pow(smoothstep(0.29, 0.5, Math.abs(z)), 1.6);
const deckTop = (z, u) => kick(z) + 0.007 * u * u;

// Deck: each cross-section is a closed ring — concave top, full bullnose (rounded) edges,
// flat bottom — so the rim shades smooth instead of showing a hard plywood edge.
const DECK_T = 0.0125;
function buildDeckGeometry() {
  const N = 50, K = 7, E = 5;
  const pos = [], uv = [], idx = [];
  const ring = 2 * K + 2 * E;
  for (let j = 0; j <= N; j++) {
    const z = -HALF_LEN + HALF_LEN * 2 * (0.5 - 0.5 * Math.cos((Math.PI * j) / N));
    const w = halfWidth(z);
    const rr = Math.min(DECK_T * 0.5, w * 0.9);
    const xi = w - rr;
    const top = (x) => deckTop(z, w > 1e-6 ? x / w : 0);
    const put = (x, y) => { pos.push(x, y, z); uv.push(x / 0.24 + 0.5, z + 0.5); };
    for (let k = 0; k < K; k++) { const x = -xi + (2 * xi * k) / (K - 1); put(x, top(x)); }
    for (let k = 0; k < E; k++) {                       // right bullnose
      const th = Math.PI / 2 - (Math.PI * (k + 1)) / (E + 1);
      put(xi + rr * Math.cos(th), top(xi) - rr + rr * Math.sin(th));
    }
    for (let k = K - 1; k >= 0; k--) { const x = -xi + (2 * xi * k) / (K - 1); put(x, top(x) - 2 * rr); }
    for (let k = 0; k < E; k++) {                       // left bullnose
      const th = -Math.PI / 2 - (Math.PI * (k + 1)) / (E + 1);
      put(-xi + rr * Math.cos(th), top(-xi) - rr + rr * Math.sin(th));
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < ring; i++) {
      const i1 = (i + 1) % ring;
      const a = j * ring + i, b = (j + 1) * ring + i, c = j * ring + i1, d = (j + 1) * ring + i1;
      idx.push(a, b, c, c, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildGripGeometry() {
  const zA = -0.37, zB = 0.385, N = 34, K = 7;
  const pos = [], idx = [];
  for (let j = 0; j <= N; j++) {
    const s = j / N;
    const z = zA + (zB - zA) * s;
    const e = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(2 * s - 1), 9)));
    const w = Math.max(0, halfWidth(z) - 0.011) * e;
    for (let k = 0; k < K; k++) {
      const u = -1 + (2 * k) / (K - 1);
      pos.push(u * w, deckTop(z, u) + 0.0016, z);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < K - 1; k++) {
      const a = j * K + k, b = (j + 1) * K + k, c = a + 1, d = b + 1;
      idx.push(a, b, c, c, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ledGeometry() {
  const b = new Builder();
  for (const side of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const z = -0.43 + (0.86 * k) / 16;
      pts.push([side * (halfWidth(z) + 0.0012), deckTop(z, side) - 0.0065, z]);
    }
    b.add(tube(pts, 0.0034, 26, 5), 0xffffff);
  }
  for (const sx of [-1, 1]) {   // nozzle glow rings
    const tg = new THREE.TorusGeometry(0.0262, 0.0032, 6, 18);
    tg.deleteAttribute('uv');
    tg.translate(sx * NOZZLE_X, NOZZLE_Y, NOZZLE_Z);
    b.add(tg, 0xffffff);
  }
  return b.build();
}

function woodTexture() {
  const W = 128, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const img = c.createImageData(W, H);
  const light = [222, 178, 118], dark = [176, 118, 66];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const warp = fbm2(x * 0.045, y * 0.004, 3, 11) * 5.5;
      const ring = 0.5 + 0.5 * Math.sin(x * 0.55 + warp * 2.2);
      const fine = noise2(x * 0.9, y * 0.02, 5) * 0.5 + 0.5;
      let t = 0.55 * smoothstep(0.35, 0.95, ring) + 0.35 * fine;
      // plywood layer bands near the edges of the width
      const edge = Math.abs(x / W - 0.5) * 2;
      if (edge > 0.9) t = 0.2 + 0.6 * ((Math.floor(y / 6) % 2) ? 1 : 0.6);
      const i = (y * W + x) * 4;
      img.data[i] = light[0] + (dark[0] - light[0]) * t;
      img.data[i + 1] = light[1] + (dark[1] - light[1]) * t;
      img.data[i + 2] = light[2] + (dark[2] - light[2]) * t;
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function truckStaticGeometry() {
  // baseplates + riser under the deck (static, merged)
  const b = new Builder();
  for (const z of [TRUCK_Z, -TRUCK_Z]) {
    b.add(roundBox(0, -0.0205, z, 0.072, 0.0085, 0.118, { n: 4, inset: 0.92, M: 14 }), 0x9aa0a6);
    b.add(roundBox(0, -0.014, z, 0.06, 0.005, 0.10, { n: 4, inset: 0.95, M: 14 }), 0x2a2a2a);
  }
  // battery enclosure: flat black box between the trucks
  b.add(roundBox(0, -0.0305, 0, 0.135, 0.036, 0.44, { n: 4.5, inset: 0.92, M: 14 }), 0x17171a);
  b.add(roundBox(0, -0.0492, 0, 0.10, 0.004, 0.36, { n: 4, inset: 0.95, M: 14 }), 0x2b2c31);   // bottom guard plate
  for (const z of [-0.14, 0.14]) b.add(roundBox(0, -0.0305, z, 0.142, 0.030, 0.024, { n: 4, inset: 0.9, M: 14 }), 0x0f0f11); // straps
  // nitro nozzles under the tail (behind the rear truck)
  for (const sx of [-1, 1]) {
    const cx = sx * NOZZLE_X;
    b.add(loft({
      axis: 'z', n: 2, M: 16, capStart: 'flat',
      sections: [
        { p: -0.400, r1: 0.016, r2: 0.016, c1: cx, c2: NOZZLE_Y },
        { p: -0.440, r1: 0.0175, r2: 0.0175, c1: cx, c2: NOZZLE_Y },
        { p: -0.470, r1: 0.023, r2: 0.023, c1: cx, c2: NOZZLE_Y },
        { p: NOZZLE_Z + 0.001, r1: 0.0255, r2: 0.0255, c1: cx, c2: NOZZLE_Y },
      ],
    }), 0x8a9098);
    b.add(loft({
      axis: 'z', n: 2, M: 14, capStart: 'flat', capEnd: 'flat',
      sections: [{ p: NOZZLE_Z + 0.014, r1: 0.0205, r2: 0.0205, c1: cx, c2: NOZZLE_Y }, { p: NOZZLE_Z + 0.015, r1: 0.0205, r2: 0.0205, c1: cx, c2: NOZZLE_Y }],
    }), 0x08090b);   // dark throat
    b.add(roundBox(cx, NOZZLE_Y + 0.014, -0.415, 0.014, 0.024, 0.02, { n: 3, inset: 0.9, M: 14 }), 0x5b6068);   // mount bracket
  }
  // ESC / charge-port nub at the tail end
  b.add(roundBox(0, -0.030, -0.232, 0.03, 0.016, 0.014, { n: 3, inset: 0.9, M: 14 }), 0x3a3d42);
  return b.build();
}

function hangerGeometry(sign) {
  // pivot origin = truck pivot (y = -0.03 in board space); axle at y = AXLE_Y - (-0.03)
  const oy = -0.03;
  const ay = AXLE_Y - oy; // -0.0355
  const b = new Builder();
  // axle tube (rotate y-axis loft onto x)
  const axle = loft({
    axis: 'y', n: 2, M: 10, capStart: 'flat', capEnd: 'flat',
    sections: [{ p: -0.145, r1: 0.0075, r2: 0.0075 }, { p: 0.145, r1: 0.0075, r2: 0.0075 }],
  });
  axle.rotateZ(Math.PI / 2);
  axle.translate(0, ay, 0);
  b.add(axle, 0xb9bec4);
  // hanger body (wedge-ish lump around the pivot)
  const body = loft({
    axis: 'y', n: 2.3, M: 14, capStart: 0.008, capEnd: 0.008,
    sections: [
      { p: -0.07, r1: 0.010, r2: 0.010 }, { p: -0.045, r1: 0.0125, r2: 0.012 }, { p: -0.018, r1: 0.0165, r2: 0.0175 },
      { p: 0, r1: 0.018, r2: 0.019 },
      { p: 0.018, r1: 0.0165, r2: 0.0175 }, { p: 0.045, r1: 0.0125, r2: 0.012 }, { p: 0.07, r1: 0.010, r2: 0.010 },
    ],
  });
  body.rotateZ(-Math.PI / 2);
  body.translate(0, ay + 0.008, 0);
  b.add(body, 0xa8aeb4);
  b.add(roundBox(0, 0.001, sign * 0.006, 0.05, 0.030, 0.042, { n: 3.2, inset: 0.85, M: 14 }), 0x8f959b);
  // bushing (dark rubber) between hanger and baseplate
  b.add(ellipsoid(0, -0.004, -sign * 0.026, 0.017, 0.013, 0.017, 10, 8), 0x2a2a2a);
  if (sign < 0) {
    // belt drive: motor can behind the axle, pulley outside each hanger end, belt between
    for (const sx of [-1, 1]) {
      const can = loft({
        axis: 'y', n: 2, capStart: 'flat', capEnd: 'flat',
        sections: [{ p: 0.0, r1: 0.0225, r2: 0.0225 }, { p: 0.062, r1: 0.0225, r2: 0.0225 }], M: 14,
      });
      can.rotateZ(-sx * Math.PI / 2);          // axis y → ±x
      can.translate(sx * 0.028, ay + 0.004, -0.064);
      b.add(can, 0x393c42);
      b.add(ellipsoid(sx * 0.095, ay + 0.004, -0.064, 0.006, 0.0125, 0.0125, 10, 8), 0xb9bec4); // pinion
      // fins / cap
      b.add(roundBox(sx * 0.0335, ay + 0.004, -0.064, 0.005, 0.036, 0.036, { n: 3, inset: 0.85, M: 14 }), 0xc44a2a);
      // big pulley on the wheel
      const pul = loft({
        axis: 'y', n: 2, capStart: 'flat', capEnd: 'flat',
        sections: [{ p: 0, r1: 0.041, r2: 0.041 }, { p: 0.012, r1: 0.041, r2: 0.041 }], M: 18,
      });
      pul.rotateZ(-sx * Math.PI / 2);
      pul.translate(sx * 0.0765, ay, 0);
      b.add(pul, 0xa9afb6);
      // belt runs (top + bottom tangents between pulley and pinion)
      const runs = [[0.0165, 0.041], [-0.0085, -0.041]];   // [y at pinion end, y at pulley end], relative to axle
      for (const [y0, y1] of runs) {
        const dy = y1 - y0, dz = 0.064, len = Math.hypot(dy, dz);
        const belt = roundBox(0, 0, 0, 0.011, 0.0028, len, { n: 3, inset: 0.95, M: 8 });
        belt.rotateX(-Math.atan2(dy, dz));
        belt.translate(sx * 0.0825, ay + (y0 + y1) / 2, -dz / 2);
        b.add(belt, 0x141416);
      }
    }
  }
  // axle nuts
  for (const s of [-1, 1]) b.add(roundBox(s * 0.148, ay, 0, 0.009, 0.020, 0.020, { n: 3, inset: 0.9, M: 14 }), 0x7d8388);
  return b.build();
}

// Wheel: lathed urethane tyre with a soft rounded lip, dark core + bearing shield, and three
// light marks on the outer face so the spin reads. Axis = x; outer face = +x.
function lathe(profile, seg) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.deleteAttribute('uv');
  return g;
}
function wheelGeometry() {
  const R = WHEEL_R;
  const b = new Builder();
  b.add(lathe([
    [0.0212, -0.0212], [0.0255, -0.0226], [R * 0.80, -0.0226], [R * 0.925, -0.0206], [R * 0.982, -0.0152],
    [R, -0.0068], [R, 0.0068], [R * 0.982, 0.0152], [R * 0.925, 0.0206], [R * 0.80, 0.0226], [0.0255, 0.0226], [0.0212, 0.0212],
  ], 18), 0xe07a2c);
  b.add(lathe([
    [0.0086, -0.0232], [0.0098, -0.0224], [0.0214, -0.0214], [0.0214, 0.0214], [0.0098, 0.0224], [0.0086, 0.0232],
  ], 14), 0x1d1d1f);
  b.add(lathe([[0.0004, -0.0238], [0.0072, -0.0238], [0.0088, -0.0228], [0.0088, 0.0228], [0.0072, 0.0238], [0.0004, 0.0238]], 12), 0xa2a7ad);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const m = new THREE.SphereGeometry(1, 8, 4);
    m.deleteAttribute('uv');
    m.scale(0.0032, 0.0012, 0.0055);
    m.rotateY(a);
    m.translate(Math.sin(a) * 0.0145, 0.0219, Math.cos(a) * 0.0145);
    b.add(m, 0xe9dcc4);
  }
  const g = b.build();
  g.rotateZ(-Math.PI / 2); // axis y → x (outer face +x)
  return g;
}

export function buildBoard(ctx) {
  const prep = ctx.prepareMaterial;
  const group = new THREE.Group();
  group.name = 'board';

  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.42, metalness: 0.0 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.97, metalness: 0.0 });
  const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55 });
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.0 });
  [woodMat, gripMat, metalMat, wheelMat].forEach((m) => prep(m));

  const deck = new THREE.Mesh(buildDeckGeometry(), woodMat);
  const grip = new THREE.Mesh(buildGripGeometry(), gripMat);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  prep(ledMat, { wet: false });
  const ledMesh = new THREE.Mesh(ledGeometry(), ledMat);
  ledMesh.castShadow = false;
  const trucks = new THREE.Mesh(truckStaticGeometry(), metalMat);
  for (const m of [deck, grip, trucks]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
  grip.castShadow = false;
  group.add(ledMesh);

  // hangers (pivot groups; the wheels are one InstancedMesh driven by setWheels)
  const wGeo = wheelGeometry();
  const hangers = [];
  for (const [z, sign] of [[TRUCK_Z, 1], [-TRUCK_Z, -1]]) {
    const hg = new THREE.Group();
    hg.position.set(0, -0.03, z);
    const hm = new THREE.Mesh(hangerGeometry(sign), metalMat);
    hm.castShadow = true;
    hg.add(hm);
    group.add(hg);
    hangers.push(hg);
  }
  const wheels = new THREE.InstancedMesh(wGeo, wheelMat, 4);
  wheels.castShadow = true; wheels.receiveShadow = true; wheels.frustumCulled = false;
  group.add(wheels);

  const _mT = new THREE.Matrix4(), _mR = new THREE.Matrix4(), _mW = new THREE.Matrix4();
  const _mFlip = new THREE.Matrix4().makeRotationY(Math.PI);
  /** Update the four wheel instances: hanger transforms must already be set. */
  function setWheels(spin) {
    let k = 0;
    for (const hg of hangers) {
      hg.updateMatrix();
      for (const s of [-1, 1]) {
        _mR.makeRotationX(s < 0 ? -spin : spin);
        _mT.makeTranslation(s * WHEEL_X, AXLE_Y + 0.03, 0);
        _mW.multiplyMatrices(hg.matrix, _mT);
        if (s < 0) _mW.multiply(_mFlip);           // outer face (with the marks) faces outward
        _mW.multiply(_mR);
        wheels.setMatrixAt(k++, _mW);
      }
    }
    wheels.instanceMatrix.needsUpdate = true;
  }
  return { group, hangers, wheels, setWheels, ledMat, materials: [woodMat, gripMat, metalMat, wheelMat, ledMat] };
}
