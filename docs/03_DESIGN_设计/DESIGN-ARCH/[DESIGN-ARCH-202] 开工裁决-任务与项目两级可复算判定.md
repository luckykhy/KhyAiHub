<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-202] 开工裁决：任务 / 项目两级可复算判定

> **需求来源**：用户原话——「还有khy不知道什么算开始」。
> **定位**：把「开工了吗」从**状态自述**改成**系统盖章的时刻 + 开工后的活动记录 → 四值裁决**。与 [`[DESIGN-ARCH-201]`](%5BDESIGN-ARCH-201%5D%20完成裁决-回合任务项目三级可复算判定.md) 对称：那个回答「干完了吗」，这个回答「真的开工了吗」。
> **状态**：已落地。纯叶子 `runtime/node/backend/src/cli/startVerdict.js`、盖章与校验 `runtime/node/backend/src/cli/hqStore.js`、门与呈现 `runtime/node/backend/src/cli/handlers/hq.js`。
> **不改**：不追溯给存量任务补开戳（假戳比没戳更坏）；不新增命令（`khy hq task set <ID> doing` 仍是唯一开工入口）；不新增规则 ID。

---

## 1. 问题：`doing` 是一个谁都能写的状态

2026-11-04 实测（`works/record/ai/hq/PROGRESS.json`，30 条任务）：

| 事实 | 后果 |
|---|---|
| 没有 `started_at` 字段 | 开工时刻从未被记录 |
| `updated` 只有日期精度，任何状态迁移都刷 | 一条 doing 任务「刚开工」还是「挂了三周」不可区分 |
| `khy hq next` 写的认领戳会被下一次状态迁移 `clearClaim` 清掉 | 开工后连「谁在做」也看不到了 |
| `todo -> doing` 只校验 `scope_guard` | 过了边界锁，改写一个字符串就叫开工 |

于是 `khy hq status` 只能说「它自称在 doing」，`khy hq close` 只能按状态数数 —— 与 201 之前「模型说完成了」是同一类病：**自述冒充事实**。

## 2. 四值，而不是布尔

```
started      系统在 todo->doing 盖了 started_at，且其后至少一条活动记录
declared     状态 doing/review，但只有自述（无开工戳，或盖章后零活动）
not-started  todo（带认领也仍是预留，不算开工）
unknown      状态缺失/无法识别，或 doing/review 连基线都没有
```

「不知道」仍是合法结论。与 201 同一条纪律：**存量数据封顶** —— 没有 `started_at` 意味着开工时刻从未由系统见证，靠 `updated`/`claimed_at` 反推最多判 `declared`，正如 legacy 散文验收最多判 `partial`。

`done` 例外地直接判 `started`（`source: terminal`）：`TASK_TRANSITIONS` 里 `review` 只能由 `doing` 到达，`review -> done` 又必须过 [`[DESIGN-ARCH-201]`](%5BDESIGN-ARCH-201%5D%20完成裁决-回合任务项目三级可复算判定.md) 的验收门 —— 「已验收」本身就是开工过的机器证据，不依赖开工戳。

## 3. 开工戳与活动记录

`khy hq task set <ID> doing` 在**过了 `scope_guard` 门之后、落盘之前**写三个字段（`hqStore.stampStart`）：

| 字段 | 语义 |
|---|---|
| `started_at` | `YYYY-MM-DDTHH:mm:ss` 本地时刻，系统盖的 |
| `started_by` | 盖章机器（`KHY_MACHINE_ID` 可覆盖），多机归因 |
| `start_note_count` | 开工瞬间的备注条数 —— **基线**，不是计数 |

`doing -> todo`（打回）清掉这三个字段（`clearStart`）：本次开工作废，再开工重新盖章。留着旧戳会让下一次开工的「开工后活动」从上一次算起，把中途停滞洗成连续开工。

活动记录只用**任务自身字段**，零 IO：

1. `claimed_at` 晚于基线（`khy hq renew` 会刷新它）；
2. `notes` 条数超过 `start_note_count`。

**刻意不读工作树、不看 HEAD**：本仓是共享脏工作树，别人提交别的东西不能让本任务「看起来开工了」。这也是 `startVerdict` 能在 `status` / `close` / `verify` 任一调用点给出**同一结论**的原因。

## 4. 落地

| 面 | 行为 |
|---|---|
| 门 | `todo -> doing` 过门即盖章；被门拒绝则不落任何字段（`hqReviewGate.test.js` 的既有 E2E 加了这条断言） |
| `khy hq status` | doing/review 任务带 `[已开工]` / `[自称开工]`；`--json` 每条任务带 `start` 与 `started_at` |
| `khy hq close` | 每行带 `start` / `startSource` / `startReason`；打印「开工面」汇总行与「开工存疑」清单；机读落 `PROJECT-STATUS.json` 的 `startVerdict` / `startCounts` |
| `khy hq verify` | doing/review 缺 `started_at` 给 warning（存量不追溯，只让它可见） |

开工面**不并入项目总裁决**：任务没做完已经由 `partial` 表达，「开工不可证实」说的是数据可信度，不是项目进度。合并会把两个问题压成一个数字。

实测读数（2026-11-04 真实仓）：

```
任务面   partial  done 0 · partial 9 · unknown 0 · failed 0 · 未结 21 / 共 30
开工面   started  已开工 9 · 自称 3 · 未开工 18 · 算不出 0 / 共 30
  开工存疑 3 条（doing/review 但系统无法证实开工）：
    - T-020 declared · 存量条目只有更新日期 2026-09-23，开工时刻从未由系统盖章
    - T-021 declared · 存量条目只有更新日期 2026-09-23，开工时刻从未由系统盖章
    - T-027 declared · 存量条目只有更新日期 2026-09-26，开工时刻从未由系统盖章
```

这三条不是「没干活」（备注里有大量工作记录），而是**干了也无从证实**。新开工的任务从第一次盖章起就有可复算的开工面。

## 5. 已知限制（明说，不假装完备）

- **手改 JSON 可伪造任何字段**：与 201 相同，本机制防的是「自述冒充」，不是「恶意伪造」；写入路径上的约束覆盖率见 `check-agent-rules.js` 与人工评审。
- **活动记录只覆盖备注/续租**：跑测试、改文件不产生开工痕迹。任务干了活但从不写备注，仍停在 `declared` —— 这是刻意的：系统只认自己看得见的。
- **存量 doing 封顶 declared**：不提供「补盖开工戳」命令。想让某条存量任务重新进入可复算状态，只能打回 `todo` 再开工（开工时刻从此刻算，旧历史不追认）。
- **认领 ≠ 开工**：`khy hq next` 的认领是预留，`todo` 带认领仍是 `not-started`。两件事分开才能看出「领了没动」。
- **开工面不阻断任何写入**：它只改读数，不改门。要把「自称开工」变成硬前提（如 `doing` 必须带认领），那是另一条规则，需单独裁决。

## 6. 判据（本机制自证）

| 判据 | 证据 |
|---|---|
| 纯叶子确定性 | `runtime/node/backend/tests/cli/startVerdict.test.js`（18 例：基线优先级、活动识别、四值矩阵、存量封顶、项目折叠） |
| 盖章真的落盘 | `runtime/node/backend/tests/cli/hqStartGate.test.js`（E2E：`task set doing` → `started_at`/`started_by`/`start_note_count` 入账） |
| 备注能把 declared 推到 started | 同上（`task note` 后 `evaluateStart → started`，且不改写开工时刻） |
| 被门拒绝时无戳 | `runtime/node/backend/tests/cli/hqReviewGate.test.js`（缺 `scope_guard` 拒绝后 `started_at === undefined`） |
| 呈现与项目折叠 | 同上 E2E：`buildStatus` 与 `hq close --json` 的 `startCounts` 按差值断言（沙箱拷的是真实任务板，绝对值会随数据漂移） |
| 打回清戳 | `hqStartGate.test.js` 第二例：`doing -> todo` 后三字段消失 |

运行方式：`node --test runtime/node/backend/tests/cli/hqStartGate.test.js`；`cd runtime/node/backend && node node_modules/jest/bin/jest.js tests/cli/startVerdict.test.js`。
