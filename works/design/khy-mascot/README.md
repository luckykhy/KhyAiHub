# Khy OS 社区形象设计说明书（角色设定参考稿）

> 生成日期：2026-11-03（v2 更新：Lucky 好运主题 + 真商标压印 + 三端落地）
> 状态：**设计参考稿（定名待人拍板）**
> 产物目录：`works/design/khy-mascot/`（母版）＋ `delivery/brand/pet/`（分发真源）
> 生成方式：AI 图像模型（minimax image），**人类指定方向**——角色气质、性别、人设、用途、交付颗粒度、好运元素、商标呈现方式、桌宠形态与互动深度均由人拍板后出图与落地（见下方「人的意愿记录」）。
> 版权口径：本目录是**社区形象参考稿**，不进入软著登记材料（依据 `[DESIGN-IP-001]` 四条硬线之一「非登记候选不进登记材料」）。

---

## 〇·〇·〇、v5 更新要点（2026-11-04 第五轮：桌宠会自己避开文字）

| 反馈 / 需求 | 落地 |
| --- | --- |
| 「如果挡到字，自己会跑到其他位置」 | 桌宠每 1.5s 量一次自己脚下压住了几行字；压住了就在视口四周的候选位里挑一个**明显更空**的位置挪过去。字散开后再自己走回原位 |
| 「我希望虽然是桌宠但是要像真人一样」 | **本轮未做**：方向待人拍板（分层视差 2.5D / 真人立绘浮雕 / 写实真人 3D 模型），见「三·九」 |

细节见「三·九」。

---

## 〇·〇、v4 更新要点（2026-11-03 第四轮：两种形态并存，默认立绘浮雕）

| 反馈 / 需求 | 落地 |
| --- | --- |
| 「建模出来的和图片一点都不像」「怎么感觉还是不像」 | 反馈是对的：程序化 3D 模型渲出来的是**另一个 Q 版角色**，不是定妆照那个人。v4 不硬凑 3D，改做**立绘浮雕**——把定妆照本身烘成**带厚度的 2.5D 网格**，正面看就是那张图，侧转有真实厚度与起伏 |
| 「两种形态并存：默认立绘（最像）+ 可切 3D 转圈」 | 卡片头部加「立绘 / 3D」开关；**默认立绘**。形态真源是 `settings.json` 的 `desktopPetForm`（与角色开关同一规矩，不另开 localStorage） |
| 浮雕要像 | 抠背景改用**梯度屏障 + 泛洪**（不用色差阈值——背景是渐变且肤色与背景几乎同色，色差阈值会把脸抠掉）；着色器把 sRGB 贴图转回线性再参与光照；画布按直通 alpha 合成 |
| 浮雕不能糊成一团 | 偏航锁在 ±0.28 rad，只做慢速轻摆（整圈转台留给真 3D）；相机距离系数按形态分别取 1.95 / 2.1，角色在 132px 卡片里占到 ~60% 高 |

细节见「三·八」。一句话总结：**程序化 3D 到此为止，它给不了插画的笔触；想要「就是那张图」，就得把那张图做成模型。**

---

## 〇、v3 更新要点（2026-11-03 第三轮：桌宠本体换成 3D 模型）

| 需求 | 落地 |
| --- | --- |
| 带上 Khy OS 商标并突出 | **真商标压印进美术**：御守面 / 胸章的金盘留白，由 `scripts/brand/build-pet-assets.ps1` 用品牌几何真源（`delivery/brand/png/khy-os-mark-256.png`）压成墨色刻印——不是模型画的仿制品；运行期卡片头部再叠一层**矢量真商标**（网页 `KhyMark` / 桌面 `BrandMark` / 手机 `KhyBrandMark`） |
| Lucky 好运主题 | 红金御守 + 锦鲤 + 金币 + 四叶草 + 琥珀底座；**每日运势抽签**（同一天结果固定） |
| 三端显示桌宠且不影响显示 | 桌面端 / 网页端 / APK 端统一为**应用内悬浮卡片**：左下角、132px 级、`pointer-events` 只作用在卡片自身、可拖拽、可收起 |
| 可以互动 | 拖拽移动、点击角色说话、点御守抽签、切换角色、收起/唤出——全部本地逻辑，不依赖模型 |
| **要 3D 立体模型，不要图片** | 角色本体换成 **Blender 建的 GLB 真网格**（含材质与商标贴图）；桌面端用**原生 WebGL**加载渲染，可拖拽转角度、空闲自转、抽签甩圈；WebGL/模型加载失败时降级到 PNG |

**为什么不用系统级悬浮窗**：手机端已有 `BridgeOverlayService`（原生 `TYPE_APPLICATION_OVERLAY`）做桥接悬浮框，若桌宠再走系统级会与它抢层级、抢权限、抢焦点；应用内浮层三端一致、可测试、不抢焦点，是当前更稳的形态。

---

## 一、两位角色

| | 女性角色 | 男性角色 |
| --- | --- | --- |
| 暂定名 | **澪 / Mio**（社区昵称「小澪」） | **凯 / Kai**（社区昵称「老凯」） |
| 定位 | 温柔治愈的**引导者**：新手引导、答疑、社区氛围 | 沉稳可靠的**首席工程师**：疑难兜底、架构评审、深夜值班 |
| 气质关键词 | 亲和、耐心、细致 | 冷静、可靠、少言 |
| 识别符号 | 猫耳发箍 + 渐变蓝长发 + 青绿蝴蝶结 | 银青耳机 + 藏青短碎发 + 青条机能外套 |
| 标志道具 | 笔记本（全息小方块） | 平板（全息界面） |
| 声线建议 | 清亮偏暖，语速稍慢 | 低沉平稳，句尾收力 |
| 社区职能 | 新人引导、教程陪跑、周末活动主持 | 疑难问答、架构答疑、夜间 on-call 陪伴 |

**双人关系**：澪负责「把复杂的事讲明白」，凯负责「把难的事扛下来」。组合时左澪右凯（当前 Banner 即此布局），两人共用同一套青色光效语言，互为对照而非竞争。

---

## 二、配色基线（三条线，互不越界）

**品牌真源**：`delivery/brand/khy-brand-tokens.json` + `delivery/brand/khy-brand-geometry.js`；
应用内令牌：桌面 `src/renderer/theme/globals.css`（`--color-brand: #f0a868`、`--brand-from: #ffc078`、`--brand-to: #e2703a`）、
网页 `src/styles/newapi-theme.css`（`--khy-primary` 族）、手机 `lib/ui/theme/app_colors.dart`（`AppColors.primary = 0xFFF0A868`）。

> ⚠️ 口径修正（v2）：Khy OS 的**应用品牌色是琥珀金**（`#F0A868` / `#E2703A` / `#FFC078`）；
> `#00BCD4` 青是 **TUI 子系统**的主题色（`runtime/node/backend/src/cli/tui/theme/themeRegistry.js`），
> 不是三端应用的品牌色。桌宠随应用走，故走**琥珀品牌线**。

| 线 | 色值 | 用在哪 |
| --- | --- | --- |
| **角色识别色**（青蓝） | `#7FE7E7` / `#1B2A4A` / `#FFF6E9` | 女主发色、蝴蝶结、白袜；男主外套与发色——**角色自己的身份色** |
| **品牌色**（琥珀） | `#F0A868` / `#E2703A` / `#FFC078` / `#14110E`（墨） | 商标渐变、底座辉光、卡片描边、UI 令牌——**Khy OS 的脸** |
| **好运色**（红金） | `#C8503C`（好运红）/ `#E8C36B`（御守金） | 御守、锦鲤、铜钱、四叶草、抽签气泡——**Lucky 主题专用** |

**铁律**：
1. 商标永远用品牌几何真源渲染，不许模型画、不许手搓近似图形。
2. 二创素材沿用同一组品牌色 + 角色识别色，不得引入第四个高饱和主色。
3. 好运红只出现在 Lucky 主题元素上（御守/封条/封签），不得扩散到主 UI。


---

## 三、交付物清单

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `khy-mascot-female-sheet.jpg` | 2752×1536 | 女主**设定图**：正面大立绘 + 正/侧/背三视图 + 六色配色表（带 hex 标注） |
| `khy-mascot-male-sheet.jpg` | 2752×1536 | 男主设定图，同结构 |
| `khy-mascot-female-chibi.jpg` | 2048×2048 | 女主 **2.5 头身 Q 版桌宠**：挥手 + 全息方块，浅灰底便于抠图 |
| `khy-mascot-male-chibi-v2.jpg` | 2048×2048 | 男主 Q 版桌宠：持全息平板（终稿；`khy-mascot-male-chibi.jpg` 为首版，发色偏棕、丢失耳机，已弃用） |
| `khy-mascot-female-avatar.jpg` | 2048×2048 | 女主社区头像方图（深藏青渐变底 + 青色边缘光） |
| `khy-mascot-male-avatar.jpg` | 2048×2048 | 男主社区头像方图（同背景体系） |
| `khy-mascot-community-banner.jpg` | 2752×1536 | 双人社区 Banner：未来感指挥中心 + 全息 HUD，上方留标题空位 |

生成参数与提示词原文留存于 `works/data/khy/T4-transient/tmp/khy-mascot-batch{1,2,3}.json`，可复现、可追版本。

### 3.1 Lucky 主题桌宠（v2 新增，已带真商标）

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `pet/khy-pet-female-idle.png` | 2048×2048 | 澪·常态：手捧御守（金币 + 锦鲤环绕） |
| `pet/khy-pet-female-lucky.png` | 2048×2048 | 澪·抽签成功态：抽签筒 + 举起的手 |
| `pet/khy-pet-male-idle.png` | 2048×2048 | 凯·常态：手持金币 + 胸前锦鲤徽章 |
| `pet/khy-pet-male-lucky.png` | 2048×2048 | 凯·抽签成功态：抛金币 |
| `pet/512/*.png` | 512×512 | 三端实际下发的缩略图 |
| `pet/_contact-sheet.jpg` | 1400×1400 | 2×2 压印校验图 |

**真商标压印**：美术里的御守面 / 胸章是**留白金盘**，由
`scripts/brand/build-pet-assets.ps1` 把品牌几何真源（`delivery/brand/png/khy-os-mark-256.png`）
经 ColorMatrix 转成墨色 `#14110E` 刻印压进盘心，并叠一层暖色压印暗边。
**为什么不让模型直接画商标**：生成模型会把标识画歪成「似是而非」的图案；商标必须逐像素来自几何真源。
压印后请看 `pet/_contact-sheet.jpg` 复核落位。

### 3.2 分发（三端同源）

`delivery/brand/pet/` 是分发真源，`scripts/brand/build-brand-assets.js` 第 9 节把它复制到：

| 端 | 路径 | 引用方式 |
| --- | --- | --- |
| 网页 | `delivery/web/ai-frontend/public/brand/pet/*.png` | URL `/brand/pet/xxx.png` |
| 网页（数据） | `delivery/web/ai-frontend/src/data/pet-fortune.json` | Vite `import` |
| 桌面 | `apps/khyos-desktop/src/renderer/assets/pet/*` | ES `import` |
| 手机 | `delivery/mobile/khy-os-client-app/assets/brand/pet/*` | `Image.asset` + `rootBundle.loadString` |

### 3.3 抽签数据源（单一真源）

`delivery/brand/pet/pet-fortune.json`：等级（大吉/吉/小吉/平稳，各带权重与提示）、
12 条工程向好运提示、5 个幸运色、两位角色各自的 idle/lucky 台词、动作按钮文案。

**算法（三端必须逐位一致）**：

```
fnv1a32(s):  h = 0x811c9dc5
             对 s 的每个 UTF-8 字节 b： h ^= b; h = imul(h, 0x01000193) & 0xFFFFFFFF
dateKey = 本地日期 "YYYY-MM-DD"
seed    = fnv1a32(dateKey + ":" + characterId)      // characterId ∈ {female, male}
level   = 按 levels[].weight 累计区间取 r = seed % totalWeight 命中项
tip     = tips[(seed >>> 8) % tips.length]
color   = luckyColors[(seed >>> 16) % luckyColors.length]
```

同一天同一角色的结果恒定（"每日一签"），跨天自动变化。

---

## 三·五、三端桌宠规格（统一）

| 项 | 规格 |
| --- | --- |
| 形态 | 应用内悬浮卡片，**不是**系统级悬浮窗（避免与手机端 `BridgeOverlayService` 抢层级/权限/焦点） |
| 默认位置 | **左下角**（left 24 / bottom 24；手机端 bottom 96 避开玻璃底栏，因为 `extendBody: true`） |
| 尺寸 | 角色图约 132×132（手机 120×120） |
| 层级 | 高于正文、低于弹窗与既有悬浮球（网页 `KhyFloatBall` 是 z-index 3000） |
| 穿透 | 卡片外**不得**有全屏命中区；`pointer-events` 只作用在卡片自身 |
| 拖拽 | 按住角色图拖动，阈值 4px（区分点击），松手持久化 `khy_pet_pos` |
| 互动 1 | 点击角色 → 随机 idle 台词（不重复上一句），气泡 2.5 秒自动收起 |
| 互动 2 | 点击御守按钮（内嵌真商标）→ 抽签：等级 + hint + 幸运色，图切 `*-lucky` 2.5 秒 |
| 互动 3 | 角色切换按钮：澪 ⇄ 凯，持久化 `khy_pet_char`，台词与文案同步切换 |
| 收起 | 头部收起 → 缩成 32px 真商标徽标；点徽标恢复；持久化 `khy_pet_hidden` |
| 无 IPC | 位置/状态一律本地存储（网页/桌面 localStorage，手机 flutter_secure_storage），不新增 preload/main 通道 |

---

## 四、3D 落地规范（桌宠）

- **比例**：桌宠用 2.5 头身（Q 版）；头像/立绘用 7 头身。两套比例共用同一套配色与识别符号，不做第三套。
- **朝向**：模型正面朝 +Z（与多数前端 3D 管线一致），导出时统一转成引擎朝向。
- **贴图**：单张 2048×2048 图集，主体 PBR（`baseColor` / `normal` / `emissive`），发光只给青色元素（蝴蝶结、底座环、HUD）。
- **透明**：Q 版用浅灰底而非纯透明，便于社区二次加工；正式版需另出带 alpha 的 PNG。
- **动作基线**（桌宠待机）：呼吸、眨眼、发丝/发梢轻微摆动、耳朵抖、蝴蝶结回弹、底座辉光脉动。
- **表情基线**（6 态）：微笑 / 惊讶 / 思考 / 得意 / 担心 / 认真。
- **性能**：桌宠常驻，建议单角色三角面 ≤ 15k、显存 ≤ 20MB、渲染帧预算 < 4ms。

---

## 三·六、三端落地状态（2026-11-03）

| 端 | 挂载点 | 组件 | 验证 |
| --- | --- | --- | --- |
| 网页 | `src/App.vue` 应用根（router-view 之外，所有路由都在） | `src/components/KhyPet.vue` | vitest 663 通过；真机浏览器实测：渲染 / 切角色 / 抽签切幸运姿态 / 不遮挡页面 ✅ |
| 桌面 | `src/renderer/components/layout/AppLayout.tsx` 根容器内 | `src/renderer/components/pet/KhyPet.tsx` | `npm test` 403 全绿（新增 19 条）；typecheck 无新增错误；electron-vite 构建通过 ✅ |
| APK | `lib/main.dart` 的 `Scaffold.body` → `Stack` 内 `Positioned` | `lib/ui/widgets/khy_pet.dart` | **未验证**：本机无 Flutter SDK，`flutter test` / `flutter analyze` 均未运行 ⚠️ |

三端共用同一份数据与同一套算法（`delivery/brand/pet/pet-fortune.json` + fnv1a32 播种），
因此同一天同一角色在三个端抽到的签**逐位相同**——锚点已写进 `apps/khyos-desktop/tests/petFortune.test.mjs`。

**桌面端顺带修的一处**：仓库里别人**未提交、写到一半**的 `src/renderer/components/viewer/CodeViewerPane.tsx`
里有一行写在三元表达式括号内的 JSX 注释（`{/* … */}` 在元素上下文外不是合法 JSX），
导致整个桌面端 `tsc` 与 `electron-vite build` 全部失败。本次只删掉了那一行游离注释（语义无损），
桌面端才恢复编译。**这是别人的在飞改动，若对方另有打算请以其版本为准。**

**金丝雀标记**：新文件未加 `khy-canary:` 信封——`scripts/release/canary-mark.js` 的入池契约是
`git ls-files`，未跟踪文件只会被报成「盲区」而永不自动打标。新文件等入跟踪后的下一批 `stamp` 再纳入台账。

---

## 三·七、3D 立体模型（v3：桌宠本体不是图片）

**为什么还要 3D**：桌宠要在应用里**转起来**（拖拽换角度、抽签时甩一圈），一张 PNG 做不到——
它只是「一张贴在平面上的画」。所以角色本体做成**真网格 + 真材质 + 真贴图**的 GLB。

| 文件 | 内容 |
| --- | --- |
| `delivery/brand/pet/models/khy-pet-female.glb` | 澪的 3D 模型（1.11MB，含护身符真商标贴图） |
| `delivery/brand/pet/models/khy-pet-male.glb` | 凯的 3D 模型（1.09MB，含胸章真商标贴图） |
| `scripts/brand/build-pet-model.py` | Blender 建模脚本（真源，改造型改这里） |
| `works/design/khy-mascot/model/*-preview-*.png` | 四视角渲染预览（正 / 四分之三 / 侧 / 背） |

**建模口径**
- 程序化建模（Blender headless），不是图生 3D：仓库与可用的连接器里**没有任何图生 3D 服务**，
  程序化建模是唯一能拿到真实网格的路子。
- 坐标：Y-up、原点在底座中心、整体高约 1.05 单位（glTF 规范由导出器转换）。
- **变换必须烘进网格**：`transform_apply(location/rotation/scale)` 一次全烘之后导出。
  否则网格会被缩到只剩几百分之一（三角形面积 ~1e-5，渲染出来是一堆看不见的小点）。
- **色彩管理必须设 `view_transform = 'Standard'`**：Blender 默认的 AgX/Filmic 会把
  深藏青洗成灰蓝、浅蓝洗成白 —— 设定值和渲出来的不一致，色块就永远不像定妆照。
- **渲染端必须做线性→sRGB 转换**：材质的 Base Color 是线性值（与 Blender 一致），
  WebGL 直接写进画布会整体偏暗（深藏青变近黑）。着色器里 `pow(color, 1/2.2)` 一步不能少。
- **光要跟着相机走**（着色器里传头灯方向）：写死光方向的话，模型一转、背对光就黑成剪影。
- 材质：Principled BSDF（baseColor / metallic / roughness），品牌色按「三条线」取。
- **商标**：护身符/胸章上的 Khy OS 标记是**贴图**，像素来自 `delivery/brand/png/khy-os-mark-256.png`
  （几何真源导出物）。几何复刻只会得到「像商标的商标」，所以这里坚持用贴图。
- 底座与金币是独立几何件，抽签时可以让它们动。

**应用侧渲染（三层兜底，同一个模型）**

| 层 | 触发条件 | 做法 |
| --- | --- | --- |
| ① 真 3D | 有 WebGL 上下文 | 原生 WebGL 加载 GLB（`glbLoader.ts` 解析 + `petModelRenderer.ts` 渲染），零依赖、不引 three.js |
| ② 转盘序列 | 无 WebGL（虚拟机 / 无显卡 / GPU 开关被关） | Blender 预渲的 36 帧旋转序列（6×6 精灵表）逐帧贴图 —— **每帧都是这个 3D 模型本身的渲染** |
| ③ PNG 立绘 | ①② 都不可用 | 静态立绘，保证桌宠永不消失 |

**交互分工（别弄反）**
- 在**模型上拖动** = 旋转模型（换角度）
- 在**卡片头部拖动** = 移动桌宠卡片
- 在模型上**点一下**（位移 < 4px）= 打招呼
- 抽签成功 = 模型快速甩一圈

### 打包链路（本轮修掉的四件事）

| 问题 | 修法 |
| --- | --- |
| 打包后 host 子进程起不来（`Cannot find module ...app.asar/out/host/index.js`） | asar 里的文件 **fork 出来的子进程读不到**（Electron-as-Node 无 asar 支持）→ `asarUnpack` 加 `out/host/**`，主进程改指向 `app.asar.unpacked` 实体副本 |
| 打包后找不到后端（会话列表加载失败） | host 靠 `KHY_OS_DIR` 找 `runtime/node/backend`；打包版没有仓库上下文 → 启动时带上 `KHY_OS_DIR=<仓库根>` |
| electron-builder 配置展开失败 | `build.publish.url` 写的是 `${env.DESKTOP_UPDATE_URL}`，不给值直接失败 → 打包脚本统一注入 |
| 打包卡在下载 Electron 运行时 / 依赖收集失败 | 走国内镜像（`ELECTRON_MIRROR`）+ 把 pnpm 放进 PATH（electron-builder 用 pnpm 收集 workspace 依赖） |

一键脚本：`scripts/desktop/package-and-launch.ps1`（构建 → 打包 → 带 `KHY_OS_DIR` 启动）。

**GPU 与 WebGL**：桌面端原先显式关掉了 `disable-gpu` + `disable-software-rasterizer`，
代价是**整个进程没有任何 WebGL**，3D 桌宠只能退回 PNG。现改为放开软件光栅化并允许
SwiftShader（`enable-unsafe-swiftshader` + `use-angle=swiftshader`）：有显卡走硬件，
没显卡走软件渲染，WebGL 至少能用。

**已知取舍**：程序化造型是「Q 版玩偶」风格，和 AI 出的那张高精度渲染图不是同一挂。
这一点在 v4 有了正面回应（见「三·八」：立绘浮雕形态才是默认），但**真 3D 模型本身**
仍然是 Q 版玩偶——想要「和定妆照一模一样的可转 3D 角色」，需要专业建模师基于定妆照
重做拓扑，这条留在待办里，不假装已经达成。

---

## 三·八、两种形态并存（v4：默认立绘浮雕，可切 3D 转圈）

**人的拍板（2026-11-03）**：「两种形态并存：默认立绘（最像）+ 可切 3D 转圈」。

**为什么会有这一轮**：v3 的桌宠本体换成了程序化 3D 模型，但渲出来的是**另一个角色**——
Q 版圆头、大蓝眼、浅蓝发，和 AI 定妆照（尖耳、浅蓝长发、青领结、藏青上衣 + 奶白围裙）
不是同一挂。用户连着两次反馈「建模出来的和图片一点都不像」「怎么感觉还是不像」，
这个反馈是对的，不是渲染参数没调好，是**造型本身就不是那个角色**。

程序化建模给不了插画的柔和渐变与笔触。所以 v4 不去硬凑 3D，而是**把定妆照本身
烘成立体浮雕**：正面看就是那张图（像素级一致），侧转有真实厚度与起伏。

| 形态 | 真源 | 说明 |
| --- | --- | --- |
| **立绘浮雕**（默认） | `scripts/brand/build-pet-relief.py` → `delivery/brand/pet/models/khy-pet-*-relief.glb` | 把定妆照烘成**带厚度的 2.5D 网格**（1.0MB / 1.06MB） |
| **真 3D 模型** | `scripts/brand/build-pet-model.py` → `delivery/brand/pet/models/khy-pet-*.glb` | 程序化 Q 版造型，可整圈转（1.54MB / 1.04MB） |

**形态开关的唯一真源**是 `settings.json` 的 `desktopPetForm`（`'relief' | 'model'`，默认 `'relief'`），
与角色开关 `desktopPetCharacter` 同一条规矩：设置页与桌宠卡片同写同键，**不另开 localStorage**
（那是第二个真源）。卡片头部的「立绘 / 3D」按钮即切换开关。

**抠图产物也是独立资产**：`delivery/brand/pet/khy-pet-{female,male}-idle-cutout.png`
（透明底立绘，413KB / 391KB）。桌面端的**2D 兜底**与**设置页形象预览**改用它——
原始定妆照带奶白底，放在深色卡片上会露出一块方框。三端分发脚本
（`scripts/brand/build-brand-assets.js` §9）会把 `delivery/brand/pet/` 下的
png/json/glb 各端各拷一份，所以新增资产自动到位。

> 网页端与手机端仍用**带底**的原图（网页端 idle/lucky 两张图要成套换，
> 只换一张会不一致；手机端无 Flutter SDK 可验证）。要换就得三端一起换，
> 留作后续。

**浮雕是怎么做出来的**

1. **抠背景**：不用「和背景色的色差」——这张图的背景是渐变，而且角色的肤色和背景奶白
   几乎同色，用颜色阈值会把脸一起抠掉。改用**梯度屏障 + 泛洪**：
   相邻像素亮度差 > 0.035 处算屏障（角色描边），再做一次半径 2 的闭运算补上断点；
   然后从四边往里泛洪，只走非屏障像素——能走到的就是背景。角色内部的浅色被描边围住，
   泛洪进不去，于是保留；金币、星星这类独立小岛也保留。最后把「被角色完全包住的小洞」
   填回去（御守上的商标块会被漏掉）。实测梯度分布 p90=0.023 / p95=0.046 / p98=0.092，
   0.035 正好落在噪声与描边之间。
2. **起伏**：网格按抠图掩码起伏，正面最高凸起 = 角色高度的 7.5%，再 Solidify 出 1.4% 的背板厚度。
3. **朝向**：网格在 Blender 的 XY 平面里搭（Z 是起伏方向），而导出 glTF 会把 Z-up 转成 Y-up。
   直接导出的角色是**躺平**在 XZ 平面上的，渲染器从 +Z 看过去只能看到一条边——画布一片空白。
   修法：绕 X 轴转 +90° 并 apply，Blender 里就站成 Z-up、正面朝 -Y，导出后正好
   「Y-up、正面朝 +Z」，与真 3D 模型同一套朝向。
4. **往返校验**：脚本导出后会**把 GLB 重新导入 Blender 再渲染**一遍
   （`works/design/khy-mascot/model/khy-pet-*-relief-preview-*.png`）——
   只有走这一趟才验得到「朝向对不对、贴图有没有上下颠倒」。

**浮雕的渲染约束**

- **偏航锁在 ±0.28 rad**：浮雕是一张平板，转过去会露侧边、画面变形，认不出是那张图。
  只做慢速轻摆，不做整圈转台（整圈转台留给真 3D 模型）。
- **着色器对贴图用平缓明暗**（`lit = mix(0.42+0.68·diffuse, 0.82+0.26·diffuse, textured)`）：
  画出来的表面不能被光照重新塑形，否则画面就不是那张图了。
- **贴图是 sRGB、材质是线性值**：采样后必须 `pow(texel, 2.2)` 转回线性再参与光照，
  最后统一 `pow(color, 1/2.2)` 转回 sRGB。少这一步，立绘整体发白。
- **画布按直通 alpha 合成**（`premultipliedAlpha: false`）：着色器输出的是直通 alpha，
  声明成预乘会让羽化边被乘两次 alpha，边缘发黑。

**体积代价**：GLB 以 `?inline` 内联（打包后渲染层跑在 file://，Chromium 拒绝 `fetch(file://)`），
base64 之后体积 ×1.33。浮雕从最初的 5.5MB 降到 1.0MB，靠的是**网格密度 140→96**
+ **背景面删干净**（整块背景底板没了，网格只剩角色本身）。若后续还要塞更多资产，
应改为「主进程 IPC 读文件 + 渲染层异步取」，而不是继续往 bundle 里内联。

**诚实的边界**：立绘浮雕是 **2.5D**，不是全立体模型——它有真实厚度和起伏，
但内部是平的，转到侧面是一张板。这是「像定妆照」与「是立体模型」之间的取舍，
人已拍板选前者。

### v4 踩到的两个真 bug（都写在这里，别重犯）

| bug | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 浮雕整块画不出来 | 画布一片空白，但 Blender 里渲染是好的 | 网格在 Blender 的 XY 平面（Z 是起伏方向），导出 glTF 时 Z-up→Y-up，角色**躺平**在 XZ 平面上，相机从 +Z 看过去只能看到一条边 | 绕 X 轴转 +90° 并 apply；Blender 里就站成 Z-up、正面朝 -Y |
| 模型/浮雕顶点全是 0 | 模型「塌了」，浮雕「消失」；Blender 往返渲染却完全正常 | `readAccessor` 里写的是 `if (!accessor.bufferView)` —— **bufferView 索引 0 是合法的**，而 `!0 === true`，于是第一个网格拿到一份全零顶点 | 显式判 `=== undefined / === null`；已加回归测试（`tests/glbLoader.test.mjs`）断言顶点非全零 |

第二个 bug 值得单说：**Blender 往返渲染是好的、应用里是坏的**，说明问题出在
「我们的解析器 / 渲染器」而不是「模型文件」。这类问题只有拿同一份文件在两边对照
才能定位——所以 `build-pet-relief.py` 里保留了「导出后重新导入再渲染」这一步。

### v4 终验

| 项 | 结果 |
| --- | --- |
| 桌面端测试 | **v6 后 478 项全绿**（mjs 201 + cjs 277）。v4 时为 424 项（mjs 180 + cjs 244），其中新增 6 项覆盖浮雕解析与形态契约；v5 再加 17 项避让单测 + 3 项避让契约；v6 再加 17 项：形态枚举纯函数 4 项（`tests/petForms.test.mjs`）+ 形态接线、画布身份与资产管线契约 13 项（M9×7 / M10×2 / P11×4） |
| typecheck | 既有 4 条 / 实际 4 条，**无新增错误** |
| 守卫 | 改动安全 ✅、agent-rules ✅、治理总纲 ✅、仓库布局 ✅、软著就绪 **0 error** ✅ |
| renderer 包体 | 30.5MB（主 chunk 15.4MB；浮雕从 5.5MB 降到 1.0MB 之后，内联 base64 仍占大头） |
| 实测取证 | `works/design/khy-mascot/model/pet-form3-{relief,model,realistic}.png`（三形态画布）+ 同名 `-card.png`（整卡，含标题栏与形态按钮）、`pet-avoidance.png`（自动避让） |

### 顺带清掉的仓库根垃圾（B8 复发第 8 次）

仓库根一直有 `.khy` / `.khyos` 两棵**影子数据目录**（CLAUDE.md §二 B8），布局守卫长期报红。
本次一并按 B8 的规矩处理干净了：

1. **先确认有没有独有状态**（守卫原话：「影子树里可能存着唯一的状态」）：
   - `.khy/feedback/`（5 份用户反馈）、`.khy/reports/code-review/`（4 份评审报告）、
     `.khyos/diag/prefix-backup/`（4 份源码备份）——**真数据家里没有** → 先归并过去；
   - `.khy/api_keys.json` / `settings.json` / `key_manager_audit.jsonl` —— 真数据家已有
     **更新且更大**的一份；影子那份的 api_keys.json 甚至是**损坏的**（JSON 语法被
     中文编码截断，且只含 1 个占位项）→ 直接弃用。
2. **归并**：476 个文件按「反馈/报告/诊断 → 真数据家，其余临时产物 → `T4-transient/tmp/`」
   逐个 move（不覆盖真数据家里更新的同名文件）。
3. **删除影子目录**：`rm --`（可恢复删除），根目录归零。
4. 根目录的 `.tmp-*` 残渣与空的 `4-output/` 也一并清掉（归容到 `T4-transient/tmp/`）。

现在 `check-repo-layout.js` **绿**。归并脚本是一次性的，放在
`works/data/khy/T4-transient/tmp/merge-shadow-trees.mjs`（临时区，不进版本控制）。

> 根因仍未变：影子目录是「有程序用 `process.cwd()` 拼数据家路径」造出来的。
> 影子树最后一次写入是 2026-11-03 05:28（早于本轮），说明 2026-10-12 那次
> 「10 处 cwd 相对写者改走 `utils/dataHome`」的修复**生效了**，现在只是历史残留。

---

## 三·九、自动避让（v5：挡住字就自己挪开）

**人的需求（2026-11-04）**：「如果挡到字，自己会跑到其他位置」。

**问题**：桌宠是浮在工作区之上的浮层，它确实会盖住下方的文字（聊天消息、文件名、按钮标签）。
浮层本身不该抢界面的可读性——但也不能让它变成噪音。

**实现分两层**（判定逻辑纯函数、DOM 测量分离，两者都可单测）：

| 文件 | 职责 |
| --- | --- |
| `src/renderer/components/pet/petAvoidance.ts` | **纯判定**：覆盖度、压住几行、候选位、逃逸选择、回家条件。不碰 DOM，可被 node 直接 import |
| `src/renderer/components/pet/petTextProbe.ts` | **DOM 测量**：取可见文字的逐行墨迹矩形 |

### 三条关键判定

1. **压住「几行」而不是「多大面积」**
   触发条件是 `blockedLines > 0`，不是面积阈值。一行 16px 高的文字只占卡片 ~8% 面积，
   但它恰恰是用户读不到的那一行；反过来，一大片空白根本不该触发。

2. **文字矩形取「墨迹」不是元素外框**
   用 `Range.getClientRects()` 取每个文本节点的实际行框。一个只含半句话的 `<p>` 元素外框
   可能横跨 600px，但真正有字的只有 40px——用外框会把桌宠吓跑。用外框的另一个后果是
   桌宠卡片**自己**的名字与按钮标签也算成「被挡住的字」。

3. **只在「明显更好」时才挪**
   目标位必须比当前位置**空得多**（`IMPROVE_FACTOR = 0.5`，即至少好一倍），否则它会在两个
   一样挤的角落之间每 1.5s 蹦一次。

### 两条不能省的约束

| 约束 | 原因 |
| --- | --- |
| **用户拖过就听用户的**（`MANUAL_GRACE_MS = 10s` 宽限期） | 否则用户刚松手它就跳走，像在跟人抢方向盘。拖拽位置同时记为「家」（`khy_pet_home`） |
| **弹窗盖住桌宠时不躲**（`isPetOnTop` 命中测试） | 桌宠自己都看不见了，它并没有在挡任何字 |
| **两次自动挪动之间有冷却**（`AUTO_MOVE_COOLDOWN_MS = 2.5s`） | 防抖 |
| **连续两次检测到家是空的才走回去** | 防来回蹦 |

### 实测取证

打包版应用内 CDP 实测（`dist-electron-pet/win-unpacked`）：

```
PET AT        {"left":790,"top":8}          ← 初始位置
PLACED AT     {"left":1380,"top":113}        ← 被拖到有字处
DURING GRACE  {"left":1380,"top":113}        ← 宽限期内：纹丝不动 ✅
AFTER GRACE   {"left":1376,"top":310}        ← 宽限期后：自己挪开了 ✅
AUTO-MOVED:   true
VERDICT       {"blockedLines":0,"coverage":0}  ← 新位置不压任何字 ✅
```

截图：`works/design/khy-mascot/model/pet-avoidance.png`。

### v5 的一个真 bug（写在这里，别重犯）

**重写模块时把守卫丢了**：`chooseEscapeSlot` 原本有 `if (currentRatio <= 0) return null`
（脚下没字就别躲）。重写时漏掉，于是 `currentRatio=0` 时 `ratio <= 0 * improveFactor`
恒成立，桌宠会在**根本没挡字**时也去挑位置。由单测「当前脚下没字时不动」逮住。

---

## 三·十、三形态并存（v6：立绘 / 3D / 写实真人）

**人的拍板（2026-11-04）**：「作为第三种形态并存，more 吧 3d 逆向，写实真人 3D 模型：
接外部 AI 3D 服务出 GLB，是真 3D，但风格可能偏离澪/凯的设定」。

### 三种形态

| 形态 | 资产 | 说明 |
| --- | --- | --- |
| **立绘浮雕**（默认） | `khy-pet-*-relief.glb` | 定妆照烘出的带厚度 2.5D 网格，像素级最像本人 |
| **真 3D 模型** | `khy-pet-*.glb` | 程序化 Q 版造型，可整圈转 |
| **写实真人 3D** | `khy-pet-*-realistic.glb` | 外部 AI 3D 服务 image-to-3D 出模，**资产可选** |

形态真源仍是 `settings.json` 的 `desktopPetForm`（`'relief' | 'model' | 'realistic'`，
默认 `'relief'`），与角色开关同一条规矩：设置页与桌宠卡片同写同键，**不另开 localStorage**。

形态枚举只有一份 —— `src/renderer/components/pet/petForms.ts`（纯类型 + 纯常量，
不碰资产、不碰 React）。设置页三选一与卡片头部轮换按钮共用它。

### 真人形态为什么走 import.meta.glob，而不是静态 import

写实真人 GLB 由外部 AI 3D 服务出模，**产出物在进仓之前根本不存在**。静态
`import` 在文件缺失时会把整个渲染层构建打挂（rollup 解析不到模块）——桌宠还没出模，
整个应用就编译不过，这不可接受。

`import.meta.glob` 按**匹配结果**生成 import：一个都没匹配上时它就是一张空表，
构建照过，运行时按「资产缺失」降级。资产进仓后，下一次构建自动接上，**不用改任何代码**。

```ts
// petRealisticAssets.ts
const realisticGlbMap = import.meta.glob('../../assets/pet/models/*-realistic.glb', {
  eager: true, import: 'default', query: '?inline',
}) as Record<string, string>
```

`?inline` 内联是必须的：打包后的渲染层跑在 `file://` 上，Chromium 拒绝 `fetch(file://)`。
Vite 6 支持 glob 的 `query` 选项（`assets.d.ts` 里只声明用到的那部分，没整体引 `vite/client`，
否则会顺带消掉既有 `import.meta.env` 的 typecheck 报错，而那份报错是基线的一部分）。

### 降级链（三形态共用）

真 3D（GLB）→ 转盘序列（36 帧 6×6 精灵表）→ 静态立绘。**桌宠永不消失**，
但形态不许悄悄变成另一套：浮雕形态没有转盘序列可退，宁可不动也不要换成 3D 模型的画面。

真人资产未进仓时：卡片画的是立绘，并在左下角标出「**真人模型待生成**」——
不说清楚就成了骗人。

### 资产管线（新增）

| 文件 | 职责 |
| --- | --- |
| `scripts/brand/build-pet-realistic.py` | 归一化外部服务的原始 GLB：Y-up / 正面朝 +Z / 高度 1.05 / 脚下贴 Z=0 / 剔地面 / 出 36 帧转盘精灵表 |
| `scripts/brand/build-brand-assets.js` §9 | 分发：`models/` **递归**拷到桌面端 |

`models/` 之前**根本没被分发脚本覆盖**（只扫顶层目录），之前的 Q 版模型是手工拷的
——加新模型时必漏。已改成递归。

递归分发只发**桌面端**：桌面端是唯一真正渲染 3D 的端（原生 WebGL 加载 GLB）。
网页端只用 PNG 立绘，手机端还没有 GLB 查看器。真人 GLB 单个可能 5–10MB，
发给装不了 3D 的端只是白涨包体（手机端 `assets/brand/` 会整个打进 APK）。

**归一化脚本已用现有 GLB 做过狗粮实测**：喂 `khy-pet-female.glb` 进去，
120 个网格物体 → 归一化后高 1.050 / 宽 0.599 / 深 0.596 → 导出 1.54MB GLB
+ 四视角预览 + 36 帧 → 拼成 6×6 精灵表（1.45MB），首帧正面、10°/帧、方向没翻。

### v6 抓到的三个真 bug（都是**旧账**，被三形态切换挖出来）

| bug | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 切一次形态，画布永久变成静态图 | 点「立绘/3D」按钮后 `<canvas>` 消失，换成 `<img alt="桌宠">`，之后再切任何形态都不再渲染 3D | 清理期把 `sprite.src` 置空会**触发一次 error 事件**，而 `onerror` 无条件 `setFailed(true)`；且 `failed` 从不清零 | `onerror` 先看 `disposed`（清理期的 error 不是加载失败）；换形态时 `setFailed(false)` |
| 打包版**根本没有 WebGL** | 实测 `canvas.getContext('webgl2')` 返回 null，3D 形态只能退回转盘序列，浮雕也只剩平面图 | `src/main/index.ts` 里 `disableHardwareAcceleration()` + `disable-gpu` + `disable-software-rasterizer` 还在 —— **README v3 声称已放开 SwiftShader，代码里从来没改** | 去掉整体关 GPU 的三条，改加 `enable-unsafe-swiftshader`（软件光栅化兜底）。**不加** `use-angle=swiftshader`：那会把所有渲染强行拉到软件光栅化，有显卡的机器也变慢 |
| 切到「真人」后画布上是**上一形态的旧画面** | 切到真人形态，画布里还是 3D 模型那一帧；看着像真人，其实根本不是 | 一块画布只能有一种上下文：被 WebGL 绑过之后 `getContext('2d')` 返回 null，2D 兜底画不出东西，而 `preserveDrawingBuffer` 让旧帧一直留着 | 画布身份（`key`）跟着「这条路径要不要 WebGL 上下文」走：换路径就换一块**新画布**；拿不到 2D 上下文时直接落回静态图，不留旧画面 |

第三个 bug 最阴险：它不报错、不空白，**看起来是对的**——只是内容是上一个形态。
「形态必须始终是用户选的那一个」这条设计约定，靠的就是这条不被破。

第二个 bug 是「文档说改了、代码没改」——这类分歧只有真去实测 `getContext` 才会暴露。

### 实测取证（打包版 CDP）

打包版（`dist-electron-pet/win-unpacked`）实测三形态轮换：

```
INITIAL   {"current":"立绘","nextLabel":"切换到立绘形态","hasCanvas":true,"badge":null}
click#1 → {"current":"3D",  "nextLabel":"切换到3D模型",  "hasCanvas":true,"badge":null}
click#2 → {"current":"真人","nextLabel":"切换到真人模型","hasCanvas":true,"badge":"真人模型待生成"}
click#3 → {"current":"立绘","nextLabel":"切换到立绘形态","hasCanvas":true,"badge":null}
```

三形态的画布内容**互不相同**（像素统计）：

| 形态 | 画布不透明像素占比 | 中心像素 | 渲染路径 |
| --- | --- | --- | --- |
| 立绘浮雕 | 0.189 | `[222,139,91]` | WebGL（浮雕有厚度） |
| 真 3D 模型 | 0.152 | `[56,81,131]` | WebGL |
| 写实真人（资产未进仓） | — | — | 2D 静态立绘 + 「真人模型待生成」 |

真人形态那一格的「像素统计读不出来」本身就是证据：那块画布已经不是 WebGL 上下文了
（`getContext('webgl2')` 返回 null），走的是 2D 兜底——**没有残留上一形态的旧画面**。
修复前这里读得出 3D 模型的像素（`[56,81,131]`），说明画布上留着上一形态那一帧。

取证截图：`works/design/khy-mascot/model/pet-form3-{relief,model,realistic}.png`。

WebGL 可用性实测（修复前 `g1:false` → 修复后 `g1:true`，且能在同一上下文上建第二个 program）。

### 诚实的边界

**写实真人的 GLB 还没进仓** —— 出模要外部 AI 3D 服务，本机只有 `api.replicate.com`
可达（tripo / meshy / huggingface / openai 全部超时，hyper3d / decloop DNS 解析失败），
需要 API key。管线已经备好，key 一到就是一条命令的事：

```
blender --background --python scripts/brand/build-pet-realistic.py -- <原始GLB> female
node scripts/brand/build-brand-assets.js
```

底图（真人立绘）也要人给：现有资产全是二次元 Q 版，直接拿去反推只会得到 Q 版 3D。

---

## 三·十一、真人底图与 3D 出模（v8：真人形态已落地，第三形态槽位有模型了）

### 死结在哪

第三形态要**真 3D 网格**，而本轮所有外部 image-to-3D 服务都缺同一样东西——**token**：

| 服务 | 网络实测 | 缺什么 |
| --- | --- | --- |
| `api.replicate.com` | 可达，HTTP 401 | token |
| `api.siliconflow.cn` | 可达，HTTP 401 | token |
| `dashscope.aliyuncs.com` | 可达，HTTP 401 | token |
| `apihub.agnes-ai.com` | HTTP 200 | **只有 9 个图像/视频模型，没有 3D** |
| `tripo` / `meshy` / `huggingface.co` / `openai` | 超时 | 网络不通 |
| `hyper3d` / `decloop` | DNS 解析失败 | 网络不通 |

本仓 `works/data/khy/api_keys.json` 里**没有任何 3D 服务凭据**（只有 opencode-zen / relay /
4 个 cc-switch，且 key 全是 1–9 位占位符）。所以「等 token」这条路的**唯一卡点不是技术，是输入**。

### v7 的解法：本地出模（不需要 token）—— **v8 实测：这条路在 Windows 上走不通**

v7 的判断是「既然唯一可达的镜像站 `hf-mirror.com` 能下权重，就把模型跑在本机」，
候选里选了 StableFast3D。**v8 实测推翻了这个结论**：

| 候选 | v8 实测结论 |
| --- | --- |
| StableFast3D（走 diffusers） | **不成立**：`diffusers 0.42.1` 的 `pipelines/` 下**没有** `stable_fast_3d`（也没有 `triposg` / `trellis`），全文 grep `StableFast3D` 零命中。官方实现是独立 `sf3d` 包，不在 PyPI 上（`https://pypi.org/pypi/sf3d/json` → 404），只能从 GitHub 源码装 |
| StableFast3D（走官方 `sf3d` 包） | **装不动**：`sf3d` 依赖 `texture_baker`（Rust 原生扩展）与 `uv_unwrapper`（C++ 原生扩展），无 Windows 预编译轮子，官方 `install.sh` 是 Linux/macOS 脚本 |
| TRELLIS / Hunyuan3D | 依赖 CUDA 专用扩展（`kaolin` / `nvdiffrast` / `diff_gaussian_rasterization`），本机装不上 |
| TripoSR | 官方实现是 **diffusers 的 `TripoSRPipeline`**（纯 PyTorch、CPU 可跑），但 `diffusers 0.42.1` **已经把它删了**（连 `pipelines/deprecated/` 里也没有）；要装就得退回旧版 diffusers。它还依赖 `torchmcubes` 做 marching cubes —— 该包**不在 PyPI**，而底层 `PyMCubes` 的轮子最高只到 **cp312**，本机唯一的 Python 是 **3.13**（Blender 自带），装不动 |
| TripoSG | 同样是纯 PyTorch，但 transformer 权重 5.76GB，且 diffusers 0.42.1 同样没有它的 pipeline |

已就位但**暂时用不上**的东西（留着，换机/换平台可直接用）：

- 4.02GB 权重：`D:\Portable\2-tools\models\stable-fast-3d\model.safetensors`，
  sha256 `a3416e1cf654e7d4f5e75f116cec2c3f0a14501a77d30c2f6068bbda178de388`
  —— 与上游 LFS oid **一致**（SHA256 OK）。非 gated 镜像 `patrickbdevaney/stable-fast-3d`
  与 `stabilityai/stable-fast-3d` 是同一份权重。
- Python 3.13 venv：`D:\Portable\2-tools\venv-3d`，torch 2.15.0+cpu / diffusers 0.42.1 /
  transformers / huggingface_hub / einops / trimesh / safetensors 全部装齐。

### v8 的解法：浮雕派生的真人模型填槽位（仍然不需要 token）

真 3D 网格拿不到，但**第三形态的槽位不能空着**。于是把「真人立绘」当输入，
在 Blender 里烘成**带厚度的 2.5D 网格**（有起伏、有厚度、能转、能自转），
落进**第三形态的模型槽位**。

**槽位名与实现方式解耦**（这是 v8 的关键设计）：

- 槽位文件 = `delivery/brand/pet/models/khy-pet-{female,male}-realistic.glb`
  —— 名字里**不带** relief / relief 不带进名字，因为 relief 只是**当前这一版的实现方式**；
- 渲染端 `petRealisticAssets.ts` 的 glob 认 `*-realistic.glb`，**只认槽位名**；
- 外部服务一旦给出真扫描网格，`build-pet-realistic.py` 会用**同名文件覆盖**，
  槽位不变、形态不变、渲染端**一行代码都不用改**。

诚实口径：**浮雕是 2.5D 拓扑**（正面细看是真网格，转到 90° 侧看是薄片），
**StableFast3D / 外部服务出的才是全身真 3D 拓扑**。这一条写在 README 里，
不把 2.5D 说成「扫描级真 3D」。

### 新增文件

| 文件 | 职责 |
| --- | --- |
| `scripts/brand/stamp-pet-realistic-mark.js` | 把**真商标**压进底图的空白金牌（见下） |
| `scripts/brand/prepare-image-to-3d-input.js` | 抠背景 + 取人物包围盒 + 居中缩放到 512 纯灰底（喂 image-to-3D 服务的输入） |
| `scripts/brand/build-pet-realistic-relief.py` | 真人立绘 → 带厚度 2.5D 网格 → **第三形态槽位 GLB** + 36 帧转盘精灵表 |
| `scripts/brand/image-to-3d-service.js` | 外部服务路线（Replicate / SiliconFlow / DashScope），token 只从 gitignore 的密钥池或 env 读 |
| `scripts/brand/run-image-to-3d.py` | 本地 StableFast3D 推理入口（**须改走官方 `sf3d` 包**才能用；见上表的实测结论） |


### 底图从哪来：走本仓图像管线重出

底图不是「等人给」——本仓自带的图像管线就能出。走
`runtime/node/backend/src/services/imageGenService.js` 的 `agnes` 后端
（`agnes-image-2.0-flash`），提示词锁死三条硬约束：

1. **单主体、全身、正面、纯灰背景** —— 多主体/侧身/复杂背景会被反推成一团糊；
2. **真人比例（约 7.5 头身）** —— 现有资产是二次元 Q 版，直接反推只会得到 Q 版 3D；
3. **护身符/胸章是**空白金牌**，不画任何图案** —— 商标必须像素级来自
   `delivery/brand/png/khy-os-mark-256.png`，**绝不能让模型画近似商标**。

产出（`works/design/khy-mascot/model/inbox/`）：

| 文件 | 内容 |
| --- | --- |
| `khy-pet-female-realistic-source.png` | 澪：渐变蓝长发 + 尖耳 + 青绿蝴蝶结 + 藏青围裙，手捧红色御守（空白金牌） |
| `khy-pet-male-realistic-source.png` | 凯：藏青工装衬衫 + 卷袖，胸口圆形金牌（空白） |

调用时必须先补作用域前缀——`imageGenService._env()` **只认
`KHY_IMAGE_GEN_<NAME>` / `GATEWAY_IMAGE_GEN_<NAME>`**，裸 `AGNES_API_KEY` 不生效：

```
$env:KHY_IMAGE_GEN_AGNES_API_KEY = $env:AGNES_API_KEY
node works/data/khy/T4-transient/tmp/gen-realistic-source.js
```

### 真商标压印：为什么底图要「先留白、后压印」

AI 画的商标**不是商标**——哪怕形状像，也和品牌几何真源对不上，登记材料过不了。
所以流程是两步：AI 只负责画**空白金牌**，真商标由脚本压上去。

`scripts/brand/stamp-pet-realistic-mark.js` 用色分割定位金牌（不写死坐标，
换一批底图重跑也落对位置），再把 `khy-os-mark-256.png` 的 alpha 通道重采样后
按**墨色 `#14110E` 刻印 + 暖色压印暗边**合成——与既有
`scripts/brand/build-pet-assets.ps1`（2D 美术那一套）同一口径。

实测定位与尺寸：

| 角色 | 金牌框 | 中心 | 印面 |
| --- | --- | --- | --- |
| 澪（御守） | `[498,558 → 524,599]` 27×42 | (511, 579) | 24px |
| 凯（胸章） | `[483,282 → 540,333]` 58×52 | (512, 308) | 46px |

印面占金牌短边的 88%：再大就压掉金牌的边，再小就读不出是标志。
目视复核：两处金牌上的**环形 + 菱形 K 字**结构清晰可辨，确认是真标而非 AI 近似图。

### 第三形态已落地：槽位、形状判定与终验（v8）

真人形态不再是「待生成」了。第三形态的**模型槽位**是
`delivery/brand/pet/models/khy-pet-{female,male}-realistic.glb`，
由 `scripts/brand/build-pet-realistic-relief.py` 从上面那张真人立绘烘出：

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `khy-pet-female-realistic.glb` | 1 457 332 B | 澪：真人比例立绘 → 带厚度 2.5D 网格 |
| `khy-pet-male-realistic.glb` | 1 701 228 B | 凯：同上 |
| `khy-pet-female-realistic-turntable.png` | 1 079 219 B | 6×6 精灵表，无 WebGL 时的 2.5D 兜底 |
| `khy-pet-male-realistic-turntable.png` | 1 132 490 B | 同上 |

**槽位名与实现方式解耦**（v8 的关键设计）：

- 槽位文件叫 `*-realistic.glb`，名字里**不带** relief —— relief 只是当前这一版的
  实现方式；
- 渲染端 `petRealisticAssets.ts` 的 glob 只认**槽位名**
  （`*-realistic.glb` / `*-realistic-turntable.png`）；
- 外部服务一旦给出真扫描网格，`build-pet-realistic.py` 用**同名文件覆盖**，
  槽位不变、形态不变、**渲染端一行都不用改**。

**能不能整圈转，按网格形状判，不按形态名判**（`petAssetShape.ts`）：
板状资产（浮雕）整圈转台会露出侧边、背面还是镜像，所以只做小角度轻摆；
立体网格才整圈自转。实测深度/高度比：

| 资产 | 深度/高度 | 判定 |
| --- | --- | --- |
| `khy-pet-female-relief.glb` | 0.1020 | 板状 |
| `khy-pet-male-relief.glb` | 0.0983 | 板状 |
| `khy-pet-female-realistic.glb` | 0.0585 | 板状 |
| `khy-pet-male-realistic.glb` | 0.0592 | 板状 |
| `khy-pet-female.glb` | 0.5676 | 立体 |
| `khy-pet-male.glb` | 0.4934 | 立体 |

阈值 `PLATE_DEPTH_RATIO = 0.15`：薄板侧 1.4× 余量，立体侧 3 倍以上。
**槽位换成真扫描网格后，这两条断言会自动翻过来**，自转策略随之切回整圈转。

### 实测抓到的真 bug：板状判定写反了

第一版写的是 `plateRef.current = isRelief || !isPlateLike(scene.bounds)` ——
**取反写反了**：`isPlateLike` 为 true 表示「是板状」，取反等于把板状当成立体，
于是板状资产被整圈转台转过去。后果有两处：

1. 真人形态转起来会**只剩一条边**（侧视 90° 时不透明像素占比从 0.072 塌到 0.018）；
2. 顺带把第二形态的 Q 版立体模型也误判成板状，**整圈自转被误伤**。

打包版 CDP 探针连续采样 20 次（每 300ms）才抓到：修前
`[0.0588 … 0.0181 … 0.0723]`（塌陷再回升），修后
`[0.1013 … 0.1020 … 0.0985]`（±1.7%，只有轻摆的幅度）。

修法：`isRelief || isPlateLike(scene.bounds)`。契约测试里加了一条
`assert.doesNotMatch(modelSrc, /!isPlateLike\(scene\.bounds\)/)` 锁死这个取反不许回来。

> 教训：**判定写对了不等于接线接对了**。这一类 bug 静态检查看不出来 ——
> 必须有一条**跑真模型、量真像素**的证据链（探针）兜底。

### v8 终验表

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 真人底图（两角色） | ✅ | `works/design/khy-mascot/model/inbox/khy-pet-*-realistic-source.png`（本仓图像管线产出） |
| 真商标压进空白金牌 | ✅ | `stamp-pet-realistic-mark.js`；御守 24px / 胸章 46px（占短边 88%），目视复核环形 + 菱形 K 字清晰 |
| 真人 3D 模型（槽位） | ✅ | `delivery/brand/pet/models/khy-pet-*-realistic.glb`，已分发到桌面端 `assets/pet/models/` |
| 36 帧转盘兜底 | ✅ | `*-realistic-turntable.png`；与单帧**逐像素一致**（0 差异通道） |
| 形状判定单测 | ✅ | `tests/petAssetShape.test.mjs`（跑真 GLB）5 项 |
| 形态契约测试 | ✅ | `tests/khyPetModel.contract.test.cjs` 23 项（M9d 改为「按形状判」、新增 M9h / M11） |
| 桌面端全量测试 | ✅ | 485 项（mjs 组 206 + cjs 组 279），exit 0 |
| 类型检查 | ✅ | 既有 4 条 / 实际 4 条，无新增 |
| 五道守卫 | ✅ | 改动安全 / agent-rules / 仓库布局 / 治理总纲 / 软著就绪（0 error）全部 exit=0；`arch:god` exit=0（28 个超限文件全是既有的后端老文件，本轮未碰后端） |
| 打包版 CDP 实测 | ✅ | 三形态轮换：立绘浮雕 → 3D Q 版 → **写实真人** → 立绘；真人形态渲染出真人（不再是「待生成」占位）；不透明像素占比连续 20 次采样稳定在 0.0985–0.1020（**不会转成一条边**） |

### 外部服务的凭据落在哪（没 token 也能跑）

`scripts/brand/image-to-3d-service.js` 是外部路线的客户端。**token 永远不进源码**（R2 /
SECURITY-001），只从两处读：

1. **环境变量**（优先）：`KHY_3D_API_KEY` / `REPLICATE_API_TOKEN` /
   `SILICONFLOW_API_KEY` / `DASHSCOPE_API_KEY`；
2. **密钥池**（本仓 gitignore 的 `works/data/khy/api_keys.json`）的 **`realtime3d`** 字段。

`realtime3d` 字段的格式（与池里其它 provider 同构，`parseApiKeyEntries` 认得）：

```json
{
  "realtime3d": [
    {
      "key": "<真实 token>",
      "endpoint": "https://api.replicate.com/v1",
      "priority": 10,
      "label": "Replicate image-to-3d"
    }
  ]
}
```

单条对象（`{"key": "...", "endpoint": "..."}`）也认。脚本按
`realtime3d` → provider 同名（`replicate` / `siliconflow` / `dashscope`）→
`realtime-3d` 的顺序找第一条可用条目。

**探测连通性**（不消耗额度）：

```
node scripts/brand/image-to-3d-service.js --probe --provider replicate
```

Replicate 走 model 作用域端点（`POST /v1/models/{owner}/{name}/predictions`），
**不钉死 version id** —— 钉死的 id 会悄悄过期。

---

## 五、待办（需人拍板后再动）

1. **定名**：「澪 / 凯」为暂定名，须人点头后统一改称并登记。
2. **「像真人一样」的路线已拍板（v6），v8 已落地**：三形态并存，第三形态 =
   **写实真人 3D 模型**。真人底图已由本仓图像管线重出、真商标已压进空白金牌、
   真人模型已烘成带厚度的 2.5D 网格并进仓（见「三·十一」）。
   **剩一件要人给**：3D 服务的 API key（本机只有 `api.replicate.com` 可达）。
   拿到后放进 `works/data/khy/api_keys.json` 的 `realtime3d` 字段，一条命令
   就能把槽位换成**全身真 3D 拓扑**的扫描网格 —— 槽位名不变，渲染端不用改。
   在那之前，真人形态显示的是浮雕派生的 2.5D 网格（**不是**扫描级全身拓扑，
   这一点如实标注，不假装已经达成）。
3. **姿态集**：桌宠目前每角色两态（idle / lucky），商用需补 8–12 态 + 6 表情。
4. **3D 模型精修**：现有 GLB 是程序化 Q 版玩偶；要「和定妆照一致」需建模师重做拓扑与绑定
   （含骨骼、表情 morph、护身符开合动画）。当前模型够真实立体，但不是美术级。
5. **Live2D / 骨骼动画**：GLB 目前只有静态网格 + 运行时自转，Live2D 或骨骼动画方案待选型。
6. **周边与二创规范**：需要一份《社区二创指引》（可标注/不可标注项、禁止改色、禁止商用转授权、商标不可变形）。
7. **官网/商店首发**：Banner 上方标题空位待填，建议用 Khy 品牌字标而非通用字体。
8. **桌宠是否进入官网/文档站**：当前只在三端应用内，官网/文档站是否也挂一只，待定。
9. **抽签文案是否上后台**：当前文案写死在 `pet-fortune.json`，若要运营可配置化（需评估三端是否都要拉配置）。
10. **手机端的 3D 渲染**：APK 端目前是 PNG 版；接真 3D 需要 GLB 查看器（flutter 侧没有现成 3D 依赖，
    要么引入 glTF 运行时，要么继续用 PNG 降级）。
11. **自动避让推广到另两端**：v5 只做了桌面端；网页端（Vue）与手机端（Flutter）尚未接这套避让。


---

## 六、人的意愿记录（B6 追溯）

**第一轮（2026-11-03）**，人（镜像）明确指定：**交付颗粒度 = 角色设定图（立绘 + 三视图 + 配色表）**、**男性角色 = 沉稳可靠的技术长者型**、**女性角色 = 温柔治愈的引导者型**、**用途 = 社区头像与桌宠兼顾**。

**第二轮（2026-11-03）**，人明确指定：**带上 Khy OS 商标并突出**、**Lucky 好运主题**、**在桌面/网页/APK 三端显示桌宠且不影响显示**、**桌宠要可以互动**；并拍板四项形态选择：**应用内浮层（可拖拽、小尺寸、可收起）**、**每日运势抽签 + 护身符/御守元素**、**本地互动（拖拽、点击表情、抽签、说话气泡）**、**商标压在护身符/胸牌/底座上**。

AI 负责的具体工作是：造型语言落地、配色执行、Lucky 元素编排、商标压印实现、渲染与图面组织、三端挂载点定位与实现、三端一致性规格与算法定义；**定名权、形态选择权、商标呈现方式与互动深度均由人拍板**。

**第三轮（2026-11-03）**，人看到打包版应用后明确指出：**「我想要的不是一张图片而是进行 3d 建模后的立体模型」**。
据此把角色本体从 PNG 换成 **Blender 建的 GLB 真网格**（真材质 + 真商标贴图），桌面端用原生 WebGL
加载渲染（可拖拽转角、空闲自转、抽签甩圈），并保留 PNG 作为降级路径。
AI 负责：建模脚本、材质与配色落地、商标贴图嵌入、GLB 导出与分发、WebGL 查看器与解析器、
打包链路修复（asar/host）；**造型审美上限与是否接受程序化 Q 版风格，仍由人判断**。

**第四轮（2026-11-03）**，人追加：**桌宠角色要能由用户二选一**。据此把角色选择提到设置层
（设置 → 常规 → 桌宠，二选一 + 形象预览），真源落在 `settings.desktopPetCharacter`，
桌宠卡片上的切换按钮与设置页写同一个键，两边不会各说各话。

**第五轮（2026-11-04）**，人明确：**「希望虽然是桌宠但是要像真人一样」**；
在三条候选路线里拍板「**作为第三种形态并存**」，第三形态 = **写实真人 3D 模型**，
走 **3D 逆向**（外部 AI 3D 服务 image-to-3D 出 GLB，是真 3D），
并**已知并接受**「风格可能偏离澪/凯的设定」。

AI 负责：形态枚举与真源接线、资产可选加载（glob）与降级链、Blender 归一化管线
（朝向/尺度/落地/剔地面/转盘精灵表）、资产递归分发、契约测试与打包版实测、
以及挖出并修掉两个旧账（切形态后画布被「失败态」粘住、打包版根本没有 WebGL）。
**3D 服务选型、API key 与真人立绘底图由人给**——这三件不是 AI 能自己定的。

---

*本文件为社区形象设计参考稿，非登记材料、非产品文档。若后续要正式立项（入 `docs/03_DESIGN_设计/` 并登记规则），需先由人拍板定名与二创规范。*
