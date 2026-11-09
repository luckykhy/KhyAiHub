// models/inbox-ding.js — 信匣·丁：掌上衣盒终端，收存信笺、把墨字译成屏上的琥珀字。
//
// 与 rig.js 同源的三条硬约束，改这个文件前先读：
//   1) 确定性：update(t, ctx) 只由 (t, ctx) 决定。采集链按 t=i/24 逐场景取帧并
//      比对两次渲染的字节；读墙钟或跨调用累加状态会把「同一 t 两次渲染不一致」
//      变成不可排查的玄学。光标闪烁走 src/util/rand.js 的 hash1，禁 Math.random。
//   2) 一个 rest 世界空间：几何与骨都建在同一坐标系里——头骨位于世界原点、盒体
//      前面落在 z = +0.105（理由见下），整组最后再平移到双脚踩 y=0。
//      bindSkin 之后再单独挪某根骨的 rest 位置，部件会跟着姿势变形而不是整体移动。
//   3) 骨必须在被渲染的图里：第一件 bindSkin 会把无父节点的 root 收为子节点，
//      其余部件靠它进图。
//
// 四个不得不这么做的决定，理由都写在代码里：
//   · 头骨钉在世界原点。rig.js 的 makeEyelids 把睑梁壳建在世界坐标
//     (0, LID_UP + LID_SLIT/2, LID_FORWARD - LID_DEPTH/2) = (0, 0.035, 0.114)
//     （rig.js:554-577），头骨一离开原点，壳就与睑骨错位，眨眼会绕着一个远在
//     别处的铰点甩。所以盒体前面（不是盒心）落在 z = +0.105：睑梁厚 1.2cm、静置
//     时横在屏前当取景罩，立起时正好盖住整块屏；头骨随之落在盒内靠后 3.5cm——
//     那也正是「脊柱退化为盒内一根纵向短轴」的位置。
//   · 脊柱做 root、头骨做它的子骨：点头只许盒体倾，腿与尾不动；而腿顶又要能
//     加权到头骨，否则盒体一倾，髋部就裂开 2.4cm 的缝（见 legWeight）。
//   · 嘴用 makeJaw，但它的壳是钉死的 14x3x9cm 透镜，只能缩放颌骨来适配 9cm 的
//     格栅缝——mesh 自己的 transform 在 three 的 attached 蒙皮里会被约掉，骨的
//     scale 不会。五根格条是颌骨的子骨，局部位置因此要除掉同一个 scale。
//   · 任务书的超椭圆「e 约 0.35」不能当指数本身读：那是内凹的四角星，与同一句
//     「圆角方盒」正相反。取 n = 1/e ≈ 2.86 才读出偏方的圆角方盒，且恰好比阙的
//     e = 2.4 方一档，两张任务书因此对得上。

import * as THREE from 'three';
import { hash1 } from '../util/rand.js';
import { bindSkin, createBoneChain, loft, makeEyelids, makeJaw, sculpt } from './rig.js';

// ---------------------------------------------------------------------------
// 比例：单位米。头骨在原点，盒前在 z = +0.105，整组最后平移 +0.227 让脚踩 y=0。
// ---------------------------------------------------------------------------

const RING = 16; // 盒体每节环上的点数；loft 按索引缝环，各节必须一致
const SMALL_RING = 8; // 小手、光标块这类小件用不到 16 点

const BOX_E = 1 / 0.35; // 偏方的圆角方盒（见文件头第四条）
const BOX_RX = 0.08; // 宽 0.16 的半宽
const BOX_RY = 0.11; // 高 0.22 的半高
const BOX_Z0 = -0.035; // 盒后：背盖占最里 3mm
const BOX_Z1 = 0.105; // 盒前：睑梁厚 1.2cm、铰点在 z=0.114，屏面要退到 0.105 才能被立起的梁盖住
const BOX_CZ = 0.035; // 盒体深度中心：天线长在这儿

const COVER_HINGE = [0, BOX_RY, BOX_Z0 + 0.003];
const COVER_OPEN = (70 * Math.PI) / 180;
const CAVITY_RX = 0.055; // 背盖里的信笺腔：11 x 15cm
const CAVITY_RY = 0.075;
const CAVITY_Z = 0.053;

const SCREEN_RX = 0.052; // 屏 10.4cm 宽——睑梁立起时正好盖满
const SCREEN_RY = 0.025; // 屏 5cm 高 = LID_LENGTH，眨眼即「整体暗下」
const SCREEN_Y = 0.035; // = LID_UP + LID_SLIT/2，睑梁铰点高度（rig.js:554）
const SCREEN_BULGE = 0.003; // 微凸：只沿 X 弯，行字因此能贴面放样

// 字行 6mm 行距：0.029..0.041 那道 12mm 空档留给横在屏前的取景罩，行字永不被它啃
const ROW_Y = [0.013, 0.019, 0.025, 0.031, 0.037, 0.043, 0.049];
const ROW_LEN = [0.055, 0.042, 0.06, 0.038, 0.05, 0.046, 0.052];
const ROW_X0 = -0.042;
const ROW_H = 0.0022;
const ROW_D = 0.0008;
const SCROLL_MM = 0.006; // 每秒 6mm，一行 6mm
const ROW_SPAN = 0.042; // 绕环范围 = 七行行距，出环即换行（终端的读法）

const SLOT_Y = -0.048; // 格栅缝：屏下一道，9cm x 2.4cm（尺寸由 JAW_SCALE 收出来）
const SLOT_Z = 0.109; // 铰点：盒前 0.105 再探出 4mm，壳收窄后正好贴在缝心
const JAW_SCALE = [0.09 / 0.14, 0.024 / 0.03, 0.008 / 0.09]; // 把钉死的壳收成格栅缝
const JAW_OPEN = 0.42;
const GRILLE_N = 5;
const GRILLE_W = 0.015;
const GRILLE_H = 0.022;
const GRILLE_D = 0.0035;
const GRILLE_Z = 0.113; // 格条立在缝面板前面 4mm
const GRILLE_HOP = 0.0016; // 格条上下振动的幅度
const GRILLE_HZ = 9; // 采集按 24fps 取帧，超过 12Hz 的振动会频闪成抖动

const LID_REST = Math.PI / 2; // 静置：横在屏前的取景罩，不挡字行
const LID_SHUT = 0; // 眨眼：立起盖住整块屏；节拍走 rig 自己的 LID_BLINK_*

const LEG_X = 0.045;
const LEG_HIP_Y = -0.095;
const THIGH = 0.055; // 大腿 5.5cm
const SHIN = 0.077; // 小腿 7.7cm ≈ 1 : 1.4
const LEG_KNEE_Z = 0.045; // 膝反折：大腿前伸 1.5cm
const LEG_ANKLE_Z = 0.01; // 小腿回落 3.5cm
const LEG_R = 0.0042; // 火柴腿

const NOD = (12 * Math.PI) / 180; // 点头：绕盒内那根纵轴前倾 12°
const NOD_SEC = 7.5;

const TAIL_BONES = 10;
const TAIL_TURNS = 1.5;
const TAIL_R0 = 0.0102; // 卷径 2cm：1.5 圈的弧长 8cm 均分到这个半径上
const TAIL_R1 = 0.0067; // 每圈只收 2.3mm——纸的厚度，卷才卷得起来
const TAIL_WIDTH = 0.012; // 纸带半宽必须小于内圈半径，否则卷心自叠
const TAIL_THICK = 0.002;
const TAIL_STRAIGHT = 0.02; // 10cm 纸带里直垂的那一段
const TAIL_ROOT = [0, -0.09, -0.01];

const ANT_STEM = 0.02; // 6cm V 形天线：2cm 干 + 4cm 分叉
const ANT_REACH = 0.04;
const ANT_SPREAD = 0.49; // ±28°
const ANT_R = 0.0018;

const PAW_LEN = 0.02; // 四只小手：收在腹下，取信时伸出
const PAW_W = 0.014;
const PAW_T = 0.011;
const PAW_TILT = 0.52; // 收姿斜出 30°
const PAW_SWING = 2.27; // 伸出时摆 130°

const WALK_HZ = 1.15;
const CLIMB_HZ = 1.85;
const TAIL_SWAY = 0.05;
const ANT_WOBBLE = 0.06;
const CURSOR_DIM = new THREE.Color('#5a2a10');
const CURSOR_LIT = new THREE.Color('#ffc078');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// 截面环在局部 XY 平面、放样方向为局部 +Z。sign * |c|^(2/e)：e=2 是椭圆，e 越大越方。
function superRing(rx, ry, e, n, cx = 0, cy = 0) {
  const ex = 2 / e;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    pts.push([
      cx + Math.sign(ca) * Math.pow(Math.abs(ca), ex) * rx,
      cy + Math.sign(sa) * Math.pow(Math.abs(sa), ex) * ry,
    ]);
  }
  return pts;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 两点之间的一根渐缩管。骨链不带旋转，所以下面这套基读起来就是世界基。
function tube(a, b, r0, r1, rings, e = 2.1, flat = 1, n = RING) {
  const axis = new THREE.Vector3().subVectors(b, a);
  const len = axis.length();
  if (!(len > 1e-6)) throw new Error('[inbox-ding] tube() 需要两个不同的点。');
  axis.divideScalar(len);
  const ref = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(ref, axis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(axis, xAxis).normalize();
  const sections = [];
  for (let i = 0; i < rings; i++) {
    const u = rings > 1 ? i / (rings - 1) : 0;
    const r = r0 + (r1 - r0) * u;
    sections.push({ z: u * len, pts: superRing(r, r * flat, e, n) });
  }
  const geo = loft(sections, { closed: true, cap: true });
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, axis).setPosition(a.x, a.y, a.z));
  return geo;
}

// 圆角截面的等厚板：盒前脸、背盖、盖内纸绒都是它。
function plate(rx, ry, e, z0, z1, cx = 0, cy = 0) {
  const pts = superRing(rx, ry, e, RING, cx, cy);
  return loft([{ z: z0, pts }, { z: z1, pts }], { closed: true, cap: true });
}

// 矩形腔壁：背盖里的信笺腔由四根拼出来。
function bar(x0, x1, y0, y1, z0, z1) {
  const pts = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return loft([{ z: z0, pts }, { z: z1, pts }], { closed: true, cap: true });
}

// 一小片收坡的纸片：信笺与光标块都是它。
function tab(len, wid, thick) {
  const sections = [];
  for (let i = 0; i < 3; i++) {
    const u = i / 2;
    const k = 1 - 0.3 * Math.abs(u) * 2;
    sections.push({ z: u * len, pts: superRing((wid / 2) * k, (thick / 2) * k, 2.4, SMALL_RING) });
  }
  return loft(sections, { closed: true, cap: true });
}

// axis = 长边方向，up = 厚度方向，宽边由 up x axis 定。
function placeTab(geo, axis, up, pos) {
  const z = new THREE.Vector3().fromArray(axis).normalize();
  const y = new THREE.Vector3().fromArray(up).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos[0], pos[1], pos[2]));
  return geo;
}

// 头骨的子骨：头骨的矩阵是世界原点上的 identity，所以局部坐标就是世界坐标。
function childBone(parent, name, pos) {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.set(pos[0], pos[1], pos[2]);
  parent.add(bone);
  bone.updateMatrix();
  return bone;
}

// 屏面：只沿 X 弯的柱面，行字因此能逐段贴面放样。
function screenZ(x) {
  const k = 1 - (x / SCREEN_RX) * (x / SCREEN_RX);
  return BOX_Z1 + SCREEN_BULGE * Math.sqrt(Math.max(0, k));
}

// 一行墨字：沿 X 分段，每段的截面贴在屏面上。
function textRow(x0, x1, y) {
  const sections = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (x1 - x0) * (i / steps);
    const zs = screenZ(x) + 0.0007;
    sections.push({
      z: x,
      pts: [
        [y - ROW_H / 2, zs - ROW_D / 2],
        [y + ROW_H / 2, zs - ROW_D / 2],
        [y + ROW_H / 2, zs + ROW_D / 2],
        [y - ROW_H / 2, zs + ROW_D / 2],
      ],
    });
  }
  const geo = loft(sections, { closed: true, cap: true });
  // sections 的 z 是世界 x、pts 是 (世界 y, 世界 z)
  geo.applyMatrix4(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    ),
  );
  return geo;
}

// 纸带尾的中心线：先直垂一段，再在 XY 平面里绕 1.5 圈（朝 +x 卷）。
function tailCenterline() {
  const pts = [new THREE.Vector3(TAIL_ROOT[0], TAIL_ROOT[1], TAIL_ROOT[2])];
  pts.push(new THREE.Vector3(TAIL_ROOT[0], TAIL_ROOT[1] - TAIL_STRAIGHT, TAIL_ROOT[2]));
  const cy = TAIL_ROOT[1] - TAIL_STRAIGHT - TAIL_R0;
  const total = TAIL_TURNS * Math.PI * 2;
  const steps = 64;
  for (let i = 1; i <= steps; i++) {
    const th = (i / steps) * total;
    const r = TAIL_R0 + (TAIL_R1 - TAIL_R0) * (th / total);
    pts.push(
      new THREE.Vector3(
        r * Math.cos(Math.PI / 2 - th),
        cy + r * Math.sin(Math.PI / 2 - th),
        TAIL_ROOT[2],
      ),
    );
  }
  return pts;
}

// 按弧长等距取点：骨间距一致，蒙皮才不会把中段饿到零权重。
function pointsAtEqualArc(poly, count) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = poly[i].distanceTo(poly[i - 1]);
    seg.push(d);
    total += d;
  }
  const out = [];
  let i = 1;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (i < poly.length - 1 && acc + seg[i - 1] < target) {
      acc += seg[i - 1];
      i++;
    }
    const f = seg[i - 1] > 0 ? (target - acc) / seg[i - 1] : 0;
    out.push(poly[i - 1].clone().lerp(poly[i], Math.min(1, Math.max(0, f))));
  }
  return out;
}

// 多块几何拼成一件（转非索引后直连）：draw call 少一个是一个。
// 必须先转非索引再数字节：loft 出来的是索引几何，索引数远大于顶点数。
function mergeGeometries(list) {
  const srcs = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of srcs) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of srcs) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    pos.set(p.array.subarray(0, p.count * 3), o * 3);
    if (n) nrm.set(n.array.subarray(0, n.count * 3), o * 3);
    if (u) uv.set(u.array.subarray(0, u.count * 2), o * 2);
    o += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return geo;
}

function paletteOf(ctx) {
  const p = (ctx && ctx.palette) || {};
  return {
    ink: p.ink || '#14110E',
    paper: p.paper || '#F6F2EC',
    amber: (p.gradient && p.gradient[0]) || '#ffc078',
  };
}

function worldOf(bones) {
  const out = {};
  for (const [name, b] of Object.entries(bones)) out[name] = b.getWorldPosition(new THREE.Vector3());
  return out;
}

// 尾骨的世界坐标：tailWeight 按距离衰减，rest 姿态取一次就够（build 里填）。
let tailWorld = {};

// 腿顶加权到头骨：盒体前倾 12° 时髋部不裂开（盒底会因此后移约 2.4cm）。
function legWeight(name, p) {
  const side = p.x < 0 ? 'l' : 'r';
  const rides = smoothstep(-0.132, -0.092, p.y);
  const belowKnee = smoothstep(-0.138, -0.162, p.y);
  if (name === 'head') return rides;
  if (name === `thigh-${side}`) return (1 - rides) * (1 - belowKnee);
  if (name === `shin-${side}`) return (1 - rides) * belowKnee;
  return 0;
}

// 尾带同理：根部 3cm 跟着盒体倾，其余归尾骨。
function tailWeight(name, p) {
  const rides = smoothstep(-0.135, -0.105, p.y);
  if (name === 'head') return rides;
  const w = tailWorld[name];
  if (!w) return 0;
  return (1 - rides) * Math.max(0, 1 - p.distanceTo(w) / 0.018);
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export const model = {
  id: 'inbox-ding',
  build(ctx) {
    const pal = paletteOf(ctx);
    const cPaper = new THREE.Color().setStyle(pal.paper);
    const cInk = new THREE.Color().setStyle(pal.ink);
    const cAmber = new THREE.Color().setStyle(pal.amber);

    const MAT = {
      // 平色分工：壳比屏暗一档，缝内、取景罩与墨字用墨，信笺回到纸白——
      // 没有光照时也读得出「哪块在发光」
      shell: new THREE.MeshBasicMaterial({ color: cPaper.clone().lerp(cInk, 0.08) }),
      screen: new THREE.MeshBasicMaterial({ color: cAmber.clone() }),
      ink: new THREE.MeshBasicMaterial({ color: cInk.clone() }),
      letter: new THREE.MeshBasicMaterial({ color: cPaper.clone() }),
      cursor: new THREE.MeshBasicMaterial({ color: cAmber.clone() }),
    };

    const group = new THREE.Group();
    group.name = 'inbox-ding';

    // ---- 骨链：脊柱是盒内那根纵向短轴，头骨（= 盒体）是它的子骨 -----------
    const tailPts = pointsAtEqualArc(tailCenterline(), TAIL_BONES);
    const spec = [
      { name: 'spine', pos: [0, -0.06, 0] },
      { name: 'head', pos: [0, 0, 0], parent: 'spine' },
    ];
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'l' : 'r';
      spec.push({ name: `thigh-${side}`, pos: [s * LEG_X, LEG_HIP_Y, 0.02], parent: 'spine' });
      spec.push({
        name: `shin-${side}`,
        pos: [s * LEG_X, LEG_HIP_Y - THIGH, LEG_KNEE_Z],
        parent: `thigh-${side}`,
      });
    }
    tailPts.forEach((p, i) => {
      spec.push({
        name: `tail-${i}`,
        pos: [p.x, p.y, p.z],
        parent: i === 0 ? 'spine' : `tail-${i - 1}`,
      });
    });

    const { root, bones } = createBoneChain(spec);
    const B = bones;
    const world = worldOf(bones);
    tailWorld = {};
    for (const [name, b] of Object.entries(bones)) {
      if (name.startsWith('tail-')) tailWorld[name] = b.getWorldPosition(new THREE.Vector3());
    }

    // update() 每帧先复位的骨：姿势是按调用切的，旋转绝不跨调用累加
    const driven = [];
    for (const name of ['head', 'thigh-l', 'thigh-r', 'shin-l', 'shin-r']) driven.push(B[name]);
    for (const b of Object.values(B)) {
      if (b.name.startsWith('tail-')) driven.push(b);
    }
    // 位置被动画驱动的骨（行字、光标、格条）：rest 位置随取随用
    const moved = [];

    // ---- 盒体：侧壁 + 前脸 + 背盖腔，一块蒙皮 -------------------------------
    const sides = loft(
      Array.from({ length: 10 }, (_, i) => {
        const u = i / 9;
        return { z: BOX_Z0 + 0.003 + u * (BOX_Z1 - 0.003 - (BOX_Z0 + 0.003)), pts: superRing(BOX_RX, BOX_RY, BOX_E, RING) };
      }),
      { closed: true, cap: false },
    );
    const shellGeo = mergeGeometries([
      sides,
      plate(BOX_RX, BOX_RY, BOX_E, BOX_Z1 - 0.002, BOX_Z1),
      // 信笺腔的四根壁 + 腔底：墨色，从盒外只看见背盖上一道 3mm 的封边
      bar(-BOX_RX, BOX_RX, CAVITY_RY, BOX_RY, BOX_Z0 + 0.003, CAVITY_Z),
      bar(-BOX_RX, BOX_RX, -BOX_RY, -CAVITY_RY, BOX_Z0 + 0.003, CAVITY_Z),
      bar(-BOX_RX, -CAVITY_RX, -CAVITY_RY, CAVITY_RY, BOX_Z0 + 0.003, CAVITY_Z),
      bar(CAVITY_RX, BOX_RX, -CAVITY_RY, CAVITY_RY, BOX_Z0 + 0.003, CAVITY_Z),
      plate(CAVITY_RX, CAVITY_RY, BOX_E, CAVITY_Z - 0.003, CAVITY_Z),
    ]);
    // 低频铺纸面的体积、高频出纸纹；rest 姿态雕，bind 之前
    sculpt(shellGeo, { amp: 0.0007, freq: 5, seed: 'ding-shell', bone: B.head });
    const shellMesh = bindSkin(
      new THREE.Mesh(shellGeo, MAT.shell),
      root,
      (name) => (name === 'head' ? 1 : 0),
    );
    shellMesh.name = 'ding-shell';
    group.add(shellMesh);

    // ---- 屏：微凸的琥珀独眼，柱面只沿 X 弯 ---------------------------------
    const screenGeo = loft(
      Array.from({ length: 9 }, (_, i) => {
        const u = i / 8;
        const t = u * (Math.PI / 2) * 0.94; // 停在退化尖点之前
        return {
          z: BOX_Z1 + SCREEN_BULGE * Math.sin(t),
          pts: superRing(SCREEN_RX * Math.cos(t), SCREEN_RY, BOX_E, RING, 0, SCREEN_Y),
        };
      }),
      { closed: true, cap: true },
    );
    const screenMesh = bindSkin(
      new THREE.Mesh(screenGeo, MAT.screen),
      B.head,
      (name) => (name === 'head' ? 1 : 0),
    );
    screenMesh.name = 'ding-screen';
    group.add(screenMesh);

    // ---- 屏上的墨字行：七根骨各自带着一行滚动 ------------------------------
    const rowBones = ROW_Y.map((y, i) =>
      childBone(B.head, `row-${i}`, [ROW_X0, y, screenZ(ROW_X0) + 0.0007]),
    );
    for (let i = 0; i < ROW_Y.length; i++) {
      const y = ROW_Y[i];
      const geo = textRow(ROW_X0, ROW_X0 + ROW_LEN[i], y);
      const mesh = bindSkin(
        new THREE.Mesh(geo, MAT.ink),
        rowBones[i],
        (name) => (name === rowBones[i].name ? 1 : 0),
      );
      mesh.name = `ding-row-${i}`;
      group.add(mesh);
      driven.push(rowBones[i]);
      moved.push({ bone: rowBones[i], rest: rowBones[i].position.clone() });
    }

    // ---- 行尾的光标方块：贴着最底下那一行，按 hash 明灭 ---------------------
    const cursorAt = [ROW_X0 + ROW_LEN[0], ROW_Y[0], screenZ(ROW_X0 + ROW_LEN[0]) + 0.0009];
    const cursorBone = childBone(B.head, 'cursor', cursorAt);
    driven.push(cursorBone);
    moved.push({ bone: cursorBone, rest: cursorBone.position.clone() });
    const cursorGeo = placeTab(tab(0.005, 0.005, 0.0012), [1, 0, 0], [0, 0, 1], cursorAt);
    const cursorMesh = bindSkin(
      new THREE.Mesh(cursorGeo, MAT.cursor),
      cursorBone,
      (name) => (name === 'cursor' ? 1 : 0),
    );
    cursorMesh.name = 'ding-cursor';
    group.add(cursorMesh);

    // ---- 可动的嘴：makeJaw 的壳收成格栅缝，五根格条挂在颌骨上振动 ----------
    const jaw = makeJaw(B.head, {
      pivot: [0, SLOT_Y, SLOT_Z],
      range: [0, JAW_OPEN],
      axis: [1, 0, 0],
    });
    jaw.mesh.material = MAT.ink;
    jaw.mesh.name = 'ding-grille-slot';
    group.add(jaw.mesh);
    // 壳是钉死的 14x3x9cm 透镜：只能缩放颌骨（mesh 自己的 transform 会被 attached
    // 蒙皮约掉）。格条是颌骨的子骨，局部位置必须除掉同一个 scale，否则会被拉着
    // 往铰点塌。
    jaw.bone.scale.set(JAW_SCALE[0], JAW_SCALE[1], JAW_SCALE[2]);
    driven.push(jaw.bone);

    const grilleBones = [];
    for (let i = 0; i < GRILLE_N; i++) {
      const x = (i - (GRILLE_N - 1) / 2) * (GRILLE_W + 0.004);
      grilleBones.push(
        childBone(jaw.bone, `grille-${i}`, [x / JAW_SCALE[0], 0, (GRILLE_Z - SLOT_Z) / JAW_SCALE[2]]),
      );
    }
    for (let i = 0; i < GRILLE_N; i++) {
      const x = (i - (GRILLE_N - 1) / 2) * (GRILLE_W + 0.004);
      const geo = plate(GRILLE_W / 2, GRILLE_H / 2, 2.3, GRILLE_Z, GRILLE_Z + GRILLE_D, x, SLOT_Y);
      const mesh = bindSkin(
        new THREE.Mesh(geo, MAT.shell),
        grilleBones[i],
        (name) => (name === grilleBones[i].name ? 1 : 0),
      );
      mesh.name = `ding-grille-${i}`;
      group.add(mesh);
      driven.push(grilleBones[i]);
      moved.push({ bone: grilleBones[i], rest: grilleBones[i].position.clone() });
    }

    // ---- 眨眼：无眼睑，取景罩立起盖住整块屏即「屏整体暗下」 -----------------
    const lids = makeEyelids(B.head, { count: 1, range: [LID_REST, LID_SHUT], axis: [1, 0, 0] });
    lids.mesh.material = MAT.ink;
    lids.mesh.name = 'ding-visor';
    group.add(lids.mesh);
    for (const b of lids.bones) driven.push(b);

    // ---- 背盖：向上翻 70°，盖内衬纸绒，腔里躺着当晚要送的信笺 --------------
    const coverBone = childBone(B.head, 'cover', COVER_HINGE);
    driven.push(coverBone);
    const coverGeo = mergeGeometries([
      plate(BOX_RX, BOX_RY, BOX_E, COVER_HINGE[2] - 0.003, COVER_HINGE[2]),
      plate(BOX_RX - 0.005, BOX_RY - 0.005, BOX_E, COVER_HINGE[2], COVER_HINGE[2] + 0.003),
    ]);
    const coverMesh = bindSkin(
      new THREE.Mesh(coverGeo, MAT.shell),
      coverBone,
      (name) => (name === 'cover' ? 1 : 0),
    );
    coverMesh.name = 'ding-cover';
    group.add(coverMesh);

    // 信笺：7 x 5cm 三张，斜躺在腔里。placeTab 以一角为定位点，所以 x 要退半张。
    const letters = [
      { at: [-0.016, 0.022, 0.012], rot: -0.06 },
      { at: [0.014, -0.018, 0.02], rot: 0.05 },
      { at: [-0.002, 0.046, 0.028], rot: -0.03 },
    ];
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      const geo = placeTab(tab(0.07, 0.05, 0.0012), [1, 0, 0], [0, 0, 1], [
        L.at[0] - 0.035,
        L.at[1],
        L.at[2],
      ]);
      geo.rotateZ(L.rot);
      const mesh = bindSkin(
        new THREE.Mesh(geo, MAT.letter),
        B.head,
        (name) => (name === 'head' ? 1 : 0),
      );
      mesh.name = `ding-letter-${i}`;
      group.add(mesh);
    }

    // ---- 两条火柴腿：大腿前伸、小腿回落，膝反折 ----------------------------
    const legParts = [];
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'l' : 'r';
      const hip = world[`thigh-${side}`];
      const knee = world[`shin-${side}`];
      const ankle = knee.clone().setY(knee.y - SHIN).setZ(LEG_ANKLE_Z);
      const thigh = tube(hip, knee, LEG_R, LEG_R * 0.8, 5);
      // 髋节：幅度小、频率低，凸点落在大腿顶端
      sculpt(thigh, { amp: 0.0005, freq: 9, seed: `ding-thigh-${side}`, bone: B[`thigh-${side}`] });
      legParts.push(thigh);
      const shin = tube(knee, ankle, LEG_R * 0.8, LEG_R * 0.6, 5);
      // 膝节：频率高、幅度小，凸点落在小腿顶端（反折那一侧）
      sculpt(shin, { amp: 0.0006, freq: 13, seed: `ding-shin-${side}`, bone: B[`shin-${side}`] });
      legParts.push(shin);
    }
    const legsMesh = bindSkin(new THREE.Mesh(mergeGeometries(legParts), MAT.shell), root, legWeight);
    legsMesh.name = 'ding-legs';
    group.add(legsMesh);

    // ---- 尾：10cm 卷曲纸带，1.5 圈螺旋，自然下垂 ----------------------------
    const tailParts = [];
    for (let i = 0; i < tailPts.length - 1; i++) {
      const a = tailPts[i];
      const b = tailPts[i + 1];
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      dir.normalize();
      // 纸带平躺在 XY 平面里：宽边是平面法向（径向），厚边是世界 Z
      const xAxis = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
      const yAxis = new THREE.Vector3(0, 0, 1);
      const half = TAIL_WIDTH / 2;
      const thick = TAIL_THICK / 2;
      const pts = [
        [-half, -thick],
        [half, -thick],
        [half, thick],
        [-half, thick],
      ];
      const geo = loft([{ z: 0, pts }, { z: len * 0.5, pts }, { z: len, pts }], {
        closed: true,
        cap: true,
      });
      geo.applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, dir).setPosition(a.x, a.y, a.z));
      tailParts.push(geo);
    }
    const tailGeo = mergeGeometries(tailParts);
    // 纸纤维：高频小幅度，读作纸的齿感而不是泥
    sculpt(tailGeo, { amp: 0.0004, freq: 16, seed: 'ding-tail', bone: B['tail-5'] });
    const tailMesh = bindSkin(new THREE.Mesh(tailGeo, MAT.shell), root, tailWeight);
    tailMesh.name = 'ding-tail';
    group.add(tailMesh);

    // ---- 四只小手：收在腹下（藏在盒里），取信时伸出 -------------------------
    const pawBones = [];
    const pawGeos = [];
    for (const s of [-1, 1]) {
      for (const [tag, z] of [
        ['f', 0.09],
        ['b', 0.0],
      ]) {
        const side = s < 0 ? 'l' : 'r';
        const base = new THREE.Vector3(s * 0.052, -0.108, z);
        const dir = new THREE.Vector3(s * Math.sin(PAW_TILT), Math.cos(PAW_TILT), 0);
        const tip = base.clone().addScaledVector(dir, PAW_LEN);
        pawBones.push(childBone(B.head, `paw-${tag}${side}`, [base.x, base.y, base.z]));
        pawGeos.push(tube(base, tip, PAW_W / 2, PAW_T / 2, 3, 2.4, 0.8, SMALL_RING));
      }
    }
    const pawWorld = pawBones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    const pawsMesh = bindSkin(
      new THREE.Mesh(mergeGeometries(pawGeos), MAT.shell),
      B.head,
      (name, position) => {
        for (let i = 0; i < pawBones.length; i++) {
          if (pawBones[i].name === name) {
            return Math.max(0, 1 - position.distanceTo(pawWorld[i]) / 0.03);
          }
        }
        return 0;
      },
    );
    pawsMesh.name = 'ding-paws';
    group.add(pawsMesh);
    for (const b of pawBones) driven.push(b);

    // ---- V 形天线：2cm 干 + 两根 4.5cm 分叉，总高 6cm ----------------------
    const stemBase = new THREE.Vector3(0, BOX_RY, BOX_CZ);
    const fork = stemBase.clone().setY(BOX_RY + ANT_STEM);
    const antStem = childBone(B.head, 'antenna-stem', [fork.x, (BOX_RY + fork.y) / 2, fork.z]);
    driven.push(antStem);
    const stemGeo = tube(stemBase, fork, ANT_R, ANT_R * 0.9, 3);
    const stemMesh = bindSkin(
      new THREE.Mesh(stemGeo, MAT.shell),
      antStem,
      (name) => (name === 'antenna-stem' ? 1 : 0),
    );
    stemMesh.name = 'ding-antenna-stem';
    group.add(stemMesh);

    const prongLen = ANT_REACH / Math.cos(ANT_SPREAD);
    const prongTips = [
      fork.clone().add(new THREE.Vector3(-Math.sin(ANT_SPREAD) * prongLen, ANT_REACH, 0)),
      fork.clone().add(new THREE.Vector3(Math.sin(ANT_SPREAD) * prongLen, ANT_REACH, 0)),
    ];
    const prongBones = [
      childBone(antStem, 'antenna-left', [fork.x, fork.y, fork.z]),
      childBone(antStem, 'antenna-right', [fork.x, fork.y, fork.z]),
    ];
    for (const b of prongBones) driven.push(b);
    for (let i = 0; i < 2; i++) {
      const geo = tube(fork, prongTips[i], ANT_R * 0.9, ANT_R * 0.3, 4);
      const mesh = bindSkin(
        new THREE.Mesh(geo, MAT.shell),
        prongBones[i],
        (name) => (name === prongBones[i].name ? 1 : 0),
      );
      mesh.name = i === 0 ? 'ding-antenna-left' : 'ding-antenna-right';
      group.add(mesh);
    }

    // 表情/姿态键（update(t, ctx) 的第二个参数是可选的提示面，缺省全部由 t 推导）：
    //   ctx.pose        'idle'（默认）| 'walk' | 'climb' | 'ride' | 'sit' | 'sleep'
    //                   —— 待机 / 跟班下台阶 / 攀爬袍缘 / 骑肩 / 坐壳脊 / 睡着
    //   ctx.expression  'calm'（默认）| 'speak' | 'think' | 'take' | 'sleep'
    //                   —— 滚字 / 出声 / 光标快闪 / 伸手开盖取信 / 屏暗
    //   ctx.amount      0..1，姿势强度，默认 1
    //   ctx.cover       0..1，背盖翻开量（盖内纸绒随盖翻；信笺留在腔里不跟着走）
    //   ctx.wind        radians，V 天线的固定倾角，正 = 向 +Z（渡海场的后倒传负值）
    //   ctx.turn        radians，整组绕 Y 转身
    const JAW_AXIS = new THREE.Vector3(1, 0, 0);
    const LID_AXIS = new THREE.Vector3(1, 0, 0);
    const tailBoneList = driven.filter((b) => b.name.startsWith('tail-'));

    function update(t, ctx) {
      const time = Number.isFinite(t) ? t : 0;
      const c = ctx || {};
      const pose = typeof c.pose === 'string' ? c.pose : 'idle';
      const expr = typeof c.expression === 'string' ? c.expression : 'calm';
      const amount = Number.isFinite(c.amount) ? Math.min(1, Math.max(0, c.amount)) : 1;
      const wind = Number.isFinite(c.wind) ? c.wind : 0;
      const turn = Number.isFinite(c.turn) ? c.turn : 0;
      const coverWant = Number.isFinite(c.cover)
        ? Math.min(1, Math.max(0, c.cover))
        : expr === 'take'
          ? 1
          : 0;

      group.rotation.y = turn;
      // 待机呼吸：整组极轻地起落，双脚不离地（1.5mm）
      const asleep = expr === 'sleep' || pose === 'sleep';
      group.position.y = 0.227 + 0.0015 * Math.sin((time * Math.PI * 2) / 4.2) * (asleep ? 0.4 : 1);

      // 姿势按调用切，先把被驱动的骨复位：旋转与位置都不跨调用累加
      for (const b of driven) b.quaternion.identity();
      for (const m of moved) m.bone.position.copy(m.rest);

      const talking = expr === 'speak' && !asleep;
      const taking = expr === 'take' ? amount : 0;
      const pedaling = pose === 'walk' || pose === 'climb' ? amount : 0;
      const tucking = pose === 'ride' || pose === 'sit' || pose === 'sleep' ? amount : 0;

      // 点头：待机时绕盒内那根纵轴缓缓前倾 12°，攀爬时压到底
      const nodIdle = 0.5 - 0.5 * Math.cos((time * Math.PI * 2) / NOD_SEC);
      const nod = asleep ? 0.3 : pose === 'climb' ? 1 : nodIdle;
      B.head.rotation.x = NOD * (nod + 0.25 * pedaling);

      // 嘴：只有 speak 走 rig 的说话节拍，其余时刻闭着。格条的振动量读颌骨的
      // 实际张角，于是「出声时缝内五根格条上下振动」与嘴开合同源。
      if (talking) jaw.update(time);
      else jaw.bone.quaternion.setFromAxisAngle(JAW_AXIS, 0);
      const open = Math.min(1, Math.max(0, jaw.bone.rotation.x / JAW_OPEN));
      for (let i = 0; i < grilleBones.length; i++) {
        grilleBones[i].position.y =
          GRILLE_HOP * open * Math.sin(time * GRILLE_HZ * Math.PI * 2 + i * 1.1);
      }

      // 眨眼：无眼睑。睡眠时取景罩直控合盖（屏整体暗下），其余走 rig 的眨眼时刻表
      if (asleep) {
        for (const b of lids.bones) b.quaternion.setFromAxisAngle(LID_AXIS, LID_SHUT);
      } else {
        lids.update(time);
      }

      // 字行：终端读法——向上滚，出环即换行；睡眠时停格
      if (asleep) {
        MAT.cursor.color.copy(CURSOR_DIM);
      } else {
        const shift = (time * SCROLL_MM) % ROW_SPAN;
        for (let i = 0; i < rowBones.length; i++) {
          let y = ROW_Y[i] + shift;
          if (y > ROW_Y[0] + ROW_SPAN - 1e-9) y -= ROW_SPAN;
          rowBones[i].position.y = y;
        }
        // 光标贴着最底下那一行：换行的瞬间跟着跳，正是终端光标的样子
        let cur = 0;
        for (let i = 1; i < rowBones.length; i++) {
          if (
            Math.abs(rowBones[i].position.y - ROW_Y[0]) <
            Math.abs(rowBones[cur].position.y - ROW_Y[0])
          ) {
            cur = i;
          }
        }
        const cx = ROW_X0 + ROW_LEN[cur];
        cursorBone.position.set(cx, rowBones[cur].position.y, screenZ(cx) + 0.0009);
        const hz = expr === 'think' ? 6 : 2.2;
        const on = hash1(Math.floor(time * hz) + 7) > 0.35;
        MAT.cursor.color.copy(CURSOR_DIM).lerp(CURSOR_LIT, on ? 1 : 0.08);
      }

      // 背盖：向上翻 70°，盖内纸绒与信笺随盖翻转
      coverBone.rotation.x = COVER_OPEN * coverWant;

      // 腿：walk / climb 是步态，ride / sit / sleep 把两条火柴腿收起来
      if (pedaling > 0) {
        const phase = time * (pose === 'climb' ? CLIMB_HZ : WALK_HZ) * Math.PI * 2;
        for (const s of [-1, 1]) {
          const side = s < 0 ? 'l' : 'r';
          const ph = phase + (s < 0 ? 0 : Math.PI);
          B[`thigh-${side}`].rotation.x = 0.34 * Math.sin(ph) * pedaling;
          // 膝反折：小腿只向后折，不向前跪
          B[`shin-${side}`].rotation.x = (0.1 + 0.5 * Math.max(0, Math.sin(ph + 0.9))) * pedaling;
        }
      }
      if (tucking > 0) {
        for (const s of [-1, 1]) {
          const side = s < 0 ? 'l' : 'r';
          B[`thigh-${side}`].rotation.x = -1.15 * tucking;
          B[`shin-${side}`].rotation.x = 1.6 * tucking;
        }
      }

      // 小手：take 时伸出，ride 时扣紧（抓住袍领那一帧）
      const reach = Math.max(taking, pose === 'ride' ? 0.35 * amount : 0);
      for (const b of pawBones) {
        const side = b.name.endsWith('l') ? -1 : 1;
        b.rotation.z = -side * PAW_SWING * reach;
      }

      // 尾带：行波摆向侧面，锚在 t=0 那一帧是自然下垂
      const sway = TAIL_SWAY * (0.4 + 0.6 * pedaling) * (asleep ? 0.3 : 1);
      for (let i = 0; i < tailBoneList.length; i++) {
        const lag = (i / 3) * Math.PI * 2;
        tailBoneList[i].rotation.z = sway * (Math.sin(time * 1.6 - lag) + Math.sin(lag));
      }

      // 天线：待机轻晃；海风给一个固定倾角（渡海场：后倒、不摆）
      const wobble = asleep ? 0.15 : 1;
      antStem.rotation.x = wind + ANT_WOBBLE * wobble * Math.sin(time * 2.3);
      const lag = Math.PI * 0.35;
      const prongWobble = ANT_WOBBLE * wobble * (Math.sin(time * 2.3 - lag) + Math.sin(lag));
      prongBones[0].rotation.x = prongWobble;
      prongBones[1].rotation.x = prongWobble;
    }
    update(0, ctx);

    // createBoneChain 只认 spec；makeJaw / makeEyelids / childBone 都是之后才挂上
    // 骨头的，所以名单从最终的骨图上取。
    const boneNames = [];
    root.traverse((o) => {
      if (o.isBone) boneNames.push(o.name);
    });
    group.userData.materials = MAT;
    group.userData.boneMap = Object.fromEntries(boneNames.map((n) => [n, root.getObjectByName(n)]));
    group.position.y = 0.227;
    return { group, bones: boneNames, update };
  },
};
