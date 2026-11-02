<!-- IMPL-STATUS: todo -->
<!-- 文档分类: DESIGN-ARCH-199 | 阶段: 设计 -->

# [DESIGN-ARCH-199] 金丝雀标记与分发溯源机制

> **本文回答两个问题**：①软著申请在途、APK 已经被解包抄袭，在「不能改产品名、不能等批文」
> 的约束下，怎么让每一份流出的源码与 APK 都带着**可递交的溯源证据**；
> ②这套标记怎么做到**纯取证、零拦截**——不挂任何门、不占任何流程、不触发升阶机制。
>
> **结论卡**：双层金丝雀。**层 1 源码**——`khy-canary:` 注释信封打进
> T1 移动端 134 文件（可标全量：原始池 135 减 1 个生成物
> project_profile.g.dart，见 §3.1 排除类③）+ T2 后端核心 120 文件（cap）+ T3 桌面端
> 103 文件（2026-11-02 增，可标全量：在册 104 减 1 个 tracked 已删；electron-vite
> main/preload 包不压缩、注释随 out/ 进 asar——桌面源码层即发行层），marker 值
> `Khy-<批次>-<序号>-<随机段>` 全局唯一，台账 `scripts/release/canary-manifest.json`
> 逐文件记 sha256；**层 2 APK**——构建脚本生成逐接收人唯一值
> `Khy-<versionName>+<versionCode>-<yyyyMMddHHmm>-<rand8>`，经
> canary.properties / resValue / manifest placeholder / cmake 宏 / --dart-define
> 七个注入面落进 arsc、binary manifest、dex、libkhyjs.so 永久层，台账
> `works/data/khy/canary/ledger.jsonl`（gitignore 区，不入仓）。
> 工具 `node scripts/release/canary-mark.js` 三个子命令 stamp / verify / report，
> **恒不拦任何流程**：不挂 git hook、不进 CI、不进 npm script、不接 khy CLI、
> verify/report 恒 exit 0、不登记 FEATURE-OWNERSHIP、**不触发 `PROCESS-008` 四阶段**。
>
> **诚实边界先说清**：信封是明文注释，`grep` 得到就可以剥离。本机制不防「决心剥干净
> 的对手」，防的是三件更常见的事：**漏剥**（357 处注释 + 四个产物面，剥一处漏一处）、
> **清洗成本**（同形标识逐处手剥，漏一处即钉死来源）、**唯一指纹**
> （批次内随机段 + APK 逐接收人唯一，命中一个 marker 就把疑似品钉到具体批次/具体接收人）。
> 它是取证手段，不是防盗门。

---

## 〇、背景与目标：动机与威胁模型

### 0.1 人的意愿

| 时间 | 谁 | 要什么 |
|---|---|---|
| 2026-11-01 | 用户 | 软著申请材料在途未批，APK 已被第三方解包抄袭；要求建立可递交的分发溯源证据链（本方案即其施工裁决的产物，三施工员 A/B/C 并行，本文是 C 的交付） |

### 0.2 威胁模型

**对手**：拿到本仓源码副本或 APK 产物的第三方，将其改名再分发（去品牌、去注释、换包名）。

**对手做不到/不划算的事**：

| 对手的动作 | 本机制的效果 |
|---|---|
| 原样或轻度改名再分发源码/APK | marker 原样命中，清单/台账直指批次与接收人 |
| 逐处清洗 marker | 254 处源码注释 + arsc / manifest / dex / so 四个产物面都要剥；漏一处即钉死来源；清洗痕迹本身是恶意性证据 |
| 彻底重写（不抄结构只抄思路） | 本机制无能为力——那是思想表达的边界问题，归软著/法律手段，不是水印能解决的 |

**取证面分工**（两层各答一个问题）：

| 层 | 回答的问题 | 证据载体 |
|---|---|---|
| 层 1 源码 | 「这份源码是不是从本仓某批次流出的」 | 源码注释信封 + `canary-manifest.json`（file → marker → sha256 链） |
| 层 2 APK | 「这份 APK 是哪次构建发给谁的」 | 四个产物注入面 + `ledger.jsonl` 逐接收人映射 + `SHA256SUMS.txt` 对账行 |

两层**值不相通**（格式与正则各自独立，见 §二），清单只收源码层值——APK 层值含接收人
语义，落在 gitignore 区的 ledger，不进可递交到公开渠道的 manifest 文件。

### 0.3 目标与非目标的一句话切分

**目标**：流出物可溯源、证据可递交（清单 + sha256 + 时序）、打标过程对工作区安全（dirty
树不破坏、可精确撤销）。

**非目标**：防剥离（做不到，见结论卡）、拦截任何流程（明令禁止，见 §一）、替代软著登记
（软著判据真源 `[DESIGN-IP-001]`，本机制与其不交叉——marker 不进登记材料候选，见 §九）。

---

## 一、非目标与不拦截声明（硬边界）

> 本节是**硬边界**，不是姿态。三施工员交付门槛里凡是与拦截沾边的做法，一律越界。

| 不发生的事 | 为什么 |
|---|---|
| 不挂 git hook（pre-commit / pre-push / commit-msg 一概不接） | 打标与取证是离线人工动作，不是提交流程的一部分 |
| 不进 CI（pr-gate.yml 零改动） | marker 丢失不该拦 PR——有人在编辑器里删一行注释是合法编辑，不是违规 |
| 不新增 npm script、不新增 khy CLI 命令 | 唯一入口是 `node scripts/release/canary-mark.js …`（直接调脚本，与 `hygiene-allowlist` 同类）；避免命令面棘轮（`[DESIGN-DELIV-002]` 任务面只降不升） |
| verify / report **恒 exit 0** | 它们是盘点工具不是门；drift/stripped/missing 是**线索**不是**违规** |
| 不登记 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` | 该表管「拦截型机制」的升阶候选；本机制不拦任何东西，登记它等于谎报门第 |
| **不触发 `PROCESS-008` 四阶段** | `PROCESS-008` 的前提是「会阻断 AI 或 CI 的钩子/检查器/门禁」——本机制没有阻断面，S1 观察期、样本量毕业、升阶裁决全部不适用。这不是规避，是**不满足触发条件本身** |
| 不改任何既有代码行为 | stamp 只在被标文件插入一行注释；工具自身无网络、无凭据、无子进程写操作（git ls-files / git status 只读） |

**判据**：今后任何人想给这套机制加「自动校验 marker 是否还在」的门，那是**新机制**，
按 `PROCESS-008` 从 S1 起步另行立项——本方案不预埋那个口子。

---

## 二、标记格式真源

> 本节是格式的单一真源。两层**各自**有一条解析正则——评审第 8 条吸收：APK 层的 release
> 段内含 `.` / `+` / `-`，若与源码层共用「按固定段数切分」会错位。

### 2.1 源码层（四段，release 无连字符）

```
Khy-20261101-007-K4QX9M2P
 │    │        │    └ rand：8 位 Crockford Base32（去 I/L/O/U）
 │    │        └ seq：清单内全局单调序号，3 位起，跨批次累计
 │    └ release：批次号，默认 yyyymmdd，--release 可改
 └ 固定前缀 Khy-
```

解析正则（唯一）：

```
^Khy-(?<release>\d{8})-(?<seq>\d{3,})-(?<rand>[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8})$
```

逐字注释行（信封固定小写 `khy-canary:`，值固定大写 `Khy-` 开头）：

```
// khy-canary: Khy-20261101-007-K4QX9M2P      ← // 族
# khy-canary: Khy-20261101-007-K4QX9M2P       ← # 族
<!-- khy-canary: Khy-20261101-007-K4QX9M2P --> ← XML 族
```

### 2.2 APK 层（release 段 = versionName+versionCode-yMMddHHmm，内含 `.`/`+`/`-`）

```
Khy-1.1.17+2-202611011430-Q7XB2M9K
 │    │          │           └ rand：同字符集 8 位
 │    │          └ ts：12 位纯数字时间戳 yyyyMMddHHmm（分钟级）
 │    └ release：pubspec versionName+versionCode（1.1.17+2，实测值）
 └ 固定前缀 Khy-
```

解析正则（唯一，与源码层不同）：

```
^Khy-(?<release>.+)-(?<ts>\d{12})-(?<rand>[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8})$
```

贪婪 `release` + 12 位纯数字时间戳锚定：release 段里的 `.`/`+`/`-` 不会与段分隔符
混淆，两层各自无歧义。**为什么 APK 层不按四段切**：`Khy-1.1.17+2-202611011430-…`
按 `-` 切出 5 段（release 自己含 `-` 的版本号还会更多），固定段数切分必错位。

**`canary-manifest.json` 只收源码层值，不收 APK 层值**——APK 层台账在
`works/data/khy/canary/ledger.jsonl` 与 `SHA256SUMS.txt` 对账行（§六）。两层载体分离，
工具不存在「解析 APK 层值」的场景，两套正则各守各的面。

### 2.3 全值字符集硬约束

`[A-Za-z0-9+.\-]`——无空格、无引号、无反斜杠、无 CR/LF。这一个约束同时保证：

| 穿越面 | 为什么安全 |
|---|---|
| XML 属性 | 无引号字符，placeholder 替换后不破属性语法 |
| HTTP 响应头 | 无 CR/LF = 结构性防头注入（HttpBridge 的 `Server:` 面） |
| C 预处理宏串接 | 无引号直传 `-DKHY_CANARY=Khy-1.1.17+2-…`，串接宏逐字节还原（NDK 28.2 clang 实测，§十一） |
| .properties | 无需转义的字符 |
| `--dart-define=KHY_CANARY=…` | shell 参数安全 |

### 2.4 唯一性与幂等

- **清单内 marker 全局唯一**：stamp 生成时查重，命中即重掷 rand；
- **APK 层逐接收人唯一**：分钟级时间戳 + 随机段；接收人映射只在 ledger（gitignore 区），
  APK 值本身不携带身份信息（§九）；
- **源码层幂等**：以信封 `khy-canary:` 探测，已标即跳过——重复 stamp 不产生第二条；
- **APK 层幂等**：每次构建覆盖重写 `android/canary.properties`。

---

## 三、双层载体设计

### 3.1 层 1：源码注释信封

**插入位总规则**：文件首行（有 shebang 则其后一行），保留 BOM 与原 EOL。
**XML 特例**：有 `<?xml … ?>` 声明行时插到**声明行之后**，无声明才插文件首。

> **XML 声明行规则是实测裁定，不是风格偏好**（评审阶段以本机 aapt2，build-tools
> 36.0.0 复跑两组对照实验；本文档作者会话未复跑，引评审实测）：注释置于声明**前**，
> `aapt2 compile --dir` 报 `XML or text declaration not at start of entity.` +
> compile fail；置于声明**后**编译通过。T1 池 7 个 tracked res XML 首行全部是声明
> （逐一打印核实）——不写这条规则，7 个 res 文件会被一次打标全部打坏。

**语法表**：

| 族 | 扩展名 | 信封形态 |
|---|---|---|
| `//` 族 | .js .cjs .mjs .ts .dart .kt .java .gradle .kts .cpp .h .c | `// khy-canary: <marker>` |
| `#` 族 | .py .ps1 .sh .cmake .pro .properties（CMakeLists.txt 按文件名识别） | `# khy-canary: <marker>` |
| XML 族 | .xml .vue | `<!-- khy-canary: <marker> -->` |

khy_platform 17 个在册 .py 实测**全部无 shebang、无 coding cookie**（本会话逐一读首两行
核实）——文件首插行不破坏 Python 解释器语义。

**打标范围三级优先，总上限 400，目标 357（T1 134 + T2 120 + T3 桌面 103）**（全部为
git 在册口径，`git ls-files` 取池；本会话复现命令与读数见 §十一）：

| 级 | 池 | 数量 | 说明 |
|---|---|---|---|
| T1 移动端 | lib dart 81 + main 层 kt/java 27 + test 层 kt/java 25 + res xml 7 = 140，减 B 独占 5 = 135，再减生成物 project_profile.g.dart（*.g.dart 命中排除类③） | **134，可标全量** | 最可能被抄的代码；B 独占 5 = MainActivity.kt / HttpBridge.java / BridgeService.java / app_logger.dart / network_diagnostic.dart |
| T2 后端核心 | gateway 全树 229 + services 根层 705 + cli 三件 3 + khy_platform 17 = **954 原始池** | **cap 120** | 候选远超上限——AGENTS.md「关键入口点」表内文件优先，余下按路径字典序确定性补足；排除 COPYRIGHT-MATERIALS 候选与 khy_platform 深层 `_resources/` |
| T3 桌面端 | `apps/khyos-desktop/src/` 在册 ts 47 + tsx 57 = **104 可标** | **103**（2026-11-02 增） | electron-vite main/preload 包默认不压缩（out/main/index.js 162KB 注释逐字存活，实测）——源码层标记直接进 asar 发行层；1 个 tracked 文件已从磁盘删除（ContextUsage.tsx，skip missing-on-disk）；48 个未在册盲区按「只标在册」不标；桌面 typecheck 基线按 file\|line\|code 记键，打标行号 +1 后已重生成基线重锚定（4 条既有错误重录，「无新增错误」） |
| T4 其他 | — | **默认关闭** | `--tier all` 才启用，本轮不标 |

> 两个口径注解（防读偏）：
> ① **「services 根层」= `src/services/` 目录直下（严格深度 1）**，不是 services 全树
> ——全树 JS 2216 = 根层 705 + 子树 1511；`services/domain/**` 深层（含
> amooBridgeConfig.js、phoneBridgeCatalog.js、trajectoryProvenance 全部）本轮**不入池**
> （这是既定选择，不是遗漏；深层面将来扩池时经 COPYRIGHT 运行时排除兜住）。由此
> T2 池**无冻结条目**——amoo 守卫的 backend 侧两条冻结线都不在池内，A 的重同步范围
> 实际只在 T1 的 5 个文件（B 若先动 MainActivity 则加第 6 个，见 §七）。
> ② khy_platform 的 17 = 根层 16 + `_resources/__init__.py` 1。方案初稿按根层 16
> 求和得 953，评审订正为按 17 算 **954**——cap 120 吸收，无行为影响。

**不可打标七类**（`--plan` 输出列为 excluded-with-reason，不报错）：

1. `*.json` 及一切无注释语法文件；
2. 二进制（*.ico / *.png / *.apk / *.aab / *.db / *.keystore）；
3. 生成/压缩物（*.min.*、*_gen.*、*_blob.h、`Generated*`、*.g.dart / *.freezed.dart /
   *.mocks.dart、docs/html/ 孪生）；
4. 取证/证据区：`works/record/evidence/**`、`scripts/copyright/vendor/**`、
   MD5 钉死的 app_functions_schema.xsd、KhyAppFunctionsTest 实钉 function_id 的
   app_functions*.xml；
5. 指令文件 AGENTS.md / CLAUDE.md / README.md——运行时读取有 8000 字符/文件静默截断
   （`MAX_FILE_CHARS`，守卫规则 DOCS-003），头部插行可能把关键规则顶出截断点；
6. **COPYRIGHT-MATERIALS.json 候选**——工具**运行时** require 该 registry JSON 抽取
   路径（实测 21 个代码候选），不把清单硬编码进工具：清单将来扩面时排除自动跟随，
   且软著 60 页选材面永远干净（`PROCESS-010` 判据 C-TOOL / C-X3）；
7. B 独占的 12 个接线文件（§七）。

新增注释一律英文；既有中文注释不动。

### 3.2 层 2：APK 注入面

**值唯一生成点 = `scripts/release/build-android.ps1`**。构建段新增 canary 段：
读 pubspec 版本 → 拼值 → 三通道分发 → 收尾对账：

```
pubspec (1.1.17+2)
   │
   ▼
$canary = "Khy-$ver-$ts-$rand8"
   ├─① 覆盖写 android/canary.properties（khy.canary=…）      ← gradle 侧主通道
   ├─② $env:KHY_CANARY = $canary                              ← 次级通道
   └─③ 两条 flutter build 追加 --dart-define=KHY_CANARY=$canary ← dart 侧通道
   ▼
SHA256SUMS.txt 追加 "# khy-canary: <stamp>" 对账行
works/data/khy/canary/ledger.jsonl 追加 {ts, canary, apkSha256, aabSha256}
```

`android/.gitignore` 在 key.properties 行旁加 `/canary.properties`（构建期生成、逐接收人
不同、不入仓）。

**build.gradle 接线**：`android { }` 之前定义 `loadCanary()`（照既有 `loadKeyProps` 的
Properties 模式）：**canary.properties 优先 → env 次级 → 兜底 `Khy-localbuild`**。

> **properties 优先是防 Gradle daemon 陷阱**：daemon 常驻时 `System.getenv` 被**固化在
> daemon 启动时刻**——daemon 复用期间 env 通道静默用旧值，逐接收人 stamp 直接失效且
> 无任何报错。canary.properties 每次构建覆盖重写，文件读数是当场值。

`defaultConfig` 三面：

| 面 | 写法 | 落点 |
|---|---|---|
| resValue | `resValue "string", "khy_canary", khyCanary` | resources.arsc |
| manifest placeholder | `manifestPlaceholders += [khyCanary: khyCanary]` | binary manifest（经 AndroidManifest.xml 的 `<meta-data android:name="khy.build" android:value="${khyCanary}"/>`，与仓内 `${applicationId}` fileprovider 同机制） |
| cmake | externalNativeBuild 块 `arguments "-DKHY_CANARY_VALUE=${khyCanary}"` | 编译宏（cmake arguments 是配置输入，值变自动重配置） |

**资源收缩存活——三件套裁定**（AGP 9.1 release 默认 R8 + 资源收缩双开）：

> 评审曾提修法 (a)：manifest 里写 `android:value="@string/khy_canary"` 引用 resValue。
> **实测否决**（aapt2 compile+link+dump xmltree，本机 build-tools 36.0.0；本文档作者
> 会话未复跑，引评审实测）：meta-data 存 `@string/` 引用时，binary manifest 落的是
> `@0x7f010000` **资源引用而非内联字面值**——修法 (a) 会把 manifest 取证面弱化成
> 一个查不到值的指针。故裁定三件套：
>
> 1. **placeholder 字面值**（上表第 2 面）→ manifest 逐字面值取证面；
> 2. **resValue** → resources.arsc 取证面；
> 3. **`android/app/src/main/res/raw/keep.xml`**：`tools:keep="@string/khy_canary"`
>    ——官方收缩豁免机制，保证零引用的 resValue 不被默认资源收缩剥除。
>
> 「R8 不碰资源」的旧前提**作废**，改述为：资源面存活靠 manifest 可达性 + keep.xml。
> gradle 资源收缩端到端两轮均未实测（§十一如实标注），按「会坏」处理并以 keep.xml 兜底。

**其余注入点**（引用一律「文件 + 符号名」，不写行号——行号会漂，符号名不会）：

| # | 文件 · 符号 | 注入形态 | 存活机制 |
|---|---|---|---|
| 1 | build-android.ps1 · canary 段 | 值生成 + canary.properties + --dart-define + 对账 | 唯一生成点 |
| 2 | MainActivity.kt · `getDeviceInfo()` 表 + 新增 `khyBuildStamp()` | 设备信息表加 `khyBuild` 键；khyBuildStamp() 读同一 meta-data（placeholder 直写，Bundle.getString 直接命中字面值） | 一面注入两面取证；被执行路径，R8 不裁 |
| 3 | HttpBridge.java · 静态 `khyBuild()` + 响应头 | `Server: khy-os-bridge (<stamp>)` | 值字符集硬约束防头注入；读 Tools 的 ctxRef |
| 4 | BridgeService.java · `onCreate()` | `Tools.init` 后一条含 stamp 的 `Log.i` | App 启动 / 开机 / PC 唤醒三路必经；比 KhyAppFunctions.onCreate（仅 API36 系统绑定才建）覆盖实 |
| 5 | CMakeLists.txt | `if(NOT DEFINED …) set(… "Khy-localbuild") endif()` + `target_compile_definitions(khyjs PRIVATE KHY_CANARY=${KHY_CANARY_VALUE})` | 宏缺省兜底（IDE 直接编译也能过） |
| 6 | khy_js_jni.cpp · 宏区 + `JNI_OnLoad` | `#ifndef/#define KHY_CANARY Khy-localbuild` + KHY_STR2/KHY_STR 双层串接宏 + `static const char kKhyCanary[]`；`JNI_OnLoad` 内 `LOGI("canary %s", kKhyCanary)` | **引用必须放在 JNI_OnLoad 里**——`used` 属性挡不住 `--gc-sections` 链接期段回收，被执行路径的引用才扛得住；标记进 libkhyjs.so（arm64-v8a 单 ABI），`strings` 即取证 |
| 7 | app_logger.dart · 常量 + `init()` details | `const String kKhyCanary = String.fromEnvironment('KHY_CANARY');` + init details 加 `canary` 键（info 级） | 值进 AOT 池并随分析包自足导出；不污染错误投影 |
| 8 | network_diagnostic.dart · UA | 非空时 `khy-os/1.0 (Khy-<stamp>)` | 仅诊断路径外发（§九） |

**明确不做**：strings.xml（resValue 同面，重复）、伪装 UA 的功能性 UA 面、
app_functions*.xml / xsd（测试 + MD5 钉死）、libkhyllama.so（khyjs 已覆盖同一 APK）、
android_build.py（Flutter 主链不经它）。

**R8 存活总纲**：Kotlin/Java 侧标记只挂**被执行路径**（JNI_OnLoad、onCreate、getDeviceInfo、
HttpBridge 响应）或 **R8 不管的面**（manifest 字面值、arsc、so 内字符串），**不依赖
`-keep` 规则**——keep 规则是对手最爱删的配置。

---

## 四、工具 CLI 与清单 schema

### 4.1 三子命令

`scripts/release/canary-mark.js`——Node 标准库、零第三方依赖。**保持三个子命令**；
撤销做成 `stamp` 的 `--undo` 开关而非第四子命令（对「三子命令」字面要求的偏离如实声明，
理由：撤销是打标的逆操作，分开写会鼓励「只 undo 不 verify」的用法）。

```
node scripts/release/canary-mark.js stamp [--release <批次号>] [--max <n>]
                                          [--tier mobile|backend|desktop|all]
                                          [--only <路径>...] [--plan]
                                          [--resync-only] [--undo [--batch <release>]]
node scripts/release/canary-mark.js verify [--manifest <path>] [--json]
node scripts/release/canary-mark.js report [--manifest <path>] [--json]
```

**使用方法速查**（都是直接调脚本，无 npm script、无 khy 子命令）：

```bash
# ① 干跑：看将标/跳过/dirty/盲区/excluded 全清单，人工审阅
node scripts/release/canary-mark.js stamp --plan

# ② 真打标（T1 全量 + T2 cap 120 + T3 桌面全量，默认批次号 = 今天）
node scripts/release/canary-mark.js stamp

# ③ 核对：清单条目 vs 磁盘现状
node scripts/release/canary-mark.js verify

# ④ 盘点报告（可贴进取证记录）
node scripts/release/canary-mark.js report --json

# ⑤ 撤销（整单或按批次）
node scripts/release/canary-mark.js stamp --undo
node scripts/release/canary-mark.js stamp --undo --batch 20261101

# ⑥ 冻结表重同步（只重定位坐标写回表，不打标、不插行）
#    用途：B 后动接线文件致冻结坐标漂移时由 A 补跑（§7.2 顺序倒置补救）
node scripts/release/canary-mark.js stamp --resync-only
```

**stamp 真跑逐文件**：含 `khy-canary:` → skip(already)；否则生成唯一 marker → 按语法表
插入（XML 声明行感知）→ 写回 → 记 beforeSha256（打标前）与 afterSha256（打标后）→
清单原子写（tmp + rename）。**绝不自动 commit / push**（红线 `PROCESS-001`）。

**verify**：逐条目核对「文件在 / marker 逐字在 / sha256 现值 vs afterSha256」，四态分类
`ok / drift / stripped / missing` + 全清单唯一性审计。**恒 exit 0**——四态是线索不是门。

**report**：层级/目录计数、批次时间线、四态分布、首尾 marker 样例、唯一性结论。

### 4.2 amoo 冻结表文本锚点重同步

`scripts/ci/check-amoo-package-literals.cjs` 的 `FROZEN` 表按 **`file:line` 坐标 + 整行
文本双匹配**（`scanLiterals()` 引擎 + 逐条比对），文件首插行使冻结坐标全体下移 →
`frozen-line-missing` 与 `unregistered-literal` 双红，而它是 pr-gate 的**硬步**。
消解机制（工具的 stamp 前置两步）：

1. **文本锚点重同步**：FROZEN 每条存整行文本（`{file, line, text, why}`），工具按逐字
   文本在现行文件里重定位坐标并更新表——覆盖 B 并行改动造成的漂移（B 永不碰该 .cjs）；
   **匹配前对行尾 `\r` 做与守卫相同的归一化**（守卫对 git grep 命中行只剥行尾 `\r`、
   表文本按 LF 撰写；本仓 Windows 下 CRLF 广泛，拿原始行文本去等值匹配会全部失配
   ——后果是 fail-safe 的：5 个含冻结条目的 T1 文件全被跳过并响亮列出，amoo 面整体
   漏标但不会静默坏）；
2. 对本轮**实际被打标**的每个文件，其表内条目 line 增加插入行数；每次改表记录日志。

两步在每次 stamp 运行时执行；同一重同步另有**独立入口** `stamp --resync-only`——只重定位
坐标不打标、不插行，全表已锚定时连表都不写（§7.2 顺序倒置补救专用）。

**防呆边界**：无法锚定的条目（行被删/文本被改）→ **跳过该文件**（不打标）并在结尾响亮
列出交人裁决——这是工具对自身危险动作的防呆，不是对人的门。表提取方式：从 .cjs 文本
切片 `const FROZEN = [` 到 `];` 求值（该文件顶层有副作用且置 `process.exitCode`，
不能 require）。

**受影响条目实测**（本会话读全表逐条核对）：T1 池内 **12 条 / 5 文件**
（AmooChatText.java 1、AmooLoop.java 1、AmooSafe.java 5、Tools.java 1、amoo_service.dart 4；
方案初稿写 11 条是漏数）、MainActivity.kt 4 条（B 独占文件，坐标漂移同样被重同步吸收）、
KhyAppFunctions.java 1 条（untracked 不在池；将来收编后重同步同样覆盖）。

### 4.3 `--undo` 与 beforeSha256 安全阀

按清单（file + line + lang）逐文件**只删工具自己插入的那一行** → 删后算 sha256 与
`beforeSha256` 比对——相等才落盘并移除清单条目；不等（打标后文件另有演化）则**拒删**
该文件并列出。dirty 工作区安全：**回滚永不触碰未暂存的他人工作**（本树 T1 池 21 个、
T2 池 17 个文件带未暂存改动——评审实测，本会话同口径复现同值；`git restore` 会抹掉
它们，故 undo 是首选，git 还原降为辅路，见 §十）。

### 4.4 清单 schema（`scripts/release/canary-manifest.json`）

```json
{ "schema": "khy-canary-manifest/1",
  "marker": { "prefix": "Khy-", "envelope": "khy-canary", "randLen": 8,
              "randCharset": "0123456789ABCDEFGHJKMNPQRSTVWXYZ" },
  "batches": [ { "release": "20261101", "stampedAt": "<ISO8601>",
    "by": "canary-mark.js stamp",
    "entries": [ { "file": "…", "marker": "Khy-20261101-001-K4QX9M2P",
                   "beforeSha256": "<64hex>", "afterSha256": "<64hex>",
                   "lang": "//", "line": 1 } ] } ] }
```

`batches` 追加式。**beforeSha256 是 `--undo` 的安全阀，afterSha256 是 verify 的 drift
判据**——两个哈希各管一头，缺一不可。该文件与工具同目录（`scripts/release/`，
hygiene-allowlist 先例），刻意不落 `docs/10_规范/registry/`（守卫判据真源区，不稀释
语义）；数据落点登记见 §八（DATA-SSOT）。

---

## 五、取证流程：拿清单比对疑似抄袭品

> 前提：`canary-manifest.json` 在仓（可递交）；`ledger.jsonl` 在 gitignore 区（**记得
> 归档**——它不在 git 里，机器坏了就没了）。

**第 1 步 · 提取疑似品里的 marker**：

| 载体 | 提取手段 |
|---|---|
| 源码副本 | `grep -r "khy-canary"`（信封固定字面，跨语言统一） |
| binary manifest | `aapt2 dump xmltree badging.apk --file AndroidManifest.xml` 找 `khy.build` meta-data 字面值 |
| resources.arsc | `aapt2 dump resources` 找 `khy_canary` |
| libkhyjs.so | `strings libkhyjs.so | grep "Khy-"` |
| 运行中设备 | `adb logcat`（BridgeService 的 Log.i / JNI_OnLoad 的 LOGI）或应用日志导出（app_logger details 键 `canary`） |
| HTTP | 请求桥的任意端点看 `Server:` 响应头 |
| Flutter AOT | 日志导出分析包内的 canary 值（String.fromEnvironment 编译期常量） |

**第 2 步 · 源码层比对**：拿提取值对 `canary-manifest.json` 全 batches 的 `entries[].marker`
查：

- **命中** → 得到 `file` + 批次 `release` + `afterSha256`。此时：① 被抄的**具体文件**直接
  得知（marker 反查到文件 + 批次）；② `afterSha256` 与疑似品对应文件哈希比对可证「逐字节
  同源」或「改过但同源」；③ 跑 `node scripts/release/canary-mark.js verify` 固化「本仓清单
  现状与打标时一致」的陈述；
- **未命中** → 对手剥了这条，或值被改。转**同形检测**：按批次在疑似品全量 grep `Khy-`
  前缀与 `khy-canary` 信封；再不行，用清单里该批次文件的 sha256 逐文件比对疑似品结构
  （改名的表结构、同序的常量表都是证据）。

**第 3 步 · APK 层比对**：拿 APK 层值（正则 §2.2）查 `ledger.jsonl` 的 `canary` 字段：

- **命中** → 该行 `ts` + 接收人映射 = **这份 APK 发给了谁、什么时候构建的**——泄露源头
  直接定位（这正是逐接收人唯一值存在的目的）；
- **未命中** → 台账批次之外（对方拿旧包重建、或 ledger 未归档丢失）——退回源码层面取证。

**第 4 步 · 证据固化**：`node scripts/release/canary-mark.js report --json` 输出 + 提取的
marker 逐字值 + sha256 链 + `SHA256SUMS.txt` 对账行，一并归档进取证记录。**不裁剪、
不摆拍**（`PROCESS-010` 证据纪律 C-MAT1 同款）。

---

## 六、台账与对账：三者分工

| 台账 | 位置 | 收什么 | 入仓？ | 消费方 |
|---|---|---|---|---|
| 源码层清单 | `scripts/release/canary-manifest.json` | file → marker → before/afterSha256，按批次追加 | **入仓**（可递交） | stamp / verify / report；取证第 2 步 |
| 出包对账行 | `works/…/SHA256SUMS.txt` 追加行 | `# khy-canary: <APK层值>` | 随产物分发 | 把「某 APK 文件」与「某 canary 值」锁死 |
| 接收人台账 | `works/data/khy/canary/ledger.jsonl` | `{ts, canary, apkSha256, aabSha256}` 逐次追加 | **不入仓**（gitignore 区） | 取证第 3 步的逐接收人定位 |

**为什么 APK 层值不进 manifest**：manifest 是要能递交、可能公开的文件；接收人映射是
敏感语义。两层分离后，公开面只暴露「批次 + 序号 + 随机段」，身份语义锁在本地台账。
**数据落点登记**：`works/data/khy/canary/` 已登记进 `DATA-LOCATIONS.json`（T3-archives
语义：只追加、永不裁剪）；`canary-manifest.json` 作为 marker 台账真源登记进
`DATA-SSOT.json`（规则 `LAYOUT-007` / `LAYOUT-008`，§八）。

---

## 七、所有权与施工顺序

### 7.1 三施工员路径互斥

| 施工员 | 拥有 | 禁碰 |
|---|---|---|
| **A** 工具+源码打标+清单+冻结表 | `scripts/release/canary-mark.js`（新增）、`canary-manifest.json`（新增）、T1/T2/T3 池内源码（目标 357）、`scripts/ci/check-amoo-package-literals.cjs`（FROZEN 坐标，A 独占）、桌面 `tsconfig.check-baseline.json`（打标行号重锚定，与 amoo 冻结表同一「文本/坐标随行号漂移重锚定」纪律） | B 的 12 文件、build-android.ps1 以外的一切接线、docs/**、CHANGELOG.md、根 .gitignore、DATA-LOCATIONS / DATA-SSOT 登记表 |
| **B** 端上标记与构建接线 | 12 文件封闭清单：build.gradle、AndroidManifest.xml、keep.xml（新增）、MainActivity.kt、HttpBridge.java、BridgeService.java、CMakeLists.txt、khy_js_jni.cpp、app_logger.dart、network_diagnostic.dart、build-android.ps1、android/.gitignore；运行时落盘 canary.properties 与 ledger.jsonl | check-amoo-package-literals.cjs（A 独占）；docs/**；登记表 |
| **C** 设计文档+CHANGELOG+数据落点登记 | 本文、DESIGN-ARCH 总目录索引、CHANGELOG.md（Unreleased）、DATA-LOCATIONS.json、DATA-SSOT.json | **一切代码与脚本** |

冲突消解：A 的排除契约 = B 的 12 文件清单 + §3.1 第七类 + C 的 registry 文件；
越界即停、经人裁决、不得互改。

### 7.2 施工顺序（硬约束，钉死）

> 这一条来自评审实测的失效推演：B 的 MainActivity.kt 接线（`getDeviceInfo()` 表加
> `khyBuild` 键 + 新增 `khyBuildStamp()`）**两处插入都发生在冻结四条之前**，坐标全体
> 下移 → `frozen-line-missing` ×4 + `unregistered-literal` ×4 → pr-gate 硬步红，而
> **B 无权修 .cjs**。顺序不钉死，结局就是「A 交付后守卫全绿收工，B 一落 MainActivity
> 门就红、且无人有权修」。

**钉死的顺序**：

1. **前置（人）**：把 mobile 未入库核心源码与 B 的三个 untracked 接线文件提交入基线
   （细目与 .gitignore 交互见 7.3）；
2. **B 先行**：12 文件接线改动落盘（MainActivity 的两处插入在内）；
3. **A 后跑**：`node scripts/release/canary-mark.js stamp --plan` 人工审阅 → 真跑 stamp
   ——文本锚点重同步在**每次 stamp 运行时**执行，B 造成的坐标漂移在这一步被吸收；
4. **收口核验**（A 与 B 各自交付门槛都含）：
   `node scripts/ci/check-amoo-package-literals.cjs` → **0 error**（本会话实测当前基线
   冻结 26 / 实测 26 / 0 error / exit 0；打标与接线后必须仍绿）；
   A 另有 `node --check`、verify 全 ok、report 存档；B 另有 flutter release 出包五面抽查
   （§十一）。

**顺序倒置的补救**：若 A 已先 stamp 而 B 后动 MainActivity → B 落盘后**必须由 A 补跑
一次 `node scripts/release/canary-mark.js stamp --resync-only`**——该开关只按整行文本
重定位冻结坐标并写回冻结表，**不打任何标、不插任何行**（有漂移则报
`freeze table resynced: N coordinate(s) updated`，无漂移报 `freeze table already
anchored` 且不写文件，无法锚定的条目响亮列出后 exit 0）；补跑后核验 0 error。
**B 自己不修表、A 收工前不得假定 B 不会动**——这个约束写死在这里，ownership 文本与
本文以本文为准。（首轮本文把补救命令误写成 `stamp --plan`——那是纯干跑、从不写表，
已订正。）

### 7.3 前置基线步骤（含 .gitignore 交互，评审第 4 条吸收的订正）

AndroidManifest.xml、CMakeLists.txt、khy_js_jni.cpp 当前 **untracked**（本会话实测：
`git ls-files` 三者皆空；AndroidManifest.xml 另经 `git cat-file -e HEAD:<path>` 确认
不在 HEAD、`git log` 该路径零输出）。不落基线就没有回滚基线——**动工前必须先处置**：

| 文件 | 处置 | 为什么 |
|---|---|---|
| CMakeLists.txt、khy_js_jni.cpp | 普通 `git add` 即可 | 不被任何 ignore 规则命中（本会话 `git check-ignore -v` 无输出） |
| **AndroidManifest.xml** | **普通 `git add` 会被静默拒绝**——根 `.gitignore:40` 的 `AndroidManifest.xml` 是**无前导斜杠的全局模式**，把 `delivery/mobile/…/src/main/AndroidManifest.xml` 一起忽略（本会话 `git check-ignore -v` 实证命中 `.gitignore:40`）。两个合规选项：**`git add -f <该文件>`**（一次性强制入库，零仓库文件改动，推荐）或根 `.gitignore` 加例外行 `!delivery/mobile/khy-os-client-app/android/app/src/main/AndroidManifest.xml` | `.gitignore:37-38` 的注释自己承认这类缺斜杠模式曾把 MainActivity.kt 坑得无法入库——同型事故复发点。**例外行方案涉及根 .gitignore，而 ownership 三方都无权碰它（A 禁碰、B 只有 android/.gitignore、C 只碰登记表）→ 若选例外行，属人裁决**；`git add -f` 可由 B（或人）直接执行，推荐后者 |
| 兜底 | 逐字节备份（.bak）并登记路径 | 三件都适用；备份是「不落基线」时的最低保障，此时该三件只能靠备份还原 |

同时顺带完成「mobile 未入库核心源码入基线」：untracked 盲区 29 个源码条目（构成见
§十一）里恰含最可能被抄的桥/引擎核心（KhyAppFunctions.java、SandboxVault.java、
VaultEnvelope.java、ProvisioningCode.java 等）。人提交入基线后池自然收编；**人不上提
交则按「只标在册」走，盲区清单如实落 `--plan` 输出与本文 §十一，不假装覆盖**。

---

## 八、守卫影响分析（修正版，逐条）

> 方案初稿对本节的三个断言被评审实测推翻过，本节是修正后的最终口径；每条给本会话
> 实测出处。

| 守卫 | 影响与裁定 |
|---|---|
| `check-agent-rules.js` | **按扩展名全量扫描、不读 registry paths 裁剪**。`CODE_EXTS` 含 `.dart`（自 2026-10-26 起，源码注释明示补 .dart 的动机即 delivery/mobile 此前完全没被扫过），**不含** .kt/.java/.xml。合成实验 `node scripts/ci/check-agent-rules.js <tmpdir> --strict-warnings` → "no violations found"——mobile dart 在扫描面内且**标记注释文本实测清洁**（规则 1–4 的模式都不命中注释信封） |
| `check-amoo-package-literals.cjs` | pr-gate **硬步**（无 continue-on-error）。当前基线冻结 26 / 实测 26 / 0 error（本会话实跑）。坐标+整行双匹配 → 打标靠 §4.2 文本锚点重同步吸收；**A 交付门槛与 B 交付门槛都含 0 error 核验**（§7.2 第 4 步） |
| `check-node-syntax.js` | 默认目标含 `scripts`（源码默认 targets 数组）→ canary-mark.js 必须过 `node --check`，已列 A 门槛 |
| `check-wiring.js` | **不适用**——全文 190 行无一引用 `scripts/release/`（本会话 grep 零命中）；本机制不新增 npm script，也无「孤儿检查器」问题（canary-mark 不是 check-*，不需要门引用） |
| `check-repo-layout.js` | ① 本文已登记进 DESIGN-ARCH 总目录索引（计数 190→191），docs-index 完备性不退化；② `dangling-task` 判据**只查 `npm run <token>` 字面**（git grep 正则提取）——本文与 CHANGELOG 的调用一律写 `node scripts/release/canary-mark.js …`，不产生悬空任务 |
| `check-copyright-readiness.js` | COPYRIGHT-MATERIALS 候选**运行时**从 registry JSON 排除（实测 21 个代码候选；∩T2 仅 sessionPersistence.js 与 sessionSearchIndex.js，均排除）。守卫自身 S1 恒 exit 0；打标不改产品名/版本串/模块清单，`PROCESS-010` 五处一致性不触发；60 页选材面因排除 ⑥ 而零接触 |
| `check:data-layout`（`DATA-LOCATIONS.json`） | `works/data/khy/canary/` 已登记 seedEntries（ledger.jsonl，T3-archives）。**如实记录**：`works/data/khy` 顶层预算 6（五档 + 索引），`canary/` 目录落盘后将被 S1 观察者记一条 `L-1/unregistered`（目录尚未落盘时无此 finding——本会话实测守卫 EXIT=0、输出零 canary 命中）——与本根现存未归位条目同属既有观察口径债，S1 只记录不阻断；将来若做 tier 前缀迁移一并收编 |
| `check:ssot-data`（`DATA-SSOT.json`） | `canary-manifest.json` 已登记为 marker 台账真源（sources[]）。登记理由：marker→文件映射是本工具自产的新数据事实、真源唯一无镜像——**先登记防将来**：有人再写一份 marker 映射时，守卫按影子副本报，而不是因为「没登记」而看不见。**窗口期如实记录**：登记后、A 交付 manifest 文件前，守卫记一条 `ssot-source-missing`（查不到真源必须报红、不许假绿——本会话实测）；pr-gate 跑的是无 `--strict` 档（pr-gate.yml 的 `check-ssot-data.js` 步），S1 观察者恒 exit 0，CI 不红；A 交付文件后该 finding 自然归零 |
| `check-version-sync.js` | **不触发、不 bump**：内部工具 + 注释行不改对外行为（`PROCESS-005` 第 1 条「仅 Fixed / 不改对外行为不 bump」；本条目按 Added 记 CHANGELOG 但不递增版本，不涉 R-2a 人批 MINOR/MAJOR） |

---

## 九、隐私与合规边界

- **逐接收人可区分是溯源目的本身**，不是副作用——APK 值若不逐接收人唯一，第 3 步取证
  就退化为「只知批次不知去向」。因此每份 APK 的 canary 值必然可区分。
- **但值本身不含身份**：源码层值 = 批次号 + 序号 + 随机段，APK 层值 = 版本号 + 构建时间
  + 随机段；「哪个值对应哪个接收人」**只存在本地 ledger**（gitignore 区、不入仓、不随
  APK 分发、不上传）。APK 落到第三方手里，第三方能看到的只是「我是第 N 份」的能力，
  看不到名单。
- **UA 外发面只有一处**：network_diagnostic.dart 的诊断请求 UA，且仅非空时拼接；其余
  七面全部本地留存（arsc/manifest/dex/so/日志/HTTP 响应头/分析包）。
- **与 `PROCESS-010` 的关系**：marker 文件与工具**不进**软著登记材料候选（§3.1 排除 ⑥
  的运行时排除保证 60 页选材面零接触）；marker 是维权取证手段，不是登记材料。
- **不拦截声明**（§一）本身就是合规边界：本机制对贡献者零摩擦——删掉一行 canary 注释
  不会触发任何门，verify 只会在下次盘点时把它报成 stripped 供人知晓。

---

## 十、回滚

> 原则：**工具逆操作为主、git 还原为辅**。本树 T1 池 21 / T2 池 17 个文件带未暂存改动
> （§4.3 实测），`git restore` 会抹掉未暂存的他人工作——「restore 后逐字节一致」只对
> 干净文件成立，不能当首选。

1. **首选：`node scripts/release/canary-mark.js stamp --undo`**（整单或
   `--batch <release>`）：按清单（file + line + lang）逐文件只删工具自己插入的标记行 →
   删后 sha256 对比 beforeSha256，相等才落盘并移除清单条目；不等（打标后文件另有演化）
   拒删并列出交人。全程不触碰未暂存改动、不需工作区干净。amoo 冻结表坐标由**同一次
   `--undo` 同步回退**（重定位回插入前的坐标）。undo 后重跑 stamp = 全新打标（新随机段、
   序号续计）——幂等语义：对未标 / 半标 / 已标状态都收敛到「清单与文件一致」。
2. **辅路：git 还原**仅限干净文件或已提交批次（`git revert`）；**禁止**对含未暂存改动的
   打标文件整树 restore。
3. **APK 层**：git 还原 B 的 12 个接线文件即移除全部注入点；**但三个 untracked 接线
   文件（AndroidManifest.xml / CMakeLists.txt / khy_js_jni.cpp）必须先按 §7.3 落基线，
   否则只能靠备份还原**——其中 AndroidManifest.xml 落基线须 `git add -f` 或根
   .gitignore 例外行（普通 add 被静默拒绝，见 7.3 表格）。`android/canary.properties`
   与 `works/data/khy/canary/ledger.jsonl` 手工删除即可。**已发出的 APK 收不回**；stamp
   与 ledger 记录不受回滚影响、永久有效——**回滚前先归档 ledger.jsonl**（它不在 git
   里，删了就没了）。
4. **不触碰**：`works/record/evidence/**`、COPYRIGHT-MATERIALS 候选（本就未标）；已推送
   后的回滚走人工 revert（红线 `PROCESS-001`，AI 不自动 push）。部分回滚：只撤 APK 层 =
   还原 B 12 文件；只撤源码层 = `--undo`；两层路径互不相交，可独立撤销。

---

## 十一、验证手段与盲区

### 11.1 本会话实测（本文作者跑过，命令与读数）

| 事实 | 命令 → 读数 |
|---|---|
| T1 池 | `git ls-files`（lib dart / main kt+java / test kt+java / res xml 四组 glob，**根层文件须单独 `dir/*.ext` 匹配——git pathspec 的 `**` 不匹配零层目录**，首轮 80/71/1511 的偏差全部由此而来）→ 81+27+25+7−5(B 独占) = 135，其中 `lib/core/config/project_profile.g.dart` 命中生成物排除（canary-mark.js `GENERATED_RE` 的 `*.g.dart`，§3.1 类③）→ **可标 134** |
| T2 原始池 | 同法 → gateway 229 + services 根层 705 + cli 三件 3 + khy_platform 17 = **954**（services 全树 2216 = 根层 705 + 子树 1511，根层=目录直下深度 1） |
| T3 桌面池（2026-11-02 扩） | `git ls-files apps/khyos-desktop/src` 按扩展名 → ts 47 + tsx 57 + json 1 + html 1 + css 1 = **107 在册**，可标语法 **104**（工具 SLASH_EXT 补 .tsx/.jsx 后 tsx 入池）；electron.vite.config.ts 无 minify 配置，out/main/index.js（162KB）实测非压缩、注释逐字存活 → 桌面源码层标记随构建进 asar 发行层（main/preload 两面）；renderer 走 vite 默认压缩，产物注释存活**未实测**，按「会坏」处理 |
| 打标结果（T3 扩池 2026-11-02） | `stamp` → 103 文件入批次 20261102（missing-on-disk 1：ContextUsage.tsx；未在册盲区 48 不标）；`verify` → `357 entr(y/ies) across 2 batch(es)`，`states: {"ok":357}`，uniqueness 全过；`report` → `by tier: {"mobile":134,"backend":120,"desktop":103}`；`check-amoo` → 26/26/0 error（桌面打标与冻结表零交集，无需重同步）；桌面 `typecheck-baseline` 打标后先红（行号 +1，4 条既有错误重记为「新增」）→ 重生成基线（4 条重锚定）→「无新增错误」；桌面测试套件 194/194 pass；`check-agent-rules --changed` → 0 error / 7 warning（warning 均为既有代码，非金丝雀注释引入） |
| 打标结果（修补轮 2026-11-01 复测） | `node scripts/release/canary-mark.js verify` → `254 entr(y/ies) across 1 batch(es)`，`states: {"ok":254}`，uniqueness 全过；`report` → `by tier: {"mobile":134,"backend":120}`。首轮文档口径 135/255 即漏减上述生成物所致，已订正 |
| dirty | `git diff --name-only` ∩ 池 → T1 **21**、T2(954 池) **17** |
| amoo 基线 | `node scripts/ci/check-amoo-package-literals.cjs` → 冻结 26 / 实测 26 / 0 error / exit 0 |
| 冻结表结构 | 读 `check-amoo-package-literals.cjs` 全表 → `{file,line,text,why}`，T1 池内 12 条 / 5 文件 + MainActivity 4 条 + KhyAppFunctions 1 条(untracked)；CRLF 归一化在 `scanLiterals()`（命中行剥行尾 `\r`，表文本 LF） |
| .gitignore 交互 | `git check-ignore -v` → AndroidManifest.xml 命中 `.gitignore:40`（无前导斜杠全局模式）；CMakeLists/khy_js_jni 不命中 |
| 盲区 29 | `git ls-files --others --exclude-standard` 分类 → lib dart 3 + flutter test dart 6 + android src/main 20（19 个未忽略未入库 + AndroidManifest.xml 被忽略但在盘）＝ **29 个源码条目**（方案初稿写 31，评审订正采纳） |
| khy_platform | 17 个在册 .py（根层 16 + `_resources/__init__.py`），首两行逐一读 → **0 shebang、0 coding cookie** |
| CODE_EXTS | 读 `check-agent-rules.js` 扩展名清单 → 含 .dart（2026-10-26 补），不含 .kt/.java/.xml |
| 守卫接线 | check-wiring.js 全文 190 行零 `scripts/release` 引用；check-repo-layout 的 dangling-task 只 grep `npm run <token>` 字面；check-node-syntax 默认 targets 含 `scripts` |
| 版本锚点 | pubspec.yaml → `1.1.17+2` |
| 索引完备 | DESIGN-ARCH 目录 190 个 .md = 索引 190 条 → 本文登记后 191/191 |

### 11.2 评审实测（本文引述，本会话未复跑）

- aapt2（build-tools 36.0.0）两组对照：XML 声明前注释 compile fail / 声明后通过；
  meta-data `@string` 引用在 binary manifest 存 `@0x7f010000` 引用不内联、placeholder
  字面值逐字入库——三件套裁定（§3.2）的依据；
- NDK 28.2 clang 以无引号 `-DKHY_CANARY=Khy-1.1.17+2-…` 编译，串接宏产物逐字节还原
  35 字节 + NUL（§3.2 第 6 面的依据）；
- 两层解析正则合成实验：源码层值不被 APK 正则命中、APK 值（含全数字 rand、release 尾随
  数字）唯一切分；禁 I/L/O/U 与引号注入均被拒。

### 11.3 未实测（如实标注，按「会坏」处理）

- **gradle 资源收缩端到端**：评审与本文会话均未跑完整 gradle 构建——AGP 9.1 默认双开的
  资源收缩是否会剥掉 resValue 未实证；兜底 = keep.xml（§3.2 三件套）+ B 交付门槛的解包
  五面抽查（见下）。
- **flutter build apk --release 出包**：未跑；落在 B 交付门槛——出包后解包五面抽查
  （aapt2 dump xmltree 查 manifest 字面值、aapt2 dump resources 查 khy_canary、dex 字符串、
  libkhyjs.so strings、logcat）。

### 11.4 机制自身盲区（不假装覆盖）

- **untracked 盲区 29（移动端）+ 48（桌面端）**：处置 = §7.3 前置入基线；人不提交则不标
  （只标在册），`--plan` 输出与本文如实记录；
- **T3 桌面层已启用（2026-11-02，103 文件入账）**；T4 其他仍默认关闭（`--tier all` 才扩）；
  桌面 renderer 产物（vite 默认压缩）注释是否存活未实测，按「会坏」处理——main/preload
  两面已实测存活；
- **信封可剥离**（结论卡已述）：机制价值 = 漏剥概率 × 清洗成本 × 唯一指纹，不承诺对抗
  彻底清洗；
- **ledger 在 gitignore 区**：不入仓 = 有丢失风险；归档义务在 §五/§十两处点名。
