// 第一人称漫游控制器：桌面 Pointer Lock + WASD，触屏虚拟摇杆 + 拖动环顾。
// 脚底位置 = player.position；相机 = 脚底 + 眼高 + 步行晃动。
// C 坐下 / 站起（任何移动键也会站起）：眼高平滑降到 ~0.9 m，轻微呼吸，自由环顾。
// 可选依赖（全部判空）：world.rockTopAt(x,z)、ctx.audio.playFootstep(surface)、
// state 键 'headBob'（=== false 时关闭步行晃动）、ctx.mod.terrain.td（峡湾渲染地形：河道/峡谷下挖后的真实高度）。
// 峡湾：走得比雨林快（Shift 跑 5.5 m/s）；隧道里 / 桥上走在路面上（按当前高度选"层"），隧道壁、桥栏挡住；
// 深水（湖、海、河道中央、瀑布潭）、太陡的坡、悬崖边都走不过去。
// 写 state 'sit' = 'ground'（坐着）/ ''，UI 用它收起 HUD。

const EYE = 1.65;
const SIT_EYE = 0.9;
const RADIUS = 0.35;
const MAX_SLOPE_COS = Math.cos((38 * Math.PI) / 180);
const MAX_DROP_COS = Math.cos((52 * Math.PI) / 180);   // 下坡比这还陡（悬崖）不能往下走
const MAX_WATER_DEPTH = 0.55;
const MOUSE_SENS = 0.0022;
const TOUCH_LOOK_SENS = 0.0048;
const JOY_RADIUS = 56;
const PITCH_LIMIT = (80 * Math.PI) / 180;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isTextInput = (el) =>
  !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
    (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox' && el.type !== 'button'));

export function createPlayer(ctx) {
  const { THREE, camera, world, state } = ctx;
  const canvas = ctx.renderer?.domElement || document.getElementById('view');
  const isFjord = world.id === 'fjord';
  const WALK = isFjord ? 1.7 : 1.6;
  const RUN = isFjord ? 5.5 : 3.2;     // 峡湾山谷很大：Shift 跑得快一些
  const path = world.path;

  const position = new THREE.Vector3();   // 脚底
  const velocity = new THREE.Vector3();   // 水平速度 (m/s)
  const spawn = world.spawn;
  position.set(spawn.x, world.heightAt(spawn.x, spawn.z), spawn.z);

  let yaw = spawn.yaw || 0;
  let pitch = 0;
  let groundY = position.y;   // 平滑后的地面高度
  let layerY = position.y;    // 上一帧的地面（隧道 / 桥选层用）
  let stepDist = 0;           // 累计步行距离（用于脚步 + 晃动相位）
  let bobAmp = 0;             // 平滑后的晃动幅度 0..1
  let lastSurface = 'leaves';
  let speedScale = 1;         // 涉水等造成的减速系数（平滑）
  let sitWant = false, sit = 0;

  const tmpN = new THREE.Vector3();
  const tmpC = new THREE.Vector3(), tmpT = new THREE.Vector3();
  const scratch = { x: 0, z: 0 };

  const player = {
    position,
    velocity,
    enabled: true,        // false = 相机被自动漫游等模块接管，本模块不再写相机
    inputEnabled: true,   // false = 忽略输入（如开场遮罩期间），相机仍跟随地面
    eyeHeight: EYE,
    sitMode: 'ground',
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get sitting() { return sit; },
    get locked() { return document.pointerLockElement === canvas; },
    isTouch: false,
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
    setLook(y, p = 0) { yaw = y; pitch = clamp(p, -PITCH_LIMIT, PITCH_LIMIT); },
    /** 放到 (x, y, z)，y = 脚底高度（下板时传路面高度：隧道里 / 桥上不是地形高度）。 */
    place(x, y, z, lookYaw = yaw) {
      position.set(x, y, z);
      groundY = y; layerY = y;
      velocity.set(0, 0, 0);
      yaw = lookYaw; pitch = 0;
      sitDown(false); sit = 0;
    },
    /** 坐下 / 站起；不传参数 = 切换。 */
    sitDown,
    update,
    dispose,
  };

  function sitDown(on = !sitWant) {
    sitWant = !!on;
    if (sitWant) { velocity.set(0, 0, 0); }
    syncSitState();
  }
  function syncSitState() {
    const v = sitWant ? 'ground' : '';
    if (player.enabled && (state?.get('sit') || '') !== v) state?.set('sit', v);
  }

  /* --------------------------------------------------------------- 输入 */
  const keys = new Set();
  let shift = false;

  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const onKeyDown = (e) => {
    const t = e.target;
    if (isTextInput(t)) return;
    if (t && t.tagName === 'INPUT' && t.type === 'range' && e.code.startsWith('Arrow')) return;
    if (e.code === 'KeyC') {
      if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && player.enabled && player.inputEnabled) sitDown();
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { shift = true; return; }
    if (MOVE_KEYS.has(e.code)) {
      keys.add(e.code);
      if (sitWant && player.enabled && player.inputEnabled) sitDown(false);   // 任何移动键 = 站起来
      if (e.code.startsWith('Arrow') && player.locked) e.preventDefault();
    }
  };
  const onKeyUp = (e) => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shift = false;
    keys.delete(e.code);
  };
  const onBlur = () => { keys.clear(); shift = false; releaseTouches(); };

  // 鼠标：Pointer Lock 环顾；未锁定时按住拖动作为后备
  const onMouseMove = (e) => {
    if (!player.inputEnabled || !player.enabled) return;
    const locked = player.locked;
    if (!locked && !(mouseDragging && e.buttons)) return;
    const dx = clamp(e.movementX || 0, -180, 180);
    const dy = clamp(e.movementY || 0, -180, 180);
    yaw -= dx * MOUSE_SENS;
    pitch = clamp(pitch - dy * MOUSE_SENS, -PITCH_LIMIT, PITCH_LIMIT);
  };
  let mouseDragging = false;
  const onCanvasPointerDown = (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (!player.inputEnabled) return;
    mouseDragging = true;
    if (!player.locked) player.requestLock();
  };
  const onPointerUpAny = (e) => { if (e.pointerType === 'mouse') mouseDragging = false; };
  const onLockChange = () => { if (!player.locked) { keys.clear(); shift = false; } };

  // 触屏：左半屏摇杆，右半屏看；#ui-root 内的触摸交给 UI
  let joy = null;   // {id, x0, y0, x, y}
  let look = null;  // {id, x, y}
  let joyEl = null, joyKnob = null;

  function ensureJoyEl() {
    if (joyEl) return;
    joyEl = document.createElement('div');
    joyEl.style.cssText =
      'position:fixed;z-index:4;width:112px;height:112px;margin:-56px 0 0 -56px;border-radius:50%;' +
      'border:1px solid rgba(210,230,220,.28);background:rgba(20,30,26,.18);pointer-events:none;' +
      'opacity:0;transition:opacity .25s ease;';
    joyKnob = document.createElement('div');
    joyKnob.style.cssText =
      'position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
      'background:rgba(210,230,220,.22);border:1px solid rgba(210,230,220,.35);';
    joyEl.appendChild(joyKnob);
    (document.getElementById('ui-root') || document.body).appendChild(joyEl);
  }
  function releaseTouches() {
    joy = null; look = null;
    if (joyEl) joyEl.style.opacity = '0';
  }
  const onTouchDown = (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    player.isTouch = true;
    if (e.target && e.target.closest && e.target.closest('#ui-root')) return;
    if (!player.inputEnabled) return;
    if (e.clientX < innerWidth * 0.5) {
      if (joy) return;
      ensureJoyEl();
      joy = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
      joyEl.style.left = e.clientX + 'px';
      joyEl.style.top = e.clientY + 'px';
      joyEl.style.opacity = '1';
      joyKnob.style.transform = 'translate(0,0)';
      if (sitWant && player.enabled) sitDown(false);
    } else if (!look) {
      look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  };
  const onTouchMove = (e) => {
    if (joy && e.pointerId === joy.id) {
      joy.x = e.clientX; joy.y = e.clientY;
      let dx = joy.x - joy.x0, dy = joy.y - joy.y0;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) { dx *= JOY_RADIUS / d; dy *= JOY_RADIUS / d; }
      joyKnob.style.transform = `translate(${dx}px,${dy}px)`;
    } else if (look && e.pointerId === look.id) {
      if (player.enabled) {
        yaw -= (e.clientX - look.x) * TOUCH_LOOK_SENS;
        pitch = clamp(pitch - (e.clientY - look.y) * TOUCH_LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT);
      }
      look.x = e.clientX; look.y = e.clientY;
    }
  };
  const onTouchUp = (e) => {
    if (joy && e.pointerId === joy.id) { joy = null; if (joyEl) joyEl.style.opacity = '0'; }
    if (look && e.pointerId === look.id) look = null;
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
    joyEl?.remove();
  }

  /* --------------------------------------------------------------- 世界查询 */
  // 地形高度：峡湾优先用渲染地形（河道 / 峡谷 / 瀑布潭下挖后的高度，与画面一致）
  const td = () => { const d = ctx.mod?.terrain?.td; return d && typeof d.heightAt === 'function' ? d : null; };
  const terrainAt = (x, z) => (td() ? td().heightAt(x, z) : world.heightAt(x, z));
  const normalAt = (x, z, out) => (td()?.normalAt ? td().normalAt(x, z, out) : world.normalAt(x, z, out));

  /**
   * 公路"层"：在路面上（尤其隧道里、桥上）脚踩路面而不是地形（隧道上方是山、桥下是峡谷）。
   * refY = 当前脚底高度，用来判断人在哪一层。返回 { y, wall } 或 null（不在路面层）。
   *   wall = true：在隧道 / 桥上越过了路面外缘（隧道壁、桥栏）。
   */
  const layer = { y: 0, wall: false };
  function roadLayer(x, z, refY) {
    if (!path || !path.isTunnel) return null;
    const s = path.nearestS(x, z);
    path.pointAt(s, tmpC);
    if (Math.abs(refY - tmpC.y) > 2.5) return null;
    path.tangentAt(s, tmpT);
    const rx = -tmpT.z, rz = tmpT.x, rl = Math.hypot(rx, rz) || 1;
    const lat = Math.abs(((x - tmpC.x) * rx + (z - tmpC.z) * rz) / rl);
    const tun = path.isTunnel(s), br = path.isBridge?.(s);
    const half = path.width / 2;
    if (tun || br) {
      const edge = half + (tun ? 1.0 : 0.45);
      layer.y = tmpC.y; layer.wall = lat > edge;
      return layer;
    }
    if (lat < half + 0.3) { layer.y = tmpC.y; layer.wall = false; return layer; }   // 普通路面（地形在路基下 0.25 m）
    return null;
  }

  // 有效地面高度：地形与（可选）踏石顶面取高者；路面层优先
  function ground(x, z, refY = layerY) {
    const L = isFjord ? roadLayer(x, z, refY) : null;
    if (L) return L.y;
    const h = terrainAt(x, z);
    const rt = world.rockTopAt?.(x, z);
    if (rt != null && Number.isFinite(rt) && rt > h && rt - h < 0.9) return rt;
    return h;
  }
  function waterLevel(x, z) {
    let lvl = world.waterLevelAt(x, z);
    if (!isFjord) return lvl;
    const d = td();
    // 河（水面沿河道下降）
    const R = d?.river;
    if (R && world.riverX && z > R.z0 && z < R.z1) {
      const rd = Math.abs(x - world.riverX(z)) / (R.widthAt?.(z) || 1);
      if (rd < 9) { const l = R.levelAt(z); if (lvl == null || l > lvl) lvl = l; }
    }
    // 回头弯瀑布潭、地热温泉
    for (const P of [d?.hairpinPool, world.features?.geothermal?.pool]) {
      if (P && P.level != null && Math.hypot(x - P.x, z - P.z) < P.r) { if (lvl == null || P.level > lvl) lvl = P.level; }
    }
    return lvl;
  }
  function waterDepth(x, z, g) {
    const lvl = waterLevel(x, z);
    return lvl == null ? 0 : lvl - g;
  }
  // 从 (ox,oz) 走到 (nx,nz) 是否允许
  function canStand(nx, nz, ox, oz) {
    if (!world.inBounds(nx, nz)) return false;
    const L = isFjord ? roadLayer(nx, nz, layerY) : null;
    if (L && L.wall) return false;                   // 隧道壁 / 桥栏
    const gN = ground(nx, nz), gO = ground(ox, oz);
    if (gN - gO > 0.45) return false; // 突然的台阶/岩壁
    const dN = waterDepth(nx, nz, gN);
    if (dN > MAX_WATER_DEPTH) {
      const dO = waterDepth(ox, oz, gO);
      if (dN >= dO - 1e-4) return false; // 已在深水里时允许往浅处退
    }
    if (L) return true;                              // 路面坡度很缓
    if (gN > gO + 1e-4) {
      normalAt(nx, nz, tmpN);
      if (tmpN.y < MAX_SLOPE_COS) return false; // 太陡，不能往上爬
    } else if (isFjord && gO - gN > 0.02) {
      // 悬崖边：比 52° 还陡的地方不往下走（脚下本来就很陡时放行，免得卡住）
      normalAt(nx, nz, tmpN);
      if (tmpN.y < MAX_DROP_COS) { normalAt(ox, oz, tmpN); if (tmpN.y >= MAX_DROP_COS) return false; }
    }
    return true;
  }
  function tryMove(ox, oz, nx, nz) {
    scratch.x = nx; scratch.z = nz;
    world.resolveCollision(scratch, RADIUS);
    return canStand(scratch.x, scratch.z, ox, oz);
  }

  function surfaceAt(x, z) {
    const rt = world.rockTopAt?.(x, z);
    if (rt != null && Number.isFinite(rt) && rt - world.heightAt(x, z) > 0.05) return 'stone';
    if (isFjord) {
      if (waterDepth(x, z, groundY) > 0.03) return 'water';
      if (roadLayer(x, z, groundY)) return 'stone';
      if ((world.beachAt?.(x, z) || 0) > 0.5) return 'mud';
      return 'leaves';
    }
    const wd = world.waterDistAt(x, z);
    if (wd < 0.25) return 'water';
    if (world.trailDistAt(x, z) < 1.6) return 'mud';
    return 'leaves';
  }

  /* --------------------------------------------------------------- 每帧 */
  const desired = { x: 0, z: 0 };

  function update(dt, t) {
    dt = Math.min(dt, 0.1);
    if (!player.enabled) return;
    syncSitState();

    /* 0) 坐下 / 站起（平滑） */
    sit += ((sitWant ? 1 : 0) - sit) * (1 - Math.exp(-(sitWant ? 2.2 : 3.0) * dt));
    if (Math.abs((sitWant ? 1 : 0) - sit) < 1e-3) sit = sitWant ? 1 : 0;
    const standK = 1 - clamp(sit / 0.35, 0, 1);    // 站起到一定程度才开始走

    /* 1) 期望速度（世界坐标，XZ） */
    let fwd = 0, rgt = 0, kbMag = 0;
    if (player.inputEnabled) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) rgt += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) rgt -= 1;
      kbMag = Math.min(1, Math.hypot(fwd, rgt));
      if (kbMag > 0) { const l = Math.hypot(fwd, rgt); fwd /= l; rgt /= l; }
    }
    let lf = fwd * kbMag * (shift ? RUN : WALK);
    let lr = rgt * kbMag * (shift ? RUN : WALK);
    if (joy) {
      let dx = joy.x - joy.x0, dy = joy.y - joy.y0;
      const d = Math.hypot(dx, dy);
      const mag = Math.min(1, d / JOY_RADIUS);
      if (mag > 0.12) {
        const m = (mag - 0.12) / 0.88;
        const sp = m < 0.9 ? (m / 0.9) * WALK : WALK + (RUN - WALK) * ((m - 0.9) / 0.1);
        lf += (-dy / d) * sp;
        lr += (dx / d) * sp;
      }
    }
    const l = Math.hypot(lf, lr);
    if (l > RUN) { lf *= RUN / l; lr *= RUN / l; }
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    // 前 = (-sin, -cos)，右 = (cos, -sin)
    desired.x = (-sy * lf + cy * lr) * standK;
    desired.z = (-cy * lf - sy * lr) * standK;

    // 涉水减速 50%（平滑过渡）
    const depthHere = waterDepth(position.x, position.z, groundY);
    const wading = depthHere > 0.08;
    speedScale += ((wading ? 0.5 : 1) - speedScale) * (1 - Math.exp(-5 * dt));
    desired.x *= speedScale; desired.z *= speedScale;

    /* 2) 平滑加/减速 */
    const accelerating = Math.hypot(desired.x, desired.z) > Math.hypot(velocity.x, velocity.z) - 0.02 && (desired.x || desired.z);
    const k = 1 - Math.exp(-(accelerating ? (RUN > 4 ? 4.5 : 5.5) : 7.5) * dt);
    velocity.x += (desired.x - velocity.x) * k;
    velocity.z += (desired.z - velocity.z) * k;
    if (Math.abs(velocity.x) < 1e-3 && Math.abs(velocity.z) < 1e-3 && !desired.x && !desired.z) { velocity.x = 0; velocity.z = 0; }

    /* 3) 移动 + 碰撞 / 坡度 / 水 / 边界（含沿墙滑动） */
    const ox = position.x, oz = position.z;
    let moved = 0;
    if (velocity.x !== 0 || velocity.z !== 0) {
      const nx = ox + velocity.x * dt, nz = oz + velocity.z * dt;
      let ok = false, fx = ox, fz = oz;
      if (tryMove(ox, oz, nx, nz)) { ok = true; fx = scratch.x; fz = scratch.z; }
      else if (tryMove(ox, oz, nx, oz)) { ok = true; fx = scratch.x; fz = scratch.z; velocity.z *= 0.5; }
      else if (tryMove(ox, oz, ox, nz)) { ok = true; fx = scratch.x; fz = scratch.z; velocity.x *= 0.5; }
      if (ok) {
        position.x = fx; position.z = fz;
        moved = Math.hypot(fx - ox, fz - oz);
      } else {
        velocity.x *= 0.3; velocity.z *= 0.3;
      }
    }
    const speed = dt > 0 ? moved / dt : 0;

    /* 4) 地面贴合（阻尼） */
    const gT = ground(position.x, position.z);
    layerY = gT;
    groundY += (gT - groundY) * (1 - Math.exp(-14 * dt));
    if (Math.abs(gT - groundY) < 1e-4) groundY = gT;
    position.y = groundY;

    /* 5) 步伐 / 晃动（跑步步幅更大） */
    const stride = speed > WALK * 1.35 ? clamp(speed * 0.3, 1.05, 1.7) : 0.78;
    const speedFrac = clamp(speed / WALK, 0, 1.6);
    if (speed > 0.15) {
      const before = Math.floor(stepDist / stride);
      stepDist += moved;
      if (Math.floor(stepDist / stride) !== before) {
        lastSurface = surfaceAt(position.x, position.z);
        ctx.audio?.playFootstep?.(lastSurface);
      }
    }
    const bobOn = state?.get('headBob') !== false;
    bobAmp += ((bobOn ? Math.min(1, speed / 0.6) : 0) - bobAmp) * (1 - Math.exp(-6 * dt));
    const ph = stepDist / stride;
    const amp = 0.022 * (0.6 + 0.4 * Math.min(speedFrac, 1.6)) * bobAmp;
    const bobY = -Math.cos(ph * Math.PI * 2) * 0.5 * amp;
    const bobX = Math.sin(ph * Math.PI) * 0.6 * amp;
    // 呼吸：坐着时更明显、更慢
    const breathe = Math.sin(t * 0.7) * 0.0035 * (1 - sit) + Math.sin(t * 1.25) * 0.009 * sit;
    const sitE = sit * sit * (3 - 2 * sit);
    const eye = EYE + (SIT_EYE - EYE) * sitE;

    /* 6) 写相机 */
    camera.position.set(
      position.x + Math.cos(yaw) * bobX,
      position.y + eye + bobY + breathe,
      position.z - Math.sin(yaw) * bobX,
    );
    camera.rotation.set(pitch, yaw, Math.sin(ph * Math.PI) * 0.0022 * bobAmp);
  }

  // 初始相机姿态
  camera.position.set(position.x, position.y + EYE, position.z);
  camera.rotation.set(pitch, yaw, 0);

  return player;
}
