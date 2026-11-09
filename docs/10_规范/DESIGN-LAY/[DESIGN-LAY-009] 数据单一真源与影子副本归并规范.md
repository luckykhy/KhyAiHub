<!-- 文档分类: DESIGN-LAY-009 | 阶段: 设计 | 原路径: 新建 -->
<!-- IMPL-STATUS: active -->
> **标记依据**：守卫已落地并跑通（`scripts/ci/check-ssot-data.js`），登记表 `docs/10_规范/registry/DATA-SSOT.json` 已建，首轮归并已完成。
# [DESIGN-LAY-009] 数据单一真源与影子副本归并规范

<!-- RULES-REGISTRY: LAYOUT-008 -->

> **强制规范 · 「同一份数据只允许有一个真源」的机械判据** · 回答三个问题：①一条数据事实的**真源在哪**、怎么取；②哪些地方是**允许存在的镜像**、镜像凭什么锁步；③发现同一事实有第二个声明时**往哪归并**。
>
> **定位**：本仓已有大量「单一真源」的**声明**（`serviceDefaults.js`、`providerPresets.js`、各登记表都自称真源），但**没有一条规则去核对「这份数据在仓内到底被写了几遍」**。声明属于纪律，纪律不会自己生效。本篇补的就是这一层：把 SSOT 从**口号**变成**可判定的不变式**。
>
> **触发**：用户 2026-10-30 目标——「khyos 中的所有数据必须遵循单一真源 SSOT 原则，做个守卫，归并数据源，避免矛盾」。
>
> **守卫**：`scripts/ci/check-ssot-data.js`（`npm run check:ssot-data`，S1 观察者档，恒 exit 0）+ 登记表 `docs/10_规范/registry/DATA-SSOT.json`。
>
> **谁该读**：要新增/修改任何「多处共用同一份数据」的人与 AI；以及每次想「顺手再写一份默认值」的人。

---

## §0 病症：这类漂移没有任何一个文件是错的

同一份数据写在两个地方时，两处**一开始相同**；改了一处，另一处就成了矛盾。
这类漂移的特征决定了它的检查方式：

- 没有「错误的文件」——两个文件各自看都没问题；
- 只有「两个文件对同一件事说法不同」——所以守卫不能问「这个文件对不对」，只能问「**这件事有几处声明**」；
- 它**不会自己暴露**——单元测试两边都能过，评审时两份都「看着对」，直到某天只有一边被改了。

本仓已有一例真实事故：`RULES-REGISTRY.json` 的 `meta.ruleCount` 声明 96，而 `rules` 数组实有 99 条
——**声明与事实同处一个文件**，连「自家人」都不认。2026-10-30 由并行会话修正为 100。
本守卫把它列为首条 `json-count` 事实（D5b 自洽判据）。

---

## §1 四层判据（详见 `scripts/lib/ssotDataGuard.js`）

### §1.1 D1/D1b/D2/D3 字段级：同一事实有几处声明

| 判据 | id | 级别 | 含义 |
| --- | --- | --- | --- |
| **影子副本** | `ssot-shadow-copy` | warning | 真源之外又写了一遍真源的值。值相同 → 此刻还没矛盾，但已是两份真相，改一处必漂移 |
| **未登记别名** | `ssot-unanchored-literal` | warning | 事实的值以**裸字面量**出现在作用域内，却没有任何登记标识符 —— 疑似换个变量名再写一遍 |
| **值矛盾** | `ssot-value-contradiction` | **error** | 同一事实出现两个不同的值 —— 已经不是漂移，是矛盾，必须当场归并 |
| **镜像失步** | `ssot-mirror-drift` | **error** | 已登记的**授权镜像**与真源值不再一致 |

三者对应三个不同动作，**归并方向不同**：

```
影子副本    →  改成从真源取值（能 import 就 import）
            →  或登记为授权镜像（物理上无法 import 时）并写明理由
未登记别名  →  同上；或把该别名登记进 detect.identifiers（若它确属同一事实）
值矛盾     →  改错的那一处，让它从真源取值
镜像失步   →  改镜像（或改真源），二者必须同时收敛到同一个值
```

### §1.1b D1b 补网：为什么标识符锚点不够

标识符锚点有一个**结构性盲区**：**新别名**。同一个事实换个变量名再写一遍，
新名字不在任何登记标识符集合里，字段级扫描就看不见它 —— 实测
`ai-manage-daemon.js` 的 `const DEFAULT_API_PORT = 9090;` 正是这样一个漏网之鱼
（它就在活跃启动路径 `main()` 的 `parsePortArg(argv, '--api-port', DEFAULT_API_PORT)` 上）。

补网用**值**兜一层，但只认**代码里的裸字面量**：

| 形态 | 是什么 | 判不判 |
| --- | --- | --- |
| `const X = 9090` | 第二份声明 | **判**（`ssot-unanchored-literal`） |
| `'… [--port 9090] …'` | 帮助文本里的示例 | 不判（是叙述） |
| `'两条路径都绑定 9090 端口'` | 案例库里的历史记录 | 不判（是知识） |

三者长得一样，只有**「在不在引号里」**能分开。实测该口径在当前仓内 **0 条误报**，
而「字符串通吃」口径会在 `bugCases.js` 里捞出 3 条历史记录。

**噪声控制是这层的生死线**：只有**区分度够的值**才启用（默认 ≥ 100）。
实测值 10（端口漂移窗口）走补网能捞出 **242 条**噪声 —— 小整数没有区分度，
值锚定对它完全无效。故此项按事实**显式开启**（`detect.valueAnchor`），不开就没有这层网。

### §1.2 D4 整文件级：登记表被逐字节复制

字段级扫描看不见「整份文件被复制到第二个地方」——复制的文件路径不同、字段名也可能不同，
只有**内容指纹**能看见。判据：对登记在册的真源文件算规范指纹（JSON 按键排序后序列化），
在同类文件里找指纹相同者。

### §1.3 D5 判据自身失效：必须报红

真源文件不存在、指针解析不出来、登记的镜像不存在 —— 这三种情况一律 **error**。
**判据失效时报「通过」等于假绿**：守卫查不到真源，就等于没查。

还有第四种，更隐蔽：**事实的作用域指向不存在的路径**（`ssot-scope-missing`）。
此时这条事实**永远 0 finding** —— 事实在册、判据在跑、结果恒为零，
看起来「全绿」，实则根本没在看。故作用域可达性由守卫自己核（注入 exists 回调，
与 `check-rules-registry.js` 的 `findDanglingRegistryPaths` 同款做法），
不可达即报红。

> 变异测试证明这条防护有效：把 `ai-backend-port` 的 `detect.paths` 指向一个不存在的目录，
> 守卫立刻报 `[ERROR] ssot-scope-missing`，而其余五类计数仍是 0 ——
> 「全绿」被正确地拦下。

---

## §2 登记表 `DATA-SSOT.json`：只登记「真源在哪」，**不登记值**

这是本篇最重要的一条设计约束。

```jsonc
{
  "id": "ai-backend-port",
  "ssot":    { "path": "…/serviceDefaults.js", "kind": "js-const", "pointer": "AI_BACKEND_DEFAULT_PORT" },
  "mirrors": [ { "path": "…/backendDiscovery.mjs", "kind": "js-const", "pointer": "DEFAULT_BACKEND_PORT",
                 "reason": "前端独立包，不能 require 后端常量" } ],
  "detect":  { "identifiers": ["AI_BACKEND_DEFAULT_PORT", "KHY_DAEMON_PORT", …],
               "paths": ["runtime/node/backend/", "delivery/"] }
}
```

**登记表里若也存一份值，它自己就��第二真源，本守卫立刻失去意义** ——
它要治的病，正是它自己会得的病。故值一律**运行时从真源文件读**。

字段含义：

| 字段 | 作用 |
| --- | --- |
| `ssot.kind` | 取值方式：`js-const` / `py-const` / `json-pointer` / `toml-key` / `json-count` |
| `ssot.pointer` | 真源里取哪个值；`json-count` 取「指针所指数组的长度」 |
| `ssot.declaredPointer` | （仅 `json-count`）真源自报的计数 → 用于 §1.1 之外的自洽判据 |
| `mirrors[]` | **授权镜像**：物理上无法 import 的地方，允许存在，但必须锁步且**必须写理由** |
| `detect.identifiers` | 影子副本的锚点：哪些标识符名属于这条事实 |
| `detect.paths` | 事实级作用域：同一标识符在不同目录可能指不同的事，作用域写窄比靠全局排除兜底更准 |
| `detect.exclude` | 事实级排除 |

**无理由的镜像 = 事实上的第二真源** —— 登记表校验会直接判 `ssot-registry-invalid`。
镜像存在的理由只能是「物理上无法 import」（独立包、跨语言），不能是「懒得 import」。

---

## §3 实测与首轮归并（2026-10-30）

### §3.1 规模

| 指标 | 数值 |
| --- | --- |
| 受版本控制文件 | 12,122（207 MB） |
| 登记的真源文件 | **24**（18 份 JSON 登记表 + 6 份代码型真源） |
| 登记的数据事实 | **10** |
| 授权镜像 | **8** |
| 全量扫描耗时 | **约 9 秒** |

> ⚠ 耗时这一行是**设计换来的**：首版按「每条事实扫全仓」实现，实测 **87.7 秒**，进不了 CI。
> 改为「**一次** `git grep` 同时定位含标识符与含可区分值的候选文件 → Node 逐行判定」后降到 9 秒，
> 语料从 5,918 收到 **110** 个文件。
> （中间试过「7 轮 grep（1 轮标识符 + 6 轮值）」，要 30 秒 —— grep 每轮都要重扫一遍索引，**合成一轮**才是对的。）

### §3.2 首轮命中

| 判据 | 命中 | 性质 |
| --- | --- | --- |
| `ssot-shadow-copy` | **11** | 全在 `runtime/node/backend/`（与真源**同一个包**，能 import 却各自写死）：10 处是 AI 后端端口 9090，1 处是手机桥接端口 8896 |
| `ssot-value-contradiction` | 1 | 误报（测试文件里的假端口 9876；排除规则的 `**/test/**` 未按路径段匹配所致，已修） |
| `ssot-self-contradiction` | 1 | **真问题**：`meta.ruleCount` 96 vs 99（已由并行会话修正） |
| `ssot-source-shadow-copy` | 0 | 全仓**无**登记表的逐字节副本 |
| `ssot-mirror-drift` | 0 | 6 个授权镜像**全部锁步** |

补网上线后（值锚定）又查出 **5 处**此前看不见的副本 —— 其中 `ai-manage-daemon.js:103`
是**别名**（`DEFAULT_API_PORT`），另 4 处是帮助文本/示例里的端口字面量。

登记了新事实（Ollama 端口、后端端口）后又查出 **6 处**：

| 判据 | 命中 | 性质 |
| --- | --- | --- |
| `ssot-unanchored-literal` | 4 | Ollama 端口 11434 的副本：后端 `ollamaModelManager.js` 两处 `url.port \|\| 11434`（同一文件已 import 真源）、诊断脚本正则里的一处、跨层工具里的一处 |
| `ssot-shadow-copy` | 2 | 部署模板 `bundleArtifacts.js` 里生成的 compose 文本把容器端口写死 3000 |
| `ssot-value-contradiction` | 1 | **误报**：`"${OLLAMA_HOST}"` 是模板插值不是字面量 —— 守卫把插值当值比了（已修） |

### §3.3 归并结果（累计 22 处影子副本 → 0，涉 15 个文件）

同一个包内能 import 却各自写死的端口，全部改为从真源取值（**值不变，行为等价**）：

| 文件 | 处数 | 改法 |
| --- | --- | --- |
| `src/services/daemonEntry.js` | 1 | `process.env.KHY_DAEMON_PORT \|\| AI_BACKEND_DEFAULT_PORT` |
| `src/services/daemonManager.js` | 1 | 同上 |
| `scripts/start-mgmt-server.js` | 1 | `\|\| AI_BACKEND_DEFAULT_PORT` |
| `scripts/ai-manage-daemon.js` | 1 | `const DEFAULT_API_PORT = require(…).AI_BACKEND_DEFAULT_PORT` |
| `src/cli/handlers/mobile.js` | 5 | `\|\| AI_BACKEND_DEFAULT_PORT`；3 行示例改用模板串 |
| `src/services/aiManagementServer.js` | 2 | `\|\| AI_BACKEND_DEFAULT_PORT` |
| `src/cli/handlers/gatewayManageDaemon.js` | 3 | `_parsePort(…, AI_BACKEND_DEFAULT_PORT)`；帮助文本改用 `${AI_BACKEND_DEFAULT_PORT}` |
| `src/cli/handlers/daemon.js` | 1 | 帮助文本改用 `${AI_BACKEND_DEFAULT_PORT}` |
| `src/services/domain/network/amoo/amooBridgeConfig.js` | 1 | `BRIDGE_PORT: PHONE_BRIDGE_DEFAULT_PORT`（手机桥接端口 8896） |
| `src/services/ollamaModelManager.js` | 2 | `url.port \|\| DEFAULT_OLLAMA_PORT` |
| `scripts/domain/deploy/publish/bundleArtifacts.js` | 2 | 生成的 compose 文本里容器端口改用 `${BACKEND_PORT}` |
| `delivery/extension/scripts/khy-diagnostics/model-type-providers.js` | 1 | 本地端点判定的端口片段改为从已解析的 SSOT 派生 |
| `delivery/extension/tools/khy-markdown/khyos-md-bridge.js` | 1 | 具名化为 `OLLAMA_DEFAULT_PORT` 并登记为**授权镜像**（跨层不能 require 后端常量） |

真源侧同步改造：`serviceDefaults.js` 新增 `DEFAULT_OLLAMA_PORT = 11434`，
`OLLAMA_HOST` 由它派生 —— 此前「端口」只以 URL 片段藏在 host 字符串里，
消费方要写「URL 没带端口时用哪个端口」只能把 11434 再抄一遍。

> 帮助文本那一处尤其值得记：**写死在 usage 里的端口，是最典型的「文档即数据」**——
> 它会随真源改动而静默过期，且没有任何测试会提醒你。

> **口径对齐（非纯重构，须知情）**：`daemonEntry`（守护进程）读 `KHY_DAEMON_PORT`，
> `aiManagementServer`（管理服务）读 `AI_MGMT_PORT`，而**守护进程跑的就是管理服务**
> （`daemonEntry.js` 头部自述）。改前：设了 `KHY_DAEMON_PORT=29090` 而没设 `AI_MGMT_PORT` 时，
> 守护进程监听 29090、管理服务自己的兜底仍是 9090 —— **同一台服务器有两个端口口径**。
> 改后两者都取 `AI_BACKEND_DEFAULT_PORT`，口径合一。这正是本篇要治的病，
> 故属**有意的行为收敛**，不是顺手重构。

回归证据：`runtime/node/backend` 的 `npm run test:node:src` **6941 测试全绿**；
受影响最直接的 jest 套件（`serviceDefaults` / `daemonManager.runtimePort` /
`mobilePairingContract`）**3 套件 24 测试全绿**。

---

## §4 能力边界（明确写出判不出什么）

一条守卫若让人以为「它管住了一切」，比没有守卫更坏。以下是**本守卫判不出**的：

1. **字符串里的端口示例与历史记录**。`console.log('… [--port 9090] …')` 与案例库里的
   `'两条路径都绑定 9090 端口'` 都是**叙述**，补网只认代码里的裸字面量（§1.1b）。
   这类副本靠标识符网与人工/文档守卫兜，不靠值锚定。
2. **区分度不够的值**。小整数（< 100，如端口漂移窗口 10）在代码里太常见，
   值锚定对它无效 —— 实测会捞出 242 条噪声。故只有 ≥ 100 的值才启用补网。
3. **文档里的数值主张**。由 `[DESIGN-DOC-005/006]`（DOCS-006/007）负责 —— 两份真源各管一件事，
   比互相覆盖更稳。
4. **测试目录里的固定值**。测试固定规范值是**防护**不是第二真源，与 AGENTS.md 端点检查豁免同款理由。
5. **语义不同却同名的事实**。如 `BRIDGE_PORT` 在协作桥语境下是 9222、在手机桥语境下是 8896 ——
   故 `detect.identifiers` 必须写准，`detect.paths` 必须写窄。
6. **跨包镜像的自动归并**。跨包镜像**只能登记**，不能自动合并 —— 物理上做不到。
7. **未登记的新事实**。守卫只判**已登记**的事实。新的共用数据事实要往
   `DATA-SSOT.json` 的 `facts[]` 加一条才会进入判定 —— 登记表是覆盖面清单，不是自动发现器。
8. **「自动发现未登记事实」这条路走不通（实测否定结论）**。试过两种聚类：
   - **按数值聚类**（同一数字出现在 ≥3 个文件）→ 洪水。高频值全是**超时与尺寸常量**
     （1024=KB、5000/10000/30000/60000=ms），与「同一事实」无关。
   - **按常量名族聚类**（同值 + 名字共享词根）→ 仍是洪水。共享词若是泛化量词
     （`DEFAULT_*` / `MAX_*`），值 10 能聚出 60+ 个无关常量；共享词若换成**域名词**
     （PORT/HOST/URL），`TOKEN`/`CACHE` 一出现整簇又会被带出来。

   结论：**数值相同 ≠ 同一件事**，机器判不出「这两个常量说的是不是一件事」。
   登记表必须**人工策展**（它编码的正是「这些标识符指的是同一件事」这一层语义）。
   守卫能做的是：把已登记事实的副本看住，并给出**候选线索**供人登记。

---

## §5 落地阶段（PROCESS-006 PP-1 / PROCESS-008）

`STAGE = 'S1'`：观察者，只记录不阻断，**恒 exit 0**（`--strict` 可让 error 阻断，供升档前自测）。

阶段登记在 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（id=`ssot-data-guard`）。

| 阶段 | 含义 | 门槛 |
| --- | --- | --- |
| S1（当前） | 观察者，只报告 | 恒 exit 0；进 PR gate 出报告 |
| S2 | 影子副本转 error | 存量归零后升档 |
| S3 | 进 commit 硬门 | 与 R1 红线同级 |

---

## §6 与既有规则的关系（不重复造门）

| 既有规则 | 管什么 | 与本篇分工 |
| --- | --- | --- |
| `RUNTIME-001` | 端点/生产域名硬编码 | 管**端点字符串**；本篇管**端口与数值事实的多处声明** |
| `PROCESS-002` / `check-version-sync` | 版本号三轨一致 | 管**版本**；本篇管版本之外的其它数据事实 |
| `LAYOUT-007` / `check-data-layout` | 数据**落点**（放哪） | 管**在哪**；本篇管**同一份数据被写了几遍** |
| `DOCS-006` / `DOCS-007` | 文档里的端点与数值主张 | 管**文档怎么说**；本篇管**代码里写了几份** |

---

## §7 复算方式

```bash
npm run check:ssot-data            # 全量扫描（约 2.3 秒）
npm run check:ssot-data -- --json  # 机读输出
npm run check:ssot-data -- --strict # error 即 exit 1（升档前自测）
npm run check:ssot-data -- --list=ssot-shadow-copy
```

单测：`npm run test:one -- scripts/tests/ssotDataGuard.test.js`

---

## §8 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 1.0.0 | 2026-10-30 | 首版。守卫 `check-ssot-data.js` + 纯核心 `ssotDataGuard.js` + 登记表 `DATA-SSOT.json` 落地；8 条事实 / 6 个授权镜像登记；首轮归并 10 处影子副本（6 文件），修 `meta.ruleCount` 自相矛盾 |
