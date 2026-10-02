// Procedural textures for vegetation: one leaf atlas (colour+alpha with
// coverage-preserving mipmaps, plus a normal map) and a few tileable barks
// (colour + normal from a multi-layer height field). Zero external assets.

import * as THREE from 'three';
import { mulberry32 } from '../../core/noise.js';

/* ------------------------------------------------------------------ bark */
// Tileable bark generated on the GPU (fast): colour (sRGB RT) + normal (from
// the same height field). kind: 0 emergent (pale, lichen), 1 mid (fissured),
// 2 palm (ringed), 3 tree fern (fibrous with leaf scars).
const BARK_FRAG = /* glsl */ `
precision highp float;
uniform int uKind;
uniform int uMode;       // 0 colour, 1 normal
uniform float uSeed;
uniform vec2 uRes;
uniform float uStrength;
varying vec2 vUv;

float hash(vec2 p, float s) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + s * 0.1379);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 x, vec2 per, float s) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
  float a = hash(i0, s), b = hash(vec2(i1.x, i0.y), s), c = hash(vec2(i0.x, i1.y), s), d = hash(i1, s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float tfbm(vec2 uv, vec2 per, int oct, float s) {
  float sum = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 6; o++) {
    if (o >= oct) break;
    sum += a * vnoise(uv * per + vec2(float(o) * 17.3, float(o) * 9.1), per, s + float(o) * 7.0);
    n += a; a *= 0.5; per *= 2.0;
  }
  return sum / n;
}
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

// returns rgb (0..255 sRGB) in .rgb and height in .a
vec4 bark(vec2 uv) {
  float u = uv.x, v = uv.y;
  float S = uSeed;
  vec3 c; float ht;
  if (uKind == 0) {
    float broad = tfbm(uv, vec2(4.0, 2.0), 4, S);
    float fib = tfbm(uv, vec2(96.0, 3.0), 3, S + 1.0);
    // sparse, vertical, broken fissures
    float crackN = tfbm(uv, vec2(20.0, 1.0), 3, S + 2.0);
    float crackMask = sstep(0.42, 0.6, tfbm(uv, vec2(8.0, 6.0), 2, S + 6.0));
    float crack = (1.0 - sstep(0.0, 0.035, abs(crackN - 0.5))) * crackMask;
    float ring = sstep(0.95, 1.0, vnoise(uv * vec2(48.0, 128.0), vec2(48.0, 128.0), S + 3.0)) * 0.5;
    float lichenN = tfbm(uv + vec2(0.3, 0.0), vec2(8.0, 6.0), 4, S + 4.0);
    float lichen = sstep(0.58, 0.72, lichenN);
    float moss = sstep(0.6, 0.74, tfbm(uv + vec2(0.5, 0.2), vec2(4.0, 3.0), 4, S + 5.0));
    ht = broad * 0.45 + fib * 0.3 - crack * 0.6 - ring * 0.2 + moss * 0.3 + lichen * 0.06;
    float t = broad * 0.55 + fib * 0.45;
    c = vec3(112.0, 104.0, 92.0) + t * vec3(44.0, 40.0, 34.0);
    c = mix(c, vec3(172.0, 176.0, 162.0), lichen * 0.55);
    c = mix(c, mix(vec3(150.0, 150.0, 128.0), vec3(176.0, 150.0, 130.0), step(0.66, lichenN)), sstep(0.7, 0.78, lichenN) * 0.4);
    c = mix(c, vec3(62.0, 74.0, 36.0), moss * (0.6 + 0.4 * fib));
    float ck = crack * 0.6 + ring * 0.3;
    c *= vec3(1.0 - ck, 1.0 - ck * 0.95, 1.0 - ck * 0.9);
  } else if (uKind == 1) {
    float broad = tfbm(uv, vec2(4.0), 4, S);
    float fis = tfbm(uv, vec2(16.0, 2.0), 4, S + 1.0);
    float ridge = 1.0 - abs(fis * 2.0 - 1.0);
    float fine = tfbm(uv, vec2(64.0, 16.0), 2, S + 2.0);
    float moss = sstep(0.55, 0.7, tfbm(uv, vec2(4.0), 4, S + 3.0));
    ht = ridge * 0.7 + fine * 0.2 + broad * 0.2 + moss * 0.2;
    float t = ridge * 0.6 + fine * 0.4;
    float lich = sstep(0.6, 0.72, tfbm(uv + vec2(0.4, 0.1), vec2(6.0, 3.0), 4, S + 4.0));
    c = vec3(84.0, 78.0, 64.0) + t * vec3(46.0, 42.0, 34.0);
    c = mix(c, vec3(150.0, 154.0, 136.0), lich * 0.6);
    c = mix(c, vec3(56.0, 70.0, 34.0), moss);
    c *= 1.0 - sstep(0.35, 0.05, ridge) * 0.5;
  } else if (uKind == 2) {
    float broad = tfbm(uv, vec2(4.0), 3, S);
    float fine = tfbm(uv, vec2(64.0, 8.0), 3, S + 1.0);
    float rv = v * 22.0 + (tfbm(uv, vec2(4.0, 2.0), 2, S + 2.0) - 0.5) * 0.8;
    float rf = fract(rv);
    float ring = sstep(0.0, 0.08, rf) * sstep(0.35, 0.12, rf);
    float lichen = sstep(0.58, 0.7, tfbm(uv, vec2(6.0), 3, S + 3.0));
    ht = broad * 0.3 + fine * 0.2 + ring * 0.6 - (1.0 - sstep(0.0, 0.12, rf)) * 0.3;
    float t = broad * 0.5 + fine * 0.5;
    c = vec3(92.0, 88.0, 76.0) + t * vec3(38.0, 34.0, 28.0);
    c = mix(c, vec3(150.0, 156.0, 140.0), lichen * 0.5);
    c *= 1.0 - (1.0 - ring) * 0.25;
  } else {
    float fib = tfbm(uv, vec2(128.0, 6.0), 3, S);
    float fib2 = tfbm(uv, vec2(48.0, 3.0), 3, S + 1.0);
    float du = u * 5.0, dv = v * 6.0;
    float cu = fract(du) - 0.5;
    float cv = fract(dv) - 0.5 + (mod(floor(du), 2.0) > 0.5 ? 0.5 : 0.0);
    cv = cv - floor(cv + 0.5);
    float wob = (tfbm(uv, vec2(16.0, 8.0), 2, S + 2.0) - 0.5) * 0.2;
    float scar = sstep(0.42, 0.22, abs(cu) + abs(cv) * 0.9 + wob);
    ht = fib * 0.5 + fib2 * 0.3 + scar * 0.2;
    float t = fib * 0.6 + fib2 * 0.4;
    c = vec3(58.0, 46.0, 34.0) + t * vec3(42.0, 32.0, 22.0);
    c = mix(c, vec3(84.0, 72.0, 52.0), scar * 0.45);
  }
  return vec4(min(c, vec3(255.0)), ht);
}

void main() {
  vec2 uv = vUv;
  if (uMode == 0) {
    vec3 srgb = bark(uv).rgb / 255.0;
    gl_FragColor = vec4(pow(srgb, vec3(2.2)), 1.0);   // RT is sRGB: store linear, hardware encodes
  } else {
    vec2 e = 1.0 / uRes;
    float hl = bark(uv - vec2(e.x, 0.0)).a, hr = bark(uv + vec2(e.x, 0.0)).a;
    float hd = bark(uv - vec2(0.0, e.y)).a, hu = bark(uv + vec2(0.0, e.y)).a;
    vec3 n = normalize(vec3(-(hr - hl) * uStrength, -(hu - hd) * uStrength, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  }
}`;

const KIND = { emergent: 0, mid: 1, palm: 2, fern: 3 };
let _barkQuad = null;
export function makeBark(renderer, kind, W, H, seed, anisotropy) {
  if (!_barkQuad) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: BARK_FRAG,
      uniforms: { uKind: { value: 0 }, uMode: { value: 0 }, uSeed: { value: 0 }, uRes: { value: new THREE.Vector2() }, uStrength: { value: 1 } },
      depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    _barkQuad = { mat, scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }
  const q = _barkQuad;
  const mk = (srgb) => new THREE.WebGLRenderTarget(W, H, {
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, anisotropy,
  });
  const colRT = mk(true), nrmRT = mk(false);
  const prevRT = renderer.getRenderTarget();
  const prevTM = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  q.mat.uniforms.uKind.value = KIND[kind];
  q.mat.uniforms.uSeed.value = seed % 97;
  q.mat.uniforms.uRes.value.set(W, H);
  q.mat.uniforms.uStrength.value = W / ({ emergent: 64, mid: 48, palm: 56, fern: 110 })[kind];
  q.mat.uniforms.uMode.value = 0;
  renderer.setRenderTarget(colRT); renderer.render(q.scene, q.cam);
  q.mat.uniforms.uMode.value = 1;
  renderer.setRenderTarget(nrmRT); renderer.render(q.scene, q.cam);
  renderer.setRenderTarget(prevRT);
  renderer.toneMapping = prevTM;
  return { map: colRT.texture, normalMap: nrmRT.texture, rts: [colRT, nrmRT] };
}


/* ------------------------------------------------------------ leaf atlas */
const AW = 2048, AH = 2048;
// Slot rects in canvas pixels [x, y, w, h]. Leaves are drawn with their base
// at the bottom of the slot and the tip at the top.
const SLOTS = {
  alocasia: [0, 0, 512, 512],
  monstera: [512, 0, 512, 512],
  canopyA: [1024, 0, 512, 512],
  canopyB: [1536, 0, 512, 512],
  banana: [0, 512, 512, 1024],
  fern: [512, 512, 512, 1024],
  palm: [1024, 512, 512, 1024],
  shrub: [1536, 512, 512, 512],
  vine: [1536, 1024, 256, 1024],
  stem: [1800, 1024, 48, 1024],
  strap: [1856, 1024, 192, 1024],
  canopyC: [0, 1536, 512, 512],
  heart: [512, 1536, 256, 256],
  dead: [768, 1536, 256, 256],
  fernB: [1024, 1536, 256, 512],
  fernDead: [1280, 1536, 256, 512],
};

function rgb(r, g, b, a = 1) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }

function drawVeinedLeaf(g, R, pathFn, opt) {
  // Clip to the leaf, fill with gradients, veins, edge tint and speckles.
  g.save();
  g.beginPath(); pathFn(); g.closePath();
  g.fillStyle = opt.base; g.fill();
  g.clip();
  const [x0, y0, w, h] = opt.box;
  const gr = g.createLinearGradient(x0, y0 + h, x0, y0);
  gr.addColorStop(0, opt.shadeBase || 'rgba(0,0,0,0.15)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(x0, y0, w, h);
  // mottling
  for (let i = 0; i < 60; i++) {
    const r = 10 + R() * 40;
    g.fillStyle = R() < 0.5 ? `rgba(0,0,0,${0.03 + R() * 0.05})` : `rgba(120,140,70,${0.02 + R() * 0.05})`;
    g.beginPath(); g.ellipse(x0 + R() * w, y0 + R() * h, r, r * (0.5 + R()), R() * 3, 0, 7); g.fill();
  }
  if (opt.veins) opt.veins();
  // edge tint: yellow-brown rim, darker inner band
  g.beginPath(); pathFn(); g.closePath();
  g.lineWidth = opt.edgeW || 10; g.strokeStyle = opt.edge || 'rgba(110,100,45,0.45)'; g.stroke();
  g.lineWidth = 3; g.strokeStyle = 'rgba(70,60,30,0.6)'; g.stroke();
  // fine speckle
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '150,160,100'},${R() * 0.08})`;
    g.fillRect(x0 + R() * w, y0 + R() * h, 2, 2);
  }
  g.restore();
}

function bez(g, pts, X, Y) {
  // pts: [[x,y] start, then triples of control points] in 0..1 slot coords
  g.moveTo(X(pts[0][0]), Y(pts[0][1]));
  for (let i = 1; i + 2 < pts.length + 1; i += 3) {
    if (!pts[i + 2]) break;
    g.bezierCurveTo(X(pts[i][0]), Y(pts[i][1]), X(pts[i + 1][0]), Y(pts[i + 1][1]), X(pts[i + 2][0]), Y(pts[i + 2][1]));
  }
}

function drawAlocasia(g, R, [x, y, w, h], mono) {
  const X = (u) => x + u * w, Y = (v) => y + v * h;
  const pts = [[0.5, 0.02],
    [0.64, 0.13], [0.98, 0.36], [0.96, 0.62],
    [0.95, 0.86], [0.83, 0.995], [0.68, 0.985],
    [0.58, 0.975], [0.53, 0.86], [0.5, 0.79],
    [0.47, 0.86], [0.42, 0.975], [0.32, 0.985],
    [0.17, 0.995], [0.05, 0.86], [0.04, 0.62],
    [0.02, 0.36], [0.36, 0.13], [0.5, 0.02]];
  const base = mono ? rgb(44, 72, 44) : rgb(38, 64, 46);
  const cx = 0.5, cy = 0.74; // petiole junction
  drawVeinedLeaf(g, R, () => bez(g, pts, X, Y), {
    base, box: [x, y, w, h], edge: 'rgba(100,110,55,0.5)',
    shadeBase: 'rgba(10,20,10,0.25)',
    veins: () => {
      g.lineCap = 'round';
      // midrib
      g.strokeStyle = rgb(150, 165, 110, 0.85); g.lineWidth = 7;
      g.beginPath(); g.moveTo(X(cx), Y(cy)); g.quadraticCurveTo(X(0.5), Y(0.4), X(0.5), Y(0.04)); g.stroke();
      // laterals
      for (let s = -1; s <= 1; s += 2) {
        for (let i = 0; i < 7; i++) {
          const t = 0.12 + i * 0.1;
          const my = cy - t * (cy - 0.05);
          const ex = 0.5 + s * (0.44 - Math.abs(t - 0.35) * 0.35), ey = my - 0.12 - t * 0.05;
          g.strokeStyle = rgb(140, 158, 100, 0.55); g.lineWidth = 3.2 - i * 0.25;
          g.beginPath(); g.moveTo(X(0.5), Y(my)); g.quadraticCurveTo(X(0.5 + s * 0.22), Y(my - 0.02), X(ex), Y(ey)); g.stroke();
          // faint intervenal
          g.strokeStyle = rgb(20, 40, 25, 0.25); g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(X(0.5 + s * 0.02), Y(my - 0.05)); g.quadraticCurveTo(X(0.5 + s * 0.2), Y(my - 0.07), X(ex * 0.95 + 0.025), Y(ey - 0.05)); g.stroke();
        }
        // basal veins into lobes
        g.strokeStyle = rgb(140, 158, 100, 0.6); g.lineWidth = 4;
        g.beginPath(); g.moveTo(X(cx), Y(cy)); g.quadraticCurveTo(X(0.5 + s * 0.2), Y(0.84), X(0.5 + s * 0.3), Y(0.96)); g.stroke();
      }
    },
  });
}

function drawMonstera(g, R, rect) {
  const [x, y, w, h] = rect;
  const X = (u) => x + u * w, Y = (v) => y + v * h;
  const pts = [[0.5, 0.03],
    [0.72, 0.05], [0.98, 0.26], [0.97, 0.55],
    [0.96, 0.82], [0.78, 0.98], [0.6, 0.95],
    [0.55, 0.94], [0.52, 0.9], [0.5, 0.86],
    [0.48, 0.9], [0.45, 0.94], [0.4, 0.95],
    [0.22, 0.98], [0.04, 0.82], [0.03, 0.55],
    [0.02, 0.26], [0.28, 0.05], [0.5, 0.03]];
  drawVeinedLeaf(g, R, () => bez(g, pts, X, Y), {
    base: rgb(34, 60, 40), box: rect, edge: 'rgba(90,100,50,0.45)',
    veins: () => {
      g.lineCap = 'round';
      g.strokeStyle = rgb(130, 150, 95, 0.8); g.lineWidth = 6;
      g.beginPath(); g.moveTo(X(0.5), Y(0.86)); g.lineTo(X(0.5), Y(0.05)); g.stroke();
    },
  });
  // fenestrations: slits from the edge between laterals, and holes
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 6; i++) {
      const my = 0.8 - i * 0.12 - R() * 0.03;
      const ang = -0.5 - i * 0.05;
      const len = 0.24 + R() * 0.12;
      const sx = 0.5 + s * 0.52, sy = my - 0.12;
      const exx = sx - s * Math.cos(ang) * len, eyy = sy - Math.sin(ang) * len * 0.5;
      g.beginPath();
      g.moveTo(X(sx), Y(sy - 0.025)); g.lineTo(X(exx), Y(eyy)); g.lineTo(X(sx), Y(sy + 0.025));
      g.fill();
      if (i > 0 && i < 5 && R() < 0.8) {
        g.beginPath(); g.ellipse(X(0.5 + s * (0.1 + R() * 0.05)), Y(my - 0.02), 9 + R() * 6, 4 + R() * 3, s * 0.4, 0, 7); g.fill();
      }
    }
  }
  g.restore();
}

function drawBanana(g, R, rect) {
  const [x, y, w, h] = rect;
  const X = (u) => x + u * w, Y = (v) => y + v * h;
  const halfW = (t) => 0.46 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.35) * (1 - 0.15 * t);
  // outline
  const N = 40;
  const outline = () => {
    g.moveTo(X(0.5), Y(0.995));
    for (let i = 1; i <= N; i++) { const t = i / N; g.lineTo(X(0.5 + halfW(t)), Y(0.995 - t * 0.985)); }
    for (let i = N; i >= 0; i--) { const t = i / N; g.lineTo(X(0.5 - halfW(t)), Y(0.995 - t * 0.985)); }
  };
  drawVeinedLeaf(g, R, outline, {
    base: rgb(52, 80, 46), box: rect, edge: 'rgba(120,105,50,0.6)', edgeW: 14,
    veins: () => {
      // parallel laterals
      for (let i = 0; i < 90; i++) {
        const t = 0.02 + i / 92;
        const yy = 0.995 - t * 0.985;
        for (let s = -1; s <= 1; s += 2) {
          g.strokeStyle = rgb(i % 3 ? 30 : 110, i % 3 ? 50 : 130, i % 3 ? 30 : 80, 0.25);
          g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(X(0.5), Y(yy)); g.quadraticCurveTo(X(0.5 + s * 0.25), Y(yy - 0.01), X(0.5 + s * 0.5), Y(yy - 0.05)); g.stroke();
        }
      }
      g.strokeStyle = rgb(160, 170, 110, 0.9); g.lineWidth = 12;
      g.beginPath(); g.moveTo(X(0.5), Y(1)); g.lineTo(X(0.5), Y(0.01)); g.stroke();
      // dry brown patches along the edge
      for (let i = 0; i < 8; i++) {
        const t = R();
        g.fillStyle = `rgba(110,90,45,${0.25 + R() * 0.3})`;
        g.beginPath(); g.ellipse(X(0.5 + (R() < 0.5 ? -1 : 1) * halfW(t) * 0.95), Y(0.995 - t * 0.985), 20 + R() * 25, 8 + R() * 20, 0, 0, 7); g.fill();
      }
    },
  });
  // tears along lateral veins
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) {
    const t = 0.12 + R() * 0.8;
    const s = R() < 0.5 ? -1 : 1;
    const yy = 0.995 - t * 0.985;
    const depth = (0.25 + R() * 0.7) * halfW(t);
    const ex = 0.5 + s * halfW(t) * 1.05;
    g.beginPath();
    g.moveTo(X(ex), Y(yy - 0.05 - 0.004)); g.lineTo(X(0.5 + s * (halfW(t) - depth)), Y(yy - 0.05 + depth * 0.1)); g.lineTo(X(ex), Y(yy - 0.05 + 0.006));
    g.fill();
  }
  g.restore();
}

function drawPinnate(g, R, rect, o) {
  // generic pinnate frond: rachis + leaflets (fern pinnae or palm leaflets)
  const [x, y, w, h] = rect;
  const X = (u) => x + u * w, Y = (v) => y + v * h;
  g.save();
  g.lineCap = 'round';
  const n = o.count;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;             // 0 base → 1 tip
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.95)), o.envPow) * (1 - 0.3 * t);
    const yy = 0.99 - t * 0.97;
    for (let s = -1; s <= 1; s += 2) {
      const L = o.len * env * (0.9 + R() * 0.2);
      if (L < 0.01) continue;
      const ang = o.angle + (R() - 0.5) * 0.12; // from rachis axis, towards tip
      const dx = s * Math.sin(ang), dy = -Math.cos(ang);
      const bx = 0.5, by = yy;
      const ex = bx + dx * L, ey = by + dy * L * (w / h) + o.droop * L * L * (w / h);
      const c = o.colors[(R() * o.colors.length) | 0];
      const shade = 0.85 + R() * 0.3;
      g.fillStyle = rgb(c[0] * shade, c[1] * shade, c[2] * shade);
      if (o.style === 'fern') {
        // pinna = axis with overlapping pinnules on both sides
        const ax = (ex - bx) * w, ay = (ey - by) * h;
        const alen = Math.hypot(ax, ay);
        const ang = Math.atan2(ax, -ay);            // canvas rotation of the pinna axis
        const k = Math.max(4, Math.round(alen / 6));
        for (let j = 0; j < k; j++) {
          const q = j / k;
          const px = X(bx) + ax * q, py = Y(by) + ay * q;
          const pl = (1 - q * 0.85) * o.width * w * (0.6 + env * 0.4);
          const sh2 = 0.9 + R() * 0.2;
          const fill = rgb(c[0] * shade * sh2, c[1] * shade * sh2, c[2] * shade * sh2);
          for (let sd = -1; sd <= 1; sd += 2) {
            // pinnules angled toward the pinna tip
            leafShape(g, px, py, pl, pl * 0.5, ang + sd * 1.05, fill, null);
          }
        }
        g.strokeStyle = rgb(c[0] * 0.8, c[1] * 0.8, c[2] * 0.6, 0.9); g.lineWidth = 2;
        g.beginPath(); g.moveTo(X(bx), Y(by)); g.lineTo(X(ex), Y(ey)); g.stroke();
      } else {
        // strap leaflet: tapered shape along a curve
        const wd = o.width * w * (0.7 + env * 0.3);
        const mx = (bx + ex) / 2, my = (by + ey) / 2 + o.droop * 0.02;
        const nx = -(ey - by) * h, ny = (ex - bx) * w; const nl = Math.hypot(nx, ny) || 1;
        const ox = (nx / nl) * wd, oy = (ny / nl) * wd;
        g.beginPath();
        g.moveTo(X(bx), Y(by));
        g.quadraticCurveTo(X(mx) + ox, Y(my) + oy, X(ex), Y(ey));
        g.quadraticCurveTo(X(mx) - ox * 0.6, Y(my) - oy * 0.6, X(bx), Y(by));
        g.fill();
        g.strokeStyle = rgb(160, 170, 110, 0.35); g.lineWidth = 1;
        g.beginPath(); g.moveTo(X(bx), Y(by)); g.quadraticCurveTo(X(mx) + ox * 0.2, Y(my) + oy * 0.2, X(ex), Y(ey)); g.stroke();
      }
    }
  }
  g.strokeStyle = o.rachis; g.lineWidth = o.rachisW;
  g.beginPath(); g.moveTo(X(0.5), Y(1)); g.quadraticCurveTo(X(0.5), Y(0.5), X(0.5), Y(0.01)); g.stroke();
  g.restore();
}

function leafShape(g, cx, cy, len, wid, ang, fill, vein) {
  // pointed elliptic leaf with drip tip, base at (cx,cy), pointing along ang
  g.save();
  g.translate(cx, cy); g.rotate(ang);
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(wid * 0.9, -len * 0.15, wid * 0.8, -len * 0.75, 0, -len);
  g.bezierCurveTo(-wid * 0.8, -len * 0.75, -wid * 0.9, -len * 0.15, 0, 0);
  g.fillStyle = fill; g.fill();
  if (vein) {
    g.strokeStyle = vein; g.lineWidth = Math.max(1, wid * 0.08);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -len * 0.92); g.stroke();
  }
  g.restore();
}

function drawCluster(g, R, rect, o) {
  // A leafy spray that fills most of the card: short stem from the base to a
  // hub, twigs out to nodes, leaves radiating outward. Used for crowns/shrubs.
  const [x, y, w, h] = rect;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  const cx = x + w * 0.5, cy = y + h * 0.5;
  const nodes = [];
  const nN = o.nodes || 7;
  for (let k = 0; k < nN; k++) {
    const a = (k / nN) * Math.PI * 2 + R() * 0.6;
    const r = (0.1 + R() * 0.2) * w;
    nodes.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.9]);
  }
  g.lineCap = 'round';
  g.strokeStyle = rgb(62, 54, 40);
  g.lineWidth = 7; g.beginPath(); g.moveTo(cx, y + h); g.quadraticCurveTo(cx + w * 0.03, cy + h * 0.25, cx, cy); g.stroke();
  g.lineWidth = 4;
  for (const [nx, ny] of nodes) { g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo((cx + nx) / 2, (cy + ny) / 2 - h * 0.03, nx, ny); g.stroke(); }
  const leaves = [];
  const Lmax = o.len * w * 1.2;
  const rx = w * 0.48 - Lmax, ry = h * 0.47 - Lmax;
  for (let i = 0; i < o.count; i++) {
    let px, py;
    do { px = R() * 2 - 1; py = R() * 2 - 1; } while (px * px + py * py > 1);
    const rr = Math.pow(px * px + py * py, 0.25);            // push toward the rim
    const a0 = Math.atan2(py, px);
    const bx = cx + Math.cos(a0) * rr * rx, by = cy + Math.sin(a0) * rr * ry;
    let best = nodes[0], bd = 1e9;
    for (const nd of nodes) { const d = (nd[0] - bx) ** 2 + (nd[1] - by) ** 2; if (d < bd) { bd = d; best = nd; } }
    const ang = Math.atan2(bx - best[0], -(by - best[1])) + (R() - 0.5) * 0.7;
    leaves.push([bx, by, ang, best]);
  }
  g.strokeStyle = rgb(58, 52, 38); g.lineWidth = 1.6;
  for (const [bx, by, , nd] of leaves) { g.beginPath(); g.moveTo(nd[0], nd[1]); g.lineTo(bx, by); g.stroke(); }
  for (const [bx, by, ang] of leaves) {
    const len = o.len * (0.75 + R() * 0.45) * w, wid = len * o.aspect;
    const c = o.colors[(R() * o.colors.length) | 0];
    const sh = 0.8 + R() * 0.35;
    leafShape(g, bx, by, len, wid, ang, rgb(c[0] * sh, c[1] * sh, c[2] * sh), rgb(c[0] * 1.5, c[1] * 1.45, c[2] * 1.3, 0.5));
  }
  g.restore();
}

function drawVine(g, R, rect) {
  const [x, y, w, h] = rect;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.lineCap = 'round';
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pts.push([x + w * (0.5 + Math.sin(t * 9) * 0.08), y + h * t]);
  }
  g.strokeStyle = rgb(70, 72, 45); g.lineWidth = 5;
  g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.stroke();
  for (let i = 1; i < 14; i++) {
    const t = i / 14 + (R() - 0.5) * 0.02;
    const px = x + w * (0.5 + Math.sin(t * 9) * 0.08), py = y + h * t;
    const s = i % 2 ? 1 : -1;
    const len = w * (0.32 + R() * 0.12);
    // heart leaf hanging down-sideways
    const ang = Math.PI - s * (0.7 + R() * 0.4);
    const c = [[48, 76, 44], [40, 66, 42], [60, 84, 44]][(R() * 3) | 0];
    leafShape(g, px, py, len, len * 0.55, ang, rgb(c[0], c[1], c[2]), rgb(120, 140, 90, 0.5));
  }
  g.restore();
}

function drawStem(g, R, [x, y, w, h]) {
  const gr = g.createLinearGradient(x, y + h, x, y);
  gr.addColorStop(0, rgb(70, 64, 42)); gr.addColorStop(0.4, rgb(72, 88, 50)); gr.addColorStop(1, rgb(80, 100, 58));
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '160,170,120'},0.08)`;
    g.fillRect(x + R() * w, y, 1 + R() * 2, h);
  }
}

function drawStrap(g, R, rect) {
  const [x, y, w, h] = rect;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  // three strap leaves side by side (bromeliad / grass clump card)
  for (let k = 0; k < 3; k++) {
    const cx = x + w * (0.2 + k * 0.3);
    const wd = w * 0.12;
    const c = [[58, 80, 44], [44, 70, 44], [72, 88, 48]][k];
    g.beginPath();
    g.moveTo(cx - wd, y + h);
    g.quadraticCurveTo(cx - wd * 1.1, y + h * 0.4, cx + (k - 1) * w * 0.05, y + h * 0.02);
    g.quadraticCurveTo(cx + wd * 1.1, y + h * 0.4, cx + wd, y + h);
    g.fillStyle = rgb(...c); g.fill();
    g.strokeStyle = rgb(130, 140, 90, 0.4); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx, y + h); g.lineTo(cx + (k - 1) * w * 0.05, y + h * 0.05); g.stroke();
    // reddish base tint
    const gr = g.createLinearGradient(0, y + h, 0, y + h * 0.7);
    gr.addColorStop(0, 'rgba(90,50,40,0.35)'); gr.addColorStop(1, 'rgba(90,50,40,0)');
    g.fillStyle = gr; g.fillRect(cx - wd * 1.2, y + h * 0.7, wd * 2.4, h * 0.3);
  }
  g.restore();
}

export function makeLeafAtlas(anisotropy) {
  const cv = document.createElement('canvas');
  cv.width = AW; cv.height = AH;
  const g = cv.getContext('2d');
  const R = mulberry32(7771);

  drawAlocasia(g, R, SLOTS.alocasia, false);
  drawMonstera(g, R, SLOTS.monstera);
  drawCluster(g, R, SLOTS.canopyA, { count: 70, len: 0.14, aspect: 0.42,
    colors: [[36, 60, 40], [44, 68, 42], [30, 52, 38], [54, 74, 42]] });
  drawCluster(g, R, SLOTS.canopyB, { count: 130, len: 0.095, aspect: 0.5,
    colors: [[58, 76, 40], [66, 82, 44], [48, 68, 40], [76, 86, 46]] });
  drawCluster(g, R, SLOTS.canopyC, { count: 36, len: 0.2, aspect: 0.38, nodes: 5,
    colors: [[32, 56, 42], [40, 62, 46], [28, 50, 40]] });
  drawCluster(g, R, SLOTS.shrub, { count: 60, len: 0.15, aspect: 0.55,
    colors: [[40, 66, 40], [50, 74, 44], [34, 58, 40], [60, 78, 44]] });
  drawBanana(g, R, SLOTS.banana);
  drawPinnate(g, R, SLOTS.fern, { count: 26, len: 0.46, envPow: 0.7, angle: 1.1, droop: 0.4, width: 0.036,
    style: 'fern', colors: [[62, 90, 48], [54, 82, 46], [70, 96, 50]], rachis: rgb(70, 72, 40), rachisW: 5 });
  drawPinnate(g, R, SLOTS.fernB, { count: 24, len: 0.46, envPow: 0.6, angle: 1.2, droop: 0.3, width: 0.042,
    style: 'fern', colors: [[44, 72, 44], [50, 78, 46]], rachis: rgb(60, 60, 36), rachisW: 4 });
  drawPinnate(g, R, SLOTS.fernDead, { count: 22, len: 0.44, envPow: 0.6, angle: 1.3, droop: 1.2, width: 0.04,
    style: 'fern', colors: [[96, 78, 50], [84, 66, 44], [110, 90, 58]], rachis: rgb(70, 55, 36), rachisW: 4 });
  drawPinnate(g, R, SLOTS.palm, { count: 34, len: 0.5, envPow: 0.5, angle: 0.55, droop: 0.9, width: 0.018,
    style: 'palm', colors: [[50, 76, 44], [58, 82, 46], [44, 68, 42]], rachis: rgb(90, 96, 60), rachisW: 6 });
  drawVine(g, R, SLOTS.vine);
  drawStem(g, R, SLOTS.stem);
  drawStrap(g, R, SLOTS.strap);
  // small heart leaf (climbers on trunks) and a dead leaf
  {
    const [x, y, w, h] = SLOTS.heart;
    leafShape(g, x + w / 2, y + h * 0.98, h * 0.95, w * 0.6, 0, rgb(42, 70, 44), rgb(120, 140, 90, 0.6));
    const [x2, y2, w2, h2] = SLOTS.dead;
    leafShape(g, x2 + w2 / 2, y2 + h2 * 0.98, h2 * 0.95, w2 * 0.45, 0, rgb(110, 84, 52), rgb(140, 110, 70, 0.6));
  }

  // Colour: opaque, with leaf colour bled far outside the leaves so mips never
  // pull in dark fringes. Alpha lives in a separate map (white = leaf).
  const cc = document.createElement('canvas');
  cc.width = AW; cc.height = AH;
  const gc = cc.getContext('2d');
  gc.fillStyle = rgb(44, 66, 44); gc.fillRect(0, 0, AW, AH);
  gc.filter = 'blur(16px)'; gc.drawImage(cv, 0, 0); gc.drawImage(cv, 0, 0);
  gc.filter = 'blur(5px)'; gc.drawImage(cv, 0, 0); gc.drawImage(cv, 0, 0);
  gc.filter = 'none'; gc.drawImage(cv, 0, 0);
  const ca = document.createElement('canvas');
  ca.width = AW; ca.height = AH;
  const ga = ca.getContext('2d');
  ga.fillStyle = '#000'; ga.fillRect(0, 0, AW, AH);
  ga.filter = 'brightness(0) invert(1)'; ga.drawImage(cv, 0, 0); ga.filter = 'none';

  const map = new THREE.CanvasTexture(cc);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  const alphaMap = new THREE.CanvasTexture(ca);
  alphaMap.anisotropy = anisotropy;
  alphaMap.minFilter = THREE.LinearMipmapLinearFilter;

  // slot → uv rect (v0 bottom, v1 top)
  const slots = {};
  for (const [k, [x, y, w, h]] of Object.entries(SLOTS)) {
    const pad = 1;
    slots[k] = { u0: (x + pad) / AW, u1: (x + w - pad) / AW, v0: 1 - (y + h - pad) / AH, v1: 1 - (y + pad) / AH };
  }
  return { map, alphaMap, slots, size: AW };
}
