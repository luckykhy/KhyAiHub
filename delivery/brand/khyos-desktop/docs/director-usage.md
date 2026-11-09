# director.js 用法 —— 导演层契约与走位键

> 真源：`src/director/director.js`（场景调度、相机、走位、表情、特效的**唯一**公共层，ES module）。
> 签名、默认值、行为一律以源码为准，本文只做速查与键位表。
> 依赖：`three@^0.170`、`src/render/cel.js`、`src/render/quantize.js`、`src/util/rand.js`，
> 以及三份 JSON（`src/story/scenes.json`、`src/story/cast.json`、`delivery/brand/khy-brand-tokens.json`，
> 后两份由打包器内联，Node ESM 侧带 `with { type: 'json' }`）。

## 0. 先读：两条硬约束

1. **`renderSceneAt(sceneId, t)` 是 `(sceneId, t)` 的纯函数。** 采集链按 `t = i/24` 逐场景取帧，
   并比对同一时刻两次渲染的字节（`scripts/capture.mjs --selftest`）。所以一帧之内不许读墙钟、
   不许跨调用累加状态、不许 `Math.random` / `Date.now`。随机一律走 `src/util/rand.js` 的
   `hash1` / `hashString` / `mulberry32`；所有脚本运动都写成 `t` 的函数。
2. **姿势一拍二、特效一拍三**（`src/render/quantize.js`）：手绘动画一张画hold 两帧，
   24fps 每帧重算姿势就是 sub-frame crawl。**间距**（飞行航线、相机运动、走位）保持一拍一——
   这正是手绘里 spacing 的含义；模型自身的节律（呼吸、眨眼、振翅）随之落在量化时钟上。

## 1. 导出清单

```js
import { createDirector } from './director/director.js';

const director = createDirector({ scene, camera, pipeline, models, scenes });
// scene   THREE.Scene        场景图；角色组与导演自建的环境/特效都挂进来
// camera  THREE.PerspectiveCamera  透视相机（管线的 mpp 由透视投影推导，正交会抛错）
// pipeline createPipeline() 的返回值，至少要有 render(t) / setFade(a)
// models  { [castId]: modelModule }，由 main.js 组装后传入（五个 cast.json id 一个不能少）
// scenes  scenes.json 的内容（也接受 [{ id, durationSec }] 数组；缺省回落到磁盘上的 scenes.json）
```

| 导出 | 签名 | 行为 |
|---|---|---|
| `sceneIds()` | `() => string[]` | 场景顺序，**必须与 scenes.json 的 scenes 数组同序同名**（capture 用它比对） |
| `sceneAt(t)` | `(t) => id` | 按 cycle 与各场景 durationSec 推 `t` 落在哪个场景（自动轮播，可越界可取负） |
| `renderAt(t)` | `(t) => t` | `renderSceneAt(sceneAt(t), t - 场景起点)`；读播放头（`setScene` 改的锚点） |
| `renderSceneAt(sceneId, t)` | `(id, t) => t` | **纯函数**：一切相机、姿势、表情、特效由 `(sceneId, t)` 推出 |
| `renderTransition(fromId, toId, k)` | `k∈[0,1]` | 纸色淡切：前半段淡出到纸色、后半段从纸色淡入；两侧内容不硬跳 |
| `setScene(id)` | `(id) => id` | 只影响**播放模式**的手动切换：把轮播锚点挪到该场景首帧；采集模式不走它 |
| `currentScene()` | `() => id` | 播放头当前所在场景（= `sceneAt(0)`） |
| `dispose()` | `() => void` | 卸下角色组、销毁导演自建的几何/材质；**scene / camera / pipeline 归调用方**，不动 |

## 2. 场景覆盖

四场全覆盖（`sceneIds()` = `dawn-lamp, tortoise-crossing, night-rain, homecoming`）。
每个场景一段方向函数（`directDawnLamp` 等），返回相机、逐角色 `ctx/place/life` 与环境/特效状态。

| 场景 | 时长 | 相机 | 在场角色 | 主事件 → 画面 |
|---|---|---|---|---|
| `dawn-lamp` 晨灯 | 28s | static `[0.2,1.75,7.2]` fov 40 | 阙·丁·笺·岱龟（渊不入画） | t=6 灯芯点起（两帧内从无到有）；t=12 丁开机受命；t=15 阙提灯转身面向海面；t=19 笺蛾惊醒飞两圈半；t=27.9 龟首出水 |
| `tortoise-crossing` 渡海 | 32s | orbit：半径 6.5m、140° 弧（尾侧→头侧），末 15% ease-out，fov 48 | 全体五名 | 步态 3.2s、每 1.6s 一簇水花；t=13 渊横渡墨面之下；t=16 弧顶正侧面；t=26 阙按甲片、笺蛾落指尖 |
| `night-rain` 夜雨 | 30s | handheld：基准 dolly + 种子摇晃（±0.06m，阵风 ×1.5，t=24 后余振衰减），t=18 摇向海面再回摇，fov 55 | 全体五名 | t=13 信笺脱盖、渊翻身；t=15 笺蛾衔住弧顶信笺；t=22 送进阙掌心；t=24 雨收、屏滚「已收妥」 |
| `homecoming` 归港 | 28s | dolly/crane：y 5.6→3.2、z 9.9，lookAt (0.9, 1.95→1.3, 2.6)（前 5 秒下沉后保持），前 18% 匀速之后二次 ease-out（t=17 时走完全程 79%），fov 40 | 全体五名 | t=5 阙下行抵达单膝点地投递、琥珀窗亮起；t=14 甲缝流光应答；t=19 渊辞别；t=26 笺蛾绕行一圈后出画 |

环境与特效按场景显影（探针实测）：码头灯台只在晨灯；壳脊灯杆挂岱龟 `spine4` 骨上（随甲胄呼吸），
渡海/夜雨/归港三场随行；环灯在晨灯与渡海可见，夜雨场隐藏（壳脊灯是唯一光源）；
湿滩/纸屋/光带只在归港；雨场、信笺只在夜雨。

## 3. 姿势键（`ctx` 第二参数）

键位全部来自各模型文件自己声明的面，导演只做选择与编排，不发明新键。

### lampkeeper-que（`pose` idle|walk|kneel|reach，`expression` calm|think|speak|sleep，`amount`，`wind`）

| 场景 | pose | expression | 备注 |
|---|---|---|---|
| dawn-lamp | idle → **reach** 5.5–8.3 | calm | t=14.5 预备（反向仰 0.4s），t=14.5–16.1 转身 yaw −2.35 |
| tortoise-crossing | idle → **reach** 25.4–27.9 | calm | 立于南脊灯杆旁，面具朝向龟首 |
| night-rain | idle | calm | `wind 0.21`（衣摆 12°，t=9–24.5），整组 roll 0.02 |
| homecoming | **walk**（t<5.98，`tOffset +1`）→ **kneel** 5.4–24.2 → idle | calm | 6s/14 步之字形下行；14 次落地压扁 + 抵达压扁 |

### inbox-ding（`pose` idle|walk|climb|ride|sit|sleep，`expression` calm|speak|think|take|sleep，`cover`，`wind`）

| 场景 | pose | expression | 备注 |
|---|---|---|---|
| dawn-lamp | **climb** 11.2–12.7 → sit | **take** 11.8–13.4 | t<10.6 藏在阙腰后挂篓里（不显影）；抵达台阶即落地压扁 |
| tortoise-crossing | ride | calm | 骑右肩，`wind −0.3`（天线后倒） |
| night-rain | sit | **think** 13.4–22（光标狂闪）→ **take** 22.6–24.2 | `cover` 窗 12.6–14.6（信笺自此脱出又自己合上） |
| homecoming | walk（`tOffset +1.42`）→ idle | calm | 与阙平行、间距恒定；`cover` 窗 0–8 |

### paper-moth-jian（`pose` rest|sleep|fly|alert|perch|feed|rain，`wingHz`，`wind`，`mood`）

| 场景 | pose | wingHz | 备注 |
|---|---|---|---|
| dawn-lamp | sleep → rest(17–19) → **fly**(19–27.75) → perch | 0.5→3.4 | 绕阙两圈半（3.5s/圈）后落左肩 |
| tortoise-crossing | fly → perch(≥27.1) | 3.2 / 2.4 | 龟首前 2m 巡飞，t=24 前极点折返 |
| night-rain | rain(栖息挡雨) → **fly**(13–22.8) → rain | 5.5 | `wind 0.6`；逆风横穿 |
| homecoming | rest → fly(26–28) | 4 | `mood 1`（翅脉全明，最高兴的一档） |

### tortoise-dai（`pose` walk|idle|rest，`expression` calm|alert|asleep|startled，`gaitSec`，`wind`，`chew`）

| 场景 | pose / expression | gaitSec | 走位 |
|---|---|---|---|
| dawn-lamp | walk→idle；calm→**alert** 27.5–28 | 3.2 | 水下阴影自右向左，t=24–28 上浮让龟首出水 |
| tortoise-crossing | walk / calm | 3.2 | x = 0.4t，yaw π/2 沿 +X 横渡 |
| night-rain | walk / **asleep** | **6** | x = 2+0.15t；颈收回甲缘避雨 |
| homecoming | **rest** / alert | 3.2 | 泊滩，yaw 0.6，后半身 12s 周期起伏 |

### ink-eel-yuan（`pose` cruise|lurk|roll，`expression` cursor|all|off，`poseT`/`exprT`）

| 场景 | pose / expression | 备注 |
|---|---|---|
| dawn-lamp | — | 不入画（隐藏） |
| tortoise-crossing | cruise / cursor | t=12.9–22.2 龟腹另一侧墨面下横渡 |
| night-rain | **roll** / all | `poseT = exprT = t−13`，海面鼓起一道发光脊又落下 |
| homecoming | lurk / all | `exprT = t−19`，t=18.9–20.9 远处最后一颗方点 |

### 导演自有的两个键

- `tOffset`（秒）：给节律固定的模型整体移相。归港场阙的行走开始于纸色淡切期间
  （scenes.json：起步于本场 t=0 前 1 秒），而模型的步频钉死 1.17Hz、14 步需 5.98s——
  于是阙带 `+1`、丁带 `+1.42`，脚步与下行路程因此对得上，不滑不跳。
- `place` / `life`：不走 `ctx`，由导演在 `update()` **之后**写 group 变换与叠加旋转
  （见下节）。模型各自的 `update()` 已在开头复位自己驱动的骨，所以叠加绝不累加。

## 4. 生命感四件套 + 落地压扁回弹

全部是 `update()` 之后的**叠加量**，纯函数：

| 件 | 实现 | 位置 |
|---|---|---|
| 预备动作 | `anticipate(t, at, lead)`：主动作前 0.4s 的反向仰/沉 | 阙 t=15 转身前（group roll 0.05×预备量） |
| 头部滞后 | `yawFn(t−3/24) − yawFn(t)`：脚本曲线在滞后窗内的差，加到 `head`/`skull` 骨 | 阙（转身）、岱龟（上浮/泊滩起伏）、笺蛾（航线高度）、步态相位差 |
| 身体扭转 | `0.045·sin(步态相位·2π)`，加到躯干骨（阙 chest / 丁 spine / 岱龟 spine4 / 笺蛾 spine2） | 随步态相位 |
| 跟随动作 | `followAt(t, at, amp, hz, decay)`：衰减振荡，加到末端骨（阙 hem-f / 丁 tail-9 / 笺蛾 antenna-l-0 / 岱龟 tail） | 主运动结束之后 |
| 落地压扁回弹 | `squashAt(t, at)`：2.5 帧压到 −0.17，随后过冲回弹；group scale = (1+s/2, 1+s, 1+s/2) | 丁落台阶（t=12.7）、阙 14 次落脚与抵达（t=5.98） |

## 5. 特效：一团一个 mesh，不画每颗粒

- **水花**：一团 = 一个 `RingGeometry(0.8, 1.0)` 细轮廓环，18 个池。时刻表是静态数据
  （`SPLASH_SCHEDULE`）：渡海场每 1.6s 一簇（按 `LEG_DEFS` 的踝位）、夜雨场 46 簇雨点、
  归港场纸山水珠两组、晨灯场龟首出水一簇。膨胀 + 淡出，位置随该场岱龟的 x 偏移。
- **音符可视**：`beatFlash(t, def)` 读 scenes.json 的 beats（music 权重 1、微事件 0.4），
  快起慢衰，驱动灯焰/环灯增益与尘埃亮度——全片唯一一处把配乐节律写进画面的地方。
- **尘埃/光斑**：一簇 = 一个八面体（`MOTES` 6 簇，种子参数），随节拍呼吸；夜雨场只在灯柱附近。
- **雨**：整场一条 `LineSegments`（一次 draw call），逐顶点色——落入灯柱的雨丝变成发光墨字，
  判定跑在一拍三的时钟上，所以一字停留整整一个三帧节拍。灯柱下宽 1.0m、上收 0.35m。
- **远景**：海天是带 ink→paper 渐变的整面（ Horizon 处已成纸色，与天纸无缝），
  「每像素多少米」的淡出完全交给 `pipeline` 的 mpp fade，远处不堆任何细节 mesh。

## 6. 材质交换（导演替渲染层做的那一步）

`render/pipeline.js` 只给 GLSL3 材质写第二张 RT；阙/丁/笺的 `MeshBasicMaterial` 与渊的
`MeshStandardMaterial` 会让 G-buffer 那段未定义，描线与笔触全花。于是导演按**源材质对象**
一对一换上皮影 cel 材质（`cel-<castId>`，G-buffer id：阙 1 / 丁 2 / 笺蛾 3 / 渊 7；
岱龟自带 GLSL3 cel 与 11–24 的 id，不动）。两条要知道的：

1. `render/cel.js` 的顶点着色器不含 skinning chunk（它的契约是非蒙皮 mesh），
   所以交换时把 chunk 补上（与 `tortoise-dai.js` 同一套）并 `needsUpdate`；
   片元着色器——二band 观感与 G-buffer 打包——仍是 cel.js 里那一份。
2. 有的模型透过 mesh 写颜色（阙的摆缘光斑 `spot.mesh.material.color`、渊的九颗方点），
   有的透过闭包写（丁的字行、笺蛾的墨脉、渊的眼）。交换时把**同一个 Color 实例**别到
   cel 材质上（`cel.color = src.color`），两条写通道都活着；每帧 `syncCel()` 再把它
   读进 `uBase`/`uShadow`。透明源（瞬膜、墨雾）把不透明度折进颜色（压黑），
   与岱龟涟漪同一种处理——MRT 下混合会连打包好的深度与 id 一起混掉。
3. `syncCel()` 必须排在 `applyCasts()` **之后**（`applyFrame` 里的步骤顺序就是契约）：
   模型在 `update()` 里写颜色，提前一步同步，渲染进这一帧的就是上一帧的颜色——同 t
   两次渲染会差出十几个像素，`scripts/capture.mjs --selftest` 的字节复现判据直接红。

## 7. 与 `src/main.js` 的接线（已接）

`src/main.js` 是页面侧装配入口，按四个扁平路径装载集成模块：`./pipeline.js`、`./director.js`、
`./audio.js`、`./models.js`（`build.mjs` 的集成插件认同一份名册，缺哪个就把哪个换成运行期
throw，build 不因此失败、页面响亮报错）。这四个扁平文件是**路径适配壳**，实现本体在
`src/render/pipeline.js`、`src/director/director.js`、`src/audio/audio.js`、`src/models/*.js`；
壳不含逻辑（与 `src/audio.js` 的同款注释同一约定）。

装配发生在 `main.js`：场景图与透视相机由页面建（`dispose()` 契约写明 scene/camera/pipeline
归调用方），管线用 `createPipeline()`，五个 cast.json id 在 main.js 键合成 `{ [castId]: model }`
后随 `scenes: storyData` 一起进 `createDirector()`。页面循环经 `graph.update(t, sceneId)` 走
`renderSceneAt`——它内部 applyFrame + `pipeline.render`，末次 blit 落在画布上；页面**不**再
自己 `renderer.render`，否则会把后处理链的成品盖成未调色的原图（画面在动、全链白接）。
轮播槽位与 HUD 标题读 `src/story/scenes.json`——采集链读的是同一份。

## 8. 自测

```bash
node --check src/director/director.js
```

语法之外，行为检查（纯函数性、场景覆盖、轮播与手动切换、纸色淡切曲线、环境/特效显影、
生命感叠加量非零、落地压扁、灯柱墨字）由**仓外**一次性脚本验证，不入库：
`renderSceneAt` 逐场景每 0.5s 一帧共 240 帧无抛错、骨矩阵零 NaN、同 `(sceneId, t)` 两次渲染
相机与全部角色变换逐字节一致。采集链的字节级判据（`scripts/capture.mjs --selftest`）
需要 WebGL2 上下文，本机之外由采集链路自己跑。
