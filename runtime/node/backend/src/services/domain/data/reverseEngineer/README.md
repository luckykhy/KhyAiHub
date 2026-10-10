# reverseEngineer — 制品逆向与自验流水线（D2 功能单元）

一句话：把一个编译产物（exe / jar / wheel / asar / 脚本）交给它，得到「它是什么 + 用什么写的 +
能取回多少源码 + 与 khy 构建清单差在哪」的结构化报告——**全程只读字节，绝不执行制品**。
这是 DESIGN-ARCH-054 的落地载体，也是「khy 生成的软件由 khy 自己验证」这条诉求的唯一实现处。

本单元的属性是**确定性优先、模型增益**：前五层零模型零猜测，只采集事实；第六层才允许模型介入，
且模型产出永远落在 `inference` 区并带 `confidence`，与 `evidence` 区物理分隔。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取；本单元的 D2→D1 边按偏差登记，不写白名单）。

## 逐成员

| 文件 | 角色 | 出边（域） | 同名测试 | 用例 |
|------|------|-----------|----------|------|
| `formatRegistry.js` | 签名/家族/可还原档位/嵌入标记的**声明式单一真源**（17 格式 + 6 标记，冻结导出） | 无（纯数据） | `formatRegistry.test.js` | 11 |
| `artifactScanner.js` | ① 只读分诊：格式、架构、大小、SHA-256、嵌入标记，标记可升级档位 | `./formatRegistry`（同单元） | `artifactScanner.test.js` | 27 |
| `stringHarvester.js` | ② 字符串证据：ASCII + UTF-16LE 捞取，5 类语义分类 + 10 条工具链指纹 | 无（纯 Buffer） | `stringHarvester.test.js` | 13 |
| `sourceRecoverer.js` | ③ 自包含产物 → 源码/字节码清单（SOURCE 档主路径；默认只编目不落盘） | `node-stream-zip`（第三方，惰性） | `sourceRecoverer.test.js` | 18 |
| `toolOrchestrator.js` | ④ 原生/字节码 → 探活并驱动外部反编译器（10 家族计划表） | `src/tools/platformUtils`（未入域）、`utils/javaEncoding`（D3） | `toolOrchestrator.test.js` | 16 |
| `reconstructionPort.js` | ⑤ 证据包 → 结构化重建（brain 注入式；无模型退化为证据报告） | `services/gateway/safeJsonParse`（**D1**）、`utils/withTimeout`（D3） | `reconstructionPort.test.js` | 19 |
| `verificationLedger.js` | ⑥ 与 khy 构建清单比对 → 保真度评分与差异点名 | 无（crypto/fs/path） | `verificationLedger.test.js` | 13 |
| `asarArchive.js` | asar 容器头解析（pickle 头尺寸 + JSON 树展平），供工具层直接复用 | 无 | `asarArchive.test.js` | 13 |
| `genericExtractor.js` | 未知归档格式的通用抽取兜底 + 逐平台安装命令生成（11 扩展名） | `src/tools/platformUtils`（未入域，注入式探测） | `genericExtractor.test.js` | 14 |
| `index.js` | 门面：串起 ①→⑥ 的 `analyze()`，含授权门与降级 | 上述六个子模块 | `index.test.js` | 20 |

合计 10 个源文件 / 2652 行，10 份同名同目录测试 / **164 例全绿、0 skip**（逐文件计数见下「测试怎么跑」）。

## 消费者（实测 fan-in = 2，按单元路径直连计）

- `src/services/reverseEngineer/index.js` —— D1 **再导出壳**（`module.exports = require('../domain/data/reverseEngineer')`）。
  真正的工具入口 `src/tools/reverseEngineer.js:74` require 的是这个壳，因此主消费链是两跳。
- `src/tools/unpackTool.js` —— 直连本单元的两个成员：`:7` 的 `genericExtractor.js`、`:272` 的 `asarArchive.js`。

注：`src/tools/**` 在 `DOMAIN-DEPS.json` 里**不属于任何域根**（既非 D1 也非 D4），所以「unpackTool 直连 D2」
这条边在方向判定上是**未映射**而非合法/非法——已作为口径问题上报（见 `khy.module.json` 的 `_fanIn_note`），
本单元不自裁。

## 六层契约（每条都对应命名测试）

1. **只读是硬约束，不是约定**：分诊层只 `fs.openSync(..., 'r')` 读头部 512 字节 + 头/尾窗口，
   从不 `spawn` 被分析对象。签名窗口之所以是 512，是因为最深的 POSIX tar magic 落在偏移 257；
   窗口之外的 magic 一律不算命中，宁缺毋滥。
   → `HEADER_BYTES=512 是有意为之：最深签名 tar 的 magic 在 257`、
   `签名窗口外的 magic 不算命中（前 512 字节之外即未知）`
2. **事实照收，判定留白**：文件不存在、是目录、0 字节、乱码，都返回完整的中性事实对象
   （`exists=false` / `unknown` 档），绝不抛也不编造格式。`scanFile` 与 `scanFileSync` 逐字节同结果。
   → `不存在的产物：exists=false 且各字段为中性值，扩展名仍按小写记录`、
   `0 字节文件：exists=true，sha256 为空串哈希，格式 unknown 且不抛`、
   `scanFile 与 scanFileSync 对同一文件给出逐字节相同的结果`
3. **撞号要消歧，架构只按头字段粗提**：`cafebabe` 同时是 Java class 与 macOS fat Mach-O 的 magic，
   靠第 6–7 字节的语义分野改判；边界按实测钉死（44/45/200/201）。ELF/PE/Mach-O 的位宽与架构只读
   确定性头部字段，头部畸形即降级为空对象。
   → `cafebabe 归 format 遍历里靠前的 macho，再由后续字节改判`、
   `_disambiguateCafebabe 实测边界（以实测为准，不按注释设想）`、
   `PE 的 e_lfanew 越界或 PE\0\0 签名不符：架构降级为空对象`
4. **嵌入标记是「升级器」且有硬闸**：标记可以把档位从 native 升到 bytecode/source（如裸 ELF 里
   发现 PyInstaller cookie），但**只在更强时**生效，且 `appliesTo` 是硬闸——BSJB 出现在 ELF 里
   不会触发 dotnet 标记。工具候选按顺序去重合并。
   → `PE + BSJB → dotnet 标记：家族换掉、档位升到 bytecode、工具合并、标签追加`、
   `标记的 appliesTo 是硬闸：BSJB 出现在 ELF 里不触发 dotnet 标记`、
   `标记档位不更强时只记事实不降级：go-binary 命中 ELF 仍留 native/elf`
5. **解包永不逃逸沙箱**：条目名逐条过 `_isSafeEntry`（绝对路径 / 上跳 / 盘符 / 非串一律拒）与
   `_isWithinDest`（边界本身算命中，近似前缀不算）。默认 `listOnly` 只编目，**只有显式给 `outDir`
   才落盘**。条目数与解压总量都有 env 上限，超限整包拒绝或如实标 `truncated`，绝不返回半份清单冒充完整。
   → `_isWithinDest 只认目标目录之内，边界本身算命中，逃逸与近似前缀不算`、
   `给 outDir 才抽取：逐成员落盘并保留目录结构，成员带 extractedTo`、
   `条目数上限走 env：超限整包拒绝且不返回半份清单`
6. **外部工具：不存在就说不存在**（防呆②）。`probe` 逐条如实上报 `available/path`；`orchestrate`
   默认 `run:false` 只探活不开火；一条候选都没有时 `degraded=true` 并在 `hint` 里列出全部安装来源。
   真开火走 `execFile` + 固定 argv + 超时 + `maxBuffer`（防呆⑤），制品路径永远是**独立 argv 元素**。
   → `无可用工具：attempted=false、degraded=true，hint 列出全部候选及其安装来源`、
   `run:false（默认）只探活不开火：hint=probe-only 且 degraded=false`、
   `防呆⑤实测：带 shell 元字符与空格的制品路径始终是独立 argv 元素，绝不拼接`
7. **证据与推断物理分隔**（防呆① 的第二义：不伪造）。`buildEvidencePack` 对每一路证据设硬裁剪上限
   （url 15 / path 20 / version 15 / sample 30 / member 80 / 反汇编样本 6000 字符）；`reconstruct`
   只把模型 JSON 里**已登记的键**收进 `inference` 区，未知键丢弃，`confidence` 钳到 [0,1]，数组各有上限。
   → `buildEvidencePack 的裁剪上限：15/20/15/30/80（输入必须真的超上限才算测到）`、
   `reconstruct 把 brain 的 JSON 收进推断区，未知键一律丢弃`
8. **没有模型也照跑**（防呆③）。brain 缺席 / 超时 / 抛错 / 返回散文 / 返回非对象——六种失效形态
   全部收敛为 `_deterministicReport`（`source:'evidence-only'`），并在 `caveats[0]` 说明原因；
   确定性语言结论**不因退化而抹掉**。
   → `模型失效的六种形态全部收敛为证据报告，绝不抛出`、
   `证据报告的语言结论在退化路径上仍保留（不因失败而抹掉确定性事实）`
9. **保真度是一把可复算的尺**：`fidelity = 50×哈希一致 + 50×源码覆盖率`；判级 `verified` 要求哈希一致
   **且**覆盖 ≥0.95，`partial` 要求覆盖 ≥0.6 或哈希一致。无清单不阻断——退化为 `no-baseline` 且
   `fidelity:null`，如实说「没法判定」。缺失与多余按 basename 归一比较，大小写与目录差异都算命中。
   → `verify 的算术：哈希一致占 50 分，覆盖占 50 分；无哈希基线时只按覆盖给分`、
   `verify 把 scan 缺 sha256 判成「不一致」而不是「无法判定」`、
   `verify 的清单比较按 basename 归一：大小写与目录差异都算命中`
10. **授权门（防呆⑥）在门面，不在子层**：产物同目录能定位到 `.khy-build-manifest.json`，**或**调用方
    显式 `authorized:true`，才放行还原/反编译/深度重建；否则只做只读分诊 + 字符串归纳，并在 `warnings`
    里把「怎么授权」写清楚。子模块单独调用不设门（它们是纯函数与被工具层使用的叶子）。
    → `未授权：只给只读分诊结论，还原/编排/清单核对一律不开`、
    `同目录存在 khy 构建清单即视为自验：无需 authorized 也能开深度能力`
11. **任何一层失败都不许拖垮整条链**：`analyze` 对「产物不存在 / 是目录 / brain 挂死」全部降级为
    部分报告并保留已得事实。
    → `产物不存在：ok=false，判级 no-artifact，且给出明确警示而非静默空报告`、
    `brain 超时：门面不挂死，回退到证据报告并说明原因`

## 配置（全部 env 门控，零硬编码）

| 变量 | 默认 | 作用 |
|------|------|------|
| `KHY_RE_STRING_WINDOW` | 8 MiB | 字符串收割只读头部这么多字节 |
| `KHY_RE_MAX_BYTES` | 64 MiB | 解包总量上限，超限标 `truncated` |
| `KHY_RE_MAX_ENTRIES` | 20000 | 归档条目上限，超限整包拒绝 |
| `KHY_RE_TOOL_TIMEOUT_MS` | 20000 | 单个外部工具的**活动式**超时 |
| `KHY_RE_TOOL_MAX_BUFFER` | 512 KiB | 外部工具输出上限，超限如实标 `truncated` |
| `KHY_RE_BRAIN_TIMEOUT_MS` | 30000 | 模型重建超时（`withTimeout` 竞速，不 kill 进程） |

## 本单元修掉的缺陷（批次 27）

- **B27-F1（`genericExtractor.js`）**：三张表都以 `TABLE[key] || 兜底` 取值，而 `key` 来自**外部数据**
  （平台名、格式扩展名、管理器名）。当它是 `constructor` / `valueOf` / `toString` 这类
  `Object.prototype` 继承键时，取到的是继承值而不是兜底，后续 `perManager[manager]` 之类的字段访问
  随即抛错。改法是自有键判定 `_own()`，对表内所有合法键**逐字节等价**。
  这是本会话在 D2 里第 **5** 次命中同一族失效模式（前四次见 `catalog/commandCatalog/README.md`）。
  → `B27-F1 回归：继承键不再写穿兜底，pickExtractor 安全返回 null 而不是抛`、
  `B27-F1 回归：detectPackageManager 对畸形 platform 走 linux 兜底，绝不抛`
- **B27-F2（`stringHarvester.js`）**：`secret` 分类器的前导 `\b` 曾套在整个交替外面，而
  `-----BEGIN` 只出现在串首或非词字符之后——那里没有词边界，PEM 支**从未命中过**；同时
  `[A-Z ]+` 至少吃一个字符，连无算法名的 PKCS#8（`-----BEGIN PRIVATE KEY-----`）也漏。
  词边界逐支下沉、量词放宽为 `*`。两处改动各钉一根测试线（RSA 形钉 `\b`，PKCS#8 形钉量词），
  并确认公钥/证书不被顺手捞进「秘密」，指控面没有扩大。
  → `B27-F2 回归：PEM 支不再被整组前导 \b 挡死，且无算法名的 PKCS#8 也命中`

## 已知边界（现状，**未**由本单元改动）

同一族继承键失效在本单元还有三处**潜在**命中点，实测均**流水线内不可达**（上游给出的是封闭集合），
但函数都已导出、可直接调用，故如实钉住并登记，不自作主张改写：

- `reconstructionPort._inferLanguageDeterministic` 的 `FAMILY_LANG[pack.family]`：scanner 可能给出的
  家族全集 = FORMATS ∪ EMBEDDED_MARKERS 共 13 个，再加签名未命中时的默认 `'unknown'` = 14 个，均非原型键；
  直接传 `'constructor'` 会得到一份 `language/toolchain` 皆 undefined 而 `confidence` 仍 0.4 的**伪报告**。
  → `家族表是普通对象字面量：非封闭家族名会命中原型链（已知边界，如实钉住）`
- `toolOrchestrator.orchestrate` 的 `PLANS[family] || []`：未知家族返回空表不抛，但家族名命中原型键时
  `.map` 直接抛 TypeError。
  → `probe 对未知家族返回空表（不抛），家族名命中原型键才暴露已知边界`
- `artifactScanner._RANK` 的同款取值（`_isStrongerRecoverability` 方向安全：命不中即判「不更强」，
  只会少升级不会误升级）。
  → `_isStrongerRecoverability 按 source>bytecode>native>archive>unknown，同档不算更强`

其余边界是**设计取舍或上游行为**，非缺陷：

- 大端 ELF 的 `e_machine` 仍按小端读，架构名会错（`endian` 字段是对的）；fat/universal Mach-O 的
  位宽退化为 32。两者都只影响 `arch` 展示，不影响档位与还原。
  → `ELF 大端：endian 认对但 e_machine 仍按小端读（已登记的已知边界）`、
  `fat/universal Mach-O（cafebabe + 小 nfat_arch）判成 macho，位宽按头退化为 32`
- `node-stream-zip` 在**打开阶段**就拒绝穿越条目，因此 `_recoverZip` 里的逐条 `skipped++` 护栏对 zip
  永远走不到：一个恶意条目会让**整包**还原失败（fail-closed），而不是跳过它继续还原其余成员。
  → `上游 node-stream-zip 先拒穿越条目：整包 fail-closed，逐条 skip 分支对 zip 不可达`
- `fidelity` 与 `verdict` 不是同一把尺：清单没登记产物哈希时 `artifactHashMatch=null`，分数退化为
  纯覆盖（半分制），判级却仍走「覆盖 ≥0.6 或哈希一致」那道门——于是 50 分覆盖判 `mismatch` 而 60 分判
  `partial`。算术如实钉住，不做静默对齐。
  → `verify 的算术：哈希一致占 50 分，覆盖占 50 分；无哈希基线时只按覆盖给分`
- `genericExtractor` 的两个真实抽取驱动（`extractWith` / `listWith`）在单测里只验**形状与 fail-closed**，
  没有真跑子进程——本机没装 7z/bsdtar/unar。装齐之后这两条路径才有端到端覆盖。
  → `extractWith 对没有 argv 构造的驱动如实返回，不启动任何子进程`
- `harvest()` 对非 Buffer 入参返回的 `classified` 是**空形状**（五个键都在但值为空），与正常路径同形；
  但 `samples/total` 等字段缺席。调用方不要假设两条路径对象键集合相同。
  → `harvest 对非 Buffer 入参降级为空对象，且 classified 是空形状（与正常路径不同）`
- `_run` 把「工具不存在」归因成 `exit ENOENT` 文案，语义上那是启动失败而非退出码——不影响降级，
  但读证据时要知道。→ `_run 永不 reject：成功取 stdout，缺失工具归因到 reason`

## 测试怎么跑

```bash
cd services/backend/src/services/domain/data/reverseEngineer
node --test *.test.js
```

164 例、0 skip。其中 `sourceRecoverer.test.js` 自带一个手搓 store-ZIP 夹具（含 `zlib.crc32`），
不依赖外部 zip 工具；`toolOrchestrator.test.js` 在 require 前替换 `platformUtils.searchExecutable`
（该模块在加载时解构了这个函数，事后打补丁无效），因此本机有没有反编译器都能跑。

单元外还有三份消费本单元的测试，方言不同，**必须分开看**：

- `tests/services/reverseEngineer/reverseEngineer.test.js` —— node:test，45 例全绿。
- `tests/services/reverseEngineer/asarArchive.test.js` —— jest 方言，本便携环境未装 jest
  （`node_modules/.bin/jest` 是悬空 shim），`node --test` 会在加载期 `ReferenceError: describe is not defined`。
- `tests/tools/unpackGeneric.test.js` —— 同上 jest 方言，加载期 `ReferenceError: beforeAll is not defined`。

后两份已用一次性方言垫片复跑核实：asarArchive **6 例全过**，unpackGeneric **7 过 1 skip**
（skip 的那条要求本机真有 `7z`，本机器没有——如实 skip，不是假绿）。「跑不了」不等于「红」；
这两条结论是**实测**得出，不是按方言名推断的。
