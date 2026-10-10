# config — 通道卡片（cc-switch）、自然语言配置意图与键位表（D2）

子上下文：`ccSwitch` / `config`（九个 nl\*Resolver）/ `keybindings`。
22 个文件，IO 集中在 `store` / 写盘器 / 探测三处，判定侧全纯。

## 谁要（角色）

- **管通道卡片的人**：`khy cc-switch <add|use|status|scan>`
  （派发 `cli/routerDispatchTail.js:1969`，处理器 `cli/handlers/ccSwitch.js:27-28`、
  `:302,423,495`）；Web 侧 `routes/ccSwitch.js:25` + `server.js:642`
  的 `/api/cc-switch`。
- **用一句话改配置的人**：`cli/aiChatCore.js:1240,1265,1286,1348` 依次问
  `config/nlConfigResolver`、`nlActionResolver`、`nlProviderResolver`、
  `nlInstallVsConfigGuard`——最后这个是「用户说要装，其实是要配」的护栏。
- **`/lang` `/keybindings` `/sandbox-toggle`**：`constants/commandSchema.js:1017`、
  `:1038`、`:1073` → `cli/handlers/{lang.js:16,config.js:121,sandboxToggle.js:24}`。
- **能力配置**：`tools/configureCapability.js:23`（另注：
  `delivery/channel/khyquant/tools/configureCapability.js:24` 指向 software 本地副本，
  不是本目录——独立项目 khyquant 的分发载体，不改变其归属）。

## 为什么这么做

「NL → 意图 → 动作」是本仓最容易 fail-open 的一段，所以刻意做成
**每个能力一个 resolver + 一张能力表**：`nlConfigResolver` 暴露 `CAPABILITIES` /
`ON_VALUE` / `OFF_VALUE` / `buildEnvPatch` / `findCapability`，
命中不了就返回未命中而不是猜；`nlInstallVsConfigGuard` 用四条正则
（`_REs`）专门拦「把 install 说成 config」这类混淆；
`philosophyDesignResolver` 把设计取向类指令单独分档。
`ccSwitch/` 里写盘的东西各归一处：`store.js`（卡片与凭证）、
`codexWriter.js`（`preflightCodexWrite` + `RESERVED_PROVIDER_IDS` + 旧形状自愈
`_healLegacyShapes`）、`appWriters.js`（把卡片应用到各 app）、
`proxyAccess.js`（代理卡与运行文件）；纯判定留给 `routeResolver.js`
（`resolveCardRoute` / `appsForProtocol`）与 `constants.js`
（`PROTOCOLS` / `APPS` / `PROTOCOL_DEFAULT_MODELS`）。
理由与 `[DESIGN-DEP-001]` §10 一致：来源与默认值必须有一处真源，
不许在写盘器里各写一份。

## 怎么验

```bash
cd services/backend
node --test tests/nlConfigResolver.test.js                       # 23 tests / 23 pass / 0 fail
node --test tests/services/keybindings/keybindingCatalog.test.js  # 20 tests / 20 pass / 0 fail
```
`tests/services/ccSwitch/*.test.js`（store/index/proxyAccess）是 jest 形态，
本机 jest 渠道不可用；`tests/routes/ccSwitch.route.test.js`、
`tests/cli/ccSwitchExitCode.test.js` 本卡未复跑。

## 已知缺陷（登记，不在本单元擅自修）

本目录当前无 ` M`/`A ` 文件。已知盲区是卡片写盘链（`codexWriter` /
`appWriters`）的回归只有 jest 侧覆盖，在本机没有可执行渠道——
「写盘正确」这件事因此在本机不可证，须在有 jest 的机器上复跑。
