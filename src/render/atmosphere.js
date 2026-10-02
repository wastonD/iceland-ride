// Time-of-day presets (day / dusk / night) → light, fog, sky and environment.
// Scenes supply their own presets (sceneDef.presets); these defaults are the rainforest.
// Presets blend smoothly when state.timeOfDay changes. Rain darkens the sky and dims the sun.

import * as THREE from 'three';
import { FOG_PARS_GLSL, fogUniforms, atmoUniforms, getCloudNoise } from './fog.js';

export const C = (r, g, b, k = 1) => new THREE.Color(r * k, g * k, b * k);
export const dirFrom = (elevDeg, azDeg) => {
  const e = THREE.MathUtils.degToRad(elevDeg), a = THREE.MathUtils.degToRad(azDeg);
  // az 0 = north (−Z), 90 = east (+X)
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};

// Keys every preset has; scene presets may omit any of them.
const DEFAULTS = {
  skyMode: 0,                        // 0 = fog-coloured sky (forest), 1 = clear sky with clouds
  zenith: C(0.1, 0.25, 0.6), horizon: C(0.6, 0.7, 0.85),
  cloudCover: 0.5, cloudCol: C(1.3, 1.3, 1.3), cloudShade: C(0.45, 0.5, 0.58), stars: 0,
  envIntensity: 0.3,
  rainDim: 0.35,                     // how much full rain dims the sun
  // cinematic extras (all 0 = off → rainforest unchanged)
  fogChroma: new THREE.Vector3(0, 0, 0), // extra per-channel fog extinction (blue > red → layered blue ridges)
  cloudShadow: 0,                    // 0..1 drifting cloud shadows dim the direct sun
  cloudSpeed: 7,                     // m/s cloud drift
  cirrus: 0,                         // high cirrus veil amount
  skyPol: 0,                         // deepen the sky ~90° from the sun
  skyCurve: 0.45,                    // horizon → zenith gradient exponent (lower = deep blue reaches lower)
  // "cinematographer's sun": optional second sun for the later part of a ride path. The sun is
  // sunDir while the rider is before sunSplit[0] (path metres), sunDir2 after sunSplit[1] (blend
  // in between — put it somewhere the sky is hidden, e.g. a tunnel). null = one sun.
  sunDir2: null, sunSplit: null,
};

// Rainforest — bright, fresh, humid (all colours linear HDR).
export const PRESETS = {
  day: {
    sunDir: dirFrom(48, 25), sunCol: C(1.0, 0.95, 0.84, 4.2),
    hemiSky: C(0.66, 0.8, 0.72), hemiGround: C(0.19, 0.23, 0.13),
    fogAmb: C(0.18, 0.27, 0.22), fogHigh: C(0.62, 0.76, 0.72), fogSunC: C(1.0, 0.93, 0.78, 0.8),
    fogDensity: 0.0032, fogFalloff: 0.045, exposure: 1.45, volStrength: 1.1, envIntensity: 0.45,
    // fair weather: blue sky + cumulus through the canopy gaps, thin mist, brighter sun and stronger
    // shafts (the scatter scales with fog density, so volStrength goes up as the mist thins)
    sunny: {
      skyMode: 1, zenith: C(0.06, 0.17, 0.48), horizon: C(0.36, 0.52, 0.75), skyCurve: 0.4,
      cloudCover: 0.42, cloudCol: C(1.3, 1.28, 1.26, 1.3), cloudShade: C(0.4, 0.46, 0.58, 0.8),
      sunCol: C(1.0, 0.95, 0.84, 5.0), hemiSky: C(0.62, 0.78, 0.8),
      fogAmb: C(0.17, 0.27, 0.24), fogHigh: C(0.52, 0.7, 0.8), fogSunC: C(1.0, 0.93, 0.78, 1.0),
      fogDensity: 0.0016, exposure: 1.4, volStrength: 2.6,
    },
  },
  dusk: {
    sunDir: dirFrom(11, 250), sunCol: C(1.0, 0.55, 0.26, 4.4),
    hemiSky: C(0.55, 0.46, 0.44), hemiGround: C(0.14, 0.11, 0.07),
    fogAmb: C(0.2, 0.15, 0.13), fogHigh: C(0.62, 0.45, 0.36), fogSunC: C(1.25, 0.62, 0.28, 1.6),
    fogDensity: 0.005, fogFalloff: 0.05, exposure: 1.35, volStrength: 1.1, envIntensity: 0.4,
  },
  night: {
    sunDir: dirFrom(58, 150), sunCol: C(0.55, 0.66, 1.0, 1.0),
    hemiSky: C(0.1, 0.14, 0.24), hemiGround: C(0.03, 0.04, 0.05),
    fogAmb: C(0.035, 0.055, 0.09), fogHigh: C(0.07, 0.1, 0.16), fogSunC: C(0.35, 0.45, 0.7, 0.9),
    fogDensity: 0.008, fogFalloff: 0.05, exposure: 2.1, volStrength: 1.4, envIntensity: 0.3,
  },
};

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // at far plane
}`;
const SKY_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
uniform float uTime, uSkyMode, uCloudCover, uStars, uRain, uCirrus, uSkyPol, uSkyCurve;
uniform vec3 uZenith, uHorizon, uCloudCol, uCloudShade, uSunCol;
uniform sampler2D tCloud;
uniform vec3 uCSParams;
uniform vec2 uCSOffset;
varying vec3 vDir;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<6;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }

vec3 fogSky(vec3 rd) {
  vec3 c = fogColorDir(rd);
  vec2 uv = rd.xz / max(rd.y, 0.08) * 1.6 + uTime * vec2(0.004, 0.002);
  float n = vn(uv) * 0.55 + vn(uv * 2.3) * 0.3 + vn(uv * 5.1) * 0.15;
  return c * mix(0.86, 1.08, smoothstep(0.35, 0.75, n) * smoothstep(0.0, 0.3, rd.y));
}

// --- clear sky (fjord). Clouds are a real layer ~1.4 km up, sampled in world space with the same
//     noise as the ground cloud shadows (fog.js) — every cloud you see casts the shadow you ride through.
float cloudField(vec2 uv) {
  vec4 a = texture2D(tCloud, uv);
  return a.r * 0.6 + a.g * 0.25 + texture2D(tCloud, uv * 3.1 + 0.37).r * 0.15;
}
vec3 horizonHaze(vec3 rd) { return fogColorDir(normalize(vec3(rd.x, max(rd.y, 0.0) * 0.25, rd.z))); }

vec3 clearSky(vec3 rd) {
  float y = max(rd.y, 0.0);
  float mu = dot(rd, uSunDir);
  float mu0 = max(mu, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(y, uSkyCurve));
  // deeper blue ~90° from the sun (polariser-like), brighter aureole toward it
  c *= 1.0 - uSkyPol * (1.0 - mu * mu) * smoothstep(0.02, 0.55, y);
  c += uSunCol * (0.012 * pow(mu0, 8.0) + 0.06 * pow(mu0, 120.0));
  c += uSunCol * 6.0 * smoothstep(0.99975, 0.9999, mu);
  // stars (night)
  if (uStars > 0.0 && rd.y > 0.0) {
    vec2 sp = rd.xz / (rd.y + 0.4) * 180.0;
    float s = step(0.9975, h21(floor(sp))) * smoothstep(0.5, 0.0, length(fract(sp) - 0.5));
    c += vec3(0.8, 0.85, 1.0) * s * uStars * smoothstep(0.0, 0.3, rd.y);
  }
  if (rd.y > 0.0) {
    float camY = uCamPos.y;
    // high cirrus veils (≈8 km): long wind-combed streaks, lit warm-white
    if (uCirrus > 0.0) {
      vec2 w = uCamPos.xz + rd.xz / (rd.y + 0.02) * (8000.0 - camY);
      vec2 cu = w / 9000.0 + uCSOffset * 0.35;
      cu = vec2(cu.x * 0.8 + cu.y * 0.6, (-cu.x * 0.6 + cu.y * 0.8) * 4.0);
      float st = texture2D(tCloud, cu).b;
      float veil = smoothstep(0.52, 0.85, st) * smoothstep(0.35, 0.75, texture2D(tCloud, cu * vec2(0.23, 0.07) + 0.5).r);
      vec3 cc = mix(uHorizon * 1.15, uCloudCol, 0.55) + uSunCol * 0.04 * pow(mu0, 4.0);
      c = mix(c, cc, veil * uCirrus * smoothstep(0.02, 0.2, rd.y));
    }
    // cumulus layer
    float dist = (1400.0 - camY) / (rd.y + 0.035);
    vec2 wp = uCamPos.xz + rd.xz * dist;
    vec2 uv = wp * uCSParams.x + uCSOffset;
    float n = cloudField(uv);
    vec4 det = texture2D(tCloud, uv * 7.3 + 0.19);
    n += (det.a - 0.5) * 0.09 + (det.g - 0.5) * 0.05;
    float thr = uCSParams.y;
    float dens = smoothstep(thr, thr + 0.09, n);
    if (dens > 0.001) {
      float th = clamp((n - thr) / 0.22, 0.0, 1.0);                 // thickness
      vec2 sd = normalize(uSunDir.xz + 1e-4) * uCSParams.x;
      float n1 = cloudField(uv + sd * 45.0), n2 = cloudField(uv + sd * 130.0);
      float od = max(n1 - thr, 0.0) + max(n2 - thr, 0.0);
      float lit = exp(-od * 5.0);                                    // self-shadow toward the sun
      // treat thickness as a height field: its normal gives sunlit / shaded flanks on each billow
      vec2 sp = vec2(-sd.y, sd.x);
      float hS = clamp((n1 - thr) / 0.22, 0.0, 1.0), hP = clamp((cloudField(uv + sp * 45.0) - thr) / 0.22, 0.0, 1.0);
      vec3 sd3 = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4), sp3 = vec3(-sd3.z, 0.0, sd3.x);
      vec3 N = normalize(vec3(0.0, 0.35, 0.0) - sd3 * (hS - th) - sp3 * (hP - th));
      float lam = clamp(dot(N, uSunDir) * 0.6 + 0.45, 0.0, 1.0);
      float side = 1.0 - smoothstep(0.05, 0.6, rd.y);                // low = seen from the side (sunlit flanks)
      float L = clamp(mix(lit, lam * lit, 0.6) * mix(0.6, 1.1, side) + (1.0 - th) * 0.3, 0.0, 1.0);
      vec3 cc = mix(uCloudShade, uCloudCol, L);
      cc *= mix(1.0, 0.8, th * (1.0 - side));                        // heavy bases overhead
      cc += uSunCol * (1.0 - th) * (0.035 * pow(mu0, 6.0) + 0.12 * pow(mu0, 40.0)); // silver lining
      cc *= mix(1.0, 0.55, uRain);
      // aerial perspective: distant clouds sink into the horizon haze
      float hk = 1.0 - exp(-dist * 0.00007);
      cc = mix(cc, horizonHaze(rd), hk);
      c = mix(c, cc, dens * smoothstep(0.0, 0.1, rd.y));
    }
  }
  // blend into the aerial-perspective haze at the horizon (matches distant terrain)
  float hz = 1.0 - smoothstep(-0.02, 0.2, rd.y);
  c = mix(c, fogColorDir(rd), hz);
  return c;
}

void main() {
  vec3 rd = normalize(vDir);
  vec3 c = uSkyMode > 0.999 ? clearSky(rd) : uSkyMode < 0.001 ? fogSky(rd) : mix(fogSky(rd), clearSky(rd), uSkyMode);
  gl_FragColor = vec4(c, 1.0);
}`;

function withDefaults(p) {
  const out = {};
  for (const k in DEFAULTS) out[k] = DEFAULTS[k]?.clone ? DEFAULTS[k].clone() : DEFAULTS[k];
  for (const k in p) if (k !== 'sunny') out[k] = p[k]?.clone ? p[k].clone() : p[k];
  return out;
}
// Fair weather: a preset may carry `sunny: { key: value }` overrides that apply when it is NOT raining.
// The base keys stay the rain look (unchanged for rain >= SUNNY_RAIN[1]); between, and while the
// weather changes, the two blend (ctx.sunny 0..1, eased — pipeline.js uses it for the grade too).
export const SUNNY_RAIN = [0.02, 0.15];
const sunnyOf = (p) => withDefaults({ ...p, ...(p.sunny || {}) });
// lerp every number / colour / vector key of a and b into out (non-lerpable keys come from the nearer one)
function mixPreset(out, a, b, t) {
  for (const k in a) {
    const x = a[k], y = b[k];
    if (typeof x === 'number' && typeof y === 'number') out[k] = x + (y - x) * t;
    else if (x?.isVector3 && y?.isVector3) (out[k]?.isVector3 ? out[k] : (out[k] = x.clone())).copy(x).lerp(y, t);
    else if (x?.isColor && y?.isColor) (out[k]?.isColor ? out[k] : (out[k] = x.clone())).copy(x).lerp(y, t);
    else out[k] = t < 0.5 ? x : y;
  }
  return out;
}

export function createAtmosphere(ctx) {
  const { scene, uniforms: U, state } = ctx;
  const presets = ctx.sceneDef?.presets || PRESETS;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
  scene.add(hemi);

  const skyU = {
    ...fogUniforms(), uTime: U.uTime, uRain: U.uRain, uSunCol: U.uSunCol,
    uSkyMode: { value: 0 }, uCloudCover: { value: 0.5 }, uStars: { value: 0 },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uCloudCol: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
    uCirrus: { value: 0 }, uSkyPol: { value: 0 }, uSkyCurve: { value: 0.45 },
    tCloud: atmoUniforms.tCloudNoise, uCSParams: atmoUniforms.uCSParams, uCSOffset: atmoUniforms.uCSOffset,
  };
  // the cloud noise is only needed for the clear sky (fjord); the forest never builds it
  const needClouds = Object.values(presets).some((p) => p.skyMode === 1 || p.sunny?.skyMode === 1);
  if (needClouds) atmoUniforms.tCloudNoise.value = getCloudNoise();
  const skyR = (ctx.camera.far || 900) * 0.5;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(skyR, 48, 24),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, uniforms: skyU }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // Environment map from the sky (reflections). Regenerated when a preset settles / rain changes a lot.
  const pmrem = new THREE.PMREMGenerator(ctx.renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), sky.material);
  envScene.add(envSky);
  let envRT = null;
  function rebuildEnv() {
    const saved = U.uCamPos.value.clone();
    U.uCamPos.value.set(0, 0, 0);
    const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
    U.uCamPos.value.copy(saved);
    if (envRT) envRT.dispose();
    envRT = rt;
    scene.environment = rt.texture;
  }

  // Scene "looks" (state.look): presets may carry 'day.warm'-style variants of a time of day.
  // Two parallel sets: W = base (rain) look, S = with the preset's `sunny` overrides; cur = their mix.
  const raw = (tod) => presets[`${tod}.${state.get('look')}`] || presets[tod] || presets.day;
  const get = (tod) => withDefaults(raw(tod));
  const getS = (tod) => sunnyOf(raw(tod));
  const sunTarget = () => 1 - THREE.MathUtils.smoothstep(state.get('rain'), SUNNY_RAIN[0], SUNNY_RAIN[1]);
  let sunK = sunTarget();
  ctx.sunny = sunK;
  const curW = get(state.get('timeOfDay')), curS = getS(state.get('timeOfDay'));
  const cur = mixPreset({}, curW, curS, sunK);
  let from = null, to = null, fromS = null, toS = null;
  let blend = 1, envDirty = true, envRain = state.get('rain'), envSun = sunK;

  const retarget = () => {
    from = withDefaults(curW); fromS = withDefaults(curS);
    to = get(state.get('timeOfDay')); toS = getS(state.get('timeOfDay'));
    blend = 0;
  };
  state.on('timeOfDay', retarget);
  state.on('look', retarget);

  const sunTmp = new THREE.Vector3();
  function apply() {
    const rain = state.get('rain');
    const fogMul = THREE.MathUtils.lerp(0.45, 1.8, state.get('fog'));
    U.uSunDir.value.copy(cur.sunDir).normalize();
    const rs = ctx.skate?.enabled ? ctx.skate.state : null;
    if (cur.sunDir2 && cur.sunSplit && rs && typeof rs.s === 'number') {
      const k = THREE.MathUtils.smoothstep(rs.s, cur.sunSplit[0], cur.sunSplit[1]);
      if (k > 0) U.uSunDir.value.lerp(sunTmp.copy(cur.sunDir2).normalize(), k).normalize();
    }
    U.uSunCol.value.copy(cur.sunCol).multiplyScalar(1 - cur.rainDim * rain);
    U.uFogAmb.value.copy(cur.fogAmb);
    U.uFogHigh.value.copy(cur.fogHigh);
    U.uFogSunC.value.copy(cur.fogSunC);
    U.uFogDensity.value = cur.fogDensity * fogMul * (0.8 + 0.6 * rain);
    U.uFogFalloff.value = cur.fogFalloff;
    skyU.uSkyMode.value = cur.skyMode;
    skyU.uCloudCover.value = cur.cloudCover;
    skyU.uStars.value = cur.stars * (1 - rain);
    skyU.uZenith.value.copy(cur.zenith).lerp(cur.horizon, rain * 0.6).multiplyScalar(1 - 0.35 * rain);
    skyU.uHorizon.value.copy(cur.horizon).multiplyScalar(1 - 0.25 * rain);
    skyU.uCloudCol.value.copy(cur.cloudCol);
    skyU.uCloudShade.value.copy(cur.cloudShade);
    hemi.color.copy(cur.hemiSky).multiplyScalar(1 - 0.2 * rain);
    hemi.groundColor.copy(cur.hemiGround);
    hemi.intensity = 1;
    scene.environmentIntensity = cur.envIntensity;
    if (ctx.sun) ctx.sun.color.copy(U.uSunCol.value), (ctx.sun.intensity = 1);
    ctx.exposure = cur.exposure;
    ctx.volStrength = cur.volStrength;
    // cinematic extras
    atmoUniforms.uFogChroma.value.copy(cur.fogChroma);
    const cover = THREE.MathUtils.lerp(cur.cloudCover, 0.97, rain * 0.85);
    atmoUniforms.uCSParams.value.y = THREE.MathUtils.lerp(0.78, 0.3, cover);
    atmoUniforms.uCloudShadow.value = needClouds && cur.skyMode > 0.5 ? cur.cloudShadow * (1 - 0.6 * rain) : 0;
    skyU.uCirrus.value = cur.cirrus * (1 - rain);
    skyU.uSkyPol.value = cur.skyPol * (1 - rain);
    skyU.uSkyCurve.value = cur.skyCurve;
  }
  apply();

  return {
    cur, presets, hemi, rebuildEnv,
    update(dt) {
      sky.position.copy(ctx.camera.position);
      // clouds (sky + their ground shadows) drift with the wind
      const w = U.uWind.value, wl = Math.hypot(w.x, w.z) || 1;
      const k = (cur.cloudSpeed * dt) * atmoUniforms.uCSParams.value.x;
      atmoUniforms.uCSOffset.value.x = (atmoUniforms.uCSOffset.value.x - (w.x / wl) * k) % 64;
      atmoUniforms.uCSOffset.value.y = (atmoUniforms.uCSOffset.value.y - (w.z / wl) * k) % 64;
      if (blend < 1) {
        blend = Math.min(1, blend + dt / 4);
        const t = blend * blend * (3 - 2 * blend);
        for (const [c, f, g] of [[curW, from, to], [curS, fromS, toS]]) {
          for (const k in g) {
            if (typeof g[k] === 'number') c[k] = THREE.MathUtils.lerp(f[k], g[k], t);
            else if (g[k]?.isVector3 && f[k]?.isVector3 && c[k]?.isVector3) c[k].copy(f[k]).lerp(g[k], t);
            else if (g[k]?.copy && c[k]?.copy && f[k]?.copy) c[k].copy(f[k]).lerp(g[k], t);
            else c[k] = g[k]?.clone ? g[k].clone() : g[k];
          }
        }
        if (blend === 1) envDirty = true;
      }
      // sun ↔ rain: ease the fair-weather look in/out (~2 s)
      sunK += (sunTarget() - sunK) * (1 - Math.exp(-dt / 0.8));
      if (Math.abs(sunK - sunTarget()) < 3e-3) sunK = sunTarget();
      ctx.sunny = sunK;
      mixPreset(cur, curW, curS, sunK);
      const rain = state.get('rain');
      if (Math.abs(rain - envRain) > 0.15) { envRain = rain; envDirty = true; }
      if (Math.abs(sunK - envSun) > 0.3 || (sunK !== envSun && (sunK === 0 || sunK === 1))) { envSun = sunK; envDirty = true; }
      apply();
      if (envDirty) { rebuildEnv(); envDirty = false; }
    },
  };
}
