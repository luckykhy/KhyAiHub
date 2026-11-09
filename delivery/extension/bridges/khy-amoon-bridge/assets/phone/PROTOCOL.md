# khy-amoon/1 — 文件与 HTTP 信封

## 文件信箱

目录：`/sdcard/khy-amoon-bridge/{inbox,outbox,working,done,failed,tmp,blobs}`。

| 文件 | 方向 | 字段 |
| --- | --- | --- |
| `cmd_<id>.json` | amoon → PC | `v=1,id,tool,args,ts?,expires_at?,reply_to?,nonce?` |
| `res_<id>.json` | PC → amoon | `v=1,id,tool,ok,ts,duration_ms,data?,error?,replayed?` |
| `msg_<id>.json` | KhyOS → amoon | `v=1,id,kind=text|command|file,text?,path?,sha256?,ts,expires_at,requires_ack` |
| `ack_<id>.json` | amoon → PC | `v=1,id,kind=ack,ts` |
| `reply_<id>.json` | amoon → PC | `v=1,id,kind=reply,text?,ts` |

- `id` 只允许 `[A-Za-z0-9_-]{8,64}`。
- 写入：先写 `tmp/`，再 `mv` 到目标目录。不要直接写 `inbox/`/`outbox/`。
- 文件通道没有 Bearer，固定映射为 `file` scope：只允许 `ping`/`bridge_status`/`mailbox_status`。
- `ack`/`reply` 可能被任何能写 `/sdcard` 的应用伪造，PC 一律标 `unverified`，不得据此执行命令。

## HTTP

`http://127.0.0.1:<port>` 经 `adb reverse` 到 PC 的 `127.0.0.1`。

- `GET /health`：无鉴权，只返回 `{ok:true}`。
- `GET /v1/status`、`GET /v1/tools`、`POST /v1/call`、`GET /v1/jobs/:id`：Bearer。
- `POST /v1/rotate` / `POST /v1/rotate/commit`、`GET /v1/audit/tail`：仅 operator。
- phone token 默认 scope 只有 `ping`/`bridge_status`/`mailbox_status`；`khy_ask` 默认关闭。
- `POST /v1/rotate` 是两阶段的：先返回新 token（旧 token 仍有效），推送成功后再
  `POST /v1/rotate/commit {record_id}` 使旧 token 失效。

## 受限工具

operator 可以调用 `phone_info`、`phone_app_list`、`phone_ls`、`phone_exec`：

- `phone_info`：只读设备信息。
- `phone_app_list`：只读包列表 + 前台 activity。
- `phone_ls`：只列白名单目录（`/sdcard` 顶层、khy-amoon-bridge、Download、Documents、
  Pictures、DCIM）。
- `phone_exec`：固定 op（echo/getprop/wm_size/pm_list/dumpsys_battery），**不是 shell**。

`phone_shell`、`phone_su`、任意文件读写/app 控制不存在。
