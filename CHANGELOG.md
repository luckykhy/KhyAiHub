# Changelog

All notable changes to khy OS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.2

khy OS 1.2.2:开发态批次收口——思维链与工具执行在三端成块可读、分发仓迁到 KhyAiHub、文档主张首次变成可机检的事实。

### Highlights

- **思维链从拍平正文里分离出来单独折叠**（TUI / 桌面 / 安卓三端）：此前 `thinking` 混在拍平后的 `content` 字符串里，读起来是一段没有归属的正文；现走独立字段与独立折叠块，流式段可收展（`apps/khyos-desktop` 的 `ThinkingBlock` + 渲染层数据链路）。
- **工具执行按提问归属，不再浮在会话顶端**（`apps/khyos-desktop/src/renderer/`）：执行面板挂到产生它的那条回复下面，切会话即清；顺带修掉 `.khy-content-col` 注释里 `mt-*/my-*` 的 `*/` 提前闭合——lightningcss 只报一条 `Delim('*')` 警告，整条 860px 居中列被静默丢弃。
- **结构化工具执行输出**（后端 sink + Ink 面板）：单例 sink、面板与高度账本接线；D2 数据模型与 S3 渲染层以封闭集合取代 `satisfies`，三区次序成闸。
- **分发仓迁到 KhyAiHub**：`luckykhy/khy_os` 删除后，新增 `scripts/release/sync-dist.js` 逐笔追加本地提交并校验出链树的树哈希，同步点记 `DIST-SYNC.json`；`sync-gitee` 改用 `checkout`，此前写法只对公开仓成立、私有仓从未走到推送。
- **文档主张可机检**（DOCS-005 / DOCS-006 / DOCS-007）：漂移观察者、内容级主张校验、数值主张校验三条守卫落地，DOCS-006 扫描提速 16 倍；另修 7 处守卫假绿（SSOT 路径 / 缺失 `node:test` / 迁移路径 / Python 实探）与两处失效守卫（恒红的 must 级发布门、零覆盖的索引检查），`pr-gate` 接入 gift-guards 硬门（后端 164 例 + 脚本 206 例）。
- **后端实现补齐**：backend-services 12 批、backend-cli 2 批回归主线；收掉 `src` 套件既有红（jest 全局桥 / Windows PATH / 手机工具基线 / 文档夹具），补回送别礼收口的三处实现漂移（波次分隔符 / 指令登记 / 休眠标注）。
- **安全收敛**：微信通道三处外发与准入收紧（事故根因修复）；移除入库的 `.env.tmp`，补生产弱密钥守卫与暂存密钥扫描。
- **便携与构建**：`repair-junctions.ps1` 修根目录 7 个受控目录联接；Docker 构建上下文再排 4.4G Flutter 产物并新增 dockerignore 契约守卫；桌面端加单实例锁，重复点图标不再起第二个实例。
- **仓库卫生**：16 个一次性残留解除跟踪并接入卫生守卫；布局巡检第 30–39 节把根 census 从 66 压到 52，并逐名归因。

### Compatibility

- 安装 / 升级:`pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`;`khy --version` 应报告 `1.2.2`。

---
## Unreleased

### Fixed

- **Ollama 端口与后端端口不再散落各处**（`src/constants/serviceDefaults.js`、`src/services/ollamaModelManager.js`、`src/services/domain/deploy/publish/bundleArtifacts.js`、`delivery/extension/scripts/khy-diagnostics/model-type-providers.js`、`delivery/extension/tools/khy-markdown/khyos-md-bridge.js`）：Ollama 端口此前只以 URL 片段藏在 `OLLAMA_HOST` 里，消费方要写「URL 没带端口时用哪个端口」只能把 `11434` 再抄一遍（后端 `ollamaModelManager.js` 两处、诊断脚本正则一处、跨层工具一处）；部署模板生成的 compose 文本把容器端口写死 `3000`。现：端口提为 `DEFAULT_OLLAMA_PORT` 并由 `OLLAMA_HOST` 派生，消费方一律引用；compose 模板的容器端口改用 `${BACKEND_PORT}`；跨层工具（不能跨层 require 后端常量）具名化为 `OLLAMA_DEFAULT_PORT` 并登记为**授权镜像**，由守卫强制与后端端口锁步 —— 端口一变就红，而不是让用户对着一个连不上的地址发问。
- **守护进程与管理服务的端口口径合一**（`src/services/daemonEntry.js`、`src/services/daemonManager.js`、`src/services/aiManagementServer.js`、`src/cli/handlers/mobile.js`、`src/cli/handlers/gatewayManageDaemon.js`、`src/cli/handlers/daemon.js`、`scripts/start-mgmt-server.js`、`scripts/ai-manage-daemon.js`、`src/services/domain/network/amoo/amooBridgeConfig.js`）：这九处各自写死了 AI 后端端口 `9090` 与手机桥端口 `8896`，而真源在 `src/constants/serviceDefaults.js` —— **同一份数据九份副本**，改一处即漂移（`ai-manage-daemon.js` 那份更在活跃启动路径 `parsePortArg(argv, '--api-port', DEFAULT_API_PORT)` 上）。现全部改为从真源取值。**口径有变、需知情**：守护进程读 `KHY_DAEMON_PORT`、管理服务读 `AI_MGMT_PORT`，而**守护进程跑的就是管理服务**（`daemonEntry.js` 头部自述）；改前设了 `KHY_DAEMON_PORT=29090` 而没设 `AI_MGMT_PORT` 时，守护进程监听 29090、管理服务自己的兜底仍是 9090 —— **同一台服务器有两个端口口径**；改后两者统一取 `AI_BACKEND_DEFAULT_PORT`。这不是顺手重构，是把一处潜在矛盾收敛掉。回归：`npm run test:node:src` 6941 测试全绿，`serviceDefaults` / `daemonManager.runtimePort` / `mobilePairingContract` / `daemon.handler` 四个 jest 套件 26 测试全绿。
- **守护进程 CLI 的测试期望停在旧英文文案**（`tests/cli/daemon.handler.test.js`）：生产代码的启动/重启提示在 HEAD 里已是中文（`守护进程已启动（PID …，端口 …）`），测试却还断言英文 `Daemon started (PID …)` —— **该字符串在生产代码里 0 命中**，断言从落地起就没对过。期望串按当前生产文案改正（端口值 9093/9094/9090 一字未动）。属既存红，与本次端口归并无关，但「红着的门等于没有门」，故一并修掉。
- **OpenCode Zen 指纹不再「每次重启换新设备」**（`services/zenIdentity.js`、`services/zenGatekeeper.js`）：实测 2026-10-24 对 `opencode.ai/zen/v1` 确认上游免费层**按出口 IP 计配额**、并**按 IP 判信誉**（本机 IP + 合法 UA 直连 → 429 `FreeUsageLimitError`;共享代理 IP → 403 `abusive traffic from this IP address`;非 opencode UA → 403 `FreeTierError`）。旧实现的 `x-opencode-session` / `x-opencode-project` 是**进程级随机**——khy-os 每重启一次就是一个「新设备」，与固定 IP 组合正是上游反滥用模型里最像批量刷量的形态;多用户共用一个服务端 IP 时更糟:一个 IP 的配额被所有人吃干 → 全员 429 → 再全员被封。现改为**每机一份、跨重启稳定**的机器码:从 `KHY_MACHINE_ID`（否则 hostname）确定性派生、落盘 `<dataHome>/zen_identity.json`——**在哪台机器上允许，就在那台机器上用它的机器码**。env 显式覆盖优先（`KHY_ZEN_SESSION_ID` / `KHY_ZEN_PROJECT_ID`）;门 `KHY_ZEN_IDENTITY`（默认开，0/false/off/no 关 → 逐字节回退旧的进程级随机行为）。fail-soft（叶子缺失/异常 → 回退旧行为）。实测跨「重启」两次取值完全一致。
- **OpenCode Zen 免费模型清单同步至 2026-10-24 实测上游目录**（`services/freeModelChannels.js`、`services/gateway/builtinProviderConfig.js`、`tests/services/opencodeFreeChannels.test.js`）：新增 `flint-40b-free`、`jev-1.13-free`（10-21 曾下线、10-24 上游已恢复）;剔除 `minimax-m3.1-flash-free`、`longcat-2.5-preview-free`、`nemotron-3-ultra-free`（上游目录已收）。**目录里「消失」的 id 不写进废弃台账**——`jev-1.13-free` 10-21 下线、10-24 回来即证:记成永久废弃会把还能用的模型藏起来。`beam-free` 上游仍在目录但实测 403 地区封锁，属**换出口 IP 可解**类（台账 `region` 短 TTL 语义），这正是走本机直连的价值所在。契约测试 `ZEN_CATALOG` / `ZEN_RETIRED_KNOWN` 同步更新，并把身份相关 env 键纳入沙箱隔离（身份不再落到真实数据目录）。

- **opencode 配置解析修复**（`services/domain/network/externalApps/opencodeAdapter.js`）：`_portableConfigPath()` 硬编码 5 级上溯在布局迁移（`services/backend/src/...` → `runtime/node/backend/src/...`）后静默错位，指向无效路径（靠 XDG 兜底才未暴露）；改为上溯 `.portable` 标记定位 khy-os 根，与布局深度无关。`configPath()` 候选顺序改为 **XDG 优先于便携 Tools/config**：镜像 opencode 自身的 XDG 解析，保证 khy 读写与进程启动读取同一文件（当前生效配置为 `Tools\opencode\xdg\opencode\opencode.json`，经用户级 `XDG_CONFIG_HOME` 生效；`~/.config` 下是历史遗留副本）。

- **补丁 / 编辑类工具的路径围栏与原子写**（`src/tools/ApplyPatchTool/`、`FileEditTool/`、`FileWriteTool/`、`MultiEditTool/`、`src/tools/editFile.js`）：越出项目根的路径被围栏挡住，写入改成 tmp + rename（失败不留半截文件），`--- ` 开头的歧义与畸形 hunk 被拦下。`editFile` 的空串匹配曾会**死循环占满 CPU 核**（`indexOf('')` 永不返回 -1）；`isStale()` 返回对象却被当布尔用，于是每次编辑都被判成「文件已变」而拒绝。
- **工具注册表自愈分支的自由变量**（`src/tools/index.js`）：`_requireWithHeal` 里 `dir.name` 应为 `dirName` —— 自愈分支一触发就是 ReferenceError。
- **手机端 shell 的命令注入面**（`MainActivity.kt`）：`shell` 通道遇 shell 控制符（`;` `&` `|` `` ` `` `>` `<` 换行 `$(`）整体拒绝并给出可操作文案；stdout/stderr 并发抽干（原来只抽一支，另一支能把进程堵死），超时真正生效；线程池由无界缓存改为固定 4 线程。
- **Web 客户端应用页整体失效**（`delivery/web/ai-frontend/src/api/clientApps.js`）：解包逻辑与其它接口不一致，页面拿不到数据。
- **桌面端 `models:list` 的 45 秒超时**（`apps/khyos-desktop/src/main/index.ts`）：15 秒不够跑完首轮模型目录，冷启动直接报错。
- **八道守卫自身的失效**（`scripts/ci/`）：Vue 分区判定（嵌套插槽模板不再误关外层，模板行识别 11451 → 24654）、git 中文路径（`core.quotePath=false`，否则中文名令牌真源永远不在改动集里）、委派 G1 判据改为「看代码不看文本」（一句注释就能满足的旧判据已废）、原子能力的 `--changed` 改为暂存/未暂存/未跟踪的并集、`check-repo-layout` 的 scope 缺失判红、源码程序量的 vendor 目录排除、provenance 台账的过期条目与 `knownGaps` 字段名不一致 —— **红着的门等于没有门**。
- **仓库根的影子数据目录**（CLAUDE.md §二 B8）：脚本探针与桌面端接线测试曾在仓库根留下 `.khyos` / `.khy`，`root-shadow-dir` 因此判红；探针现在清理自己新建的目录，桌面端接线测试把数据家钉到临时目录。
- **委派边界守卫的引号盲区**（`scripts/ci/check-delegation-boundary.js`）：判据只认单引号，把同一个赋值写成双引号或模板字符串就能绕过 —— 三种引号形态现在都判，且用 `stripComments` 取代「按行首跳过注释」（块注释里夹代码照样能过）。
- **手机桥的复制额度**（`delivery/mobile/.../bridge/Tools.java`）：`cp` 的事前预估按 1 个文件算，而一次 `cp` 能复制整棵树（上限 50），本轮 50 个文件的额度因此能被用到 95。额度现在按「本轮剩余」估，复制本身也按剩余停，剩 3 个就拷 3 个并报截断。
- **手机端安装 APK 的并发覆盖**（`MainActivity.kt`）：暂存名固定为 `khyos-install.apk`，并发安装会互相覆盖 —— A 装上了 B 的包而且不报错，A 的收尾还会删掉 B 正在用的文件。暂存名改为每次唯一。
- **Flutter 通道把「前置拒绝」报成「已有提问在进行中」**（`MainActivity.kt` + `amoo_chat_service.dart`）：无障碍服务没开时，桥侧已给出真实原因，通道侧却塌成单飞 —— 现场根本没有任务在跑，调用方白等整个预算。

### Changed

- **OpenCode Zen 免费模型清单同步至 2026-10-21 实测上游目录**（`services/freeModelChannels.js`、`services/gateway/builtinProviderConfig.js`）：新增 `big-pickle`、`minimax-m3.1-flash-free`、`glm-5.3-flash-free`、`deepseek-v4.1-flash-free`、`longcat-2.5-preview-free`、`nemotron-3.5-lightning-free`、`nemotron-3.5-super-vl-free`、`beam-free`；剔除已废弃的 `mimo-v2.5-free` / `deepseek-v4-flash-free`（上游 401）、`ling-3.0-flash-fin-free`（不可用）、`jev-1.13-free`（已不在目录）。`builtinProviderConfig` 的清单同时作为 `PROXY_MODEL_ROUTE_MAP` 路由种子，网关侧现可路由全部 10 个免费模型。
- **免费渠道发现层接入废弃台账过滤（自愈兜底）**（`services/freeModelChannels.js`、`services/gateway/builtinProviderConfig.js`）：两处静态清单的 opencode-zen 条目现经 `zenRetiredModels` 台账过滤（`isRetired`），上游后续废弃的 id 在 markRetired 补录后自动从发现层/Key 池视图消失，不再"选中才在调用时炸"。门 `KHY_ZEN_RETIRED_FILTER`（默认开，0/false/off/no 关 → 逐字节回退不过滤）；fail-soft（台账缺失/异常 → 不过滤）；与既有 `_withGlmLatest` 叠加模式同构，不改共享描述符。网关侧 `zenGatekeeper.filterFreeZenModels` 本就有同样过滤，三处消费面至此同源。

- **`init.js` 拆分，god-file 门达标**（`src/cli/handlers/init.js` 3106 → 2330 行，拆出 `initDoctorProbes.js` 与 `initClaudeSettings.js`，函数体逐字节不变）：单文件不得新增超过 2500 行（`KHY_ARCH_GOD_FILE_LOC`）。
- **危险命令底线下沉到工具层**（`delivery/mobile/.../bridge/Tools.java` + `LoopModes.java`）：`rm -rf /`、`mkfs`、`dd if=`、`reboot`、`pm uninstall` 这类命令在**桥的工具层**就拒 —— Amoo 循环、HTTP `/call`、文件信箱三条入口一次覆盖（此前只有 Amoo 路径有模式语义，另两条入口是裸奔的）。
- **手机端 `rm` 默认不递归**（`delivery/mobile/.../bridge/Tools.java`）：`{"tool":"rm","args":{"path":"/sdcard/DCIM"}}` 现在只删文件本身，删整棵树必须显式 `recursive:true` —— 原默认 true 时，一次误调用就是整棵目录树消失。PC 侧策略同步要求 rm 走确认。
- **Windows 启动器的环境契约改为单文件共享**（`khy-env.bat`）：启动器、快捷入口、便携入口共用同一份 16 个 `KHY_*` 变量，止住数据家分叉；缺这份契约时启动器**明确报错退出**，不再静默地带着半残环境跑起来（`call` 缺文件只打印一行错误就继续，是它最危险的形态）。

### Added

- **数据事实「单一真源」守卫**（`scripts/ci/check-ssot-data.js` + `scripts/lib/ssotDataGuard.js` + `docs/10_规范/registry/DATA-SSOT.json`，规则 `LAYOUT-008`，判据真源 `[DESIGN-LAY-009]`）：同一份数据写在两个地方时，两处**一开始相同**；改了一处，另一处就成了**矛盾** —— 这类漂移的特点是**没有任何一个文件是错的**，只有「两个文件对同一件事说法不同」，所以守卫不问「这个文件对不对」，只问「**这件事有几处声明**」。四层判据：真源之外的再声明判**影子副本**（warning）、同一事实出现两个值判**值矛盾**（error）、已登记的**授权镜像**与真源不一致判**镜像失步**（error）、真源被逐字节复制判**整文件副本**（error）；真源/指针/镜像取不到时**一律报红**（判据失效时报「通过」等于假绿）；另加**作用域可达性**检查——事实的 `detect.paths` 指向不存在的路径时，该事实永远 0 finding（事实在册、判据在跑、结果恒为零，看着全绿实则没在看），守卫核到不可达即报 `ssot-scope-missing`（变异测试验证：把作用域指向不存在目录，守卫立刻报红而其余五类计数仍为 0）。另有**值锚定补网**兜住标识符锚点的结构性盲区（新别名换个变量名再写一遍，标识符锚点看不见）—— 只认**代码里的裸字面量**，`const X = 9090` 判、帮助文本与案例库里的 `'…9090…'` 不判（是叙述不是声明）；且只对区分度够的值（≥100）启用（实测值 10 会捞出 242 条噪声）。登记表只登记**真源在哪、怎么取、谁是授权镜像**，**不登记值本身** —— 登记表若也存一份值，它自己就成了第二真源。首轮实测命中 **11 处同包影子副本** + **1 处真源自相矛盾**（规则登记表 `meta.ruleCount` 声明 96 而实有 99）；补网又查出 **5 处**此前看不见的别名与示例副本；登记新事实（Ollama 端口 / 后端端口）后再查出 **6 处**；累计 **22 处 / 15 个文件**已全部归并为「从真源取值」，现复跑为**影子副本 0 / 矛盾 0 / 失步 0 / 整文件副本 0**。阶段 S1 观察者（只记录不阻断），已接进 PR gate；扫描耗时约 9 秒（**一次** `git grep` 同时定位含标识符与含可区分值的候选文件，避免首版逐事实全仓扫描的 87.7 秒，也避免 7 轮 grep 的 30 秒）。
- **手机端日志规范与按天日志查看**（`delivery/mobile/khy-os-client-app`，规范真源 `docs/10_规范/其它规范/[DESIGN-LOG-002] 手机端日志规范.md`）：APK 内「设置 → 诊断工具 → 日志查看」改为**按天查看**——天列表给出哪天有几个错误，详情页**错误优先**（错误码、上下文、原始异常、堆栈同屏），另有级别筛选与关键词搜索；日志按天分文件落盘（JSONL，保留 14 天），error/fatal 额外写错误投影文件，**跨重启仍可按天检索**；未捕获异常（FlutterError / 异步错误 / Zone 错误）一律落盘（错误码 E601），崩了不留证据等于没崩；导出改为**自足分析包**（版本 + 平台 + 错误码总览 + 错误明细 + 当日日志），复制到剪贴板即可直接粘给研发智能体。错误码新增 E6xx 客户端段。判据由 `test/log_store_test.dart`（12 用例）承载。
- **opencode 免费渠道契约测试**（`tests/services/opencodeFreeChannels.test.js`，18 用例，node:test，全 env 注入确定性）：锁定发现层/Key 池清单与过滤（A/B）、`configPath` 解析矩阵与 adapter 全契约（C）、v2 CLI `run --model` 调用形状（D）、台账判定与上游错误分类（E）、网关侧同台账集成点（F）。回归基线：存量 9 相关套件与 stash 对照零新增失败（6 个存量失败编号逐一相同）。任务记录 PROGRESS.json T-030，证据 `.khy/feedback/T-030-opencode-free-channel-stability/`。
- **OpenCode Zen 每机持久身份叶子**（`runtime/node/backend/src/services/zenIdentity.js`，`src/services/zenIdentity.test.js` 8 用例，node:test）：提供「每机一份、跨重启稳定」的机器码（session id 沿用 opencode `Identifier.create` 形态 `ses_<12 hex><14 base62>`，project uuid 为 v4 形态），落盘 `<dataHome>/zen_identity.json`;env 覆盖 `KHY_ZEN_IDENTITY_FILE`（对齐 `KHY_ZEN_RETIRED_FILE` 约定）、`KHY_ZEN_SESSION_ID`、`KHY_ZEN_PROJECT_ID`;门 `KHY_ZEN_IDENTITY` 默认开、关 → 逐字节回退旧行为。判据覆盖:同机恒定、跨重启稳定、异机不撞号、env 优先、形态合法、与 `zenGatekeeper` 集成一致、门关回退。

- **Amoo 反代：把手机上的 Amoo 当后端模型用**（`delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/` 新增 16 个 Java 模块 —— `AmooLoop` / `AmooProtocol` / `AmooSafe` / `AmooSelfDesc` / `AmooMemory` / `AmooChatText` / `LoopModes` / `LoopState` / `LoopVerify` / `HttpBridge` / `BridgeService` / `BridgeOverlayService` / `BridgeToken` / `ShellSidecarClient` / `BootReceiver` / `ReviveReceiver`；Dart 侧 `lib/core/agent/`、`lib/ui/widgets/amoo_task_card.dart`；后端 `src/tools/AmooBridgeTool/`、`src/cli/handlers/amoo.js`）：三步协议 `ask` → `askResult` → `stop`，每次提问前置两层前言（自描述 + 已核实事实的共享记忆），安全底由 `LoopModes.decide` 统一裁决，出口经 `AmooSafe` 净化。提问事实写 `amoo_turn` SQLite —— 进程重启后仍能报出「提问被中断」，而不是静默丢失。
- **手机端可被 PC 主动调用的桥接面**（`src/cli/handlers/phone.js` + `src/services/domain/network/phone/`；`src/cli/handlers/stepneo.js` + `src/services/domain/network/stepneoCloud/`）：`khy phone` 从 PC 侧调用手机上的 StepBridge（adb / HTTP / 文件信箱三条通路）；`khy stepneo` 跑一轮「云端模型 + 手机工具」的智能体回合。两者都是薄壳 —— 解析在纯叶子、IO 在 client，host/port/密钥字面量一律来自 env 可覆盖的 config。
- **外部智能体委派准入门**（`src/services/gateway/delegationGate.js` + `src/services/externalAgentDirective.js`）：把渠道切给 claude / codex / opencode 之前必须先过闸，默认策略 `ask`、兜底 `deny`，auto 档不豁免本闸。三条可委派面统一收敛到 `decideExternalDelegation()`；G1 凭据改用运行时票券（`services/delegationTicket`）而非模型自述文本。
- **延迟工具的召回词表**（`src/services/tool/deferredRecallIndex.js`）：registry 里 36 个默认从定义里过滤掉的延迟工具，现在以「召回词表」的形式注入系统提示，而不是只给一串裸名 —— 工具发现成本里「召回不到」那一块由此补上。
- **CC 模式的手机联动与参数面板**（`src/cli/tui/ink-components/CcPhoneLinkPanel.js` / `CcNoticeBlock.js` / `ParamPanel.js` + `src/cli/tui/hooks/usePhoneLinkStatus.js` + `src/cli/tui/utils/ccNoticeLines.js`）。
- **桌面端 amoon 面板、品牌标记与查看器**（`apps/khyos-desktop/src/renderer/components/amoon/`、`viewer/`、`ui/BrandMark.tsx`、`ui/Skeleton.tsx`、`shared/usageChartMath.ts`）与 **Web 品牌资产**（`delivery/web/ai-frontend/public/brand/`、`favicon.svg`、`src/components/KhyMark.vue`、`KhyAuraBackground.vue`、`src/webgl/`）。
- **机器身份下沉到共享底座**（`src/utils/machineIdentity.js`）：机器身份是跨层共用原语 —— `cli/hqStore` 的多机协作租约与 `services/zenIdentity` 的身份派生现在取同一份值链，不再让 services 反向 require cli（分层倒置）。
- **模型可用性判定与自定义 provider 校验**（`src/services/gateway/modelOperationality.js`、`modelEntryCollection.js`、`customProviderVerify.js`）：判定口径与校验形态各归一处，不再散在调用面。
- **单元级 README 与生命周期记录**（11 份 `khy.module.json` + 10 份单元 README）：每个功能单元说清「谁要 / 为什么 / 怎么验」。
- **源码金丝雀与 APK 分发溯源标记**（设计真源 `[DESIGN-ARCH-199]`；工具 `scripts/release/canary-mark.js` + 台账 `scripts/release/canary-manifest.json` + `works/data/khy/canary/ledger.jsonl`，打标面含 `delivery/mobile/khy-os-client-app/` 与 `runtime/node/backend/src/`，构建接线 `scripts/release/build-android.ps1`、`android/app/build.gradle` 等 12 文件）：软著未批而 APK 已被解包抄袭→双层标记：层 1 源码注释信封 `khy-canary: Khy-<批次>-<序号>-<随机段>` 打 T1 移动端 134 文件（可标全量：在册原始池 135 减 1 个生成物 project_profile.g.dart）+ T2 后端 cap 120（在册池 954→cap，COPYRIGHT-MATERIALS 21 候选运行时排除），清单逐文件记 sha256；层 2 APK 逐接收人唯一值 `Khy-1.1.17+2-<yyyyMMddHHmm>-<随机段>` 经 canary.properties（防 Gradle daemon env 固化）/resValue/manifest placeholder/cmake 宏/--dart-define 落 arsc、binary manifest、dex、libkhyjs.so 多面（资源收缩靠 placeholder 字面值+resValue+keep.xml 三件套存活——aapt2 实测 `@string` 引用不内联）；`stamp --plan/--undo`（beforeSha256 安全阀，dirty 工作区可精确撤销）、`verify`、`report` 三子命令；**纯取证零拦截**——不挂 git hook、不进 CI、不新增 npm script 与 khy 命令、verify/report 恒 exit 0、不触发 `PROCESS-008` 升阶。实测：T1/T2 池计数复现（T1 原始 135→可标 134、T2 原始 954，`*.g.dart` 生成物按排除类③扣除；verify 254 条全 ok）、amoo 冻结表基线 26/26/0 error（打标经文本锚点重同步保持 0 error）、设计文档 §十一 留痕；gradle 资源收缩端到端与 flutter 出包未实测，按「会坏」处理并落 keep.xml 兜底与出包五面抽查门槛。2026-11-02 扩 T3 桌面层：`apps/khyos-desktop/src/` 103 文件入批次 20261102（electron-vite main/preload 包不压缩、注释随 asar 发行——桌面源码层即发行层；桌面 typecheck 基线按 file|line|code 重锚定；amoo 冻结表与桌面池零交集），verify 357 条全 ok。

## 1.2.1

khy OS 1.2.1:开发态/发布态双态版本管理落地——AI 迭代期版本号自动随工作批次递增，小版本/大版本递增改由人批准，并补上「该换版本号了」的提示。

### Highlights

- **新增 `scripts/release/version-mode.js`**：`status` / `bump` / `release` / `back` / `dev`
  五个子命令，全部支持 `--dry-run`。版本字段始终纯数字（`v` 只属于 tag），
  「切换为 v1」是打 tag 而非改字段格式，因此守卫 `isSemver` 一行未改。
  bump 会同步 G1 四源并复用 `changelog-new.js` 的 `insertStub` 插 CHANGELOG 段。
- **软著登记版本 V1.2.0 → V1.0.0**（人明示，决策记录 D-版1）：与计划中的首次正式
  发布号对齐。登记版本与工程版本不互相绑定——005 §九 要求的是「申请表与鉴别材料
  页眉」这两份申报材料之间一致，不是要跟工程版本对上。
- **自更新源不再写死已删除的公共仓**：`luckykhy/khy_os` 删除后，`serviceDefaults.js`
  三个 GitHub 默认值全部 404。改为空串 + 未配置时明确报「未配置更新源」，
  不再拼出 `https://api.github.com/repos//releases` 把配置问题报成协议问题。
- **MINOR/MAJOR 递增必须由人批准**（R-2a / AGENTS.md / CLAUDE.md B7）：AI 不得自行
  决定小版本或大版本递增，须先说明判据、影响面与建议递增位。三层执行面——
  `version-mode.js --approved-by`、`pre-commit` 的 `check-version-bump-approval.js`
  （比对暂存区+工作区与 HEAD，堵住绕过脚本私改版本号的路）、`pr-gate.yml`。
- **「该换版本号了」提示器**：`check-version-freshness.js` + 新增 `pre-push` 钩子。
  判据机械不猜语义——开发态下距上次 bump 已有提交就提示。恒不阻断推送。
  首次运行即暴露本仓积压 46 个提交未 bump，本版即为该提示的直接产出。
- **清掉全仓 `.ai/` 死指针**：8 份由 `khy metadata link` 生成、指针块停在旧路径的
  文件按 `metadataPointers._pointerBody()` 逐字节重生成；另修 2 处代码里的同类死指针。

### Compatibility

- 安装 / 升级:`pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`;`khy --version` 应报告 `1.2.1`。
- 自更新：默认不再内嵌任何仓名。部署侧需设 `KHY_UPDATE_GITHUB_REPOSITORY` 或
  `KHY_UPDATE_GITHUB_RELEASES_API`；未设置时 `khy` 明确报「未配置更新源」而不再
  给一个三个月前的错版本（原默认仓唯一 release 是 v1.1.8 / 2026-07-26）。

---
## 1.2.0

> 修复记录：`BUG-014` ｜ 设计真源：[`[DESIGN-ARCH-138]`](docs/03_DESIGN_设计/DESIGN-ARCH/%5BDESIGN-ARCH-138%5D%20工具调用能力判定与文本拦截协议.md) ｜ 取证：`.khy/feedback/toolcall-capability-falseneg-20260923/`
> 版本段推导：本次同时含 `### Fixed` 与 `### Added`（新增机制与开关），按 `[DESIGN-SEMVER-002]`「`### Added` → MINOR」定为 MINOR。

### Fixed

- **清理与保留策略度量指向旧数据家空壳（909 B 假读数）**（`services/cleanupService.js`、`cli/handlers/cleanup.js`、`khy.bat`、`registry/DATA-LOCATIONS.json`、`scripts/ci/check-data-layout.js`）
  - **改了什么**：W9′（2026-10-02）把运行态数据迁入 `works/data/khy` 后，cleanupService 的 15 个保留目标里 13 个仍经 `getDataHome()`/`getAppHome()` 解析——启动器 `khy.bat` 把 `KHY_DATA_HOME`/`KHY_PROJECT_DATA_HOME` 钉在 `<root>/.khy` 旧落点上，实测 `khy cleanup --json` 报 totalBytes **909 B**、sessions/checkpoints/audit 全 0、`overThreshold: false`，而真身同目录树 496 MB。现改两级解析（显式 env 优先保测试隔离；否则便携模式跟随 `getProjectDataHome()`），`khy.bat` 三个钉死值对齐 W9′ 落点（`works\data\khy` / `works\data\khyos`），登记表 `roots.khy.accessor` 与 protected/budgets 路径统一到事实。修后同命令 totalBytes **206 MB**、footprint 496 MB / 500 MB，读数与文件系统一致。
  - **为什么**：度量指向空房间时，「所有数据在限额内，无需清理」是一句诚实的谎话——表针存在、读数真实、测错了房间。这正是 `[DESIGN-DELIV-001]` D1「度量必须有一根表针朝外」的反例。
  - **影响范围**：只改「看哪里、报多少」，零删除。新增两个保留目标（原子写孤儿 tmp 24h 回收、空目录 7 天回收，`KHY_EMPTY_DIR_REAP=0` 可关，protected 路径豁免）；`check-data-layout` 增加空目录/杂件/原子写孤儿活体读数与 L-5 棘轮比对（S1 只记录，实测 khyEntries 211→420 恶化已留痕）。`.khy` 旧壳内少量 CLI 侧文件（settings.json 等分叉副本）**未迁移未删除**，属活体数据迁移范畴。

- **工具调用能力判定系统性偏「不支持」**（`services/backend/src/services/gateway/`、`multiFreeService.js`、`relayApiAdapter.js`）
  - **改了什么**：判据此前把「成功回了文字、没回 `tool_calls`」直接判成「不支持原生工具调用」。这三种输入性质完全不同且都不含「不支持」信号——回了散文（纯观测）、被 `max_tokens` 截断、模型自述不会调用工具——却得到同一个负向结论，现场产出 `gpt-4o → text` 这类假阴性。现在**负向裁决要求正面证据**：只有正文里出现显式调用语法（判据复用 `toolCallParser.hasExplicitToolCallSyntax`，不另写正则）才判 `text`；失败、截断、空、散文一律 `unknown` 不落库。截断判定（`finish_reason ∈ {length, max_tokens, max_output_tokens, content_filter}`）**早于**文本判定，否则一段被截断的前言会被读成「回了文字 = 不支持」。
  - **为什么**：判出 `text` 的后果是把该模型的原生 `tools` 从每个后续请求里删掉——删掉之后模型再也拿不到 `tools`、也就再也产生不了原生 `tool_calls`，被动学习无法翻案，一次误判就锁死到 TTL 到期。旧判据没有区分「证据的缺席」与「缺席的证据」。
  - **影响范围**：判定链三处（`toolCallingProbe` 判据、`modelToolingCapability` 两门、`toolCapabilityStore` 缓存）。文本拦截层（教学门 / `toolCallParser` / `toolProtocolAdapter` / `syntheticToolLayer`）与权限门**未改动**——那部分是正确资产。

- **未实测的模型被名字启发开局剥离 `tools`**（`services/backend/src/services/gateway/modelToolingCapability.js`）
  - **改了什么**：`shouldStripUpstreamTools`（wire 侧）改为**只认正面证据**——env 钉子 → 实测 `text`/`native` → 通道拒收 → **其余一律发**。名字启发（`SMALL_MODEL_HINTS`）退出 wire 判定，仅保留在提示词侧（`modelLacksReliableToolCalling`）。两门不再锁步：教学文案是加性的（`_toolCallingFallbackProfile` 标题即 `Tool calling (text-based fallback)`，不断言「你没有原生工具」），且文本调用在两条协议下都会被 `resolveToolCalls` 解析执行，故暂定档有两条成功路径。
  - **为什么**：用户池里带 `-flash`/`-lite` 的模型几乎全部命中名字启发，于是「所有模型都显示不支持工具调用」。未知档的代价是明账：真拒收 `tools` 的通道首次多一个 400 往返，而那一趟正是把通道拒收记下来的对照证据，记下后不再付第二次。

- **env 逃生舱对路由 id 形态失效 + 提示文案指错排障方向**（上述两文件）
  - **改了什么**：`KHY_NATIVE_TOOL_MODELS` / `KHY_TEXT_ONLY_TOOL_MODELS` 改用与实测缓存同一套键（`capabilityModelKey` 规范化），两种写法（裸名 / 路由 id）都认；提示文案收口为 `modelToolingCapability.stripToolsNotice()` 单一真源，两个剥离门不再各持一份字符串。
  - **为什么**：教学门拿到的 model 是路由 id、剥离门拿到的是裸名，只比裸名会让同一条 env 只在一个门上生效——用户设了强制原生，模型却仍被注入「你没有原生工具，请用文本语法」教学。文案旧版写「不支持工具调用…请切换到支持 function calling 的模型」，但工具**仍在通过文本协议正常执行**，把内部判定缺陷说成了用户的环境问题。

- **负向裁决跨适配器扩散**（`gateway/toolCapabilityStore.js`、两处剥离门、`khyUpgradeRuntime.js`、`apiAdapter.js`）
  - **改了什么**：新增 `getVerdictFor(model, {adapter})` 实现**非对称继承**——`native`（正面）全局共享，`text`（负面）只在测出它的那条适配器上生效；来源未知按「适用」处理（向后兼容历史记录）。适配器身份穿线补到 `multiFreeService`（`adapterKey: 'api'`）。
  - **为什么**：剥离门只存在于 relay/api 两条路径，而教学门按 `(adapter, model)` 判；能力档案却只有一个模型名维度。一条通道的负面结论替另一条通道做决定，是 BUG-014 的形态之一。

- **TUI spinner 文案与实际状态脱节**（`cli/tui/ink-components/App.js`、`Spinner.js`、`appHostHelpers.js`）
  - **改了什么**：spinner 的三个数（`stalled` / `elapsedSec` / `tokens`）改走**单一真源** `_spinnerProgress`（纯函数，早已存在且被测试锁着），不再在渲染体里手算；`_spinnerProgress` 补出 `stalledSec`，等待行按规则 2.5 渲染成 `… 等待中 · <目标>（已 Ns）`；`buildSpinnerMeta` 支持跳过重复时长；等待行组装抽成纯函数 `Spinner.buildStallLine` 以便无条件单测。
  - **为什么**：手写副本与 SSOT 漂出三处单位/来源错误——① 毫秒差与字面量 `3` 比较（应为 `3000ms`）⇒ 活跃中几乎恒显「等待中」；② 把 `Date.now()` 当秒数传给 spinner ⇒ meta 渲染出「 · 20719231d」；③ `tokens` 取 `query.tokenEstimate`，而该字段在 TUI 查询层**没有生产者** ⇒ 恒为 0，「~N tok」永不显示。文案要按实际数据渲染，前提是这三个数得真是实际数据。

### Added

- **通道级能力记录与身份**（`gateway/capabilityModelKey.js`、`gateway/toolCapabilityStore.js`）
  - `capabilityModelKey.routeKey()`：`<adapter或provider>::<host>[:port]::<裸模型名>`（不硬编码任何主机名，只解析调用方报上来的 endpoint）。
  - `toolCapabilityStore` 新增 `route:` 前缀分区：与模型级记录同文件、不同命名空间、独立 TTL、不参与模型键迁移。两处 400 降级链在**重试成功之后**才记通道拒收（仅凭「看到 400 且当时带着 tools」会把归因搞错）。
- **工具调用的隔离式挑战**（`services/backend/src/services/gateway/toolChallengeCadence.js`，新开关 `KHY_TOOL_CAP_CHALLENGE`（默认开）+ `KHY_TOOL_CAP_CHALLENGE_EVERY`（默认 10））
  - 按 `(通道 × 模型)` 计请求，每 N 次放行一次原生尝试（照发 `tools`），让被判 `text` 的模型有机会用原生调用当场翻案，不必等 7 天 TTL。单边实现（只跳过剥离、不动提示词）。通道已被判拒收时不挑战、env 钉子连挑战轮也不越过——两条由判据层强制。
  - 机制已按 `[DESIGN-PROCESS-002]` 登记进 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（stage S1）。
- **探测对照组**（`gateway/aiGatewayModelMethods.js`、`gateway/toolCallingProbe.js`）
  - 主组失败时补一次「同提示词、不带 tools」的请求：A 败 B 成 → `route-rejects-tools`（通道拒绝 `tools`，属通道属性、不按模型键落库）。探测 `maxTokens` 64 → 256，提示词要求不要前言（前言会吃光输出预算，把「没来得及生成」伪装成「没有调用」）。
- **排障入口**：`khy gateway probe-tools list` 新增第三组「通道拒收 tools」，与模型级两组分开显示（一个要换通道/查端点，一个要换模型）。

### 测试

- 新增 `toolCapabilityFalsenegRegression.test.js`（四条病灶各自钉成断言）、`toolCallParser.explicitSyntax.test.js`（14 例，含「显式判据 ⊆ 解析器」防方言漂移）、`toolChallengeCadence.test.js`。
- 受影响面复核：`node --test` 286/286、`jest` 155/155。

## 1.1.14

### Added

- **TUI 区域划分 SSOT**（`services/backend/src/cli/tui/ink-components/regionLayout.js`）
  - 新建区域划分单一真源文件，定义 25 个区域 ID（9 顶层 + 6 大区 + 10 小区），三层层级结构。
  - 大区值是小区值的前缀（`main.output` → `main.output.hdr`），层级可推导，测试断言锁住。
  - 覆盖层注册表 `OWNING_OVERLAYS` 集中声明 6 个独占输入覆盖层，`hideChrome` 字段决定是否隐藏 PROMPT/FOOTER。
  - 几何契约 `sidebarTopAnchorRows()` / `railCols()` 作为跨区域顶对齐 / 栏宽的单一真源。
  - 主区最小高度 `MAIN_MIN_HEIGHT = 6`，内容不足时用空行填充，确保主区始终有可读的最低高度。
  - 契约测试 `tests/cli/tui/regionLayout.test.js`（20 个断言）锁住区域顺序、层级、覆盖层判定。
  - 新增 `COMPLETION_MENU` 顶层区域（斜杠命令 / @file 补全菜单），职责边界原则：每个区域只管自己的渲染，不干涉其他区域。
  - 新增 `STATUS_AREA` 顶层区域（PROMPT 之下 5 行空行），输入区固定置底，预留未来扩展。
  - 渲染顺序调整：PROMPT 移到 FOOTER 之后（固定置底），COMPLETION_MENU 移到 PROMPT 之前（浮在上方）。

- **TUI 区域注释标签**（`services/backend/src/cli/tui/ink-components/App.js`）
  - 渲染数组每个 children 块前加 `[区域②.X]` 注释标题，grep `区域` 即可定位所有区域边界。
  - MAIN 左列总览注释列出 6 大区 + 10 小区的完整索引。

- **输出区分级显示矩阵落地**（`services/backend/src/cli/toolDisplayPolicy.js`）
  - 显示矩阵单一真源补齐 [DESIGN-ARCH-073] §2.3 声明的契约：57 个家族全部登记 `tier`（core/minor）与 `intentLabel`，`ALIASES` 覆盖工具注册表全部 151 个工具（此前 10 家族 / 147 个工具落 DEFAULT 无分级语义）。
  - 新增导出 `getToolTier` / `isCoreToolDisplay` / `buildCoreFocusLine`（`▌ 说明：目标` 三段式焦点行）；`DEFAULT_POLICY.tier='core'`（未注册工具默认 core，宁可见到不可漏掉）。
  - 接线两条渲染路径：`steps.js` `printStepLine` 新增 `opts.toolName`（core 且 active 态指示点换 `▌` 锚点，旧签名逐字节回退）；`headlessProgress.js` `formatToolStart` core 工具加 `▌ ` 前缀（stderr，stdout 机器契约不动）。
  - 契约测试 `src/cli/toolDisplayMatrix.test.js` / `src/cli/toolDisplayTier.render.test.js` 由红转绿（11/11）；存量回归 headlessProgress / foldOutputMarker / collapseConsecutiveDuplicates / toolPrefaceStreaming 共 96 用例全过。

### Changed

- **`/菜单` 与 `/commands` 分类区域上色**（`services/backend/src/cli/menu.js`、`services/backend/src/cli/commandCatalogUi.js`、`services/backend/src/cli/ui/inkComponents.js`、`services/backend/src/cli/uiPrompt.js`、`services/backend/src/cli/tui/ink-components/FormFlow.js`）
  - **改了什么**：`menu.js#showMainMenu` 为两个分类组（平台核心 / 量化交易）添加彩色分区标题与彩色图标 —— 平台核心为青色、量化交易为红色，icons 在分类色下渲染，光标选中时仅文本标为青色不遮图标颜色；`commandCatalogUi.js#CATEGORY_MAP` 为四个分类（量化交易 / AI 助手 / 系统 / 应用管理）补 `color` 字段并在 `renderCommandCatalog` 接入；`inkComponents.js#Select` 透传 `disabled` 字段、光标上下跳过禁用项、禁用项不套青色且渲染为灰色；TUI 桥接路径（`selectMenu` → `uiPrompt._normalizeChoice` → `FormFlow`）也透传 `disabled` 与 `color`，`FormFlow` 在渲染时为禁用项使用 `dimColor` + 分类色、跳过光标导航、回车键与数字键均跳过禁用项，确保 `/菜单` 在 ink TUI 下也能看到彩色分类。
  - **为什么**：菜单分类区域缺觉知分明度，用户易混淆系统管理与量化交易指令群。
  - **影响范围**：`/菜单`、`/commands` 以及所有走 `selectMenu` 路径的交互式菜单彩色渲染；Legacy Windows 终端回退到 ASCII 标记，无行为变更。

- **`overlayLiveBudget.js` 薄包装化**
  - `ownsLiveRegion()` 改为引用 `regionLayout.overlaysHidingChrome()`，不再内联覆盖层清单。
  - 新加独占输入覆盖层只需改 `regionLayout.js#OWNING_OVERLAYS`，无需触碰 `overlayLiveBudget`。

- **MAIN_TOOL_* 重命名为 MAIN_OUTPUT.*（破坏性）**
  - `MAIN_TOOL_HDR` → `MAIN_OUTPUT_HDR`（`main.tool-hdr` → `main.output.hdr`）
  - `MAIN_TOOL_OUTPUT` → `MAIN_OUTPUT_VIEW`（`main.tool-output` → `main.output.view`）
  - `MAIN_TOOL_INLINE` → `MAIN_OUTPUT_INLINE`（`main.tool-inline` → `main.output.inline`）

- **新增 MAIN 子区域 ID（破坏性）**
  - `MAIN_REASONING`（`main.reasoning`）—— 思考区大区
  - `MAIN_REASONING_LIVE`（`main.reasoning.live`）—— 思考区 live 段
  - `MAIN_REASONING_COMMITTED`（`main.reasoning.committed`）—— 思考区 committed 段
  - `MAIN_TIP`（`main.tip`）—— 提示区大区
  - `MAIN_TIP_DOUBLE_PRESS`（`main.tip.double-press`）—— 双击提示（1.5s 消失）
  - `MAIN_ACTIVITY`（`main.activity`）—— 活动区大区（原有 4 个小区挂到其下）

- **文档更新**（`docs/03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md`）
  - 新增 §7「终端分区」章节，完整记录三层区域结构、命名约定、几何契约、覆盖层规则、维护流程。

- **仓库结构卫生收口**（`docs/11_报告/历史/`、`docs/00_INDEX_文档索引.md`、`.gitignore`、`scripts/ci/repo-layout-baseline.json`）
  - 根目录 `fix_diff.txt` / `stash_patch.txt` 收容进 `docs/11_报告/历史/`（`root-whitelist` 守卫归零），另清理 `{` 与 `services/backend/{jest_out,tmp_test,test_out}.txt` 一次性测试输出，归档记录见 `docs/11_报告/历史/2026-09-根目录补丁存档-归档记录.md`。
  - `.gitignore` 补防回渗规则：`*.sqlite-shm` / `*.sqlite-wal`、`.env.bak-*`、一次性测试输出（jest_out.txt / test_out.txt / tmp_test.txt）。
  - 6 篇新文档补登主索引与就近索引（DESIGN-ARCH-072/073、DESIGN-PERF-001、DESIGN-SIZE-001、IMPL-DOC-001、快速配置说明），并补登漏网的 DESIGN-OTHER-005；阶段总数校正（03: 71→78、04: 37→38、07: 177→178）。
  - 结构基线下调（只降不升）：dangling-task 115→86、cross-layer-require 43→38、unresolved-require 24→0。

### Fixed

- **启动/长回合后历史在滚动缓冲里重复出现 2~3 份**（`services/backend/src/cli/tui/scrollbackPreserve.js`、`tui/app.js`）
  - **改了什么**：scrollbackPreserve 增加第三层「全屏帧整段转录重发抑制」（门控 `KHY_SUPPRESS_STATIC_REPRINT`，默认开）。识别 ink fullscreen 分支（ink.js:327 / instance.js:132）的单次 write `clearTerminal + fullStaticOutput + output`，用 inkRuntime 实例的 `fullStaticOutput` 做**字节级前缀校验**，通过则剥离冗余的整段转录重发，只留「就地清屏 + 活动帧」；跨 write 拆开的帧先暂存快照再判，`flush()` 兜底归还。`tui/app.js` 为规范化器注入 `getStaticSnapshot` 读取 ink 实例缓冲。快照缺失 / 校验失败 / 任一门控关（`KHY_PRESERVE_SCROLLBACK` 为总门）→ 逐字节回退今日行为。回归测试 `tests/cli/scrollbackPreserve.reprintGuard.test.js`（19 用例：四形态帧头、防误伤、拆帧、冻结快照、Buffer、门控组合）。
  - **为什么**：ink 在活动区高度 ≥ 终端行数时每次都把**累积的全部**已提交 `<Static>` 转录重写一遍；即使第二层已把清屏头改写为 ED0 就地擦除，只要转录高度超过视口，重写本身就必然滚屏，把重印头部推进原生 scrollback —— 与增量提交时已写入的同一批消息形成第二、三份完整副本（用户报「启动后会话重复几次」）。而重发是纯冗余：该分支只在上一帧活动区填满视口时触发，彼时全部转录早已增量写入终端。既有防线（liveRegionBudget / liveHeightClamp / overlayLiveBudget）只钳流式正文等特定成分，盖不住覆盖层、展开态等一切可能超顶的帧。
  - **影响范围**：仅影响 ink TUI 的 stdout 字节流；`<Static>` 增量提交模型、右栏看板画笔（`forceRailPaint` 检测 `\x1b[J` 不受剥离影响）、复制粘贴行为均不变。正常路径零延迟（帧单次 write 即判即剥），拆帧路径最多延迟到下一次 write 或退出 flush。

## 1.1.12

khy OS 1.1.12 — 补齐 Android APK 构建编排与发布版本同步。

### Added

- **Android APK 构建编排**（`platform/khy_platform/android_build.py`）
  - `khy build android` 现在可以定位 `apps/khy-mobile`、检查 JDK 与 Windows 长路径支持、按需准备 Android SDK、写入 `local.properties`、构建 Web 资源、执行 Gradle 并收集 APK。
  - Android SDK 默认放在用户目录下的 Khy-OS 数据路径，不进入 pip 包，NDK 默认保持为空以避免下载无原生依赖的工具链。

### Changed

- 主发布版本轨道统一升级到 `1.1.12`，覆盖 PyPI、npm、后端运行时、模块清单和后端锁文件。
- 发布门禁补齐 `check:khyos-pins` 入口，确保工具链固定检查在发布前实际执行。

### Compatibility

- 安装 / 升级：`pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`；`khy --version` 应报告 `1.1.12`。
- 构建 APK：`khy build android`。

---
## 1.1.9

khy OS 1.1.9 — 精简体积、跨平台脚本补齐与若干修复。

### Added

- **审计日志与上下文压缩透明度**（`services/backend`）
  - **改了什么**：`src/services/auditLog.js` 补齐八字段契约（`timestamp` / `tool` / `params` /
    `result` / `permission` / `elapsed` / `user` / `sessionId`），`logToolExecution` 改为幂等
    （2s 窗口内同一次执行重复上报只落一行，返回 `{written, deduped, reason}`），
    `getModuleStats({module})` 可按工具名前缀收窄统计，`clearAuditLog()` 清空前把旧文件存为
    `.bak` 并如实上报是否覆盖了上一份快照。新增纯叶子 `src/utils/khyError.js` 提供错误四件套
    `{code, message, hint, recoverable, retryable}`；`compactionUiPort.js` 新增第 4 条通道
    `emitCompactionNotice`，由 `cli/aiRenderer.js` 自注册到 `cli/formatters.print*`。
    `contextCompressor.js` 的 11 处跳过分支与 5 处失败分支全部改为「动作 + 目标 + 进度」
    的可见提示 + 审计留痕（`context-compress` / `-skip` / `-degrade` 三个工具名分开，
    使 `errorCount` 不被正常跳过污染）。
  - **为什么**：压缩链路此前有十余处静默 `return noOp` 和裸 `catch`，「压缩成功」「有意跳过」
    「链路失败」三种截然不同的结果对用户长得一模一样 —— 状态栏显示 99% 占用却什么都不发生时，
    没有任何一行输出能说明原因。审计侧则因为写入方从不检查返回值，写失败也无从察觉。
  - **影响范围**：审计文件格式向后兼容（只增字段、不改字段名），`getAuditStats()` 保留为零参
    委托以兼容 `telemetryService.js` 的既有调用；9 处 `logToolExecution` 调用点全部忽略返回值，
    新返回值纯属增量。所有新增阈值集中为 8 个 `KHY_AUDIT_*` / `KHY_COMPACT_*` 环境变量
    （见 `services/backend/.env.example`），`KHY_COMPACT_NOTICE=0` 可一键关回旧的静默行为。

### Fixed

- **审计日志轮转在攒满 3 份备份后静默停工，`audit.jsonl` 无上限增长**
  - **改了什么**：重写 `_rotateIfNeeded()` 的轮转循环 —— 从最旧一代开始迭代（`i = keep … 1`），
    先删掉 `.keep`，每次 rename 前先删除目标路径，最后才把活动文件移到 `.1`。
  - **为什么**：Windows 的 `fs.renameSync` 拒绝覆盖已存在的目标。旧循环从 `MAX_BACKUPS - 1 = 2`
    起步，`.3` 永远没机会被删除，于是第 4 次轮转时 `.2 → .3` 撞上已存在的 `.3` 抛错，又被
    `catch {}` 吞掉 —— 三份备份齐全之后轮转就再也不会成功，而失败没有任何痕迹。
    旧代码里那句 `if (i + 1 > MAX_BACKUPS) unlinkSync(from)` 因 `i` 最大只到 2 而永不可达。
  - **影响范围**：仅影响审计文件的磁盘占用，不改变已落盘内容。新增回归测试连续轮转 5 代，
    断言 `.1/.2/.3` 世代正确且 `.4` 不出现、目录里只剩 3 个文件。

- **压缩器抛异常与「压缩模块不存在」被同一个裸 catch 吞成同一件事**
  - **改了什么**：`khyUpgradeRuntime.buildSlidingWindow` 不再 `catch {}`，改为把异常经
    `toKhyError` 归类后区分 `compressor-unavailable`（模块缺失，正常的可选依赖降级）与
    `compressor-threw`（链路真的坏了，按 error 级别报出）；同时把 logger 注入进
    `compress()` —— 此前没传，压缩器自己的跳过日志在生产主路径上全是死代码。
    legacy 尾部截断路径在确实丢弃了消息时也会报出保留比例。
  - **为什么**：一条坏掉的压缩链路和一个没安装的可选模块，在日志里长得完全一样，
    导致「自动压缩为什么不执行」无法从现场定位。
  - **影响范围**：只增加输出、不改变控制流与返回值。

### Changed

- **`khy update` 改为 GitHub Release 优先并显示全过程进度**
  - **改了什么**：更新索引 schema v1 增量支持 pip wheel / npm tgz 的 GitHub 构件 URL、大小与
    SHA-256；`github → pypi → npm → local` 级联中，GitHub 只有在当前安装渠道存在可验证构件时
    才会胜出，下载后按大小与哈希校验并从本地文件安装。TTY 用单行进度条显示检查、下载、安装
    三阶段，非 TTY 按可配置间隔输出包含 `n/m`、百分比和速率的稳定行。
  - **为什么**：旧命令虽然先检查 GitHub 元数据，pip/npm 安装字节仍来自包仓库，GitHub 并非真实
    首选源；下载和安装期间也只有底层 pip 文本，无法稳定判断动作、目标与进度。
  - **影响范围**：旧的 name/version-only 更新索引继续合法，缺构件、GitHub 不可达或索引过旧时
    自动降级到 PyPI/npm；`KHY_UPDATE_STREAM_PROGRESS=0` 可关闭进度输出，下载活动超时和非 TTY
    输出间隔可分别用 `KHY_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS` / `KHY_UPDATE_PROGRESS_MIN_INTERVAL_MS` 调整。

- **体积精简**: 新增 `scripts/maintenance/slim-down.{bat,sh}` 一键清理脚本（日志、构建产物、
  sqlite 临时文件、未使用的 node-llama-cpp 多平台二进制），幂等且双平台覆盖；日志轮转收紧
  （`maxFiles` 7d/14d + `zippedArchive`）防单日日志爆量。
- **跨平台脚本**: 补齐 `slim-down.sh` 与 `khy.sh repair` 支持，bat/sh 配对完整。

### Fixed

- **模型「说要搜索却不调工具」**:同一个模型在能力缓存里留下了两条键不同、裁决相反的记录
  (`api:agnes:agnes-2.5-flash` → `text`,来自主动探测;`agnes-2.5-flash` → `native`,来自被动学习),
  而两道决定工具协议的闸各读一条:教学门拿路由 id、剥离门拿裸模型名。结果模型在同一轮里
  既收到完整的原生工具定义,又收到「你没有原生工具,请用 `<tool_call>` 文本语法」的教学 ——
  指令自相矛盾,模型于是只用散文说「我先用 WebSearch 搜索」,一个工具都不调,自我重驱一次后
  输出同样的段落并结束该轮。
  - 新增纯叶子 `services/gateway/capabilityModelKey.js`:能力缓存的键统一折叠为**裸模型名**,
    剥前缀的约定与 `apiAdapter.parseProviderModel` 同源(测试里有对撞断言防止三份正则各自演化)。
    ollama 风格的量化/尺寸 tag(`qwen:7b`)绝不误剥,否则不同模型会塌成同一条记录。
  - `toolCapabilityStore` 加载时**就地迁移**历史带前缀的键并落盘,已有缓存文件自愈,撞键时
    `native` 胜 `text`。
  - `recordVerdict` 新增**不静默降级**不变量:已确证 `native` 时,一次 `text` 观测不再覆盖它 ——
    「见过真实的原生 tool_calls」是正面证据,「这次没看到」只是证据的缺席(探测用极简工具 +
    极短 maxTokens,假阴性正常)。降级只能显式发生:`khy gateway probe-tools` 主动重测(现在传
    `force`),或 `KHY_TEXT_ONLY_TOOL_MODELS` 钉死。

### Changed

- **TUI 任务看板改为「右栏」，与正文平齐贯穿整屏**：看板不再作为 ink flex 行里的右列子元素渲染。
  ink 活动区永远画在已提交的 `<Static>` 滚动区之下，所以树内看板结构性地被钉在视口底部，
  右上方那一大片空间永久浪费。现在改为两步：ink 渲染的一切收窄到 `cols - 栏宽`（新叶子
  `railLayout.contentCols` 是唯一真源，经 `effectiveCols` 供各渲染路径读取），最右侧那几列
  预留出来，由 `runtime/sidebarRail` 用「存光标 → 逐行绝对定位 → 取光标」的字节把看板画进
  槽位，从屏幕第 1 行铺到 `rows - 1` 行。
  - 画笔字节被**追加进 ink 自己的那一次 `write()`**（`app.jsx` 已有的 stdout Proxy），
    整行擦除与重画因此是一次原子写入，屏幕上不存在「已擦除、未重画」的中间态 = 不闪烁。
  - 全程不含 `\n`/`\r`、不改 scroll region，`<Static>` + 终端原生 scrollback 的输出模型
    与复制粘贴行为完全不动；不新增定时器（复用 App 每秒的 `nowTick` 心跳）。
  - `/model`、`/review` 等原生交互界面前后自动 suspend/resume，resize 变窄时先清旧几何，
    退出路径清空槽位。
  - 门控 `KHY_SIDEBAR_RAIL` **默认开**；`KHY_SIDEBAR_RAIL=0` 逐字节回到树内看板的旧行为。
    宽度/配色沿用既有 `KHY_SIDEBAR*` 一族；约束高度的 `KHY_SIDEBAR_MAX_RATIO` /
    `KHY_SIDEBAR_MIN_CHROME` / `KHY_SIDEBAR_STACK_MAX_RATIO` 对右栏不再适用（它不占活动区行）。
  - 窄于 `KHY_SIDEBAR_MIN_COLS`（默认 120 列）或非 TTY → 不激活，完全走 legacy 路径。

## 1.1.8

khy OS 1.1.8 — 安全加固、CI 流水线完善、前端体验优化与便携模式增强。

### Highlights

- **安全加固**: 修复命令注入防护与会话撤销竞态条件 (d525650)，后端网关适配器、守护进程管理与启动恢复的全面硬化 (efb676b)。
- **CI/CD 完善**: 发布构件增加平台后缀防止覆盖 (18f60b8)；GitHub Release 写权限修复 (2a93fcc)；构建工具链锁定 Node 22 (5e31d1b)；独立构建所需打包脚本取消忽略 (b778b92)。
- **前端体验**: 浮动球、路由预加载与 AI 聊天视图改进 (338e3c2)；TUI 稳定性修复与输入→渲染性能优化 (f4e6541)。
- **便携模式**: 新增 portable 打包、健康检查与自愈工具链 (7970831)。
- **基础设施**: 后端版本同步机制与 SQLite 启动探测，`better-sqlite3` 降级为可选依赖 (893da15)；新增 `khyos-markdown` MCP 服务器 (1ceca37)。
- **测试**: TUI 渲染测试更新 (b336ca7)。

### Compatibility

- 安装 / 升级: `pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`；`khy --version` 应报告 `1.1.8`。
- Node.js >= 20 要求不变。
- `better-sqlite3` 不再为强制依赖，无原生模块环境下自动回退至 `node:sqlite`。

---
