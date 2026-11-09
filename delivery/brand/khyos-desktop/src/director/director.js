// director.js — the director: scene scheduling, camera, blocking, expression and
// effects for the four scenes in src/story/scenes.json.
//
// Two contracts shape this file; read them before changing anything:
//
//   1) renderSceneAt(sceneId, t) is a pure function of (sceneId, t). The capture
//      chain renders each scene at t = i/24 and compares frame bytes between two
//      renders of the same instant (scripts/capture.mjs --selftest), so nothing
//      in a frame may read a wall clock, accumulate state across calls, or call
//      Math.random. Seeded noise comes from src/util/rand.js; every scripted
//      motion below is written as a function of t.
//   2) Poses are sampled on twos, effects on threes (src/render/quantize.js).
//      Hand-drawn animation holds one drawing for two frames — re-deriving a
//      pose every frame at 24fps reads as sub-frame crawl. Spacing (flight
//      paths, camera moves, blocking) stays on ones, which is what spacing
//      means in hand-drawn work; the models' own rhythms (breath, blink,
//      wingbeat) ride the quantized clock with it.
//
// What the director owns that the models do not: the environment (sea, sky,
// shore, dock, lamp pole, ring light), the effect fields (rain, splashes, dust,
// the letter), the camera, and the liveness overlays — anticipation, head lag,
// body twist, follow-through, landing squash. The overlays are additive
// rotations applied *after* each model's update(), because every model resets
// its own driven bones at the top of update() and none of them may be edited
// to make room for a director.
//
// The three MeshBasicMaterial models (and the ink eel's MeshStandardMaterial)
// are re-skinned onto a cel material here: render/pipeline.js only writes its
// second render target for GLSL3 materials, so a GLSL1 material leaves the
// G-buffer undefined for those pixels and the ink lines and watercolor strokes
// go to noise. cel.js's own vertex shader carries no skinning chunks — its
// contract is unskinned meshes — so the swap patches them in; see makeSkinnedCel.

import * as THREE from 'three';
import { GBUFFER_GLSL, createCelMaterial } from '../render/cel.js';
import { quantizeOnTwos, quantizeOnThrees } from '../render/quantize.js';
import { hash1, hashString, mulberry32 } from '../util/rand.js';
import storyData from '../story/scenes.json' with { type: 'json' };
import castData from '../story/cast.json' with { type: 'json' };
import brandTokens from '../../../khy-brand-tokens.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const FPS = 24;
// Head lag: the head trails the body by 3 frames (the brief asks for 2-4).
const LAG_SEC = 3 / FPS;
// Body twist against the gait phase. Small on purpose — a visible twist reads
// as a cartoon swagger, not as a body carrying weight.
const TWIST_AMP = 0.045;
const WATER_Y = 0.3; // the ink sea surface, the value tortoise-dai.js drops land on
const SAND_Y = 0.35;
const FLAME_HZ = 1 / 1.7; // the travelling lamp's flame, same as lampkeeper-que.js

// G-buffer material ids: 0 is background (no ink lines, full watercolor wash),
// 1-4 are the four foreground pieces of scene 1 (lamp stand, Que, Ding, Jian),
// 5 the ring light, 7 the ink eel. The tortoise keeps the ids its own model
// authored (11-24) because it already carries GLSL3 cel materials.
const MAT_BG = 0;
const MAT_QUE = 1;
const MAT_DING = 2;
const MAT_JIAN = 3;
const MAT_STAND = 4;
const MAT_RING = 5;
const MAT_EEL = 7;

// ---------------------------------------------------------------------------
// math helpers — every one a pure function of its arguments
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, u) => a + (b - a) * u;
const smoothstep = (e0, e1, x) => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};

// 0 -> 1 -> 0 across one unit; for one-shot events with no corner at the peak.
const bell = (u) => Math.sin(Math.PI * clamp01(u));

// Fast attack, exponential decay — the shape a musical beat makes in light.
function pulse(t, at, attack, decay) {
  const d = t - at;
  if (d <= 0) return 0;
  if (d < attack) return d / attack;
  return Math.exp(-(d - attack) / decay);
}

// A 0..1 window with its own fade in and fade out.
function window01(t, t0, t1, fadeIn = 0.25, fadeOut = 0.25) {
  if (t <= t0 || t >= t1) return 0;
  const span = t1 - t0;
  return smoothstep(t0, t0 + Math.min(fadeIn, span * 0.5), t) *
    (1 - smoothstep(t1 - Math.min(fadeOut, span * 0.5), t1, t));
}

// Anticipation: the counter-movement that peaks immediately before the main
// action and vanishes into it. `lead` is 4-8 frames of screen time.
function anticipate(t, at, lead) {
  const d = at - t;
  if (d <= 0 || d >= lead) return 0;
  return Math.sin(Math.PI * 0.5 * (1 - d / lead));
}

// Landing squash: 2-3 frames of press, then a decaying overshoot the other way.
function squashAt(t, at) {
  const d = t - at;
  if (d < 0 || d > 0.55) return 0;
  const press = 2.5 / FPS;
  if (d < press) return -0.17 * (d / press);
  const u = (d - press) / 0.55;
  return -0.17 * Math.cos(u * Math.PI * 2.1) * Math.exp(-u * 4.2);
}

// Follow-through: a damped oscillation on an extremity once the main motion ends.
function followAt(t, at, amp, hz, decay) {
  const d = t - at;
  if (d <= 0 || d > 2.4) return 0;
  return amp * Math.sin(d * hz * TAU) * Math.exp(-d * decay);
}

// Seeded value noise on a one-second lattice — handheld shake and dust drift.
// The project's hash is its only randomness source; see src/util/rand.js.
function vnoise(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash1(Math.imul(i, 0x27d4eb2d) + seed) * 2 - 1;
  const b = hash1(Math.imul(i + 1, 0x27d4eb2d) + seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

function shake(t, seed) {
  return vnoise(t * 0.45, seed) * 0.6 + vnoise(t * 1.13 + 11.7, seed + 977) * 0.3 +
    vnoise(t * 2.31 + 31.3, seed + 1901) * 0.1;
}

// The yaw a mover should carry, read off the finite difference of its own path.
// Flight paths are authored as position functions, so facing the direction of
// travel is derived from them rather than stored a second time.
function yawFromPath(pathFn, t) {
  const e = 1 / FPS;
  const a = pathFn(t - e);
  const b = pathFn(t + e);
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  if (dx * dx + dz * dz < 1e-12) return 0;
  return Math.atan2(dx, dz);
}

function gaitPhaseAt(t, gait) {
  return (((t / gait) % 1) + 1) % 1;
}

// ---------------------------------------------------------------------------
// palette — one source: delivery/brand/khy-brand-tokens.json
// ---------------------------------------------------------------------------

const PAL = {
  ink: brandTokens.color.ink.value,
  paper: brandTokens.color.paper.value,
  accent: brandTokens.color.accent.value,
  accentDark: brandTokens.color.accent.valueDark,
  brandGraphic: brandTokens.color.brandGraphic.value,
  gradient: brandTokens.graphic.gradient.slice(),
};
const C_INK = new THREE.Color(PAL.ink);
const C_PAPER = new THREE.Color(PAL.paper);
const C_AMBER = new THREE.Color(PAL.gradient[0]);
const C_ACCENT = new THREE.Color(PAL.accent);
const WHITE = new THREE.Color(0xffffff);

// The models read a flat palette map off ctx.palette; the ones that carry their
// own fallbacks accept this shape directly.
const MODEL_PALETTE = {
  ink: PAL.ink,
  paper: PAL.paper,
  accent: PAL.accent,
  accentDark: PAL.accentDark,
  brandGraphic: PAL.brandGraphic,
  gradient: PAL.gradient,
};

// The environment needs shades the token file does not name (a sunken ink, a
// wet-sand grey), so mixHex derives them — cached, because it runs per frame.
const HEX_CACHE = new Map();
function mixHex(a, b, amount) {
  const key = `${a}|${b}|${amount}`;
  let hex = HEX_CACHE.get(key);
  if (!hex) {
    hex = new THREE.Color(a).lerp(new THREE.Color(b), amount).getHexString();
    HEX_CACHE.set(key, hex);
  }
  return `#${hex}`;
}

// ---------------------------------------------------------------------------
// story — scenes.json is the shared truth with the capture chain
// ---------------------------------------------------------------------------

function readStory(input) {
  let raw = input;
  if (Array.isArray(input)) raw = { scenes: input, cycle: input.map((s) => s.id) };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.scenes)) raw = storyData;
  const scenes = raw.scenes.filter(
    (s) => s && typeof s.id === 'string' && Number(s.durationSec) > 0,
  );
  const order = scenes.map((s) => s.id);
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const cycle = Array.isArray(raw.cycle) && raw.cycle.length
    ? raw.cycle.filter((id) => byId.has(id))
    : order;
  return {
    scenes,
    order,
    byId,
    cycle,
    fadeSec: Number(raw.fadeSec) > 0 ? Number(raw.fadeSec) : 2,
    cycleSec: Number(raw.cycleSec) > 0
      ? Number(raw.cycleSec)
      : cycle.reduce((sum, id) => sum + Number(byId.get(id).durationSec), 0),
  };
}

// ---------------------------------------------------------------------------
// director-owned materials
// ---------------------------------------------------------------------------

// cel.js's vertex shader has no skinning chunks — its contract is unskinned
// meshes. Every character and creature in this film is a SkinnedMesh, so the
// swap patches the chunks in (the same set tortoise-dai.js carries) and forces
// a recompile. The fragment shader — the two-band look and the G-buffer
// packing — stays the single copy inside render/cel.js. three keys its program
// cache on the shader source (WebGLShaderCache), so a patched vertexShader
// really does get its own program.
const SKIN_CEL_VERT = /* glsl */ `
#include <skinning_pars_vertex>

out vec3 vViewNormal;
out vec3 vViewPos;

void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 view = modelViewMatrix * vec4(transformed, 1.0);
  vViewNormal = normalize(normalMatrix * objectNormal);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

function makeSkinnedCel(opts) {
  const material = createCelMaterial(opts);
  material.vertexShader = SKIN_CEL_VERT;
  material.needsUpdate = true;
  return material;
}

function propCel({ base, shadow, rim, materialId, gain = 1 }) {
  return createCelMaterial({
    base: new THREE.Color(base).multiplyScalar(gain),
    shadow: new THREE.Color(shadow).multiplyScalar(gain),
    rim: new THREE.Color(rim),
    materialId,
  });
}

// Sea, sky and wet sand. The ink-to-paper ramp is what keeps the horizon
// seamless: the sea has already become paper where the sky plane takes over,
// so no hard edge survives the mpp fade. The G-buffer packing is imported from
// cel.js, never re-typed.
const ENV_VERT = /* glsl */ `
out vec3 vViewPos;
out vec3 vViewNormal;

void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vViewPos = view.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * view;
}
`;

const ENV_FRAG = /* glsl */ `
precision highp float;

${GBUFFER_GLSL}

in vec3 vViewPos;
in vec3 vViewNormal;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gGbuffer;

uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uHorizon;
uniform float uReflect;
uniform float uReflectAt;
uniform float uReflectWidth;
uniform float uMaterialId;

void main() {
  float d = max(1e-3, -vViewPos.z);
  vec3 c = mix(uInk, uPaper, smoothstep(uHorizon * 0.25, uHorizon, d));
  // The paper-white band the ring light lays on the water. Its phase is
  // quantised to 8fps on the CPU (scene 1: "海面纸白反光 8 张每秒"), which is
  // why it is a uniform and not a shader-side clock.
  float band = exp(-pow((d - uReflectAt) / max(1e-3, uReflectWidth), 2.0));
  c = mix(c, uPaper, band * uReflect);
  gColor = vec4(c, 1.0);
  gGbuffer = vec4(vViewNormal, packGbuffer(d, uMaterialId));
}
`;

function makeEnvMaterial({ ink, paper, horizon = 300, materialId = MAT_BG }) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uInk: { value: new THREE.Color(ink) },
      uPaper: { value: new THREE.Color(paper) },
      uHorizon: { value: horizon },
      uReflect: { value: 0 },
      uReflectAt: { value: 120 },
      uReflectWidth: { value: 26 },
      uMaterialId: { value: materialId },
    },
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
  });
}

// Rain: one LineSegments for the whole field — one draw call — with per-vertex
// colour so a streak inside the lamp's light column can turn into a glowing
// ink glyph without a second mesh.
const RAIN_VERT = /* glsl */ `
in vec3 aColor;

out vec3 vColor;

void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RAIN_FRAG = /* glsl */ `
precision highp float;

${GBUFFER_GLSL}

in vec3 vColor;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gGbuffer;

uniform float uMaterialId;

void main() {
  gColor = vec4(vColor, 1.0);
  // Rain is background-class: no ink lines of its own, and the wash fades it
  // with the mpp fade like every other far pixel.
  gGbuffer = vec4(0.0, 1.0, 0.0, packGbuffer(1024.0, uMaterialId));
}
`;

function makeRainMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uMaterialId: { value: MAT_BG } },
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
  });
}

// ---------------------------------------------------------------------------
// effect schedules — static data, so a frame never allocates
// ---------------------------------------------------------------------------

// Footfalls: the gait cycle is 3.2s with leg phases {fl 0, fr .5, rl .5, rr 0},
// so a foot re-enters the water every 1.6s. Offsets are the ankle positions in
// the tortoise's rest space (tortoise-dai.js LEG_DEFS); the applier carries
// them into world through the scene's tortoise placement.
const CROSSING_SPLASH_LEGS = [
  { dx: 1.26, dz: 1.7 },
  { dx: 1.26, dz: -1.7 },
  { dx: -1.74, dz: -1.74 },
  { dx: -1.74, dz: 1.74 },
];

function buildCrossingSplashes() {
  const out = [];
  for (let k = 0; k < 20; k += 1) {
    const leg = CROSSING_SPLASH_LEGS[k % CROSSING_SPLASH_LEGS.length];
    out.push({ t: 1.6 * k, dx: leg.dx, dz: leg.dz, r: 0.32 + 0.14 * hash1(k * 13 + 5), amp: 0.85 });
  }
  return out;
}

function buildRainSplashes() {
  const rand = mulberry32(hashString('director:rain-splash'));
  const out = [];
  for (let i = 0; i < 46; i += 1) {
    out.push({
      t: rand() * 29,
      dx: (rand() * 2 - 1) * 7,
      dz: (rand() * 2 - 1) * 4.5,
      r: 0.1 + rand() * 0.22,
      amp: 0.5,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// One splash = one outline ring. A blob of ink never gets a mesh per droplet.
const SPLASH_SCHEDULE = {
  'dawn-lamp': [{ t: 27.9, dx: 0.5, dz: -1.05, r: 0.9, amp: 1 }],
  'tortoise-crossing': buildCrossingSplashes(),
  'night-rain': buildRainSplashes(),
  homecoming: [
    { t: 3.0, dx: -2.3, dz: -1.4, r: 0.3, amp: 0.8 },
    { t: 12.0, dx: -2.1, dz: -1.6, r: 0.28, amp: 0.7 },
  ],
};

const RAIN_COUNT = 180;
const RAIN_TOP = 6.4;
const RAIN_BOTTOM = WATER_Y + 0.04;
const RAIN_SPAN = RAIN_TOP - RAIN_BOTTOM;
const RAIN_SLANT = Math.tan((12 * Math.PI) / 180); // 12 degrees, the scene's wind anchor

const rainRand = mulberry32(hashString('director:rain'));
const RAIN_STREAKS = [];
for (let i = 0; i < RAIN_COUNT; i += 1) {
  RAIN_STREAKS.push({
    // The field is kept tight around the tortoise: rain spread over the whole
    // frame would dilute the lamp's column to almost no glyphs, and the glyphs
    // are the shot.
    x: (rainRand() * 2 - 1) * 5.5,
    z: (rainRand() * 2 - 1) * 3.5,
    speed: 5.5 + rainRand() * 4.5,
    off: rainRand(),
    len: 0.16 + rainRand() * 0.22,
    // Streaks join as the rain builds and leave as it eases: the field fills
    // and empties instead of popping.
    gate: hash1(i * 31 + 7),
  });
}

// Dust / light-spot clusters: one mesh per cluster, never one per mote.
const MOTE_SEED = mulberry32(hashString('director:motes'));
const MOTES = [];
for (let i = 0; i < 6; i += 1) {
  MOTES.push({
    ax: MOTE_SEED() * 2 - 1,
    ay: MOTE_SEED() * 2 - 1,
    az: MOTE_SEED() * 2 - 1,
    fx: 0.3 + MOTE_SEED() * 0.5,
    fy: 0.2 + MOTE_SEED() * 0.4,
    fz: 0.3 + MOTE_SEED() * 0.5,
    ph: MOTE_SEED() * TAU,
    r: 0.018 + MOTE_SEED() * 0.03,
  });
}

// ---------------------------------------------------------------------------
// props — the environment and the effect pools
// ---------------------------------------------------------------------------

function boxGeometry(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function buildProps(scene) {
  const props = { owned: [] };
  const track = (obj) => {
    props.owned.push(obj);
    return obj;
  };

  // ---- sea + sky ----------------------------------------------------------
  const seaGeo = track(new THREE.PlaneGeometry(700, 700));
  seaGeo.rotateX(-Math.PI / 2);
  const seaMat = track(makeEnvMaterial({ ink: PAL.ink, paper: PAL.paper }));
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.name = 'director-sea';
  sea.position.y = WATER_Y;
  sea.frustumCulled = false;
  scene.add(sea);

  const skyGeo = track(new THREE.PlaneGeometry(1600, 700));
  const skyMat = track(makeEnvMaterial({ ink: PAL.paper, paper: PAL.paper, horizon: 1 }));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'director-sky';
  sky.position.set(0, 120, -320);
  sky.frustumCulled = false;
  scene.add(sky);
  props.sea = sea;
  props.sky = sky;

  // ---- scene 1: the dock and its lamp stand --------------------------------
  const dock = new THREE.Group();
  dock.name = 'director-dock';
  const woodMat = track(propCel({
    base: C_PAPER.clone().lerp(C_INK, 0.16),
    shadow: C_PAPER.clone().lerp(C_INK, 0.42),
    rim: C_AMBER,
    materialId: MAT_STAND,
  }));
  const frameMat = track(propCel({
    base: C_PAPER.clone().lerp(C_INK, 0.55),
    shadow: C_INK.clone(),
    rim: C_AMBER,
    materialId: MAT_STAND,
  }));
  const deck = new THREE.Mesh(track(boxGeometry(3.4, 0.1, 4.4, 0, 0.9, 0.6)), woodMat);
  deck.name = 'director-dock-deck';
  dock.add(deck);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(
        track(boxGeometry(0.12, 0.8, 0.12, sx * 1.5, 0.55, 0.6 + sz * 1.9)),
        frameMat,
      );
      post.name = `director-dock-post-${sx < 0 ? 'l' : 'r'}${sz < 0 ? 'b' : 'f'}`;
      dock.add(post);
    }
  }
  // The lamp stand: a column at the origin, four steps on its -X side (the side
  // Que's right hand reaches from), the lamp head on top.
  const column = new THREE.Mesh(track(boxGeometry(0.16, 1.7, 0.16, 0, 1.8, 0)), frameMat);
  column.name = 'director-lamp-column';
  dock.add(column);
  for (let i = 0; i < 4; i += 1) {
    const step = new THREE.Mesh(track(boxGeometry(0.42, 0.07, 0.5, -0.3, 1.05 + i * 0.18, 0)), woodMat);
    step.name = `director-lamp-step-${i}`;
    dock.add(step);
  }
  const lampHouse = new THREE.Mesh(track(boxGeometry(0.24, 0.18, 0.24, 0, 2.68, 0)), frameMat);
  lampHouse.name = 'director-lamp-house';
  dock.add(lampHouse);
  const lampGlass = new THREE.Mesh(
    track(boxGeometry(0.1, 0.12, 0.03, 0, 2.66, 0.12)),
    track(propCel({ base: C_AMBER, shadow: C_AMBER, rim: C_AMBER, materialId: MAT_STAND, gain: 0.6 })),
  );
  lampGlass.name = 'director-lamp-glass';
  dock.add(lampGlass);
  // The flame: small and bright so bloom carries the halo. A soft glow disc was
  // rejected on purpose — the MRT depth jump at its boundary makes the line
  // pass outline it in ink, so the light stays a physical object.
  const flameMat = track(propCel({
    base: C_AMBER, shadow: C_AMBER, rim: C_PAPER, materialId: MAT_STAND, gain: 2.6,
  }));
  const flame = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 10, 8)), flameMat);
  flame.name = 'director-lamp-flame';
  flame.position.set(0, 2.63, 0.14);
  dock.add(flame);
  const hook = new THREE.Mesh(track(new THREE.TorusGeometry(0.035, 0.008, 6, 12)), frameMat);
  hook.name = 'director-lamp-hook';
  hook.position.set(0, 2.44, 0.16);
  hook.rotation.x = Math.PI / 2;
  dock.add(hook);
  scene.add(dock);
  props.dock = dock;
  props.flame = flame;
  props.flameMat = flameMat;

  // ---- the lamp pole on the tortoise's shell ridge --------------------------
  // Parented to the spine4 bone (the shell heart) so it rides the shell's
  // breathing instead of floating above it.
  const pole = new THREE.Group();
  pole.name = 'director-pole';
  const poleMat = track(propCel({
    base: C_PAPER.clone().lerp(C_INK, 0.4),
    shadow: C_INK.clone(),
    rim: C_AMBER,
    materialId: MAT_STAND,
  }));
  const post = new THREE.Mesh(track(new THREE.CylinderGeometry(0.032, 0.042, 0.5, 8)), poleMat);
  post.position.y = 0.25;
  pole.add(post);
  const crossarm = new THREE.Mesh(track(boxGeometry(0.4, 0.02, 0.02, 0.2, 0.46, 0)), poleMat);
  pole.add(crossarm);
  const poleHouse = new THREE.Mesh(track(boxGeometry(0.14, 0.11, 0.14, 0, 0.56, 0)), poleMat);
  pole.add(poleHouse);
  const poleFlameMat = track(propCel({
    base: C_AMBER, shadow: C_AMBER, rim: C_PAPER, materialId: MAT_STAND, gain: 2.6,
  }));
  const poleFlame = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 10, 8)), poleFlameMat);
  poleFlame.position.set(0, 0.54, 0.09);
  pole.add(poleFlame);
  props.pole = pole;
  props.poleFlameMat = poleFlameMat;

  // ---- the ring light on the horizon ---------------------------------------
  const ring = new THREE.Group();
  ring.name = 'director-ring';
  const ringMat = track(propCel({
    base: C_AMBER, shadow: C_AMBER, rim: C_PAPER, materialId: MAT_RING, gain: 2.4,
  }));
  const torus = new THREE.Mesh(track(new THREE.TorusGeometry(6, 0.5, 8, 48)), ringMat);
  ring.add(torus);
  // One notch, so a rotationally symmetric ring can still be seen turning.
  const notch = new THREE.Mesh(track(boxGeometry(0.7, 0.7, 0.7, 0, 6, 0)), ringMat);
  ring.add(notch);
  ring.position.set(0, 2.8, -230);
  scene.add(ring);
  props.ring = ring;
  props.ringMat = ringMat;

  // ---- scene 4: the wet shore, the paper house, the light band -------------
  const shore = new THREE.Group();
  shore.name = 'director-shore';
  const sandMat = track(makeEnvMaterial({
    ink: C_PAPER.clone().lerp(C_INK, 0.34),
    paper: C_PAPER.clone().lerp(C_INK, 0.2),
    horizon: 1,
  }));
  const sandGeo = track(new THREE.PlaneGeometry(16, 10));
  sandGeo.rotateX(-Math.PI / 2);
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.position.set(0, SAND_Y, 4.6);
  sand.frustumCulled = false;
  shore.add(sand);

  const houseWall = track(propCel({
    base: C_PAPER.clone().lerp(C_INK, 0.1),
    shadow: C_PAPER.clone().lerp(C_INK, 0.45),
    rim: C_AMBER,
    materialId: MAT_STAND,
  }));
  const houseRoof = track(propCel({
    base: C_ACCENT.clone().lerp(C_PAPER, 0.25),
    shadow: C_ACCENT.clone().lerp(C_INK, 0.4),
    rim: C_AMBER,
    materialId: MAT_STAND,
  }));
  const houseSlotMat = track(propCel({
    base: C_INK, shadow: C_INK, rim: C_INK, materialId: MAT_STAND,
  }));
  // A lamp burning inside: the slot is what Que delivers into, so it carries
  // the only bright thing on the shore until the windows answer.
  const houseGlowMat = track(propCel({
    base: C_AMBER, shadow: C_AMBER, rim: C_PAPER, materialId: MAT_STAND, gain: 0.35,
  }));

  const house = new THREE.Group();
  house.name = 'director-house';
  house.position.set(1.2, SAND_Y, 3.4);
  const body = new THREE.Mesh(track(boxGeometry(1.5, 1.3, 1.1, 0, 0.65, 0)), houseWall);
  house.add(body);
  for (const sz of [-1, 1]) {
    const slab = new THREE.Mesh(track(boxGeometry(1.62, 0.05, 0.62, 0, 1.34, sz * 0.3)), houseRoof);
    slab.rotation.x = sz * 0.42;
    house.add(slab);
  }
  const door = new THREE.Mesh(track(boxGeometry(0.5, 0.9, 0.04, 0, 0.45, 0.56)), houseWall);
  house.add(door);
  const slot = new THREE.Mesh(track(boxGeometry(0.16, 0.05, 0.03, 0, 0.72, 0.58)), houseSlotMat);
  slot.name = 'director-house-slot';
  house.add(slot);
  for (const sx of [-1, 1]) {
    const win = new THREE.Mesh(
      track(boxGeometry(0.3, 0.26, 0.03, sx * 0.46, 0.78, 0.56)),
      houseGlowMat,
    );
    win.name = `director-house-window${sx < 0 ? 'l' : 'r'}`;
    house.add(win);
  }
  shore.add(house);
  props.houseGlowMat = houseGlowMat;

  // The light band on the wet sand: a flat patch lying on the surface. Its
  // depth stays continuous with the sand, so the line pass leaves it alone —
  // the same reason a floating glow disc was rejected.
  const bandMat = track(propCel({
    base: C_AMBER, shadow: C_AMBER, rim: C_AMBER, materialId: MAT_BG, gain: 1.5,
  }));
  const bandGeo = track(new THREE.PlaneGeometry(5.5, 0.7));
  bandGeo.rotateX(-Math.PI / 2);
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.name = 'director-light-band';
  band.position.set(0, SAND_Y + 0.012, 1.5);
  shore.add(band);
  props.band = band;
  scene.add(shore);
  props.shore = shore;

  // ---- scene 3: the letter on its parabola ---------------------------------
  const letterMat = track(propCel({
    base: C_PAPER, shadow: C_PAPER.clone().lerp(C_INK, 0.4), rim: C_AMBER, materialId: MAT_JIAN,
  }));
  const letter = new THREE.Mesh(track(boxGeometry(0.1, 0.004, 0.07)), letterMat);
  letter.name = 'director-letter';
  letter.visible = false;
  scene.add(letter);
  props.letter = letter;

  // ---- rain ----------------------------------------------------------------
  const rainGeo = track(new THREE.BufferGeometry());
  const rainPos = new Float32Array(RAIN_COUNT * 6);
  const rainCol = new Float32Array(RAIN_COUNT * 6);
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  rainGeo.setAttribute('aColor', new THREE.BufferAttribute(rainCol, 3));
  const rainMesh = new THREE.LineSegments(rainGeo, track(makeRainMaterial()));
  rainMesh.name = 'director-rain';
  rainMesh.frustumCulled = false;
  rainMesh.visible = false;
  scene.add(rainMesh);
  props.rain = rainMesh;
  props.rainPos = rainPos;
  props.rainCol = rainCol;

  // ---- splashes: one outline ring per blob ---------------------------------
  const splashGeo = track(new THREE.RingGeometry(0.8, 1.0, 22, 1));
  splashGeo.rotateX(-Math.PI / 2);
  props.splashes = [];
  for (let i = 0; i < 18; i += 1) {
    const mat = track(propCel({
      base: C_AMBER, shadow: C_AMBER, rim: C_AMBER, materialId: MAT_BG, gain: 1.7,
    }));
    const mesh = new THREE.Mesh(splashGeo, mat);
    mesh.name = `director-splash-${i}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    props.splashes.push(mesh);
  }

  // ---- dust / light-spot clusters ------------------------------------------
  const moteGeo = track(new THREE.OctahedronGeometry(1, 0));
  props.motes = [];
  for (let i = 0; i < MOTES.length; i += 1) {
    const mat = track(propCel({
      base: C_AMBER, shadow: C_AMBER, rim: C_PAPER, materialId: MAT_BG, gain: 2.2,
    }));
    const mesh = new THREE.Mesh(moteGeo, mat);
    mesh.name = `director-mote-${i}`;
    mesh.visible = false;
    scene.add(mesh);
    props.motes.push(mesh);
  }

  return props;
}

// ---------------------------------------------------------------------------
// liveness — head lag reads the scripted curve, never last frame's value
// ---------------------------------------------------------------------------

// Whatever the curve did over the last LAG_SEC seconds is what the head still
// carries. Reading it off the curve (instead of storing the previous frame) is
// what keeps the overlay a pure function of t.
function headLagFromYaw(yawFn, t) {
  return yawFn(t - LAG_SEC) - yawFn(t);
}

function headLagFromCurve(curveFn, t, gain) {
  return (curveFn(t - LAG_SEC) - curveFn(t)) * gain;
}

// ---------------------------------------------------------------------------
// per-scene staging
// ---------------------------------------------------------------------------

// Tortoise placement. The model is authored facing +Z with the belly on the
// waterline (tortoise-dai.js:18-19); the director owns where it goes.
function daiPlacement(sceneId, t) {
  if (sceneId === 'dawn-lamp') {
    // Surfacing at the dock edge: the shadow crosses right to left, then the
    // whole animal rises so the head clears the water on the last frames. The
    // end height is pinned by the shell, not the head — the carapace's ridge
    // rests flush under the dock deck (deck underside y=0.85, ridge y=0.86 at
    // -1.95), so the animal cannot rise any further without poking through the
    // dock. The head's own lift is a neck pitch in directDawnLamp.
    const rise = smoothstep(24, 28, t);
    return { x: 3.0 - 0.125 * t, y: lerp(-2.9, -1.95, rise), z: -1.3, yaw: 0 };
  }
  if (sceneId === 'tortoise-crossing') {
    return { x: 0.4 * t, y: 0, z: 0, yaw: Math.PI / 2 };
  }
  if (sceneId === 'night-rain') {
    return { x: 2.0 + 0.15 * t, y: 0, z: 0, yaw: Math.PI / 2 };
  }
  // homecoming: beached, head on the sand, rear still in the sea. The swell is
  // a 12s wave whose peaks land on t=5 and t=17 (scenes.json's beat notes).
  const swell = 0.15 * Math.sin((TAU * (t - 5)) / 12) * window01(t, 4.4, 22.4, 1.2, 1.6);
  return { x: 0, y: swell, z: 0.4, yaw: 0.6 };
}

// tortoise rest space -> world, for the scene's current placement.
function daiLocal(sceneId, t, lx, lz) {
  const d = daiPlacement(sceneId, t);
  const c = Math.cos(d.yaw);
  const s = Math.sin(d.yaw);
  return [d.x + lx * c + lz * s, d.y, d.z - lx * s + lz * c];
}

// Approximation of the folded shell surface (the real one is tortoise-dai.js
// shellSurface, which the model does not export): the central ridge at 2.8m,
// the rim at 1.1m, narrowing fore and aft. Riders are placed from this, so it
// only has to be right to a few centimetres.
function shellY(lx, lz) {
  const halfW = 1.6 * Math.max(0.15, 1 - Math.pow(Math.abs(lz) / 3.0, 2.2));
  const u = clamp(lx / halfW, -1, 1);
  return 2.8 - 1.7 * Math.pow(Math.abs(u), 2.6);
}

// The travelling lamp's flame, shared by the dock head and the shell pole.
function lampLevel(t, litFrom) {
  const lit = smoothstep(litFrom, litFrom + 2 / FPS, t);
  if (lit <= 0) return 0;
  const flicker = 0.5 + 0.5 * Math.sin(t * FLAME_HZ * TAU);
  const hashFlicker = hash1(Math.floor(t * 12) + 3) * 0.18;
  return lit * (0.78 + 0.22 * flicker + hashFlicker);
}

// Beat-driven note visual: every beat flares the light sources, main beats
// harder than the filler micro-events. This is the only place the score's
// rhythm reaches the picture, and it is read off scenes.json rather than guessed.
function beatFlash(t, def) {
  let f = 0;
  for (const b of def.beats || []) {
    const weight = b.kind === 'music' ? 1 : 0.4;
    f = Math.max(f, weight * pulse(t, Number(b.t) || 0, 0.09, 0.55));
  }
  return clamp01(f);
}

// ---------------------------------------------------------------------------
// scene 1 — dawn-lamp
// ---------------------------------------------------------------------------

function directDawnLamp(t, def) {
  // Que on the third step; t=15 she turns to face the sea.
  const queYaw = (tt) => -2.35 * smoothstep(14.5, 16.1, tt);
  const quePlace = [-0.3, 1.38, 0];
  const reach = window01(t, 5.5, 8.3, 0.35, 0.6);
  const turnAntic = anticipate(t, 14.5, 0.4);

  // Ding climbs the robe hem to the second step, then takes the letter in.
  const climb = smoothstep(11.2, 12.7, t);
  const dingPos = [lerp(-0.3, -0.3, climb), lerp(2.153, 1.3, climb), lerp(-0.26, 0.12, climb)];
  const take = window01(t, 11.8, 13.4, 0.3, 0.5);

  // Jian sleeps on the hook, rolls once at t=17, startles at t=19, flies two
  // and a half turns and lands on Que's left shoulder.
  const hookPos = [0, 2.38, 0.16];
  const shoulder = [-0.46, 2.62, 0.12];
  const a0 = Math.atan2(hookPos[0] - quePlace[0], hookPos[2] - quePlace[2]);
  const circlePos = (tt) => {
    const u = clamp01((tt - 19) / 8.75);
    const ang = a0 - 2.5 * TAU * u;
    const r = lerp(0.5, 0.17, smoothstep(26.95, 27.75, tt));
    return [
      quePlace[0] + r * Math.sin(ang),
      lerp(2.85, 2.62, smoothstep(26.95, 27.75, tt)),
      quePlace[2] + r * Math.cos(ang),
    ];
  };
  const jianPath = (tt) => {
    if (tt < 19) return hookPos;
    if (tt < 27.75) return circlePos(tt);
    return shoulder;
  };
  const jianLand = smoothstep(26.95, 27.75, t);
  const jianCircle = circlePos(t);
  const jianPos = t < 27.75
    ? [
      lerp(jianCircle[0], shoulder[0], jianLand),
      lerp(jianCircle[1], shoulder[1], jianLand),
      lerp(jianCircle[2], shoulder[2], jianLand),
    ]
    : shoulder;

  let jianPose = 'sleep';
  let jianWingHz = 2;
  if (t >= 17 && t < 19) jianPose = 'rest';
  else if (t >= 19 && t < 27.75) {
    jianPose = 'fly';
    // 0.5Hz at the startle, rising through the arc (scenes.json t=22).
    jianWingHz = lerp(0.5, 3.4, smoothstep(19, 26, t));
  } else if (t >= 27.75) jianPose = 'perch';

  const dai = daiPlacement('dawn-lamp', t);
  const flash = beatFlash(t, def);
  const lamp = lampLevel(t, 6);

  return {
    camera: { p: [0.2, 1.75, 7.2], at: [0.05, 1.95, 0.1], fov: 40, roll: 0 },
    casts: [
      {
        id: 'lampkeeper-que',
        visible: true,
        ctx: { pose: reach > 0 ? 'reach' : 'idle', expression: 'calm', amount: reach },
        place: { p: quePlace, yaw: queYaw(t), roll: turnAntic * 0.05, scale: [1, 1, 1] },
        life: {
          lagYaw: headLagFromYaw(queYaw, t),
          twist: 0.012 * Math.sin(t * TAU / 4.2),
          follow: followAt(t, 16.1, 0.05, 1.7, 2.2),
          torso: 'chest',
          tip: 'hem-f',
        },
      },
      {
        id: 'inbox-ding',
        visible: t >= 10.6,
        ctx: {
          pose: climb > 0 && climb < 1 ? 'climb' : 'sit',
          expression: take > 0 ? 'take' : 'calm',
          amount: 1,
          wind: 0,
        },
        place: {
          p: dingPos,
          yaw: Math.PI,
          // Arriving on the step is a landing: two frames of squash, then the
          // overshoot back.
          scale: squashScale(squashAt(t, 12.7)),
        },
        life: {
          lagYaw: 0,
          twist: 0.03 * Math.sin(t * 1.85 * TAU) * (climb > 0 && climb < 1 ? 1 : 0.25),
          follow: followAt(t, 13.4, 0.06, 2.4, 2.6),
          torso: 'spine',
          tip: 'tail-9',
        },
      },
      {
        id: 'paper-moth-jian',
        visible: true,
        ctx: { pose: jianPose, wingHz: jianWingHz, wind: 0, mood: t >= 19 ? null : 0.16 },
        place: { p: jianPos, yaw: yawFromPath(jianPath, t), scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          lagPitch: headLagFromCurve((tt) => jianPath(tt)[1], t, 0.35),
          twist: 0,
          follow: followAt(t, 27.75, 0.05, 2.1, 2.4),
          torso: 'spine2',
          tip: 'antenna-l-0',
        },
      },
      {
        id: 'tortoise-dai',
        visible: true,
        ctx: {
          pose: t < 24 ? 'walk' : 'idle',
          expression: t >= 27.5 && t < 28 ? 'alert' : 'calm',
          gaitSec: 3.2,
          wind: 0,
          chew: false,
        },
        place: { p: [dai.x, dai.y, dai.z], yaw: dai.yaw, scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          lagPitch: headLagFromCurve((tt) => daiPlacement('dawn-lamp', tt).y, t, 0.25),
          twist: 0,
          follow: followAt(t, 24, 0.04, 1.2, 1.8),
          // The surfacing lift. daiPlacement cannot rise any further — the
          // carapace's ridge is flush under the dock deck — yet at its end
          // height the lids sit at y=0.25, under the 0.30 waterline, so
          // scenes.json's t=28 "眼睑睁开一道缝" was never on screen and the head
          // read as a brown smear pinned to the bottom edge. Pitching the neck
          // 0.17 rad lifts the head ~0.22m (the lids to y=0.47, the skull's
          // crown to 0.63) and pulls it 60px up the frame, leaving the shell
          // exactly where the staging put it.
          neck: 'neck-root',
          neckPitch: -0.17 * smoothstep(24.6, 28, t),
          torso: 'spine4',
          tip: 'tail',
        },
      },
      { id: 'ink-eel-yuan', visible: false, ctx: {}, place: null, life: null },
    ],
    env: {
      show: { dock: true, pole: false, ring: true, shore: false },
      rain: 0,
      lamp,
      flash,
      sea: { ink: mixHex(PAL.ink, PAL.paper, 0.05), paper: PAL.paper, reflect: 0.34 },
      daiX: dai.x,
      motes: { p: [0, 2.5, 0.3], radius: 0.55, bright: 0.5 * lamp + flash * 0.5 },
      letter: null,
    },
  };
}

// One squash value -> the group scale triple. The press is mostly vertical,
// with a little width so the silhouette reads as a body, not a piston.
function squashScale(s) {
  return [1 + s * 0.5, 1 + s, 1 + s * 0.5];
}

// ---------------------------------------------------------------------------
// scene 2 — tortoise-crossing
// ---------------------------------------------------------------------------

function directTortoiseCrossing(t, def) {
  const dai = daiPlacement('tortoise-crossing', t);

  // Que stands on the south ridge beside the lamp pole, facing the head.
  const queLocal = [-0.9, 0.45];
  const quePos = daiLocal('tortoise-crossing', t, queLocal[0], queLocal[1]);
  quePos[1] = shellY(queLocal[0], queLocal[1]);
  const queReach = window01(t, 25.4, 27.9, 0.4, 0.7);
  // Ding rides her right shoulder; facing +X, right is +Z.
  const dingPos = [quePos[0], quePos[1] + 1.22, quePos[2] + 0.16];

  // Jian patrols two metres in front of the snout, turns at the front pole
  // (t=24) and lands on Que's raised fingertip at t=27.
  const headPos = daiLocal('tortoise-crossing', t, 0, 3.82);
  const patrolCentre = [headPos[0] + 2.0, 3.4, headPos[2]];
  const patrolPos = (tt) => [
    patrolCentre[0] + 1.5 * Math.cos((TAU * (tt - 24)) / 4),
    3.4 + 0.12 * Math.sin((TAU * (tt - 24)) / 2),
    patrolCentre[2] + 0.35 * Math.sin((TAU * (tt - 24)) / 4),
  ];
  const fingertip = [quePos[0] + 0.5, quePos[1] + 1.15, quePos[2]];
  const jianPath = (tt) => {
    if (tt < 26) return patrolPos(tt);
    const a = patrolPos(26);
    const u = smoothstep(26, 27.1, tt);
    return [
      lerp(a[0], fingertip[0], u),
      lerp(a[1], fingertip[1], u) + 0.25 * Math.sin(Math.PI * u),
      lerp(a[2], fingertip[2], u),
    ];
  };
  const jianPose = t >= 27.1 ? 'perch' : 'fly';

  // Yuan crosses under the belly on the far side, left edge to right edge.
  const yuanIn = window01(t, 12.9, 22.2, 0.6, 0.8);
  const yuanX = -8 + (t - 13) * 1.7;

  const flash = beatFlash(t, def);
  const gait = gaitPhaseAt(t, 3.2);
  const gaitLag = gaitPhaseAt(t - LAG_SEC, 3.2);

  return {
    camera: orbitCamera(t),
    casts: [
      {
        id: 'tortoise-dai',
        visible: true,
        ctx: { pose: 'walk', expression: 'calm', gaitSec: 3.2, wind: 0, chew: true },
        place: { p: [dai.x, dai.y, dai.z], yaw: dai.yaw, scale: [1, 1, 1] },
        life: {
          lagYaw: 0.045 * (Math.sin(TAU * gaitLag) - Math.sin(TAU * gait)),
          twist: TWIST_AMP * Math.sin(TAU * gait + 0.6),
          follow: 0,
          torso: 'spine4',
          tip: 'tail',
        },
      },
      {
        id: 'lampkeeper-que',
        visible: true,
        ctx: { pose: queReach > 0 ? 'reach' : 'idle', expression: 'calm', amount: queReach },
        place: { p: quePos, yaw: Math.PI / 2, scale: [1, 1, 1] },
        life: {
          // She rides a walking animal: her head lags the gait, her chest
          // twists against it.
          lagYaw: 0.03 * (Math.sin(TAU * gaitLag + 1.2) - Math.sin(TAU * gait + 1.2)),
          twist: TWIST_AMP * 0.8 * Math.sin(TAU * gait),
          follow: followAt(t, 27.9, 0.045, 1.8, 2.2),
          torso: 'chest',
          tip: 'hem-f',
        },
      },
      {
        id: 'inbox-ding',
        visible: true,
        ctx: { pose: 'ride', expression: 'calm', amount: 1, wind: -0.3 },
        place: { p: dingPos, yaw: Math.PI / 2, scale: [1, 1, 1] },
        life: {
          lagYaw: 0.02 * (Math.sin(TAU * gaitLag + 2.0) - Math.sin(TAU * gait + 2.0)),
          twist: 0,
          follow: 0,
          torso: 'spine',
          tip: 'tail-9',
        },
      },
      {
        id: 'paper-moth-jian',
        visible: true,
        ctx: { pose: jianPose, wingHz: t < 24 ? 3.2 : 2.4, wind: 0, mood: null },
        place: { p: jianPath(t), yaw: yawFromPath(jianPath, t), scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          lagPitch: headLagFromCurve((tt) => jianPath(tt)[1], t, 0.4),
          twist: 0,
          follow: followAt(t, 27.1, 0.05, 2.2, 2.4),
          torso: 'spine2',
          tip: 'antenna-l-0',
        },
      },
      {
        id: 'ink-eel-yuan',
        visible: yuanIn > 0,
        ctx: { pose: 'cruise', expression: 'cursor' },
        place: { p: [dai.x + yuanX, -0.75, -0.6], yaw: Math.PI / 2, scale: [1, 1, 1] },
        life: null,
      },
    ],
    env: {
      show: { dock: false, pole: true, ring: true, shore: false },
      rain: 0,
      lamp: 1,
      flash,
      sea: { ink: mixHex(PAL.ink, PAL.paper, 0.12), paper: PAL.paper, reflect: 0.24 },
      daiX: dai.x,
      motes: { p: [dai.x + 0.5, 3.3, -0.1], radius: 0.35, bright: 0.35 + flash * 0.5 },
      letter: null,
    },
  };
}

// The orbit is an arc, not a straight line between from and to: a straight
// interpolation would cut across the tortoise's back. The angles are read off
// the two endpoints, the radius off their distance from the axis, and the last
// 15% eases out so the shot settles instead of stopping dead (scenes.json t=29).
function orbitCamera(t) {
  const from = [-6.1, 2.8, 2.2];
  const to = [6.1, 2.8, 2.2];
  const dur = 32;
  const a0 = Math.atan2(from[0], from[2]);
  const a1 = Math.atan2(to[0], to[2]);
  const radius = Math.hypot(from[0], from[2]);
  const u = clamp01(t / dur);
  const p = u <= 0.85 ? u : 0.85 + 0.15 * (1 - Math.pow(1 - (u - 0.85) / 0.15, 2));
  const a = lerp(a0, a1, p);
  const dai = daiPlacement('tortoise-crossing', t);
  return {
    p: [dai.x + radius * Math.sin(a), from[1], radius * Math.cos(a)],
    at: [dai.x, 2.2, 0],
    fov: 48,
    roll: 0,
  };
}

// ---------------------------------------------------------------------------
// scene 3 — night-rain
// ---------------------------------------------------------------------------

// Ding's screen reads "已收妥" once the letter is back: a fast cursor, rather
// than an expression the model does not have.
function dingTake(t) {
  return window01(t, 22.6, 24.2, 0.2, 0.4) > 0;
}

function directNightRain(t, def) {
  const dur = Number(def.durationSec);
  const dai = daiPlacement('night-rain', t);

  // Que under the paper eave, facing into the rain.
  const queLocal = [-1.12, -0.72];
  const quePos = daiLocal('night-rain', t, queLocal[0], queLocal[1]);
  quePos[1] = shellY(queLocal[0], queLocal[1]);
  const queReach = window01(t, 12.6, 23.6, 0.4, 0.8);
  const palm = [quePos[0], quePos[1] + 1.05, quePos[2] - 0.5];

  // Ding on the shell's second step; the wind opens the cover at t=13.
  const dingLocal = [-1.25, 0.2];
  const dingPos = daiLocal('night-rain', t, dingLocal[0], dingLocal[1]);
  dingPos[1] = shellY(dingLocal[0], dingLocal[1]);
  const coverOpen = window01(t, 12.6, 14.6, 0.25, 0.5);

  // The letter: blown out of the cover at t=13, apex at t=15 (two seconds of
  // flight, 1.2m up, 1m downwind), caught, carried back, delivered.
  const letterStart = [dingPos[0] + 0.02, dingPos[1] + 0.3, dingPos[2] - 0.06];
  const letterFree = (tt) => {
    const dt = tt - 13;
    return [
      letterStart[0],
      letterStart[1] + 1.2 * dt - 0.3 * dt * dt,
      letterStart[2] + 0.5 * dt,
    ];
  };
  const apex = letterFree(15);

  // Jian: perched on the pole's crossarm, dives at t=13, catches the letter at
  // the apex, carries it back against the wind, delivers at t=22.
  const perchPos = daiLocal('night-rain', t, 0.38, 0.5);
  perchPos[1] = 3.08;
  const jianPath = (tt) => {
    if (tt < 13) return perchPos;
    if (tt < 15) {
      const u = smoothstep(13, 15, tt);
      return [
        lerp(perchPos[0], apex[0], u),
        lerp(perchPos[1], apex[1], u) - 0.3 * Math.sin(Math.PI * u),
        lerp(perchPos[2], apex[2], u),
      ];
    }
    if (tt < 22) {
      const u = smoothstep(15, 22, tt);
      return [
        lerp(apex[0], palm[0], u),
        lerp(apex[1], palm[1], u) + 0.22 * Math.sin(Math.PI * u),
        lerp(apex[2], palm[2], u),
      ];
    }
    const u = smoothstep(22, 22.8, tt);
    return [
      lerp(palm[0], perchPos[0], u),
      lerp(palm[1], perchPos[1], u),
      lerp(palm[2], perchPos[2], u),
    ];
  };
  let jianPose = 'rain';
  if (t >= 13 && t < 22.8) jianPose = 'fly';
  else if (t >= 22.8) jianPose = 'rain';

  // The letter mesh rides the moth between the catch and the delivery.
  let letterPos = null;
  if (t >= 13 && t < 15) letterPos = letterFree(t);
  else if (t >= 15 && t < 22) {
    const j = jianPath(t);
    letterPos = [j[0], j[1] - 0.06, j[2]];
  } else if (t >= 22 && t < 24) letterPos = [palm[0], palm[1] - 0.05, palm[2]];

  // Yuan rolls over beside the belly: one hump, nine squares, then gone.
  const rollIn = window01(t, 12.4, 16.2, 0.7, 0.9);
  const yuanY = t < 15.4
    ? lerp(-1.35, -0.78, smoothstep(12.6, 13.3, t))
    : lerp(-0.78, -1.35, smoothstep(15.4, 16.2, t));

  // Rain intensity: the first drop at t=0, dense by t=9, easing after t=24.
  const rain = clamp01(smoothstep(0, 9, t)) * (1 - 0.85 * smoothstep(24, 30, t));

  // Handheld: the base dolly plus seeded shake. Gusts at t=6 and t=11 double
  // the amplitude; after the wind stops at t=24 it rings down to 0.02m.
  const gust = Math.max(1, 1.5 * pulse(t, 6, 0.8, 2.5), 1.5 * pulse(t, 11, 0.6, 3.0)) *
    (0.35 + 0.65 * (1 - smoothstep(24, 30, t)));
  const amp = 0.06 * gust;
  const u = clamp01(t / dur);
  const baseP = [lerp(1.9, 0.3, u), lerp(3.2, 3.3, u), lerp(4.4, 3.2, u)];
  const camP = [
    dai.x + baseP[0] + amp * shake(t, 11),
    baseP[1] + amp * 0.8 * shake(t, 29),
    baseP[2] + amp * shake(t, 47),
  ];
  // The whip pan toward the sea and back, at the wind peak.
  const panYaw = 0.38 * bell((t - 18) / 1.3);
  const at = [dai.x, 2.6, 0.4];
  const dx = camP[0] - at[0];
  const dz = camP[2] - at[2];
  const ca = Math.cos(panYaw);
  const sa = Math.sin(panYaw);

  const flash = beatFlash(t, def);
  const gait = gaitPhaseAt(t, 6);
  const gaitLag = gaitPhaseAt(t - LAG_SEC, 6);

  return {
    camera: {
      p: [at[0] + dx * ca - dz * sa, camP[1], at[2] + dx * sa + dz * ca],
      at,
      fov: 55,
      roll: 0.012 * shake(t, 71),
    },
    casts: [
      {
        id: 'tortoise-dai',
        visible: true,
        ctx: { pose: 'walk', expression: 'asleep', gaitSec: 6, wind: 0.21, chew: false },
        place: { p: [dai.x, dai.y, dai.z], yaw: dai.yaw, scale: [1, 1, 1] },
        life: {
          lagYaw: 0.03 * (Math.sin(TAU * gaitLag + 1.1) - Math.sin(TAU * gait + 1.1)),
          twist: TWIST_AMP * 0.6 * Math.sin(TAU * gait),
          follow: 0,
          torso: 'spine4',
          tip: 'tail',
        },
      },
      {
        id: 'lampkeeper-que',
        visible: true,
        ctx: { pose: 'idle', expression: 'calm', amount: 1, wind: 0.21 },
        place: {
          p: quePos,
          yaw: Math.PI,
          // The wind lifts the hem: 12 degrees from t=9 until it stops at t=24.
          roll: 0.02 * window01(t, 9, 24.5, 1.2, 1.2),
          scale: [1, 1, 1],
        },
        life: {
          lagYaw: 0,
          twist: 0.01 * Math.sin(t * TAU / 4.2),
          follow: followAt(t, 23.6, 0.05, 1.9, 2.3),
          torso: 'chest',
          tip: 'hem-f',
        },
      },
      {
        id: 'inbox-ding',
        visible: true,
        ctx: {
          pose: 'sit',
          expression: t >= 13.4 && t < 22 ? 'think' : dingTake(t) ? 'take' : 'calm',
          amount: 1,
          cover: coverOpen,
          wind: -0.3,
        },
        place: { p: dingPos, yaw: Math.PI, scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          twist: 0,
          follow: followAt(t, 14.6, 0.06, 2.6, 2.8),
          torso: 'spine',
          tip: 'tail-9',
        },
      },
      {
        id: 'paper-moth-jian',
        visible: true,
        ctx: { pose: jianPose, wingHz: 5.5, wind: 0.6, mood: null },
        place: { p: jianPath(t), yaw: yawFromPath(jianPath, t), scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          lagPitch: headLagFromCurve((tt) => jianPath(tt)[1], t, 0.45),
          twist: 0,
          follow: followAt(t, 22, 0.05, 2.3, 2.5),
          torso: 'spine2',
          tip: 'antenna-l-0',
        },
      },
      {
        id: 'ink-eel-yuan',
        visible: rollIn > 0,
        ctx: {
          pose: rollIn > 0 ? 'roll' : 'lurk',
          expression: 'all',
          poseT: t - 13,
          exprT: t - 13,
        },
        place: { p: [dai.x + 1.9, yuanY, -0.5], yaw: Math.PI / 2, scale: [1, 1, 1] },
        life: null,
      },
    ],
    env: {
      show: { dock: false, pole: true, ring: false, shore: false },
      rain,
      lamp: 0.9 + 0.1 * Math.sin(t * 3.1) + flash * 0.3,
      flash,
      sea: { ink: mixHex(PAL.ink, PAL.paper, -0.35), paper: mixHex(PAL.paper, PAL.ink, 0.5), reflect: 0.05 },
      daiX: dai.x,
      motes: { p: [dai.x + 0.5, 3.2, -0.1], radius: 0.45, bright: 0.4 * rain + flash * 0.6 },
      letter: letterPos ? { p: letterPos, yaw: 0.2 } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// scene 4 — homecoming
// ---------------------------------------------------------------------------

function directHomecoming(t, def) {
  const dai = daiPlacement('homecoming', t);

  // Que walks the zig-zag down from the south ridge. The descent is 6s / 14
  // steps and starts one second before the scene's t=0 (it began during the
  // paper dip), which is why this cast carries a +1s time offset: the model's
  // walk cadence is fixed at 1.17Hz and 14 steps take 5.98s.
  const descentU = (tt) => clamp01((tt + 1) / 6);
  const ridge = [-1.0, 2.45, 1.1];
  // Clear of the house's front eave (the body ends at z=3.95, the roof slab
  // overhangs to z=4.51), so a standing Que passes it: she only kneels once she
  // is here. Kneeling at 3.75 put her inside the house body with its front wall
  // between her and the camera — the delivery, the scene's action peak, was a
  // hidden character behind a paper box.
  const delivery = [1.2, SAND_Y, 5.4];
  // The lateral half of the descent. A straight line from the ridge to the slot
  // runs through the middle of the house — its walls stand at x=0.45..1.95 and
  // the eave reaches x=0.39..2.01 — so she holds left of the house until she is
  // past the eave and only then swings in to the door. At u=0.88 she is at
  // z=4.88, clear of the eave's front tip at 4.51; the zig-zag's last lobe
  // points away from the house so the swing starts from open ground, not off
  // the wall.
  const queX = (u) => (u < 0.88
    ? lerp(ridge[0], 0.05, smoothstep(0, 0.88, u)) + 0.14 * Math.sin(u * Math.PI * 4.5)
    : lerp(0.05, delivery[0], smoothstep(0.88, 1, u)));
  const quePath = (tt) => {
    const u = descentU(tt);
    return [
      queX(u),
      lerp(ridge[1], delivery[1], smoothstep(0, 1, u)),
      lerp(ridge[2], delivery[2], u),
    ];
  };
  const walking = descentU(t) < 1;
  const kneel = window01(t, 5.4, 24.2, 0.35, 0.9);
  const stepPhase = gaitPhaseAt(t + 1, 1 / 1.17);
  // One squash per footfall — the model's own cadence puts a foot down every
  // half cycle — plus the arrival's.
  let stepSquash = 0;
  for (let k = 0; k < 14; k += 1) {
    stepSquash = Math.min(stepSquash, squashAt(t, 0.214 + k * 0.427 - 1));
  }
  stepSquash = Math.min(stepSquash, squashAt(t, 5.98));

  // Ding follows two steps behind on a parallel path — the same lateral shape,
  // offset to Que's far side so she clears the house exactly when Que does.
  const dingPath = (tt) => {
    const u = descentU(tt - 0.42);
    return [
      queX(u) - 0.26,
      lerp(ridge[1], delivery[1] + 0.02, smoothstep(0, 1, u)),
      lerp(ridge[2], delivery[2], u) + 0.1,
    ];
  };

  // Jian circles Que and the mail slot once, then leaves through the top edge.
  // Two things are sized here rather than guessed:
  //   - the rise ends at 3.62m, which is where the crane's lowest framing puts
  //     the moth's centre on the top edge at u=1. 4.6m overshot it half a
  //     second early and the moth was gone for the whole final second, while
  //     scenes.json t=28 says "出画点即末帧".
  //   - the first 0.17 of u blends out of the resting spot. The circle starts
  //     1.7m from where the moth was parked, so without the blend the pose
  //     change at t=26 read as a 270px cut across the frame.
  const jianRest = [2.9, 0.9, 5.4];
  const jianPath = (tt) => {
    if (tt < 26) return jianRest;
    const u = clamp01((tt - 26) / 2);
    const a = u * TAU;
    const r = lerp(1.2, 0.2, u);
    const p = [
      delivery[0] + r * Math.sin(a),
      lerp(1.5, 3.62, smoothstep(0, 1, u)),
      delivery[2] - 0.4 + r * Math.cos(a),
    ];
    const k = smoothstep(0, 0.17, u);
    return [lerp(jianRest[0], p[0], k), lerp(jianRest[1], p[1], k), lerp(jianRest[2], p[2], k)];
  };

  // Yuan's farewell: one distant square lights, then a dark ridge sinks away.
  const yuanIn = window01(t, 18.9, 20.9, 0.4, 0.7);

  const flash = beatFlash(t, def);
  const windowLit = window01(t, 5, 5.4, 0.2, 0);
  const crane = craneProgress(t, Number(def.durationSec));

  return {
    // The crane pulls back to 9.9m and opens to 40° so one shot can hold the whole
    // staging. The paper house stands at z=3.4 and Que's delivery point at
    // z=5.4, while the shell ridge she walks down from is 3.5m high — a camera
    // 4.8m out on a 36° lens cannot span both ends of that: the house's roof
    // lands ~1030px down a 720px frame and Que walks off the bottom edge at
    // t=2, so the delivery (t=5, the scene's action peak) and the rise (t=24)
    // both play off screen. The look-at also drops over the crane's first five
    // seconds and then holds, which is what keeps her feet and the house off the
    // bottom edge once she is down on the sand without pushing her head, the
    // shell ridge or the lamp flame out the top at the crane's highest.
    camera: {
      p: [0.4, lerp(5.6, 3.2, crane), 9.9],
      at: [0.9, lerp(1.95, 1.3, clamp01(t / 5)), 2.6],
      fov: 40,
      roll: 0,
    },
    casts: [
      {
        id: 'tortoise-dai',
        visible: true,
        ctx: { pose: 'rest', expression: 'alert', gaitSec: 3.2, wind: 0, chew: true },
        place: { p: [dai.x, dai.y, dai.z], yaw: dai.yaw, scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          lagPitch: headLagFromCurve((tt) => daiPlacement('homecoming', tt).y, t, 0.3),
          twist: 0.01 * Math.sin(t * TAU / 4.5),
          follow: 0,
          torso: 'spine4',
          tip: 'tail',
        },
      },
      {
        id: 'lampkeeper-que',
        visible: true,
        ctx: {
          pose: walking ? 'walk' : kneel > 0 ? 'kneel' : 'idle',
          expression: 'calm',
          amount: walking ? 1 : kneel,
        },
        tOffset: 1,
        place: {
          p: quePath(t),
          yaw: walking ? Math.PI / 2 : Math.PI,
          scale: squashScale(stepSquash),
        },
        life: {
          lagYaw: 0.02 * (Math.sin(TAU * gaitPhaseAt(t - LAG_SEC + 1, 1 / 1.17)) - Math.sin(TAU * stepPhase)),
          twist: TWIST_AMP * 0.9 * Math.sin(TAU * stepPhase),
          follow: followAt(t, 24.4, 0.05, 1.6, 2.0),
          torso: 'chest',
          tip: 'hem-f',
        },
      },
      {
        id: 'inbox-ding',
        visible: true,
        ctx: {
          pose: descentU(t - 0.42) < 1 ? 'walk' : 'idle',
          expression: 'calm',
          amount: 1,
          cover: window01(t, 0, 8, 0.4, 1.2),
          wind: 0,
        },
        tOffset: 1.42,
        place: { p: dingPath(t), yaw: Math.PI, scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          twist: 0.02 * Math.sin(TAU * gaitPhaseAt(t + 1.42, 1 / 1.17)),
          follow: followAt(t, 8, 0.06, 2.2, 2.6),
          torso: 'spine',
          tip: 'tail-9',
        },
      },
      {
        id: 'paper-moth-jian',
        visible: true,
        ctx: { pose: t >= 26 ? 'fly' : 'rest', wingHz: 4, wind: 0, mood: 1 },
        place: { p: jianPath(t), yaw: yawFromPath(jianPath, t), scale: [1, 1, 1] },
        life: {
          lagYaw: 0,
          lagPitch: headLagFromCurve((tt) => jianPath(tt)[1], t, 0.3),
          twist: 0,
          follow: 0,
          torso: 'spine2',
          tip: 'antenna-l-0',
        },
      },
      {
        id: 'ink-eel-yuan',
        visible: yuanIn > 0,
        ctx: { pose: 'lurk', expression: 'all', exprT: t - 19 },
        place: {
          p: [6 - (t - 19) * 0.8, -0.9 - (t - 19) * 0.15, -14 - (t - 19) * 0.8],
          yaw: Math.PI / 2,
          scale: [1, 1, 1],
        },
        life: null,
      },
    ],
    env: {
      show: { dock: false, pole: true, ring: true, shore: true },
      rain: 0,
      lamp: 0.35,
      flash,
      sea: { ink: mixHex(PAL.ink, PAL.paper, 0.06), paper: PAL.paper, reflect: 0.3 },
      daiX: dai.x,
      motes: { p: [1.2, 1.6, 3.4], radius: 0.8, bright: 0.45 + flash * 0.5 },
      letter: null,
      windowLit,
    },
  };
}

// The crane is linear for its first 18% and then eases out, which is what puts
// it at 79% of its travel by t=17 (scenes.json) instead of the 61% a straight
// ramp would give.
function craneProgress(t, dur) {
  if (t <= 5) return (t / 5) * 0.18;
  const v = clamp01((t - 5) / Math.max(1e-6, dur - 5));
  return 0.18 + 0.82 * (1 - Math.pow(1 - v, 2));
}

// ---------------------------------------------------------------------------
// createDirector
// ---------------------------------------------------------------------------

export function createDirector({ scene, camera, pipeline, models, scenes } = {}) {
  if (!scene || scene.isScene !== true) {
    throw new Error('[director] createDirector() needs a THREE.Scene as scene.');
  }
  if (!camera || camera.isPerspectiveCamera !== true) {
    throw new Error('[director] createDirector() needs a THREE.PerspectiveCamera as camera — the pipeline derives mpp from a perspective projection.');
  }
  if (!pipeline || typeof pipeline.render !== 'function' || typeof pipeline.setFade !== 'function') {
    throw new Error('[director] createDirector() needs a pipeline with render(t) and setFade(a).');
  }

  const story = readStory(scenes);
  if (!story.order.length) {
    throw new Error('[director] scenes 里没有可用场景（需要 [{ id, durationSec }]）。');
  }

  const castIds = [...castData.characters, ...castData.creatures].map((c) => c.id);
  const missing = castIds.filter((id) => !models || typeof models[id]?.build !== 'function');
  if (missing.length) {
    throw new Error(
      `[director] models 缺少角色模块：${missing.join(', ')}。缺一件画面就会静默少一个主体，这里不降级。`,
    );
  }

  // ---- the cel swap ---------------------------------------------------------
  // render/pipeline.js only writes its second render target for GLSL3
  // materials; the three MeshBasicMaterial models and the ink eel's
  // MeshStandardMaterial would leave the G-buffer undefined for their pixels
  // and turn the ink lines and watercolor strokes into noise. One cel material
  // per source material object, so the models' own colour animation — Que's
  // cursor, Ding's scrolling rows, Jian's vein mood, Yuan's squares — survives
  // through the per-frame sync below.
  const celSwap = [];

  function swapCelMaterials(castId, group) {
    const materialId = castId === 'lampkeeper-que' ? MAT_QUE
      : castId === 'inbox-ding' ? MAT_DING
        : castId === 'paper-moth-jian' ? MAT_JIAN
          : castId === 'ink-eel-yuan' ? MAT_EEL
            : null;
    // The tortoise already carries its own GLSL3 cel materials with authored
    // ids; swapping those would throw its id map away.
    if (materialId === null) return;
    const seen = new Map();
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      const src = obj.material;
      if (!src || src.glslVersion === THREE.GLSL3) return;
      let cel = seen.get(src);
      if (!cel) {
        // Transparent sources (the nictitating membrane, the ink mist) fold
        // their opacity into the colour: blending under MRT would blend the
        // packed depth and id along with it. Fading toward black is the same
        // call tortoise-dai.js makes for its ripple.
        const base = src.color ? src.color.clone() : WHITE.clone();
        if (src.emissive) base.add(src.emissive.clone().multiplyScalar(src.emissiveIntensity ?? 1));
        if (src.opacity < 1) base.multiplyScalar(src.opacity);
        const hsl = base.getHSL({ h: 0, s: 0, l: 0 });
        cel = makeSkinnedCel({
          base,
          shadow: base.clone().lerp(C_INK, 0.45),
          rim: hsl.l > 0.5 ? C_PAPER : C_AMBER,
          materialId,
        });
        if (src.side === THREE.DoubleSide) cel.side = THREE.DoubleSide;
        // Some models animate their colour through the mesh
        // (lampkeeper-que.js writes spot.mesh.material.color, ink-eel-yuan.js
        // writes spots[i].material.color) and others through a closure on the
        // original material. Aliasing the one Color instance both channels
        // write to is what keeps the swap from freezing either of them; the
        // per-frame sync below reads that same instance.
        cel.color = src.color || base;
        cel.name = `cel-${castId}`;
        seen.set(src, cel);
      }
      obj.material = cel;
      celSwap.push({ mesh: obj, cel, src });
    });
  }

  // ---- build the cast ------------------------------------------------------
  const built = new Map();
  for (const id of castIds) {
    const module = models[id];
    const result = module.build({ scene, palette: MODEL_PALETTE });
    if (!result || !result.group || typeof result.update !== 'function') {
      throw new Error(`[director] 模型 ${id} 的 build() 没有返回 { group, update }。`);
    }
    if (!result.group.parent) scene.add(result.group);
    result.restScale = result.group.scale.clone();
    built.set(id, result);
    swapCelMaterials(id, result.group);
  }

  const props = buildProps(scene);

  // ---- the playhead --------------------------------------------------------
  // Only the play mode touches this: setScene re-anchors the cycle so the next
  // renderAt starts at the chosen scene. renderSceneAt never reads it.
  let originId = story.cycle[0];

  function cycleStart(id) {
    let sum = 0;
    for (const cid of story.cycle) {
      if (cid === id) return sum;
      sum += Number(story.byId.get(cid).durationSec);
    }
    return 0;
  }

  function locate(t) {
    const span = story.cycleSec;
    const T = (((cycleStart(originId) + t) % span) + span) % span;
    let acc = 0;
    for (const id of story.cycle) {
      const dur = Number(story.byId.get(id).durationSec);
      if (T < acc + dur) return { id, start: acc, local: T - acc };
      acc += dur;
    }
    const last = story.cycle[story.cycle.length - 1];
    return { id: last, start: cycleStart(last), local: T - cycleStart(last) };
  }

  // ---- direction -----------------------------------------------------------
  const DIRECT = {
    'dawn-lamp': directDawnLamp,
    'tortoise-crossing': directTortoiseCrossing,
    'night-rain': directNightRain,
    homecoming: directHomecoming,
  };

  function directScene(sceneId, t) {
    const fn = DIRECT[sceneId];
    const def = story.byId.get(sceneId);
    if (!fn || !def) {
      throw new Error(`[director] 未知场景 ${sceneId}（可用：${story.order.join(', ')}）。`);
    }
    return fn(t, def);
  }

  // ---- per-frame application ----------------------------------------------
  const _a = new THREE.Color();
  const _b = new THREE.Color();
  const _poleWorld = new THREE.Vector3();
  const _glyphColor = C_AMBER.clone();
  const _inkColor = C_INK.clone();

  function syncCel() {
    for (const { cel, src } of celSwap) {
      const base = _a.copy(src.color || WHITE);
      if (src.emissive) base.add(_b.copy(src.emissive).multiplyScalar(src.emissiveIntensity ?? 1));
      if (src.opacity < 1) base.multiplyScalar(src.opacity);
      cel.uniforms.uBase.value.copy(base);
      cel.uniforms.uShadow.value.copy(base).lerp(C_INK, 0.45);
    }
  }

  function applyCasts(dir, tq) {
    const slots = new Map(dir.casts.map((c) => [c.id, c]));
    for (const [id, model] of built) {
      const slot = slots.get(id);
      const on = !!(slot && slot.visible !== false && slot.place);
      model.group.visible = on;
      if (!on) continue;

      // A per-cast time offset re-phases a model whose rhythm is fixed (Que's
      // walk cadence) against the scene's clock. Everything else reads the
      // scene time.
      model.update(tq + (slot.tOffset || 0), slot.ctx || {});

      const p = slot.place.p;
      group_place(model.group, slot.place, p, model.restScale);

      // Liveness overlays: additive rotations on top of whatever the model
      // wrote. Every model resets its driven bones at the top of update(), so
      // these never accumulate.
      const life = slot.life;
      if (life) {
        const head = model.group.getObjectByName('head') || model.group.getObjectByName('skull');
        if (head) {
          if (life.lagYaw) head.rotation.y += life.lagYaw;
          if (life.lagPitch) head.rotation.x += life.lagPitch;
        }
        if (life.twist) {
          const torso = model.group.getObjectByName(life.torso);
          if (torso) torso.rotation.y += life.twist;
        }
        if (life.follow) {
          const tip = model.group.getObjectByName(life.tip);
          if (tip) tip.rotation.x += life.follow;
        }
        // A pitch on the neck bone rather than on the head: the head bone sits
        // at the end of the neck, so rotating it only tips the skull. Used by
        // dawn-lamp's surfacing, where the head has to come up out of the water
        // while the shell stays put under the dock. Models without the named
        // bone ignore it, the same way torso/tip do.
        if (life.neckPitch) {
          const neck = model.group.getObjectByName(life.neck);
          if (neck) neck.rotation.x += life.neckPitch;
        }
      }
    }
  }

  function group_place(group, place, p, restScale) {
    group.position.set(p[0], p[1], p[2]);
    group.rotation.set(0, place.yaw || 0, place.roll || 0);
    const s = place.scale || [1, 1, 1];
    group.scale.set(restScale.x * s[0], restScale.y * s[1], restScale.z * s[2]);
  }

  function applyEnv(dir, t, tf) {
    const env = dir.env;
    const show = env.show;

    props.sea.material.uniforms.uInk.value.set(env.sea.ink);
    props.sea.material.uniforms.uPaper.value.set(env.sea.paper);
    props.sea.material.uniforms.uReflect.value = env.sea.reflect;
    props.sky.material.uniforms.uInk.value.set(env.sea.paper);
    props.sky.material.uniforms.uPaper.value.set(env.sea.paper);

    props.dock.visible = show.dock;
    props.ring.visible = show.ring;
    props.shore.visible = show.shore;
    props.letter.visible = !!env.letter;
    if (env.letter) {
      props.letter.position.set(env.letter.p[0], env.letter.p[1], env.letter.p[2]);
      props.letter.rotation.set(0.2, env.letter.yaw, 0.1);
    }

    // The shell pole rides the tortoise's spine4 bone; it only ever shows with
    // the tortoise.
    const daiModel = built.get('tortoise-dai');
    const spine4 = (daiModel.boneMap && daiModel.boneMap.spine4) || daiModel.group;
    if (props.pole.parent !== spine4) {
      if (props.pole.parent) props.pole.parent.remove(props.pole);
      spine4.add(props.pole);
    }
    props.pole.visible = show.pole && daiModel.group.visible;

    // The lamp: flame brightness plus a beat's worth of flare. The dock head
    // and the shell pole carry the same flame, which is the same lamp.
    const lamp = clamp01(env.lamp);
    const lampGain = 2.6 * lamp * (1 + env.flash * 0.8);
    props.flame.visible = lamp > 0.01;
    props.flameMat.uniforms.uBase.value.copy(C_AMBER).multiplyScalar(lampGain);
    props.flameMat.uniforms.uShadow.value.copy(props.flameMat.uniforms.uBase.value);
    props.poleFlameMat.uniforms.uBase.value.copy(C_AMBER).multiplyScalar(lampGain);
    props.poleFlameMat.uniforms.uShadow.value.copy(C_AMBER).multiplyScalar(lampGain);
    const ringGain = 2.4 * (0.7 + 0.3 * lamp) * (1 + env.flash * 0.6);
    props.ringMat.uniforms.uBase.value.copy(C_AMBER).multiplyScalar(ringGain);
    props.ringMat.uniforms.uShadow.value.copy(props.ringMat.uniforms.uBase.value);
    // One notch per minute: the ring turns at six degrees a second, and the
    // band on the wet sand follows it.
    props.ring.rotation.z = t * (TAU / 60);
    props.band.rotation.y = -t * (TAU / 60) * 0.5;

    const lit = env.windowLit === undefined ? 0 : clamp01(env.windowLit);
    const houseGain = 0.35 + 2.2 * lit;
    props.houseGlowMat.uniforms.uBase.value.copy(C_AMBER).multiplyScalar(houseGain);
    props.houseGlowMat.uniforms.uShadow.value.copy(C_AMBER).multiplyScalar(houseGain);

    applyRain(dir, tf);
    applySplashes(dir, tf);
    applyMotes(dir, tf);
  }

  function applyRain(dir, tf) {
    const rain = dir.env.rain;
    // Below this the field holds no streaks at all, and an all-degenerate
    // LineSegments is still a draw call. The buffer is parked either way, so a
    // frame that turns the rain back on never inherits the last rainy frame's
    // positions.
    props.rain.visible = rain > 0.02;

    // The pole's flame marks the light column; streaks inside it become glyphs.
    const daiModel = built.get('tortoise-dai');
    const spine4 = (daiModel.boneMap && daiModel.boneMap.spine4) || daiModel.group;
    spine4.updateWorldMatrix(true, false);
    _poleWorld.set(0, 0.54, 0).applyMatrix4(spine4.matrixWorld);

    const pos = props.rainPos;
    const col = props.rainCol;
    const glyphColor = _glyphColor.copy(C_AMBER).multiplyScalar(2.4);
    const inkColor = _inkColor.copy(C_INK).multiplyScalar(1.15);
    const columnLow = 0.6;
    const columnHigh = 4.2;

    for (let i = 0; i < RAIN_COUNT; i += 1) {
      const s = RAIN_STREAKS[i];
      const o = i * 6;
      if (s.gate >= rain) {
        // Park inactive streaks below the sea rather than toggling draw ranges.
        pos[o] = 0; pos[o + 1] = -50; pos[o + 2] = 0;
        pos[o + 3] = 0; pos[o + 4] = -50; pos[o + 5] = 0;
        continue;
      }
      const fall = (tf * s.speed + s.off) % 1;
      const y = RAIN_TOP - fall * RAIN_SPAN;
      const drop = RAIN_TOP - y;
      const x = dir.env.daiX + s.x;
      const z = s.z + RAIN_SLANT * drop;
      const y2 = y - s.len;
      const z2 = z + RAIN_SLANT * s.len;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = x; pos[o + 4] = y2; pos[o + 5] = z2;

      // A streak crossing the lamp's column reads as a glowing ink glyph. The
      // column widens toward the sea the way a shaft of light does, and the
      // test runs on the quantised clock so a glyph holds for a whole
      // three-frame beat instead of flickering per frame.
      const midY = (y + y2) * 0.5;
      const columnR = midY < columnLow || midY > columnHigh ? 0
        : lerp(1.0, 0.35, (midY - columnLow) / (columnHigh - columnLow));
      const inColumn = columnR > 0 && Math.hypot(x - _poleWorld.x, z - _poleWorld.z) < columnR;
      const c = inColumn ? glyphColor : inkColor;
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      col[o + 3] = c.r; col[o + 4] = c.g; col[o + 5] = c.b;
    }
    props.rain.geometry.attributes.position.needsUpdate = true;
    props.rain.geometry.attributes.aColor.needsUpdate = true;
  }

  function applySplashes(dir, tf) {
    const schedule = SPLASH_SCHEDULE[dir.sceneId] || [];
    let used = 0;
    for (const ev of schedule) {
      const age = tf - ev.t;
      if (age < 0 || age > 0.9 || used >= props.splashes.length) continue;
      const k = age / 0.9;
      const mesh = props.splashes[used];
      used += 1;
      mesh.visible = true;
      const r = ev.r * (0.3 + 1.15 * k);
      mesh.position.set(dir.env.daiX + ev.dx, WATER_Y + 0.012, ev.dz);
      mesh.scale.set(r, 1, r * 0.82);
      const fade = (1 - k) * ev.amp;
      mesh.material.uniforms.uBase.value.copy(C_AMBER).multiplyScalar(1.7 * fade);
      mesh.material.uniforms.uShadow.value.copy(C_AMBER).multiplyScalar(1.7 * fade);
    }
    for (let i = used; i < props.splashes.length; i += 1) props.splashes[i].visible = false;
  }

  function applyMotes(dir, tf) {
    const cfg = dir.env.motes;
    for (let i = 0; i < props.motes.length; i += 1) {
      const mesh = props.motes[i];
      if (!cfg || cfg.bright <= 0.01) {
        mesh.visible = false;
        continue;
      }
      const m = MOTES[i];
      mesh.visible = true;
      mesh.position.set(
        cfg.p[0] + cfg.radius * m.ax * Math.sin(tf * m.fx + m.ph),
        cfg.p[1] + cfg.radius * m.ay * Math.sin(tf * m.fy + m.ph * 1.7),
        cfg.p[2] + cfg.radius * m.az * Math.cos(tf * m.fz + m.ph * 0.6),
      );
      mesh.scale.setScalar(m.r * (0.8 + 0.4 * Math.sin(tf * 1.3 + m.ph)));
      mesh.material.uniforms.uBase.value.copy(C_AMBER).multiplyScalar(2.2 * cfg.bright);
      mesh.material.uniforms.uShadow.value.copy(C_AMBER).multiplyScalar(2.2 * cfg.bright);
    }
  }

  function applyCamera(dir) {
    const cam = dir.camera;
    camera.position.set(cam.p[0], cam.p[1], cam.p[2]);
    camera.lookAt(cam.at[0], cam.at[1], cam.at[2]);
    if (cam.roll) camera.rotateZ(cam.roll);
    if (camera.fov !== cam.fov) {
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
    }
  }

  function applyFrame(sceneId, time) {
    const dir = directScene(sceneId, time);
    dir.sceneId = sceneId;
    applyCamera(dir);
    applyCasts(dir, quantizeOnTwos(time));
    // syncCel 必须在 applyCasts 之后：模型在 update() 里写颜色（摆缘光斑走
    // mesh.material.color、墨脉与复眼走原材质闭包，两条通道都落在被别到 cel
    // 上的同一个 Color 实例上），提前一步同步就等于把上一帧的颜色渲染进这一帧
    // ——同 t 两次渲染会差出几个像素，采集链的字节复现判据直接红。
    syncCel();
    applyEnv(dir, time, quantizeOnThrees(time));
  }

  function renderSceneAt(sceneId, t) {
    const time = Number.isFinite(t) ? t : 0;
    applyFrame(sceneId, time);
    pipeline.setFade(0);
    pipeline.render(time);
    return time;
  }

  function renderTransition(fromId, toId, k) {
    const mix = clamp01(Number.isFinite(k) ? k : 0);
    const fromDef = story.byId.get(fromId);
    const toDef = story.byId.get(toId);
    if (!fromDef || !toDef) {
      throw new Error(`[director] renderTransition() 未知场景 ${fromId} -> ${toId}。`);
    }
    // Paper dip: the outgoing scene fades to paper across the first half, the
    // incoming one fades in across the second. Neither side hard-cuts, and the
    // two midpoints are the frames the beat notes hand over on — the last frame
    // of one scene and the first of the next.
    if (mix < 0.5) {
      applyFrame(fromId, Number(fromDef.durationSec));
      pipeline.setFade(mix / 0.5);
    } else {
      applyFrame(toId, 0);
      pipeline.setFade(1 - (mix - 0.5) / 0.5);
    }
    pipeline.render(Number(fromDef.durationSec) + mix);
    return mix;
  }

  function sceneAt(t) {
    return locate(Number.isFinite(t) ? t : 0).id;
  }

  function renderAt(t) {
    const time = Number.isFinite(t) ? t : 0;
    const { id, local } = locate(time);
    return renderSceneAt(id, local);
  }

  function setScene(id) {
    if (!story.byId.has(id)) {
      throw new Error(`[director] 未知场景 ${id}（可用：${story.order.join(', ')}）。`);
    }
    originId = id;
    return id;
  }

  function currentScene() {
    return locate(0).id;
  }

  function dispose() {
    for (const model of built.values()) {
      if (model.group.parent) model.group.parent.remove(model.group);
    }
    for (const obj of props.owned) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && obj.material.dispose) obj.material.dispose();
    }
    for (const { cel } of celSwap) cel.dispose();
    if (props.pole.parent) props.pole.parent.remove(props.pole);
    for (const key of ['sea', 'sky', 'dock', 'ring', 'shore', 'letter', 'rain', 'band']) {
      const obj = props[key];
      if (obj && obj.parent) obj.parent.remove(obj);
    }
    for (const mesh of [...props.splashes, ...props.motes]) {
      if (mesh.parent) mesh.parent.remove(mesh);
    }
    // The pipeline, the scene and the camera belong to the caller (main.js
    // builds all three); this only tears down what the director itself made.
    built.clear();
  }

  return {
    sceneIds: () => story.order.slice(),
    sceneAt,
    renderAt,
    renderSceneAt,
    renderTransition,
    setScene,
    currentScene,
    dispose,
  };
}
