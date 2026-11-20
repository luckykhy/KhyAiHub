<!-- IMPL-STATUS: todo -->
# [DESIGN-ARCH-216-附1] 授权风险档分类草案与 P0 复现规格

> **状态：非冲突准备片，2026-11-14；216 §6.3 / §8 的决策支持，不是实施完成报告。**
> **父方案**：[216 授权 broker](<[DESIGN-ARCH-216] 手机端统一授权broker-单一执行chokepoint与策略单一真源.md>)。本文是用户选定「先做非冲突准备片」后产出的两件新文件之一（另一件是本文 §5 的复现规格）。
> **边界**：本轮**零在飞源码改动**。只新建本文 + 索引行；分类草案读 `ATOMIC-CAPABILITIES.json`（只读），复现规格读现有测试（只读）。门下沉等施工仍等 213 在飞 lane 落定（216 §0.2 第二闸）。
> **草案性质**：§2 的 135 能力归档是**待人裁决的提案**（216 §6.3），不是已定案；§3 列出真正有争议、须人拍板的项。AI 不默默定案。

## 0. 本文给什么

1. **风险档分类草案**（§1–§4）：把 215 §8.2 的五类风险落到 canonical 目录的 135 个能力上，逐个给提案档 + 理由，标出待裁项，并与原生 `LoopModes` 风险名单交叉核对、surface 冲突。这是 216 §3.3「风险档入 `ATOMIC_GROUPS` 单一真源」施工前必须先由人确认的语义输入。
2. **P0 复现测试规格**（§5）：把 216 §8 的 4 条复现规格细化成可执行测试规格，**锚定到本轮亲读的真实现有测试**（非发明），含正/负控制与差分。**§5.2/§5.4 已用独立 Dart SDK 3.14.0 对真实在仓源执行 PASS（15/15，非空转）；§5.3 已于 2026-11-15 用 Flutter 真工具链执行 PASS（4/4，非空转）**（详见 §5.5）。

## 1. 五档定义与判定程序（真源 215 §8.2）

215 §8.2 原文五类（本文档名沿用 216 §3.3 的英文键）：

| 键 | 215 类别 | 默认行为 | 判据 |
|---|---|---|---|
| `read` | 受限读取 | 已授范围内可自动 | 纯读、无副作用；读正文仍受隐私/敏感限制 |
| `reversible` | 可逆工作区修改 | AI 先计划确认，执行重验基线 | 改工作区/设备态但可逆（写/建/移/配置/任务/记忆） |
| `mainScreen` | 主屏交互 | 先获当前任务/目标 App/显示范围授权 | 与主屏/目标 App UI 交互（点/输/滑/启动/开 URL） |
| `external` | 外部可见或不可逆 | 本次具体内容再次确认 | 外发/发布/付/装，或删除/凭据/第三方签到等不可逆 |
| `elevated` | 提权/任意脚本/插件/远控 | 独立能力开通 + 逐次动作边界 | 提权、跑任意脚本/代码、装插件、远程控制 |

**判定程序（确定性，most-restrictive-wins，对齐 215「不允许用点按工具把外部效果降为低风险」）**：

```
按 elevated > external > mainScreen > reversible > read 顺序，
取该能力「能产生的最高风险」定档；跨档能力取最严档并标待裁。
fail-closed：判不清 → 取更严档，不取更松档。
```

> 为什么 most-restrictive-wins：一个能力若既能读又能外发（如 `device.clipboard` 读写），按它能造成的最高风险定档，否则「点按」式低档会把外部效果偷偷降级——正是 215 §8.2 禁止的。

## 2. 135 能力分类草案（完整覆盖，按族分组）

每行：capability · 摘要（catalog 实测）· 提案档 · 备注。`[待裁]` = §3 有争议、须人拍板；其余为按 §1 程序的 confident 默认。**全部 135 个，无遗漏**（数量以生成器运行时快照为准，不引文档字面值——213 判据纪律）。

### 2.1 fs.*（14）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| fs.read | 读取文件内容 | read | 正文受隐私限制 |
| fs.write | 写入文件内容 | reversible | 工作区修改 |
| fs.edit | 局部修改文件 | reversible | |
| fs.list | 列出目录 | read | |
| fs.list-restricted | 受限白名单列目录 | read | |
| fs.glob | 名模式匹配 | read | |
| fs.grep | 内容正则检索 | read | |
| fs.mkdir | 创建目录 | reversible | |
| fs.stat | 读元信息 | read | |
| fs.move | 移动/重命名 | reversible | 可逆 |
| fs.copy | 复制 | reversible | |
| fs.delete | 删除文件/目录 | external | 不可逆（215「删哪些」）；对齐原生 rm 高危 |
| fs.zip | 打包/解包 | reversible | **[待裁]** Zip Slip / 覆盖同名；见 §3.1 |
| fs.send-to-user | 把文件发给用户 | external | 外部可见 |

### 2.2 exec.* / sys.elevation（7）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| exec.shell | 执行 shell 命令 | elevated | 任意 shell；对齐原生 exec 高危 |
| exec.shell-restricted | 白名单只读诊断 | read | **[待裁]** 受限只读 vs shell；见 §3.2 |
| sys.elevation | 查询提权代理是否可用 | read | **[待裁]** 查询 vs 提权动作；见 §3.3 |
| exec.code | 执行代码片段 | elevated | 任意代码 |
| exec.background | 后台任务与输出 | elevated | **[待裁]** 跑什么决定档；见 §3.10 |
| exec.kill | 终止进程 | external | **[待裁]** 不可逆 vs 提权；见 §3.11 |
| exec.terminal-capture | 采集终端画面 | read | 读屏 |

### 2.3 sys.goal / net.*（5）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| sys.goal | 设置/查看持续目标 | reversible | 写目标态 |
| net.http | 发起 HTTP/HTTPS | external | 外部请求/可能有副作用 |
| net.web-search | 搜索公开网络 | read | 读公开信息；外发请求 nuances 见 §3.5 |
| net.browser | 驱动真实浏览器 | elevated | **[待裁]** 远控 vs 外部；见 §3.9 |
| net.firecrawl | 抓取网页转结构化 | external | 外部请求 |

### 2.4 device.*（26）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| device.ping | 探活 | read | |
| device.info | 读设备信息 | read | |
| device.info-readonly | 只读受限设备信息 | read | |
| device.app-list | 列已安装应用 | read | |
| device.app-list-readonly | 只读受限列应用 | read | |
| device.launch-app | 启动应用 | mainScreen | 目标 App 授权 |
| device.open-url | 打开 URL | mainScreen | 可能触发外部 App，见 §3.5 |
| device.clipboard | 读写剪贴板 | reversible | **[待裁]** 写对其他 App 可见；见 §3.4 |
| device.share | 分享文本到其他应用 | external | 外部可见 |
| device.toast | 弹系统通知 | reversible | 瞬时本地 UI |
| device.battery | 读电量 | read | |
| device.volume | 调音量 | reversible | 可逆设备态 |
| device.brightness | 调亮度 | reversible | |
| device.vibrate | 触发振动 | reversible | 瞬时 |
| device.ui-dump | 读元素树 | read | |
| device.ui-dump-readonly | 只读受限元素树 | read | |
| device.ui-tap | 点击元素 | mainScreen | |
| device.ui-type | 输入框写文本 | mainScreen | |
| device.ui-gesture | 滑动/长按/导航 | mainScreen | |
| device.screenshot | 截屏 | read | **[待裁]** 隐私敏感读；见 §3.5 |
| device.screenshot-readonly | 受限截屏 | read | **[待裁]** 同上 |
| device.media-capture | 录音/开相机 | external | 隐私采集，215 §8.3 默认交人 |
| device.location | 读地理位置 | read | **[待裁]** 隐私敏感读；见 §3.5 |
| device.install-apk | 安装 APK/配置提权 | elevated | **[待裁]** 提权+不可逆装；见 §3.8 |
| device.analysis | 分析当前屏幕 | read | 读屏理解 |
| device.dart-swipe | Dart 无障碍滑动 | mainScreen | |

### 2.5 bridge / credential / app / mobile（5）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| bridge.tool-catalog | 桥自述工具 | read | |
| credential.delivery | 凭据投递四件套 | external | 不可逆；对齐原生 secret_* |
| app.adou-signin | a豆助手签到 | external | 第三方不可逆；对齐原生 adou_signin |
| mobile.notes | 检索本地笔记 | read | |
| mobile.calc | 计算数学表达式 | read | 纯函数 |

### 2.6 amoo.* / khyos / stepneo（9）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| amoo.dispatch | PC 驱动 amoo 输入任务发送 | external | 替人发话不可逆；原生 amoo_* |
| amoo.ask | 手机反代提问 | external | 写 Amoo 输入框不可逆 |
| amoo.stop | 中止任务/释放单飞锁 | external | **[待裁]** 释放可逆 vs 紧急出口；见 §3.7 |
| khyos.ask | 向本机 KhyOS 提一次性问题 | elevated | **[待裁]** 远端任务；见 §3.9 |
| stepneo.cloud-ask | 经云网关向手机 agent 发任务 | external | 远程控制/外部 |
| amoo.memory | 写 amoo 跨会话记忆 | external | 已核定案：原生 reason 明说写、撤回不了（LoopModes.java:280）；catalog「读取」误标，见 §3.6 |
| amoo.loop | 驱动 amoo 多步循环 | elevated | **[待裁]** 自主闭环；见 §3.10 |
| amoo.mailbox | 文件信箱异步通信 | reversible | 写信箱可逆 |
| amoo.bridge-status | 查桥状态 | read | |

### 2.7 memory / skill / ctx / task / agent / workflow（10）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| memory.store | 写长期记忆 | reversible | 工作区态 |
| memory.recall | 召回记忆 | read | |
| skill.discover | 发现技能 | read | |
| ctx.inspect | 检视上下文占用 | read | |
| ctx.plan | 进入/退出计划模式 | reversible | 模式态 |
| task.manage | 任务增删查改 | reversible | |
| agent.dispatch | 派发子代理/子任务 | elevated | **[待裁]** 自主执行；见 §3.10 |
| agent.team | 团队建立/撤销 | reversible | |
| agent.message | 代理间投递消息 | reversible | |
| workflow.run | 运行预定义工作流 | elevated | **[待裁]** 可能任意步骤；见 §3.10 |

### 2.8 git.*（6）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| git.read | 读仓库状态/历史 | read | |
| git.write | 提交/推送 | external | 不可逆/外部；红线 R1 禁 AI 自动 push |
| git.search | 历史检索 | read | |
| git.sandbox | 进入/退出工作树 | reversible | 可逆 |
| git.audit | 健康巡检 | read | |
| git.branch | 列出/切换分支 | reversible | 切换改工作树 |

### 2.9 model.* / ai.*（15）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| model.list | 列模型 | read | |
| model.manage | 导入/导出/下载模型 | external | 下载外部资产/磁盘 |
| model.provider | 配置供应商 | elevated | **[待裁]** 改凭据/端点；见 §3.8 |
| model.generate | 调用模型生成 | external | 外部 API/计费 |
| ai.embedding | 向量化 | external | 调 API/计费 |
| ai.rerank | 重排检索结果 | external | 调 API |
| ai.image | 图像生成/编辑 | external | 计费 |
| ai.vision | 图像理解/识别 | external | 调 API |
| ai.video | 视频生成/分析 | external | 计费 |
| ai.audio | 语音转写/合成 | external | 计费 |
| ai.doc | 文档解析/渲染 | read | 本地处理返回内容 |
| ai.codebase | 代码库理解/巡检 | read | |
| ai.self-knowledge | 自知识/线索回捞 | read | |
| ai.security | 安全扫描 | read | 只读扫描；跑扫描器 nuances 见 §3.10 |
| ai.review | 产物评审 | read | |

### 2.10 store / mcp / config / cron（7）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| store.vector | 向量库读写 | reversible | |
| store.files | 文件库读写 | reversible | |
| mcp.call | 调 MCP 服务器工具 | elevated | **[待裁]** 外部/任意；见 §3.9 |
| mcp.resources | 读 MCP 资源 | read | |
| mcp.auth | MCP 授权 | elevated | 开通能力 |
| config.read-write | 读写运行时配置 | reversible | **[待裁]** 可改端点/凭据；见 §3.8 |
| cron.manage | 定时任务增删查 | reversible | |

### 2.11 sys.*（31）

| capability | 摘要 | 提案档 | 备注 |
|---|---|---|---|
| sys.disk | 磁盘分析与清理 | external | 清理=删除不可逆 |
| sys.upgrade | 自升级/版本操作 | elevated | 改自身/不可逆 |
| sys.plugin | 插件热重载 | elevated | 插件安装 |
| sys.process | 进程监控与关停 | elevated | **[待裁]** 关停不可逆；见 §3.11 |
| sys.desktop | 桌面端控制 | elevated | **[待裁]** 远控 vs 主屏；见 §3.9 |
| sys.clipboard-snapshot | 截剪贴板画面 | read | 读 |
| sys.records | 记录进度/结构化输出 | reversible | |
| sys.guidance | 给模型的引导提示 | read | 只读提示 |
| sys.self | 自检/身份 | read | |
| sys.tool-discovery | 按需发现工具 | read | |
| sys.skill-create | 动态创建工具 | elevated | 创建可执行 |
| sys.evals | 评测与训练 | elevated | **[待裁]** 训练改模型；见 §3.10 |
| sys.realtime | 实时通道 | external | 外部连接 |
| sys.push | 推送通知 | external | 外部可见 |
| sys.project | 项目蓝图/模板 | reversible | |
| sys.optimize | 配置优化/变更提案 | reversible | |
| sys.build | 构建与部署工程 | external | 部署=外部/不可逆 |
| sys.test | 运行测试 | elevated | **[待裁]** 跑代码；见 §3.10 |
| sys.query | 数据查询/取数 | read | |
| sys.backtest | 回测 | read | 纯计算无副作用 |
| sys.strategy | 策略清单 | read | |
| sys.reverse | 逆向工程 | elevated | **[待裁]** 见 §3.10 |
| sys.rewrite | 文本改写 | reversible | |
| sys.image-to-web | 图片转网页 | reversible | 生成产物 |
| sys.replace-location | 按位置替换文档内容 | reversible | |
| sys.doc-title | 设文档标题样式 | reversible | |
| sys.artifact | 产物读写 | reversible | |
| sys.unpack | 解包 | reversible | **[待裁]** 同 fs.zip；见 §3.1 |
| sys.batch | 批量执行 | elevated | **[待裁]** 可能任意；见 §3.10 |
| sys.ask-user | 向用户提问 | read | 无副作用，弹问题给人 |
| sys.sleep | 等待 | read | 无副作用 |

## 3. 待裁清单（真正有争议、须人拍板；AI 不默默定案）

下列项两个档都站得住，或跨源冲突。给**推荐档 + 理由 + 竞争档**，最终由人裁（216 §6.3）。其余 §2 未标待裁的为按 §1 程序的 confident 默认，批准时一并确认即可。

### 3.1 fs.zip / sys.unpack（216 §6.3 点名）
- **竞争**：`reversible`（覆盖目标同名文件可再生）vs `external`（unzip 有 Zip Slip 路径穿越面）。
- **已核（决定性证据，2026-11-14）**：升 external 的唯一事实理由——Zip Slip 路径穿越——**在原生已被防住**。`Tools.java.unzip`（:3038）对每个条目用 `getCanonicalFile()` 规范化两侧路径（:3073–3074，折叠 `..`、解析符号链接），再做包含检查 `!tgtAbs.equals(destAbs) && !tgtAbs.startsWith(destAbs + File.separator)`（:3079），越界即 **REJECT**：「拒绝解压：条目越出目标目录」（:3081）。注释（:3063–3069）留痕：第一版用 `getAbsolutePath()` 不折叠 `..` 被 `ZipToolsTest` 抓到绕过，遂改 canonical。原生 `LoopModes.java:90–94` 亦明写 zip/unzip **故意不在** IRREVERSIBLE_TOOLS：破坏面是「覆盖同名文件、可再生」，且 unzip 自带该防护。
- **推荐**：`reversible`，**条件**：unzip 必须保留上述 canonical 包含检查（已实测存在且会 REJECT，非纸面承诺）。安全顾虑既已被原生防护消解，支持 reversible 的证据是决定性的。
- **须人裁（策略判断，非事实）**：是否接受「可逆 + 已验证防护」归 reversible，还是仍因「路径穿越面曾存在」保守升 external。事实子问题（防护是否存在且生效）已核闭合；剩下的纯策略取舍连同 193 Q5 交人（216 §6.3），本文不静默定案。

### 3.2 exec.shell-restricted
- **竞争**：`read`（固定白名单只读诊断，不接受任意 shell 字符串）vs `elevated`（毕竟是 shell 执行）。
- **推荐**：`read`，**条件**：白名单 + 只读边界不得放宽；一旦接受任意字符串即升 elevated。215 elevated 判据是「任意脚本」，受限白名单不满足。

### 3.3 sys.elevation
- **竞争**：`read`（摘要=查询提权代理是否可用，只读探测）vs `elevated`（语义涉提权）。
- **推荐**：查询本身 `read`；**任何实际提权授予动作**另归 elevated。须人裁是否把「查询」与「授予」拆成两个能力档。

### 3.4 device.clipboard
- **竞争**：`reversible`（本地、可覆盖）vs `external`（写入对其他 App 可见，215 §8.3 剪贴板隐私）。
- **推荐**：`reversible` + 隐私 overlay（敏感内容写入交人）。须人裁是否因跨 App 可见升 external。

### 3.5 隐私敏感读：device.screenshot / screenshot-readonly / device.location / net.web-search / device.open-url
- **竞争**：能力档 `read`/`mainScreen` vs 隐私/外部 overlay。
- **推荐**：能力档按 §2（screenshot/location=read，open-url=mainScreen，web-search=read），**但 215 §8.3 隐私拒绝是独立 overlay**：敏感界面/验证码/密码默认交人，不因能力档低而放行。须人裁隐私 overlay 与风险档如何叠加（建议：风险档定默认批准范围，隐私 overlay 独立否决，二者取严）。

### 3.6 amoo.memory（跨源冲突——2026-11-14 已核，定案 external）
- **原冲突**：catalog 摘要=「读取 amoo 记忆」（→ read），但原生 `LoopModes.IRREVERSIBLE_TOOLS` 含 `amoo_memory`（→ external）。
- **已核（决定性证据）**：原生 `LoopModes.irreversibleReason` 明说写语义——`LoopModes.java:280-282`：「amoo_memory 改的是跨会话共享记忆：写进去的条目会被以后的每一轮提问当成既定事实，**撤回不了**。要改记忆请在手机上手动发起。」三处独立佐证：IRREVERSIBLE_TOOLS 名单（:99）、四件套注释（:83-85）、reason 串（:280）。**是写不是读，catalog 摘要「读取」是误标。**
- **定案**：`external`（不可逆跨会话写）。待裁项关闭；剩下的只是「catalog 摘要该订正为写」这一真源订正动作，须人在改 `ATOMIC_GROUPS` 时一并修（与 §3.3 风险档入真源同处）。风险档本身已由原生证据定死，不再需人核读/写。

### 3.7 amoo.stop
- **竞争**：`reversible`（释放单飞锁本身可逆）vs `external`（原生 IRREVERSIBLE；它是 in-flight ask 的唯一紧急出口）。
- **推荐**：`external`（从原生底）。`LoopModes` 注释明说环内另有专门处理（`AmooLoop.executeOne`）。须人裁紧急出口是否豁免逐次确认（建议不豁免，但走快速通道）。

### 3.8 改凭据/端点/提权：model.provider / config.read-write / device.install-apk
- **竞争**：`reversible`（配置可改回）vs `elevated`（改端点/凭据=改授权规则；装 APK=提权+不可逆）。
- **推荐**：`model.provider`/`device.install-apk` → `elevated`；`config.read-write` → 若能改 auth/endpoint 则 elevated，否则 reversible。215 §8.2「不允许脚本自行改变授权规则」。须人裁 config 的哪些键算「改授权规则」。

### 3.9 远控/外部任意：net.browser / mcp.call / sys.desktop / khyos.ask
- **竞争**：`external`（外部可见）vs `elevated`（远程控制/任意工具）。
- **推荐**：`elevated`（215 elevated 含「远程控制」；mcp.call 可调任意外部工具）。须人裁「驱动浏览器」算远控还是外部交互。

### 3.10 跑代码/自主闭环：exec.background / amoo.loop / agent.dispatch / workflow.run / sys.evals / sys.test / sys.batch / sys.reverse / ai.security
- **竞争**：`read`/`reversible`（bounded 计算/扫描）vs `elevated`（执行代码/自主多步/训练改模型）。
- **推荐**：执行任意代码或自主多步的 → `elevated`（fail-closed）；纯本地只读扫描（ai.security 若只读）→ read。须人裁 sys.test/sys.batch 的「bounded runner」是否够格降档（建议不够，执行代码即 elevated）。

### 3.11 不可逆关停/清理：exec.kill / sys.process / sys.disk
- **竞争**：`external`（杀进程/删文件不可逆）vs `elevated`（系统级操作）。
- **推荐**：`external`（不可逆副作用，215「删哪些」）；sys.process 若含提权关停则 elevated。须人裁。

## 4. 分类统计与原生名单交叉核对

### 4.1 提案档 tally（逐行从 §2 表数出，待裁项按推荐档计）

| 档 | 数量 | 说明 |
|---|---|---|
| read | 48 | 纯读/无副作用 |
| reversible | 33 | 可逆工作区/设备态 |
| mainScreen | 6 | 主屏/目标 App 交互 |
| external | 27 | 外部可见/不可逆 |
| elevated | 21 | 提权/任意脚本/插件/远控 |
| **合计** | **135** | 与 catalog 能力数一致 |

> 这是草案 tally：§3 待裁项定案后会在档间移动（如 §3.1 zip/unzip 若裁 external 则 reversible−1/external+1）。amoo.memory 已核为 external（§3.6），与草案计数一致、不移动。施工时由生成器重新 tally，**不引本文字面值当实测**——213 判据纪律。

### 4.2 与原生 LoopModes 风险名单交叉核对（surface 一致性/冲突）

| 原生名单 | 成员 | 本文提案档 | 一致？ |
|---|---|---|---|
| HIGH_RISK_TOOLS | exec, rm | exec.shell=elevated, fs.delete=external | ✓ 一致（均高/不可逆） |
| IRREVERSIBLE_TOOLS | secret_* | credential.delivery=external | ✓ |
| IRREVERSIBLE_TOOLS | adou_signin | app.adou-signin=external | ✓ |
| IRREVERSIBLE_TOOLS | amoo_ask/dispatch/stop | external | ✓ |
| IRREVERSIBLE_TOOLS | amoo_memory | external（已核定案） | ✓ 原生 reason 明说写跨会话记忆、撤回不了（:280）；catalog「读取」误标，见 §3.6 |

**结论**：`amoo.memory` 读/写冲突已核（§3.6：原生 reason 明说写、撤回不了 → external 定案，catalog「读取」误标）；本文提案档与原生既有风险名单一致。这证明分类不是凭空猜，而是与既有执行点对齐——正是 216 §3.3「跨语言黄金向量钉零漂移」要钉的。

## 5. P0 复现测试规格（216 §8 细化；锚定真实现有测试；§5.2/§5.4/§5.3 均已执行 PASS）

**本轮亲读的真实锚点**（只读，未改）：
- [tool_engine_test.dart:150](../../../delivery/mobile/khy-os-client-app/test/tool_engine_test.dart#L150)：`test('ask does NOT block execution (not enforced)')` —— **作者自己的绿测试已把 E-A01 钉成当前行为**：注册 ask 工具 → `execute` → 断言 `r.success == true`。这就是引擎层 ask 缺口的 repro-before，无需发明。
- [tool_engine_test.dart:7](../../../delivery/mobile/khy-os-client-app/test/tool_engine_test.dart#L7)：`makeTool({permission, onExecute})` helper —— `onExecute` 回调是执行计数器。
- [tool_host_client_test.dart:13](../../../delivery/mobile/khy-os-client-app/test/drivers/tool_host_client_test.dart#L13)：`ToolEngine()` + `registerAll([ToolDef])` + `ToolEngineHostClient(engine)` + `invoke` → `ToolResult`；**未注册任何 ask 工具、未测 callId**（缺口所在）。
- [wechat_approval_bridge_test.dart:7](../../../delivery/mobile/khy-os-client-app/test/wechat_approval_bridge_test.dart#L7)：`_RecordingBridge implements WechatApprovalChannel`（记录请求、返回 deny）+ `makeAskTool(effects)`（execute 追加 `ran:target`）—— **正控制已存在**：deny 时 `effects` 为空 = 被门拦下。

### 5.1 复现 1：引擎层 ask 不强制（已有绿测试，引用即可）
- **repro-before**：`tool_engine_test.dart:150` 现断言 `r.success==true`（ask 工具直接执行）。原始输出 = 该测试 PASS（绿）。
- **差分（施工后须翻）**：broker 落地后，同一输入应 `r.success==false` 且 output 含 `approval_required`（无 channel）或走审批。**这条测试从「钉 bug」翻成「钉修复」**，是 RUNTIME-007 的 repro-after。
- **正控制**：`wechat_approval_bridge_test.dart` 的 deny 路径 `effects` 为空（门生效）。证明测试能区分有门/无门，非恒绿。

### 5.2 复现 2：driver/host 路径无门（新增测试规格，待执行）
- **构造**（沿用 tool_host_client_test.dart:13 结构）：`engine=ToolEngine()`；`effects=<String>[]`；`engine.register(makeAskTool(effects, name:'vision_tap'))`（permission=ask）；`client=ToolEngineHostClient(engine)`。
- **负控制（bug 现状）**：`await client.invoke('vision_tap', {'target':'x'})` → 断言 `effects == ['ran:x']`（**未触发任何审批即执行**）。
- **正控制**：同输入经 `ApprovalGatedToolEngine(channel:_RecordingBridge(deny))` → 断言 `effects` 为空 + `bridge.requests` 含该 ask。
- **仪器自验**：若摘掉门接线两控制都绿，该测试不能签字（216 §9.1）。
- **落点**：新增 `test/drivers/tool_host_approval_repro_test.dart`（**新文件，不覆盖在飞 tool_host_client_test.dart**）。施工时建，本轮只出规格。
- **→ 已执行 PASS（2026-11-14）**：本规格的负/正控制 + 仪器自验已由独立 Dart SDK 3.14.0 对**真实在仓源**跑通（harness `D:/Portable/dart_verify/verify.dart`，经 package_config 映射 `package:khy_os_client`，无副本；等价 flutter_test 件 `test/authz_residual_gate_test.dart` 已写待 Flutter）。负控制：基础引擎经 host client 裸跑 ask 工具 effects=1（bug 现）；正控制：`ApprovalGatedToolEngine`+deny→effects 空+「用户拒绝了该操作」、allow→问一次跑一次；仪器自验非空转。详见 216 §14.2。规格用 `vision_tap` 作 ask 名，harness 用通用 ask 工具 `risky_thing`，断言结构一致。

### 5.3 复现 3：AgentLoop 无门（已执行 PASS，2026-11-15 Flutter 真工具链）
- **构造**（沿用 agent_loop_test.dart:38）：`AgentLoop(engine: 普通ToolEngine, config: AppConfigData(...))`；注册 ask 工具带 effects 计数。
- **驱动**：需一个 fake model gateway，发一轮含该 ask 工具 tool_call 的响应（AgentLoop 在 [agent_loop.dart:131](../../../delivery/mobile/khy-os-client-app/lib/core/agent/agent_loop.dart#L131) 调 `_engine.execute`）。
- **负控制**：断言 effects 非空（ask 工具经 AgentLoop 直接执行，无审批）。
- **正控制**：`AgentLoop(engine: ApprovalGatedToolEngine(...))` → effects 为空。
- **注**：现有 agent_loop_test.dart 只测 config/ExecutionLog，**未驱动真实工具回合**；本规格须补 fake gateway。**harness 已建并跑通**：[test/authz_agentloop_gate_test.dart](../../../delivery/mobile/khy-os-client-app/test/authz_agentloop_gate_test.dart)（新文件名，只读作者在飞源，不改）。
- **→ 已执行 PASS（2026-11-15，flutter test --no-pub 单独 invocation，exit 0，4/4）**：用本地 fake LLM `HttpServer`（loopback:0）驱动真实 `AgentLoop.run('go')` 工具回合。四条全绿且**非空转**：① 负控制——普通 `ToolEngine` 经 AgentLoop 裸跑 ask 工具，effects=`['ran:probe']`（坐实 AgentLoop 自身无门）；② 正控制 deny——`ApprovalGatedToolEngine`+`DialogApprovalChannel(confirm:false)`，confirm 恰被问一次 `['risky_thing']`、effects 为空（零副作用）；③ 正控制 allow——confirm 问一次、effects=`['ran:probe']`（执行一次）；④ **仪器自验**——断言 effects 非空 + 回合到达 `AgentPhase.executing`，若 fake gateway 没真驱动 execute 则此条红，故 ②的 effects-空断言非 vacuous。
- **更正前轮过度保守判断（2026-11-15 实测）**：前轮记「fake gateway 须满足 ZenGate identity/HMAC/session 流程，非平凡，本轮不建」——**实测推翻**：[zen_gate.dart:476](../../../delivery/mobile/khy-os-client-app/lib/core/gateway/zen_gate.dart#L476) 的 `postChatCompletion` 对**非 Zen 端点**就是裸 `dio.post('$baseUrl/chat/completions')`→`_asJsonMap(resp.data)`，**无 identity/HMAC/session 派生**（那些只在 Zen 流式路）。故一个返回 `{'choices':[{'message':…tool_calls…}]}` 的本地 HttpServer 即可驱动真回合，harness 平凡可验。前轮「编不动」亦更正：AgentLoop 虽无 Flutter import，但 `flutter test` 真工具链可编（dio+config 链全解析），无需纯 Dart SDK。
- **结构覆盖论证（2026-11-14 实测，非运行时）**：AgentLoop 全文**唯一**工具执行点是 [agent_loop.dart:131](../../../delivery/mobile/khy-os-client-app/lib/core/agent/agent_loop.dart#L131) `await _engine.execute(toolName, args)`（grep 确认无第二处、无绕过）。而 `execute` 的门行为已由 verify.dart 场景 1/2/3/8 对真实源运行时实证：基础 `ToolEngine.execute` 裸跑 ask 工具、`ApprovalGatedToolEngine.execute` 经多态派发问门。故 `AgentLoop(engine: ApprovalGatedToolEngine(...))` 的**每一轮工具调用必经门**——§5.3 缺口由「唯一执行点 + 已验 execute 多态」**结构闭合**。**全回合运行时 harness 已于 2026-11-15 建并跑通（4/4 PASS，见上）**：前轮「ZenGate 须 identity/HMAC、fake gateway 非平凡」的判断被实测推翻——非 Zen 端点路就是裸 dio.post，本地 HttpServer 即可驱动，结构论证 + 运行时实证双重闭合。

### 5.4 复现 4：callId 接收即丢（新增测试规格，待执行）
- **构造**：`engine.register(ToolDef(name:'spy', execute:(args) async { captured=args; return ok; }))`；`client=ToolEngineHostClient(engine)`。
- **断言**：`await client.invoke('spy', {'k':'v'}, callId:'call_x')` → `captured` 不含 `call_x`/`callId` 任何键（[tool_host_client.dart:58](../../../delivery/mobile/khy-os-client-app/lib/core/toolhost/tool_host_client.dart#L58) 调 `execute(name,args)` 不带 callId，也不注入 args）。
- **差分（施工后）**：callId 贯穿后，execute 签名/原生信封应能收到 `call_x`；断言翻成「captured 含 callId」。
- **→ 已执行 PASS（2026-11-14，repro-before）**：独立 Dart SDK 对真实源跑通（verify.dart 场景 9）。spy 工具确捕获 `{'k':'v'}`（仪器非空转），`invoke('spy',{'k':'v'},callId:'call_x')` 后 captured **不含 callId 键、不含 call_x 值**——坐实 [tool_host_client.dart:58](../../../delivery/mobile/khy-os-client-app/lib/core/toolhost/tool_host_client.dart#L58) 收 callId 即丢。**此 bug 由 B+ 门片不修**（callId 贯穿是 216 §3.5 独立项，仍待施工）；本条只确认 repro-before，不宣称已修。

### 5.5 存证与边界
- 存证落 `works/data/khy/feedback/<task-id>/`：`complaint.md` / `repro-before.txt`（原始输出）/ `differential.md`（≥2 候选病因）/ `repro-after.txt`。
- **工具链现状（2026-11-14 更新）**：已落独立 **Dart SDK 3.14.0**（官方 dart-archive，纯 Dart，非 Flutter）。门链是纯 Dart，故 **§5.2（driver/host 无门）与 §5.4（callId 即丢）已对真实在仓源执行 PASS**（verify.dart 15/15，含负控制与仪器自验，非空转）。**§5.3（AgentLoop 无门）已于 2026-11-15 执行 PASS**：Flutter SDK 已落（`D:/Portable/2-tools/flutter/flutter`，3.47.2 stable），`flutter test` 真工具链可编 AgentLoop（dio+config 链全解析）；新建 [test/authz_agentloop_gate_test.dart](../../../delivery/mobile/khy-os-client-app/test/authz_agentloop_gate_test.dart) 用本地 fake LLM 驱动真回合，4/4 PASS（含仪器自验，非空转），只读作者在飞 `agent_loop.dart`（` M`）不改。**§5.1** 引擎层 ask 不强制的**行为**已由 verify.dart 场景 8 确认（基础 `engine.execute` 裸跑 ask 工具 effects=1）；作者原绿测试 `tool_engine_test.dart` 用 flutter_test，**已于 2026-11-15 在真 Flutter 工具链跑通**（见 216 §14.2 全 authz 套件）。不宣称已跑、不伪造 PASS。
- 现有测试文件 `tool_engine_test.dart`(` M`)、`tool_host_client_test.dart`(`??`)、`wechat_approval_bridge_test.dart`(`??`) 均在飞，**本轮只读不改**；新增复现测试用新文件名，施工时建。

## 6. 落定后如何接进 ATOMIC_GROUPS（施工步骤，gated，本轮不做）

一旦 213 在飞 lane 落定 + 用户裁完 §3：
1. 在 `atomicCapabilityRegistry.js` 的 `ATOMIC_GROUPS` 为每个 canonical 能力加 `risk` 字段（值取 §2/§3 定案档）。**该文件现在 ` M`，本轮不碰。**
2. 重跑 `node scripts/ci/gen-atomic-capabilities.js` 让 catalog 携带 risk；`--check` 钉不漂。
3. Dart `ToolDef.permission` 与原生 `LoopModes` 名单**派生/对齐**这同一份，加跨语言黄金向量测试（216 §3.3 / A-T06）。
4. 门下沉进 `ToolEngine.execute`（216 §3.1），按 §7 S1 观察者先接无门路径并记录。

**本轮零代码**：以上 1–4 全部 gated，不在本文执行。

## 7. 边界重申

- 本文是 216 的**非冲突准备片**：新建本文 + 索引行，零在飞源码改动。
- §2/§3 是**待人裁决的草案**，不是已定案；§5 的 **§5.2/§5.4 已执行 PASS（repro-before，确认 bug）**，**§5.3 已于 2026-11-15 用 Flutter 真工具链执行 PASS（4/4，非空转）**——已执行的是复现确认，**不等于修复已验收**（callId 等修复仍待施工）。
- 门下沉等施工仍等 213 在飞 lane 落定 + 用户批准（216 §0.2 两段闸）。
- 不抢改在飞文件、不伪造测试 PASS、不宣称「授权已统一」。