# AMOO 互动入口设计（桌面端 + APK）· v4

> 状态：实现已落地；**release APK 已出包（2026-10-22 15:04:57，release 签名）**，但**未真机验收**。
> v4 为「交付整理」轮：**只修改本文档**，不改代码、不改 APK、不改桥；把本文与工作区/索引/构建产物的实际状态对齐。
> 代码见第 6 节；实跑结果见第 10 节（§10.1 实现轮次、§10.2 本轮交付整理复跑）；逐项核对见第 13 节；未验证项见第 12 节。
> 读者：桌面端实现者、APK 实现者、桥接维护者。本文不依赖对话上下文。
> 日期：2026-10-22

---

## 0. v4 修订摘要（本轮：交付整理，只改本文档）

> 证据栏的每条都在 §10.2 列了精确命令与输出；未在本轮复跑的项目一律标注「本轮未复跑」。

| # | v3 文档里的说法 | v4 按事实的写法 | 依据（§10.2） |
|---|---|---|---|
| V1 | Gradle wrapper `9.3.1`、发行包 `-all`（§6.2、§10） | **Gradle 9.8.2 / `gradle-9.8.2-bin.zip`**（腾讯镜像）；AGP **9.1.0**、Kotlin **2.4.0**。9.3.1 的说法全部标为「历史，已被取代」 | `gradle-wrapper.properties:5-10`、`settings.gradle.kts:25-26` |
| V2 | 「APK 未出包」（§12 风险 1、§13.1） | **已出包**：`app-release.apk` 76,529,242 字节、2026-10-22 15:04:57、`apksigner` 验签 `CN=khy-os`；`versionName=1.1.17 / versionCode=2`。风险项改为「**未真机验收**」 | `apksigner verify --print-certs`、`output-metadata.json`、release class `javap` |
| V3 | .mjs 全段 `67/68`（唯一失败 probeBridge） | **68/68 全绿**；probeBridge 属**环境相关**用例（探不到 CLI 时给出可执行下一步），本轮独立复跑通过 | `node --experimental-strip-types --test <8 个 .mjs>` |
| V4 | `MainActivity.kt` 状态 `A`、diff 为整文件新增 | 三个 APK 原生文件**已重新暂存**（`A`）；**暂存版第 817 行已是 `Intent.FLAG_ACTIVITY_NEW_TASK`**；`Tools.java`/`KhyUi.java` 已进暂存区；**`AndroidManifest.xml` 仍被 `.gitignore` 忽略**；**本次没有 commit**（HEAD 仍 `ed684bfe`）。**但索引里还混进了一条与 amoo 无关的 `Tooltip.tsx` 暂存删除，且本文档自身仍未跟踪（`??`）** | `git status --porcelain`、`git show :<path> \| findstr /n`、`git check-ignore -v`、`git log -1`、`git diff --cached --stat` |
| V5 | Settings 三入口「若验收强制再追加」 | **明确决策：保持两个桌面入口，Settings 继续作为显式非目标**，理由与边界条件见 §3.3 | `SettingsPage.tsx` 搜 `amoon\|amoo` → 0 命中；`NAV_GROUPS:29`、`PAGE_META:66` |
| V6 | 无「交付整理」轮次的检查记录 | §10.2 补本轮全部检查命令与逐条结果 | 本轮实跑 |

---

## 0.1 v2 修订摘要（历史，保留原样）

### Blocking

| # | 评审问题 | 修订 |
|---|---|---|
| B1 | `AmoonPane` 的 `asStatus` 在 `ok:false && error` 时返回 null，导致 unhealthy/token 异常/401 被吞成「未运行」 | `asStatus` 改为**按 `phase` 判定**（`AmoonPane.tsx:97-102`，`PHASES.includes(rec.phase)`）。`pull()` 同时写入 `status` 与 `statusError`（`AmoonPane.tsx:155-160`）。新增 jsdom 用例断言 unhealthy 渲染「不健康」+ 端口 + hint，且不出现「未运行」 |
| B2 | APK 原生路径从未编译 | 本机 Gradle **Kotlin DSL 本身损坏**：空项目 `run { println("kts-ok") }` 仍报 Unresolved reference；同 wrapper 的 Groovy 项目 `BUILD SUCCESSFUL`。已定位到 wrapper 发行包解压出 0 字节 jar，重新解压后 `lib` 下 189 个 jar 均非空，Kotlin DSL 仍失败——判定为环境缺陷，不是本改动。**Kotlin 改动仍未编译、未真机验证**；本轮未把 `flutter build apk --debug` 记为通过<br>**⚠ v4 订正：本行的「仍未编译」已作废**——Kotlin DSL 缺陷源于 Gradle **9.3.1**，wrapper 升到 **9.8.2** 后已修复，release APK 于 2026-10-22 15:04:57 出包，release class 内 `javap` 可验到 `amooStatus` / `sendToAmoo` / `openAmoo`（§10.2 D15）。**仍未验证的是真机**，不是编译 |
| B3 | `MainActivity.kt` 被 `.gitignore:40 kotlin/` 忽略 | `.gitignore` 改为 `/kotlin/` 与 `/kotlin`（现 `:42-43`），并 `git add` 了 `android/.../MainActivity.kt`（`git status` 显示 `A`，即已暂存的新文件）。因为此前从未入库，diff 就是整文件新增 |
| B4 | start 的 `already_running` 语义矛盾；unhealthy 无停止入口；启动可能撞 lock | hub `start()` 先探测：`running && canSend` 直接返回「已在运行」；`runtime.present` 时**先执行 `cli stop` 再 `cli start`**（`index.ts:590-631`）。hint 改成「stop → 删除/轮换 operator.token → start」，不再声称 start 会补 token。停止按钮在 `runtimePresent \|\| phase === 'running'` 时出现（`AmoonPane.tsx:274`），unhealthy/malformed 可在面板内清理 |

### Missing

| # | 评审缺口 | 修订 |
|---|---|---|
| M1 | 没有入口/UI 自动化测试 | 新增 `tests/amooUiContract.test.cjs`（6 条源码契约：磁贴/switch/命令/无 fetch/五通道/phase 判定）与 `tests/amooPanel.test.cjs`（6 条 jsdom 交互）；APK 新增 `test/amoo_ui_test.dart`（composer 禁用/点击/预填、设备卡打开面板、聊天 source 契约） |
| M2 | 没有 start/stop 测试 | `tests/amooBridge.test.mjs` 注入 `spawnImpl`，断言 `start|stop --state-dir <dir>`、`ELECTRON_RUN_AS_NODE=1`、start 后 runtime 变 running、残留 runtime 时先 stop 后 start |
| M3 | APK 没有组件/widget 测试 | composer 与设备页 widget test 已加（mock 同一 MethodChannel），点击卡片真的打开 sheet、空输入按钮为 null |
| M4 | `closedPort()` 赌端口空着 | 删除。unhealthy 改用假桥 `/health` 返回 **503**（端口始终有人监听），不依赖任何空闲端口 |
| M5 | 构建/全量测试复跑口径 | 实现轮次复跑：桌面 `typecheck`、`build`、13 条 hub 测试、.cjs 全段 101/101、.mjs 全段 **68/68**（probeBridge 为环境相关用例，本轮独立复跑通过，见 §10.2）；APK `flutter test --no-pub` 17 条、`analyze`。**release APK 已出包**（2026-10-22 15:04:57），**debug APK 未取得**，见 §10 与 §12 |
| M6 | Settings 三入口 / AmooScreen 命名 | Settings 明确为非目标；APK 组件实际名是 `lib/ui/widgets/amoo_composer.dart` 的 `showAmooComposer`，仓库里**没有 AmooScreen 类**；桌面端也没有 `AmooPanel` 组件，实际是 `src/renderer/components/amoon/AmoonPane.tsx`。本文第 6 节按真实文件名列出。`pubspec.yaml` 1.1.16+1 → 1.1.17+2 已补进文件清单 |

### Security / UX

- 选择器兜底改为 **package-scoped**：`setPackage(AMOON_PACKAGE)`，且先 `resolveActivity`，不可解析时直接失败，不再把文本交给任意应用。
- `AmooStatus` 增加 `unknown`/`errorMessage`；通道异常显示「无法检测 amoo（原生通道异常）」，不再误报未安装；`canShare` 文案改为「已解析到分享入口（启动未验证）」，设备卡不再用绿色 `active`。
- `start()/stop()` 不再把 CLI stdout/stderr 回传渲染层（只写主进程日志）。
- 空白输入按 `trim()` 禁用；`cliFound=false` 时启动按钮禁用；hint 插值真实 `node "<root>/bin/cli.js"`；queued 映射成「已排队（未投递）」卡片并显示 local_path；回执区加 section 级「未验证」，未就绪时禁用读取。
- APK composer 包 `SingleChildScrollView`；设备页 15s 只读轮询 amoo 安装态（IndexedStack 常驻补偿）。

---

## 1. 目标与非目标

### 1.1 目标

1. 桌面端两个真实可达入口：SidePane 的 `amoo` 标签（主）+ 命令面板「打开 amoo 桥接」（次）。
2. APK 两个真实可达入口：设备页 `amoo` 卡（主）+ 聊天页 `amoo` chip（次），同一 `showAmooComposer`。
3. 两端事实优先：状态目录、`runtime.json`、`/health`、`/status`、组件解析结果；不可用不伪造。
4. 发送必须用户显式点击；回车/轮询/回执都不发送。
5. token 只存在于桌面主进程；IPC/日志/UI 只有 `present/valid/length`。
6. 不新增第三方依赖，不改桥的 12 工具契约。

### 1.2 非目标

- 不做双向聊天 / 自动消费 amoo 回复 / AI↔AI 互聊。
- 不做 APK 第 6 个 tab；不做 AmooScreen 一级模块。
- 不把 amoo 发送注册为 LLM 工具。
- 不做 APK 经 PC 桥发送（phone scope 无权限）。
- 不做「已读/已送达/已回复」。
- 不自动启停 daemon；桌面退出不 stop daemon。
- **不新增桌面设置页入口**（偏离 ZCode 1:1 复刻口径；**本轮已明确决策为「显式非目标」，不再是悬而未决项**，理由与边界条件见 §3.3）。

---

## 2. 两端共享的 UX 模型

### 2.1 四态与 `ok` 语义

桌面 `AmoonStatus.ok` **只表示「探测是否完全成功」**，不是「是否可渲染」。任何带合法 `phase` 的对象都必须渲染。
判据与 `bin/cli.js:230-288` 的 `status --json` 一致：

| phase | 判据 | 首屏文案 | 可发送 |
|---|---|---|---|
| `uninstalled` | 状态目录不存在 | `未安装 amoo 桥接（<stateDir> 不存在）` | 否 |
| `not_running` | 目录存在、无 runtime.json | `桥接未运行（状态目录已存在，但没有 runtime.json）` | 否 |
| `unhealthy` | runtime 存在但 `/health` 不通/非法 | `runtime.json 存在但 /health 不通（端口 N）` / `…内容不合法` | 否 |
| `running` | `/health` 200 | `桥接在运行（127.0.0.1:N，pid P）` | token 有效时是 |

`running` 但 token 缺失/过短/被 401 拒绝 → 仍显示 `running`，`ok:false`、`canSend:false`，并显示恢复步骤。
`/status` 异常但 `/health` 通 → `running`、`canSend:true`、带 error（可能仍能发送）。

### 2.2 三个动作

| 动作 | 桌面端 | APK |
|---|---|---|
| 检测 | `amoon:status`（只读，不建目录） | `amooStatus`（getPackageInfo + resolveActivity） |
| 发送 | `amoon:send` → `POST /v1/call` `amoon_send` | `sendToAmoo` → `startActivity` |
| 回执 | `amoon:inbox`（全部 unverified） | **不提供**（无可信回执，也不读 /sdcard） |

### 2.3 文案红线

1. 按钮：「发送（投递，不等于送达）」/「分享到 amoo」。
2. 成功映射：`pushed → 已投递到手机 outbox`、`sent → 已启动 amoo 分享页`；**`queued` 是失败态**，显示「已排队（未投递）」+ 本地 spool 路径 +「不会自动重试」。
3. 回执区标题与每条消息都带「未验证」；固定提示 ack/reply 可被任何能写 /sdcard 的应用伪造。
4. 不可用时不显示假在线/假二维码/假设备名，显示真实路径与可执行命令。

---

## 3. 入口表

### 3.1 桌面端（2 个入口）

| # | 类型 | 入口 | 代码路径 | 行为 |
|---|---|---|---|---|
| D1 | 主 | 侧边面板 `amoo` 磁贴 | `SidePane.tsx:54` → `:81-82` → `AmoonPane` | 打开/聚焦唯一 amoon 标签，挂载即拉状态 |
| D2 | 次 | 命令面板「视图 → 打开 amoo 桥接」 | `CommandCenter.tsx:99` → `AppLayout.tsx:194` | `openPaneTab('amoon')`，同 kind 去重（`AppLayout.tsx:113-125`） |

不新增设置页入口（见 1.2 与 **§3.3「Settings 入口决策」**）。图标复用 `Icon.tsx:49` 的 `remote-mobile`。

### 3.2 APK（2 个入口）

| # | 类型 | 入口 | 代码路径 | 行为 |
|---|---|---|---|---|
| A1 | 主 | 设备页功能状态 `amoo` 卡 | `device_screen_new.dart:178-201` | 可分享 → `showAmooComposer`；已安装但不可解析 → 打开 amoo；未知 → 无操作 |
| A2 | 次 | 聊天页快捷栏 `amoo` chip | `chat_screen_new.dart:872-875` | `showAmooComposer(initialText: _input.text)`，不自动发送 |

聊天快捷栏已改为横向 `SingleChildScrollView`（`chat_screen_new.dart:842-878`），避免窄屏 overflow。
组件统一是 `lib/ui/widgets/amoo_composer.dart` 的 `showAmooComposer`；**没有 AmooScreen 类**，也没有第 6 个 tab（`lib/main.dart:112-121` 仍是 5 个 screen，`:131-138` 仍是 `i < 5`）。桌面端主组件是 `AmoonPane.tsx`（**没有 AmooPanel**）。

### 3.3 Settings 入口决策（本轮定案：保持两个桌面入口）

**结论：维持 D1（SidePane 磁贴）+ D2（CommandCenter 命令）两个桌面入口，Settings 页面作为本文的「显式非目标」，本轮不新增任何 Settings 代码。**

理由（每条都有本轮读到的代码作证）：

1. **功能上重复。** Settings 唯一能给 amoo 的新东西是「配置」，而 amoo 目前**没有可由桌面端持久化的应用级配置**：它只有进程级环境变量 `KHY_AMOON_BRIDGE_DIR` / `KHY_OS_DIR`（`AmoonPane.tsx:324`、`:375` 已在面板内就地提示如何设置）。而 Settings 的内容区是 `settings:get` / `settings:set` 驱动的持久化配置页（`SettingsPage.tsx:98-112`、`:212-282`：GeneralSettings / AppearanceSettings / KeyManagerPage / BrowserSettings / CuaSettings / McpSettings / UsageSettings / ListSettingsPage / PluginSettings / IndexSettingsPage）。amoo 的「状态 / 启停 / 发送 / 回执」四类内容**一个都不属于**这一类。
2. **交互模型不匹配。** `AmoonPane` 是活体控制面：挂载即探测 + 15s 只读轮询（`AmoonPane.tsx:137`、`:153`、`:172`）、两段式确认停止（`AmoonPane.tsx:274-289`）、queued 琥珀卡与「未验证」标记。这些都依赖常驻挂载；Settings 是全屏路由，离开要点「返回工作区」，把带副作用的动作（spawn daemon、写手机 outbox）挪到需要离开的设置页里会削弱可见性与留痕。
3. **入口语义已经足够。** CommandCenter「打开 amoo 桥接」（`CommandCenter.tsx:99` → `AppLayout.tsx:194` `openPaneTab('amoon')`）本身就是全局入口；再加一条 Settings 入口只是「打开一个能打开面板的页面」——是入口的入口，不是能力增量。
4. **先例是混合的，不构成支持新增。** Settings 里最接近的 `'remote'`（移动端远程控制，`SettingsPage.tsx:39`、`:72`、`:229` 嵌入 `WebRemoteControlPanel`）之所以成立，是因为它承载的是「扫码/打开链接」这种一次性配对动作；amoo 没有同类配对动作。
5. **现状声明经核对属实。** `SettingsPage.tsx` 全文件搜 `amoon|amoo` → **0 命中**；本文 §1.2 与 §13.1 的非目标表述与代码一致；§3.1「桌面端（2 个入口）」与 `SidePane.tsx:54`/`:81-82`、`CommandCenter.tsx:99`、`AppLayout.tsx:194`/`:50` 的实际接线逐条对上。

**边界条件（写进文档，供后续迭代遵守）：**

- 若验收真的强制三入口，正确做法是在 `NAV_GROUPS`/`PAGE_META`（`SettingsPage.tsx:29`、`:66`）里加一个**只做「跳转/嵌入 AmoonPane」**的入口，而不是第三套实现。**本轮不预先建。**
- 只有当 amoo 日后真的产生**需要持久化的偏好**（默认 openChat、轮询间隔、桥接目录选择等）时，Settings 页才有独立存在理由——**那时也只放配置，不放启停/发送/回执**，避免与 `AmoonPane` 形成双份实现。
- 本轮**未新增、未修改任何 Settings 代码**（`SettingsPage.tsx` 与本文无关，未纳入本轮改动范围）。

---

## 4. 数据流

### 4.1 桌面端

```
AmoonPane (renderer)
  │ __KHYOS__.amoonStatus / amoonSend / amoonInbox / amoonStart / amoonStop
  ▼ ipcRenderer.invoke('amoon:*')            preload/index.ts:209-213
main/index.ts ipcMain.handle('amoon:*')      main/index.ts:785-793
  ▼
src/main/amoon/index.ts createAmoonHub
  ├─ fs: <stateDir>/runtime.json             (KHY_AMOON_HOME 或 %LOCALAPPDATA%\khy-amoon-bridge)
  ├─ fs: <stateDir>/operator.token           (只在本文件读原文)
  ├─ GET  /health                            (免鉴权)
  ├─ GET  /status                            (Bearer operator)
  ├─ POST /v1/call {id,tool,args}            (Bearer operator)
  └─ 显式按钮 → node "<bridge>/bin/cli.js" start|stop --state-dir <dir>
                 env ELECTRON_RUN_AS_NODE=1
```

`start` 流程（本轮修订）：

1. `probe()`；若 `running && canSend` → 返回「已在运行」，不 spawn。
2. 若 `runtime.present`（unhealthy/malformed 或 token 不可用）→ 先 `cli stop`（12s 上限）清理残留，避免 `daemon.lock`。
3. 再 `cli start`（25s 上限），最后 `probe()` 返回真实状态。
4. CLI 的 stdout/stderr **只进主进程日志**，不回传渲染层。

### 4.2 APK

```
设备卡 / 聊天 chip → showAmooComposer
  → AmooService.status()/shareText()/openChat()
  → MethodChannel 'com.khyos.khy_os_client/device'
  → MainActivity.amooStatus / sendToAmoo / openAmoo
       sendToAmoo: ShareActivity（显式）→ 失败 → package-scoped chooser → 仍不可用则失败
```

---

## 5. 协议与数据形状

### 5.1 IPC

| 通道 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `amoon:status` | 无 | `AmoonStatus` | 只读，不创建目录 |
| `amoon:send` | `{text, openChat?}` | `AmoonSendResult` | 本地先校验 1..4000 |
| `amoon:inbox` | `limit?` | `AmoonInboxResult` | 1..100，默认 20 |
| `amoon:start` | 无 | `{ok,message,status?}` | 无 `output` 字段 |
| `amoon:stop` | 无 | `{ok,message,status?}` | 无 `output` 字段 |

`desktopUiContract.test.cjs:137-152` 断言 preload 每个 invoke 都有同名 handle，五对必须同时存在。

### 5.2 `AmoonStatus`

```ts
{
  ok: boolean            // 仅表示探测是否完全成功；渲染看 phase
  phase: 'uninstalled'|'not_running'|'unhealthy'|'running'
  message: string; hint: string
  stateDir: string; stateDirExists: boolean
  token: { present: boolean; valid: boolean; length: number }
  runtime: { present: boolean; pid: number|null; port: number|null; malformed: boolean }
  health: boolean
  bridge: { root: string|null; cliFound: boolean }
  daemon: null | { protocol; port; state; adbOk; lastPoll; lastError; auth; counters }
  canSend: boolean; checkedAt: string
  error?: { code: string; message: string }
}
```
hint 中的 CLI 命令用真实路径插值：`node "D:\...\khy-amoon-bridge\bin\cli.js"`；找不到源码时才用 `<khy-amoon-bridge>` 占位。

### 5.3 `AmoonSendResult`

成功：
```ts
{ ok:true, id, state:'pushed'|'sent'|'queued', channel:'file'|'intent'|'both',
  intentSent, intentError, openChat, requiresAck, verified:false,
  remotePath, pushError }
```
失败：
```ts
{ ok:false, error:{code,message,details?}, queued?:{ localPath: string|null } }
```
`queued` 由桥的 `BridgeError.details.state==='queued'` 映射（`lib/bridge-tools.js:441-447`）；面板渲染琥珀卡，不并入普通错误。

### 5.4 `AmoonInboxResult`

```ts
{ ok:true, messages:[{id,kind,text,ts,status,unverified:true}], count,total,skipped,unverified:true }
```

### 5.5 HTTP 契约（桌面端只用三个）

| 路径 | 鉴权 | 用途 |
|---|---|---|
| `GET /health` | 无 | 判 unhealthy（`lib/server.js:874-893`） |
| `GET /status` | Bearer | 事实表（`:896-958`） |
| `POST /v1/call` | Bearer | send/inbox（`:1195-1213`、`:476+`） |

错误码：`daemon_unavailable`、`auth_unavailable`/`unauthorized`、`forbidden_scope`、`invalid_args`、`rate_limited`、`http_5xx`。

### 5.6 APK 形状

| 类型 | 字段 |
|---|---|
| `AmooStatus` | `installed, canShare, canOpenChat, versionName, unknown, errorMessage` |
| `AmooSendResult` | `ok, via:'direct'|'chooser'|'none', message, truncated` |
| Intent | `ACTION_SEND text/plain + EXTRA_TEXT → ShareActivity`；`OPEN_CHAT → ChatMainActivity` |

---

## 6. 文件清单

### 6.1 桌面端（`apps/khyos-desktop`）

新增：

| 文件 | 作用 |
|---|---|
| `src/main/amoon/index.ts` | 纯 Node hub；`resolveStateDir/readRuntimeFile/readOperatorTokenInfo/resolveBridgeRoot/createAmoonHub`；不 import electron |
| `src/renderer/components/amoon/AmoonPane.tsx` | 面板 UI |
| `tests/amooBridge.test.mjs` | 13 条 hub 契约测试 |
| `tests/amooPanel.harness.tsx` | jsdom 挂载 + 假 `__KHYOS__` |
| `tests/amooPanel.test.cjs` | 6 条面板交互测试 |
| `tests/amooUiContract.test.cjs` | 6 条入口/接线源码契约 |

修改：

| 文件 | 改动 |
|---|---|
| `src/main/index.ts:11` | import `createAmoonHub/resolveBridgeRoot` |
| `src/main/index.ts:102-103` | `amoonHub` 变量 |
| `src/main/index.ts:772-793` | 创建 hub（`bridgeRoot: resolveBridgeRoot(process.env, __dirname)`）+ 5 个 handle（`785-793`） |
| `src/preload/index.ts:209-213` | 5 个 invoke 映射 |
| `src/renderer/components/layout/SidePane.tsx:8,15,54,81-82` | import / PaneTabKind / 磁贴 / TabBody |
| `src/renderer/components/layout/AppLayout.tsx:50,194` | TAB_TITLES / addAmoonTab |
| `src/renderer/components/message/CommandCenter.tsx:99` | 命令条目 |
| `package.json` scripts.test | 第一段加 `tests/amooBridge.test.mjs`；第二段加 `tests/amooPanel.test.cjs tests/amooUiContract.test.cjs` |

### 6.2 APK（`delivery/mobile/khy-os-client-app`）

新增：

| 文件 | 作用 |
|---|---|
| `lib/core/services/amoo_service.dart` | 常量、MethodChannel、`AmooStatus`（含 unknown）、`AmooSendResult` |
| `lib/ui/widgets/amoo_composer.dart` | `showAmooComposer` 底部面板（可滚动） |
| `test/amoo_service_test.dart` | 13 条 service 单测 |
| `test/amoo_ui_test.dart` | composer/设备卡 widget 测试 + 聊天页源码契约 |

修改：

| 文件 | 改动 |
|---|---|
| `android/.../MainActivity.kt:156-158` | 三方法分发（`"amooStatus" ->` / `"sendToAmoo" ->` / `"openAmoo" ->`） |
| `MainActivity.kt:836`（`amooStatus`）、`:879`（`sendToAmoo`，package-scoped 兜底）、`:946`（`openAmoo`） | 三个 amoo 方法实现 |
| `MainActivity.kt:1180-1183` | 四个常量（`AMOON_PACKAGE` / `AMOON_SHARE_ACTIVITY` / `AMOON_CHAT_ACTIVITY` / `AMOON_OPEN_CHAT`） |
| `android/.../bridge/Tools.java:17`、`bridge/KhyUi.java:11` | 补 `import com.khyos.khy_os_client.KhyAccessibilityService`；这是既有原生编译阻断的修复（与 amoo 语义无关，但不修则任何构建都过不了）。**行号已按本轮读到的文件更正**（v3 误写为 `Tools.java:16` / `KhyUi.java:12`） |
| `android/gradle/wrapper/gradle-wrapper.properties:5-10` | 发行包走腾讯镜像 **`mirrors.cloud.tencent.com/gradle/gradle-9.8.2-bin.zip`**（9.8.2 / `-bin`）。`:5-8` 的注释写明：AGP 9.1.0 的最低 Gradle 是 9.3.1，但本机 9.3.1 的 Kotlin DSL 脚本编译损坏，**9.8.2 起该缺陷已修复**。属构建环境改动，不改变 app 逻辑 |
| `android/settings.gradle.kts:25-26` | AGP **9.1.0**、Kotlin **2.4.0**（与 wrapper 9.8.2 配套） |
| `lib/ui/screens/device_screen_new.dart:1,3,6,28-45,178-201` | 状态、15s 只读轮询、amoo 卡（非绿色） |
| `lib/ui/screens/chat_screen_new.dart:24,842-878` | import、横向滚动快捷栏 + chip |
| `pubspec.yaml` | 版本 1.1.16+1 → **1.1.17+2**（既有改动，本轮补进清单；无新增依赖） |
| `.gitignore:42-45` | `kotlin/` → `/kotlin/`、`/kotlin`；`res/`、`assets/` 同样限定到仓库根（**`AndroidManifest.xml` 与 `*.apk` 两条规则仍未限定，详见下方「版本控制」**） |

**版本控制（2026-10-22「交付整理」轮的实际状态，命令见 §10.2）：**

- 本轮**重新暂存了三个 APK 原生文件**，现在都是索引里的新增（`A` 状态），工作树与索引一致（`git diff --stat` 对这三条路径为空）：
  - `android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt`（1185 行）
  - `android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java`
  - `android/app/src/main/java/com/khyos/khy_os_client/bridge/KhyUi.java`
- **暂存版 `MainActivity.kt` 第 817 行已是 `intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)`**（`git show :<path> | findstr /n "FLAG_ACTIVITY_NEW_TASK"` 给出 183/197/360/656/748/762/**817**/892/926/949/961 共 11 处，全部为 `FLAG_ACTIVITY_NEW_TASK`；`Intent.FLAG_NEW_TASK` 在 `android.content.Intent` 中不存在，已无残留）。这修正了 v3 文档里「暂存版仍是 `FLAG_NEW_TASK`」的结论。
- 因为这三个文件此前从未入库，diff 是**整文件新增**（这三个文件合计 1880 insertions：KhyUi 282 + Tools 413 + MainActivity 1185），不是增量修改。
- `AndroidManifest.xml` **仍被 `.gitignore` 忽略**（`git check-ignore -v` → `.gitignore:40:AndroidManifest.xml`），`assets/shizuku/shizuku-release.apk` 仍被 `.gitignore:241:*.apk` 忽略。`AndroidManifest.xml` 未被本设计修改，属仓库既有问题。
- **本轮没有 commit**：HEAD 仍是 `ed684bfe`（分支 `chore/hygiene-20261010`）。改动只落在索引里，等复核后再决定提交。
- **索引里还有一条无关改动**：`git diff --cached --stat` 除上述 3 个文件外，还有 `apps/khyos-desktop/src/renderer/components/ui/Tooltip.tsx`（-58，暂存删除）。该条**与 amoo 无关**，且是本轮进行期间由别的环节加进索引的（本轮没有执行任何 `git add`）——**提交前必须确认要不要带上它**。
- **本文档自身仍未跟踪**：`git status --porcelain -- <本文档>` → `??`。本轮按约束只改文档内容，**没有把它加进索引**。
- **入库仍不完整（残留风险，见 §12 风险 5）**：整个 `bridge/` 目录与 `KhyAccessibilityService.kt` / `ScreenCaptureService.kt` / `ShizukuServiceManager.kt` 仍为未跟踪（`??`），`res/` 也整体未跟踪。也就是说**按当前索引直接 commit 仍然编不出 APK**——已暂存的 `MainActivity.kt` import 了 `BridgeOverlayService` / `BridgeService` / `HttpBridge`（`:16-18`）并多处引用 `KhyAccessibilityService`（`:74`、`:369` 起），这些文件都不在索引里。

---

## 7. 交互细则

### 7.1 桌面面板

- 挂载即 `amoonStatus()`；15s 只读轮询。
- 状态区：`message` + `hint`；`status.ok===false` 时额外一条红色 error banner，但状态本身照常渲染。
- 停止按钮：`runtimePresent || phase === 'running'` 即显示（覆盖 unhealthy/malformed；`AmoonPane.tsx:274`），两段式确认。
- 启动按钮：`phase!=='running'` 时显示；`bridge.cliFound===false` 时禁用并显示设置 env 的提示；`runtime.present` 时提示「启动前会先 CLI stop 清理」。
- 发送按钮禁用：`!canSend || sending || draft.trim()==='' || >4000`。
- 发送结果：成功卡（含 `未验证`）；queued 琥珀卡；其他失败红色卡。
- 回执区：标题「最近回执 + 未验证」；`!canSend` 时读取按钮禁用；空态「还没有回执…」。

### 7.2 APK

- composer 整块 `SingleChildScrollView`，键盘 + 结果条不溢出。
- 状态文案：未安装 / 已解析到分享入口（启动未验证）/ 未解析到分享入口 / 无法检测 amoo（原生通道异常：…）/ 无法读取 amoo 安装态：<原生 message>。
- 按钮 disabled：`!canShare || sending || trim 为空`；回车不发送。
- 结果文案只来自原生「已交给…（未确认送达）」/「已打开系统分享面板（仅 amoo），未确认送达」。
- 底部固定提示的实际文案：**「amoo 是否真正读取或回复无法确认；本页不读取回执，请在 amoo 中查看回复。」**
- 「分享到 amoo」与「打开 amoo」是**两个独立动作**：先启动 ShareActivity 再启动 ChatMainActivity 会覆盖分享页，因此不做「发送并打开」的合并动作（设计选择，不是缺实现）。
- 设备页 15s 只读刷新 amoo 安装态（IndexedStack 常驻）。

### 7.3 错误 / 空状态

| 场景 | 桌面 | APK |
|---|---|---|
| 未安装 | 未安装文案 + 启动 | 卡片「未安装 amoo（包名）」 |
| 未运行 | 未运行 + 启动 | — |
| 不健康/非法 runtime | 端口/原因 + 停止/清理 + 启动（先 stop） | — |
| token 缺失/过短/401 | running + 恢复步骤（stop → 删除/轮换 token → start） | — |
| 找不到桥源码 | 事实表「桥接源码 未找到」+ 启动禁用 | — |
| 发送成功 | 已投递/已启动 + 未验证 | 已交给 amoo（未确认送达） |
| queued | 已排队（未投递）+ local spool + 不自动重试 | — |
| 通道异常 | preload 未注入提示 | 无法检测 amoo（原生通道异常） |
| 回执 | 空态/超量提示/未验证 | 不提供 |

---

## 8. 安全与隐私

1. **token 只在主进程**：`readOperatorTokenValue()` 仅用于构造 Bearer；跨 IPC 只有 `{present,valid,length}`。测试断言状态 JSON 不含原文。
2. **渲染层不 fetch**：桥对带 `Origin` 请求 403（`lib/server.js:848-859`），Host 必须匹配（`:346-349,861-871`）；主进程 Node fetch 天然满足。
3. **APK 不用 phone token 调 operator-only 工具**：`amoon_send/amoon_inbox` scopes=[operator]（`lib/contracts.js:486,509`），phone → `forbidden_scope`；daemon 只监听 127.0.0.1，需 adb reverse。
4. **APK chooser 兜底 package-scoped**：`send.setPackage(AMOON_PACKAGE)` + 先 `resolveActivity`；不可解析直接失败，文本不外泄给任意应用。
5. **不自动发送**：桌面仅按钮 onClick；APK 仅按钮 onPressed；回车/轮询/回执都不触发。
6. **回执不可信**：每条与整体 `unverified:true`；UI 禁止据此执行命令。
7. **不把 CLI 原文回传**：start/stop 的 stdout/stderr 只写主进程日志，IPC 仅 `{ok,message,status}`，避免未来 CLI 输出带凭据。
8. **启动/停止显式**：start 走 CLI（创建 state dir + token），stop 走 CLI 的 PID 核对；桌面不 kill、退出不 stop daemon。
9. **resolveActivity 不是 exported 证明**：`canShare` 只表示组件可解析，UI 文案已改为「启动未验证」，设备卡不用绿色。
10. **通道异常不等于未安装**：`unknown` 态独立显示，避免旧原生壳被误报成「未安装」。
11. **命名隔离**：手机桥 8896//sdcard/bridge-amoobridge 与 amoo 桥 18765..18774/%LOCALAPPDATA%\khy-amoon-bridge 分开写。
12. **端口不写死**：只认 `runtime.json.port`。

---

## 9. 测试与构建计划

### 9.1 桌面

| 文件 | 覆盖 |
|---|---|
| `tests/amooBridge.test.mjs`（13） | stateDir/runtime/token 判据；只读不建目录；`/health` 503 → unhealthy；token 缺失 → running+canSend=false；全链路不泄 token、`/v1/call` 无 Origin；**请求参数断言：send args = `{text,mode:'file',open_chat:false,requires_ack:true}`、inbox args = `{limit:10}`（`:294-298`）**；本地长度校验；401 转错；queued 带 local_path；`resolveBridgeRoot` found/not-found；start（args/env/结果）；残留 runtime 先 stop 再 start；stop 后 not_running |
| `tests/amooPanel.test.cjs`（6） | unhealthy 渲染文案/端口/停止按钮且不出现「未运行」；空白禁用且输入不发送；点击发送参数正确、结果未验证；queued 卡；cliFound=false 禁用启动；回执 section 未验证 + 未就绪禁用 + 读取渲染 |
| `tests/amooUiContract.test.cjs`（6） | SidePane 三处；AppLayout 两处；CommandCenter；渲染层无 fetch/fs；五通道同名；asStatus 按 phase |
| `tests/desktopUiContract.test.cjs`（26） | preload ↔ main 通道一致性（既有） |

命令：

```
cd D:\Portable\khy-os\apps\khyos-desktop
node --experimental-strip-types --test tests/amooBridge.test.mjs
node --test tests/amooPanel.test.cjs tests/amooUiContract.test.cjs tests/desktopUiContract.test.cjs
npm.cmd run typecheck
npm.cmd run build
```

### 9.2 APK

| 文件 | 覆盖 |
|---|---|
| `test/amoo_service_test.dart`（13） | status 解析；未安装；通道异常 → unknown 且不误报未安装；原生 message 保留；shareText direct/chooser/空文本不调通道/4000 截断/异常；openChat；文案不承诺送达 |
| `test/amoo_ui_test.dart`（4） | composer 空/空白禁用、只有点击发送、结果含「未确认送达」；initialText 预填不自动发送；设备卡显示解析结果并点「分享」打开 sheet；聊天页 chip 源码契约 |

命令：

```
cd D:\Portable\khy-os\delivery\mobile\khy-os-client-app
set ANDROID_HOME=C:\Users\25789\.khyos\android_sdk
set ANDROID_SDK_ROOT=C:\Users\25789\.khyos\android_sdk
D:\Portable\2-tools\flutter\flutter\bin\flutter.bat test --no-pub test\amoo_service_test.dart test\amoo_ui_test.dart
D:\Portable\2-tools\flutter\flutter\bin\flutter.bat analyze --no-pub --no-fatal-infos --no-fatal-warnings
D:\Portable\2-tools\flutter\flutter\bin\flutter.bat build apk --debug --no-pub
```

不设 `ANDROID_HOME` 时 build 会先报 `[!] No Android SDK found`，这是环境配置问题，不是代码问题。

**构建现状（2026-10-22）**：wrapper 已升级到 **Gradle 9.8.2**（`gradle/wrapper/gradle-wrapper.properties:10`，`gradle-9.8.2-bin.zip`），配合 **AGP 9.1.0**（`settings.gradle.kts:25`）已能正常出包——**release 变体成功**（2026-10-22 15:04:57，`build/app/outputs/apk/release/app-release.apk`，release 签名 `CN=khy-os`）。**debug 变体未取得**（`build/app/outputs/apk/` 下只有 `release/`），上表的 `build apk --debug` 若要验收需重跑；本轮未重跑 debug 构建（避免改动构建产物）。构建必须配好 `ANDROID_HOME`/`ANDROID_SDK_ROOT`。

### 9.3 手工验收（仍未执行，需真 daemon/真机）

桌面：启动 → outbox 出现 `msg_<uuid>.json`；与 `cli status --json` 逐项对照；关闭桌面后 daemon 仍在。
APK：设备卡/聊天 chip → composer → 点发送 → amoo 受理；卸载 amoo 后卡片变未安装；`amooStatus` 的 canShare 与 dumpsys 对照。
APK 真机侧（本轮新增，仍未执行）：安装 release APK（`CN=khy-os` 签名）→ 打开设备页 amoo 卡 / 聊天页 amoo chip → `showAmooComposer` → 点「分享到 amoo」→ 确认 `ShareActivity` / `ChatMainActivity` 真机受理（`dumpsys activity` 对照）。**出包不等于验收**。

---

## 10. 实跑结果（2026-10-22）

> §10.1 = 实现轮次的结果（保留原样，但已按 v4 结论标注「已被取代」的条目）；§10.2 = **本轮「交付整理」的实跑结果**（每条都有精确命令与输出）。

### 10.1 实现轮次

| 检查 | 精确命令 | 结果 |
|---|---|---|
| 桌面 hub 测试 | `node --experimental-strip-types --test tests/amooBridge.test.mjs` | **13 tests / 13 pass / 0 fail**，exit 0 |
| 桌面面板+契约 | `node --test tests/amooPanel.test.cjs tests/amooUiContract.test.cjs tests/desktopUiContract.test.cjs` | **38 tests / 38 pass / 0 fail**，exit 0 |
| 桌面 .cjs 全段 | `node --test tests/keyManagerContract.test.cjs tests/desktopUiContract.test.cjs tests/sidebarProjectClassify.test.cjs tests/webRemotePanel.test.cjs tests/amooPanel.test.cjs tests/amooUiContract.test.cjs tests/usageChartMath.test.cjs` | **101 tests / 101 pass / 0 fail**，exit 0（**本轮复跑仍为 101/101**，见 §10.2） |
| 桌面 .mjs 全段 | `node --experimental-strip-types --test tests/keyStore.test.mjs tests/agentWriters.test.mjs tests/health.test.mjs tests/pacedProgress.test.mjs tests/keymapContract.test.mjs tests/wiringRuntime.test.mjs tests/webRemoteHub.test.mjs tests/amooBridge.test.mjs` | 实现轮次记录为 **68 tests / 67 pass / 1 fail**（唯一失败：既有 `webRemoteHub` 的 probeBridge，环境相关）。**本轮独立复跑为 68/68 全绿**，见 §10.2；v3 文档里「67/68」的表述按此更正 |
| 桌面类型 | `npm.cmd run typecheck` | **exit 0**，「类型检查：既有 5 条 / 实际 5 条 / 无新增错误。」（本轮未复跑） |
| 桌面构建 | `npm.cmd run build` | **exit 0**：main 161.51 kB、preload 15.24 kB、renderer js 2,307.16 kB + css 94.52 kB、host 26.41 kB、scheduler 0.83 kB；仅既有 keyStore 动态导入与 globals.css 注释告警（本轮未复跑） |
| APK 测试 | `flutter.bat test --no-pub test\amoo_service_test.dart test\amoo_ui_test.dart` | **17 tests / All tests passed!**（本轮未复跑） |
| APK 静态检查 | `flutter.bat analyze --no-pub --no-fatal-infos --no-fatal-warnings` | **exit 0，66 issues（17 warning / 49 info / 0 error）**；新增文件 0 条（本轮未复跑） |
| APK 构建（未设 SDK） | `flutter.bat build apk --debug --no-pub` | **exit 1**：`[!] No Android SDK found. Try setting the ANDROID_HOME environment variable.` |
| APK 构建（设 SDK，**历史失败·已被取代**） | 同上 + `ANDROID_HOME/ANDROID_SDK_ROOT=C:\Users\25789\.khyos\android_sdk` | **未通过**：`android/settings.gradle.kts:3` 起 11 个 `Unresolved reference`（run/file/uri/plugins/id），`BUILD FAILED in 27s`。诊断：同 wrapper 下 Groovy 空项目 `groovy-ok / BUILD SUCCESSFUL`；Kotlin DSL 空项目 `run { println("kts-ok") }` 仍失败。已发现 wrapper 解压出 0 字节 `ant-1.10.15.jar`，重新解压后 `lib` 下 189 个 jar 均非空，Kotlin DSL 仍失败 → **环境级缺陷**。<br>**⚠ 该行已被 2026-10-22 14:03 的 wrapper 升级（9.3.1 → 9.8.2）+ 当日 15:03–15:04 的 release 构建成功取代，不必再按本行排查** |
| APK 原生独立编译（实现者报告） | 用 Gradle 发行包内 `kotlin-compiler-embeddable 2.2.21` 编译 `KhyAccessibilityService.kt`、`ScreenCaptureService.kt`、`ShizukuServiceManager.kt` + Java bridge + `MainActivity.kt` | 报告称 exit 0，`javap MainActivity.class` 可见 `amooStatus(...)`、`sendToAmoo(String, Result)`、`openAmoo(...)` 与四个 `AMOON_*` 常量。**该结论本轮已被 release 产物直接证实**（§10.2 同样用 `javap` 在 release class 上验到同三个方法与四个常量） |
| APK 构建环境替代尝试（实现者报告，**历史·已被取代**） | AGP 9.0.1 + Gradle 9.1.0；`gradlew --offline assembleDebug` | 版本检查可通过，但 `assembleDebug` 卡在 Google Maven（142.251.45.155:443）30+ 分钟；离线报 `Plugin [id: 'org.gradle.kotlin.kotlin-dsl-root-project'] was not found`；当时已恢复 **AGP 9.1.0 + Gradle 9.3.1**。<br>**⚠ 「Gradle 9.3.1」是本轮之前的历史状态，现已被 wrapper 升级到 9.8.2 取代**（`gradle-wrapper.properties:10` = `gradle-9.8.2-bin.zip`；`:5-8` 注释说明 9.3.1 的 Kotlin DSL 编译损坏、9.8.2 起修复） |
| **APK release 构建（成功）** | 见 §10.2 | **2026-10-22 15:04:57 产出 `app-release.apk`（76,529,242 字节），release 签名 `CN=khy-os`；**此前「APK 未出包」的结论作废 |
| **APK debug 构建** | 见 §10.2 | **未取得 debug APK**（`build/app/outputs/apk/` 下只有 `release/`）。本轮**未重跑** debug 构建（避免改动构建产物），因此「环境阻塞」这一归因沿用实现轮次的 Kotlin DSL 诊断，**未经本轮复现** |

实现轮次**未执行**：`flutter build apk` 成功路径（release 路径已于 15:04 走通）、真机/真 daemon 手工验收、`cli start`（会创建状态目录）。全量 `npm test` 两段已分别跑过：.cjs 101/101 通过，.mjs 67/68（仅既有 probeBridge 环境失败；**本轮复跑 68/68**）。

### 10.2 本轮「交付整理」实跑结果（只读核对 + 复跑测试）

> 本轮**未修改任何代码 / APK / 桥**，只读工作区与索引、复跑桌面测试、核对构建产物，并把结论写回本文。所有命令在 `D:\Portable\khy-os`（git 根）与 `D:\Portable\khy-os\apps\khyos-desktop` 下执行。

| # | 检查 | 精确命令 | 结果 |
|---|---|---|---|
| D1 | 仓库/分支/HEAD | `git -C D:\Portable\khy-os rev-parse --show-toplevel` / `branch --show-current` / `log -1 --format=%H` | `D:/Portable\khy-os` / `chore/hygiene-20261010` / `ed684bfe76baf2be757371ee9a18b40391a1070d` → **本轮没有 commit** |
| D2 | 三个 APK 原生文件的暂存状态 | `git -C D:\Portable\khy-os status --porcelain -- delivery/mobile/khy-os-client-app/android/app/src/main/` | `A  .../bridge/KhyUi.java`、`A  .../bridge/Tools.java`、`A  .../kotlin/.../MainActivity.kt`（**均已是索引中的新增**）；工作树对这三条路径无未暂存差异（`git diff --stat -- <三条路径>` 输出为空） |
| D3 | 暂存区改动量 | `git -C D:\Portable\khy-os diff --cached --stat`（**注意：本轮期间索引内容发生过变化，见 D3b**） | 当前索引共 **4 个文件**：`KhyUi.java` 282+ / `Tools.java` 413+ / `MainActivity.kt` 1185+（合计 1880 insertions，首次入库的整文件新增）+ `apps/khyos-desktop/src/renderer/components/ui/Tooltip.tsx`（-58，即**暂存的删除**） |
| D3b | 索引里那个无关的删除 | `git -C D:\Portable\khy-os diff --cached -- apps/khyos-desktop/src/renderer/components/ui/Tooltip.tsx` | 是一整个 58 行的 `Tooltip` 组件被**暂存删除**（`deleted file mode 100644`），**与 amoo 无关**。本轮开始时 `git diff --cached --stat` 只有 3 个文件、没有这一条——**它是本轮进行期间被别的环节加进索引的**（本轮没有执行任何 `git add`）。**提交前必须确认这一条是否真的要一起提交**，否则会把一个无关的删除混进 amoo 的提交 |
| D4 | 暂存版 `MainActivity.kt` 的 FLAG 常量 | `git show :<MainActivity.kt> \| findstr /n "FLAG_ACTIVITY_NEW_TASK"` 与 `... \| findstr /n /c:"Intent.FLAG_NEW_TASK"` | 183/197/360/656/748/762/**817**/892/926/949/961 共 11 处，**全部是 `FLAG_ACTIVITY_NEW_TASK`**；`Intent.FLAG_NEW_TASK` **无匹配**（`findstr` exit 1）→ 暂存版第 817 行已是正确常量 |
| D5 | 暂存区空白/格式检查 | `git -C D:\Portable\khy-os diff --cached --check` | exit 0（无空白错误） |
| D6 | `AndroidManifest.xml` / assets 的忽略状态 | `git check-ignore -v .../app/src/main/AndroidManifest.xml .../app/src/main/assets/shizuku/shizuku-release.apk` | `.gitignore:40:AndroidManifest.xml`、`.gitignore:241:*.apk` → **两者仍被忽略** |
| D7 | 未跟踪的原生源码（残留风险） | `git status --porcelain --ignored -- .../app/src/main/` | 仍为 `??`：`bridge/{BootReceiver,BridgeOverlayService,BridgeService,HttpBridge,ReviveReceiver}.java`、`{KhyAccessibilityService,ScreenCaptureService,ShizukuServiceManager}.kt`、`res/`；`!!`：`AndroidManifest.xml`、`assets/` → **按当前索引 commit 仍编不出 APK**（见 §12 风险 5） |
| D8 | 桌面 .mjs 全段复跑 | `node --experimental-strip-types --test "D:\Portable\khy-os\apps\khyos-desktop\tests\keyStore.test.mjs" "…\agentWriters.test.mjs" "…\health.test.mjs" "…\pacedProgress.test.mjs" "…\keymapContract.test.mjs" "…\wiringRuntime.test.mjs" "…\webRemoteHub.test.mjs" "…\amooBridge.test.mjs"`（8 个文件全列；本机 shell 的 `cd` 不改变工作目录，故用绝对路径） | **# tests 68 / # pass 68 / # fail 0**（原 67/68 的唯一失败 `probeBridge 探不到 CLI 时给出可执行的下一步`——`tests/webRemoteHub.test.mjs:128`——**本轮 ok 61 通过**）→ probeBridge 属**环境相关**用例，已不再复现 |
| D9 | 桌面 .cjs 全段复跑 | `node --test "D:\Portable\khy-os\apps\khyos-desktop\tests\keyManagerContract.test.cjs" "…\desktopUiContract.test.cjs" "…\sidebarProjectClassify.test.cjs" "…\webRemotePanel.test.cjs" "…\amooPanel.test.cjs" "…\amooUiContract.test.cjs" "…\usageChartMath.test.cjs"` | **# tests 101 / # pass 101 / # fail 0**（与 §10.1 一致） |
| D10 | Gradle wrapper 实际版本 | 读 `android/gradle/wrapper/gradle-wrapper.properties` | `:10` = `distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-9.8.2-bin.zip`；`:5-8` 注释解释 9.3.1 的 Kotlin DSL 编译损坏、**9.8.2 起修复** → **9.8.2 / `-bin`**，不是 9.3.1 / `-all` |
| D11 | AGP / Kotlin 版本 | 读 `android/settings.gradle.kts:25-26` | `id("com.android.application") version "9.1.0"`、`id("org.jetbrains.kotlin.android") version "2.4.0"` → **AGP 9.1.0**（文档原记无误）、Kotlin 2.4.0 |
| D12 | release APK 产物 | `Get-ChildItem -Recurse build\app\outputs -Include *.apk,*.sha1,output-metadata.json` | `build/app/outputs/apk/release/app-release.apk`（76,529,242 B，2026/10/22 15:04:57）、`build/app/outputs/flutter-apk/app-release.apk`（同尺寸，15:04:58）+ `app-release.apk.sha1` = `b48dfc5cdd754f0b55ee16230ebbdfa001d83404`（15:05:00） |
| D13 | release APK 元数据 | 读 `build/app/outputs/apk/release/output-metadata.json` | `applicationId=com.khyos.khy_os_client`、`variantName=release`、`versionName=1.1.17`、`versionCode=2`、`minSdkVersionForDexing=24`，baselineProfiles 两段齐全 |
| D14 | release APK 签名 | `apksigner.bat verify --print-certs build\app\outputs\apk\release\app-release.apk` | `Signer #1 certificate DN: CN=khy-os, OU=Mobile, O=KhyOS, L=Beijing, ST=Beijing, C=CN` → **用 release key 签名**（非 debug key）；SHA-256 `cb16f14c…9f93d` |
| D15 | release class 里的 amoo 方法 | `javap -p build/app/tmp/kotlin-classes/release/com/khyos/khy_os_client/MainActivity.class` | `private final void amooStatus(MethodChannel$Result)`、`sendToAmoo(String, MethodChannel$Result)`、`openAmoo(MethodChannel$Result)`，以及 `AMOON_PACKAGE` / `AMOON_SHARE_ACTIVITY` / `AMOON_CHAT_ACTIVITY` / `AMOON_OPEN_CHAT` 四个常量 → **amoo 桥接代码确实进了 release 产物** |
| D16 | release class 里的 FLAG 值 | `javap -p -c <同上>.class`（`requestAllFiles` 反汇编） | `33: ldc #219 // int 268435456` → `0x10000000` = `Intent.FLAG_ACTIVITY_NEW_TASK`，**release 产物里是对的** |
| D17 | release javac 产物 | 列 `build/app/intermediates/javac/release/compileReleaseJavaWithJavac/classes/com/khyos/khy_os_client/bridge/` | `Tools.class`、`KhyUi.class`、`HttpBridge*.class`、`BridgeService*.class`、`BridgeOverlayService*.class`、`BootReceiver.class`、`ReviveReceiver.class` 齐全（14:18–15:03） |
| D18 | debug APK | 列 `build/app/outputs/apk/` 与 `build/app/outputs/flutter-apk/` | `apk/` 下**只有 `release/`**，`flutter-apk/` 下**只有 `app-release.apk`** → **未取得 debug APK**；本轮未重跑 debug 构建（不改构建产物） |
| D19 | `Tools.java` / `KhyUi.java` 的 import 行号 | `git show :<Tools.java> \| findstr /n "import"` / `git show :<KhyUi.java> \| findstr /n "import"` | `Tools.java:17 import com.khyos.khy_os_client.KhyAccessibilityService;`（`:16` 是 `import android.widget.Toast;`）、`KhyUi.java:11` 同名 import（`:10` 是 `import android.view.accessibility.AccessibilityNodeInfo;`）→ **v3 文档的 `:16`/`:12` 已更正** |
| D20 | `MainActivity.kt` 的 amoo 行号 | `findstr /n /c:"amooStatus" /c:"sendToAmoo" /c:"openAmoo" <MainActivity.kt>` | 分发 `:156-158`；`amooStatus` `:836`、`sendToAmoo` `:879`、`openAmoo` `:946`；常量 `:1180-1183` → **分发行号由 `:155-158` 更正为 `:156-158`** |
| D21 | 桌面入口接线 | `findstr /n "amoon" /c:"amoo" <SidePane.tsx> <AppLayout.tsx> <CommandCenter.tsx>` | `SidePane.tsx:8` import、`:15` `PaneTabKind` 含 `'amoon'`、`:54` 磁贴、`:81` `case 'amoon'`；`AppLayout.tsx:50` `amoon:'amoo'`、`:194` `openPaneTab('amoon')`；`CommandCenter.tsx:99` `id:'add-amoon-tab'` → **两个桌面入口真实存在** |
| D22 | Settings 是否有 amoo 入口 | `Select-String -Path SettingsPage.tsx -Pattern 'amoon\|amoo' -AllMatches` | **0 命中**；`NAV_GROUPS:29`、`PAGE_META:66`、`'remote':39/:72`、`WebRemoteControlPanel` 嵌入于 `:229` → **§3.3 的非目标结论成立** |
| D23 | `AmoonPane.tsx` 的停止按钮与轮询 | `findstr /n /c:"runtimePresent \|\| phase" <AmoonPane.tsx>`；`findstr /n /c:"useEffect" /c:"amoonStatus" /c:"15000" <AmoonPane.tsx>`；`findstr /n /c:"KHY_AMOON_BRIDGE_DIR" <AmoonPane.tsx>` | 停止按钮条件 `:274` = `runtimePresent \|\| phase === 'running'`（**v3 文档写的 `status.runtime.present` 不完整**）；挂载探测 `:137`（useEffect）/`:153`（`amoonStatus`），15s 轮询 `:172`（`setInterval(..., 15000)`）；env 提示 `:324`、`:375` |
| D24 | 本轮改动范围 | `git -C D:\Portable\khy-os status --porcelain -- delivery/extension/bridges/khy-amoon-bridge/docs/AMOO-INTERACTION.md`；`git -C D:\Portable\khy-os diff --stat`（全仓库，含未暂存） | **本文档本身仍是未跟踪文件（`??`，不在索引、也不在 HEAD）**——本轮按约束只改文档内容，**没有把它 `git add` 进索引**。全仓库 `git diff --stat` 里的其他条目是本轮之前就存在的工作树改动，**不是本轮产生的**。**未新增 Settings 代码**，未改 APK / 桥 / 桌面端源码 |

**本轮明确没有做的事**（避免被误读为已验证）：真机安装与点击、amoo Intent 真机受理、daemon 端到端（`cli start`）、`flutter build apk --debug`、`npm.cmd run typecheck` / `npm.cmd run build` / `flutter analyze` / `flutter test` 的复跑。

---

## 11. 实现顺序

1. 读桥：`lib/contracts.js:476-530`、`lib/server.js:476-560,848-958,1195-1213`、`lib/config.js:34-75,288-308`、`bin/cli.js:142-288`。
2. 主进程 hub + 13 条测试 → 面板 + 6 条 jsdom → 接线 + 6 条源码契约。
3. 桌面 typecheck/build。
4. APK：MainActivity 三方法 + 常量 → AmooService / composer → 设备卡 + 聊天 chip。
5. APK 测试 + analyze；跑 `flutter build apk`（**release 已于 2026-10-22 15:04:57 出包**）→ **真机安装与 amoo Intent 验收**（debug 变体仍未构建，见 §10.2 D18）。

---

## 12. 风险与未验证项

1. **APK 已出包，但未真机验收**（本轮订正）：release 包已于 **2026-10-22 15:04:57** 产出（`app-release.apk`，76,529,242 字节，release 签名 `CN=khy-os`，`versionName=1.1.17 / versionCode=2`，见 §10.2 D12–D17），**「未出包」的风险项已消解，改为「未真机验收」**。仍未做：真机安装与启动、amoo Intent（`ShareActivity` / `ChatMainActivity`）真机点击与受理、真机上的 `amooStatus` 与 `dumpsys` 对照。实现者报告的独立 kotlinc 编译通过与 release 产物都**不能**替代真机点击。**debug APK 未取得**（`build/app/outputs/apk/` 下只有 `release/`），本轮未重跑 debug 构建。
2. **ShareActivity 语义未验证**：只证明注册了 ACTION_SEND text/plain；是直接发送还是打开编辑页未知（`README.md:416,516`）。
3. **exported 未证实**：resolveActivity 由 shell 解析；已用 package-scoped chooser 兜底，失败明确报「入口不可用」。
4. **无送达回执**：桌面 `verified:false`；APK 只知 Intent 被受理；两端都不显示已送达/已读。
5. **入库仍不完整（当前最大的仓库侧风险）**：本轮已把 `MainActivity.kt`、`Tools.java`、`KhyUi.java` 三个文件重新暂存（`A` 状态，暂存版 `MainActivity.kt:817` 已是 `Intent.FLAG_ACTIVITY_NEW_TASK`），但
   - `bridge/` 下 `BootReceiver.java`、`BridgeOverlayService.java`、`BridgeService.java`、`HttpBridge.java`、`ReviveReceiver.java` 与 `KhyAccessibilityService.kt`、`ScreenCaptureService.kt`、`ShizukuServiceManager.kt` 仍为 `??`（未跟踪）——而已暂存的 `MainActivity.kt:16-18` 正好 import 了 `BridgeOverlayService` / `BridgeService` / `HttpBridge`，并在 `:74`、`:369` 起多处引用 `KhyAccessibilityService`；
   - `AndroidManifest.xml` 仍被 `.gitignore:40` 忽略，`assets/shizuku/shizuku-release.apk` 仍被 `.gitignore:241:*.apk` 忽略，`res/` 整体未跟踪（`??`）。

   **结论：按当前索引直接 commit 仍会得到一个编不过（甚至产不出 APK）的提交**——现在能出包只是因为工作树磁盘上文件齐全。建议把「`git stash -u` 后能从索引重建工作树并编出 APK」作为入库门禁，先把上述未跟踪文件与 `.gitignore` 规则一并处理，再提交。**本轮没有 commit，也没有改 `.gitignore`。**
   另注：当前索引里还有一条**与 amoo 无关**的 `apps/khyos-desktop/src/renderer/components/ui/Tooltip.tsx` 暂存删除（见 §10.2 D3b），提交前需确认是否要带上。
6. **`flutter test` 曾触发 pub get**（`Changed 140 dependencies!`，版本号未变）；`pubspec.lock` 在本次前已 modified，无法区分增量。本轮用 `--no-pub` 复跑。
7. **打包态找桥源码**：asar 内上溯失败 → `cliFound=false`，启动禁用并提示 `KHY_AMOON_BRIDGE_DIR`；开发态从 `out/main` 上溯 4 级可用。
8. **启动链路未端到端跑**：`cli start` 会创建目录/token，本轮未执行；start 的 stop-first 只用注入 spawn 测过参数与顺序。
9. **回执可伪造**：任何能写 /sdcard 的应用都能投递 ack/reply；UI 已固定 unverified。
10. **AI 互聊风险**：若未来注册为 LLM 工具，必须加显式开关与深度上限（参考 `khy_ask` 默认关闭）。
11. **Gradle 环境缺陷已修复**（本轮订正）：实现轮次记录的「重解压 wrapper 发行包、清理 `generated-gradle-jars/kotlin-dsl/jars-9` 后 Kotlin DSL 仍失败」属于 **Gradle 9.3.1 的 Kotlin DSL 脚本编译损坏**。本轮实际生效的 wrapper 是 **9.8.2**（`gradle-wrapper.properties:5-10` 注明 9.8.2 起该缺陷已修复），并已于当日 15:04 成功产出 release APK → **该环境缺陷不再成立，不必重复排查**。仅剩「debug 变体未构建」这一未覆盖项（见风险 1）。

---

## 13. 一致性复核（只读代码 + 复跑测试）

> **v3 轮**（只读代码 + 复跑测试）：本轮未修改任何源码，只读文件并复跑测试，然后更新本文。门禁输入：`desktopOk=true apkOk=true apkBuildEnvBlocked=true`。
> **v4 轮**（交付整理，见 §0 与 §10.2）：同样**只改本文档**，把 wrapper 版本、出包状态、probeBridge 计数、版本控制状态、Settings 入口决策这五处与事实对齐；本轮复跑了 .mjs / .cjs 全段测试并核对了 release 产物。

### 13.1 核对矩阵

| 核对项 | 证据（读到的代码/输出） | 结论 |
|---|---|---|
| 桌面入口表 D1 是否真接上 | `SidePane.tsx:15` `PaneTabKind ... 'amoon'`；`:54` `{kind:'amoon',label:'amoo'}`；`:81-82` `case 'amoon': return <AmoonPane />`；`:8` import | 一致，真实接线 |
| 桌面入口表 D2 是否真接上 | `CommandCenter.tsx:99` `id:'add-amoon-tab' ... onPanelAction('addAmoonTab')`；`AppLayout.tsx:194` `case 'addAmoonTab': openPaneTab('amoon')`；`:50` `amoon:'amoo'` | 一致，真实接线 |
| 桌面是否另有 Settings 入口 | 对 `SettingsPage.tsx` 全文件搜 `amoon|amoo` → **0 命中**；`NAV_GROUPS:29`、`PAGE_META:66`、`'remote'` 于 `:39`/`:72`、`:229` 嵌入 `WebRemoteControlPanel` | 无 Settings 入口；与 §1.2 非目标一致。**v4 已定案：保持两个桌面入口，Settings 为显式非目标**（理由与边界条件见 §3.3） |
| 桌面 IPC 是否对齐 | `main/index.ts:772-775` 创建 hub（`bridgeRoot=resolveBridgeRoot(process.env,__dirname)`）；`:785-793` 五个 handle；`preload/index.ts:209-213` 五个 invoke | 同名五对，一致 |
| 桌面主组件名 | 仓库实际是 `AmoonPane.tsx`；**不存在 AmooPanel** | 本文统一写 AmoonPane |
| 桌面按钮是否装饰 | `AmoonPane.tsx` 全部 `<button>` 均有 onClick（停止/确认停止/取消/刷新/启动/发送/读取）；发送与启动有 disabled 条件；回执读取 `disabled={inboxLoading \|\| !canSend}`（`:461`） | 无空壳按钮 |
| APK 主入口是否真接上 | `device_screen_new.dart:178-201` `_capCard(title:'amoo')`，`action` 为 `showAmooComposer` 或 `openChat`，不可用时 `null`（按钮不渲染） | 一致 |
| APK 次入口是否真接上 | `chat_screen_new.dart:873-875` `_quickBtn(... 'amoo', ... showAmooComposer(context, initialText: _input.text))`；快捷栏 `:845-846` 横向滚动 | 一致 |
| APK 是否有 tab / AmooScreen | `lib/main.dart:49` 五个标题；`:112-121` 五个 screen；`:132` `i < 5`；仓库无 `AmooScreen`/`amoo_screen.dart`，实际是 `lib/ui/widgets/amoo_composer.dart` 的 `showAmooComposer` | 无第 6 个 tab、无 AmooScreen；两个入口都指向同一 composer |
| APK 是否用 phone token 调 operator-only | 对 `amoo_service.dart`、`amoo_composer.dart`、`device_screen_new.dart` 搜 `http|dio|token|operator|amoon_send|amoon_inbox`：只有 `amoo_service.dart` 顶部注释解释「为什么不用」；无 HTTP 客户端、无 token 读取。`chat_screen_new.dart` 的 Dio 是其自身 LLM 调用，与 amoo 无关 | 未使用，安全边界成立 |
| APK 原生方法是否真存在 | `MainActivity.kt:156-158` 分发；`:836` `amooStatus`；`:879` `sendToAmoo`；`:946` `openAmoo`；`:1180-1183` 常量；**release class `javap` 实证同三个方法与四个常量都在产物里**（§10.2 D15） | 代码存在且**已进入 release 产物**（2026-10-22 15:04:57，release 签名 `CN=khy-os`）；**仍未真机安装/未真机验收**（见 §10.2、§12 风险 1） |
| APK 兜底是否会外泄文本 | `MainActivity.kt:909-923`：`Intent(ACTION_SEND).setPackage(AMOON_PACKAGE)` → `resolveActivity` 为 null 直接失败；`:925-934` 仅在该 intent 上 `createChooser` | 不会把文本交给任意应用 |
| 是否有自动发送 | desktop：`AmoonPane.tsx` 仅 `onClick={() => void send()}`；APK：`amoo_composer.dart` 仅 `FilledButton.onPressed`，`onSubmitted` 为空 | 无自动发送 |

### 13.2 v3 轮实际跑过的检查

| 命令 | 结果 |
|---|---|
| `cd D:\Portable\khy-os\apps\khyos-desktop && node --experimental-strip-types --test tests/amooBridge.test.mjs` | **13 tests / 13 pass / 0 fail** |
| `cd D:\Portable\khy-os\delivery\mobile\khy-os-client-app && flutter.bat test --no-pub test/amoo_service_test.dart test/amoo_ui_test.dart` | **+17 / All tests passed!** |

v3 轮**未重跑**：`npm.cmd run typecheck`、`npm.cmd run build`、`flutter analyze`、`flutter build apk --debug`。§10.1 中这些结果来自实现轮次，保留原样，不与本轮复跑混写。

**v4（交付整理）轮的检查命令与结果见 §10.2**，与本表分开列，避免把两轮结果混写。

### 13.3 本文按实际实现校正的内容

v3 轮：

1. §6/§10 的入口与 IPC 行号：`main/index.ts` 为 `772-793`（创建在 `772-775`，handle 在 `785-793`）。
2. APK 文件清单补入 `Tools.java`、`KhyUi.java` 的 `KhyAccessibilityService` import 修复，以及 `gradle-wrapper.properties` 的腾讯镜像与 AGP/Gradle 版本注释。
3. §7.2 的 composer 底部提示改为实际文案「本页不读取回执，请在 amoo 中查看回复。」
4. §9.1 补上 `amooBridge.test.mjs:294-298` 对 send/inbox 请求参数的断言。
5. §9.2/§10 的构建命令补 `ANDROID_HOME/ANDROID_SDK_ROOT` 与 `--no-pub`；补「未设 SDK → No Android SDK found」「设 SDK → Kotlin DSL 失败」「独立 kotlinc 编译（实现者报告）」三行。
6. §12 风险 1 改为「未出包」而不是「未编译」：源码有独立编译证据，但 APK 未生成、未真机验证。
7. 明确写死：桌面无 AmooPanel、APK 无 AmooScreen、APK 无第 6 个 tab、Settings 无入口（均为设计现状而非断链）。

v4 轮（交付整理，只改本文）：

8. **Gradle 版本订正**：§6.2 与 §10 的 `gradle-9.3.1-all.zip` / 「Gradle 9.3.1」全部改为 **`gradle-9.8.2-bin.zip`（9.8.2 / `-bin`）**，并补 `AGP 9.1.0`（`settings.gradle.kts:25`）、`Kotlin 2.4.0`（`:26`）；历史条目标注「已被取代」。
9. **出包状态订正**：§10.1 补 release 构建成功一行（2026-10-22 15:04:57，`CN=khy-os` 签名，76,529,242 字节，`1.1.17/2`）；§12 风险 1 从「APK 未出包」改为「**已出包、未真机验收**」；§13.1 的 APK 原生方法行从「未出包/未真机」改为「已进入 release 产物、仍未真机验收」。
10. **probeBridge 订正**：§0.1 M5、§10.1、§10.2 D8 中的 `.mjs` 结果从 `67/68` 改为 **`68/68`**，并注明 probeBridge 是**环境相关**用例（`tests/webRemoteHub.test.mjs:128`）。
11. **版本控制状态订正**：§6.2「版本控制」段与 §12 风险 5 改写为「三个 APK 原生文件已重新暂存（`A`）、暂存版 `MainActivity.kt:817` 已是 `FLAG_ACTIVITY_NEW_TASK`、`AndroidManifest.xml` 仍被 `.gitignore:40` 忽略、**本次没有 commit**」，并新增「入库仍不完整（`bridge/` 其余原生文件与 `res/` 仍 `??`）」的残留风险。
12. **Settings 入口定案**：新增 §3.3「Settings 入口决策（保持两个桌面入口）」，§1.2 / §3.1 / §13.1 同步指向；本轮**未新增任何 Settings 代码**。
13. **行号小订正**：`Tools.java:16` → `:17`、`KhyUi.java:12` → `:11`；`MainActivity.kt` 分发 `:155-158` → `:156-158`；`AmoonPane.tsx` 的 `asStatus` `:97-103` → `:97-102`；停止按钮条件补上 `|| phase === 'running'`（`AmoonPane.tsx:274`）。
14. **§10 拆成两节**：§10.1 实现轮次 / §10.2 本轮交付整理复跑（24 条带精确命令的检查记录）。
