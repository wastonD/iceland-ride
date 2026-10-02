// Fjord road: asphalt ribbon that follows world.path exactly, markings, roadside kit
// (delineators, guard rails, signs), the start viewpoint pad and the town street.
import * as THREE from 'three';
import { addShaderPatch } from '../../render/shaderPatch.js';
import {
  buildRoad, buildStreet, buildMarkings, guardrailPlan, railSegments, delineatorPlan, signPlan,
  buildSignPanels, delineatorGeometry, railBeamGeometry, railPostGeometry, PAD,
} from './build/roadGeo.js';
import { streetLines } from './build/villageLayout.js';
import { asphaltTextures, markingWearTexture, signAtlas } from './build/textures.js';
import { createInfrastructure } from './build/infra.js';
import { TEX_W, TEX_V } from './build/roadGeo.js';
import { groundUniforms } from './env/groundTex.js';

const GRAIN_VERT_PARS = 'varying vec3 vGrainPos;';
const GRAIN_FRAG_PARS = /* glsl */ `
varying vec3 vGrainPos;
precision highp sampler2DArray;
uniform sampler2DArray uGAlb, uGNrm;
uniform vec4 uGLay[8];
uniform vec4 uGMean[8];
uniform float uPhoto;
vec2 rHash2(float i) { return fract(sin(vec2(i * 12.9898 + 1.3, i * 78.233 + 4.1)) * 43758.5453); }
float rNoise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(rHash2(i).x, rHash2(i + 1.0).x, f); }
// Photo asphalt / gravel lookup in road metres (lateral, along). Two random-offset taps blended
// over ~25 m stretches so the scan's distinctive cracks never line up into a repeating pattern.
void roadTap(float L, vec2 m, out vec4 a, out vec4 n) {
  vec4 P = uGLay[int(L)];
  vec2 uv = m / P.x, gx = dFdx(uv), gy = dFdy(uv);
  float k = rNoise(m.y / 23.0 + L * 3.1) * 5.0, i = floor(k), f = fract(k);
  vec2 o1 = rHash2(i + L * 17.0) * 9.17, o2 = rHash2(i + 1.0 + L * 17.0) * 9.17;
  vec4 a1 = textureGrad(uGAlb, vec3(uv + o1, L), gx, gy), a2 = textureGrad(uGAlb, vec3(uv + o2, L), gx, gy);
  vec4 n1 = textureGrad(uGNrm, vec3(uv + o1, L), gx, gy), n2 = textureGrad(uGNrm, vec3(uv + o2, L), gx, gy);
  float w = smoothstep(0.3, 0.7, f + 0.1 * dot(a1.rgb - a2.rgb, vec3(1.0)));
  a = mix(a1, a2, w); n = mix(n1, n2, w);
}
float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

export function createRoad(ctx) {
  const { scene, world, prepareMaterial } = ctx;
  const path = world.path;
  const W = path.width;
  const aniso = Math.min(16, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
  const group = new THREE.Group();
  group.name = 'road';
  scene.add(group);
  const disposables = [];

  /* ------------------------------------------------------------ surfaceAt */
  function surfaceAt(s, lateral) {
    const a = Math.abs(lateral);
    if (a <= W / 2) return 'asphalt';
    if (PAD.side * lateral > 0 && s >= PAD.s0 + 3 && s <= PAD.s1 - 3 && a <= 9.0) return 'asphalt';
    return 'gravel';
  }
  path.surfaceAt = surfaceAt;

  /* -------------------------------------------------------------- asphalt */
  const R = buildRoad(world);
  const lines = streetLines(world);
  buildStreet(world, R.acc, lines.main, 6.2, R.F[R.F.length - 1]);      // continues the road end into town
  buildStreet(world, R.acc, lines.west, 5.6, null, 0, 0.012);
  buildStreet(world, R.acc, lines.shore, 5.6, null, 0, 0.018);
  const asphaltGeo = R.acc.toGeometry();
  const tx = asphaltTextures(aniso);
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: tx.map, roughnessMap: tx.roughnessMap, roughness: 1, metalness: 0,
    color: new THREE.Color(1.04, 1.0, 0.96),
  });
  asphaltMat.polygonOffset = true; asphaltMat.polygonOffsetFactor = -1; asphaltMat.polygonOffsetUnits = -1;
  const GU = groundUniforms();
  addShaderPatch(asphaltMat, 'asphaltGrain', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GRAIN_VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GRAIN_FRAG_PARS)
      .replace('#include <map_fragment>', `
      vec2 rPN = vec2(0.0); float rPR = 1.0;
      #ifdef USE_MAP
      if (uPhoto > 0.5) {
        // procedural map, blurred: keeps wheel tracks, patches, stains and the dusty edges;
        // the photo scan supplies the aggregate, cracks and micro relief
        vec3 procC = texture(map, vMapUv, 3.0).rgb;
        vec2 rm = vec2((vMapUv.x - 0.5) * ${TEX_W.toFixed(2)}, vMapUv.y * ${TEX_V.toFixed(2)});
        vec4 aA, nA, aG, nG;
        roadTap(6.0, rm, aA, nA);
        float edge = smoothstep(3.55, 3.95, abs(rm.x));
        vec3 det = aA.rgb / max(uGMean[6].rgb, vec3(0.004));
        vec2 nb = nA.xy * 2.0 - 1.0;
        float rr = nA.z / max(uGMean[6].w, 0.05);
        if (edge > 0.0) {
          roadTap(7.0, rm, aG, nG);
          det = mix(det, aG.rgb / max(uGMean[7].rgb, vec3(0.004)), edge);
          nb = mix(nb, nG.xy * 2.0 - 1.0, edge);
          rr = mix(rr, max(nG.z / max(uGMean[7].w, 0.05), 1.1), edge);
        }
        float gd = length(vGrainPos - cameraPosition);
        det = mix(vec3(1.0), det, 1.0 - 0.6 * smoothstep(40.0, 250.0, gd));
        diffuseColor.rgb *= procC * det;
        rPN = nb * mix(uGLay[6].z, uGLay[7].z * 0.4, edge) * (1.0 - smoothstep(30.0, 120.0, gd));
        rPR = mix(1.0, rr, 0.7);
      } else
      #endif
      {
        #include <map_fragment>
        float gd = length(vGrainPos - cameraPosition);
        float fade = 1.0 - smoothstep(6.0, 60.0, gd);
        float g1 = gHash(floor(vGrainPos.xz * 110.0));
        float g2 = gHash(floor(vGrainPos.xz * 31.0 + 17.0));
        float speck = step(0.985, gHash(floor(vGrainPos.xz * 190.0 + 5.0)));
        diffuseColor.rgb *= 1.0 + fade * ((g1 - 0.5) * 0.30 + (g2 - 0.5) * 0.16 + speck * 0.35);
      }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>' + String.fromCharCode(10) + 'roughnessFactor = clamp(roughnessFactor * rPR, 0.04, 1.0);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      if (uPhoto > 0.5) {
        // tangent frame from the road uv (u = lateral, v = along); bump = -grad(height) in uv
        vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
        vec2 st0 = dFdx(vMapUv), st1 = dFdy(vMapUv);
        vec3 N0 = normal;
        vec3 q1p = cross(q1, N0), q0p = cross(N0, q0);
        vec3 T = q1p * st0.x + q0p * st1.x, B = q1p * st0.y + q0p * st1.y;
        float det2 = max(dot(T, T), dot(B, B));
        float sc = det2 == 0.0 ? 0.0 : inversesqrt(det2);
        normal = normalize(N0 + (T * rPN.x + B * rPN.y) * sc * 0.9);
      }`);
    Object.assign(shader.uniforms, { uGAlb: GU.uGAlb, uGNrm: GU.uGNrm, uGLay: GU.uGLay, uGMean: GU.uGMean, uPhoto: GU.uPhoto });
  });
  prepareMaterial(asphaltMat);
  const asphalt = new THREE.Mesh(asphaltGeo, asphaltMat);
  asphalt.name = 'asphalt';
  asphalt.receiveShadow = true;
  asphalt.frustumCulled = false;   // one long strip, always cheap
  group.add(asphalt);
  disposables.push(asphaltGeo, asphaltMat, tx.map, tx.roughnessMap);

  /* ------------------------------------------------------------ markings */
  const markGeo = buildMarkings(world, R.F, W);
  const wear = markingWearTexture();
  const markMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: wear, alphaTest: 0.5, roughness: 0.72, metalness: 0 });
  markMat.polygonOffset = true; markMat.polygonOffsetFactor = -3; markMat.polygonOffsetUnits = -3;
  prepareMaterial(markMat);
  const marks = new THREE.Mesh(markGeo, markMat);
  marks.name = 'markings'; marks.receiveShadow = true; marks.frustumCulled = false;
  group.add(marks);
  disposables.push(markGeo, markMat, wear);

  /* ----------------------------------------------------------- roadside kit */
  const groups = guardrailPlan(world, R.F, W);
  const rails = railSegments(R.F, groups, W);
  const dels = delineatorPlan(world, R.F, W, groups);
  const signs = signPlan(world, R.F, W);

  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
  const basis = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);

  // delineators: white post, black band, yellow reflective head (instanced)
  const delGeo = delineatorGeometry();
  const delMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, emissive: new THREE.Color(0.9, 0.75, 0.3), emissiveIntensity: 0.05 });
  prepareMaterial(delMat);
  const delMesh = new THREE.InstancedMesh(delGeo, delMat, Math.max(1, dels.length));
  dels.forEach((d, i) => {
    m4.compose(pos.set(d.x, d.y, d.z), q.identity(), sc.set(1, 1, 1));
    delMesh.setMatrixAt(i, m4);
  });
  delMesh.count = dels.length; delMesh.instanceMatrix.needsUpdate = true;
  delMesh.castShadow = true; delMesh.name = 'delineators';
  group.add(delMesh);
  disposables.push(delGeo, delMat);

  // guard rails: W-beam segments + posts (instanced)
  const beamGeo = railBeamGeometry(), postGeo = railPostGeometry();
  const beamMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.55, side: THREE.DoubleSide });
  const postMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.5 });
  prepareMaterial(beamMat); prepareMaterial(postMat);
  const nSeg = rails.segs.length;
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, Math.max(1, nSeg));
  const posts = new THREE.InstancedMesh(postGeo, postMat, Math.max(1, nSeg * 2));
  let np = 0;
  const frame = (a, b, len, sz) => {
    Z.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    X.crossVectors(UPV, Z).normalize();
    Y.crossVectors(Z, X);
    basis.makeBasis(X, Y, Z);
    m4.copy(basis).setPosition(a[0], a[1], a[2]);
    if (sz !== 1) m4.multiply(new THREE.Matrix4().makeScale(1, 1, sz));
    return m4;
  };
  rails.segs.forEach((sg, i) => {
    const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1], sg.b[2] - sg.a[2]);
    beams.setMatrixAt(i, frame(sg.a, sg.b, len, len));
    posts.setMatrixAt(np++, frame(sg.a, sg.b, len, 1));
    if (sg.last) {
      const d = [sg.b[0] + (sg.b[0] - sg.a[0]), sg.b[1] + (sg.b[1] - sg.a[1]), sg.b[2] + (sg.b[2] - sg.a[2])];
      posts.setMatrixAt(np++, frame(sg.b, d, 1, 1));
    }
  });
  beams.count = nSeg; posts.count = np;
  beams.instanceMatrix.needsUpdate = posts.instanceMatrix.needsUpdate = true;
  beams.castShadow = posts.castShadow = true;
  beams.name = 'guardrail'; posts.name = 'guardrailPosts';
  group.add(beams, posts);
  disposables.push(beamGeo, postGeo, beamMat, postMat);

  // road signs: canvas painted atlas
  const L = path.length;
  const atlas = signAtlas({ placeKm: Math.max(0.1, (L - signs.find((s) => s.key === 'place').s) / 1000), endKm: Math.max(0.1, (L - signs.find((s) => s.key === 'placeEnd').s) / 1000) });
  const panels = buildSignPanels(signs);
  const signMat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, roughness: 0.45, metalness: 0, side: THREE.DoubleSide, emissive: new THREE.Color(1, 1, 1), emissiveMap: atlas, emissiveIntensity: 0.06 });
  prepareMaterial(signMat);
  const signMesh = new THREE.Mesh(panels.geometry, signMat);
  signMesh.castShadow = true; signMesh.name = 'signs';
  group.add(signMesh);
  const poleGeo = new THREE.CylinderGeometry(0.045, 0.05, 1, 6, 1, true);
  poleGeo.translate(0, 0.5, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.32, 0.34, 0.36), roughness: 0.5, metalness: 0.6 });
  prepareMaterial(poleMat);
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, panels.poles.length);
  panels.poles.forEach((p, i) => {
    m4.compose(pos.set(p.x, p.y, p.z), q.identity(), sc.set(1, p.h, 1));
    poleMesh.setMatrixAt(i, m4);
  });
  poleMesh.instanceMatrix.needsUpdate = true; poleMesh.castShadow = true; poleMesh.name = 'signPoles';
  group.add(poleMesh);
  disposables.push(panels.geometry, signMat, atlas, poleGeo, poleMat);

  // expose stats for debugging
  ctx.roadStats = { guardrailSegments: nSeg, delineators: dels.length, signs: signs.length, triangles: (asphaltGeo.index.count + markGeo.index.count) / 3 };

  const infra = createInfrastructure(ctx);

  return {
    surfaceAt,
    update(dt, t) { infra.update(dt, t); },
    dispose() {
      infra.dispose();
      group.removeFromParent();
      disposables.forEach((d) => d.dispose?.());
    },
  };
}
