<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-201] 完成裁决：回合 / 任务 / 项目三级可复算判定

> **需求来源**：用户原话——「khyos对项目的结束，无法用准确的确认，需要相关方案准确的判断任务是否完成或阶段性的完成」。
> **定位**：把「完成了吗」从**散文自述**改成**判据可执行 → 系统执行 → 运行记录 → 四值裁决**，任务级与项目级共用同一套读数。
> **状态**：已落地。纯叶子 `runtime/node/backend/src/cli/acceptanceVerdict.js`、执行面 `runtime/node/backend/src/cli/acceptanceRunner.js`、门 `runtime/node/backend/src/cli/hqStore.js`、命令 `runtime/node/backend/src/cli/handlers/hq.js`。
> **不改**：不改 `works/record/ai/hq/PROGRESS.json` 的存量任务（迁移由 `khy hq accept <ID> --scaffold` 逐条做）；不新增规则 ID；不新增顶层命令（`hq accept` / `hq close` 挂在既有 `hq` 子命令下，`PROCESS-014` 棘轮不变）。

---

## 1. 问题：四个互不等价的「完成」

设计前实测，本仓同时存在四种「完成」，彼此不可换算：

| 层 | 旧口径 | 失效形态 |
|---|---|---|
| 回合 | 回复里出现完成词（散文正则） | 说了就等于做了 |
| 回执 | `status=completed` | 它只表达「没有工具报错」。381 个可测回合里 **295 个（77.4%）零工具调用**却被记为达成 |
| 任务 | `acceptance.md` 手写 `PASS` | `证据:` 允许一句话，写的人自己声明 |
| 项目 | 无定义 | 「项目结束了吗」没有可复算的读数 |

四者都能叫「完成」，但没有一个能被机器复算。本方案不新增第五种口径，而是把**任务级**收敛成唯一可复算的判定，回合级只做记账、项目级只做折叠。

## 2. 四值，而不是布尔

```
done     全部 required 判据在新鲜记录里 pass
partial  有 pass、无 required fail，但仍有 required 未验证/跳过
failed   任一 required 判据 fail
unknown  没有可机器核对的判据（或全是自述）
```

「不知道」是合法结论。布尔只有真/假，于是「模型说完成」被迫冒充真 —— 这正是旧口径的结构性病因。

自述型判据（`source: legacy`，即只有散文 `acceptance`）**永远不能单独构成 done**，最高 `partial`。

## 3. 判据模型（`criteria[]`）

任务记录的可选字段，出现即校验（`validateCriteria`）：

```jsonc
{
  "id": "C1",                       // 运行记录靠它对应判据，缺 id 直接报错
  "desc": "全量测试 0 失败",
  "required": true,                 // false = 可选，失败只 warning
  "check": {
    "kind": "cmd",                  // cmd | manual；未知形状一律降级 manual（猜成 cmd 会掩盖「没跑」）
    "cmd": "npm test",
    "cwd": "",                      // 相对仓库根
    "expect": { "kind": "exit", "value": 0 },
                                    // 或 {"kind":"stdout-match","re":"..."} / "stdout-not-match"
    "timeoutMs": 300000
  },
  "paths": ["runtime/node/backend/src/cli"]   // 运行记录锁定的覆盖范围
}
```

人工判据（看界面、听音质）真实存在，不强行改成假命令：`kind: "manual"` 的记录必须带 `signedBy`（`khy hq accept <ID> --run --manual C1=pass --by <人>`），无签名只能是 `unknown`。

## 4. 运行记录与保鲜

系统执行结果只追加到 `works/data/khy/feedback/<evidence>/acceptance.jsonl`：

`id / kind / checkHash / at / atMs / head / dirtyCount / paths / pathsFingerprint / result / reason / exit / timedOut / durationMs / stdoutTail / stderrTail / signedBy / source`

判据取**同 id 的最新一条**（昨天的绿遮不住今天的红）。记录在四种情况下失效：

1. 超过保鲜期（默认 24h）；
2. 所属 HEAD 已被改写（非快进，`headStillAncestor === false`）；
3. 判据覆盖路径的指纹变了（`pathsFingerprint`）；
4. 判据定义变了（`checkHash`）。

**刻意不因「HEAD 前进」失效**：本仓是共享脏工作树，别的会话一提交就让全部证据过期，门会退化成噪音。覆盖范围由判据自己的 `paths` 锁定。

## 5. 三层落地

### 5.1 回合（只记账，不阻断）

`runtime/node/backend/src/services/tool/toolUseLoopHelpers.js` 在唯一的收尾漏斗里计算 `completion`：

- `executed` — 有工具调用 + 有结论；
- `declared` — 零工具调用却有结论（**宣告未执行**）；
- `unverified` — 撞到迭代上限、只回占位符、或有执行无结论；
- `failed`。

只有 `executed` 才把回执记 `completed`，其余记 `partial`。`khy receipts stats` 新增「零工具记达成 x/y」与「收尾可信度」两行，把历史 77.4% 的虚高暴露在同一张表上。

### 5.2 任务

```bash
khy hq accept T-030 --scaffold                     # 把 acceptance 散文转成 criteria[]（可手改）
khy hq accept T-030 --run --evidence T-030-xxx     # 系统执行 cmd 判据，写运行记录，出裁决
khy hq task set T-030 done                         # 门读裁决：只有 done 放行
```

`review → done` 的阻断项按「先证据、后判据」排列：缺 evidence 声明 / 目录不存在 / 目录为空 / 没有可机器核对的判据 / 任一 required 判据 fail·skip·unknown。放行时把 `{at, verdict, source, counts, total, verdicts}` 写入 `acceptance_audit` 入账。

### 5.3 项目

`khy hq close` 把任务面与交付面**分成两条轴报，绝不合并成一个布尔**：

- 任务面：done / review 任务逐条算四值，其余算未结，再由 `rollupTasks` 折叠 —— 任一 failed → failed；还有任务没到 done（含 review）→ partial（「阶段性完成」）；全部 done 但有条目 partial/unknown → partial/unknown；全部 done 且全部可复算 → done。
- 交付面：D1–D10 记分板（默认读 `works/data/khy/reports/delivery-baseline.json` 缓存，`--run-delivery` 现跑），GAP 不许被「任务全绿」遮住。

输出同时落 `works/data/khy/reports/PROJECT-STATUS.json`，供后续复核。总裁决非 done/partial 时 `khy hq close` 退出码 1。

`done` 任务在项目面按「已作出的决定」处理：仍校验 `checkHash` 与路径漂移，但不按 24h 保鲜重算 —— 否则做完一天的项目会自动退回 unknown。

## 6. 已知限制（明说，不假装完备）

- **legacy 任务进不了 done**：只有散文 `acceptance` 的存量任务会被挡在 `review → done`，必须 `--scaffold` 补判据。这是刻意的迁移成本，不是 bug。
- **review 里判据全过仍算 partial**：判据过只说明活干完了，还没过人这一关。
- **交付面默认读缓存**：`check-delivery-baseline.js --json` 在本机需 100–300s，故默认缓存、现跑需显式 `--run-delivery`。
- **不判定「该不该做」**：裁决只回答「判据过没过」，需求是否值得做不在本机制范围。

## 7. 判据（本机制自证）

| 判据 | 证据 |
|---|---|
| 纯叶子确定性 | `runtime/node/backend/tests/cli/acceptanceVerdict.test.js`（22 例：四值、legacy 不 done、过期/HEAD 改写/路径改动/判据改动、人工签名、项目折叠） |
| 执行面与记录 | `runtime/node/backend/tests/cli/acceptanceRunner.test.js`（10 例：pass/fail/stdout-match/超时/人工/判据变更/校验） |
| 门的行为锁 | `runtime/node/backend/tests/cli/hqReviewGate.test.js`（27 例，含 5 个真实 CLI spawn：拒绝非零退出、状态不变、放行落盘 done） |
| 端到端 | 夹具 `.qoder/tmp/acc-e2e`：failed（rc=1）、阶段性 partial（rc=0）、全 done（rc=0）三条路径逐一实跑 |

运行方式：`node --test runtime/node/backend/tests/cli/hqReviewGate.test.js`；`cd runtime/node/backend && node node_modules/jest/bin/jest.js tests/cli/acceptanceVerdict.test.js tests/cli/acceptanceRunner.test.js`。
