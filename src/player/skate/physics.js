// 电动长板物理：沿 path 的一维 + 横向；重力/滚阻/风阻 + 电机；过弯抓地极限（摔倒）；凸坡腾空。
// 纯数学模块（只依赖 three），无 DOM，可在 node 里做数值仿真。
// 约定：lateral > 0 = 行进方向右侧；heading = 前进方向（含坡度）；up = 路面法线。
// s 为水平弧长（path 采样沿 XZ 等距），speed 为沿地面的速度。
import * as THREE from 'three';

const G = 9.81;
const MASS = 80;             // 人 + 板 + 电机 (kg)
const RHO = 1.2;             // 空气密度
const CDA_STAND = 0.40;
const CDA_CROUCH_CUT = 0.35; // 全蹲时 CdA 减少 35%
const BOARD_LIFT = 0.13;     // 板面离路面的高度

const THRUST0 = 2.6;         // 零速时电机加速度 (m/s²)
const MOTOR_V = 20;          // 电机力衰减到 0 的速度（平路极速 ≈ 11–12 m/s）
const THROTTLE_UP = 2.5;     // 油门爬升速率 (/s) → 0.4 s 满油门
const THROTTLE_DOWN = 6;
const BRAKE_DECEL = 3.5;     // 脚刹 (m/s²)
// 轮子与路面的库仑摩擦（聚氨酯轮 / 干柏油）：静摩擦决定过弯极限，超过后侧滑，侧滑时是动摩擦
const MU_S = 0.9;
const MU_K = 0.68;
const CARVE_G = 0.45;        // 玩家主动压弯（换线）最多用到的横向加速度
const LEAN_MAX_G = 1.05;     // 人能压到的最大倾角（≈46°）对应的横向加速度 —— 可以超过抓地 → 侧滑
const TRUCK_R = 1.8;         // 桥架几何决定的最小转弯半径 (m)
const HARD_LAND = 7.5;       // 落地法向速度超过它腿扛不住 → 摔（≈ 2.9 m 高度落差）

const TUMBLE = 1.8, LIE = 0.8, GETUP = 1.8;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (k, dt) => 1 - Math.exp(-k * dt);

// 峡湾沿途风景段（弧长区间）
const FJORD_FEATURES = [
  [0, 300, 'lake'], [300, 560, 'geothermal'], [1500, 1760, 'hairpinFall'], [2140, 2290, 'tunnel'],
  [2600, 2800, 'gorge'], [2950, 3450, 'pasture'], [3450, 3760, 'beach'], [3760, 1e9, 'village'],
];

export function createRider(world, opts = {}) {
  const path = world.path;
  const closed = !!path.closed;
  const L = path.length;
  const W = path.width;
  const forest = world.id === 'rainforest' || closed;
  const features = forest ? null : FJORD_FEATURES;

  const cfg = {
    lane: Math.min(W * 0.22, 1.8),      // 被动巡航的偏右车道
    edgeMargin: forest ? 0.8 : 1.5,     // 路面外缘 = W/2 + 路肩；到此处高速/外冲 → 撞边摔倒
    edgeCrashV: 9,                      // 触边时总速度超过则摔
    edgeCrashLat: 2.2,                  // 触边时朝外横向速度超过则摔
    endStop: 45,                        // 峡湾：距终点多少米开始自动减速（终点淡出）
    startSpeed: 3.0,
    slopeScale: forest ? 0.8 : 1,       // 雨林步道起伏较陡，沿坡重力略打折
    gripScale: () => 1,                 // 天气抓地系数（下雨 0.8），由 skate.js 注入
    ...opts,
  };

  const st = {
    s: 0, lateral: 0, speed: 0,
    braking: false, steer: 0, lean: 0, crouch: 0, grounded: true,
    surface: forest ? 'dirt' : 'asphalt',
    position: new THREE.Vector3(),
    heading: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    throttle: 0, motorLoad: 0,
    airborne: false, airTime: 0, vy: 0, landing: 0,
    lateralG: 0, grip: 0, wobble: 0,
    fallen: false, fall: null,
    inTunnel: false, onBridge: false, feature: null,
    // 兼容旧字段（电动板已废弃）
    pushing: false, pushPhase: 0,
    // 附加
    latVel: 0, skid: 0, slip: 0, sliding: false, slideInput: false, boardYaw: 0, travelYaw: 0,
    boardHeading: new THREE.Vector3(0, 0, -1),
    grade: 0, accel: 0, kappa: 0, finishing: false, finished: false, speedT: 0, yawRate: 0,
  };

  // 内部量
  // v = 沿路速度，vl = 横向速度（右正），alpha = 板头相对路切线的角度（右正）
  let v = 0, vl = 0, alpha = 0, slipping = false, slideDir = 0, brakeLvl = 0, idleSteer = 99;
  let curSlide = false, finEmitted = false;
  let parked = false, revDist = 0;
  let held = false;                         // inp.hold：坐在板上，板被"按住"不动（下坡也不溜）
  let u = 0, yb = 0, vy = 0, airCool = 0, upSeen = false;   // 腾空：水平速度、板高、竖直速度
  let scrape = 0, wobbleBase = 0, wobblePulse = 0, wobbleArmed = true;
  let fs = null;                            // 摔倒内部状态
  let rand = 12345;
  const rnd = () => { rand = (rand * 1664525 + 1013904223) >>> 0; return rand / 4294967296; };

  const T = new THREE.Vector3(), Ta = new THREE.Vector3(), Tb = new THREE.Vector3(), C = new THREE.Vector3();
  const right = new THREE.Vector3(), hDir = new THREE.Vector3(), up = new THREE.Vector3(), tAir = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const listeners = {};
  const emit = (name) => { const a = listeners[name]; if (a) for (const f of a) f(st); };
  const on = (name, fn) => { (listeners[name] ||= new Set()).add(fn); return () => listeners[name].delete(fn); };

  const wrapS = (s) => (closed ? ((s % L) + L) % L : clamp(s, 0, L));
  const roadY = (s) => path.pointAt(wrapS(s), C).y;

  function surfaceFor(s, lat) {
    const r = path.surfaceAt?.(s, lat);
    if (r) return r;
    if (Math.abs(lat) > W / 2 + 0.05) return 'gravel';
    return forest ? 'dirt' : 'asphalt';
  }
  const ROLL = { asphalt: 0.012, gravel: 0.05, dirt: 0.03 };

  function featureAt(s) {
    if (!features) return null;
    for (const [a, b, n] of features) if (s >= a && s < b) return n;
    return null;
  }

  /** 路径水平曲率（右转为正，1/m），在 s 附近 ±3 m 上取。 */
  function curvatureAt(s) {
    path.tangentAt(wrapS(s - 3), Ta);
    path.tangentAt(wrapS(s + 3), Tb);
    const cy = Ta.z * Tb.x - Ta.x * Tb.z;
    const dot = Ta.x * Tb.x + Ta.z * Tb.z;
    return Math.atan2(-cy, dot) / 6;
  }

  /** 由状态重算位姿（position / heading / up）。 */
  function pose(withYaw = true) {
    const s = st.s;
    path.tangentAt(s, T);
    hDir.set(T.x, 0, T.z);
    if (hDir.lengthSq() < 1e-8) hDir.set(0, 0, -1);
    hDir.normalize();
    right.set(-hDir.z, 0, hDir.x);
    path.pointAt(s, C);
    const lat = st.lateral;
    const px = C.x + right.x * lat, pz = C.z + right.z * lat;
    let y = st.airborne ? yb : C.y;
    const k = smoothstep(W / 2 + 0.3, W / 2 + 2.5, Math.abs(lat));
    if (k > 0) y += k * (world.heightAt(px, pz) - world.heightAt(C.x, C.z));
    if (st.airborne) {
      // 板头顺着抛物线切向
      tAir.set(hDir.x * u, vy, hDir.z * u);
      if (tAir.lengthSq() < 1e-6) tAir.copy(T);
      tAir.normalize();
      up.crossVectors(right, tAir).normalize();
      st.heading.copy(tAir);
    } else {
      up.crossVectors(right, T).normalize();
      st.heading.copy(T);
    }
    st.position.set(px, y, pz).addScaledVector(up, BOARD_LIFT);
    st.boardHeading.copy(st.heading);
    if (withYaw && !st.fallen) {
      // heading = 行进方向（镜头跟它），boardHeading = 板头方向（侧滑时两者分开）
      const beta = Math.atan2(vl, Math.max(Math.abs(v), 1.5));
      st.travelYaw = beta; st.boardYaw = alpha;
      tmpQ.setFromAxisAngle(up, -clamp(beta, -0.6, 0.6));
      st.heading.applyQuaternion(tmpQ);
      tmpQ.setFromAxisAngle(up, -alpha);
      st.boardHeading.applyQuaternion(tmpQ);
    }
    st.up.copy(up);
  }

  /** quiet = true：不发 'start'（步行 → 上板时用，不重置这一程的光点 / 计时）。 */
  function place(s, lateral = cfg.lane, speed = cfg.startSpeed, quiet = false) {
    held = false;
    st.s = wrapS(s); st.lateral = lateral; v = speed; vl = 0; alpha = 0; slipping = false; slideDir = 0;
    st.slip = 0; st.sliding = false; st.skid = 0; finEmitted = false;
    st.speed = v; st.lean = 0; st.steer = 0; st.crouch = 0; st.throttle = 0; st.motorLoad = 0;
    st.finishing = false; st.finished = false; st.grounded = true; st.airborne = false;
    st.airTime = 0; st.vy = 0; st.landing = 0; st.lateralG = 0; st.grip = 0; st.wobble = 0;
    st.fallen = false; st.fall = null; st.accel = 0; st.braking = false;
    fs = null; brakeLvl = 0; idleSteer = 99; parked = false; revDist = 0;
    scrape = 0; wobbleBase = 0; wobblePulse = 0; wobbleArmed = true; airCool = 0; u = 0; vy = 0;
    st.inTunnel = !!path.isTunnel?.(st.s); st.onBridge = !!path.isBridge?.(st.s); st.feature = featureAt(st.s);
    pose(false);
    if (!quiet) emit('start');
  }

  /* ------------------------------------------------------------ 摔倒 */
  /** 摔倒。kind: 'edge'（侧滑/冲出撞上路边、隧道壁、桥栏）或 'land'（落地太重/板横着落地）。side = 外侧（±1），impact = 撞击的朝外横向速度。 */
  function startFall(kind, side, impact = 0) {
    if (fs) return;
    const speedNow = Math.abs(v);
    const slide = clamp(speedNow * 0.4 + impact * 1.5, 2, 9);   // 冲击越大滑得越远
    if (!side) side = st.lateral >= 0 ? 1 : -1;
    const lat1 = clamp(st.lateral + side * 0.4, -(edgeAt() + 0.2), edgeAt() + 0.2);
    fs = { s0: st.s, lat0: st.lateral, lat1, slide, t: 0, kind };
    st.fallen = true;
    st.fall = { t: 0, phase: 'tumble', slide, side, kind };
    st.wobble = 0; wobbleBase = 0; wobblePulse = 0;
    st.throttle = 0; st.motorLoad = 0; brakeLvl = 0; st.braking = false;
    st.airborne = false; st.airTime = 0;
    vl = 0; alpha = 0; slipping = false; slideDir = 0; st.skid = 0; st.slip = 0; st.sliding = false;
    scrape = 0; st.lean = 0; st.crouch = 0; st.steer = 0;
    v = 0;
    emit('fall');
  }

  /** 路面外缘（|lateral| 上限）：隧道 = 半宽 + 1.0，桥 = 半宽 + 0.5，路肩 1.5（雨林步道 0.8）。 */
  function edgeAt() {
    const m = path.isTunnel?.(st.s) ? 1.0 : path.isBridge?.(st.s) ? 0.5 : cfg.edgeMargin;
    return W / 2 + Math.min(m, cfg.edgeMargin);
  }

  function fallStep(dt) {
    fs.t += dt;
    const f = st.fall;
    f.t = fs.t;
    let prevS = st.s;
    if (fs.t < TUMBLE) {
      f.phase = 'tumble';
      const x = fs.t / TUMBLE;
      const e = 1 - (1 - x) ** 3;
      st.s = wrapS(fs.s0 + fs.slide * e);
      st.lateral = lerp(fs.lat0, fs.lat1, smoothstep(0, 1, x));
    } else if (fs.t < TUMBLE + LIE) {
      f.phase = 'lie';
    } else if (fs.t < TUMBLE + LIE + GETUP) {
      if (f.phase !== 'getup') { f.phase = 'getup'; emit('getup'); }
      const x = (fs.t - TUMBLE - LIE) / GETUP;
      st.lateral = lerp(fs.lat1, cfg.lane, smoothstep(0.2, 1, x));
    } else {
      // 爬起来：速度 0，车道中间继续
      st.fallen = false; st.fall = null; fs = null;
      st.lateral = cfg.lane; v = 0; vl = 0; alpha = 0; parked = false; revDist = 0;
      return;
    }
    const sp = dt > 0 ? Math.abs(st.s - prevS) / dt : 0;
    v = sp; st.speed = sp;
  }

  /**
   * 自动巡航（玩家完全不操作时）像一个稳妥的骑手：看前方 70 m 的弯道，
   * 速度超过该弯"抓地允许速度的 75%"且快来不及刹时，就踩脚刹。玩家一旦操作就完全交还控制。
   */
  function autoBrake() {
    const gs = cfg.gripScale?.() ?? 1;
    const V = Math.abs(v);
    for (let d = 0; d <= 70; d += 5) {
      const k = Math.abs(curvatureAt(st.s + d));
      if (k < 2e-3) continue;
      const vs = Math.sqrt((0.75 * MU_S * gs * G) / k);
      if (V > vs && V * V - vs * vs > 2 * (BRAKE_DECEL * 0.8) * Math.max(0, d - 8)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 主步进 */
  function sub(dt, inp) {
    const noInput = st.fallen;
    // 输入平滑
    const steerRaw = noInput || st.airborne ? 0 : clamp(inp.steer || 0, -1, 1);
    st.steer += (steerRaw - st.steer) * damp(Math.abs(steerRaw) > Math.abs(st.steer) ? 7 : 9, dt);
    if (Math.abs(steerRaw) > 0.06) idleSteer = 0; else idleSteer += dt;

    const thrTarget = noInput ? 0 : clamp(inp.throttle ?? (inp.push ? 1 : 0), 0, 1);
    const dThr = thrTarget - st.throttle;
    st.throttle += clamp(dThr, -THROTTLE_DOWN * dt, THROTTLE_UP * dt);

    const brakeWant = !noInput && !st.airborne && (!!inp.brake || (!!inp.auto && autoBrake()));
    brakeLvl += ((brakeWant ? 1 : 0) - brakeLvl) * damp(7, dt);
    st.braking = brakeLvl > 0.3;
    st.crouch += ((noInput ? 0 : (inp.crouch ? 1 : 0)) - st.crouch) * damp(6, dt);
    curSlide = !noInput && !!inp.slide;
    st.slideInput = curSlide;

    st.landing = Math.max(0, st.landing - dt * 2.2);
    wobblePulse = Math.max(0, wobblePulse - dt * 1.4);

    if (fs) { fallStep(dt); if (fs) { commonEnd(dt, 0); return; } }

    // 坐下：速度已经很低时把板按住（v = 0，不受坡度影响）；松开后像停稳一样等净推力再起步
    if (inp.hold && !st.airborne && (held || Math.hypot(v, vl) < 0.3)) { holdStep(dt); commonEnd(dt, 0); return; }
    if (held) { held = false; if (!st.finishing) parked = true; revDist = 0; }

    if (st.airborne) airStep(dt); else groundStep(dt);
    commonEnd(dt, 0);
  }

  function holdStep(dt) {
    held = true;
    v = 0; vl = 0; slipping = false; slideDir = 0; brakeLvl = 0; scrape = 0;
    alpha *= 1 - damp(3, dt);
    st.speed = 0; st.latVel = 0; st.braking = false; st.throttle = 0;
    st.accel += (0 - st.accel) * damp(6, dt);
    st.motorLoad += (0 - st.motorLoad) * damp(6, dt);
    st.lean += (0 - st.lean) * damp(4, dt);
    st.lateralG = 0; st.grip = 0; st.slip = 0; st.skid = 0; st.sliding = false; st.yawRate = 0;
    wobbleBase += (0 - wobbleBase) * damp(3, dt);
  }

  function commonEnd(dt) {
    st.inTunnel = !!path.isTunnel?.(st.s);
    st.onBridge = !!path.isBridge?.(st.s);
    st.feature = featureAt(st.s);
    st.grounded = !st.airborne && !st.fallen;
    if (st.finished && !finEmitted) { finEmitted = true; emit('finish'); }
    const wob = Math.max(wobbleBase, wobblePulse);
    st.wobble = st.fallen ? 0 : wob;
    if (wob > 0.2 && wobbleArmed && !st.fallen) { wobbleArmed = false; emit('wobbleStart'); }
    else if (wob < 0.06) wobbleArmed = true;
  }

  function groundStep(dt) {
    const s = st.s;
    path.tangentAt(s, T);
    const sinT = T.y;
    const cosT = Math.sqrt(Math.max(0.01, 1 - sinT * sinT));
    const slopeM = sinT / cosT;
    st.grade = sinT;
    const speedT = clamp(Math.abs(v) / 12, 0, 1);
    st.speedT = speedT;

    if (!closed && s > L - cfg.endStop) st.finishing = true;
    st.surface = surfaceFor(s, st.lateral);
    const crr = (ROLL[st.surface] ?? 0.03) * G * cosT;

    /* ---- 纵向力 ---- */
    const f = Math.pow(clamp(1 - Math.max(v, 0) / MOTOR_V, 0, 1), 1.2);
    const thrust = st.throttle * THRUST0 * f;
    const aGrav = -G * sinT * cfg.slopeScale;
    const cda = CDA_STAND * (1 - CDA_CROUCH_CUT * st.crouch);
    const aDrag = -(0.5 * RHO * cda * v * Math.abs(v)) / MASS;
    const aBrake = -Math.sign(v) * BRAKE_DECEL * brakeLvl * Math.min(1, Math.abs(v) / 0.5);
    let aFin = 0;
    if (st.finishing && v > 0.2) aFin = -Math.max(0.5, (v * v) / (2 * Math.max(0.8, L - 3 - s)));
    const aExt = aGrav + thrust;                       // 不含阻力的合力（停住判定用）
    let a;
    if (parked) {
      // 上坡停住后不再倒溜；等到有净向前力才起步
      v = 0; a = 0;
      if (aExt > crr * 1.05 && !st.finishing) { parked = false; revDist = 0; }
    } else {
      a = aExt + aDrag + aBrake + aFin - crr * Math.tanh(v / 0.15) - 2.5 * scrape * Math.min(1, Math.abs(v) / 0.5);
      if (v < 0) a += 1.2;                              // 倒溜时的小阻尼
      if (Math.abs(v) < 0.05 && Math.abs(aExt) <= crr) { v = 0; a = 0; }
    }
    // 抬头的坡上电机（motorLoad）
    const loadT = st.throttle * clamp(0.22 + 0.7 * f + Math.max(0, sinT) * 5, 0, 1);
    st.motorLoad += (loadT - st.motorLoad) * damp(6, dt);

    const vPrev = v;
    v = clamp(v + a * dt, -3, 40);
    if (v < 0) {
      revDist += -v * cosT * dt;
      if (revDist > 2.0) { v = 0; parked = true; }
    } else if (v > 0.1) revDist = 0;
    if (st.finishing && v > 0 && v < 0.15 && a < 0) { v = 0; st.finished = true; }

    // 纵向加速度（相机用）
    st.accel += ((v - vPrev) / dt - st.accel) * damp(8, dt);

    /* ---- 腾空判定：路面下落比抛物线快 ---- */
    if (airCool > 0) airCool -= dt;
    else if (v > 4) {
      const uh = v * cosT;
      const y0 = roadY(s), y1 = roadY(s + 2), y2 = roadY(s - 2);
      const ypp = (y1 - 2 * y0 + y2) / 4;
      const ydd = ypp * uh * uh;      // 自由飞行时水平加速度为 0
      // 离开坡顶时的竖直速度按"坡顶前一小段"的坡度算（板是顺着跳台唇口飞出去的）
      const mLip = (y0 - roadY(s - 1.5)) / 1.5;
      if (ydd < -G * 0.85 && flightGap(s, uh, mLip * uh, y0) > 0.01) {
        st.airborne = true; st.airTime = 0; upSeen = false;
        u = uh; vy = mLip * uh; yb = y0; st.vy = vy;
        emit('takeoff');
        airStep(dt);
        return;
      }
    }

    /* ---- 沿路前进 ---- */
    let ns = st.s + v * cosT * dt;
    if (closed) ns = wrapS(ns);
    else if (ns > L - 1.5) { ns = L - 1.5; v = 0; st.finished = true; }
    else if (ns < 0) { ns = 0; v = 0; parked = true; }
    st.s = ns;
    st.speed = Math.abs(v);

    /* ---- 横向：板头方向 + 轮子库仑摩擦 ---- */
    lateralDynamics(dt, cosT, Math.abs(aDrag) + crr + BRAKE_DECEL * brakeLvl);
    if (edgeCheck(dt)) return;
  }

  /**
   * 横向动力学（路面坐标系）：
   *  - 骑手（或自动巡航）通过压板控制板头转向角速度 wBoard（受倾角/桥架几何限制）；
   *  - 路面在脚下以 wRoad = κ·v 转向，所以沿路/横向速度会互相旋转；
   *  - 轮子只能沿板头方向滚动，垂直于板头的速度由摩擦消掉：需要的横向加速度 ≤ μs·g 就抓地，
   *    超过则侧滑，侧滑时摩擦降为 μk·g（弯道太快 → 板甩出去、同时擦掉速度）。
   * 正常压弯（换线）只用到 ~0.45 g，所以只有"弯道本身要求 > 抓地"时才会滑。
   */
  function lateralDynamics(dt, cosT, resistA) {
    const kap = curvatureAt(st.s);
    const kEff = kap / Math.max(0.35, 1 - kap * st.lateral);
    st.kappa = kEff;
    const wRoad = kEff * v;
    // 1) 路面转向带来的坐标旋转
    const v0 = v;
    v += wRoad * vl * dt;
    vl -= wRoad * v0 * dt;
    // 2) 阻力（风阻/滚阻/刹车）同样作用在横向分量上
    let V = Math.hypot(v, vl);
    if (V > 0.05) vl -= (vl / V) * Math.min(Math.abs(vl), resistA * dt);

    // 3) 板头控制
    const beta = Math.atan2(vl, Math.max(Math.abs(v), 0.5));
    const autoBlend = smoothstep(1.0, 2.6, idleSteer) * clamp(V / 1.5, 0, 1);
    const look = Math.max(4, 1.1 * V);
    const aAuto = clamp(Math.atan2(cfg.lane - st.lateral, look), -0.35, 0.35);
    const aMax = clamp(Math.atan2(3.6, Math.max(V, 2)), 0.12, 0.9);
    let aT = lerp(st.steer * aMax, aAuto, autoBlend);
    // 路缘：离边还剩"刹住横移所需的距离"时，主动把板头拧回路面（普通换线不会自己压到路边）
    const side = Math.sign(st.lateral) || 1;
    const vOut = Math.max(0, side * vl);
    const margin = Math.max(0.9, (vOut * vOut) / (2 * CARVE_G * G) + 0.5);
    const ex = Math.abs(st.lateral) - (edgeAt() - margin);
    if (ex > 0) aT = lerp(aT, -side * 0.3, clamp(ex / 0.8, 0, 1));
    const wantSlide = curSlide && V > 3;
    if (wantSlide) {
      // 侧滑刹车：板横过来，动摩擦 μk·g 擦掉速度。板与行进方向的夹角 θ 决定摩擦力的横向分量
      // （推力 = sign(θ)·μk·g·cosθ），骑手用它跟住弯道 + 回到车道：θ = acos(需要的横向加速度 / μk·g)
      if (!slideDir) slideDir = Math.sign(st.steer) || Math.sign(kEff) || 1;
      const muK = MU_K * (cfg.gripScale?.() ?? 1);
      const latT = lerp(st.lateral + st.steer * 2, cfg.lane, autoBlend);
      const aNeed = v * v * kEff + clamp(1.2 * (latT - st.lateral) - 1.8 * vl, -3, 3);
      const c = clamp((slideDir * aNeed) / (muK * G), Math.cos(2.35), Math.cos(0.8));
      aT = beta + slideDir * Math.acos(c) * clamp((V - 2) / 3, 0.4, 1);
    } else slideDir = 0;

    const ca0 = Math.cos(alpha), sa0 = Math.sin(alpha);
    const Vp = Math.max(Math.abs(v * ca0 + vl * sa0), 0.5);
    // 板和行进方向错开（刚松开侧滑 / 侧滑中）时，骑手会迅速把板摆回行进方向
    const recovering = !wantSlide && Math.abs(alpha - beta) > 0.25;
    if (recovering) aT = beta;
    let wRel = (wantSlide ? 7 : recovering ? 5 : 3.2) * (aT - alpha);
    if (!wantSlide && !recovering) wRel = clamp(wRel, -CARVE_G * G / Vp, CARVE_G * G / Vp);
    let wBoard = wRoad + wRel;
    if (wantSlide || recovering) wBoard = clamp(wBoard, -4, 4);
    else { const wMax = Math.min((LEAN_MAX_G * G) / Vp, Vp / TRUCK_R); wBoard = clamp(wBoard, -wMax, wMax); }
    alpha += (wBoard - wRoad) * dt;
    if (V < 1.2) alpha *= 1 - damp(3, dt);            // 几乎停住时板头回正
    alpha = clamp(alpha, -2.4, 2.4);

    // 4) 轮子摩擦：只消掉垂直于板头的速度
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const vpar = v * ca + vl * sa;
    let vperp = -v * sa + vl * ca;
    const surfK = st.surface === 'gravel' ? 0.65 : st.surface === 'dirt' ? 0.8 : 1;
    const gs = (cfg.gripScale?.() ?? 1) * surfK;
    const dv = (slipping ? MU_K : MU_S) * gs * G * cosT * dt;
    if (Math.abs(vperp) <= dv) { vperp = 0; slipping = false; }
    else { vperp -= Math.sign(vperp) * dv; slipping = true; }
    v = vpar * ca - vperp * sa;
    vl = vpar * sa + vperp * ca;

    // 5) 横向位移
    st.lateral += vl * dt;
    st.latVel = vl;
    const aLat = wBoard * vpar;                        // 骑手在要的横向加速度（右正）
    st.lateralG = Math.abs(aLat);
    st.grip = st.lateralG / (MU_S * gs * G);
    const slip = Math.abs(vperp);
    st.slip = slip; st.skid = vperp;
    st.sliding = slip > 0.4;
    st.yawRate = wBoard;
    V = Math.hypot(v, vl);
    st.speed = V;
    const speedT = clamp(V / 12, 0, 1);
    wobbleBase += (clamp((slip - 0.3) / 2.5, 0, 1) - wobbleBase) * damp(slip > 0.3 ? 6 : 2, dt);

    /* ---- 倾斜：压弯倾角 = atan(横向加速度 / g)；侧滑时身体后仰抵住 ---- */
    const leanTarget = clamp(0.85 * Math.atan(aLat / G) + st.steer * 0.08 * speedT, -0.6, 0.6);
    st.lean += (leanTarget - st.lean) * damp(6, dt);
  }

  /** 撞边判定：侧滑/冲出到路面外缘时，朝外横向速度 > 2.2（或高速且仍在往外冲）→ 摔倒；否则蹭边减速被推回。 */
  function edgeCheck(dt) {
    const edge = edgeAt();
    const a = Math.abs(st.lateral);
    scrape = Math.max(0, scrape - dt * 4);
    if (a < edge) return false;
    const side = Math.sign(st.lateral);
    const vo = side * vl;
    const V = Math.hypot(v, vl);
    if (!st.airborne && (vo > cfg.edgeCrashLat || (V > cfg.edgeCrashV && vo > 0.8))) {
      st.lateral = side * edge;
      startFall('edge', side, Math.max(0, vo));
      return true;
    }
    st.lateral = side * edge;
    if (vo > 0) {
      // 蹭着路缘被挡回：横向速度归零，板头顺着路（速度与板头一致，不会凭空产生侧滑）
      vl = 0;
      if (side * alpha > 0) alpha = 0;
    }
    scrape = 1;
    return false;
  }

  /** 预演抛体飞行：返回飞行轨迹高出路面的最大间隙（m），用来避免路面折线噪声造成的伪腾空。 */
  function flightGap(s0, u0, vy0, y0) {
    let ss = s0, y = y0, vv = vy0, best = -1, up = false;
    for (let t = 0; t < 1.6; t += 0.025) {
      ss += u0 * 0.025; vv -= G * 0.025; y += vv * 0.025;
      if (!closed && ss > L - 2) break;
      const gap = y - roadY(ss);
      if (gap > best) best = gap;
      if (gap > 0.02) up = true;
      if (up && gap < 0) break;
      if (gap < -0.3) break;
    }
    return best;
  }

  function airStep(dt) {
    st.airTime += dt;
    // 抛体：重力 + 空气阻力，保留水平速度
    const cda = CDA_STAND * (1 - CDA_CROUCH_CUT * st.crouch);
    u = Math.max(0, u - ((0.5 * RHO * cda * u * u) / MASS) * dt);
    vy -= G * dt;
    yb += vy * dt;
    st.s = closed ? wrapS(st.s + u * dt) : Math.min(L - 1.5, st.s + u * dt);
    st.vy = vy;
    st.speed = Math.hypot(u, vy);
    st.accel += (0 - st.accel) * damp(4, dt);
    st.grade = 0;
    st.throttle += 0;
    st.motorLoad += (0 - st.motorLoad) * damp(6, dt);
    // 空中不能转向：横向速度保持，板头慢慢摆正到飞行方向
    st.lateral += vl * dt; st.latVel = vl;
    { const e = edgeAt(); if (Math.abs(st.lateral) > e) { st.lateral = Math.sign(st.lateral) * e; if (st.lateral * vl > 0) vl = 0; } }
    alpha += (Math.atan2(vl, Math.max(u, 0.5)) - alpha) * damp(1.5, dt);
    st.lean += (0 - st.lean) * damp(3, dt);
    st.lateralG = 0; st.grip = 0; st.slip = 0; st.sliding = false; st.skid = 0; slipping = false;
    wobbleBase += (0 - wobbleBase) * damp(3, dt);

    const y0 = roadY(st.s);
    if (yb - y0 > 0.02) upSeen = true;
    if ((yb <= y0 && upSeen) || yb < y0 - 0.08) {
      // 落地
      const y1 = roadY(st.s + 1.5), y2 = roadY(st.s - 1.5);
      const m = (y1 - y2) / 3;
      const cosT = 1 / Math.sqrt(1 + m * m), sinT = m * cosT;
      const impact = (m * u - vy) * cosT;               // 撞向路面的法向速度
      st.airborne = false;
      st.landing = clamp(impact / 8, 0, 1);
      v = Math.max(0, u * cosT + vy * sinT);
      st.vy = 0; vy = 0; yb = y0; airCool = 0.35;
      st.speed = v;
      emit('land');
      // 真实的摔法：落差太大腿扛不住，或板横着落地（轮子不能侧着滚）
      const yawOff = Math.abs(alpha - Math.atan2(vl, Math.max(v, 0.5)));
      if (impact > HARD_LAND || (yawOff > 0.7 && v > 5)) { startFall('land', st.lean >= 0 ? 1 : -1, 0); return; }
      if (impact > 6) wobblePulse = Math.max(wobblePulse, 1);
      else if (impact > 3.5) wobblePulse = Math.max(wobblePulse, 0.9);
      else if (impact > 2) wobblePulse = Math.max(wobblePulse, 0.35);
    } else if (st.airTime > 8) {
      st.airborne = false; v = u; yb = y0; vy = 0; st.vy = 0;
    }
  }

  function step(dt, inp = {}) {
    let left = Math.min(dt, 0.1);
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      sub(h, inp);
      left -= h;
    }
    pose(true);
  }

  place(0);
  return { state: st, step, place, cfg, on, get v() { return v; } };
}
