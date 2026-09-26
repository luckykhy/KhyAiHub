# [DESIGN-ARCH-153] khy 自知面对齐规范

> **状态**：已实施（设计 + 测试 + 对齐三件套同轮交付；版本 bump / 推送留人工）
> **范围**：`services/backend/src/services/selfProfile.js`（新增分面 SSOT）、`src/tools/KhySelfTool/index.js`、`src/cli/routerDispatchTail.js`（`case 'self'`）、`src/constants/commandSchema.js`（`self` 子命令表）、`src/tools/toolProfile.js`（`coding`/`minimal`/`explore` 授权）、`src/services/selfAuditRegistry.js`（#7 证据锚点）、`src/tools/_baseTool.js` + `src/tools/PlanTool.js`（加载失败修复）
> **上游依赖**：无新增 IPC / 无新增门控；复用 `selfLocation`、`commandCatalog`、`selfAuditRegistry`、`selfAuditVerifier` 四个既有 SSOT
> **调研指针**：`[DESIGN-ARCH-020]`（架构债治理报告，selfProfile 条目）、`[DESIGN-ARCH-051]`（selfProfile 惰性 require）、`[DESIGN-ARCH-111]`（规则遵守保障）、`[DESIGN-ARCH-113]`（三模态反馈契约）、`[DESIGN-AGENT-002]`（工具授权矩阵）、`[MGMT-STD-006]` V6（自我认知验收）
> **模板合规**：非借鉴类，B-P2 据实填「不适用」（本设计不借鉴外部项目实现，全部为仓内既有 SSOT 的重组与接线）

---

## 0. 一句话结论

「khyself 工具过时了」不是一句感觉，是**五处可复核的实证缺陷**；其中两处会让模型**自报假事实**或**被指挥去调一个不在清单里的工具**。修法不是重写工具，而是把「自知」收敛成**一份分面 SSOT**，让 `KhySelf`（agent 面）与 `/self`（人类面）从同一份数据渲染——即「实现对齐」。

### 病灶表格

| # | 症状 | 根因 | 证据（可复核） |
|---|------|------|------|
| D1 | 活的系统提示里 `#7` 被标成 **·核验失败**，模型据此对外宣称自己的缓解机制没落地 | `selfAuditRegistry.js:135-137` 的证据锚点写 `commandCatalog/commandCatalog`，而该模块早已迁到 `services/domain/catalog/`；`selfAuditVerifier._verifyItem` 以 `path.join(__dirname, name + '.js')`（`__dirname` = `services/`）解析 → 落到不存在的 `services/commandCatalog/commandCatalog.js` | `node --test tests/services/selfAuditVerifier.test.js` → `1 fail`：`#7 verified against the live codebase (reason: 模块缺失:services/commandCatalog/commandCatalog.js)`；`selfProfile.formatForSystemPrompt()` 实跑输出含 `#7 … ·核验失败` |
| D2 | Claude 直连模式下模型**看不到** `KhySelf`，而系统提示仍在教它调 | `claudeAdapter.js:1975` 走 `assembleToolPool(undefined, 'coding')`；`toolProfile.js` 的 `coding` 是白名单，`KhySelf` 不在其中（同类 `khyos` 已在 `:82` 显式授予） | 探针：`coding` 池 37 个工具，`KhySelf -> HIDDEN`；无 profile 路径 181 个，`KhySelf -> VISIBLE`。而 `selfAuditRegistry.js:242` 注入的协议原文是「1) 调 KhySelf(action:self_audit_verify) 取逐项证据」 |
| D3 | 两个自知面**互不覆盖**，两个 action 枚举各自手维护 | `/self` 子命令 = `capabilities｜boundaries｜runtime`（`commandSchema.js:538`），`KhySelf` action = `commands｜location｜self_audit｜self_audit_verify｜all`；并集 8 个分面、交集只有 `location`；无 SSOT、无 parity 测试 | 实跑两侧枚举穷举对比，见 §1.3 |
| D4 | 门控登记漂移（约定缺口，非守卫失败） | `KHY_SELF_LOCATION` / `KHY_COMMAND_CATALOG` / `KHY_CTX_INSPECT` / `KHY_INSIGHTS` 只读 env；同族 `KHY_SELF_AUDIT_AWARENESS` / `KHY_AUDIT_DYNAMIC_VERIFY` / `KHY_SELF_UPDATE` 已登记 `flagRegistry.js` | `check-flag-registry.js` 今日 **PASS**（结构性守卫，不校验完备性）→ 本项为**约定漂移**，本设计**只记录不修**（见 §5 不做清单） |
| D5 | `PlanTool.js` **从未加载成功**（189/190），自知面自报的工具数因此偏差 | `PlanTool.js:93` `module.exports = defineTool({...})` 返回**冻结对象**，`:175` 又 `module.exports._getPlan = …` → 严格模式下抛 `Cannot add property _getPlan, object is not extensible`，被注册器 fail-soft 吞成一行 stderr | 探针：每次加载必现 `[ToolRegistry] Failed to load PlanTool.js: Cannot add property _getPlan, object is not extensible`；`formatBrief` 自报的 `Tools:` 计数即来自该注册表 |

> **共同根因**：`commandCatalog`（迁入 `domain/catalog/`）与 `toolCallingPermissions`（迁入 `tool/`）**都是目录重组后留下的过期引用**。D1 与 `check-permission-invariants` 今日那条 `perm-mode-list-missing` 错误同属一类：**模块搬家，引用没跟着搬，也没有机器可读的映射来发现**。这正是 `RUNTIME-009`「删除先报部位」里点明的风险——「本仓近 200 份设计文档与代码之间没有机器可读的映射」。

---

## 1. 现状实证（file:line 可复核）

### 1.1 D1 —— 过期锚点如何变成对外假话

```
selfAuditRegistry.js:136-139
  modules: ['commandOverlapAudit', 'commandCatalog/commandCatalog']   ← 注释还写着 services/commandCatalog/commandCatalog.js
        │
        ▼  selfAuditVerifier.js:128
  path.join(__dirname /* = services/ */, 'commandCatalog/commandCatalog' + '.js')
        │
        ▼
  services/commandCatalog/commandCatalog.js   ← MISSING（真身在 services/domain/catalog/commandCatalog/commandCatalog.js）
        │
        ▼  verified:false → reason '模块缺失:…'
selfAuditRegistry.formatForSystemPrompt  →  徽标 ' ·核验失败'
        │
        ▼
  系统提示（实测 4020 字符）  →  模型读到「#7 的缓解机制核验失败」
```

这条链**只有在「运行时核验」存在时才可见**——而运行时核验存在，测试却红了没被当回事。**D1 的修法不止是改一行路径，还要补一条让这一类漂移永久可机检的测试**（§4.1）。

### 1.2 D2 —— 提示词与工具清单互相矛盾

```
selfAuditRegistry.js:242   注入：「被质疑真实性时:1) 调 KhySelf(action:self_audit_verify) 取逐项证据」
claudeAdapter.js:1975      assembleToolPool(undefined, 'coding')
toolProfile.js:23-85       coding.tools = [...37 个白名单...]   ← 无 'KhySelf'（'khyos' 在 :82）
        ⇒ 模型被指挥去调一个它清单里没有的工具
```

`GATEWAY_CLAUDE_MODE` 默认 `auto`（`claudeAdapter.js:73`）＝**有 API key 就走直连**。也就是说：**装了 key 的机器上，这条矛盾默认成立**。这是一个「声明面与执行面不一致」的典型形态，与 `RUNTIME-010` A2-4「声明面收窄必须有执行面强制与之对应」是同一族问题，只是方向相反——这里是**声明面在承诺、执行面在否认**。

### 1.3 D3 —— 两个面的镜像清单

| 分面（能力） | `/self`（人类面） | `KhySelf`（agent 面） |
|---|---|---|
| identity（名称/版本/定位/性格） | ✅ 默认输出含 | ❌ |
| capabilities（10 个能力域） | ✅ `capabilities` | ❌ |
| boundaries（5 条边界） | ✅ `boundaries` | ❌ |
| runtime（平台/Node/Python/cwd/通道/推理/学习模式） | ✅ `runtime` | ❌ |
| location（安装根/自身源码/dataHome/installKind） | ⚠️ 仅混在默认输出里 | ✅ `location` |
| commands（命令目录，可搜索） | ❌（要去 `/features`） | ✅ `commands` |
| self_audit | ❌ | ✅ `self_audit` |
| self_audit_verify | ❌ | ✅ `self_audit_verify` |

**并集 8 个分面，交集 1 个。** 后果具体：
- agent 回答不了「你有哪些能力域 / 你的边界是什么」——只能靠系统提示里那段**截断**的块；`boundaries` 只在提示里以一行一条出现，`capabilities` 的 10 个域在提示里**根本没注入**。
- 人类敲 `/self` 看不到自审报告与逐项核验，要看只能重新问 agent。

### 1.4 D5 —— 一个从未加载的工具

```
PlanTool.js:1      'use strict'            ← 严格模式：对冻结对象赋值会 throw（非严格下静默失败）
PlanTool.js:93     module.exports = defineTool({ … })   ← defineTool 返回 Object.freeze(tool)
PlanTool.js:175    module.exports._getPlan = function …  ← TypeError
        ⇒ require('PlanTool.js') 抛 → 注册器 fail-soft 跳过 → 该工具对模型永远不存在
```

`defineTool` 内部**已有**处理这一问题的既定模式（`_baseTool.js:801-817`）：`tool` 是显式字面量、**不 spread `config`**，所以 `capability` / `normalizeParams` 都在**冻结前**用 `Object.defineProperty` / 显式赋值挂上去，并在注释里写明「unknown field would be silently dropped」。`PlanTool` 的作者把 store 访问器挂在了**冻结之后**，于是整整一个工具成了死件。

---

## 2. 设计：一份分面 SSOT，两个消费面

### 2.1 为什么落在 `selfProfile.js`

`selfProfile` 已经是唯一一个**同时**触达四个 SSOT 的模块：它 `require('./selfAuditRegistry')`（`:629`）、走 `getCommandCatalog()`（`:713`）、走 `getSelfLocation()`（`:702`）、自带 `buildStaticProfile` / `detectRuntimeCapabilities` / `getInstallLocation`。把分面契约放在这里，**不新增模块、不新增依赖边**，符合 `AGENTS.md`「优先编辑现有文件」。

同时它**不该**把分面表交给 `commandSchema` 反向引用：`selfProfile.js:31` 已经 `require('../constants/commandSchema')`，反向引用会成环。因此 `commandSchema.self` 子命令表**保留为元数据**，靠 **parity 测试**（§4.2）锁一致性，而不是靠 require 合并。

### 2.2 分面 SSOT

`selfProfile.js` 新增三个导出：

```js
const SELF_FACETS = Object.freeze([
  Object.freeze({ key: 'identity',          aliases: ['whoami','id'],                        summary: '名称/版本/定位/性格' }),
  Object.freeze({ key: 'capabilities',      aliases: ['capability','cap','features'],         summary: '能力域（网关/推理/工具/技能/命令/多智能体/WASM/应用/学习/安全）' }),
  Object.freeze({ key: 'boundaries',        aliases: ['boundary','limits','limitations'],     summary: '能力边界（含不支持的清单）' }),
  Object.freeze({ key: 'runtime',           aliases: ['env','environment','status'],          summary: '平台/Node/Python/cwd/网关通道/本地推理/学习模式' }),
  Object.freeze({ key: 'location',          aliases: ['where','install','install_root','khy_where'], summary: '安装根/自身源码绝对目录/数据主目录/安装类型' }),
  Object.freeze({ key: 'commands',          aliases: ['command','cmd','catalog'],             summary: '命令目录（可 keyword 过滤）' }),
  Object.freeze({ key: 'self_audit',        aliases: ['audit','audit_report','issues'],       summary: '自审报告（已知问题 + 严重度 + 现状 + 缓解模块）' }),
  Object.freeze({ key: 'self_audit_verify', aliases: ['audit_verify','verify','evidence'],    summary: '自审证据逐项运行时核验' }),
]);

resolveFacetKey(input) → string|null      // 大小写/连字符/别名容忍；未知 → null（fail-closed）
getSelfFacet(key, opts) → { ok, facet, data, reason? }   // 绝不抛；取不到 → ok:false + 诚实 reason
```

**四条契约**（与仓内既有叶子约定一致）：
1. **只读**：`SELF_FACETS` 与其元素全部 `Object.freeze`；`getSelfFacet` 返回新对象，调用方可安全 mutate。
2. **绝不抛**：任何 SSOT 不可解析 → `{ ok:false, facet, reason }`，**绝不伪造数据、绝不静默返回空白**（对齐 `RUNTIME-002` 状态透明与「诚实空信号」既有模式）。
3. **fail-closed**：`resolveFacetKey('bogus')` → `null`，**不是**默认到 `all`（默认值只在调用方——工具的 action 归一与 CLI 的默认输出——显式给出）。
4. **门控跟随被消费的 SSOT**：`commands` 分面尊重 `KHY_COMMAND_CATALOG`（关 → 空目录，与 `commandCatalog` 自身契约一致）；`self_audit` 尊重 `KHY_SELF_AUDIT_AWARENESS`；`self_audit_verify` 尊重 `KHY_AUDIT_DYNAMIC_VERIFY`（关 → verifier 返 `null` → `ok:false` + reason）。

### 2.3 两个消费面如何对齐

| 面 | 改动 |
|---|---|
| `KhySelf`（agent） | `inputSchema.properties.action.enum` **由 `SELF_FACETS` 派生**（`[...keys, 'all']`）；`execute` 分派到 `getSelfFacet`。**新增 agent 可查询分面**：`identity` / `capabilities` / `boundaries` / `runtime`（此前 agent 拿不到） |
| `/self`（人类/CLI） | 子命令**接受任意 `SELF_FACETS` key**（含别名）；**新增** `commands`（含 `<kw>` 过滤）/ `self-audit` / `self-audit-verify` 三个此前只有 agent 能看的面。`capabilities`/`boundaries`/`runtime` 的既有中文美化输出**逐字节保留**（不回归可用性） |
| `commandSchema.js:538` | `self: [...]` 更新为全部 8 个 canonical key（供帮助/补全）；由 §4.2 parity 测试锁死与 `SELF_FACETS` 一致 |
| 向后兼容 | 既有 action 名（`commands`/`location`/`self_audit`/`self_audit_verify`）本就是 canonical key，**已落盘的调用与既有测试不受影响**；`all` 语义收窄为「概览」（location + commands + self_audit 摘要）以控制 token |

### 2.4 授权面（D2 的修法）

`KhySelf` 是 `risk:'safe'` + `isReadOnly()=true`，因此把它加入只读 profile **不违反** `[DESIGN-AGENT-002]` A2-2（该条的禁令是「只读 profile 不得持有**写通道**」，`KhySelf` 不含任何写通道）：

- `PROFILES.minimal.tools` += `KhySelf` → 经 `extends` 链同时覆盖 **minimal / coding / analysis / verification** 四个 profile；
- `PROFILES.explore.tools` += `KhySelf`（`explore` 不 `extends minimal`，需单独授予）。

修完 `assembleToolPool(undefined,'coding')` 必含 `KhySelf`，**D2 的「指挥模型调不存在的工具」矛盾消失**。

### 2.5 D5 的修法（跟随 `defineTool` 既有模式）

不 broaden `defineTool` 的行为（会波及 189 个工具），而是在其**已文档化的「冻结前附加」位置**（`_baseTool.js:801-817`，与 `capability` / `normalizeParams` 同一处、同一模式）接受一个显式的 `config.extraExports`，冻结前挂上；`PlanTool.js` 改为在 config 里传 `extraExports: { _getPlan, _clearPlan }`，删除冻结后赋值那两行。**消费方 API 不变**（`require('./PlanTool')._getPlan` 仍可用）。

---

## 3. 不做清单（划边界）

- **不新建服务模块**：分面挂在既有 `selfProfile`，不引入 `selfKnowledgeService`（`AGENTS.md`「优先编辑现有文件」）。
- **不给 `KhySelf` 加写能力**：它永远 `isReadOnly()===true`；「自更新」属于 `khyUpdate` / `khySelfUpdateService`，是**另一个**工具，本次不动。
- **不修 D4（门控登记漂移）**：`check-flag-registry.js` 今日 PASS，这些门是「直读 env、不进注册表」的既有独立先例（`roleToolScope.js` 头注释明确记录了这一先例）；把 4 个门塞进注册表属于**门控体系**的一次独立决策，不该夹在自知对齐里顺手做（`RUNTIME-009`「一次提交只做一步」）。
- ~~**不修** `check-permission-invariants` 的 `perm-mode-list-missing` / `check-tool-contract` 的 `toolCatalog/toolContract` 缺失~~：**已于第二批修复**（见 §6）。原判「同族但跨域、处方最小化」在第一批成立；第二批专门做这批目录重组漂移，故不再是遗留。
  - 修复中另**发现并解锁**一个更严重的问题：`toolContractGuard` 的陈旧路径让工具契约审计**整层静默失效**（对 0 个工具断言），修好后立刻暴露 8 条真实命名冲突；其中 1 条由 D5 修复**直接引入**（`PlanTool` 复活后与 `TodoWrite` 争 `todowrite` 键），已在第二批清除，棘轮复位。
- **不做版本 bump / 不推送**：本改动含对外行为变化（`/self` 新增子命令、agent 新增可查分面），按 `[DESIGN-SEMVER-002]` 属 **PATCH 级**，但「何时 bump、推哪里、推 tag 点头」是人工决定（`PROCESS-001` 禁止 AI 自动 commit/push；`PROCESS-005` 只自动化「推 tag 之后」）。故本设计**显式留给人工**，并保证不改版本号 → `check-version-sync` 保持绿。
- **不新增拦截型机制**：D1 的漂移守卫以**既有测试套件里的断言**实现（`node:test`），不新建 hook/checker/门禁，因此不触及 `PROCESS-008` 的四阶段升阶约束。

---

## 4. 验证判据（本设计如何被证明做到了）

### 4.1 判据一：锚点漂移永久可机检

新增断言：`SELF_AUDIT_ITEMS` 的每一条 `evidenceAnchors.modules[*]` 都必须能解析到真实文件（以 `services/` 为基、允许 `../tools/x` 形式）。D1 修好后此断言绿；**任何人再把模块搬家而不改锚点，此断言立即红**。

### 4.2 判据二：两个面不可再分叉

新增 parity 断言：
1. `KhySelfTool.inputSchema.properties.action.enum` ⊇ `SELF_FACETS.map(f => f.key)`；
2. `commandSchema` 的 `self` 子命令表 == `SELF_FACETS` 的 canonical key 集合（逐元素相等）；
3. 每个 facet key 都能被 `resolveFacetKey` 解析回自身（自反），每个 alias 都解析到其 key。

### 4.3 判据三：D2 矛盾消失

断言 `assembleToolPool(undefined,'coding')` 含 `KhySelf`；且 `minimal` / `coding` / `analysis` / `verification` / `explore` 五个 profile 均含 `KhySelf`。

### 4.4 判据四：每个分面都真的能取到值

对 8 个分面逐个调 `getSelfFacet`，断言 `ok===true` 且 `data` 非空、且**不抛**；`self_audit_verify` 断言 5 项 `verified` 全为 `true`（即 D1 已修）。

### 4.5 判据五：不回归

- `node --test tests/tools/khySelfTool.test.js tests/services/selfAuditVerifier.test.js tests/services/selfAuditRegistry.test.js tests/services/selfLocation.test.js tests/services/commandCatalog.test.js tests/services/flagRegistry.test.js` 全绿（含 D1 修复前红的那条）；
- 全量 `node --test` 的失败数**不高于**改动前基线；
- 工具池加载数 189 → **190**（D5 修复），加载期不再有 `Failed to load PlanTool.js`；
- `node scripts/ci/check-agent-rules.js --changed` 与 `check-flag-registry` / `check-agent-docs` 保持绿。

### 4.6 复现的「改前 / 改后」对照

| 命令 | 改前 | 改后 |
|---|---|---|
| `node --test tests/services/selfAuditVerifier.test.js` | `1 fail`（`#7 …模块缺失:services/commandCatalog/commandCatalog.js`） | `pass` |
| 探针：`assembleToolPool(undefined,'coding')` 是否含 KhySelf | `HIDDEN`（37 工具） | `VISIBLE` |
| 探针：`formatForSystemPrompt()` 是否含 `核验失败` | `true` | `false` |
| 探针：加载工具数 / PlanTool 加载失败 | `189` + 一行 `Failed to load PlanTool.js` | `190`，无失败行 |
| 探针：`/self` 与 `KhySelf` 的 action 并集 | 8 分面 / 交集 1 | 8 分面**双面全覆盖** |

---

## 5. 遗留与移交

1. ~~**同族漂移（点名，不在本改动集）**：~~
   - ~~`check-permission-invariants` 报 `PERMISSION_MODES` 字面量在 `services/tool/toolCallingPermissions.js` 找不到（模块迁入 `tool/` 后守卫未跟）；~~
   - ~~`check-tool-contract` 报 `services/toolCatalog/toolContract` 不可解析（同样疑似迁址）。~~
   二者与 D1 同属「目录重组 → 引用过期」，~~建议后续按 `RUNTIME-009` 逐次搓、各自留回滚~~。
   → **已由 §6 第二批修复**；本仓混合行尾（`commandSchema.js` 为 CRLF、其余为 LF）曾让第一批的成对回退脚本匹配失败，见 §6.3。
2. **待人工决定**：
   - 版本 bump（PATCH）+ CHANGELOG 段落 + 推送 `main` / tag —— 按 `PROCESS-001` / `PROCESS-005` 由人工点头；
   - `commandSchema.self` 子命令表的 canonical key 是否要在帮助里也暴露别名（当前只暴露 8 个 canonical key）；
   - **7 条存量工具命名冲突**（`news`/`imageOcr`/`powershell`/`A2A` 系，见 §6.2）：`toolContract.sweep.test.js` 已把它们钉成基线 7 并明确「awaits a human call (task #37)」。它们是**跨 risk / 跨 category 的归一键争用**，谁留谁去是产品面决定，不宜由 AI 顺手改名。
   - **`PERMISSION_MODES` 第三份未冻结副本**（`appHostHelpers.js:63`，缺 `dontAsk`）：守卫建议「改为从 toolCallingPermissions 导入」在**本仓不可行**——`tool/toolCallingPermissions.js` 本身就 require `appHostHelpers`，照做会成 require 环。正确解法是把该常量提到无依赖叶子模块，但守卫不变量 #1 要求冻结字面量就在 `PERM_MODULE` 内，故需连同守卫一起重新设计，属独立决策。
3. **本设计的存证**：`.khy/feedback/<task-id>/` 落 `complaint.md`（主诉，不说病因）、`repro-before.txt`（改前原始输出）、`differential.md`（候选病因 + 可证伪预测）、`repro-after.txt`（复诊）、`requirement-5q.md`（需求五问，每条带 `source`）、`mode.json`（混合模态显式声明）、`rollback.txt`（可执行回滚）——对齐 `[DESIGN-ARCH-113]` 三模态反馈契约。第二批见 `.khy/feedback/DESIGN-ARCH-153-drift-2/`。
4. **本文件的 `.html` 孪生件待整站构建生成**（`LAY-5`）。`node scripts/docs/verify_docs_site.js`
   当前报 8 份缺失孪生，本文件是其中之一，但 **`[DESIGN-ARCH-149]`/`150`/`151`/`152` 同样缺失**——
   即这是**既有的未构建状态，非本改动引入**。生成器只有整站模式（无单文件模式），
   且生成物属 `LAY-5` 管辖、不得手改；故**未**手工产出，也未为一份文件跑整站构建
   （会产出 1200+ 文件，远超本任务范围）。移交人工：按常规节奏跑 `npm run docs:build`。

---

## 6. 第二批：目录重组漂移（`check-tool-contract` / `check-permission-invariants`）

第一批把 D1（`commandCatalog` 锚点过期）当个案修了，并显式把同族的两处漂移留作遗留（原 §5.1）。
第二批专门做这两处，因为第一批的探针已经证明：**这类漂移的后果不是「检查报错」，而是「检查静默失效」。**

### 6.1 病与修

| # | 位置 | 病 | 修 |
|---|---|---|---|
| 6-a | `scripts/lib/toolContractGuard.js:21` | `AUDITOR_PATH` 指向 `services/toolCatalog/toolContract`，实际在 `services/domain/catalog/toolCatalog/toolContract.js`；旧目录只剩 `toolCatalog` 的转出壳（**不含** `toolContract`） | 指向新落点（+ `RELEVANT_FILES` 同步，否则 `--changed` 门控也失准） |
| 6-b | `scripts/ci/check-permission-invariants.js:32` | `PERM_MODULE` 指向 `services/toolCallingPermissions.js`，该文件自迁入 `tool/` 后**只剩一行转出壳**，其中没有 `const PERMISSION_MODES = [...]` 字面量 → 不变量 #1 必错 | 指向真源 `services/tool/toolCallingPermissions.js` |
| 6-c | `services/backend/scripts/parityScorecard.js:135` | 活代码 `req('src/services/toolCatalog/toolContract')`，V3「工具契约洁净」维度**必然探测失败记 0 分** | 指向新落点 |
| 6-d | `docs/10_规范/registry/RULES-REGISTRY.json` SECURITY-004 `paths` | 登记的是转出壳路径 → **改真源文件时该规则不会被 ruleguard 触发** | 指向真源 |
| 6-e | 5 处陈旧文档路径（`toolcheck.js:9`、`check-tool-contract.js:8`、`toolContract.js` 的 `@module`、`trimIfString.js:7` 的清单、`[MGMT-STD-006]` §V3 的判据路径） | 注释/文档指向已不存在的路径。其中 `[MGMT-STD-006]` V3 引用的 `src/services/toolCatalog/toolContract.js` **根本不存在**——该目录下只剩 `index.js`，即**验收标准本身在指一个不存在的载体**，V3 条款因此无法被任何人按字面复核 | 更新为实际落点 |

### 6.2 修复解锁出的真实缺陷（这正是本类的危害）

`check-tool-contract` 修好前输出是 `Tool-contract audit over 0 tool(s)` + 1 条 `无法加载…审计器`——
即审计**整层空转**：对 0 个工具做断言，永远「通过」。修好后立刻对 190 个工具真跑，暴露：

- **8 条 `tool-collision` error**（跨 risk / 跨 category 的归一键争用）；
- 其中 **7 条是既有存量债**，`toolContract.sweep.test.js` 早已把它们钉成基线 7，注释写明
  「the actual cleanup (naming decisions on the twin tools) awaits a human call (task #37)」；
- **第 8 条由本设计 D5 修复直接引入**：`PlanTool` 此前从未加载成功，故它与 `TodoWrite` 争
  `todowrite` 键的冲突一直被掩盖；D5 让它复活，冲突即现。
- 参数审计同理：`PlanTool` 的 `tasks` 是 array 却无 `items`，参数警告 4 → 5，超基线。

**处置**：按测试自己的纪律「新增即回归，应修」——在 `PlanTool.js` 内清掉这两条**由本改动引入**的债
（移除 `todowrite` 别名：该键归 `TodoWriteTool`，其 toolName 即 `TodoWrite`；补 `items` 声明），
棘轮复位到基线 **7 / 4**。既有 7 条**不动**——谁留谁去是产品面决定。

### 6.3 混合行尾踩坑（供后续复用）

本仓行尾**不一致**：`commandSchema.js` 是 CRLF，`toolProfile.js` / `PlanTool.js` /
`selfAuditRegistry.js` 是 LF。用 LF 拼出的多行 needle 在 CRLF 文件里**必然匹配不到**，
成对回退脚本因此在中途抛错、留下半回退仓库。修法是让 needle 按目标文件的
主导行尾自适应（`\r\n` vs `\n` 计数比较），并让 apply/restore **幂等**（已在目标状态则跳过）。

### 6.4 第二批的 verdict

| 守卫 | 改前 | 改后 |
|---|---|---|
| `check-permission-invariants` | `1 error / 1 warning`（`perm-mode-list-missing`） | `0 error / 1 warning`（余下 warning 是 6-§5.2 那条环冲突，已论证不可照做） |
| `check-tool-contract` | `1 error / 0 warning`，**审计 0 个工具**（整层空转） | `7 error / 21 warning`，**审计 190 个工具**，且 7 条 = 测试钉住的既有基线，无新增 |
| `parityScorecard` V3 维度 | 探测失败 → 0 分（原因=加载不了） | 可测 → 0 分（原因=真实 7 冲突）；同时 **V6 自我认知维度 1/1**（slash 210 条 · selfLocation=true），即第一批的验收判据达标 |
| `toolContract.sweep.test.js` | `# tests 6 / # pass 4 / # fail 2`（8 超 7、5 超 4） | **`# tests 6 / # pass 6 / # fail 0`** |

> **计数口径订正（2026-09-25 实测）**：本节先前写的 `26 pass / 2 fail` → `28 pass / 0 fail` **是错的**。
> 该文件是 `node:test` 用例，含 **6 个顶层测试、0 个嵌套子测试**，故 `# tests` 只能是 6。
> 上表数字系用 `node --test services/backend/tests/tools/toolContract.sweep.test.js` **实测**得到
> （棘轮触发态经 `_rollback-docs.js rollback` 复现后测得，非推算）。
> 教训与本设计主题同源：**读数要能重跑复现，转述的数字不算读数**。

> **诚实边界**：修好后 `check-tool-contract` 仍是红的（7 error），但这个红**比修之前的红更有价值**：
> 修之前它红在一个「加载不了」的假因上，且**放弃了全部审计**；修之后它红在 7 条真实的
> 归一键争用上，且这些债早已被测试钉住、早已移交人工。这是本设计反复出现的同一句话：
> **让检查说实话，比让检查变绿更重要。**

### 6.5 存证、回滚与标签映射

**存证落点**：`.khy/feedback/DESIGN-ARCH-153-drift-2/`

| 文件 | 作用 |
|---|---|
| `repro.js` | 只读探针：A（权限不变量守卫读的是真源还是壳）/ B（审计规模是 0 还是 190）/ C（V3 维度可不可测）/ D（棘轮基线 vs 实测）/ E（同族陈旧路径残留数） |
| `_revert.js` | 成对回退/恢复——**只含 5 处代码路径载荷**（`apply` / `restore`） |
| `_rollback-docs.js` | 成对回退/恢复——含其余 8 处（含 6-f），使 12 处**全部可回滚**（`rollback` / `reapply`） |
| `repro-before.txt` / `repro-after.txt` | 同一条命令的原始 stdout，逐字未删改 |
| `complaint.md` | 主诉（只说现象与条件，不说病因） |
| `differential.md` | 候选病因 H1/H2/H3 + 各自可证伪预测 + 实测排除 |
| `requirement-5q.md` | 需求五问（守卫判本批为 BUILD 所必需；逐问标注用户原话 vs `推断:`） |
| `mode.json` | 模态声明（客观判定 BUILD 3.20 / FIX 0.20，分差 3.00 超混合带，故非必需） |
| `rollback.txt` | 三梯队可执行回滚 + 回滚后必跑 + 不可回滚项清单 |

**标签映射**（存证里的 6-a…6-l 与 §6.1 的 6-a…6-e 编号不同，此处对齐，免得复核者以为漏改）：

| §6.1 | 存证 | 说明 |
|---|---|---|
| 6-a | `6-a` + `6-a2` | 同一文件两处：`AUDITOR_PATH` 与 `RELEVANT_FILES` |
| 6-b | `6-b` + `6-e` | 同一文件两处：`PERM_MODULE` 与它上面那行文档注释 |
| 6-c | `6-c` | `parityScorecard.js:135` |
| 6-d | `6-l` | `RULES-REGISTRY.json` SECURITY-004 `paths` |
| 6-e | `6-h` + `6-i` + `6-j` + `6-k` + `6-g` | 5 处文档/注释路径 |
| §6.2 | `6-f` | `PlanTool` 别名与 `items`（**我方自己引入**的债，不属 before/after 对照） |

**回退集为何只有 5 处**（这是有意的取舍得，不是漏改）：`_revert.js` 只覆盖那 5 处
**代码路径载荷**——它们是让守卫静默失明 / 报假错 / 让 V3 不可测的原因，且两种形态
都是本次亲手写的，双向精确。6-g…6-l 的「改前」文本依同一路径族**机械推得、无法核实**
（本仓无 git 可用），纳入复现集会**伪造出未经证实的历史态**。代价是探针 E 行的
「文档/记录残留数」在改前改后同为 1（那是本文件 §5 里故意保留的划掉记录），
削弱了这一行的对照信号；`E` 行的**代码文件**计数（3 → 0）已足够承载对照。
回滚需求则由 `_rollback-docs.js` 补足——**回滚是「撤销」、复现是「还原历史」**，
两者语义不同，前者不要求历史精确。

**第三个同类实证（在本仓既存代码里）**：`toolContract.sweep.test.js` 文件头注释自述，
该测试曾因审计器的 fallback require 路径指向一个「不再导出 `getAll`」的模块，
被 `try/catch` 吞掉后得到 `total: 0`，于是**所有「真实注册表」断言都在对 0 个工具空转通过**
（"passed VACUOUSLY against zero tools (a silent no-op defense)"）。这是同一病原的第三例，
且是**该测试作者自己写下的**——它与本批修的 6-a 是同一类：**加载失败不报错，而是把规模降成 0**。
本批把这条纪律贯彻到底：凡「取不到目标」的检查，必须让**规模可见**，不能让结论照常打印。

### 6.6 验收时浮出的同族问题（**未修**，需人工裁决）

> 归属：这是在为 §6.4 取读数时**顺手发现**的，**不在本批改动集内**，也**未修改**任何相关文件。
> 记在此处是因为它与本设计同一病原：**runner 对自己的目标判断错误 → 报出大量假错**。

**事实（逐条实测，命令可复跑）**

| # | 事实 | 证据 |
|---|---|---|
| 1 | `services/backend` 的 `test:node` = `node --test tests/**/*.test.js` | `services/backend/package.json` `test:node` |
| 2 | 该模式在 **Node 自身展开**时匹配 **2692** 个文件（`**/` 含零层） | `fs.globSync('tests/**/*.test.js')` → 2692 |
| 3 | 其中 **1279 个是 jest 风格**（用 jest 全局、无 `require('node:test')`） | 按 jest.config.js 同款判据统计：node:test 1391 / jest 1279 / 独立 22 |
| 4 | jest 风格文件在 `node --test` 下**必然失败**：`ReferenceError: describe is not defined` | `node --test tests/tools/askUserQuestion.alignment.test.js` → `# fail 1` |
| 5 | 失败数≈jest 文件数（校准）：`tests/a*.test.js` 82 文件（53 jest）→ 实测 `# tests 414 / # pass 349 / # fail 55` | 同上 |
| 6 | `test:node` 接在 **4 个 workflow** 上：`pr-gate`（`continue-on-error: true`，不阻断）、`deploy-staging` 与 `dual-channel-release`（**阻断**）、`frontend-ci`（在**仓库根**运行） | 各 workflow 对应 step |
| 7 | 本仓已知同一类：`BUG-013`「两个 QUARANTINE 占位测试壳用 jest 的 describe/it/expect 全局，在 `node --test` 下未定义」——`pending_verify` | `.ai/hq/BUGS.json` |

**推断（与「事实」分开，因其未经整跑确认）**

- **跨平台分歧**：CI 是 Linux/`sh`，**无 globstar 时 `**` 退化为 `*`**，故 `tests/**/*.test.js`
  只展开到**恰好一层深**（实测 1431 个文件，其中 744 个 jest）。而 Windows 本机 cmd
  **不展开 glob**，字符串原样交给 Node，由 Node 展开到**全部深度**（2692 个，1279 个 jest）。
  两者差集 **1261 个文件**。`deploy-staging.yml:96-99` 的作者注释也是按「shell 先展开 → 1288 个」
  这个（Linux 侧）模型写的，与 Windows 实测不符。
- **因此**：`test:node` 的**覆盖面本身**在两个平台上不一致；`pr-gate` 那步被显式设为
  `continue-on-error: true`（说明其红已被预期），而 `deploy-staging` / `dual-channel-release`
  两步**阻断**——若它们在真红，则发布链早就该卡住。
- **边界（重要）**：我**没有**整跑 2692 个文件的 `test:node`（耗时不可控），故
  **「CI 是否真的红」是推断而非实测**。已实测的是**机制**（模式匹配面、文件分类、
  单文件失败）与**接线**（哪些 step 阻断）。`BUG-013` 只把范围写成「两个占位壳」，
  按实测应为 **744（CI 面）/ 1279（Windows 面）** 个文件——**该条范围陈述被严重低估**。

**建议（不代做，交人工裁决）**

- **不该**用「改 glob 为引号形式」草率处理——那会改变覆盖面且**加剧**跨平台分歧；
- 正解是让 `test:node` **按 runner 标记选文件**：`services/backend/jest.config.js` 已有现成判据
  （`findNodeTestFiles()` / `JEST_REGISTER_RE` 发现逻辑）可复用，把「node:test 文件」的集合
  显式算出并传给 `node --test`，两个 runner 才真正分开；
- 这属**新增机制**，按 `PROCESS-008` 不得直进门禁档，且会改动发布链的两个阻断 step，
  **超出本批「修引用漂移」的范围**，故只登记不实施。

---

## 7. 第三批：自知的取数分层——活体派生优先，声明必须锚定

> 用户要求：「khyself 工具过时了，需要设计一下，再做测试，然后实现对齐；
> **khyself 不能完全依赖文档自知，而应该依据项目实际情况**。」
> 前两批（§5、§6）修的是「两个面互相对齐」与「引用漂移」。
> 本批回答一个更根本的问题：**自知的内容从哪来。**

### 7.1 病：自知的"事实"是写在源码里的说明书

`selfProfile.buildStaticProfile()` 里，`capabilityDomains` 的绝大多数 `description`
是**手写散文常量**，不是从实现里取出来的。实测审计（本轮逐条对照代码库）结果：

| # | 声明 | 实况 | 判定 |
|---|---|---|---|
| D-A | `os_operations` 含 **"Alpine ISO build"** | 实际构建的是**自写 C 内核**（Limine/GRUB 引导、xorriso 打包，`cli/handlers/khyos.js`）。`Alpine` 字面量在构建路径上**一次都不出现**，只在两处顺手注释里 | **WRONG** |
| D-B | `tools.categories` 回退标签 = `file_ops / git / task / web / code_exec / media / agent / lsp` | 真实分类真源是 `tools/_toolCategories.js` 的 **15 类**：`data/analysis/execution/filesystem/git/system/optimization/coordinator/mcp/multimodal/storage/ai/training/realtime/custom`。回退标签**是编的**，与真源无一处对上 | **WRONG** |
| D-C | `multi_agent.modes` = 3 种 | 真实至少 6 种：另含 `remote_agent`（A2A 远程节点，`tasks/index.js:34` `TASK_TYPES`）、team/mesh 协作（`tools/TeamCreateTool`、`tools/MeshPeer`）、纯编排器 `coordinator/coordinatorMode.js` | **STALE（不完整）** |
| D-D | `capabilityDomains` 共 11 域 | 实现里另有至少 6 个成体系的能力域**完全未被提及**：MCP 生态、记忆/知识持久化、模型训练微调、备份恢复、消息桥接、可观测性/遥测；另有桌面自动化、定时调度、A2A | **STALE（遗漏）** |

> 上表是**设计期**审计到的四条。真正动手实现时同族缺陷**又冒出四条**（D-E ~ D-H，
> 含设计稿自己判错的一条）——见 §7.8。**这个缺陷族的规模数不出来，只能逐个接到来源上。**

**根因与 §6 同族，只是漂移物不同**：§6 漂移的是**路径**，本批漂移的是**断言**。
共同点是——**声明与实现之间没有机器可读的映射**，所以既无法被检查，也就会静默过期。
区别在于 §6 的漂移可以直接 `fs.existsSync` 判死，而「Alpine ISO build」这种断言
**连一个可以比对的对象都没有**。这才是「过时」的结构性成因，不是某几处写错。

> **本条第 5 个实证缺陷（D-E，实现期复核时发现，设计稿在此曾判错）**：
> 本节先前把 `local_inference` 的
> 「4 级 fallback: ollama-runner → node-llama-cpp → llama-cpp-python → Ollama HTTP」
> 写成「经逐行核对**完全准确**」的反例。**该判断是错的**——逐行核对 `_backend` 的赋值点
> （`localLLMService.js` 策略 1–4）可知，四级里**有两级的后端名对不上任何真实取值**：
>
> | 散文写法 | 真实 `_backend` 取值 | 判定 |
> |---|---|---|
> | `ollama-runner` | `'ollama-runner'` | 对 |
> | `node-llama-cpp` | `'node-llama-cpp'` | 对 |
> | `llama-cpp-python` | `'python-server'`（策略 3 起 `inference_server.py`） | **WRONG**（`llama-cpp-python` 是本仓里不存在的后端 id） |
> | `Ollama HTTP` | `'ollama'` | **WRONG**（描述性措辞，不是 id） |
>
> 即：**顺序与机制对，两个名字错**。这比 D-A 更隐蔽——它「看起来对」，词也都在本仓里出现过
> （`llama-cpp-python` 在别处作为依赖/注释出现过），所以人工复核容易放过。
> 修法是现取 `LOCAL_LLM_BACKENDS`（**从赋值点反向导出**），断言其 id 序列。
> 教训与本设计主题同源：**「读着像对的」不是判据，「能对着赋值点逐字核」才是。**

### 7.2 设计：取数分层（L / A 两态，禁用 P）

每个进入自知面的能力声明，**必须**属于且只属于以下两态之一：

| 态 | 含义 | 要求 | 取不到时 |
|---|---|---|---|
| **L** live-derived | 值在**调用时**从活的注册表/真源/磁盘算出 | 不得有散文；真源必须是既有 SSOT（如 `_toolCategories`） | 诚实 `ok:false` + reason，**绝不落回散文** |
| **A** anchored claim | 不可再约简的散文，**但**必须携带 `evidenceAnchors{modules,gates}` | 锚点在运行时逐条核验，对外带 `·已核验 / ·核验失败` | 徽标显示核验失败，**不静默** |
| ~~P~~ prose-only | 既无派生也无锚点的散文 | **禁止进入** `capabilityDomains` | —— |

**P 是本设计的唯一红线**：一条断言若既不能从实现算出、又不能被指向实现，它就不是
「自知」，而是「自我宣传」，不得进入自知面。这条规则防的正是 D-A/D-B 那类断言再次混入。

**为什么 A 允许存在**：有些事确实无法从代码算出——比如「多模型网关支持自动检测与故障转移」
是一句设计意图的概括。硬要把它派生成数字是另一种撒谎。A 的价值不在「准确」，
而在**可核验**：它明确说出"我这条断言指向哪些模块/门控"，于是核验失败是**可见**的。

### 7.3 落地域取数归类（20 域，实装）

`capabilityDomains` 由新叶子 `selfCapabilityRegistry.js` 声明（纯数据、零 IO），
`selfProfile._deriveDomainFacts()` 负责 L 态派生、`_materializeDomain()` 负责物化，
`selfCapabilityVerifier` 负责 A 态核验。

**实装读数**（`node -e` 实测，非推算）：**20 域 / 58 条模块锚点 / 0 条门控锚点 / 28 个部件**；
态分布 `live+claim` 5 · `live` 6 · `anchored` 9。

| 域 | 态 | 取的来源 / 锚点（`modules`，相对 `services/`，省略 `.js`） |
|---|---|---|
| `ai_gateway` | live+claim | 适配器数/名 ← `gateway/aiGateway.getStatus()`；锚点 `gateway/aiGateway` |
| `local_inference` | live+claim | 链 ← `localLLMService.LOCAL_LLM_BACKENDS`（**本批新增导出**，取代散文）；锚点 `localLLMService` |
| `tools` | live+claim | 分类与计数 ← `tools/index.getByCategory()`；类别键 ← `tools/_toolCategories.VALID_CATEGORIES`（**不再自编**）；锚点 `../tools/index`、`../tools/_toolCategories` |
| `skills` | live+claim | 计数 ← `skills/index.getSkillCommands()`（见 §7.8 的指针修复）；锚点 `skills/index`、`../skills/index` |
| `commands` | live+claim | 计数 ← `constants/commandSchema`；锚点 `domain/catalog/commandCatalog/commandCatalog`、`../cli/router`、`../cli/aliases`、`../commands/ccCommandBridge`、`../constants/commandSchema` |
| `multi_agent` | **live**（部件派生） | 模式 ← 由 8 个真实模块的**存在性**派生；锚点 `../coordinator/{workerAgent,processAgent,taskBoard,coordinatorMode,ipcProtocol}`、`../tools/TeamCreateTool/index`、`../tools/MeshPeer`、`a2a/index`、`../tasks/index`、`../agents/index` |
| `wasm_runtime` | anchored | ABI ← `wasmDefaults.SUPPORTED_ABIS`（已有）；锚点 `wasmAppService`、`wasm-sandbox/index` |
| `os_operations` | **live**（部件派生） | **删去「Alpine ISO build」**，改为真实部件标签（含「自写 C 内核 + Limine/GRUB 引导」）；锚点 `../cli/handlers/{khyos,service,deps,doctorCmdc}`、`serviceRegistry` |
| `app_runtime` | **live**（部件派生） | 锚点 `../cli/handlers/app`、`extensionMarketplace`、`domain/extensions/plugins/pluginToolBridge`、`../plugin-loader/index` |
| `learning` | anchored | 等级/XP ← `knowledgeTeachingService`（已有，走 runtime 面）；锚点 `knowledgeTeachingService` |
| `security` | **live**（部件派生） | 五项逐条锚定：`../permissions/index`、`../permissions/bashSecurity`、`ssrfGuard`、`auditLog`、`toolSandbox` |
| `mcp` | anchored | `domain/messaging/mcp/index`、`../tools/MCPTool/index` |
| `memory` | **live**（部件派生） | `../memdir/index`、`../tools/SaveMemory`、`../assistant/index` |
| `training` | anchored | `modelTrainingService`、`../tools/FineTuningTool/index` |
| `backup_restore` | anchored | `domain/backup/backup/backupService`、`restoreAgentService` |
| `messaging` | **live**（部件派生） | `../bridge/bridgeServer`、`domain/messaging/channels/messageRouter`、`../adapters/im/adapterRegistry` |
| `observability` | anchored | `../observability/index`、`telemetryService` |
| `desktop_automation` | anchored | `../tools/ComputerUseTool/index`、`domain/desktop/desktopControl/index` |
| `scheduling` | anchored | `cronScheduler`、`../jobs/cronScheduler`、`../jobs/jobStore` |
| `a2a` | anchored | `a2a/index` |

> 上表 20 行 = 20 个域（原 11 + 新增 9）。**58 条锚点全部在本机实测可解析且全部核验通过**
> （0 缺失）——锚点是设计的一部分，写错锚点就会重演 §6-D1 的假「核验失败」，故在设计阶段即实测。

> **实现期与设计稿的一处偏离（已按实况订正本表）**：设计稿把锚点写成「每个域 1–2 个」以说明意图，
> 实装时改为**把部件（`parts`）的模块一并纳入锚点**，因为两者若各存一份就会各自漂。
> 测试 G2 逐条锁死 `parts[].module ⊆ evidenceAnchors.modules`。

### 7.4 完整性：域集合本身也要可校验

遗漏（D-D）比写错更难发现，因为它不产生任何错误输出。故本设计要求：

1. **域集合单点声明** —— 只在新叶子 `selfCapabilityRegistry.CAPABILITY_DOMAINS` 里；
   `capabilityDomains` 由它驱动，两个面（KhySelf / CLI / JSON API）都从它读，
   不得再有第二份手写枚举；
2. **覆盖契约** —— 登记表另带 `EXCLUDED_DIRS`（明列不纳入的目录 + `kind` + 理由）。
   测试枚举 **`src/` 顶层目录**（实测 35 个），断言
   `FS 目录 ⊆ (被锚点伸到的目录 ∪ 已排除目录)`，且**反向也查**（登记了但磁盘上不存在的目录
   判为幽灵登记）→ 新能力上线时测试会**逼**维护者表态：登记它，或明写排除理由。
   **不允许沉默遗漏。**
3. **锚点不可过期** —— 沿用 §4.1 判据一：每条 `evidenceAnchors.modules` 必须解析到真实文件，
   写成测试（与 `selfAuditRegistry` 的 D1 测试同款）。

**实装读数**：35 个 `src/` 顶层目录 = 17 个被锚点伸到 + 20 个显式排除（`infrastructure` 8 ·
`data` 5 · `interface_adapter` 3 · `ui_affordance` 2 · `runtime_data` 1 · `container` 1），0 未覆盖、0 幽灵。

**作用域边界如实声明（`CAPABILITY_META.scopeLimit`）**：本契约**只守 `src/` 顶层**。
`services/` 下 150 个平铺目录与 `services/domain/` 的 31 个子域**不在**契约内 ——
那层粒度太细，逐个分类会退化成一份新的手维护清单。取舍是：**守一个能守住的层，
并说明没守到哪**，而不是假装覆盖了全部。

**「不是能力域」的判据**（写在登记表里，让例外可被复核而不是成为后门）：
能力域 = khy 能**替用户做**的一整片事（可被请求的操作面，或产出用户可见成果的子系统）。
界面外观层（输入模式 `vim`、装饰性陪伴 `buddy`、布局适配 `classic`）与基础设施层
（配置/常量/HTTP 管线/DB schema/迁移/数据资产/协议 schema）不是能力域 ——
它们被**显式列出**，而不是从清单里悄悄消失。

### 7.5 复用而非再造（对齐 `RUNTIME-010` A2-5 的精神）

锚点核验**只允许一份实现**。原状是 `selfAuditVerifier` 内部私有实现（`_verifyItem`
+ `_gateEnabled`）；若为能力域再写一份，就是「同一个概念两份定义」，必然分叉。

故：抽出无依赖叶子 `selfEvidenceVerifier.js`（`resolveAnchorPath` / `gateEnabled` /
`verifyAnchors`），`selfAuditVerifier` 与 `selfCapabilityVerifier` **都委托它**。
`selfAuditVerifier` 的公开 API、门控、TTL 缓存**一律不变**（D1 的修复不得回归）。

**实装验证**：重构后自审块仍 5 项全 `·已核验`、系统提示无 `·核验失败`、`SELF_FACETS` 仍 8 个
（见 §7.8 读数）。

### 7.6 门控与阶段（`PROCESS-008`）

- 新门控 **`KHY_SELF_CAPABILITY_EVIDENCE`**（默认**开**；仅显式 `0/false/off/no` 关），
  已正式登记进 `flagRegistry.FLAGS`（495 → 497），配套 `KHY_CAPABILITY_VERIFY_TTL_MS`
  （numeric，默认 300000）。
- **门控只管证据核验（A 态），不管声明与 L 态派生。** 这是对设计稿的一次**实质性订正**：
  设计稿原写「关 → `capabilityDomains` 逐字节回退到本批之前的形态」。实装时发现该设计有**两个**
  问题，故废弃：
  1. **假开关**：`buildStaticProfile()` 是记忆化的，门控实际只在进程内**首次调用**时解析一次
     —— 首次之后的「关」永远走不到；
  2. **假话后门**：被「回退」的那些字节里有两处是**事实错误**（Alpine 构建、发明的分类标签），
     保留它等于留一条说假话的路径。

  结论：**声明与派生属于「正确性本身」，正确性不设开关**；可开关的只有核验（它有真实的运维
  失败模式——每轮提示重建都 stat 磁盘）。关掉时徽标**缺席**（`anchorStatus` 不出现），
  而**不是**渲染成「通过」。
- **不新增任何 CI 拦截脚本**。本批产出的是：数据叶子 + 核验叶子 + 既有 `node:test` 用例。
  按 `PROCESS-008`，观察者/顾问阶段不得进门禁档；测试锁不变式属常规测试，
  不构成新的拦截型机制。

### 7.7 验收判据（本设计如何被证明做到了）

实装测试：`services/backend/tests/tools/khySelfCapabilityGrounding.test.js`（**33 用例全绿**；
初版 28 条，收口时补 G10 本地推理诚实性 5 条，见 §7.9）。

| # | 判据 | 怎样算过（实装的断言） |
|---|---|---|
| 一 | **无 P 态** | 每域锚点非空（`modules ∪ gates ≠ ∅`）且 `deriveFrom \|\| claim`；`parts[].module ⊆ anchors` |
| 二 | **锚点可解析** | 58 条锚点逐一解析到真实文件；任一缺失即失败（防 §6-D1 重演） |
| 三 | **门控锚点必须是登记名** | 每条 `gates[*]` 必须在 `flagRegistry.FLAGS` 里（**对两个注册表都查**）——因为 `isFlagEnabled('KHY_TOTALLY_BOGUS')===true`，错字会被默认开吞掉（§7.8） |
| 四 | **L 态真派生** | `tools.categories` 键集合 == `VALID_CATEGORIES`；`local_inference.backends` == `LOCAL_LLM_BACKENDS` 且**顺序一致**；工具数/技能数/命令数 == 活 SSOT 的值；`multi_agent.modes.length` == 存活部件数 |
| 五 | **A 态真核验（且不恒绿）** | `verifyAll({env:{}})` 20 域全 `verified:true`；**同时**故意损坏的锚点（缺模块/空锚点/门控关）必须判 `false` —— 证明徽标不是装饰 |
| 六 | **四处实证缺陷消失** | ① 任何输出都不含 `Alpine`（对实际渲染值断言，非仅搜源码）；② `tools` 类别键来自 `_toolCategories` 且**不含** `file_ops/code_exec/lsp`；③ `multi_agent.modes` ≥6 且含 `remote_agent`/`team`/`coordinator`；④ 20 域全部出现且描述非空 |
| 七 | **完整性契约生效** | 覆盖契约双向断言通过（无未覆盖、无幽灵登记）；排除理由的 `kind` 用封闭枚举；`scopeLimit` 声明作用域 |
| 八 | **不回归** | `selfAuditVerifier` 5 项仍 `·已核验`；系统提示无 `·核验失败`；`SELF_FACETS` 仍 8 个；`khySelfAlignment.test.js` 19 用例全绿 |
| 九 | **未知不得渲染成通过** | 门控关 → `grounding.available:false` 且每域 `anchorStatus === undefined`；域清单**不因门控关而消失** |
| 十 | **诚实零值** | 未传入会话工具清单时 `tools.enabled === null`（**不是** `0`）且带 `registered` 真值与 `note` |
| 十一 | **不可用要说清真原因** | `local_inference` 不可用时的「原因/修复」必须透出 `localLLMService.getStatus()` 的真实字段（`modelImportHint` / `modelLoadDiagnosis` / `lastError`）——服务给出专用 hint 时**不得**回落到写死的 `ollama.com/download`；`loaded` 时**不得**渲染原因行；`getStatus` 抛错时状态收敛为 `unknown` 且**不外泄异常细节**（G10，5 用例，见 §7.9） |

> 判据五是**本批的复现/复诊对照**：改前 `capabilityDomains` 含 `Alpine`、
> 回退标签自编、模式缺 3 种、缺 9 域；改后四项全部消失。存证落
> `.khy/feedback/DESIGN-ARCH-153-grounding/`。

### 7.8 实现期发现（超出设计稿）与实测读数

设计稿只预见了 D-A ~ D-D。真正动手改代码时，**同族缺陷又冒出四个**——它们之所以没在设计期
被发现，恰恰因为本批要修的就是「没人去核对」。记录在此，一是存证，二是说明**这个缺陷族
的规模只能靠「逐个接到来源上」来收敛，靠读文档是数不出来的**。

#### 7.8.1 D-E：`local_inference` 的后端名（设计稿自己判错的那条）

见 §7.1 末尾的表格。**设计稿曾把这条写成「完全准确」的反例**，实现期逐行核对赋值点后
发现四级里有两级的名字对不上任何真实 `_backend` 取值。修法：从赋值点反向导出
`localLLMService.LOCAL_LLM_BACKENDS`，让描述**现取**该序列，不再手写。

#### 7.8.2 D-F：`skills` 指针指着治理叶子，于是「0 个技能」被当成实测值报了出去

`selfProfile` 取技能加载器的指针原为 `require('./skills/index')`（= `src/services/skills/index`）。
**该路径存在、能 require、不报错**——但它导出的是技能**治理**叶子
（`journeyTimeline` / `skillThreatScanner` / …），**不是**加载器。加载器在
`src/skills/index`（`services/` 的**上一级**）。

后果是一个**静默的假测量**：下游守卫写的是
`typeof sm.getSkillCommands === 'function'`，在这个错误指针下**恒为 false**，
于是 `formatBrief` 与 `formatForHuman` 都如实打印 `技能 (0 已加载)` / `Skills: 0`——
**看起来像「量过了，是 0」，其实是「量错了对象」**。真实值 48。

这正是 §6-D1 的同构形态：**路径存在 ≠ 路径正确**。修法是把指针指到 `../skills/index`
（并在源码注释里写明两者的区别，防止下次又被「看着像」的路径骗回去）。

#### 7.8.3 D-G：`Tools: 0` 是同一类假测量

`formatBrief` 原本打印 `Tools: ${tools.enabled}`。但 CLI 调用路径**从不传
`opts.enabledTools`**，于是 `enabled` 恒为默认的 `0`，而 `0` 被渲染成一个看起来像
实测的事实。修法不是在 `0` 和真值之间选一个——**是承认这里本来就不知道**：

- `enabled === null`（**未传入 = 未知**，不是「没有工具」）；
- 另给 `registered`（注册表**实际**数量，190）作真值；
- 附 `note` 明写「已启用数为未知（不等于 0）」。

`brief` 因此从 `Tools: 0` 变成 `Tools: 190 注册`。
**判据**：把「未知」渲染成任何一个数字，都是假话；`null` + `note` 才是诚实。

#### 7.8.4 D-H：门控锚点写了错字，会被「默认开」吞成通过

`flagRegistry.isFlagEnabled('KHY_TOTALLY_BOGUS_XYZ')` **返回 `true`**——未登记的 flag
名字默认**开**（这是 flag 系统的合理默认，但它同时是一个静默通过的洞）。

若 `evidenceAnchors.gates` 里写了错字（或未来被重命名），核验会一路 `verified: true`，
**徽标照样亮 `·已核验`**。也就是说：**锚点写错名 = 核验永远通过 = 比没有锚点更坏**，
因为它提供的是「假的可核验性」。

修法两步：
1. **数据侧**：每条 `gates[*]` 必须是 `flagRegistry.FLAGS` 里的**登记名**；
2. **测试侧**：对**两个**注册表都断言（`flagRegistry` 与能力域自己的门控），
   并留一条**对照实验**——实测 `isFlagEnabled('KHY_TOTALLY_BOGUS_XYZ') === true`，
   证明这个洞**真实存在过**，从而证明这条断言不是空转。

对应 §7.7 判据三。

> **同族的第三种「假通过」（实现期踩到，记录以免重演）**：核验叶子的签名是
> `verifyAnchors(anchors, {env})`。写存证探针时我把它当成了 `verifyAnchors(anchors, env)`
> ——传了**裸 env**。叶子于是回退到 `process.env`，而该 flag 未设置、按默认**开**，
> 结果「门控关」那一格被打印成 `verified: true :: 全部证据锚点核验通过`。
> 我一度据此以为**自己写的核验器坏了**；直查 `flagRegistry.isFlagEnabled(name, {…:'0'})`
> 才确认**是探针的调用形状错了，核验器是对的**（改正后该格为
> `false :: 门控为关:KHY_SELF_CAPABILITY_EVIDENCE`）。
>
> 教训与 D-H 同一族、但更狠：**默认开 + 调用方形状写错 = 核验恒绿，且看不出是谁错了**。
> 所以测试 G6 一律显式传 `{env:{}}`，**不依赖 `process.env`**——让缺省也走显式路径。
> 这恰好是本批主题的又一次自证：**一个不接现场的检查，会替你说好话。**

#### 7.8.5 一次被自己推翻的设计决定：废弃「逐字节回退」

设计稿原写「门控关 → `capabilityDomains` 逐字节回退到本批之前的形态」。实装时废弃，
理由已在 §7.6 记明（假开关 + 假话后门）。此处只强调结论：**正确性不设开关**。
可开关的只有核验（它有真实的运维成本），且关掉时徽标**缺席**而非渲染成「通过」。

#### 7.8.6 实测读数（本批收工时的机器读数，非估计）

| 项 | 读数 |
|---|---|
| 能力域 | **20**；锚点模块 **58**；门控锚点 **0**；部件 **28** |
| 域态分布 | `live+claim` **5** · `live` **6** · `anchored` **9**（无 P 态） |
| 排除登记 | **20** 项 / 6 种 `kind`；未覆盖 **0**、幽灵 **0** |
| `flagRegistry.FLAGS` | **497**（本批 495 → 497） |
| 活体读数 | 工具 **190**（15 类）/ 技能 **48** / 路由命令 **258** / 斜杠 **210** / 适配器 **17** / 本地后端 **4** / 多智能体模式 **8** / ABI **3** |
| 核验 | `total 20 · verified 20 · failed []`；人类输出 20/20 `·已核验`、`·核验失败` **0** |
| 假话清除（渲染值断言） | `Alpine` **0** 次 · `file_ops/code_exec/lsp` **0** 次 · `llama-cpp-python` **0** 次 |
| `formatBrief` | `Tools: 190 注册 \| Skills: 48`（原为 `Tools: 0 \| Skills: 0`） |
| 本批测试 | `khySelfCapabilityGrounding.test.js` **33/33**；`khySelfAlignment.test.js` **19/19** |
| jest `tests/tools` | 48 套（47 通过 / 1 失败）、466 用例（462 通过 / 3 失败 / 1 跳过）——失败项见 §7.8.7 |
| `check-agent-rules.js` | 8 个改动文件扫描，**0 违规** |
| 门禁电池 | 19 个守卫**逐一 spawn 实测 exit code**：**15 个 0**，4 个非零（见下）——含 2 个**与本批无关的既有失败**与 2 个**电池脚本自身的口径错误**（见 §7.9.3） |
| `check:delivery` | `PASS 9 · PARTIAL 0 · GAP 1 · UNKNOWN 2`；唯一 GAP 是任务面棘轮（见 §7.8.7） |

> **文档孪生（LAY-5）**：本文件改动后，其 `.html` 孪生由官方生成器重建
> （`npm run docs:build`，确定性、离线），**未手改**。实测该次重建全站只改动
> **1~2** 个孪生（本文件必改；另一次附带一个**既存**陈旧孪生），新增 0、删除 0——即生成器
> 在本仓近似幂等，不存在「重跑一次就大面积翻新」的问题。重建后 `docs:verify` 通过
> （源 md 1246 · 生成 html 1247 · 本地链接 13999 全通），`check:agent-docs` exit 0。
> （注：先前此处另写「`check:build-artifacts` / `check:layout` 均 exit 0」**不实**——
> 该读数出自下面 §7.9.3 描述的坏电池。实测 `check:build-artifacts` 因本机非 git 仓库
> 恒 `exit 2`、`check:layout` 因 `docs/tui-interaction-optimize/`（mtime 2026-09-21）
> 缺 `00_INDEX` 恒 `exit 1`，**两者均与本批无关、且早于本批存在**。）

#### 7.8.7 已知的既有问题（与本批无关，**未处理**，需人工裁决）

两条都在本批动手**之前**就存在，用 mtime 与「本批新增文件数」证明非本批引入：

1. **`tests/tools/AgentTool.claudeDelegation.test.js` 3 用例失败**（既有）。
   证据：`claudeDelegation.js` mtime `2026-09-17`、测试 mtime `2026-09-06`，
   均**早于**本批首个产物 `2026-09-26T02:45`。失败原因是委派准入闸门现在按默认档
   拦截显式 Claude 委派（`no-gate：未命中任何委派闸门（G1/G2/G3）`），属
   `PROCESS-004` 委派边界域，**不在本批范围**，故不修。
2. **任务面棘轮越线 `handlerFiles = 157 / 155`**（既有，S1 下降级 WARN 不阻断）。
   证据：本批**新增 handler 文件 0 个**（三只新叶子均在 `src/services/`）；
   `handlers/` 内当日唯一改动 `gatewayManageDaemon.js` 的 mtime 为 `2026-09-26T00:49`，
   早于本批首个产物。其余三条棘轮干净（`routerCommands 245/245`、`aliasEntries 591/591`、
   `ruleCount 94/94`）。
   → **收工后经用户授权登记为可追债务**，见 §7.9.1。

> **收尾口径**：本批**不 bump 版本、不提交、不推送**（`PROCESS-001` P0 禁止 AI 自动
> commit/push；版本与 CHANGELOG 交人工，`PROCESS-005`），**不新增任何 CI 拦截脚本**
> （`PROCESS-008`：观察者阶段不得进门禁档）。

### 7.9 收工后的两项授权跟进

用户在 §7.8 报告后回复「按你的建议往下走」，据此做了两件事。两者都**延续本批的同一条原则**
——让检查说实话、让状态可追，而不是让它变绿或含糊过去。

#### 7.9.1 棘轮越线登记为可追债务（`[DESIGN-QUAL-001]` QUAL-2）

越线此前**只有** `check:delivery` 打一条 S1 WARN，**没有任何台账条目**——正是
`[DESIGN-QUAL-001]` 要防的「非阻塞退化为永久忽略」。按 QUAL-2「上升必须登记
owner/dueBy/plan」，在 `scripts/ci/debt-ledger.json` 新增一条：

| 字段 | 值 |
|---|---|
| `id` | `delivery.surface-handlerFiles-ratchet` |
| `guard` | `scripts/ci/check-delivery-baseline.js` |
| `measured → target` | `157 → 155` |
| `risk` / `owner` / `dueBy` / `status` | P2 / platform / 2026-12-31 / open |
| `plan` | 由维护者退役/合并 2 个 handler 回到 ≤155，再按 `baseline.method` 同口径重测并**下调**基线 |

`plan` 里显式写了**两条禁令**：不得为消警上调基线（棘轮只降不升），且退役属删除类、
须走 `RUNTIME-009`（scrub-plan + 可执行 rollback + 先核 `docs` 背书）。
`check:debt-ledger` 现 **16 条 / 覆盖 16 / 0 error 0 warning**。
（**未**擅删他人 handler 去硬凑基线——那是把治理指标做成假绿，与本批初衷相反。）

#### 7.9.2 本地推理不可用改说真原因（`RUNTIME-002` §2.2）

原状：人类面与系统提示里，`local_inference` 只要不可用就恒打印
`安装 Ollama: https://ollama.com/download`。但**「不可用」有四种成因**（未找到模型 /
GGUF 格式不兼容 / loopback 被禁 / runner 报错），「装 Ollama」只治其中一种——
这属于**把猜测当结论**，与本批「依据实际情况」直接冲突。

`localLLMService.getStatus()` 其实**早就返回**了真成因（`modelDiscoveryReason`、
`modelImportHint`、`modelLoadDiagnosis`、`lastError`），只是 `selfProfile` 没接。
修法是把成因**透出**，而非新造文案：

| 情形 | 现在渲染 |
|---|---|
| 未找到模型 + 服务给了 hint | `原因: 未发现可运行的本地模型` + **服务自己的 hint**（本机为「拖入 models 目录或 `khymodel import`」） |
| 未找到 + 无线索 | `原因: …` + 通用 Ollama 提示（**仅此时**才兜底） |
| 格式不兼容 | `原因: 模型格式与内置引擎不兼容 — <真实诊断>`（不误报成「未找到」） |
| `lastError` | `原因: <真实报错>` |
| `loaded` / `available` | **不渲染**原因/修复两行（不对正常状态说丧气话） |
| `getStatus` 抛错 | 状态收敛为 `unknown`，**不外泄异常细节** |

新增测试 **G10（5 用例）**锁死这六条分支：关键是「服务给出专用 hint 时**不得**出现
写死的 `ollama.com/download`」这一断言——它保证修复建议来自现场、不是模板。
本批测试总数 28 → **33**，`§7.7` 判据表补「十一 · 不可用要说清真原因」。
系统提示的实时可用性信号同步改为 `本地推理当前不可用（原因: not_found）…`。

> **未做的**：本机 `LLM: unavailable` 的**根因是环境**（无 Ollama 服务、无 GGUF 模型文件）。
> 装运行时 / 拉模型属**部署层动作、且需下载数 GB**，不在代码对齐范围，交用户在部署层决定。
> 本批能负责的是：**不可用时，把真实原因和可行的修复如实说出来。**

#### 7.9.3 收工自查揪出的自欺：我的「全绿电池」自己是坏的

复检时发现**本报告引用的「18 个守卫 exit 0」读数本身不可信**：该读数出自一个
`.cmd` 电池脚本，脚本在 `for` 循环里用 `%ERRORLEVEL%`（**非延迟展开**）——cmd 的
`for` 块在**解析期**就把 `%ERRORLEVEL%` 展开成**循环开始前**的一次性值，之后每个守卫
打印的都是同一个陈旧值。**19 个守卫的真实 exit code 需要逐一 spawn 读取**（§7.9.1 的
`check:debt-ledger` 因此也需重测）。

用 node `spawnSync` 逐一实测后的真实分布（19 个）：

| 真实 exit | 守卫 | 判定 |
|---|---|---|
| **0**（15 个） | wiring / rules / version-sync / delivery / agent-authz / build-root / memory-schema / gov-rules / rules:coverage / **debt-ledger** / rules:manifest / data-layout / rollout-stage / agent-rules（8 文件）/ agent-feedback（存证齐全） | **与本批相关的全部为真 0** |
| 1 | `check:layout` | **既有**：`docs/tui-interaction-optimize/`（mtime 09-21，早于本批）缺 `00_INDEX`，与本批无关 |
| 2 | `check:build-artifacts` | **环境**：本机非 git 仓库，该守卫依赖 `git ls-files`，恒失败；非内容违规 |
| 1 | `check:delegation-boundary` | **既有**：`platform/.../bundled/runtime/khy/bundle.mjs`（mtime 09-25，早于本批）25 处 `delegation-bypass-spawn`；构建产物，与本批无关 |
| 1 | `check:delivery-baseline` | **口径错**：`package.json` **不存在**这个 script（我此前把它列进电池纯属笔误；`npm run` 对未定义 script 报 1）。真实守卫是 `check:delivery`（= `check-delivery-baseline.js`），exit 0 |

**教训（与 D-H / 探针形状同族）**：**度量工具自己也要被度量。**「19 个全 0」和
「15 真 0 + 4 个另有原因」都是一次跑出来的事实，但前者是**假绿**——它把「脚本写错了」
伪装成「仓库很干净」。若不复检，§7.8.6 的读数就会带着这个假绿进档案。

**结论**：与本批 8 个改动文件**相关**的守卫（version-sync / delivery / debt-ledger /
agent-rules / agent-feedback / rollout-stage / wiring / gov-rules / rules 系列）真实 exit 全 0；
4 个非零全部归因明确（2 既有失败 + 1 环境限制 + 1 电池脚本笔误），无一涉及本批改动面。