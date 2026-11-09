<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-194] 原子能力聚合与接口目录

> **需求来源**：用户原话——「khyos 的原子能力不清晰，需要你把原子能力聚合在一起列出接口，这样二级能力，三级能力直接复用即可就没有必要再重复造轮子，让项目变得巨大」。
> **定位**：把 khy-os 的**原子能力（L1）**聚合成**一张可机检的清单**，并规定二级能力、三级能力如何复用它。本文是原子能力目录的**方案真源**。
> **状态**：已落地。机读注册表 `docs/10_规范/registry/ATOMIC-CAPABILITIES.json` + 守卫 `scripts/ci/check-atomic-capabilities.js` 均已生效。
> **不改**：不改任何既有工具的**功能**；不改 `FEATURE-OWNERSHIP.json`（那是 L2/L3 能力域登记表，与本文的 L1 原子能力目录**分工不同**，见 §2.3）；不改 `PROCESS-014` 棘轮（本文不新增规则 ID，只新增注册表与守卫）。
> **例外（v1.2）**：**改了 `amooBridgePolicy` 的参数契约与校验**——收敛 §3.7 的 5 组真跨端冲突时，
> 读原生实现挖出 3 个参数名 bug（`write.text` / `volume.value` / `start_app` 漏参），
> 改的是「PC 侧契约与手机原生对不上」这一层，**不碰原生实现、不碰工具功能**。
> 同时补上「未知参数拒绝」——原实现放行未知参数，导致传错名字的参数到手机侧被静默丢弃
> （`write` 传 `text` → **用空串覆盖目标文件**）。这是修 bug，不是改行为。
> **上游依赖**：`[DESIGN-LAY-005]`（L1/L2/L3 层语义）、`[DESIGN-SOURCING-001]` §3/§4（能力域唯一 canonical）、`[DESIGN-ARCH-059]`（能力即代码）、`[DESIGN-ARCH-193]` §六（手机端原子能力复用矩阵）。
> **证据时效**：全部实跑与读码发生于 2026-10-24（目录与守卫）、2026-10-25（分歧收敛），工作区 HEAD `ed684bfe`，分支 `chore/hygiene-20261010`。

---

## 一、问题：原子能力不是「不清晰」，是**根本不存在**

用户说「原子能力不清晰」。实测的结论比这更硬：**khy-os 里没有一张原子能力清单，而且当前结构下也不可能有**。

实测（§四）：同一种能力——比如「列目录」「执行命令」「搜索网页」——在仓内有 **6 份互不重合的工具清单**：

| # | 暴露面 | 真源 | 暴露名数 |
|---|---|---|---|
| 1 | 后端工具注册表 | `runtime/node/backend/src/tools/index.js` | 192 |
| 2 | PC 侧手机桥目录 | `runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js` | 39 |
| 3 | Android 原生 | `delivery/mobile/.../bridge/Tools.java` | 39 |
| 4 | 手机端 Dart | `delivery/mobile/.../core/tools/builtin_tools.dart` | 32 |
| 5 | amoon bridge 契约 | `delivery/extension/bridges/khy-amoon-bridge/lib/contracts.js` | 12 |
| 6 | amoo 桥策略 | `runtime/node/backend/src/services/domain/network/amoo/amooBridgePolicy.js` | 22 |
| | | **合计** | **337** |

337 个暴露名，**零处说明它们之间的关系**。后果直接命中用户诉求：

- 二级能力（编排类服务）想「读文件」，后端有 `readFile`、还有 `Read`——**该用哪个？参数还不一样**（`path` vs `file_path`）；
- 三级能力（手机端、amoo 协作）想「跑命令」，`exec.shell` 到底走 `bash`、`shellCommand`、`cmd`、还是手机侧的 `exec_shell`？**手机侧还自带一套更弱的危险命令白名单**；
- 「列目录」这一个动作，**六个面各有一份**。

于是每做一个二级能力，开发者都要**重新判断**「已有的是不是能直接用」，判断不了就**再写一份**。**项目变大就是这么来的**——不是某个人偷懒，是**没有可查的清单**这件事本身在制造重复。

本文的解法不是「再写一份文档让人去查」，而是把这件事变成**机器能拦的约束**。

---

## 二、方案

### 2.1 核心决策：清单必须是**生成物**

手维护的清单会漂移，而**漂移的清单比没有清单更危险**——它会让「我查过登记表，没有重复」变成一句假话。所以分工是：

| 部分 | 谁维护 | 为什么 |
|---|---|---|
| **能力语义**（哪几个工具名其实是同一个原子能力） | 人工，写在 `scripts/lib/atomicCapabilityRegistry.js` 的 `ATOMIC_GROUPS` | 这是需要人拍板的判断，机器猜不了 |
| **已登记的重复与分歧** | 人工，同文件的 `DUPLICATE_GROUPS` / `DIVERGENT_GROUPS` | 「允许不一致」是治理决定，不是技术判断 |
| **能力清单本体**（工具名、canonical、参数契约） | 生成，从 6 个暴露面**实时实测** | 工具的进出是高频事件，人工跟不动 |

三件套：

```
scripts/lib/atomicCapabilitySurfaces.js   ← 抽取器：从 6 个面读出真实工具名 + 参数契约
scripts/lib/resolveCanonical.js           ← 解析器：工具名 → 仓内真实定义文件
scripts/lib/atomicCapabilityRegistry.js   ← 语义层：人工维护的能力分组 + 已登记重复/分歧
        ↓
scripts/ci/gen-atomic-capabilities.js     ← 生成器 → ATOMIC-CAPABILITIES.json
        ↓
scripts/ci/check-atomic-capabilities.js   ← 守卫：漂移即红
```

### 2.2 守卫拦什么

| 规则 | 判据 | 级别 |
|---|---|---|
| `atomic-registry-stale` | 注册表与当前代码不一致（有人加了工具却没归组） | **error** |
| `atomic-registry-missing` | 注册表不存在 | **error** |
| `atomic-orphan-exposure` | 某暴露面有工具名**未归入任何原子能力** | **error** |
| `atomic-name-cross-registered` | 一个暴露名同时属于两个原子能力 | **error** |
| `atomic-no-canonical` / `atomic-canonical-missing` | 原子能力没有 canonical，或 canonical 指向死路径 | **error** |
| `atomic-interface-divergent` | 同一能力的参数契约在各面**不一致**（类型不兼容 / 必填性不一致），且未登记 | **error** |
| `atomic-canonical-shared-same-family` | 同族能力共用同一 canonical（疑似拆错） | warning |
| `atomic-known-duplicate` | 已登记的存量重复（附收敛理由） | warning |
| `atomic-interface-divergent`（已登记） | 已登记的接口分歧（`DIVERGENT_GROUPS`），附判据 | warning |
| `atomic-surface-unavailable` | 某暴露面读不到（代码未入仓等） | warning |

`atomic-orphan-exposure` 是**核心闸门**：它把「新增一个工具」这件事，从「随手加个文件」变成「必须先说清它复用哪个原子能力」。**这就是「不重复造轮子」从愿望变成机制的地方。**

`atomic-interface-divergent` 是**第二道闸门**：它管的是「复用时会不会踩坑」——
同一个能力在 A 面必填的参数在 B 面是选填，照抄调用方式就会被拒。
**只比「同一动作」跨面的差异**：同一面内不同工具名（`gitBlame` vs `gitLog`）不算分歧，
同名但语义刻意不同的受限面（amoo bridge 的只读 `phone_exec` vs 任意 shell）已拆成独立能力组。
已登记的 3 组（平台/粒度差异）只警告，新出现的即红。

### 2.3 与 `FEATURE-OWNERSHIP.json` 的分工（不冲突）

两者都登记能力，但**层次不同、粒度不同**：

| | `FEATURE-OWNERSHIP.json` | 本文 `ATOMIC-CAPABILITIES.json` |
|---|---|---|
| 登记什么 | **L2/L3 能力域**（如 ai-gateway、cli-router、shell-command-risk） | **L1 原子能力**（如 fs.read、exec.shell、net.web-search） |
| 数量 | 16 个能力域 | 124 个原子能力 |
| 回答什么 | 「这个能力域**归谁**实现」 | 「这个原子动作**在哪些面**暴露、**真源在哪**」 |
| 守卫 | `check-feature-ownership.js`（SOURCING-004） | `check-atomic-capabilities.js`（本文） |

二者**互补不重叠**：能力域是「能力簇」，原子能力是「簇里的单个动作」。一个能力域可以由多个原子能力组成（`shell-command-risk` 能力域的 canonical `commandRiskClassifier.js`，其原子动作是 `exec.shell` 的风险分级面）。

### 2.4 分层复用规则（用户诉求的正题）

用户要的是「二级能力、三级能力直接复用即可」。规则如下：

> **R-复用-1**：二级、三级能力需要某个原子动作时，**必须**先查 `ATOMIC-CAPABILITIES.json` 找到该动作的 `canonical`，直接调用/复用它。
>
> **R-复用-2**：确需新建原子能力时，**必须**同时登记：新 `id`、唯一 `canonical`（磁盘上真实存在的实现文件）、各暴露面的工具名。**先登记后实现**（与 `[DESIGN-API-002]` §4 同一体例）。
>
> **R-复用-3**：**不得**为已有原子能力另写一套实现。确需差异化时，走**参数差异化**（同一 canonical，不同参数契约），不新建实现文件。
>
> **R-复用-4**：跨端接入（手机侧要一个 PC 已有的动作）走**转调**，不复制实现——转调在注册表里体现为「同一原子能力在多个面各有一个暴露名」。

R-复用-4 是关键：**「一个能力在多个面各有一个名字」是正常且被鼓励的**（那是多个接入点）；**「一个能力在多个面各有一套实现」才是重复**。注册表把两者显式区分开，正是为了让人能一眼分辨「我在加接入点」还是「我在造轮子」。

---

## 三、现状盘点（实测）

### 3.1 能力规模

| 项 | 数 |
|---|---|
| 暴露面 | 6 |
| 暴露名总数 | 337 |
| 归一后原子能力 | **124** |
| 未归组孤儿 | **0** |
| 每个原子能力平均暴露名数 | 2.73（337 ÷ 124） |
| 每个原子能力平均覆盖面数 | 1.65 |
| 跨 3 个及以上面暴露的能力 | 27 |
| 有参数契约的能力 | 118 / 124 |
| 归一后参数条目总数 | 726 |

**337 → 124**：平均每个原子能力有 **2.73 个暴露名**。这个倍数就是重复的量化——同一个动作平均被写了近三遍。

### 3.2 重叠最严重的十组（按暴露名数）

| 原子能力 | 暴露名数 | 分布 | 问题 |
|---|---|---|---|
| `exec.shell` | 12 | 后端 6 + 桥 1 + 原生 1 + Dart 2 + amoo 桥 1 + amoo 策略 1 | **最严重**：后端 `bash`/`shellCommand`/`cmd`/`PowerShell`/`powershell` 五份（+ 聚合面 `PhoneBridge`）；手机 Dart 的 `exec_shell`/`exec_shell_elevated` 自带**另一套更弱的**白名单 |
| `device.ui-gesture` | 11 | 桥 5 + 原生 5 + Dart 1 | 滑动/长按/返回/Home/最近任务五个原生动作在桥面与原生面各一份 |
| `task.manage` | 8 | 后端 8 | Task 系列 7 个 + `TodoWrite` 一套 |
| `net.web-search` | 7 | 后端 6 + Dart 1 | 全仓最拥挤的一组：`WebSearch`/`webSearch`/`NewsSearch`/`news`/`SearchExtended`/`search` |
| `device.ui-tap` | 7 | 桥 2 + 原生 2 + Dart 3 | 原生 `ui_tap`/`ui_click` 两份；Dart `a11y_tap`/`a11y_find_and_click`/`a11y_list_clickable` 三份 |
| `fs.read` | 6 | 后端 2 + 桥 1 + 原生 1 + Dart 1 + amoo 策略 1 | 后端 `Read`/`readFile` 是**两套独立参数契约**（`file_path` vs `path`） |
| `fs.write` | 6 | 后端 2 + 桥 1 + 原生 1 + Dart 1 + amoo 策略 1 | 后端 `Write`/`writeFile` 成对重复 |
| `device.toast` | 6 | 桥 2 + 原生 2 + amoo 策略 2 | 原生 `toast`/`notify` 拆两个，桥侧合成一个 `phone_toast`——**暴露粒度不一致** |
| `net.http` | 5 | 后端 3 + Dart 2 | `httpRequest` 裸请求 / `WebFetch` 转 markdown / `VaultHttpFetch` 走凭据库，参数契约各异 |
| `fs.mkdir` | 4 | 桥 1 + 原生 1 + Dart 1 + amoo 策略 1 | 手机侧「建目录」四份 |
| `fs.glob` / `fs.grep` / `fs.move` / `fs.copy` / `fs.delete` / `sys.optimize` | 各 3 | — | 后端 `Glob`/`glob`、`Grep`/`grep` 成对重复；`optimizeConfig`/`optimize_config` 大小写双份——**最典型的「复制粘贴式新增」** |

### 3.3 一个容易漏掉的事实：`amoo-policy` 是 `phone-bridge` 的真子集

实测（E3）：`amooBridgePolicy.BRIDGE_TOOLS` 的 **22 项全部**包含在 `phoneBridgeCatalog.BRIDGE_TOOLS` 的 **28 项**里，差集只有 6 个（`loop_start`/`loop_stop`/`loop_status`/`amoo_ask`/`amoo_result`/`amoo_memory`）。

也就是说：**PC 侧有两份几乎相同的手机工具契约**。`amooBridgePolicy` 那 22 项各自带 `risk`/`readOnly`/`requiresConfirm`/`args`——与 `phoneBridgeCatalog` 的契约**是两份独立的**。这是「同一个能力域在同层有两个实现」的教科书案例（SOURCING-004 B-L1 P1 级）。

### 3.4 后端内部的成对重复

实测（E2）：后端 192 个工具里，存在**大小写成对**的同语义工具：

| 成对 | 类别 | 风险档 | 参数契约 |
|---|---|---|---|
| `Read` / `readFile` | filesystem | low / low | `file_path` vs `path` —— **不同** |
| `Write` / `writeFile` | filesystem | high / high | `file_path` vs `path` —— **不同** |
| `Glob` / `glob` | filesystem | safe / safe | 不同 |
| `Grep` / `grep` | filesystem | safe / safe | 不同 |
| `WebSearch` / `webSearch` | data | low / low | 不同 |
| `PowerShell` / `powershell` | execution | **high / critical** | 不同 |
| `optimizeConfig` / `optimize_config` | optimization | — | 不同 |

注意 `PowerShell`/`powershell` 的**风险档不一致**（high vs critical）——这已经不只是冗余，是**行为不一致**。

### 3.5 存量重复的处置（本轮裁决：只登记不改动）

按用户裁决「只登记不改动」，9 组已登记的存量重复在注册表里标 `status: duplicate-logged`，守卫**只警告不拦截**：

`fs.read` / `fs.write` / `fs.glob` / `fs.grep` / `exec.shell` / `net.http` / `net.web-search` / `sys.optimize` / `device.ui-tap`

每条都附了收敛理由。收敛时把 `status` 改为 `active` 并更新 `note` 即可——**守卫会立刻开始拦截新的重复**。

### 3.6 接口目录：参数契约与「分歧」

只登记能力名是不够的。二级能力真正要问的是：**「我要复用这个能力，参数怎么传？」**
所以注册表每个原子能力都带一个 `interface` 段：

| 字段 | 含义 |
|---|---|
| `params` | **参数并集**——跨面去重后的规范参数名、类型、必填性、出现在哪些处 |
| `perSurface` | **每个面每个工具名的实际契约**——供逐字段比对，不做归一 |
| `divergent` | 分歧参数名（类型不兼容 / 必填性不一致 / 数值族放宽） |
| `divergenceDetail` | 每处分歧的判据：类型、必填处、可选处 |

**124 个能力里 118 个带参数契约**（6 个是无参能力，如 `device.ping`），归一后共 **726 个参数条目**。

#### 分歧 ≠ 重复：这是两个不同的病

重复是「同一动作写了两套实现」——**看得见**，因为有两个文件。
分歧是「同一个动作，各暴露面对参数的要求不一致」——**看不见**，因为它只体现为
「在 A 面必填的参数，在 B 面是选填」。二级能力照抄 A 面的调用方式，到 B 面可能被拒。

#### 判据：只比「同一动作」跨面的差异

首轮判据报出 17 组分歧。**其中 12 组经实测是判据缺陷，不是缺陷本身**——两类：

1. **同一面内的不同工具名**：`gitBlame` 要 `file`、`gitLog` 不要。那是**两个不同动作**，
   参数本就该不同。强行收敛等于让 `gitLog` 也要求 `file`——把正确改错。
2. **同名但语义刻意不同的受限面**：amoo bridge 的 `phone_exec`（只读诊断白名单，
   契约明写「不是手机 shell」）与 phone-bridge 的 `phone_exec`（任意 shell）。
   它是 `PHONE_RESTRICTED_TOOLS` 之一（`phone-tools.js:58`）——**刻意更窄**。
   把它并进普通能力组，会让「复用」变成「放宽到任意 shell」，那是降级不是复用。

修正判据后收敛到 **5 组真跨端冲突**，逐组改代码修掉（见 §3.7）。

#### 两条判定纪律

1. **缺元数据 ≠ 契约冲突。** 原生 Java 面没有结构化 schema（只有 `a.optString("cmd")` 这类取参痕迹），
   类型恒为 `unknown`。它**不参与**类型/必填性比较——否则每个含手机侧的能力都会误报。
   实测 22 个参数属「仅原生面有、无类型元数据」，单独标注而非当成冲突。
2. **数值族内放宽不算严重分歧。** `number` vs `integer` 是放宽不是冲突，标为
   `numeric-widening` 仅提示；只有**类型不兼容**（如 `string` vs `number`）或
   **必填性不一致**才进 `severeDivergent`。

#### 分歧守卫会拦住新分歧

已对抗验证：把 `exploreTool.js` 的 `query` 从 `required: true` 改成 `false`，
`sys.query` 立刻报 `[ERROR] atomic-interface-divergent`（该能力未登记分歧）；
已登记的组仍为 warning。改回后复归绿。

### 3.7 分歧收敛：5 组真冲突已修掉

判据修正后剩下的 5 组跨端冲突，逐一读**手机原生实现**（`Tools.java`）定方向——
原生是运行时真源，两份 PC 侧契约都向它对齐。**结果挖出 3 个真 bug**。

#### 3.7.1 三个真 bug（参数名与原生不符）

`amoo-policy`（PC 侧 amoo 桥策略）与 phone-bridge（手机桥目录）**描述的是同一套手机工具**，
但前者有 3 处参数名与原生不符。`evaluateBridgeCall` 校验通过后，参数直发手机 `/call`：

| 工具 | amoo-policy 原来声明 | 原生实际接受 | 原生证据 | 后果 |
|---|---|---|---|---|
| `write` | `text` | **`content`** | `Tools.java:949` | **必失败 + 用空串覆盖目标文件** |
| `volume` | `value` | **`level`** | `Tools.java:835` | **音量静默不变**（比报错更坏） |
| `start_app` | 缺 `action`/`extras`/`uri` | 全支持 | `Tools.java:587-600` | 这三个参数被当「未知参数」拒掉 |

`write` 那条最严重：调用方传 `text` → PC 侧放行 → 手机侧只读 `content` → 拿到空串
→ **把目标文件覆盖成空**。而 `volume` 传 `value` → 音量**一点没变**，调用方却以为调成功了。

> 旁证：StepOS 云侧实际发的是 `{"path":...,"content":"hi"}`
> （`stepneoCloud/agentLoop.test.js:146`）——`content` 才是真源参数名。

**修法**：`amoo-policy` 的参数名与必填性改为对齐原生；`write` 补回 `append`；
`start_app` 补齐 `extras`/`action`/`uri`；`volume`/`level`、`brightness`/`value`
按原生 `optInt` 统一为 `integer`。

#### 3.7.2 未知参数必须拒（补上被漏掉的判据）

修了参数名还不够：`evaluateBridgeCall` 原来**只校验已声明的参数，未知参数直接放行**
（`args` 原样返回，`amooBridgePolicy.js:279`）。于是传错名字不会被拦，而是**到了手机侧
被静默丢弃**——这正是上面三个 bug 之所以能造成数据损失而不报错的通道。

phone-bridge 侧策略早有这条判据（`phoneBridgePolicy.js:229-231`「工具 X 不接受参数 Y」），
amoo-policy 侧漏了。现已补齐（`arg_unknown`），两侧一致。

#### 3.7.3 必填性对齐原生的默认值

4 处必填性与原生默认值冲突——原生用 `optString(x, 默认值)`，即**参数可省略**，
而 PC 侧标成必填，于是「用默认值即可」的合法调用被 PC 侧拒掉：

| 工具 | 参数 | 原生默认 | 原生证据 |
|---|---|---|---|
| `ls` | `path` | `/sdcard` | `Tools.java:873` |
| `clipboard` | `op` | `get` | `Tools.java:529` |
| `notify` | `title` | `"khy-os 桥"` | `Tools.java:548` |
| `notify` | `text` | `""` | `Tools.java:548` |

#### 3.7.4 收敛后剩下的 3 组：目标平台差异，不是契约冲突

| 原子能力 | 差异 | 为什么不该统一 |
|---|---|---|
| `fs.write` | `content` 必填 vs 可选 | PC 写本机文件系统，手机写 /sdcard——**不同目标**。手机侧可省略是对的（原生默认空串，写空文件在手机合法） |
| `fs.list` | `path` 必填 vs 可选 | Dart 的 `list_files` 列**应用工作目录**（`FileService.listFiles`），手机 `ls` 列 /sdcard，后端 `ListDir` 列 cwd——三者目标本就不同 |
| `device.clipboard` | `text` 必填 vs 可选 | Dart 侧把剪贴板**拆成** `read_clipboard`/`write_clipboard` 两工具，写工具天然只需 text；其余面是单一 `clipboard` 配 `op` 判别（get 时不需要 text）——**切分粒度**不同 |

这 3 组按「目标平台差异 / 切分粒度差异」登记在 `DIVERGENT_GROUPS`，附具体理由。
强行统一会改变一端的真实语义（如让 `ListDir` 必须传 path、或让 `read_clipboard` 要求 text），
那是**把正确改错**。

#### 3.7.5 收敛结果

| 项 | 收敛前 | 收敛后 |
|---|---|---|
| 真跨端冲突（严重分歧） | 5 组 | **0 组** |
| 判据误报（同面不同工具） | 7 组 | 0 组（判据修正） |
| 登记为平台/粒度差异 | — | 3 组（附理由） |
| amoo-policy 参数名与原生不符 | 3 处 | **0 处** |
| 未知参数放行 | 是 | **否**（`arg_unknown`） |
| 类型不一致（`number` vs `integer`） | 6 处 | **2 处**（存量，非本次引入） |

---

## 四、证据

### 4.1 口径

| 标记 | 含义 |
|---|---|
| `[跑]` | 本次实际运行过的命令，给出输出 |
| `[读]` | 本次实际读过的文件与行 |

### 4.2 E 表

| # | 命令 / 检查 | 输出（摘要） | 结论 |
|---|---|---|---|
| E1 | `node -e "require('./src/tools').getAll()"`（`runtime/node/backend`） | `backend tools: 192`；分类分布 `system:56 / analysis:24 / filesystem:26 / data:18 / execution:16 / git:14 / coordinator:13 / ai:7 / multimodal:6 / mcp:5 / optimization:3 / storage:2 / realtime:1 / training:1` | 后端面 **192** 项 |
| E2 | 同上，逐个取 `Read`/`readFile`/`Write`/`writeFile`/`WebSearch`/`webSearch`/`bash`/`shellCommand`/`powershell`/`PowerShell`/`Glob`/`glob`/`Grep`/`grep` 的 `name`/`category`/`risk`/`description` | `Read`(filesystem,low) vs `readFile`(filesystem,low)；`PowerShell`(high) vs `powershell`(critical)；`WebSearch`(data,low) vs `webSearch`(data,low) | **成对重复，且参数契约不同** |
| E3 | `node -e` 比较 `amooBridgePolicy.BRIDGE_TOOLS` 与 `phoneBridgeCatalog.BRIDGE_TOOLS` | `amoo policy: 22` / `phone catalog bridgeNames: 28`；`phone-only: loop_start loop_stop loop_status amoo_ask amoo_result amoo_memory`；`amoo-only:（空）` | **amoo-policy ⊂ phone-bridge**，真子集 |
| E4 | `node -e` 抽取 `phoneBridgeCatalog` 的 `BRIDGE_TOOLS`/`UI_TOOLS`/`listKhyToolDefinitions()` | 桥 28 + UI 11 = **39**；`listKhyToolDefinitions()` 返回 28（只含桥，不含 UI） | 手机桥面 **39** 项 |
| E5 | `Select-String` 读 `Tools.java` 的 `String[] NAMES` | 39 项字面量：22 基础 + `loop_start/stop/status` + `amoo_ask/result/memory` + `ui_dump`…`shot_b64` | 原生面 **39** 项 |
| E6 | `Select-String` 抽 `builtin_tools.dart` 的 `ToolDef(name: '…')` | **32** 项 | Dart 面 **32** 项 |
| E7 | `node -e "require('./lib/contracts').listToolNames().length"`（bridge 目录） | `contract tools: 12` | amoon 桥面 **12** 项 |
| E8 | `node scripts/ci/gen-atomic-capabilities.js` | `原子能力 124 个 · 暴露名 337 个 · 孤儿 0 个` | 生成器可用 |
| E9 | `node scripts/ci/check-atomic-capabilities.js` | `暴露面 6 个 · 暴露名 337 个 · 原子能力 124 个` / `Summary: 0 error(s), 17 warning(s).` | 守卫全绿 |
| E10 | **对抗验证**：新建 `src/tools/zzzNewTool.js`（`defineTool`，`name: 'zzzNewTool'`）后重跑守卫 | `[ERROR] atomic-orphan-exposure` + `[ERROR] atomic-registry-stale`；`Summary: 2 error(s)` → 退出码 1 | **未归组的新工具被拦住** |
| E11 | 清理探针（`rm --` 走 trusted launcher）后重跑守卫 | `Summary: 0 error(s)` 档；探针文件已不存在 | 清理后复归绿 |
| E12 | `node -e` 校验全部 canonical 路径是否存在 | 首轮 **30 个不存在**（人工猜路径错）→ 改为 `resolveCanonical.js` 实测反查 | 修正后 **0 个失效**（全部能力均解析到磁盘上真实存在的文件） |
| E13 | `node -e` 抽各暴露面的参数契约 | 后端 192 工具 / 188 带参数；桥 39 / 21；原生 39 / 13；Dart 32 / 25；amoo 桥 12 / 9；amoo 策略 22 / 18 | 六面接口均可结构化抽取 |
| E14 | `node -e` 统计能力级接口 | 能力中 **118** 个带参数契约；归一后 **726** 个参数条目；**17** 个能力有参数分歧，其中 **12** 个严重 | 分歧集已定位（收敛前状态） |
| E15 | **对抗验证**：把 `exploreTool.js` 的 `query` 由 `required: true` 改为 `false` 后重跑守卫 | `[ERROR] atomic-interface-divergent`：原子能力 `sys.query` 的接口在不同暴露面存在分歧（必填于 1 处、可选于 1 处）→ 退出码 1；已登记的组仍为 warning | **未登记的新分歧被拦住** |
| E16 | 改回 `required: true` 后重跑守卫 | `git diff --stat` 空（探针已还原）；`Summary: 0 error(s), 26 warning(s).` | 还原后复归绿 |
| E17 | 探针脚本逐工具核对 `amoo-policy` 声明的参数名 vs 原生 `a.optXxx("name")`（含委派方法体） | 首轮 7 处命中；修掉 3 处真 bug 后余 1 处（`mv` 为探针对 `mv\|\|cp` 合并分支的误报） | **3 处参数名与原生不符** |
| E18 | `node -e` 探测 `evaluateBridgeCall` 对参数名的实际反应 | `write{path,content}` → ALLOW；`write{path,text}` → **ALLOW**（错名放行）；`volume{level}` 与 `volume{value}` → **都 ALLOW** | 未知参数被放行，参数到手机侧才被静默丢弃 |
| E19 | `node --test src/services/domain/network/amoo/*.test.js src/services/domain/network/phone/*.test.js` | `# tests 392` / `# pass 392` / `# fail 0` | amoo + phone 两域回归全绿 |
| E20 | `node --test src/services/domain/network/stepneoCloud/*.test.js` | `# tests 102` / `# pass 102` / `# fail 0` | StepOS 云侧回归全绿（其 `phone_write` 用 `content`） |
| E21 | 收敛后重新统计 | 严重分歧 **0 组**；平台/粒度差异 3 组；`number` vs `integer` 由 6 处降至 2 处（存量） | 5 组真冲突全部修掉 |

### 4.3 未跑与未读

| 项 | 状态 | 说明 |
|---|---|---|
| 手机端 Dart 单测 / Android 单测 | **未跑** | 本轮未改任何 Dart/Java 代码，无回归面 |
| `flutter` / `gradlew` 端到端 | **未跑** | 同上 |
| 其余 5 个暴露面的**参数契约**逐项比对 | **部分** | 本轮比了全部六面的参数名/类型/必填性；但**约束值**（`maxLength`/`allowed` 等）已抽入注册表，未逐项人工判读是否应统一 |
| 原生 Java 面的参数**类型与必填性** | **未取** | 原生侧无结构化 schema（只有 `a.optString("cmd")` 取参痕迹），故其参数类型恒为 `unknown`、不参与分歧判定 |
| 6 个暴露面**全部**的接口签名导出 | **部分** | 能力名、参数名、类型、必填性、约束值已归一进注册表；**返回值的结构**未聚合（各面返回形状差异大且无统一声明，逐面抽会产出不可比的噪音） |

---

## 五、产物清单

| 文件 | 作用 | 维护方式 |
|---|---|---|
| `docs/10_规范/registry/ATOMIC-CAPABILITIES.json` | **机读总清单**：124 个原子能力 × 6 个暴露面 × 337 个暴露名 × 726 个参数条目 | **生成物**，勿手改 |
| `scripts/lib/atomicCapabilitySurfaces.js` | 抽取器：从 6 个面读出当前真实工具名**与参数契约** | 手写 |
| `scripts/lib/resolveCanonical.js` | 解析器：工具名 → 仓内真实定义文件 | 手写 |
| `scripts/lib/atomicCapabilityRegistry.js` | 语义层：人工维护的能力分组 `ATOMIC_GROUPS` + 已登记的 `DUPLICATE_GROUPS` / `DIVERGENT_GROUPS` | **人工维护点** |
| `scripts/ci/gen-atomic-capabilities.js` | 生成器（`--check` 校验是否最新） | 手写 |
| `scripts/ci/check-atomic-capabilities.js` | 守卫 | 手写 |

**日常流程**：新增工具 → 在 `ATOMIC_GROUPS` 里归组（或新建原子能力）→ 跑 `node scripts/ci/gen-atomic-capabilities.js` → 跑 `node scripts/ci/check-atomic-capabilities.js`。
参数契约若在某个面之间不一致，要么统一，要么在 `DIVERGENT_GROUPS` 登记并写明理由。

---

## 六、对用户诉求的直接回答

> 「khyos 的原子能力不清晰，需要你把原子能力聚合在一起列出接口，这样二级能力，三级能力直接复用即可就没有必要再重复造轮子，让项目变得巨大」

| 诉求 | 交付 |
|---|---|
| 原子能力聚合在一起 | 124 个原子能力的总清单，**337 个暴露名零遗漏**（孤儿 0） |
| 列出接口 | 每个原子能力带 `interface` 段：**参数并集**（726 条，118/124 个能力有）、**各面各工具的实际契约**（`perSurface`，不归一，供逐字段比对）、**分歧点**（`divergent` + `divergenceDetail`）。`canonical` 指向唯一实现真源，磁盘上可验证存在 |
| 二级、三级能力直接复用 | §2.4 的 R-复用-1~4；注册表是查表入口；`perSurface` 让调用方能看清「我要调的那一面到底要哪些参数」 |
| 不重复造轮子 | **两道闸门**：① `atomic-orphan-exposure`——新增工具未归组即 CI 红（E10 已对抗验证）；② `atomic-interface-divergent`——同一能力参数契约不一致且未登记即红（E15 已对抗验证） |
| 不让项目变大 | 归组后暴露名 337 → 能力 124；**收敛路径已就位**：9 组存量重复 + 3 组平台/粒度差异已登记，改 `status` / 移出 `DIVERGENT_GROUPS` 即开始拦截 |

**还差什么**：两件事，都是「登记而不收敛」——

1. **存量重复的实际收敛**（本轮按裁决只登记）。每组要单独评估参数契约差异与调用方影响，不是一次性动作。
2. **返回值结构未聚合**。参数侧已归一，但各面返回形状差异大且无统一声明，逐面抽会产出不可比的噪音——需要先定一个返回结构约定，才谈得上聚合。

**一处诚实边界**：原生 Java 面**没有结构化 schema**（只有 `a.optString("cmd")` 这类取参痕迹），
故其参数类型恒为 `unknown`、**不参与分歧判定**。这是原生侧的实现现状，不是抽取失败；
要让原生侧也进入接口比对，需要它自己补一份 schema 声明。

---

## 七、关联

- `[DESIGN-LAY-005]` —— L1/L2/L3 层语义（本文 `layer` 字段的口径来源）
- `[DESIGN-SOURCING-001]` §3/§4 —— 能力域唯一 canonical（B-U1）
- `[DESIGN-SOURCING-004]` / `FEATURE-OWNERSHIP.json` —— L2/L3 能力域归属登记（与本文分工见 §2.3）
- `[DESIGN-ARCH-059]` —— 能力即代码（`capability` 元数据块与 `khy capability` 视图）
- `[DESIGN-ARCH-193]` §六 —— 手机端原子能力复用矩阵（本文是其全仓推广版）
- `[DESIGN-API-002]` §4 —— 「先登记后实现」的同体例出处

---

*最后更新：2026-10-25（v1.2：分歧收敛——判据修正为「只比同一动作跨面」，5 组真跨端冲突改代码修掉，含 3 个参数名 bug 与「未知参数放行」漏洞；6 组同名异义的受限工具拆分单列）*
*v1.1（2026-10-25）：补接口目录层——六面参数契约抽取、726 条参数归一、`atomic-interface-divergent` 守卫，已对抗验证*
*v1.0（2026-10-24）：117 个原子能力聚合、6 面 336 暴露名全覆盖、CI 守卫落地并对抗验证*
