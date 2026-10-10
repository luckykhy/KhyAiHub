<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-171] 未接入后端判定与接线守卫真实性方案

> **状态**：提案（待评审）
> **范围**：`scripts/ci/check-f2e-wiring.js`（判据重写）+ `scripts/ci/wiring-exemptions.json`（豁免处置）+ `apps/khyos-desktop`（判定面扩大，零改动）+ `docs`（判定口径沉淀）
> **上游依赖**：无
> **调研指针**：[DESIGN-ARCH-060]（接线契约与编排总图：CLI/service 层审计基线）；[DESIGN-ARCH-166]（静默失效四类病因；本提案是其「能力存在但入口不调」在**桌面 IPC 面**的实例化）；[DESIGN-ARCH-170]（桌面端 X 报错：已修 4 条用户可见报错，本提案不重复）；[DESIGN-ARCH-091]（KeyManager GUI 规范：§6 IPC 契约真源）；[DESIGN-ARCH-125]（命令面板诚实化：诚实红线同族）
> **模板合规**：按 [DESIGN-SOURCING-001] §3 B-P2 体例逐字段填写；本提案为纯本仓缺陷修复与守卫判据重写，无外部借鉴，七字段据实声明不适用（先例：[DESIGN-ARCH-149] §2、[DESIGN-ARCH-170] §2）

---

## 0. 一句话结论

用户报的「khy-os 中有大量没有接入的后端」，经实证**归因与表象相反**：

| 命题 | 实测判决 |
|---|---|
| 「有 25 个后端没接入」 | **假** —— 25 个 IPC handler **全部已注册且生效**，链路四层贯通 |
| 「有一个检查器说它们没接入」 | **真** —— `check-f2e-wiring.js` 因正则收窄，**误报 25 项** |
| 「真实未接入的缺口」 | **存在，但不是那 25 项** —— 是 170 病灶 1/3 与 `Composer.tsx:142`，**该检查器一个都没报** |
| 「那为什么用户有大量不良体验」 | **真因是治理层**：检查器因误报被豁免 → 无人跑 → 误报固化 → **下一个读者信以为真** |

**结论**：这是**双向失效的守卫**——它误报了 0 个真缺口中的 25 个假项，又漏报了真实的用户可见缺口。修法不是"补 25 个 handler"（那是修一个不存在的 bug），而是**把守卫判据改对 + 把它接进 CI + 让豁免理由与事实一致**。

---

## 1. 现状实证（file:line 可复核）

### 1.1 实测基线：25 个 gap

```bash
$ node scripts/ci/check-f2e-wiring.js
Front-end ↔ Back-end Wiring Audit (3 directions)
=================================================
  Backend served namespaces: 78
  WEB (ai-frontend /api/*): OK  (51 items)
  TUI (cli service-layer require): OK  (1103 items)
  DESKTOP (IPC + endpoint source): 25 gap(s)  (131 items)

  gaps (25):
  ✗ [ipc-orphan-invoke] .invoke(keys:list) has no ipcMain.handle(keys:list)   [khyos-desktop (new) apps/khyos-desktop/src/preload/index.ts:176]
  … （共 25 条，全部形如 `[ipc-orphan-invoke]`，全部指向 preload/index.ts:176-212）
```

命令退出码 `1`（判红）。

### 1.2 25 个通道的四层贯通实证

以 `keys:list` 为例，逐层取证：

| 层 | 文件 | 行 | 状态 |
|---|---|---|---|
| ① preload 暴露 | `apps/khyos-desktop/src/preload/index.ts` | `:176` `keysList: () => ipcRenderer.invoke('keys:list')` | ✅ |
| ② main 注册 handler | `apps/khyos-desktop/src/main/keyManager/ipc.ts` | `:51` `ipc.handle('keys:list', async () => ok(await listPool()))` | ✅ |
| ③ 注册被调用 | `apps/khyos-desktop/src/main/index.ts` | `:1362` `registerKeyManagerIpc(ipcMain)`（在 `app.whenReady()` 内） | ✅ |
| ④ renderer 调用方 | `apps/khyos-desktop/src/renderer/components/keymanager/KeyManagerPage.tsx` | `:184` `const r = await api.keysList()` | ✅ |
| ⑤ 后端服务实现 | `apps/khyos-desktop/src/main/keyManager/keyStore.ts` | 28.9 KB，`listPool` 等 20+ 导出 | ✅ |

**25 个通道全部具备上述五层**。关键文件清单（`apps/khyos-desktop/src/main/keyManager/`）：

| 文件 | 体积 | 职责 |
|---|---|---|
| `ipc.ts` | 8.6 KB | **25 个 handler 注册本体**（`:51-181`） |
| `keyStore.ts` | 28.9 KB | Key 池 CRUD / 卡片 / 预设 / 模型拉取 / 端点校验 |
| `agentWriters.ts` | 18.0 KB | Mode A/B 写入编排 |
| `health.ts` / `audit.ts` / `proxyStatus.ts` | 2-5 KB | 健康探测 / 审计 / 代理状态 |
| `types.ts` | 4.9 KB | 契约类型 |

renderer 侧调用点（`KeyManagerPage.tsx`，47 KB）：`:184` `keysList()`、`:199` `cardsList()`、`:217/:263` `modelsFetch()`、`:256` `keysAdd()`、`:609` `endpointsPresets()`、`:846` `agentsMatrix()`、`:854` `proxyStatus()`、`:1053` `healthProbe()`。

### 1.3 假阳性根因：正则只认 `ipcMain` 字面量

`scripts/ci/check-f2e-wiring.js:243`：

```js
const RE_HANDLE = /ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/;
```

它只匹配变量名恰为 `ipcMain` 的 `.handle(` 调用。而 `keyManager/ipc.ts:45` 的签名是：

```ts
export function registerKeyManagerIpc(ipc: IpcMain, repoRootOverride?: string): void {
  ipc.handle('keys:list', …)   // ← 变量名是 ipc，不是 ipcMain
```

**注入式参数名 ≠ `ipcMain`** ⇒ 25 条注册全部匹配不到。

实测计数（2026-10-01）：

| 模式 | 命中 | 说明 |
|---|---|---|
| `grep -rn "ipcMain\.handle(" apps/khyos-desktop/src/` | **71** | 审计器能看见的面 |
| `grep -rnE "(^\|[^a-zA-Z])ipc\.handle\(" apps/khyos-desktop/src/` | **25** | 审计器看不见的面 |
| 后者所在文件 | `apps/khyos-desktop/src/main/keyManager/ipc.ts`（唯一） | — |

**25 = 25，一一对应**，误差为零。

### 1.4 独立交叉验证：真实孤儿数 = 0

用不依赖 `ipcMain` 字面量的穷尽扫描（握手面取「任意 `<ident>.handle('ch'`」）在 `apps/khyos-desktop/src` + `electron/` 上重跑同一逻辑：

| 口径 | 孤儿 invoke | 悬空 handle |
|---|---|---|
| `check-f2e-wiring.js`（`ipcMain` 字面量） | **25** | — |
| 独立穷尽扫描（任意 ident） | **0** | 1 |

唯一悬空 handle：`host:status`（`apps/khyos-desktop/src/main/index.ts:1027`，返回 `{running, pid}`）——main 单侧定义，preload 未暴露、renderer 无调用。**信息量极小（host 状态已在别处体现），属死代码级，非用户痛点。**

### 1.5 更贵的事实：它同时**漏报**真实缺口

用户能亲眼看到的「未接入」文案，全仓扫描（`apps/khyos-desktop/src/renderer/`）：

| # | 位置 | 用户看到 | 真实性质 | 该检查器报了吗 |
|---|---|---|---|---|
| 1 | `layout/TitleBar.tsx:94` | 「链接不可用：品牌真源未配置…」 | **真断链**（root 少跳一级 + 错误被吞） | ❌ 否（170 §1.2/§1.3 已另修） |
| 2 | `layout/TitleBar.tsx:140` | 「自动更新通道未配置，跳过检查」 | 上游 [DESIGN-ARCH-142] 管辖 | ❌ 否 |
| 3 | `layout/TitleBar.tsx:147` | 「导出日志…（自动导出通道**未接线**）」 | **真未接线**（数据目录真源迁移中） | ❌ 否 |
| 4 | `composer/Composer.tsx:142` | 「分类明细…需后端分类统计，**当前未接线**」 | **真未接线**（后端无分类统计能力） | ❌ 否 |
| 5 | `message/DiffViewer.tsx:150` | 「查看不可用：未接线 diff 查看器」 | **防御文案**（`App.tsx:623` 已传 `onViewDiff`，走 `khy:open-file`），不可达 | — |
| 6 | `keyManager/KeyManagerPage.tsx:912` | 「聚合模式暂不可用（直连模式仍可用）」 | 正常条件态 | — |
| 7 | `message/MessageBubble.tsx:48` | 「上游异常 (5xx)：模型服务暂不可用」 | 正常错误态 | — |

**判决**：真缺口是 #1/#3/#4 三条，**该检查器 0 命中**。因为它的判据只有 `.invoke → handler` 单向，「后端有能力、前端无入口」（#3/#4 的形态）它**结构上就查不到**。

> **双向失效**：误报 25 个不存在的，漏报 3 个真实存在的。

### 1.6 为什么没人发现：它被豁免了

`scripts/ci/wiring-exemptions.json:15-19`：

```json
{
  "script": "check-f2e-wiring.js",
  "reason": "同 check-f2e-spec.js：与 F2E 规格守卫成对，待 CI 浏览器环境就绪后一并接线。",
  "until": "2026-12-14"
}
```

豁免机制由 `scripts/ci/check-wiring.js`（TOOLING-005 反孤儿守卫）定义（`:17-18`）：

> 每个 `scripts/ci` 检查器必须被 ≥1 门引用，**或在 wiring-exemptions.json 登记 reason + 到期日**。

**这里的理由与事实不符**：`check-f2e-wiring.js` 是**纯静态正则扫描**，无 playwright、无浏览器依赖，本地已跑通（1.1 的输出即本机产出）。真正不能接线的原因是**它会误报 25 项**——而豁免表**没写这个理由**。

**因果链**：

```
正则收窄 → 25 假阳性 → 被豁免（理由写成"缺浏览器环境"）→ 无人跑
   → 假阳性从未被质疑 → 固化 → 下一个打开它的人相信"有 25 个后端没接入"
```

这正是 [DESIGN-ARCH-166] 四类病因中「**能力存在但入口不调**」的镜像形态：**守卫存在但没人跑，且它自己报的就是错的**。

### 1.7 已确认的干净面（不用再治）

- **WEB 方向**：`OK (51 items)`，干净。
- **TUI 方向**：`OK (1103 items)`，干净。
- **旧桌面端** `electron/`：同时被 DESKTOP 方向审计（`:237`），**零 gap**。
- **KeyManager 全链路**：§1.2 五层齐全，功能可用。

### 1.8 实施结果（2026-10-01 已落地 A1/A2/A3）

> 本节记录**已执行**的改动与实测数据。落地范围仅 `scripts/ci/check-f2e-wiring.js` 一个文件。

**A1（判据放宽）+ A2（动态注册降级）已落地**，`scripts/ci/check-f2e-wiring.js:243` 起：

```js
// 握手面识别：任意接收者上的 .handle('ch'，不限定变量名。
const RE_HANDLE = /(?:\b[A-Za-z_$][\w$]*)\.handle\(\s*(['"`])([^'"`]+)\1/;
// 动态注册：handle(<非字面量>) —— 静态判不出通道名，只用于把 error 降级为 warning。
const RE_HANDLE_DYNAMIC = /\.handle\(\s*(?!\s*['"`])[A-Za-z_$[]/;
```

四级判决取代原来的二元判决：

| 情形 | 判级 |
|---|---|
| invoke 有字面量 handle 命中 | matched（绿） |
| invoke 无字面量 handle，但目录内**存在动态注册点** | **warning**（`ipc-channel-unverified`，不阻断） |
| invoke 无 handle，且**无任何动态注册** | **error**（真孤儿） |
| handle 无 invoke（悬空能力） | **advisory**（仅打印，见 A3） |

**实测对照表**：

| 指标 | 改前 | 改后 | 期望 |
|---|---|---|---|
| DESKTOP gap | 25 | **0** | 0 |
| DESKTOP matched | 106 | **131** | 131 |
| WEB matched | 51 | 51 | 不变 |
| TUI matched | 1103 | 1103 | 不变 |
| 退出码 | 1 | **0** | 0 |

**A3（悬空能力 advisory）已落地**：新增 `danglingHandles`，跨 app 取并集后与全仓 invoke 集比对，**只打印不计入 gap、不影响退出码**。实测输出：

```
── DESKTOP (IPC + endpoint source) ───────────────────
  (clean)
  -- dangling handlers (advisory, 无前端入口；刻意保留则登记为设计选择): 1
     · host:status
```

`host:status`（`apps/khyos-desktop/src/main/index.ts:1027`）是唯一项，与独立穷尽扫描（§1.4）结论一致。

**反向断言实测**（打断一条 handler）：

```
$ # 把 ipc.handle('proxy:status', …) 临时改名为 proxy:status_X
DESKTOP (IPC + endpoint source): 1 gap(s)  (131 items)
✗ [ipc-orphan-invoke] .invoke(proxy:status) has no handle(proxy:status)   [preload/index.ts:207]
   · proxy:status_X          ← 同时进 advisory（它成了悬空）
WIRING GAPS FOUND across DESKTOP (IPC + endpoint source)
```

⇒ 新判据**仍具备真实判定能力**，且 error/advisory 两个出口同时工作。

### 1.9 运行态验证：25 个通道真的注册了（非仅源码可读）

守卫判绿只说明**源码字符串对上了**，不等于**运行时真的挂上**。为此新增 `apps/khyos-desktop/tests/wiringRuntime.test.mjs`，与静态审计互为独立口径：

| 测试 | 判据 | 结果 |
|---|---|---|
| 注册面 | 真调 `registerKeyManagerIpc(fakeIpc)`，收集实际注册的通道名，比对 preload 暴露的 25 个 | **25/25** |
| 无重复 | 同一通道不得注册两次（重复注册静默覆盖，是真实事故形态） | 无重复 |
| handler 类型 | 25 个 handler 全是真函数（非 undefined 占位） | 全通过 |
| **真调用** | 逐个调用 7 个只读通道，断言返回 `{ok:true, data}` | **7/7 返回真数据** |

真调用实测输出（节选）：

```json
{ "keys:list":       { "ok": true, "keys": ["ok","data"] },
  "providers:list":  { "ok": true, "keys": ["ok","data"] },
  "endpoints:presets":{ "ok": true, "keys": ["ok","data"] },
  "cards:list":      { "ok": true, "keys": ["ok","data"] },
  "agents:matrix":   { "ok": true, "keys": ["ok","data"] },
  "proxy:status":    { "ok": true, "keys": ["ok","data"] },
  "health:audit-list":{ "ok": true, "keys": ["ok","data"] } }
```

⇒ **不是空壳**，真的在出数据。

### 1.10 按钮响应验证：每处调用都消费了返回值

「后端通了」还不等于「按钮有反应」。最后一公里是 renderer：**点了之后有没有反馈**。检查 `KeyManagerPage.tsx` 的全部调用点：

| 交互 | 位置 | 返回值处理 |
|---|---|---|
| 添加密钥 | `:256` `await api.keysAdd(...)` | `if (!r.ok) setMsg({kind:'err'})`，成功 `setMsg({kind:'ok'})` |
| 更新密钥 | `:284` `await api.keysUpdate(...)` | 同上 |
| 启停密钥 | `:507` `await api.keysToggle(...)` | `if (r.ok) onChange() else setMsg(err)` |
| 查看明文 | `:518` `await api.keysReveal(...)` | 成功写剪贴板 |
| 删除密钥 | `:537` `await api.keysRemove(...)` | 失败提前 return + 提示 |
| 删除卡片 | `:730` `await api.cardsRemove(...)` | 同族处理 |
| 端点校验 | `:801` `await api.endpointsValidate(...)` | 成功 `setValidateState(r.data)` |
| 启动代理 | `:918` `await api.proxyStart()` | 同族处理 |
| 一键激活 | `:869` `await api.agentsApply(...)` | 同族处理 |

**结论**：全部调用点都消费了返回值，错误走明确出口，成功有可观测反馈 —— **不存在"点了没反应"的装饰按钮**。

该结论已固化为两条结构判据测试（见 §7.2），并接入 `package.json` 的 `test` 脚本，避免退化成"写了没人跑"。

---

## 2. 借鉴提案（B-P2 七字段）

> 本提案为**纯本仓守卫判据修复 + 治理接线**，无任何外部借鉴，B-P2 不触发（其第 1 字段即借鉴对象）。按体例逐字段据实声明：

| # | 字段 | 内容 |
|---|---|---|
| 1 | 借鉴对象 | **不适用** —— 无外部项目、无版本/commit。 |
| 2 | 借鉴内容 | **不适用** —— 不引入任何外部结论/结构/行为/测试。 |
| 3 | 解决的问题 | 本仓 `scripts/ci/check-f2e-wiring.js` 的 DESKTOP 方向判据失效：误报 25 项（§1.3）、漏报真实缺口（§1.5）、因误报被豁免而无人运行（§1.6）。全部指向现有 file:line。 |
| 4 | 许可证与代码性质 | **不适用** —— 不引入任何外部代码/二进制/资源。 |
| 5 | 借鉴方式 | **不适用**。 |
| 6 | 落点与现有实现对比 | 落点全部为**既有文件**：`scripts/ci/check-f2e-wiring.js`（改判据）、`scripts/ci/wiring-exemptions.json`（改豁免）、`package.json`（加 `check:*` 别名）。搜索过 `check-f2e-wiring` / `wiring-exemptions` / `ipc-orphan`（全仓）——除本提案点名的三处外无并行实现；**不新增检查器**（撞 `wiring-exemptions` 的收敛方向）、**不新增规则 ID**（登记表已 95/95 满）、**不新增 `KHY_*` 门控**（`check-tui-gates.js` 已超限 236>227）。 |
| 7 | 验收方式 | 见 §7。 |

豁免依据：零借鉴 ⇒ B-P2 本就不触发（第 1 字段为借鉴对象，据实为「不适用」）。

---

## 3. 边界：与既有件的分工（防重复真源）

按 `[MGMT-STD-008]` §2.2「重叠即违规」，逐件划定：

| 既有件 | 它管什么 | 本提案管什么 | 交叠处 |
|---|---|---|---|
| `[DESIGN-ARCH-060]` §四 | **CLI/service 层**孤儿叶子（fs 扫 165 叶子 × 29226 文件 require 引用），基线「0 个事故性孤儿」 | **桌面 IPC 层**通道配对 | **无交叠**：060 `:91` 判据是 `require` 引用，与 IPC 无关。060 **不覆盖桌面面**，本提案填的正是这个真空。 |
| `[DESIGN-ARCH-166]` | 静默失效**四例具体个案**（fd 打穿 / EISDIR / 虚高 / 无界文件） | 守卫**判据本身**失效 | **无交叠**：166 治运行时行为，本提案治静态检查器。166 §6 `:365` 明言「不新增 `scripts/ci/` 检查器」，本提案**遵此**（只改既有）。 |
| `[DESIGN-ARCH-170]` | 桌面 4 条**用户可见报错**的 P1 三处接线（§1.5 的 #1/#2/#3） | **判定与守卫**：这些缺口为何无人发现 | **有意交叠、方向互补**：170 修「那三条报错」，本提案修「报这三条的机制缺位」。170 完成 ≠ 本提案完成，反之亦然。 |
| `[DESIGN-ARCH-091]` | KeyManager **IPC 契约真源**（§6 通道清单） | 该契约的**实现是否被守卫正确识别** | **无交叠**：091 是设计真源，本提案是守卫。091 §3 `:54` 已自述「90% 是接线，不是发明」——本提案正是让守卫**如实反映**这一点。 |
| `[DESIGN-ARCH-125]` | 命令面板「不渲染点不动的命令」 | IPC 层「不误报调不到的通道」 | **同族、不同面**：125 治 UI 渲染诚实，本提案治守卫判定诚实。 |

**不重复真源声明**：本提案**不**新定义「接线」语义（那在 060）、**不**新定义 IPC 契约（那在 091）、**不**新定义诚实红线（那在 125/170 已沉淀）。本提案只做一件事：**让既有守卫的判据与上述真源一致**。

---

## 4. 设计公理（继承 + 本提案新增一条）

继承 [DESIGN-ARCH-166] §4 四条公理：P1 一处语义输入 / P2 静默 catch 只许用在失败无害上 / P3 强度必须与「有可行解」同步 / P4 不新增棘轮负担。

**本提案新增 P5（守卫诚实性）：**

> **守卫的误报与漏报同等昂贵。**
> 一个报红但不该报红的守卫，比没有守卫更糟 —— 它会训练维护者**忽略它**，并让下一个读者**相信它**。
> ⇒ 判据的**识别面**必须覆盖**语义面**：写 `ipcMain.handle` 还是 `ipc.handle` 是实现风格，不是接线与否。
> ⇒ 守卫因"会误报"被豁免时，**豁免理由必须写真实原因**，否则下一个维护者会照着一个假理由去修一个不存在的依赖。

**P5 的推论（判据覆盖面 ≤ 语义面 时，只许 fail-soft）**：

> 静态正则的识别能力天然低于语义。当实现方用了**语义等价但字面不同**的写法时，守卫应**降级为 warning 并提示"可能未覆盖"**，**不得判 error**。
> 反例（本次）：`ipc.handle` 与 `ipcMain.handle` 语义等价，守卫却按 error 报 25 项。

---

## 5. 修法（A 层：把判据改对）

### A1. 握手面识别扩展到「任意接收者 + 表驱动注册」

`check-f2e-wiring.js:243` 改为**双正则并集**：

```js
// 字面调用：<任意标识符>.handle('ch'  —— 覆盖 ipcMain.handle / ipc.handle / ctx.handle …
const RE_HANDLE_CALL = /(?:\b[A-Za-z_$][\w$]*)\.handle\(\s*(['"`])([^'"`]+)\1/;
// 表驱动注册：for (const ch of [...]) ipc.handle(ch, …) / HANDLERS = { 'ch': … }
// —— 见 A2 的处理；此处正则只负责字面调用
```

**约束：这句正则不许再收窄。** 唯一保留的排除：`.handle(` 前必须是标识符（挡住 `foo.handler()` / 字符串里的 `.handle(`）——即上面的 `\b[A-Za-z_$][\w$]*\.`。

**A1 的验证（已于 2026-10-01 用探针副本实跑，非预期值）**：

| 指标 | 修前 | 修后 | 其它方向 |
|---|---|---|---|
| DESKTOP gap | 25 | **0** | — |
| DESKTOP matched | 106 | **131** | — |
| WEB matched | 51 | 51 | ✅ 不变 |
| TUI matched | 1103 | 1103 | ✅ 不变 |
| 退出码 | 1 | **0** | — |

修法：把原正则替换为 `/(?:\b[A-Za-z_$][\w$]*)\.handle\(\s*(['"`])([^'"`]+)\1/`，在 `scripts/ci/` 下建同名探针副本实跑（不覆盖原件），跑完后删除。**四项预测全部命中，其它方向零误伤。**

### A2. 未被识别的注册形态：降级为 warning，不判 error

若某通道的 invoke **无对应 handle 命中**，且该通道在**被扫描目录内出现过任何 `handle(` 调用但通道名是动态拼接**（如 `ipc.handle(prefix + ':' + name)`）—— 此时**无法静态判定**，按 P5 推论**降级 warning**：

```
⚠ [ipc-channel-unverified] .invoke(keys:list) — no literal handle matched;
   a dynamic registration site exists at <file:line>. Verify manually.
```

**强度梯度**：

| 情形 | 判级 |
|---|---|
| invoke 无 handle，且**目录内无任何动态注册** | **error**（真孤儿） |
| invoke 无 handle，但**存在动态注册点** | **warning**（无法静态判定，不阻断） |
| handle 无 invoke（悬空） | **warning**（`--strict-dangling` 时升 error） |

### A3. 补「后端有能力、前端无入口」方向（**只报不改**）

按 P4（不新增棘轮负担），**不新增检查器**，而是在**既有** `check-f2e-wiring.js` 内加一段**advisory**（不计入 exit code，仅打印）：

```js
// ── direction 4c: 后端已注册但无任何 invoke 的通道（悬空能力）──
// 本次实测 1 项（host:status）。不判 error：部分通道刻意留给后续前端
// （见 [DESIGN-ARCH-060] §四的 pty.js 先例：保留且刻意不接线）。
// 打印仅为让维护者看见，处置权在人工。
```

**扣分项不接入门档**，理由见 §6.3。

### A4. TUI/WEB 方向同步享受 A1 修正

A1 的正则改动在 `checkDesktop()` 内，但 `RE_HANDLE` 是**模块级共享**（`:243` 定义在 `checkDesktop` 内，`:236` 的 apps 数组也在内）—— 实测确认它仅用于 DESKTOP 方向，WEB/TUI 用各自的 `require`/`/api/*` 解析逻辑，**不受影响**。改后应复核 WEB `51` / TUI `1103` **数字不变**（回归护栏）。

### A5. 豁免处置（与 A1 同批）

`wiring-exemptions.json:15-19` 的理由**与事实不符**（§1.6）。三个选项，**不代裁决**：

| 选项 | 动作 | 代价 | 收益 |
|---|---|---|---|
| **① 接线** | 加 `package.json` 别名 `check:f2e-wiring`，并入 `check:structure` 门链；从豁免表**删除**该条 | 该检查器成为门禁一部分，未来任何真孤儿会阻断提交 | 守卫真正生效；`matched 131` 成为可回归基线 |
| **② 续期** | 保留豁免，`reason` 改写为**真实原因**（"判据曾误报，待 A1 修复后接线"），`until` 顺延 | 继续无人跑 | 至少理由诚实，不再误导 |
| **③ 删除** | 判定该检查器价值不足（WEB/TUI 已绿，DESKTOP 仅 1 项 advisory），径行删除 | 失去三方向审计 | 少一个 95 规则体系里的空转件 |

**建议倾向 ①**（A1 修完后它报 0 gap，接线成本最低、收益最高），但**由维护者裁决**。

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| **去补 25 个 `ipcMain.handle`** | 那 25 个已注册在 `keyManager/ipc.ts:51-181`。再补一遍 = **同一通道两处注册**（Electron 后注册覆盖前者，`keyManager` 的审计/脱敏语义全丢）——这是把"假 bug"修成"真 bug" |
| **把 `keyManager/ipc.ts` 的 `ipc.handle` 改成 `ipcMain.handle`** | 治的是症状不是病因：参数名是**注入设计**（`registerKeyManagerIpc(ipc)` 便于测试注入 mock）。改它等于让签名耦合全局单例，且**下一个表驱动注册点又会复发** |
| **删掉 `wiring-exemptions.json` 里的豁免了事** | 豁免表本身是 TOOLING-005 的**正确设计**（`check-wiring.js:17-20`）。删条目 = 让 check-wiring 判 error，且理由问题（§1.6）被掩盖 |
| **新增一个 `check-ipc-wiring.js`** | 撞 P4；且 `wiring-exemptions.json` 的收敛方向就是**减少**孤儿检查器。本次是**修既有判据**，不是加新件 |
| **给这个检查器加 `KHY_F2E_STRICT` 之类门控** | 撞 `check-tui-gates.js` 门控预算棘轮（实测 236 > limit 227，**只降不升**）。回滚用 revert 承担，不用门控 |
| **新增规则 ID（如 `TOOLING-0XX`）** | 登记表已 **95/95 满**（实测 `RULES-REGISTRY.json` `ruleCount=95`）。本提案是**既有规则的守卫修判据**，语义不变，不需要新 ID |
| **把 A3 的悬空通道判 error** | `[DESIGN-ARCH-060]` §四有先例：`cli/pty.js` 完整实现却**刻意不接线**，是登记在案的设计选择。悬空 ≠ 缺陷 |
| **只在文档里写"实测 0 孤儿"，不改正则** | 下一个人跑同一条命令还是看到 25 项报红，然后来问我"这 25 个怎么没修" |

---

## 7. 验收方式（可复现命令 + 关联门禁）

```bash
# ① 主判据：A1 落地后 DESKTOP gap 为 0，matched 为 131
node scripts/ci/check-f2e-wiring.js
#   期望：DESKTOP (IPC + endpoint source): OK  (131 items)  /  exit 0
#   实测（2026-10-01 A1 落地后）：OK (131 items)，exit 0

# ② 回归护栏：WEB / TUI 数字不变
node scripts/ci/check-f2e-wiring.js --verbose | grep -E "matched \("
#   实测：matched (51) / matched (1103) / matched (131)

# ③ 旁证：25 个通道的实现确实存在
grep -c "ipc.handle(" apps/khyos-desktop/src/main/keyManager/ipc.ts
#   实测：25

# ④ 运行态验证（不依赖任何静态正则）
cd apps/khyos-desktop && node --experimental-strip-types --test tests/wiringRuntime.test.mjs
#   实测：7/7 pass（含 7 个只读通道真调用返回 {ok:true,data}）

# ⑤ 治理侧：豁免表处置后的自洽性
node scripts/ci/check-wiring.js
#   实测（未处置豁免时）：通过，99 检查器 / 豁免 11 项

# ⑥ 完整桌面端测试套件（已接入 package.json test 脚本）
cd apps/khyos-desktop && npm test
#   实测：85/85 pass（51 + 34）
```

**判据成立的定义（本提案的验收红线）**：

- `DESKTOP gap == 0` **且** §1.2 的五个 file:line 均仍存在（即**没有**为了"报绿"去删实现）
- 反向断言：把 `keyManager/ipc.ts` 里任一条 `ipc.handle(…)` 临时改名 → 重跑应**报出 1 个 error**（证明守卫**真的在看**，而非恒绿）

### 7.1 反向断言实测结果（2026-10-01，已跑）

**静态侧**（探针副本上，把 `keyManager/ipc.ts:51` 的 `ipc.handle('keys:list',` 改为 `keys:list_RENAMED`）：

```
DESKTOP (IPC + endpoint source): 1 gap(s)  (131 items)
✗ [ipc-orphan-invoke] .invoke(keys:list) has no handle(keys:list)   [preload/index.ts:176]
exit=1
```

**运行态侧**（同一变异下跑 `wiringRuntime.test.mjs`）：**3 个测试红**，精确指出缺失通道。

**A1 落地后再次复验**（改 `proxy:status`）：精确报 1 gap，且该通道同时出现在 advisory（它成了悬空）——error 与 advisory 两个出口同时工作。

⇒ §10 反例清单最后一行（"反向断言仍报绿 ⇒ 修法无效"）**已被排除**。

**还原确认**：`grep -c "ipc.handle(" keyManager/ipc.ts → 25`；原检查器重跑 `DESKTOP: OK`；所有探针/备份均已删除；工作区无残留。

### 7.2 按钮响应契约测试（新增，已接入 test 脚本）

`apps/khyos-desktop/tests/wiringRuntime.test.mjs` 后两条断言覆盖「按钮有没有反应」：

| 断言 | 判据 | 反向断言敏感度（实测） |
|---|---|---|
| 每个 `api.xxx()` 调用点的返回值被消费 | **结构判据**：调用点须绑定到变量或走 `.then/.catch`，否则即"点了拿不到结果" | 「加裸 await」→ 红 ✅ |
| 存在失败回流 + 成功反馈出口 | 否定判定（`if (!X.ok)`）后须有 return/提示；页面须有成功出口 | 「否定判定改 if(true)」→ 红 ✅；「移除成功反馈」→ 红 ✅ |

**职责边界（实测确定，避免造弱断言）**：

- 本测试管 —— **接线缺失**（调了不接返回值 / 无失败回流 / 无成功反馈出口）
- `tsc` 管 —— **符号不存在**（如 `setMsg` 误写成 `setMsgXXX`，`tsc` 报 `TS2552 Cannot find name`，已实测）

⇒ 因此**刻意不写**「页面里必须出现 `setMsg({kind:'err'})` 字面量」这类文案断言：实测表明文案断言抓不住结构变异、又会因无关改名误红（[DESIGN-ARCH-156] §5「低精度守卫比没有守卫更糟」）。


> 最后这条**反向断言**是本提案的核心判据：它把"守卫绿了"与"守卫在工作"区分开，直接对应 P5。

---

## 8. 待核实项（实施前须核，不代裁决）

1. **★ `ipcMain.handle` 之外还有哪些注册形态**：本次已确认 `ipc.handle`（25 处，唯一文件）。A2 的动态注册处理是否必要，取决于全仓是否真有 `ipc.handle(varName)` 形态。实施前：
   ```bash
   grep -rnE "\.handle\(\s*[A-Za-z_$]" apps/khyos-desktop/src/ electron/
   ```
   有命中 ⇒ A2 必须做；零命中 ⇒ A2 可省（保留为 warning 的**未来**防线）。
   **2026-10-01 初测**：`grep -rnE "(^|[^a-zA-Z])ipc\.handle\(" apps/khyos-desktop/src/` 的 25 处**全部是字符串字面量**（如 `ipc.handle('keys:list', …)`），**未发现变量形态**。⇒ **A2 定性为"未来防线"**，非本次必需；但保留它，因为 A1 放宽正则后**新写法仍可能绕过**（如 `ipc.handle(CH)`）。

2. **`host:status` 的处置**：A3 报出后，是接前端（谁用？）、还是删（§1.4 判为死代码级）？**需人裁决**——本提案只让守卫**看见**它。

3. **豁免走选项 ①/②/③ 哪个**（§5-A5）：涉及"该检查器是否进门链"，是治理决策，**不代拍板**。

4. **`check-wiring.js` 对新增 `package.json` 别名的识别**：选项①需加 `check:f2e-wiring` 别名，实施前核 `check-wiring.js:33` 的 `ALIAS_PATTERN`（`/^check:|^gate:|^conform:|^quality:/`）——`check:` 前缀已被覆盖，**预期无需改**，实施时以实跑为准。

5. **CI 是否真有"浏览器环境"依赖**：§1.6 已实证本检查器无此依赖，但 `check-f2e-spec.js`（豁免表 `:10-14`，与本件成对）**未核**。若它也误报，属同族问题、另案。

---

## 9. 实施分期（每期独立可回滚）

### P1（已落地，2026-10-01）

| 步骤 | 文件 | 改动 | 状态 |
|---|---|---|---|
| 1 | `scripts/ci/check-f2e-wiring.js` | A1 正则放宽为任意标识符 | ✅ 已落地 |
| 2 | `scripts/ci/check-f2e-wiring.js` | A2 动态注册存在时降级 warning | ✅ 已落地 |
| 3 | `scripts/ci/check-f2e-wiring.js` | A3 悬空能力 advisory 打印 | ✅ 已落地 |
| 4 | 反向断言核验 | 改名 handler 验证守卫在看 | ✅ 已跑（§7.1） |
| 5 | `apps/khyos-desktop/tests/wiringRuntime.test.mjs` | **新增**：运行态注册 + 真调用 + 按钮响应契约 | ✅ 已落地 |
| 6 | `apps/khyos-desktop/package.json` | 新测试接入 `test` 脚本 | ✅ 已落地 |

**P1 结果**：`DESKTOP gap 0`，`matched 131`，退出码 `0`；桌面端测试套件 85/85 全绿。

**回滚**：步骤 1-3 在同一文件内，`git checkout` 该文件即回到 25 假阳性状态；步骤 5-6 可独立 revert，不影响检查器。

### P2（治理接线，**待你裁决**）

- §5-A5 三选项择一（建议 ①）。
- 若选 ①：`package.json` 加 `check:f2e-wiring` 别名 + 并入 `check:structure`；再从豁免表删条目。

> **实施注意（2026-10-01 实测）**：`package.json` 曾被并行会话/进程占用（`EBUSY: resource device or busy`），
> 探针写入失败。`package.json` 是**高频并发写点**，改动前应确认无其他会话在写，且改完立即核
> `git diff -- package.json` 只含自己的改动（本次该文件已有 9 行并行会话改动：`check:cycle-deps`、
> `check:no-emoji:*`、`check:tui-cadence`、`check:roots-isomorphic`——**都不是本提案的**）。

### 不在本提案

- `[DESIGN-ARCH-170]` 病灶 1/2/3 的具体接线（170 管辖）。
- `Composer.tsx:142` 分类统计的**后端能力实现**（需先有后端分类统计，属独立能力件）。
- `check-f2e-spec.js`（§8-5，同族，另案）。

---

## 10. 反例清单（用来证伪本提案）

| 若观察到 | 说明本提案哪里错了 | 实测状态 |
|---|---|---|
| 改 A1 后 gap 仍 > 0 | 说明还有第三种注册形态；§8-1 的正则须再扩 | ✅ 未发生（gap=0） |
| 改 A1 后 WEB/TUI matched 变化 | A1 误伤其他方向 | ✅ 未发生（51/1103 不变） |
| 25 个通道里有任一条 `invoke` 在 renderer **确实无调用方** | §1.2 的"贯通"判决有误 | ✅ 未发生（KeyManagerPage 密集调用） |
| `keyManager/ipc.ts` 的 handler 在运行时**未注册** | §1.2 ③ 的注册时机判断有误 | ✅ 未发生（运行态实测 25/25） |
| 反向断言（改名 handler）**仍报绿** | 守卫恒绿，A1 修法无效 | ✅ 未发生（精确报 1 项） |
| 按钮调了 API 却不消费返回值 | §1.10 的"有反馈"判决有误 | ✅ 未发生（结构判据全过） |

**六条反例全部实测排除。**

---

## 11. 复现命令（一键自证）

> 下列 ①②③⑤ 的命令**改前**的观察值写在行末；④ 与 ⑥ 是**改后**应有的结果。

```bash
cd /d/Portable/khy-os

# ① 主判据（A1 落地后）：应为 OK (131 items)，exit 0
node scripts/ci/check-f2e-wiring.js | tail -6

# ② 证明 25 个 handler 都在（一行命令）
grep -c "ipc.handle(" apps/khyos-desktop/src/main/keyManager/ipc.ts     # → 25

# ③ 证明"正则收窄"曾是主因（25 = 25）
grep -rn "ipcMain\.handle(" apps/khyos-desktop/src/ | wc -l              # → 71
grep -rnE "(^|[^a-zA-Z])ipc\.handle\(" apps/khyos-desktop/src/ | wc -l   # → 25

# ④ 运行态：25 个通道真的注册 + 真调用返回数据
cd apps/khyos-desktop && node --experimental-strip-types --test tests/wiringRuntime.test.mjs
#   → # pass 7 / # fail 0

# ⑤ 证明它曾被豁免、且豁免理由与事实不符（纯静态扫描却称"缺浏览器环境"）
grep -A3 "check-f2e-wiring" scripts/ci/wiring-exemptions.json

# ⑥ 反向断言：打断一条 handler，守卫必须报红（证明它在工作，不是恒绿）
#   将 ipc.ts 任一 ipc.handle('X', …) 临时改名 → 重跑 ① 应报 1 gap；改回即复绿
```

---

## 12. 一句话给未来的维护者

> 如果你（或某个更早的版本）看到 `check-f2e-wiring.js` 报 25 个 `[ipc-orphan-invoke]`，
> **不要**去补 handler —— 它们在 `keyManager/ipc.ts:51-181`，一个都不缺。
> 先跑 §11 的 ②③④：25 个通道全部注册、全部能真调用返回数据。
> **那 25 个是守卫自己的故障，不是后端的故障。**
>
> 教训（已写进 §4 公理 P5）：守卫的**误报与漏报同等昂贵**。
> 更贵的是——它因误报被豁免后，没人再跑它，于是误报变成了"事实"。

---

## 13. 变更日志

- 2026-10-01 v1：初稿。25 假阳性根因定位（§1.3，正则收窄）；四层贯通五证据（§1.2）；漏报面实证（§1.5）；豁免理由与事实不符（§1.6）；修法 A1–A5；新增公理 P5（守卫诚实性）；反向断言判据（§7）。
- 2026-10-01 v1.1：**补入实跑证据**。A1 探针副本实测（gap 25→0、matched 106→131、WEB/TUI 零误伤、退出码 1→0）；反向断言实测；§8-1 动态注册形态初测结论。全部锚点 7 处已逐字复核。
- 2026-10-01 v2：**P1 正式落地**（§1.8 / §1.9 / §1.10 / §9）。
  - `scripts/ci/check-f2e-wiring.js`：A1 正则放宽 + A2 动态注册降级 warning + A3 悬空能力 advisory，三改落地；实测 `OK (131 items)`、exit 0。
  - **新增** `apps/khyos-desktop/tests/wiringRuntime.test.mjs`（7 条）：运行态真注册（25/25）、无重复、handler 类型、**7 个只读通道真调用返回 `{ok:true,data}`**、每个 `api.xxx()` 调用点消费返回值（结构判据）、失败回流 + 成功反馈出口。
  - `apps/khyos-desktop/package.json`：新测试接入 `test` 脚本；桌面端套件 **85/85 全绿**。
  - **按钮响应验证结论**：`KeyManagerPage.tsx` 全部 9 类交互均消费返回值、错误有明确出口、成功有可观测反馈 —— 无"点了没反应"的装饰按钮。
  - **反向断言矩阵**：结构判据对「加裸 await」「否定判定改 if(true)」「移除成功反馈」三类变异全部报红；「移除 `setMsg` 文案」类变异由 `tsc`（TS2552）兜底，故刻意不用脆弱的文案断言（§7.2 职责边界）。
  - **待你裁决**：§5-A5 豁免三选项；`host:status` 悬空能力处置（§8-2）。
  - **未做（有意）**：`package.json` 的 `check:f2e-wiring` 别名（P2，需裁决）。实测该文件是高频并发写点（探针写入遇 EBUSY），且当时已有 9 行并行会话改动。
