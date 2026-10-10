# [DESIGN-IP-002] 软著材料生成器与在仓契约

> **一句话原则**：**工具逐字不改，口径写在外面。**
>
> 本篇管一件事：软著申请资料的**生成工具链**在本仓的存在形式、完整性要求，
> 以及它与 `[DESIGN-IP-001]` 判据冲突时谁说了算。
> 登记判据本身（C-M / C-E / C-X / C-MAT 四组）**不在本篇**，真源仍是
> `[DESIGN-IP-001] 软件著作权就绪规范`（规则 `PROCESS-010`）。
>
> **定位边界**：`[DESIGN-IP-001]` 回答「代码怎么保持可登记」，本篇回答
> 「材料用什么工具生成、工具放在哪、工具默认口径与本件登记客体不一致时怎么办」。
> 借鉴方式的判定（vendored 六条前置、许可证分级、谁批准）**不重复**，
> 以 `[DESIGN-SOURCING-001]` §2 B-M1 / §3 B-P2~P3 为准，本篇只给结论与落点。

---

## 一、工具链来源与借鉴方式

| 项 | 值 |
|---|---|
| 上游 | `Fokkyp/SoftwareCopyright-Skill`，SKILL.md 版本 `2.5`（plugin 清单 `2.2.0`） |
| 钉子 | commit `947d5963194bfda8ce57b8b454b486f13359dee4`（2026-09-24） |
| 镜像 | `luckykhy/SoftwareCopyright-Skill` HEAD 与上游同 commit，入库时无本地分叉 |
| 许可证 | MIT（上游根 `LICENSE`，随包留存于 `scripts/copyright/LICENSE`） |
| 借鉴方式 | `vendored`（整包保留、只读不改）—— B-M1 六条前置逐条满足，B-P3 由维护者批准 |
| 官方包 | 无（npm 与 PyPI 均 404，实测），故依 B-M1 #2 不得走正常依赖安装 |
| 入库范围 | 26 个上游文件：`SKILL.md` + `agents/` + `references/` + `scripts/` + `tests/` |
| 未入库 | `生成demo/`（示例产物 433 KB）、`docs/screenshots/`（README 配图 1.3 MB）、`.claude-plugin/plugin.json`（单智能体专属打包清单）、`skills/` 符号链接 |
| 登记处 | `SOURCING-PROVENANCE.json` 的 `ledger` + `observedVendorDirs`；`FEATURE-OWNERSHIP.json` 的 `software-copyright-materials` 域 |

**入库字节取自上游 git blob 原始内容（LF）**，不取自任何浅克隆工作区
—— 上游仓库自身的 `core.autocrlf` 会把工作区渲染成 CRLF，取工作区会写入与上游不同的字节。
本仓 `core.autocrlf=false` 且 `.gitattributes` 未对这些扩展名设 eol，故磁盘字节 = 提交字节 = 上游字节。

## 二、落点为什么是 `scripts/copyright/`（不是 L6 `tools/`）

层级判据上它是「只在开发期被手动调用、不参与运行时」的 L6 形态，**但实测否决了 `tools/`**：

- `.gitignore:184` 忽略 `tools/deepseek-eyes/`，`git ls-files tools` 实测 **0 个跟踪文件**；
- 埋在一个整目录被忽略的位置，约束在**新克隆机器上不存在**，直接违反多机自举
  与 `[DESIGN-DELIV-001]` D3「新克隆零缺件」；
- `scripts/` 是 `[DESIGN-LAY-005]` §1.2 的**工程横切层**（「CI 守卫、公共库、维护」），
  与既有 `scripts/evidence/`（`C-E4` 采集器）同族，且随 git 分发。

因此真源目录形状为：

```plain
scripts/copyright/
├── LICENSE                            # 上游 MIT（B-M1 #4 同路径留存）
├── upstream-manifest.json             # 钉子 + 26 个文件的逐文件 sha256 + aggregate
├── repo-contract.md                   # 本仓口径覆盖层（§三）
└── vendor/software-copyright-materials/   # 26 个上游文件，逐字不改
```

目录名刻意含 `vendor` 路径段：`[DESIGN-IP-001]` `C-X3` 的排除清单
（`check-copyright-readiness.js` 的 `EXCLUDE_DIRS`）按路径段匹配 `vendor`，
于是「第三方代码不得进登记材料」这条**天然命中**，不需要第二份排除规则。

## 三、覆盖层：六处本仓口径 > 上游默认

覆盖层载体是 `scripts/copyright/repo-contract.md`（**本仓自有文件，可自由编辑**）；
vendored 树依 B-M1 #5 不可改，所以任何口径修正**只能写在外层**。
上游的选材脚本确实带前端偏好（`common.py` 的 `FRONTEND_EXTS`、
`propose_code_selection.py` 的 `selection_tier=frontend`），
因此覆盖层不是形式主义 —— 缺它，上游口径就静默生效。

| # | 上游默认 | 本仓口径 | 依据 |
|---|---|---|---|
| 1 | 名称/版本以 `草稿/申请表信息.md` 为准 | 唯一真源 `COPYRIGHT.json`（登记版本与工程版本双口径） | `C-MAT2` |
| 2 | **优先抽取前端代码**（入口/路由/页面/组件） | 60 页选材由 `COPYRIGHT-MATERIALS.json` 派生：前 30 页=启动链、后 30 页=手写内核，按运行时调用顺序成链 | `C-MAT1`/`C-MAT3` |
| 3 | 候选发现按内容检测，扩展名不限 | 同上游，但选材结论必须逐条带 `model_reason` 回指登记条目 | `C-MAT1` |
| 4 | 输出到当前工作目录 `软件著作权申请资料/` | 草稿留该目录（本机态、gitignore）；正式件收进 `evidence/06_申报材料/`，不另起第二份材料树 | `C-E4` |
| 5 | 7 个 `STOP_FOR_USER` 人工门禁 | 一个不放宽；`business`/`code-selection` 两门禁的确认对象就是 §三 的两份登记 | `PROCESS-001` 同源纪律 |
| 6 | OfficeCLI 固定 `1.0.151`、`playwright-cli` 固定版本 | 同上游；缺失/版本不符必须停下问人，不得静默安装或回退 python-docx/Pandoc | 不代人不点头 |

**为什么第 2 条是硬冲突**：本件登记客体是「基于执行轨迹记录与链路校验技术的AI助手平台」，
全称里每个词都得在页内有代码；`apps/ai-frontend` 是平台自带管理 UI，
`software/khyquant/frontend` 属**独立项目 khyquant**（另案申报）。
按上游前端优先会把材料导向与本件无关的载体，正是登记补正里「材料不一致」的成因。

## 四、使用方式（任何智能体生成材料前）

1. 读 `scripts/copyright/vendor/software-copyright-materials/SKILL.md`（工作流与门禁）；
2. **同时**读 `scripts/copyright/repo-contract.md`，冲突以覆盖层为准；
3. `<PYTHON>` 取本仓实测可用的 Python（当前 3.11.9），`<SKILL_DIR>` 取上表的 vendor 目录；
4. 逐阶段执行上游脚本，门禁一律停下等人；
5. 正式产物落 `evidence/06_申报材料/`，并按 `C-MAT1` 复核四动作（名称/版本/截图/选材）。

不使用上游的 plugin 清单安装路径（`.claude-plugin/` 未入库）：
本约束的载体是 **`AGENTS.md` 规则 9**，对读它的任何智能体（Claude Code / Codex / Cursor / Kiro / ZCode）生效，
而不是装进某一个 agent 的插件目录。

## 五、机器判据（并入 `PROCESS-010` 现有 S1 门，不新建规则）

执行器仍是 `scripts/ci/check-copyright-readiness.js`（`npm run check:copyright`，
`STAGE='S1'` 恒 exit 0、只记录不阻断）。本篇新增四条 finding：

| finding | 判什么 | 原发严重度 |
|---|---|---|
| `copyright-vendored-skill-ok` | 26 个上游文件与 manifest 逐字节一致（留痕） | warning |
| `copyright-vendored-skill` | vendored 树被改动/缺失、LICENSE 非 MIT、钉子缺 repo/commit | error |
| `copyright-overlay-missing` | `repo-contract.md` 不存在 | error |
| `copyright-overlay-conflict` | 覆盖层存在但缺关键对冲引用（未回指 `COPYRIGHT.json` / `COPYRIGHT-MATERIALS.json` / `C-X3`） | error |

规则数**不变**（仍 94 条）：依 `PROCESS-014` 棘轮「新增一条先退役一条」，
本篇是 `PROCESS-010` 之下的真源细化，不是新规则 ID。
升阶仍是人的决定（`PROCESS-008` PP-6 一次只升一阶），本篇不代劳。

## 六、vendored 的维护义务

- **改上游文件不是禁止项而是必须重登记项**：确需改动时，PR 描述必须写明
  「为什么必须改」与「下次上游同步的冲突面」（B-M1 修改禁令）；说不清就拆出为本仓文件
  （降为 `reference`），并在覆盖层加一条口径；
- **同步策略**：上游与本仓无分叉时，同步 = 重取上游 blob + 更新 `upstream-manifest.json`
  的 `commit`/`sha256`/`aggregate` + 跑 `check:copyright`；钉子变更不得静默
  （`SOURCING-PROVENANCE.json` integrityChecks 末条）；
- **`vendor/` 内出现的非上游件是正常的**：LAY-5 要求仓内每个 `.md` 配 `.html` 孪生
  （`[DESIGN-LAY-002]` 归类矩阵），`npm run docs:build` 会在 `vendor/**/*.md` 旁就地产出孪生面。
  钉子按 `upstream-manifest.json` 的 `files[]` **逐文件**比对，不是按「目录里每个字节」比对，
  所以这些 `.html` 不算改动上游文件；巡检时也不得把它们当孤儿文件清理（HK-4）；
- **整删可回滚**：`scripts/copyright/` 四件套可一次删除即完全退出，不留悬空引用
  （守卫对缺失目录只报 error finding，S1 下不阻断）。

## 七、B-P2 借鉴提案（六字段，登记于 `FEATURE-OWNERSHIP.json` 与本节前）

1. **借鉴对象**：`Fokkyp/SoftwareCopyright-Skill@947d596`（SKILL.md v2.5，MIT）；
2. **借鉴内容**：整套材料生成工作流 + 7 个人工门禁 + OfficeCLI/页数校验后端行为；
3. **解决的问题**：本仓材料生成工具链此前**在仓库外** `D:/Portable/软著交付/Khy-OS/06_工具/`
   （`[DESIGN-IP-001]` C-MAT2 明文），新克隆机器无件、且两份字段真源
   （仓外 `registration.json` vs 仓内 `COPYRIGHT.json`）需人手工 `sync_name.py` 同步；
4. **许可证与代码性质**：MIT，核实位置 = 上游根 `LICENSE`（已同路径留存）；
5. **借鉴方式**：`vendored`，判定依据 = B-M1 六条前置逐条满足（见 §一）；
6. **落点与现有实现对比**：落点 `scripts/copyright/`；
   既有同类实现搜索结论 —— 仓内只有**登记侧**件（`COPYRIGHT.json`、`COPYRIGHT-MATERIALS.json`、
   `scripts/ci/check-copyright-readiness.js`、`scripts/evidence/collect-contribution.js`），
   **无**材料生成器；`khy skill` 相关命令管的是运行时技能包，不是本工具。
   故本提案是**补齐缺失环节**，不与之并存两份。
7. **验收方式**：`node scripts/ci/check-copyright-readiness.js` 输出含
   `copyright-vendored-skill-ok`（26/26 一致）且无 `copyright-overlay-*` finding；
   改动 `vendor/` 内任一文件后该 finding 翻成 `copyright-vendored-skill`。

---

## 与其他规范的关系

- 上位：`[DESIGN-IP-001]`（判据真源，规则 `PROCESS-010`）、`[DESIGN-GOV-001]` 治理总纲；
- 引用不重复：`[DESIGN-SOURCING-001]`（B-M1/B-P2/B-P3 判定逻辑）、
  `[DESIGN-LAY-005]`（横切层与落点门槛）、`[DESIGN-PROCESS-002]`（S1~S4 阶段）、
  `PROCESS-014`（规则棘轮）、`[DESIGN-DELIV-001]` D3；
- 载体：`scripts/copyright/repo-contract.md`（可编辑覆盖层）+ `AGENTS.md` 规则 9（约束入口）。

*创建：2026-09-29（vendored 入库当日）。人的意愿：用户原话要求「不是装到 ZCode，
而是把这套 skill 变成 Khy OS 仓库的约束，让任何来改代码的智能体都必须遵守」。*
