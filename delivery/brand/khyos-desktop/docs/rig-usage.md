# rig.js 用法 —— 建模子代理照抄这份

> 真源：`src/models/rig.js`（角色/生物建模的**唯一**公共层，ES module）。
> 签名、默认值、行为一律以源码为准，本文只做速查与最小用例。
> 依赖仅两个：`three@^0.170` 与 `src/util/rand.js`；**不依赖渲染层**——材质由调用方给。
>
> 接线提示：`src/main.js` 加载的是导演侧的 `src/models.js`（`main.js:99`），
> rig.js 是被它引用的公共层，不要直接把 rig.js 挂成第四个集成模块。

## 0. 先读：三条硬约束

1. **确定性**：一切都是 `(输入, t)` 的纯函数。采集链按 `t = i/24` 逐场景取帧并比对
   两次渲染的字节；读墙钟或跨调用累加状态都会把「同一 t 两次渲染不一致」变成玄学。
   随机一律走 `src/util/rand.js`（`mulberry32` / `hashString` / `hash3`），
   **禁 `Math.random` / `Date.now`**。`update(t)` 只写骨的局部旋转，不读时钟、不累加。
2. **一个 rest 世界空间**：几何与骨骼都建在世界坐标里。`bindSkin` 抓取的
   `bindMatrix` 与 `boneInverses` 以 bind 那一刻的世界矩阵为准——bind 之后**单独**
   挪某根骨的 rest 位置，部件会跟着变形而不是整体移动。要调位置，在 bind 之前调。
3. **骨必须在被渲染的图里**：`Skeleton.update()` 读 `bone.matrixWorld`，不在场景图里的骨
   矩阵永不刷新，蒙皮会**静默停在 rest**。`bindSkin` 会接管没有父节点的 root；
   root 已有父节点时，调用方自己 `scene.add(root)`。

## 1. 导出清单

| 导出 | 签名 | 返回 |
|---|---|---|
| `loft` | `loft(sections, opts)` | `THREE.BufferGeometry`（position/normal/uv + index） |
| `sculpt` | `sculpt(geometry, opts)` | 同一 geometry（原地修改） |
| `createBoneChain` | `createBoneChain(spec)` | `{ root, bones: { name: Bone } }` |
| `bindSkin` | `bindSkin(mesh, root, weightFn)` | `THREE.SkinnedMesh` |
| `makeJaw` | `makeJaw(headBone, opts)` | `{ bone, mesh, update }` |
| `makeEyelids` | `makeEyelids(headBone, opts)` | `{ bone, bones, mesh, update }` |
| `makeFin` | `makeFin(bone, opts)` | `{ bone, bones, mesh, update }` |

三个装配件的 `update(t)`（t 为秒）都是纯函数，`update(0)` 即各自挺直/闭合的 rest 姿态；
装配件内部已各自 `bindSkin` 一次，拿到就能进场景。

## 2. loft —— 截面曲线放样

```js
loft(sections, opts)
// sections = [{ z, pts: [[x, y], ...] }, ...]  沿放样方向有序；每节点数必须一致
// opts = { closed = false, cap = true }
```

- `closed`：每节首尾相接成环；`cap`：两端加盖（盖与侧壁共享顶点，边缘是圆的）。
- 环序（顺/逆时针）**没有约定也不必管**：有向体积为负时整体翻面，法线一律朝外。
- `pts` 是 `[x, y]`，放样方向是 `z`；要沿别的轴放样，把截面数据按轴换位写即可。

```js
const body = loft(
  Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    const r = 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.02;
    return {
      z: -6 + t * 6,
      pts: Array.from({ length: 12 }, (_, k) => {
        const a = (k / 12) * Math.PI * 2;
        return [Math.cos(a) * r, Math.sin(a) * r * 0.5];
      }),
    };
  }),
  { closed: true, cap: true },
);
```

## 3. sculpt —— 沿骨骼的确定性位移雕刻

```js
sculpt(geometry, { amp, freq, seed, bone })
// amp   位移幅度（米）；<= 0 直接 no-op
// freq  噪声频率（越大越碎）
// seed  种子字符串，同种子同结果
// bone  指定骨骼（Bone/Object3D）；省略时用几何自身坐标系
```

- 每个顶点沿**法线**移动 `amp * (2*fbm - 1)`，噪声在骨的 rest 世界坐标系里取样——
  浮雕跟着骨骼走。多次调用可叠加（低频铺体积、高频出碎纹），每次都会重读当前位置。
- **原地修改并返回同一 geometry**，结束时重算法线与包围球。
- 在**播放姿势之前**调用：雕的是 rest，不是姿态。

```js
sculpt(body, { amp: 0.02, freq: 5, seed: 'ink-eel', bone: bones.mid });
sculpt(body, { amp: 0.006, freq: 16, seed: 'ink-eel-scales' });
```

## 4. createBoneChain —— 骨链

```js
createBoneChain(spec)
// spec = [{ name, pos: [x, y, z], parent }, ...]   pos 是世界坐标；父骨必须先于子骨出现
// 返回 { root, bones: { name: Bone } }
```

骨**只有位置、没有旋转**（spec 里也没有旋转字段）。方向由世界坐标的拓扑关系推导，
或由装配件的 `opts.axis` 显式给出。要歪头/侧身，把倾斜写进 `pos`，不要用 `rotation`
（装配件的壳是按「挂载骨 rest 姿态无旋转」布置的）。

```js
const { root, bones } = createBoneChain([
  { name: 'tail', pos: [-6, 0, 0] },
  { name: 'mid', pos: [0, 0, 0], parent: 'tail' },
  { name: 'head', pos: [5.4, 0.2, 0], parent: 'mid' },
]);
// bones.mid.position 已被换算成父骨空间里的局部坐标；bones.mid.getWorldPosition() 回到世界坐标
```

## 5. bindSkin —— 蒙皮

```js
bindSkin(mesh, root, weightFn)  // -> THREE.SkinnedMesh
// weightFn(boneName, position) -> 权重；position 是该顶点的 rest 世界坐标
```

- 每个顶点取权重最高的 **4 根骨**并归一化（WebGL 的 `skinIndex` 是 `vec4`，第 5 根起
  被静默丢弃）——权重函数要写得集中。
- 任何顶点全骨权重为 0 会**抛错**：那种顶点没有骨拉着，会塌到原点，静默反而更贵。
- 几何与骨在同一个 rest 世界空间；mesh 保持单位变换挂进该空间。
- root 无父节点时会被挂成 SkinnedMesh 的子节点（保证骨进场景图）。
- bind 之后整棵树可以一起移动/统一缩放（attached 模式每帧刷新 `bindMatrixInverse`）。
- 多个 SkinnedMesh 可以共享同一组骨：每个 mesh 各自 `bindSkin` 一次即可。

```js
const boneWorld = Object.fromEntries(
  Object.entries(bones).map(([name, b]) => [name, b.getWorldPosition(new THREE.Vector3())]),
);
const bodyMesh = bindSkin(new THREE.Mesh(body), root, (name, position) => {
  const w = boneWorld[name];
  return w ? Math.max(0, 1 - position.distanceTo(w) / 1.6) : 0;
});
```

## 6. 装配件 —— 可动嘴 / 眼睑 / 鳍·四肢

三者同形：`{ bone, mesh, update(t) }`（眼睑与鳍额外给 `bones: Bone[]`）。
`mesh` 是已经蒙好骨的 SkinnedMesh；`bone` 是驱动它的那根骨。
**默认没有材质**——把 cel 材质赋上去再进场景（颜色属渲染层，rig 不替你选）。

```js
import { createCelMaterial } from '../render/cel.js';
const cel = createCelMaterial({ base: '#2b2f3a', shadow: '#141821', rim: '#ffb75e', materialId: 3 });
jaw.mesh.material = cel;
```

### makeJaw(headBone, opts) —— 可动嘴

```js
makeJaw(headBone, { pivot, range, axis })
// pivot  世界坐标铰点（缺省 = 头骨位置）
// range  [闭合角, 张开角] 弧度，缺省 [0, 0.5]
// axis   铰链轴，缺省世界 +X（角色面朝 +Z 时的左右轴）
```

壳是一枚以 `pivot` 为铰、向**前**收窄的透镜体；`update(t)` 按说话节拍开合
（3.4s 一句话，其中 72% 在说，每秒 2.6 次）。骨命名 `<头骨名>-jaw`。

### makeEyelids(headBone, opts) —— 可动眼睑

```js
makeEyelids(headBone, { count, range, axis })
// count  睑骨数，缺省 2（1 就是一道整宽面罩睑；越多越像一道扫过去的褶）
// range  [静息角, 闭合角] 弧度，缺省 [0, 1.15]
// axis   铰链轴，缺省世界 +X
```

壳是立在眼裂上沿的一根横梁（宽 `LID_WIDTH`），每根睑骨负责一片；眨眼时刻表：
4.2s 一次、每次 0.16s，分段之间有 0.4s 的扫过延迟。默认布局按 ~0.3m 量级的头：
眼裂中心在头骨局部系 `(0, LID_UP, LID_FORWARD)`。骨命名 `<头骨名>-lid<i>`。

### makeFin(bone, opts) —— 鳍 / 四肢装配件

```js
makeFin(bone, { segments, span, axis })
// segments 鳍骨段数，缺省 5
// span     总长（米），缺省 0.3；段长 = span/segments
// axis     生长轴，在挂载骨的父空间里给出，缺省世界 +Y（背鳍/尾鳍开箱即用）
```

膜面根半宽 `span/2`、尖收到 `span*0.12`，宽度方向取「挂载骨来向（父骨→挂载骨）」
在轴上的垂直投影。`update(t)` 是行波：1.2Hz、幅 0.3rad、3 段一个完整波，
FK 叠加所以鳍尖摆得最欢。骨命名 `<挂载骨名>-fin<i>`。
四肢（带蹼的腿）同样用它：`axis` 给肢体方向即可。

## 7. 端到端最小用例（一条墨鳗）

```js
import * as THREE from 'three';
import { createCelMaterial } from '../render/cel.js';
import { bindSkin, createBoneChain, loft, makeEyelids, makeFin, makeJaw, sculpt } from './rig.js';

// 1) 身体：尾到吻的放样
const body = loft(
  Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    const rx = 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.02;
    return {
      z: -6 + t * 6,
      pts: Array.from({ length: 12 }, (_, k) => {
        const a = (k / 12) * Math.PI * 2;
        return [Math.cos(a) * rx, Math.sin(a) * rx * 0.5];
      }),
    };
  }),
  { closed: true, cap: true },
);

// 2) 骨链（绝对坐标，父骨在前）：13 节脊骨，首尾命名
const spec = [];
for (let i = 0; i < 13; i++) {
  const name = i === 0 ? 'tail' : i === 12 ? 'head' : `spine${i}`;
  spec.push({ name, pos: [0, 0, -6 + i], parent: i > 0 ? spec[i - 1].name : undefined });
}
const { root, bones } = createBoneChain(spec);

// 3) 雕刻：rest 姿态、bind 之前
sculpt(body, { amp: 0.02, freq: 5, seed: 'ink-eel', bone: bones.spine6 });

// 4) 蒙皮
const boneWorld = Object.fromEntries(
  Object.entries(bones).map(([name, b]) => [name, b.getWorldPosition(new THREE.Vector3())]),
);
const bodyMesh = bindSkin(new THREE.Mesh(body), root, (name, position) => {
  const w = boneWorld[name];
  return w ? Math.max(0, 1 - position.distanceTo(w) / 1.6) : 0;
});

// 5) 装配件（各自内部已 bindSkin）
const jaw = makeJaw(bones.head, { pivot: [0, -0.06, 5.9] });
const lids = makeEyelids(bones.head, { count: 2 });
const dorsal = makeFin(bones.spine6, { segments: 6, span: 0.9, axis: [0, 1, 0] });

// 6) 每帧：纯函数更新，然后 renderer.render(scene, camera)
function frame(t) {
  jaw.update(t);
  lids.update(t);
  dorsal.update(t);
}

// 7) 材质与入图
const cel = createCelMaterial({ base: '#2b2f3a', shadow: '#141821', rim: '#ffb75e', materialId: 3 });
for (const m of [bodyMesh, jaw.mesh, lids.mesh, dorsal.mesh]) m.material = cel;
scene.add(bodyMesh, jaw.mesh, lids.mesh, dorsal.mesh, root);
```

## 8. 装配件默认布局常量（要改比例就在 bindSkin 之前改）

| 常量 | 值 | 管什么 |
|---|---|---|
| `JAW_LENGTH` / `JAW_HALF_WIDTH` / `JAW_HALF_HEIGHT` | 0.09 / 0.07 / 0.015 m | 嘴壳前伸长、半宽、半厚 |
| `JAW_TALK_HZ` / `JAW_SENTENCE_SEC` / `JAW_SPEAK_RATIO` | 2.6 / 3.4 / 0.72 | 说话节拍 |
| `LID_WIDTH` / `LID_LENGTH` / `LID_SLIT` / `LID_DEPTH` | 0.1 / 0.05 / 0.03 / 0.012 m | 睑梁宽、长、眼裂高、厚 |
| `LID_UP` / `LID_FORWARD` | 0.02 / 0.12 m | 眼裂中心在头骨局部系的位置 |
| `LID_BLINK_PERIOD` / `LID_BLINK_SEC` / `LID_SWEEP` | 4.2 / 0.16 / 0.4 s | 眨眼时刻表与扫过延迟 |
| `FIN_WAVE_HZ` / `FIN_WAVE_AMP` / `FIN_WAVE_PERIOD` | 1.2 Hz / 0.3 rad / 3 段 | 鳍行波 |

## 9. 坑位表

| # | 坑 | 规矩 |
|---|---|---|
| 1 | 每顶点只有 4 根骨生效 | 权重函数写集中；第 5 根起被静默丢弃 |
| 2 | 全零权重的顶点塌到原点 | `bindSkin` 直接抛错——修 `weightFn`，别绕过。权重支撑要盖满全身：骨间距一半是下限，稀疏骨链会把中段顶点饿到零权重 |
| 3 | bind 后单独改骨的 rest 位置 | 部件会变形而非移动；调位置放在 bind 前 |
| 4 | 骨不在场景图里 | 蒙皮静默停在 rest；root 有父节点时自己 `scene.add(root)` |
| 5 | 装配件默认无材质 | 进场景前赋 cel 材质，否则渲染期才炸 |
| 6 | 开放壳配 FrontSide 材质从背面消失 | 装配件全部用闭合环+盖；自己放样时同理 |
| 7 | 挂载骨带旋转 | 装配件的壳按 rest 无旋转布置；倾斜写进 spec 的 `pos` |
| 8 | `sculpt` 重算法线与包围球 | 手调过的法线会被覆盖；要保留就别 sculpt |
| 9 | 各截面点数不一致 | `loft` 抛错；环序无所谓（自动翻面朝外） |
| 10 | 随机 | 只走 `src/util/rand.js`；`Math.random`/`Date.now` 一出现就破坏字节级复现 |

## 10. 自测

```bash
node --check src/models/rig.js
```

语法检查之外，本层的行为（法线朝外、雕刻确定性、rest 姿态零漂移、眨眼扫过、
鳍行波相位）由一次性冒烟脚本在仓外验证，不入库。
