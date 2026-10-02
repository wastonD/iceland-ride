// Robust looping for noise / texture buffers.
//
// Why not BufferSource.loop = true?  In this Chrome/Electron build a looping BufferSource returns
// garbage after the first wrap for a scattering of buffer lengths (about 1 in 10, e.g. 100002,
// 235200, 244801 samples at 48 kHz; verified offline by comparing the render to the buffer).
// The garbage is noise-like but full of block-rate (48000/128 = 375 Hz multiples) tones, which
// is the "glassy" ringing users heard. So we never rely on it: a Loop chains ordinary one-shot
// BufferSources (start times computed by us) with a short equal-ish crossfade at each seam.
//
//   const lp = createLoop(engine, buffer, { rate: 1 });
//   lp.out            GainNode to connect onward
//   lp.setRate(v, now, tc)   playbackRate target (segments alive get it via setTargetAtTime)
//   lp.stop()
// engine.tickLoops(now) must be called regularly (audio.js does it every ~50 ms).

const OVERLAP = 0.012;   // seam crossfade (s)
const LOOKAHEAD = 0.45;  // create the next segment when this much of the current one is left (s)

export function createLoop(engine, buffer, opts = {}) {
  const { ac } = engine;
  const out = ac.createGain();
  const n = buffer.length, sr = buffer.sampleRate;
  const dur = n / sr;
  const segs = [];               // { src, g, t0 (start time), pos (samples played so far) }
  let rateNow = opts.rate ?? 1;  // modelled instantaneous rate
  let rateTarget = rateNow, rateTc = 0.001, rateT0 = 0;
  let lastT = ac.currentTime;
  let stopped = false;

  const rateAt = (t) => rateTarget + (rateNow - rateTarget) * Math.exp(-(t - rateT0) / rateTc);

  function spawn(t, offsetSamples) {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const g = ac.createGain();
    src.playbackRate.value = rateAt(t);
    src.connect(g); g.connect(out);
    const seg = { src, g, t0: t, pos: offsetSamples };
    // fade in
    if (segs.length) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + OVERLAP); }
    src.start(t, offsetSamples / sr);
    segs.push(seg);
    return seg;
  }

  function retire(seg, t) {
    // fade out over the overlap and stop
    seg.g.gain.setValueAtTime(1, t);
    seg.g.gain.linearRampToValueAtTime(0, t + OVERLAP);
    seg.src.stop(t + OVERLAP + 0.02);
    seg.src.onended = () => { try { seg.src.disconnect(); seg.g.disconnect(); } catch (e) { /* gone */ } };
  }

  const loop = {
    out,
    /** playbackRate shim so callers can keep writing `.src.playbackRate.setTargetAtTime(...)` */
    playbackRate: {
      setTargetAtTime: (v, t, tc) => loop.setRate(v, t, tc),
      get value() { return rateNow; },
    },
    setRate(v, t, tc = 0.1) {
      const now = Math.max(t, ac.currentTime);
      rateNow = rateAt(now); rateTarget = v; rateTc = Math.max(tc, 0.001); rateT0 = now;
      for (const s of segs) s.src.playbackRate.setTargetAtTime(v, now, tc);
    },
    tick(now) {
      if (stopped) return;
      const dt = Math.max(0, now - lastT); lastT = now;
      // integrate playback position of live segments (rate is slow-moving; midpoint estimate)
      for (const s of segs) {
        if (now > s.t0) {
          const from = Math.max(s.t0, now - dt);
          s.pos += ((rateAt(from) + rateAt(now)) * 0.5) * (now - from) * sr;
        }
      }
      // drop segments that have finished fading out
      while (segs.length > 1 && now > segs[1].t0 + OVERLAP + 0.05) segs.shift();
      const cur = segs[segs.length - 1];
      const r = Math.max(0.05, rateAt(now));
      const remaining = (n - cur.pos) / (r * sr);          // seconds of the current segment left
      const startsIn = cur.t0 - now;                        // >0 while the segment is still pending
      if (remaining + Math.max(0, startsIn) < LOOKAHEAD + dt) {
        const T = Math.max(now + 0.005, now + Math.max(0, startsIn) + remaining - OVERLAP);
        retire(cur, T);
        spawn(T, 0);
      }
    },
    stop() {
      stopped = true;
      for (const s of segs) { try { s.src.stop(); } catch (e) { /* not started */ } }
      engine.unregisterLoop(loop);
    },
  };

  // first segment starts now at a random offset (different phase per loop)
  const off = Math.floor((opts.offset ?? Math.random()) * n);
  spawn(ac.currentTime + 0.01, off);
  engine.registerLoop(loop);
  void dur;
  return loop;
}
