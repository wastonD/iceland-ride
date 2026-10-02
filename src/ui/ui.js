// 极简界面：开场遮罩、底部控制条（雨量/时段/雾/声音/画质/预设）、操作提示。
// 全部挂在 #ui-root，默认隐藏；设置存 localStorage（读写全部 try/catch）。

import { t, getLang, setLang, onLang, commitLang, LANGS } from '../core/i18n.js';

const KEY_SETTINGS_BASE = 'rainforest.settings.v1';
const KEY_PRESETS = 'rainforest.presets.v1';
const MAX_USER_PRESETS = 5;
const KEY_HUD = 'rainforest.hud.v1';

// [值, 文案 key]：文案都走 core/i18n.js
const TIMES = [['day', 'time.day'], ['dusk', 'time.dusk'], ['night', 'time.night']];
const QUALITIES = [['auto', 'q.auto'], ['high', 'q.high'], ['medium', 'q.medium'], ['low', 'q.low'], ['eco', 'q.eco']];
const LAYERS = [
  ['rain', 'snd.rain', false], ['drips', 'snd.drips', false], ['thunder', 'snd.thunder', true],
  ['wind', 'snd.wind', false], ['stream', 'snd.stream', false], ['insects', 'snd.insects', false],
];
const VOL_KEYS = [...LAYERS.map(([k]) => k), 'music', 'board'];

const BUILTIN_PRESETS = [
  {
    name: 'preset.sleep',
    data: {
      rain: 0.5, thunderRate: 0.05, timeOfDay: 'night', fog: 0.7, masterVolume: 0.6, music: false,
      vol: { rain: 0.85, drips: 0.35, thunder: 0.1, wind: 0.25, stream: 0.55, insects: 0.3, music: 0.2, board: 0.3 },
    },
  },
  {
    name: 'preset.focus',
    data: {
      rain: 0.4, thunderRate: 0, timeOfDay: 'day', fog: 0.4, masterVolume: 0.65, music: false,
      vol: { rain: 0.6, drips: 0.25, thunder: 0, wind: 0.2, stream: 0.4, insects: 0.15, music: 0.3, board: 0.4 },
    },
  },
  {
    name: 'preset.storm',
    data: {
      rain: 1, thunderRate: 0.9, timeOfDay: 'dusk', fog: 0.8, masterVolume: 0.9, music: false,
      vol: { rain: 1, drips: 0.7, thunder: 0.9, wind: 0.8, stream: 0.5, insects: 0.05, music: 0.3, board: 0.5 },
    },
  },
  {
    name: 'preset.free',
    data: {
      rain: 0, thunderRate: 0, timeOfDay: 'day', fog: 0.4, masterVolume: 0.8, music: true,
      vol: { rain: 0.5, drips: 0.3, thunder: 0, wind: 0.6, stream: 0.3, insects: 0.3, music: 0.6, board: 0.6 },
    },
  },
];

/* ------------------------------------------------------------------ 存储 */
const store = {
  get(k) { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
};
const num01 = (v) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

// 把任意来源的数据清洗成合法设置
function sanitize(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const k of ['rain', 'fog', 'masterVolume', 'thunderRate', 'lastRain']) { const v = num01(d[k]); if (v !== undefined) out[k] = v; }
  if (TIMES.some(([k]) => k === d.timeOfDay)) out.timeOfDay = d.timeOfDay;
  if (QUALITIES.some(([k]) => k === d.quality)) out.quality = d.quality;
  if (typeof d.music === 'boolean') out.music = d.music;
  if (d.vol && typeof d.vol === 'object') {
    out.vol = {};
    for (const k of VOL_KEYS) { const v = num01(d.vol[k]); if (v !== undefined) out.vol[k] = v; }
  }
  return out;
}

/* --------------------------------------------------------------- DOM 小工具 */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

const CSS = `
#ui-root{position:fixed;inset:0;z-index:5;pointer-events:none;
  font:300 14px/1.5 "PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;color:#d6e5dc;
  -webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
#ui-root *{box-sizing:border-box}
#ui-root button{font:inherit;color:inherit;cursor:pointer;-webkit-appearance:none;appearance:none}
.rf-glass{background:rgba(12,20,18,.52);-webkit-backdrop-filter:blur(18px) saturate(1.15);backdrop-filter:blur(18px) saturate(1.15);
  border:1px solid rgba(200,225,212,.13);box-shadow:0 10px 40px rgba(0,0,0,.28)}

/* 开场遮罩 */
.rf-intro{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;
  pointer-events:auto;text-align:center;padding:24px;
  background:radial-gradient(ellipse at 50% 45%,rgba(14,26,22,.42),rgba(6,11,10,.78));
  -webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px);
  transition:opacity 1.3s ease,visibility 0s linear 1.3s;outline:none}
.rf-intro.gone{opacity:0;visibility:hidden;pointer-events:none}
.rf-intro h1{margin:0;font-weight:200;font-size:clamp(26px,5vw,38px);letter-spacing:.5em;padding-left:.5em;color:#e4efe8}
#ui-root .rf-intro .go{padding:14px 34px;border-radius:999px;font-size:16px;letter-spacing:.3em;padding-left:calc(34px + .3em);
  border:1px solid rgba(210,232,220,.32);background:rgba(20,34,30,.4);color:#e4efe8;animation:rfbreath 3.6s ease-in-out infinite;
  transition:background .3s,border-color .3s}
#ui-root .rf-intro .go:hover{background:rgba(40,64,56,.55);border-color:rgba(220,240,228,.55)}
.rf-intro .tip{font-size:12.5px;letter-spacing:.18em;color:rgba(200,222,210,.62);max-width:min(640px,100%)}
.rf-opts{display:flex;flex-direction:column;align-items:center;gap:16px}
.rf-opt{display:flex;flex-direction:column;align-items:center;gap:8px}
.rf-opt .cap{font-size:11.5px;letter-spacing:.2em;color:rgba(200,222,210,.55)}
.rf-pills{display:flex;gap:10px}
#ui-root .rf-pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:118px;min-height:42px;padding:0 20px;
  border-radius:999px;border:1px solid rgba(200,225,212,.18);background:rgba(255,255,255,.04);font-size:14px;letter-spacing:.14em;
  transition:background .25s,border-color .25s,color .25s}
.rf-pill svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
#ui-root .rf-pill:hover{background:rgba(255,255,255,.1)}
#ui-root .rf-pill.on{background:rgba(120,178,152,.26);border-color:rgba(160,212,188,.62);color:#f0f8f3}
@keyframes rfbreath{0%,100%{box-shadow:0 0 0 0 rgba(160,205,185,.0)}50%{box-shadow:0 0 28px 2px rgba(160,205,185,.16)}}

/* 提示 */
.rf-hint{position:absolute;left:max(16px,env(safe-area-inset-left));bottom:max(var(--hint-bottom,18px),env(safe-area-inset-bottom));
  font-size:12.5px;letter-spacing:.14em;color:rgba(220,236,226,.72);text-shadow:0 1px 8px rgba(0,0,0,.6);
  opacity:0;transition:opacity 1.4s ease;pointer-events:none;max-width:calc(100vw - 96px);white-space:pre-line}
.rf-hint.show{opacity:1}

/* 右下角按钮 */
.rf-fab{position:absolute;right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));
  width:44px;height:44px;border-radius:50%;display:grid;place-items:center;padding:0;pointer-events:none;
  opacity:0;transition:opacity .5s ease,background .2s}
.rf-fab.show{opacity:.55;pointer-events:auto}
.rf-fab.show:hover,.rf-fab.show:focus-visible{opacity:1}
.rf-fab svg{width:20px;height:20px;stroke:#d6e5dc;fill:none;stroke-width:1.5;stroke-linecap:round}

/* 控制条 */
.rf-bar{position:absolute;left:50%;bottom:max(14px,env(safe-area-inset-bottom));width:min(760px,calc(100vw - 24px));
  max-height:calc(100dvh - 28px);overflow-y:auto;overscroll-behavior:contain;border-radius:18px;padding:14px 16px 12px;
  transform:translate(-50%,14px);opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity .45s ease,transform .45s ease,visibility 0s linear .45s;scrollbar-width:none}
.rf-bar::-webkit-scrollbar{display:none}
.rf-bar.show{transform:translate(-50%,0);opacity:1;visibility:visible;pointer-events:auto;transition-delay:0s}
.rf-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 26px}
.rf-grid+.rf-grid{grid-template-columns:1fr}
.rf-row{display:flex;align-items:center;gap:10px;min-height:44px}
.rf-row>.lab{flex:0 0 auto;min-width:2.4em;font-size:13px;letter-spacing:.12em;color:rgba(214,229,220,.9)}
.rf-row .end{flex:0 0 auto;font-size:11.5px;color:rgba(200,222,210,.55);white-space:nowrap}
.rf-row input[type=range]{flex:1 1 auto;min-width:0}
.rf-seg{display:flex;gap:6px;flex:1 1 auto}
.rf-seg button,.rf-btn{min-height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(200,225,212,.14);
  background:rgba(255,255,255,.04);font-size:13px;letter-spacing:.06em;transition:background .2s,border-color .2s,color .2s}
.rf-seg button{flex:1 1 0}
.rf-seg button:hover,.rf-btn:hover{background:rgba(255,255,255,.09)}
.rf-seg button.on,.rf-btn.on{background:rgba(120,178,152,.24);border-color:rgba(150,205,180,.5);color:#eef7f1}
.rf-btns{display:flex;gap:6px;flex:1 1 auto}
.rf-btns .rf-btn{flex:1 1 0}
.rf-pop{display:none;margin-top:10px;padding-top:8px;border-top:1px solid rgba(200,225,212,.1)}
.rf-pop.open{display:block;animation:rffade .3s ease}
@keyframes rffade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.rf-pop .sub{font-size:11px;color:rgba(200,222,210,.5);margin-left:4px}
.rf-layers{display:grid;grid-template-columns:1fr 1fr;gap:0 26px}
.rf-row.soon .lab{color:rgba(214,229,220,.55)}
.rf-row.soon input[type=range]{opacity:.55}
.rf-tag{font-size:10px;letter-spacing:.06em;padding:1px 6px;border-radius:8px;border:1px solid rgba(200,225,212,.18);color:rgba(200,222,210,.55);white-space:nowrap}
.rf-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.rf-presets .item{display:inline-flex;align-items:stretch}
.rf-presets .item .rf-btn{border-radius:12px}
.rf-presets .item .rf-btn.has-del{border-top-right-radius:0;border-bottom-right-radius:0}
.rf-presets .item .del{width:40px;padding:0;border-radius:0 12px 12px 0;border-left:0;color:rgba(230,190,180,.85)}
.rf-save{display:flex;gap:6px;margin-top:4px}
.rf-save input{flex:1 1 auto;min-width:0;height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(200,225,212,.2);
  background:rgba(0,0,0,.22);color:#e4efe8;font:inherit;font-size:14px;outline:none;user-select:text;-webkit-user-select:text}
.rf-save input:focus{border-color:rgba(150,205,180,.6)}
.rf-note{font-size:11.5px;color:rgba(200,222,210,.55);margin:4px 2px 0}
.rf-label-h{font-size:11.5px;letter-spacing:.14em;color:rgba(200,222,210,.55);margin:6px 2px 4px}

/* 滑块 */
#ui-root input[type=range]{-webkit-appearance:none;appearance:none;height:40px;margin:0;background:transparent;cursor:pointer;
  --fill:50%;touch-action:none}
#ui-root input[type=range]:focus{outline:none}
#ui-root input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;
  background:linear-gradient(to right,rgba(150,205,180,.85) var(--fill),rgba(200,225,212,.2) var(--fill))}
#ui-root input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6.5px;border-radius:50%;
  background:#e8f3ec;border:0;box-shadow:0 0 0 4px rgba(150,205,180,.18),0 1px 4px rgba(0,0,0,.4);transition:box-shadow .2s}
#ui-root input[type=range]:hover::-webkit-slider-thumb,#ui-root input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 7px rgba(150,205,180,.22),0 1px 4px rgba(0,0,0,.4)}
#ui-root input[type=range]::-moz-range-track{height:3px;border-radius:2px;background:rgba(200,225,212,.2)}
#ui-root input[type=range]::-moz-range-progress{height:3px;border-radius:2px;background:rgba(150,205,180,.85)}
#ui-root input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#e8f3ec;border:0;box-shadow:0 0 0 4px rgba(150,205,180,.18)}
#ui-root button:focus-visible{outline:1px solid rgba(180,225,200,.7);outline-offset:2px}


/* HUD：速度 + 光点（极简、很淡）；遮幅开启时放进黑边里 */
#ui-root{--hud-top:16px;--hint-bottom:18px;--flash-bottom:9%;--flash-top:15%}
.rf-hud{position:absolute;left:max(18px,env(safe-area-inset-left));top:var(--hud-top);display:flex;align-items:baseline;gap:18px;
  font-size:12px;letter-spacing:.14em;color:rgba(235,244,238,.55);text-shadow:0 1px 6px rgba(0,0,0,.5);
  opacity:0;transition:opacity 1s ease,top .6s ease;pointer-events:none;font-variant-numeric:tabular-nums}
.rf-hud.show{opacity:1}
.rf-hud b{font-weight:300;font-size:16px;letter-spacing:.06em;color:rgba(245,250,246,.82);margin-right:4px}
.rf-hud .orb i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;
  background:radial-gradient(circle,#fff6d8 0,#f7c96a 52%,rgba(247,201,106,0) 100%);box-shadow:0 0 8px rgba(255,214,120,.65)}
.rf-hud .orb.pop b{animation:rfpop .4s ease}
@keyframes rfpop{0%{transform:scale(1)}35%{transform:scale(1.28);color:#ffe7a8}100%{transform:scale(1)}}
.rf-flash{position:absolute;left:50%;bottom:calc(var(--lb,0px) + var(--flash-bottom));transform:translate(-50%,6px);white-space:nowrap;
  font-size:19px;font-weight:200;letter-spacing:.3em;padding-left:.3em;color:rgba(255,249,232,.94);
  text-shadow:0 0 16px rgba(255,214,140,.45),0 1px 8px rgba(0,0,0,.5);opacity:0;pointer-events:none;
  transition:opacity .4s ease,transform .6s ease}
.rf-flash.show{opacity:1;transform:translate(-50%,0)}
.rf-flash.rec{bottom:auto;top:calc(var(--lb,0px) + var(--flash-top));color:#ffe6a6;font-size:17px}
.rf-card{position:fixed;left:50%;top:50%;transform:translate(-50%,-46%);z-index:20;width:min(320px,86vw);padding:24px 30px 22px;border-radius:20px;
  font:300 14px/1.95 "PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8f2ec;text-align:center;letter-spacing:.1em;
  background:rgba(14,22,20,.46);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(220,235,225,.16);
  box-shadow:0 12px 44px rgba(0,0,0,.32);opacity:0;visibility:hidden;pointer-events:none;user-select:none;-webkit-user-select:none;
  transition:opacity .9s ease,transform .9s ease,visibility 0s linear .9s}
.rf-card.show{opacity:1;visibility:visible;transform:translate(-50%,-50%);transition-delay:0s}
.rf-card h3{margin:0 0 8px;font-weight:200;font-size:18px;letter-spacing:.5em;padding-left:.5em;color:#f3f8f4}
.rf-card dl{display:grid;grid-template-columns:1fr auto;gap:1px 26px;margin:0}
.rf-card dt{text-align:left;color:rgba(200,222,210,.66)}
.rf-card dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;color:#f1f7f3}
.rf-card dd.gold{color:#ffe3a0}
.rf-card p{margin:12px 0 0;font-size:12.5px;letter-spacing:.14em;color:rgba(222,238,228,.7)}

@media (max-width:640px){
  .rf-bar{padding:12px 12px 10px;border-radius:16px}
  .rf-grid,.rf-layers{grid-template-columns:1fr;gap:0}
  .rf-seg button{padding:0 4px;font-size:12.5px;letter-spacing:.02em}
  .rf-row .end{font-size:11px}
  .rf-hint{bottom:max(72px,calc(env(safe-area-inset-bottom) + 66px));max-width:calc(100vw - 32px)}
}
#ui-root[data-lang=en],.rf-card[data-lang=en]{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
#ui-root[data-lang=en] .rf-intro h1{letter-spacing:.2em;padding-left:.2em}
#ui-root[data-lang=en] .rf-intro .go{letter-spacing:.12em;padding-left:calc(34px + .12em)}
#ui-root[data-lang=en] .rf-intro .tip,#ui-root[data-lang=en] .rf-opt .cap{letter-spacing:.08em}
#ui-root[data-lang=en] .rf-pill{letter-spacing:.06em}
#ui-root[data-lang=en] .rf-row>.lab{min-width:5.4em;letter-spacing:.03em}
#ui-root[data-lang=en] .rf-seg button,#ui-root[data-lang=en] .rf-btn{letter-spacing:.02em}
#ui-root[data-lang=en] .rf-hint,#ui-root[data-lang=en] .rf-hud{letter-spacing:.05em}
#ui-root[data-lang=en] .rf-flash{letter-spacing:.14em;padding-left:.14em}
.rf-card[data-lang=en]{letter-spacing:.03em}
.rf-card[data-lang=en] h3{letter-spacing:.22em;padding-left:.22em}
.rf-card[data-lang=en] p{letter-spacing:.04em}
@media (max-width:640px){#ui-root .rf-pill{min-width:104px;padding:0 14px}#ui-root[data-lang=en] .rf-row>.lab{min-width:4.6em}}
@media (prefers-reduced-motion:reduce){.rf-intro .go{animation:none}}
`;

/* ---------------------------------------------------------------------- UI */
export function createUI(ctx) {
  const { state, params } = ctx;
  const root = document.getElementById('ui-root') || document.body.appendChild(h('div', { id: 'ui-root' }));
  const isTouch = (() => {
    try { return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; } catch { return false; }
  })();

  const sceneId = ctx.sceneId || 'rainforest';
  const isFjord = sceneId === 'fjord';
  const KEY_SETTINGS = sceneId === 'rainforest' ? KEY_SETTINGS_BASE : `${KEY_SETTINGS_BASE}.${sceneId}`;
  const controllers = () => [ctx.player, ctx.skate].filter(Boolean);
  const activeCtl = () => (state.get('mode') === 'skate' ? ctx.skate : ctx.player) || ctx.skate || ctx.player;
  const setInput = (on) => { for (const c of controllers()) c.inputEnabled = on; };

  /* ---- 恢复上次设置（按场景分开；URL 调试参数优先；无存档时用场景默认） ---- */
  const rawSaved = store.get(KEY_SETTINGS);
  const saved = sanitize(rawSaved);
  if (!rawSaved) { saved.rain = isFjord ? 0 : 0.5; }
  let lastRain = saved.lastRain ?? (saved.rain > 0.02 ? saved.rain : 0.6);
  if (params?.get('tod')) delete saved.timeOfDay;
  if (params?.get('rain')) delete saved.rain;
  applyData(saved);
  if (state.get('rain') > 0.02) lastRain = state.get('rain');

  const style = h('style', {}, CSS);
  document.head.appendChild(style);

  /* ---- 绑定辅助 ---- */
  const syncers = [];
  // 文案绑定：切换语言时 binds 全部重算
  const binds = [];
  const bind = (el, fn, attr) => {
    const apply = () => { const v = fn(); if (attr) el.setAttribute(attr, v); else el.textContent = v; };
    apply(); binds.push(apply); return el;
  };
  const tx = (key, tag = 'span', attrs) => bind(h(tag, attrs), () => t(key));
  const lab = (key) => tx(key, 'span', { class: 'lab' });
  const end = (key) => tx(key, 'span', { class: 'end' });
  const getVal = (key) => (key.includes('.') ? (state.get('vol') || {})[key.split('.')[1]] : state.get(key));

  function slider({ key, onInput }) {
    const input = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': key });
    const paint = () => { input.style.setProperty('--fill', (input.value * 100).toFixed(1) + '%'); };
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      state.set(key, v);
      paint();
      onInput?.(v);
    });
    syncers.push(() => {
      const v = getVal(key);
      if (typeof v === 'number' && String(v) !== input.value) input.value = v;
      paint();
    });
    return input;
  }
  function segment(key, items) {   // items: [值, 文案 key | () => 文案]
    const btns = items.map(([val, label]) =>
      bind(h('button', { type: 'button', 'data-v': val, onclick: () => state.set(key, val) }), typeof label === 'function' ? label : () => t(label)));
    syncers.push(() => {
      const cur = state.get(key);
      btns.forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
    });
    return h('div', { class: 'rf-seg' }, btns);
  }
  function applyData(d) {
    for (const k of ['rain', 'fog', 'masterVolume', 'thunderRate', 'timeOfDay', 'quality', 'music']) if (d[k] !== undefined) state.set(k, d[k]);
    if (d.vol) for (const [k, v] of Object.entries(d.vol)) state.set('vol.' + k, v);
  }
  function currentData() {
    return sanitize({
      rain: state.get('rain'), fog: state.get('fog'), masterVolume: state.get('masterVolume'),
      thunderRate: state.get('thunderRate'), timeOfDay: state.get('timeOfDay'), music: !!state.get('music'), vol: { ...state.get('vol') },
    });
  }

  /* ---- 开场：语言 + 天气 → 进入（"进入"按钮就是启动音频的那次用户手势） ---- */
  let entered = false;
  const sceneKey = isFjord ? 'fjord' : 'rainforest';
  const RAIN_MIN = 0.02;
  function setWeather(v) {
    const r = state.get('rain');
    if (v === 'sun') { if (r > RAIN_MIN) lastRain = r; state.set('rain', 0); }
    else if (r <= RAIN_MIN) state.set('rain', Math.max(lastRain, 0.15));
  }
  const ICON_SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>';
  const ICON_RAIN = '<svg viewBox="0 0 24 24"><path d="M7 15a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 8.5 3.5 3.5 0 0 1 17 15"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/></svg>';
  const langButtons = (cls, extra) => {
    const btns = LANGS.map(([code, name]) => h('button', { type: 'button', class: cls, 'data-v': code, onclick: () => setLang(code) }, name));
    syncers.push(() => btns.forEach((x) => x.classList.toggle('on', x.dataset.v === getLang())));
    return btns;
  };
  const weatherPills = [['sun', ICON_SUN], ['rain', ICON_RAIN]].map(([v, icon]) => {
    const btn = h('button', { type: 'button', class: 'rf-pill', 'data-v': v, onclick: () => setWeather(v) });
    btn.innerHTML = icon;
    btn.append(tx('weather.' + v));
    return btn;
  });
  syncers.push(() => {
    const raining = state.get('rain') > RAIN_MIN;
    weatherPills.forEach((x) => x.classList.toggle('on', (x.dataset.v === 'rain') === raining));
  });
  const goBtn = bind(h('button', { type: 'button', class: 'go' }), () => t('intro.go.' + sceneKey));
  const intro = h('div', { class: 'rf-intro', role: 'dialog', 'aria-modal': 'true' },
    bind(h('h1'), () => t('intro.title.' + sceneKey)),
    h('div', { class: 'rf-opts' },
      h('div', { class: 'rf-opt' }, h('span', { class: 'cap' }, '语言 · Language'), h('div', { class: 'rf-pills' }, langButtons('rf-pill'))),
      h('div', { class: 'rf-opt' }, tx('intro.weather', 'span', { class: 'cap' }), h('div', { class: 'rf-pills' }, weatherPills))),
    goBtn,
    bind(h('small', { class: 'tip' }), () => t('intro.tip.' + sceneKey)),
  );
  function enter(e) {
    if (entered) return;
    entered = true;
    commitLang();
    state.set('audioEnabled', true);
    setInput(true);
    if (!isTouch && (!e || e.pointerType !== 'touch')) activeCtl()?.requestLock?.();
    intro.classList.add('gone');
    setTimeout(() => intro.remove(), 1500);
    showHint();
    refresh();
  }
  goBtn.addEventListener('click', enter);
  addEventListener('keydown', (e) => {   // 回车 = 进入（焦点在语言 / 天气按钮上时留给按钮自己）
    if (entered || e.code !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target?.closest?.('.rf-pill')) return;
    e.preventDefault(); enter(e);
  });

  /* ---- 操作提示 ---- */
  const hint = h('div', { class: 'rf-hint' });
  let hintTimer = 0;
  // 第二行：B 上下板 / C 坐下 / V 视角（键盘；两个控制器都在时才有 B）
  const hintText = () => {
    const skating = state.get('mode') === 'skate';
    const main = t((skating ? 'hint.skate.' : 'hint.walk.') + (isTouch ? 'touch' : 'key'));
    if (isTouch || !(ctx.player && ctx.skate)) return main;
    return main + '\n' + t(skating ? 'hint.skate.key2' : isFjord ? 'hint.walk.key2.fjord' : 'hint.walk.key2');
  };
  let hintFn = hintText;   // 当前显示的文案（坐下 / 视角提示会临时替换）
  bind(hint, () => hintFn());
  function showHint(fn = hintText, ms) {
    const skating = state.get('mode') === 'skate';
    hintFn = fn;
    hint.textContent = fn();
    requestAnimationFrame(() => hint.classList.add('show'));
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), ms ?? (skating ? 12000 : 7500));
  }
  // 坐下 / 视角切换：短暂提示一次，然后画面保持干净
  const offSit = state.on('sit', (v) => {
    if (!entered) return;
    if (v === 'pending') showHint(() => t('hint.sit.stopping'), 2600);
    else if (v === 'board' || v === 'ground') showHint(() => t(isTouch ? 'hint.sit.touch' : 'hint.sit'), 3200);
    else if (hintFn !== hintText) { hint.classList.remove('show'); hintFn = hintText; }
  });
  const offView = state.on('skateView', (v) => {
    if (!entered || state.get('mode') !== 'skate') return;
    showHint(() => t(v === 'first' ? 'hint.view.first' : 'hint.view.third'), 2200);
  });

  /* ---- HUD（速度 · 光点）、腾空/纪录提示、一程结算卡 ---- */
  const play = ctx.play || null;
  let hudEnabled = store.get(KEY_HUD)?.on !== false;
  state.set('hud', hudEnabled);
  const hudSpeed = h('b', {}, '0');
  const hudOrbN = h('b', {}, '0');
  const hudOrb = h('span', { class: 'orb' }, h('i'), hudOrbN, play ? ` / ${play.total}` : '');
  const hud = h('div', { class: 'rf-hud', 'aria-hidden': 'true' }, h('span', {}, hudSpeed, 'km/h'), play ? hudOrb : null);
  const airEl = h('div', { class: 'rf-flash', 'aria-hidden': 'true' });
  const recEl = h('div', { class: 'rf-flash rec', 'aria-hidden': 'true' });
  const flashTimers = new Map();
  function flash(el, text, ms) {
    if (!hudEnabled) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(flashTimers.get(el));
    flashTimers.set(el, setTimeout(() => el.classList.remove('show'), ms));
  }

  const cardDl = h('dl');
  const cardNote = h('p');
  const card = h('div', { class: 'rf-card', role: 'status' }, tx('card.title', 'h3'), cardDl, cardNote);
  document.body.appendChild(card);   // 放在 body 上：z-index 高于终点黑屏（#loading）
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  let lastRun = null;
  function renderCard() {
    const run = lastRun;
    if (!run) return;
    const row = (k, v, gold) => [h('dt', {}, k), h('dd', { class: gold ? 'gold' : '' }, v)];
    cardDl.replaceChildren(
      ...row(t('card.time'), fmtTime(run.time)),
      ...row(t('card.top'), `${Math.round(run.maxSpeed * 3.6)} km/h${run.record ? ' · ' + t('card.record') : ''}`, run.record),
      ...row(t('card.air'), run.maxAir > 0.05 ? `${run.maxAir.toFixed(1)} s` : '—'),
      ...row(t('card.orbs'), `${run.collected} / ${run.total}`, run.collected >= run.total),
    );
    cardNote.textContent = run.collected >= run.total ? t('card.allOrbs')
      : run.falls > 0 ? t('card.falls', { n: run.falls }) : t('card.clean');
  }
  binds.push(renderCard);
  function showCard(run) {
    lastRun = run;
    renderCard();
    card.classList.add('show');
  }
  const hideCard = () => card.classList.remove('show');
  const playOffs = [];
  if (play) {
    playOffs.push(play.on('collect', () => {
      hudOrbN.textContent = play.count;
      hudOrb.classList.remove('pop'); void hudOrb.offsetWidth; hudOrb.classList.add('pop');
    }));
    playOffs.push(play.on('reset', () => { hudOrbN.textContent = '0'; hideCard(); }));
    playOffs.push(play.on('finish', showCard));
    playOffs.push(play.on('record', (kmh) => flash(recEl, t('hud.record', { kmh: Math.round(kmh) }), 2600)));
  }
  if (ctx.skate?.on) {
    playOffs.push(ctx.skate.on('land', (rs) => { if ((rs?.airTime ?? 0) > 0.4) flash(airEl, t('hud.air', { s: rs.airTime.toFixed(1) }), 1900); }));
    playOffs.push(ctx.skate.on('start', hideCard));
  }

  // 遮幅：HUD / 提示放进黑边里（黑边够高时），否则贴着画面边缘
  function layoutLetterbox() {
    const bar = state.get('letterbox') ? Math.max(0, (innerHeight - innerWidth / 2.39) / 2) : 0;
    const st = root.style;
    st.setProperty('--lb', bar.toFixed(0) + 'px');
    st.setProperty('--hud-top', (bar >= 34 ? Math.round(bar / 2 - 9) : bar + 16) + 'px');
    st.setProperty('--hint-bottom', (bar >= 34 ? Math.round(bar / 2 - 9) : bar + 18) + 'px');
    st.setProperty('--flash-bottom', '9%');
    st.setProperty('--flash-top', '15%');
  }
  layoutLetterbox();
  addEventListener('resize', layoutLetterbox);
  const offLb = state.on('letterbox', layoutLetterbox);
  let lastKmh = -1;

  /* ---- 控制条 ---- */
  const rain = slider({ key: 'rain' });
  const fog = slider({ key: 'fog' });
  const master = slider({ key: 'masterVolume' });

  const rowRain = h('div', { class: 'rf-row' }, lab('row.rain'), end('rain.lo'), rain, end('rain.hi'));
  const rowFog = h('div', { class: 'rf-row' }, lab('row.fog'), end('fog.lo'), fog, end('fog.hi'));
  const rowTime = h('div', { class: 'rf-row' }, lab('row.time'), segment('timeOfDay', TIMES));

  // 场景切换
  const sceneBtns = Object.entries(ctx.scenes || {}).map(([id, def]) =>
    bind(h('button', {
      type: 'button', 'data-v': id, class: id === sceneId ? 'on' : '',
      onclick: () => { if (id !== sceneId) { flush(); ctx.switchScene?.(id); } },
    }), () => def.name));
  const rowScene = sceneBtns.length > 1
    ? h('div', { class: 'rf-row' }, lab('row.scene'), h('div', { class: 'rf-seg' }, sceneBtns))
    : null;

  // 晴 / 雨 快捷
  const weatherBtns = [['sun', 'w.sun'], ['rain', 'w.rain']].map(([v, label]) =>
    bind(h('button', { type: 'button', 'data-v': v, onclick: () => setWeather(v) }), () => t(label)));
  syncers.push(() => {
    const raining = state.get('rain') > RAIN_MIN;
    weatherBtns.forEach((b) => b.classList.toggle('on', (b.dataset.v === 'rain') === raining));
  });
  const rowWeather = h('div', { class: 'rf-row' }, lab('row.weather'), h('div', { class: 'rf-seg' }, weatherBtns));

  // 步行 / 滑板（两个控制器都在时才有）
  const rowMode = ctx.player && ctx.skate
    ? h('div', { class: 'rf-row' }, lab('row.mode'), segment('mode', [['walk', 'mode.walk'], ['skate', 'mode.skate']]))
    : null;
  // 滑板视角：第三人称 / 第一人称（滑板控制器读 state.skateView 并记住）
  const rowView = ctx.skate
    ? h('div', { class: 'rf-row' }, lab('row.view'), segment('skateView', [['third', 'view.third'], ['first', 'view.first']]))
    : null;

  // 显示开关：HUD、电影画幅
  const toggleBtn = (labelKey, isOn, flip) => {
    const b = bind(h('button', { type: 'button', onclick: flip }), () => t(labelKey));
    syncers.push(() => b.classList.toggle('on', !!isOn()));
    return b;
  };
  const setHud = (on) => { hudEnabled = on; store.set(KEY_HUD, { on }); state.set('hud', on); if (!on) for (const e of [airEl, recEl]) e.classList.remove('show'); };
  const rowDisplay = h('div', { class: 'rf-row' }, lab('row.display'),
    h('div', { class: 'rf-seg' },
      toggleBtn('disp.hud', () => hudEnabled, () => setHud(!hudEnabled)),
      toggleBtn('disp.letterbox', () => state.get('letterbox'), () => state.set('letterbox', !state.get('letterbox')))));
  const rowLang = h('div', { class: 'rf-row' }, lab('row.language'), h('div', { class: 'rf-seg' }, langButtons('')));

  // 调色（场景提供多套 look 时）
  const looks = ctx.sceneDef?.looks || [];
  const rowLook = looks.length > 1
    ? h('div', { class: 'rf-row' }, lab('row.look'), segment('look', looks.map((l) => [l.id, () => l.name])))
    : null;

  const btnSound = bind(h('button', { type: 'button', class: 'rf-btn', onclick: () => togglePop('sound') }), () => t('btn.sound'));
  const btnPreset = bind(h('button', { type: 'button', class: 'rf-btn', onclick: () => togglePop('preset') }), () => t('btn.presets'));
  const btnQuality = bind(h('button', { type: 'button', class: 'rf-btn', onclick: () => togglePop('quality') }), () => t('btn.quality'));
  const rowBtns = h('div', { class: 'rf-row' }, h('div', { class: 'rf-btns' }, btnSound, btnPreset, btnQuality));

  // 声音面板
  const layerRows = LAYERS.map(([k, nameKey, soon]) =>
    h('div', { class: 'rf-row' + (soon ? ' soon' : '') },
      lab(nameKey),
      slider({ key: 'vol.' + k }),
      soon ? tx('snd.soon', 'span', { class: 'rf-tag' }) : null));
  const musicBtn = h('button', { type: 'button', class: 'rf-btn', style: 'min-width:52px', onclick: () => state.set('music', !state.get('music')) });
  syncers.push(() => { const on = !!state.get('music'); musicBtn.textContent = t(on ? 'on' : 'off'); musicBtn.classList.toggle('on', on); });
  const extraRows = [
    h('div', { class: 'rf-row' }, lab('snd.music'), musicBtn, slider({ key: 'vol.music' })),
    h('div', { class: 'rf-row' }, lab('snd.board'), slider({ key: 'vol.board' })),
  ];
  const popSound = h('div', { class: 'rf-pop' },
    h('div', { class: 'rf-row' }, lab('snd.master'), master),
    h('div', { class: 'rf-layers' }, extraRows, layerRows));

  // 画质面板
  const popQuality = h('div', { class: 'rf-pop' },
    h('div', { class: 'rf-row' }, lab('btn.quality'), segment('quality', QUALITIES)),
    tx('q.note', 'div', { class: 'rf-note' }));

  // 预设面板
  const presetList = h('div', { class: 'rf-presets' });
  const nameInput = h('input', { type: 'text', maxlength: 12 });
  bind(nameInput, () => t('preset.name'), 'placeholder');
  bind(nameInput, () => t('preset.nameAria'), 'aria-label');
  const saveBtn = bind(h('button', { type: 'button', class: 'rf-btn', onclick: saveUserPreset }), () => t('preset.save'));
  const saveRow = h('div', { class: 'rf-save' }, nameInput, saveBtn);
  const addBtn = bind(h('button', { type: 'button', class: 'rf-btn', style: 'width:100%', onclick: () => { saveRow.style.display = 'flex'; addBtn.style.display = 'none'; nameInput.value = ''; setTimeout(() => nameInput.focus(), 30); } }), () => t('preset.add'));
  saveRow.style.display = 'none';
  const presetNote = h('div', { class: 'rf-note' });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUserPreset(); else if (e.key === 'Escape') cancelSave(); e.stopPropagation(); });
  const popPreset = h('div', { class: 'rf-pop' },
    tx('preset.builtin', 'div', { class: 'rf-label-h' }), presetList, addBtn, saveRow, presetNote);

  let userPresets = [];
  try {
    const raw = store.get(KEY_PRESETS);
    if (Array.isArray(raw)) {
      userPresets = raw.slice(0, MAX_USER_PRESETS)
        .filter((p) => p && typeof p.name === 'string')
        .map((p) => ({ name: p.name.slice(0, 12), data: sanitize(p.data) }));
    }
  } catch { userPresets = []; }

  function cancelSave() { saveRow.style.display = 'none'; addBtn.style.display = ''; }
  function saveUserPreset() {
    if (userPresets.length >= MAX_USER_PRESETS) return;
    const name = nameInput.value.trim().slice(0, 12) || t('preset.default', { n: userPresets.length + 1 });
    userPresets.push({ name, data: currentData() });
    store.set(KEY_PRESETS, userPresets);
    cancelSave();
    renderPresets();
  }
  function deletePreset(i) {
    userPresets.splice(i, 1);
    store.set(KEY_PRESETS, userPresets);
    renderPresets();
  }
  function renderPresets() {
    presetList.replaceChildren();
    for (const p of BUILTIN_PRESETS) {
      presetList.append(h('div', { class: 'item' }, h('button', { type: 'button', class: 'rf-btn', onclick: () => applyData(sanitize(p.data)) }, t(p.name))));
    }
    if (userPresets.length) {
      presetList.append(h('div', { class: 'rf-label-h', style: 'flex:0 0 100%;margin-bottom:0' }, t('preset.mine')));
    }
    userPresets.forEach((p, i) => {
      presetList.append(h('div', { class: 'item' },
        h('button', { type: 'button', class: 'rf-btn has-del', onclick: () => applyData(p.data) }, p.name),
        h('button', { type: 'button', class: 'rf-btn del', 'aria-label': t('preset.del', { name: p.name }), onclick: () => deletePreset(i) }, '×')));
    });
    const full = userPresets.length >= MAX_USER_PRESETS;
    addBtn.disabled = full;
    addBtn.style.opacity = full ? '.45' : '';
    presetNote.textContent = t(full ? 'preset.full' : 'preset.max', { max: MAX_USER_PRESETS });
  }
  renderPresets();
  binds.push(renderPresets);

  const pops = { sound: [popSound, btnSound], preset: [popPreset, btnPreset], quality: [popQuality, btnQuality] };
  let openPop = null;
  function togglePop(name) {
    openPop = openPop === name ? null : name;
    for (const [k, [pop, btn]] of Object.entries(pops)) {
      pop.classList.toggle('open', k === openPop);
      btn.classList.toggle('on', k === openPop);
    }
    touchActivity();
  }

  const bar = bind(h('div', { class: 'rf-bar rf-glass', role: 'region' }), () => t('panel.aria'), 'aria-label');
  bar.append(
    h('div', { class: 'rf-grid' }, rowScene, rowWeather, rowRain, rowFog, rowTime, rowMode, rowView, rowLook, rowDisplay, rowLang),
    h('div', { class: 'rf-grid' }, rowBtns),
    popSound, popPreset, popQuality);

  const fab = bind(h('button', { type: 'button', class: 'rf-fab rf-glass', onclick: () => showBar() }), () => t('panel.open'), 'aria-label');
  fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';

  root.append(hud, airEl, recEl, bar, fab, hint, intro);

  // UI 内的输入事件不冒泡到画布 / 全局（滑块拖动、触摸等）
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'wheel', 'contextmenu']) {
    for (const el of [bar, fab, intro]) el.addEventListener(type, (e) => e.stopPropagation(), { passive: type !== 'wheel' ? undefined : true });
  }

  /* ---- 显示 / 隐藏逻辑 ---- */
  let barVisible = false;
  let hover = false, pressed = false;
  let lastAct = performance.now();
  const idleBase = isTouch ? 5000 : 3000;
  const isLocked = () => !!document.pointerLockElement;

  function touchActivity() { lastAct = performance.now(); }
  function refresh() {
    bar.classList.toggle('show', barVisible);
    fab.classList.toggle('show', entered && !isLocked() && !barVisible);
    if (state.get('uiVisible') !== barVisible) state.set('uiVisible', barVisible);
  }
  function showBar() {
    if (!entered) return;
    if (isLocked()) for (const c of controllers()) c.exitLock?.();
    barVisible = true;
    touchActivity();
    refresh();
  }
  function hideBar() {
    if (!barVisible) return;
    barVisible = false;
    hover = false; pressed = false;
    refresh();
  }

  bar.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hover = true; });
  bar.addEventListener('pointerleave', () => { hover = false; touchActivity(); });
  bar.addEventListener('pointerdown', () => { pressed = true; touchActivity(); });
  bar.addEventListener('input', touchActivity);
  bar.addEventListener('scroll', touchActivity, { passive: true });
  addEventListener('pointerup', () => { pressed = false; touchActivity(); });
  addEventListener('pointercancel', () => { pressed = false; });
  document.addEventListener('pointermove', () => { if (barVisible && !isLocked()) touchActivity(); });
  // 冒泡到 document 的 pointerdown 一定来自 UI 之外（画布）：收起面板
  document.addEventListener('pointerdown', () => { if (entered) hideBar(); });

  document.addEventListener('pointerlockchange', () => {
    if (!entered) return;
    if (isLocked()) hideBar();
    else { barVisible = true; touchActivity(); }   // Esc 退出锁定 → 面板出现
    refresh();
  });

  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'))) return;
    if (e.code === 'KeyH') {
      if (!entered) return;
      if (barVisible) hideBar(); else showBar();
    }
  });

  /* ---- 状态同步 + 持久化 ---- */
  let dirty = true;
  const applyLangAttr = () => { root.dataset.lang = getLang(); card.dataset.lang = getLang(); };
  applyLangAttr();
  const offLang = onLang(() => { applyLangAttr(); for (const f of binds) f(); dirty = true; update(); });
  let saveAt = 0;
  state.on('*', (key) => {
    dirty = true;
    if (key === 'rain' && state.get('rain') > 0.02) lastRain = state.get('rain');
    if (['rain', 'fog', 'masterVolume', 'thunderRate', 'timeOfDay', 'quality', 'music', 'vol', ...VOL_KEYS.map((k) => 'vol.' + k)].includes(key)) {
      saveAt = performance.now() + 500;
    }
  });
  function persist() {
    const d = currentData();
    d.quality = state.get('quality');
    d.lastRain = lastRain;
    store.set(KEY_SETTINGS, d);
  }
  function flush() { saveAt = 0; persist(); }

  /* ---- 开场后行为 ---- */
  setInput(false);
  if (params?.has('nointro')) { entered = true; intro.remove(); setInput(true); showHint(); }
  // 步行控制器随模式启停（滑板控制器自行根据 state.mode 启停）
  const applyMode = () => {
    if (ctx.player && ctx.skate) ctx.player.enabled = state.get('mode') !== 'skate';
    if (entered) showHint();
  };
  if (ctx.player && ctx.skate) ctx.player.enabled = state.get('mode') !== 'skate';
  state.on('mode', applyMode);
  refresh();

  function update() {
    if (dirty) { dirty = false; for (const s of syncers) s(); }
    const now = performance.now();
    if (saveAt && now > saveAt) { saveAt = 0; persist(); }
    // HUD：整数 km/h 变化时才写 DOM
    const skating = state.get('mode') === 'skate' && ctx.skate?.enabled;
    const kmh = Math.round((skating ? (ctx.skate.state.speed || 0) : ctx.player ? Math.hypot(ctx.player.velocity.x, ctx.player.velocity.z) : 0) * 3.6);
    if (kmh !== lastKmh) { lastKmh = kmh; hudSpeed.textContent = kmh; }
    // 坐着欣赏风景时收起 HUD（淡出）
    const seated = state.get('sit') === 'board' || state.get('sit') === 'ground';
    hud.classList.toggle('show', entered && hudEnabled && !seated);
    const idleMs = state.get('mode') === 'skate' ? Math.min(2000, idleBase) : idleBase;
    if (barVisible && !hover && !pressed && !isLocked() && now - lastAct > idleMs) hideBar();
  }
  update();

  return {
    update,
    dispose() {
      style.remove(); bar.remove(); fab.remove(); hint.remove(); intro.remove(); hud.remove(); airEl.remove(); recEl.remove(); card.remove();
      for (const off of playOffs) off?.(); offLb?.(); offLang?.(); offSit?.(); offView?.(); removeEventListener('resize', layoutLetterbox);
    },
  };
}
