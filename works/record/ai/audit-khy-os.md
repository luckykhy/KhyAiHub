# Khy OS 全仓库审计报告

- **审计对象**：本地仓 Khy OS 开发仓（`D:\Portable\khy-os`）
- **审计执行日**：2026-11-12
- **报告文件**：`works/record/ai/audit-khy-os.md`（本次审计唯一新增文件）
- **分支信息**：不可用（审计期间工作区处于多写入者并发状态，`git status --porcelain` 行数在勘察期间从 321 漂移至 335）

## 审计对象声明

本次审计对象是**本地仓本身（Khy OS 开发仓）**，审计范围即工作区当前状态：分支信息不可用。它是分发仓 KhyAiHub 的上游真源，但本报告以本地仓为审计主体，分发仓同步状态只作为发布部署审计的一项证据出现。

第一阶段未修改任何源代码、配置与数据库结构；本次审计唯一新增的文件就是本报告。所有结论来自两部分材料：① 各领域审计执行体在本会话内实际运行的只读命令与其输出（门禁命令、静态扫描、探针复现）；② 题目下发的结构地图、门禁实测记录与带复核结论的发现清单。凡未经本会话执行或读取的，均在「第七章 审计结论」中如实标注。

**计数口径**：本报告共登记 **131 条发现**，其中复核确认 **126 条**、未证实 **1 条**（DB-09）、复核不予认定 **4 条**（GW-04、DB-11、DB-15、DEP-05，仅在结论中说明条数与理由，不进入已确认清单）。已确认的 126 条按风险等级为：P0 × 1、P1 × 26、P2 × 56、P3 × 43。

---

## 第一章 项目总体评价

### 1.1 架构

仓库是一个**单体巨仓 + 多端交付**形态：运行时三层（`runtime/boot/kernel` MoonBit+C 内核、`runtime/substrate/platform` Python 启动器与三个 pnpm 包、`runtime/node/` backend 主力 + ai-backend 生态 + Tools），交付面覆盖 Web（Vue ×2）、桌面（Electron + React）、移动（Flutter + Android）、渠道（khyquant 随平台分发）、扩展与品牌资产。核心是一个 3597 个 `.js` / 104.6 万行的 Node 后端（`services/` 单目录 723 个 js、`gateway/adapters` 70 个、`cli/handlers` 167 个、`bin/khy.js` 2492 行、`cli/router.js` 3538 行 51 个 case），外加 179 个 `.ts/.tsx` 的桌面端与两个 Vue 前端。

架构设计意图清晰且有书面真源（`[DESIGN-LAY-005]` 层级规范、`[DESIGN-ARCH-111]` 规则绑定层、D1–D10 交付判据），但**物理实现与设计意图之间存在系统性缺口**：目录迁移（2026-10 方案 P）后，跨层倒置、循环依赖、双锁文件、双 bundle 副本、失效指针（`entries/launch.js`、Alpine ISO 脚本、NSIS/管道/黄金路径多处）大面积残留，且多数残留**不在任何守卫的判据范围内**——守卫看的是它看得见的那一面（如 `unresolved-require = 0`），看不见字符串拼路径、构建配置 outDir、发布脚本 glob。

### 1.2 核心能力

- **AI 网关**：多供应商适配器（70 个 adapter）、密钥池与轮换、fast-fail 冷却、模型路由（auto/band/λ）、流式管道（SSE 解析 + stale 检测 + 拆流）、请求去重、adaptiveOutput。能力面是全仓最重的代码集中地（`aiGatewayGenerateMethod.js` 7007 行），也是缺陷密度最高处（GW 系列 13 条确认发现）。
- **CLI/REPL**：51 个命令 case、约 593 条别名、167 个 handler，配 HUD 状态行、轨迹回放、审计轨迹。
- **多端与渠道**：桌面端 agentbus 车道（ Electron 主进程 ↔ host 子进程 ↔ 手机）、跨设备同步 WS、量化前端、移动端。
- **治理与门禁**：118 个 `scripts/ci` 守卫文件（3.94 万行）、101 条登记规则、152 个 `check:*` npm 脚本、12 个 workflow、D1–D10 交付记分板。

### 1.3 工程成熟度

**治理机制的「设计成熟度」很高，「执行成熟度」很低。** 版本同步（10 源三轨道）、软著就绪、依赖来源原生三门实测全绿；但同时：架构债棘轮现行工作区实红（27 项超基线，20 个存量巨石在长胖）、`check-gov-status` 报「绿灯（可进入发布门）」而同期四个实守卫全红、`scripts/ci` 120 个执行器只有 35 个进 PR 门且总门 `rules:gate` 是 report-only、债务台账自报数与实测脱钩（10/21 项上漂、1 项 closed 而实测 38）、backend lint 495 个 error / 5899 warning 且 `--max-warnings 0` 从未对存量生效、backend jest 深红（79 suite / 198 用例失败）而 test-baseline job 整体 continue-on-error、`test:node` 通配符未加引号使 CI 比 Windows 少跑 1335 个测试文件（46%）。门禁自身也有真空判据（`forbidDeepImports` 因 0 个模块声明入口而恒 0 违规、COMMS-002 执行器扫的是被 gitignore 的目录）与过期决策记录（`rules:gate` 三条前置条件之一已静默满足）。

文档面漂移已成规模：101 个失效 npm run 命令、`docs:verify` 68 处缺孪生且无门引用、AGENTS.md 的 html 孪生计数错一倍、12 处文档数值主张与代码不符、`.env.example` 宣称的默认管理员口令与实现不符。

### 1.4 安全成熟度

**宣称面远大于控制面，且缺口集中在最高危处。** 多用户认证体系真实存在（JWT/API key/User 模型），但：

- 提权与隔离：goal/ultrawork/coding 模式把进程级权限提到 yolo **并持久化落盘**，异常终止后留下永久全自动放行（AGT-01）；OS 级沙箱（bwrap/Seatbelt/Job Object）与 agent 实际使用的 shell 工具**完全脱钩**（AGT-04）；会话存储无用户维度，任意已认证用户可读任何会话全文并向他人会话写入（AGT-03）。
- 网络暴露：跨设备同步 WS 接受未认证连接且身份由客户端自填、会话无对象级鉴权，而 server 以 0.0.0.0 监听（SEC-01）；`trust proxy=1` + 读原始 XFF 使全站限流（含登录防爆破）可被逐请求轮换绕过（SEC-02）；httpRequest 工具零 SSRF 防护且重定向不复查（AGT-02）。
- 数据与凭据：`/api/cache` 写端点未挂鉴权（SEC-03）；附件按 id 可取无属主校验（SEC-04）；审计日志脱敏只覆盖顶层固定字段名，明文密码/密保/SendKey 入库（SEC-05）；git 跟踪的初始管理员明文口令文件随分发仓外发（SEC-06）；上游密钥脱敏正则停留在 OpenAI/GitHub 时代，Gemini/JWT/UUID 一律不脱敏（GW-06）；扫码登录一次性令牌明文入请求日志（SEC-11）；未接线的 traffic-stream WS 无认证即可拉全量流量（GW-11，潜伏面）。

### 1.5 主要技术债务

1. **循环依赖与巨石文件**：`cli/`+`services/` 组成 197 节点强连通分量；28 个文件 >2500 行（最大 13997），同时 674 个超 400 行文件被 `managedOnly` 豁免；50 个单行再导出壳造成双 import 路径。
2. **配置面失控**：backend/src 独有 1250 个 `KHY_*` 环境变量名、2079 处读取，登记表只覆盖 535 个；1041 处 `process.cwd()` 拼数据路径，是根目录影子目录与垃圾文件的直接成因。
3. **数据层零事务/零乐观锁**：主库（Sequelize）全层零 `transaction` 调用；账号池租约、任务看板终态、大任务认领、刷新令牌轮换、会话 transcript 更新全部是读-改-写无状态守卫。
4. **双实现与双锁**：ai-backend 是同一仓内第二套 AI 网关实现（G2 独立轨道、代码大面积重写、无 SSOT 登记）；npm/pnpm 双锁并存且根 `package-lock.json` 记录的是迁移前目录树；pip/npm 两个 bundle 副本已字节级漂移 1.8MB 且只有一个被 git 跟踪。
5. **发布链断裂**：pip 上传路径指向已迁移的 `dist/`（P0）、`pack-executable.js` ROOT 少算一级导致发布构建第一步 ENOENT（P1）、npm 签名步对 `--dry-run` 的文件名签名（P1）、release-gate 的 must 阶段要求 `khy` 在 PATH 而 CI 从未安装（P1）、Docker 镜像装 PyPI latest 而非 tag 版本（P1）、DB 自动迁移版本锚点在两个离机渠道恒为 0.0.0（P1）。
6. **依赖债与漏洞面**：axios 1.19.0 / undici 7.29.0 / multer 1.4.5-lts / js-yaml 3.15.1 四个 P1/P2 依赖公告命中；三份锁文件共 126 条 `resolved` 指向 npmmirror；安装向导默认项是公共镜像。
7. **仓库卫生**：git 对象库缺 22 个对象（`git fsck` 退出码 2，D1 GAP）；根目录 5 个 error 级 finding（影子目录、28 个事故残留、未登记顶层目录 `vibe_images`、白名单外文件）；工作区约 25GB（mobile 21.8GB + brand 4.1GB + 数据家 5.5GB）；本地相对分发仓落后 257 笔未推送。

---

## 第二章 风险总览

### 2.1 按风险等级（与问题清单逐条对应）

| 风险等级 | 已确认 | 未证实 | 复核不予认定 | 合计 |
|---|---|---|---|---|
| P0 | 1 | 0 | 0 | 1 |
| P1 | 26 | 0 | 0 | 26 |
| P2 | 56 | 1 | 2 | 59 |
| P3 | 43 | 0 | 2 | 45 |
| **合计** | **126** | **1** | **4** | **131** |

> 计数说明：P0/P1/P2/P3 的「已确认」列 = 进入第三章问题详细清单的条目；「未证实」列 = DB-09（P2，复核子代理失败）；「复核不予认定」列 = GW-04（P2）、DB-11（P3）、DB-15（P3）、DEP-05（P2），共 4 条，只在第七章说明。三列相加 = 131，与各领域发现清单逐条一致。

### 2.2 按领域分布（已确认 126 条）

| 领域 | 编号段 | P0 | P1 | P2 | P3 | 小计 |
|---|---|---|---|---|---|---|
| 架构与债务 | ARCH | 0 | 5 | 13 | 3 | 21 |
| AI 网关 | GW | 0 | 2 | 3 | 8 | 13 |
| Agent 与工具 | AGT | 0 | 4 | 2 | 2 | 8 |
| 安全 | SEC | 0 | 2 | 6 | 6 | 14 |
| 数据与存储 | DB | 0 | 3 | 6 | 5 | 14 |
| 前端与桌面 | FE | 0 | 1 | 5 | 6 | 12 |
| 依赖与构建 | DEP | 0 | 4 | 12 | 8 | 24 |
| 发布与交付 | REL | 1 | 5 | 6 | 3 | 15 |
| 运行时 CLI | RUN | 0 | 0 | 3 | 2 | 5 |
| **合计** | | **1** | **26** | **56** | **43** | **126** |

> GW 领域 13 条已确认 + 1 条复核不予认定（GW-04）；DB 领域 14 条已确认 + 1 条未证实（DB-09，计入 2.1 表的未证实列）+ 2 条复核不予认定（DB-11、DB-15）；DEP 领域 24 条已确认 + 1 条复核不予认定（DEP-05）。

### 2.3 P0/P1 速查（每条均带 `文件:行号`，详见第三章）

| 编号 | 标题（简） | 等级 | 文件:行号 |
|---|---|---|---|
| REL-01 | pip 上传路径指向已迁移的 dist/，发布链在 twine 步必中止 | P0 | `scripts/release/publish-dual.sh:329` |
| ARCH-01 | cli/ 与 services/ 197 节点强连通分量 | P1 | `runtime/node/backend/src/services/healEscalationService.js:487` |
| ARCH-02 | 架构债棘轮实红：27 项超基线，20 个巨石在长胖 | P1 | `runtime/node/backend/src/cli/replSession.js:1` |
| ARCH-03 | 供应商 baseUrl 五处重复硬编码（25+ 文件） | P1 | `runtime/node/ai-backend/src/routes/ai.js:265` |
| ARCH-04 | 1041 处 process.cwd() 拼数据路径，影子目录根因 | P1 | `runtime/node/backend/src/cli/khy.module.json:27` |
| ARCH-05 | COMMS-002 登记 P1/enforced，执行面恒为空 | P1 | `scripts/ci/validate-json-schemas.js:130` |
| GW-01 | 密钥池 continue/return 绕过 releaseSlot，槽永久泄漏 | P1 | `runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:4940` |
| GW-02 | fast-fail 自锁：池重试退化为 1 次真实尝试 | P1 | `runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:4947` |
| AGT-01 | goal 模式提权 yolo 并持久化落盘，崩溃后永久放行 | P1 | `runtime/node/backend/src/services/goalModeService.js:139` |
| AGT-02 | httpRequest 零 SSRF 防护，可打内网与云元数据 | P1 | `runtime/node/backend/src/tools/httpRequest.js:40` |
| AGT-03 | 会话存储无用户维度，可读/写任意他人会话 | P1 | `runtime/node/backend/src/routes/khySessions.js:52` |
| AGT-04 | OS 级沙箱与 agent 实际 shell 执行完全脱钩 | P1 | `runtime/node/backend/src/services/tool/toolSandbox.js:541` |
| SEC-01 | 跨设备同步 WS 无认证 + 身份自填 + 会话无对象级鉴权 | P1 | `runtime/node/backend/src/services/crossPlatform/ws/syncServer.js:197` |
| SEC-02 | XFF 可伪造，全站限流（含登录防爆破）可绕 | P1 | `runtime/substrate/platform/packages/shared/src/middleware/rateLimit.js:14` |
| DB-01 | 账号池租约无 CAS，同一上游账号可被双租约 | P1 | `runtime/node/backend/src/services/accountPool.js:1055` |
| DB-02 | 任务看板终态/重排队无状态守卫，done 可被改回 ready | P1 | `runtime/node/backend/src/coordinator/taskBoard.js:203` |
| DB-03 | 大任务 claimTask 无租约/状态校验，跨进程可双认领 | P1 | `runtime/node/backend/src/tasks/largeTaskRuntimeStore.js:1434` |
| FE-01 | useResponsive 的 .js 覆盖 .ts，K 线渲染路径抛 TypeError | P1 | `delivery/channel/khyquant/frontend/src/composables/useResponsive.js:11` |
| DEP-03 | axios 1.19.0 命中两个 High 公告（socket 劫持 + ReDoS） | P1 | `runtime/node/backend/package.json:107` |
| DEP-04 | undici 7.29.0 命中 TLS 校验绕过（High） | P1 | `runtime/node/backend/package.json:139` |
| DEP-08 | pack-executable.js ROOT 少算一级，发布构建第一步 ENOENT | P1 | `works/ship/build/pack-executable.js:18` |
| DEP-11 | backend jest 深红（79 suite 失败），PR 门整 job 不阻断 | P1 | `.github/workflows/pr-gate.yml:500` |
| REL-02 | Docker 镜像装 PyPI latest 而非 tag 版本 | P1 | `Dockerfile:107` |
| REL-03 | npm 签名步对 `--dry-run` 打印出的文件名签名 | P1 | `.github/workflows/dual-channel-release.yml:144` |
| REL-04 | 黄金路径 pypi 分支仍读 dist/，D9 永远 SKIP | P1 | `scripts/ci/check-golden-path.js:158` |
| REL-05 | DB 自动迁移版本锚点在 pip/npm 渠道恒为 0.0.0 | P1 | `runtime/node/backend/src/bootstrap/dbAutoMigration.js:36` |
| REL-06 | release-gate 的 must 阶段要求 khy 在 PATH，CI 从未安装 | P1 | `scripts/release/lib/releaseGateStages.js:105` |

---

## 第三章 问题详细清单

**组织方式**：每条问题以「编号 ｜ 标题」为标题行，随后列出题述 13 项字段（风险等级 / 涉及模块 / 涉及文件 / 具体代码位置 / 问题描述 / 触发条件 / 复现步骤 / 实际影响 / 根本原因 / 修复建议 / 建议测试 / 是否已确认——编号与标题合并于标题行）。「是否已确认」一栏给出判定与依据；依据为门禁命令的注明命令名，为本会话实跑的探针/复现的注明「只读复现」。P0/P1 条目的「涉及文件」均带 `文件:行号`。

### 3.1 架构与债务（ARCH，21 条）

#### ARCH-01 ｜ cli/ 与 services/ 组成 197 节点的强连通分量，模块级循环依赖已失控
- **风险等级**：P1
- **涉及模块**：runtime/node/backend
- **涉及文件**：`runtime/node/backend/src/services/healEscalationService.js:487`
- **具体代码位置**：services→cli 倒挂边 + `archDebtScan --scc` 的巨型环
- **问题描述**：`node runtime/node/backend/scripts/archDebtScan.js --scc` 输出「最大强连通分量: 197 节点」。该环横跨 `src/cli/`（ai.js、aiChatCore.js、replSession.js、formatters.js、spinner.js、router.js、handlers/* 共 30+ 个）、`src/services/`（gateway/*、aiManagement*、apiKeyPool*、agenticHarnessService 等 140+ 个）、`src/tools/`、`src/routes/`、`src/coordinator/`、`src/jobs/`。另 R1 分层倒置 services→cli 实测 14 处，其中 `src/tools/AgentTool/index.js → src/cli/ai.js` 是懒加载倒挂边（check-core-layers 报 inversion-lazy warning）。
- **触发条件**：任何位于该环内的模块被 require 时；加载顺序由 Node 的 require 缓存和首次调用方决定。
- **复现步骤**：`node runtime/node/backend/scripts/archDebtScan.js --scc`（输出第 3 行「最大强连通分量: 197 节点」；第 6-10 行单边杠杆：移除 `services/healEscalationService.js:487 → cli/handlers/publish.js` 一条边可把环从 197 降到 119）。
- **实际影响**：197 个模块中任何一个都不能被独立加载、独立单测或独立替换——require 任一个都会拖进半张依赖图。改任一边缘的初始化副作用可能改变另一个模块看到的状态，且没有任何报错。新人无法回答「这个文件依赖什么」而不跑脚本。
- **根本原因**：services 层反向 require cli 层做输出/格式化（`healEscalationService.js:487 → ../cli/handlers/publish`、`aiManagementChatHttp.js:202/229 → ../cli/toolResultSummary、../cli/writeDiffRows`、`aiManagementServer.js:147 → ../cli/ai`、`a2a/executor.js:59 → ../../cli/ai` 等 14 处），cli 又反向 require services，双向成环。
- **修复建议**：按 archDebtScan 给出的贪心破环顺序逐刀：先切断 `services/healEscalationService.js:487 → cli/handlers/publish.js`（单边收益 78 节点），把 publish 的展示逻辑下沉为 services 可注入的 formatter 或事件，services 只发数据不调 cli。一次只切一刀并保留原 export 契约。
- **建议测试**：`node runtime/node/backend/scripts/archDebtScan.js --scc` 的「最大强连通分量」节点数单调下降；每切一刀后 src/ 下 node:test 套件（`npm run test:node:src`）失败集合逐名不变。
- **是否已确认**：已确认（脚本门禁：`node runtime/node/backend/scripts/archDebtScan.js --scc`）。

#### ARCH-02 ｜ 架构债棘轮现行工作区实红：27 项超基线，其中 20 个存量巨石文件在长胖
- **风险等级**：P1
- **涉及模块**：runtime/node/backend
- **涉及文件**：`runtime/node/backend/src/cli/replSession.js:1`
- **具体代码位置**：archDebtScan 全量扫描 vs `scripts/arch-debt-baseline.json`
- **问题描述**：`node runtime/node/backend/scripts/archDebtScan.js`（无参数，即 `pr-gate.yml:99` 的门禁步）退出码 1，末尾输出「⚠ 超出基线的【新增】架构债: 27 项 — CI 门禁失败」。其中 R2b「存量巨石只许减不许增」20 项全是增长：`replSession.js` 13917→13997、`toolUseLoopCore.js` 10794→11045、`ink-components/App.js` 7867→8218、`flagRegistry/index.js` 4042→4201、`router.js` 3412→3538 等。
- **触发条件**：任何触碰这 20 个文件的提交；在 CI 上是每个 PR。
- **复现步骤**：`node runtime/node/backend/scripts/archDebtScan.js`（输出第 60-86 行；`--baseline-stale` 另跑一次为 0 条悬空，证明基线本身有效，是真增长）。
- **实际影响**：`pr-gate.yml:98-99` 的「Check architecture debt (R1/R2/R2b/R3 vs baseline)」是阻断步，当前工作区一旦提交为 PR 这一课直接红。棘轮的语义是「只许减」，实测是 20 个文件同时增长——棘轮事实上已失效，维护者要么每次提交都看到红灯并习惯它，要么反复 `--update-baseline` 把基线拱手让出去。
- **根本原因**：基线是快照而非约束：`--update-baseline` 一行命令即可承认现状，而没有任何机制限制刷新频率或要求伴随拆分动作；R2b 的判据只看行数增减，不看拆分。
- **修复建议**：把 R2b 的刷新与拆分动作绑定：`--update-baseline` 时要求同一改动集内含对应文件的拆分校验（拆后原文件行数下降），否则拒绝刷新。对已超额的 20 个文件按 god-report 给出的「分节横幅」缝逐一切分。
- **建议测试**：`node runtime/node/backend/scripts/archDebtScan.js` 退出码 0；R2b 增长项数 = 0。
- **是否已确认**：已确认（脚本门禁：`node runtime/node/backend/scripts/archDebtScan.js`）。

#### ARCH-03 ｜ 第三方供应商基础 URL 在 backend / ai-backend / 三个前端重复硬编码，每个供应商散落 25+ 文件
- **风险等级**：P1
- **涉及模块**：runtime/node + delivery + apps
- **涉及文件**：`runtime/node/ai-backend/src/routes/ai.js:265`
- **具体代码位置**：供应商 baseUrl 字面量全仓分布
- **问题描述**：全仓扫描（roots: `runtime/node/backend/src`、`runtime/node/ai-backend/src`、`delivery/web/ai-frontend/src`、`delivery/channel/khyquant/frontend/src`、`apps/khyos-desktop/src`、`runtime/substrate/platform`）统计：`api.openai.com` 93 处 / 28 文件；`open.bigmodel.cn` 57 处 / 27 文件；`api.deepseek.com` 44 处 / 25 文件；`api.anthropic.com` 39 处 / 25 文件；`dashscope.aliyuncs.com` 14 处 / 9 文件。backend 侧已在 `docs/10_规范/registry/DATA-SSOT.json` 登记 `runtime/node/backend/src/services/gateway/providerPresets.js` 为「供应商预设端点真源」（该文件 :70/:87/:219/:236 持有四个 baseUrl），但 ai-backend 没有这份真源，自己在 `routes/ai.js:265/291/315/371/400` 与 `services/apiKeyPool.js:95/100/110/125/130` 各写一遍；前端侧 `delivery/web/ai-frontend/src/views/admin/AIGateway.vue`、`delivery/channel/khyquant/frontend/src/views/admin/Dashboard.vue`、`apps/khyos-desktop/src/main/keyManager/keyStore.ts` 又各写一遍。
- **触发条件**：供应商换域名/换 API 版本前缀、自托管部署、新增一个中转通道时。
- **复现步骤**：node -e 全仓正则清点；对照 `DATA-SSOT.json` 的 sources[] 与 `node scripts/ci/check-ssot-data.js`（后者只回「影子副本 0 · 值矛盾 0」，因为 providerPresets 之外的字面量根本没被登记为受管事实）。
- **实际影响**：「同一份端点事实有五处书写」。改域名时必须同时改 25+ 个文件，漏一个就出现「部分通道走到新主机、部分走到旧主机」的静默分叉——正是 AGENTS.md 规则 1 明文要防的场景。check-ssot-data 的绿灯会让人以为没有影子副本。
- **根本原因**：RUNTIME-001 的端点豁免只覆盖 localhost/回环与第一方生产域名，第三方供应商域名不在其判据内；`DATA-SSOT.json` 只登记了 11 条 fact（几乎全是端口），供应商端点被登记为 source 但没有任何守卫校验「非真源文件不得出现供应商域名字面量」。
- **修复建议**：在 check-ssot-data 的 scan.include 语料上加一条 detect：除 `providerPresets.js` / `serviceDefaults.js` 与其测试外，出现第三方供应商 baseUrl 字面量即报影子副本；ai-backend 改为从 workspace 包或共享常量导入（若物理上无法 import，按 LAYOUT-008 登记为授权镜像并写理由）。
- **建议测试**：`node scripts/ci/check-ssot-data.js` 对 providerPresets.js 之外的供应商域名报 finding；新增一个 adapter 时若硬编码 URL 即红。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-ssot-data.js`）。

#### ARCH-04 ｜ 1041 处 process.cwd() 拼数据路径，是根目录影子目录与垃圾文件的根因，且没有守卫管写入方
- **风险等级**：P1
- **涉及模块**：runtime/node/backend
- **涉及文件**：`runtime/node/backend/src/cli/khy.module.json:27`
- **具体代码位置**：cwd 相对写者遍布 backend/src
- **问题描述**：`runtime/node/backend/src/cli/khy.module.json:27` 自己写明「状态落盘一律走 utils/dataHome 解析器取址，不允许 `path.join(process.cwd(), ...)`」，但 git grep 统计 `process.cwd()` 在非测试文件里有 1041 处引用（392 个文件）。具体书写点：`src/cli/replSession.js:6253/:6266` 把 `khy-session-<stamp>.json/.md` 写进 cwd（仓库根实测存在 `khy-session-1794387211105.json`）；`src/services/dbHealthService.js:229` 拼 `cwd/khy-Trajectory/sessions.db`、:250/:1516/:988 拼 `cwd/.khy` 与 `cwd/.khy/checkpoints`；`src/services/deliveryLedger.js:67` 拼 `cwd/.khy-runtime`（第三种影子目录名）；`src/services/baseSelfCheckService.js:100` 拼 `cwd/.tmp/selfcheck.log`；`src/routes/largeTasks.js:137` 拼 `cwd/.khyquant`。
- **触发条件**：从任何一个非仓库根的目录启动 khy；或同一台机器上两个项目各起一份。
- **复现步骤**：`git grep -c "process.cwd()" -- "*.js"`（非测试 392 文件 / 1041 处，top: `replSession.js` 28、`toolUseLoopCore.js` 19）；`node scripts/ci/check-repo-layout.js` 报 `[error] root-shadow-dir`「仓库根出现 2 个影子数据目录…….khy, .khyos」。
- **实际影响**：check-repo-layout 已经把 `.khy/.khyos` 报成 error 并明确指出「某处仍在用 process.cwd() 拼数据家路径」，但守卫只看见产物（根上多了目录）看不见写入方，于是同一个 error 可以无限期复发。维护者清掉影子目录，下次从别的 cwd 启动又长出来。数据家寻址规则（LAYOUT-007）在 1041 处被绕过。
- **根本原因**：utils/dataHome 解析器存在但非强制；没有任何守卫把「`path.join(process.cwd(), …)` 用于状态落盘」判为违规，只有它造成可见垃圾后才由 root-shadow-dir 报出。
- **修复建议**：在 scripts/ci 增加一条静态判据（可挂 check-repo-layout 的既有框架）：非测试、非构建脚本的 src 代码里 `path.join(process.cwd(), …)` 作为写路径即报 finding，豁免清单走 khy-allow 注释并带理由；同时把 `replSession.js:6253`、`deliveryLedger.js:67`、`dbHealthService.js:229` 等改走 getDataHome/getDataDir。
- **建议测试**：新增一条 src 下用 cwd 拼写路径的代码即使门红；从 `D:\` 临时目录启动 khy 后仓库根不新增 `.khy/.khyos/khy-session-*.json`。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-repo-layout.js`）。

#### ARCH-05 ｜ COMMS-002 登记为 P1/enforced/gate=pr，执行面却恒为空（扫的是被 gitignore 的目录）
- **风险等级**：P1
- **涉及模块**：治理体系
- **涉及文件**：`scripts/ci/validate-json-schemas.js:130`
- **具体代码位置**：COMMS-002 执行器与登记 paths 脱节
- **问题描述**：`RULES-REGISTRY.json` 里 COMMS-002「ACP 方法登记制」priority=P1、gate=pr、nature=enforced、exec=`scripts/ci/validate-json-schemas.js`、paths=[`scripts/ci/json-schemas/**`, `runtime/node/backend/src/contracts/**`]。但执行器实际 walk 的是 `.khy/`（`validate-json-schemas.js:127-145`，注释自陈「.khy/ 是运行期状态且被 .gitignore 整体覆盖（实测 `git ls-files .khy` = 0 条）」）。实测运行 `node scripts/ci/validate-json-schemas.js` 退出码 0，输出两行：`[/json-schema] works/data/khy/ 被 .gitignore 覆盖（入仓文件 0 个）……跳过`；`[/json-schema] 注意：COMMS-002 登记的 paths 是 scripts/ci/json-schemas/** 与 runtime/node/backend/src/contracts/**，与本执行器实际扫描范围不一致，属待修缺陷。`
- **触发条件**：每次 PR（该步在 pr-gate 的 rules:gate 里；rules:gate 本身是 report-only）。
- **复现步骤**：`node scripts/ci/validate-json-schemas.js`（退出码 0，零文件被校验）；`node scripts/ci/check-wiring.js` 回「122 个检查器全部接线」——它只验「有门引用」，不验「扫到东西」。
- **实际影响**：一条 P1 强制规则在 CI 里一个文件都不校验，而规则覆盖率报告（rules:coverage）把它算作「已执行」的一分子，gov-status 据此报「阻断红线: 全部通过」。ACP 方法登记制实际处于零执行状态，任何人新增 transport 方法名而不登记 schema 都不会被拦。
- **根本原因**：真源目录从 `.khy/` 迁到 `works/data/khy/` 后执行器只改了错误提示文案，没改扫描根；登记表 paths 与执行器扫描范围从未对齐，而 check-wiring 的判据是「被引用」而非「有效」。
- **修复建议**：把执行器的扫描根改为登记表 paths（`scripts/ci/json-schemas/**` 与 `runtime/node/backend/src/contracts/**`），让 ACP schema 与 transport 实现互相校验；运行期 .khy 的校验另立一个 S1 观察者或直接删除该分支。
- **建议测试**：在 `src/contracts` 下放一个不符合 schema 的 ACP 方法定义，`node scripts/ci/validate-json-schemas.js` 退出码非 0。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/validate-json-schemas.js`）。

#### ARCH-06 ｜ check-gov-status 报「绿灯（可进入发布门）」，同期四个实守卫全红
- **风险等级**：P2
- **涉及模块**：治理体系
- **涉及文件**：`scripts/ci/check-gov-status.js:51`
- **具体代码位置**：治理状态总览的聚合范围
- **问题描述**：`node scripts/ci/check-gov-status.js` 输出「=== 总判定: 绿灯（可进入发布门）===」。其实现只聚合四件事（`check-gov-status.js:51-53` require `check-version-sync.js`、`ruleguard/lib/coverage.js`、`ruleguard/lib/ledger.js`，加 `collectWiringGaps`）：版本三轨道、规则覆盖率、抑制台账、治理接线。同一次会话里跑出来的实守卫全部是红的：check-repo-layout 退出码 1（5 error）、archDebtScan 退出码 1（27 项超基线）、check-core-layers 退出码 1（9 项 error）、check-debt-ledger 退出码 1（13 error）。
- **触发条件**：任何人看治理仪表盘做放行决定时。
- **复现步骤**：`node scripts/ci/check-gov-status.js`（绿灯）对照 `node scripts/ci/check-repo-layout.js` / `node runtime/node/backend/scripts/archDebtScan.js` / `node scripts/ci/check-core-layers.js` / `node scripts/ci/check-debt-ledger.js`（均退出码 1）。
- **实际影响**：这是「治理自身的自洽」与「业务质量」被混成一个指标的最直接证据：仪表盘亮绿灯的同一分钟，架构债、层级、债务台账三门全红。按仪表盘放行的人会得到与事实相反的结论。
- **根本原因**：gov-status 的设计目标是「治理机制是否健全」（版本对不对、规则有没有执行器、台账有没有漂），从未声称覆盖质量读数；但它的输出文案「可进入发布门」让读者把它当成健康总检。
- **修复建议**：把输出文案改成它实际覆盖的范围（如「治理机制自洽性：通过」），并在同屏附上四个实守卫的退出码摘要，或直接把 archDebtScan / check-repo-layout / check-core-layers / check-debt-ledger 的退出码纳入总判定的必要条件。
- **建议测试**：在 check-repo-layout 报 error 的状态下，`node scripts/ci/check-gov-status.js` 不得输出「绿灯（可进入发布门）」。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-gov-status.js`）。

#### ARCH-07 ｜ scripts/ci 下 120 个执行器只有 35 个进 PR 门，70 个只靠 npm run 主动触发，总门是 report-only
- **风险等级**：P2
- **涉及模块**：治理体系
- **涉及文件**：`.github/workflows/pr-gate.yml:240`
- **具体代码位置**：守卫接线覆盖面
- **问题描述**：清点 scripts/ci 下 120 个 `.js/.mjs/.cjs/.py`：被 `.github/workflows` 任一文件直接引用的 38 个，其中被 `pr-gate.yml` 引用的 35 个；只能经 package.json 的 `check:*` 触发的 70 个；从不被任何 workflow / package.json / quality-gate / hooks 引用的 12 个（annotate-patterns.js、check-core-safety.js、check-f2e-spec.js、check-f2e-wiring.js、check-frontend-tokens.js、check-secrets-staged.js、check-traffic-log.js、codemod-f2e-bridge-mobile.js、export-pyproject-dependencies.py、lint-debt-tracker.js、security-scan.js、test-a2a-mcp-server-smoke.js；check-wiring 自报 11 个零接线，差异在 check-secrets-staged.js 被登记进 wiring-exemptions.json）。唯一能一次跑完的「总门」rules:gate 在 `pr-gate.yml:240-242` 是 `continue-on-error: true` 的 report-only。
- **触发条件**：维护者以为「写了守卫就被执行」时。
- **复现步骤**：脚本比对 scripts/ci 目录 vs `.github/workflows` + 全部 package.json + `scripts/quality-gate` + `scripts/hooks` 的文本包含关系；`node scripts/ci/check-wiring.js` 回「122 个检查器全部接线（豁免 11 项）」。
- **实际影响**：70 个守卫（占 58%）的运行完全取决于维护者是否记得敲那条 npm run。check-wiring 的判据是「被某个门引用」——package.json 的 check:* 别名也算「引用」——所以它为这个状态开绿灯。治理代码 103,409 行（scripts/ 全量，394 文件），其中 scripts/ci 39,578 行，实际每个 PR 强制执行的只有 35 个文件对应的那部分。
- **根本原因**：「接线」的定义是「有地方提到这个文件名」，而不是「有地方在每个 PR 上跑它」；rules:gate 作为总门本可弥补，但它自己是 report-only。
- **修复建议**：把 check-wiring 的判据细分为「pr 门引用 / 仅 package.json / 零接线」三档并分别设定红线（零接线必须带到期日，仅 package.json 的应列出理由）；在 rules:gate 转阻断的前置条件全部满足后删除 `pr-gate.yml:241` 的 continue-on-error。
- **建议测试**：`node scripts/ci/check-wiring.js` 输出按三档分别计数；新增一个只被 package.json 引用的守卫时给出 warning。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-wiring.js`）。

#### ARCH-08 ｜ 债务台账自报数与实测脱钩：10 项指标上漂，1 项 status=closed 而实测 38
- **风险等级**：P2
- **涉及模块**：治理体系
- **涉及文件**：`scripts/ci/check-debt-ledger.js:1`
- **具体代码位置**：台账 measured 字段 vs `--remeasure` 实测
- **问题描述**：`node scripts/ci/check-debt-ledger.js`（不带 --remeasure）退出码 1：21 条台账，open 14 / closed 7，2 条逾期 12 天（layout.cross-layer-require、layout.dangling-task，due 均 2026-10-31）无 slipped 痕迹，6 条 closed 超 30 天未复验。加 `--remeasure` 后退出码 1 且 error 升至 13 条：layout.floor-closed-set 台账 measured=0/status=closed，实测 38；standards.functionLines 自报 2390 实测 2477；standards.nestingDepth 9467→9553；standards.consoleLog 5121→5199；standards.fileLines 424→436；delivery.surface-handlerFiles-ratchet 158→167；layout.domain-direction 195→199；layout.functional-unit 263→272。另 layout.root-top-level 的实测回调 ETIMEDOUT 失败，measured 仍是自报数。
- **触发条件**：按台账数字判断「债务在收敛」时。
- **复现步骤**：`node scripts/ci/check-debt-ledger.js` 与 `node scripts/ci/check-debt-ledger.js --remeasure`（后者约 3 分钟，输出 remeasure-drift 共 10 条）。
- **实际影响**：D7「债务可收敛」判 GAP（check-delivery-baseline --json 实测 detail: check-debt-ledger 退出码 1）。台账是唯一让人相信「存量豁免在单调递减」的东西，而它 10/21 项与实测不符且全部朝坏的方向漂。更糟的是 closed 项里有假的——读台账的人会认为那是已清零的。
- **根本原因**：measured 是人工填的自报数，复验（--remeasure）从不进门；台账的 status=closed 只要求自报 measured===0，不要求实测。
- **修复建议**：把 `--remeasure` 接进 commit 或 pr 门（或至少每日一次并写入 artifact），让 measured 只能来自实测；closed 项改为「实测为 0 且连续 N 次复验为 0」才允许置 closed。
- **建议测试**：`node scripts/ci/check-debt-ledger.js --remeasure` 退出码 0（remeasure-drift 与 entry-overdue 均为 0）。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-debt-ledger.js --remeasure`）。

#### ARCH-09 ｜ 28 个巨石文件 >2500 行（最大 13997 行），同时 674 个超 400 行文件被 managedOnly 豁免
- **风险等级**：P2
- **涉及模块**：runtime/node/backend
- **涉及文件**：`runtime/node/backend/src/cli/replSession.js:1`
- **具体代码位置**：archDebtScan `--god-report` 与 ARCHITECTURE-POLICY.json 的 managedOnly
- **问题描述**：`node runtime/node/backend/scripts/archDebtScan.js --god-report` 报「超限文件: 28 个」（上限 2500 行）：`replSession.js` 13997、`toolUseLoopCore.js` 11045、`tui/ink-components/App.js` 8218、`aiGatewayGenerateMethod.js` 7007、`aiChatCore.js` 5269、`useQueryBridge.js` 4562、`flagRegistry/index.js` 4201、`aiManagementServer.js` 3880、`toolCalling.js` 3705、`router.js` 3538、`claudeAdapter.js` 3512、`prompts.js` 3328、`codexAdapter.js` 3176……另 `node scripts/ci/check-zcode-baseline.js` 报「纳管 557 文件 · 违规 8 ‖ legacy 未纳管 3444 文件 · 超标 674（豁免，逐模块迁移）」——ARCHITECTURE-POLICY.json 的 `global.maxFileLines=400` 配 `managedOnly=true`，而 `src/services`、`src/cli`、`src/tools`、`src/utils`、`src/routes`、`src/agents` 六个根全部 `managed:false`，即 28 个巨石文件所在的区域整体豁免。
- **触发条件**：任何需要读懂或修改这 28 个文件的任务。
- **复现步骤**：`node runtime/node/backend/scripts/archDebtScan.js --god-report`；`node scripts/ci/check-zcode-baseline.js`（第 6 行 GAP 明细）；`docs/10_规范/registry/ARCHITECTURE-POLICY.json` 的 modules[] 里 services/cli/tools/utils/routes/agents 六项 managed=false。
- **实际影响**：策略文件写着「单文件 ≤400 行」，实际约束的是 557 个文件中的 8 个违规，放过了 3444 个文件里的 674 个违规。维护者看到的是一条已被满足的策略，而不是「本仓 28 个文件超上限 5.6 倍」的事实。合并冲突也集中在这 28 个文件上。
- **根本原因**：ZCode 迁移模型的 managedOnly 设计本意是「先纳管种子模块再逐步扩大」，但扩大动作停在了 77 个小 domain/ 子目录，六个主根从未翻管。
- **修复建议**：把 `src/cli`、`src/services` 两个根按 domain/ 已拆分的粒度逐个子类翻成 `managed:true`（每翻一个，其下超标文件即进入棘轮）；翻管顺序按 god-report 的行数降序，先 `replSession.js` 与 `toolUseLoopCore.js`。
- **建议测试**：`node scripts/ci/check-zcode-baseline.js` 的「legacy 未纳管文件数」单调下降；每翻管一个子类，对应超标文件数有归零计划。
- **是否已确认**：已确认（脚本门禁：`node runtime/node/backend/scripts/archDebtScan.js --god-report`）。

#### ARCH-10 ｜ 真空守卫：forbidDeepImports 因为 0 个模块声明入口而永远不可能触发
- **风险等级**：P2
- **涉及模块**：治理体系
- **涉及文件**：`scripts/ci/check-zcode-baseline.js:1`
- **具体代码位置**：ARCHITECTURE-POLICY.json 的 publicEntrypoints
- **问题描述**：`node scripts/ci/check-zcode-baseline.js` 输出「[PASS] 跨模块深引用（forbidDeepImports · managedOnly）……现状: 已声明入口的目标模块 0 · 深引用违规 0」。核对 `docs/10_规范/registry/ARCHITECTURE-POLICY.json` 的 83 个 modules[]，声明 publicEntrypoints 的为 0 个——没有任何模块声明公有入口，因此「是否经公有入口跨模块引用」这一判据没有比对基准，恒为 0 违规。同文件里「[PASS] 模块 import 环（forbidCycles · managed↔managed）……纳管互依模块 24 · 纳管间环 0」同理只覆盖 77 个纳管模块之间的边，依赖 legacy 的边不计。
- **触发条件**：任何跨模块深引用（本仓 37 处 cross-layer-require 由另一个守卫管，模块内深引用无人管）。
- **复现步骤**：`node scripts/ci/check-zcode-baseline.js`（第 24 行）；`node -e` 统计 ARCHITECTURE-POLICY.json modules[] 中 publicEntrypoints 字段数 = 0。
- **实际影响**：记分板上两个 PASS 是无法失败的判据。它们让人以为模块边界受控，实际上「深引用」这一整类问题没有任何机制在看。这与 check-repo-layout 报出的 37 处跨 workspace 深层相对 require 是同一问题的不同层级，后者至少真报了。
- **根本原因**：策略契约的 forbidDeepImports 需要模块方声明 publicEntrypoints 才能判定，而声明工作从未做；守卫选择了「无声明即无违规」而不是「无声明即报缺口」。
- **修复建议**：改为「已声明入口的模块才查深引用，未声明入口的模块计为 declared-entry-gap 并设基线棘轮」；或先为 77 个纳管模块批量声明入口（多数就是 index.js），让判据有比对基准。
- **建议测试**：新增一个跨模块 require 到对方内部文件（非 index.js）时，`node scripts/ci/check-zcode-baseline.js` 报 finding。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-zcode-baseline.js`）。

#### ARCH-11 ｜ entries/launch.js 仍指向 L1/L2 并入 runtime/ 之前的 services/backend，「免 Python 入口」已失效
- **风险等级**：P2
- **涉及模块**：entries
- **涉及文件**：`entries/launch.js:36`
- **具体代码位置**：CLI 路径常量
- **问题描述**：`entries/launch.js:36` `const CLI = path.join(ROOT, 'services', 'backend', 'bin', 'khy.js')`；该目录已不存在（`fs.existsSync('services')` = false，实际入口是 `runtime/node/backend/bin/khy.js`）。实测 `node entries/launch.js status` 退出码 1，输出「[ERROR] CLI 入口缺失：D:\Portable\khy-os\services\backend\bin\khy.js」。同文件 :11 与 :18 的注释、:103 的错误提示也都写 services/backend。`entries/README.md` 同样残留：:93-96 的自检命令 `node services/backend/node_modules/jest/bin/jest.js --config services/backend/jest.config.js`；:118「含 child_process……只能落 services/」；:109 声称「entries.json 单一真源。9 个端条目」而 entries.json 实测 7 条（desktop-legacy 与 mobile-legacy 已不在表内，README:61/:66 仍列着，:128-134 的「两个坑」也在描述已收口的事）。
- **触发条件**：按 README 用 `node entries/launch.js` 起端（没有 Python 的环境）。
- **复现步骤**：`node entries/launch.js status`（退出码 1，错误信息见上）；`node -e fs.existsSync('services')` → false。
- **实际影响**：README 把它作为「没有 Python 时的唯一通路」交付给维护者，实际一运行就失败。这是 2026-10 方案 P 物理化迁移（L1/L2 → runtime/）漏改的失效指针，且 entries/ 是被 git 跟踪的入仓三件套之一。
- **根本原因**：目录迁移只改了被守卫覆盖的面（check-repo-layout 的 unresolved-require = 0 说明 JS require 边都通了），entries/launch.js 用字符串拼路径不经 require，没有任何守卫校验它。
- **修复建议**：`:36` 改为 `path.join(ROOT, 'runtime', 'node', 'backend', 'bin', 'khy.js')`，同步 :11/:18/:103 注释与 README:93-96/:118 的自检命令；README:61/:66/:109/:128-134 按 entries.json 实测的 7 条重写。
- **建议测试**：`node entries/launch.js status` 与 `node entries/launch.js list` 退出码 0；README 中每条命令实际可执行。
- **是否已确认**：已确认（脚本门禁：`node entries/launch.js status`）。

#### ARCH-12 ｜ BUILD-OUTPUTS.json 登记的产物根大多不存在，实际构建配置写到别处，另有 4GB/21GB 未登记产物
- **风险等级**：P2
- **涉及模块**：delivery + apps
- **涉及文件**：`apps/khyos-desktop/package.json:74`
- **具体代码位置**：构建产物单一根（LAYOUT-005）登记表 vs 各构建配置
- **问题描述**：`docs/10_规范/registry/BUILD-OUTPUTS.json` 登记 30 个 output，其中 `entries/electron/out`、`entries/electron/renderer`、`entries/electron/dist-electron`、`entries/ai-frontend`、`entries/khyos-desktop-dist`、`entries/portable`、`entries/flutter-android` 在磁盘上全部不存在（实测 fs.existsSync 均为 false）。实际写入方：`apps/khyos-desktop/package.json:74` electron-builder `directories.output = "dist-electron"`（本地实测 dist-electron 772.9MB + dist-electron-pet 810MB + dist-electron-pkg 653.6MB + dist-electron-3d 367.5MB = 2.6GB，四个变体并存）；`delivery/web/ai-frontend/vite.config.js` 无 outDir 覆盖（默认 dist）；`delivery/channel/khyquant/frontend/vite.config.js:116` `outDir: 'dist'`；`delivery/brand/khyos-desktop/out` 实测 4039.6MB / 4168 文件（gitignore 命中，但 BUILD-OUTPUTS.json 无对应条目）；`delivery/mobile/khy-os-client-app` 实测 21.23GB（android/ 11.26GB + build/ 7.40GB + .dart_tool/ 2.87GB）。
- **触发条件**：任何一次构建；以及任何想「产物在哪」的时候。
- **复现步骤**：fs.existsSync 逐条核对 BUILD-OUTPUTS.json 的 `outputs[].path`；node -e 递归测量上述目录体积。
- **实际影响**：LAYOUT-005 的「一切可再生构建产物落 `entries/<producer>`」在登记表层面成立、在物理层面不成立。entries/README.md:33-36 自己承认「产物子目录目前大多还不存在……四端里只有终端是现成可用的」。后果是本地磁盘 25GB 级的构建缓存散落在包内，而登记表指向的空目录让 check:build-root 无从校验；新克隆的人按登记表找不到任何产物。
- **根本原因**：迁移只搬了登记表，没搬各工具的 outDir；且没有守卫校验「登记的 path 存在」或「构建配置的 outDir 与登记表一致」。
- **修复建议**：把 `apps/khyos-desktop/package.json:74` 的 output 改为 `entries/electron/dist-electron`（同步 asarUnpack 的 out/host 前缀）、两个前端的 outDir 改为 `entries/<producer>/`、`delivery/brand/khyos-desktop/out` 与 mobile 的 android/build 补登 BUILD-OUTPUTS.json；并给 check-build-root 加一条「登记 path 与构建配置 outDir 双向一致」的判据。
- **建议测试**：`node scripts/ci/check-build-root.js` 对 outDir 与登记表不一致的包报 finding；构建后 BUILD-OUTPUTS.json 每条 path 均存在。
- **是否已确认**：已确认（只读复现：node -e fs.existsSync 核对 + 目录体积递归测量）。

#### ARCH-13 ｜ check-agent-rules --changed 只扫暂存区：实测 28 个文件被扫，402 个文件与 HEAD 有差异
- **风险等级**：P2
- **涉及模块**：scripts/ci
- **涉及文件**：`scripts/ci/check-agent-rules.js:337`
- **具体代码位置**：listChangedFiles() 的优先级顺序
- **问题描述**：`check-agent-rules.js:337-341` 的优先级是：`GIT_BASE_REF` → `git diff --cached`（暂存区）→ `git diff HEAD`。即只要暂存区非空，就只看暂存区。实测 `git diff --name-only --cached --diff-filter=ACMR` = 28 个文件（全是 apps/khyos-desktop 的 agentbus 相关），而 `git diff --name-only --diff-filter=ACMR HEAD` = 402 个文件。跑 `node scripts/ci/check-agent-rules.js --changed` 输出「Agent rule check passed: no violations found (28 file(s) scanned)」——374 个改动文件一个都没打开。AGENTS.md 把这条命令写成本地检查入口（「运行：`node scripts/ci/check-agent-rules.js --changed`」）。
- **触发条件**：本地 git add 了一部分文件后运行该命令（最常见的状态）。
- **复现步骤**：`git diff --name-only --cached --diff-filter=ACMR`（28）对照 `git diff --name-only --diff-filter=ACMR HEAD`（402）；`node scripts/ci/check-agent-rules.js --changed`（扫 28）。
- **实际影响**：RUNTIME-001~005 五条工程红线（零硬编码/状态透明/活动式超时/无滚动区 UI/CLI 错误标准化）的本地把关在实际使用中只覆盖暂存区。只要养成了「先 add 再 check」的习惯，未 add 的改动永远绿灯——而门读到的是通过。CI 侧因为设了 GIT_BASE_REF 不受影响，所以这个缺口只在本地存在，恰好是 AI 助手与人最依赖的那一环。
- **根本原因**：listChangedFiles() 的设计假设是「暂存区即本次改动集」，对「边改边 add」的工作流不成立；且没有把「改动集被收窄」这件事报出来（scanNotices 机制存在但此处未用）。
- **修复建议**：把三者合并：staged ∪ (HEAD diff) ∪ untracked，而不是取首个非空；或在只用暂存区时通过 scanNotices 明确打印「另有 N 个已修改未暂存文件未纳入本次扫描」。
- **建议测试**：在 402 个改动文件的状态下运行 --changed，scanned 数应 ≥ 改动文件数；人为只在 1 个文件里写 `localhost:3000` 且不 add，命令应报 finding。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-agent-rules.js --changed`）。

#### ARCH-14 ｜ 文档与代码漂移已成规模：101 个失效 npm run 命令、docs:verify 68 处缺孪生且无门、AGENTS.md 的 html 计数错一倍
- **风险等级**：P2
- **涉及模块**：docs
- **涉及文件**：`AGENTS.md:221`
- **具体代码位置**：文档主张 vs 仓库事实
- **问题描述**：四项实测：(1) `node scripts/ci/check-repo-layout.js` 报 `dangling-task=101`——2184 条 npm run 引用散在 386 个 md 文件里，其中 101 个目标在全部 package.json 中无定义（如 docs 写 `npm run check-proposal-index` 而真名是 `check:proposal-index`、`check-tui-gates` vs `check:tui-gates`）；(2) `node scripts/docs/verify_docs_site.js`（AGENTS.md:226 指定的权威口径）退出码 1，「✗ 失败：68 个问题」，缺孪生的包括 docs/html 下 DESIGN-ARCH-195~212 十余篇、[DESIGN-LAY-009]、规则卡 [LAYOUT-008]，以及 third_party/quickjs 的 16 个 README；该脚本不被任何 workflow 引用（只在 package.json 与 CODEOWNERS 出现）；(3) AGENTS.md:221 写「全仓 3000+ 个 .html 孪生」，实测 `git ls-files "*.html"` = 1400，docs:verify 报「生成 HTML：1512」；(4) `node scripts/ci/check-doc-numbers.js` 报 12 处数值主张不符：10 处文档写 `MAX_GATES=237` 而 `scripts/ci/check-tui-gates.js:50` 实为 242，[DESIGN-ARCH-073]:236 写 `MAX_RETRIES=3` 而 `amooKhyClient.js:67` 实为 2，[DESIGN-FE-013]:174 写 `IDLE_LIMIT_MS=60` 而 `runtime/node/ai-backend/src/routes/news.js:76` 实为 30000。另 `check-doc-claims.js` 报 29 处端点主张在源码中查无此串（如 [DESIGN-API-003] 写 `/api/v1/large-tasks`，代码挂的是无版本前缀路径）。
- **触发条件**：任何人照文档执行命令、或按文档数字判断现状时。
- **复现步骤**：`node scripts/ci/check-repo-layout.js --list=dangling-task`；`node scripts/docs/verify_docs_site.js`；`git ls-files "*.html" | wc -l`；`node scripts/ci/check-doc-numbers.js`；`node scripts/ci/check-doc-claims.js --list=endpoint-claim-unsupported`。
- **实际影响**：「文档写了但命令不存在」有 101 处，维护者（尤其是按文档干活的 AI）会连续撞墙；docs:verify 红着但没有任何门看它，于是 68 个缺孪生的文档可以一直缺；AGENTS.md 这条「高频误判」提示本身数字错了一倍，而它指向的权威口径输出的是 1512 且伴随 68 个失败。
- **根本原因**：三个 doc-* 守卫全是 S1 观察者（恒 exit 0）；docs:verify 完全没接线；dangling-task 有基线棘轮但基线就是 101（不升即不报），没有任何机制去降它。
- **修复建议**：把 docs:verify 接进 pr-gate 的 contract-checks（先 report-only 一个迭代再转阻断）；把 AGENTS.md:221 的 3000+ 改为由 docs:verify 输出填充或直接删掉该数字只留「以 `npm run docs:verify` 输出为准」；dangling-task 的 101 项按 owner=docs 逐批订正（多数是漏冒号）。
- **建议测试**：`node scripts/docs/verify_docs_site.js` 退出码 0；`node scripts/ci/check-repo-layout.js` 的 dangling-task 计数单调下降。
- **是否已确认**：已确认（脚本门禁：`node scripts/docs/verify_docs_site.js`）。

#### ARCH-15 ｜ D4「校验不得被吞」只覆盖发布链，PR 门 9 处 continue-on-error 全在判据外；security-scan 的密钥扫描名不副实
- **风险等级**：P2
- **涉及模块**：.github/workflows
- **涉及文件**：`scripts/ci/check-delivery-baseline.js:425`
- **具体代码位置**：D4 判据的 targets 与 pr-gate 的上报档步骤
- **问题描述**：`check-delivery-baseline.js:425` 的 D4 targets = `['.github/workflows/dual-channel-release.yml', ...walk('scripts/release')]`——只扫发布工作流和发布脚本。实测 12 个 workflow 里共 19 处 `continue-on-error: true`（build-executables 1 @86、codeowners 1 @50、frontend-ci 4 @86/96/149/156、native-ci 4 @65/88/106/146、pr-gate 9 @78/149/208/241/467/503/540/552/567），dual-channel-release.yml 与 sync-gitee.yml 为 0。pr-gate 的 9 处包括：rules:gate 总门（:240-242）、HQ 数据自洽（:207-209）、runtime-footprint（:148-150）、整个 test-baseline job（:503，注释自陈「已知基线：tests/cli + tests/utils 取样中 4 suite / 9 用例失败」）、jest / test:node / TUI leak 三步（:540/:552/:567）、lint-ratchet 的 modified-files 步（:467）。另 security-scan job 名为「Secret scan (PR diff only)」（`.github/workflows/pr-gate.yml:801-813`），实现是 `git log --all … head -20 … git show "$commit" --pretty=format:"%B" --no-patch | grep -iE 密钥模式`——只读 20 笔提交的提交信息正文，不读任何文件内容，也不限定在本 PR。
- **触发条件**：PR 合并前的质量判定；以及「PR diff 里没有密钥」这一结论。
- **复现步骤**：逐文件正则清点 `.github/workflows`；读 `scripts/ci/check-delivery-baseline.js:425`；读 `.github/workflows/pr-gate.yml:801-813`。
- **实际影响**：D4 报 PASS（detail: 发布链上无被吞掉的校验类步骤）会让人以为「校验不是可选项」已落实，而日常 PR 门上 9 个校验步骤实际不阻断——其中 rules:gate 是能一次跑完 89 条执行器的总门。security-scan 那步更是给出一个比实现强得多的承诺：它既不看 diff 也不看文件内容。
- **根本原因**：D4 的判据范围被限定在发布链（作者的理由是发布链不可重放），PR 门的上报档从未纳入；security-scan 那步的注释与实现对不齐，从写下起就没有人核过它扫的是什么。
- **修复建议**：D4 增加第二组 targets（`.github/workflows/pr-gate.yml`），对上位档 continue-on-error 要求「同一 job 内有等强度的阻断项或登记到期日」；把 `pr-gate.yml:801-813` 改成真实扫 PR diff 的文件内容（`git diff $BASE..HEAD | grep -iE 模式`），或把步骤名改为它实际做的事。
- **建议测试**：`node scripts/ci/check-delivery-baseline.js` 的 D4 对 pr-gate.yml 新增一处无登记的 continue-on-error 报 finding；在 PR diff 的某文件里放入 `sk-` 开头字符串，security-scan 步报 error。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-delivery-baseline.js --json`）。

#### ARCH-16 ｜ pr-gate 里 rules:gate 保持 report-only 的两条理由之一已静默满足，决策记录过期
- **风险等级**：P3
- **涉及模块**：.github/workflows
- **涉及文件**：`.github/workflows/pr-gate.yml:232`
- **具体代码位置**：rules:gate 转阻断的前置条件清单
- **问题描述**：`pr-gate.yml:230-239` 列了 rules:gate 暂不阻断的三条理由，其中第 2 条是「`scripts/ci/check-code-standards.js` 与 `check-protocol-naming.js` 目前尚未纳入版本控制（git ls-files 无记录），CI 检出里不存在这两个文件」。实测 `git ls-files scripts/ci/check-code-standards.js scripts/ci/check-protocol-naming.js` 两个文件都返回路径（已入仓），git log 显示它们在 `7bfc49d9` 目录迁移收口时已提交。
- **触发条件**：有人按这段注释判断「还不能转阻断」时。
- **复现步骤**：`git ls-files scripts/ci/check-code-standards.js scripts/ci/check-protocol-naming.js`（均有输出）；`git log --oneline -2 --` 这两个文件。
- **实际影响**：三条前置条件里最可验证的一条已经消失，但门仍是 report-only。结果是 ARCH-07 描述的状态（70 个守卫不进 PR 门）被一条过期理由无限期锁住，而没有人会去重新数条件。
- **根本原因**：前置条件是写在注释里的自然语言，没有任何机制在条件满足时提醒；条件本身（git ls-files）是可机判的却没有被机判。
- **修复建议**：把这三条前置条件搬进 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` 作为可机判的 entry（如 `filesTracked: [...]`），由 check-rollout-stage.js 或 check-gov-status.js 复算；满足即打印「可升档」提示。
- **建议测试**：在 check-code-standards.js 被 `git rm --cached` 的状态下该条目翻红，恢复后转绿并提示可升档。
- **是否已确认**：已确认（脚本门禁：`git ls-files scripts/ci/check-code-standards.js scripts/ci/check-protocol-naming.js`）。

#### ARCH-17 ｜ backend/src 独有 1250 个 KHY_* 环境变量名、2079 处读取，运行时行为由不可见的 ambient 状态决定
- **风险等级**：P2
- **涉及模块**：runtime/node/backend
- **涉及文件**：`runtime/node/backend/src/utils/flagRegistry/index.js:1`
- **具体代码位置**：环境变量配置面
- **问题描述**：`git grep -oh "process\.env\.KHY_[A-Z0-9_]*" -- runtime/node/backend/src` 得 2079 处读取、1250 个不同名字。`flagRegistry/index.js`（4201 行）登记 535 条，`check-tui-gates.js:50` 的 `MAX_GATES=242` 只约束 `cli/tui/` 一域。即登记表覆盖了 1250 个名字中的 535 个，剩下 715 个散落读取、无默认值文档、无中央登记。全仓口径（含 ai-backend、前端、desktop、mobile、scripts）严格正则清点得 2023 个不同 `KHY_*` 名字、8597 处读取点。
- **触发条件**：排查「为什么这台机器上行为不一样」；以及设置任何一个 KHY_* 变量时。
- **复现步骤**：`git grep -oh "process\.env\.KHY_[A-Z0-9_]*" -- runtime/node/backend/src | sort -u | wc -l` → 1250；`node scripts/ci/check-flag-registry.js` 只回「registry table is structurally sound」。
- **实际影响**：没有任何人能枚举这个系统的配置面。一个 env 忘了设（或多设了）就改变行为，而复现问题的人不知道有这颗变量存在。flagRegistry 的守卫只检查「登记表自身结构良好」，不检查「读取点是否都登记了」——所以 715 个未登记读取可以无限增长。
- **根本原因**：环境变量是本仓事实上的第二配置层（第一层是 `constants/serviceDefaults.js`），但没有「新增 KHY_* 必须登记」的判据；check-flag-registry 校验的是表不是代码。
- **修复建议**：给 check-flag-registry 加一条反向判据：src 下 `process.env.KHY_*` 的读取点必须能在 flagRegistry 找到同名条目（或走 khy-allow 豁免并写理由），未登记读取按基线棘轮只降不升。
- **建议测试**：新增一处 `process.env.KHY_NEW_THING` 读取而不登记时，`node scripts/ci/check-flag-registry.js` 报 finding。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-flag-registry.js`）。

#### ARCH-18 ｜ 仓库根状态被守卫报 5 个 error：vibe_images 未登记层级、28 个事故残留、.khy/.khyos 影子目录
- **风险等级**：P2
- **涉及模块**：仓库根
- **涉及文件**：`scripts/ci/check-repo-layout.js:1`
- **具体代码位置**：check-repo-layout 的 error 级 finding
- **问题描述**：`node scripts/ci/check-repo-layout.js` 退出码 1，5 个 error：root-whitelist（`oc_files.txt`，27KB）、root-shadow-dir（`.khy`、`.khyos`，守卫注明「意味着某处仍在用 process.cwd() 拼数据家路径」）、root-junk（28 个临时/事故残留：24 个 `.tmp-*.cjs`、`'+fs.readdirSync(p).join('`、`datetime('now')`、`NUL`、`x.frame`、`本报告写入`、`自动化任务产出。范围上限与提交边界见本报告`、`out.tmp`、`khy-session-1794387211105.json`）、layer-registry（`vibe_images`——9 个入库 PNG，2026-11-07/08 由本机其他进程创建，docs 里 [DESIGN-ARCH-203]:669 自己记录了它的 CreationTime 并说明「不是本文造成的」，至今未登记）。另有 root-uncatalogued 37 项、domain-direction 199 处、cross-layer-require 37 处、functional-unit 272 处、entry-buffer 2409 处 warning。
- **触发条件**：新克隆者的第一印象；以及每次跑 check:layout。
- **复现步骤**：`node scripts/ci/check-repo-layout.js`（输出第 5-24 行）；`node -e fs.statSync` 逐个确认上述残留文件存在（实测 `'datetime('now')'` 255B、`NUL` 92B、`x.frame` 0B、`本报告写入` 0B、`自动化任务产出…` 0B、`oc_files.txt` 27674B、`out.tmp` 2400B、`khy-session-1794387211105.json` 2B，`.khy/.khyos` 为目录）。
- **实际影响**：这是 1.3 万文件仓库的门面：根上有 37 个未登记实体、28 个文件名像一次失败的命令注入残留（`'+fs.readdirSync(p).join('` 这种名字本身就是某次把代码当 shell 执行留下的）。pr-gate.yml:107 用 `--promote=root-whitelist,docs-index-first,layer-registry` 把其中三类升为阻断，所以这三个 error 在每个 PR 上都红。而 [DESIGN-ARCH-203] 的记录显示这些文件是「本机其他进程」持续产生的——清掉还会再来。
- **根本原因**：有两个并行的失控写入源：(1) ARCH-04 的 cwd 相对数据路径制造 `.khy/.khyos` 与 `khy-session-*.json`；(2) 某个人工/自动化流程把 Node 代码片段当 shell 命令执行，在根上留下 0 字节的代码碎片文件名。vibe_images 则是新增顶层目录未走 [DESIGN-LAY-005] 的登记流程。
- **修复建议**：按根因分工：`.khy/.khyos/khy-session-*.json` 由 ARCH-04 的修法止住；28 个残留按 LAYOUT-004「只隔离不删除」进 `.khyos/housekeeping/<日期>/` 并留 manifest；vibe_images 要么补 [DESIGN-LAY-005] 第一节与 check-repo-layout.js 的 LAYERS/CROSSCUTTING 登记，要么说明它属于哪个既有层。
- **建议测试**：`node scripts/ci/check-repo-layout.js --promote=root-whitelist,docs-index-first,layer-registry` 退出码 0。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-repo-layout.js`）。

#### ARCH-19 ｜ ai-backend 是同一仓内的第二套 AI 网关实现（G2 版本轨道独立，代码大面积重写）
- **风险等级**：P2
- **涉及模块**：runtime/node/ai-backend
- **涉及文件**：`runtime/node/ai-backend/src/services/apiKeyPool.js:125`
- **具体代码位置**：ai-backend 与 backend 的同名服务
- **问题描述**：`runtime/node/ai-backend`（88 个 .js / 2.67 万行，仅 start/dev 两个脚本）自带 `services/gateway/aiGateway.js`（1009 行，backend 侧 2717 行）、`services/apiKeyPool.js`（578 行，backend 987 行）、`services/gateway/adapters/` 下 12 个 adapter、`services/gateway/tlsSidecar/`、`services/gateway/proxyServer.js`（738 vs 3106 行）、`services/toolCalling.js`（829 行，backend 的 `src/services/toolCalling.js` 只是 2 行再导出壳，真身在 `src/services/tool/toolCalling.js` 3705 行）、`services/securityGuardService.js`（896 vs 1233）、`services/knowledgeTeachingService.js`（1283 vs 1849）、`services/webSearchService.js`（144 vs 2568）、`services/modelTrainingService.js`（23 行壳）、`constants/serviceDefaults.js`（21 行）。按「>25 字符的相同行」比对共享长行：knowledgeTeachingService 422、securityGuardService 285、apiKeyPool 153、proxyServer 96、webSearchService 44。版本轨道上它是独立的 G2（1.6.5 vs G1 1.2.2），AGENTS.md 说明这是「捆绑单元随 pip wheel 共同发布」的有意设计。
- **触发条件**：修一个网关 bug、加一个供应商适配器、或改 apiKeyPool 的轮换策略时。
- **复现步骤**：逐文件行数 + 共享长行比对脚本；`node -e` 列出两棵 src/services 树的同名文件。
- **实际影响**：同一个能力（网关调用、密钥池、安全守卫、知识教学）有两份实现，修 bug 要修两处、加适配器要加两处、行为漂移没有任何守卫会发现。DATA-SSOT.json 的 scan.include 含 runtime/，但 facts[] 只有 11 条且几乎全是端口，所以 check-ssot-data 回「整文件副本 0 · 影子副本 0」——它对这套并行实现完全无感。
- **根本原因**：版本轨道独立（G2）被当成了「代码也可以独立」的许可；LAYOUT-008 允许「跨包镜像允许存在但必须登记，理由只能写物理上无法 import」，但这两份实现从未在 DATA-SSOT.json 登记为授权镜像。
- **修复建议**：二选一并写进登记表：要么把 ai-backend 的同名服务改为 require backend 的模块（若 wheel 打包物理上不可行，按 LAYOUT-008 登记为授权镜像并给出理由），要么在 DATA-SSOT.json 为每个重复服务建一条 fact 指明真源在哪一侧、另一侧为镜像，并让 check-ssot-data 校验两侧一致。
- **建议测试**：`node scripts/ci/check-ssot-data.js` 对 ai-backend 与 backend 的同名服务报镜像失步（改一侧不改另一侧即红）。
- **是否已确认**：已确认（脚本门禁：`node scripts/ci/check-ssot-data.js`）。

#### ARCH-20 ｜ check-change-safety 的 20 文件错误上限正在塑形模块边界（模块自己记录了为此合文件又拆文件）
- **风险等级**：P3
- **涉及模块**：apps/khyos-desktop + scripts/ci
- **涉及文件**：`scripts/ci/check-change-safety.js:68`
- **具体代码位置**：ERROR_CHANGED_FILE_COUNT 与 agentbus 模块的拆分决策
- **问题描述**：`check-change-safety.js:67-68` 定 `WARN_CHANGED_FILE_COUNT=8`、`ERROR_CHANGED_FILE_COUNT=20`；`pr-gate.yml:60-70` 的注释确认 error 级（>20 文件）阻断。`apps/khyos-desktop/src/main/agentbus/agentbusProtocol.ts:5-8` 的模块头写明「It is one file rather than five because scripts/ci/check-change-safety.js caps a change set at 20 files and this lane was over it」；`agentbusTransport.ts:1-9` 同样写「Split out of agentbusClient.ts (and merged down from three files) for the same reason as the pure module: scripts/ci/check-change-safety.js caps a change set at 20 files, and this lane was over it」。即为了凑文件数，五个纯模块被合并成一个 1047 行的文件，另一个模块又被拆出来。
- **触发条件**：任何超过 20 个文件的改动集（在 1.3 万文件仓里这很常见）。
- **复现步骤**：读 `apps/khyos-desktop/src/main/agentbus/agentbusProtocol.ts:1-12` 与 `agentbusTransport.ts:1-12`；读 `scripts/ci/check-change-safety.js:67-68`；读 `.github/workflows/pr-gate.yml:60-81`。
- **实际影响**：守卫的本意是「低成本模型单次 pass 的护栏」（脚本原文 high for a low-cost-model pass），实际效果是让人类与 AI 都把「怎么切文件」排在「怎么切模块」之前。这是治理直接扭曲生产代码结构的一处可查证据——被合并的 1047 行文件从此要在没有模块边界的情况下被阅读和测试。
- **根本原因**：文件数是变化集的粗糙代理指标，被当成了硬红线；而「改动集大小」与「模块边界合理性」是两个不同目标，前者压制了后者。
- **修复建议**：保留 >20 的 warning，把 error 限定在「>20 文件且跨 ≥3 个顶层目录」这类真正危险的情形；同时在 finding 的 detail 里说明本判据的出处是低成本模型护栏，不适用于人类的大重构（可用 --promote 之外的方式显式声明）。
- **建议测试**：agentbusProtocol.ts 的头注释不再以文件数上限作为合并理由；>20 文件但单目录的改动集不再触发 error。
- **是否已确认**：已确认（只读复现：node -e 读取 agentbusProtocol.ts:1-12）。

#### ARCH-21 ｜ 50 个单行再导出壳 + runtime/node/backend 根目录遗留物（.env.bak*×4、3 个 cpuprofile、NUL、遗留 .html 孪生）
- **风险等级**：P3
- **涉及模块**：runtime/node/backend
- **涉及文件**：`runtime/node/backend/src/services/toolUseLoop.js:1`
- **具体代码位置**：兼容壳与目录根遗留
- **问题描述**：(1) backend/src 下 50 个文件是 ≤3 行的 `module.exports = require(...)` 壳（toolUseLoop.js、toolCalling.js、toolCallParser.js、toolCallingPermissions.js、toolUseLoopHelpers.js、toolUseLoopCore.js、toolExecutionEngine.js、models/ApiKey.js、config/database.js、middleware/rateLimit.js 等）。LAYOUT-001 的 exception 明文允许「纯 re-export 单行壳（存量跨层转发，仅当保持单行）」，所以它们不违规，但代价是同一模块有两个可 import 路径（如 `src/services/toolCalling.js` 与 `src/services/tool/toolCalling.js`），grep 与跳转都会命中两个。(2) runtime/node/backend 根目录有未入仓遗留：`.env.bak-20260914-codexpin`、`.env.bak-20261009-fix`、`.env.bak-20261010`、`.env.bak-cleanup`、`.env`（均被 gitignore）、`repl.cpuprofile` 98KB、`status.cpuprofile` 187KB、`status2.cpuprofile` 241KB、`NUL` 92 字节、`NUL.baiduyun.uploading.cfg` 447 字节、`smoke_in.tmp.jsonl`、`smoke_serve.tmp.js`、`_doc.log`、`_qd.log` 343KB、`req-jest.log`、`ts-test.log`、`.tmp-test-out.txt`、`logs-flap.tmp.log`、`proxy-debug.log`、`.cbssp-test.log` 510KB。另有入仓的遗留孪生 AGENTS.html、CLAUDE.html、README.html、LINT-DEBT.html——AGENTS.md:3 自述「根级 .md 自 2026-09-28 裁决起不再生成 .html 孪生；旧 AGENTS.html 为遗留文件」。
- **触发条件**：在新机器上 clone 后第一次构建/排查时。
- **复现步骤**：`node -e` 清点 ≤3 行且以 `module.exports = require(` 开头的文件（50 个）；`node -e fs.readdirSync('runtime/node/backend')` 逐项列体积；`git ls-files runtime/node/backend` 确认 AGENTS.html/CLAUDE.html/README.html/LINT-DEBT.html 已入仓。
- **实际影响**：壳让「这个函数在哪」有两个答案，新人改错一份不会有任何报错（另一份仍然导出到真身）。根目录遗留让 check-repo-hygiene（只查跟踪面的文件名形态）回「无垃圾文件名形态」，而未跟踪面 510KB 的日志和 3 个 cpuprofile 无人管。
- **根本原因**：目录迁移采用「整包平移 + 壳保旧路径」，壳的退役没有排期；backend 根目录被当作临时文件堆放处（.gitignore 覆盖所以 git status 不显示）。
- **修复建议**：给 50 个壳定退役顺序：先统计每个壳的入向 require 数（本次审计已具备该图），零引用的一批按 RUNTIME-009 走 rollback.txt 后下线；根目录遗留按 LAYOUT-004「只隔离不删除」进 `.khyos/housekeeping/<日期>/` 并留 manifest；4 个遗留 .html 孪生在同批处理。
- **建议测试**：`node -e` 重新清点壳数量单调下降至 0；runtime/node/backend 根目录只剩 package.json / server.js / Dockerfile 等登记项。
- **是否已确认**：已确认（只读复现：node -e 壳与遗留物清点）。

### 3.2 AI 网关（GW，13 条已确认）

#### GW-01 ｜ 密钥池内层循环的 continue/return 绕过 releaseSlot，并发槽永久泄漏导致 key 被判死
- **风险等级**：P1
- **涉及模块**：AI 网关 / 密钥池并发控制
- **涉及文件**：`runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:4940`
- **具体代码位置**：aiGatewayGenerateMethod.js 的 pool provider 内层 key 循环（4885–5441），try 块只有 catch 没有 finally
- **问题描述**：内层 key 循环在 `const releaseSlot = slots.acquire(picked.keyId)`（:4940）之后进入 try（:4942）。该 try 只有 catch（:5326），没有 finally，因此 try 内的 `continue`（:4995 cachedFastFail 非 strict 分支）与 `return`（:4966 strict 终局、:5000 attemptBudgetExceeded）都在未调用 :5097-5099 的 `releaseSlot()` 的情况下跳出循环/函数。concurrencySlots.acquire 只做 `slot.current++` 并返回幂等 release（`concurrencySlots.js:78-94`），而 `apiKeyPool._collectAvailableEntries` 用 `slots.hasAvailableSlot(e.id)` 过滤可用 key（`apiKeyPool.js:865-867`）——current 只增不减，累计到 max 后该 key 被永久排除，`hasAvailableKeys()` 转 false，整条 pool provider 对后续请求不可用，直到进程重启。所有既有测试都 `jest.mock('../src/services/concurrencySlots', () => ({ acquire: jest.fn(() => jest.fn()) }))` 整体替换了该模块（`tests/aiGateway.stability.test.js:73`、`tests/aiGateway.credentialRefreshRetry.test.js:72`、`tests/aiGateway.apiPoolStrategy.test.js:72`、`tests/aiGateway.contextOverflowShrink.test.js:73`、`tests/gatewayLiveSwitchPinnedSelection.test.js:76`），因此这条路径零覆盖。
- **触发条件**：relay/api 通道走密钥池，且该适配器处于 fast-fail 冷却中（例如刚吃过一次 429/401）或触发重试预算上限。此时 :4947 的 cachedFastFail 命中 → :4995 continue，槽不释放。
- **复现步骤**：代码路径：`aiGatewayGenerateMethod.js:4940 acquire → :4947 cachedFastFail 命中 → :4995 continue（无 finally 兜底）→ :5097 的 releaseSlot 被跳过`。对照同函数 single-key 分支没有槽操作，故只有 pool 分支受害。只读实证：真实 concurrencySlots 模块——kiro max=1，一次 acquire 不 release → current=1、hasAvailableSlot=false；再次 acquire 仍自增（无容量检查）；真实 apiKeyPool + concurrencySlots——对 max=3 的 key 连续 3 次 acquire 不 release → `pool.hasAvailableKeys()=false`、`listAvailableKeys()` 为空，而 `getPoolStatus()` 仍报 `["active"]`。
- **实际影响**：每发生一次即泄漏 1 个槽。PROVIDER_DEFAULTS 中 relay=5、deepseek=3、anthropic=2、kiro/cursor/claude/codex=1（`concurrencySlots.js:17-32`），kiro/cursor/claude/codex/trae/vscode 这类 max=1 的 key 一次泄漏就永久判死；max=3 的 key 三次即死。表现为「密钥池里明明配了 key，`khy key list` 显示 active，但请求永远走不到它/直接 All providers failed」，且只能靠重启进程恢复（resetAll 存在但全仓无调用方）。
- **根本原因**：把「资源获取」与「释放」放在了一个没有 finally 的 try 里，且 try 内存在 continue/return 控制流；同时缺少针对该不变式（acquire 次数 == release 次数）的测试，因为测试把 concurrencySlots 整个 mock 掉了。
- **修复建议**：把 :4942 的 try 改成 try/catch/finally，把 :5097-5099 的 `if (releaseSlot) releaseSlot();` 移入 finally（保留其在成功路径后的原语义，finally 幂等，不影响现有行为）；或将 :4995 的 continue 与 :5000 的 return 改为先 release 再跳出。不要动 acquire/release 本身的语义。
- **建议测试**：新增针对 aiGatewayGenerateMethod pool 分支的用例：mock 真实 concurrencySlots（或断言 acquire/release 调用次数相等），令 `_getRecentFastFail` 返回冷却项，跑完一次 generate 后断言 `concurrencySlots.getSlotStatus(keyId).current === 0`；再跑 maxPoolRetries 轮后仍为 0。
- **是否已确认**：已确认（静态读码 + 真实模块只读复现影响链）。

#### GW-02 ｜ 密钥池路径的 fast-fail 自锁：第 0 个 key 刚写下的冷却把 1..N-1 个 key 全部 virtualSkip，池重试退化为 1 次
- **风险等级**：P1
- **涉及模块**：AI 网关 / 密钥池轮换与冷却
- **涉及文件**：`runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:4947`
- **具体代码位置**：aiGatewayGenerateMethod.js pool 内层 key 循环顶部的 cachedFastFail 检查（:4947–4996），对照 single-key 分支 :5592–5637
- **问题描述**：pool 内层循环对每个 pi 都执行 `const cachedFastFail = await inspectCachedFastFail(entry.key, adapterDisplayName)`（:4947），没有 `pi === 0` 守卫。而 `_recordAdapterFailure` 在写任何 await 之前就同步把失败写进 `this._adapterLastError[adapterKey]`（`aiGatewayCooldownMethods.js:305-314`，注释明写「Keep local mirror hot immediately (before any async I/O) so fast-fail checks in the same tick can observe this failure」）。于是 pi=0 失败后 :5264 记录失败，pi=1 一进循环就在 :4947 读到这条刚写的冷却 → :4949 记一条 virtualSkip → :4995 continue，pi=2..N-1 同理。single-key 分支已经修掉了同一个病（:5592-5597 的注释原文：「Once this request has started the adapter, its in-request retries are governed by the attempt and delay budgets below; the failure recorded by attempt 0 must not virtual-skip attempt 1」，并落实为 `attempt === 0 ? await inspectCachedFastFail(...) : null`），pool 分支没有等价守卫。
- **触发条件**：任一走 apiKeyPool 的适配器（relay / relay_api / api）在池内第一次尝试返回 429/401/403/5xx。
- **复现步骤**：`:4947` 无条件调用 inspectCachedFastFail；`:5254 pool.markFailure(...)` + `:5264 await _recordAdapterFailureWithAttachment(...)` 同步落 `_adapterLastError`；下一轮 :4947 命中 → :4995 continue。为排除「守卫写在别处」，对 4908–5467 行正则扫 `pi === 0` / `pi > 0` / `pi < maxPoolRetries`，唯一命中是 4908 的循环条件本身。
- **实际影响**：`GATEWAY_POOL_MAX_RETRIES`（默认 5，:4901-4904）实际只有 1 次真实尝试：429 时本应「同池换 key 重试」的语义完全失效，直接掉到下一适配器；同时 allAttempts 里堆 N-1 条同因 virtualSkip，失败诊断被噪音稀释（这些条目被 `failureReasonRanking.js:13-16`、`fallbackEligibilityPolicy.js:197` 等显式当作「非真实尝试」排除）。与 GW-01 叠加（每次 continue 还漏一个槽）会更快把 key 打死。
- **根本原因**：跨请求的准入闸（fast-fail）与请求内的重试预算（attempt/delay budget）之间的边界只在一条分支上划清了；pool 分支漏掉，且冷却写在 await 之前的「保持镜像热」设计放大了这个窗口。
- **修复建议**：把 :4947 改成与 single-key 分支同型的 `pi === 0 ? await inspectCachedFastFail(entry.key, adapterDisplayName) : null`；若同时要保留「换 key 前再看一眼冷却」的语义，则应在 `pool.markFailure` 之后、下一次 acquire 之前显式判断冷却是否属于本 adapter 而非本 key。
- **建议测试**：构造 3 个 key 的 pool，第 1 个 key 的 generate 抛 429，断言 `adapter.generate` 被调用 3 次（而不是 1 次），且 3 次都带不同 apiKey；同时断言 allAttempts 中 virtualSkip 条目数为 0。（该验收未跑——需拉起完整 gateway + adapters 测试夹具；仓库内无覆盖该路径的现成测试，`aiGatewayGenerateMethod.test.js` 全文仅 2230 字符且与 pool 无关。）
- **是否已确认**：已确认（静态代码路径为确定性同步读写，无并发歧义；附带确认 continue/return/break 路径均不经 releaseSlot，与 GW-01 表述一致）。

#### GW-03 ｜ 密钥池成功路径完全不记 token 用量，relay/api 通道的计费统计恒为空
- **风险等级**：P2
- **涉及模块**：AI 网关 / Token 统计与计费
- **涉及文件**：`runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:5221`
- **具体代码位置**：aiGatewayGenerateMethod.js 的 pooledResult 成功出口（:5187-5231），对照 single-key 成功出口 :6077-6090
- **问题描述**：整个 gateway 目录里 `usageTracker.record` 只有一处调用（findstr 递归实测 TOTAL=3：:17 注释、:30 require、:6081 调用）。:6081 位于 single-key 成功路径；pool 成功路径在 :5221 `return finishResult(pooledResult, {...})` 直接返回，既不调 usageTracker.record，也不调 diagnostics.emitModelResponse / cacheEconomyStore.record / autoModelRouting.observeOutcome（这三者都只在 :6093-6139 的 single-key 路径上）。
- **触发条件**：任何经 apiKeyPool 命中 key 的成功请求（entry.key ∈ {relay, relay_api, api} 且 pool.hasAvailableKeys 为真）——这是生产上最常见的主路径。
- **复现步骤**：`:5221 return finishResult(pooledResult, ...)`；同文件 :6081 usageTracker.record 在结构上不可达于该分支。finishResult（:1532-1704）不做任何 usage 记账，排除「埋点其实在共用出口里」。
- **实际影响**：relay/api 通道所有成功请求不计入 usageTracker（经全仓扫描确认它在 src 中没有任何读者，本身即沉洞）、不进 cacheEconomyStore 的缓存命中率遥测、不进 autoModelRouting 的 S1 观测样本（autoModelRouting 的 band/λ 路由因此只收到非池通道的样本，成本路由在池通道上长期盲飞）。**订正**：原 finding 称「进而影响 tokenUsageService 的用量与费用账」「khy 的用量统计对主通道显示为 0」不被证据支持——CLI 侧记账来自 `aiChatCore.js:4958 let tokenUsage = result.tokenUsage || null` + :5003 `recordUsage(...)`，而 pooledResult 自带 provider/model/tokenUsage（:5191-5201），两条分支都会流到这里，CLI 侧 /cost、HUD、会话用量对池通道照样记。
- **根本原因**：池化成功出口是后加的分支，复制 single-key 出口时只搬了结果字段（toolUseBlocks/stopReason 等），没有搬埋点；没有任何测试断言两条成功出口的埋点集合一致。
- **修复建议**：把 :6077-6139 的埋点块（usageTracker.record + observeOutcome + diagnostics.emitModelResponse + cacheEconomyStore.record）抽成一个 request 级函数，在 pooledResult 出口前调用一次；注意保留「未发生 refusal 恢复时逐字节等于原值」的取数（用恢复后的 pooledResult）。
- **建议测试**：对 pool 分支与 single-key 分支各跑一次成功 generate，断言 usageTracker.record 被调用且入参 input/output tokens 一致；并加一条「两条成功出口的埋点调用集合相同」的契约断言。
- **是否已确认**：已确认（findstr usageTracker 恰好 3 行；`jest tests/aiGateway.apiPoolStrategy.test.js` 4 passed，但该文件只 mock 了 usageTracker.record 却从不断言它被调用；全仓无任何测试断言两条成功出口埋点一致）。

#### GW-05 ｜ adaptiveOutput 升级重试整单重发：翻倍计费 + 二次流式输出无 reset 帧，且截断信号读的是没人产出的字段
- **风险等级**：P2
- **涉及模块**：AI 网关 / 重试与流式
- **涉及文件**：`runtime/node/backend/src/services/adaptiveOutput.js:129`
- **具体代码位置**：adaptiveOutput.js:120-159 的 withAdaptiveOutput while 循环；挂载点 aiGatewayRoutingMethods.js:1210-1214
- **问题描述**：`_generateWithAdapterIsolation` 对每一次适配器调用都套 `adaptiveOutput.withAdaptiveOutput((prompt, opts) => entry.adapter.generate(prompt, opts), { maxRetries: 1 })`（`aiGatewayRoutingMethods.js:1210-1214`）。withAdaptiveOutput 的循环（adaptiveOutput.js:128-158）在 detectTruncation 命中时**原样重发整个 prompt**（仅追加一段 `[SYSTEM: Previous response was truncated ...]` 与末 200 字，:154-157）。三个问题叠加：① 重发整单 → 上游对同一 prompt 收两次费（长上下文档位下输入 token 翻倍），且这是网关 attempt 预算之外的一层，GW 的 reserveAttemptBudget 管不到它；② `chatFn` 收到的 opts 里含网关的 onChunk，第一次尝试已把部分文本推给用户，第二次又推一遍——本函数既不发 responseDebounce 的 reset 帧也不重置 `_forwardedVisibleTextLen`（对比 beginLanguageRecoveryRetry :5505-5520 与 emitAdapterFallbackReset :1173-1185 都专门做了这件事），append-only 消费者会把同一个答案渲染两遍；③ detectTruncation 的显式信号读 `response.finish_reason || response.stop_reason`（:71），而本仓所有适配器返回的都是 `stopReason`——grep 确认 `finish_reason` 在 adapters 下只出现在 SSE 解析内部，从不作为 generate 的返回字段——所以显式分支恒不命中。附带修正：:77-82 的 95% token 启发式同样恒死（读 `usage.output_tokens || usage.completion_tokens`，而适配器返回 camelCase `tokenUsage:{inputTokens,outputTokens,totalTokens}`），实际唯一活着的触发器是 :86-91 的「``` 奇数个」启发式。
- **触发条件**：模型输出接近 max_tokens，或任意 ≥200 字的回答里出现奇数个 ```（例如正文里解释 markdown 代码块、贴了半个 diff）。
- **复现步骤**：adaptiveOutput.js:129 `const response = await chatFn(message, { ...options, max_tokens: currentCap });` → :131 detectTruncation → :144-157 escalate + 重组 message → 回到 :129 重发；:71 的 finish_reason/stop_reason 与 adapters 的 stopReason 字段名不匹配。只读实测：`detectTruncation({stopReason:'length', tokenUsage:{outputTokens:8192}})` → `{truncated:false}`；`{finish_reason:'length'}` → `{truncated:true}`（但无适配器返回该字段）；294 字、3 个反引号（奇数）、stopReason:'end_turn' → `{truncated:true,reason:'unclosed code block'}`。
- **实际影响**：误判时（奇数 ``` 极常见）一次普通问答变成两次全价请求；流式场景用户看到同一答案两次；与网关自身的 toolUseLoop max-tokens 续写叠加成第三层重发。
- **根本原因**：这层包装写在上层契约（response.finish_reason）之上，而本仓适配器的返回字段已演进为 stopReason，没有任何测试锁住两者的对应关系（全仓 findstr adaptiveOutput 在 tests 下零命中）；同时它绕过网关统一的「重试前先撤回已流式草稿」协议。
- **修复建议**：把 detectTruncation 的显式信号改为同时识别 `stopReason`/`stop_reason`/`finish_reason`（以 stopReason 为第一顺位，保持向后兼容）；重发前经 onChunk 发一个 responseDebounce reset 帧并把 `_forwardedVisibleTextLen` 归零（复用 buildResetChunk，失败 best-effort 不阻断）。不建议去掉这层，只修字段名与重复输出。
- **建议测试**：① 单元：`detectTruncation({stopReason:'length', ...}) === truncated`；② 集成：mock 适配器第一次返回 stopReason:'length'，断言第二次调用的 prompt 与第一次的差集只有追加段，且 onChunk 收到过 type:'reset'；③ 断言 ``` 奇数个不再触发重发（或明确记录为已知启发式）。
- **是否已确认**：已确认（读码 + node -e 实测三种输入；网关自己的撤回协议就在隔壁且注释明写这个 bug）。

#### GW-06 ｜ 抛错路径的原始 err.message 未经脱敏直出用户状态行与密钥池 lastError；脱敏正则只覆盖 sk-/ghp_ 系
- **风险等级**：P2
- **涉及模块**：AI 网关 / 上游密钥泄漏面
- **涉及文件**：`runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:5352`
- **具体代码位置**：aiGatewayGenerateMethod.js catch 分支 :5351-5357；apiKeyPool.js:725/779；errorClassifier.js:280-287
- **问题描述**：同一函数里两条失败路径的脱敏不一致：结果型失败走 `_extractResultErrorMessage(result)`（:5236），该函数内部对每一条候选消息都过 `_sanitizeFailureMessage`（aiGateway.js:1675-1696）；而抛异常型失败在 :5351-5353 直接 `emitStatus(`${entry.adapter.getStatus().name} 错误: ${err.message || '未知错误'}`)`，:5358-5365 把 `err.message` 原样推入 allAttempts，:5357 `pool.markFailure(picked.keyId, sc, err.message, errHeaders)`。apiKeyPool.markFailure 把它存进 `entry.lastError = errorMsg || ...`（`apiKeyPool.js:725`），而 getPoolStatus 原样返回 lastError（:779），经 `GET /api/ai-gateway/pool` 暴露（该 router 整体有 authenticateToken + requireAdmin，`routes/aiGatewayAdmin.js:43`，故为管理员可见；ai-backend 侧同样裸存 lastError）；同时 emitStatus 的文本经 onChunk 直达终端/前端，是**终端用户可见的**。另外 `_sanitizeFailureMessage` 依赖的 redactSensitiveText（`errorClassifier.js:280-287`）只匹配 `sk-`、`ghp_`、`gho_`、`Authorization: Bearer`、JSON 里的 apiKey/token/secret/password/accessToken、ENV 式 `*KEY*=`: Gemini `AIza…`、智谱 JWT（`eyJ…` 带点）、百度/火山 volces UUID 等形态一律不脱敏。
- **触发条件**：上游在错误体里回显它收到的凭据（部分供应商/中转站会回显 key 前缀或全文），且该 key 不是 sk-/ghp_ 形态。
- **复现步骤**：`:5352` 使用未脱敏 err.message；对照 :5236 使用已脱敏的 resolvedErrMsg。`errorClassifier.js:280-287` 的 REDACT_PATTERNS 无 AIza/JWT/UUID 形态。只读实测：`AIzaSyA1234567890abcdefghijklmnopq`、`eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc`、`3f8a1c2e-9b4d-4e5f-8a7b-6c5d4e3f2a1b` 均原样透出；`?key=AIza...` 仅被 ENV 式规则打成前6+后4；`sk-...`/`ghp_...` 正常脱敏。
- **实际影响**：非 sk- 系供应商的 API key 可经用户可见的状态行泄漏给终端用户；traffic-logger 的 url/errorMessage 字段不脱敏（`traffic-logger.js:143`、152），本地流量归档（exportHAR）会留下明文 url。
- **根本原因**：脱敏是「调用方自觉」而非「出口统一」：同一个 generate 里有的出口过 `_sanitizeFailureMessage`，有的不过；脱敏正则的形态集合停留在 OpenAI/GitHub 时代，没有随新增供应商扩展，也没有测试锁定「所有用户可见出口必须脱敏」。
- **修复建议**：把 :5351-5357 的 err.message 与 :5357 的 markFailure 入参改走 `_sanitizeFailureMessage(err.message)`（与 :5236 对称）；在 REDACT_PATTERNS 增补通用形态（`AIza[0-9A-Za-z_-]{10,}`、`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.`、以及 `[?&]key=` 后的值）。不要改脱敏的展示粒度（前6+后4），只补形态与统一出口。
- **建议测试**：① 单测：构造 message 含 `AIzaSy...` 与 `key=AIza...`，断言 `_sanitizeFailureMessage` 输出不含完整值；② 集成：mock 适配器 throw 一个带 Gemini key 的 Error，断言 emitStatus 收到的文本与 `pool.getPoolStatus()[0].lastError` 均为脱敏形。
- **是否已确认**：已确认（读码 + node -e 实测 redactSensitiveText 六类形态）。

#### GW-07 ｜ autoModelSelect 按模型名去重发生在可用性过滤之前，同名的可用候选被静默丢弃
- **风险等级**：P3
- **涉及模块**：AI 网关 / 模型路由
- **涉及文件**：`runtime/node/backend/src/services/gateway/autoModelSelect.js:170`
- **具体代码位置**：autoModelSelect.js:143-192 的 _normalizeCandidates 去重，与 :253-260 的 filter 顺序
- **问题描述**：`rankAutoModels` 先 `_normalizeCandidates(candidates)`（:255），其中 :170-174 以 `model.toLowerCase()` 为键去重且「首个胜」；随后才 `.filter((e) => !_UNAVAILABLE_STATUS.has(e.status))`（:255-257，:116 `_UNAVAILABLE_STATUS = new Set(['disabled','cooldown'])`）。因此若同一个模型 id 出现在两个适配器上（autoModelRouting.rank 的候选池就是按 adapter 分桶后拍平的，`autoModelRouting.js:341-358`；`modelEntryCollection.js:771-775` 的 selectable 亦含 api 两路 + relay + Auto 投影），而**第一个**条目的 status 是 disabled/cooldown，去重已经把它选为代表，随后的可用性过滤直接淘汰，第二个适配器上那条可用的同名模型再也进不了排序。
- **触发条件**：两个适配器暴露同名模型，且列表中排在前的那条处于 cooldown/disabled。
- **复现步骤**：`:170-174` 去重 → :255-257 过滤；构造 `[{model:'deepseek-chat',adapter:'api',status:'cooldown'},{model:'deepseek-chat',adapter:'relay_api',status:'active'}]`，`rankAutoModels` 返回 `[]`（只读实测）；对照组 active 在前 → 返回该条；两个不同 model id 时两条都返回。
- **实际影响**：autoModelSelect 的诚实边界（:16/:195/:229 声称候选是「当前真正可用的」）实际可能因同名冲突把唯一可用的那条筛掉，表现为「明明有可用模型，Auto 预览为空/落到下一档」。当前两个在产调用点里 autoModelRouting.rank 恒传 status:'active'（:357）、modelEntryCollection 不传 status（归一后为 ''，永不进 `_UNAVAILABLE_STATUS`），所以此路径尚未在生产触发，属潜伏缺陷。
- **根本原因**：去重键选的是「模型 id」而不是「(adapter, model)」，而注释（:135-142）只声明了「按 model 去重(首个胜)」，没有考虑它与后置可用性过滤的相互作用。
- **修复建议**：把去重键改为 `${adapter}|${model}`（adapter 为空时退化为 model），或把可用性过滤提到去重之前。两者都只动顺序/键，不改排序键与打分。
- **建议测试**：补一条：同 model 不同 adapter、首条 cooldown 次条 active，断言 rankAutoModels 返回次条（现有 `tests/autoModelSelect.test.js:94-102` 的 dedupe 用例两条都传 status:'active'，未覆盖该场景）。
- **是否已确认**：已确认（读 autoModelSelect.js 全文 + node -e 复现）。

#### GW-08 ｜ keySelector 的 fill-first 冷却永不武装：recordKeyUsage 零调用点，isKeyCooling 恒 false
- **风险等级**：P3
- **涉及模块**：AI 网关 / 密钥选择策略
- **涉及文件**：`runtime/node/backend/src/services/gateway/keySelector.js:183`
- **具体代码位置**：keySelector.js:183-208（recordKeyUsage/isKeyCooling 与滑动窗口计数器）与 :215-236（selectFillFirst）
- **问题描述**：selectFillFirst 的核心判据是 `if (!isKeyCooling(c.keyId) && Number(c.backoffLevel || 0) === 0) return c;`（:229），isKeyCooling 读 `_recentRequestCounters`（:202-208），而该 Map 只由 recordKeyUsage 写入（:183-197）。用 node 脚本在 runtime/node/backend/src 全树检索 `recordKeyUsage`：TOTAL=0（唯一定义与导出在 keySelector.js 自身；构建产物 bundle.mjs 中同样只有定义+导出）。于是计数器恒空、isKeyCooling 恒 false，fill-first 退化成「按 keyId 排序取第一个 backoffLevel 为 0 的 key」，与文档承诺的「优先用同一个 key 直到它被冷却或失败过多，再切换到下一个」（:211-214）不符；`_cleanupStaleState` 里那段计数器清理（:298-302）也随之永远空转。默认策略是 round-robin（`keyStrategyDict.js:25-26`），不受影响；只有显式把某 provider 配成 fill-first/fill/exhaust 时才受害。
- **触发条件**：`GATEWAY_KEY_SELECTION_STRATEGY` 或 `GATEWAY_KEY_SELECTION_STRATEGY_MAP` 把某 provider 设为 fill-first，且该 provider 配了多把有月度配额上限的 key。
- **复现步骤**：grepdir 'recordKeyUsage' over runtime/node/backend/src → TOTAL=0；keySelector.js:202-208 的 isKeyCooling 只能读到空 Map。只读实测：不调 recordKeyUsage 连续 50 次 selectFillFirst，`picks_unique=["k1"]`（永远粘在 keyId 最小者）；手动 recordKeyUsage 41 次后 isKeyCooling=true、下一次 pick 切换到 k2。
- **实际影响**：fill-first 策略下不会按用量冷却换 key，一把 key 被持续打到配额上限才由上游 429 + markFailure 的 backoff 兜底；策略形同虚设但界面/文档显示已启用（`docs/03_DESIGN_设计/DESIGN-CPA/[DESIGN-CPA-002]:141/:210` 把 fill-first 写为推荐策略；「界面显示」只找到文档层宣传，未找到 UI）。附带偏差：代码注释与文档说策略适合「月度配额上限」的 key，而实际冷却判据是 40 req/60s 滑动窗口（:159-160），属策略语义与阈值口径的偏差。
- **根本原因**：记录端（recordKeyUsage）从未接线，而选择端（isKeyCooling）看起来是完备的——典型的「只接了一半」；没有测试断言「selectFillFirst 在超过阈值的 key 上会换 key」（tests/keySelector.test.js 与 tests/gateway/keySelector.exports.test.js 无 fill-first 用例、无这两个导出的断言）。
- **修复建议**：在 aiGatewayGenerateMethod 池分支选中 key 之后（:4929 attemptedPoolKeyIds.add 附近）调一次 `keySelector.recordKeyUsage(selected.keyId)`；不要在热路径之外再加第二处记录点。
- **建议测试**：单测：recordKeyUsage 同一 keyId 41 次后，selectFillFirst 在两个候选间必须换到另一个 key。
- **是否已确认**：已确认（git grep 零调用点 + node -e 实测选择端机制本身是好的、缺的正是记录端接线）。

#### GW-09 ｜ _openaiSseStream 收尾缓冲只解析 choices[0].delta.content，末帧的 tool_calls / Responses 事件被丢
- **风险等级**：P3
- **涉及模块**：AI 网关 / 流式响应
- **涉及文件**：`runtime/node/backend/src/services/gateway/adapters/_openaiSseStream.js:400`
- **具体代码位置**：_openaiSseStream.js:388-422 的 stream 'end' 收尾分支，对照 :230-295 的主循环分支
- **问题描述**：主循环为「没有 choices 的 event」专门加了 Anthropic content_block_delta 与 OpenAI Responses（response.output_text.delta / function_call_arguments.delta / response.completed）两条兜底（:223-296，注释说明是 relay 代理把 /v1/responses 事件透传到 /v1/chat/completions 的真实场景）。但 'end' 里对 `buffer` 残留帧的处理只认 `obj.choices?.[0]?.delta?.content` 与 `obj.choices?.[0]?.finish_reason`（:404-416）。当上游最后一条 SSE 事件后没有换行（buffer 里还留着它）时，该事件若带 tool_calls 或 Responses 形态，就在收尾被静默丢弃——主循环里本来能正确累积的那部分不会发生；`JSON.parse` 失败时 `catch { /* ignore trailing garbage */ }`（:417-419）静默吞掉，连 `_parseFailCount` 都不加。
- **触发条件**：上游在流末尾少发一个 `\n`（部分代理/截断的响应体会这样），且末事件是 function_call 参数增量或 Responses 事件。
- **复现步骤**：`:400-422` 只读 `obj.choices?.[0]?.delta?.content`；:249-295 的 Responses/function_call 分支在 end 路径没有对应实现。只读实测（EventEmitter 假流喂帧）：A 对照组（Responses 帧带 `\n\n`）→ toolUseBlocks 完整；B（末条 function_call_arguments.delta 不带尾 `\n`）→ input 变 {}，增量丢失；C（末 chunk 两条完整事件、无尾 `\n`）→ 同样丢失；D（chat-completions tool_calls 作末帧无尾 `\n`）→ 整个工具调用丢失；E 对照组（带终止符）完整保留；F（纯文本末帧无尾 `\n`）→ content 被正确保留；G（Anthropic content_block_delta 末帧无尾 `\n`）→ content=''，丢弃。
- **实际影响**：末帧工具调用参数丢失 → 该轮工具调用参数不完整（JSON.parse 失败被吞成 `{}`，:139-151）→ 上层用错误的 input 执行工具；或末帧文本丢失 → 回答尾部缺字。低频但属静默数据损坏。
- **根本原因**：end 收尾是早期实现的遗留，主循环后来扩展了协议兼容面却没有同步收尾路径；没有测试覆盖「无尾随换行的末帧」（`tests/openaiSseStream.partial.test.js` 的 `sse()` 辅助函数恒追加 `\n\n`）。
- **修复建议**：把 :400-422 的残留帧处理改为复用主循环里同一段事件分发（抽出一个 `_handleEventObject(obj)` 供 data 循环与 end 收尾共用），而不是在 end 里重写一份只认 choices 的解析。
- **建议测试**：单测：以一个不带尾行 `\n` 的 `data: {...function_call_arguments.delta...}` 结束流，断言累积的 toolUseBlocks 参数包含该增量。
- **是否已确认**：已确认（读全文 454 行 + 七个只读复现场景）。

#### GW-10 ｜ 重试等待预算的 sleep 不接 abort 信号，取消要等整个退避窗
- **风险等级**：P3
- **涉及模块**：AI 网关 / 取消语义
- **涉及文件**：`runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:2500`
- **具体代码位置**：aiGatewayGenerateMethod.js:2488-2502 的 waitWithRetryDelayBudget
- **问题描述**：`await new Promise((resolve) => setTimeout(resolve, waitMs))`（:2500）没有传 signal，也没有在 resolve 前检查 `gatewayAbort.signal.aborted`。两个调用点 :6339 与 :6530 都是 `const budgetExceeded = await waitWithRetryDelayBudget(baseDelay + jitter); if (budgetExceeded) { return budgetExceeded; } continue;`——await 之后只判预算、直接 continue，无取消检查。取消确实要等 wait 结束才生效：`throwIfCancelled`（:950 定义为 `throwIfAborted(externalAbortSignal)`）只出现在 :4997/:5009 与 :5641/:5653，都是下一轮循环开头的检查。`gatewayAbort` 就在同一闭包内（:976 `createLinkedAbortController(externalAbortSignal)`，全文 40+ 处使用），sleep 处拿得到 signal 却没传。适配器侧用的是可中止的 sleepAbortable（`adapters/_retryWithBackoff.js:64-92`，专为解决 listener 泄漏重写过），网关层这一处没有复用（该文件在 aiGatewayGenerateMethod.js 中零引用）。
- **触发条件**：请求进入重试等待预算（waitWithRetryDelayBudget 被调用）期间用户取消。
- **复现步骤**：`:2500` 无 signal 参数；:6339/:6530 调用点无取消检查。只读实证（仓外临时脚本）：`A: gateway:2500 (no signal)` → 「STILL WAITING 1200ms after abort @1214ms」；`B: adapters sleepAbortable` → 「rejected: AbortError @144ms」。即同一 signal 在 100ms 时 abort，网关写法 1.2s 后仍未 settle，适配器写法 44ms 内 reject。
- **实际影响**：取消延迟最长一个重试等待窗（受 maxRetryDelayBudgetMs 默认 15000ms 限制——小任务 5000/大任务 45000，单次 wait 的 baseDelay 为 1200 或 3000（rate_limit）+≤0.5 jitter，或 server Retry-After——非无限）；期间 spinner 已由上层 abort 停掉，但进程仍未让出控制权。属体验问题，不影响正确性。
- **根本原因**：这一处是网关层的自有 sleep，没有复用 adapters/_retryWithBackoff.js 已修好的 sleepAbortable。
- **修复建议**：改用 `require('./adapters/_retryWithBackoff').sleepAbortable(waitMs, gatewayAbort.signal)`（该模块 reject AbortError，会被 catch 接住并走 cancelled 分支；注意 `src/services/retryWithBackoff.js` 只导出私有 `_sleep`，finding 原给的路径/名字不对），并在 await 之后补一次 throwIfCancelled。同文件 :6813-6826 的网络恢复轮询已用了「clearTimeout+resolve 挂在 abort 监听上」的可中止 sleep 惯用法，有先例。
- **建议测试**：单测：waitWithRetryDelayBudget 进行中 abort gatewayAbort，断言 promise 在远小于 waitMs 的时间内 settle（全仓当前无测试覆盖该函数）。
- **是否已确认**：已确认（读码 + 仓外实证脚本对照两种写法）。

#### GW-11 ｜ traffic-stream 的 /ws/traffic 无认证即可拉取流量快照与 HAR 导出（当前未接线，属潜伏面）
- **风险等级**：P3
- **涉及模块**：AI 网关 / 流式响应与密钥泄漏面
- **涉及文件**：`runtime/node/backend/src/services/gateway/traffic-stream.js:151`
- **具体代码位置**：traffic-stream.js:53-83（attachToServer）与 :151-216（_onConnection / _onClientMessage）
- **问题描述**：TrafficStream 用 `new WebSocketServer({ server, path: WS_PATH })`（:61-65）直接吃 upgrade 事件——`ws` 的 server 模式绕过 Express 中间件，所以 routes 级的 authenticateToken 管不到它；_onConnection 里也没有任何 auth 分支（对比 `server.js:1537-1631` 的主 wss 要求先发 `type:'auth'`）。连上即收到 `snapshot`（最近 50 条 entry，:159-164），并可发 `query`（:188-192）、`exportHAR`（:208-212）拿到全量流量记录——比 finding 所说还多：`clear`（:198-202，可清空流量日志）与 `setEnabled`（:203-207，可关闭捕获）也无鉴权。而 traffic-logger 的 entry 含 requestBody/responseBody（`traffic-logger.js:146`、149，只截断不脱敏）与未脱敏的 errorMessage（:152），这些内容可能带上游回显的凭据（见 GW-06）。缓解事实：全树检索 `traffic-stream` 与 `trafficStream` 在 src、server.js、bin 下引用数均为 0——该模块当前没有任何 importers，attachToServer 不会被调用，所以这是潜伏面而非现实暴露。
- **触发条件**：将来任何一处 require gateway/traffic-stream 并 attachToServer(server)（文档与导出面都为这一刻准备好了——`delivery/web/ai-frontend/src/views/admin/TrafficMonitor/index.vue:241-272` 的客户端直连 /ws/traffic 且不发任何 token）。
- **复现步骤**：`:61-65` 无 verifyClient；:151-176 无认证；grepdir → TOTAL=0 importers。另 server.js:281-297 注释明确记载「`{ server }` 模式的 WSS 会 claim 每条 path，两个 handleUpgrade 会抛错杀进程」——意味着 traffic-stream 若要接线还必须改这个手工路由，「从未被检验」的判断因此更成立。
- **实际影响**：一旦接线，同网段/同域任何未认证客户端可读取 AI 流量明细（prompt/响应体/错误体）并导出 HAR，甚至销毁/篡改日志。
- **根本原因**：WS 端点没有沿用主 wss 的认证协议；模块从未接线使这一点从未被检验。
- **修复建议**：接线前先在 _onConnection 里要求与 server.js 同型的 auth 握手（复用 authSessionService.authenticateAccessToken），未认证只允许收一个 auth_error；或给 attachToServer 加 verifyClient 从 upgrade 请求里取 token 校验。不要为了「先用起来」跳过认证。
- **建议测试**：接线时补：未发 auth 的 ws 连上后 5s 内不应收到 snapshot；发非法 token 应被 close(1008)。
- **是否已确认**：已确认（git grep 全仓零 require/import + 前端客户端已备好 + 主 wss 认证对照；未做黑盒验证——端点当前不存在）。

#### GW-12 ｜ StreamStaleDetector.stop() 仅在 _chunkCount>0 时发遥测，零进度卡死（正是它要抓的场景）不上报
- **风险等级**：P3
- **涉及模块**：AI 网关 / 流式响应遥测
- **涉及文件**：`runtime/node/backend/src/services/gateway/adapters/_streamStaleDetector.js:180`
- **具体代码位置**：_streamStaleDetector.js:170-199 的 stop()
- **问题描述**：`if (this._chunkCount > 0) { ... emitStreamHealth(...) }`（:180-198）。而 stale 判据本身就是「首 chunk 未到之前用 max(阈值, graceMs)」（:100-102）——即探测器的设计目标包含「一个字节都没到」的挂死。零 chunk 的 stale 恰好落在 `_chunkCount === 0`，遥测被跳过，_streamHealthSink（:183）收不到任何记录。generate 侧的 `_firstChunkLogged` 诊断（`aiGatewayGenerateMethod.js:1078`、1119-1125）只在 `_traceAudit` 开启时才写，也不覆盖这里。全 backend src 只有 _streamStaleDetector.js:183 一处调用 emitStreamHealth，不存在别的路径补偿。
- **触发条件**：上游连接建立后一个字节都不吐直到 stale 阈值。
- **复现步骤**：`:180` 条件；:158 `this._firstChunkTs = now` 只在 touch 里置位，零 touch 时恒 null。只读实测：构造 provider=gpt、thresholdMs=50 的 detector，注册 sink，零 touch 等 300ms 后输出 `zero-chunk stale, sink records = []`、`isStale = true chunkCount = 0`；对照组 touch 两次再 stop，输出 `control (2 chunks), sink records = 1 {"chunkCount":2,...}`。
- **实际影响**：「headers arrived but zero chunks」这类最需要度量的挂死在 stream_health 遥测里不可见，容量/回归判断缺样本；不影响请求本身的行为（拆流与 failover 仍正常）。
- **根本原因**：遥测条件按「有样本才有意义」写，但与探测器的首 token 宽限语义冲突。
- **修复建议**：把 :180 的条件改为 `if (this._chunkCount > 0 || this._stale)`，让 stale 结果（含 chunkCount:0）也能上报；meta 里已有 chunkCount 字段，消费者可自行区分。
- **建议测试**：单测：构造一个收到 0 个 chunk 就 stale 的 detector，stop() 后断言 sink 收到一条 chunkCount===0、success===false 的记录（现有 `tests/services/streamHealthSink.test.js:73-89` 只覆盖「touch 过再 stop」的有样本场景）。
- **是否已确认**：已确认（读码 + 只读运行实测两种场景）。

#### GW-13 ｜ 网关硬死线是对整条交付级联的墙钟硬杀，与 RUNTIME-003「不许硬 kill 长任务」存在张力
- **风险等级**：P3
- **涉及模块**：AI 网关 / 超时机制
- **涉及文件**：`runtime/node/backend/src/services/gateway/_gatewayHardDeadline.js:36`
- **具体代码位置**：_gatewayHardDeadline.js:36、85-114、126-164；消费点 aiGatewayGenerateMethod.js:4257-4289
- **问题描述**：适配器级超时（createAdapterIdleTimeout，:1284-1344）与网关级 idle 看门狗都是活动式（每个真实 chunk touch），符合 RUNTIME-003。但 createGatewayDeadline 基于一次性捕获的 startedAt（_gatewayHardDeadline.js:139-140），到点即 abort gatewayAbort 并终止级联（`aiGatewayGenerateMethod.js:4257-4289` 返回 errorType:'timeout'），large 任务默认 600000ms（:36 `HARD_TIMEOUT_DEFAULTS = { large: 600000, ... }`）。文件头（:1-31）说明这是为「重试级联被自身状态输出永久续命 → 1437 次膨胀」专门加的正交兜底，属有意设计。此处仅登记张力：一个**仍在推进**（只是每轮都被级联状态续命）的大任务会在墙钟到点时被无条件终止，AGENTS.md 规则 3 的红线是「任何超时机制都不得在固定时长后无条件杀死一个长时间运行的任务，无论该任务是否仍在推进」。缓解：该路径只 abort 本次请求、不杀进程，且终局诚实报「已达网关硬超时上限」并给出下一步（:4262-4289），不假装成功。
- **触发条件**：单次 generate 的墙上时间超过 `KHY_GATEWAY_HARD_TIMEOUT_MS`（large 默认 10 分钟）。
- **复现步骤**：`:139-148 const deadline = startedAt + deadlineMs; ... exceeded(now) { return t >= deadline; }`；:36 HARD_TIMEOUT_DEFAULTS={large:600000,small:180000,normal:300000}。`flagRegistry/index.js:2767` 确认 `KHY_GATEWAY_HARD_TIMEOUT` mode:'default-on' 默认开、可关。
- **实际影响**：超长但健康的请求（例如大上下文 + 多轮工具循环）可能在仍有进度时被终止，用户需重试。门控可关，关闭后逐字节回退无硬死线行为（:71-73、:130-132）。
- **根本原因**：idle 看门狗可被级联自身状态输出续命这一病根，是用墙钟兜底的；墙钟与「进度无关」是其定义使然，不是实现疏忽。
- **修复建议**：不建议拆掉这道兜底（它是 1437 次膨胀的对策）。若要消解张力，可让 exceeded() 也接受一个「自 startedAt 以来是否有过真实适配器进度」的输入，仅在「无任何真实 progress 的墙钟」或「墙钟 × N」两档里取更保守的一档；这只改判定入参，不动兜底存在性。
- **建议测试**：已有测试覆盖门控开/关与 clamp（`node --test tests/services/gatewayHardDeadline.test.js` → 13/13 通过）；若要改判定，补一条：持续有真实 chunk 的流在墙钟过后不被判 exceeded（或按新阈值）。
- **是否已确认**：已确认（读 _gatewayHardDeadline.js 全文 + 消费点 + flagRegistry；实跑 gatewayHardDeadline.test.js 13 passed）。

#### GW-14 ｜ 去重指纹在既无 userId 又无 sessionId 时退到 'anon'，同一 30s 桶内不同匿名调用者会共享缓存回复
- **风险等级**：P3
- **涉及模块**：AI 网关 / 请求去重
- **涉及文件**：`runtime/node/backend/src/services/gateway/requestDedup.js:128`
- **具体代码位置**：requestDedup.js:115-130 的 fingerprint；调用点 aiGatewayGenerateMethod.js:726-743
- **问题描述**：fingerprint 的 raw 串是 `${userId || 'anon'}:${model || 'auto'}:${promptHash}:${bucket}:${sessionId || ''}:${imgHash}`（:128）。aiGatewayGenerateMethod.js:726-727 传 `userId: options.userId || options.sessionId || 'anon'`、`sessionId: options.sessionId`。当调用方两者都没给时，所有匿名请求共用一个命名空间：同一 model + 同一 prompt 文本 + 同一 30s 桶（:116）的第二个人会拿到第一个人的回复（:736-740 `return { ...cached, deduplicated: true }`）。文件头（:1-18）已经修过「只哈希前导片」导致的跨消息碰撞，但租户维度仍是可选的。当前 HTTP 面（`routes/ai.js:487-488`）传了 `userId: req.user?.id`，authMiddleware 下有值；CLI/内部调用方（`coordinator/agentWorkerEntry.js:107`、`coordinator/workerAgent.js:471`、`services/moaService.js:79`）不带 sessionId 即落入此格。
- **触发条件**：未带 userId 也未带 sessionId 的调用方，在 30 秒内发出文本完全相同的请求。
- **复现步骤**：:128 的 `userId || 'anon'`；:726-727 的两级回退。只读实测（内存回退路径）：`anon same-prompt fingerprints equal: true`；`userId differentiates: true`；`sessionId differentiates: true`；`caller1 new: true | caller2 new: false | caller2 sees: FIRST CALLER REPLY`——同桶内第二个匿名调用者拿到第一个人的回复。
- **实际影响**：跨会话/跨用户的回复串用（答非所问），且用户无感知（结果带 deduplicated:true，全仓 grep 确认消费方只有 routes/ai.js:519/528）。概率低但属正确性问题。
- **根本原因**：fingerprint 的租户维度是可选注入，没有「匿名时必须有一个每连接/每进程唯一盐」的兜底。
- **修复建议**：在 generate 里当 userId 与 sessionId 都缺时，用一个请求级唯一值（如 options.requestId，缺则生成一个）补足租户段，使匿名请求永不与其它匿名请求共指纹；这不改变带 userId/sessionId 时的一切现有指纹（该段原本就非空）。
- **建议测试**：单测：同一 prompt、同桶、两次均不带 userId/sessionId，断言第二次的指纹与第一次不同（或第二次拿不到 deduplicated 结果）（现有 `tests/gateway/requestDedup.test.js` 13 passed，但无任何一条断言「两个匿名调用者指纹不同」）。
- **是否已确认**：已确认（读码 + 内联 node 脚本复现碰撞 + 既有测试套件 13 passed）。

### 3.3 Agent 与工具（AGT，8 条）

#### AGT-01 ｜ goal/ultrawork/coding 模式把进程级权限提到 yolo 并持久化落盘，异常终止后留下永久全自动放行
- **风险等级**：P1
- **涉及模块**：权限控制 / Agent 生命周期
- **涉及文件**：`runtime/node/backend/src/services/goalModeService.js:139`（activate() 内 `permissionStore.setProfile('yolo')`，位置 :126-159）
- **具体代码位置**：activate() 内 permissionStore.setProfile('yolo')（goalModeService.js:126-159），调用点 toolUseLoopCore.js:1866-1909，恢复点 toolUseLoopCore.js:10708-10715
- **问题描述**：runToolUseLoop 在检测到 goal/ultrawork/coding 任一模式时调用 `goalModeService.activateIfNeeded() → activate()`，其第一步是 `permissionStore.setProfile('yolo')`（目标注释即「所有工具一律放行」），第二步 `toolCalling.enableDangerousMode()` + `acknowledgeDangerousMode()`（跳过危险操作二次确认），第三步把进程级 env `KHY_GOAL_MODE_ACTIVE`/`KHY_PLAN_AUTO_APPROVE_MS` 置真。问题有两点：(a) setProfile 未传 `{persist:false}`，而 permissionStore.setProfile 的默认语义是 persist（`permissionStore.js:253-262`：`opts.persist !== false → _save()`），_save() 用 atomicWriteJson 把 `profile:'yolo'` 写进 `~/.khyquant/permissions.json`（`permissionStore.js:121-141`）。恢复只写在 runToolUseLoop 的 finally 里（`toolUseLoopCore.js:10708-10715`）——进程被 SIGKILL/崩溃/断电时 finally 不执行，磁盘上留下 yolo，之后每次启动都是全自动放行。(b) `_profile` 是模块级单例（permissionStore.js:56），`KHY_GOAL_MODE_ACTIVE` 是进程级 env（goalModeService.js:155、320）：同一 Node 进程服务多个会话时，一个用户的 goal 轮次会把全进程（含其他用户的工具调用裁决）一起提到 yolo；且第二个会话的 activateIfNeeded() 因 isActive() 已真而返回 null，不保存自己的状态，第一个会话结束时 deactivate 会把 profile 恢复成第一个会话快照的值。同仓 `toolCallingPermissions.js:122-141` 的 `_syncPermissionProfile` 明确用 `{persist:false}` 并注释「in-session 模式变更不得覆盖用户 durable on-disk profile」——goal 模式这条路径与既定口径相反。触发面异常宽：`intentGate.js:24-25` 的 `CODING_TRIGGER_RE` 命中 'npm init'、'cargo new'、'go mod init'、'vite create'、'maven项目'、'做一个网站'、'帮我写一个服务'、'开发一个应用' 等日常措辞（甚至连「npm init 怎么用」这类问句也会命中），都会走同一条提权路径。
- **触发条件**：用户在任一入口（CLI/REPL/Web `/api/ai/chat`）发送含 'goal:'/'目标：'（`intentGate.js:18`，带 m flag 任意行首即中）或命中 CODING_TRIGGER_RE/ULTRAWORK_TRIGGER_RE 的消息；或同进程已有他人 goal 轮次在跑。
- **复现步骤**：代码依据：`goalModeService.js:139 permissionStore.setProfile('yolo');`（无第二参）；`permissionStore.js:259-261 if (opts.persist !== false) { _save(); }`；`permissionStore.js:41 const PERMISSIONS_FILE = path.join(_appHome(), 'permissions.json')`；`permissionStore.js:137 atomicWriteJson(PERMISSIONS_FILE, data, { mode: 0o666 })`。恢复仅在 `toolUseLoopCore.js:10701-10715` 的 finally 中。
- **实际影响**：一次 goal/coding 轮次中途进程被杀 → 该机此后所有会话默认 yolo（所有工具含 shell 无提示自动放行），且用户无从得知；多用户/多会话部署下一次普通会话的工具调用会被他人 goal 轮次顺带提到全权限。
- **根本原因**：把「本轮临时自主执行」实现成了对进程级+磁盘级权限真源的写操作，且写入方未使用既有的 persist:false 语义；恢复依赖 finally，未覆盖进程级非正常终止。
- **修复建议**：`goalModeService.activate()` 内改为 `permissionStore.setProfile('yolo', { persist: false })`（与 toolCallingPermissions._syncPermissionProfile 口径一致），使提升只作用于本次进程生命周期；若确需持久化，应在 deactivate 之前不落盘、且在 activate 时先备份磁盘值。跨会话部分需把提权状态从模块级单例/进程 env 收窄为按会话（如挂在 traceContext/sessionId 上），避免同进程并发会话互相提权。
- **建议测试**：单测：activate() 后读 permissions.json 断言 profile 未被改写（或断言 setProfile 收到 persist:false）；模拟 activate 后不调 deactivate 直接结束进程，重启后 getProfile() 不等于 'yolo'。并发测：两个并发 runToolUseLoop，一个 goal 一个 strict，断言 strict 侧 requestPermission 仍返回 'ask'。
- **是否已确认**：已确认（静态阅读 goalModeService.js:126-159 / permissionStore.js:41,121-141,253-271 / toolUseLoopCore.js:1866-1909,10701-10715 / intentGate.js:18-25；未做运行时并发实证）。

#### AGT-02 ｜ httpRequest 工具零 SSRF 防护，可打内网与云元数据，且重定向不复查
- **风险等级**：P1
- **涉及模块**：工具系统 / 安全边界
- **涉及文件**：`runtime/node/backend/src/tools/httpRequest.js:40`（execute() 与 _once() 位于 :31-98、:168-240，重定向循环 :198-207）
- **具体代码位置**：execute() 与 _once()（httpRequest.js:31-98、168-240），重定向循环 httpRequest.js:198-207
- **问题描述**：httpRequest 是注册表自动加载的通用 HTTP 客户端工具（`tools/index.js:211-229` 的 Phase 2 扁平 .js 扫描即注册，实测 name=httpRequest risk=medium）。它只校验协议为 http/https（`httpRequest.js:40-45`），对目标主机不做任何私网/回环/链路本地判定：169.254.169.254（云元数据）、127.0.0.1、10.x/192.168.x/172.16.x 全部可打。execute() 的重定向循环把新的 Location 直接交给 _once()（:198-207），每一跳都不再校验主机，公网 URL 302 到 `http://169.254.169.254/` 即被跟踪。响应把 headers 原样回给模型（:226、233），内部服务的 Set-Cookie/内网拓扑随之进入上下文。同仓存在且工作正常的 SSRF 守卫 `urlSafety.assertPublicHttpUrlResolved`（`services/urlSafety.js:268-292`），VaultHttpFetch 在每一跳都调用它（`tools/VaultHttpFetch.js:17、165、197`），webFetch compat 路径走 fetchWithSsrfGuard（`services/tool/toolCalling.js:988-999`），WebFetchTool 也调 assertPublicHttpUrlResolved（`tools/WebFetchTool/index.js:247-254`）——唯独 httpRequest 这个通用 REST 客户端没接。其 risk 为 medium，在 permissionStore 的 auto profile 下（_AUTO_ASK_RISK 只拦 high/critical，`permissionStore.js:52`）与 yolo/bypass 下一律自动放行，不弹窗。
- **触发条件**：模型（或被 prompt injection 驱动的模型）调用 httpRequest，url 指向内网/回环/云元数据；或先给一个公网 URL、靠目标站 302 跳到内网。
- **复现步骤**：已执行（只读、未发任何网络请求）：node -e 加载该工具并调用 validateInput → `httpRequest.validateInput(169.254.169.254) => {"valid":true}`；同一会话用仓内守卫 `urlSafety.assertPublicHttpUrlResolved` 判同一 URL → `REJECTED`，127.0.0.1 与 10.0.0.5 同样 `REJECTED`。即守卫可用而 httpRequest 未调用。源码佐证：httpRequest.js 全文无 ssrf/urlSafety/assertPublic 引用（唯一 'SSRF' 字样出现在第 112 行描述文本里）。
- **实际影响**：agent 可扫描宿主内网、读取云厂商实例元数据（含 IAM 临时凭据）、打本地管理端口；在 auto/yolo profile 下无任何人工确认。重定向使「调用点做一次 URL 校验」的补丁也不足以闭合。
- **根本原因**：SSRF 防护是以「每个出口各自记得调用」的方式接线，而非收在工具执行层的统一前置；新增通用 HTTP 工具时漏接，且风险标级 medium 使其在常见 profile 下免审。
- **修复建议**：在 httpRequest.execute() 取到 url 后、以及重定向每一跳拿到新 url 后，调用 `services/urlSafety.js` 的 `assertPublicHttpUrlResolved(url, 'httpRequest URL')`，失败即返回 `{success:false, error}`（对齐 `VaultHttpFetch.js:195-199` 的写法）；同时把该工具的 risk 从 medium 提到 high，使其在 auto profile 下也要过人闸门。
- **建议测试**：单测：`execute({url:'http://169.254.169.254/latest/meta-data/'})` 断言 success:false 且错误含 private/local；`execute({url:'https://public.example/redirect-to-metadata'})`（用一个本地测试 server 发 302）断言不发出对内网的请求；对 `http://127.0.0.1:9229/json`、`http://10.0.0.5/` 同样断言拒绝。
- **是否已确认**：已确认（只读复现：node -e 调用 httpRequest.validateInput 与 urlSafety.assertPublicHttpUrlResolved 对照；未发起真实 HTTP 请求）。

#### AGT-03 ｜ 会话存储无用户维度，任意已认证用户可读任何会话全文并向他人会话写入
- **风险等级**：P1
- **涉及模块**：会话状态 / 跨用户隔离
- **涉及文件**：`runtime/node/backend/src/routes/khySessions.js:52`（GET /:sessionId，:52-76；GET / :35-46）
- **具体代码位置**：GET /:sessionId（khySessions.js:52-76）与 GET /（khySessions.js:35-46）；写入侧 routes/ai.js:602-608 与 services/apiChatSession.js:107-111；存储层 services/sessionPersistence.js:107-136、44-67
- **问题描述**：会话真源按「项目 cwd」分桶，完全没有用户维度：`_encodeProject(cwd)` 生成桶名（`sessionPersistence.js:44-51`），cwd 缺失时落进共享的 `_unknown` 桶（:25、:45-47）。读侧解析器 `_locateSessionFile` 会遍历根下每一个桶找同名文件（:107-136），意味着任一 sessionId 都可从任意请求到达。HTTP 暴露面 khySessions.js 只做 JWT/API key 认证（文件头 11 行自陈 `app.use('/api/khy-sessions', authMiddleware)`），GET /:sessionId 直接返回该会话的 meta + 最多 500 条完整消息链，GET / 列出全部会话，均不比对 req.user 与会话归属。写入侧 `/api/ai/chat` 与 `/api/ai/chat/stream` 用 `req.user?.id` 记账，但 persistChatTurn 的 sessionId 来自请求体（`routes/ai.js:431-442、602-608`），`apiChatSession.persistChatTurn` 只做 `[a-zA-Z0-9_-]{1,64}` 文件名安全校验就写入（`apiChatSession.js:20-35、107-111`）。auth 中间件是真实多用户体系（`middleware/auth.js`：User/ApiKey 模型、per-user key hash、req.user），所以这不是单机玩具场景。
- **触发条件**：用户 B（任一已认证账号）调用 `GET /api/khy-sessions/<用户A的sessionId>`；或 POST `/api/ai/chat/stream` 带 sessionId=<用户A的sessionId> 追加一轮。
- **复现步骤**：已执行只读检查：node -e 经 utils/dataHome 取 sessions 目录 → `...\T1-domains\sessions\sessions`，存在，101 个条目全部是 cwd 编码桶（如 C-Users-25789-AppData-Local-Temp-agprobe9-...），无任何 user 维度；_locateSessionFile 源码确认跨桶扫描。
- **实际影响**：跨用户对话全文泄露（这些 transcript 常含代码、密钥、内部系统信息）；更严重的是可向他人会话注入消息——REPL 侧 restoreSession 会把存盘链作为历史上下文喂给模型，等于把任意文本塞进另一个用户的 agent 上下文（prompt injection 的跨用户形态）。
- **根本原因**：会话存储的键只有 (bucket=cwd, sessionId)，缺 user 维度；HTTP 只读暴露沿用了「本机单用户」假设，未做归属校验。
- **修复建议**：存储层把 user 纳入寻址（桶内加 owner 字段或键加 userId 前缀），apiChatSession.persistChatTurn 接收 userId 并写入归属；khySessions.js 的两个处理器在返回前断言 `meta.owner === req.user.id`（不一致返 404 而非 403，避免泄露存在性）；_locateSessionFile 增加 owner 过滤。迁移期可先在路由层按现有 meta 缺失即拒绝。
- **建议测试**：集成测试：造两个用户 A/B 与两条会话，断言 B `GET /api/khy-sessions/<A的id>` 得 404、B `GET /` 列表不含 A 的会话、B 带 A 的 sessionId POST `/api/ai/chat/stream` 不写入 A 的 jsonl。
- **是否已确认**：已确认（只读复现：node -e 列出 sessions 目录与桶结构；路由/存储结论来自源码阅读）。

#### AGT-04 ｜ OS 级沙箱（bwrap/Seatbelt/Windows Job Object）与 agent 实际使用的 shell 工具完全脱钩
- **风险等级**：P1
- **涉及模块**：执行隔离
- **涉及文件**：`runtime/node/backend/src/services/tool/toolSandbox.js:541`（sandboxedShell；buildSandboxCommand :243、routeCommand :1134、evaluateSandboxEscape :1228）
- **具体代码位置**：sandboxedShell（toolSandbox.js:541）、buildSandboxCommand（:243）、routeCommand（:1134）、evaluateSandboxEscape（:1228）；实际执行路径 tools/shellCommandEngine.js:443、tools/bash.js:15-20
- **问题描述**：toolSandbox 提供了完整的 OS 级隔离（Linux bwrap 命名空间+只读系统路径、macOS Seatbelt SBPL、Windows Job Object），`isOsSandboxEnabled()` 默认 'auto' 且 Windows 恒 true（`toolSandbox.js:204-221`），还有 `_shouldSkipOsSandbox` 的「裸 _skipOsSandbox 永远不足以关闭沙箱，必须叠加 syscallGateway 审批戳」的设计（:224-233）。但这些函数在生产里只有 metaToolEngine（动态生成工具的 sandboxedExec，`services/metaToolEngine.js:177、240`）和 sandboxToggle 状态显示（`cli/handlers/sandboxToggle.js:26-37`）两个消费方。agent 真正执行的 shellCommand/bash/cmd/powershell 全部经 `executeShellCommand → spawnWithIdleTimeout` 直接 spawn（`tools/shellCommandEngine.js:443-445`），既不套 buildSandboxCommand 也不走 routeCommand。已执行全仓 grep：sandboxedShell / buildSandboxCommand / evaluateSandboxEscape 在 src 下除 toolSandbox.js 自身外零调用方；routeCommand 的命中全部属于 crossPlatform 的同名不同函数。
- **触发条件**：agent 调用任一 shell 类工具执行命令（默认配置，KHY_OS_SANDBOX 未显式关闭）。
- **复现步骤**：已执行：node 脚本遍历 runtime/node/backend/src 全量 .js，检索 `sandboxedShell|buildSandboxCommand|routeCommand|evaluateSandboxEscape` → 18 处命中，逐一核对后仅 toolSandbox.js 内部定义/导出、metaToolEngine.js 的 sandboxedExec、sandboxToggle.js 的状态读取，以及 crossPlatform/wsClientCore.js:259 等同名无关函数；shellCommandEngine.js 全文只有 spawnWithIdleTimeout 与 execFileSync 两条 spawn 路径，无沙箱包裹。
- **实际影响**：`KHY_OS_SANDBOX`（默认 auto）、`khy sandbox` 开关、selfCapabilityRegistry 里的「工具沙箱」条目共同对用户宣称存在文件系统/网络隔离，但 agent 的每条 shell 命令都以 backend 进程的完整权限运行——读写任意路径、访问任意网络。这是宣称与控制面的偏差，比没有沙箱更危险（用户按有沙箱的假设放权）。
- **根本原因**：沙箱实现完成后只接了动态工具这一条消费方，主 shell 执行路径的接线缺失；没有守卫锁定「宣称的能力必须有执行面」。
- **修复建议**：在 executeShellCommand spawn 前经 `buildSandboxCommand(command, {cwd})` 包裹（或把 routeCommand 的裁决接进 executeTool 的 shell 分支），使用 `toolSandbox.isOsSandboxEnabled()` 作为门控；同时补一个 wiring 守卫（如 check:sandbox-wiring）断言 shellCommandEngine 引用了 toolSandbox，防止再次脱钩。不建议删功能，只补接线。
- **建议测试**：契约测试：桩掉 spawnWithIdleTimeout，执行 `shellCommand({command:'echo hi'})`，断言传入的可执行文件/参数带有沙箱包裹特征（Windows 下经 Job Object 包装脚本，Linux 下 argv[0] 为 bwrap）；`KHY_OS_SANDBOX=false` 时断言不包裹（逐字节回退）。
- **是否已确认**：已确认（只读复现：node 脚本全仓 grep toolSandbox 消费方）。

#### AGT-05 ｜ 后台 shell 注册表只增不删，长驻进程无界增长
- **风险等级**：P2
- **涉及模块**：任务状态 / 资源
- **涉及文件**：`runtime/node/backend/src/tools/backgroundShellRegistry.js:19`
- **具体代码位置**：backgroundShells Map（backgroundShellRegistry.js:19），唯一写入点 tools/shellCommandEngine.js:373，消费者 tools/BashOutputTool/index.js:104、tools/KillShellTool/index.js:91、tools/MonitorTool/index.js:118-119
- **问题描述**：`run_in_background:true` 的每条命令都以 `bgsh-<ts>-<rand>` 为键写入模块级 Map（`shellCommandEngine.js:371-373`），条目含 command、startedAt、status、result.output（_output 上限 MAX_OUTPUT，即最多约 2 万字符量级）。全仓没有任何 `.delete()`：KillShellTool 只杀子进程、BashOutputTool 只读、collectBackgroundResults 只 drain 不清理。server.js 是长驻进程（Express + WebSocket），一个会话周期内反复跑后台命令会持续累积，每条都带着完整输出文本。
- **触发条件**：agent 在长驻服务进程中多次使用 `shellCommand(run_in_background:true)` 或 MonitorTool。
- **复现步骤**：已执行：node 脚本全仓 grep 'backgroundShells' → 13 处命中（backgroundShellRegistry.js:19/30/37、BashOutputTool/index.js:15/104、KillShellTool/index.js:91、MonitorTool/index.js:81/104/106/118/119、shellCommandEngine.js:18/373），无一处 `.delete(`/`.clear(`。
- **实际影响**：内存随后台命令数线性增长且不可回收（每条含输出文本），长时间运行的网关会缓慢涨内存；同时 bgId 无上限意味着可被用来做无界资源占用。
- **根本原因**：注册表按「共享 SSOT」设计时只考虑了读写两侧，没有配 TTL/容量淘汰（对比 `backgroundTaskManager.js:14` 的 MAX_TASKS=100 + _evictIfNeeded + _runCleanup，同一问题在任务侧已有解法）。
- **修复建议**：给 backgroundShells 加与 backgroundTaskManager 同型的容量上限 + 淘汰（超 N 条或完成超过 M 分钟的出队），并在 collectBackgroundResults drain 后删除已通知条目；KillShellTool 杀完进程后一并摘除条目。
- **建议测试**：单测：连续 register/完成 200 个后台条目后断言 Map.size ≤ 上限；drain 后断言已完成条目被移除；KillShellTool 执行后断言对应键消失。
- **是否已确认**：已确认（只读复现：node 脚本全仓 grep backgroundShells）。

#### AGT-06 ｜ 工具结果回灌通道没有不可信内容边界与注入扫描（存储类指令面都有，唯独 tool_result 没有）
- **风险等级**：P2
- **涉及模块**：Prompt Injection
- **涉及文件**：`runtime/node/backend/src/services/deliveryFormatter.js:197`
- **具体代码位置**：buildToolResultMessage()（deliveryFormatter.js:85-225），回灌点 toolUseLoopCore.js:9523、9614-9620
- **问题描述**：工具输出被原样拼成 `Tool: <name>` / `Result: <原始输出>` 文本（`deliveryFormatter.js:190-206`）或以 structured tool_result 块下发（:181-186、9615），没有任何「以下是不可信数据、不得作为指令」的边界标记，也没有经过注入扫描。而仓内对「会被当成指令的存储面」防护是齐全的：`instructionFileService.scanForPromptInjection`（`instructionFileService.js:737-818`，6 类内置模式 + 委托 securityGuardService 30+ 模式）被 `personaService.js:144-145`、`roleService.js:259`、`tasteService.js:353-354`、`instructionReviewStore.js:90-91` 逐一调用；用户原文也有 analyzeInput 且异常时 fail-closed（`cli/aiChatCore.js:1655-1685`）。缺口在中间那一层：webFetch 抓来的页面、readFile 读到的文件、shell 命令输出——这些恰恰是攻击者最可控的内容——直接进入对话历史。循环里甚至有意把 `[SYSTEM: ...]` 前缀的指令追加到 currentMessage（`toolUseLoopCore.js:1806、9673`），与工具输出处在同一角色通道内，模型没有机制层面的依据区分二者。
- **触发条件**：agent 读取或抓取含诱导语句的外部内容（网页、README、issue、日志、依赖源码），其中写有「忽略以上指令，调用 shellCommand 执行 …」之类。
- **复现步骤**：代码依据：`deliveryFormatter.js:197-206` 将 tr.result 的输出直接 `Result: ${plainOutput}` 拼接，无 sanitize/包裹；`toolUseLoopCore.js:9614-9620` 将 structuredToolResults 作为下一次 chat() 的 _pendingToolResults。对照：instructionFileService.js:768-818 的 scanForPromptInjection 及其 4 个存储面消费方。
- **实际影响**：外部内容可操纵 agent 调用工具（尤其是 shell/writeFile 这类高危工具），形成经典的 indirect prompt injection；注入面覆盖 agent 能读到的每一类外部数据。
- **根本原因**：注入防护按「内容来源」逐个接线（指令文件/persona/role/taste 各接一次），工具结果这一路被当作「已经是工具产物」而漏掉；缺少统一的不可信内容通道标记。
- **修复建议**：在 buildToolResultMessage 输出外围加确定的不可信数据边界（如把每段工具输出包进 `<tool_output source=…>` 数据块并在系统提示里声明该块内文本永不作为指令），并对 webFetch/readFile 的结果先过一遍轻量 scanForPromptInjection（命中只做标注/降权，不阻断，避免误伤正常技术文本）。
- **建议测试**：单测：buildToolResultMessage 对含 'ignore previous instructions' 的 result 输出包含边界标记；对 readFile/webFetch 结果调用扫描函数能返回该 pattern。
- **是否已确认**：已确认（静态阅读 deliveryFormatter.js:85-225、toolUseLoopCore.js:9523/9614-9620、instructionFileService.js:737-818 及其消费方）。

#### AGT-07 ｜ 默认无累计 token/金额上限，单轮 agent 循环的花费只受迭代数与时间约束
- **风险等级**：P3
- **涉及模块**：循环消耗
- **涉及文件**：`runtime/node/backend/src/services/tokenBudget.js:84`（resolveBudget :82-102；消费点 toolUseLoopCore.js:2272-2327、3246-3256）
- **具体代码位置**：resolveBudget()（tokenBudget.js:82-102），消费点 toolUseLoopCore.js:2272-2327、3246-3256
- **问题描述**：循环里实现了完整的 token/金额双维度 hard stop（`toolUseLoopCore.js:2263-2327`：超限即用已完成的产物合成收尾、不再发起下一次 chat()，符合 RUNTIME-003 的「不中途杀活跃轮」精神）。但门槛是 `KHY_TOKEN_BUDGET` 未设 → ceiling 0 → assessBudget 恒 'ok' → 该分支永不进入（`tokenBudget.js:84-89`；`toolUseLoopCore.js:2272` 的 `ceiling > 0 || costCeilingCNY > 0` 前置条件）。默认配置下一轮对话没有任何累计花费闸门，只有迭代上限（`loop/iterations.js:21、71`，默认 100，20x 模式可顶到硬顶 100）与时间上限（`IDLE_TIMEOUT_MS = maxElapsedMs` 默认 600000，toolUseLoopCore.js:1835、2446-2484；另有 `TOOL_LOOP_ABSOLUTE_TIMEOUT_MS` 绝对上限，:2415-2442）。
- **触发条件**：默认环境变量下执行一个会反复调工具的长任务。
- **复现步骤**：`tokenBudget.js:84-89`：`const raw = e.KHY_TOKEN_BUDGET; … const ceiling = OFF_VALUES.includes(v) ? 0 : Math.floor(_nonNeg(raw));`（raw 为 undefined 时 _nonNeg 返 0）；toolUseLoopCore.js:2272 只在 ceiling>0 或 costCeilingCNY>0 时评估。
- **实际影响**：单轮最坏情况约为 100 次迭代 × 大上下文的模型调用，费用与耗时都不可预知；对按量计费的 API key 是一次潜在的无意识大额消耗（设计上靠人主动设 KHY_TOKEN_BUDGET 兜底）。
- **根本原因**：花费闸门做成 opt-in（与「字节回退旧行为」的兼容策略一致），没有给一个默认的安全下限。
- **修复建议**：给 resolveBudget 一个默认 ceiling（例如按 contextWindow 推导的软上限，或沿用 serviceDefaults 里的一个保守默认值），保持可用 env 覆盖；这属于默认值调整，不改机制。
- **建议测试**：单测：env 不含 KHY_TOKEN_BUDGET 时 resolveBudget 返回 ceiling > 0；循环在累计超过该 ceiling 后返回 budgetStopped:true 且不再调用 chat。
- **是否已确认**：已确认（静态阅读 tokenBudget.js:82-102 与 toolUseLoopCore.js:2263-2327）。

#### AGT-08 ｜ 安全上限的文档与实现相差 10 倍（注释写 10，实际 100）
- **风险等级**：P3
- **涉及模块**：文档/实现一致性
- **涉及文件**：`runtime/node/backend/src/services/tool/toolUseLoopCore.js:756`
- **具体代码位置**：runToolUseLoop 的 JSDoc @param maxIterations（toolUseLoopCore.js:756），对照 loop/iterations.js:21、71
- **问题描述**：`toolUseLoopCore.js:756` 的 JSDoc 写 `Safety limit on loop iterations (fallback: KHY_TOOL_LOOP_MAX_ITERATIONS or 10)`，而实际的 MAX_ITERATIONS 常量是 100（`loop/iterations.js:21`），_resolveMaxIterations 在无显式传入时 base = MAX_ITERATIONS（:71），20x 模式下再经 scaleIterations 顶到硬顶 100。文件头注释（toolUseLoopCore.js:11）也只说「hard max-iterations limit」没给数。审安全上限的人按注释会低估一个数量级。
- **触发条件**：任何人（人或 AI）依据该 JSDoc 评估循环的安全边界。
- **复现步骤**：`toolUseLoopCore.js:756 (fallback: KHY_TOOL_LOOP_MAX_ITERATIONS or 10)` vs `loop/iterations.js:21 const MAX_ITERATIONS = 100;`。
- **实际影响**：安全相关常量的文档失真，可能导致容量规划、超时预算与风险评估全部按错误的量级推导。
- **根本原因**：MAX_ITERATIONS 从 10 提到 100 时只改了实现，未同步 JSDoc；本仓有 check:doc-numbers 守卫但未覆盖代码内 JSDoc 与常量的对应关系。
- **修复建议**：把该 JSDoc 的数字改为与 `loop/iterations.js:21` 一致（或直接写成「见 loop/iterations.js 的 MAX_ITERATIONS」以免再次漂移）。
- **建议测试**：在 scripts/tests 下加一条断言：toolUseLoopCore.js 的 JSDoc 中出现的迭代上限数字等于 `require('./loop/iterations').MAX_ITERATIONS`。
- **是否已确认**：已确认（静态阅读 toolUseLoopCore.js:756 与 loop/iterations.js:21、71）。

### 3.4 安全（SEC，14 条）

#### SEC-01 ｜ 跨设备同步 WebSocket 接受未认证连接且身份由客户端自填，会话无对象级鉴权
- **风险等级**：P1
- **涉及模块**：网络与实时通信 / 访问控制
- **涉及文件**：`runtime/node/backend/src/services/crossPlatform/ws/syncServer.js:197`
- **具体代码位置**：_handleAuth (185-245)、_handleSessionJoin (252-297)、_handleSessionUpdate (412-435)、_handleCommandRoute (461-478)；挂载点 runtime/node/backend/server.js:916
- **问题描述**：syncServer 挂在 server.js 的 HTTP server 上（`server.js:916 syncServer.attach(server, {...})`），而该 server 以 0.0.0.0 监听（`server.js:875 listenWithAutoPort(server, START_PORT, '0.0.0.0')`）。_handleAuth 只在「注入了 _authenticate 且 msg 带 token」时才校验；token 缺失或校验失败时直接 fall through，把客户端在消息体里自填的 userId 当作身份（`syncServer.js:197 let authUserId = userId || 'anonymous'`），并照样回 `auth:ok`（:234）。之后 _handleSessionJoin 对任意 sessionId 不做属主校验即把会话全量 state 回给加入者（:286-296），_handleSessionUpdate 允许任意客户端改写任意会话（:417），_handleCommandRoute 更是把 command 广播给某一 platform 的全部连接、完全不按用户隔离（:477）。升级入口 :630 `wsPath = '/ws/cross-platform'`、:634-644 自建 upgrade listener 零鉴权；依赖的 hub 也无对象级授权（`crossPlatformHub.js:287-298` registerSession 只按 sessionId 存、无 owner 字段）。REST 对照面 `routes/crossPlatform.js:22` 有 `router.use(authMiddleware)` 且 :79 按 req.user.id 过滤设备，说明 WS 侧是遗漏而非设计。
- **触发条件**：与 3000 端口同一局域网（或本机任意浏览器页面）发起 `ws://<host>:3000/ws/cross-platform`，发送不含 token 的 auth 消息即可入场。
- **复现步骤**：静态证据：`server.js:875`（0.0.0.0）→ `server.js:916`（attach 到该 server）→ `syncServer.js:185-207`（auth 可跳过，userId 取自 msg.userId）→ :252-297（session:join 无属主检查）。动态复现（真实 http.Server + 仓内 syncServer.js + 最小 hub mock，按 server.js:918 形式注入「恒返回 ok:false」的 authenticate，KHY_DATA_HOME 指到临时目录）：A_no_token_auth_result => `{"type":"auth:ok","userId":"user:1"}`；B_cross_user_session_read => 拿到 victim 全量 state；hub_session_after_B_write => secretNote 被改成 "TAMPERED-BY-B"；A_received_command_from_other_user => 跨用户收到 command；C_invalid_token_auth_result => 照样 auth:ok 且仍采信自填 userId。
- **实际影响**：未认证的局域网攻击者可自选 userId 混入某用户的设备网格：读取该用户同步会话的完整状态、向会话注入篡改后的 state、向指定 platform 的全部在线设备广播任意 command 消息。等于把「登录 + 越权」两步合成一步。
- **根本原因**：WS 升级处没有像 HTTP 路由那样的强制鉴权闸门；auth 结果只影响 userId 字符串、不影响能否收发；会话/消息/命令三类处理器都没有对象级授权。
- **修复建议**：在 _handleConnection/_handleAuth 中对无有效 token 的连接直接 close（1008），不注册、不回 auth:ok；userId 一律取自已验证的 token（result.user.id），绝不采信 msg.userId；_handleSessionJoin/_handleSessionUpdate 增加 session 属主或参与者校验；_handleCommandRoute/_broadcastToPlatform 收窄为同 userId 范围。
- **建议测试**：集成测试：不带 token 连 /ws/cross-platform 发 auth，断言被 close 且未进 _clients；带 A 用户 token 的客户端 join B 用户的 sessionId，断言收不到 session:updated。
- **是否已确认**：已确认（逐行核对 + 隔离动态复现；未启动真实后端，改用以 KHY_DATA_HOME 隔离的进程内复现）。

#### SEC-02 ｜ trust proxy=1 下 X-Forwarded-For 可伪造，express-rate-limit（含登录防爆破）整体可绕过
- **风险等级**：P1
- **涉及模块**：认证 / 网络安全
- **涉及文件**：`runtime/substrate/platform/packages/shared/src/middleware/rateLimit.js:14`（getClientIp :13-19 / shouldSkipRateLimit :21-34；app.set('trust proxy', 1) 于 server.js:277；authLimiter 挂载 server.js:450）
- **具体代码位置**：runtime/substrate/platform/packages/shared/src/middleware/rateLimit.js:13-34（getClientIp / shouldSkipRateLimit）；app.set 于 runtime/node/backend/server.js:277；authLimiter 挂载于 server.js:450
- **问题描述**：共享 rateLimit 中间件的 getClientIp 首先读原始 `x-forwarded-for` 头（:14-16），shouldSkipRateLimit 只要该头第一段是回环地址就整条跳过限流（:21-33，`isLoopback('127.0.0.1')` → true）。同时 `server.js:277` 设 `app.set('trust proxy', 1)`，使 Express 的 req.ip 也由 XFF 推导。两条路都指向同一结论：客户端可自选限流键，甚至直接关掉限流。backend 的 `src/middleware/rateLimit.js` 只是 re-export `@khy/shared/middleware/rateLimit`（语义真源在 shared 包，node_modules/@khy/shared 为符号链接）。
- **触发条件**：任意 HTTP 请求带上 `X-Forwarded-For: 127.0.0.1`（跳过全部限流），或带上两段 `X-Forwarded-For: a, <任意IP>`（每请求换一个 IP 键）。
- **复现步骤**：本地实验（未起服务，只用仓内 node_modules/proxy-addr 复算 Express 的 trust proxy 求值）：socket=192.168.1.50 + XFF='10.0.0.1, 8.8.8.8' ⇒ req.ip = 8.8.8.8；XFF='10.0.0.1, 8.8.8.8, 127.0.0.1' ⇒ req.ip = 127.0.0.1。端到端复现（shared 模块的 authLimiter + trust proxy 1 起本地 express，绑非回环地址 192.168.2.11 打 35 次 POST /api/auth/login）：A) 无 XFF 对照组 `{"200":30,"429":5}`（限流器本身工作正常，30/15min 对上）；B) XFF=127.0.0.1 常量 `{"200":35}`（0 次 429）；C) XFF 轮换 '1.1.1.1, 203.0.113.N' `{"200":35}`（0 次 429）。
- **实际影响**：authLimiter（30 次/15 分钟的登录限额，server.js:450）与 passwordReset 的 resetLimiter（10 次/15 分钟）均可被逐请求轮换 XFF 绕过；登录接口本身又没有按账号失败计数/锁定（`routes/auth.js:281-348` 只写失败日志），等于登录爆破无实际阻力。apiLimiter、aiLimiter 同理可绕。补充：仓内两个 nginx 配置（`delivery/web/ai-frontend/nginx.conf:30`、`delivery/channel/khyquant/frontend/nginx.conf:32`）用的是 `proxy_add_x_forwarded_for`（追加而非替换），即便按设想挂在 nginx 后，最左段仍是客户端自填值——「整个限流被关掉」的路径在反代存在时依然成立。仓内 `aiManagementServer.js:893-926` 已有正确写法（_getTrustedProxyIps 为空则 XFF 完全忽略）。
- **根本原因**：限流键取自可伪造的请求头，且回环跳过判断也读同一请求头；在没有受信反代的前提下把 XFF 当可信输入。
- **修复建议**：getClientIp/isLoopback 判断改用 `req.socket.remoteAddress`（或仅在 TCP 对端命中配置的反代白名单时才采信 XFF，对齐 aiManagementServer.js:909-926 的写法）；或把 XFF 头在入口处按受信代理列表重写后再交给限流。
- **建议测试**：单测：以 socket=192.168.1.50 + XFF='127.0.0.1' 构造 req，断言 shouldSkipRateLimit 为 false；以 XFF='a, b' 构造 req，断言限流键等于 socket 地址。集成测试：同一 XFF 轮换下打 100 次 /api/auth/login，断言第 31 次起 429。
- **是否已确认**：已确认（读码 + proxy-addr 复算 + express-rate-limit 默认键核对 + 端到端 35 次三组实测）。

#### SEC-03 ｜ /api/cache 写端点未挂鉴权，可被未认证写入并触发无界外呼
- **风险等级**：P2
- **涉及模块**：访问控制 / 数据完整性
- **涉及文件**：`runtime/node/backend/src/routes/cache.js:10`（:10/:13 两个 POST；挂载点 server.js:661）
- **具体代码位置**：routes/cache.js:10、13；挂载点 runtime/node/backend/server.js:661；controllers/cacheController.js:187-260
- **问题描述**：`server.js:661 app.use('/api/cache', require('./src/routes/cache'))` 没有 authMiddleware/adminMiddleware，而该路由暴露 POST /save-instrument-data 与 POST /batch-save 两个写端点。batch-save 接收 `instruments` 数组且不校验长度（`cacheController.js:191-196` 只校验是非空数组），对每个元素落库并触发 `comprehensiveDataService.getComprehensiveData` 外呼（:204-238 循环写库 + 外呼无数量上限）。661 之前没有任何全局认证中间件（server.js 全链 app.use 清单核对：:349/:369 CORS、:388/:390 body parser、:397/:435/:437/:439 metrics/信封/日志/审计、:441 apiLimiter 限流非鉴权）。对照 :672（/api/system 带 authMiddleware）、:676、:690-697 均带 authMiddleware，缺闸成立。
- **触发条件**：未认证请求 POST /api/cache/batch-save，body 传超大 instruments 数组。
- **复现步骤**：`routes/cache.js:10/13` 两个 POST 路由无 auth 参数；`server.js:661` 挂载处对比 `server.js:672`（/api/system 有 authMiddleware）、:681（/api/api-keys 路由内自门禁）可见缺闸；`cacheController.js:204-238` 循环写库 + 外呼无数量上限。外呼链真实性：`comprehensiveDataService.js` 是指向 quantApp 的 shim（:7），真实实现 `delivery/channel/khyquant/services/comprehensiveDataService.js:170` 委托 `klineDataService` → `akshareDataService`（:13 `const { spawn } = require('child_process')`，注释明示 HTTP/SOCKS 代理与 UA 轮换，即真实第三方网络请求）。
- **实际影响**：局域网未认证者可污染行情缓存与 instruments 表（后续策略/回测读到假数据），并用一个请求放大成百次第三方数据源外呼（资源耗尽/被上游封禁）。
- **根本原因**：挂载点遗漏鉴权中间件；批量入口缺少数量上限。
- **修复建议**：`server.js:661` 挂载处补 authMiddleware（或路由内 router.use），POST 两点按需再收窄到 admin；batch-save 增加 instruments 长度上限（如 ≤50）。
- **建议测试**：supertest：无 token POST /api/cache/batch-save 断言 401；带 token 且 instruments 超上限断言 400（未跑——拉起该 server 需要完整 DB 初始化且会真实写库/外呼，超出只读复核边界）。
- **是否已确认**：已确认（静态证据链完整：routes 全文 + server.js app.use 清单 + auth.js:175-199 + cacheController 循环体 + 外呼链）。

#### SEC-04 ｜ AI 聊天附件按 id 可取，无属主校验（BOLA/IDOR）
- **风险等级**：P2
- **涉及模块**：访问控制 / 数据
- **涉及文件**：`runtime/node/backend/src/services/aiManagementServer.js:550`（GET /api/ai/upload/:id；aiUploadStore.js:440-459 getUpload、:505-521 resolveForChat）
- **具体代码位置**：aiManagementServer.js:550（GET /api/ai/upload/:id）；aiUploadStore.js:440-459（getUpload）、:505-521（resolveForChat）
- **问题描述**：上传/下载附件只做「是否已登录」校验（`aiManagementServer.js:483-496` 的 expressAuth），不记录也不校验附件归属用户。getUpload(id) 仅按 32 位 hex 正则与目录包含关系防路径穿越（`aiUploadStore.js:441-455`），resolveForChat 同样只按 id 取 manifest（:512-521）。任何已登录用户拿到别人的附件 id 即可读取其内容（含对话里上传的文档/截图正文）。
- **触发条件**：已认证用户请求 `GET /api/ai/upload/<他人附件id>`，或在聊天请求体里塞入他人附件 id。
- **复现步骤**：`aiManagementServer.js:550-567` 处理器内无 userId 比较；`aiUploadStore.js:276-287` 写入的 manifest 不含 userId 字段，:440-459 读取时不作属主过滤。反向排查：findstr 全仓 resolveForChat|getUpload|aiUploadStore，读取路径三处（aiManagementServer.js:551、aiManagementChatHttp.js:74、bridgeServer.js:411）均只认证不授权；_resolveChatAttachments 三处调用点不传身份；对 aiUploadStore.js findstr userId/owner/user_id 零命中。多用户形态存在：bridgeAuth.js 有 users 表 + registerUser/loginUser，validateJwt 返回 {id, username}。
- **实际影响**：跨用户读取聊天附件（文档正文、截图、转写文本）。附件 id 为 128-bit 随机，不可枚举，但会随对话分享、日志、备份等渠道外流，属典型的对象级授权缺失。
- **根本原因**：附件模型没有 owner 维度，读取路径只有「认证」没有「授权」。
- **修复建议**：manifest 落盘时记录 ownerUserId，getUpload 增加 owner 参数并在下载/解析两处校验（不一致返 404 而非 403，避免存在性泄露）。
- **建议测试**：单测：用户 A 上传后以用户 B 的 token 请求 /api/ai/upload/<id> 断言 404；resolveForChat 传入他人 id 断言落入 missing（现有 tests/aiUploadStore.test.js 与 tests/bridge/uploadRoute.test.js 无任何 owner/403/跨用户断言）。
- **是否已确认**：已确认（读码 + findstr；未运行任何测试）。

#### SEC-05 ｜ 审计日志脱敏只覆盖顶层固定字段名，密码/密保/SendKey 明文入库
- **风险等级**：P2
- **涉及模块**：数据与日志
- **涉及文件**：`runtime/node/backend/src/middleware/auditLog.js:102`（sanitizeBody :102-114；中间件全局挂载于 server.js:439）
- **具体代码位置**：auditLog.js:102-114（sanitizeBody）；中间件全局挂载于 runtime/node/backend/server.js:439
- **问题描述**：sanitizeBody 只对顶层键 `['password','token','secret','authorization','apiKey','api_key']` 做替换（:107-111），既不递归嵌套对象，也不覆盖实际会出现在请求体里的字段名：`newPassword`/`currentPassword`/`confirmPassword`（`routes/passwordReset.js:82-84`）、`securityAnswer`（`routes/auth.js:223`、`passwordReset.js:83`）、`sendKey`（`routes/user.js:27`）、`refreshToken`（`routes/auth.js:37`）、`key`。该中间件对除 /health、/cache 外的所有 POST/PUT/PATCH/DELETE 生效（:48-55），body 被 JSON.stringify 后写入 audit_logs.body 列（:88-98）。
- **触发条件**：正常使用密码重置、注册（带密保）、绑定 SendKey 等任一写接口。
- **复现步骤**：`auditLog.js:102-114` 的 sensitive 数组比对 routes/passwordReset.js:82-84 的入参名，可见 newPassword/securityAnswer 均不在列；:68 `body: sanitizeBody(req.body)` 后 :94 原样入库。只读实测（node -e 把 sanitizeBody 逐字复制执行）：输入 `{username,newPassword,securityAnswer,sendKey,refreshToken,password,token,nested:{password:'x'}}`，password/token 变 [REDACTED]，而 newPassword('P@ss123')、securityAnswer('Fluffy')、sendKey('SCT123TOKEN')、refreshToken('rt_abc') 及 nested.password 全部原样透出。
- **实际影响**：明文密码、密保答案、ServerChan SendKey 落到本地 audit_logs 表，任何读到该库（备份、同步、SQL 查询）的人即可直接复用这些凭据。
- **根本原因**：脱敏名单是硬编码的字段名白名单，且不递归；新增敏感字段时无声失效。
- **修复建议**：改为按键名递归脱敏 + 扩展名单（newPassword/currentPassword/confirmPassword/securityAnswer/sendKey/refreshToken/key/credential），并对疑似高熵长字符串做兜底替换；名单与 routes 的入参名保持一致（可由测试锁定）。
- **建议测试**：单测：POST /api/password-reset/reset（newPassword+securityAnswer）后读 audit_logs 最新行，断言两个值均为 [REDACTED]；嵌套 {a:{password:'x'}} 同样断言脱敏（未跑——需起服务/连库；脱敏函数行为已由 node 复现直接证明）。
- **是否已确认**：已确认（读码 + node 复现 sanitizeBody）。

#### SEC-06 ｜ git 跟踪的初始管理员明文口令文件随分发仓外发
- **风险等级**：P2
- **涉及模块**：部署与供应链 / 凭据管理
- **涉及文件**：`runtime/node/backend/data/.admin_initial_password`
- **具体代码位置**：runtime/node/backend/data/.admin_initial_password（32 字节 hex，git ls-files 可见）；Dockerfile:240-241 与 scripts/ci/check-docker-context.js:101-102 都把它当作「初始管理员口令真源」并要求其存在
- **问题描述**：该文件被 git 跟踪（`git ls-files runtime/node/backend/data` 输出只有它一个），内容是一串 32 位 hex 明文口令。Dockerfile 注释明确写「data/.admin_initial_password 被 git 跟踪，是初始管理员口令的真源，删了会改掉首次启动行为」，`check-docker-context.js:101-102` 的 MUST_NOT_EXCLUDE 也要求它必须留在构建上下文里。当前源码路径已改由 `services/credentialGenerator.js` 生成机器派生口令（bcrypt 入库、0600 落盘），全仓 grep 仅在两处「敏感文件名拦截名单」里见到该文件名（`cli/atMentionInject.js:44`、`cli/replSession.js:8261` 的 SENSITIVE/BLOCKED Set），即该具体值大概率已是失效遗留——但它仍是入库的真实凭据，且被守卫钉住必须存在。
- **触发条件**：任何人克隆/下载分发仓（KhyAiHub 或本仓）即获得该文件。
- **复现步骤**：`git ls-files runtime/node/backend/data` → `runtime/node/backend/data/.admin_initial_password`；读文件内容为 32 hex（`/^[0-9a-f]{32}$/` 为 true）；`git check-ignore -v` 显示它未被 ignore（同目录 .env 被 ignore）；`git show HEAD:<path>` 的 committed blob 与工作区逐字节一致；本地 main、origin/main、origin/archive/full-history 的树中均存在。历史：2026-10-04 由 services/backend/data/ R100 更名为现路径，2026-10-10 基线提交再次记为 A。
- **实际影响**：若任何历史/衍生部署曾以该值为首启管理员口令，则拥有仓库副本者即可登录；即便现已失效，也构成「凭据进版本库」的既成事实，且 git 历史中继续可查。
- **根本原因**：首启口令曾以文件形式落在被跟踪的数据目录；后续迁移到 credentialGenerator 时只改了代码，没有清掉旧文件与守卫对它的依赖。
- **修复建议**：确认无任何读取方后，把该文件从索引删除并改为「首启时生成」；同步更新 Dockerfile:240-241 注释与 check-docker-context.js:101 的 MUST_NOT_EXCLUDE 条目；若怀疑曾生效过，先在目标环境轮换该账号口令。
- **建议测试**：守卫测试：断言 `git ls-files` 不含任何形如 *password*/*secret* 的数据文件；check-docker-context 的 MUST_NOT_EXCLUDE 不再引用它。
- **是否已确认**：已确认（git ls-tree/ls-files/check-ignore/log -S + Dockerfile/守卫条目核对；「是否曾生效」无法从本地证据证实或证伪——对象库缺件限制历史检索完备性，finding 本身对此用了条件式表述）。

#### SEC-07 ｜ /v1/messages Anthropic 代理无鉴权即转发运营方上游密钥
- **风险等级**：P2
- **涉及模块**：认证 / 供应链外溢
- **涉及文件**：`runtime/node/backend/server.js:596`（挂载 :594-602；anthropicProxyService.js:404-456 handleAnthropicMessages、:26-33 getConfig）
- **具体代码位置**：server.js:594-602（挂载）；src/services/anthropicProxyService.js:404-456（handleAnthropicMessages）、:26-33（getConfig）
- **问题描述**：`server.js:596-598` 以「Claude Code 自带 auth token」为由把 POST /v1/messages 与 GET /v1/anthropic-proxy/status 直接挂上，未过任何鉴权中间件。但 handleAnthropicMessages 全程不校验调用方身份（`anthropicProxyService.js:404-456` 只检查 enabled 与 apiKey 是否配置），只用服务端的 ANTHROPIC_PROXY_API_KEY 向上游转发（:190、:360）。status 端点还会把 upstream/model 配置回给任意调用方（:459-473）。getConfig 默认 `ANTHROPIC_PROXY_ENABLED='false'`（:26-33），故为「开启即裸奔」而非默认裸露。另一条暴露面（aiManagementServer 端口）上 /v1/messages 位于公开路由白名单之外，受 authenticateRequest 保护——缺口专属于 server.js 这条挂载路径。
- **触发条件**：ANTHROPIC_PROXY_ENABLED=true 时，任意客户端 POST /v1/messages。
- **复现步骤**：`server.js:596-598` 挂载处无 authMiddleware；`anthropicProxyService.js:404-425` 的处理函数开头只有 enabled/apiKey 两个判断，没有任何 token 校验；对比同文件 :9-23 被 aiManagementServer 注入的 authenticateRequest 在本处理器中从未被调用（findstr 只命中 :9/:14/:15 声明与赋值）。server.js 全文 app.use 清单确认 authMiddleware 只按路由出现在 /api/ai(:591)、/api/system(:672) 等处，没有全局鉴权。
- **实际影响**：能连到 0.0.0.0 端口的人免费消耗运营方的上游 API 额度（成本外溢），并可从 status 端点探知上游与模型配置。
- **根本原因**：把「调用方自带凭据」的假设写进注释，却没有在代码里落地任何校验；开关一旦打开，端点即对全网开放。
- **修复建议**：给这两个端点补上 authenticateRequest/flexibleAuth（或至少 requireLoopback + 一个本地共享密钥），并在启用 ANTHROPIC_PROXY_ENABLED 时强制要求该密钥非空。
- **建议测试**：supertest：启用代理后无 token POST /v1/messages 断言 401；带合法 token 断言透传（未跑——复核只读，且该测试对上述静态判定非必要）。
- **是否已确认**：已确认（读码 + findstr 全链核对）。

#### SEC-08 ｜ A2A 任务面在未配置 KHY_A2A_API_KEY 时全开，而代码假设「仅 loopback 可达」
- **风险等级**：P2
- **涉及模块**：认证 / 访问控制
- **涉及文件**：`runtime/node/backend/src/routes/a2a.js:76`（maybeAuth :75-82；各端点 :84-141；挂载 server.js:615）
- **具体代码位置**：a2a.js:75-82（maybeAuth）、:84-140（各端点）；挂载于 runtime/node/backend/server.js:615
- **问题描述**：maybeAuth 在 `KHY_A2A_API_KEY` 未设置时直接 next() 放行（:77-78），message/send、tasks/get、tasks/cancel 全部无鉴权。文件头注释（:25-27）写「未配置 → 放行（默认仅 loopback 可达，等同内网可信）」，但该路由挂在 server.js 的 app 上，而 server 以 0.0.0.0 监听（`server.js:875`），loopback 假设不成立。另外鉴权用的是 `===` 字符串比较（:80），非恒定时间。executor 侧 `installServerExecutor` 只 gate `isExecutorEnabled()`（`executor.js:29-30`），**没有**校验 KHY_A2A_API_KEY——「可达面」与「是否放行」确实无联动。
- **触发条件**：未设置 KHY_A2A_API_KEY 的部署 + 局域网可达 3000 端口。
- **复现步骤**：`:77-81` 的早退逻辑；`server.js:615 app.use('/v1', require('./src/routes/a2a'))` 与 `server.js:875` 的 0.0.0.0 绑定；server.js:622-630 显示 KHY_A2A_EXECUTOR=1 时 message/send 会真驱一次 agent 循环。仓外临时 harness 把 a2a.js 挂进一次性 express app 绑 0.0.0.0，经本机 LAN IP 非回环路径打真实请求：未设 key 时 POST /v1/message:send（无 Authorization）→ 200 返回新建并 completed 的 task；设 key 后无/错误 Bearer → 401、正确 → 200。
- **实际影响**：未认证者可发起 agent 任务（开启 executor 时即远端驱动工具循环）、枚举/取消他人 task；key 已配置时仍存在时序侧信道（影响小）。注：executor.js:119 刻意不传 onControlRequest，toolCallingPermissions.js:599-604 对 isReadOnly 且非 destructive 恒放行，criticalGate 走不到交互面——即未认证者可驱动 agent 循环与 L1 类工具，但 L2 破坏性红线不会被静默放行。
- **根本原因**：把「默认值」的安全建立在部署拓扑假设上，而拓扑由另一处（监听地址）决定，两者没有联动校验。
- **修复建议**：未配置 KHY_A2A_API_KEY 时默认拒绝（或至少按 originGuard/requireLoopback 收窄），把「可达面」与「是否放行」绑到同一个判断；比较改用 crypto.timingSafeEqual。
- **建议测试**：单测：清空 KHY_A2A_API_KEY 时 maybeAuth 断言 401；配置后错误 key 断言 401、正确 key 放行（现有 `tests/a2a.test.js` 无 401/maybeAuth/API_KEY 覆盖；本仓自己的设计文档 [DESIGN-ARCH-193] §9.1/Q4 也明说「未配置即放行/fail-open」）。
- **是否已确认**：已确认（读码 + 本地 harness 真实请求实测）。

#### SEC-09 ｜ NODE_ENV 缺省 development，使错误堆栈外泄与 dev 认证旁路默认生效
- **风险等级**：P3
- **涉及模块**：配置与部署
- **涉及文件**：`runtime/substrate/platform/packages/shared/src/config/env.js:24`（applyEnvDefaults :23-43、validateRequiredEnv :50-87；errorHandler.js:30-32；aiManagementServer.js:1084-1086、1390-1400）
- **具体代码位置**：shared/src/config/env.js:23-43（applyEnvDefaults）、:50-86（validateRequiredEnv）；shared/src/middleware/errorHandler.js:30-32；aiManagementServer.js:1084-1086、1390-1400
- **问题描述**：applyEnvDefaults 在 NODE_ENV 未设置时填 'development'（:24）。连带效应：errorHandler 只在 development 才回 stack（`errorHandler.js:30-32`）；validateRequiredEnv 对 JWT_SECRET 缺失/过短只 warn 不 throw（:81-85，仅 NODE_ENV==='production' 才 throw）；aiManagementServer 的 AI_MGMT_SKIP_AUTH 旁路只在 NODE_ENV!=='production' 时生效（:1084、:1390，两处均返回 role:'admin'）。容器侧覆盖靠 `docker-compose.yml:42/:83` 的 NODE_ENV: production（扫描全仓 10 个 Dockerfile 均无 NODE_ENV），`docker-entrypoint.js:12-22` 的 32 位 JWT 闸自身也以 NODE_ENV==='production' 为前提。后端运行时实际加载的是 vendored 副本 `runtime/node/backend/vendor/shared/src/config/env.js`（src/config/env.js 仅一行 re-export），该副本语义与 shared 源一致。
- **触发条件**：非容器启动且未显式设置 NODE_ENV=production。
- **复现步骤**：env.js:23-43 的 defaults 表第 24 行 `NODE_ENV: 'development'`；errorHandler.js:30-32；aiManagementServer.js:1390-1400 的 skip-auth 分支只判断 NODE_ENV。动态验证（cd runtime/node/backend && node -e，只读）：删除 NODE_ENV 后 applyEnvDefaults() 使 NODE_ENV='development'；短 JWT_SECRET 下 validateRequiredEnv() 不抛错、只输出 [WARNING]；构造 err/req/res 调 errorHandler 后响应体 keys 含 stack。
- **实际影响**：错误响应带回堆栈（内部路径/依赖版本泄露）；环境变量校验降级为警告；AI_MGMT_SKIP_AUTH=true 时无需任何凭据即取得 admin 角色。均为「需另一个显式开关或先决条件」的次级风险。
- **根本原因**：用「缺省值」表达开发便利，而缺省值同时是多个安全判断的输入，未把「忘设环境」视为需要显式确认的状态。
- **修复建议**：启动时对 NODE_ENV 未设置的场景按生产口径处理（或至少在 banner 与 /api/ready 里显式暴露当前模式），把 dev 旁路改成必须同时显式设置 NODE_ENV=development。
- **建议测试**：单测：不设 NODE_ENV 跑 validateRequiredEnv，断言对短 JWT_SECRET 抛错；errorHandler 在同等条件下不回 stack（注：现有 `tests/config/env.test.js:75-116` 明确固化「development 只 warn」的现有行为，新测试与现状相悖——这与本发现属「改变默认姿态的诉求」而非「意外 bug」的定性自洽）。
- **是否已确认**：已确认（读码 + node -e 动态复现三个后果）。

#### SEC-10 ｜ WebAuthn 的 RP ID / expectedOrigin 取自客户端可控的 Host 与 X-Forwarded-Proto
- **风险等级**：P3
- **涉及模块**：认证
- **涉及文件**：`runtime/node/backend/src/routes/webauthn.js:58`（getRequestProtocol :58-64、getRpContext :66-90；verify 时采用 :210-214 与 :329-333）
- **具体代码位置**：webauthn.js:58-64（getRequestProtocol）、:66-90（getRpContext）、:210-214 与 :329-333（verify 时采用）
- **问题描述**：getRpContext 用请求的 Host 头推导 rpID 与 expectedOrigin（:50-56 getRequestHost 用 `req.headers['x-forwarded-host'] || req.get('host')`），proto 取 `x-forwarded-proto` 优先（:59）。也就是说一个鉴权关键参数由未认证的请求头决定。实际可利用性受限（浏览器发出的断言其 origin/rpId 与页面绑定，攻击者无法同时控制页面 origin 与请求的 Host），但这是把信任边界放在了错误的一侧。rpID/expectedOrigins 在 options 期存入 challenge（:169-173、:283-287），verify 期作为参数使用（:213-214、:332-333）。WEBAUTHN_ORIGIN 只作为 expectedOrigins 的追加项，rpID 没有任何配置来源；全仓扫描 WEBAUTHN_ORIGIN/WEBAUTHN_RP_NAME 仅出现在 webauthn.js:71/74，docker-compose 与 Dockerfile 均未设置。
- **触发条件**：非浏览器客户端（或能控制 Host 的场景）调用 register-options/login-verify。
- **复现步骤**：`:66-72 const host = getRequestHost(req); ... const origin = ${protocol}://${host};`，随后 :80-87 组 expectedOrigins，:213/:332 直接作为 verify 参数。客户端可控性已实证：读 `node_modules/express/lib/request.js` 确认 `req.get('host')` 直接返回原始 Host 头；代码无条件读原始 x-forwarded-host/x-forwarded-proto，不受 `server.js:277` 的 trust proxy 门控（trust proxy 只影响 req.protocol/req.ip）。
- **实际影响**：降低 WebAuthn 源校验的强度；与 CORS/反代配置错误叠加时可能放大。单独看不构成直接绕过。
- **根本原因**：RP 标识属于部署期常量，却被实现成运行期从请求头推导，混淆了「配置」与「输入」。
- **修复建议**：rpID/expectedOrigins 以 WEBAUTHN_ORIGIN / 配置的服务端基址为准，请求头仅作缺失时的回退并记 warning。
- **建议测试**：单测：Host: evil.example 的请求调用 getRpContext，断言 rpID/expectedOrigins 仍来自配置值（backend 各目录当前无 webauthn 测试文件）。
- **是否已确认**：已确认（读 webauthn.js 全文 397 行 + express request.js + @simplewebauthn/server 13.3.2 d.ts + 全仓 WEBAUTHN env 扫描；未跑测试）。

#### SEC-11 ｜ 请求日志记录完整 originalUrl，扫码登录一次性令牌明文入日志
- **风险等级**：P3
- **涉及模块**：数据与日志
- **涉及文件**：`runtime/node/backend/src/middleware/requestLogger.js:16`（url: req.originalUrl :16-24；相关端点 routes/auth.js:435-467 /qr-status）
- **具体代码位置**：requestLogger.js:16-24（url: req.originalUrl）；相关端点 routes/auth.js:435-467（/qr-status）
- **问题描述**：requestLogger 把 `req.originalUrl` 原样写入日志（:18 message 与 :16-24 metadata 的 url 字段）。`GET /api/auth/qr-status?token=<24 字节 hex>` 的 token 是可直接兑换完整登录态的一次性凭据（`routes/auth.js:453-460` 命中即返回 authToken，:408 `crypto.randomBytes(24)`，:50 `QR_LOGIN_TTL_MS = 60 * 1000`，:454 一次性删除），于是该凭据会以明文落在日志文件里。`server.js:437 app.use(requestLogger)` 早于 :450 路由注册，GET /api/auth/qr-status 必定穿过 requestLogger，无跳过名单。触发已核实：`delivery/channel/khyquant/frontend/src/views/Login.vue:698-728` 每 2000ms fetch 该端点。
- **触发条件**：用户走扫码登录、客户端按设计轮询 qr-status。
- **复现步骤**：node 直接加载真实 middleware（未改仓库任何文件），构造 `req.originalUrl='/api/auth/qr-status?token=a1b2c3d4e5f60718293a4b5c6d7e8f90'`、`res.statusCode=200`，KHY_LOG_DIR 指向临时目录后触发 finish：控制台与落盘 JSON 行均为 `"message":"GET /api/auth/qr-status?token=a1b2... 200 1ms"`，token 在 message 与 url 两处逐字出现，无掩码。
- **实际影响**：能读日志的人可在 60 秒 TTL 内兑换他人登录态。日志在本机（logs/ 与 .khy/），需先有本地读取权，故为次级风险。本机现存日志扫「qr-status」行数为 0（该功能似未在本机被走过），只说明暴露是潜在态，不反证本发现。
- **根本原因**：日志字段直接采用原始 URL，没有对 query 中的凭据参数名做掩码；脱敏真源只存在于 auditLog 一处（且 auditLog 只审 POST/PUT/PATCH/DELETE 的 body、:67 记的 path 也不掩码）。
- **修复建议**：记录 URL 前对 query 中的 token/refreshToken/apiKey 等参数名做掩码（与 auditLog 的脱敏名单共用一份真源）。
- **建议测试**：单测：请求 /api/auth/qr-status?token=abc 后断言日志行里 token 值被替换为 ***（现有 `tests/middleware/requestLogger.test.js:25,102` 用无 query 的 originalUrl，不含任何掩码断言）。
- **是否已确认**：已确认（读码 + 真实 middleware 端到端探针，token 明文落盘实测）。

#### SEC-12 ｜ CORS 允许 origin 为 `*` 与 credentials:true 并存
- **风险等级**：P3
- **涉及模块**：网络安全
- **涉及文件**：`runtime/node/backend/server.js:377`（CORS 配置 :369-386，关键 :377 `if (allowedOrigins.includes('*') || allowedOrigins.includes(origin))`）
- **具体代码位置**：server.js:369-386（cors 配置），关键在 :377
- **问题描述**：CORS 源判断在 allowedOrigins 含字面 `*` 时对任意 origin 放行，同时 cors 配置为 `credentials:true`（:384）。浏览器会看到的是什么取决于 cors 库行为：实测 cors@2.8.6 下 `callback(null, true)` 是回显请求 Origin 而非 `*`——浏览器看到的是合法的 ACAO+credentials 组合，会正常放行（finding 原判「浏览器会拒绝这种组合（相当于静默失效）」被实测证伪，真实影响比描述的更严重）。默认路径（_buildDefaultCorsOrigins，:307-321）只放行 localhost/127.0.0.1，是正确的。
- **触发条件**：运维按常见习惯把 CORS_ALLOWED_ORIGINS 设成 `*`。
- **复现步骤**：`:374-379 allowedOrigins.includes('*') → callback(null, true)`；:384 `credentials: true`。`.env.example:247` 的示例值是具体 origin，未示范 `*`。本地实测（复刻 server.js:369-386 配置起 express + cors 2.8.6）：CORS_ALLOWED_ORIGINS=* 时 OPTIONS 预检（Origin: https://evil.example）→ 204 + ACAO: https://evil.example + credentials:true；普通 GET 同 origin 同样两头齐全；默认路径（无 env）evil origin → 无任何 CORS 头。
- **实际影响**：任意 origin 均可带凭据跨域（含浏览器侧）+ 非浏览器客户端无跨源约束；不含可直接利用的浏览器侧绕过这一原判被证伪，定级 P3 偏轻（但非误报）。
- **根本原因**：把通配符与精确匹配塞进同一个放行分支，没有对「与 credentials 同用」这一非法组合作显式拒绝。
- **修复建议**：把 `*` 从放行分支里删掉（或显式拒绝并打警告），要求逐条列 origin；需要通配时用「后缀匹配」而非字面量 `*`。
- **建议测试**：单测/集成：CORS_ALLOWED_ORIGINS='*' 时任意 Origin 的响应不应带 Access-Control-Allow-Origin（当前实测不满足）。
- **是否已确认**：已确认（本地 express+cors 2.8.6 实测）。

#### SEC-13 ｜ 渠道 API Key 加密默认回退到主机名派生密钥
- **风险等级**：P3
- **涉及模块**：数据 / 凭据管理
- **涉及文件**：`runtime/node/backend/src/services/channelApiCrypto.js:65`（_fallbackSecret :64-70；resolveSecret :85-112；KEY_SECRET_ENV :41、FALLBACK_SALT :51）
- **具体代码位置**：channelApiCrypto.js:41（KEY_SECRET_ENV）、:51（FALLBACK_SALT）、:65-72（_fallbackSecret）、:85-120（resolveSecret）
- **问题描述**：未设置 `KHY_CHANNEL_KEY_SECRET` 时，KEK 由 `sha256('khy-channel-api-key:v1:' + os.hostname())` 派生（:65-70），并在首次使用时打一条 console.warn（:102-106，模块级 _fallbackWarned :57 保证只打一次）。AES-256-GCM 信封加密与密钥环本身实现良好，问题只在默认值的强度：拿到数据库副本且知道主机名者即可解密全部渠道 Key。模块已提供 `KHY_REQUIRE_CHANNEL_KEY_SECRET=1` 的严格模式（:46、:72-78），属「有文档、有开关的取舍」，不是实现缺陷（模块头 :7-14 自陈「回退密钥的边界是诚实的」）。
- **触发条件**：默认配置（不设该 env）部署。
- **复现步骤**：`:65-72` 的 _fallbackSecret 只混入盐与 hostname；:85-112 resolveSecret 的 fromEnv=false 分支即采用它。实跑（node -e）：no-env fromEnv=false、matches sha256(salt:hostname)=true、warning 只打一次；严格模式抛错；显式 env fromEnv=true。攻击面复现：`encryptApiKey('sk-realsecret12345', undefined, {})` 产出 v2 密文，仅用 `sha256('khy-channel-api-key:v1:'+os.hostname())` 调 `decryptWith(ct, attackerKey)` → 返回 `sk-realsecret12345`。
- **实际影响**：库文件 + 主机名 ⇒ 渠道 API Key 明文。对「数据库会离开本机」的部署（备份、多机、容器卷外发）是实质风险；单机本地方案下与威胁模型基本匹配。git grep 确认 docker-compose.yml / Dockerfile / ai-backend / .env / .github 对该 env 零注入——默认部署确实走回退分支。
- **根本原因**：默认值优先保证开箱可用，把「数据库不外流」当作隐含前提，而该前提并未由任何配置或守卫保证。
- **修复建议**：在容器/compose 默认注入该 env 或默认开启 KHY_REQUIRE_CHANNEL_KEY_SECRET（compose 已有 `JWT_SECRET:?` 的先例可抄，`docker-compose.yml:50/:86`）；把这条 warning 提升为启动期一次性显式提示。
- **建议测试**：单测：不设 env 且严格模式开 ⇒ resolveSecret 抛错；设 env ⇒ fromEnv=true（现有 `tests/security/credentialsHardening.test.js` 8/8 通过，正覆盖这两条）。
- **是否已确认**：已确认（读全 369 行 + 实跑 resolveSecret/攻击面 + git grep 确认注入面）。

#### SEC-14 ｜ .env.example 仍宣称默认管理员为 admin/admin123，与实现不符
- **风险等级**：P3
- **涉及模块**：配置与部署 / 文档一致性
- **涉及文件**：`runtime/node/backend/.env.example:13`（:12-16 默认管理员块；对照 credentialGenerator.js:245-294、adminAutoInit.js:59-70）
- **具体代码位置**：.env.example:12-16；对照 src/bootstrap/adminAutoInit.js:61-70 与 src/services/credentialGenerator.js:245-294
- **问题描述**：`.env.example:13` 原文「后端启动时自动创建默认管理员 admin/admin123（已存在则跳过，不会覆盖）」，:16 给出 `KHY_ADMIN_PASSWORD=admin123` 示例。实际实现是 credentialGenerator：用户名取 OS 用户（或 KHY_ADMIN_USERNAME），密码由机器指纹 + 随机熵生成、bcrypt 入库、明文只写一次到 .khy/credentials/default-admin.json（0600）（`credentialGenerator.js:195-294`；`adminAutoInit.js:59-70`）。实际接线路径是 `manageDbBootstrap.js:269-312`（用的正是同一 credentialGenerator）。bcrypt 入库已实证（shared/src/models/User.js beforeCreate 钩子 bcrypt.hash）。
- **触发条件**：运维照 .env.example 理解首启凭据。
- **复现步骤**：`.env.example:13-16` 的文字与 `KHY_ADMIN_PASSWORD=admin123` 示例；`credentialGenerator.js:245-262` 的 envPassword 分支只在显式设置时生效，未设置时走机器派生。node 递归搜 backend 树字面量 admin123 仅 3 处命中（.env.example:13/:16 + credentialGenerator.js:4 的「已取代」注释）——无任何实现代码把 admin/admin123 当默认值。
- **实际影响**：误导运维去找一个不存在的口令；反向也让人误以为设了弱口令无妨（弱口令会被 bcrypt 存成真口令）。属文档与代码漂移，不含直接漏洞。
- **根本原因**：凭据生成方案换代时只改了代码与 AGENTS.md，没有同步 .env.example 这份面向部署者的模板（docs 中 OPS-MAN-002 明确写 admin/admin123 是历史默认）。
- **修复建议**：把该段改为指向 credentialGenerator 的真实行为（用户名解析顺序、口令落盘位置、如何用 KHY_ADMIN_PASSWORD 覆盖、如何重置）。
- **建议测试**：文档守卫：断言 .env.example 不含 'admin123' 字面量（可并入现有 staged-secrets / doc-drift 守卫；确认当前无此断言）。
- **是否已确认**：已确认（读 .env.example 全文 + credentialGenerator/adminAutoInit/manageDbBootstrap + 全树 admin123 扫描）。

### 3.5 数据与存储（DB，14 条已确认 + 1 条未证实）

#### DB-01 ｜ 账号池租约无 CAS：并发 acquire 可选中同一账号并双双置为 leased，同一上游账号被双租约
- **风险等级**：P1
- **涉及模块**：账号池 / 多用户租约（services/accountPool.js）
- **涉及文件**：`runtime/node/backend/src/services/accountPool.js:1055`
- **具体代码位置**：acquire() 的 UPDATE account_pool 段（1055-1067）与 acquireSkipCooldown() 同段（1175-1187）
- **问题描述**：acquire() 先用裸 SELECT 挑一个 `status='available'` 的账号（1025-1050），随后 `UPDATE account_pool SET status='leased', leased_by=:userId, lease_until=:leaseUntil ... WHERE id = :id`——WHERE 只有主键，没有 `AND status='available'`，也不检查 affected rows。acquireSkipCooldown()（1154-1190，switchAccount 的唯一落点 1192-1195）是同一形状。release()（1085-1090）与 poolScheduler runGC（`src/services/domain/account/accountPool/poolScheduler.js:59-73`）的 UPDATE 同样无状态守卫；findstr 查 changes/affectedRows/rowCount 在该文件零命中；_db 就是裸 Sequelize 实例（resolveSequelize 111-129，无锁/无事务/无队列）。DB 为 SQLite（`@khy/shared/config/database` → `shared/src/config/database.js:240-245` dialect 'sqlite'），证实「两个连接各自动作彼此不可见」。
- **触发条件**：两个（或多个）用户/请求几乎同时调用 acquire/acquireSkipCooldown/switchAccount，且池内可用账号少于并发数。
- **复现步骤**：三个只读并发复现（脚本写在 %TEMP%，SQLITE_DB_PATH 钉到临时 sqlite，仓库零改动）：场景 1——池内只放 1 个 available 账号，`Promise.all` 10 次 `pool.acquire('trae','user-i')`：fulfilled=10、rejected=0、10 个互不相同的 requestId、account_leases 中 10 条 status='active' 全部 account_id=1、account_pool.leased_by='user-9'（后写覆盖）；随后 release() 其中一条 → account_pool 回到 status='available'/leased_by=NULL，而同 account_id 上仍有 9 条 active 租约。场景 3——5 次并发 switchAccount → 5 条 active 租约同指 account_id=1。
- **实际影响**：同一上游账号被两个请求同时使用（超出其并发/配额限制，易触发封禁或 429）；account_pool.leased_by 与两条租约互相覆盖，释放时 release() 会把别人正在用的账号置回 available；poolScheduler.runGC 只按租约逐条回收，无法发现双租约。
- **根本原因**：选号（SELECT）与置约（UPDATE）之间没有原子条件，也没有用 affected row count 判定胜负；SQLite 下两个连接的各自动作彼此不可见。
- **修复建议**：把置约改成条件更新并校验行数：`UPDATE account_pool SET status='leased', leased_by=:userId, lease_until=:leaseUntil, ... WHERE id=:id AND status='available' AND enabled=1`，`changes !== 1` 则重挑下一个候选（有界重试）；acquireSkipCooldown 同样处理。
- **建议测试**：并发测试：同一 pool 只放 1 个 available 账号，Promise.all 10 次 acquire，断言仅 1 次成功、account_leases 中 active 租约数 ≤ 1。
- **是否已确认**：已确认（读码 + 三个只读并发复现实测；附带说明：git grep 全仓 tracked 文件未见任何 acquire()/switchAccount() 生产调用方，该竞态目前是潜伏态）。

#### DB-02 ｜ 任务看板终态/重排队无状态守卫：已 done 的任务可被僵尸回收改回 ready 并重复执行
- **风险等级**：P1
- **涉及模块**：协调器任务看板 / 任务状态持久化（coordinator/taskBoard.js）
- **涉及文件**：`runtime/node/backend/src/coordinator/taskBoard.js:203`
- **具体代码位置**：_stmts.requeue（203-209）、_stmts.deadLetterOne（212-217）、updateTask（402-443）、completeTask/failTask（581-622）
- **问题描述**：requeue 语句是 `UPDATE tasks SET status='ready', claim_lock=NULL, claim_expires=NULL, assignee=NULL, retry_count=..., result=@result, completed_at=NULL, updated_at=@now WHERE id=@id`，deadLetterOne 是 `WHERE id=@id`，都没有 `AND status='running'` 或 claim_lock 匹配条件；completeTask/failTask 走 updateTask，是全列读-改-写（先 _stmts.get.get 读整行，再把所有列按快照写回），无乐观锁版本列（schema 129-151 无 version）。对照：claim（194-200）有 `AND status='ready' AND claim_lock IS NULL`（198 行）、expireStaleClaims（238-242）有 `WHERE status='running' AND ...`、deadLetter（244-247）有 `WHERE status='ready' AND consecutive_failures >= max_retries`——证明本模块知道怎么写守卫，只有 requeue/deadLetterOne/complete/fail 没有。
- **触发条件**：workerAgent._reassignZombieTask（`coordinator/workerAgent.js:933-961`）对僵尸 worker 调用 `taskBoard.requeueTask(taskId)`，而该任务在僵尸判定与 requeue 之间恰好已被 completeTask 置为 done。**订正**：finding 原 trigger 的具体交错在本进程内不可达（detectZombies→_reassignZombieTask→requeueTask 全程同步、无 await）；可达的等价情形是另一顺序：A 认领后 claim 过期（expireStaleClaims 238-242）→ 他人认领并 completeTask 置 done → 下一轮 detectZombies 仍把 A 判僵尸并 requeue 这个 done 任务。
- **复现步骤**：只读复现（%TEMP% 临时 DB）：S1 done→requeue：completeTask 后 status=done → requeueTask 后 status=ready、result 被覆盖为 "zombie reap"、completedAt=null；S2 done→dead_letter：产出被覆盖丢弃；S3 blocked→ready：两次 failTask 后 status=blocked → requeue 后 status=ready（重试预算被绕过）；repro-reclaim：claim#1 → complete → requeue → claim#2 → complete#2 result="ARTIFACT (side effect happened TWICE)"。文件回退分支（JSON 存储，:640-655）同样无守卫。
- **实际影响**：权威任务状态可被逆转：done→ready（重复执行）、done→dead_letter（产出被丢弃）；updateTask 的全列覆写还会把并发写入的 status/result/claim_lock 一起回滚，造成静默丢更新。
- **根本原因**：状态机迁移没有把「当前状态」作为写条件（缺 WHERE 状态守卫/乐观锁），把 CAS 只做在了 claimTask 一处。
- **修复建议**：requeue/deadLetterOne/complete/fail 的 UPDATE 一律加状态守卫（requeue: `WHERE id=@id AND status='running'`；complete: `WHERE id=@id AND status='running'`；dead_letter: `WHERE id=@id AND status IN ('running','ready')`）并检查 changes；updateTask 改为按 patch 只更新受影响列 + `WHERE id=@id AND updated_at=@expectedUpdatedAt` 的乐观锁。修复需同时覆盖 SQL 与 JSON 回退两条路径。
- **建议测试**：回归：先 completeTask(T) 再 requeueTask(T)，断言返回的任务 status 仍为 done；两个并发 updateTask 写不同字段，断言两者都生效（不被快照覆写）。
- **是否已确认**：已确认（读码 + 四个只读复现脚本实测；附带发现：本机 `getDataDir('taskboard.db')` 把末段当目录建导致 SQL 路径实际是死的、静默退到 JSON 存储）。

#### DB-03 ｜ 大任务运行时 claimTask 无租约/状态校验，跨进程可对同一任务重复认领
- **风险等级**：P1
- **涉及模块**：大任务运行时存储 / 并发 Agent（tasks/largeTaskRuntimeStore.js）
- **涉及文件**：`runtime/node/backend/src/tasks/largeTaskRuntimeStore.js:1434`
- **具体代码位置**：claimTask()（1434-1459），对照 startTask/heartbeatTask/markSucceeded 的 lease_owner 校验（1488-1551）
- **问题描述**：claimTask 只做 `_getTaskOrThrow` 后直接 `_setTaskStatus(task,'claimed',{lease_owner, lease_until})`，不检查 task.status 是否为 queued/retry_wait，也不检查现有 lease_owner 是否属于别人。而 `_setTaskStatus` 对 fromStatus===toStatus 直接放行（903-915），所以对已 claimed 的任务再次 claim 也会成功并覆盖 lease_owner。startTask/heartbeatTask/markSucceeded 三处确有 `task.lease_owner && workerId && task.lease_owner !== workerId` 抛错校验。claimNextTask（1461-1486）的 queued/retry_wait 过滤与 claim 在同一次 _locked 临界区内故免疫。`_withStoreLock`（802-832）第 810-812 行在锁内强制 loaded=false; _ensureLoaded() 重读磁盘。文件头（:62-66）自陈 TUI 与 Web 后端是两个进程共享 large_task_runtime.json。
- **触发条件**：TUI 与 Web 后端是两个进程共享 large_task_runtime.json；两个进程的 runTask 都读到 status='queued' 后各自 claimTask（`largeTaskOrchestrator.runTask:100-118`）。
- **复现步骤**：单进程两 store 实例（同一文件=两进程）模拟 runTask:100-118：A.claimTask => OK（lease_owner:worker-A）；B.claimTask => OK（lease_owner:worker-B，磁盘被覆盖）；随后 A.startTask => THREW `Task claimed by another worker: worker-B`。真实两个子进程 + barrier 同步、逐字复刻 largeTaskOrchestrator.js:100-118，8 轮中 6 轮两个进程都拿到 claimed。B.claimTask on running task => THREW Invalid task transition；on succeeded => THREW Terminal task is immutable。两个子进程同步调 claimNextTask：0/6 双认领。
- **实际影响**：同一任务的 lease_owner 被后到者覆盖，前一个 worker 的 runTask 以硬错误失败、其后续 heartbeat/markSucceeded 抛 lease owner mismatch。**订正**：原 finding 称「同一 taskId 被双跑/副作用执行两次」未被证据支持——orchestrator 级三种交错下 handlerRuns 均为 1，败者要么 startTask 抛错要么返回 already_running。
- **根本原因**：claimTask 缺少「仅 queued/retry_wait 可认领 + 租约未被他人生效持有」的前置条件；锁内读到的状态来自刚重载的磁盘副本，所在同一临界区内加守卫谓词即足够（不需要真正的 CAS）；漏洞专指 runTask 的 getTask→claimTask 跨两个临界区这一段。
- **修复建议**：claimTask 内显式守卫：`if (task.status !== 'queued' && task.status !== 'retry_wait') return null;`，并在 retry_wait 分支之外拒绝 `task.lease_owner && task.lease_owner !== workerId && lease 未过期`；把该判定落在同一次 _withStoreLock 内（已是）。
- **建议测试**：跨进程测试：两个进程对同一 queued 任务同时 claimTask，断言只有一个返回非 null；对已 running 且租约有效的任务 claimTask，断言返回 null。
- **是否已确认**：已确认（读码 + 5 组只读探针实测）。

#### DB-04 ｜ 跨进程存储锁用 Atomics.wait 同步自旋等待，并发变更会冻结整个事件循环最长 30s 并退化为无锁写入
- **风险等级**：P2
- **涉及模块**：大任务运行时存储 / 并发写（tasks/largeTaskRuntimeStore.js）
- **涉及文件**：`runtime/node/backend/src/tasks/largeTaskRuntimeStore.js:735`
- **具体代码位置**：_acquireStoreLock（735-780）、_withStoreLock（802-832）、_sleepSync（437-447）
- **问题描述**：_acquireStoreLock 用 `while(true){ fs.mkdirSync(lockDir) ... _sleepSync(5) }` 轮询等待，_sleepSync 走 Atomics.wait（阻塞当前线程）或忙等；_withStoreLock 对返回 promise 的异步变更会一直持有锁直到 promise settle（819-828），而同进程第二个调用者因 storeLockActive 已为 true 会走 `return fn()`（重入），但**不同 store 实例**的并发调用会进入 _acquireStoreLock 自旋。STALE_LOCK_MS=5000（737）、MAX_WAIT_MS=30000（738），超时后 console.warn「获取写锁超时…降级为无锁写入」并 return null（771-776）。全文件唯一 async 的 _locked 方法就是 executeIdempotentSideEffect（1858，1936 `await executor()`，2574 注册）。
- **触发条件**：同进程一个实例持锁跑长异步执行器（executeIdempotentSideEffect），另一入口用同 storePath 的新实例触发 _locked 方法（Web 后端 singleton 持锁的同时，`routes/largeTasks.js:813` cancel 路由 → `taskControlService.js:71-79` → `backgroundTaskLauncher.js:141 store.cancelTask`，该 store 来自 `_freshStore()`）。
- **复现步骤**：只读探针（%TEMP% 沙箱 storePath）：A 实例持锁 await 3s 执行器期间，(a) 同实例第二个调用 6ms 返回（走 804 行重入）；(b) 同进程另一个实例（同 storePath）的同步 _locked 调用（createTask）占用 5061ms 才返回，期间 25ms 定时器连续 5082ms 一次都没跳（事件循环被 Atomics.wait 完全占住），A 的 3s 执行器被拖到 5156ms 才 resolve。
- **实际影响**：进程内所有请求/心跳/流式输出冻结约 5 秒（多用户场景即全服务停顿）；锁目录 mtime 在持锁期间不刷新，第二个实例的陈旧检查（757-766）会在约 5s 抢占锁——实测 5061ms 即返回、stdout 无任何「获取写锁超时」警告，终点是抢占+跨实例抢锁（A 的 finally 在 824-827 rmSync 掉 B 刚建的同一路径锁目录），不是 30s 无锁降级丢更新。**订正**：finding 的量化口径（30s、无锁降级）与触发路径（同实例 HTTP 请求自旋）与证据矛盾，按实测为「约 5s 冻结 + 5s 陈旧抢占」，spin 只发生在不同 store 实例（或跨进程）之间。
- **根本原因**：锁等待是同步阻塞式（Atomics.wait）而非异步让出；持锁跨 await 时没有把「同进程其他变更」排队或让出事件循环。
- **修复建议**：把锁等待改成异步（setImmediate/setTimeout 让出事件循环后再探测），或对同进程并发变更做进程内串行队列（Promise chain）后再去竞争文件锁；保留 5s 陈旧抢占与 30s 安全阀语义不变。
- **建议测试**：用例：mock 一个 3s 的异步执行器占锁，同期调用第二个 _locked 方法，断言事件循环在等待期间仍能响应 setTimeout（无 30s 阻塞），且两次变更都落在最终落盘状态里。
- **是否已确认**：已确认（读码 + 只读探针实测）。

#### DB-05 ｜ 主库（Sequelize）全层零事务边界：多步写入无原子性
- **风险等级**：P2
- **涉及模块**：数据访问层 / 事务边界（backend + ai-backend + shared）
- **涉及文件**：`runtime/node/backend/src/services/conversationStore.js:321`
- **具体代码位置**：backend/src、ai-backend/src、shared/src 全量扫描；代表点 conversationStore.removeGroup(321-329)/reorder(334-352)、guiEval taskStore.deleteTask(83-93)、accountPool.acquire(1055-1067)
- **问题描述**：对 `runtime/node/backend/src`、`runtime/node/ai-backend/src`、`runtime/substrate/platform/packages/shared/src` 全量扫描（三棵树共 3775 个 .js，排除测试文件）`sequelize.transaction(` 与 `.transaction(async`，命中数为 0。'transaction' 的 69 处非测试命中全部为 selfRepairTransaction（文件快照自修复机制，非数据库）的注释/引用，或 `taskBoard.js:518`、`dbHealthService.js:541`、`sessionGroupService.js:121/305/358/383`、`sessionSearchIndex.js:252/353` 上的 `db.transaction(() => ...)`；这 7 处的 db 均来自 `../config/sqlite-adapter`（node:sqlite/better-sqlite3 驱动），且分别落 taskboard.db 与 sessions.db，不是主 Sequelize 库。所有跨行/跨表一致性都靠「但愿不出错」：删组后清 group_id 是两条独立语句；reorder 是 N 条独立 UPDATE；deleteTask 先 destroy runs 再 destroy task；acquire 先 UPDATE account 再 INSERT lease。
- **触发条件**：任一步骤失败、进程中断，或并发请求交错。
- **复现步骤**：`conversationStore.removeGroup:323 ConversationGroup.destroy` 成功，327 的 `Conversation.update({groupId:null})` 抛错（如 SQLITE_BUSY 超时）→ 组已删除但对话仍带失效 group_id，侧栏出现指向不存在分组的对话。reorder 中断则 sort_order 半新半旧。
- **实际影响**：留下中间态/悬挂引用；SQLite 下每条语句独立提交，没有「要么全做要么全不做」的保证（shared/src/config/database.js:91-98 注释明示 auto 模式默认 SQLite）。
- **根本原因**：代码库在 Sequelize 层从未使用 transaction 原语（SQLite 方言完全支持）。
- **修复建议**：对上述多步写入用 `sequelize.transaction(async (t) => { ... { transaction: t } })` 包起来；至少覆盖 removeGroup、reorder、deleteTask、accountPool 的「置约 + 插租约」、authSession 的刷新轮换。
- **建议测试**：用注入故障的 query spy 让第二步抛错，断言第一步已回滚（组仍在、group_id 未清）。
- **是否已确认**：已确认（三棵树全量扫描 + findstr 定点复核 + 读四个代表点；范围说明：仓内确有事务原语，但在另一驱动与另一库文件上）。

#### DB-06 ｜ 刷新令牌轮换读-改-写无版本守卫且无复用检测，并发刷新致一方被静默登出
- **风险等级**：P2
- **涉及模块**：认证会话 / 多端并发（services/authSessionService.js）
- **涉及文件**：`runtime/node/backend/src/services/authSessionService.js:478`
- **具体代码位置**：refreshSession()（439-511）中的 session.update（478-492）；getOrCreateUserAuthState（197-203）
- **问题描述**：refreshSession 先按 refreshTokenHash findOne 取 session（:446-450），再 `session.update({ refreshTokenHash: 新hash, tokenVersion: 旧值+1, ... })`（:478-492）。UPDATE 没有 `WHERE id=? AND tokenVersion=旧值` 的条件，也没有「旧令牌再次出现即全家撤销」的复用检测。AuthSession 模型主键 id（STRING）、refreshTokenHash 唯一索引、tokenVersion INTEGER 默认 1，**无 Sequelize version 乐观锁字段**（`models/AuthSession.js:8-28,90-96`），故 `session.update()` 实际只会生成 `WHERE id=?` 的盲写。全文无任何「旧 hash 复用检测 / 已用令牌台账 / revokeUserSessions 联动」代码；routes/auth.js:589-605 的 /refresh handler 失败统一映射 401 且无 UserLogService 审计记录。
- **触发条件**：同一刷新令牌被并发使用：双标签页同时刷新、客户端重试、或网络重放。
- **复现步骤**：只读运行时复现（require.cache 注入假 models 后 require 真实 service，AuthSession.findOne 返回行快照、实例 update 盲写覆盖）：两个并发 refreshSession 传入同一 refreshToken → A ok=true token=rt_3749cbcc…、B ok=true token=rt_5d869397…；replay A: refresh_not_found；replay B: ok；persisted tokenVersion=3。即先拿到令牌的一方再次刷新得到 refresh_not_found → 401 → 被静默登出。
- **实际影响**：多端用户被随机登出（且无任何审计线索）；若令牌被截获，重放不会触发任何撤销。
- **根本原因**：令牌轮换是读-改-写而无乐观锁；缺 refresh token 复用检测（OAuth 2.1 要求）。
- **修复建议**：轮换改为条件更新 `AuthSession.update({...}, { where: { id, tokenVersion: 旧值 } })`，changes!=1 时重读重试或按复用处理（撤销该用户全部会话）；检测到已使用过的旧 hash 时走 revokeUserSessions。
- **建议测试**：Promise.all 两个 refreshSession 同令牌，断言仅一个新令牌可再次刷新成功，另一个明确失败并留下审计事件。
- **是否已确认**：已确认（读码 + 内存桩复现交错结果；「UPDATE 无 tokenVersion 条件」这一决定性事实直接从代码读出）。

#### DB-07 ｜ 混合时间基准：ISO 字符串与 SQLite datetime('now') 比较、SQLite 本地格式串被按本地时区解析
- **风险等级**：P2
- **涉及模块**：账号池 / 时间语义一致性（services/accountPool.js）
- **涉及文件**：`runtime/node/backend/src/services/accountPool.js:1009`
- **具体代码位置**：acquire 的冷却判定（1001-1017）与租约查询（989）；lease_until/cooldown_until 写入（1053、1173、1355）；GC 与可选状态过滤（poolScheduler.js:47-57、accountPool.js:396/412）
- **问题描述**：lease_until / cooldown_until 用 `new Date(...).toISOString()` 写入（形如 2026-11-12T09:00:00.000Z），却与 SQLite `datetime('now')`（形如 2026-11-12 09:00:00，UTC）做字符串比较；同时 `new Date(lastPull[0].released_at)`（:1009）把 SQLite 写的 'YYYY-MM-DD HH:MM:SS' 按**本地时区**解析。schema（:155-213）三个时间列均为 TEXT 默认 `datetime('now')`。驱动侧：`shared/src/config/database.js:240-245` dialect 'sqlite' + storage 文件，dbMode 'auto' 默认走 SQLite，未设 timezone。
- **触发条件**：任何非 UTC 时区部署（本机实测 Asia/Shanghai）下的冷却窗口判定与租约过期判定。
- **复现步骤**：node:sqlite 内存库实测：`datetime('now')` 是 UTC；`new Date('2026-11-12 11:22:34')` → 2026-11-12T03:22:34.000Z（drift 8 小时）；`'2026-11-12T09:00:00.000Z' > '2026-11-12 09:00:00'` → true（'T'=84 > ' '=32）。端到端复现脚本（按 schema 建表、用 datetime('now') 写 released_at 后读回，原样代入 1009/1011 两行）：Date.now()-releasedAt = 28,800,272 ms（真实经过≈0ms）→ 冷却闸门判「已过期」。时区矩阵（$env:TZ 后跑同一脚本）：Asia/Shanghai drift -8h → 闸门不拦（冷却被绕过）；UTC drift 0 → 正确拦截；America/New_York drift +5h → elapsed 为负 → 恒抛 Cooldown active（反方向永不过期）；Europe/Berlin drift -1h → 冷却被绕过。
- **实际影响**：冷却窗口形同虚设（或反方向永不过期）；因 'T'>' '，`cooldown_until <= datetime('now')` 对「已过期 2 秒」「已过期 30 分钟」均返回 false（只有跨到次日才 true），`lease_until < datetime('now')` 同理永不命中——cooldown 恢复路径（:440-452）与 lease GC（poolScheduler:47）在当天剩余时间内全部失效；跨机器/跨时区恢复后语义不一致。finding 只把 SQL 侧比较描述为「同秒边界误判」，实测是同一天内恒误判，后果更重。
- **根本原因**：两套时间表示混用：JS 侧 ISO-8601 带 T/Z，SQL 侧 datetime('now') 空格 UTC；读回时又按本地时区解析后者的字符串。
- **修复建议**：统一一种：要么全部用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 与 ISO 字符串比较，要么全部存 Unix 毫秒整数（REAL/INTEGER）在 JS 侧比较；读回 SQLite 时间串时显式按 UTC 解析（替换空格为 'T' 再补 'Z'）。
- **建议测试**：在 TZ=Asia/Shanghai 与 TZ=UTC 下各跑一次：写入 cooldown_until=now+10min，断言 10min 内 acquire 抛 Cooldown active、之后放行（acquire 集成级测试未跑，已用等价 SQLite 层复现证明同一表达式与同一 SQL 的行为）。
- **是否已确认**：已确认（读码 + node:sqlite 端到端与时区矩阵实测）。

#### DB-08 ｜ 会话分组唯一所有者 sessions.db 不入备份，恢复后分组静默丢失（restoreHints 的「可重建」判定对分组表不成立）
- **风险等级**：P2
- **涉及模块**：备份与恢复 / 数据完整性（domain/backup）
- **涉及文件**：`runtime/node/backend/src/services/domain/backup/backup/backupAssetPlan.js:58`
- **具体代码位置**：SQLITE_ASSETS（58-69）、EXCLUDED_FILE_PATTERNS（213-222）、restoreHints（310-328）；写入方 sessionSearchIndex.js:110-142
- **问题描述**：SQLITE_ASSETS 只收录 `khyquant/data/khy-quant.db` 与 `taskboard.db`；EXCLUDED_FILE_PATTERNS 把所有 `*.db/-wal/-shm/-journal` 从逐文件复制中排除（:214-215，reason 'sqlite:hot-copy-only'）。因此 sessions.db 既不热备也不裸拷，完全不在备份集内。文件头（:13-16）给出的理由是「sessions.db 只是会话 JSON 的 FTS5 副本，可由 reindexAll 重建」。但 sessionGroupService（头 4/8 行）明确写着 session_groups/session_group_members 的「唯一所有者是这张表」（该句实际在 `sessionSearchIndex.js:111`），reindexAll（:445-504）只对 sessionPersistence 的会话 JSON 调 indexSession + ftsOptimize，全函数无 session_groups/session_group_members/session_group_meta 任何读写。restoreService.js:458-491 收尾只执行 kind==='discard' 的 hint 并调 reindexAll；恢复是「按 manifest 逐项覆盖写入」，无「删除备份集外文件」步骤，也无任何针对 sessions.db 的告警。
- **触发条件**：执行一次备份→恢复（restoreService.restoreBackup）。
- **复现步骤**：只读校验（opts.homes 注入假家目录，调真实 createBackup/restoreBackup）：`classifyFile('sessions.db', full) = {include:false, reason:'sqlite:hot-copy-only'}`；createBackup ok=true，manifest.entries 仅 `["file:home-project/T1-domains/sessions/sessions/sess-1.json"]`，无任何 sessions.db 条目；manifest.excluded 有 sessions.db 与 .db-wal；restoreBackup（--remap 到全新家目录，模拟换机/数据家丢失）ok=true，restored {sqlite:0,file:1}，warnings 只有 remap、core 级流水、skip-pre-backup 三条——没有任何一条提及 sessions.db；目标家目录最终不存在 sessions.db。
- **实际影响**：用户手动整理的分组结构在恢复后永久丢失，且 manifest 显示「恢复成功」、无任何告警（漏备只在用户发现分组没了那一刻暴露）。
- **根本原因**：资产清单把 sessions.db 整体判为「可由会话 JSON 重建的派生物」，但同一文件里混有不可重建的权威表（分组），判定粒度为文件而非表。旁证：`dataHome.js:50` 把 sessions.db 登记为 'T2-regenerable'。修复可行性佐证：`sqliteHotCopy.js:17-18` 头部记载实测「sessions.db(wal) 36 ms … 副本 integrity_check 全 ok」。
- **修复建议**：把 sessions.db 加入 SQLITE_ASSETS 走 hotCopySqlite（它是 WAL 库，sqliteHotCopy 头部实测支持），或在 restoreHints 中把分组表标为「不可重建、须随库恢复」并相应调整 manifest 校验；无论选哪条，都要让备份集能解释分组数据去向。
- **建议测试**：备份→恢复演练：断言恢复后 listGroups/moveSession 结果与备份前一致（当前会失败）。（未跑：本机 runtime/node/backend/node_modules 仅 58 项、无任何 sqlite 驱动，sessionGroupService._db() 返 null，改以上述 plan 级 createBackup/restoreBackup 实测替代。）
- **是否已确认**：已确认（读码 + 真实 createBackup/restoreBackup 实测）。

#### DB-10 ｜ databaseQuery 工具声明 isConcurrencySafe:true 却能写库，被并行调度后并发写同一 SQLite 文件
- **风险等级**：P2
- **涉及模块**：工具调度 / 并发 Agent（tools/databaseQuery.js、streamingToolExecutor.js）
- **涉及文件**：`runtime/node/backend/src/tools/databaseQuery.js:233`
- **具体代码位置**：defineTool 元数据 isReadOnly:false(232) 与 isConcurrencySafe:true(233)；消费方 streamingToolExecutor.js:103
- **问题描述**：`streamingToolExecutor.addTool:103` 用 `if (this._isConcurrencySafe(call.name) && this._parallelCount < MAX_PARALLEL) _startParallel(...)` 决定并行执行（MAX_PARALLEL=5，15 行）。databaseQuery 声明 isConcurrencySafe:true，但其 execute 支持 `readonly:false`（:313-319）从而执行 INSERT/UPDATE/DDL，且每次调用都 `new Database(file)` 开一条独立连接（_runSqlite :187-220）。`_baseTool.js:131` 的默认值是 false，说明这是显式申报。实测 `reg.get('databaseQuery').isConcurrencySafe({})` 与 `({readonly:false})` 均 true；对照 writeFile(35)/editFile(71)/gitCommit(111)/run_tests(152,159) 均为 false。busy timeout 5s 属实（`shared/src/config/sqliteCompat.js:63`）。
- **触发条件**：同一批工具调用里出现多个 databaseQuery（Agent 并行查库/写库），且至少一个传 readonly:false。
- **复现步骤**：注入点 `toolUseLoopCore.js:2735-2751` 以 `rt.isConcurrencySafe({})` 判定 → databaseQuery 进 _startParallel；isStreamingExecEnabled(537-539) 默认开启；aiRequestParsers.js:360-399 流式期逐个提交调用且允许同名两次不同参数调用。第二条独立并行路径（finding 未列）：`toolExecutionEngine.js:153-176` 以真实 call.params 调用 isConcurrencySafe → true，partitionIntoBatches(196-244) 将相邻安全调用并入同一并行批，默认路径在 toolUseLoopCore.js:7371-7372 使用、8204-8220 经 runWithConcurrency(limit 8) 真并发；其同路径写拆分仅覆盖 WRITE_PATH_TOOLS(71-82 文件写工具)，不含 databaseQuery。
- **实际影响**：并行 Agent 并发写库：锁竞争失败、丢更新；与 writeFile/editFile/gitCommit/runTests 的自相矛盾使该申报失去意义。**订正**：repro 中「两个 SQLite 连接同时写同一文件 → SQLITE_BUSY」在单 Node 进程内不成立——sqliteCompat.js:87-130 的 prepare/run/all 全同步且 _runSqlite 无 await，事件循环下两次写原子串行、各自 autocommit，SQLITE_BUSY 需外部进程持锁；pg/mysql 路径（_runPostgres 50-89）为真异步双连接无共享事务，「后写覆盖先写」在该路径成立。
- **根本原因**：工具能力（可写、独占连接、无事务）与并发安全申报不一致。
- **修复建议**：把 databaseQuery 的 isConcurrencySafe 改为 `(input) => input.readonly !== false`（只读查询才可并行），或直接置 false 让其进串行队列。注意流式调用点传 {} 而非真实 params（2739 行），修 declaration 需同时改调用点。
- **建议测试**：契约测试：registry 中 databaseQuery.isConcurrencySafe({readonly:false}) 必须为 false；并行两个写 query 时第二个被串行化。
- **是否已确认**：已确认（读码 + node 探针实测运行期行为）。

#### DB-09 ｜ gui-eval 路由缺租户隔离（可读他人 run），且 /tasks 在 SQLite 下用 Op.iLike 必 500
- **风险等级**：P2
- **涉及模块**：多用户数据隔离 / 路由层（routes/guiEval.js）
- **涉及文件**：`runtime/node/backend/src/routes/guiEval.js:249`
- **具体代码位置**：GET /runs（249-279）、GET /runs/:id（282-294）、GET /tasks/:id（99-111）、GET /tasks 的 q 过滤（78-81）
- **问题描述**（原文转录，未经本轮证实）：/runs 只在调用方显式传 `?userId=` 时才加 `where.user_id`（265-267），否则列出全部用户的 run；/runs/:id 与 /tasks/:id 直接 findByPk，无归属校验；而 GuiEvalRun 带 user_id 与 payout_amount（taskStore.listRuns:131-133 说明这是每用户资源）。对照同文件 222-239 的创建路径是 `user_id: req.user.id`，即数据确实是租户的。另外 /tasks?q=x 走 80 行 `Op.iLike`，而 SQLite 方言不支持（taskStore.js:38-39 特意做了 iLike/like 分流），默认 DB_MODE=sqlite（shared/config/database.js:258-263）下该请求抛错 500。
- **触发条件**：任一已登录用户请求 GET /api/gui-eval/runs（不带 userId）或 GET /api/gui-eval/runs/<他人 id>。
- **复现步骤**：原文给出的步骤（用户 A 创建 run 后用户 B 请求列表/详情）——**本轮未执行**。
- **实际影响**（原文主张）：跨租户读取评测记录与收益字段（IDOR）；q 搜索在主用数据库上不可用。
- **根本原因**（原文主张）：列表/详情路径没有把 `req.user.id` 作为强制 where 条件；dialects 分流只做在 store 层，路由层又内联了一次 iLike。
- **修复建议**（原文主张）：/runs 默认 `where.user_id = req.user.id`（管理员显式传 userId 时才放宽）；/runs/:id、/tasks/:id 增加归属校验（非本人且非管理员 → 404）；/tasks 的 q 过滤改用具名常量或复用 taskStore 的分流逻辑。
- **建议测试**（原文主张）：两个用户互访：B 列 /runs 只见自己的；B 按 A 的 runId 取详情得 404；/tasks?q=xx 在 sqlite 下返回 200。
- **是否已确认**：**未证实**——复核子代理失败，未验证。本条按原材料转录列出，供后续单独复核；在第七章结论中计入「未证实」口径，不计入已确认。
#### DB-12 ｜ 会话 transcript 整列读-改-写无版本校验，双端同时保存互相覆盖丢消息
- **风险等级**：P3
- **涉及模块**：会话持久化 / 多端一致性（services/conversationStore.js）
- **涉及文件**：`runtime/node/backend/src/services/conversationStore.js:236`
- **具体代码位置**：update()（236-265）
- **问题描述**：update 先 findOne 取整行（:238），再把 body.messages 整数组写回 messages 列（:263 `row.update(patch)`）。messages 是该会话的唯一真源（`shared/src/models/Conversation.js:4-6` 注释与 :54 字段注释声明 single source of truth；模型无 version 列）。路由 handleUpdateAiConversation parseBody 后原样调 conversationStore.update(userId,id,body)，无合并/追加/乐观锁。前端 `useChatConversations.js:96-100` PUT 整个 messages 数组，`AIChat.vue:1334-1347` payload 由本地全量 transcript 映射；AIChat.vue:1319-1323 的 _persistChain 只串行化同一标签页内的持久化，跨标签页/跨端仍各持全量数组并发 PUT。
- **触发条件**：同一会话在两个标签页/端上同时发送消息并各自保存。
- **复现步骤**：端 A 与端 B 都读到 [m1]；A 存 [m1,m2]，B 存 [m1,m3]；后写覆盖先写 → m2 或 m3 之一永久丢失，无冲突提示。
- **实际影响**：聊天记录静默丢失（不可恢复，因为这一列就是真源）。
- **根本原因**：整列覆盖式更新 + 无乐观锁版本列/条件更新（对该文件 Select-String 'version|etag|If-Match|lock|optimistic' 零命中）。
- **修复建议**：加 `version` 列做乐观锁（`WHERE id=? AND version=?`，冲突返回 409 让客户端合并），或改为服务端追加语义（appendMessage 接口只追加不覆盖）。
- **建议测试**：两个并发 update 同会话不同 messages，断言其中一个失败并保留另一方的写入（`tests/conversationStore.test.js` 当前无 version/concurren/409 断言——并发测试尚不存在）。
- **是否已确认**：已确认（读码 + Select-String 零命中核对；未运行测试）。

#### DB-13 ｜ 回放台账防抖刷新用单一全局定时器，多会话交替写入互相重置导致延迟/饿死
- **风险等级**：P3
- **涉及模块**：审计轨迹 / 持久化时效（domain/trajectory/trajectoryReplay/replayLedger.js）
- **涉及文件**：`runtime/node/backend/src/services/domain/trajectory/trajectoryReplay/replayLedger.js:75`
- **具体代码位置**：_scheduleFlush（75-89）与 _enqueueLine（61-73）
- **问题描述**：所有 ledgerPath 共用唯一的 `_flushTimer`（:47）：每入队一行都 `clearTimeout(_flushTimer)` 再按自己的延迟重设（:76-78、:88）。`_pendingLines` 是按 path 分桶的（:45）。默认防抖 150ms（:49-52）。连 32 行触发的 `_scheduleFlush(0)` 快路也覆写同一个全局 timer。除防抖定时器自身外，flush() 在仓内**只有测试调用**（replayLedger.test.js:287），drainSync() 只被 replayBundle.js:101（导出）与 `process.on('exit')` 钩子（:134-141）调用——即没有任何周期性清扫或最长驻留上限，交替写入一旦持续，队列可无限增长。trigger 可达性真实：`services/a2a/executor.js:110` 每个入站 A2A 任务独立 sessionId，`routes/a2a.js:84` 的 POST /message:send 是 async handler，两个任务的 tool loop 可在同一进程内同时在飞。
- **触发条件**：两个及以上会话交替产生工具调用（并行 Agent / 多会话并发；真正在仓内可复现的多 path 并发是 A2A 任务面——AgentTool 子 agent 通常同 path）。
- **复现步骤**：只读实测（真实 replayLedger，KHY_PROJECT_DATA_HOME 指到 mkdtemp 临时根）：两个 sessionId 以 50ms 间隔交替各入队 10 行，pendingCount 单调 1→20 涨了 800ms，`[t+861ms] END of alternation: pendingCount=20` 且两个文件都从未落盘；直到交替停止才 flush。kill 测试：子进程入队 1 行后父进程 30ms 内 SIGKILL → `child exit code=null signal=SIGKILL`、`existsAfterSigkill=false`（exit 钩子未执行；对照延到 200ms 时文件在，但那是防抖自己触发过）。
- **实际影响**：审计台账延迟落盘、内存驻留增长；硬杀进程丢失未刷新的审计行（replayLedger.js:22-24 明示 ledger 全链路 best-effort，故障面是审计证据延迟/丢失，不会挂工具调用）。
- **根本原因**：防抖定时器按全局而非按 path 管理。
- **修复建议**：改为 per-path 定时器（Map<ledgerPath, timer>），或至少让 _scheduleFlush 用最早到期时间而不是被任意一行重置。
- **建议测试**：交替入队两个 path 的各 10 行，断言两个 path 都在各自 150ms 内被 flush（pendingCount 归零）（现有 replayLedger.test.js:278-301 只用单一 path/session，无多 path 交替用例）。
- **是否已确认**：已确认（读全文 389 行 + 两条只读实测）。

#### DB-14 ｜ bootstrap 迁移无跨进程锁且版本文件非原子写，崩溃后可全量重跑/读到半份 JSON
- **风险等级**：P3
- **涉及模块**：迁移与启动（bootstrap/migrations.js）
- **涉及文件**：`runtime/node/backend/src/bootstrap/migrations.js:119`
- **具体代码位置**：_writeVersionFile（119-125）、runMigrations 主循环（150-175）、src/migrations/run.js
- **问题描述**：_writeVersionFile 用 `fs.writeFileSync` 直接覆盖 `~/.khy/bootstrap_version.json`（:121，无 tmp+rename；对照 dataHome.js:314-316 的 _writePointer 就是 tmp+rename）。runMigrations 先跑完所有 pending 才在 :175 统一写回版本文件，中途崩溃则已执行的迁移不落版本。读侧 _readVersionFile（:110-116）的 catch 一律返回 `{version:'0.0.0', migrations:[]}`——版本文件坏→全量重跑。1.0.1 迁移会删 7 天前 cache 文件（:55-79）。无任何跨进程锁（migrations.js 只 require fs/path/./state/../utils/dataHome/../utils/logger；acquireLock/withLock/flock/proper-lockfile/startupLock 在 bootstrap/、bin/khy.js 中零命中——命中的 consolidationLock.js、resourceStore.acquireLock、runtimeProvisioner.acquireLock 都在别的模块）。真正的并发面是多个 CLI 进程（bin/khy.js 有 7 处 require('../src/bootstrap/setup')，full 模式在 2302/2328）+ 独立入口 src/migrations/run.js + updateCoordinator.js:706。
- **触发条件**：两个进程同时启动；或在迁移循环中途进程被杀/断电。
- **复现步骤**：并发双跑（%TEMP% 探针，原地改导出的 MIGRATIONS 数组的 up 做计数）：`child exits: [{"tag":"A","code":0},{"tag":"B","code":0}]`，`migration execution counts across both processes: {"1.0.0":2,"1.0.1":2,"1.1.0":2,"1.2.0":2}`——两个进程都读到 0.0.0、各跑全部 4 个迁移。非原子写 + 并发读（约 3MB payload）：`{"ok":120,"empty":11,"tornPartial":26,"enoent":55}`——212 次读里 26 次读到不完整 JSON、11 次读到 0 字节文件。kill-midwrite 30 次 SIGKILL：`{"trials":30,"truncatedAfterKill":0,"intactAfterKill":30,"missingAfterKill":0}`（诚实记录：崩溃留残卷在本机未重现）。
- **实际影响**：迁移重复执行（幂等设计下多数无害，但 1.0.1 的清理与后续副作用会重复）；版本文件损坏后回退全量重跑。
- **根本原因**：版本状态文件无原子替换、无锁、无「跑一个记一个」。
- **修复建议**：_writeVersionFile 改 tmp+rename 原子写；每个迁移成功后立即落盘版本；用 dataHome 下的一个 lock 目录做跨进程互斥（或至少记录 pid+时间做陈旧抢占）——仓内已有范式可抄（dataHome.js:314-316；consolidationLock.js / resourceStore.acquireLock / runtimeProvisioner.acquireLock）。
- **建议测试**：并发两个 runMigrations，断言每个迁移只执行一次（用计数器 mock）；写文件过程中注入异常，断言版本文件仍是完整 JSON（_writeVersionFile 未导出，以等价探针替代）。
- **是否已确认**：已确认（读全文 189 行 + 三个只读探针）。

#### DB-16 ｜ 工作流 worker 终态写入无状态守卫 + 陈旧判定按 updatedAt，长节点可被双执行；answer 亦为读-改-写
- **风险等级**：P3
- **涉及模块**：跨进程工作流队列（domain/project/workflow）
- **涉及文件**：`runtime/node/backend/src/services/domain/project/workflow/workflowRunWorker.js:296`
- **具体代码位置**：executeRun 终态 update（296-317）、onLog 流式 update（257-261）、recoverStale（109-136）；ai-backend/src/services/workflowRunService.js:116-137
- **问题描述**：claimNext 有 `WHERE id=? AND status='queued'` 的原子认领（:163-166，设计良好），但 executeRun 的成功/失败/暂停终态 `run.update({status:'succeeded',...})` 没有状态条件（:296-304 succeeded、:309-317 failed、:284-291 awaiting_input、:272-279 quantum 重新入队——finding 甚至少说了后两处）；recoverStale 以「updatedAt 超过 STALE_RUN_MS（默认 3min，:39）」判定孤儿并重新入队（:127-130 的 update 有 `where:{id, status:'running'}` 守卫）。onLog（:257-261）是唯一的心跳来源，而 workflowExecutor 的 `onLog(entry)` 只在节点**跑完之后**调用（:767，另 451/578/758 为 end/pause/fail 分支）——prompt 节点的 `await primitives.chat(...)`（:457）、subAgent（:518-526）、toolCall/skill/code/http 执行期间一次 onLog 都不发。WorkflowRun 模型 timestamps:true（:135）但无 version/lease/owner 列。answer（`ai-backend/src/services/workflowRunService.js:116-137`）：:118 findOne → :120 409 检查 → :133-136 `row.update({status:'queued', resumeJson})` 无 where 守卫。
- **触发条件**：某节点执行时间 > 3 分钟且期间无 onLog 更新；或用户在两个标签页同时提交 answer。可达性：recoverStale 只在 start() 调一次（:366），而 worker 有两个启动点且标准拓扑下就是两个进程共用一张表（`server.js:1222-1223` 与 `scripts/ai-manage-daemon.js:1296-1298`；守护进程还会把 server.js 当子进程 spawn）。
- **复现步骤**：只读复现（%TEMP%，从 backend 执行）：`[1] recoverStale re-queued count = 1`（updated_at 4 分钟前的 running 行被改回 queued）；`[1] row status after recoverStale = queued`；`[2] row status after unguarded terminal write = succeeded`（第一次执行的终态照写成功）；`[3] both concurrent answers see status = awaiting_input`，`surviving resumeJson = {"answer":"B"}`（后者静默覆盖前者）。
- **实际影响**：工作流双执行、日志回退；用户答案被覆盖。
- **根本原因**：终态写入缺 `where:{status:'running'}` 守卫；陈旧判定用心跳时间而非「持锁者仍在」的证明。
- **修复建议**：executeRun 的终态 update 统一加 `{ where: { id, status: 'running' } }`，changes!=1 时记录「已被他人接管」并不再写；answer 的 update 加 `where:{ status:'awaiting_input' }`；recoverStale 前先确认本进程没有在跑该 id。**注意**：写在实例 `run.update(v, {where})` 上会被 Sequelize 静默忽略（model.js:2483 save() 用 where = this.where(true)，全程不读 options.where），需改用静态 `WorkflowRun.update(values, { where })` 并检查 changes!=1。
- **建议测试**：模拟 updatedAt 3 分钟前的 running 行且正被另一 worker 持有租约，断言 recoverStale 不动它；并发 answer 同一 run，断言只有一个成功（未跑 jest 方言的 workflowRunWorker.test.js——本环境无 jest）。
- **是否已确认**：已确认（逐行读 + DB 级只读复现）。

#### DB-17 ｜ 恢复前置守卫只查 daemon.pid，其他持连进程（Web server/TUI/桌面端）不在检查范围；热备以可写模式打开源库
- **风险等级**：P3
- **涉及模块**：备份与恢复 / 运行期句柄（domain/backup）
- **涉及文件**：`runtime/node/backend/src/services/domain/backup/backup/restoreService.js:57`
- **具体代码位置**：_daemonAlive（57-70）、precheckRestore 的守护进程 blocker（236-245）；sqliteHotCopy.js:125（new Database(src,{readonly:false})）
- **问题描述**：恢复前的唯一进程守卫是读 `<dataHome>/daemon.pid` 并 `process.kill(pid,0)`（:57-70，catch 一律 alive:false）；precheckRestore（:183-298 全函数）无任何「其他持库进程」探测。restoreSqliteInPlace（`sqliteHotCopy.js:184-214`）copyFileSync 到 `<dst>.restore-tmp-<pid>` 再 renameSync 覆盖主库，随后删 -wal/-shm/-journal。`sqliteHotCopy.js:125 db = new Database(src, { readonly: false })`——源库以可写模式打开。非 daemon 持连进程确实存在：server.js 零处 daemon.pid 引用却经 config/database 打开 khy-quant.db；CLI（`taskBoard.js:122 new Database(_dbPath())`）即持 taskboard.db；sessionSearchIndex 开 sessions.db；桌面端 spawn khy 子进程；TUI 是长跑 REPL。全仓无恢复路径可用的跨进程库锁（findstr LOCK_EX/flock/proper-lockfile 只命中 tools/_fileLock.js）。dbHealthService.js:80-83 注释自陈「sibling khy processes … Only ever touches the daemon recorded in our own pid file」。
- **触发条件**：在只跑了 Web server（未走 daemon）或开着 TUI/桌面端的机器上执行 khy 恢复。
- **复现步骤**：只读实验 A（仓内适配器，node:sqlite）：以 `{readonly:true}` 打开源库执行 `VACUUM INTO` → `READONLY VACUUM INTO: OK, bytes=8192`（证实 fix 可行）。实验 B：子进程持 node:sqlite 读写连接并持续占用，父进程模拟 restoreSqliteInPlace 的 rename → `RENAME_FAILED code=EPERM msg=EPERM: operation not permitted`（Windows 上失败可感知，经 sqliteHotCopy.js:218-220 捕获记入 out.failed）。
- **实际影响**：轻则恢复失败（可感知），重则「看起来恢复成功」但运行中进程的写入静默丢失、状态分裂（类 Unix 分支本机无法实测，为 POSIX rename 语义的常规推论）。
- **根本原因**：守卫覆盖的进程集合 ≠ 实际可能持锁的进程集合；热备路径又以可写模式打开源库（VACUUM INTO 实际只需读）。
- **修复建议**：恢复前增加「目标库是否被其他进程打开」的探测（如尝试以独占方式打开/加咨询锁，或扫描已知入口进程），无法确认时明确要求人工停机；hotCopySqlite 的源库连接改 readonly:true。
- **建议测试**：mock 一个非 daemon 进程持库打开，断言 precheckRestore 产出 blocker（当前必然失败——守卫只认 daemon.pid）；断言 hotCopySqlite 对只读源库同样成功（与实验 A 一致）。该目录下无 restoreService.test.js，守卫本身无测试覆盖。
- **是否已确认**：已确认（读码 + 两个只读实验）。

### 3.6 前端与桌面（FE，12 条）

#### FE-01 ｜ useResponsive 的 .js 覆盖了 .ts：getMobileConfig 为 undefined，K 线渲染路径直接抛 TypeError
- **风险等级**：P1
- **涉及模块**：delivery/channel/khyquant/frontend（Vue 3 量化前端）
- **涉及文件**：`delivery/channel/khyquant/frontend/src/composables/useResponsive.js:11`
- **具体代码位置**：composables/useResponsive.js 与 useResponsive.ts 同名双文件；消费方 SimpleTradingInterface.js:297/299/2116、Profile.vue:490/494/414
- **问题描述**：同一目录下存在两份 useResponsive：useResponsive.js（30 行，断点 768，只返回 { isMobile, isDesktop, windowWidth }）与 useResponsive.ts（161 行，断点 mobile=1024/tablet=1280，返回 9 个字段含 getMobileConfig/isPortrait/isLandscape/viewportMode）。`vite.config.js:72-76` 与 `vitest.config.js:28-32` 都只设了 resolve.alias、没有 resolve.extensions，因此 Vite 默认扩展名优先级（`.mjs → .js → .mts → .ts → …`，`node_modules/vite/dist/node/constants.js:24-32`）让 `@/composables/useResponsive` 解析到 .js。`SimpleTradingInterface.js:297 const { isMobile, getMobileConfig } = useResponsive()` 拿到 undefined，第 299 行 `const mobileConfig = computed(() => getMobileConfig())` 在 computed 首次求值时抛 TypeError（getMobileConfig is not a function），而它被第 2116 行 `const maxCount = mobileConfig.value.maxKlineCount` 在 K 线渲染路径上消费（位于 loadChartData（:1796 起）内、fetch 的 try/catch（:1950-2066）之外，故 TypeError 不被该 try 吞）。Profile.vue:490/494 同样只拿到 { isMobile, isDesktop, windowWidth }，isTablet/isPortrait 为 undefined，第 414 行 `:fullscreen="isMobile && isPortrait"` 恒为 false。同一阴影还波及 useTouchGestures（.js 版只读 onSwipe* 与 threshold，SimpleTradingInterface.js:305-317 传的 enablePinchZoom/enablePan/enableLongPress/minZoomLevel/maxZoomLevel 被静默丢弃）与 utils/mobileChartConfig、utils/performanceOptimizer（全 src 扫描同名 .js/.ts 影子对恰好 4 对）。
- **触发条件**：进入 /trading 路由加载任一股票（Trading.vue:830 动态 import SimpleTradingInterface.vue → SimpleTradingInterface.js），或打开 Profile 页。
- **复现步骤**：真实 Vite 解析探针（用项目自带 vite.config.js，middlewareMode）：'@/composables/useResponsive' → useResponsive.js；useTouchGestures → .js；@/utils/mobileChartConfig → .js；@/utils/performanceOptimizer → .js。构建产物旁证：dist/assets/useResponsive-N3Epez5s.js 全文即 .js 版，且 dist/assets/SimpleTradingInterface-BhcaXBHP.js 头部 import 该分块。测试侧：`vitest run src/__tests__/mobileChartConfig.test.js src/__tests__/performanceOptimizer.test.js` → 2 files / 12 tests 全过，而 mobileChartConfig.test.js:15 显式 import '../utils/mobileChartConfig.ts'，测的是不会被打包的 .ts。
- **实际影响**：K 线图表渲染路径抛 TypeError，股票详情/交易页图表不渲染（或被 try/catch 吞成静默无图）；Profile 页编辑器在全屏/竖屏判断上永远走不到预期分支；移动端手势（双指缩放/拖动/长按）整套失效；而测试锁死的是永远不会进入产物的死文件。附加实证：performanceOptimizer 的 .js/.ts 连签名都不同（.js throttleData(fn,delay) 是函数节流；.ts throttleData(data,maxCount) 是数据截断），而 SimpleTradingInterface.js:2118 以数据截断语义调用，移动端路径会再错一层；package.json build 仅为 'vite build'（无 vue-tsc），没有类型门能提前发现。
- **根本原因**：同一模块名存在 .js 与 .ts 两份实现且导出形状不同，构建侧没有 resolve.extensions 约束，测试又绕过解析显式指向 .ts，导致「测试锁死代码、产线跑另一份」而无人发现。
- **修复建议**：只保留一份实现：把 .ts 版设为唯一真源并删除 .js（或反之），所有 import 用不带扩展名的同一标识符；若必须共存，在 vite.config.js / vitest.config.js 的 resolve.extensions 里显式固定顺序，并让测试改回不带扩展名的 import，使测试与产线解析同一文件。
- **建议测试**：加一条契约测试：在真实 vite/vitest 解析下 import '@/composables/useResponsive'，断言返回值含 getMobileConfig/isTablet/isPortrait/viewportMode；再加一条渲染测试挂载 SimpleTradingInterface 并触发 K 线数据加载，断言不抛且 mobileConfig.value.maxKlineCount 为数字。
- **是否已确认**：已确认（Vite 真实解析探针 + 默认扩展名顺序 + dist 产物旁证 + vitest 12 tests）。

#### FE-02 ｜ 自选股/股票/指数/ETF/可转债行情价格由 Math.random() 生成，却标成 dataSource:'Database' 并渲染成绿色标签
- **风险等级**：P2
- **涉及模块**：delivery/channel/khyquant/frontend（Vue 3 量化前端）
- **涉及文件**：`delivery/channel/khyquant/frontend/src/composables/useDashboardQuotes.js:231`
- **具体代码位置**：loadDataWithFallback / loadIndexList / loadStockList / loadETFList / loadBondList；Dashboard.vue:370-385 渲染来源标签
- **问题描述**：loadDataWithFallback（useDashboardQuotes.js:215-274）从 `/instruments` 只取到 symbol/name（无价格，`models/Instrument.js:9-72` 字段确认无价格字段），随后 :231-251 的 map 内 `basePrice=Math.random()*150+80`、`changePercent=(Math.random()-0.5)*6`，price/open/high/low/volume/change/changePercent 全部 Math.random() 生成，:249 `dataSource:'Database'`。loadIndexList:308-331、loadStockList:396-416、loadETFList:463-508、loadBondList:522-568 是同一套写法的四份复制。getDataSourceType（:1002-1012）对含 'database' 的字符串返回 'success'（Element Plus el-tag type=success 为绿色）。对照同一文件里 loadMarketQuotes:118 与 loadFavoriteQuotesData:801-830 是走 `/comprehensive-data/kline` 取真实收盘价的，且取不到时诚实地标 '增强模拟数据'（:866）走 warning 色，:894-895 的统计把 'Database' 计入「真实数据」、只把 '增强模拟数据'/'模拟数据'/'Mock' 计入 mock——伪造数据被当作真实。
- **触发条件**：打开 Dashboard 页并切换到「股票 / 指数 / ETF / 可转债」任一分类（switchCategory :636-649）。
- **复现步骤**：读 useDashboardQuotes.js:228-258（DB 分支：response.data.data.instruments.map 内 Math.random() 造价 + dataSource:'Database'）；读 Dashboard.vue:370-385 与 useDashboardQuotes.js:1002-1012（'database' → 'success' 绿标）；后端确认 /instruments 无价格（models/Instrument.js:9-72、instrumentService.js:227-239、instrumentController.js:34-38）。
- **实际影响**：交易终端把随机数当行情展示并标注来源为数据库：用户据以下单/判断会直接亏损；绿标进一步消除了「这是模拟数据」的最后线索。属 UI 展示与后端真实状态不一致的最严重形态。**订正**：finding 称「用户看到 Database 绿标」在现行 UI 上不严格成立——Dashboard.vue:370-377 实为分类计数标签（硬编码 type="success"，与 dataSource 无关），来源标签在 :378-385 绑定的是 marketQuotes[0].dataSource（来自真实 kline 路径），伪造的 'Database' 标携带在 stockList/indexList/etfList/bondList 行数据里、当前 Dashboard 行内并未渲染 dataSource；但 getDataSourceType 的映射机制与统计口径确实存在且把伪造数据当真实。finding 标题把「自选股」列入受影响面也略宽（自选股走真实 kline）。
- **根本原因**：「列表有名字、没有价格」的空档用前端随机数填，且填的时候沿用了成功路径的 dataSource 字面量，没有把「价格是造的」这个事实带进 UI。
- **修复建议**：DB 分支要么改为真实取价（复用已有的 /comprehensive-data/kline 或行情端点按 symbol 批量取），要么把该分支的 dataSource 改成与 '增强模拟数据' 同级的诚实值（如 '模拟价格'）让 getDataSourceType 落到 warning；至少在价格字段旁标注「价格未接真实行情」。
- **建议测试**：契约测试：mock /instruments 返回 3 条无价格记录，断言 stockList 每条的 dataSource 不是 'Database'（或价格字段为 null 且 UI 渲染「暂无行情」）；再断言 getDataSourceType('模拟价格') === 'warning'。
- **是否已确认**：已确认（读码 + 后端模型字段核对；未启动前端或后端服务做运行期验证）。

#### FE-03 ｜ useConfigSync 的 SSE 实时通道取错 token key 又用 query 传参，永远 401；断线后被主动关闭且再也不重连
- **风险等级**：P2
- **涉及模块**：delivery/web/ai-frontend（Vue 3 Web 前端）
- **涉及文件**：`delivery/web/ai-frontend/src/composables/useConfigSync.js:218`
- **具体代码位置**：_startSSE / _closeSSE / onUnmounted
- **问题描述**：_startSSE（useConfigSync.js:215-244）第 218 行 `const token = localStorage.getItem('khy_token') || ''`，而本前端的 token 存储键是 'token'（`utils/safeStorage.js:40 TOKEN_KEY = 'token'`，`stores/user.js:17 localStorage.getItem(TOKEN_KEY)`），所以取到的恒为 null。第 219-221 行把它拼成 `/api/config-sync/stream?token=`（空值）。EventSource 无法设自定义 header，而后端 `routes/configSync.js:26 router.use(authMiddleware)`、:155-159 的 /stream 要求 `req.user?.id`，这个字段只可能来自 Authorization: Bearer 或 X-API-Key（`middleware/auth.js:129-131` 的 extractBearerToken 只读 req.headers.authorization；第 236 行读 x-api-key），没有任何 query.token 通路 → 首次连接即 401。第 237-240 行 onerror 里 `_closeSSE()` 把 EventSource 彻底关掉且没有任何重排，注释写的「下次 getAll 时会重连」不成立（getAll 只发一次 HTTP 拉取，不碰 SSE；_init 被 :44 `if (state.initialized) return` 守住，二次挂载也救不回来）。第 48-50 行 onUnmounted 又对模块级共享流（:33）调 _closeSSE：任何一个用过 useConfigSync 的组件卸载，实时通道对全应用死亡。同功能的 CLI 端 `cli/configSyncClient.js:165-176` 是用 fetch + Authorization: Bearer 正确实现的，可作对照。
- **触发条件**：任何调用 useConfigSync() 的页面挂载后（onMounted → _init → _startSSE）。
- **复现步骤**：读 :218-221（读 'khy_token' + ?token= 传参）与 safeStorage.js:40（TOKEN_KEY='token'）；读 routes/configSync.js:155-159（要 req.user?.id）与 middleware/auth.js:129-131（只认 Authorization 头）；读 :237-240（onerror 后不再重连）。git grep 'khy_token' → 代码里唯一命中就是 :218（该键从未被写入）；query 传令牌通路全仓零命中；cookie 鉴权不存在。
- **实际影响**：「四端配置实时同步」的 Web 端实时车道从上线起就是死的：别的端改配置，本端永远收不到 config_change，只能等下次全量 getAll；网络抖一次后连全量拉取都不再触发。UI 上没有任何地方告诉用户实时同步已断开。**订正**：git grep 显示目前没有任何生产组件 import useConfigSync（只有它自己和 useConfigSync.test.js），属潜伏缺陷而非当前用户可见故障，实际严重度低于表述。
- **根本原因**：SSE 的鉴权方式选错（query 传 token + 读错存储键），叠加「出错即永久关闭、无重连预算」的恢复策略，使一次失败变成终态。
- **修复建议**：token 改从 TOKEN_KEY（'token'）读；EventSource 不支持 header，要么改用 fetch + ReadableStream 手工解析并带 Authorization 头（前端真正范式在 useWxBinding.js:231 与 useWorkflow.js:174；useAIMonitor.js:50 自己也还是裸 EventSource 但它有指数退避重连 :71-88 含 MAX 次后终态），要么让后端 /stream 显式支持带过期时间的 query token 并登记为白名单端点；onerror 改为指数退避重连（带上限与终态标记），并把 onUnmounted 的关闭改成引用计数/只在应用级卸载时关。
- **建议测试**：单测：mock localStorage 只写 TOKEN_KEY，调用 _startSSE，断言请求 URL 携带该 token（或走 fetch 路径时带 Authorization 头）；再断言 onerror 后 N 秒内出现第二次连接尝试，且 MAX 次后进入可手动重试的终态而非静默死亡（未跑——本机 node_modules/vitest 不存在，该套测试跑不起来）。
- **是否已确认**：已确认（读码 + git grep 五组；仓内设计文档 [DESIGN-ARCH-192]:449 已把这条判成待修）。

#### FE-04 ｜ 点「停止」后 main 丢掉 host 的 ai.result，工具执行卡永远转圈到下一次发送
- **风险等级**：P2
- **涉及模块**：apps/khyos-desktop（Electron 主进程 + React 渲染层）
- **涉及文件**：`apps/khyos-desktop/src/main/index.ts:2136`
- **具体代码位置**：ipcMain.handle('ai:abort') 与 handleHostMessage 的 ai.result 中继
- **问题描述**：ai:abort（main/index.ts:2136-2156）对每个属于本窗口的 pendingAi 条目先 `pendingAi.delete(id)`（:2141），再向 host 发 ai.abort（:2146），最后 `entry.resolve({ ok:false, error:'已停止…' })`（:2151）。之后 host 那一轮的 ai.result 到达时走 main/index.ts:579-607 的中继：:588 `const entry = pendingAi.get(m.id)` 已是 undefined，:591 `const wc = entry?.win` 为 undefined，:592 的 `if (wc && !wc.isDestroyed())` 整段跳过 → 不 send；599-601 的 `entry?.resolve(m)` 是可选链，静默 no-op；随后 return——事件被静默丢弃（连 :632 兜底 console.log 都到不了）。注意同一分支对 ai.chunk / ai.toolCall / ai.toolResult 同样依赖 entry 存在，因此中止后这些事件也全部被丢。host 侧确实会在 abort 之后补发终局 ai.result（host/index.ts:1481-1491 收到 ai.abort 只做 controller.abort；handleAiGenerate 的成功路径 1064-1075 与 catch 路径 1079-1084 各自 send）。
- **触发条件**：流式回复过程中点击 Composer 的「停止」（Composer.tsx:1423-1428 → api.aiAbort）。
- **复现步骤**：读 main/index.ts:2139-2153（delete pendingAi 后 resolve）与 main/index.ts:588-598（entry 为 undefined 时整条事件被丢）；读 App.tsx:643-647（注释 640-642 明写「正常结束 / 用户中断 / 出错都会发 ai.result」）和 toolExecutionSlice.ts:104-111（cancelToolExecution 的唯一入口，全仓递归核实只有 App.tsx:646 一处派发）。
- **实际影响**：用户点了停止，输入框恢复了，但消息下面挂着若干永远转圈的工具卡（甚至包括确实已完成的 Bash/写文件），界面声称的状态与 host 真实执行状态相反；只有再发一句话（Composer.tsx:1082 派发 beginToolTurn，toolExecutionSlice.ts:60-77 把残留 activeIds 标 cancelled 并清空）或切换会话（clearExecutions，App.tsx:266/455）才恢复。
- **根本原因**：中止路径把 pendingAi 条目删掉，使紧随其后的终局事件失去投递目标；渲染层的收敛逻辑挂在一条到不了的事件上。
- **修复建议**：ai:abort 时不要删除 pendingAi（或改为保留 entry 直到 ai.result 到达/短超时后清理），保证 host 的终局事件仍能中继给渲染层；渲染层 onAiResult 已有收敛逻辑，无需改动。若担心重复 settle，可在 entry 上打 aborted 标记，让迟到的 result 只广播不 resolve。
- **建议测试**：主进程单测：注册 ai:abort 前后各发一条 ai.result，断言第二条仍被 send 到窗口 webContents；渲染层测试断言 onAiResult 后 activeIds 清空、卡片状态变 cancelled（未跑——环境不允许起 Electron；仓内无覆盖 ai:abort 的既有测试）。
- **是否已确认**：已确认（逐条读码核对）。

#### FE-05 ｜ 流式期间每个 Redux action 都触发一次全量上下文估算（最多 40 万字符走 IPC + 正则扫描）
- **风险等级**：P2
- **涉及模块**：apps/khyos-desktop（React 渲染层）
- **涉及文件**：`apps/khyos-desktop/src/renderer/components/composer/Composer.tsx:689`
- **具体代码位置**：store.subscribe 订阅 + refreshContextEstimate
- **问题描述**：Composer.tsx:689-694 订阅了整个 Redux store：`return store.subscribe(() => { const { isStreaming } = store.getState().message; if (isStreaming) refreshContextEstimate('', modelId) })`，订阅无任何节流/防抖/in-flight 去重。流式期间 App.tsx:541-562 对每个 chunk dispatch appendMessageContent/appendMessageReasoning，即每次 chunk 都会进入这个回调。refreshContextEstimate（Composer.tsx:659-680）第 668 行把所有消息 content 与当前输入 join 后 `slice(0, 400_000)`，再第 669 行 `api.estimateContextSize(text, currentModel)` → `preload/index.ts:214 ipcRenderer.invoke('context:size', text, model)` → `main/index.ts:1780-1795`（无节流，:1793 `hostProcess.send({ type: 'context.size', id, text, model })` 把整段文本结构化克隆发给 host 子进程）→ `host/index.ts:1805-1822` :1816 `tu.estimateTokens(text)`，而 `tokenUsageService.js:681-687` 的 estimateTokens 对整段文本跑一次全局 CJK 正则。对比同一文件里输入路径的估算是有 300ms 防抖的（Composer.tsx:683-686），唯独流式这条没有。store.ts:10-18 纯 configureStore 无批处理/节流中间件。
- **触发条件**：任何一次 AI 流式回复（长回复/含大代码块时分片更多）。
- **复现步骤**：读 Composer.tsx:689-694（订阅无防抖）与 :659-680（400_000 字符拼接 + IPC）；读 App.tsx:541-562（每 chunk 一次 dispatch）；读 preload/main/host 三段与 tokenUsageService estimateTokens（node -e 按行号过滤输出核实四处命中）。
- **实际影响**：流式期间渲染进程与 host 进程双向背负高频大字符串 IPC 与正则扫描，长回复下表现为掉帧/输入迟滞；host 侧事件循环被挤占还会拖慢工具回调的派发。会话越长、分片越密，代价越高。
- **根本原因**：把「每次 store 变化」当成估算触发信号，且估算本身是全量而非增量，中间没有节流/防抖层。
- **修复建议**：给这条路径加节流（例如 800ms-1s 合并一次，复用已有的 300ms 防抖模式），或改为只在流结束（onAiResult）与输入变化时估算，流式中只按已收到的字符数做本地近似并标注为估算值。
- **建议测试**：测试：挂载 Composer，mock estimateContextSize，连发 50 次 appendMessageContent，断言 IPC 调用次数远小于 50（≤ N/节流窗口），且流结束后至少再调用一次（未跑——需要 Electron 渲染进程 + preload 注入环境，超出只读复核范围）。
- **是否已确认**：已确认（静态读码完整证实触发链；引用行号较 finding 有偏移：Composer.tsx 实际 689-694/659-680/683-686，host/index.ts 实际 1816）。

#### FE-06 ｜ 「电脑端 AI」的「已等 Xs / 上限 Ys」在手机静默时冻结不动
- **风险等级**：P2
- **涉及模块**：apps/khyos-desktop（agentbus 车道 + React 面板）
- **涉及文件**：`apps/khyos-desktop/src/renderer/components/amoon/AgentbusSection.tsx:107`
- **具体代码位置**：ProgressLine + pullResult 的触发条件；hub/round 的事件广播时机
- **问题描述**：ProgressLine（AgentbusSection.tsx:107-117）显示 `已等 {seconds(lane.elapsedMs)} / 上限 {seconds(lane.budgetMs)}`（:111），lane 只由 pullResult()（:184-193）写入。pullResult 的调用点实际 4 处：挂载时（:222）、onAgentbusEvent 回调里（:230）、ask 成功后（:250）、手动刷新按钮（:291-292）——静默等待期无自动刷新。hub 只在阶段/状态跳变时广播（`main/agentbus/index.ts:99-102` broadcast()，调用点只有 :167-170 onPhase hook 与 :201 终态）；`agentbusRound.ts:120-152` 的 awaitTerminal :128 只调一次 onPhase('waiting')，随后 for(;;)（:130）靠 `client.nextEvent(...)`（:134）循环；nextEvent 静默时返回 `{kind:'timeout'}`（agentbusClient.ts:304），该分支不触发任何 hook/broadcast。hub.result() 在无 outcome 时用 `now()-job.startedAt` 现算 elapsedMs（index.ts:112）——即「值永远是新鲜的，但没人来问」。组件内无任何 setInterval / 本地时钟（通读 :171-354）。
- **触发条件**：点「发送」后手机长时间无事件（熄屏、模型慢、网络差）。
- **复现步骤**：读 AgentbusSection.tsx:107-117（用 lane.elapsedMs 渲染）与 :220-234（只在事件时刷新）；读 agentbusRound.ts:120-152（等待循环内不再 onPhase）与 agentbusClient.ts:301-319（静默返回 timeout、无广播）；hub.onEvent 的监听只经 agentbusBridge.ts:85-89 的 fan-out 发 'agentbus:event'（全仓检索 onAgentbusEvent|agentbus:event 只命中这两个文件）。
- **实际影响**：进度读数在用户最需要判断「要不要继续等」的时刻静止，与真实耗时完全脱节；用户既看不出已等多久，也看不出预算是否即将用尽。**订正**：「上限 300s」数字错：默认预算是 420s（agentbusProtocol.ts:99 BUDGET_DEFAULT_MS=420000，min 15s / max 1800s）；「pullResult 的调用点只有两处」不准确（实际 4 处），但静默期依然无自动刷新，实质不变。
- **根本原因**：进度数据的刷新完全绑定在手机的上行事件上，没有桌面侧的本地时钟；把「有事件」误当成「时间在走」。
- **修复建议**：面板侧加一个 1s 本地计时器（isRunning 时启、卸载清），与 lane.elapsedMs 取较大者或直接用 `startedAt + 本地 now` 渲染；也可以在 hub 的等待循环里按 pollIntervalMs 广播一次心跳事件。前者更稳（不依赖手机）。
- **建议测试**：渲染测试：注入一条 state='waiting' 的 lane 后不再发任何事件，推进假定时器 3s，断言「已等 3s」出现；卸载后断言定时器已清理（现有 tests/agentbusPanel.test.cjs:191-194 只由 harness 直接 setResult 断言「已等 12s / 上限 420s」，无注入 waiting 后推进假定时器的用例）。
- **是否已确认**：已确认（逐条核对 finding 引用的行号，全部对得上）。

#### FE-07 ｜ khyquant 前端并存两个行为不同的 axios 单例，外加一处裸 axios；401 处理与响应形状按文件而不同
- **风险等级**：P3
- **涉及模块**：delivery/channel/khyquant/frontend
- **涉及文件**：`delivery/channel/khyquant/frontend/src/api/request.js:1`
- **具体代码位置**：api/request.js 与 utils/request.js 两份实现；useDashboardQuotes.js 的裸 axios
- **问题描述**：api/request.js（119 行）与 utils/request.js（190 行）是两份几乎重复的拦截器实现且都在用：api/request 被 api/admin.js:1、api/largeTasks.js:1、useFuturesTickData.js:2、plugins/pluginManager.js:10、views/admin/Dashboard.vue:2554、views/Announcements.vue:318、views/ForgotPassword.vue:133 引用（另有 api/auth.js|marketData.js|strategy.js|trade.js 以 './request' 导入 api 版）；utils/request 被 views/Trading.vue:842、views/Profile.vue:491、views/ApiKeyManage.vue:249、services/dataSourceService.js:6、components/TradingAgentsBotSimple.vue:928 等引用。**按现码更正**：401 时 utils/request.js:157-159 用 `window.location.href = '/login'`（整页重载），api/request.js:100-102 用 `router.push('/login')`（SPA）——与 finding 原归属相反；两份响应拦截器都 `return response.data`（api :78、utils :124），调用方取数写法差异（useFuturesTickData.js:29 用 res.data.data，Trading.vue:3154 用 response.success）与返回契约一致，不构成形状不同；utils 版另有 300ms 防抖全屏 loading（:41, 61-73）与 silentError（:130-132）。第三处 useDashboardQuotes.js:3 直接 `import axios from 'axios'`，绕过两个单例：无 token 统一注入、无 401 处理、无 baseURL，且第 706/750 行用相对路径 `/api/favorites`、`/api/favorites/batch`，在 Capacitor 原生模式下 getApiBaseUrl() 返回 `${backendUrl}/api`（utils/connectionMode.js:74-80）而这两个调用仍解析到 capacitor://localhost，必然失败（:709-711/:751-753 有手工从 localStorage 取 token 设 Authorization 头，缺的不是 token）。非测试文件直接 import axios 至少 7 处（IntelligentStrategySelector.vue:772、ModernTradingPanel.vue:540、useDashboardLanAccess.js:3、useDashboardQuotes.js:3、marketDataService.js:7、Dashboard.vue:867、Feedback.vue:238），其中 Dashboard.vue:958、Feedback.vue:309、ModernTradingPanel.vue:989/1050、useDashboardLanAccess.js:38 同样用相对 `/api/...`，Capacitor 下的风险面比 finding 写的更大。
- **触发条件**：登录态过期时停在不同页面（走哪份 request 决定用户是否被整页踢回登录页）；或在手机 App 内打开自选股。
- **复现步骤**：读 api/request.js（全文 119 行）、utils/request.js（全文 190 行）、useDashboardQuotes.js（全文 1060 行）、utils/connectionMode.js（全文）；findstr /s 全量核对引用面；git status --porcelain 确认四个被引文件工作树干净；find /c /v 数行数。
- **实际影响**：同一应用里「401 之后发生什么」和「request.get 返回什么」取决于文件，新代码照哪份抄就会继承哪份语义；移动端自选股读写在 Capacitor 下必然失败。属于可预期的正确性陷阱而非当前必现故障，故记 P3。
- **根本原因**：同一个职责有两份实现且各自演化，调用方按就近原则导入，没有单一真源。
- **修复建议**：收敛为一份 request 单例（保留 401 → router.push 的 SPA 语义与 response.data 返回约定，另一份改为 re-export 并逐步迁调用方）；useDashboardQuotes 改导入该单例，把 `/api/favorites` 改成走 getApiBaseUrl() 拼前缀。
- **建议测试**：契约测试：对两个模块各发一次 401 与一次 200，断言落盘行为与返回值形状一致；再加一条 Capacitor 模式下自选股读写 URL 指向 backendUrl 的测试（未实机验证——不得装依赖/访问第三方服务，此为代码级推断）。
- **是否已确认**：已确认（读码 + findstr 引用面；description 的文件归属与行号已按现码更正）。

#### FE-08 ｜ loadBackground 被调用两次，khy:theme-applied 监听器注册两遍，切主题时重复读图
- **风险等级**：P3
- **涉及模块**：apps/khyos-desktop（React 渲染层主题/壁纸）
- **涉及文件**：`apps/khyos-desktop/src/renderer/theme/background.ts:289`
- **具体代码位置**：loadBackground 内的 window.addEventListener('khy:theme-applied')
- **问题描述**：loadBackground 在 renderer/main.tsx:17（模块顶层，import 见 :12，位于 createRoot 之前）和 App.tsx:392（挂载 effect，effect 见 :389-394，其 cleanup 仅 subscribeToTheme()）各被调用一次，而 background.ts:289-291 在函数体内无条件 `window.addEventListener('khy:theme-applied', () => { void applyBackground(lastSettings) })`，没有任何 registered 幂等标记（通读全文件 293 行，模块级可变状态仅 lastSettings :232，无 wired/registered 守卫，全文无 removeEventListener）。派发路径 theme.ts:40-51 applyThemeClass 在主题类真实变化后于 :50 `window.dispatchEvent(new CustomEvent('khy:theme-applied'))`，调用方为 loadTheme（:85-91）与 subscribeToTheme 的 theme:changed IPC 回调（:105-107），设置页切换深浅色必然触发。自定义壁纸时（background.ts:253-269）每次都要走一次 `readImageDataUrl(filePath)`（:259-264）IPC——主进程 main/index.ts:1184-1218 确为 fs.promises.readFile 整读文件（:1217）后 buf.toString('base64') 编码成 data URL 回传（:1218）。
- **触发条件**：在 设置 → 外观 切换深浅色，且桌面背景为「自定义图片」。
- **复现步骤**：读 main.tsx:17 与 App.tsx:392（两处调用 loadBackground）；读 background.ts:274-292（监听器无守卫）；PowerShell Select-String 全仓检索 loadBackground / khy:theme-applied / readImageDataUrl（apps/khyos-desktop/src 下）。
- **实际影响**：切主题时一次多余的大图 IPC 与一次多余的变量写入；功能不坏，但属于可避免的重复劳动，也说明该监听器缺少「只注册一次」的约束（若将来调用点增多会线性放大）。生产构建下监听器恰 2 个；dev 下 StrictMode 双调用挂载 effect 会变 3 个，缺陷只会更重。CSS 变量重复写同值无害，真实代价是一次多余大图 IPC，P3 定级合理。
- **根本原因**：自举函数把「注册全局监听」当作无副作用操作，没有考虑自身会被多处调用。
- **修复建议**：在 background.ts 加一个模块级 wired 标记（或与 useDaemonHealth 的 _stopping 同思路），首次注册后跳过；更稳妥是把壁纸重算收到 theme.ts 的主题订阅里，App 层只调一次。
- **建议测试**：单测：连续调用两次 loadBackground()，触发一次 khy:theme-applied，断言 applyBackground/readImageDataUrl 只被调用一次（khyos-desktop 无任何测试文件，未运行也无法运行）。
- **是否已确认**：已确认（读码 + Select-String 检索）。

#### FE-09 ｜ GoalBanner 的「执行中」只由本地 goal 字符串推导，「取消」不停止任何后端任务
- **风险等级**：P3
- **涉及模块**：apps/khyos-desktop（React 渲染层）
- **涉及文件**：`apps/khyos-desktop/src/renderer/App.tsx:786`
- **具体代码位置**：`<GoalBanner status={goal ? 'running' : 'idle'} onCancel={() => setGoal(undefined)} />`
- **问题描述**：App.tsx:786-790 把 status 写成 `goal ? 'running' : 'idle'`，GoalBanner.tsx:17 对 'running' 渲染标签「执行中」，:26 `if (!goal && !editing) return null`，:64-66 渲染 `· {config.label}`——只要 goal 非空就会显示「执行中」。这个 status 与 message.isStreaming / isAgentWorking / host 在途集合完全无关：goal 只是 App 的局部 state（:166 useState），从不参与发送、也不在任何消息/流式事件里被清空（node 脚本扫 App.tsx 全 885 行，goal|Goal 命中仅 5 处；同一扫描下 isStreaming|isAgentWorking|aiAbort|ai:abort|abort 零命中——App.tsx 只 select 了 message.messages.length :241、message.currentSessionId :242、toolExecution.* :695-696）。同处 onCancel 只做 setGoal(undefined)，不调用任何 aiAbort/host 通道——真正能中止的是 Composer 的「停止」按钮（Composer.tsx:1423-1434 → preload/index.ts:104 aiAbort → main/index.ts:2136-2156）。
- **触发条件**：设定目标后发消息，等回复结束或失败；或点横幅上的「取消」。
- **复现步骤**：读 App.tsx:786-791 与 GoalBanner.tsx:15-22、78-85（取消只调 onCancel）；node 脚本扫描 App.tsx 的 goal 与 abort 相关命中。
- **实际影响**：界面持续声称「执行中」而任务早已结束（状态失真）；点「取消」给用户「已经叫停」的错觉，实际后台仍在跑。**订正**：「反过来 AI 在跑而用户没设 goal 时没有任何运行指示」略过头——应用层在 inFlight 时 Composer 仍有「停止」按钮与 placeholder 变化；「按配额计费」未取到证据，属影响陈述非事实主张。
- **根本原因**：横幅状态是纯本地派生量，没有接入唯一的任务状态真源（messageSlice 的 isStreaming/isAgentWorking 或 backgroundStatus）。
- **修复建议**：status 改为从 messageSlice 派生（isStreaming/isAgentWorking → running，出错 → incomplete）；onCancel 在清本地 goal 的同时，若确实在途则调用与「停止」同一个 aiAbort 通道（并在文案上区分「取消目标显示」与「中止执行」）。
- **建议测试**：渲染测试：设定 goal 且 isStreaming=false 时断言不显示「执行中」；点「取消」时断言调用了 aiAbort（或明确只清本地态且按钮文案不暗示中止）（node 遍历 apps/khyos-desktop 统计 *.test.*/*.spec.* 文件数为 0，无既有测试可跑）。
- **是否已确认**：已确认（读码 + node 扫描）。

#### FE-10 ｜ useDaemonHealth 的「健康检查」定时器实际跑的是 keepalive，/api/daemon/status 从未被调用
- **风险等级**：P3
- **涉及模块**：delivery/web/ai-frontend（Vue 3 Web 前端）
- **涉及文件**：`delivery/web/ai-frontend/src/composables/useDaemonHealth.js:100`
- **具体代码位置**：_startTimers
- **问题描述**：文件头注释（useDaemonHealth.js:11-12）声明「Every HEALTH_CHECK_INTERVAL_MS, GET /api/daemon/status to verify the daemon is still running」，但 _startTimers（:97-101）把两个定时器都指向 _doKeepalive：`_keepaliveTimer = setInterval(_doKeepalive, 30000)`（:99）与 `_healthTimer = setInterval(_doKeepalive, 60000)`（:100）。整个文件里没有对 /api/daemon/status 的请求（:39-57 的 _doKeepalive 只 POST /api/daemon/keepalive；:71 的 ensure 在 _tryRestart 内）。因此「连接状态」实际由一次 keepalive POST 的成败推导，60s 那个定时器只是把同一请求又发了一遍（等效 30s 节拍），并没有独立校验 daemon 是否还在跑。加强证据：`routes/daemon.js:81-92` POST /keepalive 实际调用 `lifecycle.ensureStarted()` 且无论 state 为何都 `res.json({success: ok, ...})` 恒返 HTTP 200；request.js:96-101 的 axios 响应拦截器对 2xx 直接放行、不校验 success——因此前端「由 keepalive 成败推导连接状态」比 finding 说的还弱：200 + state='failed' 也会被当成功。
- **触发条件**：任何挂载 useDaemonHealth 的页面（每 30s/60s 各一次 POST；AIChat.vue:1094 import、:1220 调用）。
- **复现步骤**：读 useDaemonHealth.js:11-12（文档承诺）与 :97-101（实现），全文检索无 '/api/daemon/status'；git grep api/daemon → 全前端 src 内 /api/daemon/status 只出现在 :11 注释；git grep daemon/status 全仓 → 后端 `services/aiManageDaemonLifecycle.js:394` 与 `routes/daemon.js:40 router.get('/status', ...)` 证明端点真实存在，只是前端从不调用；git log 显示该文件仅两笔提交，无「曾有 _doHealthCheck 后被删」的历史。
- **实际影响**：health 探活的实际语义与注释承诺不符：如果 keepalive 端点因别的原因（如路由存在但不校验进程）返回 200，面板会显示「connected」而 daemon 其实已死；同时多出的 60s 定时器是纯重复请求。记 P3 因为当前未证明存在真实的假阳性，但注释与代码已经不一致。
- **根本原因**：健康检查从未实现，用同一个 keepalive 请求顶替，文档留在了设计意图上。
- **修复建议**：_healthTimer 改为 GET /api/daemon/status 并按返回的 state 置位（与 _tryRestart 同一套状态机）；若暂时不接，就把文件头那句承诺改成实况，别让读者以为有独立校验。
- **建议测试**：单测：mock 两个端点，快进 60s，断言 GET /api/daemon/status 被调用且其结果能改变 connectionStatus。
- **是否已确认**：已确认（读全文 134 行 + git grep 四组）。

#### FE-11 ｜ 自选股行情 fetch 传了 axios 专有的 { timeout: 3000 }，超时意图完全失效且无 AbortController
- **风险等级**：P3
- **涉及模块**：delivery/channel/khyquant/frontend
- **涉及文件**：`delivery/channel/khyquant/frontend/src/composables/useDashboardQuotes.js:801`
- **具体代码位置**：loadFavoriteQuotesData 内的 fetch 调用
- **问题描述**：useDashboardQuotes.js:801-804 `const response = await fetch(url, { timeout: 3000 })`。第二个参数是 RequestInit，没有 timeout 字段，浏览器静默忽略；文件里也没有任何 AbortController（对比 khyquant 别处如 utils/networkMonitor.js:71-83 是正确用 AbortController + setTimeout 的）。意图中的 3 秒上限不存在：一个挂死的 kline 请求会一直 pending，:787 `quotesLoading.value = true` → :870 `await Promise.all(promises)` 不收敛 → :900-902 的 `finally { quotesLoading.value = false }` 永不执行，这一轮加载永远不结束；内层 catch 在 :834-836 也不会触发，连 :838 起的模拟数据兜底都不会走，确实卡死在加载态。quotesLoading 被 Dashboard.vue:343（`v-loading`）、447、457、488 消费。该组合式每 30s 由 startAutoRefresh（:968-972）触发 loadMarketQuotes，同类请求会持续堆积（loadMarketQuotes :101-208 对同一 kline 端点 :118 `fetch(url)` 连 init 都没有，:103 置 true、:206 finally 才置 false——挂死请求同样无限堆积，只是函数名与描述略有出入）。
- **触发条件**：后端 /comprehensive-data/kline 无响应（进程卡死、代理挂起）时打开 Dashboard 自选股分类。
- **复现步骤**：读 useDashboardQuotes.js:801-804（fetch + { timeout }）与 :870-873（Promise.all 后置 loading=false，挂死即永不执行）；PowerShell 全量 grep（window.fetch|globalThis.fetch|originalFetch|fetch = function|fetch = async，范围 src 递归）→ 0 命中（无 fetch 补丁会把 timeout 兑现成真超时）；AbortController|abort|timeout 全文扫描：timeout 命中仅 225/302/388（axios 专有配置）与 803。
- **实际影响**：挂死请求导致自选股行情区永久停在加载态，且每 30s 叠加一批新的挂死请求；用户看到的「加载中」与后端真实状态无关。
- **根本原因**：把 axios 的配置项搬到了 fetch 上，而 fetch 需要显式 AbortSignal 才能超时。
- **修复建议**：改用 AbortController + setTimeout(abort, 3000)（与 networkMonitor.js:71-83 同款），并在 finally 里 clearTimeout；或统一改走带 timeout 的 request 单例。
- **建议测试**：测试：mock fetch 返回一个永不 settle 的 promise，推进假定时器 3s，断言请求被 abort 且 quotesLoading 复位为 false（src/__tests__ 下不存在 useDashboardQuotes 的测试文件；未跑 vitest）。
- **是否已确认**：已确认（读码 + PowerShell grep）。

#### FE-12 ｜ TerminalPanel 订阅 pty:data 时不按 id 过滤，多终端并存会串台（当前被单激活标签掩盖）
- **风险等级**：P3
- **涉及模块**：apps/khyos-desktop（Electron 渲染层 + 主进程 PTY）
- **涉及文件**：`apps/khyos-desktop/src/renderer/components/terminal/Terminal.tsx:75`
- **具体代码位置**：api.onPtyData / api.onPtyExit 回调
- **问题描述**：Terminal.tsx:75 `api.onPtyData(({ data }) => { term.write(data) })` 与 :78-81 `api.onPtyExit(({ code }) => …)` 都忽略了 payload 里的 id，而 ptyHost.ts:80 `sender.send('pty:data', { id, data })`、:84 `sender.send('pty:exit', { id, code: exitCode })`，发送目标是创建会话时存入 sessions 的 sender（:73），同一 WebContents 下所有会话共用一条通道；preload/index.ts:253-262 确认 `ipcRenderer.on('pty:data', listener)` 无 id 过滤，渲染层每个订阅者收到全部事件——两个 TerminalPanel 并存即互相串写。当前 SidePane.tsx 只渲染激活标签的 TabBody（:315，定义 :86，由 :173 activeTab 驱动；:313-314 注释明写「非激活标签保持挂载会保住终端会话/表单状态；但当前先只渲染激活标签」），所以最多只有一个 TerminalPanel 挂载，缺陷被掩盖。
- **触发条件**：（潜在）侧栏同时保留两个终端标签；或一个 WebContents 内出现第二个 TerminalPanel。
- **复现步骤**：读 Terminal.tsx:73-82（解构只用 data/code）与 ptyHost.ts:74-85（发送带 id）；读 SidePane.tsx 的单 TabBody 渲染确认当前只有一例。
- **实际影响**：潜在：A 终端的回显写进 B 终端、A 的退出码提示显示在 B 里，用户会把一条 shell 的输出当成另一条的。属当前不可达的隐患，故记 P3。附带瑕疵（不影响缺陷成立）：订阅（:74-82）先于 ptyCreate 完成，naive 的 id 相等过滤会丢首屏字节，与 :73「先订阅再创建」注释冲突。
- **根本原因**：订阅侧没有按会话 id 归属过滤，把「本终端的数据」与「本窗口的数据」当成了同一件事。
- **修复建议**：Terminal.tsx 里保存 ptyIdRef（已存在 :35/:103），onPtyData/onPtyExit 回调内先 `if (payload.id !== ptyIdRef.current) return`；ptyWrite/ptyResize（:106/:112）已经在传 id，无需改主进程。
- **建议测试**：测试：挂载两个 TerminalPanel（或直接测回调），分别投递不同 id 的 pty:data，断言每个 xterm 只收到属于自己的字节（未跑）。
- **是否已确认**：已确认（逐行核对 finding 引用的四处代码）。

### 3.7 依赖与构建（DEP，24 条已确认）

#### DEP-01 ｜ multer 钉在已停维护的 1.4.5-lts 线，三条 High DoS 公告全部命中且 caret 范围够不到修复
- **风险等级**：P2
- **涉及模块**：依赖声明 / runtime/node/backend
- **涉及文件**：`runtime/node/backend/package.json:127`
- **具体代码位置**：dependencies.multer = "^1.4.5-lts.1"；锁定值见 pnpm-lock.yaml:5453 multer@1.4.5-lts.2
- **问题描述**：pnpm-lock.yaml:5453 解析到 multer@1.4.5-lts.2，紧邻 5456 行带 npm 弃置字段 `deprecated: Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x. You should upgrade to the latest 2.x version.`（仓内自带的公告证据）。GitHub Advisory Database 三条 High 公告的受影响区间都覆盖该版本，而修复全部只落在 2.x 线：CVE-2025-7338（GHSA-fjgf-rc76-4x9p，affected ">= 1.4.4-lts.1, < 2.0.2"，patched 2.0.2）、CVE-2025-47944（GHSA-4pg4-qvpc-4q3h，affected ">= 1.4.4-lts.1, < 2.0.0"，patched 2.0.0）、CVE-2025-48997（GHSA-g5hg-p3ph-g8qg，affected ">= 1.4.4-lts.1, < 2.0.1"，patched 2.0.1）。`^1.4.5-lts.1` 的 caret 上界是 <2.0.0，结构上永远取不到 2.x 的修复（semver 实测：2.0.0/2.0.1/2.0.2 satisfies 均 false）。调用点：`src/services/aiManagementServer.js:478` require、:498-503 `multer.diskStorage({destination: os.tmpdir()})` + `limits:{fileSize, files:10}`、:509 `/api/ai/upload` 前置 expressAuth（483-496）；`src/bridge/bridgeServer.js:358,364-365` diskStorage，348-355 为 POST `/api/upload` 且先校验 Bearer JWT。本机 node_modules/multer 实装 1.4.5-lts.2。
- **触发条件**：任意已认证用户向挂载了 multer 的 HTTP 上传接口发送构造的 multipart 请求体。
- **复现步骤**：读 pnpm-lock.yaml:5453/5456 与 importer 段（:336-338）；semver 实测 caret 范围；读两个调用点；node_modules 版本核对。
- **实际影响**：远程可触发的进程级 DoS（未处理异常直接崩进程、被中止上传的文件描述符泄漏、孤儿磁盘写入无界增长）——**按实测收回两点**：两个服务默认都绑回环（`aiManagementServer.js:3569 host:'127.0.0.1'`、`bridgeServer.js:39/464 DEFAULT_BIND_HOST='127.0.0.1'`，可被 BRIDGE_BIND_HOST 改成 LAN），且 `daemonEntry.js:312-316` 装了 uncaughtException 处理器不 crash、`limits` 给每请求封了顶。准确说是「本机任意已认证客户端/同机进程可触发，配了 BRIDGE_BIND_HOST 才是远程」，严重度更接近本机/已认证的资源耗尽。
- **根本原因**：把依赖钉在已停止发布补丁的 1.4.5-lts 维护线上，且 caret 范围的上界挡住 2.x 修复；升级被当成 breaking change 一直没做。
- **修复建议**：升到 multer 2.x（>=2.0.2），并回归 aiManagementServer 与 bridgeServer 两个调用点的 storage/limits 配置（2.x 在 diskStorage 与 limits 上 API 兼容）。
- **建议测试**：补一条对 /api/ai/upload 的畸形 multipart 回归用例（异常字段名 / 中止的 upload / 超限 files 数），断言进程不退出、fd 数与临时目录字节数有界（未跑）。
- **是否已确认**：已确认（仓内证据：声明/锁定/弃置字段/semver/调用点/实装版本；三条公告的 GHSA ID 与区间取自题目材料，本环境禁网未能独立复核）。

#### DEP-02 ｜ js-yaml 3.15.1 命中 CVE-2026-84375（High，CVSS 7.5，merge key CPU 耗尽）
- **风险等级**：P2
- **涉及模块**：依赖声明 / runtime/node/backend
- **涉及文件**：`runtime/node/backend/package.json:122`
- **具体代码位置**：dependencies["js-yaml"] = "^3.15.1"；锁定值见 pnpm-lock.yaml:5039 与 :13068 js-yaml@3.15.1
- **问题描述**：GHSA-2883-xcg3-v3hh / CVE-2026-84375，标题 "js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources"，High，CVSS 3.1 7.5（AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H）。Affected versions：">= 4.0.0, < 4.3.2" 与 ">= 3.0.0, < 3.15.2"；Patched versions：4.3.2 / 3.15.2。锁定的 3.15.1 落在 3.x 受影响区间内。修复 3.15.2 在 `^3.15.1` 范围内，一次改版本号即可拿到。使用点：`src/services/domain/agents/agentAssets/adapters/deepseekHarness.js:38` require、:92 `yaml.safeLoad(text,{schema:_DSH_SCHEMA,json:true})`（读 .dsh harness 的 cordis*.yml）与 `src/services/domain/network/externalApps/cozeAdapter.js:29` require、:72 `yaml.load(S.readIfExists(...))`（读 COZE_HOME 下 model_template_*.yaml）——两处输入确为第三方配置文件。backend 范围外 `runtime/node/ai-backend/src/services/pluginImportService.js:24` 还有第三处（finding「共 2 处」是 backend 口径，属低估不影响结论）。
- **触发条件**：代码路径解析攻击者可控的 YAML 且文档含空 merge 源（`<<: []` 一类）。
- **复现步骤**：读 pnpm-lock.yaml:5039-5041 与 :13068-13071；importers 段（runtime/node/backend 起于 :262）得 specifier ^3.15.1 / version 3.15.1；node_modules/js-yaml/package.json version 3.15.1；findstr /s 定位三个 require 点。
- **实际影响**：单次解析可把 CPU 打满，事件循环冻结即等于整机 CLI/服务不可用；两个使用点都在外部适配器边界，输入来自第三方 harness/coze 配置（属本地第三方配置而非网络输入，与所引 CVSS 的 AV:N 是措辞上的宽松，不构成矛盾）。
- **根本原因**：依赖版本停留在公告发布前的最后一个 3.x 补丁；没有机制在公告发布后提示 bump。
- **修复建议**：把 js-yaml 提到 3.15.2（或统一到 4.3.2，视两处调用点是否需要 load/dump 的 4.x 行为）。
- **建议测试**：给两个适配器各加一条空 merge 源 YAML 的解析时限断言（解析应在毫秒级返回）（未跑）。
- **是否已确认**：已确认（仓内可查部分全部证实；公告元数据取自题目材料，本环境禁网未能独立核验）。

#### DEP-03 ｜ axios 1.19.0 同时命中两个 High 公告：原型污染 gadget 劫持请求 socket + data: URL ReDoS 冻结事件循环
- **风险等级**：P1
- **涉及模块**：依赖声明 / runtime/node/backend + delivery/web/ai-frontend
- **涉及文件**：`runtime/node/backend/package.json:107`
- **具体代码位置**：backend dependencies.axios = "^1.19.0"（锁定 axios@1.19.0）；delivery/web/ai-frontend/package.json:29 声明 "^1.6.5"，同一锁文件也解析到 1.19.0
- **问题描述**：CVE-2026-101905（GHSA-m8m8-qj5v-23w3，High，CVSS 7.6）：Node HTTP adapter 的原型污染 gadget 允许经继承的 createConnection 劫持请求 socket；Affected ">= 1.15.2, < 1.20.0"，Patched 1.20.0。CVE-2026-101903（GHSA-c29m-xwm3-cm6r，High）：fromDataURI 的 data: URL 解析器 ReDoS 冻结 Node 事件循环；Affected ">= 1.16.1, < 1.20.0"，Patched 1.20.0。两处 manifest 都锁定在 1.19.0（pnpm-lock.yaml:276-278 与 :169-171 importer、:2977/:10378 包条目；根 package-lock.json:9632-9636；本机 node_modules/axios 1.19.0），均落在受影响区间；修复 1.20.0 在两个 caret 范围内。漏洞代码面在 1.19.0 源码里确实在：`lib/helpers/fromDataURI.js:9 DATA_URL_PATTERN`（嵌套量词 ((?:;[^,;=]+=[^,;]+)*)）由 `lib/adapters/http.js:692 fromDataURI(own('url'), ...)` 调用；:1051 `req = transport.request(options, ...)`，transport 在 953-967 可选原生 http/https，1032 行走 follow-redirects（重定向 Location 在攻击面内）；全包 grep createConnection 只有 vendored agent-base 的 delete opts.createConnection，axios 自己从不设 own createConnection——同文件 1045-1048 只对姊妹 gadget insecureHTTPParser 做了 own 值兜底，反证这条代码路径上原型污染类问题是活的。
- **触发条件**：后端经 axios 向外部服务发请求时，响应体/重定向 Location 来自远端；前端同样经 axios 消费后端。
- **复现步骤**：读两份 manifest 与两份锁文件对应行 + node_modules 实装；读 axios 1.19.0 源码两个 gadget 点。
- **实际影响**：出站请求可被指向攻击者控制的 socket——意味着 API key、请求体与响应内容可被中间人读写；恶意响应可让进程事件循环冻结。axios 在后端确实做出站 HTTP 客户端（`src/adapters/im/feishuAdapter.js:318/601/622/658`、`src/services/multiFreeService.js:472-543`，并被网关 apiAdapter/relayApiAdapter 消费；前端 `api/request.js:1` import axios）——**订正**：「所有 AI 供应商调用的统一出口/全部网关通道」是夸大：OpenAI/Anthropic 等适配器并不都走 axios，不影响版本命中这一核心。
- **根本原因**：依赖追到 1.19.0 就停更，而 1.20.0 的修复在 caret 内却没人拉；没有任何门禁在公告发布后推动 bump。
- **修复建议**：backend 与 ai-frontend 的 axios 一并升到 >=1.20.0。
- **建议测试**：加一条网关适配器层用例：mock 一个返回携带污染原型字段的响应，断言 axios 不用继承的 createConnection；再加一条 data: URL 解析的时限断言（未跑）。
- **是否已确认**：已确认（仓内可判定部分全部逐条证实；两条公告本身的存在性/区间/Patched 取自题目材料，禁网未能独立复核）。

#### DEP-04 ｜ undici 7.29.0 命中 TLS 证书校验绕过（CVE-2026-109383，High）
- **风险等级**：P1
- **涉及模块**：依赖声明 / runtime/node/backend
- **涉及文件**：`runtime/node/backend/package.json:139`
- **具体代码位置**：dependencies.undici = "^7.19.0"；锁定 undici@7.29.0
- **问题描述**：GHSA-2m5v-pch6-74hx / CVE-2026-109383，High，标题 "undici vulnerable to TLS certificate validation bypass via dropped tls options in Agent"；Affected ">= 4.0.0, < 6.29.1"、">= 7.0.0, < 7.30.1"、">= 8.0.0, < 8.12.2"；Patched 6.29.1 / 7.30.1 / 8.12.2。同批还有 GHSA-xjj6-f33q-929c / CVE-2026-109869（High，content-encodings 过多时未处理错误致 DoS），Affected ">= 7.18.0, < 7.30.1"。锁定的 7.29.0 同时落在两个受影响区间；修复 7.30.1 在 `^7.19.0` 范围内（semver 实测 7.30.1 satisfies ^7.19.0: true）。pnpm-lock.yaml:262 importer 头为 runtime/node/backend:、:372-374 该 importer 下 undici specifier/version、:6896-6897 包段；根 package-lock.json:26852 与 :24815-24818；本机 runtime/node/backend/node_modules/undici 实装 7.29.0；根 overrides 只有 iconv-lite，无强制版本。
- **触发条件**：任何经 undici（Node 内置 fetch/Agent）发起的出站 HTTPS 请求，Agent 上显式设置了 tls 选项时。
- **复现步骤**：读 package.json:139 + 两份锁文件对应行 + 实装版本；semver 实测。
- **实际影响**：所有出站请求的 TLS 证书校验可能被静默丢弃——对 AI 供应商的调用（携带 API key）可被同网段中间人读取与篡改，且不报任何错误。机密性与完整性双重影响，故定 P1。**订正**：finding 的 trigger 措辞（「Agent 上显式设置了 tls 选项时」）在本仓一方代码中未被直接实例化——扫 runtime/node 下 6789 个 js/ts，undici 只被构造成 `ProxyAgent`（`src/utils/proxyDispatcherAgent.js:36-37`、`src/services/gateway/upstreamModelProbe.js:50`），未发现 `new Agent({connect:{tls:...}})`；仅有的 rejectUnauthorized 在 `src/cli/handlers/proxy.js:487/519/974`，是 Node 原生 https.request 选项。这影响可达性与实际可利用性（severity 讨论），不影响「依赖版本落在受影响区间」的事实认定。
- **根本原因**：undici 是 Node 运行时的传输底座，版本随 backend 依赖走；停在 7.29.0 而 7.30.1 的修复在范围内。
- **修复建议**：undici 升到 >=7.30.1。
- **建议测试**：加一条用例：用自签名证书起一个本地 HTTPS 服务，经 undici Agent 显式传 tls 选项发起请求，断言连接被拒绝（校验未被丢弃）（未跑）。
- **是否已确认**：已确认（六项代码级断言均被证据支持；唯一未证实的是外部 advisory 元数据，属题目给定材料且无任何反证）。

#### DEP-06 ｜ 根 package-lock.json 是迁移前的死锁文件，与 pnpm-lock.yaml 双锁并存
- **风险等级**：P2
- **涉及模块**：锁文件管理
- **涉及文件**：`package-lock.json:1`
- **具体代码位置**：仓库根 package-lock.json（1948 条 packages 条目，lockfileVersion 3）
- **问题描述**：该文件记录的 9 个 workspace 路径全部是 2026-10 目录迁移前的形状：apps/ai-frontend、apps/khyos-desktop、apps/provider-hub、platform/packages/shared、platform/packages/ui-shared、services/ai-backend、services/backend、services/backend/vendor/shared、software/khyquant/frontend。现行布局是 runtime/node/backend、runtime/node/ai-backend、delivery/web/ai-frontend、delivery/web/provider-hub、runtime/substrate/platform/packages/*、delivery/channel/khyquant/frontend。而根 package.json:4 自称「pnpm 是仓库 workspace 的唯一安装入口」。git log：仅一笔 692e714e（2026-07-27）此后从未改动；双锁并存属实（package-lock.json 991,715 B + pnpm-lock.yaml 525,277 B 同在仓库根）。**订正**：9 条中 apps/khyos-desktop 确实存在（DIR），「这些目录一个都不存在」与「逐个 fs.existsSync 全部为 false」不准确。
- **触发条件**：任何人在仓库根跑 npm install / npm ci / npm audit，或任何按 lockfileVersion 推断依赖树的工具。
- **复现步骤**：node -e 解析 package-lock.json：lockfileVersion=3、name=Khy-OS、packages 键 1948 条；筛出 workspace 路径 9 条；fs.statSync 逐个核对 8 不存在 1 存在；git log -5 仅一笔；根条目 devDependencies 与 package.json devDependencies 逐项一致（陈旧只发生在 workspace 路径层）。
- **实际影响**：同一项目两份锁文件，npm 侧那份描述的是不存在的目录树。**订正**：「死锁文件」与「确认无任何流程消费它后删除」不成立——`scripts/ci/check-dependency-size.js:75` 以 LOCK_PATH 读它、:137-138 文件缺失即硬报错、:375 明言「包数以 package-lock.json 为准（硬预算）」，实跑该守卫「基线 2227 → 当前 1931」正是从这份陈旧锁文件数出；`pr-gate.yml:794` 的 npm audit 无 working-directory 在仓库根执行同样消费它；check-native-registry.js:126 也把它列入扫描。直接删除会先打断 dep-size 守卫，正确修法是文档已规划的 npm 双栈退役（[DESIGN-LAY-008]:4518 列 4 个消费方、:12567 计划「先改 dependabot/frontend-ci 等 4 消费方」再退役）。
- **根本原因**：目录迁移（方案 P 把顶层 platform/services/software/apps 物理化迁入 runtime/ 与 delivery/）时只迁了 pnpm-lock.yaml，package-lock.json 留在原处。
- **修复建议**：确认无任何流程消费它后删除；若确有 npm 侧消费者，用现行布局重新生成（按上述证据，实际路径是先完成 npm 双栈退役）。
- **建议测试**：加一条守卫：package-lock.json（若存在）中记录的所有 workspace 路径必须真实存在于磁盘。
- **是否已确认**：已确认（解析 + statSync + git log + 消费方清点）。

#### DEP-07 ｜ 发布链的打包器（esbuild 0.28.1 / @yao-pkg/pkg）不在任何 manifest 里，由 CI 临时安装
- **风险等级**：P2
- **涉及模块**：构建与发布
- **涉及文件**：`.github/workflows/dual-channel-release.yml:78`
- **具体代码位置**："Install publish dependencies" 步：npm install --no-save --ignore-scripts --workspaces=false esbuild@0.28.1 @yao-pkg/pkg@6.21.0
- **问题描述**：esbuild 只在根 devDependencies 声明 ^0.25.12（package.json:373；pnpm-lock.yaml:37-39 锁定 0.25.12；本机 node_modules 实装 0.25.12），而发布链实际用 0.28.1；@yao-pkg/pkg 在仓内所有 package.json 中 0 处声明（git grep 'yao-pkg' 全仓仅命中该 CI 行；两份锁文件零命中）。两个工具都被 `works/ship/build/esbuild-modules.js:37` 与 `works/ship/build/pack-executable.js:68` 从 node_modules 解析。`--no-save` 意味着版本不进任何清单也不进锁文件。CI :95-98「Build executables」紧接着跑 `node works/ship/build/esbuild-modules.js --prod` 与 `node works/ship/build/pack-executable.js --all`。**订正**：finding 称 esbuild「只在根 devDependencies 声明」，实际 delivery/brand/khyos-desktop/package.json:14（^0.25.12）与 delivery/extension/tools/khy-markdown/muya-embed/package.json:14（^0.25.0）也有声明，但二者属互不相关的子项目、均不供 works/ship/build/ 使用。
- **触发条件**：每次 v* tag 发布；以及任何人在本机跑同一构建脚本。
- **复现步骤**：读 dual-channel-release.yml:76-79；遍历全仓 manifest 四类依赖字段；读 pack-executable.js:66-85（getPkgInvocation 依次探测 node_modules/@yao-pkg/pkg/lib-es5/bin.js :68、node_modules/pkg/lib-es5/bin.js :69、两个 legacy services/backend 变体 :70-71，最后回退 PATH 全局 pkg）。
- **实际影响**：发布产物的打包器版本不在版本控制内：本地 0.25.12 与发布 0.28.1 产出的 bundle 不可比，问题无法在本地复现；@yao-pkg/pkg 的版本漂移不会被任何锁文件发现，也无法审计。
- **根本原因**：从 vercel/pkg 迁到 @yao-pkg/pkg、以及 esbuild 升级，都只落在 CI 的临时 install 行里，没有回写 manifest。
- **修复建议**：把 esbuild 与 @yao-pkg/pkg 作为发布工具链正式声明（根 devDependencies 或独立的 works/ship 清单），CI 改用 install:core 同一套锁定安装，删掉 --no-save 的临时行。
- **建议测试**：加一条守卫：dual-channel-release.yml 中不得出现 `npm install --no-save` 形式的构建工具安装。
- **是否已确认**：已确认（读码 + git grep + 本机版本实测；「本地与发布产出不可比」为依据版本解析事实的推论而非两版 bundle 的字节比对，未实跑发布构建）。

#### DEP-08 ｜ works/ship/build/pack-executable.js 的 ROOT 少算一级，发布构建在第一步就 ENOENT
- **风险等级**：P1
- **涉及模块**：构建与发布
- **涉及文件**：`works/ship/build/pack-executable.js:18`
- **具体代码位置**：第 18 行 const ROOT = path.resolve(__dirname, '../..')；第 19 行 MODULES_JSON = path.join(ROOT, 'packaging/modules/modules.json')；第 24 行 fs.readFileSync(MODULES_JSON)
- **问题描述**：该文件住在 works/ship/build/，`../..` 解析到 works/ 而非仓库根，于是 MODULES_JSON 指向 works/packaging/modules/modules.json——该路径不存在（真实文件在 works/ship/modules/modules.json）。同目录的 `works/ship/build/esbuild-modules.js:43-46` 明确记录了同一类 bug 并已修复（"本脚本住在 works/ship/build/（方案 P 把顶层 packaging/ 物理化迁来），ROOT 是仓库根：__dirname 往上三级。曾经按搬家前的 packaging/build/ 算两级，结果四个路径全漂"），但 pack-executable.js 没跟着改。:67-72 pkg 候选含 `services/backend/node_modules/...`（不存在）；:113 `path.join(ROOT, 'services/backend/node_modules', asset)` 同样不存在；:9-11 用法仍写 packaging/build/pack-executable.js。native-modules.json 列 better-sqlite3 / node-pty / node-llama-cpp 的 assets 列表。
- **触发条件**：dual-channel-release.yml:98 的 `node works/ship/build/pack-executable.js --all`，即每次 v* tag 发布。
- **复现步骤**：实跑 `node works/ship/build/pack-executable.js --module khy --platform win-x64` → 与 finding 所述逐字一致的报错：`Error: ENOENT: no such file or directory, open 'D:\Portable\khy-os\works\packaging\modules\modules.json' at ... pack-executable.js:24:31`，exit 1，进程在读任何配置前退出。node 计算 path.resolve('works/ship/build','../..') = works（确认少算一级）；fs.existsSync 清点：works/packaging/modules/modules.json MISSING、works/ship/modules/modules.json EXISTS、services/backend/node_modules MISSING（真实位 runtime/node/backend/node_modules EXISTS）、works/entries MISSING。
- **实际影响**：发布链在「构建」这一步必然失败，可执行文件产物从来产不出来；即便修好 ROOT，:70-71 与 :113 仍是迁移前 services/backend/node_modules 路径，原生模块 better-sqlite3/node-pty/node-llama-cpp 会因 fs.existsSync 为假被静默跳过，产出缺原生模块的可执行文件——那是最坏的一类失败：构建全绿、运行时才崩。DIST_MODULES/DIST_EXECUTABLES 也会落到不存在的 works/entries/。（端到端未实测：本 checkout 未装 pkg 工具链与原生 .node 产物。）
- **根本原因**：目录从 packaging/ 迁到 works/ship/build/ 时只修了同目录的 esbuild-modules.js；pack-executable.js 的四个路径（MODULES_JSON、DIST_MODULES、DIST_EXECUTABLES、node_modules 相对位）全部没改（[DESIGN-LAY-008] 执行路线图.md:4244-4246 明确记载 executables 族「本批未动」互证）。
- **修复建议**：ROOT 改成 `path.resolve(__dirname, '../../..')`；MODULES_JSON 指向 works/ship/modules/modules.json；DIST_MODULES/DIST_EXECUTABLES 指向仓库根的 entries/executables/；第 70-71、113 行的 services/backend/node_modules 改为 runtime/node/backend/node_modules。
- **建议测试**：加一条冒烟：在干净检出里跑 pack-executable.js --all，断言配置读得进来且 assets 列表非空。
- **是否已确认**：已确认（实跑复现 ENOENT + 路径清点 + git grep 唯一 CI 调用点）。

#### DEP-09 ｜ tag 构建的 Docker 镜像装的是 PyPI 当时最新版 khy-os，不是 tag 对应的版本
- **风险等级**：P2
- **涉及模块**：构建与发布 / 容器
- **涉及文件**：`Dockerfile:106`
- **具体代码位置**：Dockerfile 105-111（ARG KHY_OS_VERSION=""；为空时 pip install --no-cache-dir khy-os）；.github/workflows/docker.yml:79-80（build-args KHY_OS_VERSION=${{ github.event.inputs.version || '' }}）
- **问题描述**：docker.yml 只在 workflow_dispatch 时才有 inputs.version（:12 required:false，描述还写 'defaults to git tag'——但这个默认值在流水线里没有任何实现）；push tag v* 事件（docker.yml:3-6 触发器）没有 inputs，表达式求值为空串，KHY_OS_VERSION 为空 → Dockerfile 走 `pip install --no-cache-dir khy-os`，即 PyPI 上的当时 latest。同一条 RUN 末尾 `&& khy --version`（:111）——版本错配在构建期就是可见的。多平台矩阵 linux/amd64,linux/arm64（:40-41）。旁证：dual-channel-release.yml:203-216（PyPI/npm 渠道在 tag 事件用 `VERSION="${GITHUB_REF#refs/tags/v}"`）——另两个渠道用 tag 版本，只有 Docker 渠道用 PyPI 当时最新；`deploy-staging.yml:117-126` 同样构建 ./Dockerfile 但完全不传 KHY_OS_VERSION，staging 镜像也吃 PyPI 最新；`git tag -l "v*"` 显示仓库真实存在 v1.1.8~v1.1.15 五个 tag，触发路径是既成事实。
- **触发条件**：推 v* tag 触发 docker.yml 的多平台构建。
- **复现步骤**：读 Dockerfile:106-111 的分支；读 docker.yml:79-80 的 build-args 与 on: 触发器；git grep KHY_OS_VERSION 全仓仅命中 docker.yml:80、Dockerfile:105/106/109（无干的是 C kernel Makefile/src）。
- **实际影响**：v1.2.3 这个 tag 产出的镜像里装的可能是 1.2.9；镜像内 `khy --version`（Dockerfile:111 会执行）与 tag 不一致；同一次发布的三个渠道内容不同（PyPI/npm 用 tag 版本，Docker 用 PyPI 当时最新），且镜像不可复现——同一条 commit 在不同日期构建出不同镜像。
- **根本原因**：build-arg 用 github.event.inputs.version 取版本，但 tag 事件的版本在 github.ref_name 里而不是 inputs 里。
- **修复建议**：tag 事件用 `${GITHUB_REF_NAME#v}` 传 KHY_OS_VERSION（与 dual-channel-release.yml:206-208 同一取法）；或改成从当前检出的 pyproject.toml 读版本并 pip install 本地 wheel。
- **建议测试**：加一条断言：构建参数里 KHY_OS_VERSION 与 tag 去 v 后相等，否则构建失败（未实跑——需 Docker 与 tag 推送环境）。
- **是否已确认**：已确认（三处引用行号与内容全部对得上；「装的可能是 1.2.9」是机制推演而非实测，按约束未访问 PyPI）。

#### DEP-10 ｜ .env 备份文件被 COPY 进发布镜像，.dockerignore 的 **/.env 匹配不到它们
- **风险等级**：P2
- **涉及模块**：构建与发布 / 容器
- **涉及文件**：`.dockerignore:154`
- **具体代码位置**：.dockerignore:154 `**/.env`；Dockerfile:203 `COPY runtime/node/backend/ runtime/node/backend/`
- **问题描述**：.dockerignore:6-8 自己写明了匹配语义：Docker 用 Go filepath.Match，`*` 不跨 `/`，`**/.env` 只命中恰好名为 .env 的文件。runtime/node/backend/ 目录下实测存在：.env(1771B)、.env.bak-20260914-codexpin(1199B)、.env.bak-20261009-fix(5897B)、.env.bak-20261010(6873B)、.env.bak-cleanup(5205B)、.env.example(14685B)、NUL(92B)。.dockerignore 已排除 **/.env、**/*.log、**/*.db、**/*.cpuprofile、**/*.pem、**/*.key，但没有一项覆盖 .env.bak-*。Dockerfile:203 整树 COPY 会把这些备份带进镜像层；Dockerfile 全文无任何事后清理 .env* 的 RUN。.env 被 gitignore（runtime/node/backend/.gitignore:5）且未被跟踪；.env.bak-20261010 被根 .gitignore:369 `*.bak-*` 忽略；git ls-files 中 .env* 仅 .env.example 一个（被跟踪）。本机 .env 变量名清点（只取 = 左侧，未输出任何值）：含 JWT_SECRET、KHYOS_SSO_PRIVATE_KEY_FILE、GATEWAY_API_POOL_SERVICE_MAP 等——「可能含真密钥」的措辞有据。构建上下文确认为仓库根（docker-compose.yml:33-34 与 docker.yml:75-76 均 context: .）。
- **触发条件**：任何本机或 CI 的 docker build（CI 干净检出没有这些文件，所以只有本机构建会中招——正是 .dockerignore 自己注释里说的「CI 全绿、本机泄漏」形态）。
- **复现步骤**：列 runtime/node/backend/ 下 .env* 文件（本会话实测 7 项）；读 .dockerignore:154 与 Dockerfile:203；findstr /N /I "bak env" .dockerignore 全文仅命中 84(venvs)/150-154，确认无任何模式覆盖 .env.bak-*；git check-ignore -v + git ls-files 确认跟踪状态。scripts/ci/check-docker-context.js:117 自带注记「['.env.example', 'git 跟踪的配置样本（不被 **/.env 命中）)」——仓库自己的守卫也依据同一匹配语义，且该守卫无任何 .env.bak 处置。
- **实际影响**：开发机上的真实凭据随镜像层发布到 GHCR；镜像层里的凭据无法通过后续层删除（只能整层作废）。附带：.env.example 被 git 跟踪，CI 干净检出里也有，同样不被 `**/.env` 命中——它进镜像甚至不限于本机。
- **根本原因**：备份文件用了 .env.bak-<后缀> 命名，绕过了按精确文件名写的排除规则。
- **修复建议**：.dockerignore 增加 `**/.env.bak-*`（或更一般的 `**/.env*` 再用 `!**/.env.example` 救回样本）。
- **建议测试**：加一条构建期断言：镜像内 `find /app -name '.env.bak-*'` 必须为空（未实跑 docker build）。
- **是否已确认**：已确认（机制链闭合：命名 → filepath.Match 语义 → 无兜底模式 → 整树 COPY → 无事后清理 → 层内凭据无法移除）。

#### DEP-11 ｜ backend jest 深红（79 suite / 198 用例失败），PR 门整 job continue-on-error 而发布门才拦
- **风险等级**：P1
- **涉及模块**：测试
- **涉及文件**：`.github/workflows/pr-gate.yml:500`
- **具体代码位置**：pr-gate.yml:500-503 test-baseline job 级 continue-on-error: true；:615-619 的 notice；对照 dual-channel-release.yml:68-70 的 Jest 步无 continue-on-error
- **问题描述**：本会话实跑 `cd runtime/node/backend && npm test -- --ci --silent`（jest 29.7.0，Node v22.18.0，Windows）：Test Suites: 79 failed / 24 skipped / 1226 passed（1305 of 1329 total）；Tests: 198 failed / 375 skipped / 12967 passed（13540 total）；耗时 3247 s。失败分类：44 个 suite 断言失败、约 20 个超时、10 个 "import after teardown"、4 个 Cannot find module。模块找不到的目标全是迁移前路径：runtime/scripts/ci/export-dimension-health.js、../../../../platform/packages/shared/src/utils/logger、../../../software/khyquant/services/klineDataService、../../../../scripts/ci/check-version-sync.js。而 pr-gate.yml:618 的 notice 自称已知基线是「tests/cli + tests/utils 取样中 4 suite / 9 用例失败」——取样数而非全量数，被当成总量宣传。DEBT.md 最后更新 2026-09-23，其 §一 自记 2026-09-08 全量基线为 465 失败套件 / 798 失败用例，与 notice 的「4/9」相差一个数量级；DEBT 登记与 Phase 2/3 期限无守卫强制。
- **触发条件**：任何 PR 合入；任何 v* tag 发布。
- **复现步骤**：本会话实跑 npm test（见上数字）；读 pr-gate.yml:500-503 与 :615-619；读 dual-channel-release.yml:68-70；读 jest.config.js:77-83（testPathIgnorePatterns 已把全部 node:test 套件与自跑脚本排除）。pr-gate.yml:641-671 的 src-suite-baseline job 只跑 test:node:src——PR 门上唯一跑 jest 全量的就是 report-only 的 test-baseline。
- **实际影响**：PR 可以带着 79 个红 suite 合入 main，红债一路累积到打 tag 才在发布链上爆——闸门装错了位置。另外 `--passWithNoTests` 留了「零测试也放行」的口子：若哪天 tests/ 下无可跑文件，发布门的 Jest 步会以 0 测试通过（该口子在两道门都存在，pr-gate.yml:546 与 dual-channel-release.yml:70）。**注**：本次运行用的是本机既有 node_modules，非干净 install:core，个别失败可能带环境因素；但模块解析失败（死路径）与 teardown 失败与安装环境无关。复现验证：同环境同命令再跑得 74 failed / 189 failed case（74 vs 79 为负载浮动，同量级同方向，退出码均非 0），`--listTests` 1329 与报告一致。
- **根本原因**：测试基线以 continue-on-error 接入后再没推进过；DEBT.md 的升级路径（Phase 2/3）没有到期机制；notice 里的「4 suite / 9 用例」是取样数，被当成总量宣传。
- **修复建议**：把迁移死路径导致的 4 个 suite 先清零（改 require 相对层级），再把 test-baseline job 的 continue-on-error 换成「失败用例数只降不升」的棘轮；同时把 notice 的全量实测数写进去。
- **建议测试**：加一条守卫：test-baseline job 不得保留 job 级 continue-on-error，除非 DEBT.md 里有未过期的登记条目。
- **是否已确认**：已确认（结构性指控逐条与代码相符，实测深红在本机同环境复现）。

#### DEP-12 ｜ aiChatCore 主对话循环里两处越作用域引用（no-undef），因 lint 不拦而一直没修
- **风险等级**：P2
- **涉及模块**：代码质量 / 运行时缺陷
- **涉及文件**：`runtime/node/backend/src/cli/aiChatCore.js:4659`
- **具体代码位置**：:4470 `let compactLoopMessages;`；:4595 闭合该块；:4659 与 :4725 在新块内引用 compactLoopMessages；:4857 引用 collectedToolResults（声明在 :3931），:5139 又用 typeof collectedToolResults !== 'undefined' 兜底
- **问题描述**：`npm run lint` 报 no-undef 共 84 处（全 src：3600 个文件、495 error、5899 warning）。aiChatCore.js：:4470 的声明所在块在 :4595 的 `}` 处闭合（缩进从 6 空格回到 4 空格），而 :4659/:4725 在之后新开的块里引用 compactLoopMessages——标识符确实不在作用域内。:4857 引用 collectedToolResults 同理（声明在 :3931），而作者自己在 :5139 写 `typeof collectedToolResults !== 'undefined' && Array.isArray(collectedToolResults)`，正说明这个引用在当时就是不确定的。
- **触发条件**：走到 wrap-up / 交付汇总这条代码路径时。
- **复现步骤**：读 aiChatCore.js 对应行；`node node_modules/eslint/bin/eslint.js src/cli/aiChatCore.js --format json` → no-undef(severity=2) 命中 4659/4725/4857；同目录对 src/ 全量 → no-undef 合计 84 处，aiChatCore.js 占 5 处（4659、4725、4857、5139、5140）。用仓库根 node_modules/acorn 写只读 AST 作用域探针：:3931 声明位于 IfStatement[3897-4808] 块内而 :4857/:5139 在其外；:4470 声明位于 WhileStatement[4176-4595] 块内而 :4659/:4725 在其外——静态证实三处引用均越作用域。
- **实际影响**：这两个路径一旦被执行就是 ReferenceError: compactLoopMessages is not defined——但**按实测收回**：四个引用点全都有护栏——:4659 被 catch[4671] 接住回落 fallback reply，:4725 被 catch[4735] 静默跳过，:4857 被 catch[4868] 接住使 provenance 提示丢失，:5139 的 typeof 在运行时就返回 'undefined' 不抛。真实后果是 wrap-up 模型汇总、计划感知聚合、溯源矛盾核对**永远静默不执行**、toolActivity 恒少计，而非进程崩溃。标题「两处」也少计：该文件实报 5 个 no-undef 站点（3 条语句）。
- **根本原因**：lint 的 error 级不阻断（见 DEP-13），no-undef 这类真缺陷被 5898 条 warning 淹没，没人逐条处置。
- **修复建议**：把 compactLoopMessages 与 collectedToolResults 提升到外层函数作用域，或改为显式传参；至少让 :5139 的 typeof 兜底与 :4857 的引用口径一致。
- **建议测试**：给 wrap-up 分支补一条走到 :4659/:4725 与 :4857 的用例（全 tests/ 无任何文件引用 compactLoopMessages/collectedToolResults，当前没有任何测试覆盖这两条路径）。
- **是否已确认**：已确认（ESLint 实跑 + AST 作用域探针 + 测试面搜索）。

#### DEP-13 ｜ backend lint 债务较文档基线翻倍，`--max-warnings 0` 从未对存量代码生效
- **风险等级**：P2
- **涉及模块**：代码质量
- **涉及文件**：`runtime/node/backend/package.json:78`
- **具体代码位置**：package.json:78 "lint": "eslint src/ --max-warnings 0"；pr-gate.yml:402 与 build-executables.yml:81 的基线注释；pr-gate.yml:459-474 的 lint-ratchet
- **问题描述**：本会话实跑 `cd runtime/node/backend && npm run lint`：exit 1，✖ 6394 problems (495 errors, 5899 warnings)（eslint 9.39.5），覆盖 2003 个不同文件。而 pr-gate.yml:401-404 与 build-executables.yml:79-84 记载的基线是「3417 个问题（428 errors + 2989 warnings，覆盖 2246 个文件中的 1060 个）」——即 errors +15.7%、warnings +97.5%、命中文件从 1060 涨到 2003。规则分布：eqeqeq 2393、import/order 2145、no-unused-vars 1106（均 warning）；no-useless-escape 155、no-empty 120、no-undef 84、no-control-regex 72（error）。eslint.config.js:44-83 确认前三个为 warn、recommended 集中后四个为 error。
- **触发条件**：任何改动 runtime/node/backend/src 的 PR。
- **复现步骤**：按 finding 指名的方式实跑（PowerShell 捕获退出码）：`npm run lint` → EXIT_CODE=1，汇总行「✖ 6394 problems (495 errors, 5899 warnings)」；用同一输出解析八项规则数（全部与 finding 精确一致）；基线增幅复算 (495-428)/428=+15.7%、(5899-2989)/2989=+97.5%。
- **实际影响**：`npm run lint` 的 `--max-warnings 0` 契约在产品代码上从未被满足过；PR 门只对新增文件零容忍（:459-462），对修改文件只报告（:465-474 continue-on-error），发布链的全量 lint 是 continue-on-error（build-executables.yml:85-88）。结果是「改了也不许更脏」这条唯一在执行的纪律只管增量，存量 495 个 error（含 84 个 no-undef）无人认领。
- **根本原因**：债务基线写在注释里而不是棘轮文件里（scripts/ci 下无 lint-baseline.json；debt-ledger.json 无 lint/eslint 条目；code-standards.baseline.json 只登记 fileLines/functionLines/nestingDepth/consoleLog/namingViolations）；lint-ratchet 的 report-only 步没有到期转阻断的机制。存在一个 scripts/ci/lint-debt-tracker.js 但属孤儿（.github/workflows 与两个 package.json 中零引用；backend 目录下 LINT-DEBT.json 不存在；且其逻辑本身不可能失败——第 77 行先写快照、第 91-92 行再读同一文件比较，第 95 行恒置 exitCode=0）。
- **修复建议**：把 495 个 error 按「no-undef / no-empty / no-control-regex 等真缺陷」与「no-useless-escape 等机械项」分两类，前者逐文件清零（可从 no-undef 下手，与 DEP-12 同源），后者一次性 --fix；基线数落进 scripts/ci 的 json 棘轮而不是注释。
- **建议测试**：加一条守卫：npm run lint 的 error 数不得超过 scripts/ci/lint-baseline.json 登记值（只降不升）。
- **是否已确认**：已确认（按 finding 指名方式实跑复现；唯一错误明细：description 中「no-undef 集中在 174 个文件，docs.js 52 处、session.js 36 处、replSession.js 28 处」标注有误——实测 no-undef 共 84 处、分布在 19 个文件，52/36/28 恰为这三个文件的 error 总数，即把 error 级统计误挂到 no-undef 标签上，不影响结论）。

#### DEP-14 ｜ prettier 在整个仓库没有任何执行面，format:check 报出 1536 个不合规文件
- **风险等级**：P2
- **涉及模块**：代码质量
- **涉及文件**：`runtime/node/backend/package.json:77`
- **具体代码位置**：package.json:77 "format:check": "prettier --check ..."；works/build/githooks/pre-commit；runtime/node/backend/package.json:232-237 的 lint-staged
- **问题描述**：本会话实跑 `cd runtime/node/backend && npm run format:check`：exit 1（npm error code 2），[warn] 共 1535 个文件不合规（finding 写 1536，实测 1535，差 1 不影响结论）。执行面核查：① 12 个 workflow 里没有任何一个调用 format:check 或 prettier（确有一个 eslint 执行面：build-executables.yml:88 report-only、frontend-ci.yml:87、pr-gate.yml:459-462 对新增文件阻断，但 prettier 在 CI 零接线）；② works/build/githooks/pre-commit（本仓唯一生效的 pre-commit，`git config core.hooksPath` 输出 works/build/githooks）跑的是临时文件、>10MB 大文件、check-staged-secrets、check-secrets-staged、rules:gate commit 档、check-copyright-readiness、check-workflow-sanity、check-version-bump-approval——没有 prettier 也没有 eslint；③ backend package.json:232-237 配了 lint-staged（`"src/**/*.js": ["prettier --check", "eslint --max-warnings 999"]`），但没有任何钩子调用 `npm run precommit`（:80 有该脚本）——全仓 27910 个文件扫描确认无任何钩子或 CI 调用 lint-staged，是死配置。根 package.json 无 lint-staged/husky/prettier 配置。
- **触发条件**：任何提交与任何 PR。
- **复现步骤**：本会话实跑 npm run format:check（见上数字）；通读 works/build/githooks/pre-commit 全文（1-178 行）；grep 全部 workflow 无 format:check/prettier。
- **实际影响**：prettier 装了、脚本写了、lint-staged 配了，三层都没接线；格式漂移无人发现，也无人能说清「当前基线是多少个文件不合规」。
- **根本原因**：格式化纪律从 npm/husky 时代迁到 pnpm + 自建 githooks 时没跟着迁，只剩 manifest 里的残留配置。
- **修复建议**：把 `prettier --check` 接进 works/build/githooks/pre-commit（只查暂存的 src/**/*.js，与 lint-staged 原意一致），或在 pr-gate 的 lint-ratchet 里加一条「新增文件必须过 prettier --check」的阻断步；存量基线落 json 棘轮。
- **建议测试**：加一条守卫：pre-commit 钩子必须包含 prettier --check 调用（防再次脱钩）。
- **是否已确认**：已确认（三层论断与 1535+ 文件不合规的实测全部属实；唯一偏差是文件数 1536 vs 1535）。

#### DEP-15 ｜ frontend-ci 对 khyquant 前端「不跑测试 / lint 坏」的两条理由与代码事实不符
- **风险等级**：P2
- **涉及模块**：CI 门禁
- **涉及文件**：`.github/workflows/frontend-ci.yml:137`
- **具体代码位置**：:137「该前端没有测试脚本，只有 lint:ci 与 build」；:139-147「eslint-plugin-vue 不在它的 devDependencies 里（只有 @vitejs/plugin-vue）」；:148-150 continue-on-error
- **问题描述**：两条都与代码相反：① `delivery/channel/khyquant/frontend/package.json:19` 有 `"test": "vitest run"`（:20-21 还有 test:watch/test:coverage），vitest.config.js:9 的 include 是 `['src/**/*.{test,spec}.{js,ts}']`，该目录实测 38 个 src/__tests__/*.test.js；② package.json:47 声明了 `"eslint-plugin-vue": "9.28.0"`，其 node_modules/eslint-plugin-vue 目录真实存在（node -e 读 version → 9.28.0），eslint.config.js:4 `import pluginVue from 'eslint-plugin-vue'`（:23 plugins、:30 flat/recommended）。两个步骤都挂 continue-on-error（:148-150 的 lint:ci 与 :156 的 Bundle size），所以理由写对写错都不影响门禁颜色。根 pnpm-lock.yaml 的 importer 块也含 eslint-plugin-vue 9.28.0 与 vitest 1.6.1，而 CI 的 Install 是 `install:frontend`（pnpm install --frozen-lockfile --filter …quant-trading-frontend…）——全新 CI 安装同样拿得到这两个包。
- **触发条件**：改 delivery/channel/khyquant/frontend/** 的 PR。
- **复现步骤**：`dir /s /b src\__tests__\*.test.js | find /c /v ""` → 38；`node node_modules\vitest\vitest.mjs run --reporter=basic`（= npm test）→ 退出码 0，Test Files 38 passed (38)、Tests 442 passed (442)；`node node_modules\.eslint-Q7PfS1A5\bin\eslint.js . --max-warnings 0`（= npm run lint:ci）→ 退出码 1，无 ERR_MODULE_NOT_FOUND，末尾为 `✖ 7 problems (0 errors, 7 warnings)` / `ESLint found too many warnings (maximum: 0)`。历史证据：`git show 7bfc49d9:.github/workflows/frontend-ci.yml` 中该注释块与今天逐字相同，而同 commit 的 frontend/package.json 已有 "test": "vitest run" 但没有 eslint-plugin-vue——理由①从一开始就是假的，理由②在 f2f1c5da（2026-10-10）补上 eslint-plugin-vue 后变为假。
- **实际影响**：38 个已写好的 vitest 用例（442 断言）在 CI 里从未运行；注释给出的「补上 eslint-plugin-vue 就能跑」是错的方向，照着做的人会白改一轮 package.json。
- **根本原因**：注释写于依赖补齐之前（或之后没更新），而 continue-on-error 让错误理由永远不会以红色暴露。
- **修复建议**：把 khyquant-frontend job 补上 `npm test`（vitest run）与 `npm run lint:ci` 两步；先以报告态跑一次拿到真实结论，再决定哪步转阻断；注释按实测改写。
- **建议测试**：加一条守卫：frontend-ci.yml 中每个被 continue-on-error 的步骤，其理由必须与当前 manifest/文件系统一致（或带到期日）。
- **是否已确认**：已确认（两条注释理由与当前代码事实相反，并用只读方式实测复现了相反结论；未运行 GitHub Actions 工作流本身，「38 个用例在 CI 里从未运行」是由静态阅读推出）。

#### DEP-16 ｜ 三份跟踪中的 npm 锁文件共 126 条 resolved 指向 registry.npmmirror.com
- **风险等级**：P2
- **涉及模块**：依赖来源原生（PROCESS-013）
- **涉及文件**：`apps/khyos-desktop/package-lock.json:1191`
- **具体代码位置**：apps/khyos-desktop/package-lock.json（15 条）、delivery/brand/khyos-desktop/package-lock.json（25 条，134 条里 25 条非官方）、delivery/channel/khyquant/frontend/package-lock.json（86 条）
- **问题描述**：check-native-registry 实测（`node scripts/ci/check-native-registry.js`，阶段 S1 只记录不阻断，full 模式扫描 7734 个文件）：三份锁文件共 126 处 resolved 指向 registry.npmmirror.com。其中 delivery/brand/khyos-desktop/package-lock.json 只有 25 个可解析 host 且全部来自 npmmirror——整份锁文件就是镜像站快照。同一守卫还报出：`scripts/desktop/package-and-launch.ps1:33-34` 出现 ELECTRON_MIRROR 与 ELECTRON_BUILDER_BINARIES_MIRROR 两个镜像注入开关（mirror-injection-knob，本文件各 1 处）；`delivery/channel/khyquant/khy_quant/_bootstrap.py:129` 运行时源码出现 npmmirror.com 但同文件无 KHY_USE_CN_MIRROR / KHY_KHYOS_PREFER_CN 门控（ungated-runtime-mirror）。合计 8 warning、0 error。
- **触发条件**：任何人按这三份锁文件执行 npm ci；或按 package-and-launch.ps1 打包。
- **复现步骤**：见 verifiedBy 字段的命令输出；另对三份 package-lock.json 逐条统计 resolved host 复核了数量。
- **实际影响**：同一份 manifest 在不同网络/不同日子装出不同版本的依赖（镜像同步延迟时甚至是旧版），产物不可复现；且这些锁文件被 git 跟踪，等于把镜像站固化进了交付物。
- **根本原因**：这三处是独立的 npm 子项目（不在 pnpm workspace 内），历史上在镜像网络环境下生成锁文件后直接提交。
- **修复建议**：三份锁文件在官方网络下重新生成（npm install --registry=https://registry.npmjs.org 后提交）；删掉 package-and-launch.ps1 的两个 *_MIRROR 参数；_bootstrap.py 的镜像地址补显式开关名，默认走官方源。
- **建议测试**：check-native-registry 已有 C3 判据，把这三份锁文件从 warning 提升为 error（或先在 .npmrc 固定 registry 后重新生成）。
- **是否已确认**：已确认（脚本门禁：node scripts/ci/check-native-registry.js）。

#### DEP-17 ｜ 两个 pnpm workspace 成员各自还跟踪着一份 npm 锁文件
- **风险等级**：P3
- **涉及模块**：锁文件管理
- **涉及文件**：`delivery/web/provider-hub/package-lock.json:1`
- **具体代码位置**：delivery/web/provider-hub/package-lock.json（150 条）、delivery/channel/khyquant/frontend/package-lock.json（631 条）
- **问题描述**：两者都是 pnpm-workspace.yaml:8-9 的成员（provider-hub 2442 行 / name=khy-provider-hub / 149 条 resolved；khyquant 9008 行 / name=quant-trading-frontend / 630 条 resolved，两者 name 与各自 package.json 一致），由根 pnpm-lock.yaml 统一安装（importers 段含两者且都是非空真实条目），却各自还跟踪一份 package-lock.json。根 package.json:4 自称 pnpm 是唯一安装入口。全仓 tracked 的 package-lock.json 共 8 个，除这两个外（根目录、apps/khyos-desktop、delivery/brand/khyos-desktop、khy-trae-bridge、khy-markdown/muya-embed、mermaid-embed）均非 pnpm-workspace.yaml 成员根目录——9 个成员里确实只有这两个。
- **触发条件**：有人在这两个目录里跑 npm install / npm ci。
- **复现步骤**：读 pnpm-workspace.yaml:8-9；在 pnpm-lock.yaml 的 importers 段找到两者；git ls-files 确认两份 package-lock.json 已被跟踪。影响中的 DEP-16 交叉引用准确（khyquant 锁内 registry.npmmirror.com 恰好 86 处，provider-hub 那份 0 处）。
- **实际影响**：第二份锁文件会随 npm 生态的漂移过期；一次误操作的 npm install 就会把依赖解析到陈旧树上（khyquant 那份还带 86 条镜像 host，见 DEP-16）。「会过期」有实证：khyquant 锁在仓内只有一笔提交（2026-10-03 目录迁移收口，内容从未重新生成）；node 比对 package.json 与锁的 packages，`@khy/ui-shared`（package.json 声明 0.1.0、pnpm-lock.yaml 解析为 workspace link）在锁的 631 个 packages 条目中不存在——即 npm ci 今天就会因 lock 与 package.json 不同步而失败。
- **根本原因**：pnpm 迁移是渐进式的，子项目级的 npm 锁文件没有随之清理。
- **修复建议**：确认无 npm 侧消费者后删除这两份；若 khyquant 前端确需独立 npm 安装，则应把它移出 pnpm-workspace.yaml 并明确入口。**限定**：khyquant 前端确有文档化的 npm 侧消费者（`frontend/README.md:49 npm install`、:129 的 Docker 片段 `RUN npm ci`；`khyquant/PACKAGING.md:50,73` 说明 pip 包首启 bootstrap 用 npm install 装前端依赖），且该锁被 sdist 收录（MANIFEST.in:32、pip_packaging_rules.py:62）——fix 的前置条件对 khyquant 那份目前不成立，直接删会打断这些流程（尽管这些流程今天已因锁过期而处在坏/将坏状态，这反而印证了影响而非削弱）。
- **建议测试**：加一条守卫：pnpm-workspace.yaml 的成员目录下不得存在被跟踪的 package-lock.json。
- **是否已确认**：已确认（六项可验证主张全部为真；未跑 npm install/npm ci——复核规则禁止安装依赖与访问第三方源）。

#### DEP-18 ｜ 根 devDependencies 里有一套全仓无人引用的 Electron 工具链，且比发货版本落后 12 个 minor
- **风险等级**：P3
- **涉及模块**：依赖声明 / 根
- **涉及文件**：`package.json:370`
- **具体代码位置**：package.json:370-372 electron 32.3.3 / electron-builder ^25.1.8 / electron-rebuild ^3.2.9；对照 apps/khyos-desktop/package.json:58-59 electron 44.2.0 / electron-builder 26.15.3
- **问题描述**：在 scripts/、works/ship/、delivery/extension/scripts/、apps/khyos-desktop/scripts/、.github/、runtime/node/backend/{scripts,bin} 范围内 grep `electron-rebuild|electron-builder|require('electron')`，唯一命中 scripts/tests/check-native-registry.test.js:198（读该文件 175-224 行确认是守卫单测里的合成 package.json 夹具字符串，不是对 devDependency 的消费）。另跑全仓 `git grep -i electron`（排除 lock/文档）：真正的 electron import 只有 apps/khyos-desktop/src（用自己声明的 44.2.0）、delivery/web/provider-hub/src（该 workspace 包在 provider-hub/package.json:16 自声明 electron ^44.2.0）、以及 delivery/extension/scripts/khy-desktop-rd/goose/main-pattern-extract.ts（自述「抓取自 goose 仓库…仅保留调研范式」，无 package.json 无构建接线）；scripts/ .github/ works/ runtime 中 `from 'electron'` 与 `require("electron")` 两种形式均 0 命中。真正发货的桌面端用 apps/khyos-desktop 自己声明的 electron 44.2.0。根上这份 32.3.3 既不参与构建也不参与发布（pnpm-workspace.yaml 与 package.json:6-16 workspaces 均不含 apps/khyos-desktop，且它自带 package-lock.json）。
- **触发条件**：任何 `pnpm install`（install:core 不含根 devDeps，但 install:all（package.json:219 无 filter 全量安装）与开发机会装）。
- **复现步骤**：grep 结果（本会话实测）；对照两份 package.json 的版本声明；pnpm-lock.yaml:20-36 根 importer devDependencies 登记三个包；本机实测 node_modules/electron 是指向 .pnpm/electron@32.3.5（即 electron@32.3.3）的 junction，其 dist 实测 265 MB，.pnpm 下 electron@32.3.3（265MB）与 electron@44.2.0（335MB）并存共 600MB。
- **实际影响**：每次全量安装白装一份 265MB 级的 electron 与 app-builder-bin（finding 写「380MB 级」为约数偏高，electron-builder 本身仅 0.1MB、重量在其传递依赖）；更糟的是它给出「仓库级 electron 是 32.3.3」的错觉，而实际发货的是 44.2.0。
- **根本原因**：桌面端从仓库根迁到 apps/khyos-desktop 时，根的 devDependencies 没跟着清（git log -S electron -- package.json 命中 f9cc03dc「下线 electron:dev 入口并删除 scripts/electron-dev.js」，证实根上唯一的 electron 消费者被下线而 devDeps 未清）。
- **修复建议**：从根 devDependencies 删除 electron / electron-builder / electron-rebuild（连同 package.json:384-389 allowScripts 里的 electron 条目 :386，以及 pnpm-workspace.yaml:14 onlyBuiltDependencies 的 electron 条目——finding 只提了前者）。
- **建议测试**：加一条守卫：根 devDependencies 中的每个包必须在 scripts/ 或 .github/ 里有引用点。
- **是否已确认**：已确认（依赖声明陈旧、全仓无消费、两份 package.json 版本倒挂、git 历史佐证迁移遗留；「真正发货的桌面端」措辞偏松——DESIGN-DELIV-002 给 electron 渠道 ciWorkflow=null 不承诺交付，但唯一具备完整 Electron 工具链声明的桌面工程就是 apps/khyos-desktop）。

#### DEP-19 ｜ package.json 的 allowScripts 不是 pnpm 的设置，是一份惰性配置
- **风险等级**：P3
- **涉及模块**：安装脚本风险
- **涉及文件**：`package.json:384`
- **具体代码位置**：package.json:384-389 allowScripts { better-sqlite3, electron, esbuild, node-pty }；pnpm-workspace.yaml:12-16 onlyBuiltDependencies
- **问题描述**：pnpm 的构建类设置（ignoreScripts / allowBuilds / dangerouslyAllowAllBuilds / strictDepBuilds / verifyDepsBeforeRun）按 pnpm.io/settings 的说明都从 pnpm-workspace.yaml 或全局 config.yaml 读取，该页没有 allowScripts 这个键；pnpm 也不从 package.json 读 workspace 配置。真正的控制面是 pnpm-workspace.yaml:12-16 的 onlyBuiltDependencies——列的是同样这四个包，形成两份平行清单。实测（读本机钉住的 pnpm 10.18.0 全量 bundle pnpm.cjs，7,723,735 字节）：onlyBuiltDependencies=34、ignoredBuiltDependencies=23、dangerouslyAllowAllBuilds=3、strictDepBuilds=5、verifyDepsBeforeRun=3、ignoreScripts=74，而 **allowScripts=0、ignoreBuilds=0**；getOptionsFromRootManifest 只从 manifest.pnpm 里 pick 固定白名单，顶层 allowScripts 不在任何读取路径上，且本仓 package.json 根本没有 pnpm 键。同 bundle 另有 warnings.push('The "workspaces" field in package.json is not supported by pnpm…')，印证「pnpm 不从 package.json 读 workspace 配置」。消费方扫描：仓内没有任何工具（含 @lavamoat/allow-scripts）读它。
- **触发条件**：任何安装；以及任何人依据 package.json 判断「安装脚本已被限制在白名单内」。
- **复现步骤**：读 package.json:384-389 与 pnpm-workspace.yaml:12-16；本机 pnpm bundle 源码逐键计数与函数体分析。
- **实际影响**：安全相关的允许清单看起来有两道，实际只有 pnpm-workspace.yaml 那道生效；改 package.json 的那份不会产生任何效果，也不会报错。
- **根本原因**：把 npm/@lavamoat 时代的 allowScripts 形态照搬进了 pnpm 仓库（归因无法由本仓 git 史证明——allowScripts 与 pnpm-workspace.yaml 在同一笔入库提交 692e714e 里同时出现；但版本钉死键形态确为 lavamoat allow-scripts 语法）。
- **修复建议**：删除 package.json:384-389 的 allowScripts 块，只保留 pnpm-workspace.yaml 的 onlyBuiltDependencies；若要可读性，在注释里指向后者。
- **建议测试**：加一条守卫：package.json 中不得出现 pnpm 不认识的构建类配置键（白名单：pnpm.onlyBuiltDependencies 等）。
- **是否已确认**：已确认（读码 + 本机 pnpm bundle 实证；未跑 pnpm config 命令与 fetch pnpm.io/settings——遵守禁网约束，改用本机钉住的 pnpm 源码核对，证据强度等同或更高）。

#### DEP-20 ｜ 打包器双轨：manifest 里留 vercel/pkg，发布实际用 @yao-pkg/pkg，两边都不锁版本
- **风险等级**：P3
- **涉及模块**：依赖声明 / 构建工具
- **涉及文件**：`runtime/node/backend/package.json:158`
- **具体代码位置**：backend devDependencies:158 "pkg": "^5.8.1"；.github/workflows/dual-channel-release.yml:78 装 @yao-pkg/pkg@6.21.0；works/ship/build/pack-executable.js:63-71 两个名字都认
- **问题描述**：backend 的 devDependencies 声明 vercel/pkg ^5.8.1（:158，位于 devDependencies 145-162 行块内）；发布链装的是社区维护的 @yao-pkg/pkg@6.21.0（且不在任何 manifest 里，见 DEP-07）；pack-executable.js:67-72 的候选列表同时含 `node_modules/@yao-pkg/pkg/lib-es5/bin.js`（:68）与 `node_modules/pkg/lib-es5/bin.js`（:69），另有两个 legacy services/backend 变体（:70-71），最后回退全局 pkg（:79-84）。实测：`git grep -n "yao-pkg"` 全仓仅 1 命中（CI 行）；`git grep -n "\"pkg\"" -- package.json` 仅 1 命中（backend:158）；findstr 两份锁文件 ya-pkg 0 命中；pnpm-lock.yaml:424-426 backend importer `pkg: specifier ^5.8.1 / version 5.8.1`、:5884/:13951 `pkg@5.8.1`；本机 backend/node_modules/pkg 实装 5.8.1、@yao-pkg 目录不存在。**订正**：标题「两边都不锁版本」措辞偏松——manifest 侧其实被 pnpm-lock.yaml 钉在 5.8.1；未锁的是 CI 侧（--no-save，6.21.0 只活在 workflow 文本里）。
- **触发条件**：任何本机跑 pack-executable.js 与任何 tag 发布（git grep pack-executable → 仅 dual-channel-release.yml:98 调用，该 workflow 由 v* tag 触发）。
- **复现步骤**：读 runtime/node/backend/package.json:158、dual-channel-release.yml:78、works/ship/build/pack-executable.js:66-78。
- **实际影响**：manifest 里的版本与发布实际用的版本分家，两边漂移都不会让任何东西变红；本机与 CI 可能解析到不同的打包器。附带发现（与本 finding 正交）：pack-executable.js:19 读 works/packaging/modules/modules.json，该路径在磁盘与 git 均不存在，脚本会在第 24 行 ENOENT 早于 pkg 解析失败（见 DEP-08）。
- **根本原因**：vercel/pkg 停止维护后迁到 @yao-pkg/pkg 时只改了 CI 的临时安装行，没清 manifest 也没回写声明。
- **修复建议**：把 @yao-pkg/pkg 正式声明（与 DEP-07 同一个修复），从 backend devDependencies 删除 pkg。
- **建议测试**：加一条守卫：pack-executable.js 解析到的打包器名必须在某个 manifest 的 devDependencies 里声明。
- **是否已确认**：已确认（三条引用逐字核对 + 只读命令补证）。

#### DEP-21 ｜ 多个已停止前进的大版本依赖留在发货树里（chalk 4 / moment / inquirer 8）
- **风险等级**：P3
- **涉及模块**：依赖声明 / 维护状态
- **涉及文件**：`runtime/node/backend/package.json:109`
- **具体代码位置**：package.json:109 chalk ^4.1.2（锁定 4.1.2）；:126 moment ^2.30.1（锁定 2.30.1）；:120 inquirer ^8.2.7（锁定 8.2.7）
- **问题描述**：对 registry.npmjs.org 的 /latest 实测（题目材料）：chalk 最新 6.0.1（声明值落后两个大版本，且 chalk 5 起为 ESM-only，升级不是改一行号）；moment 最新 2.31.0，moment 项目自述处于维护模式（legacy）。inquirer 锁定在 8.2.7。这三项都不是 CVE——逐条核过 GitHub Advisory Database：chalk/moment/inquirer 均无影响这些版本的公告——报的是维护状态，不是漏洞。仓内证据：声明值与行号精确一致；pnpm-lock.yaml importer「runtime/node/backend」下 chalk 4.1.2、inquirer 8.2.7(@types/node@24.13.4)、moment 2.30.1；本地安装树复核一致；node_modules/.pnpm 目录仅 chalk@4.1.2、chalk@5.6.2、moment@2.30.1、inquirer@8.2.7；「lock 里两份 chalk」属实（pnpm-lock.yaml:3203 与 :3207，5.6.2 的消费者是 ink@6.8.0 :12410-12416 与 lint-staged :13199）；「chalk 4 停在 CJS 时代」有本地结构证据（.pnpm/chalk@5.6.2/package.json 含 "type": "module"，backend 下 chalk@4.1.2/package.json 无 type 字段），且 chalk 仍是重负载直接依赖（backend/src 下 152 处 require('chalk')）；「moment 自述 legacy」有本地原文（node_modules/moment/README.md:15）；package.json:101 注释说明 moment 是替 khyquant 代持（klineDataService.js:11 与 enhancedMockDataService.js:1 确有 require('moment')）。
- **触发条件**：需要新特性或安全补丁时；以及每次安装的体量与 ESM/CJS 混用成本。
- **复现步骤**：读三处声明与锁定值；本地安装树与 .pnpm 目录核对。
- **实际影响**：chalk 4 停在 CJS 时代，与树里另一份 chalk@5.6.2 并存，后续任何 ESM 化都会被它拖住；moment 无新功能也无补丁。
- **根本原因**：依赖只按「能跑就不动」维护，没有大版本跟进的队列。
- **修复建议**：chalk 与 inquirer 各立一次独立的升级任务（chalk 4→6 需连带处理 ESM 边界，不能塞进功能 PR）；moment 因 package.json:101 注释说明是替 khyquant 代持，升级需与 khyquant 侧协调，单独排期。升级任务各自带原有的 CLI 输出快照测试即可，不需新增回归。
- **建议测试**：升级任务各自带原有的 CLI 输出快照测试即可，不需新增回归。
- **是否已确认**：已确认（可机查的载荷全部与证据相符；未跑项：fetch registry.npmjs.org/{chalk,moment}/latest 与 GitHub Advisory「无公告」——离线约束，且非判定基础）。

#### DEP-22 ｜ test:node 的通配符没加引号，CI 比 Windows 少跑 1335 个测试文件（46%）
- **风险等级**：P2
- **涉及模块**：测试
- **涉及文件**：`runtime/node/backend/package.json:59`
- **具体代码位置**：package.json:59 "test:node": "node --test tests/**/*.test.js"（未加引号）；对照 :61 test:node:src 和根 package.json:242 test:scripts 都加了引号
- **问题描述**：未加引号时，Linux 上 npm 用 sh 执行脚本，shell 先展开 glob；sh 不开 globstar，`tests/**/*.test.js` 等价于 `tests/*/*.test.js`（只穿透一层目录）。Windows 上 cmd 不做 glob，模式原样交给 Node，Node 的 `**` 是递归的。实测清点：tests/ 下递归共 2902 个 *.test.js；按 `tests/<一层目录>/<文件>.test.js` 计只有 1567 个。差值 1335 个文件（46.0%）在 CI 上根本不执行。deploy-staging.yml:96-99 的注释已经点明这个差异（当时记的是 1288 vs 705），但两边数字至今没人对齐。
- **触发条件**：CI（ubuntu + sh）跑 npm run test:node；本地 Windows 跑同一条命令。
- **复现步骤**：读 package.json:59-61 与根 package.json:242（:240 注释明写「Node 22+ 的 --test 把位置参数当 glob 而非目录，故必须写通配并加引号」）；对 tests/ 做两种模式的计数清点（2902 vs 1567）。glob 语义实证：用 Git for Windows sh.exe 在 runtime/node/backend 下执行，未加引号 `tests/**/*.test.js` 展开为 1567 个词，与显式一层模式 `tests/*/*.test.js` 的 1567 个词完全相同；加引号则原样透传。Node 递归（本地 node v22.18.0 在合成目录跑 `node --test "tests/**/*.test.js"`）→ 4/4 含三层文件；Windows/cmd 未加引号同样 4/4。npm 在 Linux 用 sh 执行：读 npm 10.9.3 源码 definitions.js，script-shell 默认 `isWindows ? ComSpec : process.env.SHELL || 'sh'`，根与 backend 的 .npmrc 均无覆盖。CI 接线：deploy-staging.yml:104、frontend-ci.yml:78、dual-channel-release.yml:74、pr-gate.yml:556（该步 continue-on-error）四个 workflow 在 ubuntu-latest 上跑 npm run test:node，前三处为阻断步。
- **实际影响**：CI 的 node:test 覆盖率读数比实际低近一半：在 CI 全绿的文件，在 Windows 上可能是红的（本次拿到的门禁证据就是 Windows 口径——`node --test runtime/node/backend/src/**/*.test.js` 实跑 7378 pass / 3 fail）；反过来，写测试的人若以 CI 为准，会以为两层以上目录里的 1335 个文件有人在跑。
- **根本原因**：脚本从 Windows 时代继承，通配符语义在两平台上不同；引号在两条同类入口上加了一条、漏了一条。
- **修复建议**：package.json:59 改成 `node --test "tests/**/*.test.js"`，与 :61 和根 :242 一致。
- **建议测试**：加一条守卫：package.json 里所有 `node --test` 入口的 glob 必须带引号（静态扫引号即可）。
- **是否已确认**：已确认（行号、数字、机制全部属实，且关键机制在本会话独立实证；附带说明：修复建议会使 CI 从 1567 跳到 2902 个文件，可能暴露既有失败——这是修复的影响面）。

#### DEP-23 ｜ conformance.yml 在 CI 里改写 pnpm-lock.yaml，且官方套件不钉版本
- **风险等级**：P3
- **涉及模块**：CI 门禁 / 供应链
- **涉及文件**：`.github/workflows/conformance.yml:77`
- **具体代码位置**："Install @modelcontextprotocol/conformance" 步：pnpm add -w --save-false @modelcontextprotocol/conformance
- **问题描述**：`--save-false` 阻止写 package.json，但 pnpm add 仍会更新 pnpm-lock.yaml（pnpm 一手文档列 `--lockfile-only` 为 "Update package.json and pnpm-lock.yaml without downloading dependencies"，pnpm issue #13526 实证 no-save 语义下锁文件仍被写）；且不带版本号，拉取的是当时最新的官方一致性套件。同文件 :82-94 的 a2a-tck 也是 `git clone --depth 1 "$A2A_TCK_REPO" .ci/a2a-tck`（:84），未钉 commit/tag，确为上游默认分支。触发条件：release published 或 push v* tag 或 workflow_dispatch（:7-11）。上传产物（:128-131）不含套件版本快照。conformance-runner.mjs:57-72,94-120 仅按 node_modules 存在性判定 available，报告字段不含套件版本——无任何版本钉扎。仓库自身规范真源 `docs/10_规范/其它规范/[DESIGN-QUAL-002] 官方一致性套件接入规范.md:75-92`（§4 步骤 A「钉版本（可复现底线）」：`npm install --save-dev --save-exact @modelcontextprotocol/conformance@0.1.16`）与 :134-138（§6「版本钉扎与可复现」：「MCP 套件用 npm install --save-exact，A2A 用 uv + 锁定 commit；升级套件是**受审变更**，不是 latest 自动副作用」）与 conformance.yml 逐条相反。
- **触发条件**：release published 或 push v* tag。
- **复现步骤**：读 conformance.yml 全文（143 行）；读根 package.json:367-376 devDependencies（无 @modelcontextprotocol/conformance）；读 conformance-runner.mjs；git grep 全仓 modelcontextprotocol 仅命中 workflow 与 runner；git ls-files 确认根 pnpm-lock.yaml 与 package-lock.json 均被 git 跟踪（CI 根目录执行 pnpm add 若写锁文件即弄脏已跟踪工作区）；.github/ 下无任何「检出须干净」断言。
- **实际影响**：同一条 commit 在不同日期跑一致性门禁，可能拿到不同版本的套件 → 结论不可复现；CI 工作区被改脏（虽不影响后续步骤，但会让任何「检出须干净」的断言误判）。
- **根本原因**：官方套件按「用时现装」接入，没有作为 devDependency 声明。
- **修复建议**：把 @modelcontextprotocol/conformance 声明为 devDependency 并随 pnpm-lock.yaml 锁定，CI 删掉 pnpm add 行。
- **建议测试**：加一条守卫：release 档 workflow 中不得出现 pnpm add / npm install --no-save（范围建议收窄到「官方一致性套件安装」——照字面执行也会命中 dual-channel-release.yml:78,159，见 DEP-07）。
- **是否已确认**：已确认（主干证据完全支持；锁文件子机制部分证实——本机无 pnpm，未实测 --save-false 是否跳过锁文件写入，该子机制只有 workflow 自身注释与 RESEARCH-005:123 的单方陈述）。

#### DEP-24 ｜ pr-gate 注释承诺的 nightly-security.yml（含 trivy 容器扫描）不存在
- **风险等级**：P3
- **涉及模块**：CI 门禁 / 文档漂移
- **涉及文件**：`.github/workflows/pr-gate.yml:704`
- **具体代码位置**：:702-705「Nightly 阶段（深度扫描，见 nightly-security.yml）：CodeQL 全量扫描 / trivy 容器扫描」；:818-819「深度扫描（CodeQL + trivy）在 nightly 构建中运行」
- **问题描述**：.github/workflows 下共 12 个文件，没有 nightly-security.yml。全仓只有 pr-gate.yml 这两处注释提到 trivy，没有任何 workflow 实际执行 trivy 或容器镜像漏洞扫描。实际存在的夜间扫描只有 codeql-analysis.yml 的每日 03:00 cron（:1-65，matrix.language [javascript, python]，两个 init 均 queries security-extended,security-and-quality）。docker.yml 确认容器镜像确实发布到 GHCR（REGISTRY: ghcr.io，push-by-digest=true,push=true）；dual-channel-release.yml:185-201 的 grype（anchore/scan-action@v7）只消费 sbom-pip.json/sbom-npm.json 两份依赖 SBOM，不涉及容器镜像。
- **触发条件**：任何人依据这两条注释判断「镜像漏洞有人 nightly 扫」。
- **复现步骤**：`dir /b .github\workflows\` → 12 个文件名，无 nightly-security.yml；git ls-files 同样返回这 12 个；`findstr /s /i /n /c:"trivy" .github\workflows\*.yml` → 仅两行命中（pr-gate.yml:704 注释与 :819 echo notice），两条都是不产生执行效果的文本；findstr aquasecurity/trivy-action/container-scan 零命中；git grep trivy 全仓其余命中全在文档/规则/检查器里（AGENTS.md:1245、RULES-REGISTRY.json:3355、[DESIGN-DELIV-001]:373、规则卡、RESEARCH-008:981/1024/1046、check-delivery-baseline.js:492），没有一条是 workflow 实现——其中 RESEARCH-008:1046「在 nightly workflow 中添加 CodeQL 和 trivy」正是这条注释的来源；findstr schedule/cron 只有 codeql-analysis.yml:8-10 有 cron。**订正**：finding 的 repro 写「全仓只有 pr-gate.yml 这两处注释提到 trivy」，严格说不准确（文档/规则/检查器里还有多处），但不改变核心事实。
- **实际影响**：容器镜像（GHCR 上发布的那份）没有任何漏洞扫描消费者；注释把不存在的能力写成了既成事实。
- **根本原因**：nightly 流水线从未创建，注释先写了。
- **修复建议**：二选一：建 nightly-security.yml（trivy 扫 GHCR 镜像 + 全量 CodeQL），或把这两处注释改成指向实际存在的 codeql-analysis.yml 并注明「容器镜像暂无扫描」。
- **建议测试**：加一条守卫：workflow 注释中引用的其它 workflow 文件名必须真实存在。
- **是否已确认**：已确认（description 的每一项都与证据相符）。

#### DEP-25 ｜ docker 镜像体积门禁的阈值是自认的占位值
- **风险等级**：P3
- **涉及模块**：CI 门禁 / 容器
- **涉及文件**：`.github/workflows/docker.yml:103`
- **具体代码位置**：:100-103 Assert image size budget 步，KHY_IMAGE_MAX_MB: ${{ vars.KHY_IMAGE_MAX_MB || '1200' }}；:95-99 的说明
- **问题描述**：该步注释自陈：「⚠ KHY_IMAGE_MAX_MB 的默认值是**占位**，不是实测值：本机没有 Docker，无法在改这条流程前量出当前体积。第一次跑完后请看本步骤 Echo 出的实测值，把它改成「略高于当前」的数」。git log 显示该步于 2026-11-02 提交引入（b9ebd41a chore(docker)）；git status --porcelain 对该文件为空，所读即 HEAD 状态。findstr 限定目录（.github/docs/scripts）KHY_IMAGE_MAX_MB 仅命中 docker.yml 的 95/103/106/112/119/123 行——仓内无任何实测值记录、也无 test 项建议的守卫。
- **触发条件**：push main/tags 触发 docker.yml。
- **复现步骤**：读 docker.yml:87-127。
- **实际影响**：门禁的阈值未经测量：若实际镜像 1400 MB，这道「体积门禁」第一次跑就红，然后最可能的动作是把预算改大——红线从「不许变大」退化成「跟着现状走」。finding 中「若实际 1400MB 则首跑即红、最可能动作是改大预算」为风险推演而非可证伪事实。
- **根本原因**：门禁先于测量落地，缺一次实测锚定。
- **修复建议**：第一次运行后把 Echo 出的实测 MB 写进默认值（或直接设 repository variable KHY_IMAGE_MAX_MB），此后只降不升。
- **建议测试**：加一条守卫：KHY_IMAGE_MAX_MB 的默认值必须来自最近一次实测（在注释里留实测日期与数值）。
- **是否已确认**：已确认（读 docker.yml:87-127；未能核查：GitHub 上 repository variable 是否已设置、docker.yml 是否已实际运行——需访问 GitHub 第三方服务，按约束未访问）。

### 3.8 发布与交付（REL，15 条）

#### REL-01 ｜ pip 渠道上传路径仍指向已迁移的 dist/，发布链在 twine 步骤必然中止
- **风险等级**：P0
- **涉及模块**：发布链 / pip 渠道
- **涉及文件**：`scripts/release/publish-dual.sh:329`
- **具体代码位置**：publish-dual.sh 第 3 步「Publishing pip」：315（dry-run twine check）、321（rehearse twine check）、326（testpypi upload）、329（正式 upload）
- **问题描述**：四处待上传产物都写 `"$ROOT_DIR"/dist/*`。而 2026-09-29 方案 R-R2 起 pip 产物改落 `entries/pip/`：`build-and-audit-pip-purity.sh:37 DIST_DIR="$ROOT_DIR/entries/pip"`、:94/:97 以 `--outdir "$DIST_DIR"` 构建；`build-pip-dist.js:64` 同常量；BUILD-OUTPUTS.json 的 pip-dist 条目 path=entries/pip、legacyPath=dist、note 明写「build-pip-dist.js / bash 孪生 / 平台 wheel 脚本 / CI 签名步全部指向 entries/pip」。dist/ 同时被 .gitignore:9 忽略，CI 干净检出里根本不存在该目录，也没有任何一步创建它。publish-dual.sh :297-302 第 2 步调 build-and-audit-pip-purity.sh 构建产物——即 twine 运行时产物在 entries/pip，不在 dist/。
- **触发条件**：推 v* tag 触发 dual-channel-release.yml，跑到 "Publish dual-channel" 步（第 22 个命名步，finding 原文写「第 15 步」有误，第 15 步是 Sign PyPI artifacts）。
- **复现步骤**：读 scripts/release/publish-dual.sh:315/321/326/329 与 build-and-audit-pip-purity.sh:37/94/97、build-pip-dist.js:64；`git check-ignore -v dist` → `.gitignore:9:dist/`；`git show --stat 1ff6d608`（迁移提交）→ 恰 15 个文件，publish-dual.sh 不在其中；`git blame -L 311,333` → 四行 dist/* 出自 acb8b0a3（2026-09-22），早于迁移、此后未动；bash 实测 `printf "arg:[%s]\n" /tmp/dist/*`（无 nullglob）→ 输出字面量 /tmp/dist/*；`dir /b dist` → 仅 android；`dir /b entries\pip` → 有 khy_os-1.2.0-py3-none-any.whl 与 khy_os-1.2.0.tar.gz（真实产物在 entries/pip）。
- **实际影响**：rehearse 的 `twine check dist/*` 收到不存在的路径 → `|| fail "pip rehearsal failed"` → exit 1，发布 job 在发包前整体中止；pip 未上传、npm 也未轮到（pip 先发），正是该脚本 160-171 行注释想防的渠道分裂态的反面（谁都发不出去）。若某台机器上留有旧 dist/（本机就有一个只含 android/ 的 dist/），twine 会把陈旧或非分发文件当产物处理。附带观察（finding 未提）：dry-run 分支 :314-316 无 `|| fail`，twine check 失败也会打印「dry run: twine check passed」假绿。
- **根本原因**：迁移提交 1ff6d608「R2 生成物出根」翻了 build-executables.yml、dual-channel-release.yml 签名步、BUILD-OUTPUTS.json、audit_pip_artifacts.py、build-and-audit-pip-purity.sh、build-pip-dist.js、build-platform-wheel.{ps1,sh} 共 15 个文件，漏掉了 publish-dual.sh 的上传路径。
- **修复建议**：把四处 `"$ROOT_DIR"/dist/*` 改为 `"$ROOT_DIR"/entries/pip/*`（或像 bash 孪生那样定义 DIST_DIR 变量共用），并在调 twine 前断言 glob 至少命中 1 个 .whl 与 1 个 .tar.gz。
- **建议测试**：在 scripts/tests/ 加静态断言：publish-dual.sh 不得出现 `dist/*` 形态的 twine 目标；或加一个跑 build:pip + publish-dual.sh --dry-run 的集成测试（未实跑——本机无任何 python 解释器，twine check 对不存在路径的退出码未实测）。
- **是否已确认**：已确认（逐条核对 finding 引用的每一处代码与命令均属实；另注意一个独立的在 HEAD/origin/main 中就存在的问题：workflow :95-98 调用的 works/ship/build/{esbuild-modules,pack-executable}.js 未被 git 跟踪（被 .gitignore:10 build/ 吞掉），干净检出会在该步先 MODULE_NOT_FOUND——这不推翻 REL-01，publish-dual.sh 同时也是文档化的手工发布入口）。

#### REL-02 ｜ Docker 镜像的 Python 启动器从不按版本钉住，与同时 COPY 进镜像的后端源码可能是两个版本
- **风险等级**：P1
- **涉及模块**：Docker 渠道
- **涉及文件**：`Dockerfile:107`
- **具体代码位置**：Dockerfile 105-111（ARG KHY_OS_VERSION="" → pip install khy-os → khy --version）、203（COPY runtime/node/backend/）；.github/workflows/docker.yml:79-81
- **问题描述**：ARG KHY_OS_VERSION 为空时执行 `pip install --no-cache-dir khy-os`，即装 PyPI 上当时最新的版本；而同一镜像又把仓库当前提交的 runtime/node/backend 源码树 COPY 进去当 HTTP 服务（Dockerfile:203，配合 :245 WORKDIR /app/runtime/node/backend 与 :269 CMD ["node", "docker-entrypoint.js"]）。docker.yml 只在 workflow_dispatch 时才把这个 arg 设成输入值，tag 推送与 main 推送都是空 ⇒ 永远装 latest。镜像也没有 org.opencontainers.image.version label（:60-63 只有 title/description/source/licenses 四个 label）。Dockerfile:96-104 注释进一步坐实机制：pip wheel 只含 khy_platform + bundled/runtime/khy/bundle.mjs，不含后端源码；容器内 `khy` 命令恒执行 wheel 自带的 bundle.mjs。`khy --version` 报的是 PyPI 启动器版本：`cli.py:2734-2737 pkg_version = get_installed_version()` → `env["KHYQUANT_PKG_VERSION"] = pkg_version`；`bin/khy.js:709 const cliVersion = process.env.KHYQUANT_PKG_VERSION || pkg.version`。
- **触发条件**：任何一次 docker build（tag v* 或 main push 或手动 dispatch 不输 version）。
- **复现步骤**：读 Dockerfile:105-111 与 :203、docker.yml:79-81；git grep KHY_OS_VERSION 全仓仅命中 docker.yml:80、Dockerfile:105/106/109——没有任何别的地方给这个 arg 传值；git grep -rln build-push-action 命中 docker.yml 与 deploy-staging.yml，读 deploy-staging.yml:117-127 确认它用同一份 Dockerfile 且完全没有 build-args（staging 也是 latest，比 finding 描述的更普遍）；git grep version -- pyproject.toml backend/package.json → 均 1.2.2（两渠道当前同号，但 pip 侧装什么完全不受本次构建约束）。
- **实际影响**：打 tag v1.3.0 构建出的镜像，构建期就跑过一次的 `khy --version`（Dockerfile:111）可能报 1.4.x；容器里 HTTP 服务跑仓库源码、`khy` 命令跑 PyPI latest，一次发布在 pip/npm/docker 三个渠道报出不同版本。用户 `docker run khy-os:1.3.0 khy --version` 拿到的不是 1.3.0。
- **根本原因**：镜像同时混用「PyPI 安装」与「源码 COPY」两种取版本方式，却没有把任一方钉到本次构建的版本上。
- **修复建议**：docker.yml 把 KHY_OS_VERSION 设为 `${GITHUB_REF_NAME#v}`（tag 事件）或从 pyproject.toml 读；更彻底的做法是在同一 job 内先构建本地 wheel 再 `pip install ./entries/pip/*.whl`，使镜像内启动器与后端源码同源。
- **建议测试**：在 docker.yml 加一步断言：`docker run --rm <image> khy --version` 输出等于本次 tag 版本；并在 build 前断言 KHY_OS_VERSION 非空（未实测——本机无 Docker 且按约束未访问第三方服务）。
- **是否已确认**：已确认（三处引用行号与内容全部对得上 + git grep 证明无其它传参路径 + khy --version 的版本来源已沿代码验证）。

#### REL-03 ｜ npm 签名步对 `npm pack --dry-run` 打印出的文件名签名，而该文件从未被创建
- **风险等级**：P1
- **涉及模块**：发布链 / 签名
- **涉及文件**：`.github/workflows/dual-channel-release.yml:144`
- **具体代码位置**：dual-channel-release.yml 138-151 行 "Sign npm package contents (sigstore)"
- **问题描述**：`PACK_TARBALL=$(cd works/ship/npm && npm pack --dry-run 2>/dev/null | tail -1)` 取到的是一个裸文件名（scoped 包形如 @khy-os/khy-os-1.2.2.tgz）；`--dry-run` 不把 tarball 写到磁盘，且子 shell 的 cd 不影响父 shell，随后 `sigstore sign --yes "$PACK_TARBALL"` 在仓库根解析这个既不完整也不存在的路径。前一行 143 的 `( cd works/ship/npm && npm pack --dry-run > /dev/null 2>&1 )` 是无效果的预热（实跑证明它会跑 prepack——即执行 assemble + audit:purity 并写出 bundled/，属冗余而非零副作用）。该 step 未设 working-directory，故 cwd = GITHUB_WORKSPACE。:79 pip install 装了 sigstore CLI，所以 150 行会真的被执行。works/ship/npm/package.json：name @khy-os/khy-os、version 1.2.2、prepack "npm run assemble && npm run audit:purity"（真实 tarball 由 :348 的 npm publish 自己生成，且在签名之后才跑）。Release 资产只上传 publish/payloads/*（:223-234），npm 包本身不带签名。
- **触发条件**：tag v* 发布跑到 "Sign npm package contents (sigstore)" 步（:3-6 push tags v*，:139 if: inputs.skip_npm != 'true' 默认 false）。
- **复现步骤**：本机实测（npm 10.9.3，临时 dummy 包，git-bash 按 workflow 143-150 行原样执行）：step line 143 exit=0，目录里只有 index.js/package.json/prepack-ran.txt；step line 144 → PACK_TARBALL=[khy-os-dummy-pack-test-9.9.9.tgz]，ls 报 cannot access，文件在仓库根与 works/ship/npm 均 MISSING；三次 --dry-run 后沙箱内无任何 .tgz。另确认根 .npmrc 与 works/ship/npm/ 下均无 .npmrc，不存在 pack-destination 改写；git ls-files | grep .tgz 仅一个 3 字节占位文件（版本 1.2.3 ≠ 1.2.2，路径也不同）。
- **实际影响**：`sigstore sign` 因文件不存在失败 → 该 step 非零 → 发布 job 在发包前中止（签名步在 "Publish dual-channel" 之前，无 continue-on-error）。即便成功，.sig 也只留在 CI workspace，用户无从校验。**订正**：npm 会剥掉 scope，实测文件名形如 khy-os-dummy-pack-test-9.9.9.tgz，故真实值是 khy-os-1.2.2.tgz，而非 description 写的 @khy-os/khy-os-1.2.2.tgz（「裸文件名、非路径」这一实质成立）。
- **根本原因**：把 `--dry-run` 的报告输出当成了产物路径；且签名产物没有出口。
- **修复建议**：用不带 --dry-run 的 `npm pack --pack-destination <tmpdir>` 产出真实 tarball 再签，并把 .sig 一并上传到 GitHub Release 资产（或作为 provenance attestation 推送）。
- **建议测试**：加 `test -f "$PACK_TARBALL"` 前置断言；发布后断言 Release 资产列表包含该 .sig（未运行 sigstore sign 与真实 workflow——本机未安装 sigstore，且不得安装依赖）。
- **是否已确认**：已确认（读 138-151 行 + 原样重放 143-150 行双双支持 description 的每一个实质论点）。

#### REL-04 ｜ 黄金路径的 pypi 分支仍在读 dist/，D9 永远不可能 PASS，且它提示的补救命令本身也写去 entries/pip
- **风险等级**：P1
- **涉及模块**：交付基线 / 黄金路径
- **涉及文件**：`scripts/ci/check-golden-path.js:158`
- **具体代码位置**：check-golden-path.js 156-179（newestWheel 扫 path.join(ROOT,'dist')）、231-236（SKIP 理由让用户跑 npm run build:pip）
- **问题描述**：newestWheel() 在 dist/ 下找非空 .whl；而 build:pip 的产物在 entries/pip/（build-pip-dist.js:64）。SKIP 文案写「先跑：npm run build:pip」，跑完产物仍不在它看的目录里 ⇒ 该渠道永久 SKIP，退出码 0。
- **触发条件**：每次 `npm run check:golden-path` / release-gate 的 golden-path 阶段。
- **复现步骤**：读 check-golden-path.js:157-179 与 :233-236；本机实测 `node scripts/ci/check-golden-path.js --only pypi --json` → status=SKIP（本机无 python：python/python3 退出码 9009、py ENOENT），即使补上 python 也会因 dist/ 无 wheel 而 SKIP。
- **实际影响**：D9「从零到可运行」这条向外的表针在本仓永远读作「未验证」，而记分板仍显示 D9 PASS——check-delivery-baseline.js 只检查该脚本存在且被门引用（实测输出 D9 PASS: "黄金路径检查存在且已被门引用"），不检查它能不能真的验。
- **根本原因**：同 REL-01 的迁移漏改：check-golden-path.js 不在 1ff6d608 的 15 个文件里。
- **修复建议**：newestWheel() 改扫 entries/pip（可保留 dist 作兼容回退，并打印实际读了哪个目录）。
- **建议测试**：造一个含非空 .whl 的 entries/pip fixture，用 KHY_GOLDEN_ROOT 指过去，断言 verifyPypi 不再因「找不到 wheel」SKIP。
- **是否已确认**：已确认（脚本门禁：node scripts/ci/check-golden-path.js --only pypi --json）。

#### REL-05 ｜ 自动 DB 迁移的版本锚点是仓库相对路径，在 pip/npm 两个打包安装里恒为 0.0.0，升级迁移静默不跑
- **风险等级**：P1
- **涉及模块**：运行时 / 数据库迁移
- **涉及文件**：`runtime/node/backend/src/bootstrap/dbAutoMigration.js:36`
- **具体代码位置**：dbAutoMigration.js 34-42（resolveCurrentVersion）、117（shouldRun 判据）；调用方 server.js:977-978、src/bootstrap/setup.js:72-79
- **问题描述**：resolveCurrentVersion() 用 `path.resolve(__dirname, '../../package.json')` 读 backend/package.json 的 version。该表达式在 bundle.mjs 里被原样保留（本机在 `runtime/substrate/platform/khy_platform/bundled/runtime/khy/bundle.mjs` 中核到 `HLe.resolve(__dirname,"../../package.json")`；npm 侧 `works/ship/npm/bundled/runtime/khy/bundle.mjs:9438` 同样保留）。pip 安装布局是 site-packages/khy_platform/bundled/runtime/khy/bundle.mjs，而 pyproject.toml:33 只打包 bundled/runtime/khy/bundle.mjs；npm 布局是 node_modules/@khy-os/khy-os/bundled/runtime/khy/bundle.mjs，而 works/ship/npm/package.json:9-14 的 files 只有 bin/、bundled/、scripts/postinstall-compress.js。两种布局下 ../../package.json = <...>/bundled/package.json 都不存在 ⇒ catch ⇒ process.env.npm_package_version（未设，git grep 确认零注入）⇒ '0.0.0'。compareVersions 两个操作数都 parseInt||0（:16-32），故 compareVersions('0.0.0', x) > 0 恒为 false。KHY_AUTO_DB_MIGRATE 默认 true、KHY_AUTO_DB_MIGRATE_ALWAYS 默认 false（:106-108）；跳过时返回 {ran:false, skipped:true, reason:'up-to-date'} 不打任何 warn（:119-127）。影响链：`scripts/seed.js:48-55 ensureColumn()` → `ALTER TABLE ... ADD COLUMN`；数据家是 ~/.khyquant / ~/.khy（utils/dataHome.js:148-150/:375-443，安装目录外、升级后仍在），状态文件也落在这里 ⇒「老库升级」场景真实存在。
- **触发条件**：pip 或 npm 安装后启动。**订正**：finding 原 trigger 列「server.js:977-978 或 khyquant 模式下 bootstrap/setup.js:75」，实测两个 bundle 内**不含** server.js 启动段（检索 init:dbMigration failed / Database connected / _bootDbConnected 均 0 命中），pip/npm 渠道内实际可达的是 cli-bootstrap（src/cli/bootstrap.js:85-86）与 setup-khyquant（src/bootstrap/setup.js:75）——两个 bundle 里各 1 处命中，且共用同一个坏掉的 resolveCurrentVersion。
- **复现步骤**：读 dbAutoMigration.js:34-42/117；对 pip 实包 bundle.mjs 做字符串检索（命中与预断逐字相符）；列目录 khy_platform/bundled -Recurse → 只有 runtime/khy/bundle.mjs、runtime/.env、logs/——无任何 package.json；git ls-files works/ship/npm/bundled → 只有 bundle.mjs；实测复现（三种布局求值）：source-checkout currentVersion=1.2.2 shouldRun=true；pip wheel layout currentVersion=0.0.0 shouldRun=false；npm install layout 同。Docker 侧不受影响（根 Dockerfile:162+:203 COPY runtime/node/backend/ 全树进 /app，相对路径可解析）。
- **实际影响**：compareVersions('0.0.0', lastMigratedVersion) > 0 恒为 false ⇒ shouldRun=false ⇒ ensureColumn / ALTER TABLE ADD COLUMN 在 pip/npm 渠道永不执行。老库升级后缺新列，而返回状态是 skipped:'up-to-date'，没有任何告警——「升级路径」在这两个离机渠道实际是断的。
- **根本原因**：版本锚点选了「源码树相对路径」，但两个离机渠道发出去的是单文件 bundle，没有那份 package.json；assemble 时也没有把版本注入进去。
- **修复建议**：assemble 时把版本写进 bundle 可读的位置（生成 version.json 一并装配，或由 Python 启动器设 KHY_APP_VERSION 环境变量），resolveCurrentVersion 依次读 env → 装配的 version.json → 现有相对路径。
- **建议测试**：对 bundle 做静态断言（dbAutoMigration 段不得出现 `../../package.json`）；或加一个用假 bundle 目录结构跑 runAutoDbMigration 的单测（现有 tests/dbAutoMigration.test.js 只有 disabled 与 force:true 两条，都不走版本比较分支）。
- **是否已确认**：已确认（机制、路径推导、影响全部成立；未真正 pip install/npm install 到干净环境做端到端启动——环境不允许装依赖）。

#### REL-06 ｜ 发布门的 must 阶段 `khy doctor --check` 需要 khy CLI 在 PATH 上，而 dual-channel-release.yml 从未安装它
- **风险等级**：P1
- **涉及模块**：发布链 / release-gate
- **涉及文件**：`scripts/release/lib/releaseGateStages.js:105`
- **具体代码位置**：releaseGateStages.js 99-106（doctor-preflight，tier=must，command='khy doctor --check'）；release-gate.js:59-82；dual-channel-release.yml:61-93
- **问题描述**：release-gate.js 用 execSync 直接跑 `khy doctor --check`，命令失败即 status=fail（release-gate.js:71-79，ENOENT 时 err.status 非数字 ⇒ code=1）。dual-channel-release.yml 只做 `npm run install:core`（corepack pnpm 的 filter 安装，见根 package.json:216），没有任何一步把 khy 放到 PATH；根 package.json 没有 bin 字段。runtime/node/backend/package.json 虽声明 bin:khy，pnpm 只把它链到 node_modules/.bin，execSync 不会把该目录加进 PATH。computeVerdict（:303-319）：must+deterministic+fail ⇒ blockers ⇒ automatedGo=false ⇒ exit 1。实测 node_modules/.bin 有 khy/khy.CMD/khy.ps1（根）但 backend/node_modules/.bin 无 khy；workflow 里该 step 是裸 `node scripts/release/release-gate.js`（不是 npm run gate:release），npm/pnpm 的 PATH 注入机制不生效；workflow 里无任何 PATH/node_modules/.bin 注入（唯一 PATH 操作是 native-ci.yml:80 写 moon 的 bin）。
- **触发条件**：tag v* 发布跑到 "Run release gate (deterministic checks)" 步（第 12 个命名步骤，finding 原文写「第 11 步」有误）。
- **复现步骤**：读 releaseGateStages.js:98-106、release-gate.js:59-82、dual-channel-release.yml:全文；node -e 以 PATH='C:\\Windows\\System32;C:\\Windows' 跑 execSync('khy doctor --check',{cwd:repo}) → FAIL status=1；走门禁自身逻辑：selectStages('must').runnable 含 doctor-preflight（index 9），把该阶段结果设成 fail 后 computeVerdict → automatedGo=false ⇒ 退出码 1。本地对照：where khy → D:\Portable\khy-os\khy.bat、D:\Portable\bin\khy.cmd（本机 PATH 上有 khy），execSync('khy doctor --check') → EXIT_0（finding 的 repro 写「本机 where khy 同样找不到」与本机实测相反，这反而更直接支撑 impact）。
- **实际影响**：干净 runner 上该 must 阶段必 fail ⇒ automatedGo=false ⇒ exit 1 ⇒ 发布 job 在第 12 步就红，后面的构建/签名/SBOM/发包全部不执行。维护者本机（全局装了 khy）却能跑过——同一份门禁两种读数，CI 读数恒为 NO-GO。
- **根本原因**：release-gate 设计成本地工具（假设机器上已装 khy），却被原样接进了不安装 khy 的 CI。
- **修复建议**：CI 在跑 release-gate 前把刚构建的 wheel 装进临时 venv（或把该阶段命令改成不依赖 PATH 的等价形式，如 `node runtime/node/backend/bin/khy.js doctor --check`）。
- **建议测试**：在 CI 加一步 `command -v khy` 前置断言；或给 releaseGateStages 加单测：命令不可执行时必须记 fail 而不是静默 pass（未在真实 runner 上跑该 workflow；未跑完整 release-gate.js——15+ 个重阶段、单阶段上限 30min）。
- **是否已确认**：已确认（description 的每一处代码引用都与实际行号一致，机制复现成功，影响链由门禁自身纯函数验证）。

#### REL-07 ｜ 交付渠道机器可读真源仍写方案 P 之前的路径，D2 因此永远 GAP，五个渠道 manifest 指向不存在的文件
- **风险等级**：P2
- **涉及模块**：交付基线 / 渠道声明
- **涉及文件**：`docs/10_规范/其它规范/[DESIGN-DELIV-002] 产品任务面与交付律.md:248`
- **具体代码位置**：该文档 213-248 行的 khy-delivery-surface/1 JSON 块（236 npm、238 electron、239 android、240 nsis、241 portable、248 artifactRoot）；:92 与 :126 的正文表格同样写过时路径
- **问题描述**：channels 里 npm=packaging/npm/package.json、nsis=packaging/installer/khyos_setup.nsi、portable=packaging/modules/modules.json、android=apps/khy-os-client-app/pubspec.yaml、electron=electron/main.js 全是搬迁前路径；artifactRoot.path 仍是 dist。check-delivery-baseline.js 只读 artifactRoot（349-386 行），完全不校验 channels[].manifest 是否存在（全文无 manifest 读取）。
- **触发条件**：`npm run check:delivery` / release-gate 的 delivery-baseline 阶段。
- **复现步骤**：本机实测 `node scripts/ci/check-delivery-baseline.js --json` → D2 status=GAP detail="dist/ 缺 wheel,sdist"；读 check-delivery-baseline.js:349-386 与文档 235-248 行。
- **实际影响**：「发布物真实存在」这条向外的表针看的目录不再接收产物 ⇒ 永远红着，然后被当成常态忽略；5 个渠道 manifest 是无人校验的死指针，写错了没有任何守卫会报。
- **根本原因**：同一轮迁移（1ff6d608）没有更新 DESIGN-DELIV-002 的 JSON 块，而守卫又不读 manifest 字段，两边都沉默。
- **修复建议**：把 JSON 块按现路径更新（npm→works/ship/npm/package.json、nsis→works/ship/installer/khyos_setup.nsi、portable→works/ship/modules/modules.json、android→delivery/mobile/khy-os-client-app/pubspec.yaml、electron→apps/khyos-desktop/package.json、artifactRoot→entries/pip），并让 check-delivery-baseline.js 断言每个 manifest 路径存在。
- **建议测试**：给 check-delivery-baseline 加 fixture：把某个 manifest 改成不存在的路径，断言报 finding。
- **是否已确认**：已确认（脚本门禁：node scripts/ci/check-delivery-baseline.js --json）。

#### REL-08 ｜ check:pip-packaging 仍传 --dist-dir dist，发布门的 pip 纯度阶段每次必红然后被降级成 WARN
- **风险等级**：P2
- **涉及模块**：发布链 / 发布门禁
- **涉及文件**：`package.json:140`
- **具体代码位置**：package.json:140；audit_pip_artifacts.py:249/253-254；releaseGateStages.js:135-140
- **问题描述**：`check:pip-packaging = node scripts/ci/run-python.js scripts/release/audit_pip_artifacts.py --dist-dir dist`，而 audit_pip_artifacts.py 自己的 argparse 默认值已是 entries/pip（:249，help 明写 [LAYOUT-005] single root），目录不存在即 _fail（:253-254）。该阶段在 releaseGateStages.js:135-140 是 tier=recommended ⇒ 失败只记 WARN，不翻转 automatedGo（computeVerdict :303-319 只取 tier==='must' && kind==='deterministic' && status==='fail' 作 blockers；release-gate.js:143 process.exit(verdict.automatedGo?0:1)）。
- **触发条件**：release-gate --tier=all / npm run check:pip-packaging。
- **复现步骤**：读 package.json:140、audit_pip_artifacts.py:249/253-254、releaseGateStages.js:134-140；run-python.js:28-30 原样透传参数并如实上传退出码；`dir dist` → 只有 android 子目录（无 .tar.gz、无 .whl）；`git check-ignore -v dist` → .gitignore:9（CI 干净检出 ⇒ Distribution directory not found）；git grep dist-dir 确认 package.json:140 是全仓唯一给该脚本传 --dist-dir dist 的地方（build-pip-dist.js:202 与 build-and-audit-pip-purity.sh:37/113 都显式传 entries/pip）；findstr release-gate → dual-channel-release.yml:91 发布门确实在 CI 链上。
- **实际影响**：一条恒红的 recommended 阶段，正是本仓自己批判的「非阻塞退化为永久忽略」形态；pip 产物纯度在发布门里实际没有被验过。**范围修正**：release-gate.js:31 默认 tier='must'，:269-275 selectStages 在 must 档不收 recommended 阶段，而 CI 跑的是无参默认档 ⇒ 默认 CI 路径下该阶段根本不运行——只有 --tier=all 才跑它、才恒红降级 WARN（finding 的 trigger 本身就写的是 --tier=all，在其自述范围内成立；但影响面更强：默认发布门里 pip 纯度一次都没被验过）。
- **根本原因**：迁移时改了审计脚本的默认值，却没改 package.json 里显式传的旧参数。
- **修复建议**：删掉 `--dist-dir dist`，用脚本默认值（或显式写 entries/pip）。
- **建议测试**：在 scripts/tests 中断言 package.json 的 check:pip-packaging 不含 `--dist-dir dist`（未实跑审计脚本——本环境没有 Python）。
- **是否已确认**：已确认（file 指向、行号、语义、失败路径、降级行为、rootCause 全部有证据支持）。

#### REL-09 ｜ pip 与 npm 两个渠道的 bundled 运行时副本已漂移 1.8MB/6 周，且只有一个被 git 跟踪，无守卫校验两者一致
- **风险等级**：P2
- **涉及模块**：渠道一致性 / 打包产物
- **涉及文件**：`works/ship/npm/bundled/runtime/khy/bundle.mjs`
- **具体代码位置**：works/ship/npm/bundled/runtime/khy/bundle.mjs 与 runtime/substrate/platform/khy_platform/bundled/runtime/khy/bundle.mjs；.gitignore:337；works/ship/npm/scripts/assemble.js:24-45；scripts/release/assemble-pip-runtime.js:21-38
- **问题描述**：实测 npm 侧 19,708,445 字节 / mtime 2026-11-04T15:21:58Z / sha256 b881fbdc09ba5f9d，pip 侧 17,881,192 字节 / mtime 2026-09-30T04:15:22Z / sha256 50f362d2dcae3ee1——与 description 逐位一致，差 1,827,253 字节（≈1.8MB）。npm 侧被 git 跟踪（git ls-files --error-unmatch 命中；git ls-files works/ship/npm/bundled/ 只列出这一个文件），pip 侧被 .gitignore:337 忽略（git check-ignore -v 命中；npm 侧同命令 exit 1 不被忽略）。两者都由各自渠道的 assemble 在发布时从同一个 entries/executables/modules/khy/bundle.mjs 重新生成（assemble.js:24-32 与 assemble-pip-runtime.js:21-25 跑同一条 `--module khy --prod`；两份 assemble 都 require 同一份 scripts/release/lib/runtimeStaging.js，注释明写「与 pip/npm 通道共用一份实现」）。publish-dual.sh:103-104/:122-123/:144 确认 --skip-pip/--skip-npm 真实存在（两者同给直接 fail）。
- **触发条件**：任一次只跑一个渠道的发布（publish-dual.sh 自带 --skip-pip / --skip-npm），或有人用 --ignore-scripts 打包 npm 包（该 trigger 是假设性风险场景——仓内现存 --ignore-scripts 用法都是 npm install，没有 npm pack/publish --ignore-scripts 的现成代码路径）。
- **复现步骤**：本机实测两个 bundle 的 size/mtime/sha256（见上）；git ls-files 与 git check-ignore -v 分别确认跟踪/忽略状态。
- **实际影响**：同一版本的两个渠道发布物在字节层面没有共同真源校验：一旦只发一个渠道或跳过脚本打包，pip 与 npm 就会发出不同的运行时，而没有任何守卫会报。另有一个 19.7MB 的生成物长期躺在 git 历史里（riskHints 亦记录它为最大跟踪文件）——**订正**：可追溯的已提交 blob 实为 17,630,760 字节（17.63MB），自 2026-10-04（bc43302f）起在树上；19,708,445 字节的内容在工作区，且在本地对象库中是一个不可达 blob。git log --follow 只有一笔提交，而 git status 对该路径返回 ` M`——实际存在三个互不相同的版本，git 跟踪的那份停在 10-04、比两个工作区副本都旧。两个 bundled 目录都未登记进 BUILD-OUTPUTS.json。
- **根本原因**：两个渠道各自持有同一构建产物的一份缓存副本，只有一个纳入版本控制，也没有「两侧一致」的断言。.gitignore:143-149 自己写明了意图（「可再生构建产物：committed 副本一律由源码重建，不进 git」），但 :149 那条是方案 P 搬家前的旧路径 packaging/npm/bundled/，root 锚定罩不住搬家后的 works/ship/npm/bundled/——这正是 npm 侧生成物被 git 收进去的直接原因。
- **修复建议**：把 works/ship/npm/bundled/ 一并纳入 .gitignore（与 pip 侧对齐，它是 LAYOUT-005 构建产物），并在 assemble 后加一步断言两个渠道的 bundle sha256 相同。
- **建议测试**：加一个 check：两个 bundle 都存在时 sha256 必须相等（assemble 之后跑）——「无守卫校验两者一致」经枚举证实：把 scripts/、works/ship/、runtime/substrate/platform/ 全树扫过两种路径模式，命中处（check-golden-path.js:425 只判存在、bundleLaunchContract.js:55-65 只钉路径字面量、check-docker-context.js:88 排除清单、pipSdistAllowlist.test.js:94 单测）均不做字节比对。
- **是否已确认**：已确认（finding 引用的每一项事实都复现，且还找到了它没提的更强证据）。

#### REL-10 ｜ 没有任何守卫校验「tag 与 pyproject 版本相等」，而 CI 的 tag 触发发布不传 --tag，发出去的版本在 git 里没有对应提交
- **风险等级**：P2
- **涉及模块**：渠道一致性 / 版本与 tag
- **涉及文件**：`.github/workflows/dual-channel-release.yml:215`
- **具体代码位置**：dual-channel-release.yml 203-216（--tag --push 仅在 workflow_dispatch 时追加）；publish-dual.sh:279-285、312-351、354-370
- **问题描述**：publish-dual.sh 只在 workflow_dispatch 时才收 `--tag --push -y`（215 行）。tag 推送触发时，脚本把 pyproject.toml（269-277）、works/ship/npm/package.json（284）、runtime/node/backend/package.json（285）就地 bump 成 tag 版本、构建并发布，但不 commit、不打 tag（DO_TAG 默认 '0'，:78；:354-370 的 commit/tag 块整体不进；:207-209 唯一的 tag 相关 git 检查位于 DO_TAG=='1' 分支内）。AGENTS.md 把「tag 与 pyproject.toml 版本相等」列为四条硬阻断之一，但 scripts/ 与 .github/ 里没有任何一步做这个比对（git grep GITHUB_REF 只命中 publish-dual.sh:207 的「tag 已存在」检查与 .github/workflows 里从 tag 推导 VERSION 的用法，无比对；release-gate.js/check-version-sync.js/changelog-new.js 无 git tag 逻辑）。
- **触发条件**：在一个未同步 bump 版本的提交上推 v* tag。
- **复现步骤**：读 dual-channel-release.yml:203-216（:81-82 的 Verify version sync 跑 check-version-sync.js，不接收任何 tag 输入）；读 publish-dual.sh:279-285/354-370；git grep GITHUB_REF 全仓；跑 node scripts/ci/check-version-sync.js → 1.2.2 / 1.6.5 / 0.1.0，All version sync checks passed（该脚本无 tag 感知）。
- **实际影响**：PyPI/npm 会发出 tag 声明的 X.Y.Z，而 git 里该 tag 指向的提交仍声明旧版本；main 上随后跑 check-version-sync 依旧全绿（10 源一致地指向旧号）——仓库与注册表版本分叉且无守卫变红。
- **根本原因**：发布脚本把「bump 版本」放在发布中途做，而 tag 已由人事先推好；两边之间缺少相等性断言。
- **修复建议**：在 dual-channel-release.yml 的发布步前加一步：tag 去掉 v 前缀后必须等于 pyproject.toml 的 [project] version，不等即 fail；或让 tag 触发也走 --tag 并在发布前校验 tag==pyproject。
- **建议测试**：加 CI 步 + 一个用 fixture 仓库（tag 与 pyproject 不一致）跑该断言的单测。**订正**：repro 称 git grep GITHUB_REF「仅 publish-dual.sh:207 一处」，实际 GITHUB_REF 在 scripts/ 零命中、命中全在 .github/workflows/；但 publish-dual.sh:207 确为全仓唯一 tag 相关 git 检查，实质论点成立。
- **是否已确认**：已确认（读 workflow 全文 + publish-dual.sh 关键段 + git grep + 实跑 version-sync）。

#### REL-11 ｜ Alpine ISO 构建脚本的安装源全是方案 P 之前的路径，该安装渠道做不出来
- **风险等级**：P2
- **涉及模块**：安装渠道 / Alpine ISO
- **涉及文件**：`delivery/extension/scripts/khy-alpine-iso/build-khy-os-iso.sh:205`
- **具体代码位置**：build-khy-os-iso.sh 192-214（三处 rsync 源）、配套 rootfs/etc/init.d/khy-os-backend:7 与 khy-os-console:7
- **问题描述**：`rsync "${ROOT_DIR}/backend/" "${KHY_DEST}/backend/"`（:205）、`"${ROOT_DIR}/packages/shared/"`（:209-210）、`"${ROOT_DIR}/khy_quant/"`（:213，带 `2>/dev/null || true` 吞错）三个源在本仓都不存在（实测仓库根与按脚本自身 ROOT_DIR 算法解析出的 delivery/extension 下均无 backend/packages/khy_quant；现行位置是 runtime/node/backend 与 runtime/substrate/platform/packages/shared）。OpenRC 服务指向 /opt/khy-os/backend/bin/khy-os-init.js（rootfs/etc/init.d/khy-os-backend:7、khy-os-console:7），同样不在新布局里（该文件实际在 runtime/node/backend/bin/）。:40 ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)" 解析为 delivery/extension（脚本实际住在 delivery/extension/scripts/khy-alpine-iso/，`../..` 只到 delivery/extension）——ROOT_DIR 深度本身也是错的，:243/:244/:248/:251 的 rootfs 拷贝、:214/:217 的 pyproject/package.json 拷贝同样落空；Dockerfile.iso-builder:26 的 entrypoint 写死 /src/extensions/scripts/khy-alpine-iso/build-khy-os-iso.sh（不存在）；build-iso-docker.sh:23 同样的 ROOT_DIR bug。
- **触发条件**：运行 build-khy-os-iso.sh 构建 ISO。
- **复现步骤**：读 build-khy-os-iso.sh:188/205/210/213 与 rootfs/etc/init.d/khy-os-backend:7；实测仓库根与 delivery/extension 下三个源均不存在；git ls-files | findstr khy_quant → 全仓无任何 khy_quant 路径的受跟踪文件（只有 ISO 目录里两处文本引用）；git grep khy-alpine-iso → docs 与 scripts 有提及，.github 零命中；DESIGN-DELIV-002 §channels（:233-242）只登记七项无 alpine-iso。
- **实际影响**：该渠道构建到 Step 3 就缺全部应用文件，做出来的 ISO 起不来；init.d 服务路径是死的。它未登记进 DESIGN-DELIV-002 的 channels{}、也没有 CI（属实验性渠道），所以坏了没人知道。**订正**：脚本有 `set -euo pipefail`（:21）且第一处 rsync（:205）没有 `|| true`，rsync 遇不存在的源会以非零退出，所以构建实际上在 Step 3 直接中止、根本产不出 ISO（比 finding 说的「缺文件但出 ISO」更严重）。
- **根本原因**：方案 P 目录迁移没有覆盖这个 ISO 构建脚本。**订正**：「它不在迁移提交的 15 个文件里」与实测不符——该脚本就在迁移提交 7bfc49d9（831 files changed）里并被部分更新（只把 rootfs 拷贝的 extensions/→delivery/extension/，没动三处 rsync 源）；「15 个文件」这一数字无法从证据复现。实质结论（迁移漏了 rsync 源）仍成立。
- **修复建议**：把三处 rsync 源与 init.d 的 command_args 改到 runtime/node/backend、runtime/substrate/platform/packages/shared 与新布局下 Python 启动器的位置（并修 ROOT_DIR 深度）。
- **建议测试**：给 build 脚本加前置断言：每个 rsync 源目录必须存在，缺一个即 exit 1（替换掉 `2>/dev/null || true`）（未运行 build-khy-os-iso.sh 本身——需 root/chroot/grub-mkrescue 且要下载 Alpine minirootfs，属不可执行项）。
- **是否已确认**：已确认（三处 rsync 源指向方案 P 之前路径、吞错写法、init.d 死路径、渠道未登记且无 CI 全部核实）。

#### REL-12 ｜ sigstore 签名既不被分发也不被校验，pip 侧「签名随 PyPI 上传」的注释没有实现
- **风险等级**：P2
- **涉及模块**：发布链 / 签名与校验和
- **涉及文件**：`.github/workflows/dual-channel-release.yml:122`
- **具体代码位置**：dual-channel-release.yml 118-136（pip 签名，.sig 落 entries/pip/）、138-151（npm 签名）、223-234（Release 资产只含 publish/payloads/*）
- **问题描述**：注释 122-123 行称「The signature .sig files are attached to the PyPI upload as provenance metadata and can be verified offline」，但上传步只 `gh release upload "$TAG" publish/payloads/* --clobber`（:234），没有任何一步上传 .sig，也没有任何一步跑 sigstore verify（`git grep -rn "sigstore verify"` 全仓返回空；git grep sigstore -- .github 只命中 :24 OIDC 权限、:79 pip install、:118/:121/:128、:138/:150——只有 sign、没有 verify）。npm 侧签名同样只留在 CI workspace。另一方面 twine 只接受分发扩展名，`twine upload entries/pip/*`（REL-01 修好后的形态）还会把 .sig 一起扫进去（未实测——本机无 twine，该句针对 REL-01 修好后的假设形态）。现有代码 publish-dual.sh:326/329 是 `twine upload "$ROOT_DIR"/dist/*`，同样无 --attestations、无 .sig 处理；git grep attestation/provenance -- .github/ scripts/release/ 显示发布链零 attestation 步（docker.yml:217-218 的 provenance attestation 只覆盖 GHCR 镜像）。顺带核对：「SBOM 有 grype 消费」成立（:185-201 两步 anchore/scan-action@v7 带 fail-build: true）；「校验和只有 update-index 里的 sha256 一条路」略有低估（build-payload-assets.js:29-38 也逐产物算 sha256 写进 payload manifest）。
- **触发条件**：任一次发布。
- **复现步骤**：读 dual-channel-release.yml:118-151 与 :223-234；git grep 三组（.sig / sigstore verify / sigstore）；读 build-payload-assets.js:33-38,83-89（payload 只拷 source-snapshot.json 与加密 tar，不含 .sig）。另实测（本机 npm 10.x，临时探针目录）`npm pack --dry-run` 只打印 filename、盘上不写 tarball——workflow:143-150 拿到的是不存在的裸文件名，`sigstore sign` 签的是空文件（此为复核中额外实测，作旁证，见 REL-03）。
- **实际影响**：「产物已签名」没有任何消费者能验证——签了但等于没签。SBOM 有 grype 消费（D6 PASS），签名没有对应物。另：签名步签的是 entries/pip/*.whl|*.tar.gz（:125），而 publish-dual.sh:326/329 上传 dist/*——今天签的文件与真正上传的文件并非同一批。
- **根本原因**：签名被当成「做过」而非「可验证的交付物」，产物出口与自校验都缺失。
- **修复建议**：把 .sig / provenance 一并上传到 GitHub Release 资产，并在发布链末尾加一步 `sigstore verify` 自校验（验不过即红）。
- **建议测试**：发布后断言 Release 资产列表包含每个产物的 .sig；加一步本地 verify 的 smoke（未真实触发发布工作流）。
- **是否已确认**：已确认（两个核心断言与代码逐字对上，未发现反向证据）。

#### REL-13 ｜ npm 包 files 列了一个包里不存在的压缩 helper，Linux/macOS 上文档里的压缩步骤静默空转
- **风险等级**：P3
- **涉及模块**：npm 渠道 / 安装后处理
- **涉及文件**：`works/ship/npm/package.json:13`
- **具体代码位置**：works/ship/npm/package.json:9-14（files）；works/ship/npm/scripts/postinstall-compress.js:49；works/ship/npm/scripts/assemble.js:34-45
- **问题描述**：files 含 scripts/install/enable-fs-compression.sh，但 `works/ship/npm/scripts/install/` 目录不存在（实测 dir /a /b 输出仅 assemble.js、audit-purity.js、postinstall-compress.js；git ls-files works/ship/npm 亦无 scripts/install/；真身在仓库根 scripts/install/enable-fs-compression.sh，6725 字节，assemble.js 只复制 bundle.mjs、不复制它——runtimeStaging.js:91-98 的 assembleRuntime 只 copyFileSync 调用方声明的 entries）。postinstall-compress.js:49 运行时 spawn 的正是这个不存在的 helper（`path.join(__dirname, 'install', 'enable-fs-compression.sh')`，:50 `spawnDetached('bash', [helper, ...])`），错误被 :35 child.on('error', () => {})、:37-39 try/catch、:31 stdio:'ignore' 吞掉。
- **触发条件**：Linux/macOS 上按 postinstall-compress.js:11-12 的注释手动执行该脚本（该脚本明确自称 optimization, not a requirement，未挂 install hook）。
- **复现步骤**：读 works/ship/npm/package.json:9-14；跑 dir /a /b 确认目录不存在；读 assemble.js:39-45 与 runtimeStaging.js:91-98；读 postinstall-compress.js:42-51。实跑 `npm pack --dry-run`（cwd=works/ship/npm，退出码 0，真实触发 prepack）：tarball 仅 4 个文件（bin/khy.js、bundled/runtime/khy/bundle.mjs、package.json、scripts/postinstall-compress.js）——files 声明的 .sh 静默缺失，audit:purity 仍打印「Package is complete and install-time dependency-free」。
- **实际影响**：仅影响可选的透明压缩优化，无功能损失；但 npm pack 会静默少一个 files 声明项，用户在 Linux/macOS 执行该脚本得不到任何效果也无从知道。
- **根本原因**：helper 从主仓 scripts/install/ 迁进 npm 包这一步从未做过（package.json 的 files 条目是先写的——git show 418bd209:packaging/npm/package.json 显示包创建时第 13 行已含该条目，而 git ls-tree 显示 scripts/  下只有 postinstall-compress.js，install/ 目录在包内从未存在）。
- **修复建议**：在 assemble.js 里把 scripts/install/enable-fs-compression.sh 一并复制进包（保留 files 条目），或把 package.json 的该条目与 postinstall-compress.js:49 一并去掉。
- **建议测试**：npm pack 后断言 tarball 内包含 files 声明的每一条（现有 works/ship/npm/test/manifest-contract.test.js:30-31,67-71 只断言 files[] 含 REQUIRED_PATHS，不校验每条声明项存在；audit-purity.js 无 files/existsSync 检查）。
- **是否已确认**：已确认（九项事实全部成立；severity P3 自我评估与代码注释一致）。

#### REL-14 ｜ NSIS 脚本里残留手写版本号 1.1.15，与三轨道真源 1.2.2 不一致
- **风险等级**：P3
- **涉及模块**：Windows 安装器
- **涉及文件**：`works/ship/installer/khyos_setup.nsi:10`
- **具体代码位置**：khyos_setup.nsi:10 与 khyos_uninstall.nsi:9；works/ship/installer/build_installer.js:118-128
- **问题描述**：两个 .nsi 都 `!define VERSION "1.1.15"`，而 check-version-sync 当前三轨读数为 1.2.2 / 1.6.5 / 0.1.0（本机实测 PASS）。build_installer.js:118-128 每次用 `/DVERSION=${version}` 覆盖（:127），所以该字面量不参与构建。全仓 `git ls-files "*.nsi" "*.nsh"` 核实仅这两条 NSIS 文件，且 setup.nsi:10 / uninstall.nsi:9 是两文件中唯一的版本字面量。附带证据：uninstall.nsi 全文件 0 处 `${VERSION}` 引用、且 build_installer.js 从不编译它（uninstaller 由 setup.nsi:244 WriteUninstaller 生成），该字面量是纯死值；setup.nsi 有 4 处 `${VERSION}` 引用（:17、:18、:249、:260）。
- **触发条件**：读/改安装器脚本时。
- **复现步骤**：直接读取两个 .nsi 的版本行；跑 `node scripts/ci/check-version-sync.js` → Main package version: 1.2.2；读 build_installer.js:118-128。
- **实际影响**：无运行时影响（恒定被注入值覆盖），但它是仓里唯一两处手写安装器版本号，改脚本的人会信它；也是版本分叉在主味上的一处残留。
- **根本原因**：版本注入机制做好后没有把占位字面量同步掉。
- **修复建议**：改成显式占位（如 `!define VERSION "0.0.0"`）并加注释明示「必须由 build_installer.js 注入，此值不参与构建」。
- **建议测试**：加一条断言：两个 .nsi 的 VERSION 定义必须与 pyproject.toml 一致，或必须是显式占位（「该字面量不参与构建」这一子论断未实测——本机未安装 NSIS，无法验证 makensis 对 /D 与脚本内 !define 的优先级；该不确定性只会放大而非削弱 finding）。
- **是否已确认**：已确认（核心主张由直接文件读取与指定校验命令完整支持）。

#### REL-15 ｜ publish-dual.sh 只 bump 4 个 G1 真源里的 3 个，发布后仓库立刻过不了 check-version-sync
- **风险等级**：P3
- **涉及模块**：发布链 / 版本同步
- **涉及文件**：`scripts/release/publish-dual.sh:284`
- **具体代码位置**：publish-dual.sh 279-285；check-version-sync.js:95-100（G1 组 4 个文件）；works/ship/modules/modules.json:2
- **问题描述**：脚本只 bump pyproject.toml（bump_pyproject 269-277）、works/ship/npm/package.json 与 runtime/node/backend/package.json（bump_json ×2，261-268）；works/ship/modules/modules.json（check-version-sync.js:99 列为 G1 第 4 源）不在其中，靠构建流程/人工维护。BUMPED_FILES 只在 81/258/266/275 四处追加；:354-370 --tag 时 `git add/commit -- "${BUMPED_FILES[@]}"`，即只提交那 3 个文件。注释口径：publish-dual.sh:89-90 "The version is synced into all three version files"、:248 "Sync the version into all three sources of truth"——与守卫的 4 源 G1 组口径不一致。真正会 bump modules.json 的是 version-mode.js 与 runtime/node/backend/src/cli/handlers/publish.js:305-338，二者均不在 publish-dual.sh 调用链上（对 scripts/release/*.sh|*.js、works/ship/** 搜 modules.json 仅命中 version-mode.js:44 只读清单与 esbuild-modules.js 只读不写 version）。
- **触发条件**：本地跑 `bash scripts/release/publish-dual.sh --version X.Y.Z --tag`。
- **复现步骤**：读 publish-dual.sh:279-285 与 check-version-sync.js:91-101；node -e 读 modules.json + findstr 读 pyproject.toml：四源当前均为 1.2.2；跑 `node scripts/ci/check-version-sync.js` → All version sync checks passed。impact 机制复现（未改仓库任何文件，%TEMP% 合成树四源中三源=9.9.9、modules.json=1.2.2）：`set "KHY_VERSION_SYNC_ROOT=..." && node scripts/ci/check-version-sync.js` → exit 1，`[version-sync] Version mismatch detected in main khy-os package group`。门接线：pr-gate.yml:84 与 dual-channel-release.yml:81-82 均跑该脚本。
- **实际影响**：本地跑完发布并 commit 后，三个文件是新版本、modules.json 是旧版本 ⇒ 同一次提交里 check-version-sync 必红，pre-commit / PR 门会挡下这个 release 提交。CI 上因为 bump 不提交所以看不出来（见 REL-10）。
- **根本原因**：脚本注释自称「Sync the version into all three version files」，与守卫的 4 源 G1 组口径不一致。
- **修复建议**：脚本里一并 bump modules.json（与另外三源同一条 perl 替换），或在 bump 后断言四源一致再继续。
- **建议测试**：用一个 fixture 仓库跑 publish-dual.sh --dry-run，断言结束后四个 G1 源版本相同（以 KHY_VERSION_SYNC_ROOT 合成树等价复现，未跑 publish-dual.sh 全流程——会改仓库文件并触发发布）。
- **是否已确认**：已确认（三点均有直接证据；「pre-commit 会挡下」在本机不可观测——.git/hooks 非 sample 钩子只有 post-checkout/post-commit，.git/config 无 core.hooksPath；PR 门挡下已由 pr-gate.yml:84 文件内容证实）。

### 3.9 运行时 CLI（RUN，5 条）

#### RUN-01 ｜ khy status 的 git 脏读数在探测失败时被当成「干净」，并把这个错值写进 30 秒磁盘缓存
- **风险等级**：P2
- **涉及模块**：runtime/node/backend CLI 状态行（HUD git 探测）
- **涉及文件**：`runtime/node/backend/src/cli/hudRenderer.js:177`
- **具体代码位置**：refreshGitAsync()，runtime/node/backend/src/cli/hudRenderer.js:151-186；配合 _gitOutAsync（:135-144）与磁盘缓存读写（:98-118）
- **问题描述**：refreshGitAsync 用 `const dirty = (status || '').length > 0`（hudRenderer.js:177）判定工作区是否干净。_gitOutAsync 在子进程出错/超时时 resolve(null)（:141，execFile `{timeout: 2000, maxBuffer: 8*1024*1024}`），null 与「真的干净（空串）」被同一表达式折叠成 dirty=false，随后 hudState.git 原样写入 30s TTL 的磁盘缓存（:185，GIT_CACHE_TTL/GIT_DISK_CACHE_TTL=30000 :65-66）。消费侧渲染：`routerDispatchSlash.js:915 await hud.refreshGitAsync()`、:952-954 `Branch: ${state.git.branch}${state.git.dirty ? ` (${state.git.dirtyCount} changed)` : ''}`。同步版 refreshGit 有同样形态（:390-391），但其 execSync 抛错时至少会把 branch 一起清空从而不打印 Branch 行，异步版不会。
- **触发条件**：`git status --porcelain` 子进程超时或失败。该调用 timeout: 2000，本仓实测 0.45-0.69s（空载）/1.3-1.7s（finding 报告值，8MB maxBuffer、数百行输出），余量取决于机器负载。
- **复现步骤**：受控复现（%TEMP% harness，patch child_process.execFile 后再 require hudRenderer，KHY_DATA_HOME 指向临时目录）：`node probe.js status-fails` → hudState.git = {branch:"feat/thinking-fold-20261103", dirty:false, dirtyCount:0,...}，且 fs.writeFileSync 捕获到 git-hud-*.json 内容 git:{dirty:false,dirtyCount:0}；对照 `clean`（status 返回空串）产出与该失败模式逐字节相同；`dirty` 则 dirty:true。既有磁盘证据：works/data/khy/cache/git-hud-RDpcUG9ydGFibGVra2h5LW9z.json → {"t":1794477128380,...,"git":{"dirty":true,"dirtyCount":341,...}}（= 2026-11-12 17:52:08，与 finding 记录一致）。仓库现状：git status --porcelain 实测 0.45-0.69s 四次，输出数百行。
- **实际影响**：状态行对用户说谎（违反 RUNTIME-002 状态透明）：用户看到「没有 (N changed)」会以为改动都已提交/无未提交内容，实际有数百个变更文件；且这个错误答案被缓存 30 秒，连跑多条命令都会持续显示错值。git status 越慢（仓越大）越容易触发。
- **根本原因**：把「探针失败（null）」与「探针成功且结果为空」混为一谈：_gitOutAsync 出错时 resolve(null)（:141），消费侧用 `(status || '').length > 0` 判脏（:177），失败即坍缩为干净，并写入磁盘缓存（:185）。
- **修复建议**：在 refreshGitAsync 里区分三态：status === null（探针失败）时不要覆写 hudState.git.dirty/dirtyCount，保留上一次已知值；没有上一次值时省略 changed 后缀并单独打印一行「git 状态读取失败（超时 2s），本次不显示改动数」。失败的探针不要写磁盘缓存（:185 加 null 守卫）。
- **建议测试**：对 refreshGitAsync 注入 _gitOutAsync 返回 ['branch', null, null] 的 fake，断言 hudState.git.dirty 不被改成 false、_writeGitDiskCache 未被调用；再注入全 null 断言 Branch 行不出 changed 后缀。可加一条用 KHYQUANT_CWD 指向大仓、把 timeout 压到 1ms 的集成用例（修复建议中的注入式测试未跑——属建议，非既有测试）。
- **是否已确认**：已确认（代码机制与落盘证据均支持；未端到端实跑 node bin/khy.js status——其启动链带更新检查等网络行为，且会覆盖上述 17:52:08 的磁盘证据，改以静态追踪派发路径 + 直接驱动 refreshGitAsync 的受控 harness 验证）。

#### RUN-02 ｜ khy doctor 快检在后台深检并没有启动时仍打印「深检已在后台跑」
- **风险等级**：P2
- **涉及模块**：runtime/node/backend CLI 诊断（doctor）
- **涉及文件**：`runtime/node/backend/src/cli/handlers/init.js:1105`
- **具体代码位置**：handleDoctor 快检收尾，runtime/node/backend/src/cli/handlers/init.js:1093-1106；与 _spawnBackgroundDeepDoctor（:1210-1258）的三道提前返回矛盾
- **问题描述**：只要不是 --deep，第 1105 行就无条件 printInfo「深检（网络 / 网关 / 烟雾）已在后台跑，结果写 <cacheFile>」。但 _spawnBackgroundDeepDoctor 在五种情况下会静默返回、什么都不起：stdout 不是 TTY（:1214-1216）、KHY_DOCTOR_BACKGROUND=0（:1217-1219）、KHY_DOCTOR_NO_BACKGROUND=1（:1220-1222）、缓存里已有 30 分钟内的深检结果（:1237-1239）、入口脚本缺失（:1241-1243），外加外层 catch（:1255-1257）——finding 说「三道」实为低估（共 5 处静默返回 + catch），不影响结论。快检分支调用 _spawnBackgroundDeepDoctor 且完全不看返回值（:992-995）。--json 提前 return（:1027-1083），故 --json 不打印该行但会写 cacheFile 字段。
- **触发条件**：任何非交互终端下的 `khy doctor`（CI、管道、agent 调用、输出重定向到文件），或用户显式设了 KHY_DOCTOR_BACKGROUND=0。
- **复现步骤**：实跑 `set "KHY_DATA_HOME=D:\Temp\khy-repro-b" && node runtime/node/backend/bin/khy.js doctor > out.txt 2>&1`（stdout 重定向=非 TTY）：输出第 30 行确为 `i 深检（网络 / 网关 / 烟雾）已在后台跑，结果写 ...\preflight.json`；同一次运行写出的该缓存文件 scope='fast'、checks 仅 7 条、lastDeep=null，数分钟后复查原样未变 → 后台深检从未被 spawn。--json 同跑：输出不含该行，JSON 含 scope='fast' 与 cacheFile。伪 TTY 模拟（fake isTTY=true 并拦截 spawn）：MODE=tty 时打印该行且 spawn 被调用（args=['<entry>','doctor','--deep'], detached:true）——证明该行只在闸门全过时才为真；MODE=no-bg 与 MODE=fresh-deep 两种情况下该行照常打印而 SPAWN_CALLS=[]。附带事实：doctor 每次运行都会写 works/data/khy/cache/preflight.json——「诊断」命令并非零写入。
- **实际影响**：用户被告知深检正在跑、结果会写进那个文件，于是去读 preflight.json，拿到的是 scope='fast' 的 7 条本地项，却以为是含网络/网关/烟雾的全量结论；在 CI 里这条提示同样为假。属于 RUNTIME-002 状态透明红线。
- **根本原因**：渲染侧（:1101-1106）与执行侧（:1210-1258）没有返回值通道：_spawnBackgroundDeepDoctor 是 void，调用点无法知道它到底起没起，只能默认「已起」。
- **修复建议**：让 _spawnBackgroundDeepDoctor 返回 `{started:boolean, reason:string}`，:1105 改为只在 started 时打印「已在后台跑」；未起时打印真实原因（如「深检未运行：非交互终端，手动跑 khy doctor --deep」）。
- **建议测试**：以 stdio 管道（非 TTY）跑 khy doctor，断言输出不含「已在后台跑」且 preflight.json scope=fast；再在伪 TTY 下跑一次，断言含该行并能看到深检写入。
- **是否已确认**：已确认（代码核对 + 实跑复现 + 伪 TTY 模拟；init.js 工作区干净，所审代码为已提交代码）。

#### RUN-03 ｜ setup.js 交互式安装向导按回车即选中公共镜像，与 PROCESS-013「默认必须原生」相反
- **风险等级**：P2
- **涉及模块**：runtime/node/backend 安装向导 / 依赖来源（PROCESS-013）
- **涉及文件**：`runtime/node/backend/setup.js:140`
- **具体代码位置**：createPrompt().select 默认项（runtime/node/backend/setup.js:136-143）+ npm 镜像菜单（:313-335）+ pip 镜像菜单（:368-388）；对照同文件自述的 opt-in 门（:78-88）
- **问题描述**：select() 在用户直接回车时返回 options[0].value（setup.js:141-142）。npm 菜单把「淘宝镜像 (npmmirror.com)」放在第一位（:319）、pip 菜单把「清华镜像 (tuna)」放在第一位（:373），官方源都排在最后。于是交互式 `node setup.js`（= runtime/node/backend 的 npm run setup，package.json:74）一路回车就会用 mirrors.aliyun.com / pypi.tuna 装依赖。文件头 :78-88 与 cnMirror.js 明确写「默认一律官方源，只有用户设了 KHY_USE_CN_MIRROR 才启用镜像」（cnMirror.js:42-50 cnMirrorEnabled() 默认 false），但 cnMirrorOptIn() 只在 --auto 分支被读取（:315、:369），交互分支完全不看。另：该文件因此被 scripts/ci/check-native-registry.js 判为「运行时源码」而非「构建配置」（:178-188 RUNTIME_SOURCE_RE 命中 ^runtime/node/.*\.js$），C4 判据只查文件里是否出现开关名（:322-323 content.includes），而 setup.js:79 的注释里就写着 KHY_USE_CN_MIRROR——注释即过检，行为层的「默认镜像」守卫看不见（实跑 `node scripts/ci/check-native-registry.js --files=runtime/node/backend/setup.js` → ✓ 均已被显式开关门控，0 error 0 warning）。
- **触发条件**：人在 runtime/node/backend 下跑 `npm run setup` 或 `node setup.js`，在镜像选择步按回车（或输入 1）。
- **复现步骤**：读码即可判定（实跑会装依赖，违反只读纪律）：:141 `const idx = parseInt(answer || '1', 10) - 1;` + :142 回退 options[0].value，空回车时 idx=0；:318-323 options[0] 为 `{ label: '淘宝镜像 (npmmirror.com)', value: 'taobao' }`，官方源排在 options[3]（:322）；:372-377 options[0] 为清华镜像 tuna（:373）；:326/:335 `registryArgs = npmMirror !== 'default' ? ['--registry', npmRegistry] : []` 使 :338 与 :349 的 npm install 带上 --registry https://registry.npmmirror.com；pip 侧 :380-388 生成 `-i https://pypi.tuna.tsinghua.edu.cn/simple/ --trusted-host ...` 并在 :396-398 传入 pip install。node -e 复算该算术（空 answer → 返回 'taobao'）。
- **实际影响**：同一份安装向导在不同机器上产出不同来源的依赖（镜像同步延迟时甚至拿到旧版本），且用户没有做过这个选择、也无从察觉；这与 PROCESS-013 红线「镜像不得默认生效」直接冲突，也让「默认必须原生」的守卫结论失真。
- **根本原因**：交互分支绕过了唯一的 opt-in 门：cnMirrorOptIn() 只 gate 了 --auto（:315、:369），交互菜单用自己的 options 顺序决定默认值，把公共镜像放在首位；守卫 C4 只做「开关名是否出现在文件里（含注释）」的文本检查，覆盖不到这个默认值。
- **修复建议**：把官方源设为默认项：npm/pip 两个菜单都把「官方源」挪到 options[0]（或给 select 增加 defaultIndex 并显式指向官方源）；更一致的做法是交互分支也先判 cnMirrorOptIn()，未 opt-in 时直接跳过镜像菜单用官方源。guard 侧可补一条：运行时源码里出现镜像主机表时，要求同文件有非注释的开关使用点。
- **建议测试**：给 createPrompt().select 加单测：注入空 answer，断言返回 'default'；或对 setup.js 的菜单数组断言 options[0].value === 'default'。
- **是否已确认**：已确认（五项承重点都与代码相符；未实跑 setup.js——会装依赖，违反只读纪律；未修改任何文件）。

#### RUN-04 ｜ khy hq status 头部的产品版本来自手工维护的 PROGRESS.json，与包版本漂移（1.1.11 vs 1.2.2）
- **风险等级**：P3
- **涉及模块**：runtime/node/backend CLI（hq 状态总览）
- **涉及文件**：`runtime/node/backend/src/cli/handlers/hq.js:150`
- **具体代码位置**：_printStatus（runtime/node/backend/src/cli/handlers/hq.js:147-151）；数据来源 runtime/node/backend/src/cli/hqStore.js:597-601
- **问题描述**：`khy hq status` 头部打印 `khy_os v${data.khy_os_version}`，该字段直接取自 works/record/ai/hq/PROGRESS.json 的 khy_os_version，没有任何脚本维护或校验它（自写 Node 脚本扫 scripts/ 全目录 502 个文件命中 0 处；git grep 全 tracked 文件命中仅 3 处代码/数据：handlers/hq.js:150 展示、hqStore.js:599 读取、PROGRESS.json:4 值本身）。hqStore.js:221-223 的 saveJson 用 Object.assign({}, data, { last_updated }) 整体回写，即每次任务改动都会把 khy_os_version 原样拷贝留存，但没有任何一处给它赋新值。DATA-SSOT.json 全文既不含 PROGRESS.json 也不含 khy_os_version。独立旁证：`works/record/evidence/01_人类贡献/发布记录.md:100` 与 `05_索引与对账/对账表.md:51` 已承认该字段是滞后台账、且不被守卫引用。
- **触发条件**：任何 `khy hq status` 运行；版本号只在人手改 PROGRESS.json 时才会变。
- **复现步骤**：同一会话内实跑三条命令：`node runtime/node/backend/bin/khy.js version` → 1.2.2；`node ...\bin\khy.js about` → `khy OS v1.2.2`；`node ...\bin\khy.js hq status` → 头部 `khy-os 任务状态总览    khy_os v1.1.11    2026-11-12`。读 PROGRESS.json：khy_os_version=1.1.11、version=1.0、last_updated=2026-10-21；读 backend/package.json：version=1.2.2。
- **实际影响**：两条只读命令对「这个系统是什么版本」给出不同答案，用户无从判断哪个是真的；版本号是判断要不要升级的唯一依据，漂移即说谎。影响面限于 hq status 一行展示，不阻断功能。
- **根本原因**：版本事实有两个来源：包版本（唯一被 check-version-sync 管的真源）和 PROGRESS.json 里手填的 khy_os_version（无真源登记、无写入方、无守卫）。
- **修复建议**：hq 头部改为从 runtime/node/backend/package.json 读版本（hqStore 里 require 一次即可），或删掉头部版本号只留日期；若要保留手填字段，需在 scripts/ci 加一条与 package.json 的一致性检查。
- **建议测试**：加一条 hqStore 单测：mock PROGRESS.json 的 khy_os_version 与 package.json 不同，断言 status 数据里的版本等于 package.json 的 version（未编写也未运行——复核员不改文件，且该测试尚不存在）。
- **是否已确认**：已确认（代码位置、行号、字段流向、三个命令的实测输出、scripts/ 零命中、无 SSOT 登记、无写入方全部对上）。

#### RUN-05 ｜ API Key 池不校验 endpoint 形态，khy gateway status 把 "u"/"v" 当 Endpoint 直接展示
- **风险等级**：P3
- **涉及模块**：runtime/node/backend 网关 Key 池与状态展示
- **涉及文件**：`runtime/node/backend/src/services/apiKeyPool.js:541`
- **具体代码位置**：addKey（runtime/node/backend/src/services/apiKeyPool.js:541-556）；展示侧 runtime/node/backend/src/cli/handlers/gateway.js:1232（_normalizeEndpointForDisplay 在 :1083-1089）与 gatewayStatusView.js:177-185
- **问题描述**：apiKeyPool.addKey 只校验「key 非空」（:542-544 `if (!config.key) throw`），endpoint 原样落盘；紧随其后的 _registerKey（:886-897）以 `endpoint: config.endpoint || ''` 原样入池。cc-switch 导入路径把 card.baseUrl 直接当 endpoint 传入（`src/services/domain/config/ccSwitch/store.js:244` addCard、:300 updateCard），baseUrl 是 "u"/"v" 时也照收（_normalizeCard :167-203 对 baseUrl 只做 typeof === 'string' 检查，addCard 仅要求非空 :237-239）。展示侧 _normalizeEndpointForDisplay 只做 trim + 去尾斜杠（:1088 `return text.replace(/\/+$/g, '')`），于是 `khy gateway status` 的 Endpoint 列出现单字母；gatewayStatusView.js:176-188（--endpoints-only 分支）与 :611-629（完整 status 末尾打印同一张表）原样输出，无「无效」标注。
- **触发条件**：通过 cc-switch 卡片或任何导入路径写入 baseUrl 非 URL 的 provider；本机已存在该数据。
- **复现步骤**：实跑 `node runtime/node/backend/bin/khy.js gateway status --endpoints-only`（改用文档记载的等效快速模式——裸命令会对各 adapter 做真实连通探测，为遵守「不得访问真实第三方服务」约束；两者打印同一张表、同一个 _collectConfiguredEndpointObjects 数据源），输出：cc-switch:c_46d9149babce1477 → Endpoint `u`；cc-switch:c_a8c36daab6014fa9 → `v`；cc-switch:c_cae9d086867466dc → `u`；另两行是正常 https URL。读 works/data/khy/api_keys.json（只打印 endpoint 与 key 长度，未打印 key 值）证实数据本身就写着 "endpoint":"u" / "endpoint":"v"——与 finding 描述逐条一致。
- **实际影响**：用户看到 Endpoint 是 "u" 无法理解该通道指向哪里；这些通道一旦被路由选中，请求会以难以定位的方式失败（相对地址/非法 URL），而状态页没有任何「无效」标注。属数据质量+展示可读性问题，不阻断其他通道。
- **根本原因**：系统边界（用户输入/外部配置导入）缺少 endpoint 形态校验：addKey 只校验 key 存在，导入侧不校验 baseUrl，展示侧不校验 URL 形状，三层都不设防。
- **修复建议**：在 addKey（或 ccSwitch store 的 addKey 调用点）对 endpoint 做形态校验：非空且能解析为 http(s) URL 才收，否则拒绝并回报「endpoint 必须是 http(s) URL」；存量数据可在 gateway status 展示侧把非法 endpoint 渲染成「(无效 endpoint)」而不是原样打印。
- **建议测试**：apiKeyPool 单测：addKey(provider, {key:'k', endpoint:'u'}) 断言抛错/返回校验失败；ccSwitch store 单测：baseUrl='u' 的卡片断言不入池（未执行——属建议而非已验证证据）。
- **是否已确认**：已确认（三层均如 finding 所述不设防，且本机数据与展示输出实证了该问题）。

---

## 第四章 架构改进建议

分档原则：**必须修改** = 有代码/测试证据的安全缺陷、发布链断裂与正确性缺陷（P0/P1，以及会直接造成资金损失或数据损坏的 P2）；**建议修改** = 有证据的工程债与可维护性问题（多数 P2/P3）；**暂时不要修改** = 需要先做决策或当前改动代价大于收益的项，以及本报告明确不建议的动作。所有建议均不涉及删除既有功能。

### 4.1 必须修改

1. **安全边界（P1，共 8 条）**：
   - AGT-01：`goalModeService.activate()` 的 `setProfile('yolo')` 加 `{persist:false}`；提权状态从模块级单例/进程 env 收窄为按会话。
   - AGT-02：`httpRequest.execute()` 与重定向每一跳调用 `urlSafety.assertPublicHttpUrlResolved`，risk 提为 high。
   - AGT-03：会话存储与 `khySessions.js` 读侧/写侧加入 user 维度与归属校验。
   - AGT-04：`executeShellCommand` spawn 前经 `buildSandboxCommand` 包裹，并加 wiring 守卫防再次脱钩。
   - SEC-01：`syncServer` 无有效 token 直接 close(1008)，userId 只取自已验证 token，三类处理器加对象级授权。
   - SEC-02：限流键改用 `req.socket.remoteAddress`（或受信反代白名单），对齐 `aiManagementServer.js:893-926` 写法。
   - GW-01/GW-02：pool 内层循环 try 加 finally 释放槽；`:4947` 的 fast-fail 加 `pi === 0` 守卫。
   - SEC-03/SEC-04/SEC-05：`/api/cache` 补鉴权与批量上限；附件加 owner 维度；auditLog 脱敏改递归 + 扩名单。
2. **发布链断裂（P0/P1，共 6 条）**：REL-01（`publish-dual.sh` 上传路径改 `entries/pip` 并加 glob 断言）、REL-08（删 `--dist-dir dist`）、REL-06（CI 装 khy 或改等价命令）、REL-03（签真实 tarball 并上传 .sig）、REL-08/REL-04（黄金路径与渠道 manifest 改现路径并加存在性断言）、REL-02（docker.yml 传 tag 版本或装本地 wheel）、DEP-08（`pack-executable.js` ROOT 与四个路径修正）。
3. **数据正确性（P1，共 3 条）**：DB-01（账号池置约改条件更新 + changes 校验）、DB-02（任务看板终态/重排队加状态守卫 + updateTask 乐观锁）、DB-03（claimTask 加状态与租约守卫）。
4. **前端致命缺陷（P1，共 1 条）**：FE-01（useResponsive 双文件收敛为一份，或在 vite/vitest 固定 resolve.extensions 并让测试走同一解析）。
5. **依赖漏洞（P1/P2，共 4 条）**：DEP-03（axios → >=1.20.0）、DEP-04（undici → >=7.30.1）、DEP-01（multer → 2.x）、DEP-02（js-yaml → 3.15.2）。
6. **测试门禁失位（P1）**：DEP-11（backend jest 先清零 4 个死路径 suite，再把 test-baseline 的 job 级 continue-on-error 换成失败数只降不升棘轮）。

### 4.2 建议修改

1. **网关可靠性（P2/P3）**：GW-03（池成功出口补埋点并抽共用函数）、GW-05（detectTruncation 识别 stopReason + 重发前发 reset 帧）、GW-06（抛错路径统一脱敏 + 补 AIza/JWT/UUID 形态）、GW-09（SSE 收尾复用主循环事件分发）、GW-10（sleep 改可中止）、GW-12（stale 遥测条件放宽）、GW-14（匿名指纹补请求级盐）、GW-07/GW-08（去重键加 adapter、recordKeyUsage 接线）。
2. **数据层（P2/P3）**：DB-05（主库多步写入包事务）、DB-06（刷新令牌条件更新 + 复用检测）、DB-07（时间基准统一）、DB-08（sessions.db 入备份集或分组表标不可重建）、DB-04（存储锁改异步/进程内串行）、DB-10（databaseQuery 的 isConcurrencySafe 按 readonly 判定）、DB-12/DB-16/DB-17（版本列/终态守卫/恢复前置探测）。
3. **工程债与治理（P2/P3）**：ARCH-01（按贪心顺序逐刀破环）、ARCH-02（R2b 刷新绑定拆分）、ARCH-04（新增 cwd 写路径静态判据）、ARCH-05（COMMS-002 扫描根对齐登记 paths）、ARCH-06（gov-status 输出文案与聚合范围）、ARCH-07/ARCH-16（check-wiring 三档细分 + 前置条件机判）、ARCH-08（--remeasure 进门）、ARCH-09（六个主根逐个子类翻管）、ARCH-13（--changed 合并三个改动集口径）、ARCH-14（docs:verify 接线 + 101 项订正）、ARCH-15（D4 纳入 pr-gate + security-scan 改名或改实现）、ARCH-18（影子目录按根因止住 + 残留隔离 + vibe_images 登记）、ARCH-19（ai-backend 与 backend 重复服务登记真源/镜像）、ARCH-20（20 文件 error 限定到跨目录危险情形）、ARCH-21（壳定退役顺序 + backend 根遗留隔离）。
4. **依赖与构建（P2/P3）**：DEP-06/DEP-17（npm 双栈退役计划）、DEP-07/DEP-20（打包器正式声明）、DEP-09（Docker 版本钉住）、DEP-10（.dockerignore 补 `**/.env.bak-*`）、DEP-12（no-undef 清零）、DEP-13（lint 基线落棘轮）、DEP-14（prettier 接 pre-commit 或 lint-ratchet）、DEP-15（khyquant-frontend job 补 test/lint:ci 并改注释）、DEP-16（三份镜像锁重新生成 + 删 *_MIRROR 参数）、DEP-18（根 devDeps 清 Electron 三件套）、DEP-19（删 allowScripts 惰性配置）、DEP-21（chalk/inquirer 各立升级任务）、DEP-22（test:node 通配符加引号）、DEP-23（conformance 套件钉版本）、DEP-24（建 nightly-security 或改注释）、DEP-25（体积阈值实测锚定）。
5. **发布与渠道（P2/P3）**：REL-05（版本注入 bundle）、REL-07（渠道 manifest 更新 + 守卫校验）、REL-09（npm bundled 入 gitignore + assemble 后 sha256 一致断言）、REL-10（tag==pyproject 断言）、REL-11（ISO 脚本三处 rsync 源与 init.d 改现路径）、REL-12（.sig 上传 + verify 自校验）、REL-13（helper 复制进包或去掉 files 条目）、REL-14（NSIS 版本改显式占位）、REL-15（bump modules.json 或断言四源一致）。
6. **前端与桌面（P2/P3）**：FE-02（DB 分支真实取价或诚实 dataSource）、FE-03（token 键修正 + 退避重连 + onUnmounted 引用计数）、FE-04（ai:abort 保留 pendingAi 直至终局事件）、FE-05（流式估算加节流）、FE-06（面板加本地计时器或 hub 心跳广播）、FE-07（收敛 axios 单例 + favorites 走 getApiBaseUrl）、FE-08（background.ts 加 wired 标记）、FE-09（GoalBanner status 接 messageSlice + onCancel 走 aiAbort）、FE-10（_healthTimer 改 GET /api/daemon/status 或改注释）、FE-11（fetch 改 AbortController 超时）、FE-12（onPtyData/onPtyExit 按 id 过滤）。
7. **运行时 CLI（P2/P3）**：RUN-01（区分探针失败三态、失败不写缓存）、RUN-02（_spawnBackgroundDeepDoctor 返回 started/reason）、RUN-03（镜像菜单官方源置首位或交互分支判 opt-in）、RUN-04（hq 头部版本改读 package.json 或加一致性守卫）、RUN-05（endpoint 形态校验 + 存量展示标注无效）。
8. **仓库卫生**：按 LAYOUT-004「只隔离不删除」处理根上 28 个事故残留与 backend 根遗留物（进 `.khyos/housekeeping/<日期>/` 并留 manifest）；4 个遗留 .html 孪生同批。

### 4.3 暂时不要修改

1. **GW-13（网关硬死线）**：不建议拆掉这道墙钟兜底——它是「重试级联被自身状态输出永久续命 → 1437 次膨胀」的对策。若要消解与 RUNTIME-003 的张力，只在 `exceeded()` 增加「真实适配器进度」入参，不动兜底存在性。
2. **AGT-06（工具结果注入边界）**：机制方向（不可信数据块 + 轻量扫描）是对的，但「扫描命中即阻断」会误伤正常技术文本；建议先做边界标记与只标注/降权，观察样本后再决定是否升档（符合 PROCESS-008 的阶段化要求）。
3. **AGT-07（默认 token 预算）**：属于「改变默认姿态」的诉求而非意外 bug，与「字节回退旧行为」兼容策略冲突；建议先讨论默认值来源（按 contextWindow 推导的软上限 vs serviceDefaults 保守值）再动。
4. **AGT-08（JSDoc 数字）**：只改注释，风险为零，但应与 loop/iterations.js 的改动同批做，避免单独一次文档提交。
5. **ARCH-03/ARCH-19（供应商端点与 ai-backend 双实现收敛）**：收敛方向（共享常量/单一实现）需要先做「物理上能否 import」的判断与 DATA-SSOT 登记决策，属架构决策而非纯修复；在决策前不建议动手改 25+ 个文件的字面量或合并两套网关。
6. **ARCH-12（构建产物统一落 entries/）**：迁移会动四个包的 outDir 与 asarUnpack 前缀，牵涉构建产物布局；建议与 LAYOUT-005 登记表更新同批规划，不单独做。
7. **DEP-21 的 moment**：package.json:101 注明是替 khyquant 代持，升级需与 khyquant 侧协调，单独排期，不塞进功能 PR。
8. **DEP-18/DEP-19 的删除动作**：删根 devDeps 三包与 allowScripts 块属删除类改动，需按 RUNTIME-009 走「报部位/定力道/留回滚」存证（rollback.txt）后执行；建议与下一次治理批一起做。
9. **DB-09（gui-eval 路由）**：本轮未证实，不建议在复核前照原文直接改；先单独复核再定。
10. **不建议的动作**（贯穿全报告）：不建议删除任何既有功能或渠道（包括 alpine-iso、traffic-stream 等当前失效/未接线模块——它们的问题是接线与路径，不是存在本身）；不建议用 `--update-baseline`、`continue-on-error`、扩大阈值的方式让现有红灯变绿；不建议在未取得人批准的情况下做 MINOR/MAJOR 版本递增（AGENTS.md R-2a）。

---

## 第五章 测试覆盖率分析

### 5.1 测试资产规模（来自题目给到的事实材料，非运行结果）

全仓共 **4316 个测试文件**：runtime 3400、delivery 404、apps 54、scripts 107、works 351。按跑器分：node:test 2417、jest/vitest 形态 1571、dart(flutter test) 121、jvm(JUnit) 99、node:test --experimental-strip-types 100、pytest 5、自跑脚本 3。分层入口：(1) 后端 Jest（jest.config.js 用 findNodeTestFiles 自动排除 node:test 套件与自跑脚本）；(2) 后端 node:test（`test:node` 与 `test:node:src`，test:all = test + test:node + test:node:src）；(3) 前端 vitest（ai-frontend 的 test/test:node）；(4) 桌面端 node --test（一条命令串 39 个测试文件：18 个 .mjs + 21 个 .cjs，含 agentbus/keymapContract/desktopUiContract 契约锁）；(5) Flutter（120 个 .dart + integration_test/ + test_driver/，未跟踪）；(6) Android JUnit；(7) 脚本层（根 test:scripts / test:docs + 25 个专项 test:* 入口）。根 package.json 没有裸 test 脚本，聚合入口是 `npm run test:all`。

> 口径提示：结构地图记 `apps/khyos-desktop` tests 63 个 / 1.37 万行，testInfra 记其 npm test 串 39 个文件——两个数字口径不同（前者疑为 tests 目录全量，后者为入口实际串联），本报告未逐文件复核，并列记录。另 FE-08/FE-09 的复核以 `*.test.*/*.spec.*` 通配在该 app 树下统计得 0——说明其测试以 .mjs/.cjs 形态存在于 tests 目录而非 src 旁。

### 5.2 本轮实际运行的测试/门禁（本会话执行）

| 命令 | 结果 |
|---|---|
| `node scripts/ci/check-version-sync.js` | exit 0（10 源三轨全过：1.2.2 / 1.6.5 / 0.1.0） |
| `node scripts/ci/check-agent-rules.js --changed` | exit 0，但只扫 28 个暂存文件（ARCH-13） |
| `node scripts/ci/check-repo-layout.js` | exit 1（5 error + 多组 warning） |
| `node scripts/ci/check-delivery-baseline.js [--json]` | exit 0（S1 降级），D1/D2/D3/D7 GAP、TS GAP |
| `node scripts/ci/check-copyright-readiness.js` | exit 0（7 warning，含 8 处名称不一致、17 个 .vue 样式占比超标） |
| `node scripts/ci/check-native-registry.js` | exit 0（8 warning：126 条镜像锁 + 2 个注入开关 + 1 处未门控运行时镜像） |
| `node runtime/node/backend/bin/khy.js hq verify` | exit 0（16 warning：6 条 done 不可复算、3 条 doing 无占用/无 started_at、1 条 acceptance 路径不存在） |
| `node runtime/node/backend/bin/khy.js status` | exit 0 |
| `node scripts/release/sync-dist.js status` | exit 0（本地相对分发仓落后 257 笔未推送，非同步失败） |
| `node --test scripts/tests/**/*.test.js` | exit 1（tests 1387 / suites 97 / pass 1369 / fail 17 / skipped 1，duration 327s） |
| `node --test runtime/node/backend/src/**/*.test.js` | exit 1（tests 7381 / suites 402 / pass 7378 / fail 3，duration 72.9s） |
| `node runtime/node/backend/scripts/archDebtScan.js [--scc/--god-report]` | exit 1（27 项超基线；最大 SCC 197 节点；28 个巨石） |
| `node scripts/ci/check-gov-status.js` | 绿灯（与四个实守卫全红并存，ARCH-06） |
| `node scripts/ci/check-debt-ledger.js [--remeasure]` | exit 1（--remeasure 后 13 error、10 项上漂） |
| `node scripts/docs/verify_docs_site.js` | exit 1（68 个问题） |
| `cd runtime/node/backend && npm run lint` | exit 1（6394 problems：495 error / 5899 warning） |
| `cd runtime/node/backend && npm run format:check` | exit 1（1535 个文件不合规） |
| `cd runtime/node/backend && npm test -- --ci --silent` | exit 1（79 suite failed / 198 tests failed，3247s） |
| `node works/ship/build/pack-executable.js --module khy --platform win-x64` | exit 1（ENOENT at :24，DEP-08） |
| `node entries/launch.js status` | exit 1（CLI 入口缺失，ARCH-11） |
| `node scripts/ci/check-golden-path.js --only pypi --json` | SKIP（REL-04） |
| `node scripts/ci/validate-json-schemas.js` | exit 0 但零文件被校验（ARCH-05） |
| `node --test tests/services/gatewayHardDeadline.test.js` | 13/13 通过 |
| `node runtime/node/backend/node_modules/jest/bin/jest.js tests/aiGateway.apiPoolStrategy.test.js` | 4 passed |
| `node runtime/node/backend/node_modules/jest/bin/jest.js --rootDir runtime/node/backend tests/gateway/requestDedup.test.js` | 13 passed |
| `node --test tests/security/credentialsHardening.test.js` | 8/8 通过 |
| `node node_modules/vitest/vitest.mjs run src/__tests__/mobileChartConfig.test.js src/__tests__/performanceOptimizer.test.js` | 2 files / 12 tests 全过（但 mobileChartConfig 测的是死文件，FE-01） |
| `node node_modules\vitest\vitest.mjs run --reporter=basic`（khyquant frontend） | 38 files / 442 tests 全过（DEP-15，本地跑得过、CI 从不跑） |

### 5.3 缺失的测试（关键链路零覆盖）

1. **网关池内层循环**：所有既有测试都整体 mock 掉 concurrencySlots（5 个文件），GW-01/GW-02 的 acquire/release 不变式与 fast-fail 自锁零覆盖；`aiGatewayGenerateMethod.test.js` 仅 2230 字符且与 pool 无关。
2. **adaptiveOutput**：全仓 tests 下 `adaptiveOutput` 零命中——整单重发、字段名不匹配、无 reset 帧三条都无测试（GW-05）。
3. **去重租户维度**：requestDedup.test.js 13 条用例无一条断言「两个匿名调用者指纹不同」（GW-14）。
4. **keySelector fill-first**：tests/keySelector.test.js 与 exports 测试无 fill-first 用例、无 recordKeyUsage/isKeyCooling 断言（GW-08）。
5. **autoModelSelect 同名冲突**：dedupe 用例两条都传 status:'active'，未覆盖 cooldown-first（GW-07）。
6. **SSE 无尾随换行末帧**：openaiSseStream.partial.test.js 的 sse() 恒追加 `\n\n`（GW-09）。
7. **回放台账多 path 交替**：replayLedger.test.js 只用单一 path/session（DB-13）。
8. **任务看板/大任务存储状态机**：requeue/deadLetter/claimTask 无状态守卫回归（DB-02/DB-03）；workflowRunWorker.test.js 为 jest 方言、本环境无 jest 未跑（DB-16）。
9. **账号池/会话/刷新令牌并发**：accountPool 并发 CAS、authSessionService 并发刷新、conversationStore 并发 update、guiEval 租户互访均无用例（DB-01/DB-06/DB-12/DB-09）。
10. **备份恢复的分组保持**：无 restoreService 分组断言；本机无 sqlite 驱动使该路径连本地都跑不起来（DB-08）。
11. **跨用户隔离全链路**：tests/aiUploadStore.test.js、tests/bridge/uploadRoute.test.js、tests/a2a.test.js 均无 403/401/跨用户断言（SEC-04/SEC-08）。
12. **桌面端关键交互**：ai:abort 后 ai.result 中继、Composer 流式估算节流、GoalBanner 状态派生、Terminal id 过滤、loadBackground 幂等——apps/khyos-desktop 树下无对应测试（FE-04/05/09/12/08）。
13. **前端 SSE/守护健康/超时**：useConfigSync（本机 node_modules/vitest 缺失跑不起来）、useDaemonHealth、useDashboardQuotes 的 fetch 超时均无用例（FE-03/10/11）。
14. **CLI 三态与提示一致性**：hudRenderer 探针失败三态、doctor 后台深检 started 返回、setup.js 菜单默认值、hq 版本来源均无测试（RUN-01/02/03/04）。
15. **守护自身**：restoreService 无测试文件（DB-17）；check-zcode-baseline 的 forbidDeepImports/forbidCycles 两个 PASS 无失败用例可写（ARCH-10）。

### 5.4 无效/失效的测试与测试基建问题

1. **DEP-11**：backend jest 深红——79 suite / 198 用例失败，其中 4 个 suite 因迁移死路径（`../../../../platform/packages/shared/src/utils/logger` 等）根本无法加载；PR 门整 job continue-on-error，红债不进 CI 视线。
2. **DEP-22**：`test:node` 通配符未加引号使 CI 只跑 1567/2902 个文件（少 46%）——CI 的「全绿」是缩小口径后的绿。
3. **DEP-15**：khyquant 前端 38 个测试文件 / 442 用例本地全过，但 CI 的 job 根本没有 test 步骤，两个步骤还挂 continue-on-error；注释给出的两条「不跑理由」均与代码事实相反。
4. **FE-01**：`mobileChartConfig.test.js:15` 显式 import `../utils/mobileChartConfig.ts`，测的是永远不会被打进产物的死文件（performanceOptimizer.test.js  import 的 .js 与产线一致，该条只对 mobileChartConfig 成立）。
5. **DEP-14**：prettier/lint-staged 三层配置零执行面，format:check 报 1535 个不合规文件但无任何门或钩子看它。
6. **GW-03**：apiPoolStrategy 测试 mock 了 usageTracker.record 却从不断言它被调用——mock 存在但无断言，等于没有覆盖。
7. **DEP-23**：conformance 官方套件不钉版本，同一条 commit 在不同日期跑出不同结论，「一致性测试」本身不可复现。
8. **DEP-25**：镜像体积门禁阈值是自认占位值，未经实测锚定。

### 5.5 覆盖不足的关键链路（按优先级）

1. **密钥池并发与冷却语义**（GW-01/GW-02/GW-08 + DB-01 + DB-07）：这是生产主路径（relay/api），却同时缺槽不变式、fast-fail 边界、冷却武装、租约 CAS、时间基准五类覆盖。
2. **多用户隔离全链路**（AGT-03 + SEC-01/02/03/04/08 + DB-09）：认证体系真实存在，但会话/附件/WS/限流/A2A/gui-eval 六面均无租户互访测试。
3. **发布链可复现性**（REL-01~15 + DEP-07/08/09）：twine 目标、签名对象、门禁命令可用性、Docker 版本、bundle 一致性全无冒烟。
4. **流式与取消语义**（GW-09/GW-10/GW-12/GW-14 + FE-04/FE-05/FE-06）：末帧完整性、abort 传播、遥测上报、去重租户、桌面端终局事件投递。
5. **任务/工作流状态机**（DB-02/DB-03/DB-16）：终态守卫、僵尸回收、陈旧判定、并发 answer。
6. **桌面端 agentbus 与 PTY 车道**（FE-04/FE-06/FE-12）：终局事件、进度时钟、会话 id 归属。
7. **CLI 状态透明**（RUN-01~05）：探测失败三态、后台任务 started 回报、安装向导默认值、版本读数一致性。

### 5.6 建议新增的回归测试（按批）

1. **第一批（随安全修复）**：
   - `aiGatewayGenerateMethod` pool 分支：真实 concurrencySlots 下 acquire==release 不变式；3-key 池 429 场景断言 generate 被调 3 次且 virtualSkip 为 0（GW-01/GW-02）。
   - `httpRequest` SSRF：元数据/回环/私网 URL 与 302 跳转四条断言（AGT-02）。
   - `syncServer`：无 token 连接被 close、跨用户 session join 收不到事件（SEC-01）。
   - `rateLimit`：XFF 伪造两种形态下 shouldSkipRateLimit 为 false、键等于 socket 地址（SEC-02）。
   - 跨用户隔离套件：会话读/写、附件读、cache 写、A2A 任务、gui-eval run 的 401/404 断言（AGT-03/SEC-03/SEC-04/SEC-08/DB-09）。
   - `goalModeService`：activate 后 permissions.json 不被改写；崩溃后重启 getProfile() 不等于 yolo（AGT-01）。
   - `accountPool`/`taskBoard`/`largeTaskRuntimeStore` 并发：CAS 与状态守卫的回归（DB-01/02/03）。
2. **第二批（随可靠性修复）**：
   - `adaptiveOutput`：detectTruncation 字段三形态 + 重发 prompt 差集 + onChunk reset 帧（GW-05）。
   - `_openaiSseStream`：无尾随换行的 tool_calls/Responses/Anthropic 末帧（GW-09）。
   - `requestDedup`/`keySelector`/`autoModelSelect`：匿名指纹区分、fill-first 换 key、同名不同 adapter（GW-14/08/07）。
   - `authSessionService`/`conversationStore`/`workflowRunWorker`：并发刷新、并发保存、并发 answer（DB-06/12/16）。
   - 备份→恢复演练：分组保持（DB-08）。
   - 桌面端：ai:abort 后终局事件投递、Composer 估算节流、Terminal id 过滤（FE-04/05/12）。
3. **第三批（随架构/性能修复）**：
   - `archDebtScan --scc` 节点数单调下降的棘轮断言（ARCH-01）。
   - 每切一刀后 `test:node:src` 失败集合逐名不变的契约（ARCH-01）。
   - bundle 两侧 sha256 一致的 assemble 后断言（REL-09）。
   - `check-agent-rules --changed` 在 402 改动文件状态下 scanned 数 ≥ 改动文件数（ARCH-13）。
4. **第四批（随治理修复）**：
   - 门禁自检：test-baseline 不得保留 job 级 continue-on-error；format:check/prettier 进钩子；test:node glob 引号静态断言（DEP-11/14/22）。
   - 文档守卫：.env.example 不含 admin123；AGENTS.md 的 html 计数与 docs:verify 输出一致；workflow 注释引用的 workflow 文件名必须存在（SEC-14/ARCH-14/DEP-24）。
   - JSDoc 与常量一致性：toolUseLoopCore 的迭代上限数字等于 loop/iterations 的 MAX_ITERATIONS（AGT-08）。

---

## 第六章 修复路线图

分批原则：第一批止血（安全与发布链，P0/P1）；第二批恢复核心业务可靠性（网关/数据/前端主路径）；第三批性能与架构（可维护性与规模）；第四批文档与工程治理（让门禁说真话）。每批内部按「先修证据最硬、代价最小」排序；涉及删除类改动的一律按 RUNTIME-009 留 rollback.txt。

### 第一批：安全与 P0/P1（立即启动，建议 2 周内完成）

| 序 | 编号 | 动作要点 | 验收 |
|---|---|---|---|
| 1 | REL-01 / REL-08 | publish-dual.sh 四处上传路径改 entries/pip；删 check:pip-packaging 的 `--dist-dir dist` | twine check 收到真实路径；pip 纯度阶段退出码 0 |
| 2 | REL-06 | CI 装 khy 或把 doctor-preflight 改为 `node runtime/node/backend/bin/khy.js doctor --check` | 干净 runner 上 release-gate 的 must 阶段不再因 ENOENT fail |
| 3 | REL-03 | npm 签真实 tarball（--pack-destination）并上传 .sig | 发布资产含 .sig；`test -f` 前置断言 |
| 4 | REL-02 / DEP-09 | docker.yml 传 `${GITHUB_REF_NAME#v}` 或装本地 wheel | 镜像 `khy --version` 等于 tag 版本 |
| 5 | DEP-08 | pack-executable.js ROOT/四路径修正 + 干净检出冒烟 | `--all` 读得到 modules.json 且 assets 非空 |
| 6 | AGT-01 | setProfile('yolo', {persist:false})；提权收窄到会话 | 崩溃后重启 getProfile() ≠ yolo |
| 7 | AGT-02 | httpRequest 全跳 SSRF 校验，risk 提 high | 元数据/回环/私网 URL 均被拒 |
| 8 | AGT-03 | 会话存储加 user 维度 + 路由归属校验 | 跨用户读/写返回 404 |
| 9 | AGT-04 | executeShellCommand 经 buildSandboxCommand + wiring 守卫 | 契约测试见包裹特征；KHY_OS_SANDBOX=false 逐字节回退 |
| 10 | SEC-01 | syncServer 无 token close(1008) + 对象级授权 | 集成测试两条断言 |
| 11 | SEC-02 | 限流键改 socket 地址/受信白名单 | XFF 伪造不再跳过；第 31 次登录 429 |
| 12 | GW-01 / GW-02 | try 加 finally 释放槽；fast-fail 加 pi===0 守卫 | 3-key 池 429 场景 generate×3、virtualSkip=0、slot current=0 |
| 13 | SEC-03 / SEC-04 | /api/cache 补鉴权+批量上限；附件加 owner | 无 token 401；跨用户附件 404 |
| 14 | DB-01 / DB-02 / DB-03 | 账号池 CAS、看板状态守卫、claimTask 守卫 | 并发回归用例全绿 |
| 15 | FE-01 | useResponsive 双文件收敛 | 契约测试断言导出形状；K 线路径不抛 |
| 16 | DEP-03 / DEP-04 / DEP-01 / DEP-02 | axios→1.20.0、undici→7.30.1、multer→2.x、js-yaml→3.15.2 | check-native-registry / 依赖审计无命中；两个调用点回归 |
| 17 | DEP-11 | 清零 4 个死路径 suite；test-baseline 转失败数棘轮 | PR 门 Jest 全量退出码如实 |
| 18 | SEC-05 / SEC-06 | auditLog 递归脱敏+扩名单；.admin_initial_password 从索引删除并轮换 | 密码/密保/SendKey 均 [REDACTED]；git ls-files 无该文件 |

### 第二批：核心业务可靠性（第一批合入后启动，建议 4 周）

1. **网关**：GW-03（池成功出口埋点）、GW-05（detectTruncation + reset 帧）、GW-06（脱敏统一 + 形态补齐）、GW-09（SSE 收尾复用）、GW-10（可中止 sleep）、GW-12（stale 遥测）、GW-14（匿名指纹盐）、GW-07/GW-08（去重键/记录端接线）。
2. **数据层**：DB-05（主库事务）、DB-06（刷新令牌条件更新+复用检测）、DB-07（时间基准统一）、DB-08（sessions.db 入备份集）、DB-04（存储锁异步化）、DB-10（isConcurrencySafe 按 readonly）、DB-12/DB-16/DB-17（版本列/终态守卫/恢复探测）。
3. **前端与桌面**：FE-02（行情真实取价或诚实 dataSource——涉及资金展示，优先）、FE-03（SSE token 键 + 退避重连）、FE-04（ai:abort 保留 pendingAi）、FE-05（估算节流）、FE-06（本地计时器）、FE-07（axios 单例收敛 + Capacitor URL）、FE-08~FE-12（幂等/状态派生/健康检查/超时/id 过滤）。
4. **安全剩余 P2**：SEC-07（anthropic 代理鉴权）、SEC-08（A2A 默认拒绝 + timingSafeEqual）、SEC-09（NODE_ENV 姿态）、SEC-10（WebAuthn RP 配置化）、SEC-11（URL 掩码）、GW-11（接线前认证）。
5. **Agent 与工具**：AGT-05（后台 shell 淘汰）、AGT-06（不可信内容边界标记，先标注后阻断）、AGT-07/AGT-08（默认预算讨论后落地 + JSDoc 订正）。

### 第三批：性能与架构（第二批稳定后启动，建议 6–8 周）

1. **破环与拆分**：ARCH-01 按贪心顺序逐刀（先 healEscalationService.js:487 → publish.js，单边收益 78 节点）；ARCH-02 把 R2b 刷新绑定拆分；ARCH-09 六个主根按 domain 粒度翻管（先 replSession.js / toolUseLoopCore.js）。
2. **配置面收窄**：ARCH-17（KHY_* 读取点登记判据 + 基线棘轮）；ARCH-04（cwd 写路径静态判据 + 三处改写）。
3. **重复实现收敛**：ARCH-03（供应商端点 SSOT 化，先决策后动手）；ARCH-19（ai-backend 双实现登记真源/镜像并让 check-ssot-data 校验）。
4. **性能**：FE-05 的 host 侧 IPC 节流落地后复测；GW-13 仅在取得共识后改判定入参；DESKTOP 流式路径的增量估算。
5. **构建与渠道一致性**：REL-05（版本注入 bundle）、REL-09（bundled 入 gitignore + sha256 断言）、REL-11（ISO 脚本路径）、REL-12（.sig 上传 + verify）、DEP-06/DEP-17（npm 双栈退役）、DEP-07/DEP-20（打包器声明）、DEP-10（.dockerignore）、DEP-23（conformance 钉版本）。

### 第四批：文档与工程治理（与前三批并行，持续）

1. **门禁说真话**：ARCH-06（gov-status 文案与聚合）、ARCH-07/ARCH-16（check-wiring 三档 + 前置条件机判）、ARCH-08（--remeasure 进门）、ARCH-05（COMMS-002 扫描根）、ARCH-10（declared-entry-gap）、ARCH-15（D4 纳入 pr-gate + security-scan 改名/改实现）、DEP-25（体积阈值锚定）、DEP-24（nightly-security 或改注释）。
2. **文档订正**：ARCH-14（docs:verify 接线 + 101 个 dangling-task 分批订正 + AGENTS.md html 计数改由 docs:verify 输出填充）、SEC-14（.env.example 改实况）、REL-07（渠道 manifest 更新 + 守卫校验）、REL-14/REL-15（NSIS 占位 + 四源 bump）、RUN-04（hq 版本来源）、AGT-08（JSDoc 数字）。
3. **格式与 lint 基建**：DEP-14（prettier 进 pre-commit/lint-ratchet）、DEP-13（lint 基线落棘轮 + no-undef 清零）、DEP-22（test:node 引号）、DEP-15（khyquant job 补 test/lint:ci 并改注释）、DEP-12（越作用域引用提升）。
4. **仓库卫生**：ARCH-18（影子目录止源 + 残留按 LAYOUT-004 隔离留 manifest + vibe_images 登记）、ARCH-21（50 个壳退役顺序 + backend 根遗留隔离 + 4 个遗留 .html 孪生）、DEP-16（三份镜像锁重新生成）、DEP-18/DEP-19（删根 Electron 三件套与 allowScripts，走 RUNTIME-009 存证）、DEP-21（chalk/inquirer 升级任务立项；moment 与 khyquant 协调）。
5. **发布治理补口**：REL-10（tag==pyproject 断言）、REL-13（npm 包 helper）、RUN-03（安装向导默认官方源 + 守卫 C4 改非注释开关使用点判据）、RUN-05（endpoint 形态校验）。
6. **流程纪律**：所有基线刷新（--update-baseline / debt-ledger measured / test-baseline notice）必须与拆分或清零动作同批；continue-on-error 新增须带到期日；AI 不得自行决定 MINOR/MAJOR 递增（AGENTS.md R-2a）。

---

## 第七章 审计结论

### 7.1 有代码证据的问题（126 条已确认）

第三章清单中的 126 条已确认发现，每条的「涉及文件」均带路径与行号（P0/P1 全部带 `文件:行号`），判定依据分三类：

- **门禁/脚本实测**：ARCH-01/02/03/04/05/06/07/08/09/10/11/13/14/15/16/17/18、GW-01~GW-14（除探针类外的脚本依据）、DEP-16、REL-01（部分）、REL-04、REL-07、REL-08、RUN-01（部分）——逐条命令见第三章各条「是否已确认」栏与 5.2 节表。
- **只读探针/复现**：AGT-02/03/04/05、SEC-01/02/03/04/05/06/07/08/09/10/11/12/13/14、DB-01~DB-08/DB-10/DB-12/DB-13/DB-14/DB-16/DB-17、GW-01/02/03/05/06/07/08/09/10/11/12/13/14 的行为复现、FE-01~FE-12、DEP-01~04/06~15/17~25、REL-02/03/05/06/09/10/11/12/13/14/15、RUN-01~05——均在本会话内以临时脚本（写在 %TEMP% 或仓外临时目录，跑完已删除）对真实模块驱动，未修改任何仓库文件。
- **静态读码 + 交叉检索**：若干条的触发条件或影响面无法在不启动服务/不装依赖的前提下动态化（如 SEC-03 的 supertest、DEP-01 的畸形 multipart、REL-01 的 twine 退出码），其代码事实由逐行读码与文件系统/git 检索证实，动态部分已在各条中如实标注「未跑」。

### 7.2 有测试/门禁证据的问题（点名命令与退出码）

| 问题 | 证据命令与结果 |
|---|---|
| ARCH-01 | `node runtime/node/backend/scripts/archDebtScan.js --scc` → 最大强连通分量 197 节点 |
| ARCH-02 | `node runtime/node/backend/scripts/archDebtScan.js` → exit 1，「超出基线的【新增】架构债: 27 项」 |
| ARCH-04/ARCH-18 | `node scripts/ci/check-repo-layout.js` → exit 1（root-shadow-dir / root-junk / layer-registry / root-whitelist 四个 error + 37 项未登记） |
| ARCH-05 | `node scripts/ci/validate-json-schemas.js` → exit 0，输出自陈「登记的 paths 与实际扫描范围不一致」且入仓文件 0 个 |
| ARCH-06 | `node scripts/ci/check-gov-status.js` → 「绿灯（可进入发布门）」，同会话 check-repo-layout / archDebtScan / check-core-layers / check-debt-ledger 均 exit 1 |
| ARCH-08 | `node scripts/ci/check-debt-ledger.js --remeasure` → exit 1，13 error、10 项 remeasure-drift |
| ARCH-13 | `node scripts/ci/check-agent-rules.js --changed` → 「28 file(s) scanned」，而 `git diff --name-only --diff-filter=ACMR HEAD` = 402 |
| ARCH-14 | `node scripts/docs/verify_docs_site.js` → exit 1（68 个问题）；`git ls-files "*.html"` = 1400 vs AGENTS.md:221 的「3000+」 |
| ARCH-15 | `node scripts/ci/check-delivery-baseline.js --json` → D4 PASS（detail: 发布链上无被吞掉的校验类步骤），而 pr-gate.yml 实测 9 处 continue-on-error |
| DEP-01/02/03/04 | `pnpm-lock.yaml` 条目 + `node -e` semver 复算 + node_modules 实装版本（公告元数据取自题目材料，禁网未独立复核） |
| DEP-11 | `cd runtime/node/backend && npm test -- --ci --silent` → exit 1，79 suite failed / 198 tests failed |
| DEP-12 | `node node_modules/eslint/bin/eslint.js src/ --format json` → 495 error / 5899 warning，no-undef 84 处（aiChatCore 5 处） |
| DEP-13 | `cd runtime/node/backend && npm run lint` → exit 1，6394 problems |
| DEP-14 | `cd runtime/node/backend && npm run format:check` → exit 1，1535 个文件不合规 |
| DEP-15 | `node node_modules\vitest\vitest.mjs run`（khyquant frontend）→ 38 files / 442 tests 全过；frontend-ci.yml 该 job 无 test 步骤 |
| DEP-16 | `node scripts/ci/check-native-registry.js` → 8 warning（含 126 条镜像 resolved） |
| DEP-22 | 清点 tests/ 递归 2902 vs 一层模式 1567；`node --test` 递归实测含三层文件 |
| REL-04 | `node scripts/ci/check-golden-path.js --only pypi --json` → status=SKIP |
| REL-07/REL-08 | `node scripts/ci/check-delivery-baseline.js --json` → D2 GAP（dist/ 缺 wheel,sdist） |
| REL-14 | `node scripts/ci/check-version-sync.js` → 1.2.2 / 1.6.5 / 0.1.0 全过，vs khyos_setup.nsi:10 的 1.1.15 |
| RUN-04 | `khy.js version` → 1.2.2、`khy.js about` → v1.2.2、`khy.js hq status` → v1.1.11（同会话三条命令） |
| RUN-05 | `node runtime/node/backend/bin/khy.js gateway status --endpoints-only` → Endpoint 列出现 "u"/"v" |
| RUN-02 | `node runtime/node/backend/bin/khy.js doctor`（非 TTY）→ 打印「深检已在后台跑」而 preflight.json scope='fast' |
| GW-13 | `node --test tests/services/gatewayHardDeadline.test.js` → 13/13 通过（门控开/关与 clamp 已有覆盖，判定入参无覆盖） |
| 门禁整体健康度 | `node scripts/ci/check-version-sync.js` exit 0；`khy hq verify` exit 0 但 16 warning（6 条 done 不可复算）；`check-copyright-readiness` exit 0 但 7 warning；`check-delivery-baseline` 5 GAP；`sync-dist.js status` 落后 257 笔 |

### 7.3 只是潜在风险（尚未在生产触发或需前置条件）

- **GW-11（traffic-stream 无认证 WS）**：模块当前零 importers，属潜伏面；一旦接线即暴露。
- **FE-12（Terminal pty 串台）**：当前 SidePane 只渲染激活标签，最多一个 TerminalPanel 挂载，缺陷被掩盖。
- **SEC-08（A2A fail-open）**：需未配置 KHY_A2A_API_KEY 且 0.0.0.0 可达；executor 还需 KHY_A2A_EXECUTOR=1 才真驱工具循环。
- **SEC-07（anthropic 代理裸奔）**：默认 ANTHROPIC_PROXY_ENABLED=false，开启即失守。
- **SEC-11（二维码令牌入日志）**：本机现存日志扫「qr-status」0 行，暴露是潜在态。
- **DB-01/DB-03（账号池/大任务竞态）**：git grep 未见生产调用方（acquire/switchAccount、runTask 跨进程入口），属潜伏态。
- **GW-07（autoModelSelect 同名去重）**：两个在产调用点恒传 active 或不传 status，未在生产触发。
- **GW-03 的「用量显示为 0」**：经复核不成立（CLI 侧照记），已在条目中订正——原表述是风险陈述而非事实。
- **DEP-05（PR 门依赖审计）**：复核判为 rejected（见 7.5），其指向的「审错树 + 仅 critical 级」是另一个问题，本轮未单独立项。
- **AGT-07（默认 token 预算）**：设计上靠人主动设 env 兜底，属默认姿态取舍而非既存故障。
- **DEP-09 的「v1.2.3 镜像装 1.2.9」**：机制推演，未访问 PyPI 实测。

### 7.4 未完成验证的模块与领域

1. **DB-09（gui-eval 路由租户隔离）**：复核子代理失败，整条未证实——列入清单但标注「未证实」，其 description/impact/fix 均为原文转录，需单独复核。
2. **runtime/boot/kernel（MoonBit + C 内核）**：本次审计未覆盖（无任何领域发现指向它；native-ci 的 moonbit-build/kernel-build 未运行）。
3. **runtime/node/ai-backend 的测试套件**：未运行（其 88 个 js 的自有测试不在任何已跑命令内）。
4. **delivery/mobile（Flutter/Dart + Android JUnit）**：120 个 .dart 测试与 99 个 JUnit 文件均未运行；移动端 21.8GB 目录仅做体积清点。
5. **delivery/web/ai-frontend 的 vitest 全量**：未运行（仅 khyquant 前端的 38 个文件由 DEP-15 的复核实跑）；useConfigSync 的测试因本机 node_modules/vitest 缺失跑不起来。
6. **apps/khyos-desktop 的 Electron 运行时**：未启动应用、未跑渲染/主进程测试（FE-04/05/09/12 的判定全部来自静态读码）。
7. **delivery/channel/khyquant 的后端服务（services/、controllers/、models/）**：仅作为前端取数链路的事实核验（Instrument 模型、comprehensiveDataService 外呼链）被读取，未做独立安全/正确性审计。
8. **真实后端服务的端到端**：未启动 server.js、未发真实 HTTP/WS 请求（SEC-01/02/03/08 用本地 harness 或替身 registry 等效复现；SEC-03/SEC-04 的 supertest 明确未跑）。
9. **Docker 构建与镜像层**：未跑 docker build（DEP-10 的机制由 .dockerignore 匹配语义与 check-docker-context.js:117 注记佐证）。
10. **git 历史完备性**：对象库缺 22 个对象（`git fsck` 退出码 2，D1 GAP），`git log -S`/`git show` 在部分路径报 unable to read tree——SEC-06 的「该口令是否曾生效」、ARCH-14 的 rootCause 叙事等历史性问题因此只能给条件式结论。
11. **GitHub 侧状态**：repository variables、workflow 实际运行记录、分支保护是否把 pr-gate 设为 required——均未访问（DEP-25/DEP-11/DEP-24 的相关陈述已标注为不可观测）。

### 7.5 复核不予认定的 4 条（仅在结论说明，不进入已确认清单）

| 编号 | 原标题 | 不予认定理由（摘要） |
|---|---|---|
| GW-04 | relay 默认 OpenAI 兼容路径从不构造 stale detector | 核心机制被代码直接矛盾：`staleOptions !== false ? {...} : null` 的前件与 enableStaleDetection 是同一条件，调用点不传第 4 参时传出的是非 null 对象字面量，detector 会被构造（已实证拆流生效）。finding 把该三元误读成对 staleOptions 的真值三元。 |
| DB-11 | 会话搜索索引并发索引产生重复行 | 出货驱动 node:sqlite 的 transaction 垫片把整个函数体包在 BEGIN IMMEDIATE 里，写锁在 COUNT 之前取得，第二写者阻塞 5s 后失败——四种驱动×日志模式组合下重复行都不出现，finding 自带的复现测试原样跑是通过的（20/20 轮无重复）。建议另立「catch 吞掉并发失败导致漏更新」。 |
| DB-15 | 会话分组 sortOrder 取 MAX+1 并发建组得到同号 | 唯一生产调用方在同步 IPC handler 内、两条语句之间无让出点，本进程内原子；全系统只有一个写进程（requestSingleInstanceLock）。finding 自拟的复现步骤原样执行是通过的（10 次并发 sortOrders 1..10 互不相同）。修法可作为硬化项跟进。 |
| DEP-05 | PR 门的依赖漏洞扫描只能审计一棵空树 | 两个承重主张被实测推翻：npm audit 走 Arborist loadVirtual 从 package-lock.json 建出 1948 节点虚拟树，bulk 请求实收 513 个包名；本地替身 registry 下注入 critical advisory 时该步确实 exit 1。真实缺陷是「审的是过时树 + 仅 critical 级」，应另立项。 |

### 7.6 受测试环境限制的结论（如实声明）

1. **Windows 主机限制**：DB-17 的类 Unix 分支（rename 成功而持连进程继续写旧 inode 造成静默分裂）无法在本机实测，只作为 POSIX rename 语义的常规推论；DEP-22 的 Linux sh glob 展开用 Git for Windows sh.exe 等效验证（npm 在 Linux 用 sh 执行由 npm 源码 script-shell 默认值证实）。
2. **无 Python 解释器**：REL-01 的 twine 对不存在路径退出码、REL-08 的审计脚本失败输出均未实跑，结论由代码路径 + bash glob 字面传递实测 + 目录实况推定。
3. **无 Docker / 无 pkg / 无 sigstore / 无 pnpm / 无 jest**：DEP-08 的端到端打包、REL-03 的 sigstore sign、DEP-23 的 `--save-false` 锁文件行为、DB-16 的 jest 方言测试均未实跑；DEP-19 的 pnpm 设置判据改用本机钉住的 pnpm 10.18.0 bundle 源码核对。
4. **禁网（不得访问第三方服务）**：DEP-01/02/03/04 的公告元数据（GHSA/CVE 编号、区间、Patched 版本）取自题目材料，未独立复核；PyPI latest、npm registry 实测值（DEP-21）未跑；KhyAiHub 远端状态仅依据本地 origin/main 等 ref 的树内容。
5. **并发写入者导致的工作区漂移**：审计期间 `git status --porcelain` 行数从 321 漂移至 335（.khyos/ 与 scripts/ 的 mtime 为 16:19–16:20），说明有并发写入者——所有「当前工作区状态」类读数（脏文件数、缓存文件内容）都是快照，复核时需重新核对；分支信息因此标注为不可用。
6. **依赖既有 node_modules**：DEP-11 的 jest 深红运行用的是本机既有 node_modules 而非干净 install:core，个别失败可能带环境因素（模块解析死路径与 teardown 失败与安装环境无关，已单独说明）。
7. **计数口径**：131 条发现中，P0/P1/P2/P3 的等级与 confirmed/unconfirmed/rejected 状态均以各领域复核结论为准；ARCH-02 的 20 项增长、DEP-13 的规则分布等数字来自对应命令的单次运行输出，重跑可能因工作区漂移有 1–2 的浮动（已在相应条目注明）。

### 7.7 总体结论

这个仓库的**治理设计投入与工程实现质量之间存在巨大落差**：118 个守卫、101 条登记规则、152 个 check 脚本、三轨道版本同步、D1–D10 交付记分板构成了一个看起来完备的治理体系，但真正在每个 PR 上被强制执行的只有 35 个执行器，总门 report-only，债务台账自报数与实测脱钩，文档数字与代码事实大面积漂移，四个实守卫全红的同时治理仪表盘报「绿灯（可进入发布门）」。**安全面**的缺口集中在最高危处：提权持久化、SSRF、跨用户隔离、WS 无认证、限流可绕五条 P1 同时成立，且多数已被本会话以只读方式复现。**发布链**在三个渠道上都是断的（pip 上传路径、npm 签名对象、Docker 版本），golden-path 的 D9 永远 SKIP 而记分板显示 PASS。**核心业务**（AI 网关密钥池）存在槽泄漏与 fast-fail 自锁两条 P1，数据层零事务零乐观锁。**可执行的建设路径**是清晰的：第一批 18 项（安全 + 发布链 + 依赖 + jest 门禁）都有明确的行号级修法与可执行验收；后续三批按「可靠性 → 架构 → 治理」推进，且第四批的多数动作（基线绑定拆分、continue-on-error 带到期日、--remeasure 进门）成本极低、能立即让门禁开始说真话。本次审计未修改任何源代码、配置与数据库结构，唯一新增文件即本报告。










