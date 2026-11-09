---
name: 洋葱分层重量与芯纯净
id: TOOLING-012
domain: TOOLING
nature: 约束为主，兼福利
scope: "runtime/node/backend/src/**（后端模块图）、apps/khyos-desktop/src/**、delivery/web/**、delivery/channel/**、runtime/node/backend/src/cli/tui/**（视觉层）"
priority: P1
trigger: "新增/移动/删除后端或视觉层模块、新增跨层 require、或改动冷启动入口依赖图时"
constraint: "运行时按加载时机分三层：L0 芯（冷启动即入内存）、L1 膜（被调用才装载）、L2 皮（终端/桌面/Web 表现层）。L0 不得依赖 L1/L2；L1 不得依赖 L2；L1 入口的可达闭包不得渗入视觉皮文件；逻辑侧不得经皮侧 re-export 门面引用通用能力。L0/L1 的冷闭包（仅顶层 require 边）文件数与行数不得超过 CORE-LAYERS.json 的基线，只许减不许增。视觉侧同构：V0 视觉芯的首屏冷闭包（仅静态 import/require 边）不得超基线；应懒加载的低频页面不得出现在 V0/V1 的首屏冷闭包里；视觉层方向矩阵（visual.edgePolicy）必须被消费 —— 芯(V0) 不得依赖膜(V1) 与皮(V2)，膜(V1) 不得依赖皮(V2)。运行时重量（体积轴）：version / doctor --quick / ai-lite 三个场景实际加载的第一方模块数、行数、字节数与外部依赖量不得超过 CORE-LAYERS.json 的 runtimeFootprint 预算；重量闸门（归因：非入口加载者中单点可达重量最大者）不得变大。运行时读数跨会话会漂，故硬预算只给文件数（实测波动 0），行数容差 1%、字节数容差 5%。 设计文档 [DESIGN-ARCH-197] 里引用的基线数字必须与 CORE-LAYERS.json 一致（warning 级：漂移要报，但不阻断整个 PR 构建）—— 「文档说的」与「机器做的」各说各话正是本契约要消灭的漂移本身。 入口顶层 require 预算：CLI 入口（bin/khy.js）中不在任何函数体内的 require（= 模块求值时必被执行，AST 口径）其第一方模块数量与合计行数不得超过 CORE-LAYERS.json 的 entryBudget 基线，只许减不许增 —— 这份重量由**所有命令**承担（含 khy --version），不会因为「那条路径用不到」而消失。 重量分摊预算：运行时顶层边可达（装载期求值）与懒加载边可达（只在被触发路径上求值）的模块数与行数不得超过 runtimeFootprint.weightLayers 的基线 —— 分项计量才知道该动哪一头，且该预算必须真的被守卫消费（写进契约却无人读取等于没有约束）。 分类口径：静态侧「顶层 vs 懒加载」用 AST 函数作用域判定（scripts/lib/requireGraph.js），运行时侧用「加载者是否正在求值」判定（scripts/lib/runtimeFootprint.js）；解析器不可用时必须显式报 core-classifier-degraded，不得静默降级为更差的判定。视觉侧同源：加载边分类同样用 AST（scripts/lib/visualLayerGraph.js），并显式处理视觉侧特有语义 —— ESM import 与 export ... from 是提升的（恒为装载期边）、类型导入被擦除（不算运行时边）、import() 恒为动态边；回退到括号深度口径必须显式报 visual-classifier-degraded。"
grants: "见约束边界：授权按本规则自行决定新模块落在芯/膜/皮哪一层，以及通用能力应下沉到 utils/ 还是留在表现层。"
benefit: "系统重量从主观抱怨变成可机判的数字，且不反弹；跨层依赖在提交前即被拦下，而不是等到闭包涨到几十万行后才发现。逻辑与视觉两轴同构治理：「芯里混进外壳」与「首屏里混进用时才需要的面板」是同一个病的两种表现，共用一套判据语义。补上体积轴的事实侧度量：静态闭包是估算（「如果全加载会进多少」），运行时 require.cache 才是事实（「实际进了多少」）；加载归因进一步回答「谁把重量拽进来的」——静态图答不了「哪条懒加载边被触发了」。方向矩阵被消费才叫契约：此前 visual.edgePolicy 定义了却无人执行，是一份没人执行的契约（等于没有约束）。 文档↔契约对账判据（doc-contract-drift）：契约被 --update 更新后，文档里的旧数字会被自动报出来 —— 本轮实测到两处（91,540 → 91,608、50,860 → 50,928），人不会记得同步，而守卫会。 2026-10-31 的一次口径级自我纠错（本条规则自身的度量曾算错）：「顶层 vs 懒加载」的旧判定用「require 处的括号深度」，而括号深度 ≠ 函数作用域 —— 顶层 try{}/if{} 块里的 require 与多行解构赋值里的 require（require( 落在花括号内）被误判成懒加载（低估）；更致命的是旧口径的 braceDepthMap 不识别正则字面量，正则里的括号被当成代码结构，从文件中第一个正则起深度整体偏移、后面所有函数体内的 require 都被误判成顶层（虚高，实测 toolUseLoopCore.js 第 360 行起 96% 的字符深度失真）。偏移方向取决于文件里先出现哪种字符，因而不可预测 —— 这不是某个文件写得不规范，是判据本身没有定义。两个方向都错意味着这样的数字不能当预算：一个只涨不跌的棘轮，若基线本身错了，它锁住的是错误。修正后静态侧用 AST 函数作用域、运行时侧用「加载者是否正在求值」的运行时真相（不往被测进程塞解析器，否则污染外部依赖与 heap 读数），全部基线重算并写明「是纠正还是放松」。另补两条此前无人消费的契约：entryBudget（入口顶层 require —— 所有命令都付的那一份）与 weightLayers.budget（顶层边/懒加载边分摊 —— lite 路径实测顶层边可达 332 文件/14.4 万行 vs 懒加载边 145 文件/5.8 万行，直接指认网关适配器按需加载这一刀）。"
exception: "动态 require（require(path.join(...))）不在静态图的判定范围内，不据此判违规；测试夹具与 build/dist 产物不计入闭包；纯 re-export 门面（单行转发到真源）视为层内归属。"
version: "1.2.0 (2026-10-31)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-197] 剥洋葱：Khy OS 最小核心与分层重量治理.md"
formerly: 无
owner: architecture-team
enforcement: "scripts/ci/check-core-layers.js + scripts/ci/check-runtime-footprint.js"
---

# [TOOLING-012] 洋葱分层重量与芯纯净

<!-- RULES-REGISTRY: TOOLING-012 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-197] 剥洋葱：Khy OS 最小核心与分层重量治理.md。

## 约束

运行时按加载时机分三层：L0 芯（冷启动即入内存）、L1 膜（被调用才装载）、L2 皮（终端/桌面/Web 表现层）。L0 不得依赖 L1/L2；L1 不得依赖 L2；L1 入口的可达闭包不得渗入视觉皮文件；逻辑侧不得经皮侧 re-export 门面引用通用能力。L0/L1 的冷闭包（仅顶层 require 边）文件数与行数不得超过 CORE-LAYERS.json 的基线，只许减不许增。视觉侧同构：V0 视觉芯的首屏冷闭包（仅静态 import/require 边）不得超基线；应懒加载的低频页面不得出现在 V0/V1 的首屏冷闭包里；视觉层方向矩阵（visual.edgePolicy）必须被消费 —— 芯(V0) 不得依赖膜(V1) 与皮(V2)，膜(V1) 不得依赖皮(V2)。运行时重量（体积轴）：version / doctor --quick / ai-lite 三个场景实际加载的第一方模块数、行数、字节数与外部依赖量不得超过 CORE-LAYERS.json 的 runtimeFootprint 预算；重量闸门（归因：非入口加载者中单点可达重量最大者）不得变大。运行时读数跨会话会漂，故硬预算只给文件数（实测波动 0），行数容差 1%、字节数容差 5%。 设计文档 [DESIGN-ARCH-197] 里引用的基线数字必须与 CORE-LAYERS.json 一致（warning 级：漂移要报，但不阻断整个 PR 构建）—— 「文档说的」与「机器做的」各说各话正是本契约要消灭的漂移本身。 入口顶层 require 预算：CLI 入口（bin/khy.js）中不在任何函数体内的 require（= 模块求值时必被执行，AST 口径）其第一方模块数量与合计行数不得超过 CORE-LAYERS.json 的 entryBudget 基线，只许减不许增 —— 这份重量由**所有命令**承担（含 khy --version），不会因为「那条路径用不到」而消失。 重量分摊预算：运行时顶层边可达（装载期求值）与懒加载边可达（只在被触发路径上求值）的模块数与行数不得超过 runtimeFootprint.weightLayers 的基线 —— 分项计量才知道该动哪一头，且该预算必须真的被守卫消费（写进契约却无人读取等于没有约束）。 分类口径：静态侧「顶层 vs 懒加载」用 AST 函数作用域判定（scripts/lib/requireGraph.js），运行时侧用「加载者是否正在求值」判定（scripts/lib/runtimeFootprint.js）；解析器不可用时必须显式报 core-classifier-degraded，不得静默降级为更差的判定。视觉侧同源：加载边分类同样用 AST（scripts/lib/visualLayerGraph.js），并显式处理视觉侧特有语义 —— ESM import 与 export ... from 是提升的（恒为装载期边）、类型导入被擦除（不算运行时边）、import() 恒为动态边；回退到括号深度口径必须显式报 visual-classifier-degraded。

## 授予权力

见约束边界：授权按本规则自行决定新模块落在芯/膜/皮哪一层，以及通用能力应下沉到 utils/ 还是留在表现层。

## 提供福利

系统重量从主观抱怨变成可机判的数字，且不反弹；跨层依赖在提交前即被拦下，而不是等到闭包涨到几十万行后才发现。逻辑与视觉两轴同构治理：「芯里混进外壳」与「首屏里混进用时才需要的面板」是同一个病的两种表现，共用一套判据语义。补上体积轴的事实侧度量：静态闭包是估算（「如果全加载会进多少」），运行时 require.cache 才是事实（「实际进了多少」）；加载归因进一步回答「谁把重量拽进来的」——静态图答不了「哪条懒加载边被触发了」。方向矩阵被消费才叫契约：此前 visual.edgePolicy 定义了却无人执行，是一份没人执行的契约（等于没有约束）。 文档↔契约对账判据（doc-contract-drift）：契约被 --update 更新后，文档里的旧数字会被自动报出来 —— 本轮实测到两处（91,540 → 91,608、50,860 → 50,928），人不会记得同步，而守卫会。 2026-10-31 的一次口径级自我纠错（本条规则自身的度量曾算错）：「顶层 vs 懒加载」的旧判定用「require 处的括号深度」，而括号深度 ≠ 函数作用域 —— 顶层 try{}/if{} 块里的 require 与多行解构赋值里的 require（require( 落在花括号内）被误判成懒加载（低估）；更致命的是旧口径的 braceDepthMap 不识别正则字面量，正则里的括号被当成代码结构，从文件中第一个正则起深度整体偏移、后面所有函数体内的 require 都被误判成顶层（虚高，实测 toolUseLoopCore.js 第 360 行起 96% 的字符深度失真）。偏移方向取决于文件里先出现哪种字符，因而不可预测 —— 这不是某个文件写得不规范，是判据本身没有定义。两个方向都错意味着这样的数字不能当预算：一个只涨不跌的棘轮，若基线本身错了，它锁住的是错误。修正后静态侧用 AST 函数作用域、运行时侧用「加载者是否正在求值」的运行时真相（不往被测进程塞解析器，否则污染外部依赖与 heap 读数），全部基线重算并写明「是纠正还是放松」。另补两条此前无人消费的契约：entryBudget（入口顶层 require —— 所有命令都付的那一份）与 weightLayers.budget（顶层边/懒加载边分摊 —— lite 路径实测顶层边可达 332 文件/14.4 万行 vs 懒加载边 145 文件/5.8 万行，直接指认网关适配器按需加载这一刀）。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

动态 require（require(path.join(...))）不在静态图的判定范围内，不据此判违规；测试夹具与 build/dist 产物不计入闭包；纯 re-export 门面（单行转发到真源）视为层内归属。

## 版本记录

- 1.2.0 (2026-10-31) 初版 / 迁移自 无
