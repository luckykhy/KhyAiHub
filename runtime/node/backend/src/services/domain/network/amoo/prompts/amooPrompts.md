# Amoo 协作提示词包（khy-os 侧）

> 本文件是「Amoo 协作层」面向用户的提示词真源，与
> `runtime/node/backend/src/services/domain/network/amoo/` 下的代码配套使用。
> 复制走对应段落即可，`<尖括号>` 是需要替换的占位。
>
> 使用前提（2026-10-22 在 StepX PZ261A / Android 16 上**两端实测**后更正）：
> - Amoo = `com.stepos.ailauncher` 里的助手聊天（`ChatMainActivity`），
>   没有 LAUNCHER 类别，只能按组件+动作打开（action
>   `com.stepos.ailauncher.action.OPEN_CHAT`）。
> - **Amoo 的命令执行工作区不在手机上，在云端。** 2026-10-21 两侧验证：
>   Amoo 自述工作区是 `/root/.openclaw/workspace`，`/sdcard` 对它不存在；
>   手机侧独立核查亦无 Node、无 Amoo 专属设备节点。所以
>   `adb reverse` 对 Amoo **无效**——那条路只是把手机的 loopback 映射到 PC，
>   云端进程根本碰不到手机loopback。手机上的文件要交给 Amoo，只能走附件上传。
> - 桥已并入 khy-os 手机端 App（`com.khyos.khy_os_client`，端口 8896），
>   **自带无障碍服务与 36 个工具**（含 ui_dump/ui_tap/ui_type/shot 等，
>   外加 loop_start/loop_stop/loop_status 三个循环控制工具），
>   读屏与点击不再必须由 PC 侧 adb 完成。
> - 系统会冻结后台应用，且**普通 APK 无权把自己加进冻结白名单**；唯一有记录的
>   解法是 `adb shell dumpsys activity freeze whiteAdd com.khyos.khy_os_client`。
>   长连接设计必须容忍「无预警被冻结 → 需外部拉起」。

---

## 方向说明（先读这段，再选提示词）

三条路，**已验证程度不同，别混着信**：

| 方向 | 谁发起 | 依赖 | 状态 |
|---|---|---|---|
| **路 1** | Amoo 主动调 khy-os | Amoo 的（云端）Node 工作区 + `amoo-khy-client.js` | **未在本环境复现**。stepx-neo-lab 的 `guides/amoo-notion/verification.md` 声称跑通过（Node v22.23.3、config/card/self 均退 0），但本机 2026-10-21 只复现了「PC 驱动 Amoo 界面」这一条；且云端工作区要够到 PC，要求 khy-os 有公网可达地址，本机 CGNAT 下不成立 |
| **路 2** | PC/khy-os 驱动 Amoo 界面 | 桥（已并入 khy-os App）+ PC 侧 adb | **已实测跑通**：消息送达、Amoo 思考约 6 分钟、回复读回 |
| **路 3** | 手机本地闭环，不依赖 PC | khy-os App 自己的无障碍服务 + 桥工具 | **已实现**：`AmooLoop` + `AmooProtocol` + `LoopModes` + `LoopState` + `LoopVerify` + `AmooChatText`，围栏协议见 K9 |

路 1 的结果天然落在 PC 侧（task artifacts、会话持久化）；路 2 每一步都要人在旁边看；
路 3 是唯一不依赖 PC 的一条，也是「Amoo 出命令、手机本地执行」的目标形态。
**默认走路 3，路 2 只在没有 App 权限或需要人眼确认时兜底。**

---

## K0 · 环境检查（首次运行）

```text
请检查当前执行环境中的 khy-os 接入方式：
1. 报告 Node.js 版本和可用的命令执行工具。
2. 在当前工作区查找 amoo-khy-client.js、khy-cli.js 或已加载的 khy 连接器。
3. 找到 CLI 后执行 --version 与 --help，再执行 config --json，报告 base_url、
   configured 和 credential_source。
4. 汇总可复用入口、缺少的条件与下一步。
```

## K1 · 导入 khy CLI（先附上 `amoo-khy-client.js.txt` 再发送）

```text
请将附件原样保存到执行工作区，文件名为 amoo-khy-client.js。
预期大小：<字节数> 字节。
预期 SHA-256：<sha256>。
比较附件与保存文件的哈希；已有同名且同哈希文件时直接复用，不同则另存。
确认 Node.js 版本不低于 22 后，执行 --version 与 --help。
报告保存位置、哈希比对结果、Node 版本、CLI 版本及执行结果。
```

> 附件通道可能被转码：哈希不一致就退回 PC 侧 `adb push`，不要接受「看起来一样」。

## K2 · 连接 khy-os 检查

```text
请使用现有 khy CLI 检查与 khy-os 的连通性：
1. 执行 config --json，报告 base_url、configured 和 credential_source。
2. 执行 card --json 读取 khy-os 的 A2A Agent Card，报告名称、版本与声明能力
   （特别注意 streaming 是否为 true）。
3. 已配置时执行 self --json，报告 khy-os 是否在线、本次探活延迟与错误详情。
4. 尚未配置时，说明当前执行环境的凭据设置或交互终端入口，并给出 init 初始化步骤。
5. 汇总问题出在网络、地址、凭据还是 khy-os 服务本身，不要跳过步骤直接回答。
```

> `streaming` 必须是 false：khy-os 没有 SSE 实现，任何流式代码路径都必然失败。

## K3 · 完整启动提示（记忆 + 任务下发 + 结果回收）

```text
本次任务：【填写任务】。
请先按以下顺序执行，再给出最终答复：
1. 使用现有 khy CLI 的 memory 命令读取【khy-os 交接记忆地址：本地文件路径或
   http(s) 链接】。报告记忆版本、校验词与读取完整性（字节数、SHA-256、有无截断
   或缺失小节）。
2. 执行 send --json 将本次任务下发给 khy-os，报告返回的 taskId 与初始状态。
3. 用 task <taskId> --json --wait 轮询直到终态（completed / failed / canceled /
   rejected），报告状态变迁与最终 artifacts。
4. 把 khy-os 的结论与交接记忆中的偏好合并，给出本次任务的最终答复。
失败时说明具体原因与下一步；不允许跳过步骤直接回答。
```

## K4 · 日常简短启动（存成输入法快捷短语）

```text
请先用现有 khy CLI 读取 khy-os 交接记忆并检查连通（config、card、self），
再把本次任务 send 给 khy-os 并轮询 task 到终态，最后结合记忆偏好给出结论。
简报：记忆版本、taskId、终态、关键结论。失败时说明原因。
本次任务：【填写任务】。
```

## K5 · 恢复既有环境（以前调通过，现在连不上）

```text
此前同一 Amoo 环境已成功调用 khy-os，base_url 为【地址】。
请在当前执行工作区定位既有 khy CLI，检查环境变量或
~/.config/amoo-khy/config.json 是否被 CLI 使用。
依次运行 config、card、self，定位问题出在工具、配置、网络还是 khy-os 服务。
成功时报告当前 Agent Card 版本与一次探活延迟；失败时报告具体错误及下一步。
```

## K6 · 结果回收与交接块整理（把 Amoo 结论交回 khy-os）

```text
请把本次与 khy-os 协作的结论整理成可回传 khy-os 的交接块，字段包括：
- 任务标识与 khy-os taskId；
- Amoo 侧完成的工作与产出文件路径（执行工作区内）；
- 需要 khy-os 继续处理的待办与建议命令；
- 记忆更新建议（新增、修订、删除、待确认，分别归入长期偏好或当前项目）。
输出为纯文本 Markdown，我会保存到 khy-os 交接记忆并更新版本号与校验词。
```

## K7 · 交接记忆更新草稿

```text
请把本次已确认的结论整理为 khy-os 交接记忆更新草稿。
按「新增、修订、删除、待确认」分类，分别归入长期偏好或当前项目。
给出可直接粘贴的修改片段，并标出需要更新的版本号、日期和校验词。
当前 CLI 为只读，我会把草稿保存到交接记忆后再重新读取验证。
```

## K8 · 自动读取审计（新聊天先发普通任务，回答结束后再发这段）

```text
请检查刚才回答之前已有的工具调用记录：是否读取了 khy-os 交接记忆、是否调用了
khy CLI？如果有，列出工具名称、调用时间和当时返回的记忆版本；没有记录则说明
无法确认。本次只核对既有记录，无需补读。
```

---

## K9 · 本地执行协议（无 PC 闭环；Amoo 出命令、手机本地落地）

> **命令是怎么被识别的（这条与旧版不同，别再按旧版理解）**：
> 早期约定用 ` ```khy-exec ` 围栏包住命令。**实测这台设备上围栏不可用**——Amoo 把
> markdown 代码块渲染成结构化 UI，反引号围栏行被渲染器吃掉，从不进入无障碍树，
> 拦截层根本看不到它们。所以现在的判据是**形状**：
>
> > **一整行，恰好是一个 JSON 对象，且它的 `tool` 是一个真实存在的桥工具名。**
>
> 满足这三条才执行；不满足一律忽略，即使它长得像命令。这不是不信任，是让"拦截"
> 从猜语义变成确定性匹配——以及一个你必须知道的后果：**散文里内联的示例不会被
> 执行**（那一行不会以 `{` 开头），但**单独占一行的示例会**。所以举例时务必用
> 占位符（`<工具名>`、`{...}`、`<路径>`）——带占位符的 JSON 不可能通过校验。

把下面整段发给 Amoo（或存成 Amoo 的长期指令），之后每次任务只需说任务本身：

```text
后续协作请遵守本地执行协议。命令的识别规则是：

  【一整行，恰好是一个 JSON 对象，且 tool 是真实存在的桥工具名】才会被执行。
  不满足的一律忽略，即使它长得像命令。所以：

  · 真命令必须【单独占一行】，最好单独放在一个代码块里，块内不要混散文。
    混在同一行或同一个块里的散文会让那一行不再以 { 开头，命令就丢了。
  · 举例说明时，把示例写在散文句子里面（像这样：{"tool":"<工具名>","args":{...}}），
    并且一定带占位符。带占位符的 JSON 不可能通过校验，所以是安全的；
    单独占一行又不带占位符的示例，会被当成真命令执行。

命令的字段：
  {"tool":"<桥工具名>","args":{...},"verify":{...}}
  tool 可用：write / read / ls / mkdir / rm / mv / cp / stat / exec /
             start_app / open_url / clipboard / toast / notify /
             ui_dump / ui_tap / ui_click / ui_type / shot / shot_b64
  verify 可选，用于事后自证，按 tool 选（能带就带）：
    write  -> {"kind":"read_equals","path":"<同 args.path>","expect_bytes":<字节数>}
    exec   -> {"kind":"exit_zero","expect_in_stdout":"<stdout 里应出现的串>"}
    ui_type-> 不需要，默认回读输入框比对

动手前可以先回述你理解的目标（单独一行）：
  {"goal":"<你理解的任务>","done":"<什么条件算完成>"}
我看到会核对；理解偏了我会纠正，你不会白做。

认为任务已完成时，单独发一行：
  {"summary":"<做完了什么>"}
只有这个信号算任务结束。没发它就停手，我会按未完成处理。

硬规则：
- 一次可以发多条命令，按顺序执行。半截 JSON 我会等，不会执行。
- **内容超过约 1500 字节就不要写在一条命令里**：拆成多条 write，后面几条用
  "append":true 续写。超长内容在手机界面上容易被截断，截断的 JSON 我不会执行，
  只会让你重发，白跑一轮。
- 每条命令执行后我会把【实际结果】回给你。成功才说成功；验证不过我会把实际
  状态原样告诉你，请你下一步修正，不要假设它成了。
- 需要读手机上的文件时直接用 read/ls；你的命令环境在云端，读不到 /sdcard，
  手机上的文件由我在本地读到你围栏里。
- **优先用能自证的副作用**：write 可配 read_equals、exec 可配 exit_zero、
  ui_type 默认回读输入框，这几类的结果我能独立核对。toast 弹在屏幕上之后
  没有任何可读取的事后状态（这一点我没能目视证实，只是从界面上读不到），
  所以它只能当「给旁边的人看」的信号，不要把它当作任务完成的证据。
```

**一条真命令实际长这样**（单独占一行，外面包不包代码块都行——包起来更好，
代码块会让这一行单独成为一个界面节点，识别最稳）：

    {"tool":"write","args":{"path":"/sdcard/game/main.py","content":"print('hi')"},"verify":{"kind":"read_equals","path":"/sdcard/game/main.py","expect_bytes":11}}

**当前模式**：`bypass`（直接执行，不逐条问）。但**安全底高于模式**：递归 `rm`、
以及 `rm -rf` / `mkfs` / `dd if=` / `reboot` / `setprop` / `pm uninstall` 等破坏性
命令，任何模式下都会停下来问人。这是唯一一道不能绕的闸。

---

## 交接记忆页模板

```markdown
# khy-os 交接记忆

## 校验区
- 记忆版本：v1
- 更新时间：2026-10-21
- 校验词：<两个字，换版必换>

## 长期偏好
- base_url：<PC 地址或 127.0.0.1:3000（adb reverse）>
- 凭据来源：env:KHY_A2A_API_KEY（不要把 key 写进本页）
- 常用命令：config / card / self / send / task --wait / cancel / memory
- taskId 命名：由 khy-os 返回，形如 <id>；PC 会话 UUID 记在
  works/data/khy/T1-domains/sessions/<uuid>

## 当前项目
- <本轮在做什么、做到哪一步、下一步>

## 临时测试
- <仅本轮有效的地址、taskId、待清理项>
```

> 更新纪律（与 amoo-notion 同约束）：CLI 的 `memory` 只读。改记忆 =
> K7 生成草稿 → 人粘贴到页面 → 重新读取验证版本号与校验词。

---

## 连通与送达速查

```bash
# PC 侧：确认设备在线（33743 是 connect 端口，绝不跑 adb pair）
adb connect 192.168.2.46:33743

# 首选连通：adb reverse，手机侧访问 127.0.0.1:<端口>
adb -s 192.168.2.46:33743 reverse tcp:3000 tcp:3000

# 送达 CLI（首次）：push 后核对字节数与 SHA-256
adb -s 192.168.2.46:33743 push amoo-khy-client.js /sdcard/Download/
adb -s 192.168.2.46:33743 shell sha256sum /sdcard/Download/amoo-khy-client.js

# 兜底连通：StepBridge（真实端口 8896，信箱目录 /sdcard/bridge-amoobridge）
adb -s 192.168.2.46:33743 forward tcp:8896 tcp:8896
adb -s 192.168.2.46:33743 shell cat /sdcard/bridge-amoobridge/token.txt
# 桥服务死了只有一条恢复路：monkey 拉起
adb -s 192.168.2.46:33743 shell monkey -p com.stepx.amoobridge \
  -c android.intent.category.LAUNCHER 1
```
