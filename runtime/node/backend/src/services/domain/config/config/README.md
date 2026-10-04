# config — 自然语言配置意图解析与偏好归一（纯叶子族）

D2 业务上下文里的一个功能单元：9 个**零 IO、确定性、fail-soft** 的叶子，把自然语言意图收敛成
「改哪个开关 / 配哪个供应商 / 给外部软件配模型 / 是配置还是安装」这类结构化判定，供 CLI 与会话层消费。

9 个源文件全部有同名同目录的共置测试（160 例 / 0 fail，2026-09-29 本道显式路径复跑；18 处 `KNOWN-DEFECT` 钉住实测行为）。

## 各文件的职责（取自各文件头注释）

| 文件 | 角色 |
|---|---|
| `langPreference.js` | 输出语言偏好「归一·描述·解析」的零 IO 单一真源 |
| `nlActionResolver.js` | 自然语言 → khyos「动作意图」解析 |
| `nlConfigResolver.js` | 自然语言 → khyos「能力开关」意图解析 |
| `nlExternalAppResolver.js` | 自然语言 → 「给外部软件配模型」 |
| `nlExternalAppImportResolver.js` | 自然语言 → 「反向使用外部软件」导入解析 |
| `nlInstallVsConfigGuard.js` | 「配置 khy vs 安装第三方工具」歧义护栏 |
| `philosophyDesignResolver.js` | 自然语言「哲学内容 → 软件设计落地」意图解析 |
| `sandboxToggleState.js` | `/sandbox-toggle` 的开关归一·状态解析·动作规划 |

## 谁在用本单元（非测试外部消费者 8 个，去重）

CLI 面 5 个：`cli/aiChatCore.js:1240/1265/1286/1348`（四处惰性 require，会话内配置意图路由）、
`cli/handlers/capability.js:22`、`cli/handlers/config.js:121`、`cli/handlers/lang.js:16`、`cli/handlers/sandboxToggle.js:24`；
再导出壳 1 个：`services/config/index.js:4-8`；其余 2 个为路径命中（`services/localBrainProviderConfig.js`、
`tools/configureCapability.js`），**行号本轮未逐条核到**，如实标注而不是补一个没测的数字。

## 出域边（如实登记，不写白名单）

- **D3 共 12 处**（`utils/` 与 `constants/`），名义边界内合法。
- **D1 共 1 处**：`nlExternalAppImportResolver.js:26` → `services/flagRegistry.js`（该文件本身是 D3 归位后留下的兼容壳，
  `module.exports = require('../utils/flagRegistry')` ⇒ 语义上是 D2→D3，路径上命中 D1）。
  这一条正是 `[DESIGN-LAY-008]` §12.43 里「建门前必须先定的判据」的活样本：纯路径前缀判定会把它误报成违令边。
