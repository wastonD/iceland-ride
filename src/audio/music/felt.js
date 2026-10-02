// Soft instruments for the quiet music layer. All synthesis, no recordings.
//
//   felt piano (additive partials, hammer-darkened) ─┐
//   soft nylon pluck (Karplus-Strong one-shots)       ├─► highpass 150 ─► musicBus ─► duck ─► enable ─► out.dry
//   glass chime (few pure partials)                   │      (each also feeds out.wet, the shared reverb)
//   air (two sines, 6 s swell, barely there)          ┘
//
// Rule from the audio notes: never feed a looping BufferSource straight into a BiquadFilter;
// everything here is oscillators or one-shot buffers through a Gain first.
import { renderPluck, midiToHz } from './ks.js';

export function createFelt(engine, out) {
  const ac = engine.ac;
  const rnd = Math.random;
  const nodes = [];
  const mk = (n) => { nodes.push(n); return n; };
  const gain = (v) => { const g = mk(ac.createGain()); g.gain.value = v; return g; };
  const biquad = (type, f, q = 0.7) => { const b = mk(ac.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };

  // ---- output chain ------------------------------------------------------------------
  const duck = gain(1);      // rain ducking
  const enable = gain(1);    // music on/off fade
  const bassCut = biquad('highpass', 150, 0.6);  // keeps the layer out of the low register altogether
  const bus = gain(1);
  bus.connect(bassCut); bassCut.connect(duck); duck.connect(enable); enable.connect(out.dry);
  const send = (level) => { const g = gain(level); g.connect(out.wet); return g; };

  // piano: felt-muffled low-pass (opens a hair with energy)
  const pianoBus = gain(0.9);
  const pianoTone = biquad('lowpass', 2600, 0.45);
  pianoBus.connect(pianoTone); pianoTone.connect(bus);
  const pianoSend = send(0.5); pianoTone.connect(pianoSend);

  const pluckBus = gain(0.55);
  const pluckTone = biquad('lowpass', 2000, 0.5);
  pluckBus.connect(pluckTone); pluckTone.connect(bus);
  const pluckSend = send(0.5); pluckTone.connect(pluckSend);

  const chimeBus = gain(0.5); chimeBus.connect(bus);
  const chimeSend = send(0.85); chimeBus.connect(chimeSend);

  const airBus = gain(0.1);
  const airTone = biquad('lowpass', 1400, 0.4);
  airBus.connect(airTone); airTone.connect(bus);
  const airSend = send(0.6); airTone.connect(airSend);

  const cleanup = (src, list) => { src.onended = () => { for (const n of list) { try { n.disconnect(); } catch { /* ok */ } } }; };

  // ---- pluck sample cache (dark nylon) -----------------------------------------------
  const sampleCache = new Map();
  const queue = [];
  const getBuf = (midi) => {
    let b = sampleCache.get(midi);
    if (!b) {
      const data = renderPluck(ac.sampleRate, midi, 2.6, { bright: 0.16, t60Scale: 0.75 });
      b = ac.createBuffer(1, data.length, ac.sampleRate);
      b.copyToChannel(data, 0);
      sampleCache.set(midi, b);
    }
    return b;
  };

  const api = {
    prewarm(midis) { for (const m of midis) if (!sampleCache.has(m) && !queue.includes(m)) queue.push(m); },
    pump(n = 1) { while (n-- > 0 && queue.length) getBuf(queue.shift()); },

    /**
     * Felt piano note: 6 partials (slightly stretched, as on a real string), two detuned strings on the
     * fundamental for a slow shimmer, 7-12 ms soft attack, darker with low velocity, short soft "thud".
     */
    piano(t, midi, vel, pan = 0) {
      const f = midiToHz(midi);
      const B = 0.00016 * Math.pow(f / 261, 2);
      const bright = 0.25 + 0.5 * vel;                       // hammer hardness
      const tau1 = Math.max(1.2, 3.4 - 0.04 * (midi - 48)); // fundamental decay (s): low notes ring longer
      const att = 0.008 + 0.006 * (1 - vel);
      const panner = ac.createStereoPanner(); panner.pan.value = pan;
      const master = ac.createGain(); master.gain.value = vel * 0.34;
      master.connect(panner); panner.connect(pianoBus);
      const list = [panner, master];
      let last = null;
      for (let n = 1; n <= 6; n++) {
        const fn = f * n * Math.sqrt(1 + B * n * n);
        if (fn > 7000) break;
        const a = Math.pow(n, -1.05) * Math.exp(-Math.pow((n - 1) / (1.2 + 3.4 * bright), 2));
        const tau = tau1 / (1 + 0.85 * (n - 1));
        const strings = n <= 2 ? [-1.3, 1.3] : [0];
        for (const det of strings) {
          const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = fn; o.detune.value = det + (rnd() - 0.5) * 0.8;
          const g = ac.createGain();
          const amp = a / strings.length;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(amp, t + att);
          g.gain.setTargetAtTime(0, t + att, tau);
          o.connect(g); g.connect(master);
          o.start(t); o.stop(t + att + Math.min(9, tau * 7));
          list.push(o, g); last = last || o;
        }
      }
      // felt thud: very short low-passed noise
      const nz = ac.createBufferSource(); nz.buffer = engine.noise.pink;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.05 * vel, t + 0.004); ng.gain.setTargetAtTime(0, t + 0.006, 0.018);
      const nf = ac.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = Math.min(1500, f * 3);
      nz.connect(ng); ng.connect(nf); nf.connect(master);
      nz.start(t, rnd() * 1.5, 0.12); nz.stop(t + 0.12);
      list.push(nz, ng, nf);
      cleanup(last, list);
    },

    pluck(t, midi, vel, pan = 0) {
      const src = ac.createBufferSource(); src.buffer = getBuf(midi);
      const g = ac.createGain(); g.gain.value = vel * 0.8;
      const p = ac.createStereoPanner(); p.pan.value = pan;
      src.connect(g); g.connect(p); p.connect(pluckBus);
      src.start(t);
      cleanup(src, [src, g, p]);
    },

    /** Glass / music-box chime: pure, quiet, slow-ish decay. */
    chime(t, midi, vel, pan = 0) {
      const f = midiToHz(midi);
      const panner = ac.createStereoPanner(); panner.pan.value = pan;
      panner.connect(chimeBus);
      const list = [panner];
      let last = null;
      for (const [r, a, tau] of [[1, 0.2, 1.5], [2.0, 0.045, 0.6], [4.17, 0.012, 0.18]]) {
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f * r;
        const g = ac.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(a * vel, t + 0.004);
        g.gain.setTargetAtTime(0, t + 0.006, tau);
        o.connect(g); g.connect(panner);
        o.start(t); o.stop(t + 0.01 + tau * 7);
        list.push(o, g); last = last || o;
      }
      cleanup(last, list);
    },

    /** Faint breath: two sines (root + fifth) swelling over ~6 s and leaving over ~8 s. Very low level. */
    air(t, midis, dur = 12) {
      const list = [];
      let last = null;
      for (const m of midis) {
        const f = midiToHz(m);
        for (const det of [-3, 3]) {
          const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = det + (rnd() - 0.5) * 2;
          const g = ac.createGain();
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.5 / midis.length, t + dur * 0.5);
          g.gain.linearRampToValueAtTime(0, t + dur);
          o.connect(g); g.connect(airBus);
          o.start(t); o.stop(t + dur + 0.1);
          list.push(o, g); last = o;
        }
      }
      if (last) cleanup(last, list);
    },

    /** energy 0..1 (already smoothed, very slow): a hair more brightness, nothing else. */
    setEnergy(e) {
      const now = ac.currentTime;
      pianoTone.frequency.setTargetAtTime(2400 + 900 * e, now, 3);
      pluckTone.frequency.setTargetAtTime(1900 + 700 * e, now, 3);
    },
    setDuck(v) { duck.gain.setTargetAtTime(v, ac.currentTime, 1.2); },
    setEnabled(on) { enable.gain.setTargetAtTime(on ? 1 : 0, ac.currentTime, 0.35); },

    dispose() {
      for (const n of nodes) { try { n.disconnect(); } catch { /* ok */ } }
      sampleCache.clear();
    },
  };
  return api;
}
