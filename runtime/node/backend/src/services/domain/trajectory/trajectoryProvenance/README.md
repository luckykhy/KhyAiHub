# trajectoryProvenance — 轨迹溯源与防篡改链（D2 业务上下文）

> 一句话定位：当 Khyos 经**外部 agent 中转**（codex / claude-code / 通用 relay）时，
> 外来正文、thinking 与工具调用请求会流进 Khyos 自己的对话轨迹。本单元给每一条轨迹条目
> 盖上「谁产的、可信到什么程度」的信封 `_khyTrace`，把整条轨迹钉进一条 sha256 prevHash→hash
> 边车链，并用**零模型调用**的确定性词库核对「正文声称 vs 本地工具日志」。
> 设计真源：`[DESIGN-ARCH-047]`（PHASE 1 标签 / 2 链 / 3 隔离 / 4 核对 / 5 双投影与 `khy trace`）。

## 本单元守的是什么

威胁模型是**轨迹投毒**，不是"模型出错"：

- 中转正文可以声称「我已经删了旧表」而本地从未跑过任何删除工具 → 由 `claimReconciler` 抓
  （渲染成 `⚠ unverified claim`），不是靠"再问一次模型"；
- 中转的工具调用请求可以被照单全收地自动批准执行 → 由 `quarantinePolicy` 在执行前裁决
  `allow / gate / quarantine`；
- 事后的 transcript 可以被改写 → 由 `traceChain` 的边车哈希链在 `verify()` 时当场暴露。

**两条相反的 fail 方向是本单元的核心设计，不是不一致**：

| 侧 | 缺信息时的默认 | 真源 | 为什么 |
|---|---|---|---|
| 标签侧 | fail-**SAFE-TO-OURS**：归 `khy-local` / `verified` | `khyTrace.js:62-65`、`provenanceClassifier.js:52` | 隔离与核对按 `producer != khy-local` 触发，宁可少防也不可把自家内容错标成外部；漏标方向只能偏"我方" |
| 执行侧 | fail-**CLOSED**：非 `khy-local` 的一切（含未知/缺省 producer）都当中转，须过闸 | `quarantinePolicy.js:35-37` | 执行面错了不可回滚 |

于是同一个未知 producer 串，`khyTrace.isRelayed('totally-unknown')` 是 **false**，
而 `quarantinePolicy.decide({producer:'totally-unknown'})` 判 **quarantine**。
这条不对称被 `khyTrace.test.js` 与 `quarantinePolicy.test.js` **各自钉住**，改任何一侧都会红。

## 逐成员

| 文件 | 行 | 导出 | 角色 | 出边 |
|---|---|---|---|---|
| `khyTrace.js` | 157 | 10 | `_khyTrace` 信封 schema 唯一真源（producer/trust/kind 枚举 + 盖戳 + 取值兜底） | 无（纯函数、零 IO） |
| `provenanceClassifier.js` | 71 | 2 | 入站边界按 adapter/provider/serviceType 判 producer 与初始 trust | 同目录 `./khyTrace` |
| `quarantinePolicy.js` | 144 | 5 | **安全核心**：中转工具调用的 allow/gate/quarantine 纯裁决 + 防呆④不变式 | 同目录 `./khyTrace` |
| `traceChain.js` | 254 | 10 | 防篡改边车哈希链（`<session>.trace-chain.json`），含 `verifyAgainstEntries` 交叉校验 | `src/utils/atomicWriteJson`（D3）+ 内建 `crypto/fs/path` |
| `claimNegation.js` | 83 | 3 | 否定守卫纯叶子（三扇窗口 + off 词表 + 全局克隆匹配，绝不污染冻结词库的 RegExp 状态） | 仅 `process.env` 与自身正则 |
| `claimReconciler.js` | 336 | 8 | 版本化中英双语「动词→工具族」词库（6 族）+ 工具点名核对（29 名），确定性、fail-**OPEN** | 同目录 `./claimNegation` |
| `traceProjection.js` | 95 | 5 | 人读投影：内联标签、回放行、矛盾标签、链状态页脚 | 同目录 `./khyTrace` |
| `index.js` | 36 | 21 | 桶（spread `khyTrace` 顶层 + 5 个命名空间再导出） | 全部同目录 |
| **合计** | **1176** | — | 8 个源文件 | 外部出边**只有 1 条**（D3），**零 D2→D1 反向边** |

## 扇入（谁在用）

**直接 require 本单元：7 个文件 / 10 个站点**（探针按「解析后的落点是否真在单元目录内」判定，
故兄弟相对写法 `require('../trajectoryProvenance/traceChain')` 与带 `.js` 后缀的写法都算数——
只用字符串前缀匹配的探针会同时漏掉这两类，本数字经一次形态修正后复测）：

| 消费者 | 域 | 站点 | 用了什么 |
|---|---|---|---|
| `src/services/trajectoryProvenance/index.js` | D1（自动生成 shim） | :4 | 整包再导出（目录形态） |
| `src/cli/handlers/trace.js` | D1 | :24, :25 | `khyTrace.js`（TRUST）+ `traceProjection.js` |
| `src/cli/aiGatewayGenerateHelpers.js` | D1 | :649 | `claimReconciler.reconcileToolMentions`（惰性） |
| `src/services/answerVerifier.js` | D1 | :151 | `claimReconciler.reconcile`（惰性） |
| `src/services/gateway/adapters/codexAdapter.js` | D1 | :2221 | `quarantinePolicy`（裁决 + `assertNoAutoDangerous`） |
| `src/services/sessionPersistence.js` | D1 | :508, :545, :643 | `khyTrace` 盖戳、`traceChain` 写链与验链 |
| `src/services/domain/trajectory/trajectoryReplay/replayBundle.js` | D2 | :141 | `traceChain.chainPathFor`（便携包顺带拷链，try/catch） |

另有 **2 个文件经 D1 shim 间接消费**（`src/cli/aiChatCore.js:4718` 取 `classify`/`PRODUCER`、
`src/cli/tui/ink-components/ToolLines.js:1055` 取 `projection.inlineLabel`）——
它们不指向本单元路径，所以**不计入 fanIn**，但说明桶并非无人使用。

## 裁决契约（每条都由同目录测试钉住）

1. **信封不可缺**：`traceOf()` 永不返回 null，缺/畸形一律回 `khy-local`/`verified` 的新信封
   （`khyTrace.js:132-137`）。链、投影、核对三处下游因此不必各自兜底。
2. **未知 producer 坍缩为 `relay` + `producerId`=原值**，热路径永不抛（`normalizeProducer`）；
   但 `isTrace()` **只校验 producer 与 trust**，不校验 `kind`/`v`（实测钉住，见「登记的偏差」）。
3. **链是边车，不折进 JSONL**：`CHAIN_EXT = '.trace-chain.json'` 与 `<session>.jsonl` 并列。
   理由写在 `traceChain.js:6-24`——JSONL 是多消费者 append-only，逐行嵌 prevHash 会把每个
   reader 耦合进链算，且单行损坏污染整链重建。
   ⚠ 这个"并列"设计有一个必须同时被守住的后果：**边车不是会话**，任何枚举 sessions 目录
   的消费者都要排除它，否则产出 `sessionId: undefined` 的幽灵行（`khy trace list` 的
   `TypeError` 即源于此，2026-09-29 修在 `sessionPersistence._collectSnapshotFiles`，
   并由 `tests/services/sessionPersistence.sidecar.test.js` 用 `traceChain.CHAIN_EXT`
   反推文件名把两者钉在一起——将来改扩展名会先红测试，而不是在线上崩）。
4. **封印 `seal` 只在活会话内有意义**：进程私有盐（`SEAL_SALT = crypto.randomBytes(16)`），
   跨进程读不出，所以 `verify()` **刻意只用确定性 sha256 链**，绝不因跨进程算不出 seal 而误报断链。
5. **链的写入口只有一个且 fail-soft**：`append()` 把一切异常折成 `{ok:false,error}` 返回，
   绝不抛给热路径；`sessionPersistence.js:544-556` 因此只在 try 里调用它。
   但"不抛"不等于"没事"——见「登记的偏差」里链静默重启那一条。
6. **隔离闸默认 ON**，仅显式 `0/false/off/no` 关闭（`quarantinePolicy.js:43-51`）；
   逃生口放行时 trust 仍是 **CLAIMED 而不是 VERIFIED**，即"放行"不改写真相。
7. **`preApproved → VERIFIED`、`interactive → GATE`、非交互无批准 → QUARANTINE**：
   `decide` 的五分支决策矩阵连 `trust` 一起钉（trust 是安全叙事的一部分，不是附属字段）。
8. **防呆④不变式**：`assertNoAutoDangerous({producer, enablingDangerous, gateEnabled})`
   在「中转 + 闸开 + 想自动开全局 dangerous mode」时**抛错阻断**。
   `codexAdapter.js:2232-2247` 的 `willEnableDangerous = !gateEnabled && !wasDangerous`
   使正常路径不可能触发，这段守卫锁的是"日后改动把它接回去"。
   对应的结构守卫在 `tests/services/trajectoryProvenance/p3Quarantine.test.js`，
   2026-09-29 由单行字面量正则改为**形态无关 + 调用点唯一性**（旧写法对花括号块形态是瞎的，
   既会恒红也会恒绿）。
9. **核对是咨询性证据，姿态 fail-OPEN**：`reconcile`/`reconcileToolMentions` 任何异常都返回
   空矛盾数组，绝不阻断 turn、绝不改模型正文（`claimReconciler.js:129,165-168,282,321-324`）。
   只应对 `producer != khy-local` 的正文跑，由调用方门控。
10. **否定守卫三扇窗口**：紧贴 1 字（未/没/无/毋/勿/别/不）、4 字内多字否定（没有/无需/尚未…）、
    英文否定 16 字内。窗口外即假阴性——这是设计内的诚实边界，已按实测钉住。
11. **词库版本化且冻结**：`LEXICON_VERSION = 1`、6 个动作族、**30** 个点名工具名
    （`MENTION_TOOL_NAMES.length` 实测 30，源码头注释与历史文档写的 29 是**过时口径**），
    且共置测试断言 `_firstUnnegatedMatch` 的克隆**不推进被冻结词库的 RegExp 状态**。
12. **单字形契约**：`replayRow()` 把字形只放进 `glyph`，`label` **不带**前导字形——
    因为 `cli/handlers/trace.js:161/164` 把 glyph 当独立列再拼 label，带字形就渲染成 `⟳ ⟳`。
    `inlineLabel()` 反过来**必须保留**字形（`ToolLines.js` 没有独立字形列）。
    契约真源是 `tests/cli/traceProjectionSingleGlyph.test.js`。

## 门控（全部 env 可读、零硬编码）

| 变量 | 默认 | 语义 | 读处 |
|---|---|---|---|
| `KHY_TRAJECTORY_QUARANTINE` | **开** | 中转调用隔离闸；仅 `0/false/off/no` 关闭（四次比较的拼写法） | `quarantinePolicy.js:43-51` |
| `KHY_CLAIM_NEGATION_GUARD` | **开** | 声称抽取的否定守卫；off 词表是 `Set(['0','false','off','no'])` | `claimNegation.js:17-25` |
| `KHY_TOOL_MENTION_GUARD` | **开** | 工具点名核对；off 词表是**第二份逐字重复**的 `Set([...])` | `claimReconciler.js:229-237` |

三处开关语义相同（默认可关），词表却写了**三份、两种形态**（两份 Set + 一份四元 `||` 比较），
且与仓内 252 个文件里的同族 `new Set(['0','false','off','no'])` 拼写并存
（实测计数，见「登记的偏差」）。

## 登记的偏差与缺陷（只登记，未自行动手）

见同目录 `khy.module.json` 的 `registered_defects`（B29-S1…），全部为**实测**结论，
处置权在人 → 任务 #17。其中安全相关的两条：

- **分类器认不出 `claude_code` 下划线形态** → 判 `khy-local`，方向恰是铁律最怕的
  「外部内容漏标为我方」（实测 `classifyProducer({adapter:'claude_code'})` → `khy-local`，
  而 `claude-code` / `claudecode` 两种形态都正确判 `claude-code`）。
- **边车链可被"清空"而非"改坏"**：截断/删空链文件后 `verify()` 仍报 `ok:true`（空链是完整链），
  截掉末尾记录同样检测不到。检测删行只能靠 `verifyAgainstEntries` 与 transcript 交叉比对。

## 测试怎么跑

```bash
cd services/backend
# 同目录共置（8 支）
node --test src/services/domain/trajectory/trajectoryProvenance/*.test.js
# 单元外按 PHASE 分层的 7 支
node --test tests/services/trajectoryProvenance/p1Labels.test.js \
            tests/services/trajectoryProvenance/p2Chain.test.js \
            tests/services/trajectoryProvenance/p3Quarantine.test.js \
            tests/services/trajectoryProvenance/p4Reconcile.test.js \
            tests/services/trajectoryProvenance/p5Trace.test.js \
            tests/cli/traceProjectionSingleGlyph.test.js \
            tests/atomicWriteMigration.test.js
```

⚠ `node --test` 在本便携工具链（实际 spawn 的是 Node 22）下**不接受目录参数**——
传目录会被当成模块解析，报 `Cannot find module` 并伪装成 `not ok`。一律给显式文件路径。

⚠ 涉及会话/权限的套件在 require 持久化模块**之前**必须钉 `KHY_PROJECT_DATA_HOME`
（`dataHome` 首次解析即缓存）。真实数据根里有 350 个会话与它们的边车链，
任何"跑真实根全绿"的结论都可能是空转或污染。
