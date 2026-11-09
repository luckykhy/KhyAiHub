# khy 桥指南（khy-os 手机桥契约）

你是经本桥操作这台 Android 设备的调用方。本文件是桥的行为契约：先读本核心层，
需要细节时按主题索引读取单节。花括号占位符（{{PORT}}、{{BRIDGE_TOKEN}}、
{{TOOL_NAMES}}）由桥在响应时填充。

## 连接与鉴权

- 服务只监听手机本机 loopback：http://127.0.0.1:{{PORT}}。PC 侧用
  `adb forward tcp:<本地端口> tcp:{{PORT}}` 访问；手机上的应用走进程内调用，不经 HTTP。
- 所有请求带 `Authorization: Bearer {{BRIDGE_TOKEN}}`。令牌同时落盘在信箱目录的
  token.txt（32 位十六进制），PC 侧读它即可接入。
- 信箱目录不做身份认证，只有可信调用方可访问。
- status.json（信箱目录内）的 http_port 是实际端口真源；pc_reachable/pc_idle_ms
  报告 PC 是否在协作。

## GET /ping —— 健康自报

先 GET /ping 检查连接。回执字段：

- pid：桥进程号；与 status.json 的 pid 对读。
- heartbeat_seq：桥工作循环节拍序号，每跑完一轮信箱扫描加 1；两次 /ping 之间
  序号在涨 = 循环在推进。
- heartbeat_age_ms：距上一拍的毫秒数；-1 = 尚未跑过第一拍。
- heartbeat_stale：超过 180s 无节拍为 true。

心跳陈旧不单独说明冻结、崩溃或业务结果：信箱里的长命令（exec 上限 120s）在
循环线程里同步执行，期间心跳自然变陈旧；冻结期间进程内心跳也会停。本次 /ping
能成功返回，只证明此刻 HTTP 可响应。

## POST /call

形状固定为 {"tool":"工具名","args":{...}}：

```
curl --max-time 5 -H 'Authorization: Bearer {{BRIDGE_TOKEN}}' -H 'Content-Type: application/json' -d '{"tool":"ls","args":{"path":"/sdcard"}}' http://127.0.0.1:{{PORT}}/call
```

- 顶层只允许 tool 与 args 两个字段，多一个字段即 invalid_arguments。
- args 是闭集：每工具收哪些字段见 schema 主题；参数类错误回执带 guide_topic，
  按该主题读细节。GET /agent-guide 核心层只有工具名列表，没有参数 schema。
- HTTP 200 只表示传输完成，必须读回执 JSON 的 ok。POST 超时后可用新 GET /ping
  检查恢复，但不得重发超时 POST；必须核对原请求回执或副作用。
- 不得重放 exec、write、rm、mv、cp、start_app 等非幂等动作；结果未知先核对副作用。
- 客户端等待必须长于工具期限：exec 默认 20 秒、上限 120 秒。
- 可用工具名：{{TOOL_NAMES}}（不可用的工具已被扣下，不在名单里）。

## 文件信箱（第二通道）

HTTP 不可用时的第二通道：向信箱目录写 cmd_<id>.json，轮询 result_<id>.json。
形状、生命周期与清理责任见 mailbox 主题——读后删除回执文件是消费方的第一责任。

{{TOPIC_INDEX}}

<!-- TOPIC:exec -->
exec 使用 cmd 参数，timeout 可选（1–120 秒，默认 20）：
{"tool":"exec","args":{"cmd":"dumpsys battery","timeout":30}}。

- 危险命令底线：`rm -rf /`、mkfs、dd 写盘、reboot、pm uninstall 等系统级破坏命令
  在任何入口都被拒（code=dangerous_command_refused），没有例外。
- 提权通道：exec 优先走 shell sidecar（uid 2000），其次 Shizuku，都不通则退回
  应用自身 uid——此时 input/am/pm 等命令会因权限不足而无操作。info 回执的
  elevated / sidecar / shizuku 字段说清当前在哪一层，elevation_advice 给下一步。
- 输出上限：stdout 1MB、stderr 512KB，超出截断并标注。
- 读出类工具（ls/read/exec/cp/zip）受本轮预算约束：8MB 字节、2000 条目、
  50 个复制文件；超出拒绝（code=session_budget_exceeded，回执带 budget）。
  一轮 = 一次 loop_start 或一次 amoo_ask；info 回执的 budget 字段可查已用量。
- 批量导出红线：最终效果是枚举或整体复制用户数据（相册、聊天记录、通讯录）的
  请求，先向用户说明数量与范围并取得确认，再按最小范围执行；折成多轮小请求
  累积的按累计规模判定，看效果不看工具。
- exec 回执必须读 ok / exit / stdout / stderr；HTTP 200 只表示传输完成。
<!-- TOPIC:mailbox -->
文件信箱：目录 /sdcard/bridge-amoobridge。命令 JSON 形状为
{"id":"task_001","tool":"ls","args":{"path":"/sdcard"}}。

写入规则：

- ID 为 1–128 个字母、数字、下划线或短横线，且必须与文件名一致：正文 id 与
  cmd_<id>.json 的 <id> 不同会被整条拒绝（invalid_arguments，不执行）。
- 先写同目录临时文件，再重命名为 cmd_<id>.json；直接写最终文件名可能让桥读到
  半截 JSON。
- ID 必须唯一；信箱不做身份认证，只有可信调用方可访问。

服务流程（状态机）：

1. 桥把 cmd_<id>.json 改名为 processing_<id>.json（占位，表示已认领、开始执行）；
2. 执行，原子发布 result_<id>.json——平铺 JSON：顶层 ok/error/tool 与工具字段，
   另含 id/ts，以及 action_dispatched / replay_safe / retry_safe 三个判定字段；
3. 发布成功后删除 processing_<id>.json。

回执判定字段：

- action_dispatched=false：命令没到工具层（形状被拒 / 同 id 冲突），什么都没发生，
  修正后可重发。
- replay_safe=true：只读工具且 ok=true，重发同一命令不会改变设备状态。
- retry_safe=false 时禁止自动重试；先核对副作用，再决定换思路或放弃。
  ok=false 的回执一律不重放。

结果轮询：

- 提前没读到 result_<id>.json 只表示尚未取得回执，按同一 id 继续查；不证明失败，
  也不允许重发动作。
- 长命令（exec 上限 120s）在信箱里串行执行，期间其他命令与 status.json 更新会
  延后；提前规划租约，不因超时重发。

启动 recovered：

- 服务启动时把遗留的 processing_<id>.json 登记进 status.json 的 recovered
  （最多 20 条，只含 id、tool、age_ms、args_present 和 side_effects=unknown），
  不解析参数正文、不删除文件、也不重放；这些命令的部分副作用视为未知，使用前
  先核对其 id 对应的结果或界面状态。
- 同 id 已有遗留 processing_<id>.json 时，新写同名 cmd_<id>.json 会被拒
  （duplicate_id）；先读该 id 的 result 或核对界面，确认后由调用方删除遗留文件，
  再发新命令。

消费与清理（消费方职责）：

- 读到 result_<id>.json 并核对后，由消费方删除该文件；该 id 若还有 cmd_/processing_
  残留一并删除。这是第一责任路径。

服务端 GC（兜底，消费方不清理时启用）：

- result_<id>.json 保留 24 小时；processing_<id>.json 保留 72 小时；写失败的
  .tmp 保留 1 小时；到期由桥在自愈拍里删除并写日志。

背压与写失败：

- 回执发布失败（存储满 / IO 错误）时不假装成功：processing_<id>.json 保留、
  无回执。「有 processing 无 result」= 命令未确认完成，先核对副作用。
- status.json 的 mailbox 字段（pending / processing / results / tmp）暴露队列
  深度；pending 很深说明循环正被长命令占住，不是桥死了。
<!-- TOPIC:schema -->
POST /call 形状固定 {"tool":"工具名","args":{...}}；每工具参数是闭集，问号表示可选。
信箱命令同形，另要求顶层 id 与文件名一致。

基础：

- ping: {}（探活，回 pong/pid/ui）
- info: {}（设备/UI/提权/预算一次全报）
- tools: {}（分组目录：每工具一句话）
- exec: {"cmd":"shell 命令","timeout":20?}（1–120 秒）

文件：

- ls: {"path":"/sdcard"?}（单次 200 条上限，truncated/total 标注截断）
- read: {"path":"...","max":262144?}（默认 256KB，硬上限 1MB）
- write: {"path":"...","content":"...","append":false?}
- mkdir: {"path":"..."}
- rm: {"path":"...","recursive":false?}（删目录必须显式 recursive:true）
- mv / cp: {"path":"...","dest":"..."}（cp 单次最多 50 个文件，回执带 copied/truncated/cap）
- stat: {"path":"..."}
- zip: {"path":"源","out":"目标.zip"}
- unzip: {"path":"zip","dest":"目标目录"}

凭据投递（凭据只进 App 私有目录，永不落 /sdcard；写与删都要投递码）：

- secret_code: {}
- secret_put: {"name":"...","value":"...","code":"投递码"}
- secret_list: {}
- secret_del: {"name":"...","code":"投递码"}

应用与系统：

- start_app: {"package":"...","component":"pkg/cls"?,"action":"...","uri":"...","extras":{"k":"v"}?}
- open_url: {"url":"..."}
- share_text: {"text":"...","title":"..."}
- clipboard: {"op":"get"|"set","text":"..."}（op 缺省 get）
- toast: {"text":"..."}
- notify: {"title":"...","text":"..."}
- list_apps: {}
- battery: {}
- volume: {"level":不超流上限?}（缺 level 为读）
- brightness: {"value":0-255?}（缺 value 为读；需「修改系统设置」权限）
- vibrate: {"ms":200?}
- adou_signin: {"op":"run"|"status"|"schedule"|"stop","hour"?,"minute"?,"enabled"?}

助手循环（细节见 loop 主题）：

- loop_start: {"mode":"bypass"|"plan"|"edit"|"default"?,"max_rounds"?,"deadline_ms"?,"poll_ms"?,"inject_memory"?}
- loop_stop / loop_status / amoo_result / amoo_stop: {}
- amoo_ask: {"prompt":"...","timeout_ms":420000?}（15000–1800000，异步，amoo_result 轮询）
- amoo_memory: {"op":"get"|"set","id"?,"text"?,"verified"?,"provenance"?}

界面（细节见 ui 主题）：

- ui_dump: {"max_nodes":600?}（1–5000）
- ui_tap: {"x","y"}
- ui_click: {"text":"..." 或 "id":"..."}（至少一个）
- ui_swipe: {"x1","y1","x2","y2","ms":300?}（50–10000）
- ui_longpress: {"x","y","ms":700?}（200–10000）
- ui_type: {"text":"..."}
- ui_back / ui_home / ui_recents: {}
- shot: {"path":"...png"?}（缺省存信箱目录）
- shot_b64: {"maxw":480?,"quality":60?}

兼容别名：shell_exec→exec、file_read→read、file_write→write、file_list→ls、
sys_info→info。
未知工具回执：ok=false、code=invalid_arguments、guide_topic=schema。
<!-- TOPIC:ui -->
界面工具由本机无障碍服务承接：ui 状态以 info / ui 回执的 ui 字段为准；未开启时
每个工具都会回一句可执行的中文指引。控件树能力不依赖 UiAutomator、ADB 或电脑。

标准流程：ui_dump 取控件树（uiautomator 兼容 XML，text/resource-id/class/package/
content-desc/bounds 属性齐全）→ 从 bounds 取坐标做 ui_tap / ui_swipe /
ui_longpress，或用 ui_click 按文本/resource-id 点（节点点击优先，失败退回坐标
手势）→ ui_type 向当前聚焦输入框写文字（替换而非追加，中文/换行均可）→ 每步
操作后重新 ui_dump 核对界面，不沿用旧坐标盲点。

- 坐标一律取自 ui_dump 的 bounds，不要手算；窗口切换后旧树作废，必须重新 dump。
- 手势可能被系统取消：ok=false 时回执带原因（目标窗口不接受注入等），重新 dump
  定位后再试，不要重放同一坐标。
- 横滑条要点垂直中心；列表滚动 ui_swipe 300ms 左右，翻页可到 600ms。
- ui_back / ui_home / ui_recents 是全局动作，系统可能拒绝（ok=false）。
- shot 把 PNG 截屏存文件并回路径（缺省存信箱目录）；shot_b64 直接回 base64
  （默认宽 480、质量 60，体积大慎用）。两者需要 API 30+。识图与定位、触控、
  业务结果必须分别核对——图片返回不证明已看图。
<!-- TOPIC:loop -->
助手循环组把本机聊天助手当模型驱动（读屏→提问→写回），两条用法：

一次性提问（反代）：amoo_ask {"prompt":"...","timeout_ms"?} 异步启动一次提问
（15s–1800s，默认 420s），立即返回 job；用 amoo_result 轮询答案。本机一想就是
6 分钟级别，阻塞等待必然超时。

- 单飞：同一时刻只有一笔提问；已有任务在跑时返回 code=single_flight，先取结果。
- amoo 必须在前台：否则 code=amoo_not_foreground，先把它的聊天页调到前台再试。
- amoo_stop 中止进行中的提问并释放单飞锁；回执里 running 与 ask_running 分开报，
  别混读。

持续循环：loop_start {"mode"?,"max_rounds"?,"deadline_ms"?,"poll_ms"?,
"inject_memory"?} 启动自主循环；mode 取 bypass/plan/edit/default，未知名直接报错
不静默回退。loop_status 看 running/mode/report，loop_stop 停。

- 每轮（一次 loop_start 或一次 amoo_ask）预算独立重置：8MB / 2000 条目 /
  50 个复制文件。
- 共享记忆 amoo_memory 跨会话累积：op=get 读（含确信度与来源），op=set 写；
  手工写入默认 unverified，不冒充测量结果。
