// Sign atlas layout shared by the texture painter (canvas) and the geometry builder.
// Rects are in canvas pixels: [x, y, w, h] on a 1024 x 512 atlas. Real-world size in metres.
export const SIGN_ATLAS = { w: 1024, h: 768 };

export const SIGN_DEFS = {
  // Icelandic blue place-name sign (distance filled at runtime)
  place: { rect: [0, 0, 512, 192], size: [2.6, 0.975], kind: 'place' },
  placeEnd: { rect: [512, 0, 512, 192], size: [2.6, 0.975], kind: 'placeEnd' },
  // Warning triangle: steep descent
  hill: { rect: [0, 200, 300, 260], size: [1.15, 1.0], kind: 'hill' },
  // Blue parking / viewpoint sign
  view: { rect: [320, 200, 380, 300], size: [1.5, 1.18], kind: 'view' },
  // Warning triangle: sharp bend
  bend: { rect: [720, 200, 300, 260], size: [1.15, 1.0], kind: 'bend' },
  // yellow sharp-bend advisory boards (arrow shows the turn direction) and the tunnel sign
  warnL: { rect: [0, 520, 256, 256], size: [1.05, 1.05], kind: 'warn' },
  warnR: { rect: [270, 520, 256, 256], size: [1.05, 1.05], kind: 'warn' },
  tunnel: { rect: [540, 520, 380, 250], size: [1.5, 0.99], kind: 'tunnel' },
};
