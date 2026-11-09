# services/domain/git — Git 分支领域单元

Git 分支的**判据**与**执行**分离成一对件，后端、CLI、桌面端三方共用同一份判据。

| 文件 | 角色 | IO |
|---|---|---|
| `branchGuard.js` | 前置判据纯叶子 | 零 IO · 确定性 · 绝不抛 |
| `gitBranchService.js` | 执行层（list / switch / create） | 独占 IO（execFileSync 跑 git + 探测 `.git` 标志） |

## 为什么拆成两件

判定「这次切换会不会弄丢我的改动」需要采集大量仓库状态，但那采集是 IO；
而判定规则本身（哪些情况算阻断、错误码怎么翻译）是纯逻辑。混在一起会让规则
无法被单独测试，也让三方调用方各自复制一遍判定。故：规则在叶子，采集在壳。

## 错误码 ↔ 桌面端 i18n

`branchGuard` 的错误码与 `apps/khyos-desktop/src/renderer/i18n/zh-CN.json` 的
`git.branchSwitcher.error.*` 一一对应：

| 错误码 | 桌面端 i18n 键 |
|---|---|
| `invalidBranchName` | `git.branchSwitcher.error.invalidBranchName` |
| `branchAlreadyExists` | `git.branchSwitcher.error.branchAlreadyExists` |
| `targetBranchNotFound` | `git.branchSwitcher.error.targetBranchNotFound` |
| `conflictsPresent` | `git.branchSwitcher.error.conflictsPresent` |
| `operationInProgress` | `git.branchSwitcher.error.operationInProgress` |
| `branchInOtherWorktree` | `git.branchSwitcher.error.branchInOtherWorktree` |
| `dirtyWorkingTree` | `git.branchSwitcher.blockedDialog.*` + `error.trackedOverwrite` / `error.untrackedOverwrite` |
| `unknown` | `git.branchSwitcher.error.unknown` |

后端 `_MESSAGE` 表提供中文兜底，供无 i18n 的调用方（工具层 / CLI）使用——
**任何路径都不吐 git 的英文 stderr**。

## 复用既有资产

- git 可执行文件解析 → `services/gitExecutableDetector`（Windows 优先 Git Bash），
  与 `gitContextService` / `tools/gitStatus.js` 同一条路径，不另起一套。
- 不复用 `gitContextService`：那份是**被动观测**（给系统提示注入上下文），
  本单元是**主动操作**（切分支会改工作树），语义不同层。

## 边界

- 覆盖风险只覆盖两类：本地已跟踪的修改、会被目标分支覆盖的未跟踪文件。
  stash 后的改动不在判据内。
- `force` 不在判据内，是执行层最后手段，须由调用方在用户显式确认后传入。
- 本单元无 env 门控：分支读写是产品基座能力。

## 测试

```bash
node --test runtime/node/backend/src/services/domain/git/branchGuard.test.js
node --test runtime/node/backend/src/services/domain/git/gitBranchService.test.js
```
