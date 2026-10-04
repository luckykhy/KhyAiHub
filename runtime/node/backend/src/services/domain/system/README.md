# system — 系统调用网关与 wasm 沙箱宿主（D2）

业务上下文：每一次工具权限检查都经过的**执行前闸门**（意图校验、资源分级、
红线判定、审批路由、拒绝引导），以及 wasm 应用作为「外部计算单元」的宿主与 IPC。

## 谁要（角色）

- **每次工具调用**：`services/tool/toolCallingPermissions.js:647` 取
  `syscallGateway/intentSchema` 的 `buildIntent`，`:655` 取
  `preExecutionExplainer.explain`——这是本目录唯一的生产入口（无 slash 命令）。
- **跑 wasm 应用的人**：`services/wasmAppService.js:30` require `./wasm-sandbox`。
- 壳：`services/syscallGateway/index.js:4-5`、`services/wasm-sandbox/index.js:4`。

## 为什么这么做

网关是**策略 + 状态机 + 通道**三件事，混写必然出现「改了提示词就以为改了权限」：
`resourceClassifier`（`classify / isExemptible / LEVELS`）与 `redLine`
（`isRedLine / DESTRUCTIVE_SUMMARY`）是纯判级；`intentSchema.detectBypassMarkers`
专防「换个说法绕过」；`approvalRouter` 决定 L2 确认与拒绝成因（`DENY_CAUSES`）、
`permissionCache` 只在显式授予后缓存会话许可、`breachBreaker` 管越界熔断；
`actionContractVerifier` 用公理表（`AXIOMS` + `evaluatePredicate`）验证
「这个动作声明与它的实际效果是否自洽」；`denialGuidance` 负责规则 2.2 的
「问题 + 识别码 + 修复建议」文案；`preExecutionExplainer` 在执行前把动作讲清楚。
wasm 侧同理分层：`m1Constants` 是纯常量与位运算、`ipcCodec` 是纯帧编解码、
`moonbitHostBridge`/`khySysHost` 是宿主、只有 `loopbackTransport.js` 碰盘。
本目录 16 个文件里只有 1 个碰 `fs`、0 个开网络——这是刻意的，
判据必须可在单测里逐条断言（见下）。

## 怎么验

```bash
cd services/backend
node --test tests/actionContractVerifier.test.js               # 22 tests / 22 pass / 0 fail
```
该文件 `:20` **直接 require 本目录的域内路径**（不经壳），因此这条命令同时是
「域内真源可被独立引用」的证明。同族：
`tests/services/syscallGateway.scenarios.test.js`、`tests/services/denialGuidance.test.js`、
`tests/wasmSandbox.loopbackTransport.test.js`。

## 已知缺陷（登记，不在本单元擅自修）

`intentSchema.js` 会读 `os.homedir()`——纯判级文件里混了一次宿主调用，
虽不碰盘但让「同输入同输出」的断言需要固定环境；未修，因为改它会动
`toolCallingPermissions.js:647` 的入参契约，属规则 5 的独立改动集。
