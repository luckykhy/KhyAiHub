# trajectoryReplay — 轨迹录制与确定性回放（D2 业务上下文）

> 一句话定位：把一次会话的每个工具轮次**完整**记进账本（不截断 params），再在无 AI 的
> 前提下按录制顺序重放，用 sha256 作为**唯一裁判**判定产物是否复现。回放只能收紧，
> 不能伪造录制事实：哈希不符即 HALT，绝不静默"尽力修复"。
> 设计真源：`[DESIGN-ARCH-048]`（四阶段：账本 → 环境指纹 → 便携包 → 引擎）与
> `[DESIGN-ARCH-049]`（可选 AI 修复桥 A）。

## 逐成员

| 文件 | 行 | 导出 | 角色 | 出边 | 测试/例 |
|---|---|---|---|---|---|
| `tierRegistry.js` | 120 | 7 | 三档分层唯一真源（FILE / SHELL / NETWORK_AI） | `src/tools/_writeToolNames`（**未映射域**） | 13 |
| `artifactHash.js` | 65 | 5 | 内容与产物哈希的统一封装（录制侧与校验侧算同一个摘要） | `src/services/sourceSnapshotCrypto`（D1） | 22 |
| `envFingerprint.js` | 156 | 6 | 环境指纹采集与比对（回放前的"相对静态环境"闸门） | 仅内建模块 | 22 |
| `replayLedger.js` | 389 | 12 | 录制侧真源：JSONL 边车账本 + 内容库 + 延迟写队列 | `sessionPersistence`（D1）、`utils/dataHome`（D3） | 19 |
| `replayBundle.js` | 278 | 8 | 自包含便携包（manifest + 账本原文 + blob + env + 可选链） | `sessionPersistence`（D1）、`utils/dataHome`（D3）、`trajectoryProvenance/traceChain`（D2） | 14 |
| `replayEngine.js` | 382 | 7 | 回放引擎：按档门控 + 六条防呆 + 分歧立即 HALT | `toolCalling`（D1，惰性） | 18 |
| `replayStepPolicy.js` | 88 | 6 | 步进策略纯叶子（超时 / SHELL 预批准 / 盖戳 / 应答器） | `execApproval`（D1，惰性 ×2 站点） | 13 |
| `replayArtifactGuards.js` | 96 | 2 | 前置守卫与后置校验纯叶子（防呆⑥与③） | 仅 `fs` + 同目录 `./artifactHash` | 19 |
| `index.js` | 31 | 6 | 桶（再导出六个命名空间） | 全部同目录 | 7 |
| **合计** | **1605** | **59** | 9 个源文件 | | **147 例 / 396 断言 / 0 skip** |

两个 `_` 前缀的叶子（`replayArtifactGuards`、`replayStepPolicy`）是为把 `replayEngine.js`
压进 400 行纳管上限而**行为中性**抽出的，引擎再 require 回来并重新绑定同名符号，
公开面逐字节不变；它们**不经桶暴露**（钉住于 `内部纯叶子 replayArtifactGuards/replayStepPolicy 不经桶暴露（当前表面如实钉住）`）。

## 扇入（谁在用）

非测试消费者 **6 个文件 / 11 个 require 站点**（按「直接 require 本单元路径」计，含文件形态与目录形态）：

| 消费者 | 域 | 用了什么 |
|---|---|---|
| `src/cli/handlers/replay.js` | D1 | `replayBundle` `replayEngine` `replayLedger` `tierRegistry` |
| `src/cli/handlers/guide.js` | D1 | `replayBundle` `replayLedger` |
| `src/services/tool/toolUseLoopCore.js` | D1（作者 in-flight） | `replayLedger.recordToolTurn`（两个站点：录制热路径） |
| `src/services/domain/trajectory/trajectoryGuide/mapAuthor.js` | D2 | `artifactHash` `tierRegistry` |
| `src/services/domain/eval/guiEval/recordingCollector.js` | D2 | `artifactHash`（惰性 + try/catch） |
| `src/services/domain/eval/guiEval/checkpointVerifier.js` | D2 | `artifactHash`（惰性 + try/catch） |

实测：**桶 `index.js` 在生产代码里零消费者**——六个消费者全部直连成员文件。桶仍保留，
因为它是「本单元公开面」的机器可读清单（`barrel 恰导出 6 个子模块命名空间，不多不少`）。

## 裁决契约（每条都由同目录测试钉住）

1. **三档全覆盖且冻结**：`classify` 只可能返回三档或 `UNKNOWN`，`effectiveTier` 把
   `UNKNOWN` 折叠成 **SHELL**（保守：要审批，绝不静默按 FILE 自动重放）——
   `effectiveTier 恒三档之一，任何输入都不跳出枚举（total 契约）`、
   `Read 不在 FILE 集（只读工具）：classify 判 UNKNOWN、effectiveTier 保守降 SHELL`。
   注意最后一条：`Read` 这类只读工具落在 `UNKNOWN`→SHELL，**不在 FILE 集**，
   档位表管的是"变更文件的回合"，不是"读"。
2. **FILE 集派生自单一真源**：`tools/_writeToolNames` 的捕获白名单 ∪ {applypatch, scaffoldfiles}
   ——`FILE_TOOLS 非空且恰为捕获白名单加 applypatch 与 scaffoldfiles（派生自单一真源）`。
   捕获侧刻意跳过这两个多文件工具，但"跑过它们的回合"仍是改文件的回合，两轴正交。
3. **录制只存哈希，字节另存内容库**：账本条目带 `paramsHash`/`writeDiff`/`artifacts[].sha256`，
   after 字节按内容寻址落 `trajectory_replay/<sessionId>/content/<sha256>`，因此**文件在导出前被删掉也还能复现**——
   `内容库按 sha256 存 after 字节；delete（after 空）不新增 blob`。
4. **账本是 best-effort，绝不影响业务**：`recordToolTurn` 全程 try/catch，缺 sessionId/name
   返回结构化错误而不是抛——`recordToolTurn 缺 sessionId 或 name 返回结构化错误而非抛`。
5. **写盘默认延迟、读并轨**：`record` 只入队，`read()` 把未刷条目与盘上内容合并，
   所以"记完立刻读"永远自洽；`flush()` 之后队列清零——
   `异步默认模式：record 只入队，read 并轨未刷条目，flush() 后落盘且队列清零`。
   导出与进程退出走 `_drainSync()`（`drainSync 同步排空队列到磁盘（供导出与进程退出消费者）`），
   批量 32 行或 debounce 到期即刷（`replayLedger.js:54`、`replayLedger.js:68`）。
6. **seq 的两种语义**：自动模式单调 0→1→…，**显式传 seq 原样采用且不推进计数器**——
   `seq 自动单调 0→1，显式 seq 原样采用且不推进计数器`。`verifyLedger` 因此把断号当坏条目。
7. **空包也是合法包**：`exportBundle` 对从未录制的 sessionId 返回 `ok:true` 且 steps 为空
   （`replayBundle.js:91-166`）——`exportBundle 对从未录制的会话产出空 steps 的合法空包（当前契约如实钉住，见头部注释）`。
   这是**当前契约**而非期望：调用方不能拿 `ok` 当"确实录到过东西"。
8. **便携包的篡改检测**：账本哈希、blob 哈希、schema 三关逐条报错——
   `verifyBundle 对干净包 ok，blob 被篡改报哈希不符，blob 被删报缺失且无法复现路径`、
   `verifyBundle 检测 ledger.jsonl 被改：报账本被篡改`。
9. **环境门默认拒绝**：`compare` 忽略 `capturedAt`，任何其它字段分歧即 `status:'env-mismatch'` 且**零步执行**，
   只有 `opts.force` 才继续——`防呆⑤ 环境分歧默认拒绝：status=env-mismatch、diffs 列全、零步执行`。
10. **NETWORK_AI 永不重放**：非确定性问题不假装复现——
    `防呆② NETWORK_AI 步永不重放：skipped 且理由为不可确定性复现`。
11. **SHELL 要审批**：命中 `KHY_REPLAY_SHELL_ALLOW`/`opts.preApprovedShell` 模式，或 `opts.confirm`
    返回真值才执行；confirm 抛错算未批准——`防呆④ SHELL 未预批准跳过；confirm 返回假值或抛错都算未批准`。
    模式语义直接借用 `execApproval.matchCommandPattern`（精确命中、裸前缀不命中、星号通配命中：
    `SHELL 预批准命中后穿透审批门抵达前置守卫（理由变为产物状态而非未批准）`）。
12. **前置分歧即 HALT**：改/删前比对 `beforeHash` 与盘上实际，不一致就停并回 `divergedAt`，
    绝不覆盖未录制的数据——`防呆③/⑥ 前置分歧立即 HALT：status=diverged、divergedAt=seq、verify 携 expected/actual`、
    `delete 目标仍存在且 beforeHash 不符：halt 防误删未录制数据`。已在录制终态则判 `satisfied` 跳过。
13. **AI 修复桥不改裁判**：`opts.repair` 缺席/返回 null/`attempted:false` 三态都回落纯确定性路径；
    命中与否**只由重跑 `_verifyArtifacts` 决定**——`_maybeRepair 修复后哈希校验通过判 repaired——sha256 仍是唯一裁判`、
    `_maybeRepair 零回归门：无钩子/钩子返回 null/declined 三态都回落纯 048 路径（返回 null）`。
14. **每步恰好回调一次**，回调抛错被吞不影响报告——`onStep 每步恰好回调一次，回调抛错被吞不影响报告`。

## 门控（全部 env 可读、零硬编码）

| 变量 | 默认 | 语义 | 读处 |
|---|---|---|---|
| `KHY_REPLAY_LEDGER_FLUSH_MS` | 150 | 账本延迟刷盘 debounce（`parseInt` 后 `Math.max(0,…)`） | `replayLedger.js:50` |
| `KHY_REPLAY_LEDGER_SYNC` | 关 | 强制同步落盘；真值集合是 `1/on/true/yes` | `replayLedger.js:57` |
| `KHY_REPLAY_CAPTURE_CONTENT` | 开 | 内容库 blob 捕获；假值集合是 `0/off/false/no` | `replayLedger.js:153`、`replayBundle.js:36` |
| `KHY_REPLAY_STEP_TIMEOUT_MS` | 120000 | 单步活动式超时（opts 优先于 env，非正数回退默认） | `replayStepPolicy.js:18` |
| `KHY_REPLAY_SHELL_ALLOW` | 空 | SHELL 预批准模式，按换行/逗号切分 | `replayStepPolicy.js:26` |
| `KHY_REPLAY_L2_CONFIRM` | `YES` | 回放应答器供给的 L2 键入确认词（**构造时**读 env） | `replayStepPolicy.js:76` |
| `KHY_REPLAY_FINGERPRINT_TOOLS` | `node` | 工具链探针列表，逗号或空白切分 | `envFingerprint.js:29` |
| `KHY_REPLAY_PROBE_TIMEOUT_MS` | 3000 | 单个探针超时（防挂死工具拖住 capture） | `envFingerprint.js:38` |

同一单元里存在**两套开关词汇**：`_captureContentEnabled()`（假值集合 `0/off/false/no`，
在 `replayLedger.js:152` 与 `replayBundle.js:35` **逐字重复两份**）与
`_ledgerSyncForced()`（真值集合 `1/on/true/yes`）。语义确实不同（一个是"默认可关"，
一个是"默认关可开"），所以不是同一个 bug，但词汇表重复且分叉——与第 27 批
`_OFF`/`utils/isOffValue` 漂移同族，见下文「登记的偏差」。

## 登记的偏差与缺陷（只登记，未自行动手）

- **B28-S5｜回放会替人键入 L2 确认词**（安全相关，需人裁决）。`replayStepPolicy.js:75-78`
  的应答器恒返 `{behavior:'allow', typed:'YES'}`，而网关的 L2 门只比对确认串
  （`src/services/domain/system/syscallGateway/approvalRouter.js:147`）。实测把该应答器经 `makeControlPrompter` 接到
  `route()`：`delete/project` 判 L2 时裁决为 `user-allow`，
  reasons 为「用户键入确认串「YES」，放行本次 L2」——**没有人键过任何东西**。
  对照：同一条目若交互器返回空串（回车）则 `deny` + `confirm-mismatch`。
  影响面被三样东西限制住：只有引擎决定重放的步才走到这里（NETWORK_AI 提前 skip）、
  FILE 档只重放录制过的路径、前置守卫仍会因 `beforeHash` 分歧 HALT。
  但这与 `src/services/domain/system/syscallGateway/approvalRouter.js:12`「非交互环境一律 fail-closed 拒绝」和红线「L2 必须人键入」
  的表述直接冲突。改不改、把"回放"定义为人的授权载体还是定义为绕过，属人的裁决 → 任务 #17。
- **B28-S6｜`_preconditionCheck` 非 total**：`replayArtifactGuards.js:18-19` 读
  `step.artifacts` 时无 try/catch，传 null 直接 `TypeError`。引擎调用点恒传对象，
  流水线内不可达；已由 `对 null 入参抛 TypeError（实测非 total，如实钉住）` 钉住实测行为。
- **B28-S7｜`hashCanonical` 名不符实**：只做 `JSON.stringify` 原样序列化，**不排序键**
  （`replayLedger.js`/`artifactHash.js:52-62`），所以键序不同哈希不同
  （`hashCanonical 键序不同则哈希不同（非排序规范化，仅 JSON.stringify 原样）`）。
  录制侧与校验侧算的是同一个对象，因此不产生误判；但任何"跨来源比 canonical 哈希"的
  设想都不成立。
- **B28-S8｜`compare` 把 `null` 与 `undefined` 判为分歧且两侧都显示 `null`**
  （`envFingerprint.js:127-128`）：`JSON.stringify(undefined)` 是 `undefined` 而非 `'null'`，
  于是不相等；而 diff 项两侧都被 `pa == null ? null : pa` 归一成 `null`，报出来的分歧**读起来像没分歧**。
  已由 `…其中 null vs undefined 也算分歧且两侧都显示 null（实测缺陷行为）` 钉住。
- **B28-S9｜`sha256Hex` 是唯一不 fail-soft 的导出**：`artifactHash.js:64` 原样透传上游函数，
  对 null 抛 `TypeError`，与同文件四个包装函数口径不同（`sha256Hex 透传原函数对 null 抛 TypeError（不包 fail-soft，与四包装函数不同）`）。
- **B28-S10｜两套 off 词汇 + 一份逐字重复**（见上文门控表末段）：统一成
  `utils/isOffValue` 与否属人的决定 → 任务 #17。

## 已知边界

1. `exportBundle` 会先 `replayLedger.drainSync()` 再拷贝账本原文，所以便携包不会漏掉队列里的条目；
   但**内容库是同步写、账本行是异步写**（`replayLedger.js:177-179` 注释是这条不对称的登记处），
   极端情况下 blob 已在、行还没刷——由 `drainSync` 兜住，代价是多一次同步 I/O。
2. `KHY_REPLAY_CAPTURE_CONTENT=off` 时包里的 `content/` 为空，`verifyBundle` 会对每个
   FILE 步报「缺内容 blob」。**这是设计内的诚实**：没抓字节就说复现不了，不放行。
3. `replayEngine` 经 `../../../toolCalling` 惰性 require 拿 `executeTool`（`replayEngine.js:46`）——
   这是 D2→D1 的既有反向边，本单元不修（见清单 `_deviation_note`）。
4. 环境门的 `cwd` 参与比对：同一份包在另一个工作目录重放即判 `env-mismatch`。
   要跨目录复现，须显式给 `opts.force`。
5. `_replayControlResponder` 在**构造时**读 `KHY_REPLAY_L2_CONFIRM`（`replayStepPolicy.js:76`），
   之后再改 env 不影响已构造的应答器——测试注入必须在构造前设值。

## 测试怎么跑

```bash
# 同目录共置测试（node:test 方言，147 例 / 0 skip / 全绿）
node --test services/backend/src/services/domain/trajectory/trajectoryReplay/*.test.js
```

`replayBundle.test.js` 会在文件头把 `KHY_PROJECT_DATA_HOME` 重定向到临时目录，并在
`after()` 里 `rmSync`；单独跑别的文件不会碰真实数据根。

单元外还有 **11 份测试引用本单元**（实测合计 **75 例 / 0 fail**）：6 份 node:test 方言
（`tests/services/trajectoryReplay/p{1,2,3,4}*.test.js`、`e2eReplay.test.js`、
`tests/cli/handlers/replayHandler.test.js`）可直跑；5 份 jest 方言本环境无 jest，
需按 `khy.module.json` 的 `_outside_test_note` 记的口径复跑才能拿到真判据。
注意镜像树里那份同名的 `tests/services/domain/trajectory/trajectoryReplay/tierRegistry.test.js`
是**另一份**（jest 方言 / 17 例），别与共置那份（node:test / 13 例）混为一谈。
