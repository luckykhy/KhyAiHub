# workspace — 检查点、恢复与工作区上下文摘要（D2）

业务上下文：`/workspace`（save/restore/list/diff/delete/cleanup/stats）、
`/checkpoint`、`/rollback`、`/rewind`。本目录只有 3 个文件，**全部 IO 侧**——
它是「动手前的存档」这一件事的完整落点，没有纯判级层可拆。

## 谁要（角色）

- **存档/回退的人**：`constants/commandSchema.js:99,559` 声明 `/workspace`
  子命令，`:2071` `/checkpoint`、`:2079` `/rollback`、`:1367` `/rewind`
  （「把文件回退到某个快照」）→ `cli/handlers/workspace.js:26`、
  `cli/handlers/rollback.js:98`。
- **TUI 里点恢复的人**：`cli/tui/ink-components/App.js:4292,4330`
  （list / restore）；`services/rollbackService.js:48`。
- **要把工作区状态喂给模型的人**：`cli/handlers/repo.js:364`、
  `cli/replSession.js:6302,6316,10084`、`cli/tui/hooks/useQueryBridge.js:1706,4140`
  取 `workspaceContext` 的 `collectWorkspaceContext` / `formatSummary`。
- 壳：`services/workspace/index.js:4-6`。

## 为什么这么做

三个文件各管一条不可混淆的边界：
`checkpointService.js`（910 行）是**唯一**做 git 侧动作的地方
（`:25` 集中 require `execSync / execFileSync / execFile / exec`，配合
`gitExecutableDetector` 与 `utils/dataHome`），对外只露
`saveCheckpoint / saveCheckpointAsync / restoreCheckpoint / listCheckpoints /
diffCheckpoint / deleteCheckpoint / cleanupCheckpoints / getCheckpointStats`，
`CHECKPOINT_ROOT` 走懒 getter（`:905`）——根路径绝不在模块加载时固化（规则 1）。
`checkpointObjectStore.js` 只管内容寻址的对象与引用回收
（`digestBuffer / putBuffer / readBuffer / removeIfUnreferenced`），
CAS 语义由 `tests/workspaceCheckpointCas.test.js` 锁住。
`workspaceContext.js` 是**只读摘要**：`collectWorkspaceContext` +
`redactRemote`（远端 URL 脱敏后才进上下文）+ `_countDirty` / `_aheadBehind`。
读取与写入分家的理由是：摘要会被送进模型上下文，脱敏必须在写路径之外独立可测。

## 怎么验

```bash
cd services/backend
node --test tests/workspaceCheckpointCas.test.js                 # 3 tests / 3 pass / 0 fail
```
`tests/services/workspaceContext.test.js` 是 jest 形态（全局 `describe`），
本机 jest 渠道不可用，未复跑——见 `security/README.md` 已知缺陷 3。

## 已知缺陷（登记，不在本单元擅自修）

本目录 3 个文件当前干净（无 ` M`/`A `）。风险面记一句事实：
`restoreCheckpoint` 是**会覆盖工作区文件**的动作，因此本仓的红线
「共享工作树里禁用 `git checkout --` / 只用 cp 备份恢复」正是对它生效——
改动本文件前必须先读 `checkpointService.js` 的确认闸门，不得凭推测放宽。
