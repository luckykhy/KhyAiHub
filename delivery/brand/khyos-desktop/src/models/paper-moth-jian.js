// models/paper-moth-jian.js — 笺蛾·阿笺, the letter-carrying moth.
//
// Four things in here are forced by rig.js rather than chosen:
//   1) The assemblies carry fixed layout constants — a 0.1m lid rod hinged
//      0.12m ahead of the head bone, a 0.09m jaw — with no size override.
//      Authoring a 4mm head at rig scale and shrinking the whole group once at
//      the end is the only way to use them without forking the shared layer; a
//      uniform scale after bind is the one transform the skinning contract
//      explicitly allows.
//   2) makeEyelids lays its shell out at the world origin instead of at the head
//      bone, so the shell geometry is translated onto the head after the call.
//      Its weights read x only, and the head bone sits on the body axis (x = 0),
//      so they survive the shift untouched — only y and z drift.
//   3) Bones carry positions and no rest rotation, so a rest pose is either
//      baked into the geometry (the folded wings) or written as bone rotations
//      the first time update runs (tucked legs, coiled proboscis, forward
//      antennae). Nothing accumulates and nothing reads a clock.
//   4) A wing's own frame (chord, surface normal, span) is left-handed for the
//      right wing and right-handed for the left, so the fold cannot be written
//      as "point the span here, the chord there". It is built from the span and
//      chord directions with the normal derived as their cross product, which
//      is the only way to keep det = +1 — a mirrored basis would turn the
//      normals inward and the cel shader would shade the plate black.
import * as THREE from 'three';
import { hash2 } from '../util/rand.js';
import { bindSkin, createBoneChain, loft, makeEyelids, makeJaw, sculpt } from './rig.js';

// Authoring scale: 1 native unit = 1/40 m. See note 1 above.
const NATIVE_PER_M = 40;
const GROUP_SCALE = 1 / NATIVE_PER_M;
const DEG = Math.PI / 180;

// Torso: a pen-stem rod, tail to neck. The loft runs on into the head volume so
// the neck has something to emerge from instead of meeting the ellipsoid at a
// single point.
const BODY_PROFILE = [
  [-1.8, 0.004],
  [-1.55, 0.055],
  [-1.2, 0.082],
  [-0.8, 0.1],
  [-0.4, 0.112],
  [0.0, 0.12],
  [0.4, 0.124],
  [0.8, 0.122],
  [1.2, 0.1],
  [1.55, 0.07],
  [1.8, 0.062],
  [1.95, 0.115],
  [2.1, 0.135],
];
const BODY_Z0 = -1.8;
const BODY_Z1 = 2.1;
const BODY_RINGS = 24;
const BODY_POINTS = 12;

// Head centre. z is set so the rod from the tail to the head's rear pole is the
// 0.09m the brief gives for the torso, with the ellipsoid riding on the front.
const HEAD_CENTER = new THREE.Vector3(0, 0, 1.98);
const HEAD_R = [0.16, 0.152, 0.175];
const HEAD_RINGS = 14;
const HEAD_POINTS = 12;

// Compound eyes: 1mm amber dots on the front of the head, placed inside the
// band the nictitating membrane sweeps across (see MEMBRANE_CLOSED_RAD).
const EYE_R = 0.02;
const EYE_LOCAL = [
  new THREE.Vector3(-0.0466, 0.0525, 0.1624),
  new THREE.Vector3(0.0466, 0.0525, 0.1624),
];

// Hinge point of the mouth, in world coordinates: the head's lower front.
const JAW_PIVOT = new THREE.Vector3(0, -0.092, HEAD_CENTER.z + 0.14);
const JAW_RANGE = [0, 0.12];
// Mirrors rig.js's LID_RANGE default, which is not exported. Only used to aim
// the membrane for the poses that hold it shut; the blink schedule itself still
// comes from the assembly's own update.
const MEMBRANE_CLOSED_RAD = 1.15;
const MEMBRANE_BLEND = 0.85;

const ANTENNA_LEN = 0.24;
const ANTENNA_DIR = new THREE.Vector3(0.45, 0.3, 0.84).normalize();
const ANTENNA_BASE_LOCAL = new THREE.Vector3(0.04, 0.08, 0.11);
const ANTENNA_BONES = 3;
const ANTENNA_BACK = new THREE.Vector3(0.15, -0.12, -0.98).normalize();

const PROBO_LEN = 0.22;
const PROBO_DIR = new THREE.Vector3(0, -0.25, 0.968).normalize();
const PROBO_MOUTH_LOCAL = new THREE.Vector3(0, -0.092, 0.14);
const PROBO_BONES = 2;
// Where the coiled proboscis ends up: down and back under the head. The segment
// directions are authored, not solved.
const PROBO_CURL = [
  new THREE.Vector3(0, -0.86, -0.51).normalize(),
  new THREE.Vector3(0, -0.62, -0.78).normalize(),
];

const LEG_ROWS = [
  { z: 1.28, reach: 1.0 },
  { z: 0.98, reach: 0.8 },
  { z: 0.68, reach: 0.6 },
];
const LEG_ATTACH_X = 0.085;
const LEG_ATTACH_Y = -0.055;
const LEG_FOOT_X = 0.075;
const LEG_FOOT_Y = -0.235;
const LEG_FOOT_DZ = 0.13;
const LEG_BONES = 3;

// Wings. Aspect ratio 1.6 is span/chord; the plate is a symmetric thin lens
// because the brief asks for a 薄板截面, not an airfoil.
const WING_SPAN = 1.8;
const WING_CHORD = WING_SPAN / 1.6;
const WING_TH = 0.04;
const WING_RINGS = 22;
const WING_POINTS = 12;
// Fold. The span yaws from lateral to fore-aft, then the plate tilts so the
// trailing edge — which the yaw put on the inner side — rises to the dorsal
// midline and the leading edge drapes down the flank. That is the only
// handedness-consistent way to fold a wing: the margin that ends up on the ridge
// is the inner one, and the surface still faces up and out.
const WING_TILT = 72 * DEG;
// The ridge leans 8°, descending toward the tail.
const RIDGE_LEAN = -8 * DEG;
const WING_BASE = new THREE.Vector3(0.085, 0.055, 0.3);
const WING_BONES = 4;
// Outline, in the wing's own frame: x = chord from the leading edge aft, z =
// span out from the root. The leading edge runs a hair behind the root line and
// hooks aft at the apex (前缘微凹); the trailing edge is the rounded one.
const CHORD_SHAPE = [
  [0, 0.06],
  [0.1, 0.4],
  [0.24, 0.74],
  [0.42, 0.95],
  [0.6, 1.0],
  [0.8, 0.8],
  [0.92, 0.52],
  [1, 0.18],
];
const LE_BIAS = -0.15;
const TE_BIAS = 0.85;
const LE_HOOK = 0.05;
const VEIN_TARGETS = [0.38, 0.62, 0.86];
const VEIN_HALF_W = 0.026;
const VEIN_HALF_T = 0.006;
const VEIN_RISE = 0.005;
const FIBER_SAMPLES = 22;
const FIBER_HALF_W = 0.006;
const FIBER_RISE = 0.05;
const FIBER_REACH = 0.018;
// A fiber's tip is weighted toward the bone further out along the span, so a
// wing bent by the wind drags the fringe flat instead of shearing it off.
const FIBER_DRAG = 2.2;

const BREATH_HZ = 0.28;
const WING_HZ = 2.0;
const WING_FLEX = [0, 0.35, 0.62, 0.85];
const WIND_SWEEP = 0.5;
const LEG_IDLE = 0.05;
const LEG_REACH = 0.32;
const ANTENNA_WOBBLE_HZ = 1.7;
const ANTENNA_WOBBLE = 0.035;
const IDLE_PITCH = 0.008;

const UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);

// Pose table. `open: null` means the spread is driven by t (a wingbeat), and
// `mood: null` means the vein glow is driven by t too.
const POSES = {
  rest: { open: 0, flap: 0, pitch: 0, membrane: 0, antenna: 0, proboscis: 0, talk: 1, mood: 0.16, eye: 0.5, legReach: 0, wind: 0 },
  sleep: { open: 0, flap: 0.02, pitch: 0, membrane: 0.9, antenna: 0.15, proboscis: 0, talk: 0.3, mood: 0.05, eye: 0.12, legReach: 0, wind: 0 },
  fly: { open: null, flap: 0.5, pitch: 0.105, membrane: 0, antenna: 0.25, proboscis: 0, talk: 1, mood: null, eye: 0.9, legReach: 0, wind: 0 },
  alert: { open: 1, flap: 0.58, pitch: 0.105, membrane: 0, antenna: 0.1, proboscis: 0, talk: 1, mood: 0.85, eye: 1, legReach: 0.2, wind: 0 },
  perch: { open: 0, flap: 0, pitch: 0, membrane: 0, antenna: 0, proboscis: 0.3, talk: 0.6, mood: 0.45, eye: 0.7, legReach: 0.7, wind: 0 },
  feed: { open: 0, flap: 0, pitch: 0, membrane: 0, antenna: 0, proboscis: 1, talk: 0.2, mood: 0.4, eye: 0.7, legReach: 0.5, wind: 0 },
  rain: { open: 0, flap: 0.12, pitch: 0.03, membrane: 0.55, antenna: 1, proboscis: 0, talk: 0.2, mood: 0.72, eye: 0.85, legReach: 0, wind: 1 },
};

// Expression channel, kept separate from the pose the way the rest of the cast
// does it: the director drives the face without moving the body. An expression
// only touches the membrane, the eye glow and the vein mood.
const EXPRS = {
  calm: { membrane: 0, eye: 0.5, mood: 0.16 },
  sleep: { membrane: 0.9, eye: 0.12, mood: 0.05 },
  awake: { membrane: 0, eye: 0.9, mood: 0.55 },
  alert: { membrane: 0, eye: 1, mood: 0.85 },
  rain: { membrane: 0.55, eye: 0.85, mood: 0.72 },
  joy: { membrane: 0, eye: 1, mood: 1 },
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const smoothstep = (a, b, t) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};

// Catmull-Rom through (t, value) control points. The body profile and the wing
// outline are a handful of numbers, not sixty hand-placed radii.
function spline1d(points, t) {
  const n = points.length;
  if (t <= points[0][0]) return points[0][1];
  if (t >= points[n - 1][0]) return points[n - 1][1];
  let i = 0;
  while (i < n - 2 && t > points[i + 1][0]) i++;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(n - 1, i + 2)];
  const span = p2[0] - p1[0];
  const u = span > 0 ? (t - p1[0]) / span : 0;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * u +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3)
  );
}

function lensRing(points, halfA, halfB, cx, cy) {
  const pts = [];
  for (let k = 0; k < points; k++) {
    const a = (k / points) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * halfA, cy + Math.sin(a) * halfB]);
  }
  return pts;
}

function perpendicular(dir) {
  const side = new THREE.Vector3().crossVectors(dir, UP);
  if (side.lengthSq() < 1e-8) side.copy(WORLD_X);
  return side.normalize();
}

// A tapered tube from a to b, lofted along its own axis so a limb can point
// anywhere without putting a rotation on a bone's rest pose. Legs, antennae and
// the proboscis are all this.
function limb(a, b, radiusFn, rings, points) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const side = perpendicular(dir);
  const up = new THREE.Vector3().crossVectors(side, dir).normalize();
  const sections = [];
  for (let i = 0; i < rings; i++) {
    const u = rings > 1 ? i / (rings - 1) : 0;
    const r = radiusFn(u);
    sections.push({ z: u * len, pts: lensRing(points, r, r, 0, 0) });
  }
  const geometry = loft(sections, { closed: true, cap: true });
  geometry.applyMatrix4(new THREE.Matrix4().makeBasis(side, up, dir).setPosition(a));
  return { geometry, axis: dir, origin: a.clone(), length: len };
}

// Weights along a limb's own axis, not through space: a tube's far end sits a
// full limb-length from its root bone, and 3D distance would starve it.
function axisWeight(position, axis, origin, at, support) {
  const s = position.dot(axis) - origin.dot(axis);
  return Math.max(0, 1 - Math.abs(s - at) / support);
}

// A lit look without lights. The render layer owns shading and the director is
// expected to swap cel materials in; this only stops the model reading as flat
// black when it is inspected on its own.
function shade(geometry, seed, lo, hi) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const colors = new Float32Array(position.count * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    n.fromBufferAttribute(normal, i);
    const lambert = n.dot(UP) * 0.5 + 0.5;
    const tooth = hash2(i * 31 + seed, seed) * 0.1;
    const v = lo + (hi - lo) * lambert + tooth;
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// ctx.palette belongs to the director: accept both the nested brand-token shape
// and a flat map, and fall back rather than throwing on a missing key.
function tone(palette, keys, fallback) {
  for (const key of keys) {
    let node = palette;
    for (const part of key.split('.')) {
      node = node && typeof node === 'object' ? node[part] : undefined;
    }
    const value = node && typeof node === 'object' ? node.valueDark ?? node.value : node;
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

const aim = (from, to) =>
  new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());

// ---- wing outline, in the wing's own frame --------------------------------
const wingShape = (t) => spline1d(CHORD_SHAPE, t);
const wingLE = (t) => (LE_BIAS * wingShape(t) + LE_HOOK * smoothstep(0.62, 1, t)) * WING_CHORD;
const wingTE = (t) => TE_BIAS * wingShape(t) * WING_CHORD;
const wingChord = (t) => wingTE(t) - wingLE(t);
const wingMid = (t) => (wingLE(t) + wingTE(t)) * 0.5;
const wingTh = (t) => WING_TH * (0.2 + 0.8 * wingShape(t));

function wingSections(side) {
  const sections = [];
  for (let i = 0; i <= WING_RINGS; i++) {
    const t = i / WING_RINGS;
    sections.push({
      z: t * WING_SPAN,
      // the left plate is authored mirrored in its chord axis: that is what lets
      // both wings share one handedness-consistent fold
      pts: lensRing(WING_POINTS, wingChord(t) * 0.5, wingTh(t) * 0.5, side * wingMid(t), 0),
    });
  }
  return sections;
}

function veinSections(target, side) {
  const sections = [];
  const zStart = wingMid(0.05);
  const zEnd = wingLE(target);
  for (let i = 0; i <= 10; i++) {
    const u = i / 10;
    const t = 0.05 + (target - 0.05) * u;
    // radiating veins bow aft as they run out, which is what reads as a leaf
    const z = zStart + (zEnd - zStart) * u + 0.07 * Math.sin(Math.PI * u);
    const rise = wingTh(t) * 0.5 + VEIN_RISE;
    sections.push({ z: t * WING_SPAN, pts: lensRing(6, VEIN_HALF_W, VEIN_HALF_T, side * z, rise) });
  }
  return sections;
}

function wingOutline(samples, side) {
  const le = [];
  const te = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    le.push(new THREE.Vector3(side * wingLE(t), 0, t * WING_SPAN));
    te.push(new THREE.Vector3(side * wingTE(t), 0, t * WING_SPAN));
  }
  // leading edge out to the apex, then back along the trailing edge: one closed
  // walk around the whole margin
  return le.concat(te.slice(0, -1).reverse());
}

// rig.loft stacks rings along one axis, so it cannot walk a closed outline with
// a hair standing off every sample. The fiber ring is built by hand instead and
// skinned to the wing chain like everything else.
function fiberGeometry(outline) {
  const centroid = new THREE.Vector3();
  for (const p of outline) centroid.add(p);
  centroid.multiplyScalar(1 / Math.max(1, outline.length));
  const positions = [];
  const index = [];
  const away = new THREE.Vector3();
  for (let i = 0; i < outline.length; i++) {
    const cur = outline[i];
    const nxt = outline[(i + 1) % outline.length];
    const tangent = new THREE.Vector3().subVectors(nxt, cur);
    if (tangent.lengthSq() < 1e-12) continue;
    tangent.normalize();
    // the outline is walked in the wing's own plane, so the outward normal is
    // the tangent turned a quarter turn inside that plane
    const normal = new THREE.Vector3(tangent.z, 0, -tangent.x);
    away.subVectors(cur, centroid);
    if (normal.dot(away) < 0) normal.negate();
    const tip = cur.clone().addScaledVector(UP, FIBER_RISE).addScaledVector(normal, FIBER_REACH);
    const a = cur.clone().addScaledVector(tangent, -FIBER_HALF_W);
    const b = cur.clone().addScaledVector(tangent, FIBER_HALF_W);
    const c = tip.clone().addScaledVector(tangent, -FIBER_HALF_W * 0.35);
    const d = tip.clone().addScaledVector(tangent, FIBER_HALF_W * 0.35);
    const base = positions.length / 3;
    for (const v of [a, b, d, c]) positions.push(v.x, v.y, v.z);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

export const model = {
  id: 'paper-moth-jian',
  build(ctx) {
    const palette = (ctx && ctx.palette) || {};
    const group = new THREE.Group();
    group.name = 'paper-moth-jian';

    const paperTone = tone(palette, ['color.paper.valueDark', 'color.paper.value', 'paper'], '#F6F2EC');
    const inkTone = tone(palette, ['color.ink.valueDark', 'color.ink.value', 'ink'], '#14110E');
    const amberTone = tone(palette, ['color.accent.valueDark', 'color.accent.value', 'accent'], '#F0A868');

    const paperMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(paperTone), vertexColors: true });
    const inkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(inkTone) });
    const amberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(amberTone) });
    // The nictitating membrane is a film over the eyes: it has to blend, not
    // occlude, and it is thin enough that depth-sorting it is not worth the risk.
    const membraneMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(paperTone),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    // Paper fibers are single quads; which way each one faces is not worth
    // solving, so the fringe renders double-sided.
    const fiberMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(paperTone),
      side: THREE.DoubleSide,
    });

    const inkColor = new THREE.Color(inkTone);
    const amberColor = new THREE.Color(amberTone);

    // ---- bone spec -------------------------------------------------------
    // Everything authored here is one chain: parents must precede children, so
    // the spine goes first and the limbs hang off thorax / head.
    const spec = [
      { name: 'jian-root', pos: [0, 0, 0.1] },
      { name: 'spine0', pos: [0, 0, -1.8], parent: 'jian-root' },
      { name: 'spine1', pos: [0, 0, -1.35], parent: 'spine0' },
      { name: 'spine2', pos: [0, 0, -0.9], parent: 'spine1' },
      { name: 'spine3', pos: [0, 0, -0.45], parent: 'spine2' },
      { name: 'spine4', pos: [0, 0, 0.0], parent: 'spine3' },
      { name: 'spine5', pos: [0, 0, 0.45], parent: 'spine4' },
      { name: 'thorax', pos: [0, 0, 0.9], parent: 'spine5' },
      { name: 'neck', pos: [0, 0, 1.45], parent: 'thorax' },
      { name: 'head', pos: HEAD_CENTER.toArray(), parent: 'neck' },
    ];

    // Legs: one tapered tube per leg, angled down and forward so the tuck reads
    // even before any bone moves.
    const legs = [];
    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'l' : 'r';
      for (let r = 0; r < LEG_ROWS.length; r++) {
        const name = `leg-${tag}${r + 1}`;
        const row = LEG_ROWS[r];
        const attach = new THREE.Vector3(LEG_ATTACH_X * side, LEG_ATTACH_Y, row.z);
        const foot = new THREE.Vector3(LEG_FOOT_X * side, LEG_FOOT_Y, row.z + LEG_FOOT_DZ);
        const built = limb(attach, foot, (u) => 0.03 - 0.018 * u, 6, 8);
        shade(built.geometry, 101 + r * 7 + (side < 0 ? 0 : 3), 0.4, 1.0);
        const seg = built.length / (LEG_BONES + 1);
        const names = [];
        for (let i = 0; i < LEG_BONES; i++) {
          const boneName = `${name}-${i}`;
          spec.push({
            name: boneName,
            pos: built.origin.clone().addScaledVector(built.axis, seg * (i + 1)).toArray(),
            parent: i === 0 ? 'thorax' : `${name}-${i - 1}`,
          });
          names.push(boneName);
        }
        legs.push({ names, row: r, ...built, seg, phase: r * 1.1 + (side < 0 ? 0 : 0.55) });
      }
    }

    // Antennae: straight tapered tubes with a swollen club at the tip.
    const antennae = [];
    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'l' : 'r';
      const name = `antenna-${tag}`;
      const base = HEAD_CENTER
        .clone()
        .add(new THREE.Vector3(ANTENNA_BASE_LOCAL.x * side, ANTENNA_BASE_LOCAL.y, ANTENNA_BASE_LOCAL.z));
      const dir = new THREE.Vector3(ANTENNA_DIR.x * side, ANTENNA_DIR.y, ANTENNA_DIR.z).normalize();
      const built = limb(
        base,
        base.clone().addScaledVector(dir, ANTENNA_LEN),
        // the club: the last fifth swells instead of tapering
        (u) => 0.019 - 0.008 * u + (u > 0.78 ? 0.02 * ((u - 0.78) / 0.22) : 0),
        9,
        8,
      );
      shade(built.geometry, 151 + (side < 0 ? 0 : 5), 0.42, 1.0);
      const seg = built.length / (ANTENNA_BONES + 1);
      const names = [];
      for (let i = 0; i < ANTENNA_BONES; i++) {
        const boneName = `${name}-${i}`;
        spec.push({
          name: boneName,
          pos: built.origin.clone().addScaledVector(built.axis, seg * (i + 1)).toArray(),
          parent: i === 0 ? 'head' : `${name}-${i - 1}`,
        });
        names.push(boneName);
      }
      antennae.push({
        names,
        geometry: built.geometry,
        axis: built.axis,
        origin: built.origin,
        seg,
        dir,
        back: new THREE.Vector3(ANTENNA_BACK.x * side, ANTENNA_BACK.y, ANTENNA_BACK.z).normalize(),
        phase: side < 0 ? 0 : 2.1,
      });
    }

    // Proboscis: authored straight and extended; the rest pose coils it by
    // rotating the bones, which is the only way to get a retraction out of a
    // skinning contract that moves vertices but never scales a bone.
    const proboMouth = HEAD_CENTER.clone().add(PROBO_MOUTH_LOCAL);
    const proboBuilt = limb(
      proboMouth,
      proboMouth.clone().addScaledVector(PROBO_DIR, PROBO_LEN),
      (u) => 0.021 - 0.013 * u,
      9,
      8,
    );
    shade(proboBuilt.geometry, 211, 0.45, 1.0);
    const proboSeg = proboBuilt.length / (PROBO_BONES + 1);
    const proboNames = [];
    for (let i = 0; i < PROBO_BONES; i++) {
      const boneName = `proboscis-${i}`;
      spec.push({
        name: boneName,
        pos: proboBuilt.origin.clone().addScaledVector(proboBuilt.axis, proboSeg * (i + 1)).toArray(),
        parent: i === 0 ? 'head' : `proboscis-${i - 1}`,
      });
      proboNames.push(boneName);
    }
    // Coil targets, as the local rotation each segment needs to reach them.
    const proboCurl = [];
    for (let i = 0; i < PROBO_CURL.length; i++) proboCurl.push(aim(PROBO_DIR, PROBO_CURL[i]));
    for (let i = 1; i < proboCurl.length; i++) {
      proboCurl[i].premultiply(proboCurl[i - 1].clone().invert());
    }

    // Wings: the plate, the veins and the fringe are all authored in the spread
    // frame and carried into the folded rest pose by one matrix, so the ridge is
    // exact instead of approximated by bone rotations.
    const wings = [];
    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'l' : 'r';
      // Span and chord directions, with the surface normal derived from their
      // cross product so the basis can never come out mirrored. The normal is
      // the only one that differs per side, and the chord axis follows from it —
      // authoring the left plate mirrored in its chord axis (see wingSections)
      // is what keeps the trailing edge on the ridge for both wings.
      const spanDir = new THREE.Vector3(0, 0, -1).applyAxisAngle(WORLD_X, RIDGE_LEAN);
      const chordDir = new THREE.Vector3(-Math.cos(WING_TILT), Math.sin(WING_TILT), 0).applyAxisAngle(WORLD_X, RIDGE_LEAN);
      const normalDir = new THREE.Vector3().crossVectors(spanDir, chordDir).normalize();
      const yAxis = new THREE.Vector3(normalDir.x * side, normalDir.y, normalDir.z);
      const xAxis = new THREE.Vector3().crossVectors(yAxis, spanDir);
      const fold = new THREE.Matrix4()
        .makeBasis(xAxis, yAxis, spanDir)
        .setPosition(WING_BASE.x * side, WING_BASE.y, WING_BASE.z);

      const names = [];
      for (let i = 0; i < WING_BONES; i++) {
        const boneName = `wing-${tag}-${i}`;
        spec.push({
          name: boneName,
          pos: new THREE.Vector3(0, 0, (i * WING_SPAN) / (WING_BONES - 1)).applyMatrix4(fold).toArray(),
          parent: i === 0 ? 'thorax' : `wing-${tag}-${i - 1}`,
        });
        names.push(boneName);
      }

      const plate = loft(wingSections(side), { closed: true, cap: true });
      plate.applyMatrix4(fold);
      shade(plate, 301 + (side < 0 ? 0 : 17), 0.44, 1.0);

      const veins = VEIN_TARGETS.map((target, i) => {
        const geometry = loft(veinSections(target, side), { closed: true, cap: true });
        geometry.applyMatrix4(fold);
        shade(geometry, 401 + i * 3 + (side < 0 ? 0 : 1), 0.3, 0.8);
        return geometry;
      });

      const fringe = fiberGeometry(wingOutline(FIBER_SAMPLES, side));
      fringe.applyMatrix4(fold);

      wings.push({
        names,
        fold,
        plate,
        veins,
        fringe,
        spanAxis: new THREE.Vector3(0, 0, 1).transformDirection(fold),
        surfNormal: new THREE.Vector3(0, 1, 0).transformDirection(fold),
      });
    }

    const { root, bones } = createBoneChain(spec);
    const boneWorld = {};
    for (const [name, bone] of Object.entries(bones)) {
      boneWorld[name] = bone.getWorldPosition(new THREE.Vector3());
    }

    // ---- body ------------------------------------------------------------
    const bodyGeometry = loft(
      Array.from({ length: BODY_RINGS }, (_, i) => {
        const t = i / (BODY_RINGS - 1);
        const z = BODY_Z0 + t * (BODY_Z1 - BODY_Z0);
        const r = spline1d(BODY_PROFILE, z);
        return { z, pts: lensRing(BODY_POINTS, r, r, 0, 0) };
      }),
      { closed: true, cap: true },
    );
    // Sculpt the rest, before anything is posed: ridges and volume sampled in
    // the spine's own frame ride with the skeleton instead of being baked into
    // one arbitrary pose.
    sculpt(bodyGeometry, { amp: 0.007, freq: 7, seed: 'jian-body', bone: bones.spine2 });
    sculpt(bodyGeometry, { amp: 0.0025, freq: 22, seed: 'jian-body-tooth', bone: bones.spine2 });
    shade(bodyGeometry, 11, 0.42, 1.0);

    const SPINE_NAMES = new Set(
      Object.keys(bones).filter(
        (n) => n.startsWith('spine') || n === 'jian-root' || n === 'thorax' || n === 'neck' || n === 'head',
      ),
    );
    const bodyMesh = bindSkin(new THREE.Mesh(bodyGeometry), root, (name, position) => {
      if (!SPINE_NAMES.has(name)) return 0;
      const w = boneWorld[name];
      return w ? Math.max(0, 1 - position.distanceTo(w) / 0.5) : 0;
    });
    bodyMesh.material = paperMat;
    group.add(bodyMesh);

    // ---- head ------------------------------------------------------------
    const headGeometry = loft(
      Array.from({ length: HEAD_RINGS }, (_, i) => {
        const t = i / (HEAD_RINGS - 1);
        const u = t * 2 - 1;
        const s = Math.sqrt(Math.max(0, 1 - u * u));
        return {
          z: HEAD_CENTER.z + u * HEAD_R[2],
          pts: lensRing(HEAD_POINTS, HEAD_R[0] * s, HEAD_R[1] * s, 0, 0),
        };
      }),
      { closed: true, cap: true },
    );
    sculpt(headGeometry, { amp: 0.004, freq: 14, seed: 'jian-head', bone: bones.head });
    shade(headGeometry, 23, 0.46, 1.0);
    const headMesh = bindSkin(new THREE.Mesh(headGeometry), bones.head, (name) => (name === 'head' ? 1 : 0));
    headMesh.material = paperMat;
    group.add(headMesh);

    // Compound eyes ride the head bone directly: they are rigid dots, and
    // skinning two 8-triangle spheres would buy nothing.
    const eyeGeometry = new THREE.SphereGeometry(EYE_R, 8, 6);
    shade(eyeGeometry, 37, 0.7, 1.0);
    for (let i = 0; i < 2; i++) {
      const eye = new THREE.Mesh(eyeGeometry, amberMat);
      eye.position.copy(EYE_LOCAL[i]);
      eye.name = `paper-moth-jian-eye${i}`;
      bones.head.add(eye);
    }

    // ---- mouth and nictitating membrane ---------------------------------
    const jaw = makeJaw(bones.head, { pivot: JAW_PIVOT.toArray(), range: JAW_RANGE, axis: [1, 0, 0] });
    jaw.mesh.material = paperMat;
    group.add(jaw.mesh);

    const lids = makeEyelids(bones.head, { count: 2, range: [0, MEMBRANE_CLOSED_RAD], axis: [1, 0, 0] });
    // makeEyelids lays its shell out at the world origin; carry it onto the head.
    lids.mesh.geometry.translate(HEAD_CENTER.x, HEAD_CENTER.y, HEAD_CENTER.z);
    lids.mesh.geometry.computeBoundingSphere();
    lids.mesh.material = membraneMat;
    group.add(lids.mesh);

    // ---- limbs -----------------------------------------------------------
    for (const leg of legs) {
      const mesh = bindSkin(new THREE.Mesh(leg.geometry), bones[leg.names[0]], (name, position) => {
        const i = leg.names.indexOf(name);
        if (i < 0) return 0;
        return axisWeight(position, leg.axis, leg.origin, leg.seg * (i + 1), leg.seg * 2);
      });
      mesh.material = paperMat;
      group.add(mesh);
    }

    for (const ant of antennae) {
      const mesh = bindSkin(new THREE.Mesh(ant.geometry), bones[ant.names[0]], (name, position) => {
        const i = ant.names.indexOf(name);
        if (i < 0) return 0;
        return axisWeight(position, ant.axis, ant.origin, ant.seg * (i + 1), ant.seg * 2);
      });
      mesh.material = paperMat;
      group.add(mesh);
    }

    const proboMesh = bindSkin(new THREE.Mesh(proboBuilt.geometry), bones[proboNames[0]], (name, position) => {
      const i = proboNames.indexOf(name);
      if (i < 0) return 0;
      return axisWeight(position, proboBuilt.axis, proboBuilt.origin, proboSeg * (i + 1), proboSeg * 2);
    });
    proboMesh.material = paperMat;
    group.add(proboMesh);

    // ---- wings -----------------------------------------------------------
    const wingSeg = WING_SPAN / (WING_BONES - 1);
    for (const wing of wings) {
      // Weight along the span axis, never through space: the plate reaches
      // sideways as far as half the chord, and a lateral offset must not starve
      // a vertex of weight.
      const weight = (name, position, drag) => {
        const i = wing.names.indexOf(name);
        if (i < 0) return 0;
        const s = position.dot(wing.spanAxis) - WING_BASE.dot(wing.spanAxis);
        const h = position.dot(wing.surfNormal) - WING_BASE.dot(wing.surfNormal);
        return Math.max(0, 1 - Math.abs(s + h * drag - i * wingSeg) / (wingSeg * 1.2));
      };

      const plateMesh = bindSkin(new THREE.Mesh(wing.plate), bones[wing.names[0]], (n, p) => weight(n, p, 0));
      plateMesh.material = paperMat;
      group.add(plateMesh);

      for (const geometry of wing.veins) {
        const mesh = bindSkin(new THREE.Mesh(geometry), bones[wing.names[0]], (n, p) => weight(n, p, 0));
        mesh.material = inkMat;
        group.add(mesh);
      }

      const fringeMesh = bindSkin(new THREE.Mesh(wing.fringe), bones[wing.names[0]], (n, p) => weight(n, p, FIBER_DRAG));
      fringeMesh.material = fiberMat;
      group.add(fringeMesh);
    }

    // ---- one uniform scale to bring the rig-native authoring down to metres
    group.scale.setScalar(GROUP_SCALE);

    // createBoneChain only knows the spec; makeJaw and makeEyelids add bones
    // afterwards, so the name map has to come off the finished graph.
    const boneByName = {};
    const boneNames = [];
    root.traverse((o) => {
      if (o.isBone) {
        boneByName[o.name] = o;
        boneNames.push(o.name);
      }
    });

    group.userData.materials = {
      paper: paperMat,
      ink: inkMat,
      amber: amberMat,
      membrane: membraneMat,
      fiber: fiberMat,
    };
    group.userData.boneMap = boneByName;
    group.userData.pose = 'rest';
    group.userData.mood = 0;
    group.userData.eyeGlow = 0.5;
    group.userData.wingOpen = 0;
    group.userData.nativePerM = NATIVE_PER_M;

    // ---- update ----------------------------------------------------------
    const IDENTITY = new THREE.Quaternion();
    const _flap = new THREE.Quaternion();
    const _sweep = new THREE.Quaternion();
    const _membrane = new THREE.Quaternion();
    const _wobble = new THREE.Quaternion();
    const _unfold = new THREE.Quaternion();
    const _linear = new THREE.Matrix4();

    const update = (t, updateCtx) => {
      const c = updateCtx || {};
      // Anything the director does not name — including the 'idle' the rest of
      // the cast passes — lands on the folded, perched rest stance.
      const poseKey = POSES[c.pose] ? c.pose : 'rest';
      const pose = POSES[poseKey];
      const expr = EXPRS[c.expr];
      const membraneAmount = expr ? expr.membrane : pose.membrane;
      const eyeBase = expr ? expr.eye : pose.eye;
      const moodBase = expr ? expr.mood : pose.mood;
      const time = Number.isFinite(t) ? t : 0;
      const breath = Math.sin(time * BREATH_HZ * Math.PI * 2);
      const wingHz = Number.isFinite(c.wingHz) && c.wingHz > 0 ? c.wingHz : WING_HZ;
      const phase = time * wingHz * Math.PI * 2;
      const beat = Math.sin(phase);
      const wind = clamp01((Number.isFinite(c.wind) ? c.wind : 0) + pose.wind);

      // Spine: a straight line that pitches ±6° with the wingbeat, plus a
      // breath's worth of idle so a perched moth is never perfectly still.
      root.quaternion.setFromAxisAngle(WORLD_X, pose.pitch * Math.sin(phase + 0.9) + breath * IDLE_PITCH);

      // Wings.
      const open =
        pose.open === null ? 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(phase - 0.7)) : pose.open;
      const flapAngle = pose.flap * beat + wind * 0.08 * beat;
      _flap.setFromAxisAngle(WORLD_X, flapAngle);
      for (const wing of wings) {
        for (let i = 0; i < wing.names.length; i++) {
          const bone = bones[wing.names[i]];
          if (i === 0) {
            // Slerp from the folded rest toward the inverse of the fold matrix:
            // open = 0 reproduces the authored ridge exactly, open = 1 lays the
            // plate flat and spread.
            _unfold.setFromRotationMatrix(_linear.copy(wing.fold).setPosition(0, 0, 0));
            bone.quaternion.copy(IDENTITY).slerp(_unfold.invert(), open);
            bone.quaternion.premultiply(_flap);
          } else {
            // a lagged sliver of the beat so the outer half of the plate whips
            // instead of moving as one board
            bone.quaternion.setFromAxisAngle(WORLD_X, flapAngle * WING_FLEX[i]);
            if (i >= 2) {
              _sweep.setFromAxisAngle(UP, -wind * WIND_SWEEP * ((i - 1) / 2));
              bone.quaternion.premultiply(_sweep);
            }
          }
        }
      }

      // Legs: tucked at rest, swinging forward when the pose asks for a reach.
      for (const leg of legs) {
        // the front pair reaches further than the rear pair
        const reach = pose.legReach * LEG_ROWS[leg.row].reach;
        const idle = breath * LEG_IDLE * Math.sin(time * 1.3 + leg.phase);
        for (let i = 0; i < leg.names.length; i++) {
          bones[leg.names[i]].quaternion.setFromAxisAngle(
            WORLD_X,
            -reach * LEG_REACH + idle * (1 - i * 0.2),
          );
        }
      }

      // Antennae: forward at rest, swept back and flat against the torso in the
      // rain, with a breath-paced wander so they never look pinned.
      for (const ant of antennae) {
        const sweepQ = aim(ant.dir, ant.back);
        for (let i = 0; i < ant.names.length; i++) {
          const bone = bones[ant.names[i]];
          bone.quaternion.copy(IDENTITY).slerp(sweepQ, clamp01(pose.antenna + wind * 0.3));
          // gated by the breath so frame 0 is the authored pose rather than a
          // phase-shifted offset of it
          _wobble.setFromAxisAngle(
            UP,
            ANTENNA_WOBBLE * breath * Math.sin(time * ANTENNA_WOBBLE_HZ * Math.PI * 2 + ant.phase + i * 0.8),
          );
          bone.quaternion.multiply(_wobble);
        }
      }

      // Proboscis: coiled under the head at rest, straight and forward when
      // feeding. The coil is a set of authored rotations, so extending is a
      // slerp back to identity rather than a length change.
      for (let i = 0; i < proboNames.length; i++) {
        bones[proboNames[i]].quaternion.copy(IDENTITY).slerp(proboCurl[i], 1 - pose.proboscis);
      }

      // Membrane: the assembly's own blink schedule, then a pose- or
      // expression-driven hold on top of it so sleep and rain read as covered
      // rather than blinking.
      lids.update(time);
      const membraneAngle = membraneAmount * MEMBRANE_CLOSED_RAD;
      if (membraneAngle > 0) {
        _membrane.setFromAxisAngle(WORLD_X, membraneAngle);
        for (const lid of lids.bones) lid.quaternion.slerp(_membrane, MEMBRANE_BLEND);
      }

      // Mouth: the assembly's talk cadence, scaled per pose so a sleeping moth
      // does not keep chatting.
      jaw.update(time);
      const jawAngle = 2 * Math.acos(Math.min(1, Math.max(-1, jaw.bone.quaternion.w)));
      jaw.bone.quaternion.setFromAxisAngle(WORLD_X, jawAngle * pose.talk);

      // Vein ink is the mood readout: dark when asleep, lit by rain, brightest
      // on the way home.
      const mood = Number.isFinite(c.mood)
        ? clamp01(c.mood)
        : moodBase === null
          ? 0.5 + 0.5 * Math.abs(beat)
          : clamp01(moodBase + 0.05 * breath);
      inkMat.color.copy(inkColor).lerp(amberColor, mood);
      const eyeGlow = clamp01(eyeBase + 0.1 * breath);
      amberMat.color.copy(amberColor).multiplyScalar(0.35 + 0.65 * eyeGlow);

      group.userData.pose = poseKey;
      group.userData.mood = mood;
      group.userData.eyeGlow = eyeGlow;
      group.userData.wingOpen = open;
    };
    update(0, {});

    return { group, bones: boneNames, update };
  },
};
