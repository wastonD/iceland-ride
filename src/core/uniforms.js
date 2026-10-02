import * as THREE from 'three';

// Uniform objects shared (by reference) across every patched material and pass.
// Updated once per frame by main.js / atmosphere.js — never replace the objects.
export const globalUniforms = {
  uTime: { value: 0 },                           // seconds since start
  uWind: { value: new THREE.Vector3(1, 0, 0.3) },// xz = direction, y unused
  uWindStrength: { value: 0.4 },                 // 0..1
  uRain: { value: 0.55 },                        // 0..1 rain intensity
  uWetness: { value: 0.8 },                      // 0..1 how soaked surfaces look

  // Atmosphere (set by render/atmosphere.js from the time-of-day preset)
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() }, // towards the light
  uSunCol: { value: new THREE.Color(1, 1, 1) },
  uFogAmb: { value: new THREE.Color(0.4, 0.5, 0.5) },   // ambient fog colour
  uFogHigh: { value: new THREE.Color(0.6, 0.7, 0.7) },  // fog colour looking up
  uFogSunC: { value: new THREE.Color(1, 0.9, 0.7) },    // in-scatter tint toward light
  uFogDensity: { value: 0.02 },                  // height-fog density at y = 0
  uFogFalloff: { value: 0.06 },                  // exp falloff with height
  uCamPos: { value: new THREE.Vector3() },
};
