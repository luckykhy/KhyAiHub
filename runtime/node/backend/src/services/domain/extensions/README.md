# extensions — 拓展、钩子与插件贡献的装载层（D2）

业务上下文：`/extension`、`/hooks` 与 `plugin` 子命令背后的一切——
发现拓展根、读清单、开关、把插件贡献的工具接进工具调用链、跑钩子。

## 谁要（角色）

- **装/卸拓展的人**：`constants/commandSchema.js:2106` 声明 `/extension`
  （路由 `extension list`，子命令 `:371`），处理器 `cli/delivery/extension/extensionManager.js:13`。
- **配钩子的人**：`/hooks`（`commandSchema.js:2002`）；
  钩子系统经壳 `cli/hooks/hookSystem.js:14` 再导出本目录 `hooks/hookSystem.js`。
- **让插件工具被模型调用的人**：`services/tool/toolCalling.js:65` require
  `plugins/pluginContribResolver`，`:1599` require `plugins/pluginToolBridge`，
  在 `:1709-1711` 用 `ownsTool` / `activateContributedTool` 决定工具归属。
- **加载 provider 模块的人**：`plugin-loader/index.js:38` 取 `extensionRoots`；
  `services/gateway/adapters/claudeAdapter.js:2007` 亦消费本目录。

## 为什么这么做

拓展是**会被整体搬动的目录**，所以装载链分三层且各自可独立验证：
`extensionManifest.js` 只管清单契约（`MANIFEST_CANONICAL / MANIFEST_NAMES / KINDS`），
`extensionRoots.js` 只管发现与孤儿态（`discover / readState / isEnabled / findOrphanState`），
`extensionManager.js` 才碰安装/卸载的 `fs` 与子进程。贡献面同理拆开：
`pluginContribResolver` 回答「这个工具名归谁、懒加载谁的入口」，
`pluginToolBridge` 回答「怎么调、返回什么」，`hookConfigSchema` 是纯校验
（`validateHooksConfig / normalizeHook`），`hookRunner` 才执行子进程并用
`CMD_HOOK_ALLOWED_FIELDS` 白名单收输出字段。这样拆的代价是多两三个文件，
收益是「拓展搬家」「钩子输出越界」这两类事故各自只有一处真源。

## 怎么验

```bash
cd services/backend
node --test tests/pluginToolBridge.test.js                    # 7 tests / 7 pass / 0 fail
```
`tests/hooksConfig.test.js` 是 jest 形态（正式入口 `npm test`；本卡未在此 shell 复跑，
便携 shell 无 npm/npx）。

## 已知缺陷（登记，不在本单元擅自修）

拓展契约的另一半（`khy.extension.json` 的合规与路径漂移）不在本单元判，
由 `check:layout` 的 `extension-contract` / `extension-id-hardcode` /
`extension-path-drift` 三条尺管，当前均为 0。
