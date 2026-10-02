// 电动长板控制器：沿 world.path 的真实物理（重力/滚阻/风阻 + 电机），过弯太快会摔，凸坡腾空。
//   物理   → ./skate/physics.js（沿路一维 + 横向，纯数学）
//   镜头   → ./skate/camera.js （弹簧臂第三人称 + 坐姿机位 + 第一人称，纯数学）
//   人物   → ../skater/character.js 的 createSkater（缺失时用 ./skate/placeholder.js）
//
// 操作：W 电机油门 · S 脚刹 · 空格 侧滑减速 · A/D（或 ←/→）转弯 · Shift 下蹲 · 鼠标环顾
//       B 下板步行 / 上板（有步行控制器的场景；离公路远时淡出淡入、回到最近的公路）
//       C 坐下 / 站起（速度高时先自动刹停再坐；任何移动键也会站起）
//       V 第三人称 / 第一人称（记住选择；摔倒时自动切回第三人称看摔倒，爬起后切回）
// 触屏：左半屏左右拖动转弯 · 右半屏拖动环顾 · 右下角按钮油门/刹车/坐下/视角
// 事件：skate.on('takeoff'|'land'|'fall'|'getup'|'wobbleStart'|'start'|'finish', fn)，回调参数 = rideState
// 约定同 player.js：enabled / inputEnabled / requestLock / exitLock。
//
// 坐下契约（人物模块读）：ride.sitting（0..1 平滑值）、ride.sitMode = 'board'。
// 视角：state 'skateView' = 'third' | 'first'；坐姿：state 'sit' = '' | 'pending' | 'board'（UI 用来收起 HUD）。
// 人物可选接口：skater.setFirstPerson?.(on)（隐藏头 / 帽 / 背包）；有名为 'head' 的骨骼时用它定眼睛位置。
import { createRider } from './skate/physics.js';
import { createChaseCam, createFirstPersonCam, FOV_MIN } from './skate/camera.js';
import { createPlaceholderSkater } from './skate/placeholder.js';
import { t, onLang } from '../core/i18n.js';

// 人物模块是可选的：用 glob 让构建在缺文件时也能通过
const SKATER_MODULES = import.meta.glob('../skater/character.js');

const MOUSE_SENS = 0.0022;
const TOUCH_LOOK_SENS = 0.0048;
const TOUCH_STEER_RANGE = 70;      // 触屏转弯：拖动多少像素 = 满舵
const LOOK_YAW_LIMIT = 2.8;
const LOOK_PITCH = { third: [-0.35, 0.45], first: [-1.2, 0.85] };
const RECENTER_DELAY = 1.2;        // 松开后多久镜头开始回正 (s)
const BLEND_IN = 1.1;              // 步行 → 滑板 镜头过渡 (s)
const BLEND_OUT = 1.0;             // 滑板 → 步行
const WALK_FOV = 62;               // 步行镜头 FOV（相机初始值）
const FAR_BOARD = 6;               // 上板点离人超过它（m）就淡出淡入，而不是镜头平移
const FADE_OUT = 0.4, FADE_IN = 0.55;
const SIT_STOP_V = 0.3;            // 速度低于它才坐下（否则先自动刹车）
const VIEW_KEY = 'rainforest.skateView.v1';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const isTextInput = (el) =>
  !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
    (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox' && el.type !== 'button'));
const isButton = (el) => !!el && (el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'button');
const readView = () => { try { const v = localStorage.getItem(VIEW_KEY); return v === 'first' ? 'first' : 'third'; } catch { return 'third'; } };

export function createSkate(ctx) {
  const { THREE, camera, world, state } = ctx;
  const canvas = ctx.renderer?.domElement || document.getElementById('view');
  const loadingEl = document.getElementById('loading');
  const canWalk = !!ctx.player;                 // 有步行控制器的场景（雨林、峡湾）
  const path = world.path;

  const rider = createRider(world, {
    // 下雨路面抓地 ×0.8（rain 0.5 以上即满额）
    gripScale: () => 1 - 0.2 * clamp((state.get('rain') || 0) / 0.5, 0, 1),
  });
  const chase = createChaseCam(THREE, world, camera);
  const fpCam = createFirstPersonCam(THREE, world);
  const ride = rider.state;
  ride.sitting = 0;
  ride.sitMode = 'board';

  /* ------------------------------------------------------------ 人物 */
  let skater = createPlaceholderSkater(ctx);
  let headBone;                       // undefined = 还没找；null = 没有（占位人物）
  let fpShown = null;                 // 上次传给 setFirstPerson 的值
  ctx.scene.add(skater.root);
  const loadSkater = SKATER_MODULES['../skater/character.js'];
  if (loadSkater) {
    loadSkater().then(async (m) => {
      if (typeof m.createSkater !== 'function') return;
      const real = await m.createSkater(ctx);
      if (!real?.root) return;
      const old = skater;
      skater = real;
      headBone = undefined; fpShown = null;
      if (!skater.root.parent) ctx.scene.add(skater.root);
      skater.root.visible = skate.enabled;
      old.root.parent?.remove(old.root);
      old.dispose?.();
    }).catch((e) => console.warn('[skate] createSkater 失败，使用占位人物：', e));
  }

  /* ------------------------------------------------------------ 输入 */
  const keys = new Set();
  let shift = false;
  let lookYaw = 0, lookPitch = 0, lastLookAt = -99;
  let idle = 0;                       // 无输入秒数（电影机位用）
  let touchSteer = 0, touchThrottle = false, touchBrake = false;
  let steerTouch = null, lookTouch = null, isTouch = false, mouseDragging = false;
  let btnPush = null, btnBrake = null, btnSit = null, btnView = null;
  let clockT = 0;

  // 视角
  let view = readView();
  state.set('skateView', view);
  let fpW = view === 'first' ? 1 : 0;   // 第一人称混合权重（摔倒时回到 0）

  // 坐下：0 无；1 刹车中（等停稳）；2 坐着；3 正在站起（板仍按住，直到 sitting 足够小）
  let sitPhase = 0;

  const skate = {
    _rider: rider,           // debug/test hook (headless checks place the rider)
    get _skater() { return skater; },
    enabled: false,
    inputEnabled: true,      // false = 忽略输入（开场遮罩期间），巡航与镜头照常
    cinematic: true,         // 空闲 20 s 后进入电影机位（可关）
    state: ride,
    on: rider.on,            // 事件订阅：返回取消函数
    get locked() { return document.pointerLockElement === canvas; },
    get isTouch() { return isTouch; },
    get view() { return view; },
    get sitting() { return ride.sitting; },
    setView,
    toggleView() { setView(view === 'first' ? 'third' : 'first'); },
    toggleSit,
    update,
    respawn,
    requestLock() {
      if (!canvas?.requestPointerLock) return;
      try {
        const r = canvas.requestPointerLock({ unadjustedMovement: true });
        if (r && r.catch) r.catch(() => { try { const r2 = canvas.requestPointerLock(); r2?.catch?.(() => {}); } catch { /* ignore */ } });
      } catch {
        try { canvas.requestPointerLock(); } catch { /* ignore */ }
      }
    },
    exitLock() { try { document.exitPointerLock?.(); } catch { /* ignore */ } },
    dispose,
  };

  const active = () => skate.enabled && skate.inputEnabled;
  const poke = () => { idle = 0; };
  const pitchLim = () => LOOK_PITCH[view] || LOOK_PITCH.third;

  function setView(v) {
    v = v === 'first' ? 'first' : 'third';
    if (state.get('skateView') !== v) { state.set('skateView', v); return; }   // 经由 state（UI 按钮同样走这里）
    if (v === view) return;
    view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* 隐私模式 */ }
    const [lo, hi] = pitchLim();
    lookPitch = clamp(lookPitch, lo, hi);
    if (v === 'first') fpCam.snap();
    poke();
  }
  const offView = state.on('skateView', (v) => setView(v));

  /* 坐下 / 站起 */
  function toggleSit() {
    if (!skate.enabled || !skate.inputEnabled) return;
    if (sitPhase === 0) {
      if (ride.fallen || endPhase !== 0) return;
      sitPhase = 1;
    } else if (sitPhase === 1) sitPhase = 0;
    else if (sitPhase === 2) sitPhase = 3;
    else if (sitPhase === 3) sitPhase = 2;
    poke();
  }
  const standUp = () => { if (sitPhase === 1) sitPhase = 0; else if (sitPhase === 2) sitPhase = 3; };

  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
  const onKeyDown = (e) => {
    const t = e.target;
    if (isTextInput(t)) return;
    if (t && t.tagName === 'INPUT' && t.type === 'range' && e.code.startsWith('Arrow')) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (e.code === 'KeyB') {   // 步行 <-> 滑板
      const ok = skate.enabled ? skate.inputEnabled : ctx.player?.inputEnabled !== false;
      if (!e.repeat && canWalk && ok && !mod && !swap) state.set('mode', skate.enabled ? 'walk' : 'skate');
      return;
    }
    if (!active()) return;
    if (e.code === 'KeyC') { if (!e.repeat && !mod) toggleSit(); return; }
    if (e.code === 'KeyV') { if (!e.repeat && !mod) skate.toggleView(); return; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { shift = true; poke(); return; }
    if (MOVE_KEYS.has(e.code)) {
      if (e.code === 'Space' && isButton(t)) return;
      keys.add(e.code);
      poke();
      if (!e.repeat) standUp();
      if ((e.code === 'Space' || e.code.startsWith('Arrow')) && (skate.locked || e.code === 'Space')) e.preventDefault();
    }
  };
  const onKeyUp = (e) => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shift = false;
    keys.delete(e.code);
  };
  const clearInput = () => {
    keys.clear(); shift = false;
    steerTouch = null; lookTouch = null; touchSteer = 0; touchThrottle = false; touchBrake = false;
  };
  const onBlur = clearInput;

  const onMouseMove = (e) => {
    if (!active()) return;
    if (!skate.locked && !(mouseDragging && e.buttons)) return;
    const dx = clamp(e.movementX || 0, -180, 180);
    const dy = clamp(e.movementY || 0, -180, 180);
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    const [lo, hi] = pitchLim();
    lookYaw = clamp(lookYaw - dx * MOUSE_SENS, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
    lookPitch = clamp(lookPitch - dy * MOUSE_SENS, lo, hi);
    lastLookAt = clockT;
    poke();
  };
  const onCanvasPointerDown = (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (!active()) return;
    mouseDragging = true;
    if (!skate.locked) skate.requestLock();
    poke();
  };
  const onPointerUpAny = (e) => { if (e.pointerType === 'mouse') mouseDragging = false; };
  const onLockChange = () => { if (!skate.locked) { keys.clear(); shift = false; } };

  // 触屏
  function ensureButtons() {
    if (btnPush) return;
    const mk = (label, bottom, onDown, onUp, size = 66) => {
      const b = document.createElement('div');
      b.setAttribute('role', 'button');
      b.textContent = label;
      b.style.cssText =
        `position:fixed;z-index:5;right:${18 + (66 - size) / 2}px;bottom:${bottom}px;width:${size}px;height:${size}px;border-radius:50%;` +
        `display:grid;place-items:center;font:500 ${size < 60 ? 13 : 15}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif;` +
        'color:rgba(255,255,255,.92);background:rgba(20,30,40,.32);border:1px solid rgba(255,255,255,.35);' +
        'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);touch-action:none;user-select:none;' +
        '-webkit-user-select:none;pointer-events:auto;transition:opacity .3s ease,transform .1s ease;';
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        b.style.transform = 'scale(.93)';
        onDown(); poke();
      });
      const up = () => { b.style.transform = ''; onUp(); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      (document.getElementById('ui-root') || document.body).appendChild(b);
      return b;
    };
    btnPush = mk(t('touch.throttle'), 112, () => { touchThrottle = true; standUp(); }, () => { touchThrottle = false; });
    btnBrake = mk(t('touch.brake'), 192, () => { touchBrake = true; standUp(); }, () => { touchBrake = false; });
    btnSit = mk(t('touch.sit'), 276, () => toggleSit(), () => {}, 52);
    btnView = mk(t('touch.view'), 340, () => skate.toggleView(), () => {}, 52);
    onLang(() => {
      btnPush.textContent = t('touch.throttle'); btnBrake.textContent = t('touch.brake');
      btnView.textContent = t('touch.view'); labelSit(true);
    });
  }
  let sitLabel = null;
  function labelSit(force) {
    if (!btnSit) return;
    const l = sitPhase === 2 ? 'touch.stand' : 'touch.sit';
    if (force || l !== sitLabel) { sitLabel = l; btnSit.textContent = t(l); }
  }
  const showButtons = (on) => {
    for (const b of [btnPush, btnBrake, btnSit, btnView]) if (b) { b.style.opacity = on ? '1' : '0'; b.style.pointerEvents = on ? 'auto' : 'none'; }
  };
  const onTouchDown = (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    isTouch = true;
    if (skate.enabled) { ensureButtons(); showButtons(true); }
    if (e.target && e.target.closest && e.target.closest('#ui-root')) return;
    if (!active()) return;
    poke();
    if (e.clientX < innerWidth * 0.5) {
      if (!steerTouch) { steerTouch = { id: e.pointerId, x0: e.clientX }; standUp(); }
    } else if (!lookTouch) {
      lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  };
  const onTouchMove = (e) => {
    if (steerTouch && e.pointerId === steerTouch.id) {
      touchSteer = clamp((e.clientX - steerTouch.x0) / TOUCH_STEER_RANGE, -1, 1);
      poke();
    } else if (lookTouch && e.pointerId === lookTouch.id) {
      if (skate.enabled) {
        const [lo, hi] = pitchLim();
        lookYaw = clamp(lookYaw - (e.clientX - lookTouch.x) * TOUCH_LOOK_SENS, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
        lookPitch = clamp(lookPitch - (e.clientY - lookTouch.y) * TOUCH_LOOK_SENS, lo, hi);
        lastLookAt = clockT;
      }
      lookTouch.x = e.clientX; lookTouch.y = e.clientY;
      poke();
    }
  };
  const onTouchUp = (e) => {
    if (steerTouch && e.pointerId === steerTouch.id) { steerTouch = null; touchSteer = 0; }
    if (lookTouch && e.pointerId === lookTouch.id) { lookTouch = null; lastLookAt = clockT - RECENTER_DELAY + 0.3; }
  };

  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  canvas?.addEventListener('pointerdown', onCanvasPointerDown);
  addEventListener('pointerup', onPointerUpAny);
  addEventListener('pointerdown', onTouchDown);
  addEventListener('pointermove', onTouchMove);
  addEventListener('pointerup', onTouchUp);
  addEventListener('pointercancel', onTouchUp);

  /* ------------------------------------------------------------ 黑场（离公路远时上板） */
  let fadeEl = null, fadeText = null;
  function setFade(a, text) {
    if (!fadeEl) {
      fadeEl = document.createElement('div');
      fadeEl.style.cssText = 'position:fixed;inset:0;z-index:4;background:#05080a;pointer-events:none;opacity:0;' +
        'display:grid;place-items:center;font:300 13px/1.5 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;' +
        'letter-spacing:.2em;color:rgba(220,236,226,.7)';
      fadeText = document.createElement('span');
      fadeEl.appendChild(fadeText);
      document.body.appendChild(fadeEl);
    }
    fadeEl.style.opacity = String(clamp(a, 0, 1));
    fadeEl.style.display = a > 0.001 ? 'grid' : 'none';
    if (text !== undefined) fadeText.textContent = text;
  }
  let swap = null;   // { t, phase: 'out'|'in' }

  function updateSwap(dt) {
    if (!swap) return;
    swap.t += dt;
    if (swap.phase === 'out') {
      setFade(smoothstep01(swap.t / FADE_OUT));
      if (swap.t >= FADE_OUT) {
        if (state.get('mode') === 'skate') enterSkate(false);
        swap.phase = 'in'; swap.t = 0;
      }
    } else {
      setFade(1 - smoothstep01(swap.t / FADE_IN));
      if (swap.t >= FADE_IN) { swap = null; setFade(0); }
    }
  }

  /* ------------------------------------------------------------ 模式切换 */
  // 相机过渡：进入/退出时在旧姿态与新姿态之间平滑混合
  const savedPos = new THREE.Vector3();
  const savedQuat = new THREE.Quaternion();
  let savedFov = camera.fov;
  let blendT = 99, blendDir = 0;   // blendDir: 1 = 进入滑板, -1 = 退出到步行

  function saveCamera() { savedPos.copy(camera.position); savedQuat.copy(camera.quaternion); savedFov = camera.fov; }

  /**
   * 离 p 最近的路面弧长。path.nearestS 是网格查表，只在公路附近有效（峡湾离路 >60 m 返回 0、
   * 回头弯两条路之间会插值出错），所以这里直接遍历路线点（含高度差，叠在一起的回头弯选同一层），再在相邻段上细化。
   */
  function nearestRoadS(p) {
    const pts = path.points;
    if (!pts?.length) return path.nearestS(p.x, p.z);
    const n = pts.length, step = path.length / (n - 1);   // 两种 path 都是 length = (点数 - 1) × 步长
    const py = p.y ?? 0;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const q = pts[i];
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2 + 0.5 * (q.y - py) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    let best = bi * step, bd2 = Infinity;
    for (let k = -8; k <= 8; k++) {
      const s = clamp((bi + k / 4) * step, 0, path.length);
      const c = path.pointAt(s);
      const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2 + 0.5 * (c.y - py) ** 2;
      if (d < bd2) { bd2 = d; best = s; }
    }
    return best;
  }

  /** 步行位置 → 最近公路上的上板点 { s, lat, dist }。 */
  function boardSpot(p) {
    const s = nearestRoadS(p);
    const c = path.pointAt(s), tg = path.tangentAt(s);
    const rx = -tg.z, rz = tg.x, rl = Math.hypot(rx, rz) || 1;
    const latRaw = ((p.x - c.x) * rx + (p.z - c.z) * rz) / rl;
    const lat = clamp(latRaw, -path.width / 2 + 0.4, path.width / 2 - 0.4);
    const bx = c.x + (rx / rl) * lat, bz = c.z + (rz / rl) * lat;
    return { s, lat, dist: Math.hypot(p.x - bx, p.z - bz, (p.y ?? c.y) - c.y) };
  }

  function resetSit() {
    sitPhase = 0; ride.sitting = 0;
    if (state.get('sit') === 'board' || state.get('sit') === 'pending') state.set('sit', '');
  }

  function enterSkate(blend = true) {
    skate.enabled = true;
    resetSit();
    if (ctx.player) {
      const p = ctx.player.position;
      const sp = boardSpot(p);
      ctx.player.sitDown?.(false);
      rider.place(sp.s, sp.lat, sp.dist > FAR_BOARD ? 0 : 2.0, true);
      ctx.player.enabled = false;
      if (blend) { saveCamera(); blendT = 0; blendDir = 1; } else { blendT = 99; blendDir = 0; }
    } else {
      blendT = 99; blendDir = 0;
    }
    lookYaw = 0; lookPitch = 0; idle = 0;
    chase.snap(); fpCam.snap();
    fpW = view === 'first' ? 1 : 0;
    skater.root.visible = true;
    if (isTouch) { ensureButtons(); showButtons(true); }
  }

  function exitSkate() {
    skate.enabled = false;
    skater.root.visible = false;
    showButtons(false);
    clearInput();
    resetSit();
    if (endPhase !== 0) { endPhase = 0; loadingEl?.classList.add('done'); }   // 终点黑场途中下板：别卡在黑屏
    ride.speed = 0; ride.braking = false; ride.throttle = 0; ride.wobble = 0;
    if (ctx.player) {
      saveCamera();
      const p = ctx.player;
      const yaw = Math.atan2(-ride.heading.x, -ride.heading.z);
      // 路面高度（隧道 / 桥上 world.heightAt 是山顶 / 谷底）
      const roadY = path.pointAt(ride.s).y;
      if (p.place) p.place(ride.position.x, roadY, ride.position.z, yaw);
      else {
        p.position.copy(ride.position);
        p.position.y = world.heightAt(ride.position.x, ride.position.z);
        p.velocity.set(0, 0, 0);
        p.setLook?.(yaw, 0);
      }
      p.enabled = true;
      blendT = 0; blendDir = -1;
    }
  }

  function applyMode(mode) {
    if (mode === 'skate' && !skate.enabled) {
      if (swap) return;
      const p = ctx.player?.position;
      if (p && boardSpot(p).dist > FAR_BOARD) {
        // 离公路远：淡出 → 放到最近的公路 → 淡入
        swap = { t: 0, phase: 'out' };
        setFade(0, t('fade.toRoad'));
      } else enterSkate(true);
    } else if (mode !== 'skate' && skate.enabled) {
      if (canWalk) exitSkate();
      else state.set('mode', 'skate');   // 没有步行控制器的场景
    } else if (mode !== 'skate' && swap?.phase === 'out') {
      swap = { t: FADE_IN * (1 - clamp(swap.t / FADE_OUT, 0, 1)), phase: 'in' };   // 淡出途中又切回步行
    }
  }
  const offMode = state.on('mode', applyMode);

  /* ------------------------------------------------------------ 峡湾终点：停下 → 淡出 → 回起点 → 淡入 */
  let endPhase = 0, endTimer = 0;   // 0 巡航；1 停稳等待；2 淡出中；3 黑屏后淡入

  function updateEnding(dt) {
    if (path.closed) return;
    if (endPhase === 0) {
      if (ride.finished) { endPhase = 1; endTimer = 0; }
    } else if (endPhase === 1) {
      endTimer += dt;
      if (endTimer > 1.3) {
        endPhase = 2; endTimer = 0;
        if (loadingEl) { loadingEl.textContent = t('load.again'); loadingEl.classList.remove('done'); }
      }
    } else if (endPhase === 2) {
      endTimer += dt;
      if (endTimer > 1.9) { respawn(); endPhase = 3; endTimer = 0; }
    } else if (endPhase === 3) {
      endTimer += dt;
      if (endTimer > 0.4) { loadingEl?.classList.add('done'); endPhase = 0; }
    }
  }

  function respawn() {
    resetSit();
    rider.place(0);
    chase.snap(); fpCam.snap();
    lookYaw = 0; lookPitch = 0; idle = 0;
    ride.finished = false;
    if (skate.enabled) applySkaterPose();
  }

  /* ------------------------------------------------------------ 每帧 */
  const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _qLean = new THREE.Quaternion();
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  const inp = { throttle: 0, brake: false, steer: 0, crouch: false, slide: false, auto: false, hold: false };
  const lookIn = { yaw: 0, pitch: 0, idle: 0 };
  const fpOut = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 66 };
  const eyeL = new THREE.Vector3(0, 1.62, 0.05), eyeT = new THREE.Vector3(), eyeW = new THREE.Vector3();
  let eyeInit = false;

  function applySkaterPose() {
    const root = skater.root;
    _z.copy(ride.boardHeading || ride.heading);   // 板头方向（侧滑时与行进方向不同）
    _y.copy(ride.up);
    _x.crossVectors(_y, _z).normalize();      // 局部 +X = 板的左侧
    _y.crossVectors(_z, _x).normalize();
    _m.makeBasis(_x, _y, _z);
    root.quaternion.setFromRotationMatrix(_m);
    if (skater.groundOffset === undefined) {
      // placeholder only: the real character leans itself around the wheel contact line
      _qLean.setFromAxisAngle(AXIS_Z, ride.lean); // +lean = 向右倾
      root.quaternion.multiply(_qLean);
      root.position.copy(ride.position);
    } else {
      // ride.position is board surface at BOARD_LIFT (0.13) above the road; the character wants road + groundOffset
      root.position.copy(ride.position).addScaledVector(ride.up, skater.groundOffset - 0.13);
    }
  }

  /** 第一人称眼睛（世界坐标）：人物头骨位置在板坐标系里低通（滤掉动画抖动），坐下时降到坐姿眼高。 */
  function eyeWorld(dt) {
    const root = skater.root;
    root.updateMatrixWorld(true);
    if (headBone === undefined) headBone = root.getObjectByName('head') || null;
    if (headBone) {
      headBone.getWorldPosition(eyeT);
      root.worldToLocal(eyeT);
      eyeT.y += 0.09; eyeT.z += 0.07;            // 头骨在颈顶，眼睛在其上前方
    } else {
      eyeT.set(0, 1.62 - 0.32 * ride.crouch, 0.05);
    }
    // 坐在板上：眼高 ≈ 板面上 0.85 m（人物还没有坐姿动画时也成立）
    const sit = ride.sitting || 0;
    if (sit > 0) eyeT.lerp(_x.set(0, 0.85, 0.02), sit);
    eyeT.x = clamp(eyeT.x, -0.9, 0.9); eyeT.y = clamp(eyeT.y, 0.3, 2.0); eyeT.z = clamp(eyeT.z, -0.6, 0.6);
    if (!eyeInit) { eyeL.copy(eyeT); eyeInit = true; }
    const ky = damp(9, dt), kh = damp(6, dt);
    eyeL.x += (eyeT.x - eyeL.x) * kh; eyeL.z += (eyeT.z - eyeL.z) * kh; eyeL.y += (eyeT.y - eyeL.y) * ky;
    return eyeW.copy(eyeL).applyMatrix4(root.matrixWorld);
  }

  function update(dt, t) {
    dt = Math.min(dt, 0.1);
    clockT += dt;
    updateSwap(dt);

    /* 步行模式：只负责退出过渡（player.update 先于本模块运行，已写好相机） */
    if (!skate.enabled) {
      if (blendDir === -1 && blendT < BLEND_OUT) {
        blendT += dt;
        const w = smoothstep01(blendT / BLEND_OUT);
        camera.position.lerpVectors(savedPos, camera.position, w);
        camera.quaternion.slerpQuaternions(savedQuat, camera.quaternion, w);
        const f = savedFov + (WALK_FOV - savedFov) * w;
        if (Math.abs(camera.fov - f) > 0.02) { camera.fov = f; camera.updateProjectionMatrix(); }
      } else if (blendDir === -1) {
        blendDir = 0;
        if (camera.fov !== WALK_FOV) { camera.fov = WALK_FOV; camera.updateProjectionMatrix(); }
      }
      return;
    }

    /* 坐下状态机 */
    if (ride.fallen && sitPhase === 1) sitPhase = 0;
    if (sitPhase === 1 && !ride.airborne && ride.speed < SIT_STOP_V) sitPhase = 2;
    ride.sitting += ((sitPhase === 2 ? 1 : 0) - ride.sitting) * damp(1.8, dt);
    if (ride.sitting < 1e-3 && sitPhase !== 2) ride.sitting = 0;
    if (sitPhase === 3 && ride.sitting < 0.12) sitPhase = 0;
    ride.sitMode = 'board';
    const sitKey = sitPhase === 1 ? 'pending' : sitPhase === 2 ? 'board' : '';
    if ((state.get('sit') || '') !== sitKey) state.set('sit', sitKey);
    labelSit(false);

    /* 输入 → 骑行 */
    const on = skate.inputEnabled;
    let steer = 0;
    if (on) {
      if (keys.has('KeyD') || keys.has('ArrowRight')) steer += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) steer -= 1;
      steer = clamp(steer + touchSteer, -1, 1);
    }
    if (sitPhase === 0) {
      inp.steer = steer;
      inp.throttle = on && (keys.has('KeyW') || keys.has('ArrowUp') || touchThrottle) ? 1 : 0;
      inp.slide = on && keys.has('Space');
      inp.brake = on && (keys.has('KeyS') || keys.has('ArrowDown') || touchBrake);
      inp.crouch = on && shift;
      // 完全不操作（没有按住任何键）3 s 后：自动巡航会在急弯前自己刹车
      inp.auto = idle > 3 && keys.size === 0 && !shift && !touchThrottle && !touchBrake && touchSteer === 0;
      inp.hold = false;
    } else {
      // 1：自动刹停（自动沿车道）；2/3：板被按住
      inp.steer = 0; inp.throttle = 0; inp.slide = false; inp.crouch = false; inp.auto = false;
      inp.brake = sitPhase === 1;
      inp.hold = sitPhase >= 2;
    }
    rider.step(dt, inp);
    idle += dt;

    /* 环顾回正：松开一会儿后自动回到跟拍（坐着时保持你看的方向） */
    if (clockT - lastLookAt > RECENTER_DELAY && !lookTouch && sitPhase < 2) {
      const k = Math.exp(-1.8 * dt);
      lookYaw *= k; lookPitch *= k;
      if (Math.abs(lookYaw) < 1e-3) lookYaw = 0;
      if (Math.abs(lookPitch) < 1e-3) lookPitch = 0;
    }

    /* 人物 */
    applySkaterPose();
    skater.update?.(dt, ride);

    /* 镜头：第三人称跟拍始终在算（摔倒时第一人称要无缝切回它） */
    chase.cfg.cinematic = skate.cinematic && state.get('cinematic') !== false && view === 'third';
    lookIn.yaw = lookYaw; lookIn.pitch = view === 'third' ? lookPitch : clamp(lookPitch, ...LOOK_PITCH.third); lookIn.idle = idle;
    chase.update(dt, clockT, ride, lookIn);

    // 第一人称混合：摔倒时 0.5 s 切到第三人称看摔倒过程，爬起来后 ~0.9 s 切回
    const fpTarget = view === 'first' && !ride.fallen ? 1 : 0;
    fpW += (fpTarget - fpW) * damp(fpTarget ? 3.2 : 5.5, dt);
    if (Math.abs(fpTarget - fpW) < 1e-3) fpW = fpTarget;
    if (fpW > 0) {
      const eye = eyeWorld(dt);
      lookIn.pitch = lookPitch;
      fpCam.update(dt, clockT, ride, eye, lookIn, fpOut);
      const w = smoothstep01(fpW);
      camera.position.lerp(fpOut.position, w);
      camera.quaternion.slerp(fpOut.quaternion, w);
      const f = camera.fov + (fpOut.fov - camera.fov) * w;
      if (Math.abs(camera.fov - f) > 0.01) { camera.fov = f; camera.updateProjectionMatrix(); }
    } else eyeInit = false;
    // 头 / 帽子 / 背包：镜头几乎到眼睛时才隐藏，避免过渡中看到无头的人
    const hideHead = fpW > 0.85;
    if (hideHead !== fpShown && skater.setFirstPerson) { skater.setFirstPerson(hideHead); fpShown = hideHead; }

    if (blendDir === 1 && blendT < BLEND_IN) {
      blendT += dt;
      const w = smoothstep01(blendT / BLEND_IN);
      camera.position.lerpVectors(savedPos, camera.position, w);
      camera.quaternion.slerpQuaternions(savedQuat, camera.quaternion, w);
      const f = savedFov + (camera.fov - savedFov) * w;
      if (Math.abs(camera.fov - f) > 0.02) { camera.fov = f; camera.updateProjectionMatrix(); }
    } else if (blendDir === 1) blendDir = 0;

    updateEnding(dt);
  }

  function dispose() {
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('blur', onBlur);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onLockChange);
    canvas?.removeEventListener('pointerdown', onCanvasPointerDown);
    removeEventListener('pointerup', onPointerUpAny);
    removeEventListener('pointerdown', onTouchDown);
    removeEventListener('pointermove', onTouchMove);
    removeEventListener('pointerup', onTouchUp);
    removeEventListener('pointercancel', onTouchUp);
    offMode?.(); offView?.();
    btnPush?.remove(); btnBrake?.remove(); btnSit?.remove(); btnView?.remove(); fadeEl?.remove();
    skater.root.parent?.remove(skater.root);
  }

  /* ------------------------------------------------------------ 初始化 */
  skater.root.visible = false;
  if (state.get('mode') === 'skate') {
    // 场景一开始就是滑板（峡湾）：直接从起点起步（步行控制器若存在则先停用）
    skate.enabled = true;
    if (ctx.player) ctx.player.enabled = false;
    rider.place(0);
    skater.root.visible = true;
    applySkaterPose();
    chase.snap();
    chase.update(1 / 60, 0, ride, lookIn);
  }
  return skate;
}
