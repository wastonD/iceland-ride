// Rainforest scene: dense canopy, stream, waterfall; walk or skate the trail loop.
import { world, trailCurve } from '../world/layout.js';
import { makePath } from '../core/path.js';

world.id = 'rainforest';
// Stream crossings get little wooden footbridges: the path rides at deck height there.
const deckH = (x, z) => {
  const h = world.heightAt(x, z), wl = world.waterLevelAt(x, z);
  return wl !== null ? Math.max(h, wl + 0.45) : world.waterDistAt(x, z) < 2.5 ? Math.max(h, (world.waterLevelAt(x, z) ?? h) + 0.3) : h;
};
world.path = makePath(trailCurve, deckH, { closed: true, width: 3.2, smooth: 1 });
{
  // bridge ranges = where the trail passes over water
  const P = world.path, out = []; let a = -1;
  for (let s = 0; s <= P.length; s += 1) {
    const q = P.pointAt(s), on = world.waterDistAt(q.x, q.z) < 1.5;
    if (on && a < 0) a = s;
    if (!on && a >= 0) { out.push({ s0: a - 3, s1: s + 3 }); a = -1; }
  }
  P.bridges = out; P.tunnels = [];
  P.isBridge = (s) => out.some((b) => s >= b.s0 && s <= b.s1);
  P.isTunnel = () => false;
}

const OPTIONAL = import.meta.glob(['../world/props/footbridge.js']);
const FB = '../world/props/footbridge.js';

export default {
  id: 'rainforest',
  world,
  controller: 'walk',               // 'walk' | 'skate' (player can toggle)
  camera: { near: 0.08, far: 900 },
  modules: [
    ['terrain', () => import('../world/terrain.js').then((m) => m.createTerrain)],
    ['water', () => import('../world/water.js').then((m) => m.createWater)],
    ['vegetation', () => import('../world/vegetation.js').then((m) => m.createVegetation)],
    ...(OPTIONAL[FB] ? [['footbridges', () => OPTIONAL[FB]().then((m) => m.createFootbridges)]] : []),
  ],
  // presets/grades: undefined → defaults in render/atmosphere.js and render/pipeline.js
};
