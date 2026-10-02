// Looping noise chain: buffer source -> gain -> fixed biquads -> out gain.
//
// Two Chrome pitfalls learned the hard way:
//  * a looping BufferSource wired straight into a BiquadFilter can blow the filter up
//    to NaN after the first loop wrap -> always put a plain gain node in between;
//  * continuously automating a biquad's frequency/Q can also go unstable, so filters
//    here are FIXED; brightness changes are done by cross-fading band gains and
//    pitch changes by automating the source's playbackRate (which is safe).
// A watchdog (heal) rebuilds the filters if a NaN ever appears.
import { makeNoiseBuffer } from './buffers.js';
import { createLoop } from './loops.js';

let seedCounter = 900;

/**
 * Pull-based Web Audio only renders what is connected to the destination, so a layer part
 * whose level is ~0 can be disconnected to cost nothing. Gate wraps a node's outgoing
 * connections: update(level, dt) disconnects after ~1.5 s of silence, reconnects at once
 * when the level comes back.
 */
export class Gate {
  constructor(node) { this.node = node; this.targets = []; this.active = true; this.idle = 0; }
  connect(dest, output, input) {
    this.targets.push([dest, output, input]);
    if (this.active) this.node.connect(...[dest, output, input].filter((x) => x !== undefined));
    return dest;
  }
  update(level, dt) {
    if (level > 2e-4) {
      this.idle = 0;
      if (!this.active) { this.active = true; for (const t of this.targets) this.node.connect(...t.filter((x) => x !== undefined)); }
    } else if (this.active && (this.idle += dt) > 1.5) {
      this.active = false; this.node.disconnect();
    }
  }
}

/**
 * @param spec { type:'white'|'pink'|'brown', seconds, filters:[{type,f,q}], buffer? , seed? }
 * @returns { src, out(GainNode), heal(), stop() }
 */
export function makeChain(engine, spec) {
  const ac = engine.ac;
  const src = createLoop(engine, spec.buffer || makeNoiseBuffer(ac, spec.type, spec.seconds ?? 5, spec.seed ?? (seedCounter += 37)));
  const buffer = ac.createGain();
  src.out.connect(buffer);
  const out = ac.createGain();
  const filters = [];
  const wire = () => {
    filters.length = 0;
    let node = buffer;
    for (const fd of spec.filters || []) {
      const f = ac.createBiquadFilter();
      f.type = fd.type; f.frequency.value = fd.f; f.Q.value = fd.q ?? 0.7;
      node.connect(f); node = f; filters.push(f);
    }
    node.connect(out);
  };
  wire();
  const probe = ac.createAnalyser(); probe.fftSize = 256;
  const gate = new Gate(out);
  gate.connect(probe);
  const buf = new Float32Array(256);
  return {
    src, out, gate,
    /** connect the chain output somewhere (through the gate) */
    connect: (dest, o, i) => gate.connect(dest, o, i),
    /** report the chain's current target level; the chain idles out of the graph at ~0 */
    setLevel: (level, dt) => gate.update(level, dt),
    heal() {
      if (!gate.active) return;
      probe.getFloatTimeDomainData(buf);
      if (buf.every(Number.isFinite)) return;
      console.warn('[audio] filter went NaN, rebuilding');
      buffer.disconnect(); for (const f of filters) f.disconnect();
      wire();
    },
    stop() { src.stop(); },
  };
}

/** Equal-power left/right gains for pan in -1..1. */
export function panGains(pan) {
  const a = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4;
  return [Math.cos(a), Math.sin(a)];
}
