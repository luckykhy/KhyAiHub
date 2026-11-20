import * as THREE from 'three';
import { Geo, addTube } from './lev-mat.js';
import { Rng } from './util.js';

// Sculpted rest-space geometry of the leviathan: one lofted hide from tail to snout, split along
// the lip line so the jaw really opens, a mouth lining that runs back into a throat, gums, teeth,
// bony spines and eyes. Rest space: z 0 (tail) .. L (snout), y dorsal, x lateral.

export const L = 900;
export const ZC = 0.835 * L;     // mouth corner
export const HINGE = [-16, 0.80 * L];   // y, z of the jaw hinge

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const gauss = (x, w) => Math.exp(-(x * x) / (w * w));

// cubic through keys [t, v] (non uniform Hermite)
export function curve(keys) {
  const n = keys.length;
  const m = keys.map((k, i) => {
    const a = keys[Math.max(0, i - 1)], b = keys[Math.min(n - 1, i + 1)];
    return (b[1] - a[1]) / (b[0] - a[0] || 1);
  });
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0; while (t > keys[i + 1][0]) i++;
    const h = keys[i + 1][0] - keys[i][0], u = (t - keys[i][0]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * keys[i][1] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * keys[i + 1][1] + (u3 - u2) * h * m[i + 1];
  };
}

const K = {
  xw: curve([[0, 5], [0.06, 9], [0.14, 16], [0.25, 30], [0.38, 54], [0.5, 76], [0.62, 90], [0.72, 92], [0.78, 88], [0.83, 84], [0.88, 76], [0.93, 64], [0.97, 46], [1, 26]]),
  ty: curve([[0, 7], [0.06, 14], [0.14, 23], [0.25, 38], [0.38, 56], [0.5, 72], [0.62, 80], [0.72, 82], [0.78, 80], [0.83, 76], [0.88, 66], [0.93, 50], [0.97, 34], [1, 12]]),
  by: curve([[0, -6], [0.06, -11], [0.14, -17], [0.25, -30], [0.38, -52], [0.5, -80], [0.62, -98], [0.72, -104], [0.78, -102], [0.83, -96], [0.88, -80], [0.93, -60], [0.97, -38], [1, -10]]),
  lip: curve([[0.78, -10], [0.835, -26], [0.88, -27], [0.93, -19], [0.97, -9], [1, -2]]),
};

export function section(z) {
  const t = z / L;
  const lip = K.lip(t) * ss(0.70, 0.80, t);
  // snout rounds off to a blunt tip
  const c0 = 0.955, cap = t > c0 ? Math.sqrt(Math.max(0, 1 - ((t - c0) / (1 - c0)) ** 2)) : 1;
  const y0 = K.ty(t), y1 = K.by(t);
  return { rx: K.xw(t) * cap, top: (y0 - lip) * cap, bot: (lip - y1) * cap, cy: lip, e: 2 / (t < 0.3 ? 2.5 : 2.15 - 0.15 * ss(0.8, 1, t)), t };
}

// lattice scutes in the same coordinates as the hide shader, so the silhouette carries them
function scuteH(u, v) {
  const a = Math.sin(u * 0.052 + 1.7 * Math.sin(v * 0.031)) * Math.sin(v * 0.067 + 1.3 * Math.sin(u * 0.023));
  const b = Math.sin(u * 0.13 + 2.1 * Math.sin(v * 0.09) + 1) * Math.sin(v * 0.17 + 1.2 * Math.sin(u * 0.11));
  return 0.7 + 0.8 * a + 0.35 * b;
}

// sculpting on top of the sections: returns metres along the outward normal
function sculpt(z, phi) {
  const t = z / L, up = Math.abs(phi - Math.PI / 2);         // 0 dorsal line .. PI/2 lip line (upper arc)
  const lat = Math.min(Math.abs(phi), Math.abs(phi - Math.PI), Math.abs(phi - 2 * Math.PI)); // from the flank line
  const isUp = phi >= 0 && phi <= Math.PI;
  let d = 0;
  // dorsal keel, sharper toward the tail
  d += (3 + 8 * ss(0.5, 0.1, t)) * Math.exp(-up / (0.05 + 0.07 * ss(0.1, 0.6, t))) * (isUp ? 1 : 0) * ss(0.84, 0.76, t);
  // flank keels of a crocodile's back
  if (isUp) d += 4.5 * gauss(up - 0.72, 0.09) * ss(0.06, 0.2, t) * ss(0.82, 0.7, t);
  // shoulder and hip masses
  d += 16 * gauss(t - 0.71, 0.055) * gauss(lat - 0.12, 0.42);
  d += 9 * gauss(t - 0.40, 0.04) * gauss(lat - 0.2, 0.4);
  // ribs under the skin
  if (isUp) d += 2.4 * Math.sin(z * 0.135) * ss(0.42, 0.5, t) * ss(0.76, 0.68, t) * gauss(lat - 0.45, 0.42);
  // brow, cheek, rostrum, chin
  if (isUp) {
    d += 11 * gauss(t - 0.885, 0.028) * gauss(up - 0.82, 0.17);
    d += 6 * gauss(t - 0.93, 0.05) * Math.exp(-up / 0.16);
    d += 8 * gauss(t - 0.815, 0.03) * gauss(lat - 0.5, 0.3);
    d -= 7 * gauss(t - 0.845, 0.03) * gauss(up - 1.15, 0.2);
    d += 3.5 * gauss(lat, 0.05) * ss(0.84, 0.86, t);             // lip fold
    d -= 4.5 * gauss(t - 0.872, 0.011) * gauss(up - 1.13, 0.09);  // eye socket
    d += 3.5 * gauss(t - 0.872, 0.02) * gauss(up - 0.93, 0.06);   // heavy lid
  } else {
    d += 3.0 * gauss(lat, 0.06) * ss(0.84, 0.86, t);
    d += 7 * gauss(t - 0.9, 0.05) * gauss(phi - 1.5 * Math.PI, 0.7);
  }
  return d;
}

const bellyOf = (phi, t) => {
  const a = phi <= Math.PI ? Math.abs(phi - Math.PI / 2) / Math.PI : 0.5 + Math.abs(phi - Math.PI) * 0 + (1 - Math.abs(phi - 1.5 * Math.PI) / (Math.PI / 2)) * 0.5;
  return a - 0.22 * ss(0.5, 0.2, t) + 0.05 * ss(0.8, 0.9, t) * (phi > Math.PI ? 1 : 0);
};

// one continuous loft split along the lip line. secFn(z) -> {rx, top, bot, cy, e}
export function loftBody(g, o) {
  const { zs, Nu, Nl, secFn, zc, sculptFn, bellyFn, jawFn, part = 0 } = o;
  const verts = [];
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i], S = secFn(z), slit = z > zc;
    const col = new Array(Nu + Nl + 2);
    // arc length bookkeeping: distance around from the dorsal line
    const place = (phi) => {
      const c = Math.cos(phi), s = Math.sin(phi);
      const x0 = S.rx * Math.sign(c) * Math.abs(c) ** S.e, y0 = (s > 0 ? S.top : S.bot) * Math.sign(s) * Math.abs(s) ** S.e;
      return [x0, y0, c, s];
    };
    const addV = (phi, around, upper) => {
      const [x0, y0, c, s] = place(phi);
      let d = sculptFn ? sculptFn(z, phi) : 0;
      const dorsal = upper ? Math.abs(phi - Math.PI / 2) : 9;
      if (o.scutes && dorsal < 0.95 && S.t < 0.84 && S.t > 0.02) d += o.scutes * scuteH(z, around) * ss(0.95, 0.7, dorsal) * ss(0.84, 0.8, S.t);
      const x = x0 + c * d, y = y0 + s * d + S.cy;
      const lower = !upper;
      const a = upper ? 1 - Math.min(1, Math.abs(phi - Math.PI / 2) / (Math.PI / 2)) : 1 - Math.min(1, Math.abs(phi - 1.5 * Math.PI) / (Math.PI / 2));
      const jw = jawFn ? jawFn(z, a, lower) : 0;
      const zr = z;
      return g.v(x, y, zr, S.t, phi, jw, part, around, bellyFn(phi, S.t));
    };
    // arcs from the dorsal line outward, so "around" is signed metres from the back
    const arcLen = (fromPhi, toPhi, steps) => {
      const out = [0]; let [px, py] = place(fromPhi);
      for (let k = 1; k <= steps; k++) {
        const ph = fromPhi + (toPhi - fromPhi) * (k / steps); const [x, y] = place(ph);
        out.push(out[k - 1] + Math.hypot(x - px, y - py)); px = x; py = y;
      }
      return out;
    };
    const half = Math.floor(Nu / 2);
    const aR = arcLen(Math.PI / 2, 0, half), aL = arcLen(Math.PI / 2, Math.PI, Nu - half);
    const hl = Math.floor(Nl / 2);
    const bR = arcLen(2 * Math.PI, 1.5 * Math.PI, Nl - hl), bL = arcLen(Math.PI, 1.5 * Math.PI, hl);
    for (let j = 0; j <= Nu; j++) {
      const phi = Math.PI * j / Nu;
      const ar = j <= half ? aR[half - j] : -aL[j - half];
      col[j] = addV(phi, ar, true);
    }
    for (let j = 0; j <= Nl; j++) {
      const phi = Math.PI + Math.PI * j / Nl;
      if (!slit && (j === 0 || j === Nl)) continue;
      const ar = j <= hl ? -(aL[Nu - half] + bL[j]) : (aR[half] + bR[Nl - j]);
      col[Nu + 1 + j] = addV(phi, ar, false);
    }
    if (!slit) { col[Nu + 1] = col[Nu]; col[Nu + 1 + Nl] = col[0]; }
    verts.push(col);
  }
  for (let i = 0; i < zs.length - 1; i++) {
    const A = verts[i], B = verts[i + 1];
    for (let j = 0; j < Nu; j++) g.quad(A[j], A[j + 1], B[j + 1], B[j]);
    for (let j = 0; j < Nl; j++) g.quad(A[Nu + 1 + j], A[Nu + 2 + j], B[Nu + 2 + j], B[Nu + 1 + j]);
  }
}

// a thin blade of bone: rings of a lens section, height along y, swept along -z
function addSpike(g, x, y, z, h, len, thick, sweep, lean, id, jaw = 0) {
  const first = g.count, R = 5, seg = 6;
  for (let i = 0; i <= R; i++) {
    const f = i / R, lw = len * Math.pow(1 - f, 1.25) * 0.5, th = thick * (1 - f);
    const cx = x + lean * f * f * h, cy = y + h * f, cz = z - sweep * f * f * h;
    const P = [[0, lw * 1.25], [th, lw * 0.4], [th, -lw * 0.5], [0, -lw], [-th, -lw * 0.5], [-th, lw * 0.4]];
    for (let j = 0; j < seg; j++) g.v(cx + P[j][0], cy, cz + P[j][1], f, j / seg, jaw, 3, 0, id);
  }
  for (let i = 0; i < R; i++) for (let j = 0; j < seg; j++) {
    const a = first + i * seg + j, b = first + i * seg + (j + 1) % seg;
    g.quad(a, a + seg, b + seg, b);
  }
}

function addEye(g, x, y, z, r, side) {
  const first = g.count, N = 12, M = 16;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI, sa = Math.sin(a), ca = Math.cos(a);
    for (let j = 0; j < M; j++) {
      const b = (j / M) * Math.PI * 2, dx = ca, dy = sa * Math.cos(b), dz = sa * Math.sin(b);
      g.v(x + side * dx * r * 0.8, y + dy * r, z + dz * r * 1.15, 0.5 + dz * 0.5, 0.5 + dy * 0.5, -1, 5, 0, 0);   // rides the upper jaw with the skull
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = first + i * M + j, b = first + i * M + (j + 1) % M;
    if (side > 0) g.quad(a, a + M, b + M, b); else g.quad(a, b, b + M, a + M);
  }
}

const lipW = (z) => ss(ZC, ZC + 46, z);

export function jawWeight(z, a, lower) {
  const back = (lower ? 150 : 70) * Math.pow(a, 0.8);
  const w = ss(ZC - back, ZC - back + 46 + back * 0.4, z);
  return lower ? w : -w;
}

export function buildMonsterGeometry() {
  const g = new Geo();
  // ---- rings: tighter around the head, very tight at the snout tip
  const zs = [];
  let z = 0.6;
  while (z < L - 0.02) {
    zs.push(z);
    const t = z / L;
    z += t < 0.7 ? 2.8 : t < 0.96 ? 1.7 : 0.9 * Math.max(0.12, (1 - t) / 0.04);
  }
  zs.push(L - 0.01);
  const secF = (zz) => {
    const S = section(zz);
    // the lower jaw sits a little inside the upper (overbite)
    return S;
  };
  loftBody(g, {
    zs, Nu: 170, Nl: 130, secFn: secF, zc: ZC, sculptFn: sculpt, bellyFn: bellyOf, jawFn: jawWeight, scutes: 2.3,
  });

  // ---- mouth lining: palate above, floor below, closing into the throat
  const ZB = 0.70 * L, ZT = L - 1.2, ring = 110, across = 28;
  const lipX = (zz) => section(zz).rx;
  for (const lower of [false, true]) {
    const start = g.count;
    for (let i = 0; i <= ring; i++) {
      const u = i / ring, zz = ZB + (ZT - ZB) * Math.pow(u, 0.9), S = section(zz);
      const front = ss(ZC - 24, ZC + 40, zz);
      const throat = 26 + 16 * ss(ZB, ZC, zz);
      const hw = throat + (S.rx * 0.992 - throat) * front;
      const tipFade = ss(L, L - 60, zz);
      const depth = lower ? (S.bot - 15) : (S.top - 13);
      const hmax = lower ? Math.max(4, depth * 0.84 * tipFade) : Math.max(3, depth * 0.84 * tipFade);
      const h = throat + (hmax - throat) * front;
      for (let j = 0; j <= across; j++) {
        const k = -1 + 2 * j / across;
        const arch = Math.pow(Math.max(0, 1 - k * k), 0.62);
        const xx = k * hw;
        const yy = S.cy + (lower ? -1 : 1) * h * arch;
        const wL = lipW(zz) + (1 - k * k) * ss(ZC - 110, ZC, zz) * (1 - lipW(zz));
        const a = (zz - ZB) / (ZT - ZB);
        g.v(xx, yy, zz, a, j / across, (lower ? 1 : -1) * Math.max(0, wL), 2, 0, 0.4);
      }
    }
    const W = across + 1;
    for (let i = 0; i < ring; i++) for (let j = 0; j < across; j++) {
      const a = start + i * W + j, b = a + 1, c = a + W, d = c + 1;
      if (lower) g.quad(a, b, d, c); else g.quad(a, c, d, b);
    }
  }
  // back wall of the throat
  {
    const c = g.v(0, section(ZB).cy, ZB - 1, 0, 0.5, 0, 2, 0, 0.4), first = g.count, S = section(ZB), n = 20;
    for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2; g.v(Math.cos(a) * 28, S.cy + Math.sin(a) * 28, ZB, 0, 0.5, 0, 2, 0, 0.4); }
    for (let j = 0; j < n; j++) g.tri(c, first + j, first + (j + 1) % n);
  }
  // tongue: a long muscular mound on the floor of the mouth
  {
    const pts = [], rad = [];
    for (let i = 0; i <= 26; i++) {
      const u = i / 26, zz = ZC - 70 + u * (0.97 * L - (ZC - 70)), S = section(zz);
      const hl = Math.max(0, S.bot - 15) * 0.84;
      pts.push([0, S.cy - hl * (0.72 - 0.1 * u), zz]); rad.push((14 + 26 * Math.sin(Math.PI * Math.min(1, u * 1.1))) * (1 - u * 0.55));
    }
    addTube(g, pts, rad, { seg: 12, flat: 0.34, part: 9, jawAt: (i) => Math.min(1, 0.35 + i / 12), up: new THREE.Vector3(0, 1, 0), belly: 0.5 });
  }

  // ---- gums and teeth, following the lip all the way round
  const rng = new Rng(20261);
  const lipPts = (lower) => {
    const pts = [];
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const zz = ZC + 8 + (L - 3 - ZC - 8) * (i / steps), S = section(zz);
      pts.push({ z: zz, x: S.rx * 0.97, y: S.cy, S });
    }
    return pts;
  };
  for (const lower of [false, true]) {
    const P = lipPts(lower), sgnY = lower ? 1 : -1;  // teeth point up from the lower jaw, down from the upper
    // gum tube: right side, front, left side
    const path = [], r = [], jw = [];
    const gr = (i) => 4.8 + 2.2 * Math.abs(Math.sin(i * 0.41 + 1.7 * Math.sin(i * 0.13)));
    for (let i = 0; i < P.length; i++) { path.push([P[i].x * 0.93, P[i].y, P[i].z]); r.push(gr(i)); jw.push(lipW(P[i].z)); }
    for (let i = P.length - 2; i >= 0; i--) { path.push([-P[i].x * 0.93, P[i].y, P[i].z]); r.push(gr(i + 17)); jw.push(lipW(P[i].z)); }
    addTube(g, path, r, { seg: 9, part: 10, jawAt: (i) => (lower ? 1 : -1) * jw[i], up: new THREE.Vector3(0, 1, 0), belly: 0.5 });
    // arc length along one side
    const arc = [0];
    for (let i = 1; i < P.length; i++) arc.push(arc[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z));
    const total = arc[arc.length - 1];
    const Z = new THREE.Vector3(0, 0, 1), GUM = 4.8;
    // small round cones, close and uneven, each rooted in the gum with a dark socket round its base
    const tooth = (x, y, zz, size, side, id) => {
      const inw = -side * (0.03 + rng.next() * 0.2), rake = rng.range(-0.08, 0.3), w = (lower ? 1 : -1) * lipW(zz);
      const pts = [], rr = [], root = size * 0.27;
      for (let i = 0; i <= 5; i++) {
        const u = i / 5, c = u * u;
        pts.push([x + inw * size * u, y + sgnY * (2 + (GUM - 2 + size) * u), zz - size * rake * c]);
        rr.push(Math.max(0.12, root * Math.pow(1 - u, 0.8)));
      }
      addTube(g, pts, rr, { seg: 9, part: 1, jaw: w, belly: id, up: Z });
      addTube(g, [[x, y + sgnY * (GUM - 2.4), zz], [x, y + sgnY * (GUM + 0.5), zz]], [root * 1.16 + 0.8, root * 0.9 + 0.3], { seg: 9, part: 10, jaw: w, belly: 2.5, up: Z });
    };
    for (const side of [1, -1]) {
      // [how far in, size, spacing, first tooth]: the main row, the row behind it, runts between them
      for (const [kx, ks, gap, s0] of [[0.955, 1, 1, 9], [0.895, 0.66, 1.2, 15], [0.925, 0.42, 2.2, 22]]) {
        let s = s0 + rng.range(0, 5), ti = 0;
        while (s < total - 4) {
          const k = arc.findIndex((a) => a >= s), Pk = P[Math.max(0, k)];
          const f = s / total, roll = rng.next(), big = (8.5 + 12.5 * Math.pow(f, 0.8)) * ks * (roll < 0.25 ? rng.range(0.6, 0.78) : roll > 0.85 ? rng.range(1.25, 1.5) : rng.range(0.85, 1.1));
          const size = Math.min(lower ? big * 0.88 : big, (lower ? Pk.S.bot : Pk.S.top) * 0.55);
          tooth(side * (Pk.x * kx + rng.range(-1.4, 1.4)), Pk.y, Pk.z + rng.range(-1.2, 1.2), size, side, ti + 0.5 + (side > 0 ? 3 : 0));
          s += (size * 0.5 + 1.6 + rng.range(0, 3)) * gap; ti++;
        }
      }
    }
  }

  // ---- dorsal crest and flank studs
  const rS = new Rng(77);
  const topY = (zz, offs = 0) => { const S = section(zz); return S.cy + S.top * Math.pow(Math.max(0, 1 - Math.pow(offs, 2)), 0.5); };
  let zz = 28, ci = 0;
  while (zz < 0.815 * L) {
    const t = zz / L;
    const env = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, (t + 0.02) / 0.9)) ** 0.8;
    const major = ci % 3 === 0;
    const h = (major ? 36 : 17) * env * (0.85 + rS.next() * 0.3) * (t > 0.76 ? ss(0.84, 0.76, t) * 0.7 + 0.3 : 1);
    const lenB = (major ? 34 : 22) * (0.5 + 0.7 * env);
    addSpike(g, 0, topY(zz) - 3 + 9 * ss(0.5, 0.1, t) * Math.exp(-0.1) * 0.7, zz, h, lenB, 2.8 + 2.2 * env, 0.75, 0, ci);
    zz += lenB * 0.72 + 3; ci++;
  }
  // double crest of a crocodile's tail
  zz = 1e9; ci = 0;
  while (zz < 0.46 * L) {
    const t = zz / L, S = section(zz), off = 0.42, e = 0.5 + 0.5 * ss(0.02, 0.2, t);
    const h = (ci % 2 ? 17 : 11) * e * ss(0.5, 0.36, t);
    for (const sd of [1, -1]) addSpike(g, sd * S.rx * off, topY(zz, off) - 1.5, zz, h, 15, 1.8, 0.6, sd * 0.25, ci + 2);
    zz += 16; ci++;
  }
  // studs on the back, in rows along the flank keels
  for (const [rowPhi, stp, base] of [[0.72, 74, 5]]) {
    for (const sd of [1, -1]) {
      let z2 = 0.2 * L + rowPhi * 12;
      while (z2 < 0.8 * L) {
        const S = section(z2), ph = Math.PI / 2 - rowPhi;
        const c = Math.cos(ph), s = Math.sin(ph);
        const x = sd * S.rx * c ** S.e, y = S.cy + S.top * s ** S.e;
        addSpike(g, x, y - 1.2, z2, base * (0.8 + rS.next() * 0.6), 13, 2.4, 0.5, sd * 0.45, Math.floor(z2 / 9));
        z2 += stp * (0.85 + rS.next() * 0.3);
      }
    }
  }
  // ragged spines along the jaw and cheek
  for (const sd of [1, -1]) {
    for (let i = 0; i < 12; i++) {
      const z3 = 0.79 * L + i * 13, S = section(z3), ph = 0.62;
      const x = sd * S.rx * Math.cos(ph) ** S.e, y = S.cy + S.top * Math.sin(ph) ** S.e;
      addSpike(g, x, y, z3, 11 + 8 * Math.sin(i * 1.7) ** 2, 12, 2.4, 0.9, sd * 0.7, i, -lipW(z3));
    }
  }
  // eyes under the brow
  {
    const ze = 0.872 * L, S = section(ze), ph = 0.44;
    const ex = S.rx * Math.cos(ph) ** S.e - 2.4, ey = S.cy + S.top * Math.sin(ph) ** S.e + 3;
    addEye(g, ex - 4.2, ey - 1.5, ze, 4.8, 1); addEye(g, -ex + 4.2, ey - 1.5, ze, 4.8, -1);
  }
  return g.build();
}
