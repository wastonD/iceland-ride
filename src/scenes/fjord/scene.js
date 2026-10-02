// Fjord valley scene: open Icelandic landscape, long downhill road, longboard ride.
import { world } from './layout.js';
import { t } from '../../core/i18n.js';
import { Vector3 } from 'three';
import { C, dirFrom } from '../../render/atmosphere.js';

// Linear HDR. Fog here is aerial perspective (km scale), not forest mist.
// Cinematic direction (Walter Mitty's Iceland): a lower sun for long shadows and side/back light,
// warm sun vs cool sky fill, cumulus whose shadows drift over the valley, blue layered ridges.
// Two looks (state.look / ?look=): 'cool' = Icelandic teal film (default), 'warm' = golden low sun.
const V3 = (x, y, z) => new Vector3(x, y, z);
const day = {
  skyMode: 1,
  // upper valley (lake → switchbacks → waterfall): late-afternoon sun from the west lights the
  // waterfall cliff and rakes across the switchbacks; after the tunnel the sun is south-east,
  // side/back-lighting the long run south to the sea (the cut happens inside the tunnel).
  sunDir: dirFrom(27, 272), sunDir2: dirFrom(30, 140), sunSplit: [2185, 2240],
  sunCol: C(1.0, 0.93, 0.84, 6.4),
  hemiSky: C(0.5, 0.66, 0.95, 1.2), hemiGround: C(0.2, 0.21, 0.15),
  zenith: C(0.06, 0.2, 0.6, 1.45), horizon: C(0.52, 0.68, 0.92, 1.35),
  cloudCover: 0.56, cloudCol: C(1.28, 1.26, 1.24, 1.75), cloudShade: C(0.42, 0.5, 0.64, 1.05),
  fogAmb: C(0.42, 0.57, 0.84), fogHigh: C(0.32, 0.48, 0.86), fogSunC: C(1.0, 0.88, 0.7, 0.9),
  fogDensity: 0.00022, fogFalloff: 0.0016, exposure: 1.0, volStrength: 0.12, envIntensity: 0.85, rainDim: 0.65,
  fogChroma: V3(-0.1, 0.12, 0.5), cloudShadow: 0.62, cloudSpeed: 8, cirrus: 0.55, skyPol: 0.22,
  // fair weather (state.rain ≈ 0; see SUNNY_RAIN in render/atmosphere.js) — the keys above stay the
  // rain look. Crisp clear day: deep zenith, horizon pale but not white, fewer/whiter cumulus, thin
  // haze (distant ridges stay layered blue), clean warm-white sun with a brighter blue sky fill.
  sunny: {
    // after the tunnel the sun climbs a little: fewer slopes in self-shadow on the long run south.
    // (the upper-valley sun stays at 27° — higher, the hairpin waterfall's rainbow drops out of view)
    sunDir2: dirFrom(36, 140),
    sunCol: C(1.0, 0.95, 0.87, 6.6),
    hemiSky: C(0.52, 0.66, 0.92, 1.5), envIntensity: 1.0,   // deeper sky = less env light: lift the fill back
    zenith: C(0.025, 0.12, 0.6, 1.4), horizon: C(0.36, 0.56, 0.95, 1.2), skyCurve: 0.38,
    cloudCover: 0.5, cloudCol: C(1.3, 1.28, 1.26, 1.9), cloudShade: C(0.36, 0.44, 0.6, 1.0),
    fogAmb: C(0.3, 0.47, 0.76), fogHigh: C(0.24, 0.39, 0.8), fogSunC: C(1.0, 0.9, 0.74, 0.55),
    fogChroma: V3(0.0, 0.1, 0.35), fogDensity: 0.00016, volStrength: 0.1, cloudShadow: 0.5, cirrus: 0.18, skyPol: 0.3,
  },
};
const presets = {
  day,
  'day.warm': {
    ...day,
    // golden hour: low western sun up top; after the tunnel the Icelandic midnight sun sits low in
    // the north behind the rider, throwing a long shadow down the road ahead
    sunDir: dirFrom(27, 272), sunDir2: dirFrom(18, 345), sunCol: C(1.0, 0.78, 0.52, 7.4),
    hemiSky: C(0.52, 0.6, 0.85, 1.15), hemiGround: C(0.22, 0.18, 0.12),
    zenith: C(0.1, 0.24, 0.58, 1.3), horizon: C(0.95, 0.8, 0.66, 1.3),
    cloudCol: C(1.45, 1.15, 0.9, 1.7), cloudShade: C(0.45, 0.45, 0.58, 1.0),
    fogAmb: C(0.56, 0.58, 0.72), fogHigh: C(0.36, 0.47, 0.8), fogSunC: C(1.25, 0.8, 0.45, 0.9),
    fogDensity: 0.00024, exposure: 1.1, volStrength: 0.25,
    fogChroma: V3(-0.05, 0.1, 0.35), cloudShadow: 0.5, cirrus: 0.7, skyPol: 0.15,
    sunny: {
      zenith: C(0.04, 0.16, 0.56, 1.35), horizon: C(0.78, 0.74, 0.7, 1.15), skyCurve: 0.4,
      cloudCover: 0.46, cloudShade: C(0.4, 0.42, 0.56, 1.0),
      fogAmb: C(0.46, 0.52, 0.7), fogHigh: C(0.3, 0.42, 0.8), fogSunC: C(1.25, 0.8, 0.45, 0.65),
      fogDensity: 0.00017, cloudShadow: 0.42, cirrus: 0.3, skyPol: 0.22,
    },
  },
  dusk: {
    skyMode: 1,
    sunDir: dirFrom(7, 262), sunCol: C(1.0, 0.56, 0.3, 5.0),
    hemiSky: C(0.5, 0.45, 0.55), hemiGround: C(0.16, 0.12, 0.09),
    zenith: C(0.12, 0.16, 0.38), horizon: C(1.1, 0.62, 0.42),
    cloudCover: 0.5, cloudCol: C(1.6, 0.9, 0.6), cloudShade: C(0.38, 0.3, 0.4),
    fogAmb: C(0.7, 0.5, 0.45), fogHigh: C(0.4, 0.38, 0.55), fogSunC: C(1.3, 0.7, 0.35, 1.2),
    fogDensity: 0.0005, fogFalloff: 0.0016, exposure: 1.1, volStrength: 0.4, envIntensity: 0.7, rainDim: 0.6,
    fogChroma: V3(-0.2, 0.0, 0.3), cloudShadow: 0.3, cirrus: 0.6, skyPol: 0.1,
  },
  night: {
    skyMode: 1, stars: 1,
    sunDir: dirFrom(38, 200), sunCol: C(0.55, 0.65, 1.0, 0.9),
    hemiSky: C(0.08, 0.11, 0.2), hemiGround: C(0.03, 0.035, 0.04),
    zenith: C(0.008, 0.014, 0.04), horizon: C(0.04, 0.06, 0.1),
    cloudCover: 0.35, cloudCol: C(0.12, 0.14, 0.2), cloudShade: C(0.03, 0.035, 0.05),
    fogAmb: C(0.04, 0.06, 0.1), fogHigh: C(0.03, 0.05, 0.09), fogSunC: C(0.3, 0.4, 0.6, 0.6),
    fogDensity: 0.0005, fogFalloff: 0.0016, exposure: 2.0, volStrength: 0.3, envIntensity: 0.4, rainDim: 0.5,
  },
};

// Film grades (see FILM_DEFAULTS in render/pipeline.js). Display-space: gain = white balance,
// shadowTint/highTint = split toning, greenSat pulls the "game green" back to olive/moss.
const film = {
  film: 1, curve: [1.45, 0.965, 0.18, 0.25, 16], cross: 3.0, contrast: 0.24,
  lift: [0.0, 0.004, 0.008], gamma: [1.0, 1.0, 1.0], gain: [0.99, 1.0, 1.01],
  shadowTint: [-0.014, 0.004, 0.016], highTint: [0.014, 0.004, -0.012],
  sat: 1.12, greenSat: 0.3, warmSat: 0.14, grain: 0.03, halation: 0.35, ca: 0.0025, vignette: 0.16, bloom: 0.055,
};
const grades = {
  // sunny: fair-weather overrides (blend in by ctx.sunny) — less highlight bleach (cross) so bright
  // blues stay blue, a touch more contrast, no lifted (milky) blacks, restrained halation/grain
  day: { ...film, sunny: { curve: [1.5, 0.965, 0.18, 0.25, 16], cross: 5.0, contrast: 0.27, lift: [0.0, 0.002, 0.004], sat: 1.16, greenSat: 0.2, halation: 0.18, grain: 0.022, bloom: 0.045, vignette: 0.14 } },
  'day.warm': {
    ...film, curve: [1.28, 0.965, 0.18, 0.27, 16], contrast: 0.13,
    lift: [0.02, 0.016, 0.012], gain: [1.03, 1.0, 0.94],
    shadowTint: [-0.006, 0.002, 0.012], highTint: [0.026, 0.01, -0.024],
    sat: 1.04, greenSat: 0.2, warmSat: 0.18, grain: 0.04, halation: 0.5, vignette: 0.18, bloom: 0.07,
    sunny: { curve: [1.38, 0.965, 0.18, 0.26, 16], cross: 4.2, contrast: 0.2, lift: [0.008, 0.006, 0.004], sat: 1.08, greenSat: 0.16, grain: 0.03, halation: 0.3, bloom: 0.06 },
  },
  dusk: { ...film, lift: [0.018, 0.012, 0.012], gain: [1.03, 1.0, 0.95], shadowTint: [-0.01, 0.0, 0.014], highTint: [0.02, 0.006, -0.018], sat: 1.08, greenSat: 0.2, halation: 0.5, vignette: 0.2, bloom: 0.07 },
  'dusk.warm': { ...film, lift: [0.022, 0.012, 0.008], gain: [1.05, 0.99, 0.92], shadowTint: [-0.006, 0.0, 0.01], highTint: [0.03, 0.01, -0.03], sat: 1.06, greenSat: 0.15, halation: 0.6, vignette: 0.2, bloom: 0.08 },
  night: { ...film, curve: [1.25, 0.97, 0.18, 0.24, 16], lift: [0.008, 0.012, 0.025], gain: [0.95, 1.0, 1.08], shadowTint: [0, 0, 0], highTint: [0, 0, 0], sat: 0.9, greenSat: 0, grain: 0.045, halation: 0.2, vignette: 0.25, bloom: 0.08 },
};

// Optional modules: loaded only if the file exists.
const OPTIONAL = import.meta.glob(['./animals/animals.js']);
const opt = (path, fn) => (OPTIONAL[path] ? [[path.split('/').pop().replace('.js', ''), () => OPTIONAL[path]().then((m) => m[fn])]] : []);

export default {
  id: 'fjord',
  world,
  controller: 'skate',
  camera: { near: 0.15, far: 9000 },
  presets,
  grades,
  looks: [{ id: 'cool', get name() { return t('look.cool'); } }, { id: 'warm', get name() { return t('look.warm'); } }],   // first = default (state.look)
  letterbox: true,                                                           // 2.39:1 bars by default (state.letterbox)
  modules: [
    ['terrain', () => import('./terrain.js').then((m) => m.createFjordTerrain)],
    ['road', () => import('./road.js').then((m) => m.createRoad)],
    ['water', () => import('./water.js').then((m) => m.createFjordWater)],
    ['flora', () => import('./flora.js').then((m) => m.createFlora)],
    ['village', () => import('./village.js').then((m) => m.createVillage)],
    ...opt('./animals/animals.js', 'createAnimals'),
  ],
};
