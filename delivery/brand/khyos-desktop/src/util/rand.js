// The project's only source of randomness: Math.random is banned — the desktop
// must render the same frame for the same (scene, t), and capture.mjs compares
// bytes between two renders of the same instant. Shader-side randomness comes
// from here too (GLSL_RAND uses the same mixing constants as fmix32 below),
// otherwise CPU-side stroke layout and GPU-side stroke sampling drift apart.

const TWO32 = 4294967296;

/** murmur3 fmix32: avalanche any 32-bit integer into a uniform distribution. */
function fmix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32: small, fast, deterministic. Same seed, same sequence.
 * Returns [0,1) floats. Not for cryptographic use.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / TWO32;
  };
}

/** String -> 32-bit seed (FNV-1a). Feeds mulberry32. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 1D integer lattice -> [0,1). */
export function hash1(i) {
  return fmix32(i | 0) / TWO32;
}

/** 2D integer lattice -> [0,1). Stroke fields and dither sample per cell. */
export function hash2(x, y) {
  return fmix32(Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) / TWO32;
}

/** 3D integer lattice -> [0,1). Volumetric fog and per-frame grain. */
export function hash3(x, y, z) {
  const h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  return fmix32(h) / TWO32;
}

/**
 * Shader-side randomness and value noise, GLSL3. The mixing constants match
 * fmix32 / hash2 above so "the same random" does not drift between CPU and GPU.
 * Usage: interpolate into fragment shader source; never write a second hash
 * inside a shader.
 */
export const GLSL_RAND = /* glsl */ `
float hash11(float p) {
  uint h = uint(int(p)) * 0x27d4eb2du;
  h ^= h >> 16; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16;
  return float(h) * (1.0 / 4294967296.0);
}

float hash21(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p))) * uvec2(0x27d4eb2du, 0x165667b1u);
  uint h = q.x ^ q.y;
  h ^= h >> 16; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16;
  return float(h) * (1.0 / 4294967296.0);
}

float hash31(vec3 p) {
  uvec3 q = uvec3(ivec3(floor(p))) * uvec3(0x27d4eb2du, 0x165667b1u, 0x9e3779b1u);
  uint h = q.x ^ q.y ^ q.z;
  h ^= h >> 16; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16;
  return float(h) * (1.0 / 4294967296.0);
}

// Value noise + 4-octave fbm. Watercolor strokes, paper tooth and grain all
// sample from here.
float vnoise21(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm21(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise21(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}
`;
