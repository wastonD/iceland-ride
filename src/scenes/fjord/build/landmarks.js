// Farm (turf houses, barn, walls, fences, hay bales) and the lighthouse. Created from village.js.
import * as THREE from 'three';
import { buildFarm, stoneWall, fencePlan, balePlan, baleGeometry } from './farmGeo.js';
import { buildLighthouse, beamGeometry } from './lighthouseGeo.js';
import { stoneTexture, turfTexture, boardsTexture } from './textures2.js';
import { corrugationTextures, woodTexture } from './textures.js';

const LEVEL = { day: 0, dusk: 0.55, night: 1 };

export function createLandmarks(ctx) {
  const { scene, world, prepareMaterial, state } = ctx;
  const aniso = Math.min(16, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
  const group = new THREE.Group(); group.name = 'landmarks'; scene.add(group);
  const dispose = [];
  const keep = (...o) => { dispose.push(...o); return o[0]; };
  const mesh = (geo, mat, name, cast = true, recv = true) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.castShadow = cast; m.receiveShadow = recv; group.add(m); keep(geo); return m; };

  /* ------------------------------------------------------------------ farm */
  const farm = buildFarm(world);
  const Fm = world.features.farm, Pz = world.features.pasture;
  const roadPts = world.path.points.filter((p) => p.z > 150 && p.z < 720);
  const farFromRoad = (x, z) => { for (const p of roadPts) if (Math.hypot(p.x - x, p.z - z) < 10) return false; return true; };

  // dry-stone walls: pasture west boundary (facing the road) and the farmyard enclosure
  const st = farm.m.stone;
  st.setPlace(0, 0, 0, 0);
  const line = (x0, z0, x1, z1, step = 2) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / step)); return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]); };
  stoneWall(world, st, line(Pz.x0, Pz.z0, Pz.x0, Pz.z1), farFromRoad);
  const yard = [...line(Fm.x - 46, Fm.z + 32, Fm.x - 46, Fm.z - 24), ...line(Fm.x - 46, Fm.z - 24, Fm.x + 32, Fm.z - 24).slice(1), ...line(Fm.x + 32, Fm.z - 24, Fm.x + 32, Fm.z + 32).slice(1)];
  stoneWall(world, st, yard);

  const stnTex = stoneTexture(), turfTex = turfTexture(), boards = boardsTexture(), wood = woodTexture(), corr = corrugationTextures();
  [stnTex, turfTex, boards, wood, corr.map, corr.normalMap].forEach((t) => (t.anisotropy = aniso));
  keep(stnTex, turfTex, boards, wood, corr.map, corr.normalMap);
  const mk = (p) => { const m = new THREE.MeshStandardMaterial(p); prepareMaterial(m); keep(m); return m; };
  const turfMat = mk({ vertexColors: true, map: turfTex, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const woodMat = mk({ vertexColors: true, map: boards, roughness: 0.8, metalness: 0 });
  const stoneMat = mk({ vertexColors: true, map: stnTex, roughness: 0.97, metalness: 0, side: THREE.DoubleSide });
  const barnMat = mk({ vertexColors: true, map: corr.map, normalMap: corr.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.5, metalness: 0.12 });
  mesh(farm.m.turf.toGeometry(), turfMat, 'farmTurf');
  mesh(farm.m.wood.toGeometry(), woodMat, 'farmTimber');
  mesh(farm.m.barn.toGeometry(), barnMat, 'farmBarn');
  mesh(st.toGeometry(), stoneMat, 'farmStone');

  // timber fences along the other pasture edges (posts + two rails), skipping the road side / water
  const edges = [line(Pz.x0, Pz.z0, Pz.x1, Pz.z0, 3), line(Pz.x1, Pz.z0, Pz.x1, Pz.z1, 3), line(Pz.x1, Pz.z1, Pz.x0, Pz.z1, 3)];
  const posts = [], rails = [];
  for (const e of edges) { const f = fencePlan(world, e, farFromRoad); posts.push(...f.posts); rails.push(...f.rails); }
  const postGeo = new THREE.BoxGeometry(0.11, 1.25, 0.11); postGeo.translate(0, 0.45, 0);
  const railGeo = new THREE.BoxGeometry(0.06, 0.1, 1); railGeo.translate(0, 0, 0.5);
  const fenceMat = mk({ color: new THREE.Color(0.7, 0.62, 0.52), map: wood, roughness: 0.9 });
  const postMesh = new THREE.InstancedMesh(postGeo, fenceMat, Math.max(1, posts.length));
  const railMesh = new THREE.InstancedMesh(railGeo, fenceMat, Math.max(1, rails.length));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
  posts.forEach((p, i) => { m4.compose(pos.set(p.x, p.y, p.z), q.identity(), sc.set(1, 1, 1)); postMesh.setMatrixAt(i, m4); });
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), bas = new THREE.Matrix4();
  rails.forEach((r, i) => {
    Z.set(r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]); const len = Z.length(); Z.normalize();
    X.crossVectors(UP, Z).normalize(); Y.crossVectors(Z, X);
    bas.makeBasis(X, Y, Z).setPosition(r.a[0], r.a[1], r.a[2]).multiply(new THREE.Matrix4().makeScale(1, 1, len));
    railMesh.setMatrixAt(i, bas);
  });
  postMesh.count = posts.length; railMesh.count = rails.length;
  postMesh.instanceMatrix.needsUpdate = railMesh.instanceMatrix.needsUpdate = true;
  postMesh.castShadow = railMesh.castShadow = true; postMesh.name = 'fencePosts'; railMesh.name = 'fenceRails';
  group.add(postMesh, railMesh); keep(postGeo, railGeo);

  // white plastic-wrapped hay bales
  const bales = balePlan(world);
  const baleGeo = baleGeometry();
  const baleMat = mk({ color: new THREE.Color(0.93, 0.95, 0.98), roughness: 0.3, metalness: 0 });
  const baleMesh = new THREE.InstancedMesh(baleGeo, baleMat, Math.max(1, bales.length));
  const qq = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
  bales.forEach((b, i) => { qq.setFromAxisAngle(yAxis, b.yaw); m4.compose(pos.set(b.x, b.y, b.z), qq, sc.set(1, 1, 1)); baleMesh.setMatrixAt(i, m4); });
  baleMesh.count = bales.length; baleMesh.instanceMatrix.needsUpdate = true; baleMesh.castShadow = true; baleMesh.receiveShadow = true; baleMesh.name = 'hayBales';
  group.add(baleMesh); keep(baleGeo);

  /* ------------------------------------------------------------- lighthouse */
  const LHs = buildLighthouse(world);
  const whiteMat = mk({ vertexColors: true, roughness: 0.6, metalness: 0.02 });
  mesh(LHs.tower, whiteMat, 'lighthouse');
  const glassMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.9, 0.95, 1.0), emissive: new THREE.Color(1.0, 0.86, 0.55), emissiveIntensity: 0.15, roughness: 0.1, transparent: true, opacity: 0.9 });
  prepareMaterial(glassMat, { wet: false }); keep(glassMat);
  mesh(LHs.glass, glassMat, 'lanternGlass', false, false);
  const beamGeo = beamGeometry(230, 9);
  const beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(1.0, 0.9, 0.62), opacity: 0 });
  prepareMaterial(beamMat); keep(beamMat, beamGeo);
  const beam = new THREE.Mesh(beamGeo, beamMat); beam.name = 'lighthouseBeam'; beam.frustumCulled = false; beam.renderOrder = 3;
  beam.position.set(LHs.site.x, LHs.lanternY, LHs.site.z);
  group.add(beam);

  ctx.landmarkStats = { bales: bales.length, fencePosts: posts.length, fenceRails: rails.length, farmBuildings: farm.items.length };
  let level = 0;
  return {
    update(dt, t) {
      const target = LEVEL[state.get('timeOfDay')] ?? 0;
      level += (target - level) * (1 - Math.exp(-dt * 1.2));
      glassMat.emissiveIntensity = 0.15 + level * 7;
      beamMat.opacity = level * 0.42;
      beam.visible = level > 0.01;
      beam.rotation.y = t * 0.6;
    },
    dispose() { group.removeFromParent(); dispose.forEach((d) => d.dispose?.()); },
  };
}
