# leviathan 调研笔记 —— 可复用的渲染管线与程序化建模技术

> 调研对象：`0xCodez/leviathan`（GitHub，默认分支 main，2026-11-08 读取）。
> **地址勘误**：任务给的 `exCodez/leviathan` 实际 404（该组织公开仓库数为 0）；
> 真实仓库是 `0xCodez/leviathan`（HTTP 200，55 stars，JavaScript，2026-11-04 最后推送）。
> 本笔记**只提取技术与管线**：上游的故事、角色、美术设定一律不引用、不改写、不致敬。
> 文中结论全部来自本次实际读取的上游源码（文件清单见文首，行号为上游 main 分支行号）；
> **未运行上游代码，无实测帧率数据**——唯一性能数字引自 `CONTRACT.md:151`。
>
> 上游自述：three.js r170 + WebGL2 的自定义多 pass 渲染器，模仿「赛璐璐主角 + 手绘背景」
> 的动画制片流程（`README.md:24-38`）。

已读上游文件（14 个，覆盖渲染入口、着色器、建模/骨骼/动画、工具链）：

```
README.md、CONTRACT.md
src/engine.js（渲染入口）、src/glsl.js（共享 uniform + MRT 输出）、
src/passes-env.js（paint/water/atmosphere 后处理）、src/materials.js（场景材质 + 叠加精灵）
src/util.js（种子随机 / 时间量化 / 关键帧）、src/main.js（装配 + 逐帧入口）
src/lev-spine.js（GPU 骨骼链）、src/lev-body.js（截面放样建模）、
src/lev-mat.js（脊链蒙皮材质）、src/lev-anim.js（纯函数动画）
src/archer-geo.js（程序化甲片 + 合并器）
tools/render.mjs（确定性采集 / 断点续渲）
```

> 上游源码暂存于 `entries/research/`（可按 raw URL 再生产，不入库）；
> 本仓 `delivery/brand/khyos-film/docs/leviathan-notes.md` 是同源上游的另一份笔记
> （面向 khyos-film），本文面向 khyos-desktop，两份笔记行号基准相同、结论独立核对过。

---

## 1. 渲染管线顺序与每个 pass 的职责

### 1.1 权威顺序（两处一致）

`src/engine.js:5-11` 的注释与 `CONTRACT.md:144-145` 完全一致：

```
shadow depth → reflection → main MRT (color + data)
  → paint（Kuwahara 笔触，仅 painted 像素）
  → ink（手绘描线，仅 cel 像素）
  → water（屏幕空间水面：反射/折射/波纹/泡沫）
  → atmosphere（高度雾、霞、光束）
  → overlay sprites → bloom → final grade + grain + 降采样到画布
```

`Engine.render()` 严格按此顺序执行（`src/engine.js:246-340`，分节注释
`// 1. shadow map` 在 `src/engine.js:252`、`// 9. bloom` 在 `:322`、`// 10. final` 在 `:330`）。

### 1.2 每个 pass 的职责与关键实现

| # | pass | 职责 | 关键实现（上游行号） |
|---|------|------|----------------------|
| 1 | shadow | **只给角色用的阴影贴图**——画的是"手绘光"不是物理光 | `setupShadow()` 正交相机紧包角色（`near=1, far=depth*2`，注释直言 "so the bird shades the fingers"，`src/engine.js:211-212`）；**只渲染 `opt.shadowRoots` 登记的根节点**，场景装饰永不投影（`src/engine.js:258-266`）；`userData.noShadow` 临时隐藏法；3×3 PCF + 法线偏移 0.04，着色器自做 `*0.5+0.5`（`src/glsl.js:57-69`） |
| 2 | reflection | 水面反射，**镜像相机半分辨率**渲染 | `updateReflection()`：位置/视点/up 相对 `uWaterLevel` 取镜像（`src/engine.js:226-244`）；半分辨率 RT（`src/engine.js:155`）；`userData.noReflect` 临时隐藏法 |
| 3 | main MRT | 场景主渲染，**一次输出颜色 + 数据两张图** | `count: 2` 的 WebGLRenderTarget + DepthTexture；`G.uPass=0`（`src/engine.js:281-286`） |
| 4 | paint | 水彩/ gouache 笔触，**只作用于背景像素** | 广义各向异性 Kuwahara（详见 §3.1）；半径每镜头可调（`opt.paintRadius`，默认 4，`src/engine.js:166, 289-291`） |
| 5 | ink | 手绘描线，**只作用于 cel 像素** | id/深度/法线边缘检测 + 笔压噪声（详见 §3.2）；`inkSeed = floor(t*12)%5`——**按"张"（on twos）换种子**，同张内线条稳定、张间抖动（`src/main.js:100`） |
| 6 | water | 屏幕空间水面：反投影世界射线 → 与水面平面求交 → 高度场/涟漪/尾流/反射/折射/焦散/泡沫 | 深度哨兵 8000m；像素足迹（米/像素）驱动全部 LOD（详见 §3.4） |
| 7 | atmosphere | 指数雾 + 贴水高度雾（fbm 雾带）+ 光轴（28 次向太阳 march） | 天空像素跳过雾；远处海面融进地平线色不留硬缝（`src/passes-env.js:524-614`，天空判定 `:554`，光束 `:591-611`） |
| 8 | overlay | 能量/闪电/水花等**软粒精灵**，直接画到颜色 RT | 实例化（`instanceMatrix` + 每实例 `aSprite` 属性，`src/materials.js:194-214`）；读 MRT 数据缓冲做**软深度**：`soft = clamp((sceneD - vDepth)/uSoft, 0, 1)`，相交处淡出（`src/materials.js:226-227`） |
| 9 | bloom | 阈值 1.05 提亮 → 6 次可分离模糊：1/4 分辨率 H/V 一对 → 1/8 分辨率 H/V 一对 → 1/8 上 2px H/V 一对；final 同时采样 1/4 与 1/8 两档叠加 | 5-tap 线性采样权重 0.227/0.316/0.070（`src/engine.js:322-332`，权重在 BLUR_FS） |
| 10 | final | 软肩 tone map、曝光/gamma、饱和度+vibrance、lift/gain、暗角、**按帧号 hash 的胶片颗粒**、淡入淡出；S>1.5 时 4-tap 盒式降采样 | FINAL_FS（`src/engine.js:95-129`，降采样分支在开头 `if(uS > 1.5)`） |

### 1.3 值得照搬的四个结构性决定

1. **"画在像素类别上"而不是"画在物体上"**：paint/ink 都靠 MRT 数据缓冲里的
   材质 id 与 painted 掩码决定作用范围——后处理与场景内容彻底解耦
   （`src/glsl.js:76-80`）。
2. **全屏后处理统一用全屏四边形 + GLSL3 ShaderMaterial**（`depthTest/depthWrite=false`，
   `frustumCulled=false`，一个 quad 一个 scene 一个正交相机复用），
   写 pass 就是 `pass(material, target)` 一行（`src/engine.js:205-209`）。
3. **共享 uniform 注册表 `G`**：所有材质 `...G` 展开的是**同一个 `{value}` 对象引用**，
   一帧只改一处（uTime/uSunDir/uShadowMap…）全部材质生效（`src/glsl.js:3-5`）。
4. **8000m 深度哨兵**：视图深度 >8000 一律判天空，水/大气 pass 靠它做分支；
   场景因此可以"作弊距离"，只保相机 8000m 内精致（`CONTRACT.md:100-101`；
   `src/passes-env.js:317, 554`）。
5. **`uPass` 三态约定**：0=主渲染 / 1=阴影深度 / 2=反射。材质在阴影 pass 早退写白
   （`src/materials.js:92`、`src/lev-mat.js:82`），反射 pass 丢弃水下几何
   （`src/materials.js:81`、`src/lev-mat.js:81`）——**同一份场景代码服务三个 pass**，
   不需要另建影子场景。

---

## 2. MRT / G-Buffer 布局

### 2.1 RenderTarget 配置（`src/engine.js:141-158`）

```js
renderer = new THREE.WebGLRenderer({ antialias: false,
  preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.autoClear = false;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // 线性管线，调色在最后

rtMain = new THREE.WebGLRenderTarget(IW, IH, {
  count: 2, type: THREE.HalfFloatType,
  minFilter: NearestFilter, magFilter: NearestFilter,
  depthTexture: new THREE.DepthTexture(IW, IH),
});
rtMain.textures[0].minFilter = rtMain.textures[0].magFilter = LinearFilter;
// textures[1]（数据）保持 Nearest——插值 id/深度会出伪影
rtA / rtB   半浮点乒乓缓冲（paint→ink→water→atmosphere 轮转）
rtRefl      半分辨率反射
rtShadow    4096×4096 仅深度（clear 成白色）
rtBl[0..3]  1/4、1/8 分辨率 bloom 链
```

内部渲染分辨率 = 画布 × S（`scale` 参数，预览 1、出片 2），final pass 负责降采样
（`src/engine.js:146`、`src/main.js:16`）。

### 2.2 两个输出槽位（`src/glsl.js:72-81`，所有场景材质共用 `MRT_OUT`）

```glsl
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oData;

void writeOut(vec3 col, float a, vec3 nView, float viewDepth, float id){
  oColor = vec4(col, id > 0.5 ? 0.0 : 1.0);          // alpha = "是否背景(可涂)像素"
  oData  = vec4(nView.xy * 0.5 + 0.5, viewDepth, id); // rg=视图法线, b=视图深度, a=材质 id
}
```

| 通道 | 内容 | 精度/编码 | 消费者 |
|------|------|-----------|--------|
| color.rgb | HDR 线性颜色 | half-float | paint/ink/water/atmos/bloom |
| color.a | **painted 掩码**（背景=1，cel=0） | 0/1 | paint pass 的 early-out（`src/passes-env.js:56`） |
| data.rg | 视图法线 xy | `n*0.5+0.5`，z 由 `sqrt(1-x²-y²)` 重建（`src/engine.js:27`） | ink 法线边缘、水面焦散取世界法线 |
| data.b | 视图深度（`-mv.z`，米） | half-float | ink 深度边缘、water/atmos 的深度比较与像素足迹 |
| data.a | **材质 id**：0=背景(笔触无描线)，1–99=描线 cel，100+=不描线 cel | 整数浮点 | ink 的 `inked()` 判定与 id 跳变线 |

id 语义见 `CONTRACT.md:146-147`：**"ids wrap, keep neighbours different"**——
同一主体的不同部件用不同 id，描线才落在甲片接缝上。

### 2.3 数据缓冲的三个下游用法（都是"白嫖"级思路）

- **ink**：`abs(dN.a - dC.a) > 0.5` → 部件/剪影边界线，且**只在 cel 更靠前时画**
  （深度比较带 0.5 容差，避免背景被角色轮廓误描）；否则按相对深度变化
  `smoothstep(0.015,0.035, rel)` 与法线不连续 `smoothstep(0.78,0.6, nd)*0.85`
  出褶皱线（`src/engine.js:28-52`）。
- **water**：`sceneVD < 8000 && waterVD > sceneVD` → 几何在水面前方，水面让位
  （`src/passes-env.js:317`）；焦散从 data 的视图法线重建世界法线打在水下物体上
  （`src/passes-env.js:415-425`）。
- **overlay 软粒子**：精灵深度 vs 场景深度做软淡出（`src/materials.js:226-227`）。

### 2.4 线性管线 + 末段调色

`outputColorSpace = LinearSRGBColorSpace`，所有 pass 在线性空间累加，
tone map/gamma/饱和度/vignance/grain 全在 FINAL_FS 一次做完（`src/engine.js:145`）。
每个镜头的光色/雾色/水色/调色来自 `applyLook()` 的 preset 按 `k` 插值
（`CONTRACT.md:124` 的 LOOKS 契约）——**色彩脚本也是数据驱动**，改色调不动着色器。

### 2.5 与本项目现状对照（`delivery/brand/khyos-desktop/`，本次实读）

本项目 `src/render/pipeline.js:441-449` 已是 `count: 2` + `FloatType` + Nearest 的
MRT；差异在**数据通道的打包方式**：

| | 上游 leviathan | 本项目 khyos-desktop |
|---|---|---|
| RT1 布局 | 四通道分立：`(nView.xy*0.5+0.5, viewDepth, id)`（`src/glsl.js:79`） | `rgb` 存视图法线，`a` 打包 `floor(depth*64)*256 + id`（`src/render/cel.js:23-31`） |
| 深度编码 | 原始视图深度（米，half-float） | 1/64 世界单位量化、上限 1024（`cel.js:19-21`） |
| 背景判定 | color.a 的 painted 掩码 + id==0 双保险 | 仅 `materialId==0`（`pipeline.js:111`） |
| 后处理链 | paint→ink→water→atmosphere→overlay→bloom→grade | watercolor→line→bloom→grade→fade→grain（`pipeline.js:378-380`） |

结论：**布局不同但语义同构**，迁移技术时只迁算法、不迁通道格式——本项目的打包契约
（`cel.js:11-17` 的注释：深度必须非归一化、1/64 量化配合 mpp 淡出才不出虚线）
是自行推导的，继续有效。

---

## 3. 水彩背景笔触与描线的具体做法

### 3.1 paint pass：广义各向异性 Kuwahara（`src/passes-env.js:43-100`）

```
对每个像素：
1. if (color.a < 0.5) 原样返回            // cel 像素不涂（:56）
2. ang = (fbm2(fc/140) - 0.5)*3.2 + 0.4   // 噪声方向场 = 笔触走向（:59）
   dA = 主轴, dB = 副轴
3. rad = uRadius * mix(0.72, 0.4, smoothstep(10,120,depth)) * uStep
   // 笔刷随距离缩小——远处的窗子/招牌才不糊（:62）
4. 3 圈 × 16 方向 = 48 次采样，椭圆偏移 (dA*cos·1.45 + dB*sin·0.8)*rr（:65-81）
   偶数索引归入 8 个扇区，奇数索引 **对相邻两扇区各分一半**（扇区重叠）
5. 每扇区求均值/方差；扇区权重 w = 1/(1 + pow(sd*22, 8))（:87）
   // 越"平"的扇区权重越高 → 平坦区吃到大笔触，边缘与小细节被保留
6. 输出 = 各扇区均值的加权平均
7. 干笔与纸纹（:91-97）：
   bristle = vnoise(旋转到笔触坐标系后的 (x/26, y/2.2))   // 沿笔触方向拉长的噪丝
   paper   = vnoise(fc/2.5)*0.5 + vnoise(fc/9.0)*0.5      // 纸纹齿感
   col *= 0.98 + 0.04*bristle; col *= 0.99 + 0.02*paper
```

要点：**Kuwahara 的"保边"靠方差权重**（不是硬阈值）；**笔触各向异性靠把屏幕
坐标旋进噪声场**；"水彩感"主要来自干笔/纸纹两级乘性噪声，不是滤镜。
参数默认值：`uRadius=4`、`uStep=S`（`src/engine.js:166`）。

### 3.2 ink pass：数据缓冲驱动的描线（`src/engine.js:18-66`）

```
edgeAt(uv, 8 方向, 步长 w):
  - id 差 > 0.5 → 边界线；仅当该方向 cel 更靠前才画（剪影线不包住背景）
  - 否则相对深度 rel → smoothstep(0.015, 0.035)
       法线点积 nd  → smoothstep(0.78, 0.6)*0.85
线宽 w = uWidth * uS * press * dist
  press = 0.72 + 0.56*vnoise(fc/34 + seed*7)          // 笔压：沿屏幕低频起伏（:58）
  dist  = clamp(14/max(depth,0.1), 0.5, 1.25)         // 距离衰减
最终: e = 0.5*edgeAt(w) + 0.5*edgeAt(w*0.55)          // 粗+细两遍 → 芯+晕（:61）
      alpha = e * (0.82 + 0.18*vnoise(fc/7 + seed))   // 墨色不均
      ink = mix(uInk, col.rgb*0.32, 0.25)             // 墨带一点环境色
```

`uSeed = floor(t*12) % 5`（`src/main.js:100`）：笔压噪声**按张变化**——同属
"on twos"体系，线条在一张画内稳定、换张时重新抖，这正是手绘动画的节奏。
默认 `uWidth=1.15`、墨色 `#2a2236`（`src/engine.js:167`）。

### 3.3 painted 背景本体

背景（天空/云/城市/植被）走**普通场景渲染但写 id=0**，于是自动获得笔触、
不获得描线——"手绘背景"不是 2D 贴图，而是 3D 几何 + 片元里画出来的渐变。
（背景材质在 `src/bgmaterials.js`，本次未读；本节结论以上述 id 契约为准。）

### 3.4 water pass 中可独立复用的"屏幕空间水面"配方（`src/passes-env.js:102-522`）

1. 由 `uInvProj` 反投影屏幕 uv → 世界射线 → 与 `y=waterLevel` 平面求交得世界点
   （`waterAt()`，`:153-158`）；
2. **像素足迹**：对邻像素再求交一次，`dqx/dqy` 即"米/像素"（worst axis），
   之后一切细节密度都以它为 LOD 依据（`:321-323`）；
3. 高度场 = fbm2 低频涌 + vnoise 中频（`hfield()`，`:126-131`）；
   涟漪 = 12 个槽位的扩张环（`exp(-x²)*env*sin(x*2.6)` + 一条 0.72 半径的细尾环，
   `:132-151`）；
4. 反射：7-tap 竖向涂抹（模仿手绘水的竖向拉丝）+ 法线偏移 + 正弦摆动，
   最后**色阶 posterise 到 7 级**（cel 感，`:382-392`）；
5. 折射：Beer-Lambert 吸收 `1-exp(-path*k)`，光程用 Snell 定律缩短
   （`pathR = min(depthB/max(cosR,0.3), under)`，`:394-409`）；
6. 菲涅尔 Schlick `0.04+0.96*pow(1-ndv,5)` 混合水体/反射（`:455-458`）；
7. 焦散 = **Voronoi 边界光网**（域扭曲 + 双尺度叠加 + 交叉点亮结 + 沿线宽变化，
   亚像素时退化为均匀辉光，`vorEdge/causticNet`，`:194-227`）；
8. 太阳闪烁 = 每格重摇的星形 glint（`smoothstep(0.9885,0.9975, dot(reflect,sun))`
   极窄锥 + 十字星芒，尺寸按输出像素，近/中/远三档密度，`:278-301, 469-484`）；
9. 泡沫：接触线 + Kelvin 尾流臂（`arm = side - behind*0.36 - 2.2`）+ 涟漪泡
   （`:354-369, 507-518`）。

整段有直通开关：`uOn < 0.5` 原样返回（`:305`），水面可整段摘除。

---

## 4. 骨骼、蒙皮、截面放样建模方法

### 4.1 GPU 骨骼链：rest 空间建模 + 顶点着色器包裹（`src/lev-spine.js`）

```
建模约定：所有 mesh 直接建在"rest 空间"——z 沿链 0(尾)→len(头)，x/y 是截面；
骨骼是世界空间的：uBP[i] = vec4(位置, 截面缩放), uBQ[i] = 四元数。
顶点着色器：spineAt(z/len) 在 Catmull-Rom 骨列上取 (p, q, sc)，
            world = p + qrot(q, (p.xy*sc, p.z - zc))
```

- 全身**一次 draw、零 CPU 蒙皮**：身体是一张连续曲面随骨列弯曲
  （`spineGLSL`，`src/lev-spine.js:11-26`；蒙皮材质 `src/lev-mat.js:32-35`）；
- `qrot()` 是四元数转置优化的 `v + 2*cross(q.xyz, cross(q.xyz, v) + q.w*v)`
  （`src/lev-spine.js:15`）——比 `mat3` 构造省一条指令路径；
- `setBone` 做**四元数双覆盖修正**（相邻骨点积<0 取负），否则 nlerp 走长弧
  （`src/lev-spine.js:50`）；
- 三种骨骼生成：`fromPath(fn, upFn)`（沿曲线，dorsal 尽量贴 upFn，退化时沿用
  上一帧 X 轴，`:86-106`）、`fromCurl(c, base, pos, k)`（从中心骨向两端做 FK，
  `k(s) = [pitch, yaw, twist] 弧度/骨`，`:110-130`）、`fromRoot`（短肢链，`:133`）；
- CPU 侧有与着色器逐行同构的 `at()` / `toWorld()`（`:55-82`）——
  **同一条插值写两遍，GPU/CPU 结果才一致**（锚点、命中判定都依赖它）；
- `ArcPath` = 弧长参数化 Catmull-Rom（两端线性外推），动画沿弧长取样**不拉伸**
  （`:144-157`）。

### 4.2 下颚是逐顶点权重，不是骨骼

`jawWeight(z, a, lower)` 越靠嘴前权重越大（`src/lev-body.js:182-186`），
顶点着色器绕铰链旋转（`src/lev-mat.js:23-29`）——骨数量不变，嘴开合是蒙皮权重
驱动的。**"局部开合"优先用权重，别加骨**。

### 4.3 截面放样：一张皮从尾到吻（`src/lev-body.js`）

```
section(z) → { rx, top, bot, cy, e }        // 每个 z 一个超椭圆截面（:39-46）
  x = rx*sign(cos)|cos|^e ; y = (top|bot)*sign(sin)|sin|^e   // e 控方圆
  rx/top/bot 都是 curve(keys) 非均匀 Hermite 插值出来的轮廓线（:17-30）
loftBody(): zs 非均匀布环（头部密、吻尖极密：2.8 → 1.7 → 0.9*max(0.12,(1-t)/0.04)，
  :191-198）
  每环 Nu(上)+Nl(下) 点，phi 绕截面；"around" = 从背中线起的弧长米数（贴图/鳞用，
  :117-128）
  sculpt(z, phi) 沿法线加位移：脊、侧脊、肩臀肌肉块、肋、眉/颊/吻/颏、眼窝、
    唇褶——全是 gauss() 高斯包 + smoothstep 门（:56-84）
  鳞片 = 高频 sin 叠噪，与 hide 着色器同坐标系， silhouettes 上带棱（:49-53）
```

可复用模式：**"轮廓曲线 → 超椭圆截面 → 高斯位移雕塑 → 非均匀环距放样 →
弧长参数化属性"**，五步全是纯函数、可复现。

### 4.4 甲片装甲：凸包 + 投影贴花 + 按关节合并（`src/archer-geo.js`）

- `hull(points)` = ConvexGeometry + `toCreasedNormals`；**诀窍：先整体 ×30 再算
  折痕法线再 ÷30**——three 的 crease 哈希在 0.01 处截断，小手件法线会脏
  （`:6-7`）；
- `cbox()` 倒角盒（`:24-35`）、`superPts()` 超椭球（指数 e 控圆润/方硬，`:37-50`）、
  `ribs()` 环叠柔性关节（`:59-70`）、`extrude()` 带斜度的挤出（`:73-85`）、
  `tube()` 截面沿 Y 的躯干曲面（`:96-108`，Catmull-Rom 采样 `crSample`，`:88-92`）；
- `patch(S, corners, opts)` = 曲面 S 上的一块**弯甲片**：uv 网格 + 抬升 + 厚度 +
  倒角 + 中脊 + 外张 + 冠面；法线由曲面切叉积得出；**UV 用世界米/TILE + 每片随机
  偏移**（`:152-155`，`TILE=3.4`，`:16`）——细节图集自动连续；`aEdge` 标记边缘供
  "磨损亮边"用；三角形绕向用 `orientTri` 统一外翻（`:189-195`）；
- `Kit` 合并器：按关节分 bin，`add()` 时做颜色抖动/材质标志(metal,detail,emis,id)/
  盒投影 UV 回退（按三角面法线主导轴投影，`:268-272`）；
  `finish()` **每关节一个 mesh**——"2000 块甲片只要个位数 draw call"
  （`:285-311`）；
- ink id 分配 `((n*17)%59)+1`（`:238`）：顺序错开 17 再取模，保证相邻部件不同
  （`CONTRACT.md:147` 提醒 "ids wrap, keep neighbours different"）。

### 4.5 动画：关键帧即"身体曲线"（`src/lev-anim.js`）

- 每个表面动作都是 film time 的纯函数；大幅度动作**关键帧直接存身体控制点列**，
  `vecCurve()` 对扁平数组做 Hermite 时间插值（`:15-31`）；
- `layCurve()` 把控制点列重采样成 110 点并累计弧长；`atDist(d)` 二分查找
  "离头部 d 米处"——**脊柱按弧长贴到曲线上，永不拉伸**（`:36-61`）；
- 弹道是解析的：x 匀速 + y 抛物线（`:77`），形状键 + 质心抛物线分离
  （`flipFall` 把平均 y 归到抛物线，`:100-106`）；
- 时间量化：`onTwos(t)=floor(t*12+1e-6)/12`、`onThrees=floor(t*8+1e-6)/8`
  （`src/util.js:35-36`）——角色 12 张/s、水 FX 8 张/s，`G.uDrawTime` 喂给着色器；
- 小动画走 `track([[t,v,ease],...])` 关键帧轨（`src/util.js:39-51`）。

---

## 5. 确定性与性能注意点

### 5.1 确定性（这套管线的立身之本）

| 手段 | 位置 |
|------|------|
| **每帧是 `state.t` 的纯函数**：`stateFor(frame) → st`，各部门 `update(st)` 只读 st；帧可乱序渲染 | `src/main.js:58-70, 91-101`、`CONTRACT.md:150` |
| 种子随机数 **mulberry32**（禁 `Math.random`）：`Rng{next,range,int,pick,sign,gauss}` | `src/util.js:3-22`、`CONTRACT.md:150` |
| **预热一帧并丢弃**："首帧因 GPU 懒状态略不同，渲一帧扔掉保证每帧可复现" | `src/main.js:111-113` |
| 噪声种子挂在量化时间上：ink 种子 `floor(t*12)%5`；环境 FX 时间 `uEnvTime` 走 on threes | `src/main.js:100`、`src/passes-env.js:15` |
| 着色器内置 hash 噪声（hash12/vnoise/fbm2/fbm3），无纹理随机源 | `src/glsl.js:45-55` |
| **断点续渲**：144 帧一段；段状态 = 文件在 + 元数据在 + encodeKey(scale/crf/preset/q/query/W/H/FPS) 全一致 + 字节数一致 + `srcHash`（源码哈希）一致，否则 `todo`/`stale` | `tools/render.mjs:201-208`（srcHash 实现 `:94-103`，默认 seg=144 在 `:51`） |
| 多 page 并行 worker + 崩溃孤儿回收（pidfile：只杀"仍是 chrome.exe 且命令行含同一 profile"的 pid） | `tools/render.mjs:291-297`、`:110-125` |
| 采集与渲染同一 JS 任务：`page.evaluate` 内先 `renderFrame(n)` 再 `capture(q)` | `tools/render.mjs:258-262` |
| 色彩链路：Chrome 出的 JPEG 是 full-range BT.601，转 limited-range BT.709 要先过 RGB 再换矩阵，否则色偏 | `tools/render.mjs:217-225` |

### 5.2 性能

- **预算**：典型帧 < ~0.4s @ scale 2（`CONTRACT.md:151`，上游自述，本次未实测）；
- **批处理**：Kit 合并每关节单 mesh（§4.4）；overlay 用实例化软精灵
  （`src/materials.js:194-214`）；
- **分辨率阶梯**：反射 1/2、bloom 1/4→1/8、final 才降采样；出片 S=2 内部超采样
  （`src/engine.js:146, 153-158, 322-339`）；
- **集合剔除靠"一套布景一镜头"**：部门不活跃就 `visible=false`，布景可在空间上重叠
  （`CONTRACT.md:98-99`）；
- **距离作弊**：8000m 外即天空 + 雾；每镜头可覆写 `cam.near/far`
  （`CONTRACT.md:100-101`、`src/main.js:86-87`）；
- **LOD 按"米/像素"**：鳞片/细肤/雨环/glint 全用屏幕足迹决定是否绘制及密度，
  亚像素细节主动退化成渐变/点画（`src/lev-mat.js:86-89`、`src/passes-env.js:342, 474-482`）；
- **共享 uniform 对象**避免逐材质 setUniform（`src/glsl.js:3-5`）；
- **部门故障隔离**：模块加载失败退 NOOP，其余部门照渲（`src/main.js:36-45`）。

### 5.3 坑点清单（读码所见，逐条有出处）

1. `preserveDrawingBuffer: true` + `antialias: false`：为逐帧捕获保缓冲、抗锯齿
   全靠后处理（ink pass 兼职）（`src/engine.js:141`）。
2. **MRT 数据图必须保持 NearestFilter**：颜色图换 Linear 无妨，id/深度被插值会
   在 ink/water 里产生伪边缘（`src/engine.js:149-152`）。
3. **color.a 被征用为 painted 掩码**：场景里不能有依赖 alpha 混合的透明物，
   alpha 测试一律 `discard`（`src/materials.js:87-91`）。
4. 阴影 pass 里材质要**早退并写白**（`oColor=vec4(1)`），否则深度比较基准错
   （`src/materials.js:92`、`src/lev-mat.js:82`）。
5. 反射 pass 用 `uPass>1.5` 时 `discard` 水下几何，否则镜像里出现穿帮
   （`src/materials.js:81`、`src/lev-mat.js:81`）。
6. `sunShadow` 的 bias 矩阵算了没用（`void bias`）：裁剪矩阵原样传入、着色器自做
   `*0.5+0.5`——改阴影代码时别把两处偏移叠起来（`src/engine.js:222-224`、
   `src/glsl.js:59-60`）。
7. 四元数双覆盖不修正，骨链 nlerp 会绕远路（`src/lev-spine.js:50`）。
8. `toCreasedNormals` 的 0.01 哈希截断：小件先 ×30（`src/archer-geo.js:7`）。
9. `onTwos` 的 `1e-6` epsilon：浮点边界差一拍，整帧动画会颤（`src/util.js:35`）。
10. ink id 取模会回绕：**同帧内相邻部件 id 必须不同**，否则接缝处无线
    （`src/archer-geo.js:238`、`CONTRACT.md:147`）。
11. `celMaterial` 依赖 `attribute aRest`（rest 姿态坐标做风化）；几何没这个属性时
    WebGL 默认 (0,0,0)，风化会塌成一个点——要么烘焙 aRest，要么 weather 传
    `[0,0,0,0]`（`src/materials.js:47, 96`、`CONTRACT.md:149`）。
12. 合并 mesh 后 `frustumCulled=false`（`src/archer-geo.js:304`）：包围盒失去
    意义，剔除改由"布景开关"承担——照搬时别把两者都丢了。
13. DoubleSide 是全局默认（`src/materials.js:12`）：开放壳体需要，但 fill 成本
    翻倍，能闭合的模型应仍用 FrontSide。
14. 定长 uniform 数组（涟漪 12、尾流 8、学校 4）每帧全量上传，扩容量前先算
    UBO/实例化替代（`src/engine.js:174-176`、`src/passes-env.js:19, 238`）。
15. 捕获链路两件事：render+读画布必须同一 JS 任务（合成器任务结束才清缓冲）；
    Chrome 出的 JPEG 是 full-range BT.601，转 limited-range BT.709 要先过 RGB
    再换矩阵，否则色偏（`tools/render.mjs:258-262, 217-225`）。
16. `depthTexture` + MRT 组合下，WebGL1 不可用（`src/engine.js:148-151`）——
    需锁 WebGL2（本项目 `pipeline.js:406-408` 已有同款硬校验）。

---

## 6. 对本项目（khyos-desktop）的落地建议

项目现状（本次实读 `delivery/brand/khyos-desktop/`）：`src/render/pipeline.js` 已有
MRT（RT0 颜色 + RT1 法线/打包深度/材质 id，`pipeline.js:441-449`）+ 六段后处理链
（水彩笔触 → 深度/法线描线 → 软膝 bloom 三档 → 调色 → 纸面过渡 → 颗粒，
`pipeline.js:378-380, 604-655`）；`src/render/cel.js` 是双色带 cel + 边缘光；
`src/render/quantize.js` 已有 on twos/threes（24fps）；`src/util/rand.js` 已禁
`Math.random` 并用 mulberry32/fmix32，且 GLSL 侧常量与 CPU 侧对齐
（`rand.js:1-5, 62-81`）。**地基与上游同代，迁移成本低。**

### 6.1 建议照搬（按性价比排序）

1. **ink 双尺度线宽（芯+晕）**：上游 `e = 0.5*edgeAt(w) + 0.5*edgeAt(w*0.55)`
   （`src/engine.js:61`）。本项目 LINE_FRAG 目前单尺度 Sobel
   （`pipeline.js:175-206`）——加一遍半宽采样即得"芯+晕"，是最便宜的一档提升。
2. **笔压噪声 + 按"张"换种子**：`press = 0.72+0.56*vnoise(fc/34+seed*7)`、
   `seed = floor(t*12)%5`（`src/engine.js:58`、`src/main.js:100`）。本项目颗粒已按
   帧重摇（`pipeline.js:362`），但**线条没有笔压**；把种子挂到
   `quantizeOnTwos(t)` 上（`quantize.js:19-21`），与既有 24fps 节拍对齐。
3. **paint 升级为扇区方差加权**：本项目水彩目前是 fbm 阈值掩码
   （`pipeline.js:129-135`），平坦与边缘同权。借上游 8 扇区 + `w=1/(1+pow(sd*22,8))`
   （`src/passes-env.js:83-90`）做保边；**保留本项目的 mpp 淡出/展宽**
   （`pipeline.js:107-109`）——上游用深度缩半径（`src/passes-env.js:62`），
   本项目用米/像素淡出，后者对锁定机位更稳（`pipeline.js:103-106` 注释自述）。
   再叠干笔/纸纹两级乘性噪（`src/passes-env.js:91-97`）。
4. **id 跳变线 + "仅当主体在前才画剪影"规则**（`src/engine.js:38-42`）：
   本项目 materialId 目前只驱动笔触方向（`pipeline.js:119-120`），未参与描线。
   多部件主体出现时，用 id 差出部件边界线，深度容差 0.5 防背景被误描。
5. **确定性采集三件套**（工具链就绪后）：预热一帧丢弃（`src/main.js:111-113`）；
   render+读画布同一 evaluate 任务（`tools/render.mjs:258-262`）；
   段状态 `encodeKey + srcHash + 字节数` 断点续渲（`tools/render.mjs:201-208`）。
   本项目 `rand.js:1-5` 已声明"capture.mjs 比对两次渲染的字节"，契约先行，
   工具落地时直接按上游结构写。
6. **Kit 式按关节合并**（`src/archer-geo.js:285-311`）：品牌程序化几何
   （`delivery/brand/khy-brand-geometry.js` 那类）按"每关节一 mesh"合并，
   draw call 降到个位数；ink id 用 `(n*17)%59+1`（`:238`）；
   creased 法线 ×30 技巧（`:7`）对小手件直接生效。
7. **共享 uniform 注册表**（`src/glsl.js:3-5`）：时间/光照/焦点一处写全局生效，
   替代逐材质传参——本项目后处理 uniform 已集中（`pipeline.js:467-536`），
   场景侧可同构收敛。
8. **GPU 脊链蒙皮**（`src/lev-spine.js`，整文件约 150 行）：**仅当**品牌出现
   长条有机形态主体时启用；rest 空间建模 + 顶点着色器包裹，零 CPU 蒙皮。
   桌面端品牌场景若无此类主体，跳过。

### 6.2 需要改 / 不适宜照搬的部分

- **G-buffer 通道格式不迁移**：本项目是 `法线 rgb + a 打包(depth,id)` 且深度
  1/64 量化、上限 1024（`cel.js:11-31`）；上游是四通道分立 + half-float 原始深度
  （`glsl.js:79`）。算法照搬，格式各守各的契约——混用会同时破坏两边。
- **painted 掩码机制不迁移**：上游征用 color.a（`glsl.js:78`）导致透明物只能
  `discard` 不能混合（`materials.js:87-91`）；本项目用 `materialId==0` 判定背景
  （`pipeline.js:111`），alpha 通道是自由的——这是本项目更好的选择，别改。
- **水/大气/overlay 三件套按需裁剪**：屏幕空间水面配方（§3.4）整段有 `uOn` 直通
  开关（`passes-env.js:305`）；桌面端若只要"水"不要海，只取高度场+涟漪+泡沫子集。
  高度雾/光束（ATMOS_FS）依赖 8000m 哨兵与海面判定，本项目深度上限 1024 单位
  （`cel.js:21`），**哨兵语义不同，不能直接搬**——要雾就按本项目的深度域重推。
- **上游的角色、叙事、美术设定一律不进本项目**：场景与角色原创。本笔记亦未记录
  其内容；上述文件仅作为技术出处引用。
- **JPEG→x264 的 BT.601/709 链路**（`render.mjs:217-225`）：本项目是 PNG/字节
  比对链路（`rand.js:1-5` 自述），无此问题；但"同一 JS 任务内 render+capture"
   约束相同。
- **分辨率/预算是上游口径**：0.4s@scale2 是上游 1920×1040 的自述
  （`CONTRACT.md:151`），本项目未实测，落地任何 pass 后自行测帧预算再定 scale。

### 6.3 建议的落地顺序

1. `tools/` 采集侧：warm-up 帧丢弃 + 同任务 capture + 字节比对（rand.js 的契约
   已经在等这个实现）；
2. ink：双尺度线宽 + 笔压噪声 + 挂 `quantizeOnTwos` 的种子；
3. paint：扇区方差加权保边（保留 mpp 淡出）+ 干笔/纸纹；
4. 若出现多部件主体：id 分段表（1–99 描线 / 100+ 不描线）+ id 跳变线 + Kit 合并；
5. 最后才按需加水/大气/骨骼——且每加一个 pass 重测一次帧预算。

---

## 附：本笔记的边界

- 全部结论来自 2026-11-08 对 `0xCodez/leviathan@main` 的源码阅读（14 个文件，
  清单见文首）；**未运行其页面、无实测性能数据**；帧预算 0.4s@scale2 引自
  `CONTRACT.md:151`。
- 上游 README 提到的同引擎前作与 26MB 单文件 dist 本次未读；
  `src/bgmaterials.js`（背景材质本体）本次未读，§3.3 以上游 id 契约与已读文件为准。
- 地址勘误：任务所给 `exCodez/leviathan` 返回 404（GitHub API 与 HTML 页面均确认，
  该组织 `public_repos: 0`）；实际仓库 `0xCodez/leviathan` 可达（API 200，
  55 stars，2026-11-04 推送）。
- 本仓 `delivery/brand/khyos-film/docs/leviathan-notes.md` 为同源上游的另一份笔记
  （面向 khyos-film 项目）；本文面向 khyos-desktop，结论独立核对。
