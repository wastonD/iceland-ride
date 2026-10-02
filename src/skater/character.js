// Longboard rider: board + procedural skinned character, all animation driven by rideState.
//
//   const skater = createSkater(ctx);   // ctx needs { THREE?, prepareMaterial }
//   scene.add(skater.root);             // controller sets root.position / quaternion
//   skater.update(dt, rideState);
//
// root frame: origin = centre of the deck top, +Z = nose (travel), +Y = surface normal.
// The wheel contact patch is at root-local y = -skater.groundOffset (0.101 m).
// `lean` is applied INSIDE root (rotation about the wheel contact line) — the
// controller must not roll root by lean itself.
//
// Electric board: reads speed, lean, crouch, throttle, braking, wobble, airborne, airTime,
// landing, heading, fall {phase:'tumble'|'lie'|'getup', side, [pt]}. pushing/pushPhase are ignored.
// During a fall the human stays near the root origin (rolling / lying) while the BOARD flies
// ahead in root-local space (up to ~2.4 m + drift) and is fetched back during 'getup'.
// Phase clocks are kept internally (restart on every phase change); `fall.pt` overrides (tests).
//
// The body is SDF-modelled + surface-net meshed (body.js / sdf.js) — one smooth skinned
// mesh, one material (MeshPhysical: per-vertex roughness, soft cloth sheen).
// Sitting: ride.sitting (0..1 smooth blend, 1 = seated) + ride.sitMode ('board' | 'ground'),
//   see sit.js. Missing → 0. The controller should keep the board stopped while sitting.
// First person: skater.setFirstPerson(true) hides head/beanie/hair/collar/backpack+straps in the view
//   (shadow keeps the whole rider); skater.eye / skater.getEye(v[, q]) = camera anchor between the eyes.

import * as THREE from 'three';
import { mulberry32, smoothstep, clamp, lerp } from '../core/noise.js';
import { buildBoard, GROUND, WHEEL_R } from './board.js';
import { buildBodyGeometry, BONES, LEN, COLORS, BIND_ROT, EYE_OFFSET } from './body.js';
import { makePose, copyPose, blendPose, qEuler as qEul, shoulderPos } from './pose.js';
import { fallPose, fallWeight } from './fall.js';
import { createNitro } from './nitro.js';
import { sitPose } from './sit.js';
import { addShaderPatch } from '../render/shaderPatch.js';

const V3 = THREE.Vector3;
const Q = THREE.Quaternion;
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const X_AXIS = new V3(1, 0, 0);
const Z_AXIS = new V3(0, 0, 1);

const damp = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const qEuler = (out, pitch, yaw, roll = 0) => out.setFromEuler(_e.set(pitch, yaw, roll, 'ZYX')); // Rz*Ry*Rx

// Quaternion for a bone whose rest direction is -Y so that it points along `dir`, with +Z as close to `hint` as possible.
const _bx = new V3(), _by = new V3(), _bz = new V3();
function aimQ(out, dir, hint) {
  _by.copy(dir).negate();
  _bz.copy(hint).addScaledVector(_by, -hint.dot(_by));
  if (_bz.lengthSq() < 1e-6) {
    _bz.set(0, 0, 1).addScaledVector(_by, -_by.z);
    if (_bz.lengthSq() < 1e-6) _bz.set(1, 0, 0);
  }
  _bz.normalize();
  _bx.crossVectors(_by, _bz);
  _m.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_m);
}

export function createSkater(ctx) {
  const prep = ctx.prepareMaterial;

  // ---- scene graph ------------------------------------------------------
  const root = new THREE.Group();
  root.name = 'skater';
  const pivot = new THREE.Group();     // rotates by lean about the wheel contact line
  pivot.position.set(0, -GROUND, 0);
  const rig = new THREE.Group();       // board space (deck top = origin)
  rig.position.set(0, GROUND, 0);
  root.add(pivot);
  pivot.add(rig);

  const board = buildBoard(ctx);
  rig.add(board.group);
  const nitro = createNitro();
  board.group.add(nitro.group);

  // ---- body: bones + one skinned mesh ------------------------------------
  const { geometry, boneIndex } = buildBodyGeometry();
  // soft cloth/skin: per-vertex roughness, gentle fabric sheen at grazing angles, low specular
  const bodyMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.0,
    sheen: 0.55, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.62, 0.66, 0.72),
    specularIntensity: 0.55,
  });
  prep(bodyMat);
  const fpU = { value: 0 };
  addShaderPatch(bodyMat, 'riderAttr', (shader) => {
    shader.uniforms.uFP = fpU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aRough;
attribute float aFP;
uniform float uFP;
varying float vRough;`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
vRough = aRough;
if (uFP * aFP > 0.5) transformed = vec3(0.0, -60.0, 0.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vRough;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;');
  });
  const mesh = new THREE.SkinnedMesh(geometry, bodyMat);
  mesh.name = 'rider';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const ent = {};
  const bones = [];
  for (const [name, parent, off] of BONES) {
    const obj = new THREE.Bone();
    obj.name = name;
    obj.position.set(off[0], off[1], off[2]);
    const e = { name, obj, parent: parent ? ent[parent] : null, off: new V3(off[0], off[1], off[2]), rq: new Q(), rp: new V3() };
    ent[name] = e;
    bones.push(obj);
    if (parent) ent[parent].obj.add(obj);
  }
  mesh.add(ent.pelvis.obj);
  rig.add(mesh);
  // bind pose: limbs rotated like the modelled A-pose (children inherit)
  for (const [name, a] of Object.entries(BIND_ROT)) ent[name].obj.quaternion.setFromAxisAngle(Z_AXIS, a);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton, mesh.matrixWorld);
  // first-person camera anchor: mid-point between the eyes, follows the head bone
  const eye = new THREE.Object3D();
  eye.name = 'riderEye';
  eye.position.set(EYE_OFFSET[0], EYE_OFFSET[1], EYE_OFFSET[2]);
  ent.head.obj.add(eye);

  function setBone(e, q) {
    e.rq.copy(q);
    if (e.parent) {
      e.obj.quaternion.copy(e.parent.rq).invert().multiply(q);
      e.rp.copy(e.off).applyQuaternion(e.parent.rq).add(e.parent.rp);
    } else {
      e.obj.quaternion.copy(q);
      e.rp.copy(e.obj.position);
    }
  }

  // ---- state -------------------------------------------------------------
  const rng = mulberry32(20240915);
  const S = {
    speed: 0, lean: 0, brake: 0, crouchIn: 0, fast: 0, spread: 0,
    thr: 0, wob: 0, air: 0, land: 0, grab: 0, flash: 0, prevBrake: false,
    headYaw: -0.1, headPitch: 0, spin: 0, lookTimer: 2.5, lookTarget: -0.1, lookPitch: 0,
    slip: 0, windAmt: 0, fl: 0, breath: 0, wFall: 0,
    sit: 0, sitLookT: 0, sitYaw: 0, sitPitch: 0, sitYawT: 0.25, sitPitchT: -0.04,
  };
  const sitLook = { yaw: 0, pitch: 0, breath: 0 };
  const F = { active: false, phase: 'tumble', pt: 0, side: 1 };
  let T = 0;
  let pivotXc = 0;

  const Pr = makePose(), Pf = makePose(), Po = makePose(), Ps = makePose();
  const qA = new Q(), qB = new Q(), qFlap = new Q(), qComp = new Q(), qS = new Q(), qN = new Q();
  const pelvisQ = new Q(), chestQ = new Q(), headQ = new Q(), boardQ = new Q();
  const vA = new V3(), vB = new V3(), vC = new V3(), vD = new V3(), vE = new V3();
  const hip = new V3(), knee = new V3(), ankle = new V3(), tgt = new V3(), sh = new V3(), boardP = new V3();
  const qWorld = new Q();
  const ledCol = new THREE.Color(), ledRed = new THREE.Color(1.4, 0.04, 0.03);

  // two-bone IK; returns knee and the (possibly clamped) end point
  function twoBone(h, t, l1, l2, p, outKnee, outEnd) {
    vA.subVectors(t, h);
    let D = vA.length();
    if (D < 1e-5) { vA.set(0, -1, 0); D = 1e-5; } else vA.multiplyScalar(1 / D);
    const Dc = clamp(D, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.9995);
    const x = (l1 * l1 - l2 * l2 + Dc * Dc) / (2 * Dc);
    const hh = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
    vB.copy(p).addScaledVector(vA, -p.dot(vA));
    if (vB.lengthSq() < 1e-6) vB.set(0, 0, 1).addScaledVector(vA, -vA.z);
    vB.normalize();
    outKnee.copy(h).addScaledVector(vA, x).addScaledVector(vB, hh);
    outEnd.copy(h).addScaledVector(vA, Dc);
  }

  /** Bake a pose into the bones (IK for arms and legs). */
  function solvePose(P, wind, fl, breath, lean) {
    ent.pelvis.obj.position.copy(P.pelvis);
    setBone(ent.pelvis, P.qP);
    qS.copy(P.qP).slerp(P.qC, 0.5);
    setBone(ent.spine, qS);
    setBone(ent.chest, P.qC);
    qN.copy(P.qC).slerp(P.qH, 0.5);
    setBone(ent.neck, qN);
    setBone(ent.head, P.qH);

    // cloth
    qFlap.setFromAxisAngle(X_AXIS, wind * (0.22 + 0.06 * fl) + breath * 0.02);
    qA.copy(qFlap).multiply(P.qP);
    setBone(ent.hem, qA);
    qFlap.setFromAxisAngle(X_AXIS, -wind * (0.55 + 0.14 * fl));
    qA.copy(qFlap).multiply(P.qC);
    setBone(ent.hood, qA);
    ent.pack.obj.rotation.set(0.02 * fl * wind, 0, 0.015 * Math.sin(T * 2.3) * wind - lean * 0.05);

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 'L' : 'R';
      // leg
      const th = ent['thigh' + side], shin = ent['shin' + side], ft = ent['foot' + side];
      hip.copy(th.off).applyQuaternion(ent.pelvis.rq).add(ent.pelvis.rp);
      twoBone(hip, P.ankle[i], LEN.thigh, LEN.shin, P.kneePole[i], knee, ankle);
      vC.subVectors(knee, hip).normalize();
      aimQ(qB, vC, P.kneePole[i]);
      setBone(th, qB);
      vD.subVectors(ankle, knee).normalize();
      aimQ(qB, vD, P.kneePole[i]);
      setBone(shin, qB);
      setBone(ft, P.qFoot[i]);
      // arm
      const arm = ent['arm' + side], fore = ent['fore' + side], hand = ent['hand' + side];
      sh.copy(arm.off).applyQuaternion(ent.chest.rq).add(ent.chest.rp);
      twoBone(sh, P.hand[i], LEN.upper, LEN.fore, P.elbowPole[i], knee, ankle);
      tgt.copy(P.elbowPole[i]).negate();          // twist: forearm/thumb side faces away from the elbow tip
      vC.subVectors(knee, sh).normalize();
      aimQ(qB, vC, tgt);
      setBone(arm, qB);
      vD.subVectors(ankle, knee).normalize();
      aimQ(qB, vD, tgt);
      setBone(fore, qB);
      setBone(hand, qB);
    }
  }

  // ground-clearance probes: [bone, radius, local offset x,y,z (in bone frame) or none]
  const CLR = [
    ['pelvis', 0.11], ['spine', 0.11], ['chest', 0.12],
    ['head', 0.11, 0, 0.09, 0],
    ['shinL', 0.07], ['shinR', 0.07], ['foreL', 0.06], ['foreR', 0.06],
    ['handL', 0.045, 0, -0.06, 0], ['handR', 0.045, 0, -0.06, 0],
    ['footL', 0.07], ['footR', 0.07],
    ['footL', 0.045, 0, -0.03, 0.2], ['footR', 0.045, 0, -0.03, 0.2],
    ['footL', 0.05, 0, -0.03, -0.07], ['footR', 0.05, 0, -0.03, -0.07],
  ];
  function deficit() {
    let d = 0;
    for (const c of CLR) {
      const e = ent[c[0]];
      vE.copy(e.rp);
      if (c.length > 2) vE.add(tgt.set(c[2], c[3], c[4]).applyQuaternion(e.rq));
      d = Math.max(d, -GROUND + c[1] - vE.y);
    }
    return d;
  }

  function applyPose(P, clearance, wind, fl, breath, lean) {
    solvePose(P, wind, fl, breath, lean);
    if (clearance) {
      const d = deficit();
      if (d > 0.002) {
        P.pelvis.y += d;
        for (let i = 0; i < 2; i++) { P.ankle[i].y += d; P.hand[i].y += d; }
        solvePose(P, wind, fl, breath, lean);
      }
    }
  }

  // ---- riding pose -----------------------------------------------------------
  const sole = new V3();
  const fT = new V3(), gT = new V3(), gQ = new Q();
  function footTarget(boardLocal, yaw, pitch, out, outQ) {
    // board-local sole point + angles → rig-space ankle target + orientation
    sole.copy(boardLocal).applyQuaternion(boardQ).add(boardP);
    qEul(qA, pitch, yaw);
    outQ.copy(boardQ).multiply(qA);
    out.set(0, 0.08, -0.07).applyQuaternion(outQ).add(sole);
  }

  function computeRide(rs, dt) {
    const speed = Math.max(0, rs.speed || 0);
    const lean = S.lean, aLean = Math.abs(lean);
    const { brake: brakeW, fast, spread, thr, wob, air, land } = S;
    const idle = 1 - smoothstep(0.4, 3.0, S.speed);
    const windAmt = smoothstep(2, 15, S.speed);
    const tau = Math.PI * 2;
    const wPh = T * tau * 8.5;
    const wsin = Math.sin(wPh), wsin2 = Math.sin(wPh + 1.2), wj = Math.sin(T * tau * 17.3);
    const tanL = Math.tan(lean);
    const gY = (x) => -GROUND - (x - pivotXc) * tanL;

    let crouch = Math.max(S.crouchIn, Math.max(fast * 0.6, smoothstep(5, 9, S.speed) * 0.2));
    crouch += Math.min(aLean * 0.9, 0.3) + thr * 0.12;
    crouch = clamp(1 - (1 - clamp(crouch, 0, 1)) * (1 - brakeW * 0.35) * (1 - air * 0.55) * (1 - land * 0.5) * (1 - wob * 0.15), 0, 1);

    const breath = Math.sin(T * 1.75) * idle;
    const sway = Math.sin(T * 0.53) * idle;
    const pitchTot = 0.09 + 0.42 * crouch + thr * 0.12 - brakeW * 0.16 + breath * 0.012 + land * 0.12 + air * 0.08;
    const hipYaw = -1.30 + fast * 0.16 - brakeW * 0.10 + sway * 0.03;
    const chestYaw = lerp(hipYaw + 0.42, -0.32, spread) + breath * 0.01;
    const roll = -0.25 * lean;

    // board (wobble shakes board + feet together; airborne pulls it up to the feet)
    boardP.set(wob * 0.006 * wsin2, 0.12 * air * (1 - land) + wob * 0.004 * wj, 0);
    boardQ.setFromEuler(_e.set(0.05 * air, 0.09 * wob * wsin, 0.05 * wob * wsin2, 'YXZ'));
    Pr.boardPos.copy(boardP); Pr.boardQ.copy(boardQ);

    // pelvis / chest / head
    Pr.pelvis.set(-0.02 * brakeW + sway * 0.004 + wob * 0.010 * wsin2,
      lerp(0.885, 0.62, crouch) + breath * 0.004 + wob * 0.012 * wj + boardP.y * 0.6,
      0.07 * brakeW - 0.02 * fast + 0.02 * thr);
    qEul(pelvisQ, pitchTot * 0.4, hipYaw, roll);
    qEul(chestQ, pitchTot, chestYaw, roll);
    Pr.qP.copy(pelvisQ); Pr.qC.copy(chestQ);

    // head: ahead / into the turn / around at the scenery when idle; wobble shakes it
    S.lookTimer -= dt;
    if (S.lookTimer <= 0) {
      S.lookTimer = 3 + rng() * 4.5;
      const r = rng();
      S.lookTarget = r < 0.45 ? -1.2 - rng() * 0.3 : r < 0.7 ? -0.55 : r < 0.85 ? 0.35 : -0.1;
      S.lookPitch = (rng() - 0.35) * 0.35;
    }
    let slip = 0;
    if (rs.heading && speed > 1) {
      root.getWorldQuaternion(qWorld).invert();
      vE.copy(rs.heading).applyQuaternion(qWorld);
      slip = clamp(Math.atan2(vE.x, vE.z), -0.6, 0.6);
    }
    S.slip = damp(S.slip, slip, 6, dt);
    const yawT = lerp(-0.10, S.lookTarget, idle) - clamp(lean * 0.9, -0.5, 0.5) + S.slip * 0.8 + Math.sin(T * 0.7) * 0.02 +
      wob * 0.16 * Math.sin(T * tau * 11);
    const pitchT = lerp(0.0, S.lookPitch, idle) + fast * 0.22 + thr * 0.06 - brakeW * 0.05 + air * 0.1 +
      wob * 0.07 * Math.sin(T * tau * 13.4) - land * 0.1;
    S.headYaw = damp(S.headYaw, yawT, 4 + 10 * wob, dt);
    S.headPitch = damp(S.headPitch, pitchT, 4 + 10 * wob, dt);
    const relYaw = clamp(S.headYaw - chestYaw, -1.3, 1.3);
    qEul(headQ, S.headPitch, chestYaw + relYaw, roll * 0.5);
    Pr.qH.copy(headQ);

    // feet: front (left) + rear (right) on the board, rear drags when braking
    vA.set(0, 0.002, 0.21);
    footTarget(vA, -0.87 - 0.06 * fast, 0, Pr.ankle[0], Pr.qFoot[0]);
    vA.set(0, 0.002, -0.22 - 0.02 * fast);
    footTarget(vA, -1.45, 0, Pr.ankle[1], Pr.qFoot[1]);
    if (brakeW > 0.001) {
      const bx = -0.31;
      gT.set(bx, gY(bx) + 0.002, -0.30);
      qEul(gQ, -0.10, -1.32, 0);
      fT.set(0, 0.08, -0.07).applyQuaternion(gQ).add(gT);
      Pr.ankle[1].lerp(fT, brakeW);
      Pr.qFoot[1].slerp(gQ, brakeW);
    }
    // knees: point along the toes; wobble makes them tremble
    for (let i = 0; i < 2; i++) {
      const yaw = i === 0 ? -0.87 : -1.45;
      Pr.kneePole[i].set(Math.sin(yaw) + wob * 0.6 * Math.sin(T * tau * 19 + i * 2), 0.05, Math.cos(yaw) + wob * 0.4 * Math.sin(T * tau * 23 + i));
    }

    // arms: FK described by (abduction, swing, elbow flex, sweep) → hand target + elbow pole
    qComp.setFromAxisAngle(Z_AXIS, -0.75 * lean * Math.max(spread, air, wob));
    const wm = T * tau * 1.8;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      let alpha = 0.10 + 0.22 * crouch + 0.02 * breath, beta = 0.05 + 0.03 * breath * s, elbow = 0.30 + 0.55 * crouch, sweep = 0;
      if (s < 0) { // remote hand: held forward, further forward on throttle
        alpha += 0.06; beta += 0.30 + 0.32 * thr; elbow += 0.35 + 0.25 * thr;
      }
      // wings
      const fluT = Math.sin(T * 2.6 + s * 1.7) * 0.05 + Math.sin(T * 5.3 + s) * 0.02 * fast;
      const aSp = 1.30 + fluT + s * clamp(lean * 1.0, -0.45, 0.45) + air * 0.45;
      alpha = lerp(alpha, aSp, spread); beta = lerp(beta, 0.0, spread);
      elbow = lerp(elbow, 0.20 + 0.06 * S.fl * fast, spread); sweep = lerp(sweep, 0.16 + 0.05 * fast, spread);
      // brake: arms out for balance
      alpha = lerp(alpha, 0.85 + s * 0.05, brakeW); beta = lerp(beta, 0.12, brakeW); elbow = lerp(elbow, 0.35, brakeW); sweep = lerp(sweep, 0.15, brakeW);
      // wobble: windmill
      const wa = wm + (s > 0 ? 0 : Math.PI);
      alpha = lerp(alpha, 1.25 + 0.75 * Math.sin(wa), wob);
      beta = lerp(beta, 0.35 * Math.cos(wa), wob);
      elbow = lerp(elbow, 0.25, wob); sweep = lerp(sweep, 0.1, wob);
      // landing: press down
      alpha = lerp(alpha, 0.55, land); beta = lerp(beta, 0.30, land); elbow = lerp(elbow, 0.55, land);

      shoulderPos(Pr, i, vD);
      const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sb = Math.sin(beta);
      vA.set(s * sa, -ca * cb, ca * sb);
      const sw = s * sweep, cs = Math.cos(sw), ss = Math.sin(sw);
      vA.set(vA.x * cs + vA.z * ss, vA.y, -vA.x * ss + vA.z * cs).normalize();
      vB.set(0, 0, 1).addScaledVector(vA, -vA.z);
      if (vB.lengthSq() < 1e-5) vB.set(0, 1, 0);
      vB.normalize();
      vC.copy(vA).multiplyScalar(Math.cos(elbow)).addScaledVector(vB, Math.sin(elbow)).normalize();
      vA.applyQuaternion(chestQ).applyQuaternion(qComp);
      vC.applyQuaternion(chestQ).applyQuaternion(qComp);
      vB.applyQuaternion(chestQ).applyQuaternion(qComp);
      Pr.hand[i].copy(vD).addScaledVector(vA, LEN.upper).addScaledVector(vC, LEN.fore);
      Pr.elbowPole[i].copy(vB).negate();         // elbow tip points away from the forearm bend
      if (i === 1 && S.grab > 0.001) {           // long air: rear hand grabs the toe-side edge
        gT.set(-0.13, 0.035, 0.03).applyQuaternion(boardQ).add(boardP);
        Pr.hand[1].lerp(gT, S.grab);
      }
    }
    return { windAmt, breath };
  }

  // ---- update ------------------------------------------------------------
  function update(dt, rs) {
    dt = clamp(dt || 0, 0, 0.05);
    T += dt;
    rs = rs || {};
    const speed = Math.max(0, rs.speed || 0);

    S.speed = damp(S.speed, speed, 10, dt);
    S.brake = damp(S.brake, rs.braking && speed > 0.4 ? 1 : 0, 9, dt);
    S.lean = damp(S.lean, clamp(rs.lean || 0, -0.9, 0.9), 12, dt);
    S.crouchIn = damp(S.crouchIn, clamp(rs.crouch || 0, 0, 1), 8, dt);
    S.thr = damp(S.thr, clamp(rs.throttle || 0, 0, 1), 8, dt);
    S.wob = damp(S.wob, clamp(rs.wobble || 0, 0, 1), 14, dt);
    S.air = damp(S.air, rs.airborne ? 1 : 0, 14, dt);
    S.land = damp(S.land, clamp(rs.landing || 0, 0, 1), 25, dt);
    S.grab = damp(S.grab, rs.airborne && (rs.airTime || 0) > 0.8 ? smoothstep(0.8, 1.15, rs.airTime) : 0, 8, dt);
    S.fast = damp(S.fast, smoothstep(9, 16, speed), 3.0, dt);
    const spreadT = Math.max(S.fast, smoothstep(0.10, 0.32, Math.abs(S.lean)) * 0.85, S.air * 0.9) * (1 - 0.5 * S.brake);
    S.spread = damp(S.spread, spreadT, 3.5, dt);
    if (rs.braking && !S.prevBrake) S.flash = 1;
    S.prevBrake = !!rs.braking;
    S.flash = Math.max(0, S.flash - dt * 4.5);
    S.fl = 0.5 * Math.sin(T * 23) + 0.5 * Math.sin(T * 37 + 1.3);

    // fall state (own clock per phase)
    const fall = rs.fall;
    if (fall && fall.phase) {
      if (!F.active) { F.active = true; F.phase = fall.phase; F.pt = 0; }
      else if (fall.phase !== F.phase) { F.phase = fall.phase; F.pt = 0; }
      else F.pt += dt;
      if (typeof fall.pt === 'number') F.pt = fall.pt;   // optional per-phase time override (preview / tests)
      F.side = fall.side || 1;
    } else F.active = false;
    const wF = F.active ? fallWeight(F.phase, F.pt) : 0;
    S.wFall = wF;

    // sitting (ride.sitting 0..1, ride.sitMode 'board' | 'ground'); a crash overrides it
    S.sit = F.active ? 0 : damp(S.sit, clamp(rs.sitting || 0, 0, 1), 30, dt);
    const sit = S.sit;

    // lean pivot (contact-line rotation); no lean while crashed / sitting
    const lean = S.lean * (1 - wF) * (1 - sit);
    pivotXc = -0.135 * Math.tanh(lean / 0.12);
    pivot.position.x = pivotXc;
    pivot.rotation.z = lean;
    rig.position.x = -pivotXc;

    const ride = computeRide(rs, dt);
    if (sit > 0.001) {
      // slow, relaxed looking around + breathing
      S.sitLookT -= dt;
      if (S.sitLookT <= 0) {
        S.sitLookT = 4 + rng() * 5;
        S.sitYawT = (rng() - 0.5) * 1.1;
        S.sitPitchT = -0.02 - rng() * 0.12;
      }
      S.sitYaw = damp(S.sitYaw, S.sitYawT * smoothstep(0.85, 1, sit), 0.9, dt);
      S.sitPitch = damp(S.sitPitch, S.sitPitchT * smoothstep(0.85, 1, sit), 0.9, dt);
      sitLook.yaw = S.sitYaw; sitLook.pitch = S.sitPitch; sitLook.breath = Math.sin(T * 1.45);
      sitPose(Ps, Pr, sit, rs.sitMode === 'ground' ? 'ground' : 'board', sitLook);
      copyPose(Pr, Ps);
    }
    if (F.active) {
      fallPose(Pf, F.phase, F.pt, F.side, T);
      blendPose(Po, Pr, Pf, wF);
    } else copyPose(Po, Pr);

    // board transform + trucks + wheels + LED
    board.group.position.copy(Po.boardPos);
    board.group.quaternion.copy(Po.boardQ);
    const omega = speed / WHEEL_R;
    S.spin += 90 * Math.tanh(omega / 90) * dt;         // saturate: no aliasing garbage at high speed
    _e.set(0, -0.42 * lean, -0.55 * lean, 'ZYX'); board.hangers[0].quaternion.setFromEuler(_e);
    _e.set(0, 0.42 * lean, -0.55 * lean, 'ZYX'); board.hangers[1].quaternion.setFromEuler(_e);
    board.setWheels(S.spin);
    // nitro flame: only on throttle, out when braking / crashed
    const nz = rs.braking || F.active ? 0 : clamp(rs.throttle || 0, 0, 1) * (1 - sit);
    nitro.update(dt, nz, speed, T);
    ledCol.setRGB(0.10, 0.75, 1.0).multiplyScalar(0.05 + 1.1 * S.thr + 0.8 * nitro.state.ign);
    ledCol.lerp(ledRed, Math.max(S.flash, S.brake * 0.35));
    board.ledMat.color.copy(ledCol);

    applyPose(Po, wF > 0.02, ride.windAmt, S.fl, ride.breath, lean);
  }

  function dispose() {
    mesh.geometry.dispose();
    skeleton.dispose();
    root.traverse((o) => { if (o.geometry && o !== mesh) o.geometry.dispose(); });
    for (const m of board.materials) { m.map?.dispose?.(); m.dispose(); }
    bodyMat.dispose();
    nitro.dispose();
  }

  // settle into a neutral pose immediately
  update(0.016, { speed: 0 });

  /**
   * First-person mode: hides the head, beanie, hair, collar, backpack and its straps in the camera view
   * (the shadow still shows the whole rider). Torso, arms, legs, hands and the board stay
   * visible. Place the camera at `eye` (head-bone anchor between the eyes).
   */
  function setFirstPerson(on) { fpU.value = on ? 1 : 0; }

  return {
    root,
    update,
    dispose,
    setFirstPerson,
    get firstPerson() { return fpU.value > 0.5; },
    eye,
    /** World-space eye position (and optionally orientation) for a first-person camera. */
    getEye(outPos, outQuat) {
      eye.updateWorldMatrix(true, false);
      eye.getWorldPosition(outPos);
      if (outQuat) eye.getWorldQuaternion(outQuat);
      return outPos;
    },
    groundOffset: GROUND,
    colors: COLORS,
    _debug: { ent, mesh, board, S, deficit },
  };
}
