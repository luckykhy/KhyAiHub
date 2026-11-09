# Phase 0 — amoon 能力门（双向的前提）

本文件定义 `amoon → PC` 方向的唯一证据标准。**没有这里的证据，README、CLI、bridge_status
都只能写 `unverified` / 单向，不能宣称双向。**

## 为什么需要它

PC 侧 `adb shell` 能执行命令，只能证明 **PC 的 adb** 能操作手机；它不能证明 amoon 这个
Android 应用自己能执行 shell、读写 `/sdcard` 或发起 HTTP。因此 Phase 0 的三项动作必须由
**amoon 自己**完成，并由人记录证据。

## 三项探测

设 `ROOT=/sdcard/khy-amoon-bridge`，`PORT` 为 daemon 实际端口（`runtime.json` 与手机
`port.txt`/`config.json` 中的值）。

### a) 执行 shell

在 amoon 中执行：

```sh
sh /sdcard/khy-amoon-bridge/kb health
```

期望：输出 JSON（至少包含 `ok` 与 `channel`）。

### b) 写文件信箱

在 amoon 中向 `$ROOT/inbox/` 写入：

```json
{"v":1,"id":"probe00001","tool":"ping","args":{}}
```

文件名必须是 `cmd_probe00001.json`，且先写 `$ROOT/tmp/` 再 `mv` 到 `inbox/`（或直接写
`inbox/` 但能保证完整写入）。期望：PC 端 poller 在数秒内把 `outbox/res_probe00001.json`
写回，且 `inbox/` 中的命令消失。

### c) HTTP

在 amoon 中执行：

```sh
TOKEN=$(cat /sdcard/khy-amoon-bridge/token)
curl --noproxy '*' -sS --max-time 5 \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:PORT/health
```

期望：`{"ok":true}`，退出码 0。

## 记录证据

```powershell
node scripts\probe-amoon.js instructions --state-dir <state>
node scripts\probe-amoon.js record --shell --http --file-write --by "<谁在 amoon 中执行>" --evidence "<命令与输出摘要>" --state-dir <state>
node scripts\probe-amoon.js show --state-dir <state>
```

写入 `<state>/capability.json`，字段：

```json
{
  "status": "unverified | partial | verified | unavailable",
  "shell": true,
  "http": true,
  "fileWrite": true,
  "fileRead": false,
  "dozeWriter": false,
  "evidence": "人工记录的命令/输出摘要",
  "at": "ISO 时间",
  "by": "执行者"
}
```

判定：

- `shell && http && fileWrite` → `verified`（可以宣称双向，但仍受 scope/限流约束）；
- 任意一项为真但未全满足 → `partial`（只能按 capability 选择 HTTP 或文件通道）；
- 全部为假 → `unavailable`（只交付 KhyOS→手机 + 人工中转）；
- 未运行 → `unverified`（默认）。

## 不得作为证据的东西

- PC 侧 `adb shell` 的输出；
- `khy mcp test`（只 connect + listTools）；
- 手机侧 `kb health` 由 PC 的 adb 代跑；
- 截图/UI dump 看到 amoon 界面（只能证明界面存在）。

## 失败后的交付

三项全失败：README 与 `bridge_status.capabilities.amoonToPc` 保持 `unavailable`/`unverified`，
只承诺 KhyOS→手机与人工中转；不提供“双向可用”的文案。

`phone khy_ask` 还额外要求 `capability.json` 的 `http: true`；只有 `status=verified` 而没有
`http:true` 仍然保持关闭。
