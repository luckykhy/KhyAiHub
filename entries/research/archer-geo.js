import * as THREE from 'three';
import { ConvexGeometry } from '../vendor/addons/ConvexGeometry.js';
import { toCreasedNormals } from '../vendor/addons/BufferGeometryUtils.js';
import { Rng, deg, clamp } from './util.js';

// three's crease hash truncates at 0.01: work at x30 so tiny hand parts keep clean normals
export function creased(g, a) { g.scale(30, 30, 30); const r = toCreasedNormals(g, a); r.scale(1 / 30, 1 / 30, 1 / 30); return r; }

// Modelling kit for the archer. Armour is built the way real armour is: a sculpted
// body surface (tube) carrying overlapping curved plates (patch) with a chamfered
// edge, then everything is merged per joint into one mesh with per-vertex colour,
// ink id and material flags, so 2000 plates cost a handful of draw calls.

export const V = THREE.Vector3;
export const v3 = (x, y, z) => new V(x, y, z);
export const TILE = 3.4;      // one detail-atlas tile covers this many robot units

export function hull(points, crease = 30) {
  const g = new ConvexGeometry(points);
  return creased(g, deg(crease));
}

// box with chamfered edges, optional taper (top size) and top offset in z/x
export function cbox(w, h, d, c = 0.05, o = {}) {
  const wt = o.wt ?? w, dt = o.dt ?? d, zt = o.zt ?? 0, zb = o.zb ?? 0, xt = o.xt ?? 0;
  const pts = [];
  for (const [y, ww, dd, zz, xx] of [[-h / 2, w, d, zb, 0], [h / 2, wt, dt, zt, xt]]) {
    const ys = Math.sign(y);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * ww / 2 + xx, z = sz * dd / 2 + zz;
      pts.push(v3(x - sx * c, y, z - sz * c), v3(x, y - ys * c, z - sz * c), v3(x - sx * c, y - ys * c, z));
    }
  }
  return hull(pts, o.crease ?? 28);
}

export function superPts(rx, ry, rz, e, n, fn) {
  const pts = [], p = 2 / e;
  const f = (c) => Math.sign(c) * Math.pow(Math.abs(c), p);
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    for (let k = 0; k < n * 2; k++) {
      const b = -Math.PI + (Math.PI * k) / n;
      const q = v3(rx * f(Math.cos(a)) * f(Math.cos(b)), ry * f(Math.sin(a)), rz * f(Math.cos(a)) * f(Math.sin(b)));
      if (fn) fn(q);
      pts.push(q);
    }
  }
  return pts;
}

export const cyl = (rt, rb, h, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);
export const cylZ = (r, h, seg = 16) => new THREE.CylinderGeometry(r, r, h, seg, 1).rotateX(Math.PI / 2);
export const cylX = (r, h, seg = 16) => new THREE.CylinderGeometry(r, r, h, seg, 1).rotateZ(Math.PI / 2);
export const ring = (r, tube, seg = 24) => new THREE.TorusGeometry(r, tube, 6, seg).rotateX(Math.PI / 2);
export const ball = (r, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h);

// ring-stack: alternating ribs, for flexible dark joints and cable hoses
export function ribs(g, r0, r1, h, n, seg = 14) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0.5;
    const r = r0 + (r1 - r0) * t;
    const gg = new THREE.CylinderGeometry(r, r * 1.04, (h / n) * 0.62, seg, 1);
    gg.translate(0, -h / 2 + (h * (i + 0.5)) / n, 0);
    out.push(gg);
  }
  void g;
  return out;
}

// Extruded silhouette with bevel, profile in XY, thickness along Z, centred.
export function extrude(pts, depth, bevel = 0.02, holes = [], crease = 30) {
  const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) {
    const pth = new THREE.Path();
    if (h.r) pth.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true);
    else pth.setFromPoints(h.map((p) => new THREE.Vector2(p[0], p[1])));
    sh.holes.push(pth);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 16 });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('uv');
  return creased(g, deg(crease));
}

// Catmull-Rom over an array of number arrays
export function crSample(arr, t) {
  const n = arr.length - 1, x = clamp(t) * n, i = Math.min(Math.floor(x), n - 1), f = x - i;
  const a = arr[Math.max(i - 1, 0)], b = arr[i], c = arr[i + 1], d = arr[Math.min(i + 2, n)];
  return b.map((_, k) => 0.5 * (2 * b[k] + (-a[k] + c[k]) * f + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * f * f + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * f * f * f));
}

// A sculpted body surface around the Y axis.
// secs: [y, rx, rz, cz = 0, e = 2.4, cx = 0]. u is in turns: 0 = +Z (front), .25 = +X, v 0..1 along secs.
export function tube(secs, opt = {}) {
  const S = secs.map((s) => [s[0], s[1], s[2], s[3] ?? 0, s[4] ?? 2.4, s[5] ?? 0]);
  const fr = (vv) => crSample(S, vv);
  const flip = opt.mirror ? -1 : 1;
  return {
    p(u, vv, out = new V()) {
      const [y, rx, rz, cz, e, cx] = fr(vv);
      const a = u * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), p = 2 / e;
      return out.set(flip * (cx + rx * Math.sign(s) * Math.pow(Math.abs(s), p)), y, cz + rz * Math.sign(c) * Math.pow(Math.abs(c), p));
    },
    c(u, vv, out = new V()) { const [y, , , cz, , cx] = fr(vv); return out.set(flip * cx, y, cz); },
  };
}

function orientTri(pos, i, q) {
  const ax = pos[i], ay = pos[i + 1], az = pos[i + 2], bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5], cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
  const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const mx = (ax + bx + cx) / 3 - q.x, my = (ay + by + cy) / 3 - q.y, mz = (az + bz + cz) / 3 - q.z;
  return nx * mx + ny * my + nz * mz < 0;
}

const rngUV = new Rng(77123);

// One armour plate on surface S.
// c: 4 corners [[u,v] x4] going around the plate.
// o: nu, nv grid; lift above surface; t thickness; ch chamfer width; ridge raises a keel along the
//    middle (s=.5); ridgeV the same across; flare adds lift toward r=1; crown pillows the plate
export function patch(S, c, o = {}) {
  const nu = o.nu ?? 4, nv = o.nv ?? 5, lift = o.lift ?? 0, t = o.t ?? 0.05, ch = o.ch ?? 0.03;
  const ridge = o.ridge ?? 0, ridgeV = o.ridgeV ?? 0, flare = o.flare ?? 0, crown = o.crown ?? 0, flareS = o.flareS ?? 0;
  const uvAt = (s, r) => {
    const [a, b, d, e] = c;
    return [(1 - r) * ((1 - s) * a[0] + s * b[0]) + r * ((1 - s) * e[0] + s * d[0]), (1 - r) * ((1 - s) * a[1] + s * b[1]) + r * ((1 - s) * e[1] + s * d[1])];
  };
  const _p = new V(), _c = new V(), _a = new V(), _b = new V();
  const P = (s, r, off) => {
    const [u, vv] = uvAt(s, r);
    const p = S.p(u, vv, new V());
    const e = 0.01;
    const [u1, v1] = uvAt(Math.min(s + e, 1), r), [u0, v0] = uvAt(Math.max(s - e, 0), r);
    const [u3, v3_] = uvAt(s, Math.min(r + e, 1)), [u2, v2] = uvAt(s, Math.max(r - e, 0));
    S.p(u1, v1, _a).sub(S.p(u0, v0, _p));
    S.p(u3, v3_, _b).sub(S.p(u2, v2, _p));
    const n = _a.clone().cross(_b);
    S.c(u, vv, _c);
    const out = p.clone().sub(_c);
    if (n.lengthSq() < 1e-10) n.copy(out);
    n.normalize();
    if (n.dot(out) < 0) n.negate();
    const k = off + ridge * (1 - Math.abs(2 * s - 1)) + ridgeV * (1 - Math.abs(2 * r - 1)) + flare * r + flareS * s + crown * Math.sin(Math.PI * s) * Math.sin(Math.PI * r);
    return p.addScaledVector(n, k);
  };
  const lenU = Math.max(S.p(...uvAt(0, 0.5)).distanceTo(S.p(...uvAt(1, 0.5))), 0.02);
  const lenV = Math.max(S.p(...uvAt(0.5, 0)).distanceTo(S.p(...uvAt(0.5, 1))), 0.02);
  const eU = Math.min(ch / lenU, 0.3), eV = Math.min(ch / lenV, 0.3);
  const ou = rngUV.next(), ov = rngUV.next();
  const pos = [], uv = [], edge = [], pr = [];
  const rOf = (q) => clamp(((q[1] - ov) * TILE) / lenV);
  const uvOf = (s, r) => [s * lenU / TILE + ou, r * lenV / TILE + ov];
  const top = (i, j) => P(eU + (1 - 2 * eU) * (i / nu), eV + (1 - 2 * eV) * (j / nv), lift + t);
  const grid = [];
  for (let i = 0; i <= nu; i++) { grid[i] = []; for (let j = 0; j <= nv; j++) grid[i][j] = top(i, j); }
  const tri = (a, b, d, ua, ub, ud, e) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
    uv.push(...ua, ...ub, ...ud);
    edge.push(e[0], e[1], e[2]);
    pr.push(rOf(ua), rOf(ub), rOf(ud));
  };
  const G = (i, j) => [grid[i][j], uvOf(i / nu, j / nv)];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const [a, ua] = G(i, j), [b, ub] = G(i + 1, j), [d, ud] = G(i + 1, j + 1), [e, ue] = G(i, j + 1);
    tri(a, b, d, ua, ub, ud, [0, 0, 0]); tri(a, d, e, ua, ud, ue, [0, 0, 0]);
  }
  // perimeter: top edge -> chamfer -> skirt to the base
  const per = [];
  for (let i = 0; i < nu; i++) per.push([i, 0]);
  for (let j = 0; j < nv; j++) per.push([nu, j]);
  for (let i = nu; i > 0; i--) per.push([i, nv]);
  for (let j = nv; j > 0; j--) per.push([0, j]);
  const ringB = per.map(([i, j]) => P(i / nu, j / nv, lift + t * 0.45));
  const ringC = per.map(([i, j]) => P(i / nu, j / nv, lift - 0.03));
  for (let k = 0; k < per.length; k++) {
    const k2 = (k + 1) % per.length;
    const [i, j] = per[k], [i2, j2] = per[k2];
    const a = grid[i][j], b = grid[i2][j2], u1 = uvOf(i / nu, j / nv), u2 = uvOf(i2 / nu, j2 / nv);
    tri(a, b, ringB[k2], u1, u2, u2, [1, 1, 1]); tri(a, ringB[k2], ringB[k], u1, u2, u1, [1, 1, 1]);
    tri(ringB[k], ringB[k2], ringC[k2], u1, u2, u2, [0.35, 0.35, 0.35]); tri(ringB[k], ringC[k2], ringC[k], u1, u2, u1, [0.35, 0.35, 0.35]);
  }
  // consistent outward winding
  const mid = P(0.5, 0.5, lift);
  const [u, vv] = uvAt(0.5, 0.5);
  const below = mid.clone().lerp(S.c(u, vv), 0.5);
  for (let i = 0; i < pos.length; i += 9) {
    if (orientTri(pos, i, below)) {
      for (let k = 0; k < 3; k++) { const x = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = x; }
      const ti = (i / 9) * 6, tv = uv.slice(ti + 2, ti + 4); uv[ti + 2] = uv[ti + 4]; uv[ti + 3] = uv[ti + 5]; uv[ti + 4] = tv[0]; uv[ti + 5] = tv[1];
      const pi = i / 3, px = pr[pi + 1]; pr[pi + 1] = pr[pi + 2]; pr[pi + 2] = px;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setAttribute('aPr', new THREE.Float32BufferAttribute(pr, 1));
  const r = creased(g, deg(o.crease ?? 15));
  r.userData.ownUV = true;
  return r;
}

// Solid skin of a tube (under-frame / simple bodies)
export function solid(S, o = {}) {
  const nu = o.nu ?? 16, nv = o.nv ?? 8, k = o.k ?? 1, caps = o.caps ?? true;
  const pos = [];
  const p = (i, j) => { const q = S.p(i / nu, j / nv); const c = S.c(i / nu, j / nv); return q.sub(c).multiplyScalar(k).add(c); };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = p(i, j), b = p(i + 1, j), d = p(i + 1, j + 1), e = p(i, j + 1);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z, a.x, a.y, a.z, d.x, d.y, d.z, e.x, e.y, e.z);
  }
  if (caps) for (const j of [0, nv]) {
    const c = S.c(0, j / nv);
    for (let i = 0; i < nu; i++) { const a = p(i, j), b = p(i + 1, j); if (j === 0) pos.push(c.x, c.y, c.z, b.x, b.y, b.z, a.x, a.y, a.z); else pos.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z); }
  }
  // tubes run +Y→-Y or -Y→+Y: orient against the mid-axis
  const mid = S.c(0, 0.5);
  for (let i = 0; i < pos.length; i += 9) {
    const q = new V((pos[i] + pos[i + 3] + pos[i + 6]) / 3, (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3);
    const ref = S.c(0, clamp((q.y - S.c(0, 0).y) / (S.c(0, 1).y - S.c(0, 0).y + 1e-6)));
    void mid;
    if (orientTri(pos, i, ref)) for (let k2 = 0; k2 < 3; k2++) { const x = pos[i + 3 + k2]; pos[i + 3 + k2] = pos[i + 6 + k2]; pos[i + 6 + k2] = x; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return creased(g, deg(o.crease ?? 38));
}

// ----------------------------------------------------------------- merge kit
// style: { col:'#hex', metal, detail, emis (0 none, 1 core, 2 visor, 3 ember inlay), wear, tone, id, sheen }
export class Kit {
  constructor(seed = 1) { this.bins = new Map(); this.n = 0; this.rng = new Rng(seed); this._c = new THREE.Color(); this.tris = 0; this.xf = {}; }
  // non-uniform fit of a whole joint's geometry: limbs are modelled generous, then proportioned here
  scaleBin(name, sx, sy, sz) { this.xf[name] = [sx, sy, sz]; }
  id() { this.n++; return ((this.n * 17) % 59) + 1; }
  // part list form: kit.add('chest', geo|[geos], style, pos, rot(deg), { mirror, id, scale })
  add(bin, geo, st, pos = [0, 0, 0], rot = [0, 0, 0], o = {}) {
    if (Array.isArray(geo)) { const id = o.id ?? st.id ?? this.id(); for (const g of geo) this.add(bin, g, st, pos, rot, { ...o, id }); return id; }
    const id = o.id ?? st.id ?? this.id();
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position, N = g.attributes.normal, UV = g.userData.ownUV || geo.userData.ownUV ? g.attributes.uv : null, EDGE = g.attributes.aEdge, PR = g.attributes.aPr;
    const m = new THREE.Matrix4().compose(new V(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(rot[0]), deg(rot[1]), deg(rot[2]))), o.scale ? new V(...o.scale) : new V(1, 1, 1));
    if (o.mirror) m.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1));
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const B = this.bins.get(bin) ?? { pos: [], nor: [], uv: [], col: [], mat: [], edge: [] };
    this.bins.set(bin, B);
    const c = this._c.set(st.col ?? '#c8ccd8');
    const jit = 1 + (st.tone ?? 0.05) * (this.rng.next() * 2 - 1);
    const cc = [c.r * jit, c.g * jit, c.b * jit];
    const flipW = o.mirror ? true : false;
    const a = new V(), b = new V(), d = new V(), na = new V(), nb = new V(), nd = new V();
    const ou = this.rng.next(), ov = this.rng.next();
    const n = P.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = i, i1 = flipW ? i + 2 : i + 1, i2 = flipW ? i + 1 : i + 2;
      a.fromBufferAttribute(P, i0).applyMatrix4(m); b.fromBufferAttribute(P, i1).applyMatrix4(m); d.fromBufferAttribute(P, i2).applyMatrix4(m);
      na.fromBufferAttribute(N, i0).applyMatrix3(nm).normalize(); nb.fromBufferAttribute(N, i1).applyMatrix3(nm).normalize(); nd.fromBufferAttribute(N, i2).applyMatrix3(nm).normalize();
      B.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
      B.nor.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nd.x, nd.y, nd.z);
      if (UV) {
        B.uv.push(UV.getX(i0), UV.getY(i0), UV.getX(i1), UV.getY(i1), UV.getX(i2), UV.getY(i2));
      } else {
        // box projection per triangle, in local units
        const fx = Math.abs((b.y - a.y) * (d.z - a.z) - (b.z - a.z) * (d.y - a.y));
        const fy = Math.abs((b.z - a.z) * (d.x - a.x) - (b.x - a.x) * (d.z - a.z));
        const fz = Math.abs((b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x));
        const pr = fx >= fy && fx >= fz ? (q) => [q.z, q.y] : (fy >= fz ? (q) => [q.x, q.z] : (q) => [q.x, q.y]);
        for (const q of [a, b, d]) { const [s, r] = pr(q); B.uv.push(s / TILE + ou, r / TILE + ov); }
      }
      for (let k = 0; k < 3; k++) {
        B.col.push(cc[0], cc[1], cc[2]);
        B.mat.push(st.metal ?? 0.7, st.detail ?? 1, st.emis ?? 0, id);
        const e = EDGE ? EDGE.getX([i0, i1, i2][k]) : 0;
        B.edge.push(e, st.wear ?? 1, PR ? PR.getX([i0, i1, i2][k]) : 0.5);
      }
    }
    this.tris += n / 3;
    return id;
  }
  // Builds one mesh per bin and parents it under bins[name]
  finish(joints, material, meshes = []) {
    for (const [name, B] of this.bins) {
      const X = this.xf[name];
      if (X) {
        for (let i = 0; i < B.pos.length; i += 3) {
          B.pos[i] *= X[0]; B.pos[i + 1] *= X[1]; B.pos[i + 2] *= X[2];
          const nx = B.nor[i] / X[0], ny = B.nor[i + 1] / X[1], nz = B.nor[i + 2] / X[2], l = Math.hypot(nx, ny, nz) || 1;
          B.nor[i] = nx / l; B.nor[i + 1] = ny / l; B.nor[i + 2] = nz / l;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(B.col, 3));
      g.setAttribute('aMat', new THREE.Float32BufferAttribute(B.mat, 4));
      g.setAttribute('aEx', new THREE.Float32BufferAttribute(B.edge, 3));
      const mesh = new THREE.Mesh(g, material);
      mesh.name = 'kit:' + name;
      mesh.frustumCulled = false;
      if (!joints[name]) throw new Error('kit: no joint ' + name);
      joints[name].add(mesh);
      meshes.push(mesh);
    }
    this.bins.clear();
    return meshes;
  }
}
