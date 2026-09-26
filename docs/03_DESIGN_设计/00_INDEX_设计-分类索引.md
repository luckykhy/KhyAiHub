# 00_INDEX 设计分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/03_DESIGN_设计/`）收容**架构与设计规范**类文档：架构设计（ARCH）、协议、数学建模、治理规范、设计期提示词（OTHER）。**不收**实现报告（归 `04_IMPL_实现/`）、运维指南（归 `07_OPS_运维/`）。

> 注：`DESIGN-ARCH-026`、`DESIGN-ARCH-029` 历史遗留重号已治理——`khy-agent-sdk` 改 `DESIGN-ARCH-043`、`Agent自愈微循环` 改 `DESIGN-ARCH-044`，内部印记与外部引用已同步更新，全目录编号现唯一。

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-ARCH-001] khy-移动智能体协议.md|移动智能体协议|在产|
|[DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.md|CB-SSP数学建模|在产|
|[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md|受约束随机最短路径|在产|
|[DESIGN-ARCH-004] _cbssp_progress.md|CB-SSP进度档|在产|
|[DESIGN-ARCH-005] agentfs-智能体文件系统.md|智能体文件系统|在产|
|[DESIGN-ARCH-006] ai-gateway-适配器协议架构.md|网关适配器协议|在产|
|[DESIGN-ARCH-007] m1-微内核-ipc-moonbit.md|微内核IPC设计|在产|
|[DESIGN-ARCH-008] moonbit-系统边界.md|MoonBit系统边界|在产|
|[DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09.md|可视化工作流编辑|在产|
|[DESIGN-ARCH-010] 核心架构.md|核心架构|在产|
|[DESIGN-ARCH-011] 应用接入标准.md|应用接入标准|在产|
|[DESIGN-ARCH-012] 工具延迟加载.md|工具延迟加载|在产|
|[DESIGN-ARCH-013] 弱模型兼容.md|弱模型兼容|在产|
|[DESIGN-ARCH-014] 模式图谱.md|模式图谱|在产|
|[DESIGN-ARCH-015] 编码规范.md|编码规范|在产|
|[DESIGN-ARCH-016] AI_Agent显示规范.md|Agent显示规范|在产|
|[DESIGN-ARCH-017] 元工具系统设计.md|元工具系统|在产|
|[DESIGN-ARCH-018] Agent提示词复用机制.md|提示词复用机制|在产|
|[DESIGN-ARCH-019] 用户输入预处理规范.md|输入预处理规范|在产|
|[DESIGN-ARCH-020] 架构债治理报告.md|架构债治理|在产|
|[DESIGN-ARCH-021] 巨型环反转设计.md|巨型环反转|在产|
|[DESIGN-ARCH-022] khyos多实例并发文件控制规范.md|多实例文件锁|在产|
|[DESIGN-ARCH-023] khyos文档排版与格式控制规范.md|文档排版规范|在产|
|[DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范.md|元规划约束注入|在产|
|[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md|服务调用审批网关|在产|
|[DESIGN-ARCH-027] Agent依赖自愈机制规范.md|依赖自愈机制|在产|
|[DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因.md|通信防御零静默|在产|
|[DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议.md|有限窗口降级兜底|在产|
|[DESIGN-ARCH-030] 源端构建-目标机自愈运行.md|源端构建自愈部署|在产|
|[DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译.md|网关日志租界隔离|在产|
|[DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成.md|内嵌MD工作台右键集成|在产|
|[DESIGN-ARCH-034] 动态自适应约束求解引擎.md|能力向量动态配约束|在产|
|[DESIGN-ARCH-036] 万物结构化熔炉引擎.md|NL前置坍缩结构化|在产|
|[DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎.md|自举创世闭环自愈|在产|
|[DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关.md|意图光谱动态提权（已在产，见 GOVERNANCE-LEDGER）|在产|
|[DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.md|agent-sdk对齐融合|在产|
|[DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试.md|自愈微循环|在产|
|[DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md|非活跃通道僵尸治理|在产|
|[DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md|聊天污染与截断治理|在产|
|[DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离.md|轨迹溯源与防投毒|在产|
|[DESIGN-ARCH-048] khyos轨迹回放与确定性复现.md|轨迹回放确定性复现|在产|
|[DESIGN-ARCH-049] 轨迹即教材-AI引导回放.md|轨迹即教材AI引导回放|在产|
|[DESIGN-ARCH-051] 单人维护者健康驾驶舱.md|单人维护健康驾驶舱|在产|
|[DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知.md|任务驱动读取搜索范围规划|在产|
|[DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开.md|命令输出折叠与展开|在产|
|[DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件.md|AI逆向工程还原自验|在产|
|[DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固.md|对抗式训练抗压自检|在产|
|[DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作.md|桌面操控眼耳嘴模拟操作|在产|
|[DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.md|细粒度权限+记忆主动化|在产|
|[DESIGN-ARCH-059] 能力即代码.md|能力即代码（学习落为可执行模块+测试+自动发现）|在产|
|[DESIGN-ARCH-060] khy 功能接线与编排总图.md|接线五件套+编排主线切点图|在产|
|[DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕.md|开源更新包只读甄别精华弃糟粕|在产|
|[DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界.md|常驻/一次性/按需 三层 SSoT + 操作化 + 守卫|在产|
|[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md|书序架构阅读主线（书目录→khy 真源映射+术语对照）|在产|
|[DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图.md|后端纵向逻辑关系图（一条消息下行路径·汇流点/单一出口/IoC 缝三骨架点）|在产|
|[DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.md|Hermes v0.18.0 三支柱研究+gap 分析；落地 /goal 证据门（evidence-based completion）|在产|
|[DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关.md|前端代理出站桥路由与启停开关|在产|
|[DESIGN-ARCH-067] opencode高含金量功能教学与khy-os差距补齐路线.md|opencode 12 项功能对照教学；References/LSP 诊断/权限 auto 三项差距分阶段补齐|在产|
|[DESIGN-ARCH-067] 动态模型差异化适配引擎.md|动态模型差异化适配引擎（**编号与上一行冲突，待重编**）|在产|
|[DESIGN-LAY-005] 仓库层级板块规范.md|顶层目录 L0–L6 分层 + 允许依赖边 + docs 统一编号轴 + 任务入口命名（层级单一真源）|在产|
|[DESIGN-TOOL-002] 拓展契约与核心边界规范.md|核=壳+漏斗+网关；拓展=一目录一 manifest；根优先级+惰性激活+删目录即消失（拓展契约单一真源）|在产|
|[DESIGN-ARCH-071] 通道选择决策矩阵.md|五通道（读状态/服务直调/CLI/API/看屏幕）判定顺序+反模式+降级（通道裁决单一真源）|在产|
|[DESIGN-ARCH-072] 任务最小闭环-裁决接线与交付台账.md|收尾仲裁门三态裁决+交付台账（任务最小闭环单一真源）|在产|
|[DESIGN-ARCH-073] khyos 核心任务循环-稳定交付总纲.md|受理→交付核心循环运行时契约（072 上位总纲）|在产|
|[DESIGN-ARCH-074] khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录.md|账号=用户名；alias 软冲突；密码必填；ai-backend LAN 暴露（账号体系单一真源）|在产|
|[DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案.md|桌面端↔CLI/TUI 互联：发现链(backend_runtime.json)+会话/供应商真源归一+bridge(9222) 实时共享，P0-P4 分期落地|在产|
|[DESIGN-ARCH-090] TUI用户评价调研与痛点分析.md|TUI 痛点调研（081–089 上游输入）|在产|
|[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.md|一处配置全 Agent 密钥端点（GUI 门面+应用矩阵+测试规范）|在产|
|[DESIGN-ARCH-095] TUI交互完善调研与实施路线.md|TUI 交互差距分析与 P0–P3 路线（三路调研收口件）|在产|
|[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.md|七核两层（运行核：壳/漏斗/网关/智能体；主张核：工作流/记忆/拓展契约）一词一解收口件；证据锚点+定位裁决|在产|
|[DESIGN-SOURCING-001] 借鉴与实现统一规则.md|可借/不可借黑白名单 + 五种借鉴方式 + 六字段提案 + FEATURE-OWNERSHIP 归属登记（借鉴与实现统一单一真源）|在产|
|[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md|数学重塑提示词链|在产|
|[DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词.md|分阶段防闪退提示|在产|
|[DESIGN-OTHER-003] khy-系统提示词结构图.md|系统提示词结构图|在产|
|[DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md|特性访问提示胶囊|在产|
|[DESIGN-OTHER-005] desktop-rd-桌面端调研指针.md|桌面端开源项目调研指针|在产|
|[DESIGN-PERF-002] khy-cli-交互流畅度修复方案-v1.md|CLI 流畅度三阶段修复方案（2026-09-15 改号：`PERF-001` 归 `10_规范/` 性能规范）|在产|
|[DESIGN-PERF-003] TUI 启动阻塞治理方案.md|TUI 启动阻塞实测与治理（方向为预加载+去阻塞，非更加懒加载）|在产|
|[DESIGN-SIZE-001] khy-os 体积优化方案.md|体积三层优化方案|在产|

**历史未编号件**（保留原名；重命名须同步改写全部入站引用与 `.html` 孪生件，属独立一轮工作）：

|文件名|核心职责(10字内)|在产|状态|
| --- | --- | --- | --- |
|[DESIGN-ARCH-109] Y-code 借鉴实施方案.md|ycode 借鉴点与落地计划（原 `ycode-inspiration-plan 设计与实现记录`，占用 `083`）|在产|在产|
|[DESIGN-ARCH-108] CC-TUI复刻执行提示词.md|CC TUI 复刻执行提示词（原 `EXECUTION_PROMPT 设计与实现记录`，占用 `083`）|在产|在产|
|[DESIGN-ARCH-111] 规则遵守保障机制.md|规则登记表→门禁绑定层：门成员资格从登记表派生、归类枚举、门档强度、抑制、覆盖率红线、反孤儿守卫|派生|派生|
|[DESIGN-ARCH-112] khyos-Harness架构对照.md|四层架构与 Harness 五要素→khyos 文件路径映射、baseline 六处更正、病灶章节归属|在产|在产|
|[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md|AI修改三模态反馈契约|在产|在产|
|[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md|谁做 vs 怎么做：默认自做 + 三闸门(G1 点名/G2 能力缺失/G3 隔离)准入、委派契约、禁止项、降级与反模式；规则 PROCESS-004|在产|在产|
|[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md|CH-6 外部智能体委派准入：G1 显式点名 / G2 本地能力缺失 / G3 需隔离环境，其余一律 khy 自做（默认档是自做，委派需举证）|在产|在产|
|[DESIGN-ARCH-115] TUI 启动板块设计.md|TUI 板块设计第 1 块：进程→输入框可用的六拍节拍链与契约、两渲染层原子交接、失败态二分、门控净新增 0、10 条验收|在产|在产|
|[DESIGN-ARCH-116] khyos-插件系统契约(@khy/plugin-sdk).md|自有插件系统契约真源：① @khy/plugin-sdk（manifest 4 必填字段 name/namespace/engines.khy/main、发现源 6 路 eager-lazy 边界、命名空间+版本门控，测试 26 条全绿）；② 姊妹篇 .khy/hooks.json Hooks 配置契约（hookConfigSchema 真源 + 11 事件 + 阻断/审计退出码语义 + 最小 PreToolUse 危险命令拦截样例，测试 17 条全绿）；与 `ccSkillBridge`（借 CC 生态）并行|在产|在产|
|[DESIGN-ARCH-117] khy-多端入口矩阵.md|四端（cli/desktop/mobile/web）入口的单一真源：把此前五处互相矛盾的端定义收敛成带检活的登记表；落点 L2 `services/backend/src/services/entrypoints/`（不新建顶层目录）、仓库级 vs 本机级定档分离、产物坐标只存指针不复制；含幽灵端等四条未收口清单|在产|在产|
|[DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复.md|拖选复制失效的三条独立根因（press 被无条件吞 / Shift 修饰位被丢弃 / 备屏绕过未知终端保护）；v2 三层方案：判据收窄（已完成）→ 应用内自绘选择（跳出鼠标通道互斥，对齐 claude-code 松手即复制）→ 门控与登记收口；含 13 条反例矩阵与三层落地清单|在产|在产|
|[DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md|ARCH-119 第二层（应用内自绘选择）的可执行验收标准：`S-xx`/`V-xx`/`A-xx`/`X-xx`/`N-xx` 五组用例的三段式（输入→期望输出→通过条件），面向小模型直接据以实现；含自验结果（模型层 27/27 实跑绿、全 TUI 771/771 无回归、5 条反例均能检出错误实现）|在产|在产|
|[DESIGN-ARCH-120] khy-移动端合并方案.md|收口 ARCH-117 遗留幽灵端：`apps/khy-mobile` 0 个 git 跟踪文件、源码已丢失，故不存在源码级合并，改为三段收编（契约收编 / 引用收口 / 目录隔离）；唯一真实差距是扫码，用 `mobile_scanner` 补齐并修掉 `Uri.splitQueryString` 误用；含能力对等矩阵、解析器四条不变量、跨语言契约测试、三条不可回退不变量；目录隔离明确不执行并列出爆炸半径|在产|在产|
|[DESIGN-ARCH-121] khyos-CC-Harness借鉴清单.md|黄佳《Claude Code 实战：Harness 工程之道》全书机制→借鉴决策 36 条（✅17/🔄10/🔁8/❌1）；P0/P1 落地详析 12 条（K-01~K-12）；载体改造（YAML→JSON 双文件）、不采纳 4 条理由、三轮施工序、整合总图 3 不变量|在产|在产|
|[DESIGN-ARCH-122] TUI 设计族总纲.md|TUI 设计族唯一导航入口与 scope 裁决真源（20 编号 / 21 文件，5 组；含 119 同号双文件）；规则冲突以 `[DESIGN-ARCH-102]` 为准|在产|
|[DESIGN-ARCH-123] K-01~K-12 施工盘点清单.md|施工前只读盘点：4 处复核订正（K-12 落点应为 `_patternRules` 而非 `rules`、pattern rules 的 `default:true` 对 opt-in 模式无效、内置 agent 实为 26 个非 5 个、`loadAgents.js` 的 YAML frontmatter 与 §2.5 冲突）；逐条落点/巨石/改动量/门禁风险表；5 件待裁决事项；前置检查命令与 `.khy/` 回滚路径|在产|在产|
|[DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案.md|CC 模式（`KHY_CC_TUI=1`）下剪贴板底层通道（`utils/ccClipboard.writeClipboard`）与选区算法叶子（`selection.js`）补齐提案（**提案待评审、尚未编码**）；上游依赖 `[DESIGN-ARCH-119]`/`[DESIGN-ARCH-111]`；含盲区实证（6 层逐层定位，断点为 `CcApp.js` 零消费者）、方案 A/B 对比、7 项移植清单、键盘语义待决项、附录 A 编号冲突收口说明|在产|在产|
|[DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09.md|桌面端 UI 调研差距分析|在产|在产|
|[DESIGN-RES-002] 桌面端智能体UI每日调研-2026-09-10.md|桌面端 UI 每日调研日志|在产|在产|
|[DESIGN-ARCH-137] khyos运行时信息获取规则与读取预算接线方案.md|PROCESS-007 从「只约束改本仓的 AI」扩展为「约束 khyos 运行时」：三轴六条（定位/取样/存续）+ 契约 A–D + 四期落地；含四项实测断点（运行时零命中 3120 文件、`scopePlan` 零消费者、`PreCompact.additionalContext` 零消费、无任务级累计读取预算）|提案|提案|

**2026-09-10 规范族拆分**：全部独立编号规范族（`DESIGN-A11Y/API/ACP/BACKUP/CACHE/CICD/COMM/DB/DEP/
DEPLOY/DOC/ENV/ERR/FE/GIT/I18N/INDEX/LOG/MEM/MONITOR/MS/OUT/PERF/PRIV/REVIEW/SEC/TEST/TOOL`，
以及未编号协议件 `FILE-FORMAT-PROTOCOL.md`、`RELIABILITY-PROTOCOL.md`）已迁入
[`docs/10_规范/`](../10_规范/00_INDEX_规范-总目录.md)（规范目录）。ARCH 编号的设计族与治理单一真源
（068/069/070/071 等）留在本目录——拆分口径与台账见该目录 00_INDEX 第三节与
`docs/04_IMPL_实现/[IMPL-RPT-049]`。`FILE-FORMAT-PROTOCOL` 于 2026-08-15 曾从 `02_CONCEPTS_概念入门/`
迁入本目录，本次随规范族一并迁出。

> `FILE-FORMAT-PROTOCOL.md` 于 2026-08-15 从 `docs/02_CONCEPTS_概念入门/` 迁入本目录：它是
> **强制标准**（违反即过不了 `check-change-safety` 门控），不是给小白读的概念入门篇，此前落在
> 概念目录是历史批量搬迁的遗留，并因此成为 `docs:check-beginner` 的孤儿页。
> 它与 `RELIABILITY-PROTOCOL.md` 互补；后者正文提到的 `COMMUNICATION-PROTOCOL.md`
> **在仓库中不存在**（如实登记，本轮不补写）。

> **`[DESIGN-LAY-005]` 是「新代码/新目录该放哪一层、能依赖谁」的单一真源**，
> 由 `npm run check:layout` 的 `layer-registry` 规则强制执行。`AGENTS.md`、`README.md`、
> `[OPS-MAN-169]` 均指向它，不重复其内容。
>
> **`[DESIGN-TOOL-002]` 是「这东西该进核还是该做成拓展」的单一真源**，是 `068` 的下位法：
> `068` 管顶层目录属于哪一层，`069` 只把 L5 `extensions/` 内部的契约写细（manifest 形状、
> 根优先级、惰性激活、删目录即消失）。由同一守卫的 `extension-contract` 规则强制执行。
>
> **`[DESIGN-ARCH-071]` 是「一次操作该走哪条通道」的单一真源**：五通道（直接读状态/服务层直调/CLI/Web API/看屏幕）
> 的五问判定顺序、适用/禁止/降级与反模式。`AGENTS.md` 架构速查的「通道选择判定」节是它的压缩版，两处同改。
>
> **编号缺陷（如实登记，本轮不重编）**：`[DESIGN-ARCH-067]` 被两份文档同时占用
> （`opencode高含金量功能教学…` 与 `动态模型差异化适配引擎`），违反 [MGMT-STD-001]
> 编号唯一性。重编需同步改写入站引用与 `.html` 孪生件，属独立一轮工作。
> 因此本次新增文档取 **068**（跳过冲突号），下一个空号为 069。
>
> **订正（2026-09-16，二次）**：上一段的「下一个空号为 114」写于 `113` 落盘当时，**已两次过时**
> ——`114` 已于 2026-09-16 被 `委派边界决策矩阵-第六通道外部智能体` 占用，`115` 同日被
> `TUI 启动板块设计` 占用。**当时下一个空号为 116。**
> 另注：`114` 在本索引中**被登记了两行**（一行标「定稿」、一行标「提案」，指向同一文件），
> 与 [MGMT-STD-001] 的编号唯一性不符，待维护者裁决去重（本轮未擅自删除，避免与并行的写入冲突）。
> 新增文档前请以本节文件清单为准复核，勿沿用旧结论。
>
> **订正（2026-09-17，三次）**：上一段的「下一个空号为 116」同样**已过时**。实测本目录占用号已达
> `119`（`116` 插件系统契约、`117` 多端入口矩阵、`118` HQ 能力吸收与多机协作规范、`119` TUI 原生
> 文本选择修复先后落盘）。本次新增 `khyos-CC-Harness借鉴清单` 取 **121**：`120` 留作缓冲，
> 避免与并行写入再次撞号。**当前下一个空号为 122（120 为保留缓冲）。**
> 注意：`119` 当前仅存在 `.md`（无 `.html` 孪生件），属未完成的三件套同步，待其作者补齐或
> 运行 `npm run docs:build` 收口。
>
> **订正（2026-09-22，四次）**：上一段的「下一个空号为 122」已过时。实测本目录占用号
> 已达 `127`（`122` TUI 设计族总纲、`123` K-01~K-12 施工盘点清单、`124` CC 模式剪贴板
> 复制能力补齐提案、`125` 桌面端新对话卡片工作空间选择、`126` 跨端 AI 编程任务看板泳道
> 编排方案、`127` khyos 可维护性诊断与减负方案先后落盘）。本次新增
> `khyos结构化输出方案-输出卫生层与语义渲染契约` 取 **128**。**当前下一个空号为 129。**
> 新增文档前请以本节文件清单为准复核，勿沿用旧结论。


### 二·补 2026-09-27 全量补齐（按物理子目录分组）

> **补录缘由**：2026-09-27 索引体检实测——本索引原先收录 **98 篇**，而本目录（不含
> `_archive_已删除孤儿引擎/`）实际有 **223 篇** `.md`，**漏收录 133 篇**（124 篇正文件 + 9 篇就近索引）。
> 本节的「核心职责」列只写**从文件名可直接推出**的最短描述，不臆造正文内容；「状态」列取各篇
> 头部 `> **状态**：…` 的原文，无该字段者（多为 2026-09 前落盘的老件）统一填 `在产`。
>
> **本节为纯增补**：未改动上方任何既有行（含他人未提交的在途条目），仅在 §二 末尾追加。
> ⚠ 补录时如实登记了 6 组编号冲突与 4 组同名重复件，见本节末「补录时发现的结构缺陷」。

#### DESIGN-ARCH/（补 78 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-ARCH-050] 项目整体意识与自驱收尾保障.md|项目整体意识与自驱收尾|在产|
|[DESIGN-ARCH-068] 仓库层级板块规范.md|顶层目录 L0–L6 分层真源|在产|
|[DESIGN-ARCH-069] 拓展契约与核心边界规范.md|拓展契约与核心边界|在产|
|[DESIGN-ARCH-070] 治理总纲与可执行规则.md|治理总纲十板块|在产|
|[DESIGN-ARCH-072] 模型上下文窗口探测规范.md|上下文窗口探测|在产|
|[DESIGN-ARCH-072] 项目规范化总纲.md|项目规范化总纲|在产|
|[DESIGN-ARCH-073] 规范快速参考卡.md|规范快速参考卡|在产|
|[DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线.md|opencode 功能教学与差距|在产|
|[DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.md|任务最小闭环与交付台账|在产|
|[DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.md|受理→交付核心循环|在产|
|[DESIGN-ARCH-079] TUI界面设计规范.md|TUI 界面设计规范|在产|
|[DESIGN-ARCH-079] TUI组件实现提示词.md|TUI 组件实现提示词|在产|
|[DESIGN-ARCH-080] 网页端信息架构与四页重设计-2026-09-08.md|网页端四页重设计|Draft（待评审冻结）|
|[DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.md|CC TUI 复刻实施计划|在产|
|[DESIGN-ARCH-082] CC模式输入框与光标设计.md|CC 输入框与光标|在产|
|[DESIGN-ARCH-083] CC模式表格与折叠设计.md|CC 表格与折叠|在产|
|[DESIGN-ARCH-084] CC模式注意力与选择设计.md|CC 注意力与选择|在产|
|[DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计.md|CC 子视图与滚动|在产|
|[DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪.md|CC TUI 复刻总计划|在产|
|[DESIGN-ARCH-087] CC模式微交互与反馈设计.md|CC 微交互与反馈|在产|
|[DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理.md|CC 快捷键与 Redo/Fork|在产|
|[DESIGN-ARCH-089] TUI设计模式调研报告.md|TUI 设计模式调研|在产|
|[DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.md|密钥与智能体统一管理|在产|
|[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md|Provider 卡片枢纽|在产|
|[DESIGN-ARCH-096] ycode 第二轮增量借鉴调研报告.md|ycode 第二轮借鉴|在产|
|[DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案.md|提示词静动分层与缓存|在产|
|[DESIGN-ARCH-099] 提示词架构横向调研与khy-os对齐方案.md|提示词架构横向调研|在产|
|[DESIGN-ARCH-100] 模型列表真值校验与过滤规范.md|模型列表真值校验|在产|
|[DESIGN-ARCH-101] 代理模式统一Agent模型管理与协议桥接方案.md|代理模式统一模型管理|在产|
|[DESIGN-ARCH-101] TUI 交互与展示规则细则.md|TUI 交互展示细则|在产|
|[DESIGN-ARCH-102] Khy TUI 统一规则手册.md|TUI 统一规则手册|在产|
|[DESIGN-ARCH-103] TUI 终端界面重设计方案.md|TUI 终端界面重设计|在产|
|[DESIGN-ARCH-105] ycode 第三轮增量借鉴调研报告.md|ycode 第三轮借鉴|在产|
|[DESIGN-ARCH-106] 项目规范化总纲.md|项目规范化总纲|在产|
|[DESIGN-ARCH-107] TUI组件实现提示词.md|TUI 组件实现提示词|在产|
|[DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记.md|TUI 与经典模式同步|在产|
|[DESIGN-ARCH-114] CLI 错误标准化规范.md|CLI 错误标准化|在产|
|[DESIGN-ARCH-116] khyos-插件系统契约(@khy-plugin-sdk).md|插件系统契约|在产|
|[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md|HQ 能力吸收与多机协作|在产|
|[DESIGN-ARCH-125] 桌面端新对话卡片工作空间选择与快捷键统一登记.md|桌面端新对话卡片与快捷键|一期+二期已实施|
|[DESIGN-ARCH-126] 跨端 AI 编程任务看板泳道编排方案.md|跨端任务看板泳道编排|方案|
|[DESIGN-ARCH-127] khyos 可维护性诊断与减负方案.md|可维护性诊断与减负|在产|
|[DESIGN-ARCH-128] khyos结构化输出方案-输出卫生层与语义渲染契约.md|结构化输出与语义渲染|在产|
|[DESIGN-ARCH-129] TUI 滚动-选择-历史-固定底部共存设计.md|滚动选择历史共存|在产|
|[DESIGN-ARCH-130] 前台与后台任务编排方案.md|前后台任务编排|提案|
|[DESIGN-ARCH-131] 报错一键交修闭环方案.md|报错一键交修闭环|在产|
|[DESIGN-ARCH-132] TUI选区锚点漂移修复方案.md|TUI 选区锚点漂移修复|在产|
|[DESIGN-ARCH-133] 桌面端基本任务闭环-接入智能体工具循环.md|桌面端任务闭环|P0+P1+P2 已落地|
|[DESIGN-ARCH-134] TUI 启动屏视觉重设计.md|TUI 启动屏视觉重设计|P0 已实施|
|[DESIGN-ARCH-135] TUI长任务会话中断与压缩不接续修复方案.md|长任务压缩不接续修复|在产|
|[DESIGN-ARCH-136] 零尝试失败被误报为钉选抑制的修复方案.md|零尝试误报钉选抑制|在产|
|[DESIGN-ARCH-138] 工具调用能力判定与文本拦截协议.md|工具调用能力判定|在产|
|[DESIGN-ARCH-139] 网关零尝试(NO_ATTEMPT)与钉选残留第6次复发修复方案.md|零尝试与钉选残留复发|提案|
|[DESIGN-ARCH-140] 规则与规范依托全景盘点与补全提案.md|规则依托全景盘点|提案|
|[DESIGN-ARCH-140] khy启动卡顿定位与首帧前置方案.md|启动卡顿与首帧前置|提案|
|[DESIGN-ARCH-141] 动态工作流-运行时自演化与节点热插拔方案.md|动态工作流自演化|步骤 2+3 已完成|
|[DESIGN-ARCH-142] 用户数据安全更新与可选更新机制.md|数据安全更新机制|提案|
|[DESIGN-ARCH-143] DSH插件生态接入评估与分层适配方案.md|DSH 插件生态接入|提案|
|[DESIGN-ARCH-144] khyquant剥离为可选拓展的结构划分与接口契约方案.md|khyquant 剥离方案|提案|
|[DESIGN-ARCH-145] 用户DIY空间分层与安全边界统一方案.md|DIY 空间分层与边界|提案|
|[DESIGN-ARCH-146] TUI 卡片点击交互-选项命中与展开方案.md|TUI 卡片点击交互|在产|
|[DESIGN-ARCH-147] 好设计十诫的工程映射与设计判据落地方案.md|好设计十诫工程映射|P0 已落盘|
|[DESIGN-ARCH-148] README漏斗式重设计与真源指针化方案.md|README 漏斗式重设计|已实施|
|[DESIGN-ARCH-149] TUI选区复制携带ANSI残留修复方案.md|选区复制 ANSI 残留|提案|
|[DESIGN-ARCH-150] 模型设置页排版减负与配置动线重设计.md|模型设置页排版减负|已实施|
|[DESIGN-ARCH-151] TUI思维链折叠存储与显示减负方案.md|思维链折叠与显示减负|部分实施（P2 已落地）|
|[DESIGN-ARCH-152] 聊天气泡布局与系统提示词防泄露、思考过程与工具卡片渲染方案.md|聊天气泡与防泄露|提案|
|[DESIGN-ARCH-153] khy 自知面对齐规范.md|khy 自知面对齐|已实施|
|[DESIGN-ARCH-154] 上下文窗口真值贯通-网关免费目录供血与前后端一致方案.md|上下文窗口真值贯通|提案|
|[DESIGN-ARCH-155] 工具调用短显示规范-TUI与桌面统一.md|工具调用短显示|提案|
|[DESIGN-ARCH-156] TUI帧生成管线契约化-高度账本与字节出口单一所有者方案.md|TUI 帧生成管线契约|提案|
|[DESIGN-ARCH-157] 文件修改红绿diff三端统一规格.md|红绿 diff 三端统一|已采纳|
|[DESIGN-ARCH-158] TUI默认承载路径工具条目投影缺失修复方案.md|工具条目投影缺失修复|提案|
|[DESIGN-ARCH-159] CLI命令输出层次化与缩进统一方案.md|CLI 输出层次化缩进|在产|
|[DESIGN-ARCH-160] 惯性执行机制设计方案.md|惯性执行机制|提案|
|[DESIGN-ARCH-161] 任务执行时延与质量优化方案.md|任务时延与质量优化|部分实施|
|[DESIGN-ARCH-162] Auto模式模型粒度健康路由方案.md|Auto 模式健康路由|已批准待实施|
|[DESIGN-ARCH-163] 图文混合输入识别增强方案.md|图文混合输入增强|草案待批准|

#### DESIGN-CPA/（补 3 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-CPA-001] CPA 反代集成方案.md|CPA 反代集成|草案|
|[DESIGN-CPA-002] CPA+NewAPI 分层架构实施方案.md|CPA+NewAPI 分层实施|待评审|
|[DESIGN-CPA-003] CPA接入层+NewAPI治理层分层架构.md|CPA 接入层+NewAPI 治理层|待实施|

#### DESIGN-FE/（补 3 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-FE-001] 前端页面规范.md|前端页面规范|在产|
|[DESIGN-FE-002] 前端组件库规范.md|前端组件库规范|在产|
|[DESIGN-FE-003] 前端快速参考卡.md|前端快速参考卡|在产|

#### DESIGN-MEM/（补 7 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-MEM-000] 记忆系统总结.md|记忆系统总结|在产|
|[DESIGN-MEM-001] 记忆系统标准规范.md|记忆系统标准规范|在产|
|[DESIGN-MEM-002] 记忆时机指南.md|记忆时机指南|在产|
|[DESIGN-MEM-003] 记忆模板库.md|记忆模板库|在产|
|[DESIGN-MEM-004] 记忆快速参考卡.md|记忆快速参考卡|在产|
|[DESIGN-MEM-005] 记忆系统使用指南.md|记忆系统使用指南|在产|
|[DESIGN-MEM-007] 记忆规则系统总纲.md|记忆规则系统总纲|提案|

#### DESIGN-PERF/（补 2 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-PERF-001] 性能规范.md|性能规范（跨阶段真源）|在产|
|[DESIGN-PERF-001] khy-cli-交互流畅度修复方案-v1.md|CLI 流畅度修复 v1|定稿|

#### DESIGN-RES/（补 1 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研.md|跨Agent技能MCP调研（阶段一）|在产|

#### [DESIGN-CICD-001] CI/（补 1 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|CD 规范.md|CI/CD 规范（位于 `[DESIGN-CICD-001] CI/` 子目录）|在产|

#### 其它设计/（补 29 篇正文件）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DESIGN-A11Y-001] 可访问性规范.md|可访问性规范|在产|
|[DESIGN-A2A-001] A2A 协议规范.md|A2A 协议规范|在产|
|[DESIGN-API-001] API 设计规范.md|API 设计规范|在产|
|[DESIGN-CACHE-001] 缓存规范.md|缓存规范|在产|
|[DESIGN-COMM-001] 通信协议规范.md|通信协议规范|在产|
|[DESIGN-DB-001] 数据库规范.md|数据库规范|在产|
|[DESIGN-DEP-001] 依赖管理规范.md|依赖管理规范|在产|
|[DESIGN-DEPLOY-001] 部署规范.md|部署规范|在产|
|[DESIGN-DOC-001] 文档结构规范.md|文档结构规范|在产|
|[DESIGN-ENV-001] 环境配置规范.md|环境配置规范|在产|
|[DESIGN-ERR-001] 错误处理规范.md|错误处理规范|在产|
|[DESIGN-GIT-001] Git 工作流规范.md|Git 工作流规范|在产|
|[DESIGN-I18N-001] 国际化规范.md|国际化规范|在产|
|[DESIGN-INDEX-001] 规范索引.md|规范索引|在产|
|[DESIGN-LEGISLATION] 跨Agent技能MCP统一管理-阶段二立法清单.md|技能MCP立法清单（阶段二）|在产|
|[DESIGN-LOG-001] 日志规范.md|日志规范|在产|
|[DESIGN-MONITOR-001] 监控告警规范.md|监控告警规范|在产|
|[DESIGN-MS-001] 微服务通信规范.md|微服务通信规范|在产|
|[DESIGN-OUT-001] 输出结构规范.md|输出结构规范|在产|
|[DESIGN-PHILOSOPHY] 设计哲学总纲.md|设计哲学总纲|在产|
|[DESIGN-PRIV-001] 数据隐私规范.md|数据隐私规范|在产|
|[DESIGN-QUICK-REF] 设计模式速查卡.md|设计模式速查卡|在产|
|[DESIGN-RESEARCH] 跨Agent技能MCP统一管理-阶段一调研.md|技能MCP调研（阶段一）|在产|
|[DESIGN-RESEARCH] 桌面端智能体UI调研与差距分析-2026-09-09.md|桌面端UI调研差距|Draft（持续更新）|
|[DESIGN-RESEARCH] 桌面端智能体UI每日调研-2026-09-10.md|桌面端UI每日调研|Daily Report|
|[DESIGN-REVIEW-001] 代码审查规范.md|代码审查规范|在产|
|[DESIGN-TEST-001] 测试规范.md|测试规范|在产|
|EXECUTION_PROMPT.md|CC-TUI 复刻执行提示词（原文件名）|在产|
|ycode-inspiration-plan.md|y-code 借鉴实施方案（原文件名）|在产|

#### 就近索引（补 9 篇）

> 下列 `00_INDEX_*` 是本目录各子夹的**就近索引**（清单真源），此前亦未在本索引登记。

| 文件名 | 覆盖范围 |
| --- | --- |
|00_INDEX_设计-分类索引.md|本目录就近索引（根级，即本文件）|
|00_INDEX_DESIGN-ARCH-总目录.md|DESIGN-ARCH/ 夹就近索引|
|00_INDEX_DESIGN-CPA-总目录.md|DESIGN-CPA/ 夹就近索引|
|00_INDEX_DESIGN-FE-总目录.md|DESIGN-FE/ 夹就近索引|
|00_INDEX_DESIGN-MEM-总目录.md|DESIGN-MEM/ 夹就近索引|
|00_INDEX_DESIGN-OTHER-总目录.md|DESIGN-OTHER/ 夹就近索引|
|00_INDEX_DESIGN-PERF-总目录.md|DESIGN-PERF/ 夹就近索引|
|00_INDEX_DESIGN-RES-总目录.md|DESIGN-RES/ 夹就近索引|
|00_INDEX_其它设计-总目录.md|其它设计/ 夹就近索引|

#### 补录时发现的结构缺陷（如实登记，本轮不擅改）

**编号冲突（6 组，同号两篇）**：

| 编号 | 文档 A | 文档 B |
| --- | --- | --- |
|`DESIGN-ARCH-072`|模型上下文窗口探测规范|项目规范化总纲|
|`DESIGN-ARCH-079`|TUI界面设计规范|TUI组件实现提示词|
|`DESIGN-ARCH-101`|代理模式统一Agent模型管理与协议桥接方案|TUI 交互与展示规则细则|
|`DESIGN-ARCH-140`|规则与规范依托全景盘点与补全提案|khy启动卡顿定位与首帧前置方案|
|`DESIGN-PERF-001`|性能规范|khy-cli-交互流畅度修复方案-v1|
|`DESIGN-ARCH-067`|opencode高含金量功能教学与khy-os差距补齐路线|动态模型差异化适配引擎|

> 另有 `[DESIGN-ARCH-067]` 的第二篇在磁盘上实际占号 `075`（`opencode高含金量…`），
> 即 `067` 与 `075` 两号指向同一文档、`067` 同时被两篇占用。

**同名重复件（4 组，跨子目录各存一份）**：

| 文档 | 副本位置 |
| --- | --- |
|桌面端智能体UI调研与差距分析-2026-09-09|`DESIGN-RES/[DESIGN-RES-001]` 与 `其它设计/[DESIGN-RESEARCH]`|
|桌面端智能体UI每日调研-2026-09-10|`DESIGN-RES/[DESIGN-RES-002]` 与 `其它设计/[DESIGN-RESEARCH]`|
|跨Agent技能MCP统一管理-阶段一调研|`DESIGN-RES/[DESIGN-RES-003]` 与 `其它设计/[DESIGN-RESEARCH]`|
|khy-cli-交互流畅度修复方案-v1|`DESIGN-PERF/[DESIGN-PERF-001]` 与 `DESIGN-PERF/[DESIGN-PERF-002]`|

**索引内死链（既有缺陷，非本轮引入）**：`[DESIGN-ARCH-109] Y-code 借鉴实施方案.md`、
`[DESIGN-ARCH-108] CC-TUI复刻执行提示词.md`、`[DESIGN-PROCESS-001] 委派边界决策矩阵…`（登记两行）
等条目在磁盘上不存在——磁盘上对应文件仍用原文件名（`其它设计/ycode-inspiration-plan.md`、
`其它设计/EXECUTION_PROMPT.md`）。上方「历史未编号件」表已声明「重命名须同步改写入站引用与 `.html`
孪生件，属独立一轮工作」，故本轮**不替他人改名**，仅登记。

> **订正（2026-09-27，五次）**：前四次的「下一个空号」结论全部过时。本轮全量补齐后实测本目录
> 占用号已达 `163`（`DESIGN-ARCH-163`）。**当前下一个空号为 `164`** —— 注：`164` 曾于 2026-09-27 被
「复杂项目开发作业法」占用，同日因并入 `[DESIGN-ARCH-077]` 而**释放**，故可再用。新增文档前请以本索引
文件清单为准复核，勿沿用旧结论。

> **另注（守卫覆盖缺口）**：`docs-index-complete` 只扫阶段目录的**直接子文件**
> （`scripts/ci/check-repo-layout.js:376` 非递归），而本目录下只有本索引自身一个 `.md` 且被 `:379` 跳过
> ⇒ **该守卫对本索引的扫描面为 0**。本索引的完整性无任何自动守卫兜底，只能靠人工体检。

## 三、已归档（已删除孤儿引擎）

下列设计稿对应的治理引擎经 2026-06-14「接线或删除」核实为 ORPHAN（三入口不可达），其实现已删除，
设计稿移入 `docs/18_归档/03_DESIGN_设计/`（2026-09-15 自本目录提级为跨阶段冷存储）仅作历史留存，**非在产**：DESIGN-ARCH-024（marshal，
叶子 capabilityVector 仍在产）、033（dualTrack）、035（cognitiveSnapshot）、038（dualTrackForge）、
039（envSymbiosis）、040（dataSovereignty）、042（selfSustainingInfra）。

- 归档子索引：`docs/18_归档/03_DESIGN_设计/00_INDEX_已删除孤儿引擎归档.md`。
- 删除裁决与证据：`.ai/GOVERNANCE-LEDGER.md` §B.0；在产判据：`.ai/GUARDS-AI.md` §0。

## 四、跨分类关联指引

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 设计的实现落地：`docs/04_IMPL_实现/`；验证：`docs/05_TEST_测试/`。
- 治理标准上位规范：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
