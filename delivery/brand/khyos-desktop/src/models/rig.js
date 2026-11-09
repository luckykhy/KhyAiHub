// models/rig.js — the shared modeling layer for every character and creature:
// section lofting, bone chains, skinning, and the movable assemblies (jaw,
// eyelids, fins/limbs). Everything here is a pure function of its inputs, so a
// frame is decided by (scene, t) alone.
//
// Three constraints shape this file; read them before changing anything:
//   1) Determinism. The capture chain renders per scene at t = i/24 and
//      compares frame bytes between two renders of the same instant. Reading a
//      wall clock or accumulating state across calls turns "same t, different
//      pixels" into undebuggable folklore — all randomness goes through the
//      seeded generators in src/util/rand.js (contract in its header comment).
//   2) Geometry and bones live in one rest world space. bindSkin captures
//      bindMatrix and boneInverses from the world matrices at bind time;
//      moving a single bone's rest position afterwards makes the part deform
//      with the pose instead of moving rigidly.
//   3) Bones must stay in the rendered graph. Skeleton.update() reads
//      bone.matrixWorld, and a bone outside the scene graph never refreshes it,
//      so skinning silently freezes at rest. That is the most expensive failure
//      mode in this layer, so bindSkin adopts a parentless root itself.

import * as THREE from 'three';
import { hash3, hashString, mulberry32 } from '../util/rand.js';

// ---------------------------------------------------------------------------
// loft
// ---------------------------------------------------------------------------

/**
 * Loft a surface through cross-section curves.
 * sections = [{ z, pts: [[x, y], ...] }] ordered along the loft direction;
 * every section must carry the same point count because rings are stitched by
 * index. opts.closed wraps each ring end to start, opts.cap seals both ends.
 * Returns a BufferGeometry with position / normal / uv in the caller's space —
 * which is the rest world space the mesh will later be skinned in.
 */
export function loft(sections, opts = {}) {
  const closed = opts.closed === true;
  const cap = opts.cap !== false;

  if (!Array.isArray(sections) || sections.length < 2) {
    throw new Error('[rig] loft() needs at least two sections: [{ z, pts }] along the loft direction.');
  }
  const n = sections[0].pts.length;
  if (!Number.isInteger(n) || n < (closed ? 3 : 2)) {
    throw new Error(`[rig] loft() needs >= ${closed ? 3 : 2} points per section when closed=${closed}.`);
  }
  for (const s of sections) {
    if (!Array.isArray(s.pts) || s.pts.length !== n) {
      throw new Error('[rig] loft() sections must share one point count — rings are stitched by index.');
    }
    if (!Number.isFinite(s.z)) {
      throw new Error('[rig] loft() every section needs a finite z (loft direction coordinate).');
    }
    for (const p of s.pts) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        throw new Error('[rig] loft() section points must be finite [x, y] pairs.');
      }
    }
  }

  const rings = sections.length;
  const positions = [];
  const uvs = [];
  for (let s = 0; s < rings; s++) {
    for (let i = 0; i < n; i++) {
      const p = sections[s].pts[i];
      positions.push(p[0], p[1], sections[s].z);
      uvs.push(i / n, rings > 1 ? s / (rings - 1) : 0);
    }
  }

  const index = [];
  const step = closed ? n : n - 1;
  for (let s = 0; s < rings - 1; s++) {
    for (let i = 0; i < step; i++) {
      const a = s * n + i;
      const b = s * n + ((i + 1) % n);
      const c = (s + 1) * n + ((i + 1) % n);
      const d = (s + 1) * n + i;
      index.push(a, b, c, a, c, d);
    }
  }

  if (cap) {
    const capRing = (s, outward) => {
      const center = positions.length / 3;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += sections[s].pts[i][0];
        cy += sections[s].pts[i][1];
      }
      positions.push(cx / n, cy / n, sections[s].z);
      uvs.push(0.5, 0.5);
      for (let i = 0; i < step; i++) {
        const p = s * n + i;
        const q = s * n + ((i + 1) % n);
        if (outward) index.push(center, p, q);
        else index.push(center, q, p);
      }
    };
    capRing(rings - 1, true);
    capRing(0, false);
  }

  // Ring winding from callers is not a contract (both CW and CCW show up in
  // the wild), and reversed winding means inward normals — the cel shader then
  // shades the whole body black. Signed volume is complete for the global
  // orientation, so flip everything together when it comes out negative; sides
  // and caps keep their relative winding either way.
  if (signedVolume(positions, index) < 0) {
    for (let i = 0; i < index.length; i += 3) {
      const swap = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = swap;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function signedVolume(positions, index) {
  let v = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}

// ---------------------------------------------------------------------------
// sculpt
// ---------------------------------------------------------------------------

// Deterministic field for sculpt: hash3 lattice + trilinear interpolation,
// three-octave fbm. The decorrelation constants mirror the GLSL fbm in
// rand.js (2.03 / 11.7) so CPU-side displacement and GPU-side sampling of the
// same seed cannot drift apart.
function vnoise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function fbm3(x, y, z) {
  let sum = 0;
  let norm = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  let pz = z;
  for (let o = 0; o < 3; o++) {
    sum += amp * vnoise3(px, py, pz);
    norm += amp;
    amp *= 0.5;
    px = px * 2.03 + 11.7;
    py = py * 2.03 + 11.7;
    pz = pz * 2.03 + 11.7;
  }
  return sum / norm;
}

/**
 * Deterministic displacement sculpt along a bone: every vertex moves along its
 * normal by amp * (2*fbm - 1), with the noise sampled in the bone's rest world
 * frame so ridges and volume ride with the skeleton. Omit bone to sculpt in the
 * geometry's own frame. Mutates and returns the same geometry; normals and the
 * bounding sphere are recomputed because stale ones shade wrong after moving
 * positions. Call it before posing — sculpting a posed chain bakes the pose in.
 */
export function sculpt(geometry, opts = {}) {
  const { amp = 0, freq = 1, seed = 'rig', bone = null } = opts;
  const position = geometry.getAttribute('position');
  if (!position) {
    throw new Error('[rig] sculpt() needs a geometry with a position attribute.');
  }
  if (!(amp > 0)) return geometry;

  const rand = mulberry32(hashString(String(seed)));
  const phaseX = rand() * 256;
  const phaseY = rand() * 256;
  const phaseZ = rand() * 256;

  let toBone = null;
  let fromBone = null;
  let nToBone = null;
  if (bone) {
    bone.updateWorldMatrix(true, false);
    toBone = new THREE.Matrix4().copy(bone.matrixWorld).invert();
    fromBone = new THREE.Matrix4().copy(bone.matrixWorld);
    nToBone = new THREE.Matrix3().getNormalMatrix(toBone);
  }

  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');
  const pos = position.array;
  const nrm = normal.array;
  const p = new THREE.Vector3();
  const nv = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    const k = i * 3;
    p.set(pos[k], pos[k + 1], pos[k + 2]);
    nv.set(nrm[k], nrm[k + 1], nrm[k + 2]);
    if (toBone) {
      p.applyMatrix4(toBone);
      nv.applyMatrix3(nToBone).normalize();
    }
    const f = fbm3(p.x * freq + phaseX, p.y * freq + phaseY, p.z * freq + phaseZ);
    p.addScaledVector(nv, amp * (f * 2 - 1));
    if (fromBone) p.applyMatrix4(fromBone);
    pos[k] = p.x;
    pos[k + 1] = p.y;
    pos[k + 2] = p.z;
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// bone chain + skinning
// ---------------------------------------------------------------------------

/**
 * Build a Bone chain from spec [{ name, pos, parent }]. pos is world
 * coordinates; a parent must appear in spec before its children. Returns
 * { root, bones: { name: Bone } }.
 * Bones carry positions only, no rotations: directions are derived from world
 * positions via topology (see the assemblies) or given explicitly through
 * opts.axis. A rotated rest pose is safe for a body mesh — the rest pose always
 * reproduces the authored geometry — but the assemblies place their shells
 * assuming the attach bone's rest orientation is identity, so bake a tilt into
 * the spec's pos rather than into a rotation.
 */
export function createBoneChain(spec) {
  if (!Array.isArray(spec) || spec.length === 0) {
    throw new Error('[rig] createBoneChain() needs a non-empty spec: [{ name, pos, parent }].');
  }
  const bones = {};
  let root = null;
  const _m = new THREE.Matrix4();

  for (const entry of spec) {
    const name = entry && entry.name;
    const pos = entry && entry.pos;
    if (typeof name !== 'string' || name === '') {
      throw new Error('[rig] createBoneChain() every entry needs a name.');
    }
    if (bones[name]) {
      throw new Error(`[rig] createBoneChain() duplicate bone name: ${name}.`);
    }
    if (!Array.isArray(pos) || pos.length < 3 || !pos.slice(0, 3).every(Number.isFinite)) {
      throw new Error(`[rig] createBoneChain() ${name} needs pos as finite [x, y, z].`);
    }
    const parentName = entry.parent;
    let parentBone = null;
    if (parentName !== undefined && parentName !== null) {
      parentBone = bones[parentName];
      if (!parentBone) {
        throw new Error(
          `[rig] createBoneChain() parent ${parentName} must appear before ${name} in spec.`,
        );
      }
    } else if (root) {
      throw new Error('[rig] createBoneChain() allows exactly one bone without a parent.');
    }

    const bone = new THREE.Bone();
    bone.name = name;
    if (parentBone) {
      // The parent's matrixWorld is final by now (no rotations on the chain, so
      // it is a plain composition of translations): local = world * inverse.
      parentBone.updateMatrix();
      parentBone.updateMatrixWorld();
      _m.copy(parentBone.matrixWorld).invert();
      bone.position.set(pos[0], pos[1], pos[2]).applyMatrix4(_m);
      parentBone.add(bone);
    } else {
      bone.position.set(pos[0], pos[1], pos[2]);
      root = bone;
    }
    bone.updateMatrix();
    bones[name] = bone;
  }

  root.updateMatrixWorld(true);
  return { root, bones };
}

/**
 * Skin a mesh onto the chain rooted at root; returns the SkinnedMesh that
 * deforms on the GPU along the bones.
 * weightFn(boneName, position) → weight, position being the vertex's rest
 * coordinates. Each vertex keeps its four strongest influences and normalizes
 * them — WebGL's skinIndex is a vec4, so influences beyond four are dropped
 * silently and weight functions must stay concentrated.
 * Contract: geometry and bones share one rest world space; keep the mesh at
 * identity inside that space; a parentless root is adopted by the SkinnedMesh
 * so it enters the rendered graph.
 */
export function bindSkin(mesh, root, weightFn) {
  if (!mesh || mesh.isMesh !== true) {
    throw new Error('[rig] bindSkin() needs a Mesh.');
  }
  if (!root || root.isObject3D !== true) {
    throw new Error('[rig] bindSkin() needs a bone (or the root of a bone chain).');
  }
  if (typeof weightFn !== 'function') {
    throw new Error('[rig] bindSkin() needs weightFn(boneName, position).');
  }
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) {
    throw new Error('[rig] bindSkin() geometry has no position attribute.');
  }

  const bones = [];
  root.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  if (bones.length === 0) {
    throw new Error('[rig] bindSkin() found no Bone under root.');
  }

  const count = position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(position, i);
    const hits = [];
    let sum = 0;
    for (let b = 0; b < bones.length; b++) {
      const w = weightFn(bones[b].name, v);
      if (Number.isFinite(w) && w > 0) {
        hits.push({ b, w });
        sum += w;
      }
    }
    if (!(sum > 0)) {
      throw new Error(
        `[rig] bindSkin() vertex ${i} has zero weight on every bone: nothing holds it and it collapses to the origin. weightFn must return a positive weight for at least one bone.`,
      );
    }
    hits.sort((x, y) => y.w - x.w);
    const keep = Math.min(4, hits.length);
    for (let k = 0; k < keep; k++) {
      skinIndex[i * 4 + k] = hits[k].b;
      skinWeight[i * 4 + k] = hits[k].w / sum;
    }
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

  const skinned = new THREE.SkinnedMesh(geometry, mesh.material);
  skinned.name = mesh.name;
  skinned.position.copy(mesh.position);
  skinned.quaternion.copy(mesh.quaternion);
  skinned.scale.copy(mesh.scale);
  skinned.userData = mesh.userData;

  // A bone outside the rendered graph never refreshes matrixWorld and the mesh
  // freezes at rest. Adopt only a rootless root; a caller-managed chain is left
  // exactly where it was put.
  if (!root.parent) skinned.add(root);
  skinned.updateMatrixWorld(true);
  // Refresh the whole chain, children included: boneInverses below are read
  // from matrixWorld, and a bone that never got one carries identity — the
  // mesh then collapses instead of failing loudly.
  if (root.parent) root.updateWorldMatrix(true, true);

  skinned.bind(new THREE.Skeleton(bones));
  return skinned;
}

// ---------------------------------------------------------------------------
// assemblies
// ---------------------------------------------------------------------------

// Assembly defaults: cadence and layout. Capture calls update(t) at 24fps, so
// any pure function of t is deterministic; these constants only exist so parts
// on screen do not share one beat, and so the defaults read as a ~0.3m head.
// Rescale the mesh or move the bones before bindSkin for other proportions.
const JAW_TALK_HZ = 2.6;
const JAW_SENTENCE_SEC = 3.4;
const JAW_SPEAK_RATIO = 0.72;
const JAW_LENGTH = 0.09;
const JAW_HALF_WIDTH = 0.07;
const JAW_HALF_HEIGHT = 0.015;
const JAW_RANGE = [0, 0.5];

const LID_COUNT = 2;
const LID_RANGE = [0, 1.15];
const LID_WIDTH = 0.1;
const LID_LENGTH = 0.05;
const LID_SLIT = 0.03;
const LID_DEPTH = 0.012;
const LID_UP = 0.02;
const LID_FORWARD = 0.12;
const LID_BLINK_PERIOD = 4.2;
const LID_BLINK_SEC = 0.16;
const LID_SWEEP = 0.4;

const FIN_SEGMENTS = 5;
const FIN_SPAN = 0.3;
const FIN_WAVE_HZ = 1.2;
const FIN_WAVE_AMP = 0.3;
const FIN_WAVE_PERIOD = 3;

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

function unitVector(list, fallback) {
  const v = new THREE.Vector3().fromArray(list || fallback);
  return v.lengthSq() > 1e-12 ? v.normalize() : new THREE.Vector3().fromArray(fallback);
}

// Ring sections along +Z with an elliptical cross-section, tapered to a lens at
// both ends. Every assembly shell is built this way: closed rings with caps, so
// the mesh stays solid under FrontSide materials.
function taperedRings(rings, points, halfA, halfB, length, endTaper = 0.04) {
  const sections = [];
  for (let i = 0; i < rings; i++) {
    const u = rings > 1 ? (i / (rings - 1)) * 2 - 1 : 0;
    const taper = Math.sqrt(Math.max(endTaper, 1 - u * u));
    const pts = [];
    for (let k = 0; k < points; k++) {
      const a = (k / points) * Math.PI * 2;
      pts.push([Math.cos(a) * halfA * taper, Math.sin(a) * halfB * taper]);
    }
    sections.push({ z: u * length * 0.5, pts });
  }
  return sections;
}

function placedLoft(sections, xAxis, yAxis, zAxis, position) {
  const geometry = loft(sections, { closed: true, cap: true });
  geometry.applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(position));
  return geometry;
}

/**
 * Movable jaw: a jaw bone under headBone plus a lens shell hinged at pivot,
 * with update(t) swinging it open and shut on a talk cadence (a 3.4s sentence,
 * 72% of it speaking, 2.6 openings per second).
 * opts.pivot is the world-space hinge point (defaults to the head bone's
 * position); opts.range is [closedRad, openRad]; opts.axis is the hinge axis
 * (default world +X — the left/right axis of a +Z facing head). The shell is
 * laid out assuming headBone keeps an identity rest orientation.
 */
export function makeJaw(headBone, opts = {}) {
  if (!headBone || headBone.isObject3D !== true) {
    throw new Error('[rig] makeJaw() needs a head bone.');
  }
  headBone.updateMatrix();
  headBone.updateWorldMatrix(true, false);
  const pivot = opts.pivot
    ? new THREE.Vector3().fromArray(opts.pivot)
    : headBone.getWorldPosition(new THREE.Vector3());
  const range = opts.range || JAW_RANGE;
  const axis = unitVector(opts.axis, [1, 0, 0]);

  const jaw = new THREE.Bone();
  jaw.name = `${headBone.name || 'head'}-jaw`;
  jaw.position
    .copy(pivot)
    .applyMatrix4(new THREE.Matrix4().copy(headBone.matrixWorld).invert());
  headBone.add(jaw);

  // Shell runs forward from the hinge and tapers toward the chin, so swinging
  // it around the hinge axis drops the front — an opening mouth, not a spin.
  const shell = new THREE.Mesh(
    placedLoft(
      taperedRings(7, 8, JAW_HALF_WIDTH, JAW_HALF_HEIGHT, JAW_LENGTH),
      WORLD_X,
      WORLD_Y,
      WORLD_Z,
      pivot,
    ),
  );
  shell.name = `${jaw.name}-shell`;
  const mesh = bindSkin(shell, jaw, (name) => (name === jaw.name ? 1 : 0));

  const update = (t) => {
    const cycle = t * JAW_TALK_HZ;
    const open01 = 0.5 - 0.5 * Math.cos(Math.PI * 2 * (cycle - Math.floor(cycle)));
    const sentence = (((t / JAW_SENTENCE_SEC) % 1) + 1) % 1;
    const speaking = sentence < JAW_SPEAK_RATIO ? 1 : 0;
    jaw.quaternion.setFromAxisAngle(axis, range[0] + (range[1] - range[0]) * open01 * speaking);
  };
  update(0);

  return { bone: jaw, mesh, update };
}

/**
 * Movable eyelids: count lid bones under an assembly root below headBone, plus
 * one shell rod standing at the top of the eye slit; update(t) presses it down
 * over the slit on a blink schedule (one blink every 4.2s, 0.16s long, sweeping
 * across the lids so a segmented lid reads as a folding fold).
 * opts.count is the lid bone count (1 gives a single full-width visor);
 * opts.range is [restRad, closedRad]; opts.axis is the hinge axis (default
 * world +X). Default layout for a ~0.3m head: the slit sits at
 * (0, LID_UP, LID_FORWARD) in the head bone's frame, which assumes headBone
 * keeps an identity rest orientation; adjust bone positions or scale the mesh
 * before bindSkin for other proportions.
 */
export function makeEyelids(headBone, opts = {}) {
  if (!headBone || headBone.isObject3D !== true) {
    throw new Error('[rig] makeEyelids() needs a head bone.');
  }
  const count = Math.max(1, Math.floor(opts.count || LID_COUNT));
  const range = opts.range || LID_RANGE;
  const axis = unitVector(opts.axis, [1, 0, 0]);

  const lidRoot = new THREE.Bone();
  lidRoot.name = `${headBone.name || 'head'}-lidroot`;
  headBone.add(lidRoot);

  const segW = LID_WIDTH / count;
  const hingeY = LID_UP + LID_SLIT * 0.5;
  const hingeZ = LID_FORWARD - LID_DEPTH * 0.5;
  const lids = [];
  for (let i = 0; i < count; i++) {
    const lid = new THREE.Bone();
    lid.name = `${headBone.name || 'head'}-lid${i}`;
    lid.position.set(-LID_WIDTH * 0.5 + segW * (i + 0.5), hingeY, hingeZ);
    lidRoot.add(lid);
    lids.push(lid);
  }

  // The shell is one rod standing up from the hinge line, built along local +Z
  // (= world +Y here) with the ring spanning the slit width; every lid bone
  // owns a slice of it, so a blink presses the whole rod down.
  const shell = new THREE.Mesh(
    placedLoft(
      taperedRings(5, 8, LID_WIDTH * 0.5, LID_DEPTH * 0.5, LID_LENGTH, 0.25),
      WORLD_X,
      new THREE.Vector3(0, 0, -1),
      WORLD_Y,
      new THREE.Vector3(0, hingeY, hingeZ),
    ),
  );
  shell.name = `${lidRoot.name}-shell`;

  const lidIndex = new Map(lids.map((l, i) => [l.name, i]));
  const lidWorld = lids.map((l) => l.getWorldPosition(new THREE.Vector3()));
  const support = segW * 1.5;
  const mesh = bindSkin(shell, lidRoot, (name, position) => {
    const i = lidIndex.get(name);
    if (i === undefined) return 0;
    return Math.max(0, 1 - Math.abs(position.x - lidWorld[i].x) / support);
  });

  const update = (t) => {
    const phase = (((t % LID_BLINK_PERIOD) + LID_BLINK_PERIOD) % LID_BLINK_PERIOD);
    for (let i = 0; i < lids.length; i++) {
      const offset = (LID_SWEEP * i) / Math.max(1, lids.length - 1);
      const local = phase - offset;
      const closing = local >= 0 && local < LID_BLINK_SEC;
      const k = closing ? Math.sin((Math.PI * local) / LID_BLINK_SEC) : 0;
      lids[i].quaternion.setFromAxisAngle(axis, range[0] + (range[1] - range[0]) * k);
    }
  };
  update(0);

  return { bone: lids[0], bones: lids, mesh, update };
}

/**
 * Fin / limb assembly: a chain of segments bones grows from bone along axis,
 * with a membrane lofted over it (root half-width span/2 tapering to span*0.12)
 * and update(t) running a traveling wave down the chain (FK — each bone stacks
 * on its parent, so the tip swings hardest).
 * opts.segments is the bone count, opts.span the total length in meters,
 * opts.axis the growth axis given in the attach bone's parent space (default
 * world +Y, which is what dorsal and caudal fins want out of the box).
 * The membrane width direction is the attach bone's inward direction (parent to
 * bone) projected perpendicular to the axis. Chains from createBoneChain carry
 * no rotations, so all of these directions read as world directions — the
 * assembly is laid out assuming bone keeps an identity rest orientation.
 */
export function makeFin(bone, opts = {}) {
  if (!bone || bone.isObject3D !== true) {
    throw new Error('[rig] makeFin() needs an attach bone.');
  }
  const segments = Math.max(1, Math.floor(opts.segments || FIN_SEGMENTS));
  const span = Number.isFinite(opts.span) && opts.span > 0 ? opts.span : FIN_SPAN;
  const axis = unitVector(opts.axis, [0, 1, 0]);
  const segLen = span / segments;

  bone.updateMatrix();
  bone.updateWorldMatrix(true, false);
  const boneWorld = bone.getWorldPosition(new THREE.Vector3());
  const inward = bone.parent
    ? boneWorld.clone().sub(bone.parent.getWorldPosition(new THREE.Vector3()))
    : new THREE.Vector3();
  if (inward.lengthSq() < 1e-12) inward.copy(WORLD_Z);
  inward.normalize();

  const perpendicular = (ref) => {
    const v = ref.clone().addScaledVector(axis, -ref.dot(axis));
    return v.lengthSq() < 1e-8 ? null : v.normalize();
  };
  const width = perpendicular(inward) || perpendicular(WORLD_Z) || perpendicular(WORLD_X);
  const thickness = new THREE.Vector3().crossVectors(axis, width).normalize();

  const fins = [];
  let parent = bone;
  for (let i = 0; i < segments; i++) {
    const fin = new THREE.Bone();
    fin.name = `${bone.name || 'root'}-fin${i}`;
    fin.position.copy(axis).multiplyScalar(segLen);
    parent.add(fin);
    fins.push(fin);
    parent = fin;
  }

  const sections = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const halfW = span * (0.5 * (1 - t) + 0.12 * t);
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pts.push([Math.cos(a) * halfW, Math.sin(a) * halfW * 0.14]);
    }
    sections.push({ z: i * segLen, pts });
  }
  const shell = new THREE.Mesh(placedLoft(sections, width, thickness, axis, boneWorld));
  shell.name = `${bone.name || 'root'}-fin-shell`;

  const finIndex = new Map(fins.map((f, i) => [f.name, i]));
  const boneAxial = boneWorld.dot(axis);
  const support = segLen * 1.2;
  const mesh = bindSkin(shell, fins[0], (name, position) => {
    const i = finIndex.get(name);
    if (i === undefined) return 0;
    // Axial distance, not 3D distance: the membrane reaches sideways as far as
    // half the span, and a lateral offset must not starve a vertex of weight —
    // bones are spaced along the axis, so weight belongs to the axis too.
    const axial = position.dot(axis) - boneAxial;
    return Math.max(0, 1 - Math.abs(axial - i * segLen) / support);
  });

  const update = (t) => {
    for (let i = 0; i < fins.length; i++) {
      // Traveling wave, anchored so t=0 is the straight rest pose: without the
      // second term the chain would already be mid-swing on the first frame.
      const lag = (i / FIN_WAVE_PERIOD) * Math.PI * 2;
      const angle = FIN_WAVE_AMP * (Math.sin(t * FIN_WAVE_HZ * Math.PI * 2 - lag) + Math.sin(lag));
      fins[i].quaternion.setFromAxisAngle(width, angle);
    }
  };
  update(0);

  return { bone: fins[0], bones: fins, mesh, update };
}
