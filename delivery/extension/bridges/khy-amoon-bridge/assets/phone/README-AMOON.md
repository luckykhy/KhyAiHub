# amoon 手机侧说明（khy-amoon-bridge）

本目录是手机上的 `/sdcard/khy-amoon-bridge`，由 PC 侧 `lib/bootstrap.js` 推送：

| 文件 | 作用 |
| --- | --- |
| `README.md` | 本说明 |
| `tools.json` | 手机可调用的工具清单（低权限） |
| `kb` | POSIX sh 客户端（curl 优先，失败回退文件信箱） |
| `port.txt` | PC daemon 实际监听端口（adb reverse 的目标）；`kb` 优先读 `config.json` 的 `port`，没有再回退到这里 |
| `token.txt` | **phone scope** token（仅当 PC 侧显式提供时存在）；不含 operator token。`kb` 优先读契约路径 `token`，没有再回退到这里 |
| `inbox/` | 手机 → PC 的命令：`cmd_<id>.json` |
| `outbox/` | PC → 手机的投递消息与命令结果：`msg_<id>.json` / `res_<id>.json` |
| `working/` `done/` `failed/` | PC 侧轮询时使用的中间/归档目录 |
| `tmp/` | 原子写的临时文件（先写这里，再 `mv`） |
| `blobs/` | 内容寻址附件（Phase 2 才用） |

## 两条通道

### 1. HTTP（快，优先）

PC 建立 `adb reverse tcp:<port> tcp:<port>` 后，手机可访问：

```
http://127.0.0.1:<port>/health          （无需鉴权，只返回 {"ok":true}）
http://127.0.0.1:<port>/v1/call        （Bearer phone token）
```

```sh
TOKEN=$(cat /sdcard/khy-amoon-bridge/token.txt)
PORT=$(cat /sdcard/khy-amoon-bridge/port.txt)
curl --noproxy '*' -sS --max-time 60 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"tool":"ping","args":{}}' \
  "http://127.0.0.1:$PORT/v1/call"
```

### 2. 文件信箱（慢，兜底）

写命令与读结果是同一个 FUSE 卷上的 `rename`，必须原子写：

```sh
# 写
printf '%s\n' '{"v":1,"id":"demo0001","tool":"ping","args":{}}' \
  > /sdcard/khy-amoon-bridge/tmp/cmd_demo0001.json.tmp
mv /sdcard/khy-amoon-bridge/tmp/cmd_demo0001.json.tmp \
   /sdcard/khy-amoon-bridge/inbox/cmd_demo0001.json

# 读
cat /sdcard/khy-amoon-bridge/outbox/res_demo0001.json
```

- 命令字段：`v=1,id,tool,args,ts?,expires_at?,reply_to?,nonce?`。
- 结果字段：`v=1,id,tool,ok,ts,duration_ms,data?,error?,replayed?`。
- `id` 只能是 `[A-Za-z0-9_-]{8,64}`；文件名必须匹配 `cmd_<id>.json` / `res_<id>.json`。
- 半写文件会被 PC 侧按“大小稳定 + JSON 重试”处理；不要直接写 inbox，必须 tmp+mv。
- 文件投递是 at-least-once；结果可能重复，`id` 是幂等键。

## kb 用法

```sh
sh /sdcard/khy-amoon-bridge/kb health
sh /sdcard/khy-amoon-bridge/kb tools
sh /sdcard/khy-amoon-bridge/kb status
sh /sdcard/khy-amoon-bridge/kb ping
sh /sdcard/khy-amoon-bridge/kb bridge_status '{"verbose":false}'
sh /sdcard/khy-amoon-bridge/kb mailbox_status
sh /sdcard/khy-amoon-bridge/kb ask '帮我总结今天的计划'
```

- `kb <tool> '<json args>'` 先试 HTTP；curl 失败/无 token 时自动回退文件信箱（stderr 会说明）。
- 等待结果默认 60 秒，可用 `KB_TIMEOUT` 覆盖。
- stdout 只输出 JSON；错误也是 JSON。
- 不依赖 jq / openssl；兼容 Android toybox。

## 允许的工具（手机侧）

| 工具 | phone scope | file scope | 说明 |
| --- | --- | --- | --- |
| `ping` | 是 | 是 | 最小连通性 |
| `bridge_status` | 是 | 是 | 状态（裁剪 serial/路径） |
| `mailbox_status` | 是 | 是 | 信箱计数 |
| `khy_ask` | **默认关闭** | 永不 | 需要 PC 侧 `KHY_AMOON_PHONE_ASK=1` 且 HTTP 能力已验证 |
| `phone_*` / `amoon_*` | 否 | 否 | 仅 operator |
| `phone_shell` | 不存在 | 不存在 | 桥不提供任意 shell |

文件信箱没有 Bearer：任何能写 `/sdcard` 的应用都能投递。因此 file scope 永远只有上面三个
低权限工具——不能触发模型、不能控制手机。

## Phase 0：双向的前提

`amoon → PC` 是否可用，必须由 **amoon 自己**完成以下三项并留证，不能用 PC 侧 `adb shell`
代跑冒充：

1. 执行 `sh /sdcard/khy-amoon-bridge/kb health`（证明能执行 shell）；
2. 写一个 `inbox/cmd_<id>.json`（证明能写文件信箱，且 PC 能回结果）；
3. `curl http://127.0.0.1:<port>/health`（证明 adb reverse + HTTP 可用）。

三项全失败 → 只交付 **KhyOS → 手机** 单向 + 人工中转，本文件不得写“双向可用”。
证据由 PC 侧 `scripts/probe-amoon.js` / `cli probe` 写入 `capability.json`。

## 安全边界

- token 放在 `/sdcard`，同机任何有存储权限的应用都可能读到；phone token 默认没有模型能力。
- 文件信箱没有 HMAC（手机缺 `openssl` / `sha256hmac`）；`res_`、`ack_`、`reply_` 都可能被伪造，
  一律按 `unverified` 处理，不得据此执行命令。
- 不提供 `phone_shell`、无障碍服务、root；不修改 amoon 安装包。
- `adb reverse` 只映射 PC 的 `127.0.0.1`，不做 LAN 监听。

## 排障

| 现象 | 处理 |
| --- | --- |
| `kb health` 返回 `channel:file` | HTTP/reverse 不通；检查 PC 侧 `bridge_status` 与 `adb reverse --list` |
| HTTP 401 | `token.txt` 与 PC 侧 `tokens.json` 不匹配；让 PC 重新 rotate 并重新推送 |
| HTTP 403 `forbidden_scope` | 该工具不在 phone/file scope；属预期 |
| `forbidden_scope` + `khy_ask` | 手机提问默认关闭；需要 PC 侧显式开启 |
| 文件信箱一直超时 | 检查 PC daemon 是否运行、`inbox` 是否可写、命令是否过期 |
| 结果 `abandoned` | PC 在命令执行中重启；结果未知，按失败处理，不要盲目重试非幂等工具 |
| `curl: command not found` | 设备无 curl；只能用文件信箱 |

## 状态

- KhyOS → 手机：由 PC 侧 adb 主动推送/截图/读屏，不依赖本 App 前台（Phase 1）。
- 手机 → KhyOS：只有 Phase 0 三项通过后才宣称可用；否则为单向。
- `capability.json` 的 `amoonToPc` 是唯一判据，不要仅凭本文件推断双向可用。
