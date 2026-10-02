// One-shot voice factory shared by drips, board clicks, birds, footsteps ...
//
// A voice is a small throw-away node graph:  sources -> (your filters/gains) -> input
//   input = distance lowpass -> stereo panner -> layer.dry  (+ send -> layer.wet)
// Every source is stopped at t+dur; when the last one ends all nodes are disconnected.
// A global cap keeps the number of live voices (and therefore CPU) bounded.

const rnd = Math.random;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Envelope: 0.0001 -> peak (linear attack) -> exponential decay to ~0 over `dec`. */
export function envAD(g, t, peak, atk, dec) {
  const p = g.gain;
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(Math.max(0.0002, peak), t + atk);
  p.exponentialRampToValueAtTime(0.0002, t + atk + dec);
}

export function createVoices(engine, layer, maxActive = 36) {
  const { ac, noise } = engine;
  let active = 0;

  /**
   * @param t start time, dur total lifetime
   * @param dn distance 0..1 (far = darker + more reverb), pan -1..1
   * @param opts { wet: extra reverb multiplier, lp: override lowpass freq }
   */
  function voice(t, dur, dn = 0.1, pan = 0, opts = {}) {
    const nodes = [], srcs = [];
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = opts.lp ?? 17000 * Math.pow(0.15, dn); lp.Q.value = 0.5;
    const pn = ac.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1);
    const send = ac.createGain(); send.gain.value = (0.25 + 1.1 * dn) * (opts.wet ?? 1);
    lp.connect(pn); pn.connect(layer.dry); pn.connect(send); send.connect(layer.wet);
    nodes.push(lp, pn, send);
    const end = t + dur;
    return {
      input: lp, t, end,
      /** gain node with attack/decay envelope, connected to the voice input */
      gain(atk, peak, dec) {
        const g = ac.createGain(); g.gain.value = 0.0001;
        envAD(g, t, peak, atk, dec); g.connect(lp); nodes.push(g); return g;
      },
      noiseSrc(buf = noise.white) {
        const s = ac.createBufferSource(); s.buffer = buf;
        s.start(t, rnd() * (buf.duration - 0.6)); s.stop(end);
        srcs.push(s); nodes.push(s); return s;
      },
      osc(type = 'sine') {
        const o = ac.createOscillator(); o.type = type;
        o.start(t); o.stop(end);
        srcs.push(o); nodes.push(o); return o;
      },
      filter(type, f, q) {
        const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q;
        nodes.push(b); return b;
      },
      node(n) { nodes.push(n); return n; },
      seal() {
        active++;
        let left = srcs.length;
        for (const s of srcs) {
          s.onended = () => {
            if (--left > 0) return;
            active--;
            for (const n of nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
          };
        }
      },
    };
  }

  return { voice, canSpawn: () => active < maxActive, get active() { return active; } };
}
