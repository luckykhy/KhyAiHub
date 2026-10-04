# adapters — 外部 agent 资产适配器族

D2 功能单元（`domain/agents/agentAssets/adapters/`）。

## 谁要

用户把沉淀在某个外部 agent 工具（Claude Code / opencode / OpenClaw / DeepSeek Harness /
通用 harness 约定）里的记忆、技能、MCP 工具配置搬到 khy-os 或另一家工具时，需要一层
「每家磁盘布局 → 统一资产模型」的翻译层。编排层 `../sync.js` 只认「源 id → 目标 id」，
khy-os 自己也实现同一契约（`khyOs.js`），故 tool↔tool 直接迁移不需要特判。

## 为什么

新增一家工具 = 新增一个 `adapters/<id>.js` + 注册表加一行（`../registry.js` 头注释
写明的扩展缝）。各家布局的实证来源写在各文件头（`~/.claude` 本机实证、上游 README、
docs.openclaw.ai 三页实测确认），不是猜的。

## 怎么验

`node --test <六个显式路径>`（本仓口径禁止通配读数），6 份共置测试 / 53 例 / 0 fail，
全部用 `fs.mkdtempSync` 临时目录 + 注入 env，不触真实主目录。装载走 `registry.js:86`
的动态 require（`require(./adapters/${module})`），故静态 fan-in 为 0 ——
验证装载面需跑经 registry 的上层（sync 套件）。
