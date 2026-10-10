<!-- 生成器：整理会话 2026-10-05；判定方法见文末。人工改判后请同步更新标记与清单。 -->
# [DESIGN] 实现状态总览 —— 待实现 / 已实现

> 覆盖 `03_DESIGN_设计/` 全部编号设计文档（195 篇中已判定 126 篇）。每篇首行有机器可读标记 `<!-- IMPL-STATUS: done|todo -->`。
> 分域细粒度状态（含「部分实施/一期已落地」等）见 [00_INDEX_设计-分类索引](00_INDEX_设计-分类索引.md)，本清单是其二值投影。

## 待实现（10 篇）

> 设计横幅自述「目标态/规划中/实施方案」，或分类索引状态为「提案/待评审/草案/待实施/部分实施」，且无实现证据引用；个别可能已落地但未留报告引用，复核后请改标记并移区。

### DESIGN-ARCH

- [[DESIGN-ARCH-080] 网页端信息架构与四页重设计-2026-09-08](DESIGN-ARCH/[DESIGN-ARCH-080]%20网页端信息架构与四页重设计-2026-09-08.md) —— 分类索引=Draft（待评审冻结）
- [[DESIGN-ARCH-095] TUI交互完善调研与实施路线](DESIGN-ARCH/[DESIGN-ARCH-095]%20TUI交互完善调研与实施路线.md) —— 横幅=待实现
- [[DESIGN-ARCH-109] Y-code 借鉴实施方案](DESIGN-ARCH/[DESIGN-ARCH-109]%20Y-code%20借鉴实施方案.md) —— 横幅=待实现
- [[DESIGN-ARCH-137] khyos运行时信息获取规则与读取预算接线方案](DESIGN-ARCH/[DESIGN-ARCH-137]%20khyos运行时信息获取规则与读取预算接线方案.md) —— 分类索引=提案
- [[DESIGN-ARCH-151] TUI思维链折叠存储与显示减负方案](DESIGN-ARCH/[DESIGN-ARCH-151]%20TUI思维链折叠存储与显示减负方案.md) —— 分类索引=部分实施（P2 已落地）
- [[DESIGN-ARCH-155] 工具调用短显示规范-TUI与桌面统一](DESIGN-ARCH/[DESIGN-ARCH-155]%20工具调用短显示规范-TUI与桌面统一.md) —— 分类索引=提案
- [[DESIGN-ARCH-158] TUI默认承载路径工具条目投影缺失修复方案](DESIGN-ARCH/[DESIGN-ARCH-158]%20TUI默认承载路径工具条目投影缺失修复方案.md) —— 分类索引=提案
- [[DESIGN-ARCH-161] 任务执行时延与质量优化方案](DESIGN-ARCH/[DESIGN-ARCH-161]%20任务执行时延与质量优化方案.md) —— 分类索引=部分实施

### DESIGN-RES

- [[DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09](DESIGN-RES/[DESIGN-RES-001]%20桌面端智能体UI调研与差距分析-2026-09-09.md) —— 横幅=待实现
- [[DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研](DESIGN-RES/[DESIGN-RES-003]%20跨Agent技能MCP统一管理-阶段一调研.md) —— 横幅=待实现

## 已实现（116 篇）

> 被 IMPL-RPT/TEST-RPT/报告/运维文档正文引用（实现证据），或分类索引/横幅自述已落地。

### DESIGN-ARCH

- [[DESIGN-ARCH-001] khy-移动智能体协议](DESIGN-ARCH/[DESIGN-ARCH-001]%20khy-移动智能体协议.md) —— 分类索引=在产
- [[DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射](DESIGN-ARCH/[DESIGN-ARCH-002]%20Khyos-CB-SSP-数学建模与实现映射.md) —— 分类索引=在产
- [[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径](DESIGN-ARCH/[DESIGN-ARCH-003]%20Khyos-数学重塑-受约束随机最短路径.md) —— 分类索引=在产
- [[DESIGN-ARCH-005] agentfs-智能体文件系统](DESIGN-ARCH/[DESIGN-ARCH-005]%20agentfs-智能体文件系统.md) —— 分类索引=在产
- [[DESIGN-ARCH-006] ai-gateway-适配器协议架构](DESIGN-ARCH/[DESIGN-ARCH-006]%20ai-gateway-适配器协议架构.md) —— 分类索引=在产
- [[DESIGN-ARCH-007] m1-微内核-ipc-moonbit](DESIGN-ARCH/[DESIGN-ARCH-007]%20m1-微内核-ipc-moonbit.md) —— 分类索引=在产
- [[DESIGN-ARCH-008] moonbit-系统边界](DESIGN-ARCH/[DESIGN-ARCH-008]%20moonbit-系统边界.md) —— 分类索引=在产
- [[DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09](DESIGN-ARCH/[DESIGN-ARCH-009]%20可视化拖拽工作流编辑器-2026-06-09.md) —— 分类索引=在产
- [[DESIGN-ARCH-010] 核心架构](DESIGN-ARCH/[DESIGN-ARCH-010]%20核心架构.md) —— 分类索引=在产
- [[DESIGN-ARCH-011] 应用接入标准](DESIGN-ARCH/[DESIGN-ARCH-011]%20应用接入标准.md) —— 分类索引=在产
- [[DESIGN-ARCH-012] 工具延迟加载](DESIGN-ARCH/[DESIGN-ARCH-012]%20工具延迟加载.md) —— 分类索引=在产
- [[DESIGN-ARCH-013] 弱模型兼容](DESIGN-ARCH/[DESIGN-ARCH-013]%20弱模型兼容.md) —— 分类索引=在产
- [[DESIGN-ARCH-014] 模式图谱](DESIGN-ARCH/[DESIGN-ARCH-014]%20模式图谱.md) —— 分类索引=在产
- [[DESIGN-ARCH-015] 编码规范](DESIGN-ARCH/[DESIGN-ARCH-015]%20编码规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-016] AI_Agent显示规范](DESIGN-ARCH/[DESIGN-ARCH-016]%20AI_Agent显示规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-018] Agent提示词复用机制](DESIGN-ARCH/[DESIGN-ARCH-018]%20Agent提示词复用机制.md) —— 分类索引=在产
- [[DESIGN-ARCH-021] 巨型环反转设计](DESIGN-ARCH/[DESIGN-ARCH-021]%20巨型环反转设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-023] khyos文档排版与格式控制规范](DESIGN-ARCH/[DESIGN-ARCH-023]%20khyos文档排版与格式控制规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范](DESIGN-ARCH/[DESIGN-ARCH-025]%20khyos元规划协议与动态约束注入规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范](DESIGN-ARCH/[DESIGN-ARCH-026]%20khyos系统级服务调用审批网关规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-027] Agent依赖自愈机制规范](DESIGN-ARCH/[DESIGN-ARCH-027]%20Agent依赖自愈机制规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因](DESIGN-ARCH/[DESIGN-ARCH-028]%20Agent通信防御-零静默失败与精准归因.md) —— 分类索引=在产
- [[DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议](DESIGN-ARCH/[DESIGN-ARCH-029]%20Agent有限窗口降级与强制兜底执行协议.md) —— 分类索引=在产
- [[DESIGN-ARCH-030] 源端构建-目标机自愈运行](DESIGN-ARCH/[DESIGN-ARCH-030]%20源端构建-目标机自愈运行.md) —— 分类索引=在产
- [[DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译](DESIGN-ARCH/[DESIGN-ARCH-031]%20网关日志租界隔离-按需可见与净味翻译.md) —— 分类索引=在产
- [[DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成](DESIGN-ARCH/[DESIGN-ARCH-032]%20内嵌MD工作台与跨平台右键集成.md) —— 分类索引=在产
- [[DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范](DESIGN-ARCH/[DESIGN-ARCH-043]%20khy-agent-sdk-Claude对齐与D1-D6融合规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试](DESIGN-ARCH/[DESIGN-ARCH-044]%20Agent自愈微循环-诊断修复重试.md) —— 分类索引=在产
- [[DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断](DESIGN-ARCH/[DESIGN-ARCH-045]%20非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md) —— 分类索引=在产
- [[DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真](DESIGN-ARCH/[DESIGN-ARCH-046]%20聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md) —— 分类索引=在产
- [[DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离](DESIGN-ARCH/[DESIGN-ARCH-047]%20轨迹溯源标准-溯源信封与防篡改链与注入隔离.md) —— 分类索引=在产
- [[DESIGN-ARCH-048] khyos轨迹回放与确定性复现](DESIGN-ARCH/[DESIGN-ARCH-048]%20khyos轨迹回放与确定性复现.md) —— 分类索引=在产
- [[DESIGN-ARCH-049] 轨迹即教材-AI引导回放](DESIGN-ARCH/[DESIGN-ARCH-049]%20轨迹即教材-AI引导回放.md) —— 分类索引=在产
- [[DESIGN-ARCH-050] 项目整体意识与自驱收尾保障](DESIGN-ARCH/[DESIGN-ARCH-050]%20项目整体意识与自驱收尾保障.md) —— 分类索引=在产
- [[DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知](DESIGN-ARCH/[DESIGN-ARCH-052]%20任务驱动读取与搜索范围规划-精准而非全知.md) —— 分类索引=在产
- [[DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件](DESIGN-ARCH/[DESIGN-ARCH-054]%20AI逆向工程-从产物还原与自验软件.md) —— 分类索引=在产
- [[DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固](DESIGN-ARCH/[DESIGN-ARCH-055]%20对抗式训练-极端环境抗压自检与加固.md) —— 分类索引=在产
- [[DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作](DESIGN-ARCH/[DESIGN-ARCH-056]%20khyos桌面操控-眼耳嘴与模拟操作.md) —— 分类索引=在产
- [[DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎](DESIGN-ARCH/[DESIGN-ARCH-058]%20细粒度权限策略与记忆主动化引擎.md) —— 分类索引=在产
- [[DESIGN-ARCH-059] 能力即代码](DESIGN-ARCH/[DESIGN-ARCH-059]%20能力即代码.md) —— 分类索引=在产
- [[DESIGN-ARCH-060] khy 功能接线与编排总图](DESIGN-ARCH/[DESIGN-ARCH-060]%20khy%20功能接线与编排总图.md) —— 分类索引=在产
- [[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS](DESIGN-ARCH/[DESIGN-ARCH-063]%20对照《Claude%20Code%20架构》一书读懂%20Khy-OS.md) —— 分类索引=在产
- [[DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化](DESIGN-ARCH/[DESIGN-ARCH-065]%20Hermes%20Agent%20v0.18.0%20参考学习-判断验证自我进化.md) —— 分类索引=在产
- [[DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关](DESIGN-ARCH/[DESIGN-ARCH-066]%20前端代理出站桥-选节点实际路由与启用停用开关.md) —— 分类索引=在产
- [[DESIGN-ARCH-067] 动态模型差异化适配引擎](DESIGN-ARCH/[DESIGN-ARCH-067]%20动态模型差异化适配引擎.md) —— 分类索引=在产
- [[DESIGN-ARCH-068] 仓库层级板块规范](DESIGN-ARCH/[DESIGN-ARCH-068]%20仓库层级板块规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-071] 通道选择决策矩阵](DESIGN-ARCH/[DESIGN-ARCH-071]%20通道选择决策矩阵.md) —— 分类索引=在产
- [[DESIGN-ARCH-073] 规范快速参考卡](DESIGN-ARCH/[DESIGN-ARCH-073]%20规范快速参考卡.md) —— 分类索引=在产
- [[DESIGN-ARCH-074] khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录](DESIGN-ARCH/[DESIGN-ARCH-074]%20khyos%20账号体系收口-用户名唯一键%20alias%20软冲突%20密码必填%20局域网登录.md) —— 分类索引=在产
- [[DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线](DESIGN-ARCH/[DESIGN-ARCH-075]%20opencode高含金量功能教学与khy-os差距补齐路线.md) —— 分类索引=在产
- [[DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲](DESIGN-ARCH/[DESIGN-ARCH-077]%20khyos%20核心任务循环-稳定交付总纲.md) —— 分类索引=在产
- [[DESIGN-ARCH-079] TUI界面设计规范](DESIGN-ARCH/[DESIGN-ARCH-079]%20TUI界面设计规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-079] TUI组件实现提示词](DESIGN-ARCH/[DESIGN-ARCH-079]%20TUI组件实现提示词.md) —— 分类索引=在产
- [[DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划](DESIGN-ARCH/[DESIGN-ARCH-081]%20Claude%20Code%20TUI%201复刻实施计划.md) —— 人工复核：CC TUI 复刻已交付并在产（runtime/node/backend/src/cli/tui/ 为 AGENTS 入口点表在册模块）
- [[DESIGN-ARCH-082] CC模式输入框与光标设计](DESIGN-ARCH/[DESIGN-ARCH-082]%20CC模式输入框与光标设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-083] CC模式表格与折叠设计](DESIGN-ARCH/[DESIGN-ARCH-083]%20CC模式表格与折叠设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-084] CC模式注意力与选择设计](DESIGN-ARCH/[DESIGN-ARCH-084]%20CC模式注意力与选择设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计](DESIGN-ARCH/[DESIGN-ARCH-085]%20CC模式子视图子菜单卡片与滚动设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪](DESIGN-ARCH/[DESIGN-ARCH-086]%20CC%20TUI%20复刻总计划与子任务跟踪.md) —— 同上
- [[DESIGN-ARCH-087] CC模式微交互与反馈设计](DESIGN-ARCH/[DESIGN-ARCH-087]%20CC模式微交互与反馈设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理](DESIGN-ARCH/[DESIGN-ARCH-088]%20CC快捷键系统RedoFork与执行偏差处理.md) —— 分类索引=在产
- [[DESIGN-ARCH-089] TUI设计模式调研报告](DESIGN-ARCH/[DESIGN-ARCH-089]%20TUI设计模式调研报告.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-ARCH-090] TUI用户评价调研与痛点分析](DESIGN-ARCH/[DESIGN-ARCH-090]%20TUI用户评价调研与痛点分析.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范](DESIGN-ARCH/[DESIGN-ARCH-093]%20密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范](DESIGN-ARCH/[DESIGN-ARCH-094]%20Provider卡片枢纽（CardHub）GUI设计规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-096] ycode 第二轮增量借鉴调研报告](DESIGN-ARCH/[DESIGN-ARCH-096]%20ycode%20第二轮增量借鉴调研报告.md) —— 横幅=已实现
- [[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解](DESIGN-ARCH/[DESIGN-ARCH-097]%20KhyOS%20核心边界定稿-一词一解.md) —— 分类索引=在产
- [[DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案](DESIGN-ARCH/[DESIGN-ARCH-098]%20系统提示词结构重设计-静态动态分层与缓存优化方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-101] 代理模式统一Agent模型管理与协议桥接方案](DESIGN-ARCH/[DESIGN-ARCH-101]%20代理模式统一Agent模型管理与协议桥接方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-101] TUI 交互与展示规则细则](DESIGN-ARCH/[DESIGN-ARCH-101]%20TUI%20交互与展示规则细则.md) —— 分类索引=在产
- [[DESIGN-ARCH-102] Khy TUI 统一规则手册](DESIGN-ARCH/[DESIGN-ARCH-102]%20Khy%20TUI%20统一规则手册.md) —— 分类索引=在产
- [[DESIGN-ARCH-103] TUI 终端界面重设计方案](DESIGN-ARCH/[DESIGN-ARCH-103]%20TUI%20终端界面重设计方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-105] ycode 第三轮增量借鉴调研报告](DESIGN-ARCH/[DESIGN-ARCH-105]%20ycode%20第三轮增量借鉴调研报告.md) —— 横幅=已实现
- [[DESIGN-ARCH-106] 项目规范化总纲](DESIGN-ARCH/[DESIGN-ARCH-106]%20项目规范化总纲.md) —— 分类索引=在产
- [[DESIGN-ARCH-108] CC-TUI复刻执行提示词](DESIGN-ARCH/[DESIGN-ARCH-108]%20CC-TUI复刻执行提示词.md) —— 同上
- [[DESIGN-ARCH-111] 规则遵守保障机制](DESIGN-ARCH/[DESIGN-ARCH-111]%20规则遵守保障机制.md) —— 分类索引=派生
- [[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式](DESIGN-ARCH/[DESIGN-ARCH-113]%20AI修改三模态反馈契约-客户模式.md) —— 分类索引=在产
- [[DESIGN-ARCH-114] CLI 错误标准化规范](DESIGN-ARCH/[DESIGN-ARCH-114]%20CLI%20错误标准化规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-115] TUI 启动板块设计](DESIGN-ARCH/[DESIGN-ARCH-115]%20TUI%20启动板块设计.md) —— 分类索引=在产
- [[DESIGN-ARCH-116] khyos-插件系统契约(@khy-plugin-sdk)](DESIGN-ARCH/[DESIGN-ARCH-116]%20khyos-插件系统契约(@khy-plugin-sdk).md) —— 分类索引=在产
- [[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范](DESIGN-ARCH/[DESIGN-ARCH-118]%20HQ%20能力吸收与多机协作规范.md) —— 分类索引=在产
- [[DESIGN-ARCH-119] TUI文本选择与复制-验收标准](DESIGN-ARCH/[DESIGN-ARCH-119]%20TUI文本选择与复制-验收标准.md) —— 分类索引=在产
- [[DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复](DESIGN-ARCH/[DESIGN-ARCH-119]%20TUI原生文本选择与复制可用性修复.md) —— 分类索引=在产
- [[DESIGN-ARCH-121] khyos-CC-Harness借鉴清单](DESIGN-ARCH/[DESIGN-ARCH-121]%20khyos-CC-Harness借鉴清单.md) —— 分类索引=在产
- [[DESIGN-ARCH-122] TUI 设计族总纲](DESIGN-ARCH/[DESIGN-ARCH-122]%20TUI%20设计族总纲.md) —— 分类索引=在产
- [[DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案](DESIGN-ARCH/[DESIGN-ARCH-124]%20CC%20模式剪贴板复制能力补齐提案.md) —— 分类索引=在产
- [[DESIGN-ARCH-125] 桌面端新对话卡片工作空间选择与快捷键统一登记](DESIGN-ARCH/[DESIGN-ARCH-125]%20桌面端新对话卡片工作空间选择与快捷键统一登记.md) —— 分类索引=一期+二期已实施
- [[DESIGN-ARCH-127] khyos 可维护性诊断与减负方案](DESIGN-ARCH/[DESIGN-ARCH-127]%20khyos%20可维护性诊断与减负方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-131] 报错一键交修闭环方案](DESIGN-ARCH/[DESIGN-ARCH-131]%20报错一键交修闭环方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-132] TUI选区锚点漂移修复方案](DESIGN-ARCH/[DESIGN-ARCH-132]%20TUI选区锚点漂移修复方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-134] TUI 启动屏视觉重设计](DESIGN-ARCH/[DESIGN-ARCH-134]%20TUI%20启动屏视觉重设计.md) —— 分类索引=P0 已实施
- [[DESIGN-ARCH-135] TUI长任务会话中断与压缩不接续修复方案](DESIGN-ARCH/[DESIGN-ARCH-135]%20TUI长任务会话中断与压缩不接续修复方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-136] 零尝试失败被误报为钉选抑制的修复方案](DESIGN-ARCH/[DESIGN-ARCH-136]%20零尝试失败被误报为钉选抑制的修复方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-138] 工具调用能力判定与文本拦截协议](DESIGN-ARCH/[DESIGN-ARCH-138]%20工具调用能力判定与文本拦截协议.md) —— 分类索引=在产
- [[DESIGN-ARCH-141] 动态工作流-运行时自演化与节点热插拔方案](DESIGN-ARCH/[DESIGN-ARCH-141]%20动态工作流-运行时自演化与节点热插拔方案.md) —— 横幅=已实现
- [[DESIGN-ARCH-146] TUI 卡片点击交互-选项命中与展开方案](DESIGN-ARCH/[DESIGN-ARCH-146]%20TUI%20卡片点击交互-选项命中与展开方案.md) —— 分类索引=在产
- [[DESIGN-ARCH-164] 用户需求理解管线-意图裁决澄清问询与需求固化方案](DESIGN-ARCH/[DESIGN-ARCH-164]%20用户需求理解管线-意图裁决澄清问询与需求固化方案.md) —— 分类索引=S1 已落地
- [[DESIGN-ARCH-165] TUI 工具卡片渲染规格与两端分工方案](DESIGN-ARCH/[DESIGN-ARCH-165]%20TUI%20工具卡片渲染规格与两端分工方案.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-ARCH-167] 模型选择列表分组与信息分层方案](DESIGN-ARCH/[DESIGN-ARCH-167]%20模型选择列表分组与信息分层方案.md) —— 横幅=已实现
- [[DESIGN-ARCH-171] 未接入后端判定与接线守卫真实性方案](DESIGN-ARCH/[DESIGN-ARCH-171]%20未接入后端判定与接线守卫真实性方案.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-ARCH-176] TUI 与桌面端统一方案：底色分层 · 稳定渲染 · 共享语义](DESIGN-ARCH/[DESIGN-ARCH-176]%20TUI%20与桌面端统一方案：底色分层%20·%20稳定渲染%20·%20共享语义.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-ARCH-177] 侧栏项目分组可辨识化改造方案](DESIGN-ARCH/[DESIGN-ARCH-177]%20侧栏项目分组可辨识化改造方案.md) —— 横幅=已实现
- [[DESIGN-ARCH-178] TUI启动44秒病灶-redis顶层副作用与首帧前重require收敛方案](DESIGN-ARCH/[DESIGN-ARCH-178]%20TUI启动44秒病灶-redis顶层副作用与首帧前重require收敛方案.md) —— 横幅=已实现
- [[DESIGN-ARCH-180] 驻留资源提示判据错配修复方案](DESIGN-ARCH/[DESIGN-ARCH-180]%20驻留资源提示判据错配修复方案.md) —— 横幅=已实现
- [[DESIGN-ARCH-182] Watchdog阻塞归因分化-同步长任务与进程被停走区分方案](DESIGN-ARCH/[DESIGN-ARCH-182]%20Watchdog阻塞归因分化-同步长任务与进程被停走区分方案.md) —— 横幅=已实现

### DESIGN-FOLD

- [[DESIGN-FOLD-001] 子任务副屏折叠展开统一设计](DESIGN-FOLD/[DESIGN-FOLD-001]%20子任务副屏折叠展开统一设计.md) —— 分类索引=已实现

### DESIGN-MEM

- [[DESIGN-MEM-001] 记忆系统标准规范](DESIGN-MEM/[DESIGN-MEM-001]%20记忆系统标准规范.md) —— 分类索引=在产

### DESIGN-OTHER

- [[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链](DESIGN-OTHER/[DESIGN-OTHER-001]%20Khyos-数学重塑-实施提示词链.md) —— 分类索引=在产
- [[DESIGN-OTHER-003] khy-系统提示词结构图](DESIGN-OTHER/[DESIGN-OTHER-003]%20khy-系统提示词结构图.md) —— 分类索引=在产
- [[DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01](DESIGN-OTHER/[DESIGN-OTHER-004]%20特性访问-提示词胶囊-2026-06-01.md) —— 分类索引=在产

### DESIGN-PERF

- [[DESIGN-PERF-001] khy-cli-交互流畅度修复方案-v1](DESIGN-PERF/[DESIGN-PERF-001]%20khy-cli-交互流畅度修复方案-v1.md) —— 分类索引=定稿
- [[DESIGN-PERF-002] khy-cli-交互流畅度修复方案-v1](DESIGN-PERF/[DESIGN-PERF-002]%20khy-cli-交互流畅度修复方案-v1.md) —— 分类索引=在产
- [[DESIGN-PERF-003] TUI 启动阻塞治理方案](DESIGN-PERF/[DESIGN-PERF-003]%20TUI%20启动阻塞治理方案.md) —— 分类索引=在产
- [[DESIGN-PERF-004] TUI 动画节拍治理方案](DESIGN-PERF/[DESIGN-PERF-004]%20TUI%20动画节拍治理方案.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-PERF-005] khy-chat-启动慢与报错链治理方案](DESIGN-PERF/[DESIGN-PERF-005]%20khy-chat-启动慢与报错链治理方案.md) —— IMPL/TEST/报告 引用证据 1 处
- [[DESIGN-PERF-006] khy 启动提速方案](DESIGN-PERF/[DESIGN-PERF-006]%20khy%20启动提速方案.md) —— 横幅=已实现

## 未判定（69 篇）

> 无横幅信号也无报告引用，多为早期架构总纲类与治理类文档；需逐篇人工判定后归入上两区。

### DESIGN-ARCH

- [DESIGN-ARCH-004] _cbssp_progress
- [DESIGN-ARCH-017] 元工具系统设计
- [DESIGN-ARCH-019] 用户输入预处理规范
- [DESIGN-ARCH-020] 架构债治理报告
- [DESIGN-ARCH-022] khyos多实例并发文件控制规范
- [DESIGN-ARCH-034] 动态自适应约束求解引擎
- [DESIGN-ARCH-036] 万物结构化熔炉引擎
- [DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎
- [DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关
- [DESIGN-ARCH-051] 单人维护者健康驾驶舱
- [DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开
- [DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕
- [DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界
- [DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图
- [DESIGN-ARCH-069] 拓展契约与核心边界规范
- [DESIGN-ARCH-070] 治理总纲与可执行规则
- [DESIGN-ARCH-072] 模型上下文窗口探测规范
- [DESIGN-ARCH-072] 项目规范化总纲
- [DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账
- [DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案
- [DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范
- [DESIGN-ARCH-099] 提示词架构横向调研与khy-os对齐方案
- [DESIGN-ARCH-100] 模型列表真值校验与过滤规范
- [DESIGN-ARCH-107] TUI组件实现提示词
- [DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记
- [DESIGN-ARCH-112] khyos-Harness架构对照
- [DESIGN-ARCH-117] khy-多端入口矩阵
- [DESIGN-ARCH-120] khy-移动端合并方案
- [DESIGN-ARCH-123] K-01~K-12 施工盘点清单
- [DESIGN-ARCH-126] 跨端 AI 编程任务看板泳道编排方案
- [DESIGN-ARCH-128] khyos结构化输出方案-输出卫生层与语义渲染契约
- [DESIGN-ARCH-129] TUI 滚动-选择-历史-固定底部共存设计
- [DESIGN-ARCH-130] 前台与后台任务编排方案
- [DESIGN-ARCH-133] 桌面端基本任务闭环-接入智能体工具循环
- [DESIGN-ARCH-139] 网关零尝试(NO_ATTEMPT)与钉选残留第6次复发修复方案
- [DESIGN-ARCH-140] khy启动卡顿定位与首帧前置方案
- [DESIGN-ARCH-140] 规则与规范依托全景盘点与补全提案
- [DESIGN-ARCH-142] 用户数据安全更新与可选更新机制
- [DESIGN-ARCH-143] DSH插件生态接入评估与分层适配方案
- [DESIGN-ARCH-144] khyquant剥离为可选拓展的结构划分与接口契约方案
- [DESIGN-ARCH-145] 用户DIY空间分层与安全边界统一方案
- [DESIGN-ARCH-147] 好设计十诫的工程映射与设计判据落地方案
- [DESIGN-ARCH-148] README漏斗式重设计与真源指针化方案
- [DESIGN-ARCH-149] TUI选区复制携带ANSI残留修复方案
- [DESIGN-ARCH-150] 模型设置页排版减负与配置动线重设计
- [DESIGN-ARCH-152] 聊天气泡布局与系统提示词防泄露、思考过程与工具卡片渲染方案
- [DESIGN-ARCH-153] khy 自知面对齐规范
- [DESIGN-ARCH-154] 上下文窗口真值贯通-网关免费目录供血与前后端一致方案
- [DESIGN-ARCH-156] TUI帧生成管线契约化-高度账本与字节出口单一所有者方案
- [DESIGN-ARCH-157] 文件修改红绿diff三端统一规格
- [DESIGN-ARCH-159] CLI命令输出层次化与缩进统一方案
- [DESIGN-ARCH-160] 惯性执行机制设计方案
- [DESIGN-ARCH-162] Auto模式模型粒度健康路由方案
- [DESIGN-ARCH-163] 图文混合输入识别增强方案
- [DESIGN-ARCH-166] 静默失效与真源漂移四例收敛方案
- [DESIGN-ARCH-168] 开机零自启与按需懒加载方案
- [DESIGN-ARCH-169] khychat启动假阴性-就绪信号后置与守护僵尸化方案
- [DESIGN-ARCH-170] 桌面端X报错功能接线与指路真实性方案
- [DESIGN-ARCH-179] khy-os 统一登录体系 — GitHub Gitee OAuth + 登录方式可选 + 按需登录 + 启动优化
- [DESIGN-ARCH-181] 通道兜底甩出资格与披露统一策略

### DESIGN-CPA

- [DESIGN-CPA-001] CPA 反代集成方案
- [DESIGN-CPA-002] CPA+NewAPI 分层架构实施方案
- [DESIGN-CPA-003] CPA接入层+NewAPI治理层分层架构

### DESIGN-MEM

- [DESIGN-MEM-004] 记忆快速参考卡
- [DESIGN-MEM-005] 记忆系统使用指南
- [DESIGN-MEM-007] 记忆规则系统总纲

### DESIGN-OTHER

- [DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词
- [DESIGN-OTHER-005] desktop-rd-桌面端调研指针

### DESIGN-RES

- [DESIGN-RES-002] 桌面端智能体UI每日调研-2026-09-10

---

## 判定方法

1. **分类索引状态列**（优先）：`00_INDEX_设计-分类索引` 的逐篇状态——提案/待评审/草案/待实施/部分实施 → 待实现；在产/已实施/已落地/已采纳/定稿 → 已实现（调研/差距分析/借鉴方案类除外——「在产」只说明文档现行，不代表方案已实现）。
2. **横幅信号**（前 30 行）：目标态/尚未实现/待实现/规划中/实施计划/路线图 → 待实现；已实现/已落地/已收敛/验收通过 → 已实现。
3. **实现证据**（交叉）：文档 ID 被 `04_IMPL_实现`/`05_TEST_测试`/`11_报告`/运维与概念文档正文引用（排除 00_INDEX 自引与生成的去向表）→ 已实现。
4. **人工复核**：4 篇 TUI 复刻族（081/086/107/108）据在产事实改判。
5. 判定时点 2026-10-05；判定只描述「设计是否已落地」，不评价设计质量。
