<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-177] 侧栏项目分组可辨识化改造方案（项目名脱离路径末段 + 身份标识 + 层级感知）

> **状态**：**已落地**（2026-10-03，三期全实施并重建产物；实施记录见 §10）
> **范围**：`apps/khyos-desktop/src/renderer/components/layout/WorkspaceSidebar.tsx`（项目 tab 的文件夹视图）
> **上游依赖**：无（不借鉴任何外部项目）
> **调研指针**：用户 2026-10-03 提供的两张截图 —— 图1 = khyos 侧栏实况（项目名 `Portable` / `khy-durable-transcript-OotVEc` / `khy-os` 混列）；图2 = WorkBuddy「新建工作区」弹窗（源文件夹 + 名称 + 图标 + 颜色 四段式）
> **模板合规**：B-P2 七字段据实声明「不适用 + 依据」（见 §2，零借鉴 ⇒ 第 1 字段本就不触发）
> **B-P1 豁免判定**：本改动为**行为修正**（项目名取错、身份不可辨），非新增能力域，适用 `[DESIGN-SOURCING-001] §3 B-P1` 豁免

---

## 0. 一句话结论

侧栏「项目」tab 的文件夹名是 `workspacePath` 的**路径末段机械取值**，而 `workspacePath` 记录的是**会话当时的工作目录**，不是用户登记的「项目」。二者混用导致三类可辨识性崩塌：**父目录冒充项目**（`Portable` 26 条）、**临时目录冒充项目**（`khy-durable-transcript-*` 各 1 条）、**同名项目无法区分**（两个不同路径都叫 `backend`）。修法不是加图标或加颜色（那是装饰），而是**先给项目一个独立身份**（路径 → 项目记录的映射 + 显示名 + 可选图标/颜色），让列表按身份分组而非按路径末段。

| 病灶 | 证据 | 用户可见症状（图1） |
|---|---|---|
| P1 项目名 = 路径末段 | `WorkspaceSidebar.tsx:306-309` `baseName()`、`:353` `name: p ? baseName(p) : '未归属项目'` | `Portable` 与 `khy-os` 同列，父目录成了「项目」 |
| P2 分桶键 = 完整 `workspacePath` | `:342-355` `byPath` 以整串路径为 key | 同一项目的不同子目录被拆成多个「项目」 |
| P3 身份只有路径，没有登记 | 全仓无项目登记表；`settingsStore.ts:67-77` 只有 `desktopWorkspacePath`（单值）+ `desktopRecentWorkspaces`（MRU，上限 8） | 无法给项目起名、配色、图标；无法把散在同一项目下的会话归拢 |
| P4 文件夹头无身份标识 | `:662-664` 仅 `▸/▾` + 名字 + 计数 | 一排灰字，扫不出哪个是常用项目 |
| P5 会话标题未出现在文件夹头 | `:752-760` 任务行才有 `title` | 想知道「khy-os 那个项目里在干什么」必须逐条展开 |

---

## 1. 现状实证

### 1.1 项目名与分桶：全部由 `workspacePath` 派生

`WorkspaceSidebar.tsx`：

- `:31-38` `interface Task { id; title; workspacePath; createdAt; updatedAt; archived }` —— **Task 上没有 projectId**，只有裸路径。
- `:306-309`
  ```ts
  const baseName = (p: string) => {
    const seg = p.split(/[\\/]/).filter(Boolean)
    return seg.length ? seg[seg.length - 1] : p
  }
  ```
  取路径**最后一段**。`D:\Portable` → `Portable`；`D:\Portable\khy-os\apps\backend` → `backend`。
- `:342-348` 项目视图分桶：
  ```ts
  const byPath = new Map<string, Task[]>()
  for (const t of filteredOrdered) {
    const p = t.workspacePath || ''
    ...
  }
  ```
  key 是**整串路径**（`:351` `key: \`project:${p || 'none'}\``），两个不同路径末段同名 ⇒ 屏幕上同名文件夹，key 不同 ⇒ 拖拽归组/折叠互不干扰。
- `:353` `name: p ? baseName(p) : '未归属项目'` ⇒ 名字与 key 同源，**改名字就会改身份**。
- `:306-309` 的 `baseName` 是本文件内**唯一**的路径取名函数（Grep `baseName` 命中 2 处：定义 + 使用），无其他 canonical 可收敛。

### 1.2 `khy-durable-transcript-*` 不是本仓产生的目录

- Grep `durable-transcript` / `durableTranscript`：`apps/khyos-desktop/src` **零命中**；`services/backend/src`（限定 `--glob *.js`）**零命中**。
- ⇒ 这些目录由**仓外**流程（会话落盘/转录临时目录）产生，会话的 `workspacePath` 恰好指向它们，于是被 `:342` 的自动分桶当成「项目」。
- 它们与真项目在数据结构上**完全同形**（都只是 `Task.workspacePath` 的一串值）⇒ 渲染层没有任何依据把它们摘出来。**这不是渲染 bug，是缺一层「什么才算项目」的判定。**

### 1.3 main 侧已有可复用的持久化通道，但没有「项目」实体

- `settingsStore.ts:71` `desktopWorkspacePath: ''` —— 单值，注释写明「Workspace root chosen via 窗口菜单 → 打开工作区 / 侧栏 添加项目」。⚠ **注释里的「侧栏 添加项目」目前不存在**：侧栏顶部只有「新建任务 / 搜索 / 自动化 / 插件市场」四个按钮（`WorkspaceSidebar.tsx:495-526`），无任何添加项目入口。注释已先行于实现（典型的意图/实现漂移）。
- `settingsStore.ts:77` `desktopRecentWorkspaces: []` —— MRU 候选集，**上限 8**，注释明确「它**不是**第二个真源」。
- `main/index.ts:693-695`
  ```ts
  ipcMain.handle('workspace:list', async () => {
    return { ok: true, current: await getWorkspaceRoot(), recents: await readRecentWorkspaces() }
  })
  ```
  返回 `{ current, recents }`，**无项目数组、无显示名、无标识**。
- preload `index.ts:186` `workspaceList` 桥已暴露；`:41` `workspaceListFiles` 是**文件**列表，与项目无关（勿混淆这两个同名方法）。

⇒ 落点应**扩展既有 canonical**（`workspace:list` + `settingsStore`），**不新建第二个真源**。

### 1.4 文件夹头与任务行的现状

- `:643-664` 文件夹头：`▸/▾` + `truncate` 名字 + `items.length` 计数。三样都是中性样式（`text-foreground/60`、`text-foreground/30`），**零身份信息**。
- `:752-760` 任务行：小圆点（激活态 `bg-brand`）+ `task.title` + `formatTime(task.updatedAt)`。`title` 只在行内出现，文件夹头看不到。
- 已有空态三态（`:588-605`）与归档区（`:853-882`），形态完备 ⇒ 新方案不必重写列表骨架。

### 1.5 可用资产

- 图标：`components/ui/Icon.tsx:27-42` 注册 12 枚字形（`IconName` 联合类型），全部走 `currentColor`。⚠ 该文件头注释（`:1-11`）自述「这套字形是 2026-10-02 用户点名重做的，有意偏离 ZCode 1:1 复刻」⇒ **新增项目图标应扩展这个注册表，不要引第二套图标来源**。
- 颜色令牌：`theme/globals.css:9-46` `@theme` 块，语义令牌齐全（`--color-brand` / `--color-surface-hover` / `--color-selected` / `--color-border` …）。⚠ `--color-brand` 在浅色主题下是 `#000000`（`:189`）、深色下是 `#ffffff`（`:96`）⇒ **品牌色不能承担「区分项目」的职责**（浅色主题下所有项目一个黑点，等于没区分）。
- 现有本地化真源：`renderer/i18n/zh-CN.json`。⚠ 但 `WorkspaceSidebar.tsx` 全文**未使用 i18n**（Grep `i18n|useTranslation` 零命中），所有文案是硬编码中文 ⇒ 本提案**沿用硬编码中文**，不擅自引入 i18n 键（那是另一条战线）。

---

## 2. 借鉴提案（B-P2 七字段）

**零借鉴 ⇒ B-P2 不触发**。图2 是 WorkBuddy 自身「新建工作区」弹窗，属**同生态产品形态参考**，非外部上游项目，故第 1 字段无对象可填。按 `[DESIGN-ARCH-149] §2` 先例逐字段据实声明：

| # | 字段 | 声明 |
|---|---|---|
| 1 | 借鉴对象 | **不适用** —— 未借鉴任何外部项目/版本/commit。图2 为 WorkBuddy 自身 UI 截图，仅作形态参照 |
| 2 | 借鉴内容 | **不适用** —— 无上游结论被采纳。形态上确实与图2 的「源文件夹 + 名称 + 图标 + 颜色」分段思路同向，但本方案的**身份层设计来自本仓 §1.1–§1.3 的实测缺口**，非移植 |
| 3 | 解决的问题 | **不适用**（B-P2 语境）；本仓待解缺口见 §0 病灶表 P1–P5，均有 file:line 证据 |
| 4 | 许可证与代码性质 | **不适用** —— 未拷贝任何外部代码。落地全部为本仓新写 TSX/CSS |
| 5 | 借鉴方式 | **不适用** —— 无 `idea`/`reference`/`adapter`/`vendored`/`fork` 归属 |
| 6 | 落点与现有实现对比 | 落点：`WorkspaceSidebar.tsx`（既有文件，扩展）、`main/index.ts` + `settingsStore.ts`（既有 canonical，扩展 `workspace:list`）。**搜索过**：`baseName`（本文件内 2 处，无第二实现）、`workspace:list`/`workspaceList`（`preload/index.ts:186`、`main/index.ts:693`、渲染侧 3 处消费）、`durable-transcript`（仓内零命中）、`IconName`（`Icon.tsx:27`）、`添加项目`（`settingsStore.ts:67` 注释命中，侧栏无实现）。⇒ 属**扩展既有 canonical**，非新增并行实现 |
| 7 | 验收方式 | 见 §7（三条可复现命令 + 一次人工目视） |

---

## 3. 目标形态

### 3.1 数据层：引入「项目登记」实体（扩展既有 canonical）

新增 `settingsStore.ts` 字段（与 `desktopWorkspacePath` 同级，走既有 `settings:get/set`）：

```ts
// 项目登记表：路径 → 身份。解决「项目名 = 路径末段」导致父目录/临时目录
// 冒充项目、以及同名项目不可辨。写入侧：侧栏「添加项目」或会话归组时登记；
// 读取侧：项目 tab 分桶。不新建第二个真源 —— 当前工作空间仍只由
// desktopWorkspacePath 回答。
desktopProjects: [
  // { path: 'D:\\Portable\\khy-os', name: 'khy-os', icon: 'review', color: 'blue' }
],
```

- `path` 是**分桶键**（替代 `:342` 的整串 `workspacePath` 裸值）。
- `name` 是**显示名**（用户可写，允许与末段不同 ⇒ 解决 P1）。
- `icon` / `color` 可选，缺省则不渲染标识（**不给假数据**）。
- 未登记的路径**仍要显示**（不能因为没登记就丢列表）—— 走 §3.2 的兜底分类。

### 3.2 判定层：什么才算「项目」（本方案的核心）

未登记路径按**固定顺序**判定，避免误伤：

1. **已登记** → 用登记的 `name`/`icon`/`color`。
2. **临时/转录目录**（形如 `khy-durable-transcript-<随机6位>`）→ 归入固定分组「**未归属**」，不占用项目层级。
3. **其它路径** → 显示 `baseName()`，但**标记为「推测项目名」**（弱化样式 + `title` 提示完整路径），用户可一键「登记为项目」把它正名。

> ⚠ 规则 2 的匹配必须**锚定到具体前缀常量**并写进文档与测试；**不得**泛化成「名字里有 random 就过滤」—— 那会误杀真项目。

### 3.3 渲染层：文件夹头三段式（对齐图2 的信息层次）

文件夹头从「▸ + 名字 + 计数」升级为：

```
[▸] [图标] 名字 .................... 计数
                └ 副行（仅推测项目名时）：完整路径，弱化
```

- **图标**：`Icon.tsx` 注册表内取，`size={13}`，`currentColor` 继承文件夹头文字色。⚠ 不新增第二套图标来源（§1.5）。
- **颜色**：只允许**左侧 3px 竖条**（`w-[3px] h-3.5 rounded-full`）承载，**不给文字上色** —— 文字上色会与 `text-foreground/60` 抢夺语义层级，且浅色主题下对比度不可控。
- **计数**保留右侧原位，不与图标争夺注意力。
- **推测项目名**的文件夹头：名字 `truncate` + 副行路径 `text-[11px] text-foreground/35`，hover 时整行可点「登记为项目」（P3 的最小闭环）。

### 3.4 登记入口：复用既有 `groupDialog` 形态

`WorkspaceSidebar.tsx:993-1035` 已有自绘对话框（`absolute inset-0` + `bg-popover` 卡片 + 输入框 + 取消/确定）。**照它的形状**做「登记项目」对话框，新增两个可选控件：

- 名称输入（**预填 `baseName`**，允许直接改 —— 这是解决 P1 的最短路径）。
- 图标选择：横排 8 枚（`IconName` 前 8 个），单选。
- 颜色选择：6 色圆点（`--color-brand` **不可选**，理由见 §1.5），单选。
- 「取消」= 不写任何键（保持现状渲染）；「确定」= 写 `desktopProjects`。

⚠ 图标/颜色**默认值必须留空**，不预选 —— 预选就是给假数据。

### 3.5 文案与样式约束

- 全部沿用 `WorkspaceSidebar.tsx` 硬编码中文（§1.5），不新增 i18n 键。
- 颜色一律走 `@theme` 令牌或 `currentColor`，**禁硬编码色值**（`check:frontend-design-tokens`）。
- 6 色候选的具体色值由 `@theme` 现有语义令牌组合而来（如 `success`/`warning`/`destructive`/`brand` 的浅色变体），**不在组件里写 hex**。

---

## 4. 实施分期（每期独立可回滚）

### 第一期：判定层 + 兜底（**解决 80% 的可辨识性问题，零 UI 改动**）

1. `WorkspaceSidebar.tsx` 抽出 `classifyWorkspacePath(path, registered)` 纯函数：返回 `{ bucket: 'registered'|'transient'|'inferred', name, icon?, color? }`。
2. `:321-361` 的 `folders` memo 按判定结果分桶；`transient` 统一进「未归属」分组。
3. 文件夹头暂不加图标/颜色。

**为什么先做这期**：图1 里最刺眼的 4 个 `khy-durable-transcript-*` + `Portable` 全部由这一步解决，且**不触碰持久化**（不写 `settingsStore`），回滚 = 删一个纯函数。

### 第二期：项目登记（`desktopProjects` 落地）

1. `settingsStore.ts` 加字段 + 默认值 `[]`。
2. `main/index.ts:693` 的 `workspace:list` 返回值加 `projects`（**扩展既有 IPC，不新增通道**）。
3. preload `index.ts` 无需改（`workspaceList` 已整体透传返回）。
4. 侧栏读 `projects` → 判定层接上「已登记」分支。
5. 文件夹头「登记为项目」入口 + 登记对话框（§3.4）。

### 第三期：身份标识（图标 + 颜色）

1. `Icon.tsx` 的 `IconName` 联合类型按需增补（**只增不改**，防破坏既有调用方）。
2. 文件夹头加图标 + 3px 色条（§3.3）。
3. 登记对话框的图标/颜色选择器接线。

> ❌ **别把第三期提前**。身份标识是装饰，判定层是地基。先上色条会让「`Portable` 依然是个项目」这件事看起来被解决了 —— 掩盖问题而非修复。

---

## 5. 诚实边界（刻意不纳入）

| 不纳入 | 原因 |
|---|---|
| 会话标题聚合到文件夹头 | 标题是自由文本，聚合需要摘要策略（取最近一条？统计？），会引入第二套语义判断。**先只做身份，标题聚合留作独立提案** |
| 项目拖拽排序持久化到 main | 现有 `taskOrder` 在 `localStorage`（`:98-104`），项目级排序若另走 main 会形成第二套持久化。建议等项目登记真源定了再一并收敛（见 §6） |
| 「删除项目」 | 会牵连会话归属（会话的 `workspacePath` 不可变）。**先只做新增，正名可改，删除不做** |
| 引入 i18n 键 | 该文件全硬编码中文，单独改造成本不属本提案（§1.5） |
| 给临时目录做真实清理 | `khy-durable-transcript-*` 由仓外流程产生，**本仓没有它的产生者**，就无法定义「谁负责删」。本提案只做展示层归类 |
| 会话创建时选项目 | 属任务创建流程改造，超出侧栏范围 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| **加图标/颜色了事**（跳过判定层直接做第三期） | 图标是装饰。`Portable` 加上彩色图标后依然是「26 条会话的父目录冒充项目」—— 用户以为被修好了，实际问题原样保留。**先分桶，再上色** |
| **继续用 `baseName` 但加「只取有 `.git` 的目录」这类启发** | 会把「刚 `git init` 还没提交」「纯文档项目」误杀。项目是**用户意图**，不是目录属性 ⇒ 只能由用户登记决定，不能由目录形状推断 |
| **用「名字含 6 位随机串」判定临时目录** | 泛化启发会误杀真项目（`khy-agents-v2` 之类）。必须锚定**确切前缀** + 单测钉住 |
| **让用户在文件夹头上直接改名字（就地编辑）** | 会把「显示名」和「分桶键」在用户心智里焊死 —— 他改完名，会以为项目目录也改名了。**改名走登记对话框**（明确「显示名 ≠ 目录名」） |
| **为项目再建一个 `workspace:projects` IPC 通道** | `workspace:list` 已在返回工作空间全貌，扩展返回值是**扩展 canonical**；另开通道就是第二个真源，正是 `settingsStore.ts:69-70` 注释反复警告的那件事 |
| **用 `--color-brand` 给项目上色** | 浅色主题下 `--color-brand = #000000`（`globals.css:189`），深色下是 `#ffffff`（`:96`）⇒ 主题一切换，**全部项目同一个颜色**，区分功能归零 |
| **顺手修 `settingsStore.ts:67` 那句「侧栏 添加项目」的注释** | 注释先行是**意图登记**，不是缺陷。第二期落地后注释自动成真；提前改会把「谁先欠的」这条线索擦掉 |

---

## 7. 验收方式

```powershell
# 1) 判定层单测（第一期新增，必须用 node:test —— services/backend/tests 下的
#    jest 风格文件会被 node --test 扫走并炸在 describe 未定义）
& "<node>" --test "apps/khyos-desktop/tests/sidebarProjectClassify.test.cjs"

# 2) 桌面端 UI 契约（新增 IPC 两侧一致性，D6）
& "<node>" --test "apps/khyos-desktop/tests/desktopUiContract.test.cjs"

# 3) 禁硬编码色值
& "<node>" scripts/ci/check-frontend-design-tokens.js
```

**目视验收（第二/三期后）**：侧栏项目 tab 展开后，图1 的 4 个 `khy-durable-transcript-*` 应收敛进「未归属」分组；`Portable` 若已登记为父容器则显示其登记名，否则带「推测」弱化样式 + 路径副行；已登记项目显示图标 + 色条。

⚠ `tsc --noEmit` 在**改动前就有 33 条错误**（`src/host/index.ts` 占 16 条）⇒ **不能以「tsc 全绿」为门禁**，只比对改动前后是否**新增**。

---

## 8. 待核实项

| # | 事项 | 优先级 |
|---|---|---|
| 1 | `khy-durable-transcript-*` 的**真正产生者**在本仓之外何处 —— 若将来它改为写入 khy-os 自己的 `.khy/` 下，则 §3.2 规则 2 可简化为「一律排除 `.khy/` 下的路径」 | 中（不影响落地，只影响规则写法） |
| 2 | 临时目录判定用的**确切前缀常量**取自何处（配置项 / 硬编码）—— 需与产生方约定，否则规则会随对方改名而失效 | **高**（阻断第二期落地） |
| 3 | `Task.workspacePath` 是否有历史空值（`:344` 已有 `|| ''` 兜底 ⇒ 说明**确实出现过**）—— 需确认空值会话的占比 | 低（已有兜底，不阻断） |
| 4 | 排序/折叠状态（`collapsedFolders`，`:261`）当前只在内存，刷新即丢 —— 属「项目可辨识」相邻的独立痛点，不并入本提案 | 低（登记为独立条目） |

---

## 9. 变更日志

- 2026-10-03：初稿。基于用户实况截图 + `WorkspaceSidebar.tsx` / `settingsStore.ts` / `main/index.ts` 实读取证，编号 177（枚举 `DESIGN-ARCH/*.md` 求得 max=176）。
- 2026-10-03：**实施落地（三期一次做完）**。见 §10。

---

## 10. 实施记录（2026-10-03）

> 状态：**已落地并重建产物**。三期按序完成，但**在同一次改动内一并落地** ——
> 判定层（纯函数 + 单测）先写成并跑绿，才接渲染；色条最后接，且**只对已登记 /
> inferred 项目生效**，`kind !== 'project'` 一律不上色。

### 10.1 落地清单

| 文件 | 改动 |
|---|---|
| `src/renderer/shared/sidebarProjectClassify.ts` | **新增**（103 行）。`baseName` / `isTransientPath` / `classifyWorkspacePath` / `inferredColorKey` / `TRANSIENT_PREFIXES` / 类型。零 IO、零 env，登记表为可选参数（不传 = 旧行为） |
| `tests/sidebarProjectClassify.test.cjs` | **新增**（17 条）。用仓内 `typescript@5.9.3` 的 `transpileModule` 正规转译后求值（**不用正则剥类型**）；含一条「消费方已接线」的反向断言 + 一条误杀反模式钉住（`khy-agents-v2` 不得被当临时目录） |
| `src/renderer/components/layout/WorkspaceSidebar.tsx` | 删内联 `baseName` 与「项目名 = 路径末段」分桶；改调 `classifyWorkspacePath`；新增 `projectRegs` 状态 + 读取/保存 + 登记对话框 + 文件夹头设置入口；**`toast` 声明整体前移**（见 10.3） |
| `src/main/settingsStore.ts` | 新增 `desktopProjects: []` 默认值 + 字段语义注释 |
| `src/main/index.ts` | `workspace:list` 返回值加 `projects`（**扩展既有通道**，未新增 IPC） |
| `src/preload/index.ts` | **未改** —— `workspaceList` 整体透传返回，`getSettings`/`setSetting` 桥已存在 |

### 10.2 与方案的偏离（逐条给原因）

| 方案写的 | 实际做的 | 为什么 |
|---|---|---|
| 三期分次实施 | 一次做完 | 判定层已先写成并跑绿再接线，顺序约束实际满足了；且分三次要重建三次产物 |
| 第三期「`IconName` 按需增补」 | **一个字没改** | 12 枚现有字形够用（选前 8 枚做候选）。**不增补 = 零风险**：动 `IconName` 会波及所有既有调用方 |
| 颜色候选「由 @theme 语义令牌组合」 | 6 色里 4 个用 `bg-success`/`bg-warning`/`bg-destructive`/`bg-[var(--color-foreground)]`，另 2 个用 `var()` 显式引用 | `@theme` 没有覆盖 6 个区分色的语义名。**全走 CSS 变量 / 语义类、零 hex** ⇒ `check-frontend-design-tokens` 零新增 finding |
| 推测项目名「弱化样式」 | 名字 `text-foreground/45` + **11px 路径副行** + 散列色条 | 加了副行是实测后的判断：只弱化颜色时，用户仍看不出「为什么 `Portable` 是个项目」。副行把路径亮出来，问题自暴露 |

### 10.3 踩到的坑（照 §8.5 排查，8 秒定位）

**TDZ 白屏（已避开，留在代码注释里）**：`saveProjectRegs` 是 `useCallback`，依赖数组里引用了 `toast`，而 `toast` 原本声明在 ~178 行之后。React 依赖数组是**渲染期求值** ⇒ 每次渲染抛 `Cannot access 'toast' before initialization`，整棵树白屏。修法：把 `toast` 声明整体前移到本段**之前**，并在原位留顺序警告注释。

> 这是 skill §8.5 记录的 `AutomationsPage.tsx` 同病实例（`#/automations` 一直白屏）的**同型复发**。
> ⚠ 未复发的原因是新增 hook 块时我先核了 `toast` 的行号 —— 但这说明**该坑已复发两次**，
> 建议后续把它做成 lint 规则而非靠人记。

### 10.4 验收实测

| 项 | 结果 |
|---|---|
| `sidebarProjectClassify.test.cjs` | **17/17 绿** |
| `desktopUiContract.test.cjs` | **26/26 绿**（D6 preload↔main 通道一致性含在内） |
| `keyManagerContract.test.cjs` | 8/8 绿（未触碰，回归对照） |
| 桌面端 `tests/` 全量（3 文件） | **51/51 绿，0 红** |
| `tsc --noEmit` | **20 条既有错误，与本次改动零重叠**（全在 `host/index.ts` 15 + `BrowserPane.tsx` 3 + `Tooltip.tsx` + `i18n/index.ts`）。⚠ 基线从 33 降到 20 —— **非本次所致**，是并行会话修了 `host/`（skill §6.5 的归因纪律） |
| `check-frontend-design-tokens` | `exit=0`，58 findings **全在 `apps/ai-frontend`**，khyos-desktop 零新增 |
| 三段构建 | `electron-vite` / `vite.host` / `vite.scheduler` 全 `exit=0`；新包 `assets/index-CZxLM5H3.js`（2.2 MB）已进 `index.html` |
| 产物含新代码 | 6 个探针 5 HIT + 副行 3 HIT；`main/index.js` 含 `desktopProjects`。唯一 MISS 是探针词选错（用注释里的「推测名」三字去搜产物，产物不含注释） |

### 10.5 明确不做

- 不加 `tsc 全绿` 门禁（基线 20 条在 `host/`，与侧栏无关）。
- 不给 `check:frontend-size` 判失败（无产物可量时恒 `exit=2`，是既有行为）。
- 不碰 `settingsStore.ts:67` 那句「侧栏 添加项目」的注释 —— 按 §6 反模式，注释先行是意图登记。
- 不做项目删除、不做标题聚合、不做 i18n 化（见 §5，逐条有原因）。

### 10.6 落地后的目视验收（待用户确认）

重启应用（`.js` 不热更新）后看侧栏项目 tab：

1. 4 个 `khy-durable-transcript-*` 应**收敛成一个「未归属」分组**（原来占 4 行）。
2. `Portable` 这类推测项目名下会出现**完整路径副行** + 名字弱化 —— 父目录冒充项目的问题自暴露。
3. hover 任一项目文件夹头会出现**齿轮状入口**（登记为项目），点开可改显示名、选图标（8 枚）、选颜色（6 色）；**默认全空** —— 不预选即不给假数据。
4. 登记后：显示名生效、副行消失、图标与色条出现；`Portable` 若登记为容器名，它的色条与 `khy-os` 的不同。

⚠ 若 `khy-durable-transcript-*` 仍散在项目层级 ⇒ 判定层没生效，先查 `out/renderer/index.html` 指向的 hash 包是否为本次产物。

