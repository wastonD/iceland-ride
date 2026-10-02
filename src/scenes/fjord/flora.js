// Fjord flora: tundra grass, Nootka-lupine fields, stones (GPU-procedural fields that
// follow the camera: each world cell hashes to the same plant, so nothing swims), plus
// static basalt boulders and downy-birch scrub (InstancedMesh, cast shadows).
//
// Field instances are placed entirely in the vertex shader on the exact rendered terrain
// surface (shared terrainData GLSL), densities come from the same masks the terrain
// shader uses (lupine field, road/river distance, slope), so distant purple patches on the
// ground continue seamlessly into real flower spikes near the road.
// Nothing taller than 0.4 m within 3 m of the asphalt edge (road half-width 3.75 m).

import * as THREE from 'three';
import { addShaderPatch } from '../../render/shaderPatch.js';
import { getTerrainData, addBakedLight, lupineJS, riverDistJS } from './env/terrainData.js';
import { groundUniforms } from './env/groundTex.js';
import { grassTuft, lupinePlant, stoneGeo, shrubGeo, bladeCardTuft } from './env/floraGeo.js';
import { awaitPhotoAssets, loadPhotoAssets, PHOTO_STATS } from './env/photoAssets.js';
import { photoRockMaterial, createPhotoRocks } from './env/photoRocks.js';
import { FEATURES, featureClearJS, pastureJS, bayR } from './env/features.js';
import { mulberry32, smoothstep, clamp, fbm2f as fbm2 } from '../../core/noise.js';

const QUALITY = { high: 1, medium: 0.65, low: 0.48 };
const ROCK_OCC = { tRockOcc: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) }, uRockOccOn: { value: 0 } };
ROCK_OCC.tRockOcc.value.needsUpdate = true;

/* --------------------------------------------------------- field shader */
const FIELD_PARS = /* glsl */ `
vec2 fh22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
attribute vec2 aCell;
uniform float uCell, uRadius, uSeed, uTilt, uWindAmp, uFlutter;
uniform vec2 uFade;
uniform float uTime, uWindStrength, uRain;
uniform vec3 uWind;
uniform sampler2D tRockOcc;   // photo-rock footprints (2 m texels over ±2048 m): nothing grows through a rock
uniform float uRockOccOn;
varying float vFHash;
varying float vFDens;
`;

// Coherent wind for the photo grass: one wind direction, soft gust patches drifting downwind
// across the meadow (~5.5 m/s) plus a travelling ripple; bent blades show paler (fGust -> tint).
const GUST_WIND = /* glsl */ `
    vec2 wD = normalize(uWind.xz + vec2(1e-5));
    vec2 gp = wxz - wD * (uTime * 5.5);
    float gust = smoothstep(0.28, 0.85, tgn(gp * 0.035 + 1.7) * 0.62 + tgn(GROT2 * gp * 0.09 + 3.7) * 0.38);
    float ripple = 0.5 + 0.5 * sin(dot(wxz, wD) * 0.42 - uTime * 2.4 + tgn(wxz * 0.05) * 3.0);
    float ws = 0.3 + uWindStrength;
    float bend = ws * (0.22 + 0.95 * gust + 0.25 * ripple * (0.35 + gust));
    float hy = max(lp.y, 0.0);
    vec2 disp = wD * bend * uWindAmp * hy * hy;
    disp += vec2(-wD.y, wD.x) * sin(uTime * 2.1 + h1 * 6.2831) * 0.12 * uWindAmp * hy * hy * ws;
    disp += vec2(sin(uTime * 7.0 + h2 * 20.0 + position.x * 40.0), cos(uTime * 6.3 + h1 * 20.0 + position.z * 40.0)) * uFlutter * hy * (0.3 + gust) * ws;
    lp.xz += disp;
    lp.y -= dot(disp, disp) * 0.5 / max(hy, 0.05) * step(0.001, hy);
    fGust = gust * ws;
`;
const OLD_WIND = /* glsl */ `
    vec2 wD = normalize(uWind.xz + vec2(1e-5));
    float gust = 0.55 + 0.45 * sin(dot(wxz, wD) * 0.07 - uTime * 1.2 + h5 * 2.0);
    float sway = (0.55 + 0.45 * sin(uTime * 1.6 + h5 * 6.2831) + 0.3 * sin(uTime * 3.7 + h4 * 6.2831)) * (0.25 + uWindStrength) * gust;
    float hy = max(lp.y, 0.0);
    vec2 disp = wD * sway * uWindAmp * hy * hy;
    disp += vec2(-wD.y, wD.x) * sin(uTime * 2.3 + h1 * 6.2831) * 0.3 * uWindAmp * hy * hy * (0.3 + uWindStrength);
    disp += vec2(sin(uTime * 7.0 + h2 * 20.0 + position.x * 30.0), cos(uTime * 6.3 + h1 * 20.0 + position.z * 30.0)) * uFlutter * hy * (0.3 + uWindStrength);
    lp.xz += disp;
    lp.y -= dot(disp, disp) * 0.5 / max(hy, 0.05) * step(0.001, hy);
`;

function fieldVertex(densityGLSL, tintGLSL, wind = OLD_WIND) {
  return /* glsl */ `
  vec3 fPos, fNrm, fTint;
  float fGust = 0.0;
  {
    vec2 cell = aCell;
    vec2 hA = fh22(cell + vec2(uSeed * 3.7, uSeed * 1.3)), hB = fh22(cell * 1.618 + vec2(19.19 + uSeed, 7.7));
    float h1 = hA.x, h2 = hA.y, h3 = hB.x, h4 = hB.y, h5 = fh22(cell * 0.7071 + vec2(uSeed, 41.3)).x;
    vec2 wxz = (cell + vec2(h1, h2)) * uCell;
    float camD = distance(uLodCam.xz, wxz);
    // cheap macro surface first; the micro relief is only evaluated for cells that grow something
    float th = baseH(wxz);
    vec3 tn = terrNormal(wxz);
    float rd = roadDist(wxz), rv = riverDist(wxz);
    float slope = 1.0 - tn.y;
    float dens = 0.0, scl = 1.0;
    float fade = (1.0 - smoothstep(uRadius * 0.72, uRadius, camD));
    if (uFade.y > 0.0) fade *= smoothstep(uFade.x, uFade.y, camD);
    if (fade > 0.0) {
    ${densityGLSL}
    dens *= 1.0 - occM * OCC_K;
    }
    scl *= step(h3, dens) * step(0.002, dens) * clamp(fade * 1.6, 0.0, 1.0) * mix(0.55, 1.0, fade);
    vFHash = h5; vFDens = dens;
    if (scl > 0.0) {
      vec3 fDet = terrDetail(wxz, tn.y, rd, th, camD);
      th += fDet.x;
      tn = normalize(tn + vec3(-fDet.y, 0.0, -fDet.z) * tn.y);
    }
    if (scl <= 0.0) {
      // empty cell: collapse the whole instance to one point (no raster, skip the rest)
      fPos = vec3(wxz.x, -9999.0, wxz.y); fNrm = vec3(0.0, 1.0, 0.0); fTint = vec3(0.0);
    } else {
    float yaw = h4 * 6.2831853;
    float cy = cos(yaw), sy = sin(yaw);
    mat3 rot = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
    vec3 lp = rot * (position * scl);
    lp.y *= 0.8 + 0.45 * fract(h5 * 7.13);
    // lean with the slope, and in the wind (quadratic along the stem)
    lp.xz += tn.xz * lp.y * uTilt;
    ${wind}
    fPos = vec3(wxz.x, th, wxz.y) + lp;
    fNrm = normalize(rot * normal);
    ${tintGLSL}
    }
  }
  `;
}

function fieldPatch(td, U, spec) {
  return (shader) => {
    Object.assign(shader.uniforms, td.uniforms, spec.uniforms, ROCK_OCC, spec.extraUniforms || {});
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n#define OCC_K ' + (spec.occ ?? 1).toFixed(2));
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.uniforms.uRain = U.uRain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + td.GLSL + FIELD_PARS + (spec.vertexPars || ''))
      .replace('#include <beginnormal_vertex>', fieldVertex(spec.density, spec.tint || 'fTint = vec3(1.0);', spec.gust ? GUST_WIND : OLD_WIND) + '\nvec3 objectNormal = fNrm;')
      .replace('#include <begin_vertex>', 'vec3 transformed = fPos;\n#ifdef USE_COLOR\nvColor.rgb *= fTint;\n#endif\n' + (spec.vertexExtra || ''));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFHash;\nvarying float vFDens;\n' + (spec.fragmentPars || ''))
      .replace('#include <map_fragment>', spec.mapFragment || '#include <map_fragment>')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + (spec.lightsEnd || ''))
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + (spec.fragment || ''))
      // thin double-sided blades: keep the (upward-bent) normal on both faces
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
}

// Instances are whole tiles of cells: the CPU culls tiles (radius, frustum, "is anything
// growing here" from cached per-tile density estimates) and uploads absolute cell indices;
// the vertex shader hashes each cell into position / size / presence.
function makeField(ctx, td, name, baseGeo, material, spec) {
  const tile = spec.tile, per = Math.round(tile / spec.cell), cell = tile / per;
  const cellsPerTile = per * per;
  const span = Math.ceil((spec.radius * 2) / tile) + 2;
  const maxInst = span * span * cellsPerTile;
  const arr = new Float32Array(maxInst * 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = baseGeo.index;
  for (const k in baseGeo.attributes) g.setAttribute(k, baseGeo.attributes[k]);
  const attr = new THREE.InstancedBufferAttribute(arr, 2);
  attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aCell', attr);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const uniforms = {
    uCell: { value: cell }, uRadius: { value: spec.radius }, uSeed: { value: spec.seed },
    uTilt: { value: spec.tilt ?? 0.3 }, uWindAmp: { value: spec.windAmp ?? 1 }, uFlutter: { value: spec.flutter ?? 0 },
    uFade: { value: new THREE.Vector2(...(spec.fadeIn || [0, 0])) },
  };
  addShaderPatch(material, 'fjordField_' + name, fieldPatch(td, ctx.uniforms, { ...spec, uniforms }));
  addBakedLight(material, td, { aoStrength: 0.8 });
  // thin grass blades: the shared wet patch turns up-facing blades into white sheen, skip it
  ctx.prepareMaterial(material, { wet: spec.wet !== false });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'flora_' + name;

  const cache = new Map();
  const tileInfo = (tx, tz) => {
    const key = (tx + 32768) * 65536 + (tz + 32768);
    let t = cache.get(key);
    if (t) return t;
    const x0 = tx * tile, z0 = tz * tile;
    let y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) {
      const h = td.heightAt(x0 + (i * tile) / 2, z0 + (j * tile) / 2);
      if (h < y0) y0 = h; if (h > y1) y1 = h;
    }
    t = { dens: spec.tileDensity(x0, z0, tile), y0: y0 - 2, y1: y1 + 2.5 };
    cache.set(key, t);
    return t;
  };
  const box = new THREE.Box3();
  let radius = spec.radius, fade = spec.fadeIn ? spec.fadeIn.slice() : null;
  const LIM = 2048 - tile;
  const tilesX = new Float64Array(span * span + 1).fill(NaN), tilesZ = new Float64Array(span * span + 1).fill(NaN);
  let lastNt = -1;
  return {
    mesh, geo: g, material,
    setQuality(q) {
      radius = spec.radius * q;
      uniforms.uRadius.value = radius;
      if (spec.fadeIn) { fade = [spec.fadeIn[0] * q, spec.fadeIn[1] * q]; uniforms.uFade.value.set(fade[0], fade[1]); }
    },
    cull(cam, frustum) {
      const cx = cam.x, cz = cam.z;
      const tx0 = Math.floor((cx - radius) / tile), tx1 = Math.floor((cx + radius) / tile);
      const tz0 = Math.floor((cz - radius) / tile), tz1 = Math.floor((cz + radius) / tile);
      let n = 0, nt = 0, same = true;
      for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = tx * tile, z0 = tz * tile;
        if (x0 < -LIM || x0 > LIM || z0 < -LIM || z0 > LIM) continue;
        const dx = Math.max(x0 - cx, 0, cx - x0 - tile), dz = Math.max(z0 - cz, 0, cz - z0 - tile);
        if (dx * dx + dz * dz > radius * radius) continue;
        if (fade) {
          const fx = Math.max(Math.abs(x0 - cx), Math.abs(x0 + tile - cx)), fz = Math.max(Math.abs(z0 - cz), Math.abs(z0 + tile - cz));
          if (fx * fx + fz * fz < fade[0] * fade[0]) continue;
        }
        const t = tileInfo(tx, tz);
        if (t.dens < 0.004) continue;
        box.min.set(x0 - 1, t.y0, z0 - 1); box.max.set(x0 + tile + 1, t.y1, z0 + tile + 1);
        if (!frustum.intersectsBox(box)) continue;
        if (n + cellsPerTile > maxInst) break;
        const c0x = tx * per, c0z = tz * per;
        // the cell list only changes when the set of visible tiles changes: skip rewrite + upload
        if (same && (tilesX[nt] !== tx || tilesZ[nt] !== tz)) same = false;
        tilesX[nt] = tx; tilesZ[nt] = tz; nt++;
        if (!same) {
          let o = n * 2;
          for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) { arr[o++] = c0x + i; arr[o++] = c0z + j; }
        }
        n += cellsPerTile;
      }
      if (same && nt === lastNt) return n;
      lastNt = nt;
      if (same) { tilesX[nt] = NaN; }
      g.instanceCount = n;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(2, n * 2));
      attr.needsUpdate = true;
      return n;
    },
  };
}

/* -------------------------------------------------------------- species */
// Shared mask snippets (vertex). Rock ≈ steep ground (same threshold as the terrain splat).
const MASKS = /* glsl */ `
    float rockM = smoothstep(0.33, 0.43, slope);
    float sandM = max(1.0 - smoothstep(1.2, 3.2, th), 1.0 - smoothstep(10.0, 13.0, rv));
    float snowM = max(smoothstep(760.0, 820.0, th), smoothstep(430.0, 470.0, th) * smoothstep(300.0, 500.0, wxz.x) * (1.0 - smoothstep(-1250.0, -1080.0, wxz.y)));
    float lupM = lupineAt(wxz, th, tn.y, rd);
    float clearM = featureClear(wxz);
    float pastM = pastureAt(wxz);
    float occM = uRockOccOn > 0.5 ? textureLod(tRockOcc, wxz / 4096.0 + 0.5, 0.0).r : 0.0;
`;

const GRASS_DENS = MASKS + /* glsl */ `
    dens = (1.0 - rockM) * (1.0 - sandM) * (1.0 - snowM) * smoothstep(5.5, 6.3, rd) * (0.95 - 0.5 * lupM);
    dens *= mix(smoothstep(0.15, 0.55, tgn(wxz * 0.37) * 0.7 + tgn(wxz * 0.09 + 3.0) * 0.5), 1.0, pastM * 0.85);
    dens *= clearM;
    scl = (0.75 + 0.6 * h1 * h2 + 0.25 * tgn(wxz * 0.05)) * (1.0 + 0.45 * pastM);
    scl *= mix(1.0, 0.7, 1.0 - smoothstep(6.0, 9.0, rd));       // trampled verge
`;
const GRASS_TINT = /* glsl */ `
    fTint = heathMosaic(wxz, terrGrassTint(wxz, slope), 0.0) * (0.85 + 0.3 * h5);
`;

// Thin blades let sunlight through: back-lit grass glows instead of reading as black spikes.
// `directLight` still holds the (shadowed, terrain-occluded) sun after the light loop.
const GRASS_TRANSLUCENCY = /* glsl */ `
  #if NUM_DIR_LIGHTS > 0
  {
    vec3 tV = normalize(vViewPosition);
    float fwd = pow(max(dot(-tV, directLight.direction), 0.0), 3.0);
    reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * RECIPROCAL_PI * (0.3 + 2.2 * fwd);
  }
  #endif
`;

const LUP_DENS = MASKS + /* glsl */ `
    dens = lupM * (0.45 + 0.55 * smoothstep(0.3, 0.65, tgn(wxz * 0.45) * 0.7 + tgn(wxz * 1.3) * 0.3));
    dens *= smoothstep(7.0, 9.5, rd);            // never on / beside the asphalt
    scl = 0.7 + 0.45 * h1 + 0.2 * lupM;
`;
const LUP_TINT = /* glsl */ `
    fTint = vec3(0.26, 0.29, 0.22) * (0.85 + 0.3 * h2);
`;
const LUP_FRAG_PARS = /* glsl */ `varying vec3 vLup;`;
const LUP_FRAG = /* glsl */ `
  if (vLup.x > 0.5) {
    float hue = vFHash;
    vec3 violet = vec3(0.12, 0.055, 0.3), blue = vec3(0.075, 0.068, 0.27), lav = vec3(0.2, 0.15, 0.36), pink = vec3(0.3, 0.07, 0.19), white = vec3(0.55, 0.52, 0.6);
    vec3 pc = mix(violet, blue, smoothstep(0.25, 0.55, hue));
    pc = mix(pc, lav, smoothstep(0.62, 0.8, hue) * 0.8);
    pc = mix(pc, pink, step(0.92, hue));
    pc = mix(pc, white, step(0.978, hue));
    // florets: staggered rows of round flowers, paler "banner" petal on top of each
    float v = vLup.z * 13.0, u = vLup.y * 7.0 + floor(v) * 0.5;
    vec2 f = vec2(fract(u), fract(v)) - 0.5;
    float d = length(f * vec2(1.0, 1.25));
    float floret = smoothstep(0.52, 0.2, d);
    float banner = smoothstep(0.05, 0.3, f.y) * floret;
    vec3 c = mix(pc * 0.3, pc, floret);
    c = mix(c, mix(pc, vec3(0.85, 0.85, 0.95), 0.55), banner * 0.6);
    // unopened buds at the tip, faded older florets at the base
    c = mix(c, vec3(0.2, 0.2, 0.3), smoothstep(0.78, 1.0, vLup.z) * 0.7);
    c *= 0.8 + 0.2 * smoothstep(0.0, 0.3, vLup.z);
    diffuseColor.rgb = c;
  }
`;

const STONE_DENS = MASKS + /* glsl */ `
    float scree = smoothstep(0.12, 0.22, slope) * (1.0 - rockM * 0.5) * smoothstep(40.0, 140.0, th);
    float plat = 1.0 - smoothstep(-1500.0, -1250.0, wxz.y);
    float bch = beachAt(wxz) * step(bayR(wxz), 1.08);
    dens = 0.05 + 0.5 * scree + 0.25 * plat + 0.35 * (1.0 - smoothstep(9.0, 14.0, rv)) + 0.3 * sandM * step(1.5, th);
    dens *= smoothstep(5.6, 6.2, rd) * (1.0 - lupM * 0.7) * (1.0 - pastM * 0.8);
    dens *= mix(clearM, 1.0, smoothstep(0.3, 0.6, gorgeInfo(wxz).x)) * (1.0 - glacierInfo(wxz).x * 0.6);   // cobbles in the canyon, few on the ice
    dens = max(dens, bch * 0.28);
    float tillQ = glacierInfo(wxz).z;
    dens = max(dens, smoothstep(0.85, 1.0, tillQ) * (1.0 - smoothstep(1.2, 1.5, tillQ)) * 0.55);   // moraine boulders
    dens = max(dens, lapilliAt(wxz) * (1.0 - bch) * 0.3);
    scl = 0.12 + 0.4 * h1 * h1 * h2 + 0.3 * scree * h2 + bch * 0.35 * h2;
    scl = min(scl, mix(0.3, 1.0, smoothstep(6.7, 9.0, rd)));      // ≤ 0.4 m tall near the road
`;
const STONE_TINT = /* glsl */ `
    fTint = mix(vec3(0.06, 0.058, 0.055), vec3(0.11, 0.1, 0.085), h2) * mix(1.0, 1.4, step(0.8, h5));
    fTint = mix(fTint, vec3(0.035, 0.034, 0.036), beachAt(wxz));
`;

/* ------------------------------------------------------ static scatter */
function scatterStatic(world, td, { count, seed, accept, sizeFn, alongRoad = 0.55 }) {
  const rnd = mulberry32(seed);
  const out = [];
  const P = world.path, tmp = new THREE.Vector3(), tan = new THREE.Vector3(), n = new THREE.Vector3();
  for (let tries = 0; tries < count * 40 && out.length < count; tries++) {
    let x, z;
    if (rnd() < alongRoad) {
      const s = rnd() * P.length;
      P.pointAt(s, tmp); P.tangentAt(s, tan);
      const side = rnd() < 0.5 ? -1 : 1, off = 9 + Math.pow(rnd(), 1.8) * 520;
      x = tmp.x - tan.z * off * side; z = tmp.z + tan.x * off * side;
    } else {
      z = -1950 + rnd() * 2900;
      x = world.valleyX(Math.max(z, -1400)) + (rnd() * 2 - 1) * 1250;
    }
    const h = td.heightAt(x, z);
    td.normalAt(x, z, n);
    const rd = world.roadDistAt(x, z);
    const rv = z > -900 && z < 1000 ? Math.abs(x - world.riverX(z)) : 1e4;
    const size = sizeFn(rnd, rd, n, h);
    if (!accept({ x, z, h, n, rd, rv, size, rnd })) continue;
    out.push({ x, z, h, n: n.clone(), size, r: rnd() });
  }
  return out;
}

const ROCK_FRAG_PARS = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uGAlb;
varying vec3 vRW; varying vec3 vRN;
`;
const ROCK_FRAG = /* glsl */ `
  {
    vec3 N = normalize(vRN);
    vec3 w = pow(abs(N), vec3(4.0)); w /= (w.x + w.y + w.z);
    vec3 p = vRW / 1.8;
    vec3 a = texture(uGAlb, vec3(p.zy, 2.0)).rgb * w.x + texture(uGAlb, vec3(p.xz, 2.0)).rgb * w.y + texture(uGAlb, vec3(p.xy, 2.0)).rgb * w.z;
    vec3 mean = textureLod(uGAlb, vec3(0.5, 0.5, 2.0), 12.0).rgb;
    vec3 rock = vec3(0.058, 0.055, 0.052) * a / max(mean, vec3(0.004)) * diffuseColor.rgb;
    vec3 m = texture(uGAlb, vec3(vRW.xz / 1.3, 1.0)).rgb;
    vec3 mm = textureLod(uGAlb, vec3(0.5, 0.5, 1.0), 12.0).rgb;
    float moss = smoothstep(0.5, 0.8, N.y + (tgn(vRW.xz * 1.7) - 0.5) * 0.5);
    vec3 mossC = mix(vec3(0.17, 0.26, 0.06), vec3(0.26, 0.28, 0.18), tgn(vRW.xz * 0.3)) * m / max(mm, vec3(0.004));
    diffuseColor.rgb = mix(rock, mossC, moss * 0.85);
  }
`;
const ROCK_VERT = /* glsl */ `
  {
    mat4 rm = modelMatrix;
    #ifdef USE_INSTANCING
      rm = modelMatrix * instanceMatrix;
    #endif
    vRW = (rm * vec4(transformed, 1.0)).xyz;
    vRN = normalize(mat3(rm) * objectNormal);
  }
`;

const SHRUB_FRAG = /* glsl */ `
  {
    float n1 = tgn(vRW.xz * 2.3 + vRW.y * 1.7), n2 = tgn(vRW.xz * 6.1 - vRW.y * 3.1 + 5.0);
    float leaf = n1 * 0.6 + n2 * 0.4;
    vec3 c = mix(vec3(0.025, 0.045, 0.012), vec3(0.11, 0.17, 0.035), smoothstep(0.3, 0.75, leaf));
    c = mix(c, vec3(0.2, 0.23, 0.06), smoothstep(0.78, 0.92, n2) * 0.5);
    diffuseColor.rgb = c * diffuseColor.rgb * (0.9 + 0.2 * tgn(vRW.xz * 0.05));
  }
`;

/* ------------------------------------------------ chunked static meshes */
// Split static instances into ~800 m chunks so frustum / shadow-camera culling works.
// Static instances in ~400 m chunks: per-chunk frustum/shadow culling, and beyond LOD_D a
// low-poly stand-in (or nothing) replaces the full mesh. Only chunks within ~80 m cast
// real-time shadows (the baked terrain shadow covers the rest).
const LOD_D = 320, SHADOW_D = 80;
function chunkedInstances(group, geo, mat, items, name, place, geoLo = null) {
  const CH = 400, buckets = new Map();
  for (const it of items) {
    const k = Math.floor(it.x / CH) * 1000 + Math.floor(it.z / CH);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  const meshes = [];
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  for (const list of buckets.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => { place(it, m4, col); mesh.setMatrixAt(i, m4); mesh.setColorAt(i, col); });
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = name;
    mesh.computeBoundingSphere();
    mesh.userData.full = list.length;
    group.add(mesh);
    if (geoLo) {
      const lo = new THREE.InstancedMesh(geoLo, mat, list.length);
      lo.instanceMatrix = mesh.instanceMatrix;
      lo.instanceColor = mesh.instanceColor;
      lo.boundingSphere = mesh.boundingSphere;
      lo.receiveShadow = true;
      lo.name = name + 'Lo';
      lo.visible = false;
      group.add(lo);
      mesh.userData.lo = lo;
    }
    meshes.push(mesh);
  }
  return meshes;
}
function updateChunks(meshes, cam, high, swapR = 0) {
  // high: low-poly stand-ins out to the horizon; medium/low: nothing beyond LOD_D
  // swapR > 0: photo rocks replace these instances inside swapR (shader collapses them there)
  for (const m of meshes) {
    const bs = m.boundingSphere, d = cam.distanceTo(bs.center) - bs.radius;
    const near = d < (high ? LOD_D : LOD_D * 0.7) && !(swapR > 0 && d + 2 * bs.radius < swapR - 30);
    m.visible = near;
    m.castShadow = high && d < SHADOW_D && !(swapR > 0);
    const lo = m.userData.lo;
    if (lo) { lo.visible = !near && (high || d < 700); lo.count = m.count; }
  }
}

/* ================================================================ module */
export async function createFlora(ctx) {
  const { scene, world, state, uniforms: U, camera } = ctx;
  const t0 = performance.now();
  const td = getTerrainData(ctx);
  const GU = groundUniforms();
  const group = new THREE.Group();
  group.name = 'fjordFlora';
  const disposables = [];
  const nv = new THREE.Vector3();

  /* ---- CPU tile density estimates (only used to skip empty tiles) */
  const grassTile = (x0, z0, T) => {
    let best = 0;
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) {
      const x = x0 + (i * T) / 2, z = z0 + (j * T) / 2, h = td.heightAt(x, z);
      td.normalAt(x, z, nv);
      const ok = (nv.y > 0.55 ? 1 : 0) * (h > 1.0 ? 1 : 0) * (h < 830 ? 1 : 0) * (riverDistJS(x, z) > 9 ? 1 : 0);
      best = Math.max(best, ok);
    }
    const rdMax = Math.max(world.roadDistAt(x0, z0), world.roadDistAt(x0 + T, z0), world.roadDistAt(x0, z0 + T), world.roadDistAt(x0 + T, z0 + T));
    return rdMax < 5 ? 0 : best;
  };
  const lupTile = (x0, z0, T) => {
    let best = 0;
    const S = 4;
    for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
      const x = x0 + (i * T) / S, z = z0 + (j * T) / S;
      td.normalAt(x, z, nv);
      best = Math.max(best, lupineJS(x, z, td.heightAt(x, z), nv.y, world.roadDistAt(x, z)));
    }
    return best;
  };
  const stoneTile = (x0, z0, T) => (Math.max(world.roadDistAt(x0, z0), world.roadDistAt(x0 + T, z0 + T), world.roadDistAt(x0 + T, z0), world.roadDistAt(x0, z0 + T)) < 5 ? 0 : 1);

  /* ---- procedural fields */
  const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const grassNearGeo = grassTuft({ blades: 9, height: 0.22, seed: 11 });
  const grassNear = makeField(ctx, td, 'grassNear', grassNearGeo, grassMat, {
    cell: 0.5, tile: 8, radius: 26, seed: 1.7, wet: false, tilt: 0.35, windAmp: 1.3, flutter: 0.012, density: GRASS_DENS, tint: GRASS_TINT, tileDensity: grassTile,
  });
  const grassMidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const grassMidGeo = grassTuft({ blades: 6, height: 0.3, seed: 12 });
  const grassMid = makeField(ctx, td, 'grassMid', grassMidGeo, grassMidMat, {
    cell: 1.0, tile: 16, radius: 50, seed: 4.1, wet: false, tilt: 0.35, windAmp: 1.1, flutter: 0.01, fadeIn: [19, 26],
    density: GRASS_DENS.replace('scl = 0.75', 'scl = 1.05'), tint: GRASS_TINT, tileDensity: grassTile,
  });

  const lupPars = 'attribute vec3 aLup;\nvarying vec3 vLup;\n';
  const lupMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  const lupGeo = lupinePlant({ seed: 21, leaves: 3, spikeSides: 4, spikeSegs: 2 });
  const lupNear = makeField(ctx, td, 'lupNear', lupGeo, lupMat, {
    cell: 0.625, tile: 10, radius: 34, seed: 7.3, wet: false, tilt: 0.15, windAmp: 0.3, flutter: 0.006, density: LUP_DENS, tint: LUP_TINT, tileDensity: lupTile,
    vertexPars: lupPars, vertexExtra: 'vLup = aLup;', fragmentPars: LUP_FRAG_PARS, fragment: LUP_FRAG,
  });
  const lupFarMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  const lupFarGeo = lupinePlant({ seed: 22, leaves: 1, spikeSides: 3, spikeSegs: 1, stem: false });
  const lupFar = makeField(ctx, td, 'lupFar', lupFarGeo, lupFarMat, {
    cell: 1.25, tile: 20, radius: 120, seed: 9.9, wet: false, tilt: 0.15, windAmp: 0.25, fadeIn: [34, 44], density: LUP_DENS.replace('scl = 0.7', 'scl = 0.95'), tint: LUP_TINT, tileDensity: lupTile,
    vertexPars: lupPars, vertexExtra: 'vLup = aLup;', fragmentPars: LUP_FRAG_PARS, fragment: LUP_FRAG,
  });

  const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  const sg = stoneGeo({ detail: 1, seed: 31, smooth: true });
  sg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(sg.attributes.position.count * 3).fill(1), 3));
  const stones = makeField(ctx, td, 'stones', sg, stoneMat, {
    cell: 2.5, tile: 20, radius: 75, seed: 13.3, tilt: 0.6, windAmp: 0, density: STONE_DENS, tint: STONE_TINT, tileDensity: stoneTile,
  });

  const fields = [grassNear, grassMid, lupNear, lupFar, stones];
  for (const f of fields) group.add(f.mesh);

  /* ---- static boulders */
  const village = world.landmarks.village;
  const boulders = scatterStatic(world, td, {
    count: 750, seed: 4242, alongRoad: 0.6,
    sizeFn: (rnd, rd) => { const s = 0.7 + Math.pow(rnd(), 2.6) * 4.6; return rd < 25 ? Math.min(s, 1.6) : s; },
    accept: ({ x, z, h, n, rd, rv, size, rnd }) => {
      if (rd < 9 + size * 1.2 || rv < 16 + size || h < 2 || n.y < 0.55) return false;
      if (featureClearJS(x, z) < 0.6 || pastureJS(x, z) > 0.3) return false;
      if (Math.hypot(x - village.x, (z - village.z) * 1.3) < 190) return false;
      if (Math.abs(x) > 2000 || Math.abs(z) > 2000) return false;
      const slope = 1 - n.y;
      return rnd() < 0.18 + slope * 1.8;
    },
  });
  const bGeo = stoneGeo({ detail: 2, seed: 7, smooth: true }), bGeoLo = stoneGeo({ detail: 0, seed: 7, smooth: true });
  const uSwapR = { value: 0 };
  const rockMat = (bare, swap = false) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: bare ? 0.55 : 0.85, metalness: 0 });
    addShaderPatch(m, (bare ? 'fjordRockBare' : 'fjordRock') + (swap ? 'Swap' : ''), (shader) => {
      shader.uniforms.uGAlb = GU.uGAlb;
      shader.uniforms.uSwapR = uSwapR;
      Object.assign(shader.uniforms, td.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRW; varying vec3 vRN;\nuniform float uSwapR;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (swap ? `
        #ifdef USE_INSTANCING
        { // inside uSwapR the photo-scanned rock at this spot takes over (cross-shrink)
          vec3 ic = (modelMatrix * instanceMatrix[3]).xyz;
          transformed *= smoothstep(uSwapR - 25.0, uSwapR, distance(ic.xz, cameraPosition.xz));
        }
        #endif` : ''))
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + ROCK_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + td.GLSL + ROCK_FRAG_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + (bare ? ROCK_FRAG.replace('diffuseColor.rgb = mix(rock, mossC, moss * 0.85);', 'diffuseColor.rgb = rock * 0.75;') : ROCK_FRAG));
    });
    addBakedLight(m, td, { aoStrength: 0.7 });
    ctx.prepareMaterial(m);
    return m;
  };
  const bMat = rockMat(false, true), wallMat = rockMat(false), reefMat = rockMat(true, true);
  const q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p3 = new THREE.Vector3();
  const bMeshes = chunkedInstances(group, bGeo, bMat, boulders, 'boulders', (b, m4, col) => {
    q.setFromEuler(e.set((b.r - 0.5) * 0.4, b.r * 17.0, ((b.r * 7) % 1 - 0.5) * 0.4));
    const s = b.size;
    sc.set(s * (0.8 + ((b.r * 3.7) % 1) * 0.5), s * (0.55 + ((b.r * 5.3) % 1) * 0.45), s * (0.8 + ((b.r * 2.9) % 1) * 0.5));
    m4.compose(p3.set(b.x, b.h - s * 0.22, b.z), q, sc);
    const v = 0.8 + ((b.r * 11.3) % 1) * 0.45;
    col.setRGB(v, v * 0.98, v * 0.95);
  }, bGeoLo);

  /* ---- black basalt reef rocks along the beach (some awash) */
  const B = FEATURES.bay, reefRnd = mulberry32(606);
  const reef = [];
  for (let k = 0; k < 400 && reef.length < 70; k++) {
    const a = reefRnd() * Math.PI * 2, r = 0.88 + reefRnd() * 0.2;
    const x = B.x + Math.cos(a) * B.rx * r, z = B.z + Math.sin(a) * B.rz * r;
    if (world.roadDistAt(x, z) < 10 || Math.hypot(x - FEATURES.lighthouse.x, z - FEATURES.lighthouse.z) < 18) continue;
    const size = 0.6 + Math.pow(reefRnd(), 2) * 3.2;
    const h = td.heightAt(x, z);
    if (h > 3) continue;
    reef.push({ x, z, h: h + size * 0.1, n: new THREE.Vector3(0, 1, 0), size, r: reefRnd() });
  }
  const reefMeshes = chunkedInstances(group, bGeo, reefMat, reef, 'reefRocks', (b, m4, col) => {
    q.setFromEuler(e.set((b.r - 0.5) * 0.5, b.r * 29.0, ((b.r * 5) % 1 - 0.5) * 0.5));
    sc.set(b.size * (0.9 + ((b.r * 3.3) % 1) * 0.6), b.size * (0.7 + ((b.r * 7.1) % 1) * 0.6), b.size * (0.9 + ((b.r * 1.9) % 1) * 0.5));
    m4.compose(p3.set(b.x, b.h - b.size * 0.25, b.z), q, sc);
    col.setRGB(0.55, 0.55, 0.57);
  }, bGeoLo);
  /* ---- dry-stone walls around the home fields */
  const PA = FEATURES.pasture, FM = FEATURES.farm, wallRnd = mulberry32(808);
  const wallLines = [
    [[PA.x0 + 12, PA.z0 + 20], [PA.x1 - 10, PA.z0 + 35]],
    [[PA.x1 - 10, PA.z0 + 35], [PA.x1 - 25, PA.z1 - 40]],
    [[PA.x0 + 20, (PA.z0 + PA.z1) / 2 + 30], [PA.x1 - 25, (PA.z0 + PA.z1) / 2 + 10]],
    [[PA.x0 + 15, PA.z1 - 30], [PA.x1 - 25, PA.z1 - 40]],
  ];
  const wallStones = [];
  for (const [[xa, za], [xb, zb]] of wallLines) {
    const len = Math.hypot(xb - xa, zb - za), yaw = Math.atan2(xb - xa, zb - za);
    for (let s2 = 0; s2 < len; s2 += 0.55) {
      const t = s2 / len, wob = Math.sin(s2 * 0.05 + xa) * 1.5;
      const x = xa + (xb - xa) * t + Math.cos(yaw) * wob, z = za + (zb - za) * t - Math.sin(yaw) * wob;
      if (world.roadDistAt(x, z) < 9 || Math.hypot(x - FM.x, z - FM.z) < FM.r * 0.8) continue;
      if (wallRnd() < 0.04) { s2 += 1.5; continue; }          // gaps / fallen stretches
      const h = td.heightAt(x, z);
      for (let row = 0; row < 2; row++) {
        const sz = 0.3 + wallRnd() * 0.18;
        wallStones.push({ x: x + (wallRnd() - 0.5) * 0.15, z: z + (wallRnd() - 0.5) * 0.15, h: h + 0.12 + row * 0.3, n: new THREE.Vector3(0, 1, 0), size: sz, r: wallRnd(), yaw });
      }
    }
  }
  const wallMeshes = chunkedInstances(group, bGeo, wallMat, wallStones, 'stoneWalls', (b, m4, col) => {
    q.setFromEuler(e.set((b.r - 0.5) * 0.3, b.yaw + (b.r - 0.5) * 0.6, ((b.r * 7) % 1 - 0.5) * 0.3));
    sc.set(b.size * 1.3, b.size * 0.75, b.size);
    m4.compose(p3.set(b.x, b.h - b.size * 0.2, b.z), q, sc);
    const v = 0.8 + ((b.r * 9.3) % 1) * 0.5;
    col.setRGB(v * 1.1, v * 1.05, v);
  });

  /* ---- birch scrub */
  const shrubs = scatterStatic(world, td, {
    count: 900, seed: 777, alongRoad: 0.35,
    sizeFn: (rnd) => 0.45 + Math.pow(rnd(), 1.6) * 1.1,
    accept: ({ x, z, h, n, rd, rv, size, rnd }) => {
      if (rd < 10 + size || h < 3 || h > 230 || n.y < 0.9 || rv < 13) return false;
      if (featureClearJS(x, z) < 0.8 || pastureJS(x, z) > 0.5) return false;
      const dv = Math.hypot(x - village.x, (z - village.z) * 1.3);
      if (dv < 105) return false;
      const nearRiver = 1 - smoothstep(20, 170, rv), nearVil = 1 - smoothstep(120, 380, dv);
      const lowSlope = 1 - smoothstep(60, 200, h - world.floorY(clamp(z, -1500, 1000)));
      const thicket = smoothstep(0.08, 0.3, fbm2(x * 0.011, z * 0.011, 3, 91));
      const p = (0.02 + 0.8 * nearRiver + 0.7 * nearVil + 0.25 * lowSlope * (z > -900 ? 1 : 0)) * thicket;
      return rnd() < p;
    },
  });
  const shGeo = shrubGeo({ seed: 9, lumps: 3 }), shGeoLo = shrubGeo({ seed: 9, lumps: 1 });
  const shMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  addShaderPatch(shMat, 'fjordShrub', (shader) => {
    Object.assign(shader.uniforms, td.uniforms);
    shader.uniforms.uTime = U.uTime; shader.uniforms.uWind = U.uWind; shader.uniforms.uWindStrength = U.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRW; varying vec3 vRN;\nuniform float uTime, uWindStrength; uniform vec3 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
        vec2 wD = normalize(uWind.xz + vec2(1e-5));
        float sw = (0.6 + 0.4 * sin(uTime * 1.3 + ph)) * (0.2 + uWindStrength) * 0.05 * max(position.y, 0.0);
        transformed.xz += wD * sw + vec2(sin(uTime * 5.0 + ph + position.x * 4.0), cos(uTime * 4.3 + ph + position.z * 4.0)) * 0.012 * max(position.y, 0.0);
      }`)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + ROCK_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + td.GLSL + 'varying vec3 vRW; varying vec3 vRN;\n')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SHRUB_FRAG);
  });
  addBakedLight(shMat, td, { aoStrength: 0.8 });
  ctx.prepareMaterial(shMat);
  const shMeshes = chunkedInstances(group, shGeo, shMat, shrubs, 'birchScrub', (b, m4, col) => {
    q.setFromEuler(e.set(0, b.r * 23.0, 0));
    const s = b.size;
    sc.set(s * (0.9 + ((b.r * 3.1) % 1) * 0.5), s * (0.7 + ((b.r * 4.3) % 1) * 0.6), s * (0.9 + ((b.r * 6.7) % 1) * 0.5));
    m4.compose(p3.set(b.x, b.h - 0.25, b.z), q, sc);
    const v = 0.85 + ((b.r * 9.7) % 1) * 0.3;
    col.setRGB(v * (0.95 + ((b.r * 5.1) % 1) * 0.15), v, v * 0.9);
  }, shGeoLo);

  /* ---- photo-scanned assets (env/photoAssets.js): blade-card grass, scanned pebbles in the
         stone field, scanned rocks/boulders. Each part is optional — whatever failed to load
         keeps the procedural version above. */
  // boulder subset per quality, mirroring chunkedInstances' per-chunk m.count
  {
    const CH = 400, buckets = new Map();
    for (const b of boulders) {
      const k = Math.floor(b.x / CH) * 1000 + Math.floor(b.z / CH);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(b);
    }
    const SK = { high: 1, medium: 0.6, low: 0.3, eco: 0.3 };
    for (const list of buckets.values()) list.forEach((b, i) => { b.keep = (qn) => i < Math.floor(list.length * (SK[qn] ?? 1)); });
  }
  const photo = { grass: [], stones: null, rocks: null, on: false };
  const qName = () => (state.get('quality') === 'eco' ? 'eco' : state.get('resolvedQuality') || 'medium');
  function enablePhoto(A) {
    if (!A || photo.on || !(A.grass || A.rocks)) return;
    photo.on = true;
    if (A.grass) {
      const G = A.grass;
      const uBladeMean = { value: new THREE.Vector3(...G.mean) };
      // alpha-cut photo blades; alpha is boosted with the mip level so far blades don't thin out
      const mapFragment = /* glsl */ `
      #ifdef USE_MAP
      {
        vec4 gTex = texture2D(map, vMapUv);
        vec2 gSz = vec2(textureSize(map, 0));
        vec2 gdx = dFdx(vMapUv * gSz), gdy = dFdy(vMapUv * gSz);
        float gLod = max(0.0, 0.5 * log2(max(dot(gdx, gdx), dot(gdy, gdy))));
        gTex.a = clamp(gTex.a * (1.0 + gLod * 0.4), 0.0, 1.0);
        diffuseColor *= vec4(gTex.rgb / uBladeMean, gTex.a);
      }
      #endif`;
      const rings = [
        { name: 'grassPhNear', cell: 0.3, tile: 6, radius: 15, cards: 7, height: 0.3, seed: 2.3, windAmp: 1.5, flutter: 0.016 },
        { name: 'grassPhMid', cell: 0.5, tile: 8, radius: 32, cards: 6, height: 0.32, seed: 5.1, fadeIn: [11, 15], windAmp: 1.35, flutter: 0.013 },
        { name: 'grassPhFar', cell: 1.0, tile: 16, radius: 55, cards: 5, height: 0.36, seed: 8.7, fadeIn: [26, 32], windAmp: 1.15, flutter: 0.01, scl: 1.12 },
      ];
      for (const R of rings) {
        const geo = bladeCardTuft({ cards: R.cards, height: R.height, seed: Math.round(R.seed * 10), blades: G.blades, spread: R.cell * 0.45 });
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: G.tex, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.42 });
        mat.alphaToCoverage = true;
        const f = makeField(ctx, td, R.name, geo, mat, {
          cell: R.cell, tile: R.tile, radius: R.radius, seed: R.seed, wet: false, tilt: 0.3, windAmp: R.windAmp, flutter: R.flutter, fadeIn: R.fadeIn,
          // photo grass: denser carpet (patchiness relaxed), clumps spread wider
          density: GRASS_DENS.replace('smoothstep(0.15, 0.55, tgn(wxz * 0.37)', 'smoothstep(0.0, 0.42, tgn(wxz * 0.37)').replace('scl = 0.75', 'scl = ' + (0.75 * (R.scl || 1)).toFixed(3)),
          tint: GRASS_TINT + 'fTint *= vec3(1.22, 1.2, 1.08) * (1.0 + 0.22 * fGust);', tileDensity: grassTile, gust: true,
          mapFragment, fragmentPars: 'uniform vec3 uBladeMean;', extraUniforms: { uBladeMean }, lightsEnd: GRASS_TRANSLUCENCY,
        });
        photo.grass.push(f);
        group.add(f.mesh);
        disposables.push(geo, mat, f.geo);
      }
      disposables.push(G.tex);
    }
    if (A.rocks) {
      // scanned pebble (rock_07, ~260 tris) in the GPU stone field
      const pg = A.rocks.geos.pebble.clone();
      pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pg.attributes.position.count * 3).fill(1), 3));
      pg.translate(0, -0.08, 0);
      pg.scale(1.15, 1.15, 1.15);
      const pm = photoRockMaterial(ctx, td, A.rocks, { detailOnly: true, vertexColors: true });
      photo.stones = makeField(ctx, td, 'stonesPh', pg, pm, {
        cell: 2.5, tile: 20, radius: 75, seed: 13.3, tilt: 0.6, windAmp: 0, density: STONE_DENS, tint: STONE_TINT, tileDensity: stoneTile, occ: 0.6,
      });
      group.add(photo.stones.mesh);
      disposables.push(pg, pm, photo.stones.geo);
      photo.rocks = createPhotoRocks(ctx, td, A.rocks, { boulders, reef });
      group.add(photo.rocks.group);
    }
    applyQuality(state.get('resolvedQuality'));
    console.info(`[fjord flora] photo assets on (grass ${!!A.grass}, rocks ${!!A.rocks}, rock instances ${photo.rocks?.items.length ?? 0})`);
  }

  scene.add(group);
  disposables.push(grassNearGeo, grassMidGeo, lupGeo, lupFarGeo, sg, bGeo, bGeoLo, shGeo, shGeoLo, grassMat, grassMidMat, lupMat, lupFarMat, stoneMat, bMat, wallMat, reefMat, shMat, ...fields.map((f) => f.geo));

  /* ---- per-frame tile culling, right before the main render (camera is final then) */
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  const stats = { instances: 0, ms: 0 };
  function cullAll(cam) {
    const a = performance.now();
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    let n = 0;
    for (const f of fields) if (f.mesh.visible) n += f.cull(cam.position, frustum);
    for (const f of photo.grass) if (f.mesh.visible) n += f.cull(cam.position, frustum);
    if (photo.stones?.mesh.visible) n += photo.stones.cull(cam.position, frustum);
    const sh = state.get('resolvedQuality') === 'high';
    if (photo.rocks) photo.rocks.update(cam, frustum);
    uSwapR.value = photo.rocks ? photo.rocks.swapR : 0;
    updateChunks(bMeshes, cam.position, sh, uSwapR.value); updateChunks(shMeshes, cam.position, sh);
    updateChunks(reefMeshes, cam.position, sh, uSwapR.value); updateChunks(wallMeshes, cam.position, sh);
    stats.instances = n;
    stats.ms = performance.now() - a;
  }
  let updates = 0, obrSeen = 0;
  const prevOBR = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, cam, rt) {
    if (prevOBR) prevOBR.call(this, r, s, cam, rt);
    if (cam === camera) { cullAll(cam); obrSeen = updates; }
  };

  /* ---- quality */
  function applyQuality(qn) {
    const k = QUALITY[qn] ?? 1;
    for (const f of fields) f.setQuality(k);
    const sk = qn === 'low' ? 0.3 : qn === 'medium' ? 0.6 : 1;
    for (const m of [...bMeshes, ...shMeshes, ...reefMeshes]) m.count = Math.floor(m.userData.full * sk);
    // photo grass replaces the procedural tufts except in eco (power saving keeps the old look/cost)
    const eco = state.get('quality') === 'eco';
    const phGrass = photo.grass.length > 0 && !eco;
    grassNear.mesh.visible = !phGrass;
    grassMid.mesh.visible = !phGrass && qn !== 'low';
    photo.grass.forEach((f, i) => { f.setQuality(k); f.mesh.visible = phGrass && !(i === 2 && qn === 'low'); });
    if (photo.stones) { photo.stones.setQuality(k); photo.stones.mesh.visible = true; stones.mesh.visible = false; }
    if (photo.rocks) {
      photo.rocks.setQuality(qName());
      ROCK_OCC.tRockOcc.value = photo.rocks.occTex; ROCK_OCC.uRockOccOn.value = 1;
    }
  }
  // wait for the photo assets (already loading since the terrain module); late -> applied later
  enablePhoto(await awaitPhotoAssets(ctx, 15000));
  if (!photo.on) loadPhotoAssets(ctx).then((A) => { if (A && (A.grass || A.rocks)) enablePhoto(A); });
  applyQuality(state.get('resolvedQuality'));
  const off = state.on('resolvedQuality', applyQuality);
  const offQ = state.on('quality', () => applyQuality(state.get('resolvedQuality')));

  console.info(`[fjord flora] ${Math.round(performance.now() - t0)} ms (boulders ${boulders.length}, shrubs ${shrubs.length})`);
  return {
    group, stats, photo, groundU: GU, photoStats: PHOTO_STATS,
    update() {
      // fallback if our onBeforeRender hook got replaced by someone else
      if (++updates - obrSeen > 2) { camera.updateMatrixWorld(); cullAll(camera); }
    },
    dispose() {
      off?.(); offQ?.();
      photo.rocks?.dispose();
      scene.onBeforeRender = prevOBR || (() => {});
      scene.remove(group);
      disposables.forEach((d) => d.dispose());
      [...bMeshes, ...shMeshes, ...reefMeshes, ...wallMeshes].forEach((m) => m.dispose());
    },
  };
}
