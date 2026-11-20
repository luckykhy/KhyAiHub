// models/ink-eel-yuan.js — the ink eel "Yuan" (cast.json id ink-eel-yuan), the
// lurker beneath the ink sea.
//
// Form traces to src/story/cast.json:33-39: a ribbon body flattened dorsoventrally
// (rx 0.9m / ry 0.45m), widest one third of the body length behind the head,
// tapering to a line at the tail tip; a long-arc spine that becomes a 2.5-wavelength
// sine (λ 6m, amp 0.8m) while swimming; pointed snout 0.5m with a jaw that gapes
// 60°; no paired fins, seven short dorsal spines; nine 2cm amber squares that
// light one by one and die one by one like a cursor walking a line of text; no
// eyelids — the blink is two 3mm amber dots dimming together on their own clock;
// three gill pairs that breathe and spit ink mist; a lighter ink band along the
// belly that pushes the surface up into a glowing ridge.
//
// Three constraints, inherited from rig.js:
//   1) update(t) is a pure function of (t, ctx): no wall clock, no Math.random, no
//      state carried between frames. capture.mjs compares frame bytes of two
//      renders of the same instant.
//   2) The rest pose already has form — the lofted sections carry the spindle
//      profile and the flattened cross-section, so A-pose reads without animation.
//   3) Bones stay in the rendered graph: every mesh here binds to the one root
//      that bindSkin adopts, so all skeletons share a single chain.

import * as THREE from 'three';
import { bindSkin, createBoneChain, loft, makeEyelids, makeJaw, sculpt } from './rig.js';

// ---------------------------------------------------------------------------
// Form constants
// ---------------------------------------------------------------------------

const BODY_LEN = 14; // snout tip to tail tip
const SNOUT_LEN = 0.5;
const RX_MAX = 0.9; // cross-section half width (left/right)
const RY_MAX = 0.45; // cross-section half height (dorsal/ventral) — flattened
const WIDEST_FRAC = 1 / 3; // widest one third of the body length behind the head
const SPINE_ARC = 0.55; // rest pose: rise of the long arc above the snout-tail chord
const SWIM_AMP = 0.8;
const SWIM_WAVELENGTH = 6;
const SWIM_K = (Math.PI * 2) / SWIM_WAVELENGTH;
const SWIM_W = SWIM_K; // 1 m/s wave travel — a lazy cruise
const JAW_OPEN = Math.PI / 3; // 60° gape
const SPOT_COUNT = 9;
const SPOT_SIZE = 0.02; // 2cm square
const EYE_SIZE = 0.003; // 3mm
const DORSAL_SPINES = 7;
const GILL_PAIRS = 3;

const HEAD_Z = SNOUT_LEN;
const TAIL_Z = HEAD_Z - BODY_LEN;

const SPINE_BONES = 14; // skull -> tail tip
const BODY_RINGS = 26;
const BODY_POINTS = 18;
const BELLY_RINGS = 16;
const BELLY_POINTS = 10;

// Separate clocks on purpose (cast.json:38): the cursor-walk of the squares, the
// blink, the gill breath and the cruise sway must not share a phase.
const SPOT_STEP = 0.3;
const SPOT_RAMP = 0.15;
const SPOT_HOLD = 0.25;
const BLINK_PERIOD = 4.2;
const BLINK_SEC = 0.16;
const BREATH_PERIOD = 5.5;
const ROLL_UP = 0.9;
const ROLL_HOLD = 0.5;
const ROLL_DOWN = 0.9;
const GILL_ROLL_SEC = 1.6;
const MIST_ROLL_SEC = 2.1;

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth(x) {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
}

// 0 -> 1 -> 0 envelope: a single rise and fall with no corner at the peak.
function bell(x) {
  return Math.sin(Math.PI * clamp01(x));
}

// Spindle profile: zero at both tips, RX_MAX one third of the body length behind
// the head. One sin half-period per side keeps the snout pointed.
function bodyRadius(z) {
  const u = (z - TAIL_Z) / (HEAD_Z - TAIL_Z); // 0 = tail tip, 1 = snout tip
  const widest = 1 - WIDEST_FRAC;
  if (u <= widest) return RX_MAX * Math.sin((Math.PI * 0.5 * u) / widest);
  return RX_MAX * Math.sin(Math.PI * 1.5 * (1 - u));
}

function bodyDepth(z) {
  return RY_MAX * (bodyRadius(z) / RX_MAX);
}

// Rest spine: one long arc, snout and tail on the chord, the back arching up.
function spineY(z) {
  const u = clamp01((z - TAIL_Z) / (HEAD_Z - TAIL_Z));
  return SPINE_ARC * Math.sin(Math.PI * u);
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export const model = {
  id: 'ink-eel-yuan',
  build(ctx) {
    const scene = ctx && ctx.scene;
    const palette = (ctx && ctx.palette) || {};
    // Body ink — one shade blacker than the sea surface (cast.json:38). palette
    // may override; the fallbacks are that blacker-than-the-sea ink.
    const inkColor = new THREE.Color(palette.ink || palette.inkEel || '#04050a');
    const bellyColor = new THREE.Color(palette.belly || '#12161f');
    const amberColor = new THREE.Color(palette.amber || '#ffb45a');
    const mistColor = new THREE.Color(palette.mist || '#0a0d15');

    const group = new THREE.Group();
    group.name = 'ink-eel-yuan';

    // Standard materials with a small emissive floor so the silhouette survives a
    // scene without lights. The render layer swaps these for cel materials through
    // group.userData.materials — a plain MeshBasicMaterial would write no
    // G-buffer id and the ink pass would lose the outline.
    const inkMaterial = new THREE.MeshStandardMaterial({
      color: inkColor,
      roughness: 0.62,
      metalness: 0.05,
      emissive: inkColor.clone().multiplyScalar(0.07),
    });
    const bellyMaterial = new THREE.MeshStandardMaterial({
      color: bellyColor,
      roughness: 0.5,
      metalness: 0.05,
      emissive: bellyColor.clone().multiplyScalar(0.12),
    });
    const amberMaterial = new THREE.MeshStandardMaterial({
      color: amberColor,
      roughness: 0.35,
      metalness: 0,
      emissive: amberColor.clone(),
      emissiveIntensity: 1,
    });
    const mistMaterial = new THREE.MeshBasicMaterial({
      color: mistColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    // -----------------------------------------------------------------------
    // 1) Body: loft through cross-section curves. Closed rings + caps, so the
    //    shell stays solid under FrontSide materials.
    // -----------------------------------------------------------------------

    const bodySections = [];
    for (let i = 0; i < BODY_RINGS; i++) {
      const u = i / (BODY_RINGS - 1);
      const z = TAIL_Z + u * (HEAD_Z - TAIL_Z);
      // A hard zero radius would collapse a ring into degenerate triangles and
      // NaN normals; 1.2cm reads as "a line" at every camera distance in the film.
      const rx = Math.max(0.012, bodyRadius(z));
      const ry = Math.max(0.012, bodyDepth(z));
      // The rest spine is an arc, so every ring is lifted onto it: geometry and
      // bones must share one rest world space or the bind pose fights the pose.
      const arc = spineY(z);
      const pts = [];
      for (let k = 0; k < BODY_POINTS; k++) {
        const a = (k / BODY_POINTS) * Math.PI * 2;
        pts.push([Math.cos(a) * rx, Math.sin(a) * ry + arc]);
      }
      bodySections.push({ z, pts });
    }
    const bodyGeo = loft(bodySections, { closed: true, cap: true });

    // -----------------------------------------------------------------------
    // 2) Bone chain: skull -> spine -> tail tip, each bone parented to the one
    //    before it. A flat hierarchy (all children of the skull) would make the
    //    whole body swing rigidly with the head instead of stacking rotations,
    //    which is what the undulation is made of.
    // -----------------------------------------------------------------------

    const SKULL_Z = 0.05;
    const SKULL_Y = spineY(SKULL_Z);
    const boneSpec = [{ name: 'skull', pos: [0, SKULL_Y, SKULL_Z] }];
    for (let i = 0; i < SPINE_BONES; i++) {
      const z = -((i + 1) * (BODY_LEN - SNOUT_LEN)) / SPINE_BONES;
      const name = i === SPINE_BONES - 1 ? 'tailtip' : `spine${String(i).padStart(2, '0')}`;
      boneSpec.push({ name, pos: [0, spineY(z), z], parent: i === 0 ? 'skull' : boneSpec[i].name });
    }
    const { root, bones } = createBoneChain(boneSpec);
    const chainNames = Object.keys(bones);

    // Rest world z of every chain bone. The swim and roll waves are sampled at
    // these stations, so update() never reads a posed position — that would make
    // the frame depend on the previous frame.
    const restZ = {};
    for (const name of chainNames) {
      restZ[name] = bones[name].getWorldPosition(new THREE.Vector3()).z;
    }

    // Weight kernel along the body length. Bones sit ~0.96m apart and support is
    // 1.05m, so at most three spine bones plus the skull ever influence a vertex
    // — inside skinIndex's four-influence budget. bindSkin hands over the whole
    // rest position (a Vector3), not just z.
    function bodyWeight(name, position) {
      const z = position.z;
      if (name === 'skull') return clamp01((z + 2.2) / 1.2);
      if (name === 'tailtip') return clamp01((z - restZ.tailtip + 1.0) / 1.0);
      const bz = restZ[name];
      if (bz === undefined) return 0;
      return clamp01(1 - Math.abs(z - bz) / 1.05);
    }

    // -----------------------------------------------------------------------
    // 3) Sculpt along the skeleton: low frequency for volume, high for hide.
    //    Seeded strings keep two builds identical. Rest pose, before bind.
    // -----------------------------------------------------------------------

    sculpt(bodyGeo, { amp: 0.05, freq: 2.1, seed: 'ink-eel-yuan:bulk', bone: bones.spine07 });
    sculpt(bodyGeo, { amp: 0.012, freq: 7.5, seed: 'ink-eel-yuan:hide' });

    // The sculpt moves the surface, so features that must sit ON it (spots,
    // spines) read their height off the sculpted geometry rather than the nominal
    // profile — otherwise a noise peak would bury them. Rings sit 0.56m apart, so
    // the window has to be at least half that or it misses the nearest ring.
    function dorsalY(z) {
      const pos = bodyGeo.getAttribute('position');
      let best = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getZ(i) - z) > 0.3) continue;
        if (Math.abs(pos.getX(i)) > 0.3) continue;
        const y = pos.getY(i);
        if (y > best) best = y;
      }
      return Number.isFinite(best) ? best : spineY(z) + bodyDepth(z);
    }

    // -----------------------------------------------------------------------
    // 4) Skin the body
    // -----------------------------------------------------------------------

    const bodyMesh = bindSkin(new THREE.Mesh(bodyGeo, inkMaterial), root, bodyWeight);
    bodyMesh.name = 'ink-eel-yuan-body';
    group.add(bodyMesh);

    // -----------------------------------------------------------------------
    // 5) Belly band: a lighter ink strip along the underside — the ridge that
    //    pushes the sea surface up. Built as a slightly smaller copy of the body
    //    lowered onto the belly, so only the strip shows; the rest hides inside
    //    the opaque body. Rolling the body brings it up.
    // -----------------------------------------------------------------------

    const bellySections = [];
    for (let i = 0; i < BELLY_RINGS; i++) {
      const u = i / (BELLY_RINGS - 1);
      const z = TAIL_Z + u * (HEAD_Z - TAIL_Z);
      const rx = Math.max(0.01, bodyRadius(z) * 0.96);
      const ry = Math.max(0.01, bodyDepth(z) * 0.96);
      const drop = 0.06 * (ry / RY_MAX) + 0.015;
      const arc = spineY(z);
      const pts = [];
      for (let k = 0; k < BELLY_POINTS; k++) {
        const a = (k / BELLY_POINTS) * Math.PI * 2;
        pts.push([Math.cos(a) * rx, Math.sin(a) * ry + arc - drop]);
      }
      bellySections.push({ z, pts });
    }
    const bellyGeo = loft(bellySections, { closed: true, cap: true });
    const bellyMesh = bindSkin(new THREE.Mesh(bellyGeo, bellyMaterial), root, bodyWeight);
    bellyMesh.name = 'ink-eel-yuan-belly';
    group.add(bellyMesh);

    // -----------------------------------------------------------------------
    // 6) Seven short dorsal spines: a row of cones on the ridge, interleaved with
    //    the nine squares so nothing collides. Bone chain + skinning — this
    //    creature has no paired fins, so makeFin has nothing to attach to.
    // -----------------------------------------------------------------------

    const spikeGeo = new THREE.ConeGeometry(0.035, 0.2, 5, 1);
    for (let i = 0; i < DORSAL_SPINES; i++) {
      const u = 0.115 + (i * 0.66) / (DORSAL_SPINES - 1);
      const z = TAIL_Z + u * (HEAD_Z - TAIL_Z);
      const base = dorsalY(z);
      const h = 0.1 + 0.12 * (1 - u);
      const spike = new THREE.Mesh(spikeGeo, inkMaterial);
      spike.position.set(0, base + h * 0.5 - 0.015, z);
      spike.rotation.x = 0.3; // rake the tip caudally
      spike.scale.y = h / 0.2;
      // Mesh transform is set before bindSkin and never touched again: it becomes
      // part of bindMatrix, so the stretch pivots on the cone's own centre.
      const mesh = bindSkin(spike, root, bodyWeight);
      mesh.name = `ink-eel-yuan-spike${i}`;
      group.add(mesh);
    }

    // -----------------------------------------------------------------------
    // 7) Nine 2cm amber squares embedded along the spine. One mesh each: their
    //    brightness is independent, which is what makes the cursor-walk read.
    // -----------------------------------------------------------------------

    const spotGeo = new THREE.BoxGeometry(SPOT_SIZE, SPOT_SIZE, SPOT_SIZE);
    const spots = [];
    for (let i = 0; i < SPOT_COUNT; i++) {
      const u = 0.06 + (i * 0.88) / (SPOT_COUNT - 1);
      const z = TAIL_Z + u * (HEAD_Z - TAIL_Z);
      const spot = new THREE.Mesh(spotGeo, amberMaterial.clone());
      spot.position.set(0, dorsalY(z) - SPOT_SIZE * 0.3, z);
      const mesh = bindSkin(spot, root, bodyWeight);
      mesh.name = `ink-eel-yuan-spot${i}`;
      spots.push(mesh);
      group.add(mesh);
    }

    // -----------------------------------------------------------------------
    // 8) Three gill pairs. Each slit is a flap on its own bone — a bone chain plus
    //    skinning — hinged along the body axis at its ventral edge so it swings
    //    outward like an operculum. Bone rotation opens it; a mesh transform would
    //    pivot on the world origin instead of the hinge.
    // -----------------------------------------------------------------------

    const gills = [];
    for (let pair = 0; pair < GILL_PAIRS; pair++) {
      const z = -0.15 - pair * 0.3;
      const r = Math.max(0.05, bodyRadius(z));
      const h = bodyDepth(z) * 1.15;
      const hingeY = spineY(z) - h * 0.45;
      for (const side of [-1, 1]) {
        const bone = new THREE.Bone();
        bone.name = `gill${pair}${side < 0 ? 'l' : 'r'}`;
        // The skull's rest frame is a pure translation (no rotation), so a world
        // point becomes a local offset by subtracting the skull's position.
        bone.position.set(side * (r + 0.005), hingeY - SKULL_Y, z - SKULL_Z);
        bones.skull.add(bone);

        const geo = new THREE.BoxGeometry(0.03, h, 0.11);
        geo.translate(0, h * 0.5, 0); // bottom edge onto the hinge
        geo.translate(side * (r + 0.005), hingeY, z);
        const mesh = bindSkin(new THREE.Mesh(geo, inkMaterial), root, (name) =>
          name === bone.name ? 1 : 0,
        );
        mesh.name = `ink-eel-yuan-gill${pair}${side < 0 ? 'l' : 'r'}`;
        gills.push({ bone, side });
        group.add(mesh);
      }
    }

    // Ink mist: one puff trailing back from the gills. Opacity and position only
    // — a mesh-level scale would pivot on the world origin.
    const mistGeo = new THREE.SphereGeometry(0.2, 10, 8);
    mistGeo.scale(1.0, 0.85, 2.2);
    const MIST_BASE = new THREE.Vector3(0.62, spineY(-1) - 0.03, -1.1);
    mistGeo.translate(MIST_BASE.x, MIST_BASE.y, MIST_BASE.z);
    const mistMesh = bindSkin(new THREE.Mesh(mistGeo, mistMaterial), root, (name) =>
      name === 'skull' ? 1 : 0,
    );
    mistMesh.name = 'ink-eel-yuan-mist';
    group.add(mistMesh);

    // -----------------------------------------------------------------------
    // 9) Face: movable jaw + nictitating membrane + two amber eye dots
    // -----------------------------------------------------------------------

    // Pointed-snout jaw. The hinge sits at the snout root; as the jaw rotates the
    // chin sweeps down and caudally, which is the readable part of the 60° gape
    // (cast.json:37).
    const JAW_PIVOT = new THREE.Vector3(0, spineY(0.3) - bodyDepth(0.3) - 0.005, 0.3);
    const jaw = makeJaw(bones.skull, {
      pivot: [JAW_PIVOT.x, JAW_PIVOT.y, JAW_PIVOT.z],
      range: [0, JAW_OPEN],
      axis: [1, 0, 0],
    });
    // makeJaw sizes its shell for a ~0.3m head. Scaling the mesh would pivot on
    // the world origin and fling the shell off the head, so the scale goes into
    // the geometry about the hinge — the shell then grows around its own pivot.
    const jawGeo = jaw.mesh.geometry;
    jawGeo.translate(-JAW_PIVOT.x, -JAW_PIVOT.y, -JAW_PIVOT.z);
    jawGeo.scale(0.8, 1.6, 3.0);
    jawGeo.translate(JAW_PIVOT.x, JAW_PIVOT.y, JAW_PIVOT.z);
    jawGeo.computeVertexNormals();
    jaw.mesh.material = inkMaterial;
    jaw.mesh.name = 'ink-eel-yuan-jaw';
    group.add(jaw.mesh);

    // Nictitating membrane. This eel has no eyelids — the blink is the two amber
    // dots dimming together (cast.json:38) — so makeEyelids is assembled as the
    // mechanism that sweeps a dark film across the eye while the visible blink
    // stays on the dots' own clock below.
    const membrane = makeEyelids(bones.skull, { count: 1, range: [0, 0.5], axis: [1, 0, 0] });
    const lidRoot = membrane.bone.parent; // the assembly's lidroot bone under the skull
    // The assembly writes its shell at (0, LID_UP, LID_FORWARD) in WORLD space but
    // puts the lid bone at the same offset in the SKULL's frame — the two only
    // coincide when the head bone sits at the origin, and this one does not. So
    // the sub-chain and the shell need different deltas, differing by exactly the
    // skull's position, to meet at the eye.
    const EYE_Z = 0;
    const EYE_X = bodyRadius(EYE_Z) + 0.01;
    const EYE_Y = spineY(EYE_Z);
    const eye = new THREE.Vector3(EYE_X, EYE_Y, EYE_Z);
    const skullPos = new THREE.Vector3(0, SKULL_Y, SKULL_Z);
    const lidOffset = new THREE.Vector3(0, 0.035, 0.114); // hingeY / hingeZ, rig.js:556-557
    lidRoot.position.copy(eye).sub(skullPos).sub(lidOffset);
    const membraneGeo = membrane.mesh.geometry;
    membraneGeo.translate(
      eye.x - lidOffset.x,
      eye.y - lidOffset.y,
      eye.z - lidOffset.z,
    );
    // Scale about the new hinge so the weights (computed on the original shell)
    // keep every vertex inside their support. The result is a thin radial plate
    // lying along the head's flank: narrow in x, taller in y, shallow in z.
    membraneGeo.translate(-eye.x, -eye.y, -eye.z);
    membraneGeo.scale(0.35, 1.6, 2.4);
    membraneGeo.translate(eye.x, eye.y, eye.z);
    membraneGeo.computeVertexNormals();
    membrane.mesh.material = inkMaterial;
    membrane.mesh.name = 'ink-eel-yuan-membrane';
    group.add(membrane.mesh);

    // Two 3mm amber dots, half-buried in the flank. One shared material, so they
    // always dim together (cast.json:38).
    const eyeGeo = new THREE.BoxGeometry(EYE_SIZE, EYE_SIZE, EYE_SIZE);
    const eyeMaterial = amberMaterial.clone();
    for (const side of [-1, 1]) {
      const dot = new THREE.Mesh(eyeGeo, eyeMaterial);
      dot.position.set(side * (EYE_X - EYE_SIZE * 0.35), EYE_Y, EYE_Z);
      const mesh = bindSkin(dot, root, (name) => (name === 'skull' ? 1 : 0));
      mesh.name = `ink-eel-yuan-eye${side < 0 ? 'l' : 'r'}`;
      group.add(mesh);
    }

    group.userData.materials = {
      ink: inkMaterial,
      belly: bellyMaterial,
      amber: amberMaterial,
      mist: mistMaterial,
    };
    if (scene) scene.add(group);

    // -----------------------------------------------------------------------
    // update — pure function of (t, ctx).
    //   pose:       'cruise' (default) the 2.5-wavelength sine swim
    //               'lurk'   rest arc + a slow breathing wave
    //               'roll'   one turnover: the mid-body twists belly-up, the gills
    //                        flare once and the mist puffs once
    //   expression: 'cursor' (default) nine squares light head->tail then die the
    //                        same way, looping
    //               'all'    all nine light together for half a second, then die
    //                        head->tail
    //               'off'
    //   poseT / exprT: optional clocks in seconds for one-shot cues; they default
    //               to t, so continuous poses need nothing extra.
    // -----------------------------------------------------------------------

    const chain = chainNames.map((name) => bones[name]);
    const acc = new Array(chain.length);

    function rollEnvelope(pt) {
      if (pt < 0) return 0;
      if (pt < ROLL_UP) return smooth(pt / ROLL_UP);
      if (pt < ROLL_UP + ROLL_HOLD) return 1;
      if (pt < ROLL_UP + ROLL_HOLD + ROLL_DOWN) {
        return 1 - smooth((pt - ROLL_UP - ROLL_HOLD) / ROLL_DOWN);
      }
      return 0;
    }

    function spotLevel(i, et, expr) {
      if (expr === 'off') return 0;
      if (expr === 'all') {
        // Every square lights at once for half a second, then they die head->tail.
        const period = 0.5 + SPOT_COUNT * SPOT_STEP + SPOT_RAMP + 2.0;
        const tt = ((et % period) + period) % period;
        if (tt < 0.5) return 1;
        const d = tt - 0.5 - i * SPOT_STEP;
        return d <= 0 ? 1 : clamp01(1 - d / SPOT_RAMP);
      }
      // Cursor walk: the head of the sweep is bright and the squares behind it
      // fade to a floor — one bright cursor walking the line with a trail — then
      // the row dies one by one the same way (cast.json:38).
      const period = 2 * (SPOT_COUNT * SPOT_STEP) + SPOT_HOLD + 2 * SPOT_RAMP;
      const tt = ((et % period) + period) % period;
      const lightAt = i * SPOT_STEP;
      if (tt < lightAt) return clamp01((tt - (lightAt - SPOT_RAMP)) / SPOT_RAMP);
      const dieAt = SPOT_COUNT * SPOT_STEP + SPOT_HOLD + i * SPOT_STEP;
      if (tt < dieAt) return 1 - 0.65 * clamp01((tt - lightAt) / (2 * SPOT_STEP));
      return 1 - clamp01((tt - dieAt) / SPOT_RAMP);
    }

    function update(t, updateCtx) {
      const time = Number.isFinite(t) ? t : 0;
      const c = updateCtx || {};
      const pose = c.pose || 'cruise';
      const expr = c.expression || 'cursor';
      const pt = Number.isFinite(c.poseT) ? c.poseT : time;
      const et = Number.isFinite(c.exprT) ? c.exprT : time;

      // --- gills + mist: breathing, or one flare through the roll ------------
      let gill;
      let mistAmount;
      if (pose === 'roll') {
        gill = bell(pt / GILL_ROLL_SEC);
        mistAmount = bell(pt / MIST_ROLL_SEC);
      } else {
        const s = Math.sin((Math.PI * 2 * (time % BREATH_PERIOD)) / BREATH_PERIOD);
        gill = 0.4 * s * s;
        mistAmount = gill * 0.55;
      }
      mistMaterial.opacity = 0.55 * mistAmount;
      mistMesh.position.set(0, -0.3 * mistAmount, -0.55 * mistAmount);
      for (const g of gills) {
        // Right flap swings out under a negative Z rotation, left under positive.
        g.bone.quaternion.setFromAxisAngle(WORLD_Z, -g.side * gill * 0.9);
      }

      // --- nine amber squares -------------------------------------------------
      for (let i = 0; i < spots.length; i++) {
        const level = spotLevel(i, et, expr);
        spots[i].material.color.copy(amberColor).multiplyScalar(0.25 + 0.75 * level);
        spots[i].material.emissiveIntensity = 0.15 + 2.6 * level;
      }

      // --- blink: two dots dim together, on their own clock -------------------
      // The offset keeps t=0 an open-eyed frame: a blink landing exactly on the
      // first captured frame would read as a defect, not a blink.
      const blinkPhase = ((time + 1.3) % BLINK_PERIOD + BLINK_PERIOD) % BLINK_PERIOD;
      const eyeLevel = blinkPhase < BLINK_SEC ? 0.12 : 1;
      eyeMaterial.color.copy(amberColor).multiplyScalar(0.3 + 0.7 * eyeLevel);
      eyeMaterial.emissiveIntensity = 0.2 + 1.8 * eyeLevel;

      // --- body pose ----------------------------------------------------------
      // Per-bone angles are differences of the target tangent, so the rotation
      // accumulated at each bone equals the wave's tangent there (FK stacks them).
      if (pose === 'roll') {
        const rho = Math.PI * rollEnvelope(pt);
        for (let i = 0; i < chain.length; i++) {
          const u = clamp01((restZ[chainNames[i]] - TAIL_Z) / (HEAD_Z - TAIL_Z));
          // A ramp over the middle third leaves head and tail in place and twists
          // the mid-body over — a rolling wave, not a rigid cartwheel.
          acc[i] = rho * smooth((u - 0.15) / 0.7);
        }
      } else if (pose === 'lurk') {
        for (let i = 0; i < chain.length; i++) {
          acc[i] =
            0.035 * Math.sin((Math.PI * 2 * restZ[chainNames[i]]) / 13 + (Math.PI * 2 * time) / 6);
        }
      } else {
        for (let i = 0; i < chain.length; i++) {
          acc[i] = Math.atan(
            SWIM_AMP * SWIM_K * Math.cos(SWIM_K * (restZ[chainNames[i]] - TAIL_Z) + SWIM_W * time),
          );
        }
      }
      // Lateral undulation turns about Y (the dorsoventral axis) so the chain
      // actually sweeps sideways; the roll turns about Z (the body axis); the
      // lurking breath turns about X and rides on top of the rest arc.
      const axis = pose === 'roll' ? WORLD_Z : pose === 'lurk' ? WORLD_X : WORLD_Y;
      for (let i = 0; i < chain.length; i++) {
        const d = acc[i] - (i > 0 ? acc[i - 1] : 0);
        chain[i].quaternion.setFromAxisAngle(axis, d);
      }

      // --- jaw: breath-linked gape, wide open through the roll ----------------
      // makeJaw's own talk cadence is deliberately unused — this creature does
      // not speak.
      const breath = Math.sin((Math.PI * 2 * (time % BREATH_PERIOD)) / BREATH_PERIOD);
      const gape = pose === 'roll' ? 0.55 * bell(pt / GILL_ROLL_SEC) : 0.1 + 0.08 * breath;
      jaw.bone.quaternion.setFromAxisAngle(WORLD_X, gape);

      membrane.update(time);
    }

    // Naming table for the director and the ink-pass id assignment: every bone in
    // the rendered graph, assemblies included.
    const allBones = [];
    root.traverse((o) => {
      if (o.isBone) allBones.push(o.name);
    });

    return { group, bones: allBones, update };
  },
};
