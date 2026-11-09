import * as THREE from 'three';

// Two-band cel shading: hard color step + rim light on the lit side. GLSL3 is a
// hard requirement — MRT needs the second output at layout(location = 1), and
// three.js only refrains from claiming location 0 when glslVersion is GLSL3
// (in WebGLProgram.js the pc_fragColor declaration evaluates to an empty string
// for GLSL3). Mixing a GLSL1 material into this render leaves the second RT
// undefined for those pixels.

/**
 * G-buffer packing contract. RT1 = rgb view-space normal + a packed(view depth, material ID).
 * Depth is stored as raw view depth quantized at 1/64 world units (0-1024 units),
 * not normalized: normalizing either couples the far plane into the material or
 * squeezes all precision into the far range, and both grow phantom edges on ink
 * lines far away. 1/64 is about 1.5cm, which combined with the mpp fade in post
 * is clean enough. Post-processing must unpack through here, never a second copy.
 */
export const GBUFFER_GLSL = /* glsl */ `
const float GBUF_DEPTH_QUANTUM = 64.0;
const float GBUF_ID_SCALE = 256.0;
const float GBUF_DEPTH_MAX = 1024.0;

float packGbuffer(float viewDepth, float materialId) {
  float q = floor(clamp(viewDepth, 0.0, GBUF_DEPTH_MAX) * GBUF_DEPTH_QUANTUM);
  return q * GBUF_ID_SCALE + clamp(materialId, 0.0, GBUF_ID_SCALE - 1.0);
}

void unpackGbuffer(float packed, out float viewDepth, out float materialId) {
  materialId = mod(packed, GBUF_ID_SCALE);
  viewDepth = floor(packed / GBUF_ID_SCALE) / GBUF_DEPTH_QUANTUM;
}
`;

const VERT = /* glsl */ `
out vec3 vViewNormal;
out vec3 vViewPos;

void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vViewPos = view.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * view;
}
`;

const FRAG = /* glsl */ `
precision highp float;

${GBUFFER_GLSL}

in vec3 vViewNormal;
in vec3 vViewPos;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gGbuffer;

uniform vec3 uBase;
uniform vec3 uShadow;
uniform vec3 uRim;
uniform vec3 uLightDir;
uniform float uBandSoftness;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uMaterialId;

void main() {
  vec3 N = normalize(vViewNormal);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);

  float lambert = dot(N, L);
  // smoothstep only exists to antialias; its width is a hard step, not a midtone
  float band = smoothstep(-uBandSoftness, uBandSoftness, lambert);
  vec3 color = mix(uShadow, uBase, band);

  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower) * uRimStrength;
  // Rim stays on the lit side: a ring of light on the back side reads as a
  // sticker, not as cel shading
  rim *= smoothstep(-0.25, 0.35, lambert);
  color += uRim * rim;

  gColor = vec4(color, 1.0);
  gGbuffer = vec4(N, packGbuffer(-vViewPos.z, uMaterialId));
}
`;

/**
 * Build one two-band cel material. Colors go into the renderer's working
 * (linear) space; hex strings are interpreted as sRGB (THREE.ColorManagement is
 * on by default).
 *
 * materialId lands in the G-buffer and drives watercolor stroke direction and
 * density; 0 is reserved for background, matching the pipeline default.
 */
export function createCelMaterial({ base, shadow, rim, materialId = 0, lightDir }) {
  const toColor = (c) => (c instanceof THREE.Color ? c.clone() : new THREE.Color().setStyle(c));
  const dir = lightDir ? new THREE.Vector3().fromArray(lightDir).normalize()
    : new THREE.Vector3(-0.35, 0.75, 0.55).normalize();

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uBase: { value: toColor(base) },
      uShadow: { value: toColor(shadow) },
      uRim: { value: toColor(rim) },
      uLightDir: { value: dir },
      uBandSoftness: { value: 0.04 },
      uRimPower: { value: 2.5 },
      uRimStrength: { value: 0.55 },
      uMaterialId: { value: materialId },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}
