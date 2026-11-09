# [DESIGN-ARCH-204] 统一开发环境管理器 — 盘点、清单与一键恢复

> 状态：v1 已实现（后端 + CLI 终端通道；网页/桌面通道各自实施）。
> 真源范围：本文档是「开发环境盘点/清单/一键恢复」功能的设计真源；依赖自愈底座的真源仍是
> `[DESIGN-ARCH-027]`。用户痛点原话与需求五问存证：
> `works/data/khy/feedback/devenv-manager-20261107/requirement-5q.md`（`RUNTIME-008`）。

## 1. 需求与 v1 取舍

**用户原话**：「我有个困扰每次换电脑都要重新安装一堆的开发环境」「我希望 khyos 的网页、桌面、终端，
都有个能够统一管理所有开发环境的页面和功能」「如 python,c,c++,c#,java,javascript,typescript,
html,css,moonbit,jdk,wasm……等开发语言环境」。

**v1 取舍（迁移导向，理由如下）**：v1 只做四件事——全量盘点（已装工具链 + 版本）、缺失清单、
一键安装缺失项（curated）、环境清单导出/导入（换电脑一键恢复的核心场景）。

| 排除项（outOfScope） | 理由 |
|---|---|
| 多版本并存 / 升级 / 卸载 | 用户痛点是「换机重装」，不是「单机多版本」；v2 再做。服务层只预留接口位置：manifest schema 带 `version` 字段、registry 无 uninstall 条目 |
| winget 不可用时的官方下载器兜底全量覆盖 | v1 不实装任何下载器（见 §5 安装策略②——v1 终稿连三个高频项的 `official` 字段也未落，因为盘点实测 winget 在 Windows 10 1709+ 普遍可用，兜底价值后置；需兜底的工具链经 `docsUrl` 诚实降级手动） |
| 新终端模拟器 | 终端通道 = 现有 khy CLI（REPL 内可用） |
| html/css 的「可安装化」 | 无运行时语言不做伪安装目标，informational 三态如实呈现 |
| 39 个 registry depId 全量上架 | puppeteer/torch/whisper/ghidra 等运行时依赖归 `khy deps` 自愈语义，不进开发环境目录 |

## 2. 总原则：不另起炉灶

v1 = 在既有「依赖自愈子系统」`runtime/node/backend/src/services/domain/network/dependency/`
（`[DESIGN-ARCH-027]`，registry/installRunner/toolchainVersions/共置测试文化）之上做
「盘点/清单/编排」增量。四块新能力（版本探针、全量盘点、清单 IO、任务编排）以同目录共置
新叶子补齐，**不建第二套探测/安装机器**：

| 文件 | 职责 | 关键红线 |
|---|---|---|
| `versionProbe.js` | depId → 已装版本探针（`<bin> --version` + 正则） | 单 bin 5s 超时是 RUNTIME-003「短 I/O 超时」合法例外（防挂死 I/O，非杀活跃任务）；永不抛，失败 version=null |
| `inventory.js` | DEV_ENV_CATALOG 三态目录 + scanInventory 全量盘点 + 快照原子写 + **assertInstallable 短路闸（单点实现）** | 闸先于 buildInstallPlan；informational 条目（html/css）无 registry 条目，闸内先查目录再查 registry |
| `manifestIo.js` | buildManifest / previewImport / applyImport | 导入文件是**不可信输入**：只取 depId+version 两个 token，depId 须命中 registry∪目录，version 须过 toolchainVersions 白名单；文件内命令/路径/URL 绝不进入执行 |
| `installJobs.js` | HTTP 通道内存任务表（单队列顺序执行、无 wall-clock kill、不持久化） | settle 于子进程退出/结果事件；进程重启 job 即失，UI 如实提示 |

registry/resolver 两处加性改动：
- `registry.js` 新增 `nodejs` depId（39 项里此前没有 node/nodejs——用户点名 javascript 的唯一缺口）。
- `python3` probe 改多候选 `bins:['python3','python','py']`（保留规范 `bin:'python3'`——既有
  registry 守卫要求 COMMAND probe 必有 bin 字符串，`registry.test.js` 实测会拦）；python.org
  安装的 Windows 上只有 python.exe/py.exe，单 bin 探针会假阴性（`platformUtils.searchExecutable`
  用 `where`，win32 无 python3.exe）。`resolver.probe` 支持 `p.bins` 逐个试、首中即返，
  单 bin 行为不变，heal 链向后兼容。

### 2.1 工具链目录（DEV_ENV_CATALOG，实际上架 17 项）

用户点名 11 项 + 「……等」邻域 6 项（registry 现成条目，盘点同屏展示不另做）。
真源 `inventory.js` 的 `DEV_ENV_CATALOG`（inventory.js:41-60），kind 三态：installable
可安装 / manual 仅手动 / informational 无运行时无安装；语言名/别名/depId 的归一入口
`normalizeToDepId()`（大小写不敏感），CLI 安装参数与导入清单共用。

| language（用户口径） | depId（对齐 registry） | kind | 别名归一 |
|---|---|---|---|
| python | python3 | installable | python, py |
| javascript | nodejs | installable | javascript, js, node, nodejs |
| java | openjdk | installable | java, jdk, openjdk |
| c | gcc | installable | c, gcc |
| c++ | gpp | installable | c++, cpp, g++, gpp |
| c# | dotnet | installable | c#, csharp, dotnet, .net |
| typescript | typescript | installable | typescript, ts |
| moonbit | moonbit | **manual** | moonbit, moon |
| wasm | wabt | installable | wasm, webassembly, wabt |
| html | html | **informational** | 无独立运行时，无需安装 |
| css | css | **informational** | 无独立运行时，无需安装 |
| make | make | installable | make |
| cmake | cmake | installable | cmake |
| nasm | nasm | installable | nasm（x86 汇编） |
| clang | clang | installable | clang, llvm |
| rust | rust | installable | rust, rustc, cargo |
| go | go | installable | go, golang |

版本探针表（`versionProbe.js` 的 `VERSION_PROBES`，15 个 depId——html/css 无运行时无探针）
逐项 `execFile <bin> --version` 正则提取，单 bin 5s 超时；盘点快照 entry 额外带
`installable`（本平台有 curated 计划才算可装）与 manual 条目的 `installHint`（registry
curated 只读展示，scanInventory 聚合时填）。非开发工具链（puppeteer/torch/whisper/ghidra
等运行时依赖）不进本目录——归 `khy deps` 自愈语义（outOfScope，§1 表末行）。

## 3. manual 短路闸为何必须落在 devenv 层（实测证据）

「MoonBit 永不自动执行官方脚本」在 `registry.js` moonbit 条目**只是注释契约，代码零强制**：

- 实测 `require('.../dependency/index.js').buildInstallPlan('moonbit')` 返回非空计划
  `{manager:'script', displayCommand:'powershell -Command irm https://cli.moonbitlang.com/install/powershell.ps1 | iex'}`。
- `installRunner.js` 全文件无 `script` 分支；`runInstall`（installRunner.js:159-197）只验
  `plan.command` 非空数组即执行。

因此 v1 新增机制闸 `assertInstallable(depId)`（inventory.js，门面 index.js 补导出）：
manual（catalog kind='manual' **或** registry `install.manager==='script'`）与 informational
条目在 **buildInstallPlan 之前**拒绝，返回
`{ok:false, code:'DEV_ENV_MANUAL_ONLY'|'DEV_ENV_NOT_INSTALLABLE', installHint?}`。
三个安装入口（CLI `devenv install` / HTTP `POST /install` / import apply）共用这一个闸，
绝不依赖 registry/installRunner 拒绝。applyImport 内对该闸再过一次（防被改过的清单），
manual 条目置 `skipped(reason=DEV_ENV_MANUAL_ONLY)`。

**是否把硬拒下沉到 installRunner/buildInstallPlan 层**属自愈链行为变更（healingLoop 同消费
该链），按该单元「登记不修、改动需人工裁决」的现行文化交人工单独裁决；已登记
`khy.module.json` knownDefectsPinned 第 4 条，`inventory.test.js` 以 KNOWN-DEFECT 断言钉住
现状（断言 buildInstallPlan('moonbit') 仍产出 script 计划——若有人修复了自愈链，断言翻红即为提示）。

## 4. 清单文件 schema 与落点（两件东西、两种性质）

**1) 盘点快照（机内缓存，可再生，T2-regenerable）**：
`<projectDataHome>/T1-domains/tools/env/scan-latest.json`
（经 `dataHome.js` `DATA_PATHS.devEnv = 'T1-domains/tools/env'` +
`getProjectDataPath` 解析——该函数正是为「文件路径不建末级目录」而存在）。
已登记 `docs/10_规范/registry/DATA-LOCATIONS.json` seedEntries `dev-env-scan`
（note 写明：重跑 `khy devenv scan` 即可再生，删除仅丢上次盘点缓存）。
快照不是数据真源（真源是机器系统状态本身），不登记 DATA-SSOT.json。

```json
{ "scannedAt": "...", "platform": "win32", "winget": {"present": true, "detail": "C:\\...\\winget.exe"},
  "entries": [{ "depId": "python3", "language": "python", "label": "Python 3", "kind": "installable",
                "present": true, "version": "3.12.7", "versionDetail": "Python 3.12.7",
                "versionable": true, "versions": ["3.10","3.11","3.12","3.13"],
                "docsUrl": "...", "installable": true, "installHint": null, "note": null }] }
```

`installHint` 仅 manual 条目非空（registry curated 只读展示）；`/api/dev-env/catalog` 的
toolchains 条目同字段同来源（web/桌面「复制安装命令」按钮的数据源）。job 终态 progress
由 installJobs 在 settle 时采纳 `result.progress` 覆写——轮询方读到的完成文案即最终态，
不会把 running 期文案当成功消息。

**2) 用户随身清单（导出/导入，不入数据家）**：

```json
{ "schemaVersion": 1, "kind": "khy-dev-env-manifest", "exportedAt": "...", "platform": "win32", "khyVersion": "1.2.2",
  "entries": [{ "depId": "python3", "language": "python", "state": "present|missing|manual|informational", "version": "3.12.7" }] }
```

导出默认写 stdout 或 `--out` 显式路径（CLI）/浏览器下载（Web）/保存对话框（桌面）；
导入由用户给路径。服务端不接收任何导出落盘路径（杜绝路径注入）。
manifest 里 state='present' 是安装目标（旧机有→新机装）、'missing' 跳过、
'manual'/'informational' 展示/跳过。

## 5. 安装策略（v1 终稿）

1. **winget 可用**（Windows 10 1709+ 默认有）→ registry 的 win32 winget argv，版本经
   toolchainVersions 矩阵按需选（`devenv install jdk@17`）。
2. **winget 不可用** → v1 未实装下载器兜底（§1 取舍）；工具链经 docsUrl 诚实降级手动安装。
   未来落法已在勘察中确认可借鉴 `runtimeProvisioner` 的原子写/锁/SHA256 模式。
3. **manager:'npm' 的 typescript** → 前置 nodejs；installRunner 的 manager-not-found 归因
   （MANAGER_DOCS）已指向 nodejs.org。
4. **manual 条目硬短路** → assertInstallable（§3，本设计新增的机制闸）。
5. **装后一律 probe 复验**（deps.js:212-241 先例），复验失败如实报
   「安装命令已执行，但 X 仍未探测到就绪……可能需重开终端刷新 PATH」——绝不安装即转绿。

## 6. 三通道接线

### 终端（khy CLI，本通道）

- 新自注册命令 `khy devenv`（`handlers/devenv.js`，manifest：
  `{name:'devenv', subCommands:['scan','missing','install','export','import','help'], category:'dev'}`，
  aliases 留空——静态别名在 aliases.js 单点登记避免双源）。
- **命令名不取 `env`**：`env` 已在 ROUTER_COMMANDS（commandSchema.js Claude-Code-aligned 区段）；
  route() 派发链 dispatchOpsCommand → dispatchSlashCommand → dispatchTailCommand →
  commandAutoRegistry → 硬编码 switch，而 `case 'env'`（打印 Platform/Node/CWD）在
  routerDispatchSlash.js:539-557 **先于** auto-registry——自注册 env 会被截胡。
  `devenv` 经全 dispatch 模块零命中实测取用。
- 子命令在 ROUTER_SUB_COMMANDS 登记（router.js:994/1022 用它解析 subCommand，该表不入棘轮
  计数）；handler 内保留 `subCommand || args[0]` peel 兜底（deps.js:285 先例）。
- 静态别名 4 条：`开发环境` / `环境管理` / `huanjing` / `dev-env`（用户约束「CLI 新命令须同步
  aliases.js」+ AGENTS.md AI 须知#3，不走 manifest 别名的零增量旁路）。
- 语言名归一经 DEV_ENV_CATALOG：c→gcc、c++→gpp、c#/csharp→dotnet、java|jdk→openjdk、
  javascript|js→nodejs、wasm→wabt、python→python3。

### 网页（/api/dev-env，实施见 routes/devEnv/index.js）

挂载 `app.use('/api/dev-env', require('./src/routes/devEnv'))`（server.js 挂载处不加 auth）；
authMiddleware 在路由内部 `router.use(authMiddleware)`（clientApps 形态，`../../middleware/auth`
import）。**勿**与 largeTasks 的挂载处 auth 形态叠加成双重鉴权。
信封 `{success, data|message, code}`；业务失败 409（DEV_ENV_MANUAL_ONLY / DEV_ENV_NO_INVENTORY /
DEV_ENV_NOT_INSTALLABLE）、客户端错 400（DEV_ENV_UNKNOWN_DEP / DEV_ENV_MANIFEST_INVALID）、
服务端错 500+code。长操作（scan/install/import/apply）一律 job 化返 202，
`GET /jobs/:jobId` 轮询（kind 通用；未知 jobId → 404，如实提示「任务记录随进程重启清空」）。

**API 契约**（真源 `routes/devEnv/index.js`；全部走 `{success, data|message, code}` 信封；
鉴权在路由内部 `router.use(authMiddleware)`，挂载处不加 auth——clientApps 形态，防双重鉴权）：

| 方法与路径 | 语义 | 成功 | 失败 |
|---|---|---|---|
| GET /api/dev-env/catalog | 静态目录：toolchains 条目（manual 条目带 installHint）+ winget 可用性，不触发探测 | 200 | 500+code |
| GET /api/dev-env/inventory | 读上次盘点快照，不触发探测 | 200 | 409 DEV_ENV_NO_INVENTORY（引导态而非错误） |
| POST /api/dev-env/scan | 全量盘点（约 3-10s），job 化 | **202 {jobId}** | 500+code |
| GET /api/dev-env/jobs/:jobId | 轮询任务（scan/install/import 通用） | 200 jobView | 404 DEV_ENV_JOB_NOT_FOUND |
| POST /api/dev-env/install | 单项安装，body `{depId, version?}`，job 化 | **202 {jobId}** | 400 DEV_ENV_UNKNOWN_DEP · 409 DEV_ENV_MANUAL_ONLY / DEV_ENV_NOT_INSTALLABLE（data 附 installHint/note） |
| POST /api/dev-env/export | 以最近快照构建清单，服务端不落盘（杜绝路径注入） | 200 manifest | 409 DEV_ENV_NO_INVENTORY |
| POST /api/dev-env/import/preview | 导入预览，永不安装；计划四段 `{toInstall, skipped, manual, unknown}` | 200 plan | 400 DEV_ENV_MANIFEST_INVALID |
| POST /api/dev-env/import/apply | 导入执行（apply 内再过 assertInstallable 闸），job 化 | **202 {jobId}** | 400 DEV_ENV_MANIFEST_INVALID |

未知 depId 的 400 回包附可选列表（`dep.devCatalog` 全量 depId）；install 的存在性预检用
registry ∪ 盘点目录——html/css 是纯目录项（无 registry 条目），只按 registry 判会把
informational 误报成「未知依赖」。job 终态 progress 由 installJobs settle 时采纳
`result.progress` 覆写，轮询方读到的完成文案即最终态。前端消费见
`delivery/web/ai-frontend/src/api/devEnv.js`（8 方法一一对应；catalog/inventory/export 标
`silent`——409 由页面空态承接而非全局报错）。

### 桌面（host 桥，桌面通道实施者阅读）

主通道 = host nodeRequire 后端门面（`resolveKhyOsDir() + '/runtime/node/backend/src/services/
domain/network/dependency/index.js'`，对每个导出 typeof 兜底）；main 只持通道字面量与文件
对话框。6 组 host 消息（env.catalog/scan/install/importPreview/importApply/export）+
2 个流事件（env.progress / env.jobDone）；`env:lastScan` 是唯一不经 host 的通道（main 直读
数据家快照）。desktopUiContract 只校验 preload↔main 配对、不校验 main↔host——host 侧消息
漏登记不会红任何测试、只在运行时挂死，实施者按设计定稿的 6 组清单逐一核对五个同步点
（协议头注释 / HostMsg 类型 / handleMessage 分派 / main pending map / handleHostMessage 认领）。

## 7. 棘轮与登记（如实记录）

2026-11-07 实测 `node scripts/ci/check-delivery-baseline.js`：本功能实施后
`routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94`
（实施前 248/591/166/101——本功能增量 +1/+4/+1/0）。任务面棘轮在实施前本已突破
（delivery-surface-ratchet-breach，S1 WARN 不阻断），增量 finding 如实接受、不为绕过砍功能；
基线下调须先退役等量命令面（人的决定）。本功能是产品能力不是拦截型门禁，不触发 PROCESS-008
四阶段登记；数据落点按 DATA-LOCATIONS 先登记后落盘（check-data-layout S1 观察者档）。

## 8. 已知限制（如实）

- **WindowsApps 商店占位 stub**：`where python` 命中 `...\WindowsApps\python.exe`（Store alias）
  时 presence=true 但 `--version` 无输出 → 盘点表显示「已装 / 版本 -」。这是探测语义的诚实
  结果（PATH 上确有名为 python 的东西，但读不出版本）；导入流程会把该项按「本机已装」跳过。
  stub 识别（输出去重/Store 别名剔除）留 v2。
- **PATH 即时刷新**：安装完成后当前进程探测不到新装工具是 OS 事实，只做诚实提示（重开终端/
  重启应用后复验），不做 PATH 注入或进程重启魔法。
- **previewImport 的 unknown 状态容错**：清单条目 state 不在四态白名单内时按 'missing' 处理
  （fail-safe：绝不因此安装任何东西）。
- **applyImport 的「本平台无预置安装命令」分支**：registry 现行 40 项在三大平台均有回落
  command，该分支当前是防御性死代码——保留是为 registry 未来「诚实降级」型条目（如 ghidra
  型 platform 限空）兜底，不伪装可达。
