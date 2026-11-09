import * as THREE from 'three';
import { GLSL_RAND } from '../util/rand.js';
import { GBUFFER_GLSL } from './cel.js';
// The JSON is inlined by the bundler. The attribute is required by Node ESM and
// understood by esbuild 0.25 (the bundler this project builds with). The single
// source of the palette is delivery/brand/khy-brand-tokens.json; this is only the
// default, overridable through options.palette.
import brandTokens from '../../../khy-brand-tokens.json' with { type: 'json' };

// Palette: warm amber pair on a paper-and-ink base — ink carries shadows and ink
// lines, paper is the paper white, accent/brandGraphic warm the wash and the
// bloom. The light-side values are used; the dark-side values (valueDark) stay
// available for a dark theme through options.palette.
function paletteFromTokens(tokens) {
  const c = tokens.color;
  return {
    ink: c.ink.value,
    paper: c.paper.value,
    accent: c.accent.value,
    accentDark: c.accent.valueDark,
    brandGraphic: c.brandGraphic.value,
    gradient: tokens.graphic.gradient.slice(),
  };
}

const DEFAULT_PALETTE = paletteFromTokens(brandTokens);

// Defaults
const DEFAULT_LOOK = {
  exposure: 1.05,
  contrast: 0.32,
  saturation: 1.06,
  toneStrength: 0.6,
  midStrength: 0.035,
  bloomStrength: 0.4,
  bloomThreshold: 0.72,
  bloomKnee: 0.6,
  bloomWeight: [1.0, 0.7, 0.45],
  lineStrength: 0.9,
  lineDepthWeight: 6.0,
  lineNormalWeight: 1.4,
  lineThreshold: 0.35,
  lineSoftness: 0.15,
  grainAmount: 0.045,
  strokeScale: 0.05,
};

const DEFAULTS = {
  fps: 24,
  focal: 1,
  // mpp fade band (world units per pixel): full detail below 0.004, none above
  // 0.05. Both numbers are "how many metres fit in one pixel" heuristics; retune
  // when the scene scale changes.
  detailNearMpp: 0.004,
  detailFarMpp: 0.05,
  backgroundMaterialId: 0,
  foregroundWash: 0.25,
};

const BLOOM_SCALES = [0.5, 0.25, 0.125];

// Fullscreen triangle
const QUAD_VERT = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 1) Watercolor background strokes
const WATERCOLOR_FRAG = /* glsl */ `
precision highp float;

${GBUFFER_GLSL}
${GLSL_RAND}

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tGbuffer;
uniform vec2 uResolution;
uniform float uPixelWorldSize;
uniform float uFocal;
uniform float uDetailNearMpp;
uniform float uDetailFarMpp;
uniform float uBackgroundMaterialId;
uniform float uForegroundWash;
uniform float uStrokeScale;
uniform vec3 uWashPaper;
uniform vec3 uWashWarm;

void main() {
  vec4 src = texture(tColor, vUv);
  vec4 gb = texture(tGbuffer, vUv);
  vec3 N = gb.xyz;

  float viewDepth, materialId;
  unpackGbuffer(gb.a, viewDepth, materialId);

  // mpp = how many metres this pixel covers. Screen-space noise gets sampled per
  // pixel as mpp grows, which reads as shimmer on a locked-off shot — so strokes
  // both fade and widen with mpp (they keep their world size and smear into a
  // wash in the distance instead of turning into sand).
  float mpp = viewDepth * uPixelWorldSize / uFocal;
  float fade = smoothstep(uDetailNearMpp, uDetailFarMpp, mpp);
  float detail = 1.0 - fade;

  float isBackground = abs(materialId - uBackgroundMaterialId) < 0.5 ? 1.0 : 0.0;
  float wash = mix(uForegroundWash, 1.0, isBackground);

  // Stroke direction: the material id sets a base angle, the screen-space
  // orientation of the normal sets the flow. A surface facing the camera has no
  // flow to read, so fall back to that material's fixed angle (atan(0,0) is
  // undefined in GLSL).
  vec2 nxy = N.xy;
  float flowAngle = length(nxy) > 0.05 ? atan(nxy.y, nxy.x) : hash11(materialId + 3.0) * 6.2831853;
  float angle = hash11(materialId) * 6.2831853 + flowAngle;
  vec2 flow = vec2(cos(angle), sin(angle));

  vec2 px = vUv * uResolution;
  vec2 sp = vec2(dot(px, flow), dot(px, vec2(-flow.y, flow.x)));
  sp.y /= 6.0;
  sp *= uStrokeScale * (1.0 + mpp * 120.0);
  sp += hash11(materialId + 7.0) * 31.0;

  float stroke = fbm21(sp);
  float mask = smoothstep(0.35, 0.85, stroke) * detail * wash;

  vec3 washColor = mix(uWashPaper, uWashWarm, hash21(vec2(materialId, 3.0)));
  // Multiplicative tint plus a lift: the paper base shows through the gaps
  // between strokes
  vec3 color = mix(src.rgb, src.rgb * washColor * 1.25 + washColor * 0.04, mask * 0.55);
  fragColor = vec4(color, src.a);
}
`;

// 2) Depth + normal ink lines
const LINE_FRAG = /* glsl */ `
precision highp float;

${GBUFFER_GLSL}
${GLSL_RAND}

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tGbuffer;
uniform vec2 uTexel;
uniform float uPixelWorldSize;
uniform float uFocal;
uniform float uDetailNearMpp;
uniform float uDetailFarMpp;
uniform float uDepthWeight;
uniform float uNormalWeight;
uniform float uThreshold;
uniform float uSoftness;
uniform float uStrength;
uniform vec3 uInk;

float depthAt(vec2 uv) {
  float d, id;
  unpackGbuffer(texture(tGbuffer, uv).a, d, id);
  return d;
}

void main() {
  vec2 t = uTexel;
  // Depth 3x3 Sobel: silhouettes and folded surfaces. The 0.25 folds the Sobel
  // magnitude back into "average depth difference between neighbours", so the
  // threshold can talk to scene scale directly.
  float dNW = depthAt(vUv + vec2(-t.x,  t.y));
  float dN  = depthAt(vUv + vec2( 0.0,  t.y));
  float dNE = depthAt(vUv + vec2( t.x,  t.y));
  float dW  = depthAt(vUv + vec2(-t.x,  0.0));
  float dE  = depthAt(vUv + vec2( t.x,  0.0));
  float dSW = depthAt(vUv + vec2(-t.x, -t.y));
  float dS  = depthAt(vUv + vec2( 0.0, -t.y));
  float dSE = depthAt(vUv + vec2( t.x, -t.y));
  float gx = (dNE + 2.0 * dE + dSE) - (dNW + 2.0 * dW + dSW);
  float gy = (dSW + 2.0 * dS + dSE) - (dNW + 2.0 * dN + dNE);
  float depthEdge = length(vec2(gx, gy)) * 0.25;

  // Normals: average difference against the four neighbours, for interior folds.
  // Take the larger of the two so a depth discontinuity never leaves a hole.
  vec3 nC = texture(tGbuffer, vUv).xyz;
  float normalEdge = (length(nC - texture(tGbuffer, vUv + vec2(t.x, 0.0)).xyz)
                    + length(nC - texture(tGbuffer, vUv - vec2(t.x, 0.0)).xyz)
                    + length(nC - texture(tGbuffer, vUv + vec2(0.0, t.y)).xyz)
                    + length(nC - texture(tGbuffer, vUv - vec2(0.0, t.y)).xyz)) * 0.25;

  float edge = max(depthEdge * uDepthWeight, normalEdge * uNormalWeight);

  float viewDepth, materialId;
  unpackGbuffer(texture(tGbuffer, vUv).a, viewDepth, materialId);
  float mpp = viewDepth * uPixelWorldSize / uFocal;
  float fade = smoothstep(uDetailNearMpp, uDetailFarMpp, mpp);

  // The far field gets two treatments at once: a raised threshold plus a faded
  // strength. Fading alone leaves the 16-bit depth quantisation steps strung
  // into a dashed line; raising the threshold alone smears the silhouette.
  float threshold = mix(uThreshold, uThreshold * 6.0, fade);
  float line = smoothstep(threshold, threshold + uSoftness, edge);
  // Silhouettes have to survive into the distance; only interior folds die
  line *= uStrength * mix(1.0, 0.35, fade);

  vec3 color = mix(texture(tColor, vUv).rgb, uInk, clamp(line, 0.0, 1.0));
  fragColor = vec4(color, 1.0);
}
`;

// 3) Atmospheric bloom
const BLOOM_BRIGHT_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform float uThreshold;
uniform float uKnee;
uniform vec3 uTint;

void main() {
  vec3 c = texture(tColor, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft-knee highlight selection: continuous across the threshold, so no hard
  // cut shows up as a ring around the bloom
  float knee = uThreshold * uKnee + 1e-5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  fragColor = vec4(c * w * uTint, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform vec2 uTexel;

void main() {
  // 5 linear taps standing in for a 9-weight Gaussian. Wide and soft: atmosphere,
  // not a lamp halo
  vec3 sum = texture(tColor, vUv).rgb * 0.2270270270;
  sum += (texture(tColor, vUv + uTexel * 1.3846153846).rgb
        + texture(tColor, vUv - uTexel * 1.3846153846).rgb) * 0.3162162162;
  sum += (texture(tColor, vUv + uTexel * 3.2307692308).rgb
        + texture(tColor, vUv - uTexel * 3.2307692308).rgb) * 0.0702702703;
  fragColor = vec4(sum, 1.0);
}
`;

// 4) Color grade (bloom composited here)
const GRADE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec3 uAccent;
uniform float uExposure;
uniform float uContrast;
uniform float uToneStrength;
uniform float uMidStrength;
uniform float uSaturation;
uniform float uBloomStrength;
uniform vec3 uBloomWeight;

void main() {
  vec3 c = texture(tColor, vUv).rgb;
  vec3 bloom = texture(tBloom0, vUv).rgb * uBloomWeight.x
             + texture(tBloom1, vUv).rgb * uBloomWeight.y
             + texture(tBloom2, vUv).rgb * uBloomWeight.z;
  c += bloom * uBloomStrength;

  c *= uExposure;
  // Soft-knee contrast: sits on the film shoulder better than linear contrast.
  // The curve is only defined on 0..1 — c*c*(3-2c) peaks at c=1 and goes
  // strongly negative past it, and this film runs its light sources well past
  // 1.0 on purpose (the flame sits at 2.6, the ring at 2.4). Letting the curve
  // run off its domain deletes whichever channel is brightest, which in an
  // amber palette is always red: the pixel comes out of the grain pass's
  // max(c,0) as a green or cyan residue. Clamping the curve's input keeps
  // over-range values on their own hue and only rolls them toward white, the
  // way a highlight is supposed to behave. In-gamut pixels are untouched —
  // clamp is the identity there, so the grade below 1.0 is bit-for-bit what
  // it was.
  vec3 knee = clamp(c, 0.0, 1.0);
  c = mix(c, knee * knee * (3.0 - 2.0 * knee), uContrast);

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Split tone: shadows lean toward ink (warm black), highlights toward paper.
  // The tints are normalised into "unit-luminance hue directions" first so only
  // hue moves — multiplying by ink's absolute value crushes the shadows to death.
  vec3 shadowTone = uInk / max(dot(uInk, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  vec3 highTone = uPaper / max(dot(uPaper, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  vec3 tone = mix(shadowTone, highTone, smoothstep(0.0, 1.0, l));
  c *= mix(vec3(1.0), tone, uToneStrength);

  // Amber in the midtones only; the two ends are left alone
  float mid = 1.0 - abs(l * 2.0 - 1.0);
  c += uAccent * mid * uMidStrength;

  c = mix(vec3(l), c, uSaturation);
  fragColor = vec4(max(c, vec3(0.0)), 1.0);
}
`;

// 5) Paper wipe. The only scene transition this pipeline owns: the director fades
// one scene out to paper and the next in from paper, so no scene boundary ever
// hard-cuts. It sits after the grade and before the grain because the chain is
// linear up to the grain pass — fading in sRGB here would double-encode the paper.
const FADE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform vec3 uPaper;
uniform float uFade;

void main() {
  vec3 c = texture(tColor, vUv).rgb;
  fragColor = vec4(mix(c, uPaper, clamp(uFade, 0.0, 1.0)), 1.0);
}
`;

// 6) Film grain (and the only place that leaves linear space)
const GRAIN_FRAG = /* glsl */ `
precision highp float;

${GBUFFER_GLSL}
${GLSL_RAND}

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tGbuffer;
uniform float uPixelWorldSize;
uniform float uFocal;
uniform float uDetailNearMpp;
uniform float uDetailFarMpp;
uniform float uFrame;
uniform float uGrainAmount;

void main() {
  vec3 c = texture(tColor, vUv).rgb;

  float viewDepth, materialId;
  unpackGbuffer(texture(tGbuffer, vUv).a, viewDepth, materialId);
  float mpp = viewDepth * uPixelWorldSize / uFocal;
  float fade = smoothstep(uDetailNearMpp, uDetailFarMpp, mpp);

  // Grain re-rolls every frame (same clock as the 24fps beat) and fades with mpp:
  // a locked-off shot where every far pixel swaps noise each frame is pure
  // shimmer — this is the most direct cut against far-field noise.
  float g = hash21(gl_FragCoord.xy + vec2(uFrame * 7.13, uFrame * 3.71)) - 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Mids read strongest; grain in the shadows is eaten by the OETF below, and
  // the paper stock is mid/high-key anyway
  c += g * uGrainAmount * (1.0 - fade) * (0.25 + 0.75 * smoothstep(0.0, 0.6, l));

  // The whole post chain is linear; only this step leaves it: linear -> sRGB
  c = max(c, vec3(0.0));
  vec3 srgb = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  fragColor = vec4(srgb, 1.0);
}
`;

/**
 * Build one non-photorealistic render pipeline.
 *
 * MRT: RT0 color, RT1 normal xyz + packed(view depth, material ID). The post
 * order is fixed: watercolor background strokes -> depth+normal ink lines ->
 * atmospheric bloom -> color grade -> paper wipe -> film grain.
 *
 * render(t) holds no cross-frame accumulated state: every frame is a pure
 * function of (t, inputs). Grain comes from hash(pixel, frame) rather than a
 * history buffer, so pausing, scrubbing backwards and skipping frames are safe.
 *
 * Opaque objects in the scene must use createCelMaterial (or another GLSL3
 * material that writes location = 1); otherwise the second RT is undefined at
 * those pixels and lines and strokes go to noise. The pipeline warns about
 * non-compliant materials on the first render — objects attached after that
 * frame are outside the check.
 */
export function createPipeline(renderer, scene, camera, options = {}) {
  const {
    width: initialWidth = 1,
    height: initialHeight = 1,
    palette,
    look,
    fps = DEFAULTS.fps,
    focal = DEFAULTS.focal,
    detailNearMpp = DEFAULTS.detailNearMpp,
    detailFarMpp = DEFAULTS.detailFarMpp,
    backgroundMaterialId = DEFAULTS.backgroundMaterialId,
    foregroundWash = DEFAULTS.foregroundWash,
  } = options;

  if (!renderer.capabilities.isWebGL2) {
    throw new Error('khyos-desktop 管线需要 WebGL2（MRT 与 GLSL3 在 WebGL1 上没有对应物）：请换 WebGL2 上下文或更新浏览器/驱动');
  }
  if (!renderer.extensions.has('EXT_color_buffer_float')) {
    throw new Error('khyos-desktop 管线需要 EXT_color_buffer_float（G-buffer 用浮点 RT 存法线与打包深度）：请更新 GPU 驱动或换设备');
  }
  if (!camera.isPerspectiveCamera) {
    throw new Error('khyos-desktop 管线需要透视相机（mpp「每像素多少米」按透视投影推导，正交相机没有这条公式）：请传 PerspectiveCamera');
  }

  const pal = Object.assign({}, DEFAULT_PALETTE, palette || {});
  const cfg = Object.assign({}, DEFAULT_LOOK, look || {});
  const colorOf = (hex) => new THREE.Color().setStyle(hex);
  const cInk = colorOf(pal.ink);
  const cPaper = colorOf(pal.paper);
  const cAccent = colorOf(pal.accent);
  const cBrandGraphic = colorOf(pal.brandGraphic);
  const cBloomTint = colorOf(pal.gradient[0] || pal.accentDark);

  let width = Math.max(1, Math.floor(initialWidth));
  let height = Math.max(1, Math.floor(initialHeight));

  function makeColorTarget(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
  }

  // The G-buffer is float: normals have to stay exact and the depth+id packing
  // has to unpack to whole values. An 8-bit RT turns ink lines into dashes.
  const gbuffer = new THREE.WebGLRenderTarget(width, height, {
    count: 2,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    generateMipmaps: false,
  });
  const sceneA = makeColorTarget(width, height);
  const sceneB = makeColorTarget(width, height);
  const bloomLevels = BLOOM_SCALES.map((s) =>
    makeColorTarget(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s))));
  const bloomTmp = bloomLevels.map((rt) => makeColorTarget(rt.width, rt.height));

  function makePass(fragmentShader, uniforms) {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
  }

  const wcU = {
    tColor: { value: null },
    tGbuffer: { value: null },
    uResolution: { value: new THREE.Vector2(width, height) },
    uPixelWorldSize: { value: 0 },
    uFocal: { value: focal },
    uDetailNearMpp: { value: detailNearMpp },
    uDetailFarMpp: { value: detailFarMpp },
    uBackgroundMaterialId: { value: backgroundMaterialId },
    uForegroundWash: { value: foregroundWash },
    uStrokeScale: { value: cfg.strokeScale },
    uWashPaper: { value: cPaper },
    uWashWarm: { value: cBrandGraphic },
  };
  const lineU = {
    tColor: { value: null },
    tGbuffer: { value: null },
    uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
    uPixelWorldSize: { value: 0 },
    uFocal: { value: focal },
    uDetailNearMpp: { value: detailNearMpp },
    uDetailFarMpp: { value: detailFarMpp },
    uDepthWeight: { value: cfg.lineDepthWeight },
    uNormalWeight: { value: cfg.lineNormalWeight },
    uThreshold: { value: cfg.lineThreshold },
    uSoftness: { value: cfg.lineSoftness },
    uStrength: { value: cfg.lineStrength },
    uInk: { value: cInk },
  };
  const bloomU = {
    tColor: { value: null },
    uThreshold: { value: cfg.bloomThreshold },
    uKnee: { value: cfg.bloomKnee },
    uTint: { value: cBloomTint },
  };
  const blurU = {
    tColor: { value: null },
    uTexel: { value: new THREE.Vector2() },
  };
  const gradeU = {
    tColor: { value: null },
    tBloom0: { value: null },
    tBloom1: { value: null },
    tBloom2: { value: null },
    uInk: { value: cInk },
    uPaper: { value: cPaper },
    uAccent: { value: cAccent },
    uExposure: { value: cfg.exposure },
    uContrast: { value: cfg.contrast },
    uToneStrength: { value: cfg.toneStrength },
    uMidStrength: { value: cfg.midStrength },
    uSaturation: { value: cfg.saturation },
    uBloomStrength: { value: cfg.bloomStrength },
    uBloomWeight: { value: new THREE.Vector3().fromArray(cfg.bloomWeight) },
  };
  const fadeU = {
    tColor: { value: null },
    uPaper: { value: cPaper },
    uFade: { value: 0 },
  };
  const grainU = {
    tColor: { value: null },
    tGbuffer: { value: null },
    uPixelWorldSize: { value: 0 },
    uFocal: { value: focal },
    uDetailNearMpp: { value: detailNearMpp },
    uDetailFarMpp: { value: detailFarMpp },
    uFrame: { value: 0 },
    uGrainAmount: { value: cfg.grainAmount },
  };

  const watercolor = makePass(WATERCOLOR_FRAG, wcU);
  const linePass = makePass(LINE_FRAG, lineU);
  const bloomBright = makePass(BLOOM_BRIGHT_FRAG, bloomU);
  const blurPass = makePass(BLUR_FRAG, blurU);
  const grade = makePass(GRADE_FRAG, gradeU);
  const fadePass = makePass(FADE_FRAG, fadeU);
  const grain = makePass(GRAIN_FRAG, grainU);

  // Fullscreen triangle: one fewer interpolation corner than a quad, and immune
  // to camera transforms
  const quadGeometry = new THREE.BufferGeometry();
  quadGeometry.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(quadGeometry, null);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  function blit(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
  }

  function applySize(w, h) {
    width = Math.max(1, Math.floor(w));
    height = Math.max(1, Math.floor(h));
    gbuffer.setSize(width, height);
    sceneA.setSize(width, height);
    sceneB.setSize(width, height);
    for (let i = 0; i < bloomLevels.length; i++) {
      const lw = Math.max(1, Math.round(width * BLOOM_SCALES[i]));
      const lh = Math.max(1, Math.round(height * BLOOM_SCALES[i]));
      bloomLevels[i].setSize(lw, lh);
      bloomTmp[i].setSize(lw, lh);
    }
    wcU.uResolution.value.set(width, height);
    lineU.uTexel.value.set(1 / width, 1 / height);
  }
  applySize(width, height);

  let mrtChecked = false;
  function warnIfNotMrtCapable() {
    if (mrtChecked) return;
    mrtChecked = true;
    const offenders = [];
    scene.traverse((obj) => {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        // Only GLSL3 materials write layout(location = 1); a GLSL1 material is
        // transpiled by three into writing location 0 alone, leaving the second
        // RT undefined
        if (m && m.glslVersion !== THREE.GLSL3) {
          offenders.push(`${obj.name || obj.type}/${m.name || m.type}`);
        }
      }
    });
    if (offenders.length > 0) {
      console.warn(`khyos-desktop 管线：${offenders.length} 个材质不写 MRT 第二张 RT，描线与笔触会花 —— ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ' 等' : ''}。改用 createCelMaterial 或 GLSL3 MRT 材质。`);
    }
  }

  function render(t) {
    const time = Number.isFinite(t) ? t : 0;
    warnIfNotMrtCapable();

    // The three parts of mpp meet here: linear depth (from the G-buffer) x world
    // size per pixel / focal length
    const fovRad = (camera.fov * Math.PI) / 180;
    const pixelWorldSize = (2 * Math.tan(fovRad / 2)) / height;

    wcU.uPixelWorldSize.value = pixelWorldSize;
    lineU.uPixelWorldSize.value = pixelWorldSize;
    grainU.uPixelWorldSize.value = pixelWorldSize;
    grainU.uFrame.value = Math.floor(time * fps);

    renderer.setRenderTarget(gbuffer);
    renderer.clear();
    renderer.render(scene, camera);

    wcU.tColor.value = gbuffer.textures[0];
    wcU.tGbuffer.value = gbuffer.textures[1];
    blit(watercolor, sceneA);

    lineU.tColor.value = sceneA.texture;
    lineU.tGbuffer.value = gbuffer.textures[1];
    blit(linePass, sceneB);

    bloomU.tColor.value = sceneB.texture;
    blit(bloomBright, bloomLevels[0]);
    for (let i = 0; i < bloomLevels.length; i++) {
      blurU.tColor.value = i === 0 ? bloomLevels[0].texture : bloomLevels[i - 1].texture;
      blurU.uTexel.value.set(1 / bloomTmp[i].width, 0);
      blit(blurPass, bloomTmp[i]);
      blurU.tColor.value = bloomTmp[i].texture;
      blurU.uTexel.value.set(0, 1 / bloomLevels[i].height);
      blit(blurPass, bloomLevels[i]);
    }

    gradeU.tColor.value = sceneB.texture;
    gradeU.tBloom0.value = bloomLevels[0].texture;
    gradeU.tBloom1.value = bloomLevels[1].texture;
    gradeU.tBloom2.value = bloomLevels[2].texture;
    blit(grade, sceneA);

    // sceneB is free again once the grade has read it, so the wipe and the grain
    // keep the same two-target ping-pong instead of allocating a third RT
    fadeU.tColor.value = sceneA.texture;
    blit(fadePass, sceneB);

    grainU.tColor.value = sceneB.texture;
    grainU.tGbuffer.value = gbuffer.textures[1];
    blit(grain, null);
  }

  /**
   * Paper wipe amount, 0..1. The director owns the transition curve; this only
   * stores it. A NaN (a transition k that never got a value) is clamped to 0
   * rather than reaching the uniform, where it would blank the whole frame.
   */
  function setFade(a) {
    fadeU.uFade.value = Math.min(1, Math.max(0, Number.isFinite(a) ? a : 0));
  }

  function dispose() {
    gbuffer.dispose();
    sceneA.dispose();
    sceneB.dispose();
    bloomLevels.forEach((rt) => rt.dispose());
    bloomTmp.forEach((rt) => rt.dispose());
    watercolor.dispose();
    linePass.dispose();
    bloomBright.dispose();
    blurPass.dispose();
    grade.dispose();
    fadePass.dispose();
    grain.dispose();
    quadGeometry.dispose();
    renderer.autoClear = prevAutoClear;
  }

  const targets = {
    gbuffer,
    scene: sceneA,
    post: sceneB,
    bloom: bloomLevels,
  };

  return { setSize: applySize, render, setFade, targets, dispose };
}
