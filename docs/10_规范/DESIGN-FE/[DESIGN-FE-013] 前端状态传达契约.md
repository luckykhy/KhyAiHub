<!-- IMPL-STATUS: todo -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：7 条路径可解析，但文中未自述已实现；保守标 todo 待人工复核。
# [DESIGN-FE-013] 前端状态传达契约

> **定位**：本文是前端「界面上的每一句话必须对外说对」的单一真源。它不重新发明 AGENTS.md 工程规则 2（`RUNTIME-002`），而是把那六条规则在**浏览器 UI 上**落成可执行口径，并把规则 2 此前在 `.vue` 模板上的覆盖缺口堵上。
>
> **本文与既有规范的关系**：
> - 规则本身（状态透明、动作+目标+进度）仍是 `AGENTS.md` 工程规则 2 与 2.1–2.6 的正文。本文不降低它，只规定**前端怎么落地**。
> - 视觉侧（令牌、色值、对比度、间距、动效）见 `[DESIGN-FE-001]` / `[DESIGN-FE-004]` / `[DESIGN-FE-012]`；本文只在 §5 规定「状态色与前景色不得取错令牌」，因为它直接影响「这条状态看不看得见」。
> - 组件 API 形态见 `[DESIGN-FE-002]`；测试形态见 `[DESIGN-FE-009]`。
>
> **写法约定**：本文每条规则都带 `路径:行号` 的落点。**凡本文与代码现状冲突，以代码为准并登记进 §7 缺口表**——缺口只降不升。
>
> **本轮实测状态（阅读本文前请先看这一段）**：本文的静态检查结论由本轮实跑得出（命令与输出见 §6）；
> **所有 vitest 断言本轮均未跑通**（pnpm store 残缺，`npm run test:frontend` 无法原样执行），
> 凡涉及测试是否转红的判断一律标注「读断言源码得出，未跑」。

---

## 1. 前端在替谁传达什么

界面是人与机器之间唯一那条通道。机器侧有五类事实，前端每一刻都在替它说话：

| 事实 | 用户需要知道 | 现状失败形态（本文要治的） |
|------|-------------|--------------------------|
| **机器状态** | 我在做什么、对什么、走到哪 | 枚举词上屏：`思考中` / `聆听中` / `启动中` |
| **进度** | 已经等多久、还剩多少、死了没有 | 静态句子覆盖整个 turn；顶条只在 axios 请求时出现 |
| **错误** | 什么失败、为什么、我能做什么 | `catch {}` 吞掉 → 用「暂无…」空态断言机器事实 |
| **结果确定性** | 这件事到底成没成 | `success !== false` → 未标注即绿勾「完成」 |
| **意图** | 界面此刻在做什么动作、落点在哪 | 失败提示写「刷新本页」但页面上没有刷新按钮 |

**一句话**：前端不是把机器状态「显示出来」，而是**对用户的判断负责**。显示一个枚举值不需要负责，宣称「暂无模型」需要。

---

## 2. 为什么现在传达不到位（四条根因，不是泛泛而谈）

### 2.1 失败被降级成了空态 —— 事实断言被换成了空断言

仓内已有一个正确抽象 `src/api/loadError.js`（`useLoadError` / `describeLoadError` / `loadInto`），
但它只被 **5 个消费点**使用：

```
$ grep -rln "useLoadError\|LoadErrorBanner\|loadInto" src
src/api/loadError.js
src/api/loadError.test.js                                  # 测试
src/components/LoadErrorBanner.vue
src/components/__tests__/componentContract.wiring.test.js   # 测试
src/composables/useGatewayBilling.js
src/composables/useProxies.egress.wiring.test.js             # 测试
src/composables/useProxies.js
src/views/admin/Pricing.vue
src/views/admin/UsageLogs.vue
src/views/ProxyManagement.vue
```

10 个命中里 3 个是测试文件，**实际消费点 5 个**（`useGatewayBilling` / `useProxies` / `Pricing` / `UsageLogs` / `ProxyManagement`）。
其余列表读取全部是「catch 里写成空集合」：

- `src/views/AIChat.vue:2120-2122` 的 `} catch { /* no models available */ }` → 模板 `:831-837` 渲染 `暂无可用模型：确认对应适配器已本地安装并登录`
- `src/composables/useGateway.js:127-137 / :334-337 / :390-397` 三处 `catch { … = [] }` → `AIGateway.vue:603-609` / `:703-713` 渲染「还没有可用模型 / 先接入供应商 Key」
- `src/views/Marketplace.vue:307-311`（`reload()` 无 catch）→ `:36-41` 渲染「插件市场还空着」
- `src/views/admin/AIDashboard.vue:394-401` 的 `Promise.allSettled` → `:62` 渲染「健康广播器尚未就绪」、`:319-336` 待办计数折成 `0`

**后果**：后端 500 / 401 / 网络失败时，界面用一句**确定的**话描述**不确定**的机器事实，并把用户导向一个无用动作（去装适配器、去接 Key、去导入规范）。

### 2.2 等待没有终点 —— 长等待链路恰恰是「没有进度信号」的那几条

`src/composables/useGlobalLoading.js:11-14` 只合并两个信号（`httpPending` 计数器 + `routeLoading` 布尔），
而 `httpStart/httpDone` 的调用方**只有** `src/api/request.js`（`:4` import，`:82/:91/:98/:114/:134` 全部在 axios 拦截器内）。

于是**等待最久的三条链路全绕过计数器**：附件上传（`AIChat.vue:1839` 走 `authedFetch`）、
流式生成（`AIChat.vue:3422` 走 `authedFetch` + `stream: true`）、
终端 WebSocket（`src/views/KhyOsTerminal.vue:129` 裸 `new WebSocket`）。
`GlobalProgressBar.vue` 在这些时刻根本不出现。

更严重的是流式生成**自身也没有看门狗**：`AIChat.vue:3445-3446` 的 `while (!streamDone) { const chunk = await reader.read(); … }`
没有任何超时分支，`authedFetch.js:74` 对 `stream: true` 把内部超时置 0。
同文件 `:2373` 的 WS 路径**有** 60s 空闲看门狗（`VITE_AI_WS_IDLE_TIMEOUT_MS`）——同一页两条链路，一条有、一条没有。

而状态标签 `AIChat.vue:3939-3943` 是一句编译期常量：

```js
const loadingStatusText = computed(() =>
  transportMode.value === 'ws'
    ? 'AI 输出通道已建立（WebSocket），正在接收增量内容'
    : 'AI 输出通道已建立（HTTP 流式），正在接收增量内容'
);
```

它会在流已死的情况下**永远说下去**，且说的与事实相反。

### 2.3 终态没有收口 —— 「未完成」和「已完成」在数据层不可区分

`AIChat.vue:2543` 把工具步骤置为 `status: 'running'`，`:2561-2572` 只在**收到配对 `tool_result`** 时改终态。
`runAssistantTurn` 的 `finally`（`:3617-3626`）不做任何 running→终态收口，历史恢复 `:2751` 的 `steps: m.steps || []` 也原样带回。

**orphan 清理在全仓不存在**——非测试文件里 `'running'` 的命中共 6 处：
`AIChat.vue:501`（模板 `v-if="step.status === 'running'"`）、
`AIChat.vue:2543`（置 running）、
`AIChat.vue:2561`（配对判定 `if (s.status !== 'running') continue;`）、
`aiChatEventUtils.js:243`（注释）、
`aiChatEventUtils.js:258`（进度统计）、
`useDaemonHealth.js:60`（daemon 状态字面量，与本条无关）。
六处里**没有一处是收口**。

叠加 `aiChatEventUtils.js:163` / `AIChat.vue:2554` 的判据 `payload?.success !== false`
（详见 §3.3 R-1：**这个判据在前端其实是空转的，真正的兜底在后端**）。

### 2.4 守卫在关键位置覆盖不足或根本没有断言

本轮实跑（完整命令与输出见 §6）：

```
$ node scripts/ci/check-agent-rules.js delivery/web/ai-frontend/src
Summary: 0 error(s), 2 warning(s) across 198 file(s) scanned.
```

198 个前端文件、0 error。**病因要说准**——不是「`.vue` 模板不在扫描面上」：

| 现象 | 真相 |
|------|------|
| `CODE_EXTS` 含 `.vue`，脚本读全文 | `.vue` **是**被扫的 |
| `<span>处理中…</span>` 不报 | **纯文本节点不在判定面上**——`STATUS_CONTEXT_HINTS`（`:169-178`）要求同一行出现 `console.log` / `status:` / `label=` 等上下文 |
| `<el-option label="处理中" />` **会报** | `label=` 命中 `STATUS_CONTEXT_HINTS` 第 7 条正则 `/(?:^|[({,\s])(?:status\|message\|text\|detail\|label\|title\|subtitle)\s*[:=]/i`（`:176`） |
| 本轮实跑的两条 warning | `useWxBinding.js:264`（`status: 'connecting'`）与 `KhyOsDesktop.vue:40`（模板 `v-if="connecting || …"`）——**后者本身就是模板行** |

所以真实缺口是两条，且**必须按顺序修**（见 §6.1）：

1. **词表只覆盖 6 个 token**（`scripts/ci/check-agent-rules.js:146-153`）：
   `正在工作 / 处理中 / 尝试连接 / loading / processing / connecting`。
   AGENTS.md 规则 2 正文列的「加载中」「请稍候」等**不在表内**。
2. **纯文本节点不在判定面上**。放宽 `STATUS_CONTEXT_HINTS` 会扩大覆盖，
   **但守卫里没有实现 AGENTS.md 规则 2 的枚举/i18n 例外豁免**——判定块 `:586-603` 的逃逸口只有
   `hasStatusDetail`（进度信号）与 `isLikelyUserFacingStatusLine`（上下文提示）两个。
   不先补豁免就放宽上下文，`§4` 边界 1 承诺的「枚举标签不算违规」会立刻破约。
3. **vitest 侧**：本轮实跑确认
   `src/__tests__/a11yContract.test.js:150-170` 的「表单输入元素应有 label 关联或 aria-label」
   整个 `it` 体只有 `console.warn`，**没有任何 `expect`**——永远通过。
   `src/__tests__/designTokenCompliance.test.js:140` `const BASELINE = 999;`。
   **本轮未跑通任何 vitest 断言**（见文首），这两个数字只有读断言源码可得。

---

## 3. 传达口径（照着做即可）

### 3.1 等待态：目标 + 已等待 + 可中断

任何用户会盯着看的等待，界面上必须同时存在三个量：

| 量 | 形态 | 反例 → 正例 |
|----|------|------------|
| **目标** | 具体到对象/动作，不是类目词 | `思考中…` → `分析：定位 AIChat.vue:3445 的读循环` |
| **已等待** | 秒数，活的，随时间自增 | `正在接收增量内容` → `已等待 12s · 最后事件 14:03:11` |
| **可中断** | 有超时且超时后有出路 | 无超时、无重试按钮 |

**规则 W-1（流式读取必须有空闲看门狗）**

任何 `reader.read()` / `onmessage` 循环必须有一个**按入站数据重置**的空闲计时器（AGENTS.md 规则 3 的前端形态）：

```js
// ✗ Wrong — 无界等待，流死了也永远转
while (!streamDone) {
  const chunk = await reader.read();
  streamDone = chunk.done;
  if (streamDone) break;
  handle(chunk);
}
```

```js
// ✓ Correct — 每收到一个字节重装，超时后如实说明
const IDLE_LIMIT_MS = 60_000;   // 与 WS 侧 AIChat.vue:2373 同口径，来源须走 env
let lastActivity = Date.now();
let lastEventLabel = '(尚未收到事件)';
let idleTimer = setTimeout(onIdle, IDLE_LIMIT_MS);

function onIdle() {
  const waited = Math.round((Date.now() - lastActivity) / 1000);
  clearTimeout(idleTimer);
  // 注意：此处是 throw 不是 reject —— 该循环嵌在 runAssistantTurn 的
  // 重试结构里（AIChat.vue:3475 `if (attempt < SSE_MAX_RETRIES) continue;`），
  // 不是独立 Promise 边界，没有可调用的 reject。
  throw new Error(
    `已 ${waited}s 未收到任何数据（最后事件：${lastEventLabel}），读取已中断，可点「重试」`,
  );
}

while (!streamDone) {
  const chunk = await reader.read();   // 读之前已装计时器；取消路径必须 clearTimeout
  clearTimeout(idleTimer);
  lastActivity = Date.now();
  if (chunk.done) { streamDone = true; break; }
  const events = parseEvents(chunk);
  if (events.length) lastEventLabel = events[events.length - 1].type;
  for (const e of events) handle(e);
  idleTimer = setTimeout(onIdle, IDLE_LIMIT_MS);
}
```

**W-1 与 R-2 的耦合（不可分开实施）**：循环内 `handleStreamEvent`（`AIChat.vue:3458`）会把 `running` 步骤
写进 `assistantMessage.steps`。中途 `throw` 后外层 `finally`（`:3617-3626`）已把 `loading.value = false`，
**orphan running 步骤就永远留在界面上**。
因此：**W-1 的任何 throw 路径必须保证 R-2 的 `settleOrphanSteps` 已在其上游可达**
（同一 `finally`，或 `catch` 里先收口再抛）。只做 W-1 不做 R-2，会把「永久转圈」从数据问题变成必然结果。

计时器阈值从 env 读（`readTimeoutEnv('VITE_AI_STREAM_IDLE_TIMEOUT_MS', 60000)`），不得字面量写死——
这是 `RUNTIME-001` 的前端延伸。

**规则 W-2（等待文案必须带已等待秒数）**

状态文案不得是编译期常量。至少这样写：

```vue
<!-- ✗ Wrong：一句会永远说下去的话 -->
<span>{{ loadingStatusText }}</span>

<!-- ✓ Right：目标 + 计时 + 最后事件 -->
<span>
  {{ transportLabel }} · 已等待 {{ waitSeconds }}s · 最后事件 {{ lastEventAt }}
</span>
```

**规则 W-3（重试耗尽必须有终态）**

任何「自动重连 N 次」的逻辑耗尽后，状态**不得**继续描述那个已经停止的动作，并须给出人工出路：

```js
// ✗ Wrong
if (attempts < MAX) setTimeout(retry, delay);   // 超限后静默放弃，UI 仍说「正在尝试」
```

```js
// ✓ Correct
if (attempts < MAX) {
  setTimeout(retry, delay);
} else {
  state.value = 'failed';   // 终态：文案改为「已停止自动重试，请点此重试」
}
```

适用范围至少含：
- `src/composables/useDaemonHealth.js`：`MAX_RESTART_ATTEMPTS = 3` 定义在 `:21`，耗尽判断在 `:54`
  （`if (reconnectAttempts.value >= MAX_RESTART_ATTEMPTS) return;`），
  之后只置 `connectionStatus = 'disconnected'`，无「已放弃」态。
- `src/composables/useAIMonitor.js`：`MAX_RECONNECT_ATTEMPTS = 10` 定义在 `:15`，耗尽分支在 `:74-78`，
  静默放弃且 `reconnectAttempts` 从不上屏。

**规则 W-4（连接关闭必须收口，不许只在「就绪」态改写）**

```js
// ✗ Wrong — 只覆盖 ready，启动中断时状态永远停在「启动中」
ws.onclose = () => {
  if (!manualClose && status.value === 'ready') status.value = 'exited';
};
```

```js
// ✓ Right — 任何非人工关闭都要落到终局，并在终端里留一行
ws.onclose = () => {
  if (manualClose) return;
  connecting.value = false;
  authed = false;
  const wasBooting = status.value === 'booting';
  status.value = wasBooting ? 'error' : 'exited';
  writeLine(wasBooting
    ? '启动中断：连接在内核就绪前断开，查看启动日志后点「重新连接」'
    : '连接已断开。点击「重新连接」继续。');
};
```

同时：`status !== 'ready'` 时用户键入被丢弃（`KhyOsTerminal.vue:273`），必须给出提示，不得静默吞掉按键。

### 3.2 空态：失败不可被空态代偿

**规则 E-1（列表读取失败必须落到 loadError，禁止 catch 成空集合）**

仓内已有正确抽象，**不许再造第二个**。新增或修改任何列表读取，一律走：

```js
// ✗ Wrong — 把失败写成「机器上什么都没有」
async function fetchCatalog() {
  try { catalogEdges.value = await request.get('/api/gateway/edges'); }
  catch { catalogEdges.value = []; }
}

// ✓ Right — 失败被记录，成功被清空，视图据此分流
const loadError = useLoadError();
async function fetchCatalog() {
  await loadInto('网关拓扑', loadError, async () => {
    catalogEdges.value = await request.get('/api/gateway/edges');
  });
}
```

**规则 E-2（空态与失败态在模板里互斥，失败优先；加载遮罩期间不得渲染空态）**

```vue
<!-- ✗ Wrong — 失败与空态同形；且加载遮罩期间空态已经渲染出来，与 v-loading 并存 -->
<KhyEmpty v-if="!modelGroups.length" title="暂无可用模型" description="确认适配器已本地安装并登录" />
```

```vue
<!-- ✓ Right — 三态分流：失败 / 加载中 / 真空 -->
<!-- 注意条件要覆盖全部 v-loading 的信号：AIChat.vue:830 是
     v-loading="modelsLoading || overridesBusy"，漏掉 overridesBusy
     会让遮罩期间空态闪回来，正是本规则要治的病。 -->
<LoadErrorBanner v-if="loadError" :message="loadError">
  <template #action><el-button size="small" @click="loadModels">重试</el-button></template>
</LoadErrorBanner>
<KhyEmpty
  v-else-if="!modelsLoading && !overridesBusy && !modelGroups.length"
  title="暂无可用模型"
  description="确认对应适配器已本地安装并登录，模型会自动出现在这里。"
/>
```

`LoadErrorBanner.vue:2-8` 当前只有 `:title`，**没有 `#action` 插槽**——按本规则需要补一个可选 `action` 插槽承载重试按钮。

**规则 E-3（计数不得由失败折成 0）**

待办数、健康分、调用数这类**计数**在请求失败时显示 `—`，不显示 `0`。「0」是一个关于机器的断言，失败时你没有资格断言。

```js
// ✗ Wrong
const pendingTotal = pendingUserCount + pendingPaymentCount + expiredKeyCount;   // 失败时全是 0
```

```js
// ✓ Right — 每个来源带自己的失败标记
const pendingTotal = computed(() =>
  sources.some((s) => s.failed) ? null : sources.reduce((a, s) => a + s.count, 0),
);
```

模板：`{{ pendingTotal === null ? '—' : pendingTotal }}`，且 `null` 时整块挂一条告警说明「后端未响应，计数不可得」。

**规则 E-4（用户可见行为的变更须被登记）**

E-2 会让 AIChat 的模型面板在失败时**从「暂无可用模型」变红条**（`AIChat.vue:831-837`）。
这是修正，但它是**用户可见的行为变更**，须登记进 §7 缺口表以便截图与说明同步。

### 3.3 结果：完成 / 失败 / 未知 必须三态

**规则 R-1（`success` 缺失即未知 —— 但落点在后端，前端单改无效）**

**本规则是本文唯一一条「不改后端就等于没做」的规则。** 事实：

```js
// runtime/node/backend/src/bridge/aiChatConsumer.js:133-141
} else if (t === 'tool_result') {
  const success =
    typeof chunk.success === 'boolean'
      ? chunk.success
      : typeof chunk.isError === 'boolean'
        ? !chunk.isError
        : typeof chunk.is_error === 'boolean'
          ? !chunk.is_error
          : true;                       // ← 三个字段都缺时兜底成 true
  broadcast({ type: 'chunk_tool_result', …, success, … });
```

后端已经把「缺失」补成了 `true`。因此 WS/SSE 桥接路径上，
前端无论怎么写 `settleStatus`，收到的 `success` 永远是 `true`，`unknown` 分支**永不进入**。

**而另一条通道口径相反**：

```js
// runtime/node/backend/src/cli/aiRequestParsers.js:403-415
let normalizedSuccess;
if (typeof chunk.success === 'boolean')      normalizedSuccess = chunk.success;
else if (typeof chunk.isError === 'boolean')  normalizedSuccess = !chunk.isError;
else if (typeof chunk.is_error === 'boolean') normalizedSuccess = !chunk.is_error;
if (typeof normalizedSuccess === 'boolean') {       // ← undefined 时整个字段被省略
  normalizedChunk = { ...normalizedChunk, success: normalizedSuccess };
}
```

这不是「跨通道可能碰巧缺字段」的假设，而是**仓内两个具体函数的现存分歧**。

**正确落点（前后端联动）**：

1. **后端**：`aiChatConsumer.js:140` 的 `: true` 改为「三个字段都缺时**不广播 `success` 字段**」，
   与 `aiRequestParsers.js` 的 `undefined → 省略` 对齐。
2. **前端**：

```js
// ✗ Wrong — 后端已兜底成 true，本分支永不进入
const ok = payload?.success !== false;
```

```js
// ✓ Right — 必须在后端 (1) 落地之后才有效
function settleStatus(payload) {
  if (payload?.success === true)  return 'ok';       // 完成 ✓
  if (payload?.success === false) return 'error';   // 失败 ✗
  return 'unknown';                                  // 字段缺失
}
```

**顺序不可颠倒**：先改后端再改前端。若同时改，所有不带该字段的适配器步骤会**集体翻成灰色「结果未返回」**——
这是全聊天页的用户可见大退步。须按 §7 G-18 记录的顺序分两次提交，中间保持 `settleStatus` 的 `unknown` 分支
先只打日志、不上 UI，灰度确认无大面积翻灰后再渲染。

**规则 R-2（`unknown` 文案必须满足规则 2.2 三维，且模板要显示出来）**

引入第三态就引入了一条新文案，它**必须**自己满足本文所引的规则 2.2，否则本文自相矛盾：

| 维度 | 要求 | 落实 |
|------|------|------|
| 问题 | 说清发生了什么 | `工具结果未返回` |
| 原因 | 说清为什么 | `原因：<s.note>`，如「可能因中断/超时」（由 R-3 的 `settleOrphanSteps` 写入） |
| 修复 | 给出用户能做的动作 | `重新生成，或查看运行日志` |

```js
// ✗ Wrong — 三维全缺，本文自己造了一条违规文案
{ status: 'unknown', label: '结果未返回' }
```

```vue
<!-- ✓ Right — 模板必须把 note 与动作渲染出来，note 缺失时降级为「原因未标注」 -->
<span class="step-step__status" data-tone="neutral">
  ? 结果未返回（原因：{{ step.note || '原因未标注' }}）· 重新生成
</span>
```

**规则 R-3（`running` 必须有 orphan 收口）**

进入 `running` 的步骤，只能由配对结果改终态，或由**兜底收口函数**改终态。
任何 turn 结束时都要跑一次（`runAssistantTurn` 的 `finally` 与历史载入处各一次）：

```js
function settleOrphanSteps(steps, reason) {
  for (const s of steps) {
    if (s.status !== 'running') continue;
    s.status = 'unknown';
    s.startedAt ??= Date.now() - (s.durationMs || 0);
    s.durationMs = Date.now() - s.startedAt;
    s.note = reason;   // 例如 '可能因中断/超时' —— R-2 的文案要读它
  }
}
```

每个步骤记 `startedAt` / `endedAt` 并渲染耗时——「转圈 4 分钟」和「转圈 4 秒」是两种完全不同的情况。

**规则 R-4（进度摘要不得出现会倒退的分数）**

`summarizeToolProgress`（`aiChatEventUtils.js:249-271`）当前用「已到达步骤数」当分母，
新步骤到达时分母变大，读数会倒退（`1/1 → 1/2 → 2/3`）。

```js
// ✗ Wrong — total 随到达增长，读数看起来在倒退（aiChatEventUtils.js:266）
const parts = [`工具 ${done}/${total}`];
```

```js
// ✓ Right — 已完成数 + 进行中数，不编造分母
const parts = [`已完成 ${done} 个`];
if (running > 0) parts.push(`${running} 个进行中`);
if (failed > 0) parts.push(`${failed} 个失败`);
```

只有当后端**明确给出计划步数**时才允许 `n/m`，否则禁止写分数。

**规则 R-4 的既有测试影响面（必读）**：

`src/views/aiChatEventUtils.toolEvents.test.js` 会对本规则的改动转红，两条断言：

| 位置 | 现断言 | R-4 落地后 |
|------|--------|-----------|
| `:229` | `assert.match(p.label, /工具 2\/3/);` | **必红** |
| `:238` | `assert.equal(p.label, '工具 2/2');` | **必红** |
| `:248` | `assert.match(p.label, /1 失败/)` | 仍绿 |
| `:249` | `assert.match(p.label, /1 进行中/)` | **必红**（`进行中` 改成 `个进行中`） |

该文件 `:5` `import { test } from 'vitest'` 却 `:6` `import assert from 'node:assert/strict'`，
**混了双 runner**——所以 `node --test` 跑不到它，只有 vitest 跑得到。
`AGENTS.md` 规则 8（`PROCESS-008`）管的是「新增拦截型机制的阶段」，**管不了「按本文做会打红既有测试」**。
落地 R-4 的同一个提交里必须同步改这三条断言。

### 3.4 错误文案：`{问题}：{原因}，{修复}`

**规则 X-1（三维缺一不可，且修复必须是用户能做的动作）**

```
✗  保存失败
✗  请重试或检查连接
✓  保存调度配置失败 (500)：后端返回内部错误，请稍后重试；若持续失败运行 khy doctor
```

`catch {}` **不接错误对象**等于把「原因」这一维直接丢掉：

```js
// ✗ Wrong — 三维全缺，连 err 都没接
try { await pool.updateScheduling(s); showSuccess('已保存'); }
catch { showError('保存失败'); }

// ✓ Right
try { await pool.updateScheduling(s); showSuccess('调度配置已保存'); }
catch (err) { showError(`保存调度配置失败：${describeFailure(err)}，请稍后重试`); }
```

存量至少 11 处须逐个改：`AccountPool.vue:547/:578`、`GuiEvalTasks.vue:206`、`WebFrontendEvalTasks.vue:207`、
`AIChat.vue:1419/:1435`、`Marketplace.vue:489`、`PromptLibrary.vue:380/:389/:403`、`ProxyManagement.vue:799`。

**规则 X-2（修复建议不得与原因矛盾，且必须有落点）**

`src/api/loadError.js:31` 把 `fix = '请稍后重试'` 作为**所有分支**的固定尾巴拼在句末，导致：

- 401 → 「登录已失效，请重新登录，**请稍后重试**」（自相矛盾）
- 403 → 「当前账号没有权限访问，**请稍后重试**」（把无权限用户指向一个永远无效的动作）

```js
// ✗ Wrong — 统一尾巴
export function describeLoadError(err, subject, fix = '请稍后重试') { … return `${subject}加载失败：${reason}，${fix}`; }
```

```js
// ✓ Right — fix 由状态码决定，且都指向页面上真实存在的动作
const FIX_BY_STATUS = {
  401: '点右上角头像退出后重新登录',
  403: '联系平台管理员开通该页面的权限',
  429: '稍后重试，或减少请求频率',
  // 404 不设条目：其修复动作与 401/403/429 不同类，走兜底
};
export function describeLoadError(err, subject, fix) {
  const s = statusOf(err);
  const tail = fix || FIX_BY_STATUS[s] || '请稍后重试';
  return `${subject}加载失败：${reason}，${tail}`;
}
```

**X-2 的既有测试影响面（必读）**：`src/api/loadError.test.js:29` 断言
`expect(msg).toContain('请稍后重试')`（404 分支）。当前 `FIX_BY_STATUS` 无 404 条目 → 落到兜底 → 仍绿，
**但这是运气不是设计**：实现者只要顺手给 404 补一条，`loadError.test.js:29` 立刻红。
规则：`FIX_BY_STATUS` 必须为 `describeLoadError` 的**每个已有分支保留可达路径**，
任何新增条目都要同步检查 `loadError.test.js`。

**规则 X-3（无权限文案必须面向人）——落点被镜像约束挡住，须另开覆盖表**

`classifyKhyError.mjs:13` 的 `PERMISSION_DENIED.hint` 是「该操作需要你显式授权，重新执行并选择允许」，
这是给 AI 智能体写的工具授权说明，**人无法执行「重新执行并选择允许」**。
而 `notify.js:136-142` 的 `_formatToast` 会把它原样拼进给人看的 toast：

```
[error] PERMISSION_DENIED · <axios 英文原文>（提示：该操作需要你显式授权，重新执行并选择允许）
```

**不能直接改 `classifyKhyError.mjs`**——该文件 `:1-4` 的头注释明文写着：

> `MIRRORS platform/packages/shared/src/errorEnvelope.js:STATUS_TABLE,… 与 apps/ai-mobile/src/utils/classifyKhyError.mjs 内容应保持一致；改动两边要同步。`

改 `PERMISSION_DENIED.hint` 会破镜像并牵动 mobile。正确落点：

1. 在 **前端另开一张面向人的覆盖表**（建议 `src/api/notify.js` 内一张 `USER_FACING_HINTS`），
   按 code 覆盖 hint，不动 `classifyKhyError.mjs`；
2. 4xx/5xx 的 `message` 用中文覆盖 axios 原文；
3. **注意回流**：`notify.js:149-159` 的 `deriveErrorMessage` 是 `loadError.js:33` 的下游，
   改 `_formatToast` 的 hint 会**回流进所有 loadError 文案**，影响 Pricing / UsageLogs / ProxyManagement
   三个已在用的视图。故覆盖表必须挂在 `deriveErrorMessage` 这一层（页面 toast 与 loadError 共用），
   并把这三个视图的文案变化登记进 §7。

**规则 X-4（错误页必须留下可上报的识别码）**

`src/router/index.js:602-610` 的 `router.onError((error, to) => { … router.replace('/500'); })`
（`:610` 是 `router.replace('/500')`）把 `error` 直接丢弃，
`src/views/ServerError.vue:5-8` 只留一句泛化描述并让用户去翻浏览器控制台。

路由层须把 `error.message` 与 `to.fullPath` 通过 router state 带到 `/500`，页面展示之（并提供「复制错误信息」）。
同理 `src/router/index.js:546` 的 403 拦截须把被拦路径带进 query 并回显——`Forbidden.vue` 全文无 `route` 引用，
「返回上一页」用 `router.back()` 会把用户弹回那个管理员页再被守卫弹回 403，每次点击还多压一条历史。

### 3.5 无入站活动的长传输：按体积自适应，不套用入站重置

**规则 U-1（无进度回传的上传必须按体积自适应超时，且失败文案不得是机器原文）**

`AIChat.vue:1839` 的上传走 `authedFetch` 默认 **固定墙钟 30s**（`authedFetch.js:19`
`DEFAULT_TIMEOUT = Number(import.meta.env.VITE_AI_HTTP_TIMEOUT_MS) || 30000`），
经 `authedFetch.js:17` 的 `import { createAuthHeaders, fetchWithTimeout } from '@khy/ui-shared'`
引入 `runtime/substrate/platform/packages/ui-shared/src/http/fetchWithTimeout.js:22-28`
（**注意：不在 `src/api/` 下，照错路径找会落空**）。
超时抛 `new DOMException('timeout', 'AbortError')`，被 `AIChat.vue:1877-1879` 原样取 `err.message` 展示——
用户看到的就是「timeout」三个字母。

固定墙钟本身就是 `AGENTS.md` 规则 3（`RUNTIME-003`）的违规形态：稍大的文件**必然**被中止，
且该计时器**没有字节活动重置机制**。

```js
// ✗ Wrong
catch (err) {
  const reason = err?.message || '网络错误';   // → 「timeout」
  showError(`「${file.name}」上传失败：${reason}`);
}
```

```js
// ✓ Right — 分类 + 体积 + 可执行的下一步
catch (err) {
  const kind = err?.name === 'AbortError' ? '超时' : '网络中断';
  showError(
    `「${file.name}」（${formatSize(file.size)}）上传失败：${kind}，`
    + (kind === '超时'
      ? '文件可能超过单次上传上限，请压缩后重试或改用链接引用'
      : '请检查后端服务是否在线后重试'),
  );
}
```

超时阈值按 `Content-Length` 自适应（例如 `max(30s, size / 256KB/s)`），而不是留一个固定的 30s。

上传的 chip 不得写「上传中（N）…」：`AIChat.vue:1832` 是**串行** `for (const file of files)`，
N 是并发计数，恒为 1，用户看不出还剩几个。改为「第 i/N 个 · name · 大小 / 已用 Xs」。

### 3.6 全局等待指示：先承认它不知道，再谈接线

**规则 P-1（先选 (b) 降级，(a) 接线是独立工程）**

`GlobalProgressBar.vue:21-25` 用 `role="progressbar"` + `:aria-valuenow="Math.round(width)"`
播报一个**与任何真实测量无关**的百分比——该文件 `:5-11` 的设计注释自己写明
「它并不知道任意请求的真实百分比」「不虚报完成、也不跳 100」「它的职责是『有活在干』，不是『精确报数』」。

**必须先认清 (b) 的边界**：(b) 只改 `role` 与 `aria-valuenow`（`:21-25`），**不动 `usePacedProgress`，
也不改视觉上的 1%/160ms 步进**。所以：

- ✅ (b) 能修的：不再向辅助技术播报一个假百分比。
- ❌ (b) **修不了**的：视力用户看到的仍是编造读数。
  §2.2 抱怨的「等待没有终点」一点没解决——**别把它当成 (b) 的功劳**。

**路径 (b)（本轮要求的最小可交付）**：
`role="progressbar"` → `role="status"`，删 `:aria-valuenow`，加
`aria-valuetext="正在等待后端响应"`，并在条旁以文字标明在等哪条链路。

**路径 (a)（接线，需独立排期，13 个接入点）**：

| 类型 | 位置（本轮 `grep -rn "new WebSocket\|EventSource\|fetch(" src/` 实测） |
|------|------|
| WebSocket ×7 | `KhyFloatBall.vue:462`、`:615`、`services/crossPlatform/shared/wsClientCore.js:190`、`views/admin/TrafficMonitor/index.vue:246`、`AIChat.vue:3230`、`KhyOsDesktop.vue:201`、`KhyOsTerminal.vue:129` |
| EventSource ×3 | `useAIMonitor.js:47`、`useConfigSync.js:219`、`useGateway.js:80` |
| 裸 fetch ×2 | `main.js:27`、`:128` |
| 另加 | `authedFetch` 的全部调用点（上传、流式、工作流 SSE…） |

**⚠ (a) 的硬约束**：`httpStart/httpDone` **必须成对**。
`request.js:104-108` 的注释明写这个计数器对不平衡极其敏感
（「both the original error's httpDone AND the retry's response httpDone fire,
leaving httpPending stuck at +1」）。
**漏配一处 → `GlobalProgressBar` 永久卡住不消，比原问题更严重。**
所以 (a) 不是「顺手包一层」，须配套：(i) 逐点列出 start/done 的对称位置；
(ii) 每个接入点加一条「计数器最终回到 0」的自检；(iii) 一次只接一条链路，接完验收再接下一条。

---

## 4. 三条边界（哪些不用改）

1. **枚举标签不算违规**。`AGENTS.md` 规则 2 例外条款仍然有效：`<option>` 内容、options 数组的 `label` 字段、
   i18n 翻译键、状态解析正则、数据库 ENUM 值——它们是**数据**，展示前还会被代码进一步处理。
   本文不扩大规则 2 的覆盖面。
   **⚠ 但这条边界当前在守卫里没有兑现**：`check-agent-rules.js:586-603` 的判定块没有枚举/i18n 豁免。
   §6.1 要求放宽扫描面**之前**必须先补这个豁免，否则 §4 边界 1 会破约。
2. **组件内部不套校验**。本文的所有规则都作用在**用户可见的呈现**与**系统边界**上，不要求给纯内部函数加状态文案。
3. **阶段治理的适用范围**。`AGENTS.md` 规则 8（`PROCESS-008`）六条红线管的是
   **「新增拦截型机制」不得直进 S3**。本文**新增**的检查（新对比度计算、`checkCrossEnd` 的 null 分流 info 化）
   一律从 S1 观察者起步、只记录不阻断。但 §6.1 对 `check-agent-rules.js` 词表与上下文的改动是
   **给既有机制扩面**、不是新机制，落在 `PROCESS-008` 六条红线之外——**它不需要重新走阶段**，
   但扩面后新命中的行仍应先按 warning 观察一段时间。

---

## 5. 视觉侧的两条硬约束（状态看不看得见）

### 5.1 前景色不得绑到背景令牌

`src/views/Markdown.vue:874-875`：

```css
:global(html.dark) .md-preview { --md-fg: var(--khy-md-bg); … }
```

`--khy-md-bg` 是**代码块背景**令牌（`newapi-theme.css:253` 暗色 `#161b22`），
而承载面是 `Markdown.vue:704` 的 `background: var(--el-bg-color, var(--khy-white));`
→ `newapi-theme.css:191` `--el-bg-color: var(--khy-bg-main)` → 暗色 `:259` `#161b26`。

**正文色 = 面板底色**。方案初稿的 WCAG 实算是相对亮度 1.00:1（同路径浅色 14.71:1）——
**该数字本轮未复算**（复核只核了色值来源：`:253 #161b22`、`:259 #161b26`、`:94-96` 三色均已核对）。
落地时须先复算再改。

规则：**正文色只能绑语义文本令牌**（`--khy-text-main` / `--khy-text-strong`），不得绑任何 `*-bg` / `*-surface`。

**副作用须登记**：改色后整块 Markdown 预览的暗色前景色会变——这正是意图，
但 `evidence/03_图片/` 里的相关截图会过期，触发 `AGENTS.md` 规则 9（`PROCESS-010`）的 C-MAT1/C-MAT2。

### 5.2 状态色一律收口到 `--khy-success/-warning/-danger`（带 fallback，不许写死品牌色）

仓内目前并存三套状态色：

| 来源 | 绿 | 琥珀 | 红 |
|------|----|------|-----|
| `newapi-theme.css:94-96` `--khy-*` | `#059669` | `#d97706` | `#dc2626` |
| Element Plus 默认（未被重映射） | `#67c23a` | `#e6a23c` | `#f56c6c` |
| `ui-shared/board/TaskCard.vue:154-157` / `TaskBoard.vue:270-273` | `--el-color-success` | `--el-color-warning` | `--el-color-danger` |

`grep -n 'el-color-success\|el-color-warning\|el-color-danger' src/styles/newapi-theme.css` = **0 命中**
（该文件只重映射了 `--el-color-primary` 与 text/bg/border/fill）。
而 TaskBoard 通过 `@khy/ui-shared/board/TaskBoard` 真实渲染在 ai-frontend 里（`src/views/admin/TaskBoard.vue:28`），
于是同屏出现两种绿、两种琥珀、两种红。且 TaskCard 的淡底 `--el-color-*-light-9` 未被重映射。

规则：

1. `ui-shared/board/*` 的状态色改引 `--khy-success/-warning/-danger`，**且必须带 fallback**：
   `var(--khy-success, #059669)`。
   **不能照字面只写 `var(--khy-success)`**——`ui-shared` 是 pnpm workspace 共享包
   （`delivery/web/ai-frontend/node_modules/@khy/ui-shared` → `runtime/substrate/platform/packages/ui-shared`），
   而 **khyquant 自己定义了不同的值**：`delivery/channel/khyquant/frontend/src/styles/theme.css:12`
   `--khy-success: #52c41a`。在共享包里写死 ai-frontend 的品牌色，等于让 ui-shared 从「中性层」退化成「某端主题层」。
   （爆炸半径有限：`grep -rn "ui-shared/board\|TaskBoard\|TaskCard" delivery/channel/khyquant/frontend/src`
   零命中，khyquant 不引用看板组件。）
2. 在 `newapi-theme.css` 补 `--el-color-*-light-9` 的重映射，使 EP 组件与 khy 组件共用同一组值。
3. 任何 `fg/bg` 配对必须实算对比度，亮暗各自达标（`[DESIGN-FE-012]` §3.2 规则③）。
4. **禁止拿语法高亮色 / 图表色当状态色**：`Markdown.vue:1010-1015` 的
   `.md-stat.ok{color:var(--el-color-success, var(--khy-md-green))}` 回落值是 GitHub 语法色，属错绑。

### 5.3 语义图标的 stroke 不得写死（当前**无任何断言**，改动须补网）

`KhyIcon.vue:98-104` 把 `stroke` 写成 `props.color || 'var(--khy-primary, var(--khy-primary))'`。
调用方的祖先 `color:` 对 SVG 的 `stroke` **表现属性无效**，故：

| 调用点 | 要求 | 实际 |
|--------|------|------|
| `admin/WxBinding.vue:48` + `:468-470` | `--el-color-success` | 品牌蓝 |
| `admin/WxBinding.vue:58` + `:472-474` | `--el-color-danger` | 品牌蓝 |
| `ServerError.vue:4` + `:50-52` | `--khy-warning` | 品牌蓝 |
| `Forbidden.vue:4` + `:47-49` | `--khy-danger` | 品牌蓝 |

**扫码成功与扫码失败长得一样。**

规则：`stroke` 改 `currentColor`（或由 `.khy-icon svg { stroke: … }` 从 CSS 变量取值），
并按 `kind` 给 `success/warning/error` 映射默认语义色，使调用方的 `color:` 与 `color` prop **都**生效。

**测试网现状**：`src/components/KhyIcon.test.js` 全文只有 3 个 `it`
（`:19` 路径数量、`:27` kind 区分、`:35` 未知 kind 回退），**没有一条断言 stroke 或 color**。
这不是「断言了错的还绿」，是**根本没有断言**——所以改 stroke 不会有测试转红来提示你，
也**不会有测试保护你改对**。该文件已用 `createSSRApp` + `renderToString` 渲染，
加一条「`kind='success'` 时输出的 svg 带非品牌色的 stroke/currentColor」断言成本很低，
**改动 stroke 的同一个提交里必须补上**。

同理 §5.1 的 Markdown 对比度、§5.2 的状态色对比度，全仓无任何对比度测试兜底。

---

## 6. 守卫与测试：本轮实跑记录

> 以下是我在本轮**实际执行**的命令与输出。**未跑的项一律标注「未跑」**。

| 检查 | 命令 | 输出 |
|------|------|------|
| 规则 1/2/3/4 静态体检 | `node scripts/ci/check-agent-rules.js delivery/web/ai-frontend/src` | `Summary: 0 error(s), 2 warning(s) across 198 file(s) scanned.` — 两条 warning 是 `useWxBinding.js:264`（`status: 'connecting'`）与 `KhyOsDesktop.vue:40`（模板 `v-if="connecting…"`，被 `STATUS_CONTEXT_HINTS` 第 7 条命中） |
| 美学守卫 | `node scripts/ci/check-aesthetics.js` | `[aesthetics] checked=59 findings=43 exit=0`。按端分计数：**`surfaces.web=null` 12 条 / `surfaces.tui=null` 31 条**，其余 0 条 |
| 前端测试 | `npm run test:frontend`（= `vitest run`） | **未能原样执行（未跑）**。本机 pnpm store 残缺：`failed to load config from vite.config.js` → `Cannot find package '@vitejs+plugin-vue@5.2.4…node_modules/vite/index.js'`。**本轮未跑通任何 vitest 断言** |
| WCAG 对比度复算 | — | **未跑**。§5.1 的 1.00:1 / 14.71:1 沿用初稿，本轮只核了色值来源（`newapi-theme.css:253` `#161b22`、`:259` `#161b26`、`:94-96` 三色） |

### 6.1 守卫修复的**顺序**（不可颠倒）

1. **先实现 §4 边界 1 承诺的枚举/i18n 豁免**。
   `check-agent-rules.js:586-603` 的判定块目前没有这个逃逸口，先补上——
   否则下一步放宽扫描面就会把 `<el-option label="处理中" />` 这类枚举标签判成违规。
2. **再补词表**：`GENERIC_STATUS_TOKENS`（`:146-153`）补齐 AGENTS.md 规则 2 正文列的含糊词
   （至少「加载中」「正在加载」「请稍候」）。本轮 grep 现状：`加载中` 0、`正在加载` 2、`请稍候` 1、
   `聆听中` 1、`思考中` 1、`启动中` 3，共 8 处——补词表后的即期命中面很小，风险主要来自下一步。
3. **最后放宽 `STATUS_CONTEXT_HINTS`**（`:169-178`），覆盖纯文本节点。
   注意放宽后 §2.4 的两条 warning 会继续命中，属预期。
4. **修 `a11yContract.test.js:150-170`**：该 `it` 全文只有 `console.warn`，没有任何 `expect`，永远通过。
   要么补断言（同文件 `:87` 的 `toBeLessThanOrEqual(20)` 同款，基线取实测值），要么删掉这条假守卫。
5. **修 `designTokenCompliance.test.js:140` 的基线**：`BASELINE = 999` 已失效。
   **取值口径：`BASELINE = 实测值 + 明确余量`（例如 +2）**，不得直接等于实测值——
   零余量棘轮会让下一次任何人写一个 hex 就红，那是噪音不是信号。
   **⚠「实测值」本轮无法复现**（vitest 跑不起来），初稿记的「4 个文件」是读断言逻辑推得的，
   **落地前必须先修好本机 store 再实测**。
   同时给 `HEX_RE` 加豁免——`var(--el-border-color, #dcdfe6)` 这类回退位的 hex 不应计入裸 hex，
   否则数字对应的是不存在的违规。
6. **`check-aesthetics.js:183-186` 的 `checkCrossEnd`**：把 `surfaces[end] === null` 分流为
   「未决，跳过存在性校验」并计为 info。`AESTHETICS-TOKENS.json` 的 `$meta.valueSemantics`
   自己写明 null=未决，而 43 条 warning **全部**是这一类（web 12 + tui 31）——
   守门人每天读这份输出只会学会忽略它，真缺口反而看不见。
   噪声归零后，剩下的才是真缺口。

### 6.2 文档必须订正的三处陈述（与仓库事实相反）

| 文档 | 现写 | 事实 |
|------|------|------|
| `[DESIGN-FE-012]:144`、`:412`、`:459`、§6 第 6 行 | 「`check-aesthetics.js` 尚未落地（当前不存在）」、「CI 强制依赖 check-aesthetics.js（待落地）」 | **文件存在，239 行，在 CI 跑**，`node scripts/ci/check-aesthetics.js` → `[aesthetics] checked=59 findings=43 exit=0`。而 `grep -niE "contrast\|ratio\|luminance" scripts/ci/check-aesthetics.js` 只命中 `:133-134` 的 rationale 非空检查，**没有任何对比度计算**——文档说没做的事做了，文档说有做的事没做，**两头都错** |
| `[DESIGN-FE-001]:90` / `:303`(G5)、`[DESIGN-FE-003]:51` | 「间距与字号目前没有 token（实测 `--khy-space-*`、`--khy-text-*` 不存在）」 | `newapi-theme.css:108-117` 已定义 `--khy-space-1..16` 共 10 档、`:128-131` 定义 `--khy-text-xs..2xl` 共 6 档。真实缺口是**消费率**：`grep -rn "khy-space-" --include="*.vue" src` = **0 处**。把缺口改述为「令牌已存在，0 组件消费，收敛方向是组件间距改走令牌」 |
| `[DESIGN-FE-004]:47` / `:226-231`、`[DESIGN-FE-012]:283` | 「`.mt-8` = `margin-top: var(--khy-space-2)`」「工具类映射到 `--khy-space-*`」 | `newapi-theme.css` 里 18 处 `--khy-space-` **全是定义与 self 引用**，无任何 `.mt-8` 之类工具类。FE-004 六层模型的 Utilities 层在代码中不存在，而文档把它当既有层描述——**错误还被 FE-012 §3.4 转抄复制传播**。标注为「目标态，仓内未落地」 |

### 6.3 本文的引用勘误记录

本文初稿有若干 grep / 行号 / 路径与仓库事实不符，已在正文中改正，此处留痕以免复查时再踩：

| 初稿写法 | 实际 |
|---------|------|
| `AIChat.vue:2121-2123` 的 catch | `:2120-2122` |
| `Markdown.vue:703` 是 background | `:704`（`:703` 是 `min-height: 0`） |
| `aiChatEventUtils.js:162` 的 `const ok` | `:163` |
| `classifyKhyError.mjs:13` 是 `PERMISSION_DENIED` | `:13` **正确**（`:11` 是 `MODULE_NOT_FOUND`，`:13` 才是 `PERMISSION_DENIED`） |
| `router/index.js:602-609` 含 `router.replace('/500')` | 块是 `:602-610`，`router.replace` 在 `:610` |
| `MAX_RESTARTART_ATTEMPTS` | **拼写不存在**。真名 `MAX_RESTART_ATTEMPTS`，定义 `useDaemonHealth.js:21`，引用 `:54` |
| `src/api/fetchWithTimeout.js` | **该路径不存在**。实现在 `runtime/substrate/platform/packages/ui-shared/src/http/fetchWithTimeout.js`，经 `authedFetch.js:17` 引入 |
| `grep 'running'` 只命中 4 处 | 非测试文件命中 **6** 处（多 `useDaemonHealth.js:60`、`aiChatEventUtils.js:243`），但**结论（无 orphan 清理）成立** |
| 「三处视图用『刷新本页』」 | `grep -rn "刷新本页" src/` 只有 **1 处**：`UserHome.vue:487`（文案来源，非 alert 渲染块 `:28-35/:71-78`） |
| aesthetics 43 条「全部是 web」 | web 12 / tui 31 |

---

## 7. 缺口表（只降不升）

| # | 缺口 | 落点 | 收敛方向 |
|---|------|------|---------|
| G-1 | 11 处 `catch {}` 丢弃错误对象 | `AccountPool.vue:547/:578` 等 | 接 `err` + 三维模板（规则 X-1） |
| G-2 | `check-agent-rules.js` 词表与正文不符；**且枚举/i18n 豁免未实现**，与放宽扫描面构成先后依赖 | `scripts/ci/check-agent-rules.js:146-153` / `:169-178` / `:586-603` | 先补豁免，再补词表，最后放宽上下文 |
| G-3 | `a11yContract.test.js` 有一条无断言的假守卫 | `:150-170` | 补断言或删除 |
| G-4 | `designTokenCompliance` 基线 999；**且「实测值」本轮无法复现**（vitest 未跑通） | `:140` | 实测 + 明确余量；先修本机 store |
| G-5 | `check-aesthetics.js` 43 条全为 null 误报（web 12 / tui 31） | `:183-186` | null 分流为 info |
| G-6 | FE-012 对守卫存在性的陈述与事实相反 | `FE-012:144/:412/:459`、§6 第 6 行 | 按 §6.2 订正 |
| G-7 | FE-001/FE-003 说间距字号无 token | `FE-001:90`、`:303`、FE-003:51 | 按 §6.2 订正，缺口改述为「0 组件消费」 |
| G-8 | FE-004 的 Utilities 层不存在但被当现状描述 | `FE-004:47/:226-231`、FE-012:283 | 标注为目标态 |
| G-9 | `--khy-space-*` 定义了 10 档、0 组件消费 | `newapi-theme.css:108-117` | 组件间距改走令牌 |
| G-10 | `Markdown.vue` 间距字号大量使用标度外的值（14/10/6/5px、12.5/13.5px） | `:710/:764/:775/:786/:789/:850` | 归到最近档或补档 |
| G-11 | 动效令牌 `--khy-duration-*`/`--khy-easing-*` 定义了 0 处使用，全是字面时长 | `newapi-theme.css:523/:501-512` | 替换字面量；`khy-fade-in` 与卡片 hover 位移纳入现有 reduced-motion 块 |
| G-12 | `UserHome.vue:487` 的修复建议写「刷新本页」，但页面上没有刷新按钮 | `UserHome.vue:487`（文案来源） | 页头 actions 槽加统一「刷新」按钮 |
| G-13 | 三个品牌组件各用一套尺寸档；`KhyIcon` 的 `small` 拼写静默回落到 md | `KhyIcon.vue:34/:93`、`KhyAvatar.vue:4/:19`、`KhyLogo.vue:8` | 共享 sm/md/lg；size 加白名单校验 |
| G-14 | **后端 `success` 兜底**：`aiChatConsumer.js:140` 的 `: true` 使前端 R-1 的 `unknown` 分支永不进入 | `runtime/node/backend/src/bridge/aiChatConsumer.js:133-141` | 改为「缺失时不广播该字段」；**必须先于前端 R-1 落地**，见 R-1 的顺序约束 |
| G-15 | **两条通道 `success` 语义分歧**：`aiChatConsumer.js:134`（缺失→true）vs `aiRequestParsers.js:403-415`（缺失→省略） | 同上两处 | 统一为「缺失即省略」，前端才有 unknown 可判 |
| G-16 | R-4 落地会打红既有测试 | `src/views/aiChatEventUtils.toolEvents.test.js:229/:238/:249` | 同一提交内同步改这三条断言；该文件混双 runner，只有 vitest 跑得到 |
| G-17 | X-2 的兜底表无 404 条目时侥幸不挂 `loadError.test.js:29`，但无保障 | `src/api/loadError.test.js:29` | `FIX_BY_STATUS` 为每个已有分支保留可达路径；新增条目须同步查该测试 |
| G-18 | R-1 前后端同改会导致所有不带 success 字段的步骤集体翻灰（全聊天页用户可见大退步） | `AIChat.vue:2554/:2572` | 分两次提交：后端先改、`unknown` 分支先只打日志；灰度确认后再渲染 |
| G-19 | KhyIcon stroke / 状态色对比度 / Markdown 对比度**无任何测试守卫**（KhyIcon.test.js 只有 3 个 it，无 stroke 断言——是「无断言」不是「假绿」） | `src/components/KhyIcon.test.js` | 改 stroke 的同一提交补断言；对比度归 §6.1 的 check-aesthetics 补实现 |
| G-20 | §5.1 改色会使 `evidence/03_图片/` 截图过期 | `Markdown.vue:874-875` | 触发规则 9（`PROCESS-010`）C-MAT1/C-MAT2，改后重拍受影响截图 |
| G-21 | P-1(a) 的 13 个接入点若配对失败会让进度条永久卡死 | `request.js:104-108` 注释所述 | 一次只接一条链路 + 「计数器最终回 0」自检 |
| G-22 | `GlobalProgressBar` 的 (b) 降级只对 aria 有效，视力用户仍看到编造读数 | `GlobalProgressBar.vue:5-11` 设计注释与 `:21-25` 的矛盾 | 承认 (b) 的边界；要真正解决须走 (a) |

---

## 8. 一页速查（写新页面时照抄）

```js
// 1. 读列表：走 loadInto，失败被记录
const loadError = useLoadError();
await loadInto('用量日志', loadError, () => list());

// 2. 状态文案：动作 + 目标 + 进度，活的
<span>{{ actionLabel }} {{ target }} · 已等待 {{ waitSeconds }}s</span>

// 3. 错误文案：问题 + 原因 + 修复，修复必须是用户能做的动作
showError(`保存调度配置失败：${describeFailure(err)}，请稍后重试`);

// 4. 三态结果：缺 success 即未知，不用 `!x.error` 反推成功
//    ⚠ 后端 aiChatConsumer.js:140 兜底成 true 之前，这条是空转的
const st = payload?.success === true ? 'ok' : payload?.success === false ? 'error' : 'unknown';

// 5. 超时：有入站活动的链路（流式 / WS / SSE）按入站字节重置，不写固定墙钟；
//    ⚠ 无入站活动的链路（上传等）走 U-1 的体积自适应，不受本条约束
clearTimeout(timer); lastActivity = Date.now(); timer = setTimeout(onIdle, LIMIT);

// 6. 状态色：只用 --khy-success/-warning/-danger（共享包内须带 fallback），正文只用 --khy-text-*
```

| 别抄（现状） | 抄（目标） |
|-------------|-----------|
| `status: '正在连接'` | `正在连接 PostgreSQL (127.0.0.1:5432)，第 2/3 次` |
| `showError('保存失败')` | `保存调度配置失败 (500)：后端内部错误，请稍后重试` |
| `catch {} → value = []` | `await loadInto('网关拓扑', loadError, loader)` |
| `<KhyEmpty v-if="!list.length">` | `<LoadErrorBanner v-if="loadError">` + `v-else-if="!loading && !list.length"`（**`loading` 要覆盖 v-loading 的全部信号**） |
| `const ok = p.success !== false` | 三态 `ok / error / unknown`（**且先改后端兜底**） |
| `结果未返回` | `结果未返回（原因：可能因中断/超时）· 重新生成` |
| `工具 ${done}/${total}` | `已完成 ${done} 个 · 1 个进行中`（**同提交改 `toolEvents.test.js:229/:238/:249`**） |
| 「登录已失效，请重新登录，请稍后重试」 | 「登录已失效，点右上角头像退出后重新登录」 |
| 「该操作需要你显式授权，重新执行并选择允许」 | 「无权限访问该页面，请联系平台管理员开通」（**前端覆盖表，不改 `classifyKhyError.mjs`**） |
| `role="progressbar" :aria-valuenow="width"` | `role="status" aria-valuetext="正在等待后端响应"` |
| `v-if="status === 'running'"` 永久转圈 | `finally` 里跑一次 `settleOrphanSteps` + 渲染耗时 |
| `showError(\`「${f.name}」上传失败：timeout\`)` | 「…上传失败：超时，文件可能超过单次上传上限，请压缩后重试」 |
| `--md-fg: var(--khy-md-bg)` | `--md-fg: var(--khy-text-main)`（正文永不绑背景令牌） |
| `stroke: color \|\| 'var(--khy-primary…)'` | `stroke: currentColor` + 按 kind 映射语义色 |