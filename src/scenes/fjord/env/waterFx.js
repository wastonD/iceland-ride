// Set-piece water effects: the plateau mirror lake (planar reflection), the geothermal
// hot-spring pool + mud pots, and one soft-particle system for steam / spray / mist
// (with a physically placed rainbow in the hairpin-fall spray).

import * as THREE from 'three';
import { FOG_PARS_GLSL, fogUniforms } from '../../../render/fog.js';
import { FEATURES } from './features.js';
import { mulberry32 } from '../../../core/noise.js';

const F = FEATURES;

/* =============================================================== mirror lake */
const LAKE_VERT = /* glsl */ `
varying vec3 vWP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWP = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

function lakeFrag(td, ENV_GLSL, RIPPLE_GLSL) {
  return /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
${RIPPLE_GLSL}
${ENV_GLSL}
uniform float uTime, uRain, uWindStrength, uReflOn;
uniform vec3 uSunCol, uWind;
uniform sampler2D tRefl;
uniform vec2 uRes;
uniform mat4 uTexMat;
varying vec3 vWP;
void main() {
  vec3 wp = vWP;
  float depth = wp.y - baseH(wp.xz);
  if (depth < -0.02) discard;
  vec3 toC = cameraPosition - wp;
  float dist = length(toC);
  vec3 V = toC / dist;
  float t = uTime;
  // calm: only cat's-paw ripples where gusts touch the water, plus rain rings
  vec2 wd = normalize(uWind.xz + vec2(1e-4));
  float gustMask = smoothstep(0.55, 0.85, tgn(wp.xz * 0.02 - wd * t * 0.15) * 0.7 + tgn(wp.xz * 0.06 + t * 0.05) * 0.3) * (0.3 + uWindStrength);
  vec3 r1 = tgnd(wp.xz * 0.9 - wd * t * 0.6), r2 = tgnd(wp.xz * 2.3 + wd.yx * t * 0.8 + 7.0);
  vec2 g = (r1.yz * 0.012 + r2.yz * 0.006) * (0.15 + gustMask * 1.6) * (1.0 - smoothstep(40.0, 300.0, dist) * 0.7);
  g += rainRipples(wp.xz, t, uRain) * (1.0 - smoothstep(10.0, 45.0, dist)) * 2.0;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float NV = max(dot(N, V), 1e-3);
  float Fr = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.005; R = normalize(R);
  vec3 refl = skyRefl(R, 0.02 + gustMask * 0.05);
  if (uReflOn > 0.5) {
    vec4 pc = uTexMat * vec4(wp, 1.0);
    vec2 uv = pc.xy / pc.w + N.xz * 0.25;
    vec4 m = texture2D(tRefl, clamp(uv, vec2(0.001), vec2(0.999)));
    refl = mix(refl, m.rgb, m.a);
  }
  float sunVis = terrSunVis(wp.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  float dk = 1.0 - exp(-max(depth, 0.0) * 0.6);
  vec3 body = mix(vec3(0.1, 0.12, 0.09), vec3(0.01, 0.03, 0.035), dk) * (skyUp * 0.55 + uSunCol * max(uSunDir.y, 0.0) * 0.1 * sunVis);
  // clear highland water: you see the pebbles in the shallows, the sky everywhere else
  vec3 col = mix(body, refl, Fr);
  vec3 Hh = normalize(uSunDir + V);
  float a2 = 0.02 + gustMask * 0.03;
  float NH = max(dot(N, Hh), 0.0), dd = NH * NH * (a2 * a2 - 1.0) + 1.0;
  col += uSunCol * min(a2 * a2 / (3.14159 * dd * dd) * Fr * 0.25 / NV, 40.0) * sunVis * max(dot(N, uSunDir), 0.0);
  float alpha = mix(0.35, 1.0, smoothstep(0.0, 1.8, depth));
  alpha = max(alpha, Fr) * smoothstep(-0.02, 0.08, depth);
  col = applyHeightFog(col, wp);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

export function createMirrorLake(ctx, td, commonUniforms, ENV_GLSL, RIPPLE_GLSL) {
  const { renderer, scene, camera, uniforms: U } = ctx;
  const L = F.lake;
  const geo = new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2);
  geo.scale(L.rx * 1.45, 1, L.rz * 1.45);
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
  const res = new THREE.Vector2(1, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: LAKE_VERT, fragmentShader: lakeFrag(td, ENV_GLSL, RIPPLE_GLSL),
    uniforms: { ...commonUniforms, uWindStrength: U.uWindStrength, uReflOn: { value: 0 }, tRefl: { value: rt.texture }, uRes: { value: res }, uTexMat: { value: new THREE.Matrix4() } },
    transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(L.x, L.level, L.z);
  mesh.renderOrder = 1;
  mesh.name = 'mirrorLake';
  mesh.userData.reflection = { rt, mirrorCam: null };

  // planar reflection (three's Reflector math), terrain only (layer 5), half resolution
  const mirrorCam = new THREE.PerspectiveCamera();
  mirrorCam.layers.set(5);
  mesh.userData.reflection.mirrorCam = mirrorCam;
  const plane = new THREE.Plane(), normal = new THREE.Vector3(0, 1, 0), mirrorPos = new THREE.Vector3(L.x, L.level, L.z);
  const camPos = new THREE.Vector3(), view = new THREE.Vector3(), target = new THREE.Vector3(), lookAt = new THREE.Vector3(), rot = new THREE.Matrix4();
  const clipPlane = new THREE.Plane(), clipVector = new THREE.Vector4(), q = new THREE.Vector4();
  const savedCam = new THREE.Vector3(), savedClear = new THREE.Color();
  let rendering = false, litLayers = false, tick = 0;
  const tier = () => ctx.state.get('resolvedQuality');
  mesh.onBeforeRender = (r, sc, cam) => {
    if (cam !== camera || rendering) return;
    camPos.setFromMatrixPosition(cam.matrixWorld);
    const dxz = Math.hypot((camPos.x - L.x) / L.rx, (camPos.z - L.z) / L.rz) * Math.min(L.rx, L.rz);
    const qt = tier();
    if (qt === 'low' || dxz > 350 || camPos.y < L.level + 0.2 || !td.prepareReflection) { mat.uniforms.uReflOn.value = 0; return; }
    // refresh every 2nd frame (3rd on medium); the texture is reused in between
    if ((tick++ % (qt === 'high' ? 2 : 3)) !== 0 && mat.uniforms.uReflOn.value > 0.5) return;
    // size: half the drawing buffer
    r.getDrawingBufferSize(res);
    const div = qt === 'high' ? 3 : 4;
    const w = Math.max(2, Math.floor(res.x / div)), h = Math.max(2, Math.floor(res.y / div));
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    view.subVectors(mirrorPos, camPos);
    view.reflect(normal).negate().add(mirrorPos);
    rot.extractRotation(cam.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(mirrorPos, lookAt).reflect(normal).negate().add(mirrorPos);
    mirrorCam.position.copy(view);
    mirrorCam.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    mirrorCam.lookAt(target);
    mirrorCam.far = cam.far; mirrorCam.near = cam.near;
    mirrorCam.updateMatrixWorld();
    mirrorCam.projectionMatrix.copy(cam.projectionMatrix);
    mat.uniforms.uTexMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);
    // oblique near plane = the water surface (nothing under the lake leaks in)
    plane.setFromNormalAndCoplanarPoint(normal, mirrorPos);
    clipPlane.copy(plane).applyMatrix4(mirrorCam.matrixWorldInverse);
    clipVector.set(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
    const pm = mirrorCam.projectionMatrix.elements;
    q.x = (Math.sign(clipVector.x) + pm[8]) / pm[0];
    q.y = (Math.sign(clipVector.y) + pm[9]) / pm[5];
    q.z = -1.0;
    q.w = (1.0 + pm[10]) / pm[14];
    clipVector.multiplyScalar(2.0 / clipVector.dot(q));
    pm[2] = clipVector.x; pm[6] = clipVector.y; pm[10] = clipVector.z + 1.0 - 0.003; pm[14] = clipVector.w;
    mirrorCam.projectionMatrixInverse.copy(mirrorCam.projectionMatrix).invert();

    // lights are only gathered for objects on the camera's layers: let sun + sky light the mirror pass
    if (!litLayers) { sc.traverse((o) => { if (o.isLight) o.layers.enable(5); }); litLayers = true; }
    td.prepareReflection(mirrorCam);
    rendering = true;
    const prevRT = r.getRenderTarget(), prevShadow = r.shadowMap.autoUpdate, prevAlpha = r.getClearAlpha();
    r.getClearColor(savedClear);
    savedCam.copy(U.uCamPos.value);
    U.uCamPos.value.copy(mirrorCam.position);
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(sc, mirrorCam);
    r.setRenderTarget(prevRT);
    r.setClearColor(savedClear, prevAlpha);
    r.shadowMap.autoUpdate = prevShadow;
    U.uCamPos.value.copy(savedCam);
    rendering = false;
    mat.uniforms.uReflOn.value = 1;
  };
  return { mesh, mat, geo, dispose() { rt.dispose(); geo.dispose(); mat.dispose(); } };
}

/* ========================================================== hot-spring pool */
const POOL_FRAG = (td, ENV_GLSL) => /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
${ENV_GLSL}
uniform float uTime, uMud, uRad;
uniform vec2 uCenter, uImpact;
uniform vec3 uSunCol;
varying vec3 vWP;
varying vec2 vUv;
void main() {
  vec3 wp = vWP;
  vec3 toC = cameraPosition - wp;
  float dist = length(toC);
  vec3 V = toC / dist;
  float t = uTime;
  float sunVis = terrSunVis(wp.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  vec3 col; float alpha;
  if (uMud > 1.5) {
    // plunge pool under a waterfall: deep teal-black water, white churn around the impact,
    // radial foam lines drifting outward
    float depth = wp.y - baseH(wp.xz);
    if (depth < -0.02) discard;
    vec2 rel = wp.xz - uCenter;
    float r = length(rel) / uRad;
    vec3 g3 = tgnd(wp.xz * 1.3 + vec2(t * 0.6, -t * 0.45)), g4 = tgnd(wp.xz * 3.1 - vec2(t * 0.9, t * 0.7));
    vec3 N = normalize(vec3(-(g3.y * 0.08 + g4.y * 0.04), 1.0, -(g3.z * 0.08 + g4.z * 0.04)));
    float Fr = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 body = mix(vec3(0.03, 0.09, 0.09), vec3(0.01, 0.035, 0.04), smoothstep(0.0, 1.2, depth)) * (skyUp * 0.6 + uSunCol * 0.1 * sunVis);
    col = mix(body, skyRefl(reflect(-V, N), 0.06), Fr);
    float impact = 1.0 - smoothstep(0.0, 0.75, length(wp.xz - uImpact) / uRad);
    float churn = tgn(vec2(atan(rel.y, rel.x) * 3.0, r * 6.0 - t * 1.6)) * 0.6 + tgn(wp.xz * 2.2 + t * 0.8) * 0.4;
    float foam = clamp(impact * 1.3 + smoothstep(0.55, 0.85, churn) * (0.35 + 0.65 * impact) + (1.0 - smoothstep(0.02, 0.2, depth)) * 0.6, 0.0, 1.0);
    vec3 foamCol = (uSunCol * 0.28 * max(uSunDir.y, 0.1) * sunVis + skyUp * 0.9) * 0.9;
    col = mix(col, foamCol, foam * 0.9);
    alpha = max(mix(0.8, 0.97, smoothstep(0.0, 0.5, depth)), foam) * smoothstep(0.03, 0.3, depth) * (1.0 - smoothstep(0.8, 1.0, r));
  } else if (uMud < 0.5) {
    float depth = wp.y - baseH(wp.xz);
    if (depth < -0.02) discard;
    // milky silica water (Blue Lagoon): opaque turquoise, soft sky sheen, drifting steam
    vec3 g3 = tgnd(wp.xz * 0.8 + vec2(t * 0.1, -t * 0.07));
    vec3 N = normalize(vec3(-g3.y * 0.03, 1.0, -g3.z * 0.03));
    float Fr = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 milk = mix(vec3(0.07, 0.36, 0.44), vec3(0.16, 0.5, 0.55), smoothstep(0.0, 1.2, depth) * 0.4 + tgn(wp.xz * 0.3 + t * 0.02) * 0.6);
    milk = mix(vec3(0.42, 0.55, 0.52), milk, smoothstep(0.0, 0.25, depth));    // silica shallows at the rim
    col = milk * (skyUp * 0.6 + uSunCol * max(uSunDir.y, 0.0) * 0.12 * sunVis);
    col = mix(col, skyRefl(reflect(-V, N), 0.05), Fr * 0.8);
    float steam = smoothstep(0.45, 0.85, tgn(wp.xz * 0.35 + vec2(t * 0.25, t * 0.1)) * 0.6 + tgn(wp.xz * 1.1 - t * 0.3) * 0.4);
    col = mix(col, skyUp * 1.0 + uSunCol * 0.04 * sunVis, steam * 0.18);
    alpha = mix(0.75, 0.98, smoothstep(0.0, 0.6, depth)) * smoothstep(-0.02, 0.06, depth);
  } else {
    // bubbling mud pot: grey-brown, bubbles swell and pop with expanding rings
    vec2 p = wp.xz * 1.6;
    vec2 cell = floor(p), f = fract(p) - 0.5;
    float h1 = tgh(cell), ph = fract(t * (0.35 + 0.4 * h1) + h1 * 7.0);
    float r = length(f - (vec2(tgh(cell + 3.1), tgh(cell + 7.7)) - 0.5) * 0.4);
    float bub = smoothstep(0.3 * ph, 0.0, r) * step(ph, 0.7);
    float ring = exp(-pow((r - (ph - 0.7) * 1.2) / 0.03, 2.0)) * step(0.7, ph) * (1.0 - ph) * 3.0;
    vec3 N = normalize(vec3((f - 0.5) * bub * 0.8, 1.0).xzy);
    vec3 mud = vec3(0.3, 0.27, 0.24) * (0.8 + 0.3 * tgn(wp.xz * 3.0));
    col = mud * (skyUp * 0.6 + uSunCol * 0.3 * sunVis * max(dot(N, uSunDir), 0.0));
    col = mix(col, skyRefl(reflect(-V, N), 0.1), 0.06 + 0.3 * pow(1.0 - max(dot(N, V), 0.0), 5.0)) + skyUp * 0.1 * (bub + ring);
    float er = length(vUv - 0.5) * 2.0;
    alpha = 1.0 - smoothstep(0.55 + tgn(wp.xz * 2.0) * 0.3, 1.0, er);
  }
  col = applyHeightFog(col, wp);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const POOL_VERT = /* glsl */ `
varying vec3 vWP;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWP = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
export function createPlungePool(ctx, td, commonUniforms, ENV_GLSL, P, lip) {
  const geo = new THREE.CircleGeometry(P.r * 1.05, 40).rotateX(-Math.PI / 2);
  const toTop = new THREE.Vector2(lip[0] - P.x, lip[2] - P.z).normalize().multiplyScalar(P.r * 0.45);
  const mat = new THREE.ShaderMaterial({
    vertexShader: POOL_VERT, fragmentShader: POOL_FRAG(td, ENV_GLSL),
    uniforms: { ...commonUniforms, uMud: { value: 2 }, uRad: { value: P.r }, uCenter: { value: new THREE.Vector2(P.x, P.z) }, uImpact: { value: new THREE.Vector2(P.x + toTop.x, P.z + toTop.y) } },
    transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(P.x, P.level, P.z);
  mesh.renderOrder = 1;
  mesh.name = 'plungePool';
  return { mesh, dispose() { geo.dispose(); mat.dispose(); } };
}

export function createHotPool(ctx, td, commonUniforms, ENV_GLSL) {
  const P = F.geothermal.pool, G = F.geothermal;
  const vert = POOL_VERT;
  const poolGeo = new THREE.CircleGeometry(P.r * 1.3, 40).rotateX(-Math.PI / 2);
  const poolMat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: POOL_FRAG(td, ENV_GLSL), uniforms: { ...commonUniforms, uMud: { value: 0 }, uRad: { value: 1 }, uCenter: { value: new THREE.Vector2() }, uImpact: { value: new THREE.Vector2() } },
    transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const pool = new THREE.Mesh(poolGeo, poolMat);
  pool.position.set(P.x, P.level, P.z);
  pool.renderOrder = 1;
  pool.name = 'hotSpring';
  // mud pots on the far side of the pool (away from the road)
  const rnd = mulberry32(99);
  const pots = [];
  for (let k = 0; k < 4; k++) {
    const a = 1.2 + k * 0.7 + rnd() * 0.3, d = P.r + 6 + rnd() * 8;
    const x = G.x + Math.cos(a) * (d + 4), z = G.z + Math.sin(a) * (d + 4);
    if (ctx.world.roadDistAt(x, z) < 9) continue;
    const r = 1.1 + rnd() * 0.9;
    const g = new THREE.CircleGeometry(r, 18).rotateX(-Math.PI / 2).translate(x, td.heightAt(x, z) + 0.06, z);
    pots.push(g);
  }
  const merged = mergeGeos(pots);
  const mudMat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: POOL_FRAG(td, ENV_GLSL), uniforms: { ...commonUniforms, uMud: { value: 1 }, uRad: { value: 1 }, uCenter: { value: new THREE.Vector2() }, uImpact: { value: new THREE.Vector2() } },
    transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mud = new THREE.Mesh(merged, mudMat);
  mud.name = 'mudPots';
  const vents = [];
  for (let k = 0; k < 7; k++) {
    const a = k * 0.9 + rnd() * 0.5, d = 5 + rnd() * (G.r - 10);
    const x = G.x + Math.cos(a) * d, z = G.z + Math.sin(a) * d;
    if (ctx.world.roadDistAt(x, z) < 8 || Math.hypot(x - P.x, z - P.z) < P.r + 1) continue;
    vents.push({ x, y: td.heightAt(x, z), z, big: k < 2 });
  }
  return { meshes: [pool, mud], vents, dispose() { poolGeo.dispose(); poolMat.dispose(); merged.dispose(); mudMat.dispose(); } };
}

function mergeGeos(list) {
  let n = 0, m = 0;
  for (const g of list) { n += g.attributes.position.count; m += g.index.count; }
  const pos = new Float32Array(n * 3), uvs = new Float32Array(n * 2), idx = new Uint32Array(m);
  let o = 0, oi = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    uvs.set(g.attributes.uv.array, o * 2);
    for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.array[i] + o;
    o += g.attributes.position.count;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/* ============================================================ soft particles */
// One instanced quad per puff. aP = base xyz + seed, aQ = rise, life, size0, size1,
// aR = drift xz, alpha, kind (0 steam, 1 fall spray with rainbow, 2 low spray).
const PART_VERT = /* glsl */ `
attribute vec4 aP, aQ, aR;
uniform float uTime;
uniform vec3 uWind;
uniform float uWindStrength;
varying vec2 vUv;
varying vec3 vWP;
varying float vA;
varying float vKind;
varying float vAge;
void main() {
  vUv = uv;
  float age = fract(uTime / aQ.y + aP.w);
  float sz = mix(aQ.z, aQ.w, sqrt(age));
  vec2 wd = uWind.xz * (0.4 + uWindStrength);
  vec3 c = aP.xyz + vec3(aR.x * age + wd.x * age * age * aQ.y * 0.6, aQ.x * (1.0 - (1.0 - age) * (1.0 - age)), aR.y * age + wd.y * age * age * aQ.y * 0.6);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float spin = aP.w * 6.2831 + uTime * 0.05 * (fract(aP.w * 13.0) - 0.5);
  vec2 q = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * position.xy;
  // fade in / out over the puff's life; thin out when the camera is inside it
  float dc = distance(cameraPosition, c);
  vA = aR.z * smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.55, 1.0, age)) * smoothstep(sz * 0.3, sz * 1.1, dc);
  // overdraw guard: a puff closer than ~its own size is nearly invisible anyway — shrink it
  // away (and collapse fully transparent ones) so they don't fill the screen with blending
  sz *= (smoothstep(sz * 0.2, sz * 0.8, dc) * 0.8 + 0.2) * step(0.004, vA);
  vec3 p = c + (camR * q.x + camU * q.y) * sz;
  vWP = p;
  vKind = aR.w;
  vAge = age;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const PART_FRAG = (td) => /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
uniform float uTime;
uniform vec3 uSunCol;
varying vec2 vUv;
varying vec3 vWP;
varying float vA;
varying float vKind;
varying float vAge;
vec3 rainbow(float x) {           // x: 0 inner (violet) … 1 outer (red)
  vec3 c = clamp(vec3(abs(x * 6.0 - 3.0) - 1.0, 2.0 - abs(x * 6.0 - 2.0), 2.0 - abs(x * 6.0 - 4.0)), 0.0, 1.0);
  return c.bgr;
}
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  float n = tgn(q * 3.0 + vWP.xz * 0.05 + uTime * 0.05) * 0.6 + tgn(q * 7.0 - uTime * 0.1) * 0.4;
  float a = pow(max(1.0 - smoothstep(0.0, 1.0, r + (n - 0.5) * 0.5), 0.0), 2.2) * vA;
  if (a < 0.003) discard;
  vec3 rd = normalize(vWP - cameraPosition);
  float vis = terrSunVis(vWP.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  // strong forward scattering: steam lights up when you look toward the sun
  float mu = dot(rd, uSunDir);
  float g = 0.65, hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.08;
  vec3 col = vec3(0.95) * (skyUp * 1.15 + uSunCol * vis * (0.16 + hg));
  // rainbow: 40–42° from the antisolar point, only in the fall spray, only in sunlight
  if (vKind > 0.5 && vKind < 1.5) {
    float ang = degrees(acos(clamp(dot(rd, -uSunDir), -1.0, 1.0)));
    float band = smoothstep(39.5, 40.5, ang) * (1.0 - smoothstep(42.3, 43.2, ang));
    col += rainbow(clamp((ang - 40.0) / 2.6, 0.0, 1.0)) * band * uSunCol * vis * 0.35 * step(0.02, uSunDir.y);
    a = min(a * (1.0 + band * 0.6), 1.0);
  }
  col = applyHeightFog(col, vWP);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createParticles(ctx, td, emitters) {
  const U = ctx.uniforms;
  const rnd = mulberry32(4711);
  const P = [], Q = [], R = [];
  for (const e of emitters) {
    for (let i = 0; i < e.count; i++) {
      const [ox, oy, oz] = e.spawn(rnd);
      P.push(ox, oy, oz, rnd());
      Q.push(e.rise * (0.7 + rnd() * 0.6), e.life * (0.75 + rnd() * 0.5), e.size0 * (0.7 + rnd() * 0.6), e.size1 * (0.7 + rnd() * 0.6));
      const [dx, dz] = e.drift ? e.drift(rnd, ox, oz) : [0, 0];
      R.push(dx, dz, e.alpha * (0.7 + rnd() * 0.6), e.kind);
    }
  }
  // interleave emitters (Fisher–Yates on instance order) so thinning keeps every emitter
  const nI = P.length / 4, order = Array.from({ length: nI }, (_, i) => i);
  for (let i = nI - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const shuf = (a) => { const o = new Float32Array(a.length); order.forEach((src, dst) => o.set(a.slice(src * 4, src * 4 + 4), dst * 4)); return o; };
  const Ps = shuf(P), Qs = shuf(Q), Rs = shuf(R);
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('uv', quad.attributes.uv);
  g.setAttribute('aP', new THREE.InstancedBufferAttribute(Ps, 4));
  g.setAttribute('aQ', new THREE.InstancedBufferAttribute(Qs, 4));
  g.setAttribute('aR', new THREE.InstancedBufferAttribute(Rs, 4));
  g.instanceCount = P.length / 4;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    vertexShader: PART_VERT, fragmentShader: PART_FRAG(td),
    uniforms: { ...fogUniforms(), ...td.uniforms, uTime: U.uTime, uSunCol: U.uSunCol, uWind: U.uWind, uWindStrength: U.uWindStrength },
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.name = 'steamSpray';
  // particles are shuffled per emitter order; thinning = drawing a prefix of a shuffled list
  const full = g.instanceCount;
  const applyQ = (q) => { g.instanceCount = Math.floor(full * (q === 'low' ? 0.35 : q === 'medium' ? 0.6 : 1)); };
  applyQ(ctx.state.get('resolvedQuality'));
  const off = ctx.state.on('resolvedQuality', applyQ);
  return { mesh, count: full, dispose() { off?.(); g.dispose(); quad.dispose(); mat.dispose(); } };
}
