// Audio engine: AudioContext, bus graph, shared noise + reverb, layer factory.
//
//   layer.dry ─► dryVol ─► mix ─┐
//   layer.wet ─► wetVol ─► reverb ─► mix
//   mix ─► highpass ─► master ─► compressor ─► destination
//
import { makeNoiseBuffer, makeReverbIR, makeTunnelIR } from './buffers.js';

const taper = (v) => v * v; // perceptual-ish fader curve

export function createEngine() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio not supported');
  const ac = new AC({ latencyHint: 'playback' });

  // ---- master chain -------------------------------------------------------
  const mix = ac.createGain();
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 28; hp.Q.value = 0.5;
  const master = ac.createGain();
  master.gain.value = 0;
  const comp = ac.createDynamicsCompressor();
  // Gentle peak control (not a squasher: rain transients must stay transient).
  comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 3;
  comp.attack.value = 0.005; comp.release.value = 0.2;
  // Soft clipper as a last safety net: transparent below 0.35, ceiling 0.56 (2x-oversampling
  // overshoot on flat-topped spikes measured ~+25%, keeping true peaks under ~0.85 = -1.4 dBFS).
  const clip = ac.createWaveShaper();
  {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
      c[i] = Math.sign(x) * (a < 0.35 ? a : 0.35 + 0.21 * Math.tanh((a - 0.35) / 0.21));
    }
    clip.curve = c; clip.oversample = '2x';
  }
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  mix.connect(hp); hp.connect(master); master.connect(comp); comp.connect(clip); clip.connect(ac.destination);
  clip.connect(analyser);

  // ---- shared reverb (procedural stereo IR, ~3 s) --------------------------
  const reverbIn = ac.createGain();
  const reverbHp = ac.createBiquadFilter();
  reverbHp.type = 'highpass'; reverbHp.frequency.value = 220;
  const convolver = ac.createConvolver();
  convolver.buffer = makeReverbIR(ac, 3.0, 77);
  const reverbOut = ac.createGain();
  reverbOut.gain.value = 0.85;
  reverbIn.connect(reverbHp); reverbHp.connect(convolver); convolver.connect(reverbOut); reverbOut.connect(mix);

  // ---- tunnel reverb: short, dense, bright concrete reflections (fed by per-layer tunnel sends) ----
  const tunnelIn = ac.createGain();
  const tunnelConv = ac.createConvolver();
  tunnelConv.buffer = makeTunnelIR(ac);
  const tunnelOut = ac.createGain();
  tunnelOut.gain.value = 0.9;
  tunnelIn.connect(tunnelConv); tunnelConv.connect(tunnelOut); tunnelOut.connect(mix);
  const layers = [];
  const loops = new Set(); // chained-segment loop players (see loops.js)

  // ---- shared noise (used by short one-shot voices) -------------------------
  const noise = {
    white: makeNoiseBuffer(ac, 'white', 2.3, 101),
    pink: makeNoiseBuffer(ac, 'pink', 2.9, 202),
  };

  const engine = {
    ac, mix, master, analyser,
    comp: clip, // final output node (compressor -> soft clipper); tools tap this
    compressor: comp, reverbIn, noise,
    now: () => ac.currentTime,
    registerLoop(l) { loops.add(l); },
    unregisterLoop(l) { loops.delete(l); },
    /** advance all loop players; call every ~50 ms */
    tickLoops(now) { for (const l of loops) l.tick(now); },

    /** Create a layer with its own dry + reverb-send inputs and a volume fader. */
    makeLayer(name, trim = 1) {
      const dry = ac.createGain(), wet = ac.createGain();
      const dryDuck = ac.createGain(), wetDuck = ac.createGain(); // situational ducking (tunnel roof ...)
      const dryVol = ac.createGain(), wetVol = ac.createGain();
      const tunSend = ac.createGain(); tunSend.gain.value = 0;
      dry.connect(dryDuck); dryDuck.connect(dryVol); dryVol.connect(mix);
      wet.connect(wetDuck); wetDuck.connect(wetVol); wetVol.connect(reverbIn);
      dryVol.connect(tunSend); tunSend.connect(tunnelIn);
      let vol = 0;
      const apply = (imm) => {
        const g = trim * taper(vol);
        for (const n of [dryVol, wetVol]) {
          if (imm) n.gain.value = g;
          else n.gain.setTargetAtTime(g, ac.currentTime, 0.08);
        }
      };
      apply(true);
      const layer = {
        name, dry, wet,
        setVolume(v, imm = false) { vol = Math.max(0, Math.min(1, v)); apply(imm); },
        /** multiplicative situational gain (1 = untouched) */
        setDuck(x, tc = 0.2) { for (const n of [dryDuck, wetDuck]) n.gain.setTargetAtTime(x, ac.currentTime, tc); },
        /** amount of the shared tunnel reverb this layer sends (0..~1) */
        setTunnelSend(x, tc = 0.2) { tunSend.gain.setTargetAtTime(x, ac.currentTime, tc); },
        dispose() { try { dry.disconnect(); wet.disconnect(); dryDuck.disconnect(); wetDuck.disconnect(); dryVol.disconnect(); wetVol.disconnect(); tunSend.disconnect(); } catch { /* ok */ } },
      };
      layers.push(layer);
      return layer;
    },

    setMaster(v, imm = false) {
      const g = taper(Math.max(0, Math.min(1, v)));
      if (imm) master.gain.value = g;
      else master.gain.setTargetAtTime(g, ac.currentTime, 0.08);
    },

    /** Fade master up from silence (avoids a pop on first start). */
    fadeInMaster(v) {
      const t = ac.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0, t);
      master.gain.setTargetAtTime(taper(v), t + 0.02, 0.5);
    },

    resume() { return ac.state === 'running' ? Promise.resolve() : ac.resume(); },
    suspend() { return ac.suspend(); },
    close() { return ac.close(); },

    /** Current output level in dBFS (rough RMS), for the test page meter. */
    levelDb() {
      const a = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(a);
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * a[i];
      return 10 * Math.log10(s / a.length + 1e-12);
    },
  };
  return engine;
}

/**
 * Poisson event scheduler: fires `fire(when)` at exponentially-distributed
 * intervals, scheduled ahead of ac.currentTime so events are sample-accurate.
 */
export function createPoisson(rateFn, fire) {
  let next = 0;
  return {
    tick(now, ahead) {
      const rate = rateFn();
      if (!(rate > 0.001)) { next = 0; return; }
      if (next === 0 || next < now - 0.3) next = now - Math.log(1 - Math.random()) / rate;
      let guard = 0;
      while (next < now + ahead && guard++ < 64) {
        fire(Math.max(next, now + 0.005));
        next += -Math.log(1 - Math.random()) / rate;
      }
    },
  };
}
