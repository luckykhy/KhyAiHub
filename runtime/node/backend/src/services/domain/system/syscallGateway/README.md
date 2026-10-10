# syscallGateway — 系统调用审批网关

一句话定位：模型与执行器**只能声明意图**，能不能触达宿主系统由本网关裁决；网关**只能增加拒绝，不能放松既有保护**。它是 D2「业务上下文」域里的安全裁决单元，全程只在内存、进程退出即归零。

- 域：`D2`（`services/backend/src/services/domain/system/syscallGateway`）
- 出边实测：仅 1 条跨域边（D3 `utils/isPlainObject`），**零 D1 出边** —— 这是目前建档的 D2 单元里方向最干净的一个
- 规模：10 个源文件 / 2403 行 / 52 个导出符号 / 10 份共置测试 / 168 例（0 skip、全绿）

## 逐成员

| 文件 | 行 | 导出 | 职责 | 本地出边 | 用例 |
|---|---|---|---|---|---|
| `intentSchema.js` | 403 | 5 | 把一次工具调用规约成不可变 Intent（动作/资源/作用域），并探测旁路企图 | 无（只用 node 内建 `path`/`os`） | 26 |
| `resourceClassifier.js` | 108 | 3 | L0/L1/L2 三级分级的单一真源，保守优先 | `./intentSchema` | 15 |
| `redLine.js` | 103 | 5 | 红线判定与人类可读摘要（委托分级层，绝不另立判据） | `./intentSchema`、`./resourceClassifier` | 14 |
| `approvalRouter.js` | 166 | 4 | 三级审批路由（纯决策、零副作用），输出带 `cause` 的裁决 | `./resourceClassifier` | 18 |
| `permissionCache.js` | 140 | 2 | 会话级预审批清单 + L1/L2 免审缓存（**只内存，绝不落盘**） | `./resourceClassifier` | 11 |
| `breachBreaker.js` | 135 | 1 | 会话级越权熔断器：旁路一次即跳闸、L2 硬闯累计跳闸 | 无 | 12 |
| `denialGuidance.js` | 61 | 2 | 只对「环境没给批准通道」这一类拒绝生成可执行指引（纯 display） | `./approvalRouter` | 7 |
| `preExecutionExplainer.js` | 366 | 7 | 执行前深浅说明：按「难易 × 重要度」决定深浅，缺数据主动采集 | `./intentSchema`、`./redLine`、D2 `workspace/workspace/workspaceContext` | 13 |
| `actionContractVerifier.js` | 601 | 9 | 极小核验器 V：`Φ_pre/Φ_post` 作为**数据**的可机检谓词契约 | D3 `utils/isPlainObject` | 34 |
| `index.js` | 320 | 14 | 门面：规约 → 分级 → 路由 → 熔断 → 结果，串成单一裁决权威 | 上述 6 个同单元成员 | 18 |

## 消费者（fan-in）

直连本 D2 路径的**非测试**消费者 4 个：

| 消费者 | 位置 | 取用 |
|---|---|---|
| `src/services/syscallGateway/index.js` | `:4`、`:5` | D1 再导出壳（整包 + `permissionCache`），自身再被 4 处消费 |
| `src/services/tool/toolCallingPermissions.js` | `:647`、`:655` | `buildIntent`、`preExecutionExplainer.explain` |
| `src/services/domain/desktop/desktopControl/safetyGate.js` | `:582` | 目录形 require（ask/strict 模式的审批 backstop），不可用时 `:584` 返回 fail-closed |
| `src/services/domain/messaging/channels/ilinkDispatcher.js` | `:1243` | `DEFAULT_L2_CONFIRM`（跨设备确认串一致性） |

经 D1 壳的 2 跳消费者：`src/cli/sessionClear.js:28`、`src/cli/tui/ink-components/PermissionsPrompt.js:48`（取 `permissionCache.isL2SessionAllowEnabled`）、`src/services/tool/toolCalling.js:2240`、`src/services/tool/toolSandbox.js:1230`。另有**数据形**登记：`src/services/domain/catalog/capabilityMatrix/descriptors.js:228` 以 `{ module: './syscallGateway', export: 'evaluate' }` 声明能力入口，`src/services/tool/toolCalling.js:2238` 经 `isEnabledAt(POST_TOOL_GOVERNANCE,'syscallGateway')` 决定是否过门。

## 裁决契约（逐条给测试标题出处）

1. **分级保守优先，判不准一律红灯。** `classify null 意图 fail-closed 落 L2`、`classify 未知动作 fail-closed 落 L2`、`classify 全部天然红线动作无论作用域一律 L2`。只读短路先于风险标签：`classify critical 风险但只读：只读短路先于 critical → L0`，而 `classify 自报 isDestructive 但动作是 read：只读短路胜出 → L0`。
2. **意图规约永不抛，异常收敛为 UNKNOWN + 保守作用域。** `buildIntent 对空 call fail-closed 为 UNKNOWN/na 且不抛`、`buildIntent 对畸形 params（非对象）不抛，降级`、`buildIntent 返回冻结对象且默认 risk=medium`。动作/资源/作用域从命令文本与工具声明派生：`buildIntent 从命令文本派生删除动作`、`buildIntent 从命令文本派生全局安装动作并锁系统作用域`、`buildIntent sandboxEscape 声明覆盖动作并锁系统作用域`。
3. **审批权只属于用户：参数里不存在能跳过审批的合法开关。** `detectBypassMarkers 键 force:true 命中（任意层级）`、`detectBypassMarkers 键 force:false 不命中（假值放行）`、`detectBypassMarkers 嵌套数据里的 autoApprove 键仍命中`。作用域化门控开时只扫命令承载字段：`detectBypassMarkers 作用域化：命令字段命中 --skip-approval`、`detectBypassMarkers 作用域化：子进程自有 --yes 不当旁路`、`detectBypassMarkers 作用域化：数据载荷字段 content 不扫 flag`；门控关逐字节回退旧的全字符串无差别扫描：`detectBypassMarkers 门控关（legacy）：无差别扫描，裸 -f 命中`。
4. **L2 必须键入确认串，回车/`y`/小写 `yes` 一律不通过（差异化操作）。** `L2 空串确认不通过（防呆③差异化）`、`L2 小写 yes 不通过（区分大小写）`、`L2 键入带首尾空白的 YES 去空白后放行`、`L2 自定义确认串精确匹配放行`。
5. **非交互环境一律 fail-closed 拒绝，但拒绝的性质要可区分。** `L1 无交互器 fail-closed 拒绝，cause=no-interactive-channel`、`L2 无交互器 fail-closed 拒绝`、`L1 交互器抛错 → cause=interaction-error fail-closed`、`L1 用户主动拒绝 → cause=user-declined`。红线不被权限模式软化：`L2 autoApproveL1 不影响红线，仍拒绝`。
6. **熔断：旁路零容忍，硬闯累计。** `reportBypass 非空标记一次即跳闸（零容忍）`、`reportBypass 空数组/null 不跳闸`、`reportDeniedL2 累计达默认阈值 3 才跳闸`、`非法 l2RetryThreshold 回退默认 3`。环境性拒绝不计入硬闯，避免三个互不相关的合法高危操作各撞一次就把会话砖掉：`智能熔断门控开：环境性拒绝 3 次不跳闸；门控关则跳闸`，而真·硬闯仍计数：`真·硬闯计数：L2 确认串不匹配累计 3 次跳闸`。
7. **跳闸优先于一切，且不可在会话内自愈。** `熔断优先于一切：跳闸后连 L0 只读也拒`、`跳闸时以注入 killer 清场登记在册子进程`、`killer 抛错被吞掉，跳闸照常完成`、`reset 归零熔断状态与被拒计数`。清场只杀登记在册的 pid（`registerChild 忽略非法 pid，unregisterChild 移除合法 pid`），绝不误杀宿主。
8. **缓存只活内存：预审批清单绝不接纳 L2，L1 与 L2 免审物理隔离。** `submitManifest 用真实分级器接纳 L1、静默拒收 L2`、`submitManifest 无分类器时按 item.level 判定，仍拒收 L2`、`grantSessionExempt 仅 L1 可免审，L0/L2 no-op`、`L1 与 L2 grants 物理隔离，互不溢出`。历史不变量「L2 永不免审」现由门控可逆地放开（见下条），关闭时逐字节恢复：`L2 会话免审门控关：grant no-op + has 恒 false（红线铁律）`。
9. **可免审集合是硬不变量：只有 L0/L1。** `isExemptible 仅 L0/L1 可免审，L2 与非法值不可（L2 硬不变量）` —— 分级层的这一票不因缓存层放开 L2 会话免审而改变。
10. **执行前说明深浅三档、且永远拿得到一个可渲染对象。** `explain 只读 L0 → brief 单行、不附工作区`、`explain 系统级删除 L2 → detailed，附后果与撤销`、`explain git 强推命中 hazard：what/risks/undo 用专项文案`、`explain describe 抛错 fail-soft 降级 L2 detailed`。工作区数据缺失时主动获取而非编造：`explain 缺 workspace 时主动采集（注入桩，非 git）`、`explain 采集抛错 fail-soft → workspace=null`。
11. **拒绝指引只对一类 cause 产出，其余不改措辞。** `no-interactive-channel 拒绝产出含工具名的指引`、`其余 cause 一律 null（语义已自明，不改措辞）`、`门控关 → null（逐字节回退不附指引）`、`坏输入（tool 取值即抛）fail-soft 返回 null`。它不接触权限门，纯 display。
12. **核验器 V 的公理集是封闭冻结集合，未知算子只能 fail-closed。** `AXIOMS 公理集非空、冻结，describeAxioms 返回副本`、`P1 未知算子 fail-closed 返回 false`、`P1/P3 verify 遇未知算子收敛为 error 阶段（不 fail-open）`、`门控关时 evaluatePredicate fail-closed 恒 false`。八条投毒路径逐条钉死：`P2 _get 拒绝原型链：__proto__/继承属性判缺失`、`P6 量词绑定名为 __proto__ → fail-closed`、`P7 量词路径缺失（非数组）→ fail-closed`，资源上限 `P5 参数数上限：64 ok / 65 fail`、`P5 量词元素上限：256 ok / 257 fail`、`P5 路径深度上限：超 32 段判缺失`、`P5 节点预算：超深嵌套 and fail-closed`。本单元唯一允许读 env 的位置是门控函数，其余全为纯计算：`verify 对非纯对象契约 fail-closed 到 error 阶段`。
13. **门面自身的失效面。** `evaluate 空 call 不抛、fail-closed 拒绝`；网关异常时 `catch` 收敛为 DENY + `'L2'`（index.js:139-148）；会话级隔离：`resetSession 幂等、inspect 缺失会话返回 null`、`resetAllSessions 返回清除数且绝不抛`。`makeControlPrompter 非函数入参返回 null` —— 拿不到真交互器时不伪造一个。

## 门控（6 个，两套关档词表）

| 门控 | 位置 | 判法 | 语义 |
|---|---|---|---|
| `KHY_SYSCALL_GATEWAY` | `index.js:39` | `!== 'off'` | 默认开；**只有字面 `off` 才关** |
| `KHY_GATEWAY_BREAKER_SMART` | `index.js:116` | `!== 'off'` | 同上；关 → 所有 L2 被拒都计入硬闯 |
| `KHY_ACTION_CONTRACT` | `actionContractVerifier.js:62-68` | `_FALSY` 集 | `0`/`false`/`off`/`no` 关 |
| `KHY_GATEWAY_BYPASS_SCOPED` | `intentSchema.js:97-110` | `_FALSY` 集 | 关 → 回退 legacy 无差别扫描 |
| `KHY_L2_SESSION_ALLOW` | `permissionCache.js:29-38` | `_FALSY` 集 | 关 → 恢复「L2 永不会话免审」铁律 |
| `KHY_GATEWAY_DENIAL_GUIDANCE` | `denialGuidance.js:19-28` | `_FALSY` 集 | 关 → 不附指引 |

同单元内还有两处常被误当门控的 env：`intentSchema.js:275` 的 `KHYQUANT_CWD` 是工作目录来源（作用域派生输入，不是开关）；`KHY_GATEWAY_DYNAMIC_RISK` 在 **D1** 的 `src/services/tool/toolCalling.js:2266`，不在本单元。

## 本单元登记的缺陷（只钉实测行为，不顺手改语义）

- **B28-S1（安全相关，fail-open）** `intentSchema.js:373-377`：整段递归 `visit` 被包在**一个** `try/catch` 里，而 `Object.entries(obj)` 会在进入循环前**急切求值所有 getter**——任何一个取值即抛的属性会中止整场扫描并被静默吞掉。实测 `{force:true, boom→throw}` 返回 `[]`（键序反转同样 `[]`），真实旁路标记完全丢失，`validateIntent` 随即报 `{ok:true,bypass:[],errors:[]}`，而 `breachBreaker` 把旁路探测当作零容忍跳闸的依据。与本文件头「任何解析异常都降级成『未知高危』而非放行」相悖。已钉：`B28-S1 实测钉住：取值即抛的键会中止整场旁路扫描并吞掉真实 force 标记（fail-open）`。**不修**：收紧它会让历史上被漏放的旁路开始跳闸，属行为变更，交任务 #17 裁决。
- **B28-S2（fail-closed 不彻底）** `redLine.js:79`：`const action = intent && intent.action;` 落在 `try/catch`（止于 `:73`）**之外**，取值即抛的 `action` getter 会让 `describe` 抛出。`isRedLine` 与 `describe(null)` 都 fail-closed（`isRedLine 对判定异常输入 fail-closed 返回 true`、`describe 对 null fail-closed 返回 L2 红线`），唯独这条分支漏网。已钉：`describe 对取值即抛的 intent 实际会抛出（钉住真实行为，与文件头 fail-closed 相悖）`。上游 `preExecutionExplainer` 已用 `explain describe 抛错 fail-soft 降级 L2 detailed` 兜住，所以本条的实际影响是「调用方必须自带 try」而非整链崩。
- **B28-S3（同单元两套关档词表）** 见上表：4 个门控用 `_FALSY = new Set(['0','false','off','no'])` 且**逐字重复声明 4 次**（`actionContractVerifier.js:62`、`denialGuidance.js:19`、`intentSchema.js:97`、`permissionCache.js:29`），另 2 个用 `!== 'off'`。实测差异：`KHY_SYSCALL_GATEWAY=0` 时网关**仍开**，`KHY_ACTION_CONTRACT=0` 时核验器**已关**。这与第 27 批（reverseEngineer）登记的 `_OFF` / `utils/isOffValue` 词表漂移是同一族问题，收敛到哪一份是语义决定，一并交任务 #17。
- **B28-S4（文档与代码分工不符）** `index.js:9` 声称「网关判 allow → 盖一枚不可伪造的 `EXEC_APPROVED` Symbol 戳」，但本单元**不盖戳**：allow 路径就是 `index.js:138` 的 `return _result(allow, ...)`。`EXEC_APPROVED` 定义在 D1 的 `src/services/execApproval.js:494`，由既有权限管线读取/施加（消费例：`src/tools/DesktopControlTool/index.js:398`、`src/tools/ComputerUseTool/index.js:47`）。语义上「交还既有管线放行」是对的，主语写错了。只订正文档理解口径，不改码。

## 已知边界（设计取舍，不是缺陷）

1. 作用域化门控**开**（默认）时 `--yes` 不被当旁路 —— 这是刻意的收窄：子进程自有 flag 不等于跳过 khy 审批。实测 `detectBypassMarkers 作用域化：子进程自有 --yes 不当旁路`，且同一输入在门控关时命中（legacy 词表含 `--yes`）。两侧行为都有测试钉住。
2. 「L2 永远不可被会话免审」这条历史不变量已被**用户知情决定**放开为可逆门控（`permissionCache.js:14-24` 记录来龙去脉），但预审批清单仍绝不接纳 L2（批量预授权语义比逐次确认更危险）。放开只影响**逐次询问后的本会话同类免审**，且只活内存。
3. `intentSchema.js` 文件头写「仅 node:path」，实际 `:276` 还 `require('os')`（取 homedir 判作用域）。零本地出边这一条仍然成立。
4. 网关的裁决只覆盖**动作意图**这一维度；`src/services/tool/toolCalling.js:2238` 是否过门由 capabilityMatrix 的 seam 开关决定，关闭 seam 即绕过网关（既有保护仍在）。这不属于本单元，但要知道网关不是唯一门。
5. `preExecutionExplainer` 的说明深浅依赖 D2 `workspaceContext.collectWorkspaceContext`，跨了单元但同域（D2→D2），因此方向合法；它对该调用做了 fail-soft，工作区采集抛错只降级为 `workspace=null`。

## 测试怎么跑

```bash
cd services/backend/src/services/domain/system/syscallGateway
node --test *.test.js                 # 168 例 / 0 skip / 全绿
node --test redLine.test.js           # 单文件
```

10 份测试全部 `node:test` 方言、与源同名同目录共置；逐文件 34/18/12/7/18/26/11/13/14/15。零真实交互、零落盘：交互器一律注入假对象，`process.env` 的读写用「保存-设置-finally 恢复」包裹，熔断清场用注入 killer。`actionContractVerifier` 的门控经参数注入（`isEnabled(env)`），不碰 `process.env`。
