// 长板第三人称电影镜头：弹簧臂 + 路径前瞻 + 惯性滞后/侧倾 + 速度/加速度 FOV + 地形避让 + 颠簸
// + 腾空/摔倒/隧道/桥的特殊处理 + 空闲电影机位。
// 纯数学（只依赖传入的 THREE），无 DOM，可在 node 里仿真。
//
// update(dt, t, ride, look)
//   ride = 骑行状态（skate.state）；look = { yaw, pitch, idle }：
//   鼠标/触屏环顾偏移（rad）与"无输入秒数"（用于电影机位）。

// 电影取景：静止时略长焦（压缩远山、让山体显得更高大），速度越快越广（保留速度感）
export const FOV_MIN = 54;
export const FOV_MAX = 72;          // 16 m/s 时
const TUNNEL_CEIL = 4.6;            // 隧道内镜头高度上限（路面 + m）
const TUNNEL_HALF = 5.0;            // 隧道内镜头横向上限（m）
// 坐在板上（ride.sitting）：镜头缓缓绕到人的侧前方，低机位、略长焦，慢慢呼吸漂移
const SIT_YAW = 2.0;                // 绕骑手转多少（rad，0 = 正后方，π = 正前方）
const SIT_BACK = 3.7;               // 离骑手的距离
const SIT_H = 0.5;                  // 相对锚点（坐姿胸口）的高度
const SIT_FOV = 50;
// 第一人称
export const FP_FOV_MIN = 66;
const FP_FOV_MAX = 76;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const wrapPi = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };

export function createChaseCam(THREE, world, camera, opts = {}) {
  const path = world.path;
  const cfg = {
    back: 5.4, height: 1.75,           // 弹簧臂：身后 5.4 m、高 1.75 m（低机位，地平线下移、天空更大）
    lookMin: 6, lookMax: 10,           // 前瞻距离
    clearance: 0.8,                    // 相机离地最小高度
    maxRoll: (4 * Math.PI) / 180,
    cinematicDelay: 20,                // 空闲多少秒进入电影机位
    cinematic: true,
    ...opts,
  };

  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const fwd = new THREE.Vector3(), rgt = new THREE.Vector3();
  const delta = new THREE.Vector3();
  const ahead = new THREE.Vector3(), aheadR = new THREE.Vector3(), aheadT = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const pc = new THREE.Vector3(), pt = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const qRoll = new THREE.Quaternion(), qJit = new THREE.Quaternion(), eJit = new THREE.Euler();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const upV = new THREE.Vector3(0, 1, 0);

  let camYaw = 0, roll = 0, fov = FOV_MIN, cine = 0, speedSm = 0, accSm = 0;
  let airBlend = 0, fallBlend = 0, wobSm = 0, fovAcc = 0;
  let inited = false, yawRate = 0;
  let sitCam = 0, sitSide = 0;   // 坐姿机位混合（比 ride.sitting 更慢）、绕向哪一侧（±1，0 = 未选）
  const wrapS = (s) => (path.closed ? ((s % path.length) + path.length) % path.length : clamp(s, 0, path.length));

  // 当前帧的地面模式：普通地形 / 隧道 / 桥（隧道与桥用路面高度作为"地面"）
  let mode = 0, rideRef = null, armBack = 5;
  const roadYAt = (s) => path.pointAt(wrapS(s), pc).y;
  function groundAt(x, z, tt = 1) {
    if (mode !== 0 && rideRef) return roadYAt(rideRef.s - armBack * tt);
    return world.heightAt(x, z);
  }

  /** 计算期望相机位置（含地形避让），写入 desired。 */
  function solveArm(A, dirBackX, dirBackZ, back, height) {
    // 按期望长度试；若被地形挡住，先抬高（≤3.5 m），仍挡住则拉近
    for (let attempt = 0; attempt < 3; attempt++) {
      const len = attempt === 2 ? back * 0.5 : attempt === 1 ? back * 0.75 : back;
      armBack = len;
      desired.set(A.x + dirBackX * len, A.y + height, A.z + dirBackZ * len);
      let raise = 0;
      for (let k = 1; k <= 3; k++) {
        const tt = k / 3;
        const px = lerp(A.x, desired.x, tt), pz = lerp(A.z, desired.z, tt);
        const py = lerp(A.y, desired.y, tt);
        const need = groundAt(px, pz, tt) + cfg.clearance - py;
        if (need > 0) raise = Math.max(raise, need / tt);
      }
      if (raise <= 0) return;
      if (raise <= 3.5 || attempt === 2) { desired.y += Math.min(raise, 6); return; }
    }
  }

  /**
   * 坐下时选绕向哪一侧（±1）：机位不被地形挡（不需要抬高）优先，其次是骑手身后（画面背景）更开阔的一侧；
   * 隧道 / 桥上选机位离路中线更近的一侧（不出隧道、不悬在桥外）。
   */
  function chooseSitSide(ride) {
    const P = ride.position;
    const confined = ride.inTunnel || ride.onBridge;
    let best = 1, bestScore = Infinity;
    for (const sd of [1, -1]) {
      const o = camYaw + sd * SIT_YAW;
      const bx = -Math.sin(o), bz = -Math.cos(o);
      const cx = P.x + bx * SIT_BACK, cz = P.z + bz * SIT_BACK;
      let score;
      if (confined) {
        path.pointAt(wrapS(ride.s), pc); path.tangentAt(wrapS(ride.s), pt);
        const rx = -pt.z, rz = pt.x, rl = Math.hypot(rx, rz) || 1;
        score = Math.abs(((cx - pc.x) * rx + (cz - pc.z) * rz) / rl);
      } else {
        const raise = Math.max(0, world.heightAt(cx, cz) + cfg.clearance - (P.y + SIT_H + 0.4));
        let open = 0;
        for (const d of [60, 150, 320]) open += clamp(P.y - world.heightAt(P.x - bx * d, P.z - bz * d), -120, 120);
        score = raise * 2 - open / 120;
      }
      if (score < bestScore - 1e-6) { bestScore = score; best = sd; }
    }
    return best;
  }

  function update(dt, t, ride, look = {}) {
    dt = Math.min(dt, 0.1);
    rideRef = ride;
    const ly = look.yaw || 0, lp = look.pitch || 0;
    const idle = look.idle || 0;
    const accel = ride.accel || 0;

    // 平滑速度 / 加速度
    speedSm += (ride.speed - speedSm) * damp(2.5, dt);
    accSm += (accel - accSm) * damp(3.0, dt);
    const sT = clamp(speedSm / 16, 0, 1);

    airBlend += ((ride.airborne ? 1 : 0) - airBlend) * damp(4, dt);
    fallBlend += ((ride.fallen ? 1 : 0) - fallBlend) * damp(ride.fallen ? 1.3 : 1.1, dt);
    wobSm += ((ride.wobble || 0) - wobSm) * damp(10, dt);

    // 坐姿机位（ride.sitting 0..1）；sw = 0 时下面所有 lerp 都是恒等，原跟拍完全不变
    const sitIn = clamp(ride.sitting || 0, 0, 1);
    sitCam += (sitIn - sitCam) * damp(sitIn > sitCam ? 1.0 : 1.5, dt);
    if (sitIn === 0 && sitCam < 1e-3) { sitCam = 0; sitSide = 0; }
    const sw = sitCam > 0 ? smoothstep(0, 1, sitCam) : 0;

    // 电影机位混合：空闲 20 s 后缓入，任何输入快速退出；腾空/摔倒/预警/坐着时不进入
    const calm = !ride.airborne && !ride.fallen && (ride.wobble || 0) < 0.05 && sitIn < 0.05;
    const wantCine = cfg.cinematic && idle > cfg.cinematicDelay && calm ? 1 : 0;
    cine += (wantCine - cine) * damp(wantCine ? 0.5 : 2.5, dt);
    if (cine < 0.001) cine = 0;

    // 骑手锚点（胸口高度，蹲下降低）
    anchor.copy(ride.position).addScaledVector(ride.up, lerp(1.05 - 0.3 * ride.crouch, 0.55, sw));

    // 镜头朝向：滞后跟随板头方向
    const hy = Math.atan2(ride.heading.x, ride.heading.z);
    if (!inited) camYaw = hy;
    const diff = wrapPi(hy - camYaw);
    const dYaw = diff * damp(3.2, dt);
    camYaw = wrapPi(camYaw + dYaw);
    yawRate = dt > 0 ? dYaw / dt : 0;

    // 电影机位：缓慢侧向环绕到前方低机位，再绕回（周期约 90 s）
    const cineYaw = cine * (1.55 - 1.05 * Math.cos(t * 0.07));
    if (sitIn > 0 && !sitSide) sitSide = chooseSitSide(ride);
    const sitYaw = sw > 0 ? sw * (sitSide * SIT_YAW + 0.1 * Math.sin(t * 0.083)) : 0;
    const orbit = camYaw + ly + cineYaw + sitYaw;

    // 弹簧臂：速度越快略拉远、降低；加速被甩后、刹车前压；腾空拉远；摔倒拉远升高
    const accPull = clamp(accSm * 0.4, -1.3, 1.0);
    let back = (cfg.back + 0.9 * sT + accPull + 1.2 * airBlend + 2.6 * fallBlend) * (1 - 0.15 * cine);
    let height = cfg.height - 0.4 * sT - cine * 0.9 - lp * back * 0.9 + 0.35 * airBlend + 1.3 * fallBlend;
    if (sw > 0) {
      const sb = SIT_BACK + 0.3 * Math.sin(t * 0.061 + 2);
      height = lerp(height, SIT_H + 0.07 * Math.sin(t * 0.13 + 1) - lp * sb * 0.9, sw);
      back = lerp(back, sb, sw);
    }
    height = clamp(height, 0.5, 6.5);

    // 隧道 / 桥：相机在（或刚离开）隧道或桥时，用路面高度当"地面"
    const sBehind = ride.s - back - 1;
    const inTun = !!(ride.inTunnel || path.isTunnel?.(sBehind));
    const onBr = !!(ride.onBridge || path.isBridge?.(sBehind));
    mode = inTun ? 1 : onBr ? 2 : 0;

    const bx = -Math.sin(orbit), bz = -Math.cos(orbit);
    solveArm(anchor, bx, bz, back, height);

    // 前瞻点（沿 path，含横向）；环顾/电影/摔倒时逐渐看向骑手
    const lookDist = lerp(cfg.lookMin, cfg.lookMax, sT);
    const sA = ride.s + lookDist;
    path.pointAt(wrapS(sA), ahead);
    path.tangentAt(wrapS(sA), aheadT);
    aheadR.set(-aheadT.z, 0, aheadT.x).normalize();
    ahead.addScaledVector(aheadR, ride.lateral * 0.6);
    ahead.y += 0.9;
    if (ride.airborne) ahead.y = Math.min(ahead.y, ride.position.y + 1.5 - 2 * airBlend);   // 腾空时视线略下压看落点
    const away = Math.max(smoothstep(0.5, 1.6, Math.abs(ly)), cine, fallBlend);
    tgt.copy(ahead).lerp(anchor, away);
    tgt.y += lp * 3 * (1 - away);
    if (sw > 0) {
      // 看骑手，但把人放在画面一侧（目标点往行进方向偏），留出风景
      let px = -bz, pz = bx;
      if (px * ride.heading.x + pz * ride.heading.z < 0) { px = -px; pz = -pz; }
      pc.copy(anchor).addScaledVector(ride.up, 0.12);
      pc.x += px * 0.75; pc.z += pz * 0.75;
      pc.y += lp * 1.5;
      tgt.lerp(pc, sw);
    }

    if (!inited) { camPos.copy(desired); lookAt.copy(tgt); inited = true; }

    // 位置平滑：前后方向硬一点、横向软（转弯有惯性拖尾）、垂直居中；坐姿机位整体很慢
    fwd.set(Math.sin(camYaw), 0, Math.cos(camYaw));
    rgt.set(-fwd.z, 0, fwd.x);
    delta.subVectors(desired, camPos);
    const df = delta.dot(fwd), dr = delta.dot(rgt), dy = delta.y;
    const kf = damp(lerp(fallBlend > 0.05 ? 3 : 16, 1.7, sw), dt), kr = damp(lerp(4.5, 1.7, sw), dt), ky = damp(lerp(ride.airborne ? 5 : 8, 1.7, sw), dt);
    camPos.addScaledVector(fwd, df * kf).addScaledVector(rgt, dr * kr);
    camPos.y += dy * ky;
    lookAt.lerp(tgt, damp(lerp(fallBlend > 0.05 ? 3 : 6, 2.0, sw), dt));

    // 保证不钻地 / 不穿隧道顶：状态与输出都夹紧
    armBack = back;
    const gMin = groundAt(camPos.x, camPos.z, 1) + cfg.clearance;
    if (camPos.y < gMin) camPos.y = gMin;
    if (mode === 1) {
      const ceil = ride.position.y - 0.13 + TUNNEL_CEIL;
      if (camPos.y > ceil) camPos.y = ceil;
      // 横向不超出隧道（±5 m）
      const sc = wrapS(ride.s - back);
      path.pointAt(sc, pc); path.tangentAt(sc, pt);
      const rx = -pt.z, rz = pt.x, rl = Math.hypot(rx, rz) || 1;
      const lat = ((camPos.x - pc.x) * rx + (camPos.z - pc.z) * rz) / rl;
      if (Math.abs(lat) > TUNNEL_HALF) {
        const d = (Math.sign(lat) * TUNNEL_HALF - lat) / rl;
        camPos.x += rx * d; camPos.z += rz * d;
      }
    }

    // 路面颠簸（速度 >10 m/s 起明显，随路面粗糙度）、预警抖动
    const rough = ride.surface === 'gravel' ? 2.4 : ride.surface === 'dirt' ? 1.5 : 1;
    const hiSpeed = smoothstep(10, 17, ride.speed) * (ride.airborne ? 0.15 : 1);
    const amp = (0.004 * sT + 0.011 * hiSpeed) * rough * (1 - cine);
    const bump = amp * (Math.sin(t * 41.3) * 0.5 + Math.sin(t * 27.1 + 1.3) * 0.35 + Math.sin(t * 63.7 + 0.4) * 0.15);
    const bump2 = amp * 0.6 * Math.sin(t * 33.9 + 2.1);
    const shakeX = wobSm * 0.07 * Math.sin(t * 19.0) + wobSm * 0.03 * Math.sin(t * 31.0 + 1);
    const shakeY = wobSm * 0.035 * Math.sin(t * 23.0 + 0.5);
    // 落地冲击：镜头向下压一下
    const land = (ride.landing || 0);

    camera.position.copy(camPos);
    camera.position.y += bump + shakeY - land * 0.22;
    if (sw > 0) camera.position.y += sw * 0.03 * Math.sin(t * 1.15);   // 坐着：很慢的呼吸
    camera.position.x += (bump2 + shakeX) * rgt.x; camera.position.z += (bump2 + shakeX) * rgt.z;
    const gOut = mode === 0 ? groundAt(camera.position.x, camera.position.z, 1) : roadYAt(ride.s - back);
    if (camera.position.y < gOut + cfg.clearance - 0.3) camera.position.y = gOut + cfg.clearance - 0.3;

    // 朝向 + 侧倾（转弯时向内倾斜，≤ 4°）+ 抖动
    m.lookAt(camera.position, lookAt, upV);
    camera.quaternion.setFromRotationMatrix(m);
    const rollTarget = clamp(-yawRate * 0.05 + ride.lean * 0.10, -cfg.maxRoll, cfg.maxRoll) * (1 - cine * 0.6) * (1 - sw);
    roll += (rollTarget - roll) * damp(4, dt);
    const wobRoll = wobSm * 0.028 * Math.sin(t * 17.0) + wobSm * 0.012 * Math.sin(t * 29.0);
    qRoll.setFromAxisAngle(zAxis, -roll + wobRoll);   // 右转（roll>0）→ 相机绕视线顺时针
    camera.quaternion.multiply(qRoll);
    const jit = amp * 0.35 + wobSm * 0.004;
    if (jit > 1e-5) {
      eJit.set(jit * Math.sin(t * 47.0), jit * 0.6 * Math.sin(t * 39.0 + 1.0), 0);
      qJit.setFromEuler(eJit);
      camera.quaternion.multiply(qJit);
    }

    // FOV：速度 62°→78°（16 m/s）+ 加速度 ±3°（油门猛推拉宽、刹车收窄）
    const targetFov = lerp(lerp(FOV_MIN, FOV_MAX, smoothstep(0, 1, sT)), SIT_FOV, sw);
    fovAcc += (clamp(accSm / 2.5, -1, 1) * 3 - fovAcc) * damp(5, dt);
    fov += (targetFov + fovAcc - fov) * damp(4, dt);
    if (Math.abs(camera.fov - fov) > 0.02) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  /** 硬复位（重生 / 切换控制器时）：下一帧直接吸附到期望位置。 */
  function snap() { inited = false; speedSm = 0; accSm = 0; roll = 0; cine = 0; airBlend = 0; fallBlend = 0; wobSm = 0; fovAcc = 0; sitCam = 0; sitSide = 0; }

  return { update, snap, cfg, get roll() { return roll; }, get fov() { return fov; }, get sit() { return sitCam; } };
}

/**
 * 长板第一人称：相机在骑手眼睛处（eye 由控制器给：人物头骨位置，已在板坐标系里低通滤波），
 * 朝向沿行进方向（低通），鼠标环顾；求稳——roll ≤ 2°、颠簸只有跟拍的一小部分、腾空时俯仰只跟一半。
 * 不直接写 camera：结果写进 out = { position, quaternion, fov }，由控制器与第三人称混合。
 *
 * update(dt, t, ride, eye, look, out)
 *   eye: Vector3 世界坐标眼睛位置；look = { yaw, pitch }；ride.sitting 降低基准俯角 / 关掉颠簸。
 */
export function createFirstPersonCam(THREE, world) {
  const path = world.path;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const pc = new THREE.Vector3();
  let yaw = 0, pitch = 0, roll = 0, fov = FP_FOV_MIN, speedSm = 0, accSm = 0, airBlend = 0, wobSm = 0, fovAcc = 0;
  let inited = false;
  const wrapS = (s) => (path.closed ? ((s % path.length) + path.length) % path.length : clamp(s, 0, path.length));

  function update(dt, t, ride, eye, look, out) {
    dt = Math.min(dt, 0.1);
    const h = ride.heading;
    const hy = Math.atan2(-h.x, -h.z);                       // 相机 yaw 约定：0 = 看向 -Z
    const hp = Math.asin(clamp(h.y, -1, 1));
    const seat = clamp(ride.sitting || 0, 0, 1);
    airBlend += ((ride.airborne ? 1 : 0) - airBlend) * damp(4, dt);
    if (!inited) { yaw = hy; pitch = hp * 0.7; inited = true; }
    yaw = wrapPi(yaw + wrapPi(hy - yaw) * damp(7, dt));
    pitch += (hp * (0.7 - 0.35 * airBlend) - pitch) * damp(ride.airborne ? 2.2 : 4, dt);

    speedSm += (ride.speed - speedSm) * damp(2.5, dt);
    accSm += ((ride.accel || 0) - accSm) * damp(3, dt);
    wobSm += ((ride.wobble || 0) - wobSm) * damp(10, dt);
    const sT = clamp(speedSm / 16, 0, 1);

    // 颠簸：只给跟拍的 ~40%，只上下；预警抖动也很克制
    const rough = ride.surface === 'gravel' ? 2.4 : ride.surface === 'dirt' ? 1.5 : 1;
    const hiSpeed = smoothstep(10, 17, ride.speed) * (ride.airborne ? 0.15 : 1);
    const amp = (0.0016 * sT + 0.0045 * hiSpeed) * rough * (1 - seat);
    const bump = amp * (Math.sin(t * 41.3) * 0.5 + Math.sin(t * 27.1 + 1.3) * 0.35 + Math.sin(t * 63.7 + 0.4) * 0.15);
    const shake = wobSm * 0.012 * Math.sin(t * 23.0 + 0.5);
    out.position.copy(eye);
    out.position.y += bump + shake - (ride.landing || 0) * 0.08 + seat * 0.006 * Math.sin(t * 1.2);

    // 不钻地 / 不顶穿隧道：隧道与桥上以路面为地面
    const confined = ride.inTunnel || ride.onBridge;
    const gy = confined ? path.pointAt(wrapS(ride.s), pc).y : world.heightAt(out.position.x, out.position.z);
    if (out.position.y < gy + 0.45) out.position.y = gy + 0.45;
    if (ride.inTunnel && out.position.y > gy + 4.4) out.position.y = gy + 4.4;

    // roll：压弯时只给很小的倾斜（≤ 2°），坐着为 0
    const rollT = clamp(-(ride.lean || 0) * 0.1, -0.035, 0.035) * (1 - seat) + wobSm * 0.004 * Math.sin(t * 17.0);
    roll += (rollT - roll) * damp(3, dt);
    euler.set(pitch * (1 - seat) - 0.05 * (1 - seat) + (look.pitch || 0), yaw + (look.yaw || 0), roll, 'YXZ');
    out.quaternion.setFromEuler(euler);

    // FOV：比跟拍广（能看到脚下的板），速度感幅度适中
    fovAcc += (clamp(accSm / 2.5, -1, 1) * 1.5 - fovAcc) * damp(5, dt);
    const fT = lerp(lerp(FP_FOV_MIN, FP_FOV_MAX, smoothstep(0, 1, sT)) + fovAcc, 62, seat);
    fov += (fT - fov) * damp(3, dt);
    out.fov = fov;
    return out;
  }
  function snap() { inited = false; speedSm = 0; accSm = 0; airBlend = 0; wobSm = 0; fovAcc = 0; roll = 0; fov = FP_FOV_MIN; }
  return { update, snap };
}
