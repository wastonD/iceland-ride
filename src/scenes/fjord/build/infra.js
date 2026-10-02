// Runtime (DOM/material) side of the tunnel and the steel bridge. Created from road.js.
import * as THREE from 'three';
import { buildTunnel } from './tunnelGeo.js';
import { createKaleidoMaterials } from './kaleido.js';
import { buildBridge } from './bridgeGeo.js';
import { shotcreteTexture, stoneTexture } from './textures2.js';

export function createInfrastructure(ctx) {
  const { scene, world, prepareMaterial } = ctx;
  const aniso = Math.min(16, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
  const group = new THREE.Group(); group.name = 'roadInfra';
  scene.add(group);
  const dispose = [];
  const keep = (...o) => { dispose.push(...o); return o[0]; };

  const conc = shotcreteTexture(), stn = stoneTexture(); conc.anisotropy = stn.anisotropy = aniso;
  const concMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: conc, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4 });
  const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: stn, roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
  const steelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.35 });
  prepareMaterial(concMat); prepareMaterial(stoneMat); prepareMaterial(steelMat);
  keep(conc, stn, concMat, stoneMat, steelMat);

  const add = (geo, mat, name, cast = true) => {
    const m = new THREE.Mesh(geo, mat); m.name = name; m.castShadow = cast; m.receiveShadow = true; group.add(m); keep(geo); return m;
  };

  /* ---------------------------------------------------------------- tunnel */
  const T = buildTunnel(world);
  const K = createKaleidoMaterials(T.length);
  keep(K.wall, K.road);
  const inner = new THREE.Mesh(T.inner, K.wall); inner.name = 'tunnelKaleidoscope'; inner.frustumCulled = false; group.add(inner); keep(T.inner);
  add(T.outer, concMat, 'tunnelShell');                      // buried shell: casts the tunnel's shadow, dark rock at the mouths
  add(T.rocks, stoneMat, 'tunnelMouthRocks');
  const discMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.012, 0.016) });
  prepareMaterial(discMat); keep(discMat);
  const discs = new THREE.Mesh(T.discs, discMat); discs.name = 'tunnelMouthDark'; group.add(discs); keep(T.discs);
  const glow = new THREE.Mesh(T.glow, K.road); glow.name = 'tunnelRoadGlow'; glow.renderOrder = 2; glow.frustumCulled = false; group.add(glow); keep(T.glow);
  let flow = 0, rotA = 0, spd = 0;

  /* ----------------------------------------------------------------- bridge */
  const B = buildBridge(world);
  add(B.conc, concMat, 'bridgeDeck', false);   // slab sits 2 cm under the asphalt: as a shadow caster it darkened the road
  add(B.steel, steelMat, 'bridgeTruss');
  add(B.stone, stoneMat, 'bridgeAbutments');

  ctx.infraStats = { tunnel: { sE: T.plan.sE, sX: T.plan.sX }, bridge: { sa: B.sa, sb: B.sb } };
  return {
    update(dt, t) {
      // pattern flow + symmetry rotation follow the rider's speed
      const v = ctx.skate?.state?.speed ?? 0;
      spd += (Math.min(1, v / 22) - spd) * (1 - Math.exp(-dt * 2));
      flow += dt * (3 + v * 0.85);                  // features stream back toward the entrance
      rotA += dt * (0.05 + 0.02 * v);
      const U = K.uniforms;
      U.uTime.value = t; U.uFlow.value = flow; U.uRot.value = rotA; U.uSpeed.value = spd;
    },
    dispose() { group.removeFromParent(); dispose.forEach((d) => d.dispose?.()); },
  };
}
