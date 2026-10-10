# plugins — 扩展插件贡献的解析 / 调用 / 桥接

D2 功能单元（`domain/extensions/plugins/`），三个源文件各管一段：

- `pluginContribResolver.js` — 扫描各扩展根的 manifest，解析「哪个扩展声明了哪些工具/命令」，
  first-wins 遮蔽序 + 禁用位（disabled）决定广告面；
- `pluginInvoker.js` — 按声明执行插件（openapiTools 对外契约形状、urlSafety/nativeHttp 出网面）；
- `pluginToolBridge.js` — 把插件工具桥接成 `_baseTool` 形态，交给 `src/tools` 注册表。

## 谁要

`khy` 的扩展体系（`services/plugins/index.js` 门面、网关适配器 claude/codex 的广告面、
`services/tool/toolCalling.js` 的执行面）需要一处把「外部扩展声明」变成「平台可调用工具」的
翻译层，三处消费者共用同一解析结果，避免 CLI 与网关两套视图不一致。

## 为什么

扩展贡献必须有唯一漏斗（resolver），否则「工具名到底谁生效」在不同入口会给出不同答案。
实测语义（钉在测试头注释）：禁用 first-wins 的扩展**不会**让工具名消失——discover 序后位的
同名扩展接管该名字，须双禁用才 fail-closed 出局。

## 怎么验

`node --test` 显式列三份共置测试路径：pluginContribResolver 9 例 / pluginInvoker 14 例 /
pluginToolBridge 10 例，合计 33 例 / 0 fail。resolver/invoker 的出网与 `_baseTool` 面用
require.cache 桩隔离；`flagRegistry`、`@khy/shared/plugins/openapiTools` 走真件。
