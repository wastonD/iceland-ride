// Quiet generative composition — pure functions, no Web Audio, no DOM (node-testable).
//
// Mood: a few soft notes with long silences, slow open harmony (fifths, ninths, sus chords),
// mid/high register, almost no bass. Nothing here is taken from an existing piece: pitches are a
// weighted random walk over the key's seven notes with a one-cell motif memory.
//
// Time is in seconds (no bar grid): the composer hands out "events" one gap at a time.
//   const c = createQuiet(seed);
//   c.next(ctrl) -> { dt, notes:[{kind,midi,vel,dt}], chord? } where ctrl = { energy, rain, scene }
// The caller keeps its own clock: t += dt, then schedules notes at t + note.dt.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mod12 = (n) => ((n % 12) + 12) % 12;
/** scale-step index (any integer) -> semitones above the tonic of the major scale */
export const sc = (i) => MAJOR[((i % 7) + 7) % 7] + 12 * Math.floor(i / 7);

// ---- per-scene colour --------------------------------------------------------------------
// tonic: scale index (of the session's major scale) used as home chord. 0 = ionian (bright, open),
//        5 = aeolian (cool, nordic). All chords stay inside the same seven notes.
export const SCENES = {
  rainforest: {
    tonic: 0,
    roots: [0, 3, 5, 4, 1],
    // next-root weights by current root
    next: { 0: [[3, 3], [5, 3], [4, 2], [1, 1]], 3: [[0, 3], [5, 2], [1, 2], [4, 1]], 5: [[3, 3], [0, 2], [1, 2], [4, 1]], 4: [[0, 3], [5, 2], [3, 2]], 1: [[4, 3], [0, 2], [3, 2]] },
    plucked: 0.28,   // share of melody notes played by the soft nylon pluck instead of the piano
    chime: 0.06,
    regCenter: 68,
    gapScale: 1.0,
  },
  fjord: {
    tonic: 5,
    roots: [5, 3, 0, 4, 1],
    next: { 5: [[3, 3], [0, 3], [4, 2], [1, 1]], 3: [[5, 3], [0, 2], [4, 2], [1, 1]], 0: [[4, 3], [5, 3], [3, 2]], 4: [[5, 3], [0, 2], [3, 2]], 1: [[5, 3], [4, 2], [3, 2]] },
    plucked: 0.0,
    chime: 0.2,
    regCenter: 72,
    gapScale: 1.18,
  },
};

// chord shapes in scale steps above the chord root: low dyad + colour tones
const SHAPES = [
  { name: 'open5', steps: [0, 4, 8], w: 2 },   // root, 5th, 9th  (no third: open)
  { name: 'sus2', steps: [0, 1, 4], w: 3 },
  { name: 'sus4', steps: [0, 3, 4], w: 2, notOn: [3] }, // IV sus4 would hold the lydian tritone
  { name: 'add9', steps: [0, 2, 4, 8], w: 2 },
  { name: 'maj7', steps: [0, 2, 4, 6], w: 1 },
];

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function wpick(rng, pairs) {
  let tot = 0; for (const [, w] of pairs) tot += w;
  let r = rng() * tot;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

export function createQuiet(seed = (Math.random() * 4294967296) >>> 0) {
  const rng = mulberry32(seed);
  const keyPc = pick(rng, [0, 2, 5, 7, 9]);         // C D F G A
  let chord = null, chordLeft = 0;                    // seconds remaining in the current chord
  let lastIdx = null;                                 // last melody note as a scale-step index (absolute)
  let cell = null;                                    // last phrase as scale-step intervals (motif memory)
  let phraseLeft = 0;                                 // notes left in the current phrase
  let phraseIv = null, phraseCursor = 0;              // replayed motif
  let sceneSeen = null;
  const nameOf = (c) => `${c.root}:${c.shape.name}`;

  const stepOfMidi = (m) => { // nearest scale-step index of a midi pitch (for the random walk)
    let best = 0, bd = 99;
    for (let i = -14; i < 40; i++) { const d = Math.abs(keyPc + sc(i) + 36 - m); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  const midiOfStep = (i) => keyPc + sc(i) + 36;       // octave-3 anchored: idx 14 -> 2 octaves up

  function newChord(scene) {
    const S = SCENES[scene] || SCENES.rainforest;
    let root;
    if (!chord || sceneSeen !== scene) root = S.tonic;
    else root = wpick(rng, S.next[chord.root] || [[S.tonic, 1]]);
    let shape;
    for (let k = 0; k < 8; k++) {
      shape = wpick(rng, SHAPES.map((s) => [s, s.w]));
      if (shape.notOn && shape.notOn.includes(((root % 7) + 7) % 7)) continue;
      if (chord && chord.root === root && chord.shape === shape) continue;
      break;
    }
    sceneSeen = scene;
    chord = { root, shape, pcs: shape.steps.map((s) => mod12(keyPc + sc(root + s))) };
    chord.low = lowDyad(root);
    chordLeft = 15 + rng() * 9;                      // 15..24 s per chord
    return chord;
  }

  // soft root + fifth for the left hand, never below G3 (keeps energy out of the <200 Hz region)
  function lowDyad(root) {
    const lo = 57;
    const r = lo + mod12(keyPc + sc(root) - lo);
    return [r, r + 7];
  }

  function melodyPool(S) {
    const pool = [];
    const root = chord.root;
    const hasSus4 = chord.shape.name === 'sus4';
    for (let i = 0; i <= 28; i++) {
      const m = midiOfStep(i);
      if (m < 60 || m > 86) continue;
      const rel = (((i - root) % 7) + 7) % 7;
      let w = 1;
      if (rel === 0 || rel === 4) w = 3;            // root, fifth
      else if (rel === 1) w = 2.2;                  // ninth
      else if (rel === 2) w = hasSus4 ? 0.3 : 1.6;
      else if (rel === 3) w = hasSus4 ? 2 : 0.7;
      else if (rel === 6) w = 0.6;
      else if (rel === 5) w = 1.1;
      pool.push({ i, m, w });
    }
    return pool;
  }

  function nextNote(S, e) {
    const pool = melodyPool(S);
    if (lastIdx === null) lastIdx = stepOfMidi(S.regCenter);
    // motif replay: transpose the remembered interval cell onto the current harmony
    if (phraseIv) {
      const iv = phraseIv[phraseCursor++];
      if (phraseCursor >= phraseIv.length) phraseIv = null;
      let target = lastIdx + iv;
      let best = pool[0], bd = 99;
      for (const p of pool) { const d = Math.abs(p.i - target) - 0.35 * p.w; if (d < bd) { bd = d; best = p; } }
      return best;
    }
    const cand = [];
    for (const p of pool) {
      const d = p.i - lastIdx;
      if (Math.abs(d) > 4) continue;
      let w = p.w;
      const ad = Math.abs(d);
      w *= ad === 0 ? 0.25 : ad === 1 ? 2.2 : ad === 2 ? 1.6 : ad === 3 ? 0.8 : 0.4;
      w *= Math.exp(-Math.pow((p.m - S.regCenter) / 6.5, 2) * 0.5) + 0.05;   // stay in the middle register
      cand.push([p, w]);
    }
    return wpick(rng, cand);
  }

  /**
   * One musical gesture. `dt` = silence before it (relative to the previous gesture),
   * `notes` = [{ kind, midi, vel, dt }] with dt relative to the gesture start.
   */
  function next(ctrl) {
    const scene = SCENES[ctrl.scene] ? ctrl.scene : 'rainforest';
    const S = SCENES[scene];
    const e = clamp01(ctrl.energy || 0), rain = clamp01(ctrl.rain || 0);
    // the speed effect is deliberately tiny: a little more often, never louder or denser than "a few notes"
    const gapMul = S.gapScale * (1 - 0.14 * e) * (1 + 0.5 * rain);
    const out = { dt: 0, notes: [], chord: null };

    let startedChord = false;
    if (!chord || chordLeft <= 0 || sceneSeen !== scene) {
      newChord(scene); startedChord = true;
      out.chord = { low: chord.low, pcs: chord.pcs, root: chord.root, name: nameOf(chord) };
    }

    // rest between phrases (long breaths), shorter gaps inside a phrase
    let gap;
    if (phraseLeft <= 0) {
      phraseLeft = 2 + Math.floor(rng() * 3.4);       // 2..5 notes
      gap = (4 + rng() * 4.5) * gapMul;               // 4..8.5 s of near silence
      if (rng() < 0.18) gap *= 1.5;                   // occasionally a really long pause
      if (!cell || rng() > 0.4) phraseIv = null;
      else { phraseIv = cell.slice(); phraseCursor = 0; }
      cell = [];
    } else {
      gap = pick(rng, [1.4, 1.9, 2.4, 3.0, 3.6]) * gapMul * (0.9 + 0.2 * rng());
    }
    if (startedChord) gap = Math.max(gap, 3.2 * gapMul); // let the new harmony settle before melody resumes
    out.dt = gap;
    chordLeft -= gap;

    const note = nextNote(S, e);
    if (cell) cell.push(note.i - (lastIdx ?? note.i));
    lastIdx = note.i;
    phraseLeft--;
    const r = rng();
    const kind = r < S.chime && note.m >= 72 ? 'chime' : r < S.chime + S.plucked ? 'pluck' : 'piano';
    const vel = (0.34 + 0.2 * rng()) * (kind === 'chime' ? 0.8 : 1);
    out.notes.push({ kind, midi: note.m, vel, dt: 0 });
    // sometimes a soft octave-up echo or a held neighbour, never a chord stack
    if (kind === 'piano' && note.m + 12 <= 94 && rng() < 0.1 + 0.1 * (1 - rain)) {
      out.notes.push({ kind: 'chime', midi: note.m + 12, vel: 0.22 + 0.1 * rng(), dt: 0.9 + rng() * 0.5 });
    }
    return out;
  }

  /** Does the chord change want an accompanying low dyad? (only sometimes: the bass is a rarity) */
  const wantsDyad = () => rng() < 0.45;
  /** Is a faint breathy swell wanted with this chord? */
  const wantsAir = (scene) => rng() < (scene === 'fjord' ? 0.4 : 0.22);

  return { seed, keyPc, next, wantsDyad, wantsAir, get chord() { return chord; } };
}
