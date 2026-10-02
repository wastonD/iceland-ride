// Vegetation materials: wind sway, rain taps, leaf back-light translucency.
// All shader edits go through addShaderPatch so they compose with fog/wetness.

import * as THREE from 'three';
import { addShaderPatch } from '../../render/shaderPatch.js';

// Per-vertex attribute aWind (vec4):
//   x = bend amplitude (m) — whole-plant sway, 0 at the base
//   y = flutter amplitude (m) — leaf-level motion along the normal
//   z = object phase (0..1) — per plant (merged meshes) / per variant
//   w = leaf phase (0..1) — per leaf
const WIND_VERT = /* glsl */ `
{
  vec3 wOrigin;
  float wS = 1.0;
  mat3 wToLocal = mat3(1.0);
  #ifdef USE_INSTANCING
    wOrigin = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    mat3 wIm = mat3(instanceMatrix);
    wS = length(wIm[0]);
    wToLocal = transpose(wIm) / (wS * wS);
  #else
    wOrigin = vec3(0.0);
  #endif
  float wHash = fract(sin(dot(wOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453);
  float wPh = (aWind.z + wHash) * 6.2831853;
  float wLp = (aWind.w + wHash) * 6.2831853;
  vec2 wD = normalize(uWind.xz + vec2(1e-5));
  float wStr = uWindStrength;
  vec3 wP = (modelMatrix * vec4(position, 1.0)).xyz;
  #ifdef USE_INSTANCING
    wP = wOrigin;
  #endif
  // travelling gust field
  float wGust = 0.55 + 0.45 * sin(dot(wP.xz, wD) * 0.045 - uTime * 0.7 + wPh * 0.15);
  float wSway = (0.45 + 0.55 * sin(uTime * 0.9 + wPh) + 0.25 * sin(uTime * 2.1 + wPh * 1.7)) * wStr * wGust;
  vec3 wDisp = vec3(wD.x, 0.0, wD.y) * wSway * aWind.x;
  wDisp.xz += vec2(-wD.y, wD.x) * sin(uTime * 1.3 + wPh * 2.3) * 0.35 * wStr * aWind.x;
  // leaf flutter + rain taps (sharp impulses pushing leaf tips down)
  float wFl = sin(uTime * (5.0 + 3.0 * aWind.w) + wLp) * (0.15 + wStr * wGust)
            + sin(uTime * 11.0 + wLp * 3.0) * 0.25 * wStr;
  float wTap = pow(max(0.0, sin(uTime * (2.3 + aWind.w * 2.1) + wLp * 5.0)), 30.0) * uRain * 3.0;
  wDisp.y -= wTap * aWind.y;
  vec3 wLocal = wToLocal * (wDisp * wS);
  wLocal += normal * aWind.y * (wFl * (1.0 + uRain * 0.8) + wTap * 0.5);
  transformed += wLocal;
}
`;

export function windPatch(U) {
  return (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.uniforms.uRain = U.uRain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aWind;
uniform float uTime; uniform vec3 uWind; uniform float uWindStrength; uniform float uRain;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERT);
  };
}

// Thin-leaf translucency: light arriving from behind the leaf (relative to the
// viewer) scatters through as a warmer yellow-green. Uses the shadowed
// directLight, so leaves in shade don't glow.
const TRANS_PARS = /* glsl */ `
uniform float uLeafTrans;
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 specBefore = reflectedLight.directSpecular;
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  // Grazing sun glints on wet leaves (Fresnel -> 1) turned whole blades white:
  // scale leaf sun specular down and cap its luminance.
  vec3 dSpec = ( reflectedLight.directSpecular - specBefore ) * uSpecScale;
  float sLum = dot( dSpec, vec3( 0.2126, 0.7152, 0.0722 ) );
  dSpec *= min( 1.0, uSpecMax / max( sLum, 1e-5 ) );
  reflectedLight.directSpecular = specBefore + dSpec;
  float back = saturate( -dot( geometryNormal, directLight.direction ) );
  float vl = saturate( dot( -geometryViewDir, directLight.direction ) );
  float tr = back * 0.5 + pow( vl, 6.0 ) * 0.4;
  vec3 tint = material.diffuseColor * vec3( 1.1, 1.35, 0.45 ) + vec3( 0.002, 0.004, 0.0 );
  reflectedLight.directDiffuse += directLight.color * tint * tr * uLeafTrans * RECIPROCAL_PI;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`;

export function translucencyPatch(U) {
  return (shader) => {
    shader.uniforms.uLeafTrans = U.uLeafTrans;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_pars_fragment>',
      '#include <lights_physical_pars_fragment>\n' + TRANS_PARS,
    );
  };
}

// Keep alpha-tested coverage stable in lower mips (atlas is 2048²).
function alphaMipPatch(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <alphamap_fragment>',
    `#ifdef USE_ALPHAMAP
    {
      float aM = texture2D( alphaMap, vAlphaMapUv ).g;
      vec2 aDx = dFdx( vAlphaMapUv * 2048.0 ), aDy = dFdy( vAlphaMapUv * 2048.0 );
      float aMip = max( 0.0, 0.5 * log2( max( dot( aDx, aDx ), dot( aDy, aDy ) ) ) );
      diffuseColor.a *= aM * ( 1.0 + aMip * 0.25 );
    }
    #endif`,
  );
}

// Foliage cards with bent (crown-radial) normals: don't flip on back faces.
function noFlipPatch(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
    {
      // keep bent normals in the viewer's hemisphere (else grazing Fresnel → white cards)
      vec3 fvd = normalize( vViewPosition );
      float fnd = dot( normal, fvd );
      if ( fnd < 0.35 ) normal = normalize( normal + fvd * ( 0.35 - fnd ) );
    }`,
  );
}

export function createVegMaterials(ctx, tex) {
  const U = ctx.uniforms;
  const vegU = { uLeafTrans: { value: 1.0 } };
  const wind = windPatch(U);
  const trans = translucencyPatch(vegU);

  const depthFor = (mat) => {
    const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (mat.userData.windy) addShaderPatch(d, 'vegwind', wind);
    return d;
  };

  const leaf = (opts, { bent = false, bump = true } = {}) => {
    const m = new THREE.MeshStandardMaterial({
      map: tex.atlas.map,
      alphaMap: tex.atlas.alphaMap,
      bumpMap: bump ? tex.atlas.map : null,
      bumpScale: 1.5,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      vertexColors: true,
      roughness: 0.55,
      metalness: 0,
      envMapIntensity: 0.8,
      ...opts,
    });
    m.alphaToCoverage = true;
    m.userData.windy = true;
    const minRough = { value: bent ? 0.55 : 0.4 };
    const specScale = { value: bent ? 0.25 : 0.5 };
    const specMax = { value: bent ? 0.03 : 0.06 };
    addShaderPatch(m, 'vegwind', wind);
    addShaderPatch(m, 'minrough', (shader) => {
      // applied after the wetness patch: bent-normal cards must never turn mirror-like
      shader.uniforms.uMinRough = minRough;
      shader.uniforms.uSpecScale = specScale;
      shader.uniforms.uSpecMax = specMax;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uMinRough;\nuniform float uSpecScale;\nuniform float uSpecMax;')
        .replace('#include <lights_fragment_begin>', 'material.roughness = max( material.roughness, uMinRough );\n#include <lights_fragment_begin>');
    });
    addShaderPatch(m, 'alphamip', alphaMipPatch);
    addShaderPatch(m, 'leaftrans', trans);
    if (bent) addShaderPatch(m, 'noflip', noFlipPatch);
    ctx.prepareMaterial(m);
    return m;
  };

  const bark = (t, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.1, 1.1),
      vertexColors: true, roughness: 0.85, metalness: 0, ...opts,
    });
    m.userData.windy = true;
    addShaderPatch(m, 'vegwind', wind);
    ctx.prepareMaterial(m);
    return m;
  };

  const mats = {
    broadleaf: leaf({}),                                      // big understory leaves: true normals
    foliage: leaf({ roughness: 0.66, envMapIntensity: 0.5 }, { bent: true, bump: false }), // crown cards (bent normals)
    barkEmergent: bark(tex.barkEmergent),
    barkMid: bark(tex.barkMid),
    barkPalm: bark(tex.barkPalm),
    barkFern: bark(tex.barkFern, { roughness: 0.95 }),
    liana: (() => {
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
      m.userData.windy = true;
      addShaderPatch(m, 'vegwind', wind);
      ctx.prepareMaterial(m);
      return m;
    })(),
  };
  mats.depthFor = depthFor;
  mats.vegU = vegU;
  return mats;
}
