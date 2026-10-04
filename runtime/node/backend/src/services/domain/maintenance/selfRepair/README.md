# selfRepair — 自修复事务的编排器与 IO 原语（D2 功能单元）

一句话：把「让 fix agent 改代码」这件事包成一次**可校验、可回滚、失败不丢修复**的事务。
`transactionRunner.js` 只做编排（plan → snapshot → runFix → classify → validate → decide → keep|rollback），
所有副作用集中在 `primitives.js` 这一个工厂里，因此编排器可以用 stub 原语做零真 IO 的单测。
判定（去留、改动集归一、门控计划）全部委托纯叶子 `services/selfRepairTransaction.js`（D1，另属它自己的单元）。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取；本单元的 D2→D1、D2→D5 边按偏差登记，不写白名单）。

## 逐成员

| 文件 | 角色 | require | 同名测试 |
|------|------|---------|----------|
| `primitives.js` | 唯一副作用面：`snapshot`（`git stash create`）、`restore`（只还原改动集）、`validateFiles`（`node --check` 异步探针 + JSON 解析 + 机器守卫 + 受影响测试与覆盖率） | `child_process`、`fs`、`path`（内建）、`../../../evolutionSafety`（D1）、仓库根 `scripts/lib/*` 两枚守卫（D5，缺失则 null 跳过） | `primitives.test.js` |
| `transactionRunner.js` | 纯编排 + 依赖注入：事件流、fail-soft、回滚未净时升级交人 | `../../../evolutionPolicy`、`../../../evolutionSafety`、`../../../selfRepairTransaction`（均 D1），回滚未净时惰性 `../../../healEscalationService` | `transactionRunner.test.js` |

## 消费者（实测 fan-in = 3，均非测试文件）

`services/changeWatchService.js`（每回合开始跑校验）、`services/selfRepair/index.js`（D1 再导出壳）、
`services/tool/toolUseLoopCore.js`（fix 派发处，作者 in-flight 文件，本单元只读其引用关系）。

## 契约（每条都对应命名测试）

1. **快照不动工作树**：用 `git stash create` 产悬挂 commit；干净树回退到 `HEAD`；非 git 环境返回 `null`
   （无回滚能力，事务仍校验并透明告警）。绝不 `stash push/save`。
   → `the IO surface is confined to this factory (worktree safety)`
2. **回滚只作用于改动集**：改动集内先试 `git checkout <ref> -- <file>`，快照里不存在者视为 fix 新建 → `fs.rm`；
   会话内其余无关改动一律保留。无 git 快照句柄时 `restore` 直接返回 `false`，不做任何事。
   → `restore() refuses to act without a git snapshot handle`
3. **语法闸的三条豁免**：`.json` 走 `JSON.parse`；`.ts/.tsx/.jsx` 不送 `node --check`
   （node 按扩展名选 loader，对内容合法的 `.jsx` 也抛 `ERR_UNKNOWN_FILE_EXTENSION`，还会把 node 内部栈行号
   当成源文件行号上报）；**不存在的路径直接跳过**——rename/delete 后旧路径留在清单里，
   否则每次改名都会让整轮校验误报「改动不对」。
   → `validateFiles: malformed JSON is judged by parse, not by node --check`、
   `validateFiles: extension-less-to-node-check types are skipped, not misreported`、
   `validateFiles: a vanished path (rename/delete) is skipped rather than reported`
4. **探针不阻塞事件循环**：`node --check` 用 `execFile` 异步形态（同步版实测约 300ms/文件 × 70 文件 ≈ 22s，
   正是「提交后 spinner 卡死约 30s」的根因，因为 `changeWatchService.checkOnce()` 每回合都跑）。
   → `primitives.js` 的 `_nodeCheckAsync`；返回形态与 `spawnSync` 逐字段一致，调用方处理不变。
5. **门控关 = 逐字节回退**：`KHY_SELF_REPAIR_TRANSACTION=off` 时直接返回 `runFix()` 的**同一对象**，
   不取快照、不附 `transaction` 注记、不发事件。
   → `gate off: byte-identical passthrough — no snapshot, no transaction wrapper`
6. **事件梯与决策形状**：门控开时依次 `repair_snapshot_start/done → repair_validate_start/done`，
   校验不过且有快照才 `repair_rollback_start/done`；`decision.keep` 为真时 `rolledBack` 恒为 `null`。
   → `gate on, clean validation: keep, no rollback, and the documented event ladder`、
   `gate on, failing validation with a snapshot: restore is called and its answer reported`
7. **fail-soft「绝不比今天差」**：快照抛错 → `snapshotMissing` 为真但流程继续；校验原语抛错 →
   返回未经包装的 `fixResult`（**保留可能正确的修复，不回滚**）；`onEvent` 监听器抛错不得影响事务；
   非对象 fix 结果归一化为空壳而不是把垃圾展开。
   → `a throwing snapshot degrades to "no rollback capability", not to failure`、
   `machinery failure is fail-soft: the fix result survives, nothing rejects`、
   `a hostile onEvent listener cannot break the transaction`、`a non-object fix result is normalised instead of spreading garbage`
8. **回滚未净交人（L3）**：`restore` 返回 `false` 意味着工作树可能残留半截改动——写 `.khy/heal_escalation.json`
   并终端告警；回滚成功是护栏正常生效，不打扰用户。升级链自身抛错也被吞掉，绝不反噬事务。
   → `a failing restore still completes and never rethrows`

## 已知偏差（登记，不合法化）

- **D2→D1**：两成员共伸进 `evolutionPolicy`、`evolutionSafety`、`selfRepairTransaction`，
  回滚未净时还伸进 `healEscalationService`。
- **D2→D5**：`primitives.js` 从仓库根 `scripts/lib/{leafContractGuard,modelHardcodingGuard}` 深相对 require；
  缺失（纯 pip 环境无完整仓库）时 best-effort 置 `null` 跳过。
  两条都由 `archDebtScan` R1/R3 与 `domain-direction` 既有棘轮管辖，本单元只如实记录。

## 怎么跑

```bash
node --test services/backend/src/services/domain/maintenance/selfRepair/primitives.test.js \
  services/backend/src/services/domain/maintenance/selfRepair/transactionRunner.test.js
node scripts/ci/check-repo-layout.js --list=functional-unit | grep -c "selfRepair"   # 期望 0
```

新增 `README.md` 后须跑 `node scripts/docs/build_docs_site.js` 生成同名 `.html` 孪生。
