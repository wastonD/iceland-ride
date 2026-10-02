// Audio module: 100% procedural Web Audio (no recordings).
// createAudio(ctx) -> { update, layers, engine, playFootstep, playDrip, dispose }
//
// The AudioContext is only created after state.audioEnabled becomes true
// (first user gesture, set by the UI).
import { createEngine } from './engine.js';
import { createRainLayer } from './rain.js';
import { createDripsLayer } from './drips.js';
import { createWindLayer } from './wind.js';
import { createBoardLayer } from './board.js';
import { createWaterLayer } from './water.js';
import { createFaunaLayer } from './fauna.js';
import { createMusicLayer } from './music/music.js';
import { smoothstep } from '../core/noise.js';

// stream = running water + sea, insects = fauna (insects/frogs in the forest, birds/gulls at the fjord)
// music = generative background score (src/audio/music).
const LAYER_NAMES = ['rain', 'drips', 'thunder', 'wind', 'stream', 'insects', 'board', 'music'];

/** Placeholder layer: bus + volume subscription are wired, sound comes next phase. */
function createStubLayer(engine, name) {
  const out = engine.makeLayer(name, 1);
  return { name, out, update() {}, dispose() { out.dispose(); } };
}

export function createAudio(ctx) {
  const { state, camera } = ctx;
  let engine = null;
  let timer = null;
  let lastTick = 0;
  let lastEnvRead = -1e9;
  let gestureRetry = null;
  const unsubs = [];

  // Listener environment, smoothed. Layers read this every tick (scene-agnostic:
  // ctx.world / ctx.sceneId may be the rainforest or the fjord).
  const env = {
    scene: 'rainforest', world: null, rain: state.get('rain') ?? 0.5, tod: 'day',
    x: 0, y: 0, z: 0, rightX: 1, rightZ: 0,
    canopy: 0.3, water: 0, waterDist: 50, wood: 0, sea: 0,
    // skateboard (0 speed when walking)
    speed: 0, speedRaw: 0, lean: 0, braking: false, grounded: true, surface: 'asphalt',
    // electric board
    throttle: 0, motorLoad: 0, airborne: false, landing: 0, lateralG: 0, grip: 0, slip: 0, wobble: 0,
    fallen: false, fall: null, inTunnel: false, onBridge: false, feature: null,
    tunnel: 0, tunnelExit: 0, beach: 0,   // smoothed tunnel amount (0..1) and a brief pulse when leaving it
  };
  const target = { canopy: 0.3, water: 0, wood: 0, sea: 0, beach: 0 };

  function readEnv() {
    const world = ctx.world;
    env.world = world;
    env.scene = ctx.sceneId || world?.id || 'rainforest';
    env.tod = state.get('timeOfDay') || 'day';
    const p = camera && camera.position;
    if (!p || !world) return;
    if (world.canopyAt) target.canopy = world.canopyAt(p.x, p.z);
    let wood = 0;
    const lm = world.landmarks;
    if (env.scene === 'fjord') {
      // waterDistAt is a height above sea here; "near water" = beside the river or down at the shore
      const river = world.riverX ? 1 - smoothstep(3, 32, Math.abs(p.x - world.riverX(p.z))) : 0;
      const valley = 1 - smoothstep(820, 900, p.z);
      env.waterDist = world.waterDistAt ? world.waterDistAt(p.x, p.z) : 50;
      target.water = Math.max(river * valley, 0.6 * (1 - smoothstep(4, 20, env.waterDist)));
      target.sea = smoothstep(650, 900, p.z);
      target.beach = world.beachAt ? world.beachAt(p.x, p.z) : 0;
    } else {
      if (world.waterDistAt) {
        env.waterDist = world.waterDistAt(p.x, p.z);
        target.water = 1 - smoothstep(0.5, 22, env.waterDist);
      }
      target.sea = 0; target.beach = 0;
      if (lm) {
        for (const key of ['hut', 'giantTree']) {
          const L = lm[key];
          if (L) wood = Math.max(wood, 1 - smoothstep(2, 14, Math.hypot(p.x - L.x, p.z - L.z) - L.radius));
        }
      }
    }
    target.wood = wood;
  }

  function readPose() {
    const p = camera && camera.position;
    if (!p) return;
    env.x = p.x; env.y = p.y; env.z = p.z;
    const yaw = camera.rotation ? camera.rotation.y : 0;
    env.rightX = Math.cos(yaw); env.rightZ = -Math.sin(yaw);
  }

  // Tunnel: fast attack/release so leaving it feels like a sudden opening.
  const DUCK = { rain: 0.12, drips: 0.1, insects: 0.15, stream: 0.35, wind: 0.7 };
  const TUN_SEND = { board: 0.9, wind: 0.55, stream: 0.4, insects: 0.2 };
  let lastTun = -1;
  function stepTunnel(dt) {
    const tgt = env.inTunnel ? 1 : 0;
    const was = env.tunnel;
    env.tunnel += (tgt - env.tunnel) * (1 - Math.exp(-dt / (tgt > env.tunnel ? 0.35 : 0.1)));
    if (was > 0.5 && env.tunnel < was && !env.inTunnel) env.tunnelExit = 1;   // just left: bright "opening up" pulse
    env.tunnelExit = Math.max(0, env.tunnelExit - dt / 1.4);
    if (Math.abs(env.tunnel - lastTun) > 0.02 || (env.tunnel === 0 && lastTun !== 0)) {
      lastTun = env.tunnel;
      const t = env.tunnel;
      for (const n of Object.keys(DUCK)) api.layers[n]?.out.setDuck(1 - t * (1 - DUCK[n]), 0.08);
      for (const n of Object.keys(TUN_SEND)) api.layers[n]?.out.setTunnelSend(t * TUN_SEND[n], 0.08);
    }
  }

  // Discrete rideState events (takeoff / land / fall / getup / wobbleStart), subscribed lazily
  // because the skate controller is created after the audio module.
  let evSkate = null;
  function hookEvents() {
    const sk = ctx.skate;
    if (!sk || sk === evSkate || typeof sk.on !== 'function') return;
    evSkate = sk;
    for (const name of ['takeoff', 'land', 'fall', 'getup', 'wobbleStart']) {
      sk.on(name, (rs) => { for (const n of LAYER_NAMES) api.layers[n]?.onEvent?.(name, rs || sk.state, env); });
    }
  }

  function readSkate(dt) {
    const rs = ctx.skate && ctx.skate.state;
    const on = !!rs && rs.mode !== 'walk';
    env.speedRaw = on ? Math.max(0, rs.speed || 0) : 0;
    env.lean = on ? rs.lean || 0 : 0;
    env.braking = on && !!rs.braking;
    env.airborne = on && !!rs.airborne;
    env.grounded = on ? rs.grounded !== false && !rs.airborne : true;
    env.throttle = on ? rs.throttle || 0 : 0;
    env.motorLoad = on ? rs.motorLoad || 0 : 0;
    env.landing = on ? rs.landing || 0 : 0;
    env.lateralG = on ? rs.lateralG || 0 : 0;
    env.grip = on ? rs.grip || 0 : 0;
    env.slip = on ? rs.slip || 0 : 0;   // lateral sliding speed m/s (0 = gripping) — drives urethane slide/squeal
    env.wobble = on ? rs.wobble || 0 : 0;
    env.fallen = on && !!rs.fallen;
    env.fall = on ? rs.fall || null : null;
    env.inTunnel = on && !!rs.inTunnel;
    env.onBridge = on && !!rs.onBridge;
    env.feature = on ? rs.feature || null : null;
    env.surface = (on && rs.surface) || 'asphalt';
    env.speed += (env.speedRaw - env.speed) * (1 - Math.exp(-dt / 0.2));
  }

  function applyVolumes(imm) {
    const vol = state.get('vol') || {};
    for (const n of LAYER_NAMES) {
      const off = n === 'music' && state.get('music') === false; // state.music is the on/off switch
      api.layers[n]?.out.setVolume(off ? 0 : (vol[n] ?? 0.5), imm);
    }
    engine.setMaster(state.get('masterVolume') ?? 0.8, imm);
  }

  function tick() {
    if (!engine || engine.ac.state !== 'running') return;
    const now = engine.ac.currentTime;
    const dt = Math.min(Math.max(now - lastTick, 0.001), 0.5);
    lastTick = now;

    const wall = performance.now();
    if (wall - lastEnvRead > 500) { lastEnvRead = wall; readPose(); readEnv(); }

    const k = 1 - Math.exp(-dt / 1.2);
    hookEvents();
    readPose();
    readSkate(dt);
    env.canopy += (target.canopy - env.canopy) * k;
    env.sea += (target.sea - env.sea) * k;
    env.beach += (target.beach - env.beach) * k;
    stepTunnel(dt);
    env.water += (target.water - env.water) * k;
    env.wood += (target.wood - env.wood) * k;
    env.rain += (state.get('rain') - env.rain) * (1 - Math.exp(-dt / 0.5));

    engine.tickLoops(now);
    // schedule further ahead if the timer is being throttled (background tab)
    const ahead = Math.min(1.2, Math.max(0.12, dt + 0.1));
    for (const n of LAYER_NAMES) api.layers[n]?.update(dt, now, env, ahead);
  }

  function start() {
    if (!engine) {
      try { engine = createEngine(); } catch (e) { console.warn('[audio] unavailable:', e); return; }
      api.engine = engine;
      api.layers = {
        rain: createRainLayer(engine),
        drips: createDripsLayer(engine),
        thunder: createStubLayer(engine, 'thunder'),
        wind: createWindLayer(engine),
        stream: createWaterLayer(engine),
        insects: createFaunaLayer(engine),
        board: createBoardLayer(engine),
        music: createMusicLayer(engine, () => ctx.skate?.state ?? null),
      };
      readPose(); readEnv();
      env.canopy = target.canopy; env.water = target.water; env.wood = target.wood; env.sea = target.sea;
      applyVolumes(true);
      engine.fadeInMaster(state.get('masterVolume') ?? 0.8);
      lastTick = engine.ac.currentTime;
      timer = setInterval(tick, 50);
      // If the browser still blocks us, retry on the next gesture.
      gestureRetry = () => { if (state.get('audioEnabled') && engine) engine.resume().catch(() => {}); };
      for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, gestureRetry, { passive: true });
    }
    engine.resume().catch(() => {});
  }

  unsubs.push(state.on('audioEnabled', (v) => {
    if (v) start();
    else if (engine) engine.suspend();
  }));
  unsubs.push(state.on('vol', () => { if (engine) applyVolumes(false); }));
  unsubs.push(state.on('music', () => { if (engine) applyVolumes(false); }));
  unsubs.push(state.on('masterVolume', (v) => { if (engine) engine.setMaster(v); }));

  const api = {
    engine: null,
    layers: {},
    update() { /* all work is driven by an internal timer */ },
    /** Footstep for walk mode. surface: 'mud' | 'leaf' | 'wood' | 'stone' | 'water' | 'asphalt' | 'gravel' | 'grass' | 'dirt'. */
    playFootstep(surface) { api.layers.board?.footstep?.(surface); },
    /** Fire a single drip immediately: 'leaf' | 'water' | 'wood'. */
    playDrip(kind) { api.layers.drips?.trigger?.(kind); },
    dispose() {
      unsubs.forEach((u) => u());
      if (timer) clearInterval(timer);
      if (gestureRetry) for (const ev of ['pointerdown', 'keydown', 'touchend']) removeEventListener(ev, gestureRetry);
      for (const n of LAYER_NAMES) api.layers[n]?.dispose();
      engine?.close();
      engine = null;
    },
  };

  if (state.get('audioEnabled')) start();
  return api;
}
