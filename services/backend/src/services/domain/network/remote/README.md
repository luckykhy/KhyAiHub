# `domain/network/remote` —— 远端 SSH 执行/上传的可注入原语簇（12 文件，星形装配）

> 本 README 是本单元的上下文真源之一。机器可读的契约、扇入与登记缺陷见同目录
> `khy.module.json`（守卫 `npm run check:layout` 的 `functional-unit` 规则要求二者并存）。

## 1. 三问（规则 9 / `PROCESS-010`）

| 问 | 答 |
|---|---|
| **谁要的** | 用户。入口在 D1：`routes/remoteSsh.js`（远端执行 SSE 面）、`routes/largeTasks.js`（取 remoteStateSyncService 做状态画面）、`cli/handlers/remote.js`、`tools/deploy.js`（deployOrchestrator）。这四个消费者**全部**经 D1 整包 shim `services/backend/src/services/remote/index.js:4` 单点进入本目录——实测扇入 = **1 个非测试文件 / 1 个 require 站点**。 |
| **为什么要这么做** | 这簇文件解决的是「平台要对远端主机做**有审批的执行与上传**」这件事的分层：配置读取（ssh_config 解析）、凭据事后校验、审批 FSM（工单→批准→消费）、执行/上传原语、流式事件存储（断线重播）、状态持久化与告警环、以及把八件原语装配起来的 `index.js`。星形装配是刻意的：11 个兄弟文件之间**零互引**，只有 `index.js:3-16` 取它们；每个原语都能被单独注入假件（deployOrchestrator 的工厂收全部八个依赖）。反例也登记在册：exec 与 transfer 把 `spawn('ssh'/'scp')` 硬编码在装载路径上（B31-R17），它们的隔离靠**装载顺序**（先换 spawn stub 再 require）而不是设计。 |
| **怎么验证** | `cd services/backend && node --test src/services/domain/network/remote/*.test.js`（**显式列路径**，本环境直传目录得到假读数）→ 12 份共置套件 **170 例 / 874 个断言调用点 / 0 fail / 0 skip**（duration ≈ 1.5s）。单元外 7 份引用本目录的测试**全部是 jest 方言，本环境未装 jest、0 份可跑**——它们的装载失败形如「1 例 fail、名字是文件路径」，不是产品缺陷，不可据此判红。 |

## 2. 契约（改本单元前先读这段）

- **`index.js` 导出面 19 键**（`index.test.js` 逐字钉死）：11 个装配好的单例 +
  `remoteStateHydration` + `buildRemoteExecStreamRequestFingerprint` / `persistRemoteState` /
  `listPersistenceAlerts` / `subscribePersistenceAlerts` / `markPersistenceAlertsAcknowledged` /
  `hydrateRemoteStateFromDisk` / `resetRemoteStateForTests`。其余 11 个文件各自独立导出
  （类+工厂为主；`remoteExecService` 只有类、**无工厂无注入缝**）。
- **三种文件角色，改法不同**。纯叶子：`remoteWorkspaceResolver`（51 行）、
  `remoteStateSyncService`（37 行只读聚合器）、`parseSshConfig` 半边、指纹函数。
  薄 IO：`sshConfigService`（读一个路径来自 env 的文件）、`remoteStatePersistence`
  （tmp+rename 写状态）、`sshCredentialGuard`（stat 密钥）、`remoteFileTransferService`
  （spawn scp）、`remoteExecService`（spawn ssh）。有状态主体：`index.js`（563 行，
  module-load 单例 + 持久化防抖 + 告警环 + hydration）、`remoteApprovalBridge`（FSM）、
  `sshConnectionManager`（会话表）、`remoteExecStreamStore`（流/事件窗口）。
  **新逻辑一律进纯叶子，不要往 `index.js` 加。**
- **本目录读取的 `KHY_*` 门，全数清点 14 个**（非抽样）：
  执行总闸 `KHY_REMOTE_SSH_ENABLE_EXEC`（默认**关**，`utils/envFlagByName` 逐调用点读取）；
  超时对 `KHY_REMOTE_SSH_IDLE_TIMEOUT_MS` / `KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC`；
  持久化 `KHY_REMOTE_SSH_PERSIST_STATE`（默认**关**）/ `KHY_REMOTE_SSH_STATE_PATH` /
  `KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS` + 告警环 `KHY_REMOTE_SSH_PERSIST_ALERT_MAX` /
  `KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS`；
  流表面 `KHY_REMOTE_SSH_STREAM_TTL_MS` / `KHY_REMOTE_SSH_RUNNING_STREAM_TTL_MS` /
  `KHY_REMOTE_SSH_MAX_STREAMS` / `KHY_REMOTE_SSH_MAX_STREAM_EVENTS`；
  边界 `KHY_REMOTE_WORKSPACE_ALLOWLIST`（未设即 fail-open，见 B31-R3）/ `KHY_REMOTE_SSH_CONFIG_PATH`。
- **凭据处理**：本单元**不存储任何凭据**，只引用路径 + 事后校验。IdentityFile 从
  ssh_config 读出后经 `os.homedir()` 展开 `~`（调用时解析，本机探针实测 libuv 顺序
  HOME→USERPROFILE，见 §4）；`sshCredentialGuard` 查密钥存在/是文件/权限 ≤600，
  **win32 分支是跳过不是检查**（B31-R5c）。工单导出与 onMutate 载荷**从不带密钥材料**
  （`remoteApprovalBridge.test.js` 钉死）。API key 的家在 `~/.khyquant/config.json`，属别的单元。
- **写/执行通道只有三条，全部默认封死**：(1) `remoteExecService.js:195` `spawn('ssh', …)`；
  (2) `remoteFileTransferService.js:236` `spawn('scp', …)`（本单元**没有** download/list/delete
  半边）；(3) `remoteStatePersistence.save` 写状态文件（默认关）。封条是
  `KHY_REMOTE_SSH_ENABLE_EXEC=false` + 审批 FSM + 幂等键；但封条本身有实测破口——
  B31-R1（`dd if=` 判 SAFE）、B31-R20（审批不绑定 payload）、B31-R18（类型垃圾变 shell 词）、
  B31-R3（白名单 fail-open）——**改动任何一条前先读 khy.module.json 的对应缺陷**。
- **注入点**：`createDeployOrchestrator({...})` 八依赖全注入；各 `create*` 工厂的
  `onMutate/onEvent/enabled/statePath` 位；`RemoteStateSyncService` 构造子三位；
  路径位 `KHY_REMOTE_SSH_CONFIG_PATH` / `KHY_REMOTE_SSH_STATE_PATH` / `KHY_DATA_HOME`。
  **注入破口**：exec/transfer 装载即绑 spawn（B31-R17），不可注入传输。
- **出边地形**：D3×5（envFlagByName×4、dataHome×1，全合法）、D2×2（index.js:437-438
  惰性取 `deploy/publish` 的 builder，横向合法）、同目录×11、CORE×14。⚠ **2 条边落在
  无域归属的根上**：`remoteExecService.js:6` 与 `remoteFileTransferService.js:22` →
  `../../../../tools/platformUtils`（取 `safeKill`）。`services/backend/src/tools/**`
  不在 DOMAIN-DEPS 任何 roots/overrides 里，守卫**静默跳过**——这是继 messaging/mcp
  （B30-M8）、network/externalApps 之后**第三个**撞上同一登记盲区的批次。
  `mayDependOn` 保持 `["D2","D3"]` 不放宽：放宽等于把缺口做实，属人的裁决。
  **D2→D1 反向边：0。**

## 3. 实测数字（2026-09-29，磁盘遍历全数清点，非抽样；git 对象库损坏故不用 ls-files）

| 文件 | 行数(wc) | 导出键 | 测试例 | 断言调用点 |
|---|---:|---:|---:|---:|
| deployOrchestrator.js | 370 | 2 | 20 | 166 |
| index.js | 563 | 19 | 22 | 210 |
| remoteApprovalBridge.js | 289 | 2 | 15 | 77 |
| remoteExecService.js | 677 | 1 | 19 | 78 |
| remoteExecStreamStore.js | 539 | 3 | 18 | 102 |
| remoteFileTransferService.js | 337 | 2 | 14 | 37 |
| remoteStatePersistence.js | 109 | 2 | 12 | 44 |
| remoteStateSyncService.js | 37 | 1 | 8 | 27 |
| remoteWorkspaceResolver.js | 51 | 1 | 10 | 16 |
| sshConfigService.js | 155 | 4 | 13 | 40 |
| sshConnectionManager.js | 95 | 2 | 10 | 46 |
| sshCredentialGuard.js | 95 | 2 | 9 | 31 |
| **合计 12 源 / 12 测** | **3317** | 40 | **170** | **874** |

扇入 **1 文件 / 1 站点**（D1 shim `services/remote/index.js:4`；shim 自己经 4 个具名消费者
——remoteSsh、largeTasks、cli/handlers/remote、tools/deploy）。出边 D3×5、D2×2、SAME_UNIT×11、
CORE×14、**UNMAPPED×2**。单元外测试 7 份 / 9 站点，全部 jest 方言、本机 0 可跑。
共置测试合计 3432 行。**本批改动面：零源文件修改**——只新增 12 份共置测试 + 本 README +
`khy.module.json`，`git status --porcelain -- <本目录>` 全为 `??`。

## 4. 测试隔离与已知警告（跑本目录测试前必读）

**隔离怎么做到的**：12 份共置测试一律先把 `HOME` / `USERPROFILE` / `KHY_DATA_HOME` /
`KHY_PROJECT_DATA_HOME` / `XDG_CONFIG_HOME` 钉进 `fs.mkdtempSync` 临时目录**再 require**；
`index.test.js` 按用例删 require 缓存重装载（`openIndex`），每个状态用例独享子目录与状态文件。
exec/transfer/index 三份在 require 目标模块**之前**把 `child_process.spawn` 换成抛错 stub
——顺序不可反（B31-R17：spawn 在各自装载时绑定，后 patch 无效）。跑完实测该目录 `??` 之外
零 ` M`。

**`~` 展开的实测结论（修正一个流传的错误前提）**：委派口径曾称
`sshConfigService` 用 `os.homedir()`「无视注入的 HOME」，属沙箱穿透 + 用户可见缺陷。
**探针证伪**：本机上 libuv 的 homedir 在调用时按 `HOME`→`USERPROFILE` 顺序解析，
`~/.ssh/id_deploy` 在双 env 钉死后确实展开进临时根。原红是测试断言打错了目录名
（期望 `<root>\ssh`，真值 `<root>\.ssh`）。残余风险登记为 **B31-R22**：若未来 runner
只钉两个 env 之一或两个都不钉，Windows 上回退真实账户目录——**跑本目录测试必须 HOME 与
USERPROFILE 一起钉**。

**未来运行者绝不可做的事**：(1) 不要把 `node --test` 指向目录——本机得到假读数，
必须显式列 12 个路径；(2) 不要试图复跑 `tests/services/remote*` 与
`tests/routes/largeTasks.errorPathsAndWatch` 那 7 份——jest 未安装，装载失败会被读成
「产品红」，而它们从未被执行；(3) 不要翻 `KHY_REMOTE_SSH_ENABLE_EXEC=true` 来「看全路径」
——exec/transfer 的传输不可注入，下一条语句就是真 `spawn('ssh'/'scp')`；(4) 不要用
`git ls-files` 做本单元任何清点——对象库已损坏（git fsck 失败），名单只认磁盘；
(5) 不要把 B31-R1/R3/R11/R20 当「测试在挑剔」——那四条是审批与安全叙事本身的实测破口，
修它们=改跟踪源文件=人的裁决。

**本批收尾的 6 例红全部是测试侧错误**（断言了源码从未有过的形状或计数，逐条证据与
裁决写进 `khy.module.json` 的 `_tests_note` ①–⑥ 与 `instrument_notes`）：getSession 的克隆
没有 `events`（真回放面是 `getEventsSince`）、两处监听器/通知计数被写漏、create_session 的
payload 被当成了 append_event、`{}` 构造子按现行不抛（旧断言与它自己的 message 自相矛盾，
登记为 B31-R23）、以及上面的 `~` 目录名打错。**未删任何测试、未削弱任何断言、未动任何源码。**
