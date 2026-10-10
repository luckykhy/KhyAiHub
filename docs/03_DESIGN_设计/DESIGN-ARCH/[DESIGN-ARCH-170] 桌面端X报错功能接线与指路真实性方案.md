# [DESIGN-ARCH-170] 桌面端 X 报错功能接线与指路真实性方案

> **状态**：提案（待评审）
> **范围**：`apps/khyos-desktop`（renderer + main，零 host 改动，零新增 IPC）
> **上游依赖**：无
> **调研指针**：[DESIGN-ARCH-125]（同域前置：命令面板诚实化与快捷键统一登记）；[DESIGN-ARCH-142]（更新机制，本提案不涉）
> **模板合规**：按 [DESIGN-SOURCING-001] §3 B-P2 体例逐字段填写；本提案为纯本仓缺陷修复，无外部借鉴，七字段据实声明不适用（先例：[DESIGN-ARCH-149] §2）

---

## 0. 一句话结论

两条截图 X 报错都不是「功能没做」，而是**做了三层的功能断在第四层**：

| # | 用户看到 | 真实病灶 | 三层验证结论 |
|---|---|---|---|
| 1 | 「未配置编辑器：请在『设置 → 常规』填写编辑器命令…」 | **指路指到不存在的 UI**：`desktopEditor` 在渲染层 0 处入口 | handler 全（`main/index.ts:1253-1282`）+ 桥全（`preload/index.ts:89`）+ 调用方全（`TitleBar.tsx:132-137`、`AppHeader.tsx:51-55`）——缺的只是设置页一个输入框 |
| 2 | 「链接不可用：品牌真源未配置，请检查 KHY_OS_DIR 与 serviceDefaults」 | **main 回退路径少跳一级**（`out/main` 上跳三级落在 `apps/`，services 在仓库根）+ **渲染层吞掉真实 error** | handler 全（`main/index.ts:1299-1317`）+ 桥全（`preload/index.ts:92`）+ 调用方全（`TitleBar.tsx:143-146`）——断在 root 解析与错误传递两处 |
| 3 | 「导出日志：…（自动导出通道未接线）」 | 日志目录真源自身在迁移中（`dataHome.js:24`），现在硬接线会逆着治理方向 | 无 main 侧 handler，文案里的 `~/.khyquant/logs` 指向 legacy 家目录 |
| 4 | 「检查更新：…自动更新通道未配置，跳过检查」 | 更新通道无能力 | 上游 [DESIGN-ARCH-142] 管辖，本提案不动 |

P1 修复 = 三处小改，全部落在**既有文件**内、**零新增 IPC**（`settings:set` / `app:brandingLinks` / `app:openInEditor` 通道全部已存在且 D6 已登记）。

---

## 1. 现状实证（file:line 可复核）

### 1.1 病灶 1：编辑器链路断在「设置入口不存在」

`desktopEditor` 全 src 命中仅 4 处（2026-09-30 实测 grep）：

| 位置 | 角色 | 状态 |
|---|---|---|
| `src/main/settingsStore.ts:85` | 默认值 `desktopEditor: ''` | ✅ 已定义 |
| `src/main/index.ts:1250-1257` | 消费方（settings → KHY_EDITOR 回退链） | ✅ 已实现 |
| `src/preload/index.ts:88-89` | `openInEditor` 桥 | ✅ 已暴露 |
| **渲染层** | 设置输入框 | ❌ **0 处** |

报错文案 `main/index.ts:1265` 让用户去「设置 → 常规」填写 —— `GeneralSettings.tsx` 存在且九个分区齐全（引导/数据/消息流分组/消息流显示/系统行为/更新/网络与证书/终端/语言），**唯独没有编辑器字段**。文案指路指到了空处。

可复用的现成组件：`GeneralSettings.tsx:322-364` 的 `SaveField`（输入框 + 脏态保存按钮），页面级 `onChange` 管道直通 `settings:set` IPC —— **接线 = 加一个字段，零新通道**。

### 1.2 病灶 2a：`app:brandingLinks` 的 root 回退少跳一级

`main/index.ts:1301-1303`：

```ts
const root = process.env.KHY_OS_DIR
  ? path.resolve(process.env.KHY_OS_DIR)
  : path.resolve(__dirname, '..', '..', '..')   // ← 从 out/main 上跳三级
```

实测（node -e 复算）：`path.resolve('D:/Portable/khy-os/apps/khyos-desktop/out/main','..','..','..')` = **`D:\Portable\khy-os\apps`**。
随后 `nodeRequire(path.join(root, 'services', 'backend', 'src', 'constants', 'serviceDefaults.js'))` 拼出 `apps/services/...` —— 不存在，require 必 ENOENT → catch → `{ ok: false, error }`（`main/index.ts:1314-1316`）。

对照组：host 侧有**正确**的发现顺序 `host/index.ts:41-45`（`KHY_OS_DIR → cwd/../..`，注释自述「apps/khyos-desktop 相对仓库根」）。main 没复用它，自写了一个少跳一级的版本 —— **第二真源**。

### 1.3 病灶 2b：渲染层吞掉 main 返回的真实错误

`TitleBar.tsx:92-99`：

```ts
const openUrl = async (url?: string) => {
  if (!url) {
    toast('链接不可用：品牌真源未配置，请检查 KHY_OS_DIR 与 serviceDefaults', 'error')  // :94
    return
  }
  const res = await api?.openExternal?.(url)
  ...
}
```

调用点 `TitleBar.tsx:143-146`（问题反馈 / 提需求 / 用户社群 / 产品文档四项）拿到 `getBrandingLinks()` 结果后**直接解构 `l.feedback` 等字段、不检查 `l.ok` / `l.error`**。main 返回 `{ok:false, error:'品牌链接真源不可用：…'}` 时四个 URL 全为 undefined → 全部落进 `:94` 的笼统文案。main 精心拼装的错误信息（`:1315`）**从未到达过用户**。用户于是拿着一个不存在的「未配置」问题去查 `KHY_OS_DIR`。

### 1.4 病灶 2 的旁证：URL 派生是第二真源

`main/index.ts:1305-1312` 手写 `https://${host}/feedback` 派生；而 `serviceDefaults.js:44` 已导出 `FEEDBACK_URL`（`:561` 在导出表）、`:33-39` 的 `CLOUD_DEFAULT_HOST` 也有导出（`:559`）且自带 fallback `'khyquant.top'`（`:37`）。

**关键推论**：`CLOUD_DEFAULT_HOST` 永不为空、`FEEDBACK_URL` 永不为空 —— 只要 require 成功，四个 URL 就非空。所以「品牌真源未配置」的**唯一触发条件是 require 失败**，即 1.2 的路径问题。`serviceDefaults.js:22-23` 注释自述：「Every module that needs the default MUST import these instead of re-hardcoding the domain」—— main 现在的写法正违反它。

### 1.5 病灶 3：日志目录真源在迁移中

`TitleBar.tsx:147` 文案指向 `~/.khyquant/logs`；后端唯一解析器 `dataHome.js:24` 明说 `~/.khyquant` 与 `~/.khy` 混用待统一，`:65` 要求「新增/改造的写入点必须经它而非再硬写 `os.homedir()+'.khyquant'`」。运行时日志目录经 `getDataDir('logs')`（`dataHome.js:346`）解析。⇒ 现在给 main 硬接线日志路径 = 逆着收敛方向新增一个硬编码点。**P2 处理，P1 不碰。**

### 1.6 已经干净的面（不用再治）

- **命令面板**：`CommandCenter.tsx:51-61` 上一轮 [DESIGN-ARCH-125] 已删 20 条空壳命令，现存每条都可执行，未注入的回调直接不渲染条目。
- **error toast 全集**（2026-09-30 grep）：除本提案病灶外，其余均为防御性兜底（preload 未注入 / 工作区路径为空 / host 超时），指向真实可操作动作，不在本提案范围。

---

## 2. 借鉴提案（B-P2 七字段）

> 本提案为**纯本仓缺陷修复与 UI 补线**，无任何外部借鉴，B-P2 不触发（其第 1 字段即借鉴对象）。按体例逐字段据实声明：

| # | 字段 | 内容 |
|---|---|---|
| 1 | 借鉴对象 | **不适用** —— 无外部项目、无版本/commit。 |
| 2 | 借鉴内容 | **不适用** —— 不引入任何外部结论/结构/行为/测试。 |
| 3 | 解决的问题 | 本仓 `apps/khyos-desktop` 既有断链：设置入口缺失（§1.1）、root 回退错误（§1.2）、错误吞噬（§1.3）、URL 派生第二真源（§1.4）。均指向现有 file:line。 |
| 4 | 许可证与代码性质 | **不适用** —— 不引入任何外部代码/二进制/资源。 |
| 5 | 借鉴方式 | **不适用**。 |
| 6 | 落点与现有实现对比 | 落点全部为**既有文件**：`GeneralSettings.tsx` / `main/index.ts` / `TitleBar.tsx`。搜索过 `desktopEditor`（全 src，4 命中）、`brandingLinks`（src，5 命中）、`autoUpdater|checkForUpdates`（main，仅 1 条注释命中）——确认无并行实现可收敛之外的新增面；既有第二真源（URL 手写派生）本身被本提案**删除**、收敛到 serviceDefaults 导出常量。 |
| 7 | 验收方式 | 见 §7。 |

豁免依据：零借鉴 ⇒ B-P2 本就不触发（第 1 字段为借鉴对象，据实为「不适用」）。不引用登记表作豁免依据（`FEATURE-OWNERSHIP.json` 并不含 desktop 品牌/编辑器域，该话没核过、不写）。

---

## 3. 目标形态（组件级契约）

### 3.1 设置页新增「编辑器」分区（治病灶 1）

`GeneralSettings.tsx` 新增一个 `SettingSection`，**插在「终端」分区之前**（编辑器打开的是工作区目录，与终端同属「外部工具」域，分区相邻）：

```tsx
<SettingSection title="编辑器">
  <SaveField
    label="编辑器命令"
    description="用于窗口菜单与页头的「在编辑器中打开」。填写可执行命令名或完整路径，例如 code。留空时回退读取 KHY_EDITOR 环境变量。"
    value={(settings.desktopEditor as string) || ''}
    placeholder="例如 code"
    onChange={(v) => onChange('desktopEditor', v)}
  />
</SettingSection>
```

约束：

- **零新增 IPC**：走页面既有 `onChange` → `settings:set` 管道；`settingsStore.ts:85` 已登记默认值。
- **样式零硬编码**：`SaveField` 现成 class（`bg-input` / `border-input-border` / `text-foreground` 等 CSS 变量族），不新增任何色值。
- **文案与 main 指路互指**：description 里「设置 → 常规」的路径描述与 `main/index.ts:1265` 错误文案保持同词——错误指的路从此真实存在。
- 文案沿用本页现状（内联中文，与 `:18-19` 等既有条目一致）；**不**为单字段新开 i18n 双轨（见 §5）。

### 3.2 main `app:brandingLinks` 修正（治病灶 2a + 1.4）

```ts
ipcMain.handle('app:brandingLinks', async () => {
  try {
    // 与 host/index.ts resolveKhyOsDir 同语义：env 优先，回退以 app 包根
    // （package.json 所在 = apps/khyos-desktop）上跳两级到仓库根。
    // 不用 __dirname 数跳级 —— out/ 深度随构建形态漂移（本次病灶即由此而来）。
    const root = process.env.KHY_OS_DIR
      ? path.resolve(process.env.KHY_OS_DIR)
      : path.resolve(app.getAppPath(), '..', '..')
    const sd = nodeRequire(path.join(root, 'services', 'backend', 'src', 'constants', 'serviceDefaults.js'))
    // 消费导出常量（serviceDefaults.js:22-23 的 MUST import 约束），不再手写 /feedback 派生
    const host = sd.CLOUD_DEFAULT_HOST || ''
    return {
      ok: true,
      cloudHost: host,
      feedback: sd.FEEDBACK_URL || '',
      docs: host ? `https://${host}/docs` : '',
      community: host ? `https://${host}/community` : '',
      issues: host ? `https://${host}/issues` : '',
    }
  } catch (err) {
    return { ok: false, error: `品牌链接真源不可用：${String((err as Error)?.message || err)}` }
  }
})
```

- `serviceDefaults.js` 是零依赖叶子（其 `:15-17` 自述），跨 bundle require 安全，维持现状加载方式。
- `docs/community/issues` 从**已导出的** `CLOUD_DEFAULT_HOST` 派生一次（serviceDefaults 未导出这三个常量；不为它们扩 backend canonical —— 见 §5）。
- **待核实锚点**：`app.getAppPath()` 的实际值以实施时探针输出为准，见 §8.1。

### 3.3 渲染层错误透传（治病灶 2b）

`TitleBar.tsx` 四个品牌链接菜单项改为先判 `ok`：

```ts
{ kind: 'action', label: '问题反馈', run: () => { void api?.getBrandingLinks?.().then((l) => {
    if (l && l.ok === false) { toast(l.error || '品牌链接真源不可用', 'error'); return }
    openUrl(l?.feedback)
  }) } },
```

- main 的真实 error（含 root 解析失败的 ENOENT 路径）**原样到达用户**，不再被改写成「未配置」。
- `:94` 的笼统文案保留为防御兜底（`ok:true` 但 URL 为空串的理论分支），加注释说明其兜底地位，**不再是用户能看到的常态**。

### 3.4 报错指路真实性原则（本提案沉淀的判据）

> **报错文案里指的路必须真实存在。** 诚实红线不仅要求「如实说错」，还要求「指的路通」：文案指向设置页，设置页就得有那个字段；文案指向日志目录，那个目录就得经唯一解析器可达。

此判据与 [DESIGN-ARCH-125] 的「不渲染点不动的命令」同族：前者治「说了没有的路」，后者治「列了没有的命令」。

---

## 4. 实施分期（每期独立可回滚）

### P1（一次落地，零新增 IPC，全部既有文件内）

| 步骤 | 文件 | 改动 | 回滚 |
|---|---|---|---|
| 1 | `GeneralSettings.tsx` | 新增「编辑器」分区（§3.1） | revert 单文件 |
| 2 | `main/index.ts` | `app:brandingLinks` root 修正 + 消费导出常量（§3.2） | revert 单文件 |
| 3 | `TitleBar.tsx` | 四个链接项错误透传（§3.3） | revert 单文件 |

三步相互独立：任一步单独 revert 不影响其余两步的功能成立。

### P2（另行小步，前置核实见 §8.2）

- 「导出日志」真接线：菜单项 → 打开日志目录（复用 `app:openPath`）。**前置**：main 侧获得 dataHome 唯一解析器的结果（经 host 查询或设置侧落定 dataPath 后推导），**禁止**在 main 硬编码 `~/.khyquant`（§6.5）。

### 不在本提案（上游管辖）

- 「检查更新」→ [DESIGN-ARCH-142]。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 自动探测编辑器（扫 PATH 找 code/cursor/…） | 见 §6.1，三条理由 |
| 给 serviceDefaults 补 DOCS/COMMUNITY/ISSUES 常量 | 改 backend canonical 属另一能力域；从已导出的 `CLOUD_DEFAULT_HOST` 派生一次已消除第二**字面量**。要扩也是独立的 backend 小步，不混进桌面端修复 |
| 动「检查更新」 | [DESIGN-ARCH-142] 管辖，越界 |
| i18n 键迁移 | GeneralSettings 现状全内联中文；单字段开键 = 造双轨。i18n 是该页面的既有债务，不在本提案扩大战线 |
| 给 brandingLinks / 编辑器解析加任何 `KHY_XXX` 开关 | 见 §6.4，撞门预算棘轮 + 破坏 B-P1 豁免 |
| P1 顺手接「导出日志」 | 日志目录真源在迁移中（§1.5），现在接线就是新增硬编码点 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| **自动探测编辑器**（遍历 PATH 找 code.exe） | ① 与既有单一来源链（settings.desktopEditor → KHY_EDITOR）冲突成第二真源；② 探测结果因机器而异，用户想用 cursor 却被打开 code，行为不可预测；③ `execFile` 一个探测出来的可执行文件扩大攻击面。缺省时的正确行为是**把指路的路修通**（§3.1），不是替用户猜 |
| **把 `https://khyquant.top/feedback` 硬写进 main** | serviceDefaults.js:22-23 自述 MUST import；`CLOUD_FALLBACK_ENDPOINTS`（:25-28）就是为域名迁移预留的，硬编码让 main 在迁移日必漏 |
| **渲染层吞 `ok:false` 继续显示笼统文案** | 本次病灶 2b 的成因本身。错误必须原样到达用户——笼统文案让用户去查一个不存在的「未配置」问题，比不报错更糟 |
| **加 `KHY_XXX` env 开关做回滚** | 撞门预算棘轮（`check-tui-gates.js:32`，MAX_GATES 只降不升）；且 B-P1 的「新增配置键」判据会把 bugfix 从豁免变成非豁免。「让功能变正确」不构成用户可见权衡，回滚能力用 revert 承担 |
| **在 main 硬写 `~/.khyquant/logs` 修日志入口** | dataHome.js:24/:60-65 明确正在把散落的硬编码收敛到唯一解析器；新增硬编码 = 逆着治理方向开倒车 |
| **用 `__dirname` 数跳级修 root** | 本次病灶 2a 的成因本身。`out/` 深度随构建形态漂移；用 `app.getAppPath()`（package.json 所在目录）做语义化锚点 |

---

## 7. 验收方式（可复现命令 + 关联门禁）

```bash
# D6（preload↔main 两侧一致）+ D9（品牌文本）——本次零新增 IPC，应原样绿
node --test apps/khyos-desktop/tests/desktopUiContract.test.cjs

# 设计令牌门禁——新字段全走 CSS 变量，零新增 finding
node scripts/ci/check-frontend-design-tokens.js

# tsc 前后对照：只认「错误数不新增」，基线数字以当日实测为准（历史 33 条，不写死）
node apps/khyos-desktop/node_modules/typescript/bin/tsc -p apps/khyos-desktop/tsconfig.json --noEmit
```

手工验收脚本：

1. **品牌链接（正路）**：不设 `KHY_OS_DIR` 启动 → 窗口菜单「问题反馈 / 给产品提需求 / 用户社群 / 产品文档」→ 应打开 `*.khyquant.top` 域链接，不再报「品牌真源未配置」。
2. **品牌链接（错误透传）**：把 `KHY_OS_DIR` 指向坏目录重启 → 点任一链接项 → 应显示 main 返回的真实错误（含 ENOENT 路径），不再是笼统文案。
3. **编辑器闭环**：设置 → 常规 →「编辑器」分区填 `code` → 保存 → 窗口菜单「在编辑器中打开」→ VS Code 打开工作区根。
4. **编辑器缺省**：清空编辑器命令且不设 `KHY_EDITOR` → 点「在编辑器中打开」→ 报错文案与设置页字段互指，按文案走到「设置 → 常规」能看到该字段。

关联门禁：`npm run check:frontend-design-tokens` / `check:changed` / `check:proposal-index`（非借鉴类无需登记，跑通自身校验即可）。

---

## 8. 待核实项

1. **★ `app.getAppPath()` 在本仓 dev 与生产构建下的实际值**（决定 §3.2 锚点写法）。预期 `apps/khyos-desktop`；实施时以探针输出为准，若不符则回退 `process.cwd()` 与 host 同基准。**此项只影响写法，不影响方案成立**（两处锚点语义均为「包根上跳两级」）。
2. **`settings:set` 对 `desktopEditor` 的键校验**：`settingsStore.ts:85` 已有默认值 ⇒ 大概率无白名单拦截；实施时核 `settings:set` handler 确认，若有白名单需同步登记。
3. **CI 对 `apps/khyos-desktop/tests/` 的选择范围**：按 6.3 纪律，实施前核 `.github/workflows/pr-gate.yml`；如需新增 UI 行为断言，用 `node:test` 显式 `require` 写、前置条件不满足时显式 skip，杜绝 jest 风格全局。
4. **i18n 同义键**：实施前在 `zh-CN.json` 搜「编辑器命令」同义键，有则复用，无则维持内联（§5）。

---

## 9. 变更日志

- 2026-09-30 v1：初稿。病灶 1/2/3 实测定位（§1），P1 三步接线方案（§3/§4），指路真实性判据（§3.4）。
