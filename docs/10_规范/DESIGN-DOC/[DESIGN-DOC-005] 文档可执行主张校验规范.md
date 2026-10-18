
<!-- IMPL-STATUS: done -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-006 自举：本文所述机制已实现 -->
> **标记依据**：本文规范的是 scripts/ci/check-doc-claims.js，该脚本已落地并接入 ruleguard（DOCS-006 / doc-claims-guard / S1 观察者），反向验证通过（注入端点 8→9）。
# [DESIGN-DOC-005] 文档可执行主张校验规范

> **规则 ID**：`DOCS-006`　**域**：DOCS　**门档**：pr　**优先级**：P1
> **执行面**：`scripts/ci/check-doc-claims.js`（S1 观察者，恒 exit 0）
> **本文是语义真源**；机器可读登记在 `docs/10_规范/registry/RULES-REGISTRY.json`
> 与 `docs/10_规范/registry/FEATURE-OWNERSHIP.json`。
>
> 与 [`[DESIGN-DOC-004] 文档实现状态标注规范`]([DESIGN-DOC-004]%20文档实现状态标注规范.md)
> 同范围、互补：DOCS-005 管**路径级**漂移（文档声称的实现还在不在），
> 本文管**内容级**漂移（文档写下的字面量在代码里是不是真的）。

<!-- RULES-REGISTRY: DOCS-006 -->

---

## 一、要纠正的一个判断

此前 `[DESIGN-DOC-004]` 断言「内容级漂移不在本规则射程」，理由是
「数值、口径、命令与代码不符无法机械判定」。**这个判断是错的，已被实测推翻。**

一份文档写下 `` `/api/v1/large-tasks` `` 时，它就是在对读者作出一个
**可验证的承诺**。承诺与仓库现状不符就是漂移——无论谁先谁后，
都不需要 git 时间戳来判定。

实测（2026-10-18）：适用范围内 329 份文档共 **124 条端点主张**，
其中 **9 条在源码中查无此串**，逐条人工核实 **9/9 为真漂移**：

| 文档 | 文档写 | 代码实际 | 结论 |
|------|--------|---------|------|
| `[DESIGN-API-003]` | `/api/v1/large-tasks` | `server.js:674` 挂 `/api/large-tasks` | 真漂移 |
| `[DESIGN-API-003]` | `/api/v1/remote-ssh/execute` | 挂 `/api/remote/ssh` | 真漂移 |
| `[DESIGN-API-003]` | `/api/v1/payments` | 挂 `/api/ai-gateway/payments` | 真漂移 |
| `[DESIGN-API-003]` | `/api/v1/orders` | 全仓无 orders 路由 | 真漂移 |
| `[DESIGN-RL-001]` | `/api/v1/strategies` | `server.js:487` 挂 `/api/strategies` | 真漂移 |
| `[DESIGN-ARCH-009]` | `/api/block/types` | 全仓无 | 真漂移 |
| `[DESIGN-ARCH-080]` | `/api/auth/capabilities.passwordReset.mode` | 全仓无 | 真漂移 |
| `[DESIGN-ARCH-080]` | `/api/ai-gateway-admin/health` | 全仓无 | 真漂移 |
| `[DESIGN-ARCH-154]` | `/api/free-llm` | 全仓无该端点 | 真漂移 |

`grep -c "api/v1" server.js` = **0** —— 后端根本不存在任何 v1 挂载。
文档统一写 `/api/v1/...` 而代码统一无前缀，是一次**系统性的口径分歧**。

---

## 二、三条信号，按精度排序

| # | 信号 | 实测精度 | 处置 |
|---|------|---------|------|
| S1 | 端点字面量：文档写 `` `/api/x` `` 而源码无此串 | **9/9 = 100%** | **做成 finding** |
| S2 | npm 目标：文档 `npm run X` 而 package.json 无此脚本 | 已覆盖 | **不重复**，见 §三 |
| S3 | 命令内路径：文档 `node --test a.test.js` 而该文件不可达 | **21.9%** | **只作线索，不判定** |

### 2.1 为什么 S3 不做成 finding

实测 726 条原始命中：剔除示例占位 4、绝对路径 1、**搬迁后仍可达 136**，
余下 159 条候选——**精度仅 21.9%**。

噪声的来源不是判据写得不好，而是**文档里的命令行示例天然包含大量已过时
但仍有教学意义的历史命令**。一份 2026-06 的设计文档写
`node --test tests/services/foo.test.js`，那个测试文件后来搬了家或改名了，
这属于文档的历史属性，不是需要修的错。

仓库引「公理 A4：误报比漏报更贵」。把 78% 命中率的信号做成告警，
只会让剩下 22% 的真问题被淹没。故：`--list=code-path-lead` 可查，
默认不输出为 finding，仅 `stats.codePathLeads` 计数。

---

## 三、S2 已由既有守卫承担，不重复造

`check-repo-layout.js` 的 **`dangling-task`** 规则做的正是这件事，
且已做过充分的误报治理（通配符截断、占位符、测试夹具假名、尖括号形式
四类排除，见其源码注释）。它实测报出 101 条悬空目标，其中包括
`[DESIGN-A2A-001]` 的三条 `npm run test:a2a:*`。

本规则**不重复实现**，只在文档里写明分工。理由：`[DESIGN-ARCH-111]`
的绑定层要求「门成员资格从登记表派生」——同一判据有两个执行器，
会出现两份口径不一致的真源。

---

## 四、这一条如何覆盖「代码先走、文档没跟上」

`[DESIGN-DOC-004]` §四实测证伪了 git 时间戳信号（同 commit 配对 80% 是假阳性），
因此「代码更新了但文档没跟上」在 DOCS-005 之下只能人工判定。

**本文给出的是另一条路：让文档持续自证。**

只要文档写下的是**可逐字比对的字面量**，那么无论代码什么时候变，
「文档说的这个端点现在还在吗」都是一个可以随时回答的问题。
本守卫每次运行都重新回答一遍——**代码先走的方向因此不再依赖时序推断**。

反过来说：**数值类主张**（`ARCH-020` 声称 R1=28 而实跑 R1=9）
仍然无法机检——文档没写下可核对的字面量，只写了一个数字。
这类需要人或专门的执行器（`archDebtScan.js` 本就是那个执行器，
问题在于文档的读数没跟着更新），不在本文射程。

---

## 五、落地阶段与升阶

`STAGE = 'S1'`：观察者，只记录不阻断、恒 exit 0（`[DESIGN-PROCESS-002]` PP-1）。
升阶须同时改三处：`scripts/ci/check-doc-claims.js` 的 `STAGE`、
`RULES-REGISTRY.json` 中 `DOCS-006` 的 `severity`、`FEATURE-OWNERSHIP.json`
中 `doc-claims-guard` 的 `stage`。一次一阶（PP-6），**由人决定**。

`severity` 必须显式写 `advisory`——`check-rollout-stage.js:197` 的 PP-3
会复算 `gateStrength()`，未声明时 P1 会派生为 blocking 而报 error。

---

## 六、怎么用

```bash
npm run check:doc-claims        # 人读摘要（恒 exit 0）
npm run check:doc-claims:json   # 机读
npm run check:doc-claims:list   # 全量端点主张清单
node scripts/ci/check-doc-claims.js --list=code-path-lead   # 路径类线索（不作判定）
```
