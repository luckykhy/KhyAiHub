# Khy-OS 治理台账 (Governance Ledger)

> 跨 Block 过程登记。每完成一个 Block,在此追加一行(状态 = action + target + progress)。
> 规矩: 忠实、一行、可追溯;Block 逐个提交评审,不打包。

| date | block | action → target → progress |
| --- | --- | --- |
| 2026-08-17 | Block A | 完成 DeepSeek-Harness 式「插件按需激活」: src/services/plugins/pluginContribResolver.js 纯叶子懒加载 + executeTool 漏斗内接线(KHY_PLUGIN_LAZY_LOAD 门控默认开) + flagRegistry 注册 + 11/11 测试绿(修复 T3 顺序依赖: beforeEach 清空 on-disk extensions 树) |
| 2026-08-17 | Block B | 完成 DeepSeek-Harness 式「插件注册点」: src/services/hooks/hookContribSeams.js 纯叶子(单调收紧 tighten 借用 permissionPolicy/config STRATEGIES 真源,不另立顺序) + hookRegistry 新增 ToolPermission/PromptSection 事件 + 两处接线(requestPermission 于 policy 裁决后只收紧;aiChatCore 以 pluginPromptSection guard-tier entry 只追加) + flagRegistry 注册 KHY_HOOK_TOOL_PERMISSION / KHY_HOOK_PROMPT_SECTION(均默认开) + 16/16 测试绿(含对 STRATEGIES 全部有序对穷举证明「绝无放松路径」) |
| 2026-11-09 | DESIGN-ARCH-207 期 1 | 重估（非翻案）→ [DESIGN-ARCH-200]:113 G5「不押」裁决 → 因 wangzan101/Mika@v0.1.38 量产实证，追加式记录「值不值得开半天探针」的建议，原裁决原文保留、不改写；同步补登 RikkaApps/Shizuku@v13.6.0（adapter）与 Mika（idea）两条溯源 + FEATURE-OWNERSHIP 新增 mobile-privileged-shell / desktop-computer-use 两个能力域；本期零代码 diff，期 2 真机探针（[DESIGN-ARCH-200] §7.3 设备项）需人再拍板，不写「已验证」 |
| 2026-11-10 | DESIGN-ARCH-208 期 3 裁定 | Q4/Q5 拍板 → [DESIGN-ARCH-208] §3.2 / §3.3 → 用户选「方案 B 独立输入 Activity」+「内存队列、重启即清」；据此落地期 3（新增 PromptInputActivity + Manifest 注册 + AmooLoop 唯一队列真源 + 面板输入行），消费只走 Tools.dispatch("amoo_ask")、失败保留队首并诚实回因、不在 2s ticker 里做自动排空；期 4（G5 真机探针）维持冻结 —— 本机 adb 设备 offline、无 AVD，规格已在 [DESIGN-ARCH-207] §10 备好，不写「已验证」；静态自检与五条守卫零新增红，未跑 Android build |
