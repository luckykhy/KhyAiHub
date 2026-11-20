# [DESIGN-ARCH-210] 内建代码编辑器工作台 — 人与 AI 共用同一份代码

> 状态：v1 设计已定；**M1（可用编辑器）、M2（统一写通道）与 M3（AI 改动待审）均已落地**（2026-11-11）。
> 真源范围：本文档是「桌面端内建代码编辑器」的设计真源（形态、通道契约、上限、
> 冲突三态、待审状态机）。通用工程规范仍以 `AGENTS.md` 为准。

## 0. 需求五问（RUNTIME-008）

| # | 问题 | 答案 | source |
|---|---|---|---|
| 1 | 谁用？ | 本机开发者（用户本人）在 KhyOS 里直接改工作区代码；同时是 AI 工具循环的写盘对象 | 「帮我做个人和ai都可以用的编辑器进去」 |
| 2 | 什么时候用？ | 不想切外部 IDE、要在 KhyOS 内改代码时；AI 改代码时人要能看见并批准 | 「khyos 中缺少 code 编辑器」+ 截图报错「未配置编辑器」 |
| 3 | 现在的替代做法？ | 右侧 220–640px 窄面板「查看 → 点编辑」，只改不建、读取上限 256KB；或配 `KHY_EDITOR` 跳外部 VS Code；AI 改动无审阅、与人并发写同一文件会静默互相覆盖 | 实测：`CodeEditorPane` + `codeEditor:write`；`app:openInEditor` 只收目录 |
| 4 | 成功长什么样？ | 打开工作区 → 切编辑器 → 文件树/搜索/多标签编辑并保存 3 个文件；AI 改已打开文件时出现待审 diff，批准前磁盘不变 | 用户裁决「文件树 + 多标签 + 全局搜索」「共用写通道 + 改动待审」 |
| 5 | 不做会怎样？ | 写代码仍要离开 KhyOS；人与 AI 并发写同一文件会静默丢改动 | 「主区独立工作台」不为聊天让路 |

形态与边界由人裁决（编辑器形态＝主区独立工作台；人机共用＝共用写通道 + 改动待审；
首批能力＝文件树 + 多标签 + 全局搜索；首期不做＝跳行/转到定义、LSP 诊断面板、
选区加入对话、编辑器内运行脚本）。工程实现（模块切分、上限数值、状态机形状）
由 AI 提出，依据写在本文件，可推翻。

## 1. 定位与非目标

### 1.1 与既有编辑形态的关系

| 形态 | 位置 | 通道 | 本轮处置 |
|---|---|---|---|
| `CodeEditorPane`（旧） | 右侧 SidePane `codeViewer` 标签 | `codeViewer:read` / `codeEditor:write` | **保留**，作为窄预览；M2 把写落点收口到同一服务 |
| 工作台（本文件） | 主区 `<main>` 内，与聊天并列 | `editor:*` | 新增；「看代码」的默认落点改为这里 |
| 外部编辑器 | `app:openInEditor` | 系统进程 | 保留；未配置时（`state:'unconfigured'`）不报错，TitleBar / AppHeader 的「在编辑器中打开」回落主区内置工作台；不支持 `file:line`（首期不做） |

两条读通道并存是刻意的：工作台是宽编辑面（标签 / 搜索 / 保存三态），侧栏是
「对话里点开看一眼」的窄预览。写通道**不允许**长期双轨，M2 收口（§6）。

### 1.2 明确不做（首期）

- 跳行 / 转到定义（`Ctrl+P`、`F12` 语义）。
- LSP 诊断面板（工作台只用 Monaco 内置语法高亮，不挂 `tsserver` 诊断面板）。
- 选区加入对话。
- 编辑器内运行脚本（旧面板的 `RUNNERS` 保留在侧栏，工作台不接 pty）。
- 为「像 VS Code」而 fork VS Code：本方案是 **Monaco 内核 + 一层薄 workbench 壳**，
  零新增 npm 依赖（PROCESS-013）。

## 2. 技术路线依据

VS Code 开源仓 `microsoft/vscode` 分层为 `src/vs/{base,platform,editor,workbench,code,server}`：
`editor/` 就是 Monaco，`workbench/` 才是标签、面板、活动栏。因此「像 VS Code」=
**Monaco 内核 + 一层薄 workbench 壳**，不 fork。

| 候选 | 体积 | 结论 |
|---|---|---|
| Monaco（已装） | ≈5MB，含 TS/JSON 语言服务、diff editor、多光标、折叠 | **采用**：loader/worker 已本地化（`renderer/monacoSetup.ts`），换内核是倒退 |
| CodeMirror 6 | 50–200KB 语法层，语言服务另配 | 不采用：等于把现有能力推倒重来 |
| fork VS Code | 数百 MB | 不采用：与本仓体量与维护模型不匹配 |

## 3. 架构

```
渲染层（lazy chunk）  EditorWorkbench = 文件树 240px ‖ 多标签 + Monaco ‖ AI 待审轨（M3）
        │ window.__KHYOS__.editor*
主进程  main/editor/{ipc,workspaceRules,readFile,writeFile,search,watcher}.ts
        │ nodeRequire（既有先例 main/index.ts:1916/1940/1993/2010）
后端    services/fileWriteService.js  ← 人保存与 AI 工具写盘的唯一落点（M2）
        │ host 子进程（AI 工具循环）经 fileWriteService 写盘
```

**状态归属**：标签元数据与 Monaco 模型由工作台 chunk 自己持有；`AppLayout` 只持
`centerView: 'chat' | 'editor'`、`editorRequest {filePath, seq}`、`editorDirty` 三个值
（用于切视图、外部打开、关窗拦截）。工作台一旦打开就保持挂载，`visible` 只切 CSS ——
卸载会丢标签、未保存缓冲区与 undo 栈。

**首屏预算硬约束**：`docs/10_规范/registry/CORE-LAYERS.json` 对 `App.tsx` /
`AppLayout.tsx` 的文件数零容差（`baseline == max`）。工作台只能经 `AppLayout.tsx`
内联 `lazy()` 引入（同 `:84` 的 CommandCenter 形态），**不得**改成顶层静态 import，
**不得**新增 Redux slice（`state/store.ts` 在 AppLayout 冷闭包内）。Monaco 的
loader 接线随之从 `renderer/main.tsx` 移出，改由两个 lazy 入口各自 `import`。

## 4. 通道契约

### 4.1 IPC（`main/editor/ipc.ts`，全部 `namespace:action`）

| 通道 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `editor:read` | `filePath` | `EditorReadResult` | 4 MiB 上限；NUL 探测，二进制拒读；返回 `eol`/`bom`/`mtimeMs` |
| `editor:write` | `filePath, content, baseMtimeMs?` | `EditorWriteResult` | 白名单根 + 已存在 + mtime 基线；tmp + rename 原子替换 |
| `editor:create-file` | `dirPath, fileName` | `EditorCreateResult` | `'wx'` 原子新建；文件名非法字符/结尾空格与点拒收 |
| `editor:search` | `query, EditorSearchOptions` | `EditorSearchResult` | 见 §4.3；进度经 `editor:searchProgress` |
| `editor:search-cancel` | `searchId` | `{ ok }` | 渲染层预生成 id，结果返回前即可取消 |
| `editor:watch-set` | `filePaths[]` | `EditorWatchSetResult` | 只监听这些文件的父目录（≤64个，超了报 `dropped`）；同一批路径转给 host 作为待审范围 |
| `editor:pending-list` | — | `EditorPendingItem[]` | M3：窗口重载后重建待审卡片（主进程镜像） |
| `editor:pending-decision` | `id, accept, acceptedHunks?` | `{ ok, existed }` | M3：只转发决定，落盘由 host 的闸门完成 |
| `editor:fileChanged`（事件） | `EditorFileChanged` | — | main → 渲染层；`changed` / `gone` |
| `editor:pending`（事件） | 待审原文 + 两份内容 | — | main → 渲染层；主进程已把它算成 `EditorPendingItem` |
| `editor:pendingSettled`（事件） | `{ id, ok, state, error? }` | — | main → 渲染层；`accepted` / `rejected` / `timeout` / `error` |

**白名单根**：与 `codeEditor:write` 共用 `editorWritableRoots`，不另立第二份根集合。
禁用 `fs:readFile` / `fs:writeFile` 两条无白名单孤儿通道。

### 4.2 读写的三态（失败矩阵）

| 状态 | 触发 | 渲染层行为 |
|---|---|---|
| `ok` | 正常 | 载入模型；`state:'empty'` 也算成功（空文件可编辑） |
| `missing` | ENOENT | 标签标 `gone`，保存会失败；提示「已不在磁盘上」 |
| `conflict` | 磁盘 mtime ≠ 基线 | 横幅三选一：覆盖写入 / 重新加载（丢弃我的修改）/ 不动 |
| `outsideWorkspace` | 不在白名单根内 | 错误态 + 「重新读取 / 关闭标签」，不重试 |
| `tooLarge` | 超 4 MiB | 错误态并说明上限 |
| `binary` | 前 4KB 含 NUL | 错误态并说明「二进制文件不支持编辑」 |
| `error` | 其余 IO 失败 | 错误态，文案带动作 + 目标 |

**CRLF / BOM**：读时探测，模型内部统一 `\n`；保存时按原 `eol` 还原、BOM 原样带出。
不认识的编码不猜，按文本读或直接报错 —— 静默改写行尾会让整份文件进 diff。

### 4.3 全局搜索的上限与预算

| 项 | 值 | 理由 |
|---|---|---|
| 单文件读取上限 | 512 KiB | 大文件（bundle/日志）不参与全文搜索 |
| 累计读取上限 | 64 MiB | 防止整仓扫穿磁盘 |
| 命中总数上限 | 500 | UI 展示边界 |
| 命中文件数上限 | 200 | 分组展示边界 |
| 单文件命中上限 | 20 | 防止一个文件淹没结果 |
| 预算 | 15 000 ms | **协作式**：循环内检查 `Date.now()` 并 `await setImmediate` 让出事件循环 |

不设硬 kill 定时器（RUNTIME-003）：超限返回 `truncated + reason`，UI 如实显示
「还有 N 个文件未扫描」，取消走 `editor:search-cancel`。

### 4.4 磁盘变更（watcher）

- 只监听打开标签的父目录，目录数 ≤64（LRU），超了 `dropped` 如实上报。
- 150 ms 去抖；自写自触发用 `SELF_WRITE_SUPPRESS_MS = 2000` 抑制。
- 标签干净 → 自动从磁盘重载并提示；标签脏 → 只标 `externalChanged`，**不覆盖**
  人的未保存内容，横幅提示冲突。

## 5. 模型与脏判定

- 正文唯一真源 = Monaco model（按 `file://` URI 注册，Windows 盘符大写 + `encodeURI`）。
- 只给 `defaultValue`，**不给** `value`：受控 `value` 会在每次重渲染时 `setValue`，
  等于把 undo 栈清空。
- 脏判定 = `model.getAlternativeVersionId() !== savedVersionId`（撤销回保存点会自动变干净），
  不做字符串全量比较。
- 基线在模型挂载 / 切换时（`onDidChangeModel`）建立 —— `onMount` 只触发一次，
  但 `path` 每次切标签都会换模型。
- 关标签时延迟到下一轮再 `dispose()` 模型（跳过已被重新打开的标签），避免
  dispose 仍挂在编辑器上的模型。

## 6. M2：统一写通道收口（已落地 2026-11-11）

新增 `runtime/node/backend/src/services/fileWriteService.js`：

```
write({ filePath, content, baseMtimeMs?, createIfMissing=false,
        actor:'tool'|'editor', reason, beforeContent?, turnId?, diagCwd?, skipAudit? })
  → { ok, state:'ok'|'conflict'|'missing'|'rejected'|'error', mtimeMs?, diskMtimeMs?, error? }
```

顺序：校验 → stat → mtime 冲突 →（M3 待审闸门）→ 快照/turn 记录 → 诊断基线 →
`mkdir` + tmp/rename → `_readTracker.markRead`。

锁：内部复用 `tools/_fileLock.acquire(filePath)`（同进程可重入；跨进程真互斥）。

工具侧只改「写盘那一行」，编排留在工具里（`ApplyPatchTool` 的多文件全成或全回滚、
`MultiEditTool` 的 all-or-nothing 不动）。`main/editor/writeFile.ts` 改为 `nodeRequire`
该服务（`actor:'editor'`），写后向 host 发 `editor.fileWritten` 让其 `_readTracker.markRead`
—— 否则人保存后 AI 的「先读后写」会误判 stale 而拒绝编辑。

两条落地时的补充判据：

- `skipAudit` 只给 `ApplyPatchTool`：它 Phase 1 已按批登记快照与 turn，通道侧再记一遍
  会让同一次补丁出现两条历史记录。多文件全成或全回滚仍由工具自己编排。
- 新建空文件不走 `editor.fileWritten`：把「没读过」记成「读过了」会直接废掉 AI 的
  先读后写闸门。人保存已有文件才发通知。

反证（`src/services/fileWriteSinkTools.test.js`）：把通道的 `write` 换成**不落盘**的
探针，逐个调用 8 个写盘工具，断言「探针收到调用 + 磁盘内容一字未变」。工具私自
`fs.writeFileSync` 会让这两条同时失败。

## 7. M3：AI 改动待审（已落地 2026-11-11）

### 7.1 闸门位置与范围

闸门放在 `fileWriteService` 内部（工具链没有干净的 pre-write hook：`riskGate` /
`PreToolUse` 都发生在「新内容算出之前」，`_khyWriteDiff` 是写后回读）。收口后
闸门就是一个 `if`。

**只审「编辑器打开集合」内的路径**：主进程每次标签开/关发 `editor:watch-set` →
主进程转成 `editor.watchSet` 给 host；host 维护规范化后的 `Set<path>`。未打开的
路径照旧直写 —— AI 能力不退化。主进程里**不注册**闸门：人保存不该被拦。

闸门契约（`fileWriteService.setPendingGate`）：

```
(req: { filePath, content, beforeContent?, baseMtimeMs?, actor, reason })
  → { action: 'write' }                    // 放行，写原 content
  | { action: 'write', content: string }   // 放行，写子集拼好的内容（逐 hunk 接受）
  | { action: 'reject', error }
```

抛错按拒绝处理（fail-closed）。闸门返回后 `fileWriteService` **再 stat 一次**：
批准期间磁盘被改（mtime 超出 50 ms 容差）→ `conflict`，不落盘、不猜。

### 7.2 待审状态机

```
         工具发起写（actor='tool' 且路径在打开集合内）
                     │
                     ▼
              ┌─────────────┐  同文件已有待审  ┌──────────────┐
              │   pending   │ ───────────────▶ │ rejected(dup)│
              └─────────────┘                  └──────────────┘
               │     │      │
     接受(全部/子集) 拒绝   120s 超时 / 关窗
               │     │      │
               ▼     ▼      ▼
           写入磁盘  rejected  rejected(timeout/cancelled)
        (闸门返回后再校验 mtime，conflict 则不落盘)
```

- **接受**：host 用 `utils/diff/structuredHunks` 重算 hunk，`applyAcceptedHunks`
  拼出选中的块，作为 `verdict.content` 交回闸门；落盘仍走 `fileWriteService`
  （复用同一把锁与 mtime 校验）。
- **拒绝**：不写，工具收到 `{ ok:false, state:'rejected', error:'用户未批准该改动（磁盘保持原样）' }`。
- **超时**：`PENDING_REVIEW_TIMEOUT_MS = 120_000`，到点 resolve 为 reject 并推
  `editor:pendingSettled{state:'timeout'}`（RUNTIME-003「仅 reject 的 Promise 超时」豁免，不 kill 任务）。
- **关窗/退出**：`win.on('close')` → 主进程 `cancelAllPending()` → host `settleAll()`
  全部 resolve reject，并清空主进程镜像；文件从未落盘，无需回滚。
- **内容无变化**：`before === after` 时闸门直接放行（没有可审的东西）。

### 7.3 diff 来源与块的唯一口径

主进程 `main/editor/pending.ts` 用 `nodeRequire` 的 `cli/writeDiffRows.js`
`buildWriteDiffRows(ctx, true)` 生成 `DiffRow[]`（与 `host/index.ts` 同一生产者），
去掉 `stat` 行并把 `⋯ N unchanged lines` 本地化，截断到 `MAX_DIFF_ROWS`。

hunk 切分是纯函数 `shared/editorDiff.ts`：

- `splitDiffHunks(rows)`：在 `kind === 'gap'` 处切块，`stat` / `more` 不进任何块；
- `applyAcceptedHunks(before, after, hunks, accepted)`：按 backend
  `computeStructuredDiffHunks` 的块模型拼接受集；全接受返回 `after` 原样，
  一块不接受返回 `before` 原样。

`tests/editorDiff.test.mjs` 守的是最贵的一条不变量：`splitDiffHunks(buildWriteDiffRows(...))`
的块数必须等于 `computeStructuredDiffHunks(...).hunks.length` —— 错一位就等于把
用户拒绝的改动写进磁盘。

行集被截断（> `MAX_DIFF_ROWS`）时**禁掉逐块勾选**，只给整体接受/拒绝：界面上
看不见的块会随子集拼接被静默丢掉，那正是「批准了没看过的改动」的反面。

渲染层复用 `shared/toolDiff.ts` + `DiffViewer` 的行模型；待审面板
（`PendingReviewPanel.tsx`）把每块做成可勾选的卡片，默认全选。

### 7.4 缓冲区保护

标签 `dirty` 时**禁用「接受」**：待审 diff 基于磁盘内容，接受会让人未保存的修改
与 AI 内容互相覆盖。提示先保存或还原。多块勾选后全部取消 → 按拒绝处理。

### 7.5 实施记录

| 文件 | 位置 | 职责 |
|---|---|---|
| `editorDiff.ts` | `src/shared/` | 切块 / 子集拼接（纯函数） |
| `editorPending.ts` | `src/host/` | 待审状态机：打开集合、`Map` 单文件单审、超时、`settleAll` |
| `pending.ts` | `src/main/editor/` | diff 行生成 + `EditorPendingItem` 组装 |
| `PendingReviewPanel.tsx` | `renderer/components/editor/` | 右轨待审卡片（勾块 / 拒绝 / 接受） |

接线：`host/index.ts`（注册闸门 + 三条消息）、`main/editor/ipc.ts`（镜像 + 中继）、
`main/index.ts`（host 消息分支 + 关窗取消）、`preload/editor.ts` 与
`editorApi.ts`（两条调用 + 两个事件）、`EditorWorkbench.tsx`（拉取 / 订阅 / 决定）。

反证：`runtime/node/backend/src/services/fileWriteService.test.js` 覆盖
「闸门拒绝不落盘」「闸门抛错 = 拒绝」「`verdict.content` 替换落盘内容」
「批准期间磁盘被改 → conflict」四态；`apps/khyos-desktop/tests/editorPendingGate.test.mjs`
覆盖闸门状态机五条：「人保存与未打开不拦 / 拒绝收束 / 逐块接受 / 同文件重复拒绝 /
关窗全取消」。

## 8. M1 实施记录

新增（主进程，`apps/khyos-desktop/src/main/editor/`）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `workspaceRules.ts` | 41 | `SKIP_DIRS` / `TEXT_EXTS` 单一真源（原 `main/index.ts` 两处副本） |
| `readFile.ts` | 73 | 4 MiB 上限、NUL 探测、eol/bom 探测 |
| `writeFile.ts` | 142 | 白名单 + mtime 基线 + tmp/rename + `'wx'` 新建 |
| `search.ts` | 260 | 异步 BFS + 协作式预算 + 四件套上限 + 取消 |
| `watcher.ts` | 129 | 父目录监听（≤64 / LRU / 150ms 去抖 / 自写抑制） |
| `ipc.ts` | 72 | 六条通道注册 |

新增（共享与渲染层）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/shared/editorContract.ts` | 137 | 上限常量 + 五组契约类型 |
| `components/editor/editorApi.ts` | 33 | preload 桥的类型与存在性检查 |
| `components/editor/editorModels.ts` | 46 | 路径规范化 / `file://` URI / `toDiskText` |
| `components/editor/editorLanguages.ts` | 45 | 扩展名 → Monaco 语言 / 运行器（与侧栏共用） |
| `components/editor/EditorTabs.tsx` | 81 | 标签栏（脏点 / 中键关闭 / 阻断态） |
| `components/editor/EditorSurface.tsx` | 116 | 唯一 Monaco 实例 + 状态栏 + `Ctrl+S` |
| `components/editor/SearchPanel.tsx` | 222 | 全局搜索（进度 / 取消 / 截断原因） |
| `components/editor/EditorWorkbench.tsx` | 689 | 外壳：文件树 ‖ 标签 + Monaco ‖ 冲突与新建/关闭确认 |

修改：`AppLayout.tsx`（内联 lazy + 三值状态 + `<main>` 条件渲染 + `khy:open-file-picker` 切工作台）、
`TitleBar.tsx`（菜单项 + 右侧按钮 + 脏点 + 未配置编辑器回落）、`AppHeader.tsx`
（「在编辑器中打开」未配置时回落工作台）、`CommandCenter.tsx`（命令入口）、`FileTree.tsx`
（`refreshToken` / `onCreateFile`）、`CodeEditorPane.tsx`（改用 `editorLanguages` +
自带 `monacoSetup`）、`renderer/main.tsx`（移出 `monacoSetup`）、`shared/keymap.ts`
（`Ctrl+Shift+E`）、`preload/index.ts`（六通道 + 两个事件）。

快捷键：`Ctrl+Shift+E` 切换工作台（登记进 `KEY_BINDINGS`，命令面板与窗口菜单的
徽标都从这张表派生；`tests/keymapContract.test.mjs` 的 C1 要求每个登记的 action
在渲染层有 `action === '<name>'` 消费点）。

入口：窗口菜单「代码编辑器」、标题栏右侧代码按钮、命令面板「切换代码编辑器」、
侧栏文件树点文件、`khy:open-file` 事件（消息流「查看文件」）。

## 9. 治理与登记

| 项 | 动作 |
|---|---|
| RUNTIME-001 | 上限与忽略目录集中到 `shared/editorContract.ts`、`main/editor/workspaceRules.ts`；无绝对路径字面量 |
| RUNTIME-002 | 搜索/保存/冲突/重载文案全部「动作 + 目标 + 进度」，禁「处理中」 |
| RUNTIME-003 | 搜索用协作式空闲预算（无硬 kill 定时器）；M3 待审等待以 reject 收束 |
| RUNTIME-008 | 需求五问见 §0 |
| PROCESS-013 | 零新增依赖（不引 ripgrep / chokidar） |
| PROCESS-014 | 不新增 CLI 命令 / 别名 / handler；新增 IPC 不计入棘轮 |
| CORE-LAYERS | 不给 `App.tsx` / `AppLayout.tsx` 加静态 import，不新增 Redux slice |
| FEATURE-OWNERSHIP | 待 M2/M3 登记 `code-editor-workbench`、`file-write-sink` 两个能力域；`fs:writeFile` 记 forbidden |

## 10. 验证

```bash
cd apps/khyos-desktop && node scripts/typecheck-baseline.cjs
node --experimental-strip-types --test tests/keymapContract.test.mjs tests/editorContract.test.mjs tests/editorDiff.test.mjs
node --test tests/desktopUiContract.test.cjs
cd ../.. && node --test runtime/node/backend/src/services/fileWriteService.test.js
node --test runtime/node/backend/src/services/fileWriteSinkTools.test.js
node scripts/ci/check-core-layers.js
node scripts/ci/check-agent-rules.js --changed
```

M1 手工路径：`npm run dev` → `Ctrl+Shift+E` → 文件树打开 3 个文件 → 改一个不保存 →
切/关标签触发拦截 → 新建文件 → 搜索看进度与取消 → 记事本外部改文件看到「磁盘已变」。

M2 / M3 手工矩阵见本文件 §6 / §7。2026-11-11 实测：桌面端 317 mjs + 351 cjs 全绿
（cjs 含未配置编辑器回落的 D11 契约），`fileWriteService.test.js` 11/11、
`fileWriteSinkTools.test.js` 9/9，类型检查仍为「既有 4 条」，
`check-core-layers` 10 条既有 finding 未增，`check-agent-rules --changed` 0 违规。
