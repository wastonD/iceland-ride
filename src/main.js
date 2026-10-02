import * as THREE from 'three';
import { state } from './core/state.js';
import * as i18n from './core/i18n.js';
import { globalUniforms } from './core/uniforms.js';
import { prepareMaterial } from './render/fog.js';
import { createPipeline } from './render/pipeline.js';
import { createAtmosphere } from './render/atmosphere.js';
import { SCENES, DEFAULT_SCENE } from './scenes/index.js';

// Shared feature modules. Scene-specific ones come from the scene descriptor.
// Every module loads independently: one failing module is skipped, not fatal.
const LOADERS = {
  rain: () => import('./weather/rain.js').then((m) => m.createRain),
  audio: () => import('./audio/audio.js').then((m) => m.createAudio),
  player: () => import('./player/player.js').then((m) => m.createPlayer),
  skate: () => import('./player/skate.js').then((m) => m.createSkate),
  play: () => import('./play/collect.js').then((m) => m.createCollect),
  ui: () => import('./ui/ui.js').then((m) => m.createUI),
  debugForest: () => import('./render/debugScene.js').then((m) => m.createDebugForest),
  debugTerrain: () => import('./render/debugScene.js').then((m) => m.createDebugTerrain),
};

/*
 * URL params:
 *   ?scene=rainforest|fjord      which world (default: last chosen, else fjord)
 * Debug (handy for screenshots while developing):
 *   ?cam=x,y,z,yawDeg,pitchDeg   fixed camera, controllers disabled (y is metres above ground)
 *   ?off=rain,vegetation         skip listed modules
 *   ?tod=day|dusk|night          time of day
 *   ?rain=0.8                    rain intensity
 */
const params = new URLSearchParams(location.search);
const off = new Set((params.get('off') || '').split(',').filter(Boolean));
if (params.get('tod')) state.set('timeOfDay', params.get('tod'));
if (params.get('rain')) state.set('rain', parseFloat(params.get('rain')));

const SCENE_KEY = 'rainforest.scene';
const readScene = () => { try { return localStorage.getItem(SCENE_KEY); } catch { return null; } };
let sceneId = params.get('scene') || readScene() || DEFAULT_SCENE;
if (!SCENES[sceneId]) sceneId = DEFAULT_SCENE;
try { localStorage.setItem(SCENE_KEY, sceneId); } catch { /* private mode */ }

const loadingEl = document.getElementById('loading');
const canvas = document.getElementById('view');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 900);
camera.rotation.order = 'YXZ';

const ctx = {
  THREE,
  scene,
  camera,
  world: null,     // set from the scene descriptor
  sceneDef: null,
  sceneId,
  scenes: SCENES,
  state,
  uniforms: globalUniforms,
  prepareMaterial,
  params,
  renderer: null,  // set by pipeline
  sun: null,       // DirectionalLight, set by pipeline
  player: null,    // walking controller (scenes that allow walking)
  skate: null,     // longboard controller
  audio: null,
  mod: {},         // loaded modules by name (e.g. ctx.mod.terrain.td for the fjord's rendered heights)
  /** Fade out and reload into another scene. */
  switchScene(id) {
    if (!SCENES[id] || id === sceneId) return;
    try { localStorage.setItem(SCENE_KEY, id); } catch { /* ok */ }
    loadingEl.textContent = i18n.t('load.goto', { name: SCENES[id].name });
    loadingEl.classList.remove('done');
    const p = new URLSearchParams(location.search);
    p.set('scene', id);
    setTimeout(() => { location.search = p.toString(); }, 900);
  },
};

let pipeline = null;
const modules = [];
const add = async (name, factory) => {
  if (off.has(name)) return null;
  try {
    const t0 = performance.now();
    const f = factory || (await LOADERS[name]());
    const m = (await f(ctx)) || {};
    console.info(`[boot] ${name} ${Math.round(performance.now() - t0)} ms`);
    m.name = name;
    modules.push(m);
    ctx.mod[name] = m;
    return m;
  } catch (e) {
    console.error(`[module ${name}] failed, skipping:`, e);
    return null;
  }
};

async function boot() {
  const step = (msg) => { loadingEl.textContent = msg; return new Promise((r) => setTimeout(r, 0)); };
  await step(i18n.t('load.goto', { name: SCENES[sceneId].name }));
  const tScene = performance.now();
  const def = (await SCENES[sceneId].load()).default;
  console.info(`[boot] scene ${sceneId} ${Math.round(performance.now() - tScene)} ms`);
  ctx.sceneDef = def;
  ctx.world = def.world;
  camera.near = def.camera?.near ?? 0.08;
  camera.far = def.camera?.far ?? 900;
  camera.updateProjectionMatrix();
  state.set('mode', def.controller || 'walk');
  globalUniforms.uWetness.value = sceneId === 'rainforest' ? 0.12 + 0.78 * state.get('rain') : 0.04 + 0.86 * state.get('rain');

  pipeline = createPipeline(ctx, canvas);
  window.__rf.pipeline = pipeline;

  await step(i18n.t('load.land'));
  await add('atmosphere', createAtmosphere);
  if (params.get('debug') === 'forest') await add('debugForest');
  if (params.get('debug') === 'terrain') await add('debugTerrain');
  for (const [name, loader] of def.modules) {
    if (name === 'vegetation' || name === 'flora') await step(i18n.t('load.plants'));
    const m = await add(name, await loader().catch((e) => { console.error(`[module ${name}] load failed`, e); return () => null; }));
    if (m?.rockTopAt) ctx.world.rockTopAt = m.rockTopAt;
  }
  await add('rain');
  ctx.audio = await add('audio');

  const fixedCam = params.get('cam');
  if (fixedCam) {
    const [x, y, z, yaw = 0, pitch = 0] = fixedCam.split(',').map(Number);
    camera.position.set(x, ctx.world.heightAt(x, z) + y, z);
    camera.rotation.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0);
  } else {
    // walking is available in every scene unless the descriptor opts out (fjord: B to step off the board)
    if (def.walk !== false) ctx.player = await add('player');
    ctx.skate = await add('skate');
    await add('play');
  }
  await add('ui');

  await step(i18n.t('load.shaders'));
  const tW = performance.now();
  pipeline.warmup?.();
  console.info(`[boot] shader warmup ${Math.round(performance.now() - tW)} ms`);
  loadingEl.classList.add('done');
  requestAnimationFrame(loop);
}

const clock = new THREE.Clock();
// Frame cap: 60 fps (30 in 省电/eco). High-refresh screens otherwise render 120–165 fps for nothing.
let lastFrame = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const cap = state.get('quality') === 'eco' ? 30 : 60;
  if (now - lastFrame < 1000 / cap - 1.5) return;
  lastFrame = now;
  window.__rf.frames = (window.__rf.frames || 0) + 1;
  tick(Math.min(clock.getDelta(), 0.1));
}

// One simulation + render step (also driven manually by headless tests via __rf.step).
let simT = 0;
function tick(dt) {
  simT += dt;
  const t = simT;
  globalUniforms.uTime.value = t;
  const rain = state.get('rain');
  globalUniforms.uRain.value = rain;
  // surfaces soak up / dry off slowly; in sun the forest floor only stays slightly damp
  const wetTarget = sceneId === 'rainforest' ? 0.12 + 0.78 * rain : 0.04 + 0.86 * rain;
  const wet = globalUniforms.uWetness;
  wet.value += (wetTarget - wet.value) * (1 - Math.exp(-dt / (wetTarget > wet.value ? 6 : 25)));
  for (const m of modules) m.update?.(dt, t);
  globalUniforms.uCamPos.value.copy(camera.position);
  pipeline.render(dt, t);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  pipeline?.setSize(innerWidth, innerHeight);
});

// Expose for debugging in the console / automated screenshots
window.__rf = { ctx, modules, pipeline, state, i18n, step: (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) tick(dt); } };

boot().catch((e) => {
  loadingEl.textContent = i18n.t('load.fail', { msg: e.message });
  console.error(e);
});
