// Fjord village: corrugated-iron houses, the blue church, rainbow path, wooden pier,
// street lamps and a fishing boat. Everything is merged / instanced (few draw calls).
import * as THREE from 'three';
import { MeshBuilder } from './build/builder.js';
import { computeVillage, PIER } from './build/villageLayout.js';
import {
  Decals, buildHouse, buildChurch, buildRainbow, buildPier, buildBoat, deckY,
  lampPoleGeometry, lampHeadGeometry,
} from './build/houseGeo.js';
import { corrugationTextures, windowAtlas, woodTexture, paintTexture } from './build/textures.js';
import { createLandmarks } from './build/landmarks.js';

const LAMP_H = 5.2;
// emissive level by time of day: [windows, lamps]
const NIGHT_LEVEL = { day: [0, 0.25], dusk: [1.2, 2.4], night: [2.4, 5.5] };

export function createVillage(ctx) {
  const { scene, world, prepareMaterial, state } = ctx;
  const aniso = Math.min(16, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
  const V = computeVillage(world);
  const group = new THREE.Group();
  group.name = 'village';
  scene.add(group);
  const disposables = [];
  const track = (...o) => { disposables.push(...o); return o[0]; };

  /* ---------------------------------------------------------- houses + church */
  const walls = new MeshBuilder(), decals = new Decals();
  for (const H of V.houses) buildHouse(walls, decals, H);

  // church footprint (nave + apse + tower) on the terrace
  const ch = V.church;
  {
    const c = Math.cos(ch.yaw), s = Math.sin(ch.yaw), hs = [];
    for (const [lx, lz] of [[-4, -8.5], [4, -8.5], [4, 9.2], [-4, 9.2], [0, 0]]) hs.push(world.heightAt(ch.x + lx * c + lz * s, ch.z - lx * s + lz * c));
    ch.floorY = Math.max(...hs) + 0.2; ch.baseY = Math.min(...hs) - 0.3;
  }
  buildChurch(walls, decals, ch);

  const corr = corrugationTextures();
  const wallMat = new THREE.MeshStandardMaterial({
    vertexColors: true, map: corr.map, normalMap: corr.normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.5, metalness: 0.12,
  });
  prepareMaterial(wallMat);
  const wallGeo = walls.toGeometry();
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.name = 'houses'; wallMesh.castShadow = true; wallMesh.receiveShadow = true;
  group.add(wallMesh);
  track(wallGeo, wallMat, corr.map, corr.normalMap);

  const atlas = windowAtlas();
  const winMat = new THREE.MeshStandardMaterial({
    map: atlas.map, emissiveMap: atlas.emissiveMap, emissive: new THREE.Color(1.0, 0.72, 0.38), emissiveIntensity: 0,
    roughness: 0.32, metalness: 0,
  });
  winMat.polygonOffset = true; winMat.polygonOffsetFactor = -2; winMat.polygonOffsetUnits = -2;
  prepareMaterial(winMat, { wet: false });
  const winGeo = decals.mb.toGeometry();
  const winMesh = new THREE.Mesh(winGeo, winMat);
  winMesh.name = 'windows'; winMesh.receiveShadow = true;
  group.add(winMesh);
  track(winGeo, winMat, atlas.map, atlas.emissiveMap);

  /* ------------------------------------------------------------ rainbow path */
  const paint = paintTexture();
  const rbGeo = buildRainbow(world, V.rainbow, 3.2);
  const rbMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: paint, roughness: 0.78, metalness: 0 });
  rbMat.polygonOffset = true; rbMat.polygonOffsetFactor = -4; rbMat.polygonOffsetUnits = -4;
  prepareMaterial(rbMat);
  const rainbow = new THREE.Mesh(rbGeo, rbMat);
  rainbow.name = 'rainbowPath'; rainbow.receiveShadow = true;
  group.add(rainbow);
  track(rbGeo, rbMat, paint);

  /* -------------------------------------------------------------------- pier */
  const wood = woodTexture();
  const pier = buildPier(world, PIER);
  const pierMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: wood, roughness: 0.88, metalness: 0 });
  prepareMaterial(pierMat);
  const pierMesh = new THREE.Mesh(pier.geometry, pierMat);
  pierMesh.name = 'pier'; pierMesh.castShadow = true; pierMesh.receiveShadow = true;
  group.add(pierMesh);
  track(pier.geometry, pierMat, wood);

  const pileGeo = new THREE.CylinderGeometry(0.2, 0.24, 1, 7, 1, true);
  pileGeo.translate(0, 0.5, 0);
  const pileMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.11, 0.085, 0.065), roughness: 0.95 });
  prepareMaterial(pileMat);
  const piles = new THREE.InstancedMesh(pileGeo, pileMat, Math.max(1, pier.piles.length));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  pier.piles.forEach((p, i) => { m4.compose(pos.set(p.x, p.y, p.z), q, sc.set(1, p.h, 1)); piles.setMatrixAt(i, m4); });
  piles.count = pier.piles.length; piles.instanceMatrix.needsUpdate = true; piles.castShadow = true; piles.name = 'pierPiles';
  group.add(piles);
  track(pileGeo, pileMat);

  /* -------------------------------------------------------------------- boat */
  const boatGeo = buildBoat();
  const boatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  prepareMaterial(boatMat);
  const boat = new THREE.Mesh(boatGeo, boatMat);
  boat.name = 'boat'; boat.castShadow = true; boat.receiveShadow = true;
  const BOAT = { x: PIER.x - 4.4, y: 0.02, z: 1031 };
  boat.position.set(BOAT.x, BOAT.y, BOAT.z);
  group.add(boat);
  track(boatGeo, boatMat);

  /* -------------------------------------------------------------------- lamps */
  const lamps = V.lamps.map((l) => {
    const dx = l.side * l.tz, dz = -l.side * l.tx;               // toward the street
    return { x: l.x, z: l.z, y: world.heightAt(l.x, l.z), hx: l.x + dx * 0.42, hz: l.z + dz * 0.42 };
  });
  for (const z of [1000, 1027]) {
    const x = PIER.x - PIER.width / 2 + 0.06;
    lamps.push({ x, z, y: deckY(z), hx: x + 0.3, hz: z });
  }
  lamps.push({ x: PIER.x - 3.6, z: PIER.z1 + 3.8, y: deckY(PIER.z1), hx: PIER.x - 3.2, hz: PIER.z1 + 3.8 });
  const poleGeo = lampPoleGeometry(), headGeo = lampHeadGeometry();
  const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.4 });
  prepareMaterial(poleMat);
  const headMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(1.0, 0.9, 0.7), emissive: new THREE.Color(1.0, 0.7, 0.34), emissiveIntensity: 0.25, roughness: 0.4 });
  prepareMaterial(headMat, { wet: false });
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, lamps.length);
  lamps.forEach((l, i) => {
    m4.compose(pos.set(l.x, l.y - 0.1, l.z), q, sc.set(1, LAMP_H + 0.1, 1)); poleMesh.setMatrixAt(i, m4);
    m4.compose(pos.set(l.hx, l.y + LAMP_H + 0.1, l.hz), q, sc.set(1, 1.15, 1)); headMesh.setMatrixAt(i, m4);
  });
  poleMesh.instanceMatrix.needsUpdate = headMesh.instanceMatrix.needsUpdate = true;
  poleMesh.castShadow = true; poleMesh.name = 'lampPoles'; headMesh.name = 'lampHeads';
  group.add(poleMesh, headMesh);
  track(poleGeo, headGeo, poleMat, headMat);

  ctx.villageStats = { houses: V.houses.length, lamps: lamps.length, triangles: (wallGeo.index.count + winGeo.index.count + rbGeo.index.count + pier.geometry.index.count + boatGeo.index.count) / 3 };

  const landmarks = createLandmarks(ctx);

  /* ------------------------------------------------------------------- update */
  let winLevel = 0, lampLevel = 0.25;
  return {
    update(dt, t) {
      landmarks.update(dt, t);
      const lv = NIGHT_LEVEL[state.get('timeOfDay')] || NIGHT_LEVEL.day;
      const k = 1 - Math.exp(-dt * 1.5);
      winLevel += (lv[0] - winLevel) * k; lampLevel += (lv[1] - lampLevel) * k;
      winMat.emissiveIntensity = winLevel;
      headMat.emissiveIntensity = lampLevel;
      boat.position.y = BOAT.y + Math.sin(t * 1.1) * 0.035;
      boat.rotation.z = Math.sin(t * 0.9) * 0.02;
      boat.rotation.x = Math.sin(t * 0.7 + 1) * 0.012;
    },
    dispose() {
      landmarks.dispose();
      group.removeFromParent();
      disposables.forEach((d) => d.dispose?.());
    },
  };
}
