# [DESIGN-MEM-009] 信息导入与用户理解落地规范

<!-- RULES-REGISTRY-NONE: 本文件当前不承载规则 ID（纯设计方案，无执行器） -->

> **定位**：对照 `ai.today.android.app.cn`（下称 Today）APK 的解包结论，把「**信息导入**」与
> 「**越来越了解用户**」两条主线翻译成本仓可落地的方案。只写方案，不含任何运行代码改动。
>
> **上游**：
> - `[DESIGN-MEM-007] 记忆规则系统总纲`（MR-* 系列：何时写、怎么写、写哪、层级、回忆触发）；
> - `[DESIGN-MEM-008] 记忆操作可见性规范`（写/回忆的**可见落点**；本文的「过程态」一节承接其 V5）；
> - `docs/10_规范/registry/DATA-LOCATIONS.json`（`LAYOUT-007`：记忆/会话/轨迹的寻址真源）；
> - `[DESIGN-LAY-007] 三态目录立体分层方案`（T0–T4 五档语义与「移动即建链接」）。
>
> **受众**：改 `memdir/`、`services/domain/memory/`、`services/memory*`、导入类薄壳与引导流程的维护者。
>
> **边界**：本文不定义新的记忆语义（种类/层级/生命周期三轴已由 001/007 定义），不自造规则 ID，
> 不复制 Today 的设备能力面（短信/通讯录/日历/无障碍/通知监听等，理由见 §6）。

---

## 0. 一句话结论

本仓记忆域的**分层与生命周期强于 Today**（三轴正交 + 可恢复遗忘 + 可门控回退），
缺的是 Today 的两样东西：**把散装记忆收束成一页可读的画像**，以及**一条带校验、可溯源、
对用户明示阶段的导入通道**；导入域则相反——本仓有四条互不相干的「导入」薄壳
（项目依赖图 / 外部应用模型 / 外部 IDE 凭据 / 自然语言意图），但**没有一条把它们收束成
「导入即事实、事实可回溯」的统一语义**。两条主线的共同缺口是同一个：**落点不唯一**。

---

## 1. 现状实证（file:line 可复核）

### 1.1 记忆域：一个单一真源 + 三轴 + 一套召回链

| 事实 | 证据 |
|---|---|
| 记忆文件 IO 的单一真源是 `memdir/memdir.js`，对外 7 个操作：加载提示段、写、读、删、更新索引、搜索、列举 | `runtime/node/backend/src/memdir/memdir.js:1-12`、`:1202-1228` |
| 索引名与体量上限是常量：`MEMORY.md` / 200 行 / 25 000 字节 | `runtime/node/backend/src/memdir/paths.js:24-26` |
| 记忆家解析器：`KHY_MEMORY_DIR` → 统一家（门控 `KHY_MEMORY_UNIFIED_HOME`，便携态 = `getProjectDataHome()/memory`）→ 旧 `<dataHome>/memory` → `~/.claude/memory` 迁移回退 | `paths.js:109-149`、`:92-102` |
| 落盘真源在 `utils/dataHome.js`：`memory → T1-domains/memory/memory`、`sessions → T1-domains/sessions/sessions`、`conversations → T1-domains/sessions/conversations` | `runtime/node/backend/src/utils/dataHome.js:46-47`、`:53` |
| 便携态下 `works/data/khy/memory` 与 `works/data/khy/T1-domains/memory/memory` **是同一份物理目录**（前者是 Junction） | 实测 `powershell -NoProfile -Command "Get-Item 'works\data\khy\memory' \| Select-Object LinkType,Target"` → `LinkType: Junction`，`Target: ...\T1-domains\memory\memory` |
| 三条正交轴：`type`（语义种类）/ `tier`（保留层）/ `stage`（衰减状态机） | `services/memoryTier.js:25-32`（tier）、`services/memoryLifecycle.js:26-56`（stage）、`memdir.js:333`（type 注释） |
| 「信息更新」有确定性决策：同名 supersede / 正文未变 skip / 不同主题 insert，合并时取更持久层 | `memoryTier.js:156-177`、`:199-203` |
| 记忆存储是**扁平**的，取数口径是 frontmatter.type，绝不按目录推断 | `services/domain/memory/memoryEngine/index.js:165-168` |
| 召回链：tokenizer → 关键词重叠打分（name×3 desc×2 type×1 body×1）→ 富化（CJK 二元组 + 别名哨兵）→ 上限/字符预算 | `memdir.js:596-694`、`memoryEngine/memoryRecallTokens.js:1-37` |
| 主动注入三段：主动提及 / 话题切换预热 / 会话内短期 | `memoryEngine/index.js:209`（proactive）、`:293`（priming）、`:620`（session memory） |
| 会话内短期记忆**永不落盘**，进程内单例 | `memoryEngine/sessionMemory.js:1-16`、`:47`、`:99` |
| 过期判定是纯叶，视界按 type 派生，且与蒸馏共用同一批 env 旋钮 | `services/memoryStaleness.js:58`、`:83` |
| 写/回忆的**用户可见**告知已存在（纯叶 + 两态成对范式） | `services/memoryOpsNotice.js:103`（写）、`:185`（召回）、`:260`（过程态） |
| 画像侧的既有零件是**分散**的：讲解档位 / 使用习惯 / 隐式偏好信号 / persona 文件 | `services/learningProfile.js:19,98`；`services/usageHabitService.js:20,219`；`services/preferenceSignals.js:26,247`；`services/personaService.js:145,268` |
| 记忆**没有导出**入口（profile 有） | `services/userProfile.js:12`（`khy profile export/import`）、`:379`（`exportProfile`）；`memdir` 导出清单 `memdir.js:1202-1228` 无 export |

### 1.2 导入域：四条薄壳，一条语义

| 通道 | 现状 | 证据 |
|---|---|---|
| 项目依赖图 | 纯正则解析 imports/exports，**零依赖零模型**，解析失败 fail-safe 返回空图，动态导出标 `dynamic` 让下游整体跳过 | `services/domain/project/projectCoherence/importGraph.js:4-16`、`:73` |
| 外部应用模型导入 | 读 6 个外部软件已配置的 provider → 注册进 khy 自己的 provider 池；密钥只在进程内传递、返回一律 mask | `services/domain/network/externalApps/appModelImporter.js:4-20`、`:89` |
| 自然语言导入意图 | 纯叶三分判据（app 名 + 反向动词 + 模型领域词）缺一即 null，与正向 resolver 互不接管 | `services/domain/config/config/nlExternalAppImportResolver.js:11-18`、`:41-60` |
| 外部 IDE 凭据导入 | 扫本地登录存储并 upsert 进账号池，含观测式自动导入的冷却/去重 | `services/domain/account/accountPool/poolImporter.js:3-9` |
| 引导 | 步骤解析/元数据/渲染是纯叶；薄壳只做门控、快照、把每步委托既有 SSOT | `services/domain/onboarding/onboarding/onboardingPlan.js:54-71`；`cli/handlers/onboarding.js:1-20` |
| 会话/轨迹落点 | 会话是 append-only JSONL + JSON 快照，原子写；会话按 cwd 编码分桶 | `services/sessionPersistence.js:1-11`、`:27` |
| 活动式超时 | 会话看门狗只观测不杀进程（规则 3 的执行面之一） | `services/sessionWatchdog.js:1-25` |

### 1.3 三条实测缺陷（本文所有建议的起点）

**D1 — 记忆 frontmatter 解析不认 CRLF，导入的外部 Markdown 会「写入成功但看不见」。**

```
> node -e "const m=require('./runtime/node/backend/src/memdir/memdir');
  const lf='---\nname: role\ndescription: d\ntype: user\n---\n\nbody';
  const crlf=lf.replace(/\n/g,'\r\n');
  console.log('LF  ->',JSON.stringify(m.parseFrontmatter(lf).frontmatter));
  console.log('CRLF->',JSON.stringify(m.parseFrontmatter(crlf).frontmatter));"
LF  -> {"name":"role","description":"d","type":"user"}
CRLF-> {}
```

根因在 `memdir.js:44` 的正则 `^---\n([\s\S]*?)\n---\n?` 只认 `\n`。后果不是「解析报警」而是**静默**：
`frontmatter` 变 `{}`、`body` 变成整份文件，于是该条记忆在 `selectRelevantMemories` 的
name/description 权重上恒为 0、在列举/画像页里没有标题。任何来自 Windows 编辑器或外部导出包
的记忆文件都会踩到——这正是「导入」这条路要过的第一道门。

**D2 — 恢复脚本硬编码 `.khy/memory`，与落点真源不同源，并已产出仓库根影子目录。**

`scripts/memory/restore-memory.js:21-23` 写死 `MEMORY_DIR = ROOT_DIR/.khy/memory`；
而真源是 `utils/dataHome.js:53`（`T1-domains/memory/memory`）。实测
`node scripts/ci/check-repo-layout.js` 报 `root-shadow-dir`：
「仓库根出现 1 个影子数据目录（CLAUDE.md §二 B8）… 删掉它们，并修掉制造它的 cwd 相对写者：.khy」。
实测该目录当前只有 `key_manager_audit.jsonl` 与 `settings.json`（`Get-ChildItem .khy`），
即「另有写者也在往仓库根写」——D2 只是其中一处，但它是**记忆域自己**的那一处。

**D3 — 存在第二套记忆实现：`memoryBridge.js` 绕开 memdir 自写一套。**

`memoryBridge.js:48-63` 建 `appHome/memory/{user,feedback,project,reference,logs}` 目录树、
`:101-144` 自写关键词搜索、`:193-260` 直接把裸 `.md`（**无 frontmatter、无 tier、无索引条目**）
tmp+rename 落盘。它不经过 `memoryWriteSafety`、不写 `MEMORY.md`、不参与 staleness/tier 判定。
后果：通过工具写入的记忆对召回链（memdir 扁平目录）不可见，两套实现必然漂移。
`[DESIGN-ARCH-097]` 已把「记忆」定义为核，核里有两份写实现即违反单一真源。

---

## 2. APK 侧依据（只用侦察结论，编号对应发现清单）

| 编号 | 结论要点 | 本文用它做什么 |
|---|---|---|
| UM-01 / UM-14 | 记忆是一级页面（70 条专用文案），并把「我对你的了解」做成一页，空态同时完成「承认空 / 教怎么填 / 说明收益」 | 主线二的第一件产物 |
| UM-03 / UM-04 | 记忆权威源唯一（服务端），端上只消费 `v1/memories/overview` 与 `about-user`；端上 Room **没有** memory 表 | D3 的对照反面：本仓应只有一条写链 |
| UM-06 | 记忆在端上是 Markdown 文件树，且有路径逃逸防护文案（`Resolved Memory path escapes its configured root`） | 导入通道的路径校验与「格式要能读」 |
| UM-08 / UM-09 | 引导只采称呼/助理名/头像/性格/连接哪些 App，画像靠聊天长出来；记忆引导由服务端布尔决定，**且不存在关闭记忆的开关** | onboarding 步骤设计 + 明确要避开「只能开不能关」 |
| UM-10 / UM-24 | 三轴显式反馈：准确度 / 有用度 / **发送时机**；Today 显式询问，Khy 只有隐式推断 | 主线二的第二件产物 |
| UM-15 | 「正在建记忆」被暴露成用户可见状态；状态过期（1h）自动降级为 idle，避免永远显示进行中 | 过程态 + 活动式过期判定 |
| UM-16 / UM-17 | 删除只有「逐条/逐文件夹」与「注销账号」两档，且把会被删的东西**列全**；记忆可删但**不可导出** | 导出补齐 + 删除文案口径 |
| ING-01 | 设备能力以九元组清单上报：`capabilityId/description/version/inputSchema/outputSchema/executorType/riskLevel/enabled/parent` | 工具清单可自描述 |
| ING-03 / SEC-POS-02 | 外部分享进入 `share-inbox/`：sha256 文件名、`inbox.json` 清单、`.today-share-ownership.json` 归属日志、canonical path 校验、AtomicFile+fsync | 导入收件箱的六个要件 |
| ING-06 | 记忆文件导入两段式：逐文件 `<50MB` → 类型校验 → 上传换 storage path → 提交任务换 taskId，阶段由 `phase` 跟踪；**50MB 数值本身未在字节码中找到字面常量**，只能证实「有上限校验」 | 导入前校验 + 阶段明示（数值走 env） |
| ING-08 | 增量同步有 checkpoint token、dirty 标记、分片与压缩上限 | 只借「可续传状态机」形态（见 §6 不搬部分） |
| F09 | 连接器可用性细分：「当前可用但无法保证一直可用 / 需要重新授权 / 当前设备不支持」 | 导入三态与诚实降级 |
| F12 | 长时采集用 WAL + 分段 + 一致性校验 + 可恢复队列 | 轨迹侧的形态参照（本仓已有等价物，见 §6） |
| F14 / A-14 | 工具按「命名空间.方法」组织，错误码统一（`tool.notFound/permissionDenied/timeout/concurrencyRejected/...`），风险等级只作清单字段 | 错误码与本仓 `riskGate` 的对照 |
| SEC-SEC-01 / DEP-018 | 推送与监控凭据明文进包（AppSecret / JPushAppKey / Sentry DSN / PostHog key） | **反面样本**：本文任何落盘都不得引入进包常量（规则 `RUNTIME-001`） |

---

## 3. 落点总表

> 约定：目标一律是**本仓已存在**的文件；「改什么」写到函数/接口级；「规则」列出会拦住错误实现的守卫。

| # | 借鉴点 | 本仓目标文件（真实路径） | 建议改什么（函数级） | APK 侧依据 | 优先级 | 代价 | 受哪条规则约束 |
|---|---|---|---|---|---|---|---|
| 1 | 记忆权威源唯一 | `runtime/node/backend/src/services/memoryBridge.js` | 把 `:48-63` 的目录壳、`:101-144` 自写搜索、`:193-260` 裸写，改为委托 `memdir.saveMemory` / `selectRelevantMemories` / `localMemoryRecall`；按 RUNTIME-009 三档搓 | UM-03、UM-04 | 高 | 中 | `RUNTIME-009`（删有文档背书的代码）、`[DESIGN-MEM-001]`、`[DESIGN-ARCH-097]` |
| 2 | 导入收件箱六要件 | `runtime/node/backend/src/memdir/paths.js` | `getMemoryFilePath:178` 白名单正则（拒绝 `..`、Windows 保留名、ADS）；越界返回 null 由调用方报错 | ING-03、SEC-POS-02、UM-06 | 高 | 低 | `RUNTIME-002`（错误消息具体化）、`LAYOUT-007` |
| 3 | 归属可溯源 | `runtime/node/backend/src/memdir/memdir.js` | `saveMemory:344` 增 `options.source/sourceHash/importedAt` 三键写进 frontmatter；`_safeWriteFileSync:206` 在 rename 前后补 fsync | ING-03（ownership journal）、SEC-POS-02（AtomicFile+fsync） | 高 | 低 | `RUNTIME-001`（零硬编码）、`MEM` 域规范 |
| 4 | 外部 Markdown 必须能读 | `runtime/node/backend/src/memdir/memdir.js` | `parseFrontmatter:43` 先归一 CRLF 再解析；失败返回 `parseError` | UM-06、ING-06（失败要有可见原因） | 高 | 低 | `RUNTIME-002` |
| 5 | 导入落点走解析器 | `scripts/memory/restore-memory.js` | `:21-23` 改 `utils/dataHome.getDataDir('memory')`；`.archive` 同源 | ING-03、SEC-POS-02 | 高 | 低 | `LAYOUT-007`、`RUNTIME-001` |
| 6 | 一页画像 | `runtime/node/backend/src/cli/handlers/persona.js` | switch 增 `about`：读 `memdir.listMemories:547` 中 `type=user` + `learningProfile.getLevel:82` + `usageHabitService` 的 responsePreferences，渲染单页（不写盘） | UM-14、F07 | 高 | 低 | `RUNTIME-002`；新增功能先过规则 6（需求五问） |
| 7 | 三轴显式反馈 | `runtime/node/backend/src/services/preferenceSignals.js` | 新增纯叶 `detectExplicitFeedback(text)`（accuracy/helpfulness/timing）；与 `:247 detectPreferenceSignal` 并列，宁 null 不猜 | UM-10、UM-24 | 高 | 低 | 规则 6；`[DESIGN-MEM-007]` MR-B（写入方式） |
| 8 | 引导里给记忆一个位置（且可关闭） | `runtime/node/backend/src/services/domain/onboarding/onboarding/onboardingPlan.js` | `STEP_META:54` / `STEP_ORDER:64` 增 `memory`；薄壳 `cli/handlers/onboarding.js` 委托 `learningProfile.setLevel:98` + 显式 `KHY_DISABLE_MEMORY` | UM-08、UM-09（反面） | 高 | 低 | `RUNTIME-010`（授权须显式授予）、`PROCESS-008`（新步骤按阶段） |
| 9 | 导入三态与诚实降级 | `runtime/node/backend/src/services/domain/network/externalApps/appModelImporter.js` | `discover:89` 返回 `state: ok/stale/reauth/unsupported`；CLI 按态给修复命令 | F09 | 中 | 低 | `RUNTIME-002` §2.2 |
| 10 | 工具清单可自描述 | `runtime/node/backend/src/services/tool/toolSpec.js` | 增 `toManifestEntry()`（version/enabled/parent/executorType）；`memoryBridge.js:257` 的 `write_memory` risk 与真实副作用对齐（现为 LOW） | ING-01、F14；`riskGate.js:1-17` 已消费静态 risk | 中 | 中 | `RUNTIME-010` A2-4（声明面收窄须有执行面） |
| 11 | 导入阶段对用户明示 | `runtime/node/backend/src/services/memoryOpsNotice.js` | 增 `formatImportNotice({stage})` 两态成对；`memdir.saveMemory` 返回 `phase` 与 `reason` | ING-06、UM-15 | 中 | 中 | `[DESIGN-MEM-008]` V5；`RUNTIME-003`（活动式超时） |
| 12 | 可删就要可导出 | `runtime/node/backend/src/services/userProfile.js` | `exportProfile:379` 的 bundle 并入 memdir 记忆（Markdown 原样 + `index.json` 清单）；输出到 T3/用户指定目录 | UM-17、UM-16 | 中 | 中 | `LAYOUT-007`（T3 只追加）、`SECURITY` 域 |

---

## 4. 主线一：信息导入（把外部东西变成可召回的事实）

### 4.1 第一阶段（只做「不让导入静默失败」）

范围：#2 / #4 / #5。三件都不新增存储、不改召回算法。

1. `parseFrontmatter` 归一 CRLF 且返回 `parseError`（D1）；
2. `getMemoryFilePath` 白名单 + 越界返回 null；
3. `restore-memory.js` 改走 `getDataDir('memory')`（D2）。

**验收**：
```bash
# 1) CRLF 与 LF 必须解析出同一份 frontmatter
node -e "const m=require('./runtime/node/backend/src/memdir/memdir');\
const lf='---\nname: r\ntype: user\n---\n\nb';\
const a=m.parseFrontmatter(lf).frontmatter, b=m.parseFrontmatter(lf.replace(/\n/g,'\r\n')).frontmatter;\
console.log(JSON.stringify(a)===JSON.stringify(b))"   # 期望 true

# 2) 路径白名单：'..\\x.md' / 'a:b.md' / 'CON.md' 必须被拒
#    （实现后可直接断言 getMemoryFilePath 返回 null）

# 3) 影子目录不再被脚本制造
node scripts/ci/check-repo-layout.js   # root-shadow-dir 不再由 restore-memory 触发
```

回归门（本仓真实测试入口是 jest，`package.json` 的 `test` 即 `jest`；`node --test` 跑 jest 风格的用例会报
`beforeAll is not defined`，实测已排除）：
```bash
cd runtime/node/backend && node D:/Portable/khy-os/node_modules/jest/bin/jest.js tests/memdirRelevance.test.js
# 实测：PASS，Tests: 10 passed, 10 total
```

### 4.2 第二阶段（导入收件箱：可溯源与可回退）

范围：#3 / #11。做的事：

- 导入的每一条记忆在 frontmatter 里带 `source`（来源标识）、`sourceHash`（内容 sha256 前缀）、
  `importedAt`（ISO）；
- 导入是**两段式**：先 `validated`（大小/类型/frontmatter 校验）→ `stored`（写盘 + fsync）→
  `indexed`（`MEMORY.md` 有对应条目）。任一段失败返回 `{ok:false, reason, limit?}`，
  `reason ∈ {too_large, unsupported_type, bad_frontmatter, path_rejected}`；
- 上限**从 env 取**（如 `KHY_MEMORY_IMPORT_MAX_BYTES`），源码不写字面量（RUNTIME-001）；
- 用户可见：`formatImportNotice({stage})` 两态成对（开始 / 完成），失败给可执行原因。

**验收**：同一条导入分别造「超限」「类型不支持」「CRLF 无 frontmatter」「正常」四种素材，
断言返回的 `phase`/`reason` 与可见告知成对出现；并断言正常导入后
`memdir.selectRelevantMemories(<标题词>)` 能召回该条（证明「导入的东西真的能召回」）。

### 4.3 第三阶段（收束四个导入薄壳的语义，按需）

只有在 #1（单一写链）落地后才做：给四条导入薄壳统一一个「导入结果」返回形状
`{ok, channel, imported, skipped, reasons[]}`（`channel ∈ {project-graph, app-model, nlp-intent, ide-credential}`），
让 CLI 能对任意导入通道给出同一句「导入了 N 条，跳过 M 条（原因）」。**这一步不做也不影响前两阶段。**

---

## 5. 主线二：越来越了解用户（把散装记忆收束成理解）

### 5.1 第一阶段（一页画像 + 一条显式反馈）

范围：#6 / #7。

- `khy persona about`：纯读聚合，**不新增存储**。数据来源三处已有：`memdir.listMemories`
  （`type=user` 的记忆）、`learningProfile.getLevel`、`usageHabitService` 的 responsePreferences。
  空态照 Today 的三段结构（承认空 / 怎么填 / 有什么用），不写成「暂无数据」。
- `detectExplicitFeedback`：把用户显式评价映射成三轴信号，落 `recordResponseFeedback`（已有落点，
  不新建画像文件）。与现有 `detectPreferenceSignal` 并列而不合并——一个是「隐式纠正」，
  一个是「显式评价」，判据不同，合并会互相污染误报率。

**验收**：
- 空库：`persona about` 输出空态三段；有 3 条 user 记忆：输出标题列表 + 档位 + 偏好摘要；
- 纯叶用例：11 条正样本（含「回答不准确」「这次时机不对」）与 11 条反样本（含「帮我写个简短报告」
  这类描述交付物而非评价的句子）必须全对——反样本全对是这条的硬判据（宁 null 不猜）。

### 5.2 第二阶段（引导里给记忆一个位置）

范围：#8。`/onboarding memory` 步骤只做两件事：选讲解档位（normal/beginner）、
决定记忆开/关（写 `KHY_DISABLE_MEMORY`）。**明确要避开 Today 的缺口**：它的记忆只能开不能关
（UM-09 反证：`toggle.*memory` / `setMemoryEnabled` / `disableMemory` 全库零命中）。

**验收**：`/onboarding status` 能读到该步骤状态；选「关」后下一轮 `loadMemoryPrompt()`
返回 null（`memdir.js:261-264` 已有门控），且 `persona about` 明说「记忆已关闭」而不是显示空库。

### 5.3 第三阶段（过程态与过期降级）

范围：#11 的可见性部分。记忆写入/整理的过程态要**成对**（开始/完成），并且状态本身有保鲜期：
超过阈值未推进就降级为 idle，而不是永远显示「正在分析」。判定纯叶（活动时间戳由调用方传入，
不读时钟），对齐 `[DESIGN-MEM-008]` V5 与规则 3。

---

## 6. 不做 / 不参考（含风险）

| 不做什么 | 为什么 |
|---|---|
| 设备能力面（短信、通讯录读写、日历写、应用使用统计、通知监听、无障碍读屏、悬浮窗） | Today 把这些做成 LLM 工具是它权限面极宽的根因（SEC-PERM-01/02/03/04/08、F15）。本仓是本地优先的 CLI/服务端形态，没有等价场景；照搬会同时引入「模型可触达的数据面」与合规负担，而收益为零。 |
| Health Connect / 健康数据同步 | 与 Khy OS 的数据真源无关（`LAYOUT-007` 的 T1 域里没有健康域）。Today 自己也是「用系统中介替代自建权限」的妥协做法（F11），不是能力借鉴点。 |
| 归因 / 增长 / 邀请奖励 / 订阅重置额度 | 与交付基线（`[DESIGN-DELIV-002]`）方向相反：Khy 的表针是「能力能不能用」，不是「额度剩几次」。 |
| 推送聚合层（JPush + 厂商插件 + 明文 AppSecret） | 中国区 Android 分发才需要；且 Today 把 OPPO/VIVO/JPush 凭据与 Sentry DSN、PostHog key 明文进包（SEC-SEC-01、DEP-018），是本仓 `RUNTIME-001` 判 error 的形态。 |
| 服务端下发首页/卡片流（`today-pages`、`briefs`） | 会让「状态真源在本地、写必走正门」失效（CH-1/CH-3 原则）。khyquant 尤其不能由远端配置决定交易态。 |
| 客服/订阅/强制更新链路 | 本仓版本策略是人工触发发布（`PROCESS-005`），客户端自更新会绕过版本同步真源。 |
| Today 的分片上传/checkpoint 协议（ING-08） | 本仓会话是 append-only JSONL + 快照（`sessionPersistence.js:1-11`），轨迹是内容寻址 blob 桶（`DATA-LOCATIONS.formats.blobRoots` 里的 `trajectory_replay` / `feedback`），**没有「大对象增量上传」这个场景**。只借它的「状态机可续传」思想用于 #11，不搬协议。 |
| 把记忆改成目录树 | Today 有文件夹/重命名/排序（UM-06），但本仓的扁平存储是**设计选择**：`memoryEngine/index.js:165-168` 明写「取数口径是 frontmatter.type，绝不按文件所在目录推断」。改成树会同时牵动召回打分、索引生成与 project 记忆隔离，收益（浏览）远小于代价。 |

**风险登记**：

| 风险 | 说明 | 缓解 |
|---|---|---|
| 导入即投毒 | 外部 Markdown 可携带「忽略此前指令」类文本 | 导入通道只落**数据**，不落 persona/instruction；persona 侧已有 `scanForPromptInjection`（`personaService.js:145`），导入侧应复用同一管线后再入库 |
| 导出物泄密 | #12 的导出 bundle 含用户画像 | 默认输出 T3-archives 或用户指定目录，绝不写进仓库树、绝不进 T0 |
| 画像页变成「编造画像」 | 聚合页若加入推断性描述，会变成模型幻觉的载体 | 单页只呈现**已有条目**（记忆正文 + 档位 + 显式反馈计数），不做二次总结 |
| 两套写链并存期 | #1 落地期间两处都可能写 | 先让 `memoryBridge` 写路径改委托（行为不变），再删目录壳；期间用「同一 (type,name) 只应有一个文件」断言 |

---

## 7. 与既有 MEM 规则、数据落点的衔接

### 7.1 哪些结论只能落在 `works/data/khy/memory/`（用户记忆态）

- 用户/反馈/项目/参考四类记忆文件与 `MEMORY.md` 索引：**运行态数据**，归 T1-domains 的 `memory` 族，
  物理真源 `works/data/khy/T1-domains/memory/memory`（`DATA_PATHS.memory`），
  `works/data/khy/memory` 只是它的 Junction 别名。
- 会话内短期记忆**不落盘**（`sessionMemory.js:1-16`）——它不属于任何落点。
- 会话正文与轨迹各自有落点：`conversations` / `sessions` / `trajectory_replay`
  （`dataHome.js:46-47`；轨迹目录是 `formats.blobRoots` 豁免「格式自解释」的扁平常量桶）。

### 7.2 哪些属于受控真源（不得在本文或实现里另立一份）

| 主题 | 真源 | 本文只允许引用 |
|---|---|---|
| 记忆种类/层级/生命周期/回忆触发 | `[DESIGN-MEM-007]`（MR-*）、`memoryTier.js`、`memoryLifecycle.js` | 引用，不新增枚举 |
| 记忆落盘格式与不可搬面 | `DATA-LOCATIONS.json`（`LAYOUT-007`）、`[DESIGN-LAY-007]` | 引用 |
| 记忆可见性 | `[DESIGN-MEM-008]` | 引用；过程态沿用其 V5 的「两态成对」 |
| 记忆格式与索引契约 | `memdir/memdir.js`（`MEMORY.md` 条目形如 `- [Title](file.md) — hook`，≤200 行 / 25 000 字节） | 引用常量，不复制数值 |
| 门控 | 各模块自身的 `KHY_*` env（`KHY_DISABLE_MEMORY` / `KHY_MEMORY_TIERS` / `KHY_MEMORY_RECALL_*` …） | #8 的开关复用 `KHY_DISABLE_MEMORY`，不新造 |

### 7.3 已发现的文档漂移（只登记，不在本文修）

`[DESIGN-MEM-001] 记忆系统标准规范` 的落点表仍写 `.khy/memory/`，示例脚本也用
`path.resolve('.khy/memory')`。这与 `utils/dataHome.js:53` 的解析结果不一致（便携态为
`works/data/khy/T1-domains/memory/memory`）。按规则 7「文档背书的代码不许静默清理」的反向同理，
**订正 001 需单独一次改动并说明影响面**；本文只指出漂移，不顺手改。

---

## 8. 反模式（这条路别走）

1. **另起一份画像存储**。已有 `learningProfile` / `usageHabitService` / `preferenceSignals` /
   `userProfile` / `memdir` 五处都在承载「关于用户的事实」。再加一份 = Today 的「两个 JSON 栈 +
   两套 Session Replay」同型问题（DEP-005、DEP-016）。
2. **让导入通道直接写 `MEMORY.md`**。索引是派生结构，只能经 `updateMemoryIndex` 维护；
   手写索引行会让「文件存在但索引没有」与「索引有但文件没了」两种腐坏同时出现。
3. **把「正在记忆」做成无过期的进行时**。Today 用「stale 1h → downgrade to idle」解决了这个，
   本仓若只加进行时、不加保鲜，会违反规则 2.1（状态必须收敛）。
4. **用 `mtime` 代替 `updated`**。`memoryStaleness` 已把 `updated` 作为首选、mtime 只作回退
   （`memdir.js:765-772`）；导入的文件若不带 `updated`，一次 `cp` 就能让三年旧记忆变成「刚更新」。
5. **在导入路径上做「智能分类」**。`importGraph.js:4-16` 的铁律（零依赖零模型、失败返回保守空值）
   同样适用于记忆导入：分类错了会被后续所有分析继承（DEP-012 的教训：把下载队列 SDK 记成广告 SDK）。

---

## 9. 验收方式

| 层 | 命令 | 判据 |
|---|---|---|
| 结构守卫 | `node scripts/ci/check-repo-layout.js` | 不新增 finding（编辑级：`root-shadow-dir` / `docs-index-complete` 不得因本文变法） |
| 文档守卫 | `node scripts/ci/check-agent-docs.js` | `0 error` |
| 记忆召回回归 | `cd runtime/node/backend && node D:/Portable/khy-os/node_modules/jest/bin/jest.js tests/memdirRelevance.test.js` | 全绿（实测基线 10/10） |
| 记忆写安全 | 同上，`tests/memdirSafeWrite.test.js`、`tests/memoryWriteSafety.test.js` | 全绿 |
| 记忆过期 | 同上，`tests/memdirStaleness.test.js`、`tests/memoryStaleness.test.js` | 全绿 |
| 项目记忆契约 | 同上，`tests/projectMemoryContract.test.js` | 全绿 |
| 阶段一 D1 | 本文件 §4.1 的 CRLF 断言 | `true` |
| 阶段二导入 | 四种素材（超限/类型/CRLF/正常） | `phase` 与 `reason` 成对、正常项可被召回 |

> 说明：以上 jest 用例的**存在**已实测（`runtime/node/backend/tests/`），其中
> `memdirRelevance.test.js` 由本次分析实跑通过（10 passed / 0 failed）。其余用例本次**未逐个运行**，
> 落地时应作为回归门一并跑。

---

## 10. 待核实项

1. `#1` 落地前需确认 `memoryBridge` 的调用方清单（是否已有路由/TUI 依赖它的目录布局）；
   本轮只读了 `memoryBridge.js` 本身，**没有**做调用点全量扫描。
2. `KHY_MEMORY_IMPORT_MAX_BYTES` 的合理默认值：Today 的 50MB 在字节码里**没有**字面常量（ING-06 已声明），
   不能拿它当依据；本仓应由使用者裁决。
3. `[DESIGN-MEM-001]` 落点漂移的订正范围（是否连带改 `scripts/memory/clear-memory.js`）未核。
4. 记忆导出物是否应加密：`works/data/khy/credentials` 有权限保全要求（`DATA-LOCATIONS.protected`），
   记忆没有；是否需要同等保护待裁决。
5. 本文新增的文档孪生（`docs/html/.../[DESIGN-MEM-009] ....html`）本次**未生成**——
   生成器 `scripts/docs/build_docs_site.js` 是全站重建（会重写数千个孪生与 `nav-data.js`），
   超出本次改动授权范围；落地时按常规 `docs:build` 一并生成。

---

## 11. 变更日志

- 2026-10-26 初版。依据 Today APK 解包结论（UM/ING/F/SEC/DEP 系列）与本仓实测取证
  （`memdir.js:43-67` CRLF 解析、`restore-memory.js:21-23` 硬编码、`memoryBridge.js:48-260`
  第二套实现、`Get-Item works\data\khy\memory` 的 Junction 事实、`check-repo-layout` 的
  `root-shadow-dir` 报错、`jest tests/memdirRelevance.test.js` 10/10）写成。无运行代码改动。
