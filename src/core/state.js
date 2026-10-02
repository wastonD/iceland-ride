// Tiny observable store. Single source of truth for everything the UI can change.
// Usage: state.get('rain'), state.set('rain', 0.7), state.on('rain', v => ...)

const defaults = {
  // weather
  rain: 0.55,            // 0 = drizzle … 1 = downpour (drives visuals + audio)
  thunderRate: 0.3,      // 0 = never … 1 = frequent
  timeOfDay: 'day',      // 'day' | 'dusk' | 'night'
  fog: 0.5,              // 0..1 user fog multiplier

  // audio mixer (0..1 each)
  masterVolume: 0.8,
  audioEnabled: false,   // becomes true after first user gesture
  vol: { rain: 0.8, drips: 0.6, thunder: 0.5, wind: 0.4, stream: 0.5, insects: 0.4, music: 0.5, board: 0.6 },

  // rendering
  quality: 'auto',       // 'auto' | 'high' | 'medium' | 'low'
  resolvedQuality: 'high',
  // cinematic look (render/pipeline.js resolves null → scene default at boot; URL ?letterbox=0|1 &look=id)
  letterbox: null,       // true = 2.39:1 black bars (fjord default on, rainforest off)
  look: null,            // colour look id from ctx.sceneDef.looks, e.g. 'cool' | 'warm' (fjord); null = none

  // ui / modes
  mode: 'walk',          // 'walk' | 'skate' (active controller)
  music: true,
  autoWander: false,
  headBob: true,
  uiVisible: true,
  lang: 'zh',            // 'zh' | 'en' (core/i18n.js owns it; setLang() / state.set('lang') both work)
};

const data = structuredClone(defaults);
const listeners = new Map();

function emit(key, value) {
  const set = listeners.get(key);
  if (set) for (const fn of set) fn(value);
  const any = listeners.get('*');
  if (any) for (const fn of any) fn(key, value);
}

export const state = {
  get(key) { return data[key]; },
  // Dotted paths are supported for one level: 'vol.rain'
  set(key, value) {
    if (key.includes('.')) {
      const [a, b] = key.split('.');
      data[a] = { ...data[a], [b]: value };
      emit(key, value);
      emit(a, data[a]);
      return;
    }
    data[key] = value;
    emit(key, value);
  },
  on(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key).delete(fn);
  },
  snapshot() { return structuredClone(data); },
  defaults,
};
