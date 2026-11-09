# [DESIGN-ARCH-205] khyos Git 深度集成 — 分支能力从「看得见」到「选得了」

> 状态：v1 已实现（后端分支领域服务 + 工具层分支工具 + 桌面端分支选择器）。
> 真源范围：本文档是「Git 分支能力」的设计真源；Git 工作流 / 提交规范 / 自动化治理的
> 真源仍是 `[DESIGN-GIT-001]`～`[DESIGN-GIT-004]`（`docs/10_规范/DESIGN-GIT/`）。
>
> **本文档解决的问题**：khyos 桌面端能显示当前分支名，但**不能选分支**；Agent 侧
> 七个 git 工具里**没有一个与分支相关**；TUI 侧**没有 Git 概念**。用户诉求原话：
> 「khyos中无法选择分支，没有Git概念需要设计一个git深度集成方案」。

## 1. 现状盘点（2026-11-08 实测，非推测）

盘点结论来自对当前工作树的实际检索与运行验证，逐条可复核：

| 层 | 现状 | 缺口 |
|---|---|---|
| CLI | `khy repo branch list` / `switch` 已存在（`cli/handlers/repo.js`） | 有分支概念，但只在 CLI，Agent 与桌面端都够不着 |
| Agent 工具 | `gitStatus` / `gitDiff` / `gitCommit` / `gitPush` / `gitLog` / `gitClone` / `gitBlame` 七个 | **无任何分支工具**——AI 查不到分支名、也切不了分支 |
| 后端服务 | `gitContextService`（把分支名注入系统提示）、`gitOperationTracker`（事后从 shell 输出里**检测** checkout/rebase） | 都是**被动观测**；没有主动的分支领域模型 |
| 桌面端 | `GitPanel.tsx` 只读 `git status -z --branch`，显示分支名 | **分支名是纯文本，点不动** |
| 桌面端 i18n | **已有整套 `git.branchSwitcher.*` 词条**（约 40 条：搜索框、新建分支、脏文件阻断弹窗、worktree 冲突、无效分支名……） | **词条在、实现不在**——上游基线有完整设计稿，重写时丢了接线 |
| TUI | Git 只在横幅/系统提示里露一个分支名 | 无 Git 概念面板 |
| HTTP 面 | `routes/` 无 git 路由 | 后端无对外 Git API |

**关键发现**：桌面端那套 `git.branchSwitcher.*` 文案是**上游基线继承下来的完整设计稿**，
连失败面都列全了（脏文件被覆盖、worktree 冲突、仓库有未解决冲突、有进行中的 Git 操作、
分支名无效、分支已存在）。所以本方案的第一原则是**把这份既有设计接回来**，而不是另起炉灶。

### 1.1 更深一层：底座本身是坏的

盘点过程中发现一个更底层的缺陷，它让「Git 能力」在本机整体失效：

`gitExecutableDetector` 的 PATH 扫描用 `existsSync` 判定候选，而 `existsSync` **对目录
同样返回 true**。本机 PATH 上存在名为 `git` 的**目录**（portable Git 的
`D:\Portable\Tools\git`），于是 detector 返回了这个目录而不是
`D:\Portable\Tools\git\cmd\git.exe`。后果是**静默**的：

- `spawnSync(目录)` → `ENOENT`
- 调用方把它当成「本机没装 git」→ 诚实降级为「无 Git」
- `gitStatus` / `gitContextService` / `gitCommit` / `gitPush` 全部失效，**且没有任何报错线索**

实测证据（修复前）：`detectGitExecutable()` 返回 `"D:\\Portable\\Tools\\git"`（是目录），
`execSync('"D:\\Portable\\Tools\\git" status --porcelain')` 报
`'"D:\Portable\Tools\git"' is not recognized as an internal or external command`。
修复后返回 `"D:\\Portable\\Tools\\git\\cmd\\git.exe"`，`git status` 正常输出。

这解释了「没有 Git 概念」的体感——**不是没有设计，是底座断了且断得没有声音**。

## 2. 设计原则

1. **不另起炉灶**：复用既有 `gitExecutableDetector` 的可执行文件解析、既有
   `DESIGN-GIT-001`～`004` 的规范口径、既有桌面端 i18n 文案、既有工具注册与风险闸机制。
2. **判据单一真源**：分支名合法性、会不会覆盖本地改动、有无冲突等判定**只写一遍**
   （后端纯叶子 `branchGuard.js`），后端服务 / CLI / 桌面端 / 工具层共用。
   前端**不做第二套判定**——两端规则必然漂移，这是本方案要消灭的问题本身。
3. **只读先行，写操作需人确认**：符合仓库红线 R1（分支纪律）。Agent 查分支可自动放行；
   切/建分支必须过确认闸。
4. **诚实失败**：git 的英文 stderr 绝不透给用户，一律翻译成错误码 + 中文文案；
   映射不到就落到 `unknown`，**宁可说「不知道」，也不伪造具体原因**。

## 3. 架构

```
                     ┌──────────────────────────────────────┐
   桌面端 GitPanel    │ services/domain/git/                │
   ┌──────────────┐   │  ├─ branchGuard.js   判据纯叶子      │
   │BranchSwitcher│──▶│  │   零 IO · 确定性 · 绝不抛          │
   └──────┬───────┘   │  └─ gitBranchService.js  执行层      │
          │ IPC       │      list / switch / create         │
          │           └───────────┬──────────────────────────┘
   ┌──────┴───────┐               │ 同一份判据
   │ preload      │               │
   │ main         │               │
   └──────────────┘               │
                     ┌────────────┴─────────────┐
                     │ tools/gitBranch.js  只读  │ → risk safe → 自动放行
                     │ tools/gitSwitch.js  写操作 │ → risk medium → L1 确认
                     └──────────────────────────┘
                                 （force 时 isDestructive → L2 红灯）
```

### 3.1 判据与执行分离

`branchGuard.js` 是**纯叶子**：零 IO、确定性、绝不抛、一切经入参注入。它回答「这次切换
允许吗、不允许的话是为什么」。

`gitBranchService.js` 是**执行层**：独占 IO（`execFileSync` 跑 git、`fs.existsSync` 探测
`.git` 下的进行中操作标志），把状态**采集**起来交给叶子**判定**，然后执行或翻译失败。

拆两件的理由：判定需要大量仓库状态（那是 IO），但判定规则本身是纯逻辑。混在一起
规则就没法被单独测试，三方调用方也会各自复制一遍判定。

### 3.2 错误码 ↔ 桌面端 i18n 一一对应

| 错误码 | 桌面端 i18n 键 | 含义 |
|---|---|---|
| `invalidBranchName` | `git.branchSwitcher.error.invalidBranchName` | 分支名非法 |
| `branchAlreadyExists` | `git.branchSwitcher.error.branchAlreadyExists` | 分名已存在 |
| `targetBranchNotFound` | `git.branchSwitcher.error.targetBranchNotFound` | 目标分支不存在 |
| `conflictsPresent` | `git.branchSwitcher.error.conflictsPresent` | 有未解决冲突 |
| `operationInProgress` | `git.branchSwitcher.error.operationInProgress` | 有进行中的 Git 操作 |
| `branchInOtherWorktree` | `git.branchSwitcher.error.branchInOtherWorktree` | 分支在别的 worktree 检出 |
| `dirtyWorkingTree` | `git.branchSwitcher.blockedDialog.*` | 本地改动会被覆盖 |
| `unknown` | `git.branchSwitcher.error.unknown` | 诚实降级 |

后端 `_MESSAGE` 表提供中文兜底，供无 i18n 的调用方（工具层 / CLI）使用。

## 4. 已实现内容

### 4.1 后端分支领域单元

`runtime/node/backend/src/services/domain/git/`

| 文件 | 角色 | IO |
|---|---|---|
| `branchGuard.js` | 前置判据纯叶子 | 零 IO · 确定性 · 绝不抛 |
| `gitBranchService.js` | 执行层（list / switch / create） | 独占 IO |
| `branchGuard.test.js` | 判据测试（34 例） | node:test |
| `gitBranchService.test.js` | 执行层测试（18 例，**真建临时 git 仓库**） | node:test |
| `khy.module.json` | 单元清单（domain D2 / fanIn / lifecycle / contract） | — |
| `README.md` | 单元说明 | — |

执行层测试刻意**不 mock 掉 exec**——执行层的价值恰恰在于「真仓库上真切换」，故每次测试
自建自销临时 git 仓库，绝不碰仓库自身的 `.git`。

### 4.2 工具层

| 工具 | 风险 | 语义 |
|---|---|---|
| `gitBranch` | `safe` + 只读 | 列出本地分支，标出当前分支与 upstream/ahead/behind。**自动放行** |
| `gitSwitch` | `medium` | 切换分支（可选 `create` 新建）。**走 L1 确认闸**；带 `force` 时 `isDestructive` → **L2 红灯** |

两者成对：**没有 `gitBranch` 就无从知道有哪些分支**，AI 只能猜分支名或退回裸 shell 命令。

### 4.3 桌面端

- `BranchSwitcher.tsx`：分支名可点击 → 打开选择器；搜索框、新建分支、脏文件阻断弹窗
  （给「提交并切换」与「丢弃改动并切换」两条明确出路）。
- **文案复用既有词条**：组件走 `react-i18next` 的 `useTranslation`，错误码表映射到
  上游基线留下的 `git.branchSwitcher.error.*`（44 条既有词条），**不另写一套文案**。
  只补了三条确有缺口的新键：`blockedDialog.forceAction`（丢弃改动并切换）、
  `currentBadge`（当前）、`otherWorktreeBadge`（其它 worktree）。
  契约测试会断言「组件引用的每个 i18n 键都在 `zh-CN.json` 里存在」——漏键在运行时会
  显示成裸键名，这类问题类型检查抓不到。
- IPC：`git:branchList`（只读）/ `git:branchSwitch`（写操作）。
- `Icon.tsx` 补 `git-branch` 字形（lucide `GitBranch`）。

**强制切换必须显式传 `force`**：普通切换路径绝不默认 force，否则会静默丢弃用户改动。

### 4.4 CLI：本轮**未**改（明确的范围边界）

`khy repo branch list` / `switch` 仍走它自己的一套分支解析：自己跑 `git branch` 并切
字符串，自己用正则匹配 git 的英文报错来判断「是不是本地改动冲突了」。这与本单元的
判据构成**第二份**，正是本方案要消灭的「判据在两处」。

本轮**没有**改它，两条理由：

1. **范围边界**：本轮范围经确认是「桌面端 + 工具层」，CLI/TUI 明确列为「只复用不重做」。
   改 CLI 的 `branch` 子命令会动到既有命令的输出格式与提示文案，属于扩大范围。
2. **守卫硬阈**：`check-change-safety.js` 的 `ERROR_CHANGED_FILE_COUNT = 20`。
   加上 CLI 后本轮改动面为 21 个文件，越阈即 error。实测逐一验证过其余 20 个文件
   都承重或为必需——`domain/git/README.md` 移除后 `functional-unit` 272→273、
   `entry-buffer` 2406→2407（承重，不能删）；`khy.module.json` 移除后计数不变
   （非守卫强制，但为 D2 新单元的晋级记录，保留）。

后续做 CLI 收口时的要点（已在此登记，避免下次重新推演）：
- `list` 改走 `listBranches()`，输出当前分支标记、upstream 的 ↑↓ 计数、其它 worktree 占用；
- `switch` 改走 `switchBranch()`，错误码 → 中文提示（与桌面端 i18n 同一套语义），
  `dirtyWorkingTree` 时列出受影响文件清单；
- 已在本轮临时验证过该改造可行（临时 git 仓库三条路径：列表正确、切换后
  `rev-parse` 确认已切到目标分支、不存在的分支给出正确提示），实施时可直接复用。

## 5. 修复的底座缺陷

`services/gitExecutableDetector.js` 的 `_scanPathForGit` 现在对每个命中再做一次
`isFile()` 判定，目录直接跳过、继续扫下一个候选。

**为什么这条必须修**：不修的话，桌面端与工具层新增的分支能力在本机会**同样静默失效**
（spawn ENOENT → 降级成「没装 git」）。分支能力建在断掉的底座上没有意义。

回归测试打的是**扫描叶子本身**（`_scanPathForGit`）——因为注入模式会整体跳过 PATH 扫描
（保持历史字节一致），走解析器接口的断言永远打不到真路径。

## 6. 实施中踩到并修掉的三个真问题

诚实记录，因为它们都**只在真环境跑才会暴露**：

1. **detector 把目录当可执行文件**（见 §5）——`existsSync` 对目录返回 true。
2. **worktree 路径斜杠方向不一致**——git 在 Windows 输出正斜杠（`C:/Users/x/repo`），
   `process.cwd()` 是反斜杠（`C:\Users\x\repo`）。直接字符串比较必然不等 →
   当前 worktree 被误判成「别的 worktree」→ 切换被无谓阻断。已加路径归一化。
3. **`%(worktreepath)` 对当前分支同样返回路径**——不判 `isCurrent` 就会把当前分支
   标成「已在其它 worktree 检出」。

另有一条测试自身的缺陷值得记：覆盖风险用例里两个分支的 `a.txt` 内容相同，
切换根本不会覆盖——判据没错，是夹具没构造出差异。

## 7. 后续（未实现，明确排除）

| 项 | 状态 | 说明 |
|---|---|---|
| TUI 侧 Git 面板 | 未实现 | 本轮范围按桌面端 + 工具层；TUI 可复用同一后端服务 |
| 远端分支 / PR 视图 | 未实现 | 需 GitHub/GitLab 接入，超出「选分支」诉求 |
| 合并 / 变基 / 冲突解决 UI | 未实现 | 属于 Git 高级工作流，非本轮 |
| `khy repo branch` 收口到本服务 | 未实现 | 见 §4.4：范围边界 + 守卫硬阈；要点已登记 |
| 分支保护规则 | 未实现 | 需远端协同 |

## 8. 验收

| 门禁 | 命令 | 结论 |
|---|---|---|
| 判据测试 | `node --test runtime/node/backend/src/services/domain/git/branchGuard.test.js` | 34/34 |
| 执行层测试 | `node --test runtime/node/backend/src/services/domain/git/gitBranchService.test.js` | 18/18 |
| detector 回归 | `jest tests/gitExecutableDetector.test.js` | 12/12 |
| detector 旁证 | `node --test`（resolver / softExec / spawnHelper） | 全绿 |
| 桌面端分支契约 | `node --test tests/gitBranchUiContract.test.cjs` | 13/13 |
| 桌面端 UI 契约 | `node --test tests/desktopUiContract.test.cjs` | 26/26 |
| 桌面端全量 | `node --test tests/*.test.cjs`（24 个文件） | **335/335** |
| 类型检查 | `npm run typecheck` | 无新增错误（既有 4 条基线不变） |
| 构建 | `electron-vite build` | 成功 |
| 守卫·变更安全 | `check-change-safety.js <本轮 20 个文件>` | **0 error**（2 warning：本机无 Python、改动面提示级） |
| 守卫·Agent 规则 | `check-agent-rules.js <本轮文件>` | 全绿 |
| 守卫·仓库布局 | `check-repo-layout.js` | `functional-unit` 290→272（净降 18）、`entry-buffer` 2470→2406；三个 error 均为工作树既有根目录残留（11/5–11/7 创建，早于本轮） |

### 8.1 一个既有的、与本轮无关的测试失败

`tests/gitCommitTiming.test.js` 的「enforce：判据全绿 → 真的提交」用例失败，报
`提交时机判据未通过(do-not-commit): 未满足 1 条判据：T2`。

**已用 stash 对照实验证明与本轮无关**：把 `gitExecutableDetector.js` 单独 stash 回退到
修复前状态后重跑，该用例**同样失败**（8 例中仍为 7 通过 1 失败）。故属工作树既有
问题（提交时机判据 T2 与测试夹具的 task-id 解析），不在本轮范围。

### 8.2 索引登记只登记就近索引

本文档登记在 `DESIGN-ARCH/00_INDEX_DESIGN-ARCH-总目录.md`（就近索引），**未**登记进
`docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md`。

依据：`check-repo-layout.js` 的 `checkDocsIndexComplete` 判据是「主索引**或**就近索引
有」即合规（B8 去重写法，见 [DESIGN-PLAN-009] §2 五层骨架 L-D0），就近索引才是清单
真源。既有 `[DESIGN-ARCH-201]`～`[DESIGN-ARCH-204]` 四篇同样只登记在就近索引——
分类索引自 `[DESIGN-ARCH-200]` 之后未再收新篇（该表存在 192–199 的历史欠账，属他人
账目，本轮不代劳补登）。且分类索引一行会让本轮改动面从 20 涨到 21，越过
`check-change-safety.js` 的 `ERROR_CHANGED_FILE_COUNT = 20` 硬阈。

> 顺带记录：分类索引工作树里已有他人未提交的 48 行改动（补登 165–191 等）。本轮
> 曾加过 205 一行，发现越阈后已移除，**未触碰那 48 行**——`git diff` 显示的仍是
> 他人那部分。

