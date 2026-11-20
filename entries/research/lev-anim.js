import * as THREE from 'three';
import { track, smooth, smoother, invLerp, lerp, deg, onTwos } from './util.js';

// Every surface beat of the monster as a pure function of film time. Drawn on twos: huge things
// keep a slight hold, and t quantised here makes the whole rig step like drawings.
// The big arcs are key-drawn: each key is the body as a curve (tail to head), keys are splined
// through time, and the spine is laid on the curve by arc length so nothing stretches.
const V = THREE.Vector3;
const _a = new V(), _b = new V(), _c = new V();

export const SHOTS_MINE = new Set(['s14', 's15', 's18', 's19', 's20', 's21', 's22', 's24', 's38', 's39']);

// ---------------------------------------------------------------- key-drawn body curves
// keys: [[t, [x,y,z, x,y,z, ...]], ...] -> continuous (no stop at each key) flat array at t
function vecCurve(keys) {
  const n = keys.length;
  const m = keys.map((k, i) => {
    const a = keys[Math.max(0, i - 1)], b = keys[Math.min(n - 1, i + 1)];
    return k[1].map((_, c) => (b[1][c] - a[1][c]) / (b[0] - a[0] || 1));
  });
  const out = new Float32Array(keys[0][1].length);
  return (t) => {
    if (t <= keys[0][0]) { out.set(keys[0][1]); return out; }
    if (t >= keys[n - 1][0]) { out.set(keys[n - 1][1]); return out; }
    let i = 0; while (t > keys[i + 1][0]) i++;
    const h = keys[i + 1][0] - keys[i][0], u = (t - keys[i][0]) / h, u2 = u * u, u3 = u2 * u;
    const A = keys[i][1], B = keys[i + 1][1];
    for (let c = 0; c < out.length; c++) out[c] = (2 * u3 - 3 * u2 + 1) * A[c] + (u3 - 2 * u2 + u) * h * m[i][c] + (-2 * u3 + 3 * u2) * B[c] + (u3 - u2) * h * m[i + 1][c];
    return out;
  };
}

const NC = 110;
const cPts = Array.from({ length: NC + 1 }, () => new V());
const cLen = new Float32Array(NC + 1);
function layCurve(c) {
  const m = c.length / 3;
  const get = (i, k) => {
    if (i < 0) return 2 * c[k] - c[3 + k];
    if (i >= m) return 2 * c[(m - 1) * 3 + k] - c[(m - 2) * 3 + k];
    return c[i * 3 + k];
  };
  for (let i = 0; i <= NC; i++) {
    const f = (i / NC) * (m - 1), j = Math.min(Math.floor(f), m - 2), t = f - j, t2 = t * t, t3 = t2 * t;
    for (let k = 0; k < 3; k++) {
      const p0 = get(j - 1, k), p1 = get(j, k), p2 = get(j + 1, k), p3 = get(j + 2, k);
      cPts[i].setComponent(k, 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3));
    }
  }
  cLen[NC] = 0;
  for (let i = NC - 1; i >= 0; i--) cLen[i] = cLen[i + 1] + cPts[i].distanceTo(cPts[i + 1]);
}
// a point d metres back from the head end of the curve; straight extrapolation past both ends
function atDist(d, out) {
  if (d <= 0) { _c.copy(cPts[NC]).sub(cPts[NC - 1]).normalize(); return out.copy(cPts[NC]).addScaledVector(_c, -d); }
  if (d >= cLen[0]) { _c.copy(cPts[0]).sub(cPts[1]).normalize(); return out.copy(cPts[0]).addScaledVector(_c, d - cLen[0]); }
  let lo = 0, hi = NC;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cLen[mid] > d) lo = mid; else hi = mid; }
  const f = (cLen[lo] - d) / Math.max(cLen[lo] - cLen[hi], 1e-6);
  return out.lerpVectors(cPts[lo], cPts[hi], f);
}
const _sk = new V(), _skT = new V();
function layBody(api, flat, upFn, p = {}) {
  layCurve(flat);
  const off = p.slide ?? 0, k = p.scale ?? 1, len = api.L * k, s0 = p.skull ?? 2;
  // the skull is bone: from s0 on it runs dead straight off the neck instead of bending along the curve
  if (s0 < 1) { atDist(off + (1 - s0) * len, _sk); atDist(off + (1.04 - s0) * len, _skT); _skT.subVectors(_sk, _skT).normalize(); }
  api.path((s, out) => (s > s0 ? out.copy(_sk).addScaledVector(_skT, (s - s0) * len) : atDist(off + (1 - s) * len, out)), upFn, p);
}

// ---------------------------------------------------------------- the breach (s20–21), film-time keys
export const BREACH_Z = -560;
const BREACH_SCALE = 1.5;          // small enough that the whole arc reads in frame
// One parabola through the air: x at constant speed, y ballistic, so it leaves the sea fast, slows to the
// top and goes over. The body rides that single curve head first, so the crown stays where it broke.
const BR = { x0: -330, vx: 100, tc: 34.8, ta: 39.4, H: 330 };
const brP = (t) => { const q = (t - BR.ta) / (BR.ta - BR.tc); return [BR.x0 + BR.vx * (t - BR.tc), BR.H * (1 - q * q), BREACH_Z - 140 + 26 * (t - BR.tc)]; };
const BREACH_ARC = new Float32Array(Array.from({ length: 35 }, (_, i) => brP(29 + i * 0.4)).flat());
const BREACH_RUN = [];             // [t, metres of arc still ahead of the head]
for (let i = 0, d = 0; i < 90; i++) {
  const t = 42.6 - i * 0.1, a = brP(t), b = brP(t - 0.1);
  BREACH_RUN.unshift([t, d, (u) => u]);
  d += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// the dying flip (s39): shapes from the reference, in the gap between two ships
export const FLIP_Z = -880;
const fk = (pts) => pts.flatMap(([x, y], i) => [x, y, FLIP_Z + (i - 2) * 46]);
const flipKeys = vecCurve([
  [76.4, fk([[-60, -700], [-30, -450], [0, -200], [40, 60], [80, 320]])],
  [77.0, fk([[-175, -260], [-110, 0], [-20, 215], [70, 370], [140, 520]])],
  [77.8, fk([[-230, -130], [-185, 130], [-65, 295], [115, 365], [300, 345]])],
  [78.3, fk([[-250, 330], [-190, 215], [-20, 170], [180, 175], [345, 215]])],
  [78.8, fk([[-235, 450], [-160, 235], [-30, 70], [155, 30], [340, 72]])],
  [79.25, fk([[-300, 200], [-170, 30], [-20, -60], [150, -50], [320, 40]])],
  [79.9, fk([[-330, 70], [-170, -10], [0, -40], [170, -20], [340, 40]])],
  [80.4, fk([[-330, 70], [-170, -10], [0, -40], [170, -20], [340, 40]])],
]);
// the keys give the shape; the centre of mass is ballistic, so it climbs, slows, and comes down on its back
function flipFall(t) {
  const f = flipKeys(t), n = f.length / 3, q = t - 77.75, y = 290 - 104 * q * q;
  let my = 0;
  for (let i = 1; i < f.length; i += 3) my += f[i] / n;
  for (let i = 1; i < f.length; i += 3) f[i] += y - my;
  return f;
}

// tail (top, far) down the ridge toward the camera, head deep under the fog
const S24_CURVE = new Float32Array([0, 262, -470, 4, 196, -270, 0, 104, -90, 0, 16, 60, 0, -150, 210, 0, -420, 320, 0, -700, 420]);

// ---------------------------------------------------------------- staging the fleet per shot
// The ocean fleet belongs to Ships; for the monster's shots the reference wants particular
// layouts, so its public entries are repositioned here and restored for everyone else.
// [x, z, heading, speed]; a null entry is hidden.
const PI = Math.PI;
const BREACH_FLEET = [[6, -140, PI, 6, 340], [-238, -118, -PI + 0.35, 6, 340], [310, -60, PI - 0.5, 6, 320], [150, -400, PI - 0.15, 6, 340], [-372, -1320, -PI + 0.18, 6, 300], [690, -1780, PI - 0.28, 6, 300]];
const LURE_FLEET = [null, null, null, null, null, [960, -2350, PI / 2 + 0.12, 5]];
const FLEET = {
  s14: [[-905, 240, PI - 0.1, 7], [-1040, -240, PI - 0.14, 7], [810, 40, PI + 0.13, 7], null, null, [1500, -2900, PI + 0.06, 7]],
  s18: LURE_FLEET, s19: LURE_FLEET,
  s20: BREACH_FLEET, s21: BREACH_FLEET,
  s38: [[-900, -1300, PI / 2, 2], [960, -1250, -PI / 2, 2], null, null, null, null],
  s39: [[-372, -150, PI / 2, 2, 200], [430, -120, -PI / 2, 2, 200], [-250, -2300, PI, 3, 400], [400, -2700, PI, 3, 400], [90, -3300, PI, 3, 400], null],
};
function stageFleet(ctx, st) {
  const fl = ctx.ships?.fleet;
  if (!fl) return;
  const L = FLEET[st.sid];
  fl.forEach((f, i) => {
    if (f.pos0 === undefined) return;
    f._o ??= { pos0: f.pos0, heading: f.heading, speed: f.speed, hide: f.hide };
    if (L) {
      const e = L[i];
      f.hide = !e;
      if (e) { f.pos0 = [e[0], 0, e[1]]; f.heading = e[2]; f.speed = e[3]; f.root.rotation.y = e[2]; f.wake = e[4]; }
      f.pitch = 0; f.roll = 0; f.sink = 0;
      f.staged = true;
    } else if (f.staged) {
      f.pos0 = f._o.pos0; f.heading = f._o.heading; f.speed = f._o.speed; f.hide = f._o.hide; f.root.rotation.y = f._o.heading; f.wake = undefined;
      f.pitch = 0; f.roll = 0; f.sink = 0;
      f.staged = false;
    }
  });
}

function hideAll(api) {
  api.show(false);
  for (const w of api.lures) w.show(false);
  for (const w of api.pod) w.show(false);
  api.run.value = 0; api.foam.value = 0; api.lureRun.value = 0; api.lureFoam.value = 0; api.podRun.value = 0;
}

// s15: where each whale breaks the surface, seen from the port rail
export const POD = [[-322, -402, 0.0, 0.92], [-205, -352, 0.28, 1.16], [-205, -590, 0.14, 1.0], [-120, -536, 0.4, 0.88]];

const LX = [-214, -84, 78, 206], LZ = [12, 24, -12, 6], LH = [196, 262, 274, 210], LD = [0.12, 0.0, 0.05, 0.2], LLEAN = [-0.15, -0.05, 0.1, 0.2];
export const HEAD_Z0 = 300;
// s19, the swallow, per whale: drop start, duration, extra height in the mouth, hop before it falls, tumble, roll
const SW_T = [34.62, 34.3, 34.78, 34.46], SW_D = [0.5, 0.58, 0.46, 0.54];
const SW_Y = [-30, 110, 45, -55], SW_HOP = [46, 62, 22, 34];
const SW_SPIN = [-1.4, 2.3, -2.6, 1.1], SW_ROLL = [1.2, -1.6, 0.8, -2];

export function animate(ctx, api, st) {
  hideAll(api);
  stageFleet(ctx, st);
  const t = onTwos(st.t), sid = st.sid;
  const C = ctx.CUES;

  if (sid === 's14') {
    // a colossal shape glides under the fleet
    const k = invLerp(21.57, 23.17, t);
    ctx.world?.seaShadow?.({ x: lerp(250, 215, k), z: lerp(-1180, -1280, k), heading: deg(198), strength: 1, halfLength: 1500, halfWidth: 290 });
  }

  if (sid === 's15') {
    // four real breaches, seen from the port rail. Timed to the water FX: the head breaks the surface
    // on each breach ring (whalesRise + i * 0.22), the nose goes back in on the dive fountains, the flukes last.
    // x runs -1 (head out) .. 1 (flukes in). The centre of mass is ballistic: launched at full speed, a
    // true parabola, constant speed over the water, so nothing eases in or hangs at the top.
    // Everything below is one continuous spline through the keys, so no joint stops at a key.
    //            x      pitch roll  arch  flukes sweepL droopL sweepR droopR
    const K = vecCurve([
      [-1.3, [84, -34, -0.14, -0.9, 1.3, 0.55, 1.3, 0.55]],
      [-0.9, [79, -18, -0.06, 0.1, 1.25, 0.5, 1.3, 0.55]],
      [-0.55, [74, 0, 0.04, 0.5, 0.95, 0.28, 1.15, 0.42]],
      [-0.2, [60, 28, 0.16, -0.1, 0.45, 0.08, 0.8, 0.2]],
      [0.1, [34, 72, 0.28, -0.2, 0.3, 0.14, 0.36, 0.14]],
      [0.4, [-4, 112, 0.36, 0.2, 0.42, 0.26, 0.46, 0.28]],
      [0.7, [-48, 146, 0.32, 0.6, 0.8, 0.4, 0.8, 0.42]],
      [1.0, [-78, 168, 0.22, 0.9, 1.2, 0.58, 1.2, 0.58]],
      [1.3, [-88, 178, 0.14, 1.1, 1.3, 0.62, 1.3, 0.62]],
    ]);
    const YAW = [71, 56, 78, 64], SPIN = [1, -1, 1, -1];
    for (let i = 0; i < 4; i++) {
      const w = api.pod[i], [x0, z0, , sc] = POD[i];
      const a = C.whalesRise + i * 0.22, D = 3.2, x = (t - a - D / 2) / (D / 2);
      const L = w.len * sc, yaw = deg(YAW[i]);
      const y = (0.72 - 1.15 * x * x) * L;
      const run = (x + 0.85) * 0.3 * L;
      // the body keeps its slant through the climb, goes over the top and down nose first, the tail last;
      // the roll is the twist it left the water with: on its side at the top, on its back as it falls
      const [pitch, r0, B, fl, sL, dL, sR, dR] = K(x);
      const roll = deg(r0) * SPIN[i];
      // the arch stays in the plane of the arc whatever the roll has done
      w.pose({ pos: [x0 + Math.sin(yaw) * run, y, z0 + Math.cos(yaw) * run], yaw, pitch: deg(pitch), roll,
        bend: B * Math.cos(roll), side: -B * Math.sin(roll), wave: 0.5 * smooth(invLerp(-0.3, -1.1, x)), phase: t * 5 + i,
        flipL: { sweep: sL, droop: dL, curl: 0.06 }, flipR: { sweep: sR, droop: dR, curl: 0.06 },
        flukes: fl });        // the last kick leaves the water with it, then they trail the arc and lift
      w.show(x > -1.28 && x < 1.3);
    }
    api.podRun.value = 0.7;
  }

  if (sid === 's18' || sid === 's19') {
    const lt = t - C.lures, Tm = C.mawRises;
    // the head comes up behind them, snout to the sky, jaws gaping toward camera
    const hingeY = track([[32.6, -300], [33.5, -70], [34.0, 110], [34.4, 210], [34.8, 290], [35.1, 340], [35.5, 372]], t);
    const headZ = track([[32.6, HEAD_Z0], [33.6, HEAD_Z0 + 16], [34.3, HEAD_Z0 + 120], [34.9, HEAD_Z0 + 250], [35.5, HEAD_Z0 + 350]], t);
    // the neck rears and the head tips forward, so the open mouth keeps looking down at camera
    const pitch = track([[32.6, 30], [33.8, 33], [34.3, 22], [34.7, 10], [35.0, 5], [35.5, 3]], t);
    const jaw = track([[32.6, 1.0], [34.0, 1.05], [34.6, 1.24], [35.0, 1.24], [35.3, 1.2], [35.5, 1.08]], t);
    api.pose({ center: 0.80, pos: [0, hingeY, headZ], yaw: 0, pitch: deg(pitch), roll: 0, jaw, wide: 0.56, scale: 1.25, flipL: { sweep: 1.42, droop: 0.34, curl: 0.03 }, flipR: { sweep: 1.42, droop: 0.34, curl: 0.03 }, curlFn: (s) => (s > 0.4 && s < 0.78 ? 0.055 : 0) });
    api.show(t > 32.5);
    api.run.value = lerp(0.55, 0.82, smooth(invLerp(33.6, 34.8, t)));
    api.foam.value = 14;
    const close = smooth(invLerp(Tm + 0.72, Tm + 1.55, t));        // the lures are drawn down as the jaws shut
    const conv = smooth(invLerp(Tm + 0.1, Tm + 1.1, t));
    for (let i = 0; i < 4; i++) {
      const w = api.lures[i], Tp = 1.9, tau = Math.max(0, t - (C.lures + LD[i] - 0.4)), past = Math.max(0, tau - Tp) / Tp;
      // a thrown body: leaves the water at full speed, gravity alone slows it, it tops out and sinks back
      // on the stalk (tau > Tp) until the rising maw takes over; it never eases in and never hangs
      const up = tau < Tp ? 1 - (1 - tau / Tp) ** 2 : 1 - 0.75 * past * past;
      const surge = (1 - Math.min(1, tau / Tp)) ** 2;              // what is left of the launch speed
      const over = smooth(invLerp(0.62, 1.5, tau / Tp));           // the momentum carrying the top of it over
      const T = w.len + w.neck, wl = w.len;
      const x = (LX[i] * 0.88 + LLEAN[i] * 330 * surge + LLEAN[i] * 46 * over) * lerp(1, 0.6, conv) * lerp(1, 0.6, close);
      const riseK = smooth(invLerp(33.7, 34.5, t));
      const y = lerp(lerp(-70, LH[i] * 0.84, up), hingeY + 30 + LH[i] * 0.06, riseK) + 7 * Math.sin(lt * 1.3 + i * 2) - close * 60;
      const z = headZ + LZ[i] + 150 + 34 * up - 380 * close;
      // it comes out slanted and swings up through its lean, the top still travelling
      const lean = LLEAN[i] * lerp(-0.9, 1 + 0.55 * over, 1 - surge) * (1 + conv * 0.9) + 0.9 * surge * Math.sign(LLEAN[i]);
      const dir = new V(Math.sin(lean), Math.cos(lean), 0.1 * conv + 0.95 * riseK + 0.34 * over * (1 - riseK)).normalize();
      const head = new V(x, y, z);
      const tailP = head.clone().addScaledVector(dir, -wl).add(_b.set(-Math.sin(lean) * 16, 0, -6));
      const rootP = api.lureRoot(i, new V());
      const ctrl = rootP.clone().lerp(tailP, 0.55).add(_b.set(-lean * 40, -40, 0));
      const stalk = new THREE.QuadraticBezierCurve3(rootP, ctrl, tailP);
      const sN = w.neck / T;
      const wig = 0.1 * Math.sin(lt * 1.5 + i);
      // the roll it left the water with unwinds through belly-on and past it; the tail lags the head
      const spin = (i % 2 ? -1 : 1) * (1.15 * (1 - tau / Tp) * (tau < Tp ? 1 : 0) - 0.3 * over) * (1 - riseK);
      w.path((s, out) => {
        if (s <= sN) return stalk.getPoint(s / sN, out);
        const u = (s - sN) / (1 - sN);                  // whale proper: slight S so it isn't a rod
        out.copy(tailP).addScaledVector(dir, wl * u);
        const b = Math.sin(u * Math.PI);
        // the back arches as the head goes over
        out.x += wig * b * 40 - lean * 26 * b; out.z += 10 * b * b - 44 * over * (1 - riseK) * b;
        return out;
      }, (s, out) => out.set(lean * 0.3, 0.14, -1).normalize().applyAxisAngle(dir, spin * smooth(invLerp(sN * 0.7, 1, s))), {
        flipL: { sweep: lerp(1.3, 0.62, up), droop: 0.22 + 0.34 * surge + 0.12 * past + 0.08 * Math.sin(lt * 2.1 + i), twist: 0.5, curl: 0.06 },
        flipR: { sweep: lerp(1.3, 0.62, up), droop: 0.22 + 0.34 * surge + 0.12 * past + 0.08 * Math.sin(lt * 1.8 + i * 3), twist: 0.5, curl: 0.06 },
        jaw: 0.05 * up, flukes: 0.3 + 0.7 * surge * Math.sin(lt * 7 + i) });
      w.show(y > -60 && close < 0.8);
    }
    api.lureRun.value = 0.72;
  }

  // s19, the swallow: the block above stands the head up. From here each whale stays held in the mouth
  // with it, then drops past the lower lip tumbling, and only then do the jaws slam on them.
  if (sid === 's19' && t > C.mawRises + 0.72) {
    const Tm = C.mawRises, lt = t - C.lures, H = api.spine.at(38 / 47, new V());
    const A = api.spine.toWorld(_a.set(0, 0, 860), new V()).sub(H).normalize();
    const U = api.spine.toWorld(_a.set(0, 100, 720 + 7), new V()).sub(H).normalize();
    const conv = smooth(invLerp(Tm + 0.1, Tm + 1.1, t)), riseK = smooth(invLerp(33.7, 34.5, t));
    for (let i = 0; i < 4; i++) {
      const w = api.lures[i], wl = w.len, up = smoother(invLerp(C.lures + LD[i] - 0.62, C.lures + LD[i] + 1.85, t));
      // one at a time: each has its own height in the mouth, its own moment, its own speed and tumble
      const f = Math.min(1, Math.max(0, (t - SW_T[i]) / SW_D[i])), fall = f * f;
      const x0 = LX[i] * lerp(1, 0.6, conv);
      const hold = new V(x0, lerp(lerp(-70, LH[i], up), H.y + 30 + LH[i] * 0.06, riseK) + 7 * Math.sin(lt * 1.3 + i * 2) + SW_Y[i] * smooth(invLerp(34.12, 34.5, t)), H.z + LZ[i] + 150 + 34 * up);
      hold.lerp(w.anchor('head', new V()), 1 - smooth(invLerp(Tm + 0.72, Tm + 1.62, t)));   // pick up from wherever the block above left it
      const end = H.clone().addScaledVector(A, -120).addScaledVector(U, -140).setX(x0 * 0.3);
      const head = hold.lerp(end, fall).addScaledVector(U, SW_HOP[i] * 4 * f * (1 - f));
      const lean = LLEAN[i] * lerp(1.7, 1, up) * (1 + conv * 0.9), spin = SW_SPIN[i] * fall, twist = SW_ROLL[i] * fall;
      const dx = Math.sin(lean), dy = Math.cos(lean), dz = (0.1 * conv + 0.95 * riseK) * (1 - 1.5 * fall);
      const dir = new V(dx * Math.cos(spin) - dy * Math.sin(spin), dx * Math.sin(spin) + dy * Math.cos(spin), dz).normalize();
      const tailP = head.clone().addScaledVector(dir, -wl).add(_b.set(-Math.sin(lean) * 16, 0, -6));
      const rootP = api.lureRoot(i, new V());
      const ctrl = rootP.clone().lerp(tailP, 0.55).add(_b.set(-lean * 40, -40, 0));
      const stalk = new THREE.QuadraticBezierCurve3(rootP, ctrl, tailP);
      const sN = w.neck / (w.len + w.neck), wig = 0.1 * Math.sin(lt * 1.5 + i), free = smooth(Math.min(1, f * 2.5));
      w.path((s, out) => {
        // the stalk lets go as it falls, drawn up into the tail, so it drops as a whale and not on a hose
        if (s <= sN) return stalk.getPoint(s / sN, out).lerp(_b.copy(tailP).addScaledVector(dir, -3 * (1 - s / sN)), free);
        const u = (s - sN) / (1 - sN), b = Math.sin(u * Math.PI);
        out.copy(tailP).addScaledVector(dir, wl * u);
        out.x += wig * b * 40 - lean * 26 * b; out.z += 10 * b * b;
        return out;
      }, (s, out) => out.set(lean * 0.3, 0.14, -1).normalize().applyAxisAngle(dir, twist), {
        flipL: { sweep: lerp(0.78, 1.4, fall), droop: 0.3 + 0.4 * fall * Math.sin(t * 19 + i), twist: 0.5, curl: 0.05 },
        flipR: { sweep: lerp(0.78, 1.4, fall), droop: 0.3 + 0.4 * fall * Math.sin(t * 17 + i * 3), twist: 0.5, curl: 0.05 },
        jaw: lerp(0.05 * up, 0.5, fall), flukes: 0.2 + 0.8 * fall });
      w.show(f < 1);
    }
    // the jaws gather, then come down with all their weight, the last whale still going in
    if (t > 34.98) {
      const j = track([[34.98, 1.24], [35.06, 1.32], [35.28, 0.06, (u) => u * u * u], [35.34, 0.17], [35.46, 0.05]], t);
      api.spine.uniforms.uJaw.value.set(j * 0.74, j * 0.26);
    }
  }

  if (sid === 's20' || sid === 's21') {
    const phi = deg(track([[35.5, 64], [37.4, 52], [39.8, 32], [41.2, 18], [42.4, 6]], t));
    const c = Math.cos(phi), s0 = Math.sin(phi);
    layBody(api, BREACH_ARC, (s, out) => out.set(0.1 * (1 - s), c, -s0).normalize(), {
      slide: track(BREACH_RUN, t), skull: 0.78,
      jaw: track([[35.5, 0.02], [39, 0.05], [41, 0.1], [42.4, 0.16]], t),
      flipL: { sweep: track([[35.5, 1.15], [38.2, 0.9], [41.6, 0.5]], t), droop: track([[35.5, 0.7], [38.2, 0.85], [41.6, 1.25]], t), twist: 0.3, curl: 0.06 },
      flipR: { sweep: track([[35.5, 1.2], [37.2, 0.42], [39.8, 0.3], [41.6, 0.4]], t), droop: track([[35.5, 0.7], [37.2, 0.05], [39.8, 0.55], [41.6, 1.22]], t), twist: track([[35.5, 0.1], [38, 0.45], [41.6, 0.2]], t), curl: 0.07 },
      flukes: 0.4 * Math.sin(t * 0.8), scale: BREACH_SCALE });
    api.show(true);
    api.run.value = track([[35.5, 0.95], [38.5, 0.8], [42, 0.5]], t);
    api.foam.value = 22;
  }

  if (sid === 's22') {
    // the belly slides past above the bridge windows, whatever the Ships camera is
    const c = st.cam, cam = new V(...c.pos), look = new V(...c.look), fwd = look.clone().sub(cam).normalize();
    const right = new V().crossVectors(fwd, new V(0, 1, 0)).normalize();
    const k = invLerp(C.belly, C.bigWave, t);
    const pos = cam.clone().addScaledVector(fwd, 700).add(new V(0, 200, 0)).addScaledVector(right, lerp(-260, 200, k));
    api.pose({ pos: pos.toArray(), yaw: Math.atan2(right.x, right.z), pitch: deg(track([[0, 16], [1, 4]], k)), roll: deg(84), spine: 0.3, center: 0.68,
      flipL: { sweep: 0.5, droop: 0.72, twist: 0.2, curl: 0.05 }, flipR: { sweep: 0.5, droop: 0.72, twist: 0.2, curl: 0.05 }, jaw: 0.25 });
    api.show(true);
    api.run.value = 0.5;
  }

  if (sid === 's24') {
    // the ridged tail stock climbs out of the fog to the spread flukes and slides under
    const k = invLerp(49.33, 51.3, t);
    layBody(api, S24_CURVE, (s, out) => out.set(0, 1, 0.35).normalize(), { slide: 345 - 150 * k - 900 * 0.7, flippers: 0.1, flukes: lerp(0.1, 0.5, k), scale: 1.7, fat: 3 });
    api.show(true);
    api.run.value = 0.8;
    api.foam.value = 14;
  }

  if (sid === 's39') {
    const k = t;
    const roll = deg(track([[76.6, 90], [77.0, 60], [77.8, 0], [78.3, -120], [78.8, -180], [79.25, -210], [80, -220]], k));
    const c = Math.cos(roll), s0 = Math.sin(roll);
    layBody(api, flipFall(k), (s, out) => out.set(0, c, -s0).normalize(), {
      skull: 0.78, jaw: 0.16,
      flipL: { sweep: track([[77, 0.5], [78.3, 0.3]], k), droop: track([[77, 0.4], [78.3, -0.2]], k), twist: 0.3, curl: 0.06 },
      flipR: { sweep: track([[77, 0.6], [78.3, 0.5]], k), droop: track([[77, 0.5], [78.3, 0.1]], k), twist: 0.3, curl: 0.06 },
      flukes: Math.sin(k * 3) * 0.7 });
    api.show(k < 80.3);
    api.run.value = 0.5;
    // the crash takes the ships: the right one is hit by the falling head, the left by the wall
    const fl = ctx.ships?.fleet;
    if (fl?.[1] && fl?.[0]) {
      const h = smooth(invLerp(79.0, 80.6, st.t)), w = smooth(invLerp(80.0, 81.8, st.t));
      fl[1].roll = deg(-14) * h; fl[1].pitch = deg(9) * h; fl[1].sink = 16 * h;
      fl[0].roll = deg(19) * w; fl[0].pitch = deg(-7) * w;
    }
  }
}
