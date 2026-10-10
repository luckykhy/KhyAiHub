# [DESIGN-ARCH-183] khyos 任务自动分组 — 来源标记与固定分组方案

> 关联：[DESIGN-ARCH-177] 侧栏项目分组可辨识化改造方案（"项目"视图）、[DESIGN-ARCH-130] 前台与后台任务编排方案。
> 借鉴对象：ZCode 的 cron/off-peak 自动分组机制（逆向自其任务索引模块），并修正其在实际运行中暴露的"内存缓存回写覆盖"缺陷。

## 0. 目标与范围

- 定时自动化（后续闲时任务同理）产生的会话，**自动归入固定分组**，侧栏"分组"视图下直接可见，不靠事后标题识别。
- 分组数据从 renderer localStorage **升级为后端 SQLite 持久化**，桌面端、TUI、网页端三端共享一份真源。
- 保持 ZCode 的核心机制：**创建时打标记、系统组用固定 ID、ensure 幂等、启动回填**。

不在本期范围：闲时算力子系统本身（scheduler 进程 Phase 10 预留）；网页端分组管理 UI（本期只读展示，走后端接口）。

## 1. 现状与差距（事实基础）

| 环节 | khy-os 现状 | 差距 |
|---|---|---|
| 分组存储 | renderer localStorage：`khy.sidebar.groups`、`khy.sidebar.taskGroup`（`WorkspaceSidebar.tsx:276-290`，注释明确"宿主桥没有 group API"） | 无后端持久化，三端不共享，清缓存即丢 |
| 会话来源 | 桌面端自动化经 `fireAutomation()`→host `ai.generate`（`src/main/index.ts:448-479`，id 前缀 `auto_`）；TUI cron 调 `ai.chat('[Scheduled] '+prompt)`（`jobs/cronScheduler.js:510-521`） | 两条链路都**不把来源持久化**到会话上，事后无法辨认 |
| 会话库 | `sessions.db`（`sessionSearchIndex.js`，better-sqlite3，WAL）：`conversations` 表只有 session_id/title/model/计数/时间 | 无来源列、无分组表 |
| 侧栏 | `WorkspaceSidebar.tsx` 已有「项目」视图（`sidebarProjectClassify.ts`）与「分组」视图 | 分组视图只认 localStorage |
| TUI | `cli/handlers/session.js` 的 `session list` 仅按项目桶过滤 | 无分组概念 |

ZCode 的实现要点（逆向结论）：任务表带 `cron_automation_id` 来源列 → 代码硬编码固定组 ID（`zcode-default-group-cron`/`zcode-default-group-off-peak`）→ 会话创建时 `ensureCronGroupMembership()` 幂等挂组 → 启动时 `backfillCronGroupMemberships()` 全量回填 → UI 对固定 ID 特判（组名走 i18n、显示 `#` 图标、禁改名/删除）。
已知缺陷（本机实测）：ZCode 运行时把活跃任务的旧状态回写数据库，会覆盖外部写入的成员关系。**根因是分组存在内存缓存里、写库不经过单一所有者。**

## 2. 设计原则

1. **创建时打标记，不做事后识别**——来源在会话落库那一刻写入，分组零猜测。
2. **系统组用固定 ID**（`khyos-default-group-automation` / 预留 `khyos-default-group-offpeak`），ensure 才能幂等。
3. **分组唯一所有者是后端 SQLite**，UI 不缓存成员关系，读时 join——从根上杜绝 ZCode 的回写覆盖问题。
4. **回填必须幂等**，可重复执行不产生重复成员（`ON CONFLICT DO UPDATE`）。
5. localStorage 降级为一次性迁移源，迁移后不再参与。

## 3. 数据模型（sessions.db 迁移）

迁移落在 `sessionSearchIndex.js` 的建库流程（与其现有表同一连接、同一事务习惯），DDL 全部 `IF NOT EXISTS`/带存在性守卫：

```sql
CREATE TABLE IF NOT EXISTS session_groups (
  group_id   TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'gray',  -- 合法值: gray|red|orange|yellow|green|blue|purple
  kind       TEXT NOT NULL DEFAULT 'user',  -- 'system' | 'user'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_group_members (
  group_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  project_key TEXT NOT NULL,               -- 会话所属项目桶（沿用 sessionPersistence 的 _encodeProject 键）
  sort_order  INTEGER,
  added_at    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_key, session_id),
  FOREIGN KEY (group_id) REFERENCES session_groups(group_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_group_meta (   -- 一次性标记等
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

-- conversations 加来源列（ALTER 前用 PRAGMA table_info 守卫，列存在则跳过）
ALTER TABLE conversations ADD COLUMN source_type TEXT;  -- 'automation' | 'offpeak' | NULL
ALTER TABLE conversations ADD COLUMN source_id   TEXT;  -- automationId / 闲时任务 id
CREATE INDEX IF NOT EXISTS idx_conversations_source
  ON conversations(source_type, source_id) WHERE source_type IS NOT NULL;
```

**固定系统组**（首启时 ensure 进 `session_groups`）：

| group_id | title（库内初始值） | color | kind |
|---|---|---|---|
| `khyos-default-group-automation` | 定时任务 | blue | system |
| `khyos-default-group-offpeak` | 闲时任务 | purple | system（预留，闲时子系统落地后启用） |

用户组 ID 沿用现有前端习惯 `g_<uuid>`，与系统组靠 `kind` 列区分。

## 4. 来源标记链路（三处创建入口）

原则：`source` 作为会话元数据从触发点一路带到 `sessionPersistence.persistSession()`，落库时写入 `conversations.source_type/source_id`。会话 JSON 侧在 `.project.json` 同级的会话元数据里同步冗余一份 `source`（与 ZCode 的 meta_json 冗余做法一致）。

1. **桌面端自动化**：`src/main/index.ts` `fireAutomation()` 已持有 automationId，经 host 通道 `ai.generate` 传递（现有 id 前缀 `auto_` 保留）；host 的 `ai.generate` handler 把 `source:{type:'automation', id}` 附加到最终 `persistSession(..., metadata)` 调用。
2. **TUI cron**：`jobs/cronScheduler.js` `_defaultEnqueue` 的 `ai.chat('[Scheduled] '+prompt, { _isFollowUp: true })` 增加 `source:{type:'automation', id: job.id}`；`ai.chat` 链路把 options.source 透传到 persistSession。`[Scheduled]` 标题前缀保留，仅作显示层提示。
3. **手动会话**：source 为空 → 不挂任何系统组，行为不变。

收口点：`sessionPersistence.persistSession()` 是**唯一写入者**——新增可选参数 `metadata.source`，写 conversations 列 + 会话元数据，缺省不写。

## 5. 分组服务（后端单一所有者）

新文件 `runtime/node/backend/src/services/sessionGroupService.js`（复用 sessionSearchIndex 的连接）：

- `ensureGroup({groupId, title, color, kind})` — `INSERT OR IGNORE`，幂等。
- `ensureMembership({sessionId, projectKey, groupId, sortOrder})` — upsert（`ON CONFLICT(project_key,session_id) DO UPDATE`）。
- `ensureSystemMembership({sessionId, projectKey, sourceType, sourceId})` — sourceType→固定组映射后调 ensureMembership。
- `backfillSystemGroupMemberships()` — `SELECT session_id, project_key, source_type FROM conversations WHERE source_type IS NOT NULL` 逐条 ensure；跑完在 `session_group_meta` 写 `bootstrap_once` 标记。
- `listGroups()` / `listSessionsWithGroups({limit})` — **侧栏读取的唯一入口**，LEFT JOIN members，一次返回分组树 + 未分组列表（不再由前端拼）。
- `createGroup/renameGroup/setGroupColor/deleteGroup/moveSession/reorderGroups` — 用户组管理；`kind='system'` 的组在服务层直接拒绝改名/删除/改色（与 ZCode 的 UI 特判对应，但**收口在服务层**，多端一致）。

**启动钩子**：`sessionSearchIndex` 初始化建库完成后调用 `backfillSystemGroupMemberships()`（bootstrap 标记防重复全量扫，但 backfill 本身幂等，重复执行无害）。

## 6. IPC 与多端接口

- 桌面端（main→host 透传，与现有 `session:list` 同模式）：`sessionGroup:list`、`sessionGroup:create`、`sessionGroup:rename`、`sessionGroup:setColor`、`sessionGroup:delete`、`sessionGroup:moveSession`（拖动入组/出组）、`sessionGroup:reorder`。
- preload（`src/preload/index.ts`）按现有命名风格补 `sessionGroup.*` API。
- 网页端（Phase 2）：后端 Express 暴露 `GET /api/session-groups` 等只读+管理路由，直接调 sessionGroupService。
- TUI：`cli/handlers/session.js` 的 `session list` 增加 `--grouped`：调 `listSessionsWithGroups`，系统组显示为 `[定时任务]` 分区头；现有 TaskListPanel 的 `splitTaskLinesBySource()` 不动（那是任务清单分区，不是会话列表）。

## 7. UI 改造（桌面端 WorkspaceSidebar）

- **数据源切换**：「分组」视图从 localStorage（276-290 行）改为 `sessionGroup:list`，分组树与未分组列表由后端 join 返回；拖动/排序直接写回 IPC（`sort_order` + 组顺序），**不再在 renderer 保留第二真源**。
- **系统组特判**（对齐 ZCode）：
  - 显示名不读库内 title，走常量映射（`定时任务`/`闲时任务`），便于后续改文案不用迁移数据；
  - 组头显示 `#` 图标而非颜色点；
  - 右键菜单禁用重命名/改色/删除（服务层已有守卫，UI 同步禁用只是体验）。
- **用户组**：保留颜色（合法值 gray|red|orange|yellow|green|blue|purple）、折叠展开、拖入拖出（拖出即回「未分组」，服务层删除成员关系）。
- **「项目」视图不动**：`sidebarProjectClassify.ts` 三态逻辑照旧，与「分组」视图并列切换。

## 8. localStorage 一次性迁移

renderer 首次挂载分组视图时：若 `khy.sidebar.groups` 存在且后端 `session_groups` 中用户组为空 → 经 `sessionGroup:importGroups`（批量：建组 + 按 `khy.sidebar.taskGroup` 映射搬成员）→ 迁移成功后把 localStorage 键改为 `khy.sidebar.groups.migratedAt`（保留只读备份，不再读取）。半途失败可重试（导入按 upsert 幂等）。

## 9. 并发与防覆盖（ZCode 缺陷的修正）

- 分组成员关系的**唯一写入口是 sessionGroupService**（SQLite WAL，短事务，busy_timeout），UI、TUI、网页端都经它写，不存在"内存缓存另有一份真源再回写"的路径——ZCode 那种运行时覆盖在本方案中结构上不可能发生。
- 会话本体（title/updated_at）仍由 sessionPersistence 写；分组列只在创建时写一次 + 用户拖动时更新，冲突面极小。
- 多实例（多 host）并发：upsert 幂等 + WAL，安全。

## 10. 实施顺序

1. 迁移 DDL：`session_groups` / `session_group_members` / `session_group_meta` + `conversations` 来源列与索引（列存在性守卫）。
2. `sessionGroupService.js`：ensure/backfill/list/管理接口 + 系统组服务层守卫。
3. 启动钩子：backfill + bootstrap 标记。
4. 创建链路打标记：persistSession 收口 `metadata.source` → host `ai.generate` 与 TUI cronScheduler 两条链路接线。
5. IPC + preload。
6. WorkspaceSidebar：数据源切 IPC、系统组特判、拖动。
7. localStorage 一次性导入。
8. TUI `session list --grouped`。
9. 验证：ensure 幂等单测；手动触发一次自动化 → 会话落库带 source_type → 侧栏「定时任务」组可见；重启后回填不重复成员；拖动持久化；三端（TUI）读到同一分组。

## 11. 与 ZCode 实现的对照

| 点 | ZCode | khy-os 本方案 |
|---|---|---|
| 来源标记 | tasks 表 `cron_automation_id`/`off_peak_task_id` 列 + meta_json 冗余 | conversations `source_type`/`source_id` + 会话元数据冗余（一致） |
| 固定组 ID | `zcode-default-group-cron` 等 | `khyos-default-group-automation`/`-offpeak`（一致） |
| ensure/回填 | ensureCronGroupMembership + 启动 backfill（一致） | sessionGroupService.ensure*/backfill + bootstrap 标记 |
| UI 特判 | 渲染层按固定 ID 特判组名/权限 | 同样特判，但**权限守卫下沉到服务层**（多端一致） |
| 存储所有者 | 主进程内存缓存 + SQLite 双轨（有回写覆盖缺陷） | **后端 SQLite 单一所有者，读时 join**（修正缺陷） |
| 分组对象 | 任务（跨项目） | 会话（带 project_key 项目桶，语义一致） |
