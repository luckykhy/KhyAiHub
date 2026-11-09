// models/tortoise-dai.js — 岱龟: the ferry of the ink sea, carrying a folded paper
// mountain and two paper houses on its back.
//
// Three constraints, same as rig.js — read before changing anything:
//   1) Determinism. The capture chain renders per scene at t = i/24 and compares
//      frame bytes between two renders of the same instant, so update(t) only
//      writes local bone transforms: no wall clock, no cross-frame state.
//      Randomness exists only at build time and only through src/util/rand.js.
//   2) One rest world space. Geometry and bones are authored in world
//      coordinates; bindSkin captures bindMatrix and boneInverses from the world
//      matrices at bind time, so moving a bone's rest position afterwards makes
//      the part deform instead of moving. Reposition before bindSkin.
//   3) Bones must stay in the rendered graph. Skeleton.update() reads
//      bone.matrixWorld, and a bone outside the graph never refreshes it — the
//      mesh then silently freezes at rest. bindSkin adopts the parentless root
//      (tail) itself; the caller only has to add the returned group to a scene.
//
// Orientation: head toward +Z, tail toward -Z, back toward +Y, belly toward -Y.
// The director rotates the group to cross the sea along +X.
//
// The import whitelist is three / ../util/rand.js / ./rig.js, so render/cel.js
// is out of reach and this file carries its own two-band cel material (see
// makeCelMaterial). Its G-buffer packing contract must stay byte-identical to
// cel.js — diverge and the ink lines and watercolor strokes go to noise.

import * as THREE from 'three';
import { hashString, mulberry32 } from '../util/rand.js';
import { bindSkin, createBoneChain, loft, makeEyelids, makeJaw, sculpt } from './rig.js';

const TAU = Math.PI * 2;
const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Returns a new Color: the same palette feeds several parts, none of them may
// mutate the shared value.
const mixColor = (a, b, t) => a.clone().lerp(b, t);

// ---------------------------------------------------------------------------
// Carapace: the five ridge lines are Catmull-Rom curves (three's
// CatmullRomCurve3), and the cross-section is straight between them — folded
// facets, not a smooth dome. Control points are [z, half width, ridge height]
// per station; reshaping the shell means editing this table only.
// ---------------------------------------------------------------------------

// Shell heart 2.8m, rim down to 1.1m: the ridge table peaks at 2.80 around
// z=0.55, the rim peaks at 1.11 mid-body.
const SHELL_STATIONS = [-2.95, -2.25, -1.55, -0.85, -0.15, 0.55, 1.25, 1.95, 2.5];
const SHELL_HALF_W = [0.62, 0.92, 1.2, 1.44, 1.56, 1.6, 1.58, 1.46, 1.28];
const RIM_H = [0.7, 0.9, 1.03, 1.09, 1.11, 1.11, 1.1, 1.05, 1.0];
const RIDGE_H = [
  [1.44, 1.72, 1.98, 2.16, 2.26, 2.28, 2.24, 2.12, 1.96],
  [1.62, 1.94, 2.24, 2.45, 2.57, 2.6, 2.57, 2.46, 2.3],
  // The central ridge is the spine: it sinks slowly from neck root (2.52) to
  // tail root (1.72).
  [1.72, 2.06, 2.38, 2.62, 2.76, 2.8, 2.78, 2.68, 2.52],
];
const RIDGE_U = [-0.78, -0.39, 0, 0.39, 0.78];
// Section control lines: rim, ridge1, ridge2, central ridge, ridge2, ridge1, rim
// — seven lines, straight segments between neighbours.
const SECTION_LINES = [RIM_H, RIDGE_H[0], RIDGE_H[1], RIDGE_H[2], RIDGE_H[1], RIDGE_H[0], RIM_H];
const SECTION_U = [-1, ...RIDGE_U, 1];

const SHELL_UNDERSIDE = 0.58; // flat plate inside the hull; the plastron hangs under it
const BELLY_BOTTOM = 0.34; // plastron floor, 4cm above the waterline
const WATER_Y = 0.3; // ink sea surface: drops land here and ripple

// The front of the shell narrows into a neck funnel: past FUNNEL_Z the whole
// section converges on the neck root, so a retracted head hides inside it with
// only the eye slit left at the lip.
const FUNNEL_Z = 2.05;
const FUNNEL_LEN = 0.45;
const FUNNEL_SCALE = 0.26;
const NECK_BASE_Y = 2.42;

const BODY_RINGS = 35;
const TOP_SUB = 3; // facets between two neighbouring ridges

function stationCurve(values) {
  const pts = SHELL_STATIONS.map((z, i) => new THREE.Vector3(z, values[i], 0));
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
}

const HALF_W_CURVE = stationCurve(SHELL_HALF_W);
const LINE_CURVES = SECTION_LINES.map(stationCurve);

// The curve is parameterised over control points, not over z, so every lookup
// goes through this one normalised mapping — the loft, the prop placement and
// the seam glow then agree on where the surface is.
function stationT(z) {
  return clamp((z - SHELL_STATIONS[0]) / (SHELL_STATIONS[SHELL_STATIONS.length - 1] - SHELL_STATIONS[0]), 0, 1);
}

function shellHalfWidth(z) {
  return HALF_W_CURVE.getPoint(stationT(z)).y;
}

function lineHeight(i, z) {
  return LINE_CURVES[i].getPoint(stationT(z)).y;
}

// Height of the folded surface at (x, z): normalise x by the local half width,
// then interpolate linearly between the seven control lines. Lofting, prop
// placement and the seam glow all read the surface through this one function.
function shellSurface(x, z) {
  const w = shellHalfWidth(z);
  const u = clamp(x / w, -1, 1);
  let i = 0;
  while (i < SECTION_U.length - 2 && u > SECTION_U[i + 1]) i++;
  const t = (u - SECTION_U[i]) / (SECTION_U[i + 1] - SECTION_U[i]);
  return lineHeight(i, z) + (lineHeight(i + 1, z) - lineHeight(i, z)) * t;
}

function surfaceNormal(x, z) {
  const e = 0.05;
  const hx = shellSurface(x + e, z) - shellSurface(x - e, z);
  const hz = shellSurface(x, z + e) - shellSurface(x, z - e);
  return new THREE.Vector3(-hx, 2 * e, -hz).normalize();
}

// One section ring: rim, over the five ridges, down to the rim again, then the
// skirt folds inward to the flat underside plate. Ring winding is not a
// contract — loft flips everything together when the signed volume is negative,
// so normals always end up outward.
function shellRing(z) {
  const w = shellHalfWidth(z);
  const rimY = lineHeight(0, z);
  const ring = [];
  for (let i = 0; i < SECTION_U.length - 1; i++) {
    const u0 = SECTION_U[i];
    const u1 = SECTION_U[i + 1];
    const y0 = lineHeight(i, z);
    const y1 = lineHeight(i + 1, z);
    for (let k = 0; k < TOP_SUB; k++) {
      const t = k / TOP_SUB;
      ring.push([(u0 + (u1 - u0) * t) * w, y0 + (y1 - y0) * t]);
    }
  }
  ring.push([w, rimY]);
  // Right skirt: three steps from the rim down to the underside plate, leaving
  // an outward thickness so the shell edge reads as a wall and not a sheet.
  ring.push([w * 0.99, rimY - 0.1], [w * 0.96, SHELL_UNDERSIDE + 0.12], [w * 0.93, SHELL_UNDERSIDE]);
  ring.push([w * 0.465, SHELL_UNDERSIDE], [0, SHELL_UNDERSIDE], [-w * 0.465, SHELL_UNDERSIDE]);
  ring.push([-w * 0.93, SHELL_UNDERSIDE], [-w * 0.96, SHELL_UNDERSIDE + 0.12], [-w * 0.99, rimY - 0.1]);
  return ring;
}

// The funnel converges on a fixed neck-root height. Converging on a height that
// itself travels with t drags the mid sections down to the waterline and pokes
// the neck-root bone out through the funnel wall.
function funnelRing(ring, z) {
  if (z <= FUNNEL_Z) return ring;
  const t = clamp((z - FUNNEL_Z) / FUNNEL_LEN, 0, 1);
  const s = 1 + (FUNNEL_SCALE - 1) * t;
  return ring.map(([x, y]) => [x * s, NECK_BASE_Y + (y - NECK_BASE_Y) * s]);
}

function bodySections() {
  const z0 = SHELL_STATIONS[0];
  const z1 = SHELL_STATIONS[SHELL_STATIONS.length - 1];
  const sections = [];
  for (let i = 0; i < BODY_RINGS; i++) {
    const z = z0 + (i / (BODY_RINGS - 1)) * (z1 - z0);
    sections.push({ z, pts: funnelRing(shellRing(z), z) });
  }
  return sections;
}

// Plastron: flat, cross-section a near half ellipse of rx 1.6m — an arched back
// plus one flat floor, closed into a tube.
function bellySections() {
  const sections = [];
  const N = 14;
  for (let i = 0; i < 21; i++) {
    const z = -2.6 + (i / 20) * 4.9;
    const pw = Math.min(1.6, shellHalfWidth(z));
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const a = Math.PI * (k / N);
      pts.push([-Math.cos(a) * pw, BELLY_BOTTOM + 0.22 * Math.sin(a)]);
    }
    for (let k = 1; k < 4; k++) pts.push([pw - (2 * pw * k) / 4, BELLY_BOTTOM]);
    sections.push({ z, pts });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Geometry helpers: lofting along an arbitrary axis, columns, merging.
// rig.js does not export placedLoft / taperedRings, and every leg segment and
// every origami fan blade needs its own axis here.
// ---------------------------------------------------------------------------

// Right-handed basis: x cross y = z. A left-handed one mirrors the winding and
// the cel shader shades the whole part black.
function orientedLoft(sections, origin, zAxis, xAxis) {
  const z = zAxis.clone().normalize();
  const x = xAxis.clone().addScaledVector(z, -xAxis.dot(z));
  if (x.lengthSq() < 1e-10) x.copy(WORLD_X);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const geometry = loft(sections, { closed: true, cap: true });
  geometry.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin));
  return geometry;
}

// Elliptical column from `from` to `to`; squash turns the circle into an
// ellipse (the legs are 0.5m thick posts).
function columnLoft(from, to, r0, r1, squash = 0.86, rings = 5, points = 10) {
  const axis = new THREE.Vector3().subVectors(to, from);
  const len = axis.length();
  axis.normalize();
  const xAxis = Math.abs(axis.y) > 0.9 ? WORLD_X : new THREE.Vector3().crossVectors(WORLD_Y, axis);
  const sections = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const r = r0 + (r1 - r0) * t;
    const pts = [];
    for (let k = 0; k < points; k++) {
      const a = (k / points) * TAU;
      pts.push([Math.cos(a) * r, Math.sin(a) * r * squash]);
    }
    sections.push({ z: t * len, pts });
  }
  return orientedLoft(sections, from, axis, xAxis);
}

// Merges position/normal/uv/index only — that is all loft() produces, and
// anything more would be dead weight carried into the skinning pass.
function mergeGeometries(list) {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of list) {
    vTotal += g.getAttribute('position').count;
    iTotal += g.getIndex().count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const index = new Uint32Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    nrm.set(n.array.subarray(0, n.count * 3), vo * 3);
    uv.set(u.array.subarray(0, u.count * 2), vo * 2);
    const gi = g.getIndex();
    for (let i = 0; i < gi.count; i++) index[io + i] = gi.array[i] + vo;
    vo += p.count;
    io += gi.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

// ---------------------------------------------------------------------------
// Material: two-band cel plus the MRT second output.
//
// The pipeline only accepts glslVersion === GLSL3 (its warnIfNotMrtCapable),
// and this file cannot import render/cel.js, so it carries its own copy. Three
// traps worth knowing:
//   1) Skinning. three declares skinIndex / skinWeight under USE_SKINNING and
//      the renderer uploads bindMatrix / bindMatrixInverse / boneTexture; the
//      shader must include the skinning chunks or every vertex stays at rest
//      and the whole tortoise stops moving. Those three uniforms come from the
//      chunks — do not declare them twice.
//   2) The G-buffer packing contract is cel.js's, verbatim.
//   3) uFade multiplies the colour, not alpha: blending under MRT would blend
//      the packed depth and id along with it and the ink lines would go to
//      noise. The ripple therefore fades toward ink black instead of turning
//      transparent — the ink sea is the darkest value in the film anyway.
// ---------------------------------------------------------------------------

const CEL_VERT = /* glsl */ `
#include <skinning_pars_vertex>

varying vec3 vViewNormal;
varying vec3 vViewPos;
varying float vFlowZ;

void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 view = modelViewMatrix * vec4(transformed, 1.0);
  vViewNormal = normalize(normalMatrix * objectNormal);
  vViewPos = view.xyz;
  vFlowZ = transformed.z;
  gl_Position = projectionMatrix * view;
}
`;

const CEL_FRAG = /* glsl */ `
precision highp float;

varying vec3 vViewNormal;
varying vec3 vViewPos;
varying float vFlowZ;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gGbuffer;

uniform vec3 uBase;
uniform vec3 uShadow;
uniform vec3 uRim;
uniform vec3 uEmissive;
uniform vec3 uLightDir;
uniform vec3 uFlowColor;
uniform float uBandSoftness;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uMaterialId;
uniform float uFade;
uniform float uFlowGain;
uniform float uFlowTime;

const float GBUF_DEPTH_QUANTUM = 64.0;
const float GBUF_ID_SCALE = 256.0;
const float GBUF_DEPTH_MAX = 1024.0;

float packGbuffer(float viewDepth, float materialId) {
  float q = floor(clamp(viewDepth, 0.0, GBUF_DEPTH_MAX) * GBUF_DEPTH_QUANTUM);
  return q * GBUF_ID_SCALE + clamp(materialId, 0.0, GBUF_ID_SCALE - 1.0);
}

void main() {
  vec3 N = normalize(vViewNormal);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);

  float lambert = dot(N, L);
  float band = smoothstep(-uBandSoftness, uBandSoftness, lambert);
  vec3 color = mix(uShadow, uBase, band) + uEmissive;

  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower) * uRimStrength;
  rim *= smoothstep(-0.25, 0.35, lambert);
  color += uRim * rim;

  // Seam glow: one bright packet travelling along the rest z, one flash per
  // step (uFlowTime is advanced by update).
  if (uFlowGain > 0.0) {
    float ph = fract(vFlowZ * 0.35 - uFlowTime * 0.9);
    float pulse = smoothstep(0.0, 0.14, ph) * smoothstep(0.46, 0.14, ph);
    color += uFlowColor * pulse * uFlowGain;
  }

  gColor = vec4(color * uFade, 1.0);
  gGbuffer = vec4(N, packGbuffer(-vViewPos.z, uMaterialId));
}
`;

const LIGHT_DIR = new THREE.Vector3(-0.35, 0.75, 0.55).normalize();

function makeCelMaterial(opts) {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uBase: { value: opts.base },
      uShadow: { value: opts.shadow },
      uRim: { value: opts.rim },
      uEmissive: { value: opts.emissive || new THREE.Color(0, 0, 0) },
      uLightDir: { value: LIGHT_DIR },
      uFlowColor: { value: opts.flowColor || new THREE.Color(0, 0, 0) },
      uBandSoftness: { value: 0.04 },
      uRimPower: { value: 2.5 },
      uRimStrength: { value: opts.rimStrength === undefined ? 0.55 : opts.rimStrength },
      uMaterialId: { value: opts.materialId },
      uFade: { value: 1 },
      uFlowGain: { value: opts.flowGain || 0 },
      uFlowTime: { value: 0 },
    },
    vertexShader: CEL_VERT,
    fragmentShader: CEL_FRAG,
  });
  material.name = opts.name || 'cel';
  return material;
}

// ---------------------------------------------------------------------------
// The paper mountain: origami trees and the two paper houses
// ---------------------------------------------------------------------------

// One fan blade: a flat tapered slab, thick in the middle and thin at the rim.
// Five of them fan out around the trunk.
function fanBlade(len, baseW, tipW, thick) {
  const sections = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const w = baseW + (tipW - baseW) * t;
    const h = thick * (1 - 0.55 * t);
    sections.push({
      z: t * len,
      pts: [[-w * 0.5, -h * 0.5], [w * 0.5, -h * 0.5], [w * 0.5, h * 0.5], [-w * 0.5, h * 0.5]],
    });
  }
  return loft(sections, { closed: true, cap: true });
}

function placeGeometry(geometry, origin, zAxis, xAxis) {
  const z = zAxis.clone().normalize();
  const x = xAxis.clone().addScaledVector(z, -xAxis.dot(z));
  if (x.lengthSq() < 1e-10) x.copy(WORLD_X);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return geometry.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin));
}

function surfaceFrame(x, z) {
  const n = surfaceNormal(x, z);
  const fwd = WORLD_Z.clone().addScaledVector(n, -WORLD_Z.dot(n));
  if (fwd.lengthSq() < 1e-10) fwd.copy(WORLD_Z);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(n, fwd).normalize();
  return { n, fwd, right };
}

// A miniature paper tree: a vertical trunk plus a five-blade origami crown. The
// crown is its own group so update(t) can swing only the crown — the gait
// inertia moves the whole mountain in unison while the trunks stay planted.
function buildPaperTree(rand, x, z, scale, matTrunk, matLeaf) {
  const base = shellSurface(x, z);
  const { n, fwd, right } = surfaceFrame(x, z);
  const tree = new THREE.Group();
  tree.name = 'dai-tree';
  tree.position.set(x, base + 0.015, z);
  tree.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, n, fwd));

  const trunkH = 0.1 * scale;
  const trunk = columnLoft(
    new THREE.Vector3(0, -0.03, 0),
    new THREE.Vector3(0, trunkH, 0),
    0.02 * scale,
    0.013 * scale,
    1,
    4,
    8,
  );
  const trunkMesh = new THREE.Mesh(trunk, matTrunk);
  trunkMesh.name = 'dai-tree-trunk';
  tree.add(trunkMesh);

  const crown = new THREE.Group();
  crown.name = 'dai-tree-crown';
  crown.position.set(0, trunkH, 0);
  const blades = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + rand() * 0.6;
    const dir = new THREE.Vector3(Math.cos(a), 0.34 + rand() * 0.12, Math.sin(a)).normalize();
    const xAxis = new THREE.Vector3().crossVectors(WORLD_Y, dir);
    if (xAxis.lengthSq() < 1e-10) xAxis.copy(WORLD_X);
    const blade = placeGeometry(
      fanBlade(0.15 * scale, 0.075 * scale, 0.022 * scale, 0.009),
      new THREE.Vector3(0, 0, 0),
      dir,
      xAxis,
    );
    blades.push(blade);
  }
  const crownMesh = new THREE.Mesh(mergeGeometries(blades), matLeaf);
  crownMesh.name = 'dai-tree-crown-mesh';
  crown.add(crownMesh);
  tree.add(crown);
  return { tree, crown };
}

function boxLoft(w, h, d) {
  const pts = [
    [-w * 0.5, -h * 0.5],
    [w * 0.5, -h * 0.5],
    [w * 0.5, h * 0.5],
    [-w * 0.5, h * 0.5],
  ];
  return loft([
    { z: 0, pts: pts.map((p) => [p[0], p[1]]) },
    { z: d, pts: pts.map((p) => [p[0], p[1]]) },
  ], { closed: true, cap: true });
}

// One paper house: box body, two folded roof slabs, a door and its mail slot.
// The windows are small amber squares on their own material so they reach bloom
// — there is a lamp burning inside.
function buildPaperHouse(x, z, yaw, scale, matWall, matSlot, matWindow) {
  const base = shellSurface(x, z);
  const { n, fwd, right } = surfaceFrame(x, z);
  const house = new THREE.Group();
  house.name = 'dai-house';
  house.position.set(x, base + 0.01, z);
  house.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, n, fwd));
  house.rotateY(yaw);

  const parts = [];
  parts.push(boxLoft(0.42 * scale, 0.3 * scale, 0.36 * scale).translate(0, 0.15 * scale, 0));
  // The two roof slabs fold about X, ridge running along the house width
  const roofA = boxLoft(0.46 * scale, 0.025 * scale, 0.23 * scale);
  roofA.rotateX(0.45).translate(0, 0.33 * scale, 0.1 * scale);
  parts.push(roofA);
  const roofB = boxLoft(0.46 * scale, 0.025 * scale, 0.23 * scale);
  roofB.rotateX(-0.45).translate(0, 0.33 * scale, -0.1 * scale);
  parts.push(roofB);
  const door = boxLoft(0.012, 0.2 * scale, 0.13 * scale);
  door.translate(0, 0.1 * scale, 0.183 * scale);
  parts.push(door);
  const body = new THREE.Mesh(mergeGeometries(parts), matWall);
  body.name = 'dai-house-body';
  house.add(body);

  const slot = new THREE.Mesh(boxLoft(0.014, 0.032 * scale, 0.05 * scale), matSlot);
  slot.name = 'dai-house-slot';
  slot.position.set(0, 0.145 * scale, 0.19 * scale);
  house.add(slot);

  for (const sx of [-1, 1]) {
    const win = new THREE.Mesh(boxLoft(0.01, 0.1 * scale, 0.09 * scale), matWindow);
    win.name = `dai-house-window${sx < 0 ? 'l' : 'r'}`;
    win.position.set(sx * 0.214 * scale, 0.17 * scale, 0.02 * scale);
    house.add(win);
  }
  return house;
}

// Seam glow: a thin wall sitting on the fold between two ridges. The whole
// tortoise is a SkinnedMesh, so the glow is skinned too — an unskinned wall
// would float or sink the moment the shell breathes.
function buildFlowStrips() {
  const creases = [-0.89, -0.585, -0.195, 0.195, 0.585, 0.89];
  const parts = [];
  for (const u of creases) {
    const sections = [];
    for (let i = 0; i <= 26; i++) {
      const z = -2.8 + (i / 26) * 5.0;
      const x = u * shellHalfWidth(z);
      const y = shellSurface(x, z);
      sections.push({
        z,
        pts: [
          [x - 0.017, y - 0.002],
          [x + 0.017, y - 0.002],
          [x + 0.017, y + 0.016],
          [x - 0.017, y + 0.016],
        ],
      });
    }
    parts.push(loft(sections, { closed: true, cap: true }));
  }
  return mergeGeometries(parts);
}

// ---------------------------------------------------------------------------
// Skeleton and gait
// ---------------------------------------------------------------------------

// The spine rides the central ridge, sinking slowly from neck root to tail root;
// four neck segments in an S, one head. pos is world space and a parent must
// appear before its children (createBoneChain's contract).
const SPINE_SPEC = [
  { name: 'tail', pos: [0, 1.83, -2.72] },
  { name: 'spine1', pos: [0, 2.22, -1.9], parent: 'tail' },
  { name: 'spine2', pos: [0, 2.53, -1.1], parent: 'spine1' },
  { name: 'spine3', pos: [0, 2.73, -0.3], parent: 'spine2' },
  { name: 'spine4', pos: [0, 2.8, 0.5], parent: 'spine3' },
  { name: 'spine5', pos: [0, 2.78, 1.3], parent: 'spine4' },
  { name: 'spine6', pos: [0, 2.64, 2.1], parent: 'spine5' },
  { name: 'neck-root', pos: [0, 2.3, 2.28], parent: 'spine6' },
  { name: 'neck-1', pos: [0, 2.42, 2.7], parent: 'neck-root' },
  { name: 'neck-2', pos: [0, 2.26, 3.12], parent: 'neck-1' },
  { name: 'neck-3', pos: [0, 2.1, 3.45], parent: 'neck-2' },
  { name: 'head', pos: [0, 2.18, 3.82], parent: 'neck-3' },
];

// Four columnar legs: 0.5m thick, elliptical section, flat webbed feet. Hip,
// knee, ankle; the A-pose lives in the positions themselves — bones carry
// positions only, so the splay is a property of where the joints sit.
const LEG_DEFS = [
  { key: 'fl', hip: [-1.02, 1.06, 1.55], knee: [-1.5, 0.66, 1.44], ankle: [-1.7, 0.32, 1.26], dir: 1, phase: 0, parent: 'spine5' },
  { key: 'fr', hip: [1.02, 1.06, 1.55], knee: [1.5, 0.66, 1.44], ankle: [1.7, 0.32, 1.26], dir: 1, phase: 0.5, parent: 'spine5' },
  { key: 'rl', hip: [-1.06, 1.06, -1.55], knee: [-1.54, 0.66, -1.64], ankle: [-1.74, 0.32, -1.74], dir: -1, phase: 0.5, parent: 'spine2' },
  { key: 'rr', hip: [1.06, 1.06, -1.55], knee: [1.54, 0.66, -1.64], ankle: [1.74, 0.32, -1.74], dir: -1, phase: 0, parent: 'spine2' },
];

const GAIT_SEC = 3.2; // one full gait cycle in the crossing scene (scenes.json)
const STANCE_END = 0.55; // how much of the cycle is stance
const HIP_SWING = 0.4;
const KNEE_LIFT = 0.85;

// Retraction fold angles (rad): an alternating Z fold. The positive folds pull
// the neck back, the negative ones push it back into place, so the neck can
// shrink below the shell rim without dropping — an all-positive fold drags the
// head down to the waterline instead.
const NECK_CHAIN = ['neck-root', 'neck-1', 'neck-2', 'neck-3'];
const NECK_FOLD = [0.39, 2.36, -3.14, 3.92];
const HEAD_TUCK = 1.0; // how far the snout dips, tucking the beak under the lip

// One leg's phase. A positive hip angle swings the leg backward (a positive
// rotation about +X carries a downward segment toward -Z), so ph=0 is the foot
// forward and ph=STANCE_END is it back; the swing phase flexes the knee to lift
// the foot clear of the water.
function legPhase(ph) {
  let hip;
  let lift;
  if (ph < STANCE_END) {
    hip = -HIP_SWING * Math.cos(Math.PI * (ph / STANCE_END));
    lift = 0;
  } else {
    const u = (ph - STANCE_END) / (1 - STANCE_END);
    hip = HIP_SWING * Math.cos(Math.PI * u);
    lift = Math.sin(Math.PI * u);
  }
  return { hip, knee: KNEE_LIFT * lift };
}

function applyLegPose(leg, ph) {
  const { hip, knee } = legPhase(ph);
  leg.bones.hip.rotation.x = hip;
  leg.bones.knee.rotation.x = knee;
  // The ankle counter-rotates to level the webbed foot: three segments on one
  // axis summing to zero leave the paddle at its rest, horizontal attitude.
  leg.bones.ankle.rotation.x = -(hip + knee) * 0.9;
}

// An ink drop detaches from where the foot was at the start of the swing and
// then only falls, so the anchor is read once at build time — no need to
// reconstruct the live pose at runtime.
function legDropAnchor(leg, root) {
  applyLegPose(leg, STANCE_END);
  root.updateMatrixWorld(true);
  const anchor = leg.bones.ankle.getWorldPosition(new THREE.Vector3());
  applyLegPose(leg, 0.25);
  root.updateMatrixWorld(true);
  return anchor;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

// Pose / expression keys. update(t, ctx)'s second argument is an optional hint
// surface; with nothing supplied everything is derived from t alone:
//   ctx.pose        'walk' (default) | 'idle' | 'rest' — crossing / waiting / berthed
//   ctx.expression  'calm' (default) | 'alert' | 'asleep' | 'startled'
//   ctx.gaitSec     gait period in seconds, default 3.2 (the rain scene passes 6)
//   ctx.wind        radians of shared lean for the paper trees, positive = +Z
//   ctx.chew        false disables the paper-leaf chewing cadence
const POSE_KEYS = ['walk', 'idle', 'rest'];
const EXPR_KEYS = ['calm', 'alert', 'asleep', 'startled'];

const BREATH_HZ = 0.22; // idle breathing: neck root and shell front rise and fall
const LID_HALF = 0.55; // half closed: one amber slit
const LID_WIDE = 1.15; // wide open (startled)
const LID_ALERT = 1.05;
const BLINK_PERIOD = 4.2;
const BLINK_SEC = 0.16;
const STARTLE_PERIOD = 13.5;
const STARTLE_AT = 11;
const STARTLE_SEC = 0.6;
const CHEW_PERIOD = 9.5; // aligns with the t=19 chewing beat of the crossing scene
const CHEW_SEC = 1.6;
const JAW_OPEN = 0.524; // 30 degrees
const DROP_FALL_SEC = 0.5; // the 2.8m fall is compressed to half a second to stay readable
const DROP_SPACING = 0.08;
const RIPPLE_SEC = 1.2;
const SWAY_AMP = 0.1;
// The seam glow's peak has to clear bloom's 0.72 threshold: amber is only about
// 0.6 in linear light, so a gain below ~1.3 reads as a bright texture rather
// than light leaking from inside the shell.
const FLOW_GAIN = 1.4;

const PALETTE_FALLBACK = {
  ink: '#14110E',
  paper: '#F6F2EC',
  accent: '#9C4116',
  accentDark: '#F0A868',
  brandGraphic: '#E2703A',
  gradient: ['#FFC078', '#E2703A'],
};

export const model = {
  id: 'tortoise-dai',
  build(ctx) {
    const pal = Object.assign({}, PALETTE_FALLBACK, (ctx && ctx.palette) || {});
    const color = (hex) => new THREE.Color().setStyle(hex);
    const cInk = color(pal.ink);
    const cPaper = color(pal.paper);
    const cAccent = color(pal.accent);
    const cAccentDark = color(pal.accentDark);
    const cWarm = color((pal.gradient && pal.gradient[0]) || pal.accentDark);

    // Shell colours are derived from the palette instead of a second list of
    // hex literals: reskinning the film means touching the tokens only.
    const shellBase = mixColor(cInk, cAccent, 0.45);
    const shellShadow = mixColor(cInk, cAccent, 0.12);
    const legBase = mixColor(cInk, cAccent, 0.38);
    const legShadow = mixColor(cInk, cAccent, 0.1);
    const headBase = mixColor(cInk, cAccent, 0.42);
    const jawBase = mixColor(cInk, cAccent, 0.2);
    const bellyBase = mixColor(cInk, cAccent, 0.62);
    const paperShadow = mixColor(cPaper, cInk, 0.38);

    const mats = {
      shell: makeCelMaterial({ base: shellBase, shadow: shellShadow, rim: cAccentDark, materialId: 11, name: 'dai-shell' }),
      belly: makeCelMaterial({ base: bellyBase, shadow: mixColor(cInk, cAccent, 0.3), rim: cAccentDark, materialId: 12, name: 'dai-belly' }),
      leg: makeCelMaterial({ base: legBase, shadow: legShadow, rim: cAccentDark, materialId: 13, name: 'dai-leg' }),
      neck: makeCelMaterial({ base: headBase, shadow: mixColor(cInk, cAccent, 0.14), rim: cAccentDark, materialId: 14, name: 'dai-neck' }),
      head: makeCelMaterial({ base: headBase, shadow: mixColor(cInk, cAccent, 0.14), rim: cAccentDark, materialId: 15, name: 'dai-head' }),
      jaw: makeCelMaterial({ base: jawBase, shadow: mixColor(cInk, cAccent, 0.06), rim: cAccentDark, materialId: 16, name: 'dai-jaw' }),
      lid: makeCelMaterial({ base: mixColor(cInk, cPaper, 0.2), shadow: mixColor(cInk, cPaper, 0.05), rim: cAccentDark, materialId: 17, name: 'dai-lid' }),
      paper: makeCelMaterial({ base: cPaper, shadow: paperShadow, rim: cAccentDark, materialId: 18, name: 'dai-paper' }),
      slot: makeCelMaterial({ base: cInk, shadow: cInk, rim: cInk, materialId: 20, name: 'dai-slot' }),
      // The three amber parts (windows, eyes, seam glow) all have to clear
      // bloom's 0.72 threshold, but stay amber: emissive helps, it is not a lamp.
      amber: makeCelMaterial({
        base: cWarm,
        shadow: cWarm,
        rim: cWarm,
        emissive: cWarm.clone().multiplyScalar(0.5),
        materialId: 21,
        name: 'dai-amber',
      }),
      flow: makeCelMaterial({
        base: mixColor(cWarm, cInk, 0.55),
        shadow: mixColor(cWarm, cInk, 0.75),
        rim: cWarm,
        flowColor: cWarm,
        flowGain: FLOW_GAIN,
        materialId: 22,
        name: 'dai-flow',
      }),
      drop: makeCelMaterial({ base: mixColor(cInk, cAccent, 0.18), shadow: cInk, rim: cWarm, rimStrength: 1.1, materialId: 23, name: 'dai-drop' }),
      ripple: makeCelMaterial({ base: cWarm, shadow: cWarm, rim: cWarm, emissive: cWarm.clone().multiplyScalar(0.25), materialId: 24, name: 'dai-ripple' }),
    };

    const group = new THREE.Group();
    group.name = 'tortoise-dai';

    // ---- skeleton ----
    const spec = SPINE_SPEC.map((b) => ({ ...b }));
    for (const leg of LEG_DEFS) {
      spec.push({ name: `leg-${leg.key}-hip`, pos: leg.hip, parent: leg.parent });
      spec.push({ name: `leg-${leg.key}-knee`, pos: leg.knee, parent: `leg-${leg.key}-hip` });
      spec.push({ name: `leg-${leg.key}-ankle`, pos: leg.ankle, parent: `leg-${leg.key}-knee` });
    }
    const { root, bones } = createBoneChain(spec);
    root.updateMatrixWorld(true);

    const boneWorld = {};
    for (const [name, bone] of Object.entries(bones)) {
      boneWorld[name] = bone.getWorldPosition(new THREE.Vector3());
    }
    const SHELL_BONES = ['tail', 'spine1', 'spine2', 'spine3', 'spine4', 'spine5', 'spine6', 'neck-root'];
    const NECK_BONES = ['neck-root', 'neck-1', 'neck-2', 'neck-3'];

    // bindSkin keeps each vertex's four strongest influences but normalises by
    // the weight sum from *before* the truncation, so a fifth influence is
    // silently swallowed and the vertex is dragged toward the origin. A plain
    // distance falloff hands a dozen bones a say at once, so the shell and the
    // neck both take the two nearest bones along z instead: the shell is rigid
    // (riding the local ridge is enough) and the neck is a tube bending along
    // the bone column (interpolating two bones *is* the bend). Sparsity here is
    // a correctness requirement, not an optimisation.
    function bracketingWeight(names, radius) {
      const zs = names.map((n) => boneWorld[n].z);
      let memoZ = NaN;
      let memo = new Map();
      return (name, p) => {
        if (p.z !== memoZ) {
          memoZ = p.z;
          const hits = [];
          for (let i = 0; i < names.length; i++) {
            const w = Math.max(0, 1 - Math.abs(p.z - zs[i]) / radius);
            if (w > 0) hits.push([names[i], w]);
          }
          hits.sort((a, b) => b[1] - a[1]);
          memo = new Map(hits.slice(0, 2));
          // A vertex past the last bone can sit further than radius from every
          // bone; all-zero weights would make bindSkin throw.
          if (memo.size === 0) {
            let best = 0;
            for (let i = 1; i < names.length; i++) {
              if (Math.abs(p.z - zs[i]) < Math.abs(p.z - zs[best])) best = i;
            }
            memo.set(names[best], 1);
          }
        }
        return memo.get(name) || 0;
      };
    }

    // The shell is rigid: only the spine column speaks. Neck, head and leg bones
    // take no part, or retracting the head would drag the whole carapace along.
    const shellWeight = bracketingWeight(SHELL_BONES, 0.6);
    const neckWeight = bracketingWeight(NECK_BONES, 0.6);

    // ---- carapace ----
    const bodyGeo = loft(bodySections(), { closed: true, cap: true });
    sculpt(bodyGeo, { amp: 0.05, freq: 2.2, seed: 'dai-shell', bone: bones.spine4 });
    sculpt(bodyGeo, { amp: 0.018, freq: 8, seed: 'dai-scutes', bone: bones.spine4 });
    const bodyMesh = bindSkin(new THREE.Mesh(bodyGeo, mats.shell), root, shellWeight);
    bodyMesh.name = 'dai-carapace';
    group.add(bodyMesh);

    // ---- plastron ----
    const bellyGeo = loft(bellySections(), { closed: true, cap: true });
    sculpt(bellyGeo, { amp: 0.02, freq: 4.5, seed: 'dai-belly', bone: bones.spine3 });
    const bellyMesh = bindSkin(new THREE.Mesh(bellyGeo, mats.belly), root, shellWeight);
    bellyMesh.name = 'dai-plastron';
    group.add(bellyMesh);

    // ---- neck: the S curve, skinned to the spine column so it can bend ----
    const neckChain = ['neck-root', 'neck-1', 'neck-2', 'neck-3'];
    const neckParts = [];
    for (let i = 0; i < neckChain.length - 1; i++) {
      const a = boneWorld[neckChain[i]];
      const b = boneWorld[neckChain[i + 1]];
      neckParts.push(
        columnLoft(
          new THREE.Vector3().fromArray([a.x, a.y, a.z]),
          new THREE.Vector3().fromArray([b.x, b.y, b.z]),
          0.19 - i * 0.005,
          0.17 - i * 0.005,
          0.92,
          4,
          10,
        ),
      );
    }
    const neckGeo = mergeGeometries(neckParts);
    sculpt(neckGeo, { amp: 0.02, freq: 5, seed: 'dai-neck', bone: bones['neck-1'] });
    const neckMesh = bindSkin(new THREE.Mesh(neckGeo, mats.neck), root, neckWeight);
    neckMesh.name = 'dai-neck';
    group.add(neckMesh);

    // ---- head: a wedge, flat at the snout, one transverse ridge on the brow ----
    // The skull origin sits on the brow ridge: makeEyelids puts the eye slit at
    // (0, 0.02, 0.12) in the head bone's frame, and only a shell surface that
    // passes through there makes the heavy lid beam read as growing out of the
    // skull instead of being buried inside it.
    const HEAD_RINGS = [
      { z: -0.3, top: 0.1, bot: -0.06, rx: 0.19 },
      { z: -0.2, top: 0.12, bot: -0.08, rx: 0.23 },
      { z: -0.1, top: 0.11, bot: -0.1, rx: 0.25 },
      { z: 0.0, top: 0.08, bot: -0.12, rx: 0.26 },
      { z: 0.1, top: 0.045, bot: -0.13, rx: 0.25 },
      { z: 0.2, top: 0.02, bot: -0.13, rx: 0.22 },
      { z: 0.3, top: 0.0, bot: -0.12, rx: 0.18 },
      { z: 0.4, top: -0.01, bot: -0.09, rx: 0.14 },
      { z: 0.46, top: -0.015, bot: -0.06, rx: 0.1 },
    ];
    const headSections = HEAD_RINGS.map((r) => {
      const pts = [];
      const N = 12;
      for (let k = 0; k < N; k++) {
        const a = (k / N) * TAU;
        // Flat on top, round underneath: the pressed snout plus the rounded
        // skull is what makes the head a wedge.
        const up = Math.max(0, Math.sin(a));
        const down = Math.max(0, -Math.sin(a));
        const y = up * r.top + down * r.bot;
        const x = Math.cos(a) * r.rx * (up > 0 ? 1 : 0.92);
        pts.push([x, y]);
      }
      return { z: r.z, pts };
    });
    const headGeo = loft(headSections, { closed: true, cap: true });
    // Skinned geometry has to share the bones' rest world space, but the ring
    // table above is in the head bone's frame — translate it before binding or
    // the skull renders at the world origin.
    const headWorld = boneWorld.head;
    headGeo.translate(headWorld.x, headWorld.y, headWorld.z);
    sculpt(headGeo, { amp: 0.012, freq: 6, seed: 'dai-head', bone: bones.head });
    const headMesh = bindSkin(new THREE.Mesh(headGeo, mats.head), bones.head, (name) =>
      name === 'head' ? 1 : 0,
    );
    headMesh.name = 'dai-skull';
    group.add(headMesh);

    // The brow ridge: a bony crest the same width as the lid beam, so the beam
    // reads as part of the skull.
    const brow = new THREE.Mesh(
      columnLoft(
        new THREE.Vector3(-0.13, 0.055, 0.1),
        new THREE.Vector3(0.13, 0.055, 0.1),
        0.026,
        0.026,
        0.6,
        3,
        8,
      ),
      mats.head,
    );
    brow.name = 'dai-brow';
    bones.head.add(brow);

    // Eyes: two amber dots sitting exactly on the band the lid beam covers, so
    // half-closed lids leave one slit of amber underneath.
    const eyeGeo = new THREE.IcosahedronGeometry(0.02, 0);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, mats.amber);
      eye.name = `dai-eye${sx < 0 ? 'l' : 'r'}`;
      eye.position.set(sx * 0.038, 0.035, 0.115);
      bones.head.add(eye);
    }

    // The ink line along the beak edge: pressed to the underside of the snout,
    // a closed beak shows only this seam.
    const beakLine = new THREE.Mesh(boxLoft(0.17, 0.006, 0.2), mats.slot);
    beakLine.name = 'dai-beak-line';
    beakLine.position.set(0, -0.135, 0.3);
    bones.head.add(beakLine);

    // ---- movable jaw and eyelids (both assemblies bindSkin internally) ----
    const headBone = bones.head;
    headBone.updateMatrixWorld(true, false);
    const jawPivot = headBone.localToWorld(new THREE.Vector3(0, -0.125, 0.28));
    const jaw = makeJaw(headBone, { pivot: [jawPivot.x, jawPivot.y, jawPivot.z], range: [0, JAW_OPEN] });
    jaw.mesh.material = mats.jaw;
    jaw.mesh.name = 'dai-jaw-shell';
    group.add(jaw.mesh);

    const lids = makeEyelids(headBone, { count: 2, range: [0, LID_WIDE] });
    lids.mesh.material = mats.lid;
    lids.mesh.name = 'dai-lid-shell';
    // makeEyelids builds its shell in the head bone's frame (its contract assumes
    // the head bone sits at the origin) while skinning wants rest world space.
    // Moving the SkinnedMesh to the head bone's world position fixes that: in
    // attached mode the mesh's world transform cancels against bindMatrix in the
    // shader, so this moves the shell onto the head without touching the skin.
    lids.mesh.position.copy(headWorld);
    group.add(lids.mesh);

    // ---- four columnar legs ----
    const legs = [];
    const rand = mulberry32(hashString('tortoise-dai'));
    for (const def of LEG_DEFS) {
      const hipBone = bones[`leg-${def.key}-hip`];
      const kneeBone = bones[`leg-${def.key}-knee`];
      const ankleBone = bones[`leg-${def.key}-ankle`];
      const hip = boneWorld[`leg-${def.key}-hip`];
      const knee = boneWorld[`leg-${def.key}-knee`];
      const ankle = boneWorld[`leg-${def.key}-ankle`];
      const parts = [];
      parts.push(
        columnLoft(
          new THREE.Vector3().copy(hip),
          new THREE.Vector3().copy(knee),
          0.27,
          0.23,
          0.86,
          5,
          12,
        ),
      );
      // A blob at the knee hides the seam where the two columns meet
      parts.push(
        columnLoft(
          new THREE.Vector3().copy(knee).add(new THREE.Vector3(0, 0.06, 0)),
          new THREE.Vector3().copy(knee).add(new THREE.Vector3(0, -0.06, 0)),
          0.24,
          0.24,
          0.9,
          3,
          10,
        ),
      );
      parts.push(
        columnLoft(
          new THREE.Vector3().copy(knee),
          new THREE.Vector3().copy(ankle),
          0.23,
          0.17,
          0.86,
          5,
          12,
        ),
      );
      // The webbed foot: a thin slab spreading forward from the ankle
      const paddleOrigin = new THREE.Vector3().copy(ankle);
      const paddle = columnLoft(
        paddleOrigin,
        new THREE.Vector3(ankle.x, ankle.y, ankle.z + 0.44 * def.dir),
        0.26,
        0.2,
        0.16,
        4,
        8,
      );
      parts.push(paddle);
      const legGeo = mergeGeometries(parts);
      sculpt(legGeo, { amp: 0.022, freq: 5, seed: `dai-leg-${def.key}`, bone: kneeBone });
      const legMesh = bindSkin(new THREE.Mesh(legGeo, mats.leg), hipBone, (name, p) => {
        const w = boneWorld[name];
        return w ? Math.max(0, 1 - p.distanceTo(w) / 0.75) : 0;
      });
      legMesh.name = `dai-leg-${def.key}`;
      group.add(legMesh);
      legs.push({ def, bones: { hip: hipBone, knee: kneeBone, ankle: ankleBone } });
    }
    for (const leg of legs) leg.anchor = legDropAnchor(leg, root);

    // ---- the paper mountain on the carapace: trees and two houses ----
    // Both hang off the nearest spine bone, so the paper mountain breathes with
    // the shell.
    const hostBoneFor = (x, z) => {
      let best = bones.tail;
      let bestD = Infinity;
      for (const name of SHELL_BONES) {
        const w = boneWorld[name];
        const d = (w.x - x) * (w.x - x) + (w.z - z) * (w.z - z);
        if (d < bestD) {
          bestD = d;
          best = bones[name];
        }
      }
      return best;
    };
    const attachToShell = (obj, x, y, z) => {
      const host = hostBoneFor(x, z);
      const w = boneWorld[host.name];
      obj.position.set(x - w.x, y - w.y, z - w.z);
      host.add(obj);
    };

    // The houses sit on the slope between two ridges with their roofs just under
    // the shell heart, reading as a folded paper mountain rather than two
    // buildings standing on top of the shell.
    const HOUSES = [
      { x: -0.86, z: -0.55, yaw: 0.5, scale: 1.0 },
      { x: 0.82, z: 1.1, yaw: -0.7, scale: 0.86 },
    ];
    const crowns = [];
    for (const h of HOUSES) {
      const house = buildPaperHouse(h.x, h.z, h.yaw, h.scale, mats.paper, mats.slot, mats.amber);
      // Once attached to a spine bone, do not group.add it as well: add() takes
      // the object off the bone and the house drops to the world origin.
      attachToShell(house, h.x, shellSurface(h.x, h.z) + 0.01, h.z);
    }

    // Trees keep clear of both houses and off the central ridge — that is where
    // the spine runs.
    let placed = 0;
    let guard = 0;
    while (placed < 5 && guard++ < 200) {
      const x = (rand() * 2 - 1) * 1.3;
      const z = -2.2 + rand() * 4.0;
      if (Math.abs(x) < 0.42) continue;
      const clash = HOUSES.some((h) => Math.hypot(h.x - x, h.z - z) < 0.85);
      if (clash) continue;
      const scale = 0.8 + rand() * 0.5;
      const built = buildPaperTree(rand, x, z, scale, mats.paper, mats.paper);
      attachToShell(built.tree, x, shellSurface(x, z) + 0.015, z);
      crowns.push(built.crown);
      placed++;
    }

    // ---- seam glow ----
    const flowGeo = buildFlowStrips();
    const flowMesh = bindSkin(new THREE.Mesh(flowGeo, mats.flow), root, shellWeight);
    flowMesh.name = 'dai-seam-glow';
    group.add(flowMesh);

    // ---- ink drops and ripples ----
    const beadGeo = new THREE.IcosahedronGeometry(0.022, 0);
    const ringGeo = new THREE.RingGeometry(0.05, 0.5, 20, 1);
    ringGeo.rotateX(-Math.PI * 0.5);
    for (const leg of legs) {
      // Three to five in a string: how many is decided by the build-time seed,
      // never at runtime.
      const count = 3 + Math.floor(rand() * 3);
      leg.drops = [];
      for (let i = 0; i < count; i++) {
        const drop = new THREE.Mesh(beadGeo, mats.drop);
        drop.name = `dai-ink-drop-${leg.def.key}-${i}`;
        drop.visible = false;
        // Start at the anchor's waterline: left at the origin they would stretch
        // the whole tortoise's bounding box out to the world centre.
        drop.position.set(leg.anchor.x, WATER_Y, leg.anchor.z);
        group.add(drop);
        leg.drops.push(drop);
      }
      const ripple = new THREE.Mesh(ringGeo, mats.ripple.clone());
      ripple.name = `dai-ripple-${leg.def.key}`;
      ripple.position.set(leg.anchor.x, WATER_Y, leg.anchor.z);
      ripple.visible = false;
      group.add(ripple);
      leg.ripple = ripple;
      leg.rippleMat = ripple.material;
    }

    // ---- update: a pure function; writes bone transforms and material uniforms only ----
    function update(t, ctx) {
      const time = Number.isFinite(t) ? t : 0;
      const hint = ctx || {};
      const pose = POSE_KEYS.includes(hint.pose) ? hint.pose : 'walk';
      const expr = EXPR_KEYS.includes(hint.expression) ? hint.expression : 'calm';
      const gait = Number.isFinite(hint.gaitSec) && hint.gaitSec > 0 ? hint.gaitSec : GAIT_SEC;
      const wind = Number.isFinite(hint.wind) ? hint.wind : 0;
      const chewOn = hint.chew !== false;
      const walking = pose === 'walk';
      const gaitPhase = (((time / gait) % 1) + 1) % 1;
      const breath = Math.sin(time * BREATH_HZ * TAU);

      // Four legs taking turns; when not walking they rest at mid-stance,
      // planted and not sliding.
      for (const leg of legs) {
        const ph = walking ? (((gaitPhase + leg.def.phase) % 1) + 1) % 1 : 0.25;
        applyLegPose(leg, ph);
      }

      // Idle breathing: the front of the shell and the tail root rise and fall,
      // so the resting pose is alive rather than a statue.
      bones.spine5.rotation.x = -0.018 * breath;
      bones.spine6.rotation.x = -0.022 * breath;
      bones.tail.rotation.x = 0.012 * breath;

      // Neck: extending and retracting. Retraction is that alternating Z fold,
      // and the head's pitch is specified as a *world* attitude (snout down,
      // tucked under the funnel lip) with the accumulated neck rotation
      // subtracted again — otherwise a folded neck leaves the head pointing up.
      const retracted = pose === 'rest' || expr === 'asleep';
      // The fold's vertical component does not scale linearly: a half fold
      // already drops the head half a metre, so extension only takes the two
      // ends (fold 0 and fold 1). Dipping on the way in is the retraction
      // itself, not a bug.
      const extend = retracted ? 0 : pose === 'idle' ? 0.98 : 1;
      const fold = 1 - clamp(extend, 0, 1);
      let neckAcc = 0;
      for (let i = 0; i < NECK_FOLD.length; i++) {
        const a = NECK_FOLD[i] * fold + (i === 0 ? -0.03 * breath : 0);
        bones[NECK_CHAIN[i]].rotation.x = a;
        neckAcc += a;
      }
      bones.head.rotation.x = HEAD_TUCK * fold + 0.03 * breath - neckAcc;
      bones.head.rotation.y = Math.sin(time * 0.31) * 0.09 * (1 - fold * 0.5);
      bones.head.rotation.z = Math.sin(time * 0.23) * 0.05;

      // Eyelids: half closed leaves one amber slit, a startle opens them wide,
      // sleep closes them. Note the assembly's own update is not used — its
      // blink schedule overwrites the lid rotation wholesale, and its geometry
      // treats rotation 0 as the closed state, which is the inverse of a blink.
      const startlePhase = (((time - STARTLE_AT) % STARTLE_PERIOD) + STARTLE_PERIOD) % STARTLE_PERIOD;
      const startled = expr === 'startled' || (expr !== 'asleep' && startlePhase < STARTLE_SEC);
      const baseOpen = expr === 'asleep' ? 0 : startled ? LID_WIDE : expr === 'alert' ? LID_ALERT : LID_HALF;
      const blinkPhase = ((time % BLINK_PERIOD) + BLINK_PERIOD) % BLINK_PERIOD;
      const blinking = !startled && expr !== 'asleep' && blinkPhase < BLINK_SEC;
      const lidOpen = baseOpen * (1 - (blinking ? Math.sin((Math.PI * blinkPhase) / BLINK_SEC) : 0));
      for (const lid of lids.bones) lid.rotation.x = lidOpen;

      // Beak: 30 degrees while eating paper leaves, a seam the rest of the time.
      // makeJaw's own talk cadence is not used for the same reason — a tortoise
      // does not chatter.
      const chewPhase = ((time % CHEW_PERIOD) + CHEW_PERIOD) % CHEW_PERIOD;
      const chewing = chewOn && expr !== 'asleep' && chewPhase < CHEW_SEC;
      const jawAngle = chewing
        ? JAW_OPEN * Math.max(0, Math.sin((chewPhase / CHEW_SEC) * Math.PI * 2.5))
        : 0;
      jaw.bone.quaternion.setFromAxisAngle(WORLD_X, jawAngle);

      // The crowns swing with the gait inertia, all at the same angle — a whole
      // mountain moving as one.
      const sway = SWAY_AMP * Math.sin(gaitPhase * TAU - 0.7) + wind;
      for (const crown of crowns) crown.rotation.x = sway;

      // Seam glow: one flash per step, with a four-second breath on top.
      mats.flow.uniforms.uFlowTime.value = (time * 2) / gait;
      mats.flow.uniforms.uFlowGain.value = FLOW_GAIN * (0.55 + 0.45 * Math.sin(time * (TAU / 4)));

      // Ink drops: they leave the webbed foot during the swing phase, three to
      // five in a string, and ripple when they hit the sea.
      const cycle = Math.floor(time / gait);
      const swingStart = (cycle + STANCE_END) * gait;
      for (const leg of legs) {
        for (let i = 0; i < leg.drops.length; i++) {
          const drop = leg.drops[i];
          const age = time - (swingStart + i * DROP_SPACING);
          const falling = walking && age >= 0 && age <= DROP_FALL_SEC;
          drop.visible = falling;
          if (falling) {
            const k = age / DROP_FALL_SEC;
            drop.position.set(
              leg.anchor.x,
              leg.anchor.y - (leg.anchor.y - WATER_Y) * k * k,
              leg.anchor.z,
            );
          }
        }
        const rippleAge = time - (swingStart + leg.drops.length * DROP_SPACING + DROP_FALL_SEC);
        const expanding = walking && rippleAge >= 0 && rippleAge <= RIPPLE_SEC;
        leg.ripple.visible = expanding;
        if (expanding) {
          const k = rippleAge / RIPPLE_SEC;
          leg.ripple.scale.setScalar(0.12 + 1.0 * k);
          leg.rippleMat.uniforms.uFade.value = 1 - k;
        }
      }
    }

    update(0, {});

    // The assembly bones (jaw, eyelids) hang off the head bone and belong in the
    // returned list too — a director driving expressions has to find them by name.
    const allBones = {};
    const allNames = [];
    root.traverse((o) => {
      if (o.isBone && o.name) {
        allBones[o.name] = o;
        allNames.push(o.name);
      }
    });

    return {
      group,
      bones: allNames,
      boneMap: allBones,
      update,
    };
  },
};
