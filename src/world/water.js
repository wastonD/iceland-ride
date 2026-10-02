// Stream surface (ribbon along world.streamPoints), the waterfall curtain that
// follows the cliff profile, and the rising mist at its foot.

import * as THREE from 'three';
import { FOG_PARS_GLSL, fogUniforms } from '../render/fog.js';
import { streamWidthAt, STREAM_LENGTH } from './layout.js';
import { NOISE_GLSL, RIPPLE_GLSL } from './ground/glsl.js';
import { mulberry32, clamp, smoothstep } from '../core/noise.js';

const CROSS = 25;            // vertices across the ribbon
const WATER_DROP = 0.25;     // matches world.waterLevelAt
const FALL_HALF_W = 3.75;    // waterfall half width (m)

/* -------------------------------------------------------------- stream ribbon */
function buildRibbon(world) {
  const sp = world.streamPoints, n = sp.length - 1;
  const WF = world.waterfallZ;
  const segs = [];
  let a = 0;
  while (a < n && sp[a].z < WF - 0.8) a++;
  segs.push([0, a]);
  let b = a;
  while (b < n && sp[b].z < WF + 1.4) b++;
  segs.push([b, n]);

  const pos = [], dat = [], tan = [], idx = [];
  const arcStep = STREAM_LENGTH / n;
  for (const [i0, i1] of segs) {
    const base = pos.length / 3;
    const rows = [];
    for (let i = i0; i < i1; i += 2) rows.push(i);
    rows.push(i1);
    rows.forEach((i, r) => {
      const p = sp[i], pa = sp[Math.max(0, i - 1)], pb = sp[Math.min(n, i + 1)];
      let tx = pb.x - pa.x, tz = pb.z - pa.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const half = streamWidthAt(i / n) * 0.5;
      const L = half * 1.12 + 0.3;
      const y = world.streamYAtZ(p.z) - WATER_DROP;
      const pool = Math.exp(-((p.z + 116) ** 2) / 60);
      const flow = 1 - 0.6 * pool;
      for (let j = 0; j < CROSS; j++) {
        const l = ((j / (CROSS - 1)) * 2 - 1) * L;
        const x = p.x + nx * l, z = p.z + nz * l;
        pos.push(x, y, z);
        dat.push(l, i * arcStep, y - world.heightAt(x, z), flow);
        tan.push(tx, tz);
      }
      if (r > 0) {
        for (let j = 0; j < CROSS - 1; j++) {
          const q0 = base + (r - 1) * CROSS + j, q1 = q0 + 1, q2 = q0 + CROSS, q3 = q2 + 1;
          idx.push(q0, q1, q2, q1, q3, q2);
        }
      }
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(dat, 4));
  g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const WATER_VERT = /* glsl */ `
attribute vec4 aData;
attribute vec2 aTan;
varying vec4 vData;
varying vec2 vTan;
varying vec3 vWP;
void main() {
  vData = aData; vTan = aTan;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWP = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const WATER_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
${NOISE_GLSL}
${RIPPLE_GLSL}
uniform float uTime;
uniform float uRain;
uniform vec3 uSunCol;
varying vec4 vData;
varying vec2 vTan;
varying vec3 vWP;

const vec2 IMPACT = vec2(-0.4, -122.4);

void main() {
  float t = uTime;
  float lat = vData.x, arc = vData.y, depth = vData.z, flow = vData.w;
  vec3 wp = vWP;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // ---- flowing micro-surface (gradient of scrolled noise, in lateral/along space)
  vec2 f1 = vec2(0.8, 0.22), f2 = vec2(2.0, 0.6), f3 = vec2(4.6, 1.5);
  vec2 q1 = vec2(lat, arc - t * 0.9) * f1;
  vec2 q2 = vec2(lat, arc - t * 1.5) * f2 + 4.3;
  vec2 q3 = vec2(lat, arc - t * 2.3) * f3 + 9.1;
  vec3 n1 = gnd(q1), n2 = gnd(q2), n3 = gnd(q3);
  float dl = n1.y * f1.x * 0.22 + n2.y * f2.x * 0.08 + n3.y * f3.x * 0.035;
  float da = n1.z * f1.y * 0.22 + n2.z * f2.y * 0.08 + n3.z * f3.y * 0.035;
  float detailFade = 1.0 - smoothstep(20.0, 90.0, dist);
  float impactD = length(wp.xz - IMPACT);
  float turb = 1.0 + 2.2 * (1.0 - smoothstep(1.0, 7.0, impactD)) * step(-123.6, wp.z);
  float amp = (0.35 + 0.65 * flow) * detailFade * clamp(depth * 3.0, 0.15, 1.0) * turb;
  vec2 T = vTan, Nl = vec2(-vTan.y, vTan.x);
  vec2 g = (Nl * dl + T * da) * amp;
  g += rainRipples(wp.xz, t, uRain) * (1.0 - smoothstep(10.0, 45.0, dist)) * 2.2;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  // ---- shading
  float cosv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.03 + 0.97 * pow(1.0 - cosv, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = fogColorDir(R);
  float open = smoothstep(0.02, 0.55, R.y);
  vec3 refl = sky * mix(0.32, 1.0, open);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  vec3 body = vec3(0.018, 0.040, 0.036) + skyUp * vec3(0.030, 0.050, 0.045);
  float deepK = 1.0 - exp(-max(depth, 0.0) * 1.7);
  body = mix(body * 1.7, body, deepK);
  vec3 col = mix(body, refl, F);
  float sp = pow(max(dot(R, uSunDir), 0.0), 700.0);
  col += uSunCol * sp * 0.6;

  // ---- alpha: clear at the shore, dark and opaque in the deep
  float wob = (gn(wp.xz * 2.1 + vec2(0.0, t * 0.1)) - 0.5) * 0.10;
  float edge = smoothstep(0.0, 0.10, depth + wob);
  float alpha = edge * mix(0.30, 0.94, deepK);
  alpha = max(alpha, F * edge);

  // ---- foam: shore lace, riffles, plunge-pool churn
  vec2 fp = vec2(lat * 2.4, (arc - t * 0.7) * 2.4);
  float fn = gfbm(fp) * 0.65 + gn(fp * 3.1 + 5.0) * 0.35;
  float shore = smoothstep(0.42, 0.02, depth + wob * 0.8) * smoothstep(0.32, 0.62, fn + 0.12);
  float churn = (1.0 - smoothstep(0.8, 6.5, impactD)) * step(-123.6, wp.z);
  vec2 cp = wp.xz * 1.35 + vec2(0.0, t * 0.5);
  float cn = gfbm(cp) * 0.6 + gfbm(cp * 2.3 - t * 0.3) * 0.4;
  float churnF = churn * smoothstep(0.30, 0.68, cn + churn * 0.42);
  float foam = clamp(max(shore * 0.75, churnF), 0.0, 1.0);
  vec3 foamCol = (skyUp * 0.85 + 0.03) * vec3(0.90, 0.96, 0.95);
  col = mix(col, foamCol, foam * 0.75);
  alpha = max(alpha, foam * 0.75 * step(0.0, depth + 0.05));

  col = applyHeightFog(col, wp);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* -------------------------------------------------------------- waterfall */
function buildCurtain(world) {
  const WF = world.waterfallZ;
  // stream centre x at the cliff
  const sp = world.streamPoints;
  let cx = 0, best = 1e9;
  for (const p of sp) { const d = Math.abs(p.z - WF); if (d < best) { best = d; cx = p.x; } }
  const zTop = WF - 1.6;
  const yTop = world.streamYAtZ(zTop + 0.35) - WATER_DROP;      // lip water level
  const poolY = world.streamYAtZ(WF + 4) - WATER_DROP;          // plunge pool surface
  const ROWS = 56, COLS = 33;
  const pos = [], uv = [], idx = [];
  for (let r = 0; r < ROWS; r++) {
    const f = r / (ROWS - 1);
    const y = yTop + (poolY - yTop) * f;
    for (let c = 0; c < COLS; c++) {
      const u = c / (COLS - 1);
      // slight fan-out toward the bottom
      const x = cx + (u * 2 - 1) * FALL_HALF_W * (1 + 0.12 * f) + Math.sin(f * 5 + u * 3) * 0.05;
      // find the cliff surface z where height == y (bisection; height falls with z)
      let lo = WF - 3.5, hi = WF + 3.5;
      for (let it = 0; it < 22; it++) {
        const mid = (lo + hi) * 0.5;
        if (world.heightAt(x, mid) > y - 0.02) lo = mid; else hi = mid;
      }
      const zSurf = (lo + hi) * 0.5;
      const push = 0.16 + 0.5 * f * f + 0.10 * Math.sin(u * 9 + f * 4);
      pos.push(x, y, Math.max(zSurf, zTop) + push);
      uv.push(u, f);
    }
  }
  for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS - 1; c++) {
    const a = r * COLS + c, b = a + 1, d = a + COLS, e = d + 1;
    idx.push(a, b, d, b, e, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return { geo: g, cx, yTop, poolY, zBase: WF + 2.6 };
}

const FALL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWP;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWP = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FALL_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
${NOISE_GLSL}
uniform float uTime;
uniform float uHeight;
uniform float uWidth;
varying vec2 vUv;
varying vec3 vWP;

void main() {
  float t = uTime;
  float across = vUv.x * uWidth;
  float f = vUv.y;                       // 0 at the lip, 1 at the pool
  float down = f * uHeight;
  // falling water accelerates: stretch the pattern with distance fallen
  float fall = down * (0.55 + 0.45 * f);
  float s1 = gfbm(vec2(across * 2.6, fall * 0.20 + t * 2.1));
  float s2 = gn(vec2(across * 8.5, fall * 0.55 + t * 4.2));
  float s3 = gn(vec2(across * 21.0 + 7.0, fall * 1.3 + t * 7.5));
  float streak = s1 * 0.5 + s2 * 0.32 + s3 * 0.18;
  float white = smoothstep(0.42, 0.82, streak);

  // ragged side edges
  float e = min(vUv.x, 1.0 - vUv.x) * uWidth;
  float edgeN = (gn(vec2(fall * 0.9 + t * 3.0, vUv.x * 4.0)) - 0.5) * 1.1;
  float side = smoothstep(0.0, 1.0, e + edgeN);

  float thin = mix(0.42, 1.0, smoothstep(0.0, 0.22, f));      // glassy where it leaves the lip
  float foot = smoothstep(0.80, 1.0, f);                      // impact foam
  float alpha = (0.34 + 0.6 * white + 0.12 * streak) * thin * side;
  alpha = mix(alpha, 0.98 * side, foot * 0.75);

  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  vec3 lit = skyUp * 0.85 + 0.03;
  vec3 deep = vec3(0.10, 0.17, 0.16) * (0.5 + skyUp * 0.9);
  float bright = clamp(white * 0.9 + foot * 0.6 + 0.04, 0.0, 1.0);
  vec3 col = mix(deep, lit * vec3(0.95, 1.0, 0.98), bright);
  // lip highlight
  col += lit * 0.25 * smoothstep(0.06, 0.0, f) * (0.4 + white);

  col = applyHeightFog(col, vWP);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ------------------------------------------------------------------- mist */
const MIST_VERT = /* glsl */ `
attribute vec3 aOff;       // xz offset from the impact point, y = phase
attribute vec3 aSeed;      // size, rate, drift
uniform float uTime;
uniform vec3 uBase;
varying vec2 vQ;
varying float vLife;
varying float vSeed;
varying vec3 vWP;
void main() {
  float life = fract(uTime * aSeed.y + aOff.z);
  vLife = life;
  vSeed = aSeed.x;
  vec3 c = uBase + vec3(aOff.x, 0.0, aOff.y);
  c.y += 0.6 + life * 4.0 * aSeed.z + 0.5 * sin(uTime * 0.6 + aOff.x);
  c.x += (life * 3.0 - 1.0) * aSeed.z + 0.6 * sin(uTime * 0.35 + aOff.y);
  c.z += life * 2.2;
  float size = aSeed.x * (1.0 + life * 1.8);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  vWP = c;
  vQ = position.xy;
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
}`;

const MIST_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
${NOISE_GLSL}
uniform float uTime;
uniform float uRain;
varying vec2 vQ;
varying float vLife;
varying float vSeed;
varying vec3 vWP;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  float soft = pow(1.0 - r, 1.8);
  float n = gfbm(vQ * 2.2 + vSeed * 13.0 + uTime * 0.05 + vLife * 2.0);
  float a = soft * (0.35 + 0.9 * n) * sin(3.14159 * vLife);
  float dCam = length(cameraPosition - vWP);
  a *= smoothstep(2.0, 7.0, dCam);
  a *= 0.13;
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  vec3 col = skyUp * 0.85 + 0.03;
  col = applyHeightFog(col, vWP);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildMist(base) {
  const N = 44, rnd = mulberry32(4242);
  const quad = new THREE.PlaneGeometry(2, 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.getAttribute('position'));
  const off = new Float32Array(N * 3), seed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    off[i * 3] = (rnd() - 0.5) * 8.5;
    off[i * 3 + 1] = (rnd() - 0.4) * 5.5;
    off[i * 3 + 2] = rnd();
    seed[i * 3] = 2.2 + rnd() * 2.6;
    seed[i * 3 + 1] = 0.045 + rnd() * 0.04;
    seed[i * 3 + 2] = 0.6 + rnd() * 0.8;
  }
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
  g.instanceCount = N;
  return g;
}

/* ------------------------------------------------------------------ module */
export function createWater(ctx) {
  const { scene, world, uniforms: U } = ctx;
  const group = new THREE.Group();
  group.name = 'water';

  // stream surface
  const ribbon = buildRibbon(world);
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT, fragmentShader: WATER_FRAG,
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    uniforms: { ...fogUniforms(), uTime: U.uTime, uRain: U.uRain, uSunCol: U.uSunCol },
  });
  const water = new THREE.Mesh(ribbon, waterMat);
  water.renderOrder = 1;
  water.frustumCulled = false;
  group.add(water);

  // waterfall curtain
  const fall = buildCurtain(world);
  const fallMat = new THREE.ShaderMaterial({
    vertexShader: FALL_VERT, fragmentShader: FALL_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { ...fogUniforms(), uTime: U.uTime, uHeight: { value: fall.yTop - fall.poolY }, uWidth: { value: FALL_HALF_W * 2.2 } },
  });
  const curtain = new THREE.Mesh(fall.geo, fallMat);
  curtain.renderOrder = 2;
  group.add(curtain);

  // mist
  const mistGeo = buildMist();
  const mistMat = new THREE.ShaderMaterial({
    vertexShader: MIST_VERT, fragmentShader: MIST_FRAG,
    transparent: true, depthWrite: false,
    uniforms: { ...fogUniforms(), uTime: U.uTime, uRain: U.uRain, uBase: { value: new THREE.Vector3(fall.cx, fall.poolY, world.waterfallZ + 2.2) } },
  });
  const mist = new THREE.Mesh(mistGeo, mistMat);
  mist.frustumCulled = false;
  mist.renderOrder = 3;
  group.add(mist);

  scene.add(group);
  return {
    group,
    update() {},
    dispose() {
      scene.remove(group);
      ribbon.dispose(); fall.geo.dispose(); mistGeo.dispose();
      waterMat.dispose(); fallMat.dispose(); mistMat.dispose();
    },
  };
}
