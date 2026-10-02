// 中 / 英双语。用法：t('key', {n: 3})、setLang('en')、getLang()、onLang(fn)（返回取消函数）。
// 语言存 localStorage（try/catch）；首次打开按浏览器语言预选；state 里的 'lang' 与此同步（state.set('lang', 'en') 也有效）。
// 字符串可以是函数 (vars) => string（用于英文复数等）。找不到的 key 先回退到中文，再回退到 key 本身。
import { state } from './state.js';

const KEY_LANG = 'rainforest.lang.v1';
export const LANGS = [['zh', '中文'], ['en', 'English']];

const STR = {
  zh: {
    'doc.title': '雨林漫游',
    'lang.label': '语言',
    // scenes / looks
    'scene.rainforest': '雨林',
    'scene.fjord': '峡湾山谷',
    'look.cool': '冰岛冷调',
    'look.warm': '暖阳胶片',
    // loading
    'load.goto': '前往{name}…',
    'load.land': '铺开大地…',
    'load.plants': '长出植物…',
    'load.shaders': '编译着色器…',
    'load.fail': '加载失败：{msg}',
    'load.again': '再滑一程…',
    'load.photo': '载入实景素材… {pct}%',
    'load.photoProc': '处理实景贴图…',
    // intro
    'intro.title.rainforest': '雨林漫游',
    'intro.title.fjord': '峡湾山谷',
    'intro.weather': '天气',
    'intro.go.rainforest': '进入雨林',
    'intro.go.fjord': '出发',
    'intro.tip.rainforest': '建议戴上耳机',
    'intro.tip.fjord': '建议戴耳机 · 下坡会越来越快，弯前记得刹车',
    'weather.sun': '晴天',
    'weather.rain': '雨天',
    // hints
    'hint.skate.touch': '右下角按钮：电机加速 / 刹车 · 左右拖动转弯 · 急弯前记得减速',
    'hint.skate.key': 'W 电机加速 · S 脚刹 · 空格 侧滑减速 · A/D 转弯 · Shift 下蹲 · 弯前减速，太快冲出路面会摔',
    'hint.walk.touch': '左侧拖动移动 · 右侧拖动环顾 · 右下角按钮打开面板',
    'hint.walk.key': 'WASD 移动 · Shift 加速 · 鼠标环顾 · H 显示面板',
    'hint.skate.key2': 'B 下板步行 · C 坐下 · V 切换视角',
    'hint.walk.key2': 'B 上滑板 · C 坐下',
    'hint.walk.key2.fjord': 'B 上滑板（回到最近的公路）· C 坐下',
    'hint.sit': 'C 或任意移动键 站起来 · 鼠标环顾',
    'hint.sit.touch': '点「站起」或拖动左侧 站起来',
    'hint.sit.stopping': '先刹停，再坐下…',
    'hint.view.first': '第一人称 · V 切回第三人称',
    'hint.view.third': '第三人称 · V 切到第一人称',
    'fade.toRoad': '回到最近的公路',
    // HUD / card
    'hud.air': '滞空 {s} s',
    'hud.record': '新纪录 {kmh} km/h',
    'card.title': '这一程',
    'card.time': '用时',
    'card.top': '最高速度',
    'card.air': '最长滞空',
    'card.orbs': '光点',
    'card.record': '新纪录',
    'card.allOrbs': '光点全部收集，太棒了',
    'card.falls': (v) => `摔了 ${v.n} 次，爬起来继续`,
    'card.clean': '一次都没摔，很稳',
    // panel
    'panel.aria': '设置',
    'panel.open': '打开设置面板 (H)',
    'row.scene': '场景',
    'row.weather': '天气',
    'row.rain': '雨量',
    'row.fog': '雾',
    'row.time': '时段',
    'row.mode': '方式',
    'row.display': '显示',
    'row.look': '色调',
    'row.language': '语言',
    'row.view': '视角',
    'view.third': '第三人称',
    'view.first': '第一人称',
    'w.sun': '晴',
    'w.rain': '雨',
    'rain.lo': '毛毛雨',
    'rain.hi': '暴雨',
    'fog.lo': '澄澈',
    'fog.hi': '浓雾',
    'time.day': '白天',
    'time.dusk': '黄昏',
    'time.night': '夜晚',
    'mode.walk': '步行',
    'mode.skate': '滑板',
    'disp.hud': '速度 · 光点',
    'disp.letterbox': '电影画幅',
    'btn.sound': '声音',
    'btn.presets': '预设',
    'btn.quality': '画质',
    'q.auto': '自动',
    'q.high': '高',
    'q.medium': '中',
    'q.low': '低',
    'q.eco': '省电',
    'q.note': '自动会根据帧率调整；夜间或低端设备可选「中」「低」。',
    'snd.master': '总音量',
    'snd.rain': '雨声',
    'snd.drips': '滴落',
    'snd.thunder': '雷声',
    'snd.wind': '风',
    'snd.stream': '溪流 · 海浪',
    'snd.insects': '鸟鸣 · 虫鸣',
    'snd.music': '音乐',
    'snd.board': '滑板声',
    'snd.soon': '即将推出',
    'on': '开',
    'off': '关',
    'preset.builtin': '内置',
    'preset.mine': '我的',
    'preset.sleep': '助眠',
    'preset.focus': '专注',
    'preset.storm': '暴风雨',
    'preset.free': '自由滑行',
    'preset.name': '给这套混音起个名字',
    'preset.nameAria': '预设名称',
    'preset.save': '保存',
    'preset.add': '保存当前为我的预设',
    'preset.del': '删除 {name}',
    'preset.default': '我的预设 {n}',
    'preset.full': '自定义预设已满 {max} 个，删除后可继续保存',
    'preset.max': '最多可保存 {max} 个自定义预设（含雨量、时段、雾、音量）',
    // touch buttons
    'touch.throttle': '油门',
    'touch.brake': '刹车',
    'touch.sit': '坐下',
    'touch.stand': '站起',
    'touch.view': '视角',
  },
  en: {
    'doc.title': 'Rainforest Roam',
    'lang.label': 'Language',
    'scene.rainforest': 'Rainforest',
    'scene.fjord': 'Icelandic Fjord',
    'look.cool': 'Nordic Cool',
    'look.warm': 'Warm Film',
    'load.goto': 'Heading to {name}…',
    'load.land': 'Unrolling the land…',
    'load.plants': 'Growing the plants…',
    'load.shaders': 'Compiling shaders…',
    'load.fail': 'Failed to load: {msg}',
    'load.again': 'One more ride…',
    'load.photo': 'Loading photo assets… {pct}%',
    'load.photoProc': 'Processing photo textures…',
    'intro.title.rainforest': 'Rainforest',
    'intro.title.fjord': 'Icelandic Fjord',
    'intro.weather': 'Weather',
    'intro.go.rainforest': 'Enter the rainforest',
    'intro.go.fjord': 'Start riding',
    'intro.tip.rainforest': 'Headphones recommended',
    'intro.tip.fjord': 'Headphones recommended · You gain speed downhill — brake before the bends',
    'weather.sun': 'Sunny',
    'weather.rain': 'Rainy',
    'hint.skate.touch': 'Bottom-right buttons: throttle / brake · Drag left or right to steer · Ease off before sharp bends',
    'hint.skate.key': 'W throttle · S brake · Space slide · A/D steer · Shift crouch · Slow down before hairpins — too fast and you\'ll crash',
    'hint.walk.touch': 'Drag left to move · Drag right to look · Bottom-right button opens the panel',
    'hint.walk.key': 'WASD move · Shift sprint · Mouse to look · H toggles the panel',
    'hint.skate.key2': 'B step off and walk · C sit down · V switch view',
    'hint.walk.key2': 'B hop on the board · C sit down',
    'hint.walk.key2.fjord': 'B hop on the board (back to the nearest road) · C sit down',
    'hint.sit': 'C or any move key to stand up · Mouse to look around',
    'hint.sit.touch': 'Tap "Stand" or drag on the left to stand up',
    'hint.sit.stopping': 'Braking to a stop, then sitting down…',
    'hint.view.first': 'First person · V for third person',
    'hint.view.third': 'Third person · V for first person',
    'fade.toRoad': 'Back to the nearest road',
    'hud.air': 'Airtime {s} s',
    'hud.record': 'New record {kmh} km/h',
    'card.title': 'This Ride',
    'card.time': 'Time',
    'card.top': 'Top speed',
    'card.air': 'Longest air',
    'card.orbs': 'Orbs',
    'card.record': 'New record',
    'card.allOrbs': 'Every orb collected — beautiful.',
    'card.falls': (v) => `Fell ${v.n} time${v.n === 1 ? '' : 's'} — got back up and kept going`,
    'card.clean': 'Not a single fall — smooth ride.',
    'panel.aria': 'Settings',
    'panel.open': 'Open settings (H)',
    'row.scene': 'Scene',
    'row.weather': 'Weather',
    'row.rain': 'Rain',
    'row.fog': 'Fog',
    'row.time': 'Time',
    'row.mode': 'Mode',
    'row.display': 'Display',
    'row.look': 'Look',
    'row.language': 'Language',
    'row.view': 'View',
    'view.third': 'Third person',
    'view.first': 'First person',
    'w.sun': 'Sunny',
    'w.rain': 'Rainy',
    'rain.lo': 'Drizzle',
    'rain.hi': 'Downpour',
    'fog.lo': 'Clear',
    'fog.hi': 'Dense',
    'time.day': 'Day',
    'time.dusk': 'Dusk',
    'time.night': 'Night',
    'mode.walk': 'Walk',
    'mode.skate': 'Skate',
    'disp.hud': 'Speed · Orbs',
    'disp.letterbox': 'Widescreen',
    'btn.sound': 'Sound',
    'btn.presets': 'Presets',
    'btn.quality': 'Quality',
    'q.auto': 'Auto',
    'q.high': 'High',
    'q.medium': 'Medium',
    'q.low': 'Low',
    'q.eco': 'Eco',
    'q.note': 'Auto adapts to your frame rate; at night or on weaker devices try Medium or Low.',
    'snd.master': 'Master',
    'snd.rain': 'Rain',
    'snd.drips': 'Drips',
    'snd.thunder': 'Thunder',
    'snd.wind': 'Wind',
    'snd.stream': 'Stream · Waves',
    'snd.insects': 'Birds · Insects',
    'snd.music': 'Music',
    'snd.board': 'Board',
    'snd.soon': 'Coming soon',
    'on': 'On',
    'off': 'Off',
    'preset.builtin': 'Built-in',
    'preset.mine': 'Mine',
    'preset.sleep': 'Sleep',
    'preset.focus': 'Focus',
    'preset.storm': 'Storm',
    'preset.free': 'Free Ride',
    'preset.name': 'Name this mix',
    'preset.nameAria': 'Preset name',
    'preset.save': 'Save',
    'preset.add': 'Save current as my preset',
    'preset.del': 'Delete {name}',
    'preset.default': 'My preset {n}',
    'preset.full': 'Custom presets are full ({max}) — delete one to save another',
    'preset.max': 'Up to {max} custom presets (rain, time, fog, volumes)',
    'touch.throttle': 'Throttle',
    'touch.brake': 'Brake',
    'touch.sit': 'Sit',
    'touch.stand': 'Stand',
    'touch.view': 'View',
  },
};

/* ------------------------------------------------------------------ 存取 */
function readSaved() {
  try { const v = localStorage.getItem(KEY_LANG); return v && STR[v] ? v : null; } catch { return null; }
}
function detect() {
  try {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
    return /^zh/i.test(list[0] || '') ? 'zh' : 'en';
  } catch { return 'zh'; }
}

let cur = readSaved() || detect();
const hadSaved = !!readSaved();
let chosen = hadSaved;     // 用户已选过语言（本次或以前）
const listeners = new Set();

function sideEffects() {
  try {
    document.documentElement.lang = cur === 'zh' ? 'zh-CN' : 'en';
    document.title = t('doc.title');
  } catch { /* ignore */ }
}

function tIn(lang, key, vars) {
  let s = STR[lang][key] ?? STR.zh[key] ?? key;
  if (typeof s === 'function') return s(vars || {});
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}
/** 首次打开、还没选语言时，加载提示中英文都显示（当前预选的语言在前） */
export function t(key, vars) {
  if (!chosen && key.startsWith('load.')) {
    const other = cur === 'zh' ? 'en' : 'zh';
    return `${tIn(cur, key, vars)}  ·  ${tIn(other, key, vars)}`;
  }
  return tIn(cur, key, vars);
}
export const getLang = () => cur;
/** 当前语言是否来自上次保存（false = 按浏览器语言预选） */
export const langWasSaved = () => hadSaved;
export function setLang(l) { if (STR[l]) state.set('lang', l); }
/** 把当前语言记住（进入时调用；setLang 也会调用） */
export function commitLang() { chosen = true; try { localStorage.setItem(KEY_LANG, cur); } catch { /* 隐私模式 */ } }
export function onLang(fn) { listeners.add(fn); return () => listeners.delete(fn); }

state.on('lang', (l) => {
  if (!STR[l] || l === cur) return;
  cur = l;
  commitLang();
  sideEffects();
  for (const fn of [...listeners]) { try { fn(cur); } catch (e) { console.error('[i18n]', e); } }
});
state.set('lang', cur);
sideEffects();
