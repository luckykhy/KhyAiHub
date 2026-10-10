# [DESIGN-ARCH-145] 用户 DIY 空间分层与安全边界统一方案

> **状态**：提案（待裁决）  ·  **范围**：`services/backend`（CLI + 拓展/插件/主题体系）；不改既有拓展根语义  ·  **上游依赖**：无外部代码借鉴（B-P2 据实填不适用，见 §2）
> **调研指针**：[DESIGN-TOOL-002]（拓展契约）、[DESIGN-ARCH-143]（DSH 外部生态接入，正交）、[DESIGN-ARCH-144]（khyquant 剥离，`~/.khyquant/` 数据契约 §1.4）、`RUNTIME-002`（状态透明）、`RUNTIME-010`（工具授权）
> **模板合规**：非借鉴类内部架构提案，B-P2 七字段按 §4.0 据实填「不适用」（见 §2）
> **日期**：2026-09-24  ·  **编号**：[DESIGN-ARCH-145]

---

## 0. 一句话结论

**khy-os 的 DIY 落点已经比表面丰富得多——实测九处，但它们散落在六个互不相识的命令里，且「用户代码进进程」的两个落点（CLI 命令插件、网关插件链）安全边界明显弱于拓展体系。** 本提案做两件事：①把九个落点按「能力深度 × 失效半径」统一为**四层梯度**，让每层配对四道既有闸门中的合适子集；②补齐代码层的缺口（权限披露、审计、两个实 bug），再用一个 `khy diy` 发现入口把「我能改什么」变成一眼可见。**成就感不需要新机制——需要的是把既有能力串成一条看得见的路。**

**病灶表格**：

| # | 缺口 | 现状证据 | 后果 |
|---|------|---------|------|
| G1 | 九个 DIY 落点散落六个命令入口，无统一发现面 | `skin`/`plugin`/`skill`/`extension`/`config`/`hooks` 各自为政（§1.1 表） | 用户不知道能改什么——成就感的第一公里缺失 |
| G2 | CLI 命令插件**零权限披露**：`require` 即全权 | `plugins.js:95` 直接 `require(pluginPath)`，handler 可用 fs/child_process/网络 | 用户装一个 `.js` 就等于给全 Node 能力开门，且无人知道它用了什么 |
| G3 | 网关插件 `toggle` 只改内存不落盘 | `pluginChain.js:107-113` `plugin._enabled = enabled`，无写回 | 重启后状态漂移：用户以为关了，其实还开着 |
| G4 | 自定义主题只能存一个 | `themeRegistry.js:31` `CUSTOM_THEME_FILE` 单文件 | 换主题 = 覆盖旧主题，作品无法积累 |
| G5 | CLI 插件 `reload` 按 `name` 猜路径清缓存 | `plugins.js:203` `path.join(PLUGINS_DIR, plugin.name + '.js')` | 文件名 ≠ `name` 时旧缓存残留，改了不生效（对照 `pluginChain.js:66` 已记 `_file` 真源） |
| G6 | 代码层 DIY 无行为审计 | 全仓无插件执行日志 | 出问题无法归因，「是哪个插件干的」查不到 |

---

## 1. 现状实证（file:line 可复核，全部 2026-09-24 实测）

### 1.1 九个 DIY 落点盘点

| # | 落点 | 用户入口 | 落盘位置 | 成就感 | 边界现状 |
|---|------|---------|---------|--------|---------|
| D1 | 主题（颜色/spinner/thinkingVerbs/工具显示名/阶段文案） | `skin <name>` | `~/.khyquant/theme.json`（`themeRegistry.js:31`） | 高（一眼可见，`thinkingVerbs` 是彩蛋级定制点） | configGuard 防护 + 字段级 fallback（`:265-274`）+ 色深自适应降级 G4（`:281-284`）；**但单文件只能一个主题（G4）** |
| D2 | CLI 自定义命令 | `khy plugin`（router.js 内 legacy 路） | `~/.khyquant/commands/*.js`（`plugins.js:38`） | 极高（自己造工具） | 内置命令优先、插件兜底（`router.js:2793-2797`）；服务代理白名单仅 3 个（`plugins.js:143-163`）；**零权限披露、零审计（G2/G6）** |
| D3 | 网关插件（AI 请求/响应/stream/错误四钩子） | `khy plugin gateway` | `~/.khyquant/gateway_plugins/*.js`（`pluginChain.js:25`） | 高（拦截改写 AI 流量） | 文件名白名单（`:52`）+ 语法预检不执行（`:234-241`）+ 100KB 上限（`:217`）+ 原子写（`:289-297`）+ hook 级错误隔离（`:127-132`）+ 总开关（`:27`）；**toggle 不落盘（G3）、无权限披露（G2 同型）** |
| D4 | 自定义 AI provider | `khy config` / registrar | `<dataHome>/custom_providers.json`（`customProviderRegistry.js:16`） | 极高（接入自己的模型） | configGuard 覆盖（`configGuard.js:14` 明列）；有 registrar 写入通路 |
| D5 | 技能 | `khy skill learn/curate/pin/import/export`（`handlers/skill.js:19-92`） | 技能库 | 高（可沉淀可分享） | 生命周期完整；`skill journey/stats`（`:394`/`:477`）已是成就感基建 |
| D6 | 拓展（manifest + 市场安装） | `khy extension` | `<dataHome>/extensions`（`extensionRoots.js:99-101`） | 极高 | **最成熟**：五级根发现（`:104-111`）、「文件系统就是注册表」（`:12-15`）、仓库根优先于用户根（`:113-114`）、只读探测器绝不 require（`:17-19`）、state 显式禁用（`:15`）、市场 `extensionMarketplace.js:41` |
| D7 | 工作流图 | ai-frontend Vue Flow 画布 | workflow 引擎 | 极高（可视化编排） | 13 节点型声明式目录 SSOT + 目录↔执行器双向一致守卫 + fail-closed（[DESIGN-ARCH-141] §1，G1 缺口已修） |
| D8 | 键位目录 | `/keybindings`（`handlers/keybindings.js:27`） | 不落盘 | 低 | **诚实边界范例**：只做准确目录展示，「不造写了配置却不真正改变按键行为的假重映射引擎」（`keybindings.js:10-13`） |
| D9 | SDK 插件开发 | `khy plugin init/dev/doctor/link`（`handlers/plugin-dev.js:4-10`） | `<dataHome>/plugins`（`:43`） | 极高（完整脚手架+热重载） | `validateManifest`（`:23`）+ SDK 兼容层 mock（`:24`） |

### 1.2 边界资产（既有闸门，本提案复用而非新建）

| 闸门 | 机制 | 证据 |
|------|------|------|
| 优先级闸 | 内置命令 > 用户插件；仓库根拓展 > 用户根拓展（同名静默顶替被禁止，冲突永远可见） | `router.js:2793-2797`；`extensionRoots.js:113-114` |
| 失效半径闸 | configGuard 三步原子写 + .bak 自愈 + 双重损坏回退默认值；mountOptional 删目录即卸载；主题字段级 fallback | `configGuard.js:8-14`；`server.js:440`（[144] §1.2）；`themeRegistry.js:265-274` |
| 可逆闸 | 主题切回 `default`；拓展 state 显式禁用；插件 reload | `themeRegistry.js:210-236`；`extensionRoots.js:15` |
| 可见性闸 | healAudit 审计（配置自愈留痕）；skill journey 统计 | `configGuard.js:19`；`handlers/skill.js:394,477` |

### 1.3 与近邻提案的边界（不重叠声明）

- **[DESIGN-ARCH-143]**：接入**外部** DSH 插件生态的评估——本文是**用户自己动手**的空间，方向相反；其「同进程挂载无隔离 = 供应链风险进主进程」的结论（§1.2）是本文 §5 第 1 条的直接论据。
- **[DESIGN-ARCH-144]**：khyquant 应用**仓库结构**剥离——本文不动物理布局；`~/.khyquant/` 用户数据契约（[144] §1.4「剥离不触碰」）恰是本文 D1-D3 落点的宿主，两者兼容。

---

## 2. 借鉴提案（B-P2 七字段）

**非借鉴类，不适用。** 依据：本提案是仓库内部能力盘点与边界补齐，四层梯度、四道闸门、文件系统即注册表、configGuard 自愈全部是既有本仓机制的延伸（§1.2 表），无外部上游可指认。**概念同型披露（非借鉴）**：§4 的「插件权限披露」与浏览器扩展生态（Chrome/VS Code 的 permissions 声明）概念同型，属行业通用概念，`idea` 级——不引入任何上游代码、字段布局按本仓 manifest 既有形态（`khy.extension.json`）自行定义。不为「看起来合规」硬借一个上游（SOURCING 红线）。

---

## 3. 目标形态：四层梯度 × 四道闸门

### 3.1 分层判据

分层维度是**「用户写的是什么 × 坏了会波及多大」**，不是功能分类：

| 层 | 定义 | 落点 | 坏了的失效半径 | 配套闸门 |
|----|------|------|---------------|---------|
| **L1 数据层** | 改值不改码 | D1 主题 | 视觉退化 | 失效半径闸（schema fallback）+ 可逆闸 |
| **L2 声明层** | 结构化登记，被平台解释执行 | D4 provider、D6 拓展 manifest、D7 工作流图 | 该能力缺席（404 + 提示），底座不倒 | 优先级闸 + 失效半径闸 + 可逆闸 |
| **L3 组合层** | 编排既有积木 | D5 技能、D9 SDK 插件、拓展安装动作 | 行为偏差，但积木本身被平台守卫 | 全四闸 |
| **L4 代码层** | **用户代码进进程** | D2 命令插件、D3 网关插件 | 任意行为（进程内全权） | **四闸中缺可见性闸——本提案补** |

### 3.2 L4 补边：声明—披露—审计三步（不承诺沙箱）

```
加载时                          运行时
┌──────────────────────────────────────────────────────────┐
│ 1. 声明（可选）: manifest/导出字段 permissions: ['fs','net']│
│ 2. 披露（强制）: 静态扫描源码 require() 集 → 加载披露面     │
│    「该插件使用了: fs, child_process」                      │
│ 3. 审计（强制）: 每次执行写一行 pluginAudit（healAudit 同型）│
└──────────────────────────────────────────────────────────┘
```

- **披露以静态抽取为准、声明为补充**：不依赖用户自觉——扫源码里的 `require('fs')` / `require('child_process')` / `require('http')` 得出实际能力集，声明与实测不一致时以**实测**披露并标注「声明不符」。这是 `RUNTIME-002` 状态透明精神在 DIY 面的延伸。
- **S1 阶段只记录不阻断**：未声明 permissions 的存量插件行为零变化（加载照旧），仅多一行披露——与规则 10「未声明 ≠ 全权」的登记强度对齐，靠人工评审兜底而非硬拦。
- **为什么不承诺 vm 沙箱**：Node 官方文档明示 `vm` 非安全机制；`pluginChain.js:234` 现有 `validateSyntax` 只做语法预检正是这个正确用法。进程级隔离的成本论证见 §5 第 1 条。

### 3.3 成就感闭环：串路而非造轮

| 环节 | 既有件 | 本提案动作 |
|------|--------|-----------|
| 发现 | ——（缺） | **P1 `khy diy list`**：九落点一张表（能改什么 / 现状已定制几处 / 回滚方法） |
| 上手 | theme fallback 模板（`themeRegistry.js:51-133`）、`plugin init` 脚手架、`extension scaffold`、`pluginChain.getTemplate()`（`:326-364`） | `khy diy open <id>` 直达对应模板/目录 |
| 痕迹 | `skill journey/stats`、`preferences.json` | `khy diy list` 汇总展示「你已定制 N 处」 |
| 分享 | `skill export/import`、extension marketplace（`extensionMarketplace.js:41`） | 不动（够用） |

---

## 4. 实施分期（每期独立可回滚）

### P1 — `khy diy` 发现入口（纯读，零风险）

- 新增 `handlers/diy.js`（薄壳取数打印，对齐 `keybindings.js` 体例）+ `diyCatalog.js`（纯叶子，单一真源，同源驱动帮助文案）。
- `diy list`：按 §3.1 四层分组输出九落点（层 / 落点 / 入口命令 / 落盘路径 / 回滚方法 / 当前状态）；`diy open <id>`：打印模板或目录路径（不代开编辑器，避免越权 spawn）。
- 回滚：删 handler + router 一行 case。

### P2 — L4 补边三件套 + 两个 bug 修复

1. **权限披露**：`plugins.js` 与 `pluginChain.js` 加载时静态抽取 require 集，登记到 `list()` 输出与 `plugin doctor` 面；manifest `permissions` 字段可选补充（默认不声明 = 现状，零 breaking）。
2. **审计**：新增 `pluginAudit`（对齐 `utils/healAudit` 形态）：每次命令插件/网关插件执行记一行（name / file / 时间 / 出错与否），放 `<dataHome>/audit/`。
3. **修 G3**：`pluginChain.toggle` 把 `_enabled` 写回插件文件的 `enabled` 字段（读-改-写走既有 `savePlugin` 原子写）或独立 state 文件——二选一在实施时按「文件是用户手写作品，机器回写会毁格式」的原则裁决，倾向独立 state（对齐 extensionRoots 的 `extensions_state.json` 先例）。
4. **修 G5**：`plugins.js` 加载时记 `_file`（照抄 `pluginChain.js:66`），`reloadPlugins` 按 `_file` 清缓存。
- 回滚：披露与审计均为旁路增量，删即回；G3/G5 修复带回归测试（见 §7）。

### P3 — 主题多文件化

- `themeRegistry.init()` 增加 `<appHome>/themes/*.json` 目录加载（在单文件 `theme.json` 之后、内置主题之后注册，同名优先级：内置 > 用户单文件 > 用户目录，保持「新能力不改变既有优先级语义」）。
- `skin list` 天然显示全部；`khy diy open theme` 生成模板到 `themes/` 目录。
- 回滚：目录不存在时行为与今日逐字节相同（写一条 `strictEqual` 钉住）。

### P4 — 明确不做（上升为 §5 诚实边界，不占工期）

---

## 5. 诚实边界（刻意不纳入——逐条给原因）

1. **进程级沙箱/隔离**：Node 单进程 CLI 架构下，worker 隔离会让插件的同步上下文（chalk、终端 TTY）全部失效，改造成本等于重写插件协议；DSH「同进程挂载无隔离」被 [143] 判为风险进主进程的教训是**不接入外部生态**，而不是给本机用户代码套笼子——本机用户的威胁模型是「误写」而非「恶意」，披露+审计恰好覆盖。
2. **键位重映射**：沿用 `keybindings.js:10-13` 的既有裁决——键位硬编码在 Ink 输入处理器里，没有重映射通路就只做目录展示，不造假引擎。
3. **DIY 市场**：`extensionMarketplace` 已覆盖「装别人的作品」；「晒自己的作品」等真实需求出现前不预建（`RUNTIME-008` 新增先提问）。
4. **TUI 桌面端的可视化 DIY 编辑器**：`apps/khyos-desktop` 的设置面改造是独立能力域，且其 CSS 变量令牌体系（`theme/globals.css`）与 CLI 主题是两套真源——合并属于另一个提案的裁决，本文不越界。
5. **权限硬拦截**：S1 阶段只披露不阻断（§3.2）；「未声明 = 拒绝加载」会一夜废掉所有存量插件，违背「零 breaking」分期原则。

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|--------|--------|
| 用 `vm` 模块造「沙箱」并宣称安全 | Node 文档明示 vm 非安全机制；逃逸手段成熟。语法预检（现状）是它唯一的诚实用法 |
| 为 DIY 新增 `KHY_DIY_*` env 门 | 撞 `check-tui-gates.js:32` 的 MAX_GATES=220 棘轮（只降不升）；权限披露走 manifest 字段 + 静态抽取，不需要 env；「让功能变正确」不构成开门的用户可见权衡 |
| 新建第二套插件/拓展注册机制 | `extensionRoots.js:4-10` 的注释就是血泪史：三套互不认识的机制刚收敛为一，「装在哪、叫什么、谁能看见」只能有一个答案 |
| 把九个落点重排成一个大而全的「DIY 平台」命令族 | 越权改既有命令语义会破坏 [143]/[144] 的前提；`khy diy` 只做**发现与直达**，执行仍回各自的 canonical 命令 |
| 披露面用用户声明的 permissions 而不静态核验 | 自觉声明不可信；「声明不符」必须以实测为准（`RUNTIME-010` 未声明 ≠ 全权的同一逻辑） |
| 机器回写用户手写的插件文件（G3 修复） | 插件是用户作品，回写毁格式；状态走独立 state 文件（extensionRoots 先例） |

---

## 7. 验收方式（可复现命令 + 关联门禁）

| 期 | 验收 | 命令 |
|----|------|------|
| P1 | `khy diy list` 输出四层九落点，每项含路径/入口/回滚；`check:changed` 绿 | `node services/backend/bin/khy.js diy list` |
| P2 | 新增 `node:test` 用例（`tests/diy/`，`require('node:test')` 写法，落地即绿——CI 全量扫 `tests/**/*.test.js`）：① toggle 后重启语义（state 落盘生效）；② reload 后文件名 ≠ name 的插件缓存确实被清；③ 静态抽取对含 `require('fs')` 的样例报出 fs；④ 审计文件出现对应行 | `node --test services/backend/tests/diy/*.test.js` |
| P3 | `themes/` 目录多主题被 `skin list` 列出且可切换；目录缺席时与今日行为逐字节相同（strictEqual 钉住） | `node --test services/backend/tests/diy/themeMultiFile.test.js` |
| 全程 | 门禁不新增红 | `npm run check:changed`、`npm run check:wiring`、`node scripts/ci/check-leaf-contract.js services/backend/src/cli/diyCatalog.js` |

基线说明：P2/P3 的新测试文件均为**新增文件**（不往既有 jest 风格文件追加 `node:test` 用例——两套 runner 会同时扫到）；`diyCatalog.js` 按纯叶子纪律写（零 IO、不抛、不读 env），过 leaf-contract 守卫。

---

## 8. 待核实项

1. **（优先，阻断 P1 命名）** `diy` 命令名与全局命令清单的冲突——本次已抽查 `router.js:255-315` 命令数组无 `diy`/`customize`，但实施前须再跑 `aliases.js` 全量比对（含中文别名「定制」）。
2. **（阻断 P2 审计）** `pluginAudit` 的落盘目录语义：`<dataHome>/audit/` 是否与 `utils/dataHome.js` 的目录契约冲突，实施时读该文件确认。
3. **（影响 P2 范围）** SDK 插件路（`plugin-dev.js`，`<dataHome>/plugins`）的权限披露是否与 legacy commands 插件同型适用——本文 P2 只覆盖 D2/D3，SDK 路留待实施时按 `validateManifest` 既有字段评估，不预扩范围。
4. **（影响 P3 优先级）** `themes/` 目录与单文件 `theme.json` 并存时的同名冲突测试样例须覆盖「三层同名」极端情况。

---

## 9. 变更日志

| 日期 | 变更 |
|------|------|
| 2026-09-24 | 初稿。九落点/四层梯度/四道闸门/三件套补边定稿；G3/G5 作为顺手 bug 登记进 P2（本提案范围内修复，证据已在 §0 表） |
