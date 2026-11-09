// models/lampkeeper-que.js — 守灯人·阙：纸洲上当值的守灯人，四场皆在场的定场之锚。
//
// 与 rig.js 同源的三条硬约束，改这个文件前先读：
//   1) 确定性：update(t, ctx) 只由 (t, ctx) 决定。采集链按 t=i/24 逐场景取帧并
//      比对两次渲染的字节；读墙钟或跨调用累加状态会把「同一 t 两次渲染不一致」
//      变成不可排查的玄学。闪烁类节律走 src/util/rand.js 的 hash1，禁 Math.random。
//   2) 一个 rest 世界空间：全部几何与骨都建在角色站姿的世界坐标里（面朝 +Z、
//      双脚踩 y=0，总高约 1.6m）。bindSkin 之后再单独挪某根骨的 rest 位置，
//      部件会跟着姿势变形而不是整体移动——要调比例就在这里的常量里调。
//   3) 骨必须在被渲染的图里：每件 Mesh 各自 bindSkin 一次，rootless 的 root 由
//      bindSkin 接管，有父节点的 root 靠躯干那件先入图带进去。
//
// 两个不得不这么做的决定，理由都写在代码里：
//   · 头颅单独包一层 headGroup。rig.js 的 makeEyelids 把睑梁壳建在世界坐标
//     (0, LID_UP, LID_FORWARD) 上（rig.js:569-577），只有头骨位于世界原点时壳才
//     与睑骨重合；所以头颅在局部空间建好后再整组平移到站位，蒙皮走 three 的
//     attached 模式跟随这层变换。
//   · 材质用 THREE.MeshBasicMaterial 平色。本文件按约定只许 import three /
//     ../util/rand.js / ./rig.js，拿不到 render/cel.js 的两 band 着色；颜色仍从
//     ctx.palette 取，导演侧要换 cel 材质时逐个 mesh.material 赋即可。

import * as THREE from 'three';
import { hash1 } from '../util/rand.js';
import { bindSkin, createBoneChain, loft, makeEyelids, makeJaw, sculpt } from './rig.js';

// ---------------------------------------------------------------------------
// 比例：单位米，rest 世界空间。几何与骨的 rest 位置都从这里长出来。
// ---------------------------------------------------------------------------

const RING = 16; // 每节环上的点数；loft 按索引缝环，各节必须一致
const SMALL_RING = 8; // 手指这类小件用不到 16 点

const ROBE_E = 2.4; // 钟形长袍的超椭圆指数（任务书给定：近方不近圆）
const ROBE_DEPTH = 0.78; // 每节的前后深 / 左右宽

const HIPS_Y = 0.88;
const WAIST_RX = 0.16; // 腰线截面半宽（任务书给定）
const HEM_Y = 0.22;
const HEM_RX = 0.34; // 摆底截面半宽（任务书给定）
const HEM_RZ = HEM_RX * ROBE_DEPTH;

const HEAD_AT = [0, 1.48, 0.004]; // 头颅装配原点的世界位置
const CHIN_Y = 1.355; // 与颈顶对齐

// 节拍：全是 t 的纯函数，没有一处时钟
const BREATH_HZ = 1 / 4.2; // 一次待机呼吸 4.2 秒，与睑的眨眼周期错开
const WALK_HZ = 1.17; // 归港一场 6 秒 14 步 ≈ 每周期两步
const FLAME_HZ = 1 / 1.7; // 随身灯芯的火苗
const LID_CLOSED = Math.PI / 2; // 横褶压到水平即「合眼」
const SOCKET_TILT = (20 * Math.PI) / 180; // 眼窝斜上 20°

const JAW_AXIS = new THREE.Vector3(1, 0, 0);
const LID_AXIS = new THREE.Vector3(1, 0, 0);
const CURSOR_DIM = new THREE.Color('#5a2a10');
const CURSOR_LIT = new THREE.Color('#ffc078');
const SPOT_DIM = new THREE.Color('#7a3a16');
const SPOT_LIT = new THREE.Color('#ffd9a0');

// 截面环在局部 XY 平面、放样方向为局部 +Z；这个基把局部 (x, y, z) 映到世界
// (x, z, y)，于是「环面 = 世界 XZ 平面、放样 = 世界上方向」。
const UP = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 1, 0),
);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function superRing(rx, ry, e, n, cx = 0, cy = 0) {
  const ex = 2 / e;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // sign * |c|^(2/e)：e=2 是椭圆，e 越大越方。e=2.4 即任务书的钟形截面。
    pts.push([
      cx + Math.sign(ca) * Math.pow(Math.abs(ca), ex) * rx,
      cy + Math.sign(sa) * Math.pow(Math.abs(sa), ex) * ry,
    ]);
  }
  return pts;
}

// 颅顶的环：脸一面指数高（一块平板），后脑指数低（圆润），上半环再叠三道折痕。
function skullRing(rx, rz, eFace, eBack, crown) {
  const pts = [];
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2; // 0 = +x，PI/2 = +z（脸）
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const e = eBack + (eFace - eBack) * Math.max(0, sa);
    const ex = 2 / e;
    let x = Math.sign(ca) * Math.pow(Math.abs(ca), ex) * rx;
    let z = Math.sign(sa) * Math.pow(Math.abs(sa), ex) * rz;
    if (crown > 0) {
      // 负号让极小值（折痕）落在 x/rx = 0、±2/3：恰好三道
      const lobe = 1 - crown * Math.cos((x / rx) * Math.PI * 3);
      x *= lobe;
      z *= lobe;
    }
    pts.push([x, z]);
  }
  return pts;
}

// 两点之间的一根渐缩管。骨链不带旋转，所以下面这套基读起来就是世界基。
function tube(a, b, r0, r1, rings, e = 2.1, flat = 1, n = RING) {
  const axis = new THREE.Vector3().subVectors(b, a);
  const len = axis.length();
  if (!(len > 1e-6)) throw new Error('[lampkeeper-que] tube() 需要两个不同的点。');
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

// 一小片收坡的纸片：眼窝、嘴、光标块、摆缘光斑都是它。
function tab(len, wid, thick) {
  const sections = [];
  for (let i = 0; i < 3; i++) {
    const u = i / 2;
    const k = 1 - 0.35 * Math.abs(u) * 2;
    sections.push({ z: u * len, pts: superRing((wid / 2) * k, (thick / 2) * k, 2.4, SMALL_RING) });
  }
  return loft(sections, { closed: true, cap: true });
}

// axis = 长边方向，up = 厚度方向，宽边由 up × axis 定。
function placeTab(geo, axis, up, pos) {
  const z = new THREE.Vector3().fromArray(axis).normalize();
  const y = new THREE.Vector3().fromArray(up).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos[0], pos[1], pos[2]));
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

// rig 的 bindSkin 按「全部命中的总和」归一、却只存最强的四根（rig.js:378-384）：
// 第五根起的权重被静默丢掉，顶点于是被拉向原点（蒙皮盒会塌、渲染会缩）。
// 所以权重函数必须自己把影响数压到四根以内——这里只保留最近的四根骨，
// 半径因此可以放宽到只管过渡软硬与覆盖，不必再担心超编。
// names 只取「这根 root 以下、且过 include 筛的骨」：bindSkin 只遍历 root
// 以下的骨，拿全表去排名会把压根问不到你的骨排进前四，本骨反而一个权重都不剩。
function topFour(world, root, radius, include) {
  const names = [];
  root.traverse((o) => {
    if (o.isBone && (!include || include(o.name))) names.push(o.name);
  });
  return (name, position) => {
    const hits = [];
    let self = 0;
    for (const n of names) {
      const w = world[n];
      const d = position.distanceTo(w);
      if (d < radius) {
        const v = 1 - d / radius;
        hits.push([n, v]);
        if (n === name) self = v;
      }
    }
    if (hits.length <= 4) return self;
    // 同值用名字断先后，保证恰好四根吃权重
    hits.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    for (let i = 0; i < 4; i++) if (hits[i][0] === name) return hits[i][1];
    return 0;
  };
}

// 长袍只跟躯干与摆缘走：腿骨摆起来会把摆缘顶点拽下去（摆底 rx 0.34 比踝骨还
// 近），所以袍子的权重表里根本不列四肢。
const ROBE_BONES = new Set([
  'hips', 'spine-low', 'spine-mid', 'chest', 'neck',
  'shoulder-l', 'shoulder-r',
  'hem-l', 'hem-r', 'hem-f', 'hem-b',
]);

// ---------------------------------------------------------------------------
// 静态数据
// ---------------------------------------------------------------------------

// 钟形长袍的截面：腰 0.16、摆 0.34，胸段随脊柱微弓（z 收负），腰段回正。
const ROBE_SECTIONS = [
  [0.22, 0.34, 0.0],
  [0.3, 0.332, 0.0],
  [0.4, 0.316, 0.0],
  [0.52, 0.292, 0.0],
  [0.64, 0.26, 0.0],
  [0.76, 0.222, 0.0],
  [0.88, WAIST_RX, 0.0],
  [0.98, 0.158, 0.001],
  [1.08, 0.166, 0.0],
  [1.18, 0.176, -0.01],
  [1.25, 0.18, -0.009],
  [1.3, 0.132, -0.007],
  [1.335, 0.08, -0.006],
];

// 纸袋形颅：脸一面平板、后脑圆润、颅顶收褶成一道尖。
const HEAD_SECTIONS = [
  { y: -0.125, rx: 0.086, rz: 0.098, crown: 0 },
  { y: -0.085, rx: 0.093, rz: 0.107, crown: 0 },
  { y: -0.035, rx: 0.098, rz: 0.113, crown: 0 },
  { y: 0.015, rx: 0.1, rz: 0.117, crown: 0.02 },
  { y: 0.06, rx: 0.099, rz: 0.115, crown: 0.05 },
  { y: 0.095, rx: 0.09, rz: 0.1, crown: 0.08 },
  { y: 0.118, rx: 0.06, rz: 0.062, crown: 0.1 },
  { y: 0.128, rx: 0.026, rz: 0.026, crown: 0.1 },
];

// 软尖无趾的足：截面底边钉在 y=0，rest 姿态即着地摊平的那一帧。
const FOOT_SECTIONS = [
  { z: -0.045, rx: 0.03, ry: 0.026 },
  { z: -0.01, rx: 0.033, ry: 0.03 },
  { z: 0.04, rx: 0.03, ry: 0.026 },
  { z: 0.09, rx: 0.024, ry: 0.018 },
  { z: 0.13, rx: 0.014, ry: 0.009 },
  { z: 0.152, rx: 0.006, ry: 0.004 },
];

const FINGERS = [
  { name: 'index', dx: -0.032 },
  { name: 'middle', dx: -0.011 },
  { name: 'ring', dx: 0.011 },
  { name: 'little', dx: 0.03 },
];

// 骨链：绝对坐标，父骨必须先于子骨出现。上臂:前臂 ≈ 1:1.15 由 pos 定出来。
function boneSpec() {
  const spec = [
    { name: 'hips', pos: [0, HIPS_Y, 0] },
    { name: 'spine-low', pos: [0, 0.98, 0.001], parent: 'hips' },
    { name: 'spine-mid', pos: [0, 1.08, 0.0], parent: 'spine-low' },
    { name: 'chest', pos: [0, 1.18, -0.01], parent: 'spine-mid' },
    { name: 'neck', pos: [0, 1.27, -0.007], parent: 'chest' },
  ];
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'l' : 'r';
    spec.push({ name: `shoulder-${side}`, pos: [s * 0.165, 1.22, -0.004], parent: 'chest' });
    spec.push({ name: `elbow-${side}`, pos: [s * 0.215, 1.0, -0.002], parent: `shoulder-${side}` });
    spec.push({ name: `wrist-${side}`, pos: [s * 0.245, 0.72, 0.0], parent: `elbow-${side}` });
    spec.push({ name: `palm-${side}`, pos: [s * 0.248, 0.645, 0.006], parent: `wrist-${side}` });
    for (const f of FINGERS) {
      let px = s * (0.248 + f.dx);
      let py = 0.625;
      let pz = 0.012;
      let parent = `palm-${side}`;
      for (let k = 0; k < 3; k++) {
        const name = `finger-${side}-${f.name}${k + 1}`;
        py -= 0.024;
        pz += 0.005;
        spec.push({ name, pos: [px, py, pz], parent });
        parent = name;
      }
    }
    // 拇指：三节，从掌心内侧斜出，与四指对握
    let tx = s * 0.232;
    let ty = 0.632;
    let tz = 0.024;
    let tparent = `palm-${side}`;
    for (let k = 0; k < 3; k++) {
      const name = `thumb-${side}${k + 1}`;
      tx += -s * 0.002;
      ty -= 0.019;
      tz += 0.012;
      spec.push({ name, pos: [tx, ty, tz], parent: tparent });
      tparent = name;
    }
    spec.push({ name: `hip-${side}`, pos: [s * 0.085, 0.86, 0.0], parent: 'hips' });
    spec.push({ name: `knee-${side}`, pos: [s * 0.105, 0.52, 0.004], parent: `hip-${side}` });
    spec.push({ name: `ankle-${side}`, pos: [s * 0.118, 0.1, -0.002], parent: `knee-${side}` });
    spec.push({ name: `foot-${side}`, pos: [s * 0.12, 0.03, 0.15], parent: `ankle-${side}` });
  }
  // 摆缘四根：呼吸摆动与风向倾斜都落在这里，光斑也挂在它们身上
  spec.push({ name: 'hem-l', pos: [-0.26, 0.23, 0.0], parent: 'hips' });
  spec.push({ name: 'hem-r', pos: [0.26, 0.23, 0.0], parent: 'hips' });
  spec.push({ name: 'hem-f', pos: [0.0, 0.23, 0.21], parent: 'hips' });
  spec.push({ name: 'hem-b', pos: [0.0, 0.23, -0.21], parent: 'hips' });
  return spec;
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

export const model = {
  id: 'lampkeeper-que',
  build(ctx) {
    const pal = paletteOf(ctx);
    const cPaper = new THREE.Color().setStyle(pal.paper);
    const cInk = new THREE.Color().setStyle(pal.ink);
    const cAmber = new THREE.Color().setStyle(pal.amber);

    const MAT = {
      // 平色分工：袍比面具暗一档、四肢再暗一档，没有光照时也能读出体积
      robe: new THREE.MeshBasicMaterial({ color: cPaper.clone().lerp(cInk, 0.1) }),
      limb: new THREE.MeshBasicMaterial({ color: cPaper.clone().lerp(cInk, 0.2) }),
      mask: new THREE.MeshBasicMaterial({ color: cPaper.clone() }),
      ink: new THREE.MeshBasicMaterial({ color: cInk.clone() }),
      cursor: new THREE.MeshBasicMaterial({ color: cAmber.clone() }),
    };

    const group = new THREE.Group();
    group.name = 'lampkeeper-que';

    const { root, bones } = createBoneChain(boneSpec());
    const B = bones;
    const world = worldOf(bones);

    // update() 每帧先把这些骨复位：姿势是按调用切的，旋转绝不跨调用累加
    const driven = [];
    for (const name of [
      'chest', 'neck',
      'shoulder-l', 'shoulder-r', 'elbow-l', 'elbow-r', 'wrist-l', 'wrist-r',
      'hip-l', 'hip-r', 'knee-l', 'knee-r', 'ankle-l', 'ankle-r',
      'hem-l', 'hem-r', 'hem-f', 'hem-b',
    ]) {
      driven.push(B[name]);
    }
    for (const name of Object.keys(B)) {
      if (name.startsWith('finger-') || name.startsWith('thumb-')) driven.push(B[name]);
    }

    // ---- 钟形长袍 ----------------------------------------------------------
    const robeGeo = loft(
      ROBE_SECTIONS.map(([y, rx, cz]) => ({
        z: y,
        pts: superRing(rx, rx * ROBE_DEPTH, ROBE_E, RING, 0, cz),
      })),
      { closed: true, cap: true },
    );
    robeGeo.applyMatrix4(UP);
    // 低频铺布褶的体积、高频出纸纹；rest 姿态雕，bind 之前
    sculpt(robeGeo, { amp: 0.006, freq: 3.5, seed: 'que-robe', bone: B.hips });
    const robeMesh = bindSkin(
      new THREE.Mesh(robeGeo, MAT.robe),
      root,
      topFour(world, root, 0.5, (n) => ROBE_BONES.has(n)),
    );
    robeMesh.name = 'que-robe';
    group.add(robeMesh);

    // ---- 颈：从领口斜上接到颅底 --------------------------------------------
    const neckGeo = tube(
      new THREE.Vector3(0, 1.28, -0.006),
      new THREE.Vector3(0, CHIN_Y, 0.004),
      0.04, 0.046, 5, 2.2, 0.92,
    );
    const neckMesh = bindSkin(
      new THREE.Mesh(neckGeo, MAT.limb),
      B.neck,
      (name) => (name === 'neck' ? 1 : 0),
    );
    neckMesh.name = 'que-neck';
    group.add(neckMesh);

    // ---- 四肢：细长，肘/膝/肩的骨节起伏由 sculpt 沿各自骨雕出来 -------------
    // 半径要盖住整段：顶点若在所有骨的半径外，bindSkin 直接抛错（rig.js:374）；
    // 影响数超编由 topFour 收口，半径因此只决定过渡软硬。
    const limbs = [];
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'l' : 'r';
      const arm = tube(world[`shoulder-${side}`], world[`elbow-${side}`], 0.034, 0.027, 5);
      sculpt(arm, { amp: 0.005, freq: 9, seed: `que-arm-${side}`, bone: B[`shoulder-${side}`] });
      limbs.push([`que-arm-${side}`, arm, B[`shoulder-${side}`], 0.17]);

      const fore = tube(world[`elbow-${side}`], world[`wrist-${side}`], 0.027, 0.019, 5);
      // 肘节：频率高、幅度小，凸点落在前臂顶端（肘骨那一端）
      sculpt(fore, { amp: 0.006, freq: 13, seed: `que-fore-${side}`, bone: B[`elbow-${side}`] });
      limbs.push([`que-forearm-${side}`, fore, B[`elbow-${side}`], 0.19]);

      limbs.push([
        `que-palm-${side}`,
        tube(world[`wrist-${side}`], world[`palm-${side}`], 0.03, 0.032, 3, 2.3, 0.55),
        B[`wrist-${side}`], 0.09,
      ]);

      for (const f of FINGERS) {
        const a = world[`finger-${side}-${f.name}1`];
        const b = world[`finger-${side}-${f.name}3`];
        limbs.push([
          `que-fingers-${side}-${f.name}`,
          tube(a, b, 0.009, 0.0065, 4, 2.0, 0.9, SMALL_RING),
          B[`finger-${side}-${f.name}1`], 0.05,
        ]);
      }
      const ta = world[`thumb-${side}1`];
      const tb = world[`thumb-${side}3`];
      limbs.push([
        `que-thumb-${side}`,
        tube(ta, tb, 0.01, 0.007, 4, 2.0, 0.9, SMALL_RING),
        B[`thumb-${side}1`], 0.05,
      ]);

      // 腿的上段在袍里，只放样到膝下一段；摆缘以下才看得见
      const thigh = tube(world[`hip-${side}`], world[`knee-${side}`], 0.058, 0.04, 5);
      limbs.push([`que-thigh-${side}`, thigh, B[`hip-${side}`], 0.22]);
      const shin = tube(world[`knee-${side}`], world[`ankle-${side}`], 0.04, 0.026, 5);
      // 膝节同肘：凸点落在小腿顶端
      sculpt(shin, { amp: 0.006, freq: 13, seed: `que-shin-${side}`, bone: B[`knee-${side}`] });
      limbs.push([`que-shin-${side}`, shin, B[`knee-${side}`], 0.25]);

      // 足：软尖无趾，底边钉在 y=0。「着地时摊平」做在 rest 几何里（截面底边一律
      // 落在 y=0、前后压扁），不放在 update 的骨缩放上：骨的缩放是绕骨原点的，
      // 一压就把脚底抬离地面 12mm；而 SkinnedMesh 自己的缩放会被蒙皮里的
      // bindMatrixInverse 抵掉（skinning_vertex.glsl.js），根本不出现在画面上。
      const footGeo = loft(
        FOOT_SECTIONS.map((c) => ({
          z: c.z,
          pts: superRing(c.rx, c.ry, 2.2, RING, s * 0.118, c.ry),
        })),
        { closed: true, cap: true },
      );
      limbs.push([`que-foot-${side}`, footGeo, B[`ankle-${side}`], 0.2]);
    }
    for (const [name, geo, bone, radius] of limbs) {
      const mesh = bindSkin(new THREE.Mesh(geo, MAT.limb), bone, topFour(world, bone, radius));
      mesh.name = name;
      group.add(mesh);
    }

    // ---- 头颅：在局部空间里以原点为头骨，装配完再整组平移到站位 ------------
    // makeEyelids 的睑梁壳建在世界坐标 (0, LID_UP, LID_FORWARD)，头骨不在原点时
    // 壳与睑骨就错了位；所以头颅在局部空间建。这一层 group 的位置留到装配全部
    // 结束后才设：蒙皮算的是「骨的世界矩阵 × bind 时抓的逆矩阵」，而颌骨/睑骨
    // 挂在头骨下面、不跟着自己那件 SkinnedMesh 走，先落位再 bind 会让 mesh 与
    // bone 各挪各的——整组蒙皮会错位到 -HEAD_AT。
    const headGroup = new THREE.Group();
    headGroup.name = 'que-head-group';
    group.add(headGroup);

    const headBone = new THREE.Bone();
    headBone.name = 'head';

    const headGeo = loft(
      HEAD_SECTIONS.map((c) => ({ z: c.y, pts: skullRing(c.rx, c.rz, 3.2, 1.9, c.crown) })),
      { closed: true, cap: true },
    );
    headGeo.applyMatrix4(UP);
    sculpt(headGeo, { amp: 0.003, freq: 11, seed: 'que-skull', bone: headBone });
    const headMesh = bindSkin(
      new THREE.Mesh(headGeo, MAT.mask),
      headBone,
      (name) => (name === 'head' ? 1 : 0),
    );
    headMesh.name = 'que-skull';
    headGroup.add(headMesh);

    // 眼窝：两道斜上 20° 的墨色纸片，探出睑梁前面 2mm——睑梁压下时正好被盖住。
    // 位置被两条边界夹着：x 必须收在睑梁的 10cm 宽度内（LID_WIDTH），z 必须越过
    // 睑梁合上前的 front face（LID_FORWARD + LID_DEPTH/2），所以眼窝是一对贴在
    // 面具前面的墨色竖签，而不是浮雕。
    for (const s of [-1, 1]) {
      const geo = placeTab(
        tab(0.018, 0.003, 0.003),
        [s * Math.cos(SOCKET_TILT), Math.sin(SOCKET_TILT), 0],
        [0, 0, 1],
        [s * 0.037, 0.034, 0.129],
      );
      const mesh = bindSkin(
        new THREE.Mesh(geo, MAT.ink),
        headBone,
        (name) => (name === 'head' ? 1 : 0),
      );
      mesh.name = s < 0 ? 'que-socket-l' : 'que-socket-r';
      headGroup.add(mesh);
    }

    // 可动的嘴：铰点在唇中线，壳尖探出脸面，3cm 横切口挂在颌骨上随它开合
    const jaw = makeJaw(headBone, { pivot: [0, -0.058, 0.072], range: [0, 0.55], axis: [1, 0, 0] });
    jaw.mesh.material = MAT.mask;
    jaw.mesh.name = 'que-jaw';
    headGroup.add(jaw.mesh);

    const mouthGeo = placeTab(tab(0.008, 0.03, 0.004), [0, 1, 0], [0, 0, 1], [0, -0.062, 0.119]);
    const mouthMesh = bindSkin(
      new THREE.Mesh(mouthGeo, MAT.ink),
      jaw.bone,
      (name) => (name === jaw.bone.name ? 1 : 0),
    );
    mouthMesh.name = 'que-mouth';
    headGroup.add(mouthMesh);

    // 可动的眼睑：面具上一道横褶，合眼时下压盖住眼窝（眠时唯一表情）
    const lids = makeEyelids(headBone, { count: 2, range: [0, LID_CLOSED], axis: [1, 0, 0] });
    lids.mesh.material = MAT.mask;
    lids.mesh.name = 'que-lids';
    headGroup.add(lids.mesh);

    // 右颊一枚 4mm 琥珀方块（终端光标）
    const cursorGeo = placeTab(tab(0.004, 0.004, 0.002), [1, 0, 0], [0, 0, 1], [0.056, -0.052, 0.122]);
    const cursorMesh = bindSkin(
      new THREE.Mesh(cursorGeo, MAT.cursor),
      headBone,
      (name) => (name === 'head' ? 1 : 0),
    );
    cursorMesh.name = 'que-cursor';
    headGroup.add(cursorMesh);

    // 头颅装配收口：此刻所有 bind 都已完成，整组（骨与 mesh 一起）平移到站位
    headGroup.position.fromArray(HEAD_AT);

    // ---- 摆缘光斑：随身灯芯的琥珀从袍摆内衬透出 -----------------------------
    // 挂在摆缘骨上，呼吸摆动与风倾都由骨带过去；绕环的角度是 t 的纯函数。
    const spots = [];
    const spotGeo = tab(0.03, 0.02, 0.012);
    const quad = [
      { bone: 'hem-f', center: Math.PI * 0.5, half: Math.PI * 0.2, phase: 0 },
      { bone: 'hem-r', center: 0, half: Math.PI * 0.2, phase: 1.7 },
      { bone: 'hem-b', center: Math.PI * 1.5, half: Math.PI * 0.2, phase: 3.1 },
      { bone: 'hem-l', center: Math.PI, half: Math.PI * 0.2, phase: 4.6 },
    ];
    for (const q of quad) {
      const mat = new THREE.MeshBasicMaterial({ color: cAmber.clone() });
      const mesh = new THREE.Mesh(spotGeo, mat);
      mesh.name = `que-hem-spot-${q.bone}`;
      B[q.bone].add(mesh);
      spots.push({
        mesh,
        rest: world[q.bone].clone(),
        center: q.center,
        half: q.half,
        phase: q.phase,
      });
    }

    const fingerBones = driven.filter(
      (b) => b.name.startsWith('finger-') || b.name.startsWith('thumb-'),
    );

    function update(t, ctx) {
      const time = Number.isFinite(t) ? t : 0;
      const c = ctx || {};
      const pose = typeof c.pose === 'string' ? c.pose : 'idle';
      const expr = typeof c.expression === 'string' ? c.expression : 'calm';
      const amount = Number.isFinite(c.amount) ? Math.min(1, Math.max(0, c.amount)) : 1;
      const wind = Number.isFinite(c.wind) ? c.wind : 0;
      const turn = Number.isFinite(c.turn) ? c.turn : 0;

      group.rotation.y = turn;
      headGroup.rotation.set(0, 0, 0);
      // 姿势按调用切，先把被驱动的骨复位：旋转绝不跨调用累加
      for (const b of driven) {
        b.quaternion.identity();
        b.scale.set(1, 1, 1);
      }
      B.hips.position.set(0, HIPS_Y, 0);

      const breath = Math.sin(time * BREATH_HZ * Math.PI * 2);
      const walk = pose === 'walk' ? amount : 0;
      const kneel = pose === 'kneel' ? amount : 0;
      const reach = pose === 'reach' ? amount : 0;
      const reachArm = Math.max(reach, kneel);
      let drop = 0; // 髋下沉量：行走的轻沉与跪姿都走它，头颅跟着一起落

      // 待机呼吸：胸廓微升、腕与指跟着轻扣——静止姿态也要有形
      B.chest.rotation.x = 0.014 * breath + 0.05 * kneel + 0.04 * reach;
      B.neck.rotation.x = -0.02 * breath;
      B['shoulder-l'].rotation.x = 0.02 * breath;
      B['shoulder-r'].rotation.x = 0.02 * breath;
      for (const side of ['l', 'r']) B[`wrist-${side}`].rotation.x = 0.03 * breath;

      // 行走：髋前后摆、膝只向后弯；踝反向补偿髋+膝，脚底才保持水平不啃地
      // （不补偿时整条腿攒下 0.7rad，趾尖能扎到地面以下 5cm），再叠一点迈步的
      // 蹬地起伏。手臂与同侧腿反相。
      if (walk > 0) {
        const phase = time * WALK_HZ * Math.PI * 2;
        for (const s of [-1, 1]) {
          const side = s < 0 ? 'l' : 'r';
          const ph = phase + (s < 0 ? 0 : Math.PI);
          const hipRot = 0.3 * Math.sin(ph);
          const kneeRot = 0.08 + 0.42 * Math.max(0, Math.sin(ph + 0.8));
          B[`hip-${side}`].rotation.x = hipRot * walk;
          B[`knee-${side}`].rotation.x = kneeRot * walk;
          B[`ankle-${side}`].rotation.x = (-(hipRot + kneeRot) + 0.05 * Math.sin(ph + 1.2)) * walk;
          B[`shoulder-${side}`].rotation.x = -0.14 * Math.sin(ph) * walk;
        }
        // 身体随步态轻沉；幅度压在厘米级，脚步不因此离地
        drop = 0.012 * (1 - Math.cos(2 * phase)) * 0.5 * walk;
      }

      // 单膝点地：髋下沉 18cm（袍摆随之落到离地 4cm，再低摆缘就穿地），
      // 左腿按两节 IK 解出来把左脚钉在原地，右腿前折下探；右臂同时前伸去接信笺。
      if (kneel > 0) {
        drop = 0.18 * kneel;
        B.chest.rotation.x = 0.05 * kneel;
        B['hip-l'].rotation.x = -0.8 * kneel;
        B['knee-l'].rotation.x = 1.42 * kneel;
        B['ankle-l'].rotation.x = -0.62 * kneel;
        B['hip-r'].rotation.x = -0.9 * kneel;
        B['knee-r'].rotation.x = 1.5 * kneel;
        B['ankle-r'].rotation.x = -0.6 * kneel;
      }

      // 右臂前伸：按甲片、接信笺、提灯都走这一条
      if (reachArm > 0) {
        B['shoulder-r'].rotation.x = -1.15 * reach - 0.55 * kneel;
        B['elbow-r'].rotation.x = -0.28 * reach - 0.3 * kneel;
        B['wrist-r'].rotation.x = 0.45 * reach + 0.4 * kneel;
      }

      // 髋下沉：行走的轻沉与跪姿共用这一个量，摆缘、光斑都跟着它
      B.hips.position.y = HIPS_Y - drop;

      // 摆缘：呼吸轻张，再叠风向的统一偏角（夜雨一场的 12° 由 ctx.wind 给）
      const sway = 0.022 * breath;
      B['hem-l'].rotation.z = -sway - wind * 0.35;
      B['hem-r'].rotation.z = sway - wind * 0.35;
      B['hem-f'].rotation.x = -sway - wind;
      B['hem-b'].rotation.x = sway + wind * 0.3;

      // 头颅自己缓摆；转身交给 ctx.turn（整组绕 Y，不是头的局部旋转）。
      // 头组的位置跟着髋下沉走——它挂在世界坐标上，不跟着脊柱链落。
      headGroup.position.set(HEAD_AT[0], HEAD_AT[1] - drop, HEAD_AT[2]);
      headGroup.rotation.y = 0.035 * Math.sin(time * 0.42);
      headGroup.rotation.x = 0.014 * Math.sin(time * 0.31 + 1);

      // 指：三节常态微扣，伸手时放开
      const curl = -0.09 - 0.04 * breath + 0.07 * reach;
      for (const b of fingerBones) b.rotation.x = curl;

      // 眼睑：眠时横褶压到底，其余走 rig 的眨眼时刻表
      if (expr === 'sleep') {
        for (const b of lids.bones) b.quaternion.setFromAxisAngle(LID_AXIS, LID_CLOSED);
      } else {
        lids.update(time);
      }

      // 嘴：只有 speak 走 rig 的说话节拍，其余时刻闭着
      if (expr === 'speak') jaw.update(time);
      else jaw.bone.quaternion.setFromAxisAngle(JAW_AXIS, 0);

      // 右颊光标：think 时按 hash 明暗闪烁，平静时随灯芯火苗呼吸
      if (expr === 'think') {
        const on = hash1(Math.floor(time * 2.4) + 11) > 0.3;
        MAT.cursor.color.copy(CURSOR_DIM).lerp(CURSOR_LIT, on ? 1 : 0.1);
      } else {
        const flame = 0.5 + 0.5 * Math.sin(time * FLAME_HZ * Math.PI * 2);
        MAT.cursor.color.copy(CURSOR_DIM).lerp(CURSOR_LIT, 0.3 + 0.7 * flame);
      }

      // 摆缘光斑：绕摆环游走，走动时游得快，亮度跟着同一道火苗
      const roam = walk > 0 ? 1.5 : 0.45;
      for (const spot of spots) {
        const a = spot.center + spot.half * Math.sin(time * roam + spot.phase);
        const wx = HEM_RX * 0.99 * Math.cos(a);
        const wz = HEM_RZ * 0.99 * Math.sin(a);
        spot.mesh.position.set(wx - spot.rest.x, HEM_Y - spot.rest.y, wz - spot.rest.z);
        const flame = 0.5 + 0.5 * Math.sin(time * FLAME_HZ * Math.PI * 2 + spot.phase);
        spot.mesh.material.color.copy(SPOT_DIM).lerp(SPOT_LIT, 0.25 + 0.75 * flame);
      }
    }
    update(0, ctx);

    const boneNames = [
      ...Object.keys(B),
      'head',
      jaw.bone.name,
      lids.bones[0].parent.name,
      ...lids.bones.map((b) => b.name),
    ];
    return { group, bones: boneNames, update };
  },
};
