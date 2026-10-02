// Composable onBeforeCompile. Several systems (height fog, wind sway, wetness…)
// need to patch the same built-in material, so never assign
// material.onBeforeCompile directly — call addShaderPatch instead.
//
//   addShaderPatch(mat, 'wind', (shader) => {
//     shader.uniforms.uTime = globalUniforms.uTime;
//     shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `...`);
//   });
//
// Patches run in insertion order. The key must be stable per behaviour so
// three.js can share compiled programs between materials with the same patches.

export function addShaderPatch(material, key, fn) {
  const patches = material.userData.__patches || (material.userData.__patches = []);
  if (patches.some((p) => p.key === key)) return material;
  patches.push({ key, fn });
  material.onBeforeCompile = (shader, renderer) => {
    for (const p of patches) p.fn(shader, renderer);
  };
  material.customProgramCacheKey = () => patches.map((p) => p.key).join('|');
  material.needsUpdate = true;
  return material;
}

export function hasShaderPatch(material, key) {
  return !!material.userData.__patches?.some((p) => p.key === key);
}
