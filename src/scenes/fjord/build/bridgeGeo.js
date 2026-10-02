// Single-span red steel truss bridge over the basalt gorge: concrete deck slab with girders
// underneath, through-truss sides, stone-faced abutments keyed into the canyon walls.
import { MeshBuilder, lin } from './builder.js';
import { computeFrames } from './roadGeo.js';
import { beamBox, localPoint, frameAtIndex } from './util.js';

export const BR = { slabHalf: 5.0, slabTop: -0.02, slabThick: 0.95, trussL: 5.2, trussH: 5.4, panels: 8 };

const terr = (world, F, s, l) => { const f = frameAtIndex(F, s); return world.heightAt(f.x + f.rx * l, f.z + f.rz * l); };

export function buildBridge(world) {
  const F = computeFrames(world.path.points, 2);
  const B = world.path.bridges[0];
  // abutment stations: canyon edge = first/last station whose centre-line terrain is > 1.5 m below the deck
  let sa = B.s0; while (sa < B.s1 && terr(world, F, sa, 0) > frameAtIndex(F, sa).y - 1.5) sa++;
  let sb = B.s1; while (sb > B.s0 && terr(world, F, sb, 0) > frameAtIndex(F, sb).y - 1.5) sb--;
  sa -= 1; sb += 1;
  const conc = new MeshBuilder(), steel = new MeshBuilder(), stone = new MeshBuilder();
  const cCol = lin('#a3a19a'), cDark = lin('#6f6d68'), red = lin('#b5372c'), redD = lin('#8f2b22');
  const P = (s, l, y) => { const f = frameAtIndex(F, s); return [f.x + f.rx * l + 0, f.y + y, f.z + f.rz * l]; };

  // ----------------------------------------------------------- deck slab + girders
  const { slabHalf: H, slabTop: ST, slabThick: TH } = BR;
  const rows = []; for (let s = B.s0; s <= B.s1; s += 1) rows.push(s);
  for (let k = 0; k < rows.length - 1; k++) {
    const a = rows[k], b = rows[k + 1];
    // top (mostly hidden under the asphalt; visible on the outer strip)
    conc.quadU(P(a, -H, ST), P(a, H, ST), P(b, H, ST), P(b, -H, ST), [0, 1, 0], { color: cCol, su: 1 / 3, sv: 1 / 3, u0: 0, v0: a / 3 });
    // underside
    conc.quadU(P(a, -H, ST - TH), P(a, H, ST - TH), P(b, H, ST - TH), P(b, -H, ST - TH), [0, -1, 0], { color: cDark, su: 1 / 3, sv: 1 / 3, v0: a / 3 });
    // sides
    for (const sg of [-1, 1]) {
      const hint = (() => { const f = frameAtIndex(F, a); return [sg * f.rx, 0, sg * f.rz]; })();
      conc.quadU(P(a, sg * H, ST - TH), P(b, sg * H, ST - TH), P(b, sg * H, ST), P(a, sg * H, ST), hint, { color: cCol, su: 1 / 3, sv: 1 / 3, v0: a / 3 });
    }
    // kerbs just outside the asphalt
    for (const sg of [-1, 1]) {
      const l0 = sg * 4.5, l1 = sg * 4.95, hh = 0.26;
      const f = frameAtIndex(F, a), hr = [sg * f.rx, 0, sg * f.rz];
      conc.quadU(P(a, l0, ST + hh), P(a, l1, ST + hh), P(b, l1, ST + hh), P(b, l0, ST + hh), [0, 1, 0], { color: cCol, su: 1, sv: 1 });
      conc.quadU(P(a, l0, ST), P(b, l0, ST), P(b, l0, ST + hh), P(a, l0, ST + hh), [-hr[0], 0, -hr[2]], { color: cCol, su: 1, sv: 1 });
      conc.quadU(P(a, l1, ST), P(b, l1, ST), P(b, l1, ST + hh), P(a, l1, ST + hh), hr, { color: cCol, su: 1, sv: 1 });
    }
  }
  // longitudinal girders under the slab (span between abutments), cross diaphragms
  for (const l of [-3.4, 0, 3.4]) beamBox(conc, P(sa, l, ST - TH), P(sb, l, ST - TH), 0.5, 0.9 + 0.5, cDark, [0, 1, 0]);
  const nD = 9;
  for (let k = 0; k <= nD; k++) { const s = sa + ((sb - sa) * k) / nD; beamBox(conc, P(s, -H + 0.2, ST - TH - 0.3), P(s, H - 0.2, ST - TH - 0.3), 0.3, 0.6, cDark, [0, 1, 0]); }

  // ------------------------------------------------------------ truss (each side)
  const { trussL: TL, trussH: HH, panels: N } = BR;
  const span = sb - sa, pl = span / N;
  const yb = -0.55, yt = HH;                      // chord centre lines relative to deck
  const stationS = (i) => sa + i * pl;
  for (const sg of [-1, 1]) {
    const l = sg * TL;
    for (let i = 0; i < N; i++) {
      const s0 = stationS(i), s1 = stationS(i + 1);
      beamBox(steel, P(s0, l, yb), P(s1, l, yb), 0.42, 0.5, red, [0, 1, 0]);        // bottom chord
      beamBox(steel, P(s0, l, yt), P(s1, l, yt), 0.42, 0.5, red, [0, 1, 0]);        // top chord
      // diagonals: Warren pattern (up, down alternating), toward the mid-span from each end
      const up = i < N / 2;
      if (up) beamBox(steel, P(s0, l, yb), P(s1, l, yt), 0.26, 0.26, redD, [0, 0, 1]);
      else beamBox(steel, P(s0, l, yt), P(s1, l, yb), 0.26, 0.26, redD, [0, 0, 1]);
    }
    for (let i = 0; i <= N; i++) beamBox(steel, P(stationS(i), l, yb), P(stationS(i), l, yt), 0.3, 0.3, red, [1, 0, 0]);  // verticals
  }
  // top lateral bracing + portal frames
  for (let i = 0; i <= N; i++) {
    const s = stationS(i);
    beamBox(steel, P(s, -TL, yt), P(s, TL, yt), 0.28, 0.34, red, [0, 1, 0]);
  }
  for (let i = 0; i < N; i += 1) {   // X bracing in the top plane
    if (i % 2) continue;
    beamBox(steel, P(stationS(i), -TL, yt), P(stationS(i + 1), TL, yt), 0.16, 0.16, redD, [0, 1, 0]);
    beamBox(steel, P(stationS(i), TL, yt), P(stationS(i + 1), -TL, yt), 0.16, 0.16, redD, [0, 1, 0]);
  }
  // end portal frames: raking struts at the abutments
  for (const s of [sa, sb]) for (const sg of [-1, 1]) beamBox(steel, P(s, sg * TL, yt), P(s, sg * (TL - 2.4), yt - 1.3), 0.22, 0.22, redD, [0, 1, 0]);

  // ------------------------------------------------------ abutments (stone faced)
  const stn = lin('#8b857b'), stnD = lin('#6d675e');
  const grids = [];
  for (const [s0, dir] of [[sa, 1], [sb, -1]]) {
    // bearing seat block under the deck end, reaching back into solid ground
    const sBack = s0 - dir * 4.5, sFront = s0 + dir * 1.2;
    const seatBot = ST - TH - 0.9;
    const hr = (s) => { const f = frameAtIndex(F, s); return [f.rx, 0, f.rz]; };
    const tv = (s) => { const f = frameAtIndex(F, s); return [f.tx * dir, 0, f.tz * dir]; };
    // front face (toward the void)
    const lo = (s, l) => Math.min(seatBot - 0.6, terr(world, F, s, l) - 0.6);
    const fr = frameAtIndex(F, sFront);
    stone.quadU(P(sFront, -6.2, lo(sFront, -6.2) - 0.5), P(sFront, 6.2, lo(sFront, 6.2) - 0.5), P(sFront, 6.2, ST - TH + 0.55), P(sFront, -6.2, ST - TH + 0.55), tv(sFront), { color: stn, su: 1 / 2.2, sv: 1 / 1.3 });
    // side faces
    for (const sg of [-1, 1]) {
      const hint = [sg * hr(s0)[0], 0, sg * hr(s0)[2]];
      const a = sBack, b = sFront;
      stone.quadU(P(a, sg * 6.2, seatBot - 4), P(b, sg * 6.2, lo(b, sg * 6.2) - 0.5), P(b, sg * 6.2, ST - TH + 0.55), P(a, sg * 6.2, ST - TH + 0.55), hint, { color: stnD, su: 1 / 2.2, sv: 1 / 1.3 });
    }
    // top of the seat (under deck) is hidden. Masonry revetment following the canyon wall:
    const rowsS = [], span2 = 14;
    for (let k = 0; k <= 14; k++) {
      const s = s0 + dir * (1.2 + (k / 14) * span2);
      const row = [];
      for (let m = -8; m <= 8; m++) { const l = m * 0.8 + 0; const f = frameAtIndex(F, s); const x = f.x + f.rx * l, z = f.z + f.rz * l; row.push([x, world.heightAt(x, z) + 0.28, z]); }
      rowsS.push(row);
    }
    grids.push(rowsS);
    void fr; void sBack;
  }
  for (const rowsS of grids) for (let k = 0; k < rowsS.length - 1; k++) for (let j = 0; j < rowsS[k].length - 1; j++) {
    const a = rowsS[k][j], b = rowsS[k][j + 1], c = rowsS[k + 1][j + 1], d = rowsS[k + 1][j];
    stone.quadU(a, b, c, d, [0, 1, 0.0001], { color: (j + k) % 3 ? stn : stnD, su: 1 / 2.2, sv: 1 / 2.2, u0: j * 0.36, v0: k * 0.3 });
  }
  return { F, sa, sb, conc: conc.toGeometry(), steel: steel.toGeometry(), stone: stone.toGeometry() };
}
