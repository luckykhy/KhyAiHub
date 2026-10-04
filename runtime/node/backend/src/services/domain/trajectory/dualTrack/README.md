# dualTrack — 双轨热插拔运行时（D2 功能单元）

一句话：把「模型自适应 + 官方核心/用户扩展双轨」收敛成一个可被调度器调用的编排门面 `DualTrackRuntime`，落 DESIGN-ARCH-033 的四条宪法红线——**脆弱解析致命**（红线1）、**未知指令静默吞没**（红线2）、**假设终态/白屏崩溃**（红线3）、**官方更新覆盖用户轨**（红线4）、**覆写污染核心源**（红线5）。核心轨在 `assemble` 后密封不可改写；用户/模型 DIY 只能在影子扩展轨（`user_patch/`）里以 Override 覆盖，永不触碰官方源。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被 `npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。

## 逐成员

| 文件 | 角色 | 仓内 require | 同名测试 |
|------|------|-------------|----------|
| `core/coreActions.js` | 官方核心轨内置动作（`say` / `read_file` / `noop`）+ 接入点契约 `CORE_ENTRY_POINTS`；冻结、纯函数 | 无（node 内建亦无） | `core/coreActions.test.js` |
| `actionRegistry.js` | 双轨注册表：核心轨（密封只读）+ 用户覆写影子轨；解析优先级 override > core > unknown 兜底；核心完整性断言 | 无 | `actionRegistry.test.js` |
| `unknownActionView.js` | 未知指令安全占位符（与 UI 框架无关的数据描述符）；原始视图截断至 4000 字符；任何输入恒 renderable | 无 | `unknownActionView.test.js` |
| `degradeStateMachine.js` | 降级状态机 `decideFlow`：已知+可调用 → PROCEED（auto），其余一律 MANUAL_CONFIRM（human），全定义、永不抛 | `./unknownActionView` | `degradeStateMachine.test.js` |
| `lenientResponseParser.js` | 宽松解析模型响应：未知字段捕获、非对象动作封装、坏 JSON 当 text 兜底，永不抛（红线1/2/3） | 无 | `lenientResponseParser.test.js` |
| `extensionLoader.js` | 装载用户扩展轨（manifest.json）+ 沙箱边界 `assertWithinUserTrack`；单个扩展坏掉绝拖不垮基座 | `path`、`./actionRegistry` | `extensionLoader.test.js` |
| `extensionWriter.js` | 模型 DIY 授权写入扩展轨；授权闸 + 沙箱闸双保险 | `path`、`./actionRegistry`、`./extensionLoader` | `extensionWriter.test.js` |
| `updateGuard.js` | 官方更新防破坏协议：`planOfficialUpdate`（fail-closed）/ `detectBreakingChange`（迁移提示）/ `applyOfficialUpdate`（仅安全才施工） | `path`、`./extensionLoader` | `updateGuard.test.js` |
| `index.js` | `DualTrackRuntime` 门面：assemble / parse / resolveAction / dispatch / authorizedModelWrite / planUpdate / applyUpdate / checkBreaking / coreIntact | `path`、单元内 6 件 | `index.test.js` |

require 全为单元内互引或 node 内建（`path` / `fs`），**无一条伸向 D3/D1**，故清单 `mayDependOn` 只声明 `[D2]`（见 `khy.module.json` 的 `_mayDependOn_note` / `_deviation_note`）。

## 消费者（fanIn = 1，实测 2026-09-28）

- `services/backend/src/services/dualTrack/index.js` —— D1 侧的兼容别名壳，`module.exports = require('../domain/trajectory/dualTrack')`。按 `[DESIGN-LAY-008]` 第 0 步约定，纯 re-export 壳仍算真实入口，故如实计入 fanIn。

文本提及 `dualTrackForge` 的文件（`security/adversarial/*`、`data/reverseEngineer/*`）指向的是**兄弟单元** `trajectory/dualTrackForge/`，不是本单元，且均为注释而非 require，不计入。本单元当前是「机制已就位、尚未被业务广泛接线」的受保护基座，`fanIn=1` 是真实读数。

## 契约（每条都有具名测试兜）

1. **核心轨密封不可改写**：`seal()` 后任何 `registerCore`（含未注册过的合法 type）抛 `CorePollutionError`；重复注册同 type 亦抛；`registerOverride` 只写影子层，核心键集合逐字节不变 → `actionRegistry.test.js`
2. **解析优先级 + 未知兜底**：`resolve` 恒返回 `{type, handler, origin, isKnown, source}`，未知 → `origin:'unknown', isKnown:false, handler:null`，绝不 `undefined` 也不抛；override 压过 core → `actionRegistry.test.js`
3. **状态机全定义 + PROCEED 门槛**：`decideFlow` 要 PROCEED 必须同时满足 `isKnown===true` **且** `handler` 为函数；其余（含 resolution 缺失、isKnown 但 handler 非函数）一律降级 MANUAL_CONFIRM 并交还控制权；遍历任意输入组合无一次返回 undefined → `degradeStateMachine.test.js`
4. **占位符恒可渲染 + 截断**：任意输入（含 null/undefined/循环引用）都产出 `renderable:true`；原始视图超 4000 字符按 `…(已截断，共 N 字符)` 截断 → `unknownActionView.test.js`
5. **宽松解析永不致命**：坏 JSON / 非对象根 / 非对象动作 / 缺类型 / 未知键 / 非数组 actions 全部走降级或捕获路径，顶层未知字段进 `unknownFields`、动作未知键进 `_unknownKeys`，warning 同步注入的 logger 且 logger 抛错不影响解析 → `lenientResponseParser.test.js`
6. **装载优雅降级 + 沙箱**：无轨 / 读失败 / manifest 坏 JSON / 单扩展坏，基座恒存活（记入 `skipped`/`errors`）；`module` 路径解析越出用户轨即抛 `CorePollutionError` 并被捕获跳过，越界模块**绝不**被注册 → `extensionLoader.test.js`
7. **写入双闸**：授权闸（`authorized !== true`）在**任何 fs 调用之前**拒绝；沙箱闸拒绝越界/绝对轨外路径；成功路径经注入 fs 断言 mkdir/writeFile 实参 → `extensionWriter.test.js`
8. **更新 fail-closed**：任一文件越出核心轨或命中受保护用户轨（含段名兜底）→ 整包 `safe:false`；`applyOfficialUpdate` 见 `safe!==true` 拒绝施工、写盘桩被调用即炸；接入点被移除时 `detectBreakingChange` 产多行迁移提示，绝不静默作废 → `updateGuard.test.js`
9. **门面编排**：`assemble` 注册注入的 coreActions → 密封 → 记录 loadReport；`dispatch` 未知动作绝不自主执行、executor 抛错转 MANUAL_CONFIRM 兜底并保留其 `Error.code`；`coreIntact` 在核心键漂移后返回 `false`；`checkBreaking` 用 `CORE_ENTRY_POINTS` 做兼容性差分 → `index.test.js`

## 怎么跑

```bash
# 共置契约测试（node:test 方言；Windows 下必须逐个列文件名，目录参数会被当模块路径）
cd services/backend/src/services/domain/trajectory/dualTrack
node --test actionRegistry.test.js degradeStateMachine.test.js unknownActionView.test.js \
  lenientResponseParser.test.js extensionLoader.test.js extensionWriter.test.js \
  updateGuard.test.js index.test.js core/coreActions.test.js
```

全部测试对 fs / requireImpl / pathImpl / logger 走桩注入，不发网络、不读写真实 `user_patch/`、不依赖开发者绝对路径。

本单元的记录动作 = **9 份同名同目录测试 + 1 份清单 + 本 README**：按守卫实测，每补一份共置测试 `functional-unit` 降 1，一份覆盖全单元的清单 + 齐全晋级判据使 `entry-buffer` 降 9（9 个源文件从「无记录」转为「已记录 stable」）。
