import * as THREE from 'three';

// A bone chain evaluated on the GPU: every mesh of the creature is modelled straight in
// "rest space" (z runs along the chain from 0 at the tail to len at the head, x/y are the
// cross section) and the vertex shader wraps it on a Catmull-Rom spine, so the whole
// body bends as one continuous surface at no CPU cost. Bones are world-space.
// Frame convention: +Z toward the head, +Y dorsal, +X = Y x Z.

const Q = THREE.Quaternion, V = THREE.Vector3;

export const spineGLSL = (n) => /* glsl */ `
uniform vec4 uBP[${n}];   // bone position, w: cross-section scale
uniform vec4 uBQ[${n}];   // bone rotation
uniform float uLen;
vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void spineAt(float s, out vec3 p, out vec4 q, out float sc){
  float last = ${n - 1}.0;
  float f = clamp(s, 0.0, 1.0) * last;
  int i = int(min(floor(f), last - 1.0));
  float t = f - float(i);
  vec3 p0 = uBP[max(i - 1, 0)].xyz, p1 = uBP[i].xyz, p2 = uBP[i + 1].xyz, p3 = uBP[min(i + 2, ${n - 1})].xyz;
  p = 0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t * t * t);
  q = normalize(mix(uBQ[i], uBQ[i + 1], t));
  sc = mix(uBP[i].w, uBP[i + 1].w, t);
}
`;

const _a = new V(), _b = new V(), _c = new V(), _d = new V(), _q = new Q(), _q2 = new Q(), _q3 = new Q();
const AX = new V(1, 0, 0), AY = new V(0, 1, 0), AZ = new V(0, 0, 1);

export class Spine {
  constructor(len, n) {
    this.len = len; this.n = n; this.seg = len / (n - 1); this.k = 1;
    this.P = new Float32Array(n * 4); this.Q = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { this.P[i * 4 + 2] = i * this.seg; this.P[i * 4 + 3] = 1; this.Q[i * 4 + 3] = 1; }
    this.uniforms = {
      uBP: { value: this.P }, uBQ: { value: this.Q }, uLen: { value: len },
      uJaw: { value: new THREE.Vector2(0, 0) }, uHinge: { value: new THREE.Vector2(0, 0) },
      uHideOff: { value: 0 }, uWide: { value: 0 }, uFat: { value: 0 },
    };
  }

  // a size cheat for single shots: lengths and cross sections grow together, rest space stays put
  setScale(k) { this.k = k; this.seg = this.len / (this.n - 1) * k; }

  setBone(i, p, q, sc = this.k) {
    const P = this.P, Qa = this.Q, k = i * 4;
    P[k] = p.x; P[k + 1] = p.y; P[k + 2] = p.z; P[k + 3] = sc;
    let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    if (i > 0 && qx * Qa[k - 4] + qy * Qa[k - 3] + qz * Qa[k - 2] + qw * Qa[k - 1] < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
    Qa[k] = qx; Qa[k + 1] = qy; Qa[k + 2] = qz; Qa[k + 3] = qw;
  }

  // same interpolation as the shader
  at(s, p, q) {
    const n = this.n, f = Math.min(1, Math.max(0, s)) * (n - 1), i = Math.min(Math.floor(f), n - 2), t = f - i, P = this.P, Qa = this.Q;
    const i0 = Math.max(i - 1, 0), i3 = Math.min(i + 2, n - 1), t2 = t * t, t3 = t2 * t;
    for (let c = 0; c < 3; c++) {
      const p0 = P[i0 * 4 + c], p1 = P[i * 4 + c], p2 = P[(i + 1) * 4 + c], p3 = P[i3 * 4 + c];
      p.setComponent(c, 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3));
    }
    if (q) {
      const k = i * 4, l = (i + 1) * 4;
      q.set(Qa[k] + (Qa[l] - Qa[k]) * t, Qa[k + 1] + (Qa[l + 1] - Qa[k + 1]) * t, Qa[k + 2] + (Qa[l + 2] - Qa[k + 2]) * t, Qa[k + 3] + (Qa[l + 3] - Qa[k + 3]) * t).normalize();
    }
    return p;
  }

  // rest-space point -> world, with the same jaw rotation as the vertex shader
  toWorld(rest, out, jawW = 0) {
    let { x, y, z } = rest;
    if (jawW) {
      const J = this.uniforms.uJaw.value, H = this.uniforms.uHinge.value;
      const ang = jawW > 0 ? J.x * jawW : J.y * jawW, c = Math.cos(ang), s = Math.sin(ang);
      const ry = y - H.x, rz = z - H.y;
      y = H.x + c * ry - s * rz; z = H.y + s * ry + c * rz;
    }
    const zc = Math.min(this.len, Math.max(0, z));
    this.at(zc / this.len, _a, _q);
    _b.set(x * this.k, y * this.k, z - zc).applyQuaternion(_q);
    return out.copy(_a).add(_b);
  }

  // the spine follows a curve: fn(s, out) gives the position of s (0 tail..1 head); dorsal is
  // kept as close as possible to upFn(s) (a vector), else to world up
  fromPath(fn, upFn) {
    const n = this.n, p = this._p ?? (this._p = Array.from({ length: n }, () => new V()));
    for (let i = 0; i < n; i++) fn(i / (n - 1), p[i]);
    const m = new THREE.Matrix4();
    for (let i = n - 1; i >= 0; i--) {
      const a = p[Math.max(i - 1, 0)], b = p[Math.min(i + 1, n - 1)];
      _c.copy(b).sub(a).normalize();                       // tangent toward the head
      if (upFn) upFn(i / (n - 1), _d); else _d.copy(AY);
      _a.crossVectors(_d, _c);
      if (_a.lengthSq() < 1e-5) _a.copy(this._lastX ?? AX);
      _a.normalize();
      this._lastX = (this._lastX ?? new V()).copy(_a);
      _b.crossVectors(_c, _a).normalize();
      m.makeBasis(_a, _b, _c);
      _q.setFromRotationMatrix(m);
      this.setBoneFromTail ??= 0;
      this._tmpQ = this._tmpQ ?? Array.from({ length: n }, () => new Q());
      this._tmpQ[i].copy(_q);
    }
    for (let i = 0; i < n; i++) this.setBone(i, p[i], this._tmpQ[i]);
  }

  // forward kinematics from a centre bone: base orientation + curvature per unit length.
  // k(s, out) writes [pitchCurl, yawCurl, twist] radians per bone
  fromCurl(c, base, pos, k) {
    const n = this.n, p = this._p ?? (this._p = Array.from({ length: n }, () => new V()));
    const qs = this._tmpQ ?? (this._tmpQ = Array.from({ length: n }, () => new Q()));
    p[c].copy(pos); qs[c].copy(base);
    const v = [0, 0, 0];
    for (let i = c; i < n - 1; i++) {
      k((i + 0.5) / (n - 1), v);
      _q.setFromAxisAngle(AX, v[0]); _q2.setFromAxisAngle(AY, v[1]); _q3.setFromAxisAngle(AZ, v[2]);
      qs[i + 1].copy(qs[i]).multiply(_q).multiply(_q2).multiply(_q3);
      _a.copy(AZ).applyQuaternion(_q.copy(qs[i]).slerp(qs[i + 1], 0.5));
      p[i + 1].copy(p[i]).addScaledVector(_a, this.seg);
    }
    for (let i = c; i > 0; i--) {
      k((i - 0.5) / (n - 1), v);
      _q.setFromAxisAngle(AX, -v[0]); _q2.setFromAxisAngle(AY, -v[1]); _q3.setFromAxisAngle(AZ, -v[2]);
      qs[i - 1].copy(qs[i]).multiply(_q).multiply(_q2).multiply(_q3);
      _a.copy(AZ).applyQuaternion(_q.copy(qs[i]).slerp(qs[i - 1], 0.5));
      p[i - 1].copy(p[i]).addScaledVector(_a, -this.seg);
    }
    for (let i = 0; i < n; i++) this.setBone(i, p[i], qs[i]);
  }

  // a short limb chain from a root frame: bend(i, out) as in fromCurl
  fromRoot(rootP, rootQ, k) { this.fromCurl(0, rootQ, rootP, k); }
}

export const baseQuat = (yaw, pitch, roll, out = new Q()) => {
  out.setFromAxisAngle(AY, yaw);
  _q.setFromAxisAngle(AX, -pitch); out.multiply(_q);
  _q.setFromAxisAngle(AZ, roll); out.multiply(_q);
  return out;
};

// arc-length parametrised path through points, extrapolated straight past both ends
export class ArcPath {
  constructor(points, tension = 0.5) {
    this.curve = new THREE.CatmullRomCurve3(points.map((p) => new V(...p)), false, 'centripetal', tension);
    this.curve.arcLengthDivisions = 600;
    this.length = this.curve.getLength();
    this.t0 = this.curve.getTangentAt(0).clone(); this.t1 = this.curve.getTangentAt(1).clone();
    this.p0 = this.curve.getPointAt(0).clone(); this.p1 = this.curve.getPointAt(1).clone();
  }
  at(d, out) {
    if (d <= 0) return out.copy(this.p0).addScaledVector(this.t0, d);
    if (d >= this.length) return out.copy(this.p1).addScaledVector(this.t1, d - this.length);
    return this.curve.getPointAt(d / this.length, out);
  }
}
