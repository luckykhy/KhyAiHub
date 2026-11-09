# khy-amoon-bridge

KhyOS 与手机 amoon 之间的桥。Phase 1 交付 8 个核心工具 + 4 个受限只读手机工具：
`ping`、`bridge_status`、`khy_ask`、`phone_screenshot`、`phone_ui_dump`、`phone_info`、
`phone_app_list`、`phone_ls`、`phone_exec`、`amoon_send`、`amoon_inbox`、`mailbox_status`。

> **先读这一段：当前状态。**
>
> - **四个模块已经接起来**：`lib/daemon.js` 负责单例装配，启动 HTTP server、ADB 无线生命周期、
>   文件信箱 poller 和任务队列；`lib/registry.js` 只注册 12 个 wire 工具（本地 PC 工具不暴露，
>   仅作为 khy_ask 的内部 runner）；
>   `lib/bridge-tools.js` 实现 ping / bridge_status / khy_ask / amoon_send / amoon_inbox / mailbox_status。
> - MCP stdio 前端（`lib/mcp.js`）、KhyOS 发现与注册助手（`lib/khy-tools.js`）、manifest、
>   安装/启动/诊断脚本、测试与本文档均已落地。
> - **仍未验证的是真机行为**：screencap/uiautomator/input 的实际输出、adb reverse 往返、
>   Doze/锁屏、amoon 的 Phase 0 三项能力。没有这些证据时，`amoon → PC` 一律是 `unverified`。
> - `start` 只启动本机 daemon；没有设备时只降级（`DEGRADED_ADB`），HTTP `/health` 仍可用，
>   不会假装手机工具成功。

---

## 1. 它能做什么（以及不做什么）

### Phase 1 的 12 个工具（8 核心 + 4 受限只读）

| 工具 | side | risk | scope | 说明 |
| --- | --- | --- | --- | --- |
| `ping` | pc | low | operator / phone / file | 最小连通性检查，不访问手机、不触发模型 |
| `bridge_status` | pc | low | operator / phone / file | 状态机、ADB、reverse、信箱、能力矩阵；phone/file 会裁剪敏感字段 |
| `khy_ask` | khyos | medium | operator（phone 默认关闭） | 一次性提问 KhyOS；phone 开启后强制 `max_turns=1`、空 cwd、哨兵 allowlist |
| `phone_screenshot` | phone | medium | operator | `adb exec-out screencap -p`，默认落盘 24h，`inline` 受 8MB 上限约束 |
| `phone_ui_dump` | phone | medium | operator | `uiautomator dump`，最多 500 节点/1MB，不区分聊天角色 |
| `phone_info` | phone | low | operator | 只读设备信息：serial/model/brand/sdk/release/屏幕/电量/亮屏/锁屏/唤醒 |
| `phone_app_list` | phone | low | operator | 只读 `pm list packages` + 前台 activity；不能启停应用 |
| `phone_ls` | phone | medium | operator | 受限目录列表：仅 `/sdcard/khy-amoon-bridge`、Download、Documents、Pictures、DCIM 及 `/sdcard` 顶层；realpath 复检，拒绝 `..` 与符号链接逃逸 |
| `phone_exec` | phone | medium | operator | 固定诊断 op：`echo` / `getprop <白名单 key>` / `wm_size` / `pm_list` / `dumpsys_battery`；**不是手机 shell**，拒绝管道/重定向/`;`/`$()`/反引号/换行/未知 op |
| `amoon_send` | amoon | medium | operator | 先写本地 spool，再 push 到手机 outbox（tmp+mv）；任一通道成功后把 spool 移入 `outbox/sent/`（失败则删除），返回 `spool_retired`，后续 flush 不会重发；intent 只报告启动成功 |
| `amoon_inbox` | amoon | low | operator | 读取本地 replies/ack 索引；文件来源一律 `unverified` |
| `mailbox_status` | mailbox | low | operator / phone / file | 信箱状态、当前 inbox/working 深度、累计扫描数、上次轮询、adb 可用性、能力状态 |

Phase 2 名称（`phone_ui_tap`、`phone_ui_swipe`、`phone_key`、`phone_text`、
`phone_file_push`、`phone_file_pull`、`amoon_ui_send`、`amoon_read_chat`）**不在 Phase 1 注册**，
`tools/list` 不会出现。

文档里的 `phone.info`、`phone.app.list`、`phone.exec`、`phone.ls` 是注册名
`phone_info`、`phone_app_list`、`phone_exec`、`phone_ls` 的点号简写；HTTP、CLI、MCP 调用都会
归一化为下划线名。`phone.shot` 是 `phone_screenshot` 的显式别名。`khy.ask` 这类本地工具名
**不会**被别名化成已注册工具。

### restricted 与 prohibited 的边界

这是对参考项目 StepBridge 的**故意收窄**：保留只读状态/应用/目录/诊断能力，拒绝任意命令执行。

- **restricted（已注册，operator only）**：`phone_info`、`phone_app_list`、`phone_ls`、`phone_exec`。
  - `phone_exec` 只接受结构化 `{op,...}`，命令模板固定；用户值经 `shQuote` 且先过元字符拒绝。
  - `phone_ls` 只列白名单根；设备侧 `realpath -e` 后再做前缀校验。
  - `phone_app_list` 只读包列表/前台 activity，不能 start/stop。
- **prohibited（永不注册）**：`phone_shell`、`phone_su`、`phone_read`、`phone_write`、
  `phone_app_start`、`phone_app_stop`、通知、task/agent 控制。任何“任意手机 shell”都不提供。

### 明确不做

- 不新建/修改手机 App，不使用无障碍服务，不 root，不执行 `adb root/remount`。
- 不提供 `phone_shell` 或任意手机/PC shell。
- 不把 KhyOS 的任意 MCP/内置工具透传给手机；file scope 不包含 `khy_ask`。
- 不做 LAN 监听、TLS、多用户/OAuth；只绑 `127.0.0.1` + `adb reverse`。
- 不做开机自启/Windows 服务；daemon 按需启动。
- Phase 1 不做文件信箱 HMAC（手机缺 `openssl`/`sha256hmac`），ack/reply 一律不可信。
- 不把审计哈希链说成防篡改；它只让本机管理员篡改可见。

---

## 2. 架构

```text
KhyOS CLI / TUI
  │  MCP stdio（换行 JSON-RPC 2.0；stdout 只出协议）
  ▼
bin/mcp-server.js ──► lib/mcp.js（本目录）
  │  HTTP 127.0.0.1:<port>，Bearer operator
  ▼
amoon-bridge daemon（模块 A；单例，per Windows user）
  ├─ HTTP server：Host/Origin、auth、限流、per-tool cap、202/jobs
  ├─ registry：schema → scope/risk → 幂等 → 审计 → handler（模块 C）
  ├─ mailbox poller：adb exec-out ls/cat/mv，worker pool=2（模块 C）
  ├─ adb lifecycle：resolve → connect → 校验 serial → reverse → keepalive（模块 B）
  └─ khy runner：spawn node khy.js -p（sentinel/system-prompt/depth guard）（模块 C）
        │ adb.exe（永远 -s <serial>）
        ▼
Android adbd（无线 TLS）
  ├─ adb reverse tcp:<port> → PC 127.0.0.1:<port>
  ├─ shell：curl / uiautomator / screencap / am / dumpsys（无 phone_shell 工具）
  ├─ amoon com.stepos.ailauncher（ChatMainActivity / ShareActivity）
  └─ /sdcard/khy-amoon-bridge/{inbox,outbox,working,done,failed,tmp,blobs}
```

两条通道：

1. **HTTP 快通道**：手机 `127.0.0.1:<port>` → `adb reverse` → PC loopback。
   Bearer phone token 默认只有 `ping`/`bridge_status`/`mailbox_status`；`khy_ask` 默认关闭。
2. **文件慢通道**：`/sdcard/khy-amoon-bridge` 文件信箱。没有 Bearer，投递者一律映射为独立
   `file` scope，只允许 `ping`/`bridge_status`/`mailbox_status`；不触发模型、不控制手机。

HTTP 端点（`/v1/*` 与 `/health` 等价短路径）：

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /health` | 无 | 只返回 `{ok:true}`，不暴露 pid/版本/serial |
| `GET /v1/status` | 任意 scope | 状态；phone/file 只看到本 scope 的工具名，`tasks.state_dir` 被裁掉 |
| `GET /v1/tools` | 任意 scope | 当前 scope 可见的工具描述 |
| `POST /v1/call` | 任意 scope | 工具调用；`body.id`（8..64）是幂等键：同 id 同参数重放（`replayed:true`），同 id 不同参数 409 `id_conflict`；`khy_ask` 等长任务可 `wait_ms`，否则 202 + job id |
| `GET /v1/jobs/:id` | operator | 202 job 的查询；`/v1/jobs/<id>`（短路径 `/jobs/<id>`） |
| `POST /v1/rotate` | operator | 两阶段轮换第 1 步：返回新 phone token，**旧 token 仍有效** |
| `POST /v1/rotate/commit` | operator | 第 2 步：`{record_id}`，推送成功后使旧 phone token 失效 |
| `GET /v1/audit/tail?n=100` | operator | 审计尾部（脱敏，带 seq/prev） |

`KHY_AMOON_ENABLED=0` 时 registry 只放行 `ping`/`bridge_status`/`mailbox_status`，其它工具返回
`bridge_disabled`；HTTP 诊断端点仍可用于排障。

---

## 3. 文件与模块归属

| 文件 | 作用 | 归属 |
| --- | --- | --- |
| `lib/contracts.js` | **冻结契约**：12 个工具、错误码、路径、限制、模块接口 | A（只增不改） |
| `lib/config.js` / `lib/logger.js` | per-user 配置、fail-closed token 读取、JSON 日志 | A |
| `lib/mcp.js` | **MCP stdio 前端 + daemon HTTP 客户端**（initialize/tools/list/tools/call/ping） | D（本模块） |
| `lib/khy-tools.js` | KhyOS 发现、`getMcpServerEntry`、`khy mcp add/remove` argv、mcp.json 只读检查 | D（本模块） |
| `bin/mcp-server.js` | 极薄入口：argv + 启动 `lib/mcp.js` | D（本模块） |
| `bin/cli.js` | 命令分发（start/stop/status/doctor/call/phone/install/uninstall） | A |
| `lib/daemon.js` / `bin/daemon.js` | 单例锁、装配 HTTP+wireless+mailbox+tasks、runtime.json、PID 身份停止 | A（集成） |
| `lib/registry.js` / `lib/bridge-tools.js` | 12 个 wire 工具、scope 门禁、phone/amoon/mailbox 适配 | A/C（集成） |
| `lib/server.js` / `lib/local-tools.js` | loopback HTTP 前端、鉴权/审计/限流；本地工具仅供 khy_ask 内部使用，**不注册到 registry** | A |
| `lib/auth.js`、`lib/audit.js` | 鉴权、审计哈希链、日志 | A |
| `lib/errors.js` / `lib/ids.js` | 错误码表/BridgeError 再导出；id 生成与校验 | A |
| `lib/ratelimit.js` / `lib/idempotency.js` | 固定窗口限流；`body.id` 幂等/重放/冲突存储 | A |
| `lib/adb.js`、`lib/wireless.js`、`lib/phone-tools.js` | ADB 传输、无线生命周期/reverse、phone_* 处理器 | B |
| `lib/mailbox.js`、`lib/tasks.js` | 文件信箱 poller、持久任务队列 | C |
| `lib/adb/*`、`lib/tools/*`、`lib/mailbox/*`、`lib/mcp/*`、`lib/http/*` | 契约路径的薄 re-export shim（见 `contracts.SHIMS`） | 集成 |
| `lib/bootstrap.js`、`phone/**`（`README.md`/`tools.json`/`kb`）、`scripts/deploy-phone.js`、`docs/PHASE0.md` | 手机侧资产与部署（bootstrap 额外写 `port.txt`，提供 token 时写 `token.txt`） | D（其它任务） |
| `scripts/install.ps1` / `start.ps1` / `doctor.ps1` | 安装、启动、只读诊断 | D（本模块） |
| `test/mcp.test.js` / `test/manifest.test.js` / `test/registry.test.js` | MCP 握手、工具表、manifest、scope/kill-switch 校验（不需要真机） | D（本模块） |

跨模块只通过 `lib/contracts.js` 的 `MODULES[*].exports` 调用。`lib/mcp.js` 不碰 ADB、信箱或
工具处理器；`tools/call` 只走 HTTP。

---

## 4. 前置条件

- Windows 10/11，PowerShell 5.1+。
- Node **>= 22**（本机实测 `v22.18.0`，位置 `D:\Portable\Tools\commandcode\npm-global\node.exe`）。
- Android platform-tools 的 `adb`。本机不在 PATH，位于
  `D:\Portable\Tools\platform-tools\adb.exe`；脚本会自动找到它。
- KhyOS 便携版（本机 `D:\Portable\khy-os`，后端版本 `1.2.1`）。
- 手机已开启开发者选项与无线调试，并已授权本机（见第 6 节）。

---

## 5. 一次性安装

```powershell
# 在仓库根目录（khy-amoon-bridge）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

等价的 CLI 路径（只做 token + MCP 注册；手机侧资产由 install.ps1/bootstrap 负责）：

```powershell
node bin\cli.js install --scope user --dry-run   # 只打印将执行的 khy mcp add 命令
node bin\cli.js install --scope user             # 现有 amoon 注册不会被覆盖，除非加 --force
node bin\cli.js uninstall --scope user --dry-run # 打印 khy mcp remove 命令
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-Scope user\|project` | 写入用户级或项目级 `mcp.json`（默认 `user`） |
| `-Serial <adb serial>` | 显式指定设备，避免双 transport 误操作 |
| `-StateDir <dir>` | 覆盖状态目录（默认 `%LOCALAPPDATA%\khy-amoon-bridge`） |
| `-KhyJs <path>` | 显式指定 KhyOS 的 `khy.js` |
| `-SkipMcp` / `-SkipPhone` | 只做其中一半 |
| `-RotatePhoneToken` | 强制轮换 phone token（bootstrap 分支会重新生成并推送 `token.txt`） |
| `-OpenChat` | 仅透传给 `scripts/deploy-phone.js`；bootstrap 分支不打开聊天 |
| `-Force` | 允许覆盖已存在的 `amoon` 注册（默认不覆盖） |
| `-DryRun` | 只打印计划，不落盘、不执行 `khy mcp add` |
| `-Json` | 机器可读输出 |

`install.ps1` 实际做的事：

1. 检查 Node >= 22；解析 ADB（缺失只警告，不阻止 MCP 注册）。
2. 创建 `%LOCALAPPDATA%\khy-amoon-bridge` 及其子目录，生成 `operator.token`
   （32 字节随机，`khy_` 前缀；用 `icacls /inheritance:r /grant:r` 限定当前用户；
   ACL 失败会删除 token 并以退出码 1 中止）。
3. 若有设备 serial：优先调用 `scripts/deploy-phone.js`；否则调用 `lib/bootstrap.js`：
   创建 `/sdcard/khy-amoon-bridge/{inbox,outbox,working,done,failed,tmp,blobs,examples}`，
   推送 `phone/README.md`、`phone/tools.json`、`phone/kb`（LF 归一、tmp+mv），写 `port.txt`；
   若手机上没有 `token.txt`（或显式 `-RotatePhoneToken`），先 `TokenStore.issuePhone()`
   生成 **phone scope** token 并推送 `token.txt`；只有 bootstrap 确认推送成功后才
   `commitPhoneRotation(record_id)` 使旧 token 失效（operator token 永不下发）。
   推送失败时旧 phone token 仍有效。
   两者都不存在时明确打印「已跳过」，不影响 MCP 注册。
4. 自动发现 `khy.js`（`KHY_JS` → `KHY_HOME` → 祖先目录 → `D:\Portable\khy-os`），
   生成**绝对路径**的 MCP 入口，执行：

   ```text
   & <node.exe> <khy.js> mcp add amoon --scope user -- <node.exe> <...\bin\mcp-server.js> \
       --root <...\khy-amoon-bridge> --state-dir <...\khy-amoon-bridge> --khy-js <khy.js>
   ```

5. 回读 `mcp.json` 校验入口一致，并打印回滚命令。

> 为什么必须是绝对路径：KhyOS 启动 MCP server 时不传 cwd（勘察 `services/domain/messaging/mcp/index.js`），
> 相对路径的 `bin/mcp-server.js` 会解析到错误目录。

### 手工注册（等价命令）

```powershell
& 'D:\Portable\Tools\commandcode\npm-global\node.exe' `
  'D:\Portable\khy-os\runtime\node\backend\bin\khy.js' `
  mcp add amoon --scope user -- `
  'D:\Portable\Tools\commandcode\npm-global\node.exe' `
  'D:\Portable\khy-os\delivery\extension\bridges\khy-amoon-bridge\bin\mcp-server.js' `
  --root 'D:\Portable\khy-os\delivery\extension\bridges\khy-amoon-bridge' `
  --state-dir "$env:LOCALAPPDATA\khy-amoon-bridge" `
  --khy-js 'D:\Portable\khy-os\runtime\node\backend\bin\khy.js'
```

落盘位置（按 KhyOS 当前实现）：

- `user` scope：`KHY_DATA_HOME/mcp.json`，本机即 `D:\Portable\khy-os\works\data\khy\mcp.json`；
- `project` scope：`<当前目录>/works/data/khy/mcp.json`（不是 `.khy/mcp.json`）。

`khy.extension.json` 里的 `mcp` 块只是**声明**：核里没有 `manifest.mcp` 消费者，不会自动注册。

---

## 6. 无线调试配对

```powershell
# 1. 手机：开发者选项 → 无线调试 → 使用配对码配对
adb pair 192.168.2.46:<pair_port> <6位配对码>

# 2. 配对成功后，用「无线调试」页面显示的 IP:端口连接（不是配对端口）
adb connect 192.168.2.46:<connect_port>

# 3. 确认状态与 serial
adb devices -l
adb -s 192.168.2.46:<connect_port> getprop ro.serialno
```

注意事项（来自本机勘察）：

- 同一台设备可能同时出现两个 `_adb-tls-connect._tcp` 端口（实测 `33743` 与 `37925`）。
  **所有命令都必须带 `-s <serial>`**；不带 `-s` 的 `adb reverse --list` 会直接报
  `more than one device/emulator`。
- 连接后必须校验 `ro.serialno`（本机 `ZYPZ261A01M6870010L`），防止操作到另一台设备。
- 配对码不要写进日志/审计/脚本；`install.ps1` 也不处理配对。
- `unauthorized`：在手机上允许 USB 调试并勾选「始终允许」；`offline`：先
  `adb disconnect <serial>` 再重连。

`install.ps1` 不会替你配对，只会使用已经 `device` 状态的设备；没有设备时跳过手机部署。

---

## 7. 启动与停止

```powershell
# 启动 daemon（后台单例）并等待 /health
node bin\cli.js start
# 或
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1

# 只读状态（配置 + runtime + /health + bridge_status）
node bin\cli.js status --json

# 停止（核对 PID 身份；拒绝误杀，清理本端口 reverse）
node bin\cli.js stop
```

`start` 的实际行为：

1. 已存在 `runtime.json` 且 `/health` 可达 → 直接报告「已在运行」，不重复启动；
2. 创建状态目录与 `operator.token`（缺失时），然后后台 spawn `bin/daemon.js`；
3. daemon 先绑定 `127.0.0.1`（端口被占会在 18765..18774 内换端口），写 `runtime.json`，
   再异步启动 wireless 与 mailbox；ADB 不可用只降级为 `DEGRADED_ADB`，HTTP 仍可用；
4. CLI 轮询 `runtime.json` 与 `/health`（最多 15s），失败时打印 `daemon.log` 尾部并以退出码 3 结束。

调试时可前台运行（不要与后台实例同时启动）：

```powershell
node bin\cli.js start --foreground --state-dir "$env:TEMP\amoon-debug"
```

`stop` 会先用 `Get-CimInstance Win32_Process` 核对 `runtime.json` 里的 pid 确实是
`bin/daemon.js`；身份不符时拒绝停止（`--force` 才跳过）。daemon 正常退出时会
`adb reverse --remove tcp:<port>`，只管理自己的端口，绝不使用 `--remove-all`。

---

## 8. 在 KhyOS 里使用

注册成功后，KhyOS 把工具暴露为 `mcp__amoon__<tool>`（例如 `mcp__amoon__ping`）。

```powershell
# 查看注册
node D:\Portable\khy-os\runtime\node\backend\bin\khy.js mcp show amoon

# 实际调用（会消耗模型 token；这才是验收）
node D:\Portable\khy-os\runtime\node\backend\bin\khy.js -p "调用 mcp__amoon__ping 并只返回 pong" `
  --allowedTools mcp__amoon__ping --output-format json --max-turns 2
```

> **`khy mcp test` 不是验收。** 它只做 connect + `tools/list`（`handlers/mcp.js` 的 test 分支），
> 不执行 `tools/call`；daemon/adb/reverse/信箱坏了它也可能「成功」。

> **路由兼容**：`lib/mcp.js` 优先 `POST /v1/call`，若收到 404（说明 daemon 只实现了 `/call`，
> 当前 `lib/server.js` 就是这种形态）会自动回退到 `/call` 一次；`/v1/status` → `/status` 同理。
> 工具域失败始终是 HTTP 200 + `ok:false`，不会被误判成 404。

在 KhyOS 会话中直接说「用 amoon 截图」「问 KhyOS 一个问题」即可；模型会按工具描述选择
`mcp__amoon__phone_screenshot` / `mcp__amoon__khy_ask` 等。

### 工具调用失败时

`tools/call` 的错误以 MCP `isError:true` 返回，文本以 `[错误码]` 开头：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `daemon_unavailable` | daemon 未启动/不可达 | `scripts\start.ps1`，再 `doctor.ps1` |
| `auth_unavailable` | operator.token 缺失/过短 | 重跑 `install.ps1` |
| `adb_unavailable` | 设备不可用 | 检查 `adb devices -l`、重新 `adb connect` |
| `device_ambiguous` | 多台设备 | 设置 `KHY_AMOON_SERIAL` 或用 `-Serial` |
| `forbidden_scope` | token scope 不允许 | 别用 phone/file token 调 operator 工具 |
| `phone_ask_disabled` | 手机侧 `khy_ask` 默认关闭 | 需要 `KHY_AMOON_PHONE_ASK=1` 且 `capability.http=true` |
| `rate_limited` | 触发限流 | 稍后重试；phone ask 为 3/min、20/day |
| `timeout` | 工具超时 | 见第 11 节 |
| `not_implemented` | 该功能未接线（Phase 2 工具、单独调用 routes shim 等） | 看错误文本；Phase 1 的 12 个工具不应出现此码 |

---

## 9. 手机 amoon 侧

### 9.1 Phase 0 门（双向的前提）

`amoon → PC` 只有在 **amoon 自己**完成下面三项并留下证据后，才允许宣称可用：

1. 执行 `sh /sdcard/khy-amoon-bridge/kb health`；
2. 写 `/sdcard/khy-amoon-bridge/inbox/cmd_<id>.json`；
3. 对 `127.0.0.1:<port>/health` 发一次 HTTP 请求。

证据写入 `%LOCALAPPDATA%\khy-amoon-bridge\capability.json`
（`status` = `unverified|partial|verified|unavailable`）。**不能用 PC 侧 `adb shell` 代跑冒充**：
那只能证明 adb 能用，不能证明 amoon 有 shell/文件/HTTP 能力。

三项全失败 → 只交付 `KhyOS → 手机` + 人工中转；README 和 `bridge_status` 都必须显示单向。
完整标准、证据格式与判定规则见 `docs/PHASE0.md`；生成探测指令用
`node scripts\probe-amoon.js instructions`，人工记录用
`node scripts\probe-amoon.js record --shell --http --file-write --by <name>`。
`doctor.ps1` 在缺少 `capability.json` 时按 `unverified` 处理。

### 9.2 HTTP 快通道（amoon 能联网时）

```sh
# bootstrap 的默认布局：token.txt + port.txt
# phone/kb 会优先读契约路径 token / config.json（若存在），否则回退到这两个文件。
TOKEN=$(cat /sdcard/khy-amoon-bridge/token.txt)
PORT=$(cat /sdcard/khy-amoon-bridge/port.txt)

curl --noproxy '*' -sS --max-time 60 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"tool":"ping","args":{}}' \
  "http://127.0.0.1:$PORT/v1/call"
```

- phone token 默认只有 `ping`/`bridge_status`/`mailbox_status`；
- `khy_ask` 默认关闭；开启需要 `KHY_AMOON_PHONE_ASK=1` 且 `capability.http=true`；
- token 位于 `/sdcard/khy-amoon-bridge/token.txt`，任何有存储权限的 App 都可能读取；7 天 TTL + rotate。

### 9.3 文件慢通道（amoon 只能读写 /sdcard 时）

```sh
# 写命令：先 tmp，再 mv（同一 FUSE 卷 rename 原子）
cat > /sdcard/khy-amoon-bridge/tmp/cmd_demo01.json.tmp <<'EOF'
{"v":1,"id":"demo01","tool":"ping","args":{}}
EOF
mv /sdcard/khy-amoon-bridge/tmp/cmd_demo01.json.tmp \
   /sdcard/khy-amoon-bridge/inbox/cmd_demo01.json

# 读结果
cat /sdcard/khy-amoon-bridge/outbox/res_demo01.json
```

- 文件 scope 只允许三个只读工具；`khy_ask`/`amoon_send`/`phone_*` 一律 `forbidden_scope`；
- 结果先写再删命令；结果带 `args_digest`：同 id 同参数重放会标 `replayed`，同 id 不同参数写 `id_conflict` 并把原结果归档为 `res_<id>.conflict_*.json`；
- daemon 崩溃恢复把 `working/` 里的幂等命令放回 `inbox/` 重试，只有放回失败才写 `abandoned`；
- `ack_`/`reply_` 文件可以被任何能写 `/sdcard` 的 App 伪造，KhyOS 只当投递提示，不当可信回执；
- Doze 下只承诺「PC 排队/轮询，amoon 运行时投递」；amoon 在 Doze 能否读写需要 Phase 0 证据。

`kb` 用法（部署后）：

```sh
sh /sdcard/khy-amoon-bridge/kb health
sh /sdcard/khy-amoon-bridge/kb tools
sh /sdcard/khy-amoon-bridge/kb call /sdcard/khy-amoon-bridge/examples/ping.json
sh /sdcard/khy-amoon-bridge/kb status
```

### 9.4 KhyOS → amoon 的可靠性边界

- `amoon_send(mode=file)`：只保证「PC 已把文件放到手机 outbox」，**不保证 amoon 读取**；
  `ack` 之前状态最多 `pushed`。
- `mode=intent`：只报告 `am start` 启动成功，不保证直接发送；ShareActivity 的语义未验证。
- 中文不要走 `input text`（实测非 ASCII 会 NPE）；中文走文件或 Intent。
- Phase 1 读回复：`amoon_inbox`（unverified）或 `phone_ui_dump`（只读可见节点，不能区分角色）。

---

## 10. 安全模型

- **监听面**：HTTP 只 `listen(port, '127.0.0.1')`；手机只经 `adb reverse` 访问；不绑 `0.0.0.0`。
- **Host/Origin**：拒绝任何 `Origin`；`Host` 只接受 `127.0.0.1:<port>` / `localhost:<port>`；无 CORS。
- **token**：`crypto.randomBytes(32)` → `khy_+base64url`；`tokens.json` 只存 sha256/scope/expires/last_used；
  比较用 sha256 后 `crypto.timingSafeEqual`；缺失/损坏/过短 → `auth_unavailable`（fail-closed）。
- **scope**：
  - `operator`：Phase 1 全部工具；
  - `phone`：`ping`/`bridge_status`/`mailbox_status`，`khy_ask` 默认关闭；
  - `file`：只有 `ping`/`bridge_status`/`mailbox_status`，永不 `khy_ask`。
- **khy_ask 无工具隔离**：`--allowedTools __khy_amoon_no_tools__`（哨兵使网关非空但过滤所有真实工具）、
  固定 `--system-prompt`、`KHY_MCP_AUTOCONNECT=false`、`KHY_AMOON_DEPTH=1`、phone 固定空 cwd。
  这仍不是绝对隔离（全局 skills 是否被完全覆盖未验证），所以 phone 默认关闭。
- **Windows 权限**：NTFS 上 `fs.chmod(0600)` 无效（实测 `stat.mode` 仍为 666），必须用 `icacls`；
  `ensureTokenFile` 在 ACL 无法收紧时 **fail-closed**。daemon 启动时只对**空目录**执行
  `icacls /inheritance:r /grant:r 当前用户`；对已有内容的目录改用非破坏性的
  `/grant:r 当前用户:(OI)(CI)F`，避免清掉既有文件继承的 ACE（否则 `capability.json` 会变成不可读）。
  目录 ACL 收紧失败仍拒绝启动；单个 token/状态文件仍按文件级 `icacls` 收紧。
- **PID 身份**：停止 daemon 前用 `Get-CimInstance Win32_Process` 核对 exe/cmdline/创建时间，
  拒绝误杀（模块 A 实现）。
- **危险工具**：Phase 1 无 `phone_shell`/`phone_su`；`phone_exec` 是固定诊断 op 白名单，
  `phone_ls` 只列白名单目录，`phone_app_list` 只读；Phase 2 的 tap/swipe/ui_send 默认
  `KHY_AMOON_ALLOW_HIGH_RISK=0`。restricted 与 prohibited 的完整边界见第 1 节。
- **截图/聊天**：可能含验证码/聊天内容；默认落盘 24h、截图目录启动时 icacls 收紧到当前用户、
  审计只记摘要。
- **adbd 本身是特权通道**：能连 adb 的攻击者已可控制手机；本设计不解决 adbd 被攻陷。
- **无 TLS**：token 明文只出现在 loopback 与 ADB TLS 隧道内；不做 LAN fallback。

---

## 11. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `khy` 里看不到 `mcp__amoon__*` | mcp.json 未注册 / 未重启 KhyOS | `khy mcp show amoon`；重开会话或 `khy mcp` 查看连接 |
| `khy mcp test` 成功但调用失败 | test 只 listTools | 用第 8 节的 `khy -p` 做真实 tools/call |
| `daemon_unavailable` | daemon 未启动/崩溃 | `scripts\start.ps1`；`doctor.ps1`；看 `daemon.log` |
| `auth_unavailable` | token 缺失/过短/损坏 | 重跑 `install.ps1`；`doctor.ps1` 看 ACL |
| `adb_unavailable` | 未连接/未授权/无线调试关闭 | `adb devices -l`；`adb connect`；重新配对 |
| `device_ambiguous` | 双 transport（33743/37925）或多设备 | 设置 `KHY_AMOON_SERIAL`，所有命令带 `-s` |
| `reverse` 为空 | daemon 未启动/reverse 丢失 | `doctor.ps1`；重启 daemon；不要用 `--remove-all` |
| 手机 `/sdcard/khy-amoon-bridge` 不存在 | 未部署 / 无存储权限 | `install.ps1`；确认 `MANAGE_EXTERNAL_STORAGE: granted=true` |
| `phone_ask_disabled` | phone `khy_ask` 默认关闭 | 需要 `KHY_AMOON_PHONE_ASK=1` 且 capability.http=true |
| `timeout` | KhyOS MCP 请求 60s，`khy_ask` 默认 45s | 降低问题复杂度；长任务走 HTTP `/v1/jobs`（MCP 无 job 工具） |
| `not_implemented` | 功能未接线（Phase 2 工具或内部 shim） | 看错误文本；Phase 1 工具已全部注册 |
| 中文字符串在脚本里乱码 | PowerShell 5.1 读无 BOM UTF-8 | 三个 `.ps1` 已写 UTF-8 BOM；手工改文件时保留 BOM |

诊断命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Json
```

`doctor.ps1` 只读：node / 状态目录 / token+ACL / daemon `/health` / Phase 0 状态 /
adb / 设备与 serial / reverse / 手机关键文件 / KhyOS mcp.json 注册一致性。
存在 `fail` 时退出码 1；只有 `warn` 时退出码 0。

---

## 12. 卸载与回滚

按顺序执行，避免留下后台进程或残留映射：

```powershell
# 1. 停止 daemon（模块 A；会先核对 PID 身份）
node bin\cli.js stop

# 2. 移除 MCP 注册（回滚命令；scope 与安装时一致）
& 'D:\Portable\Tools\commandcode\npm-global\node.exe' `
  'D:\Portable\khy-os\runtime\node\backend\bin\khy.js' `
  mcp remove amoon --scope user

# 3. 只移除本桥的 reverse（不要用 --remove-all）
adb -s <serial> reverse --remove tcp:18765

# 4. 删除本地状态（token、审计、截图、jobs）
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\khy-amoon-bridge"

# 5. （经确认后）删除手机侧目录
adb -s <serial> shell "rm -rf /sdcard/khy-amoon-bridge"
```

不要 `adb kill-server`，不要改无线调试配置，不要删除 `mcp.json` 里的其它 server。

---

## 13. 未验证清单（不要当成结论）

以下动态行为仍未在真机验证（部分真机检查见 13.1；其余为尚未覆盖的场景）：

- 真机 `screencap`/`uiautomator`/`input` 的实际输出、锁屏/Doze 边界。
- `adb reverse` 在真机上的实际往返（fake adb 只验证了命令序列）。
- amoon 的 shell/文件/HTTP 能力（Phase 0 才能回答）。
- ShareActivity 的 Intent 语义（直接发送还是打开编辑页）。
- **真实用户 `mcp.json` 的写入**：本次只跑了 `install --dry-run`；模块 D 之前用临时
  `KHY_DATA_HOME` 验证过 `khy mcp add/remove`，没有改动
  `D:\Portable\khy-os\works\data\khy\mcp.json`（回读仍只有 `deepseek-eyes`）。
- `khy -p` 真实 tools/call 验收（会消耗模型 token）。
- `README.html` 孪生与仓库门（`npm run check:layout`、`docs:build/verify`）。

**集成阶段已修复的缺口**：

1. `lib/daemon.js` 已落地：单例锁 + PID 身份、runtime.json、端口扫描、`server + wireless +
   mailbox + tasks` 装配、优雅停止（清理 reverse 与全部定时器）。`bin/cli.js start/stop/status`
   不再返回 `not_implemented`。
2. `lib/registry.js` 只注册 12 个 wire 工具；`/v1/call` 与 `/call`
   都可路由；`bridge_status`/`khy_ask`/`phone_*`/`amoon_*`/`mailbox_status` 已注册。
3. `lib/server.js` 增加 `/v1/*` 别名，并把认证得到的 principal（operator/phone）传入
   `tools.call`；phone token 现在能按 `phone` scope 被校验。
4. 契约路径与单文件交付的差异用薄 shim 收敛，清单见 `lib/contracts.js` 的 `SHIMS`。

### 13.1 集成后的实际运行记录（可复核）

| 命令 | 结果 |
| --- | --- |
| `cd delivery/extension/bridges/khy-amoon-bridge && node --test` | **2026-11-03 实测 196 例 / 196 passed / 0 failed / 0 skipped**（18 个测试文件全量；同夜 2026-11-02 复跑一次，结果相同。含 restricted 工具、registry scope/kill-switch、ack/reply、rotate/audit/jobs、Phase 0 capability、HTTP idempotency、ids/ratelimit 用例）。⚠ 其中 `test/local-tools.test.js`（20 例）含剪贴板用例，**会写真实系统剪贴板**（先读后写 + restore 重试，失败会响亮报错）——本行数字含它；不想动本机剪贴板时按 `node --test test/adb.test.js …` 逐个列文件跳过它（2026-11-02 同批实测：跳过该文件后其余 17 个文件 176 例 / 176 passed / 0 failed） |
| `node --test test\integration.test.js` | 2 例 / 2 passed（2026-11-02 测得）：fake adb 下 daemon 装配、`/health`、`/v1/call`、MCP→daemon、`HEALTHY`、mailbox 启动、file scope 拒绝、shutdown 清理 reverse/runtime/lock；`sameIdentity` 只认 daemon.js + 同 exe |
| `node bin\cli.js --help` | 退出码 0，列出 8 个命令 |
| `node bin\cli.js status --json --state-dir <temp>` | 退出码 0；`daemon.running=false`；不创建状态目录 |
| `node bin\cli.js install --dry-run --json --state-dir <temp>` | 退出码 0；打印绝对路径的 `khy mcp add`；**不创建**状态目录/token |
| `node --test test\registry.test.js` | 8 例 / 8 passed（2026-11-02 测得）：registry 只有 12 个 wire 工具（无 exec/read/write）、缺 principal 直接 403、`KHY_AMOON_ENABLED=0` 阻断非诊断工具、file scope 拒绝 khy_ask、phone ask 需 env+capability.http |
| `node --test test\server.test.js` | 23 例 / 23 passed（2026-11-02 测得）：`/v1/tools`（12/4）、`/v1/jobs/:id`、`/v1/rotate` 两阶段（旧 token 在 commit 前仍有效）、`/v1/audit/tail`、phone token 403 |
| `node --test test\mailbox.test.js` | 19 例 / 19 passed（2026-11-02 测得）：ack_/reply_ 写入本地 replies 并移入 done/；坏 JSON 进 failed/；counts.inbox 与 scanned 分离 |
| `test/capability.test.js` | 2 passed：Phase 0 指令；`capability.json` 的 unavailable/partial/verified 与 raw `http` 字段 |
| 真机最终冒烟（port 18913/18914） | start 200/health、ping 200、phone_info 200、phone_exec `{op:"echo",text:"final-ok"}` 200 `stdout=final-ok`；stop `forced=false`、`reverse_removed=true`、reverse 列表为空、无残留 daemon |
| MCP stdio：initialize/tools/list/tools/call（`--no-autostart`） | 3 帧 stdout；12 个工具；`tools/call` 为 `[daemon_unavailable]`，不假装成功 |
| 真机（serial `192.168.2.46:33743`，port 18910，临时 state） | `start` 退出码 0，`state=HEALTHY`、`reverse_mapped=True`、`mailbox_running=True`；`stop` 后 `forced=false`、reverse 列表为空、无残留 daemon |
| 真机复测（mDNS serial，port 18898，2026-10-22） | **21/21**：HEALTHY、reverse、capability ACL 存活、`device.json=ZYPZ261A01M6870010L`、点号 `phone.info`/`phone.exec`、`phone_ls`、`phone_screenshot` 1200×2670、HTTP `body.id` replay/409、手机 `curl`→PC `/health`、`kb ping`、信箱 `args_digest`/`replayed`/`id_conflict`+archive、MCP 12 工具 |
| 真机 `phone_info` | 200；`serial=ZYPZ261A01M6870010L`、`model=PZ261A`、`brand=StepX`、`sdk=36` |
| 真机 `phone_app_list {filter:"stepos",limit:20}` | 200；`total=66`、`count=20`；`foreground=com.android.launcher3/.uioverrides.QuickstepLauncher` |
| 真机 `phone_ls {path:"/sdcard/Download"}` | 200；解析为 `/storage/emulated/0/Download`，`total=9`，条目含 `.csj`/`Bluetooth`/`FMessage` |
| 真机 `phone_ui_dump` | 200；`package=com.stepos.ailauncher`，`activity=com.stepos.ailauncher/.chat.activity.ChatMainActivity`（与 package 一致；已修复“取第一条 ACTIVITY”导致的错配） |
| 真机 `phone_exec echo/getprop/wm_size/dumpsys_battery` | 200；`echo -> ok`、`ro.product.model -> PZ261A`、`battery level=100/已充满` |
| 真机拒绝用例 | `op=shell` → 400 `invalid_args`；`echo "a; id"` → 400 `invalid_args`；`getprop persist.sys.timezone` → 403 `forbidden_scope`；`phone_ls /sdcard/Android` → 403 `forbidden_scope`；`phone_ls /sdcard/Download/../Android` → 400 `invalid_args` |

真机检查的边界：检查 13 只调用了 `phone_info`/`phone_app_list`/`phone_ls`/`phone_exec` 与拒绝用例；
另做了一次只读 `phone_ui_dump` 校验 activity 字段。没有打开 amoon、没有向 amoon 发送消息、
没有安装/卸载应用、没有改系统设置。

模块 D 之前记录并保留的证据（本次未复跑）：`install.ps1 -DryRun`、临时 `KHY_DATA_HOME` 下的
`khy mcp add/remove`、`doctor.ps1` 的真机只读探测（双 transport 歧义、reverse 为空、
`/sdcard/khy-amoon-bridge` 不存在）。


---

## 14. 测试

```powershell
cd D:\Portable\khy-os\delivery\extension\bridges\khy-amoon-bridge

# 全量（显式 glob；本仓基线文档警告 node --test <目录> 会只报 1 例假读数）
node --test "test\*.test.js"

# 等价于 package.json 的 npm test（node --test）
npm test
```

`test/mcp.test.js` 覆盖：initialize 协议版本协商、tools/list 的 12 个工具与顺序、
tools/call 成功/失败/未知工具/无执行器、JSON-RPC 错误码、通知不响应、stdout 纯净、
参数透传、异步调用与取消、慢调用在 stdin 关闭后仍响应、响应截断、token 脱敏、
daemon 客户端 `/v1/call`→`/call` 回退、KhyOS 入口/argv/mcp.json 助手。

`test/manifest.test.js` 覆盖：id=目录名、namespace 唯一、kind=runtime、main 可加载且无副作用、
engines.khy 匹配、capabilities/provides/permissions、mcp.tools 与契约一致、无 schemaVersion 2.0、
package.json 零依赖与 bin 存在。

这些测试**不需要真机、不会写 mcp.json**；`test/integration.test.js` 会用 fake adb 在进程内
启动一次 daemon（临时 state、port 0），结束后 shutdown。
