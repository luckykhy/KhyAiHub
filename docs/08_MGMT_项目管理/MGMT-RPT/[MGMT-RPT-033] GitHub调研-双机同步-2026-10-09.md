# GitHub 调研 — 双机流水线与状态同步板块 — 2026-10-09

> 每日板块轮转调研（索引 5/12，第二次进入本板块，上轮为 [MGMT-RPT-027] 2026-09-14）。
> 架构已变：HQ（指挥部）2026-09-17 归档，协作收敛为「单仓 + 租约」——本轮调研对象是收敛后的
> 租约机制（`runtime/node/backend/src/cli/hqStore.js` + `hq.js`）与统一状态视图
> （`scripts/sync/sync-status.js`），对标 GitHub 分布式租约/锁与任务同步项目。

## 调研对象

khy-os 双机同步板块现状（HQ 归档后的单仓 + 租约形态，三套机制）：

| 机制 | 位置 | 形态 |
|---|---|---|
| 状态真源 + 租约 | `runtime/node/backend/src/cli/hqStore.js` + `handlers/hq.js` | `works/record/ai/hq/{BUGS,PROGRESS}.json`（git 入仓）为任务/Bug 真源；租约三字段 `claimed_by/claimed_at/lease_expires`（默认 120 分钟）；机器身份 `KHY_MACHINE_ID`/hostname 大小写不敏感（`sameMachine`）；五档瀑布 `pickNext` G0–G4 + WSJF 评分；`khy hq` 命令面（status/next/verify/accept/scope/release/states） |
| 镜像推送 + 补推队列 | `scripts/sync/mirror-sync.js` + `scripts/lib/mirrorSyncQueue.js` | post-commit 推 origin+gitee，失败分类落队列，滑动超时，CI 兜底 |
| 统一只读视图 | `scripts/sync/sync-status.js` | 027 落地：两仓（现单仓 + 可选归档 HQ）ahead/behind/dirty + 镜像队列欠账 + manifest 一致性，`--json` |

**短板（4 条，本轮新观察）**：

1. **G0 提示「续租」但命令面没有续租命令**：`pickNext` 对过期租约的 howto 写着
   「由该机器续租或释放」（`hqStore.js:493/500`），但 `khy hq` 的子命令表里**没有 renew/lease**——
   续租的唯一路径是重跑 `khy hq next --task <ID>` 让 `_claim` 全量重盖三字段。
   声明面引用了不存在的命令，正是规则 10（A2-4/A2-6）「提示词必须与机制事实一致」要拦的形态。
2. **`cmdRelease` 认机不认时：死占用清不掉**：`cmdRelease` 只放行
   `sameMachine(item.claimed_by, me)`（`hq.js:1257`）。实测案例（`PROGRESS.json` 变更记录 2026-09-20）：
   本机 ID 改名（`2541UGH10NVUR7S` → `QiQiaoBan`）后，旧 ID 的**早已过期**租约 `release` 不识别，
   只能手改 JSON。而 `pickNext` 早已判定「租约过期 = 可被他人接管」——释放过期租约是合法操作，
   命令面却没有这个语义。
3. **统一视图不含租约面**：`sync-status.js` 答「git 领先/落后/未提交 + 镜像队列 + manifest」，
   但 027 修好的「三机制一视图」随 HQ 归档后机制换形（第三机制从 hq sync.py 变成了**租约**），
   视图没跟上——答不了「本机持几条租约、几条 30 分钟内到期、几条已死」。
4. **`_claim` 读-改-写无 fencing token**：两机同 base 各自 claim 同一条 → git merge 撞或
   last-writer-wins 双重领取；租约只挡「渲染后」，不挡「写入竞争」。
   修法需要给 JSON 状态文件加 `claim_seq`/版本字段 = **改 schema**（用户红线明令禁止），
   本轮标**待人工决策**，只做 verify 侧的检测增强。

## 对标项目

| 项目 | Star（2026-10-09） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| etcd | ~52.3k | Go | 高：lease Grant/Revoke/**KeepAlive**——持有者周期续租是租约 API 的一等公民，不是 claim 的副作用 | https://github.com/etcd-io/etcd |
| kubernetes | ~128k | Go | 高：coordination.k8s.io `Lease`（holderIdentity/renewTime/leaseDurationSeconds），更新走 resourceVersion 乐观并发 | https://github.com/kubernetes/kubernetes |
| redis (Redlock) | ~76.7k | C | 高：fencing token（单调递增令牌）防「锁已过期旧持有者仍在写」——正是短板 #4 的正解方向 | https://github.com/redis/redis |
| restic | ~36.5k | Go | 高：repo 锁文件含时间戳/主机名/pid，`restic unlock` 默认**只清过期死锁**、`--remove-all` 才清全部 | https://github.com/restic/restic |
| taskwarrior | ~6.1k | C++ | 中：任务状态同步按 UUID + 条目级时间戳合并，last-change-wins | https://github.com/GothenburgBitFactory/taskwarrior |

## 值得借鉴的点

### 1. 续租是一等公民：`khy hq renew <ID> [--minutes N]`（P0）

**对方怎么做**：etcd 的 `LeaseKeepAlive`/`KeepAliveOnce` 让持有者显式续租 TTL，到期不续才被
revoke——续租与领取是两个独立操作；k8s Lease 的 `renewTime` 由 **holderIdentity 本人**更新，
他机更新会被 resourceVersion CAS 拒绝。

**khy-os 现状差在哪**：G0 提示「由该机器续租」（`hqStore.js:493/500`），但命令面没有 renew；
重跑 `khy hq next` 全量重盖三字段，语义混杂且对他人持有的条目会先被 `_claim` 拒绝——
持有者本人反而没有一条「只刷时间不改状态」的路径。

**改哪些文件**：`hqStore.js`（复用 `stampClaim`/`heldByOther`/`parseIso`，不加新字段——
只更新既有三字段）；`handlers/hq.js`（`cmdRenew` + `handleHq` switch 加 `case 'renew'` + help 行）。
约束：持有者本人（`sameMachine`）才可续；未占用/他机存活租约/终态与验收态（review/done/pending_verify/closed）拒绝。

### 2. 死锁清理语义：`khy hq release --expired`（P0）

**对方怎么做**：restic 的 `unlock` 默认**只删过期/失效锁**（进程不在、时间戳过期），
`--remove-all` 才全删——「清死锁」与「释放活锁」是显式分开的两种力度。

**khy-os 现状差在哪**：`cmdRelease` 认机不认时，旧机器 ID 的过期租约（实测案例）清不掉；
`pickNext` 已判定「过期 = 可被他人接管」，但没有任何命令能把这个判定兑现成释放。

**改哪些文件**：`handlers/hq.js` 的 `cmdRelease` 加 `--expired` 标志：在现有「本机占用」语义
**逐字节不变**的基础上，额外释放「任何持有者 + 租约已过期 + 状态仍 doing/in_progress」的条目，
逐条打印被释放者与原持有者；默认（无 --expired）行为不变。

### 3. 统一视图补租约段（P0）

**对方怎么做**：k8s `kubectl get leases` 一条命令列出 holder/renewTime/age；
etcd `lease list` 列存活租约。状态视图必须覆盖**全部**并存机制，漏一个机制视图就失效一半。

**khy-os 现状差在哪**：`sync-status.js` 的聚合缺租约段——答不了「本机持几条租约、
几条临近到期、几条已死」。短板 #4（027）以新形态回归。

**改哪些文件**：`scripts/sync/sync-status.js` 增纯读解析（直接读 `works/record/ai/hq/*.json`，
**不跨层级 require** backend src——scripts 层依赖方向只向下）+ 租约汇总（held-by-me /
expiring ≤30min / expired 计数与明细），人类表格与 `--json` 同步输出。

### 4. fencing token 防双领（P2，待人工决策——改 schema）

**对方怎么做**：Redlock 的 fencing token（单调递增令牌）：持有者写回时带 token，
真源拒收旧 token——「锁过期但旧持有者仍在写」的竞态只有 fencing 能拦。

**khy-os 现状差在哪**：`_claim` 读-改-写无 CAS，两机同 base 双领后 git merge 撞或静默互覆。

**改哪些文件**：BUGS.json/PROGRESS.json 加 `claim_seq` 字段 + `_claim` 校验——**改 schema**，
用户红线明令禁止（「禁止改 DB/schema」），标**待人工决策**，须人拍板后才动。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | `khy hq renew <ID> [--minutes N]`：持有者本人续租，复用 `stampClaim`，不加字段 | P0 | 1–2 小时 |
| 2 | `khy hq release --expired`：清死占用（认时不认机），默认语义不变 | P0 | 1 小时 |
| 3 | `sync-status.js` 增租约段（held-by-me / expiring / expired，纯读） | P0 | 1–2 小时 |
| 4 | fencing token 防双领（`claim_seq`） | P2 | 待人工决策（改 schema） |

## 参考链接

- https://github.com/etcd-io/etcd — LeaseKeepAlive/KeepAliveOnce/LeaseRevoke，续租一等公民
- https://github.com/kubernetes/kubernetes — coordination.k8s.io Lease：holderIdentity/renewTime/resourceVersion
- https://github.com/redis/redis — Redlock fencing token
- https://github.com/restic/restic — 锁文件 + `restic unlock` 死锁清理语义
- https://github.com/GothenburgBitFactory/taskwarrior — UUID + 条目级时间戳合并

## 落地记录

> 本轮落地 3 条 P0；第 4 条（fencing token，P2）标**待人工决策**（改 schema，用户红线明令禁止）。
> 全程遵守工程红线：零硬编码（env 覆盖 `KHY_MACHINE_ID`/`KHY_HQ_DIR`/`KHY_GIT`）、面向用户消息「动作+目标+进度」、无固定硬超时、无滚动区转义、未加 DB/schema 字段（renew 只更新既有三字段）、未新增顶层目录/npm run 入口、未改版本号。

### 已实现条目（3 条 P0）

**P0-1 `khy hq renew <ID> [--minutes N]` 续租命令（etcd LeaseKeepAlive / k8s Lease renewTime 模式）** — 已实现
- `handlers/hq.js` 新增 `cmdRenew`：持有者本人（`sameMachine`）续租，只刷 `claimed_at/lease_expires`，状态与备注不动；`--minutes` 可调（默认 `LEASE_MINUTES`=120，上限 7 天）。
- 四类拒绝（各自留痕与出口码）：未占用（warn/1）、终态与验收态 review/done/pending_verify/closed（warn/1）、他机存活租约（warn/2，同 `_claim` blocked 契约）、**他机已过期租约**（warn/2——不可静默续成自己的，指路 `khy hq release --expired` 或 `khy hq next <ID>` 显式接管）。
- `handleHq` switch 加 `case 'renew'`；help 与 `MANIFEST_EXPORT_KEY` 的 usage/subCommands 同步登记（命令面声明不再引用不存在的命令）。
- `hqStore.js` 的 `pickNext` G0 howto 改指真实命令（`khy hq renew <ID>` 续租 / `khy hq release --expired` 清理）——补上声明面与执行面的脱节。

**P0-2 `khy hq release --expired` 清死占用（restic unlock 死锁清理语义）** — 已实现
- `cmdRelease` 加 `--expired`：在现有「本机占用」语义**不变**的基础上，额外释放「任何持有者 + 租约已过期 + 状态仍 doing/in_progress」的条目，逐条打印被释放者与原持有者；无 `--expired` 时行为逐字节不变。
- 实测案例（旧机器 ID 改名后 `release` 认机不认时清不掉的死占用）由此收敛。

**P0-3 `sync-status.js` 统一视图增租约段（k8s `kubectl get leases` 模式）** — 已实现
- 纯读解析 `works/record/ai/hq/{BUGS,PROGRESS}.json`（**不跨层级 require** backend src，scripts 层依赖只向下）；机器身份内联 `KHY_MACHINE_ID`/hostname 大小写不敏感比较（与 `hqStore.js` 同款约定）。
- 汇总 `heldByMe`（本机持有）/ `expiring`（≤30 分钟内到期）/ `expired`（已过期死占用）计数 + 逐条明细（含持有者、状态、剩余分钟、修复指引）；人类表格与 `--json` 同步输出；真源文件缺失/不可读时静默跳过（fail-soft）。
- 导出 `leaseCollect` 供夹具测试。

### 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `runtime/node/backend/src/cli/handlers/hq.js` | 改 | P0-1 `cmdRenew` + switch/help/usage 登记；P0-2 `cmdRelease --expired` |
| `runtime/node/backend/src/cli/hqStore.js` | 改 | P0-1 G0 howto 指向真实命令（声明面补齐） |
| `scripts/sync/sync-status.js` | 改 | P0-3 租约段（heldByMe/expiring/expired + 明细，`--json`） |
| `docs/08_MGMT_项目管理/MGMT-RPT/[MGMT-RPT-033] …md` | 新增 | 本调研报告 |

### 检查结果

| 检查 | 结果 |
|---|---|
| 夹具驱动功能验证（`KHY_HQ_DIR` 指向 `.khyos/tmp` 夹具，真源零触碰） | **17/17 全过**：renew 4 类拒绝 + 2 条续租路径 + `--minutes` 覆盖；release 默认语义不变 + `--expired` 只清死占用；leaseCollect heldByMe/expiring/expired 计数与明细 |
| `node scripts/sync/sync-status.js`（真实数据） | ✓ 正常输出：main @ 4613564f，领先 0/落后 0/未提交 664，镜像队列 1 条，租约「无」，manifest 未找到 |
| `node scripts/ci/check-agent-rules.js --changed` | **0 error**，7 warning（全部为本次未触碰的存量文件：khyquant 前端 4 + release 脚本 3；本次 3 个改动文件零命中） |
| `node scripts/ci/check-delivery-baseline.js` | exit 0（S1 只记录不阻断）。任务面棘轮 warning：`routerCommands=246/245`（+1 来自本轮 `renew` 子命令）；`handlerFiles=158/155`、`ruleCount=96/94` 为存量漂移，本轮零贡献（未新增 handler 文件、未加规则） |

### 未实现项（待人工决策：1 条）

- **P2 fencing token 防双领（`claim_seq`）**：`_claim` 读-改-写无 CAS，两机同 base 双领后 git merge 撞或静默互覆——修法需给 BUGS.json/PROGRESS.json 加 `claim_seq` 字段 = **改 schema**（用户红线明令禁止），须人拍板后才动。短期缓解：`khy hq verify` 已有占用/租约一致性体检项，双领会在下一轮 verify 以「ID 重复/状态不同步」形态可见。

> 夹具与临时脚本已清理（`.khyos/tmp/hq-fixture*`、`_scan_lease.js`、`_gh_info.js`、`_verify_lease.js`），真源 `works/record/ai/hq/` 全程零触碰。
> 棘轮基线（routerCommands 245）未代改——「加一个先退役一个」与基线下调是人的决定，按 `[DESIGN-DELIV-002]` §5.2 处理。
