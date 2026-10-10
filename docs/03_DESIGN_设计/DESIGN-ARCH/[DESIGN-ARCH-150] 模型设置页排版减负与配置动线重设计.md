# [DESIGN-ARCH-150] 模型设置页排版减负与配置动线重设计

> **状态**：已实施（2026-09-24，P1-P3 全量落地，见 §10 实施记录）
> **范围**：`apps/khyos-desktop/src/renderer/components/settings/SettingsPage.tsx`、`apps/khyos-desktop/src/renderer/components/keyManager/KeyManagerPage.tsx`
> **上游依赖**：无新增（编辑能力复用既有 IPC，见 §1.3）
> **调研指针**：DESIGN-ARCH-091（keyManager 模块来源）、DESIGN-ARCH-147（好设计十诫工程映射）
> **模板合规**：非借鉴类，B-P2 七字段据实填「不适用」，见 §2

---

## 0. 一句话结论

模型设置页「挤」的根因是**四层垂直导航嵌套塞进 768px 容器**，「难用」的根因是**编辑能力三层齐全但零 UI 接线**、**添加表单横排溢出**、**配置动线断成三个 tab 无引导**。修法：压掉嵌入态的内部侧栏 tab、表单改纵向对话框、编辑走现成 `keysUpdate`/`cardsUpdate`、加一条「下一步」动线状态条。

### 病灶表格

| # | 症状 | 根因 | 证据 |
|---|------|------|------|
| 1 | 三条竖栏叠在内容区前 | 设置导航(240px) + KeyManager 内部 tab 栏(w-52=208px) + provider 列表(w-56=224px)，三层全是纵向排列 | `SettingsPage.tsx:139`、`KeyManagerPage.tsx:74`、`KeyManagerPage.tsx:225` |
| 2 | 内容区实际只剩 ~272px | 页面容器 `max-w-3xl`(768px) 扣掉 tab 栏 208 + 内边距 48 + 列表 224 + 间距 16 | `SettingsPage.tsx:208`、`KeyManagerPage.tsx:89` |
| 3 | 添加表单输入框被截断（截图可见） | 表单横排 flex-wrap，单行 `min-w-[220px]+min-w-[200px]`，双行加起来 > 内容宽，`flex-1 min-w-[180px]` 的 provider 框被挤没 | `KeyManagerPage.tsx:320-347` |
| 4 | 密钥/卡片无法编辑，只能删了重加 | `keys:update` / `cards:update` 三层（main IPC → preload → renderer api）全部存在，但全仓 **零 UI 消费方** | `ipc.ts:58,119` → `preload/index.ts:173,193` → `renderer/keyManager/api.ts:94,126`；`KeyManagerPage.tsx` 中仅调用 keysToggle/keysReveal/keysRemove/cardsRemove |
| 5 | 「用起来」要跨三个 tab 自己摸路 | 添加密钥(T1) → 建卡片(T2) → 激活 Agent(T3) 三步分散，tab 之间无状态提示、无跳转 | `KeyManagerPage.tsx:23-28`（四 tab 定义）、`:579-584`（T3 报错「请先去端点预设页创建卡片」即断链证据） |
| 6 | 双层标题冗余 | 页面 header「模型设置」+ T1 内部 h2「Provider 与密钥」+ 副标题两段，嵌入态重复占高 | `SettingsPage.tsx:67,201-204`、`KeyManagerPage.tsx:199-202` |

---

## 1. 现状实证（file:line 可复核）

### 1.1 宽度算术

```
页面内容容器        max-w-3xl            = 768px   SettingsPage.tsx:208
− KeyManager tab 栏 w-52                = 208px   KeyManagerPage.tsx:74
− 内容区内边距      p-6 (左右各 24)      =  48px   KeyManagerPage.tsx:89
− provider 列表列   w-56                 = 224px   KeyManagerPage.tsx:225
− 列间距            gap-4                =  16px   KeyManagerPage.tsx:223
= 密钥列表/表单实际可用               ≈ 272px
```

添加表单第一行 `min-w-[180px] + min-w-[220px]` = 400px > 272px ⇒ **必然溢出**，与截图右缘截断一致。

### 1.2 编辑能力「三层齐全、零消费」（本仓惯发病，参照 SKILL §8.1 命令面板先例）

| 层 | 证据 | 状态 |
|---|---|---|
| main IPC | `main/keyManager/ipc.ts:58` `keys:update`、`:119` `cards:update` | ✓ 已实现 |
| preload | `preload/index.ts:173` `keysUpdate`、`:193` `cardsUpdate` | ✓ 已暴露 |
| renderer api | `renderer/keyManager/api.ts:94`、`:126` | ✓ 类型齐全 |
| UI 消费方 | `KeyManagerPage.tsx` 全文（814 行） | ✗ **零调用** |

⇒ 补编辑是**纯前端接线**，不需要新 IPC、不需要动 D6 契约测试的通道清单。

### 1.3 独立窗口通道已存在但与嵌入态互不相助

`main/keyManagerWindow.ts:16-19`：独立窗口 1080×720（min 880×560），同宽下不挤。设置页嵌入态**没有**「在独立窗口打开」的入口，独立窗口也没有反向提示。本提案不动窗口拓扑（见 §5），只做嵌入态自愈。

---

## 2. 借鉴提案（B-P2 七字段）

**不适用。** 依据：本提案是对本仓既有能力域（DESIGN-ARCH-091 落地的 keyManager 模块）的**展示层修正与既有内部能力接线**，不借鉴任何外部项目/代码/设计稿；`keys:update`/`cards:update` 是本仓 main 层既有 canonical。若实施中引入具体外部 UI 参考，须按 SOURCING-001 补七字段。

---

## 3. 目标形态（组件级契约）

### 3.1 布局减负（一期）

| 改动点 | 契约 |
|---|---|
| `KeyManagerPage` 新增 prop 契约 | `embedded` 为 `true` 时：不渲染左侧 `w-52` 竖 tab 栏（`:74-87`），改为内容区顶部**横向 segmented tabs**（四项横排，选中态沿用 `bg-selected text-brand`）；`standalone` 为 `true` 时维持现状不动 |
| 双标题去重 | embedded 时隐藏 T1-T4 内部的 `h2` 与副标题（`:199-202` 等），页面 header（`SettingsPage.tsx:201-204`）为唯一标题 |
| 容器放宽 | `SettingsPage.tsx:208` 的内容容器对 `models` 页放宽为 `max-w-5xl`（其余页维持 `max-w-3xl`），条件类名，不建并行容器 |

放宽后算术：`1024 − 48(p-6) − 224(provider 列) − 16(gap) ≈ 736px` 给密钥区，足够。

### 3.2 添加与编辑（二期）

| 改动点 | 契约 |
|---|---|
| 添加表单收纳 | 删除常驻底部表单（`:318-365`），provider 列表顶部加 `＋ 添加密钥` 按钮；点击展开**纵向**单列表单（provider / endpoint / key / label 各占一行，无横向 min-w 拼行），就地收起或成功后收起 |
| 密钥编辑 | 密钥行操作组（`:267-310`）在 停用/显示/删除 之前加 `编辑`：打开对话框预填 `label`/`endpoint`（key 不回显、留空=不改），保存调 `api.keysUpdate(sel.id, k.keyId, patch)` —— **现成 api，零新 IPC** |
| 卡片编辑 | T2 卡片行（`:457-475`）加 `编辑`，复用右侧新建卡片表单预填，保存调 `api.cardsUpdate(c.id, patch)` |
| 「一键导入」按钮 | 保留原位（`:206-221`），随顶部操作区上移 |

### 3.3 使用动线（三期）

| 改动点 | 契约 |
|---|---|
| 动线状态条 | T1 内容区顶部渲染一条「下一步」提示（数据全部来自已加载的 `providers`/`cards`，不新拉接口）：`有密钥但该 provider 无卡片 → 「创建卡片 →」`；`有卡片但未激活任何 Agent → 「去激活 →」`；全部就绪 → 绿色 `✓ 可在聊天中选择使用` |
| 跳转预填 | 点击跳转切 tab 时携带上下文（T2 表单预填 baseUrl/provider），T3 激活成功文案已含重启提示（`:596-597`）保持不变 |
| 折叠目录 | 「网关聚合模型目录」（`:368-379`）改 `<details>` 默认折叠，保留只读展示 |

### 3.4 样式与文案约束

- 全部走既有 CSS 变量类（`bg-card`/`border-card-border`/`bg-input`/`text-brand`…），**禁硬编码色值**（`check:frontend-design-tokens` 门禁）。
- 新增文案先搜 `i18n/zh-CN.json` 同义键再新增（本页历史文案是硬编码中文，保持同页一致性，不强制迁 i18n）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚方式 |
|---|---|---|
| P1 | segmented tabs（仅 embedded 分支）+ 双标题去重 + models 容器 max-w-5xl | 撤一个文件的样式分支，standalone 路径零改动 |
| P2 | 添加表单收纳 + 密钥/卡片编辑（纯接线 keysUpdate/cardsUpdate） | 编辑入口是纯增量按钮，撤掉即回旧行为 |
| P3 | 动线状态条 + 目录折叠 | 状态条是纯展示组件，删除即回滚 |

P1 与 P2 无耦合，可并行；P3 依赖 P2 的表单组件形状（跳转预填）。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 嵌入态改成「跳独立窗口」 | 独立窗口已存在（`--key-manager`/菜单入口），但用户在设置页的语境是就地配置；把人踢去另一个窗口是换地方挤，不是减负 |
| 拖拽排序 provider/密钥 | 池内已有 priority 字段但 UI 从未暴露排序意图；先解决有/无编辑，排序等真实需求出现再做 |
| key 编辑后回显明文 | reveal 是一次性操作（60s 冷却 + 审计，`KeyManagerPage.tsx:201` 自述），编辑表单回显明文会绕过该安全模型 |
| 把本页文案迁入 i18n | 全页硬编码中文是既有现状，迁移属另一条目；本提案只保证**新增文案**不造重复键 |
| 动 T2 预设目录机制 | `builtin-fallback` 与 backend 真源的分支（`:449`）与排版无关，不碰 |

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| 给表单输入框继续加 `min-w` 或缩字号硬塞进 272px | 病灶是**容器算术**，不是字号；272px 里塞两个 200px+ 输入框在数学上不可能 |
| 新造 `keys:patch`/`cards:modify` 之类的第二个 update IPC | canonical 已三层齐全（§1.2），再建一个违反「一处真源」（`main/index.ts:85-89` 注释精神），且要同步改 D6 契约测试两侧 |
| 把编辑做成独立路由页（`#/key-manager/edit/...`） | standalone 窗口 hash 路由要动 `App.tsx:461` 分支，弹窗/抽屉成本更低且不碰路由 |
| 为「好看」删掉 env 叠加层展示（`:238-249`） | env 条目是真实数据（filter set 才渲染），删掉会让「这把 key 来自环境变量」失去可见性 |
| 用固定像素给 segmented tabs 定宽 | provider id 长度不定（`agnes` vs `ballian-tokenplan`），用内容自适应 + truncate |

---

## 7. 验收方式

```bash
# 类型：改前基线 20 条错误（2026-09-24 实测，全在 src/host/index.ts），改后必须恰为 20、零新增
"<node>" apps/khyos-desktop/node_modules/typescript/bin/tsc -p apps/khyos-desktop/tsconfig.json --noEmit

# 桌面 UI 契约（D6 IPC 两侧一致 / D9 品牌文本）——本提案不新增 IPC，必须原样绿
"<node>" --test apps/khyos-desktop/tests/desktopUiContract.test.cjs

# 设计令牌门禁：零新增 finding
"<node>" scripts/ci/check-frontend-design-tokens.js
```

手工验收（重建 `out/` 后）：
1. 设置 → 模型设置：四个 tab 横排可见，无左侧双导航；页面无横向滚动条。
2. 添加表单：四输入框全部完整可见、无截断。
3. 对任一密钥点「编辑」改 label → 保存 → 列表即时更新，重启应用后仍为新值（走 keys:update 真持久化）。
4. 仅有密钥、无卡片时，T1 顶部出现「创建卡片 →」状态条，点击能到达 T2。

---

## 8. 待核实项

| 项 | 状态 |
|---|---|
| tsc 基线数 | ✓ 已实测：20 条（2026-09-24，全部位于 `src/host/index.ts`，与本提案无交集） |
| `desktopUiContract.test.cjs` 当前是否绿 | ⚠ 实施前先跑一次记录基线，若本身红则与本提案切割 |
| registry 无 keyManager 能力域条目 | 已核实 `docs/10_规范/registry/` 无匹配（Grep 2026-09-24），不影响本提案（非借鉴类）；若后续登记能力域，落点由 memory/registry 维护者定 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-24 | 初版提案（含截图病灶、宽度算术、编辑能力零消费实证、三分期设计） |
| 2026-09-24 | P1-P3 全量实施并验收通过，新增 §10 实施记录 |

---

## 10. 实施记录（2026-09-24）

### 10.1 落地清单

| 文件 | 改动 |
|---|---|
| `renderer/components/keyManager/KeyManagerPage.tsx` | embedded 时竖 tab 栏 → 顶部横向 segmented；四个子 tab 组件的 h2/副标题改 `!embedded` 条件渲染；T1 常驻添加表单删除，「＋ 添加密钥」展开式纵向单列表单替代；T1 密钥行新增「编辑」（env 来源条目隐藏）；T2 卡片行新增「编辑」+ 表单编辑模式（保存走 `cardsUpdate`）；T1 顶部动线状态条（无密钥→建卡片→激活 Agent→✓ 就绪，点击跳转并预填端点）；聚合模型目录改 `<details>` 默认折叠 |
| `renderer/components/settings/SettingsPage.tsx` | 页面 header 与内容容器对 models 页放宽 `max-w-3xl` → `max-w-5xl`（条件类名，其余页不变） |

接线事实：编辑全部走既有 `keysUpdate`（`api.ts:94`）/ `cardsUpdate`（`api.ts:126`），**零新增 IPC**，D6 契约测试无通道变更。

### 10.2 与方案的偏离及原因

| 偏离 | 原因 |
|---|---|
| 「＋ 添加密钥」按钮放在顶部操作区（与一键导入并排），非 provider 列表顶部 | 操作集中在同一行更可发现；列表列保持纯净 |
| 一键导入按钮样式从 brand 描边改为中性描边 | 同行出现两个 brand 描边按钮后主次不分；「＋」前缀让给了添加密钥 |
| doAdd 成功后自动 `setSelected(fProvider)` | 新 provider 入库后立即可见其密钥列表，动线不中断 |
| env 来源密钥不显示「编辑」 | `keys:update` 只作用于池内条目（keyStore.ts:357 按 keyId 查池），env 条目不在池内，编辑必报「密钥不存在」 |
| T2 编辑模式隐藏预设下拉（沿用 `!preset` 分支） | 编辑时端点以卡片现存值为准，避免预设覆盖用户自定义端点 |

### 10.3 验收实测

| 门禁 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | **20 条错误，与改前基线完全一致，零新增**（基线 2026-09-24 实测） |
| `node --test apps/khyos-desktop/tests/desktopUiContract.test.cjs` | **26/26 pass，0 fail**（D6 通道两侧一致未受影响） |
| `scripts/ci/check-frontend-design-tokens.js` | exit=0；25 条 findings 全部位于 `apps/ai-frontend`（既有存量），`khyos-desktop` 零新增 |
| `electron-vite build` | exit=0，main/preload/renderer 三段构建成功（1.36s / 160ms / 12.22s） |
| 产物探针 | `out/renderer/index.html` 指向新包 `index-nTEhynY1.js`；5 个新增标识探针（动线文案 / 编辑密钥 / 折叠目录 / keysUpdate / cardsUpdate）**全部命中** |

实施未做：§5 诚实边界各项维持不动；host/scheduler 段未重建（本次未改 `src/host`、`src/scheduler`）。用户需重启 KhyOS 桌面端生效。
