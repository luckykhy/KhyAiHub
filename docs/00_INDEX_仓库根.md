<!-- 文档分类: INDEX | 阶段: 常驻 | 上位: [MGMT-STD-001] 第 1.3 条 / [DESIGN-LAY-005] -->
# 00_INDEX — 仓库根楼层索引

> 根目录共 **48 项**（13 目录 + 7 符号链接 + 28 文件；不含资源管理器不显的 `.git/`），按消费方分六族。
> 米勒定律的兑现方式是**先分组**：人记 6 族，不记 48 项；
> 族内「机器按根路径读取」的条目位置即契约，**永不动**（真源 [DESIGN-LAY-008] §3 裁决二、§4 不变量 3）。
> 变更根条目前先读 `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-008] 目录层级重设计执行路线图.md` §13（方案 R）/ §17.3（终态树）。
> 本索引由探针 `.khyos/tmp/root-census.js` + `.khyos/tmp/index-coverage.js` 对账（覆盖全部根条目才算数）。
>
> **最后核对 2026-10-10**（`[RESEARCH-026]` D0 批重写）。上一版停在 2026-09-29（66 → 62 → 61），
> 其①「七层板块」表列的 `platform/` `services/` `apps/` `software/` `extensions/` `tools/`
> **已全部出根**（`git ls-files` 均为 0），⑤「横切层」的 `evidence/` `deploy/` `patches/` `tests/` 同样已出根——
> 索引与物理树脱节 8+ 条目达 11 天。本版按当轮 `ls -A` + 判型实测逐条重画。
>
> **当前 48 项距 531 终态还差多少**：见 [`[RESEARCH-026] 531目录架构设计与缺口重算`](../11_报告/RESEARCH/[RESEARCH-026]%20531目录架构设计与缺口重算-2026-10-10.md)
> §1（体检）/ §3（逐条去向表）/ §4（施工批次）。一句话：**`business/` 整个域未建**，
> 根上还剩 `apps/` `docs/` `scripts/` `entries/` 四个架构目录未归域。

## ① 域目录（531 五域，四席已落位）— 4 项 + 1 待建

| 条目 | 域 | 第二层现状 | 一句话 |
| --- | --- | --- | --- |
| `runtime/` | D1 运行时内核 | `boot/ node/ substrate/`（+误建的 `works/`） | 平台作为操作系统跑起来；7518 跟踪件 |
| `delivery/` | D4 交付与接入 | `channel/ extension/ mobile/ web/` | 面向人的产物与接入面；929 跟踪件 |
| `works/` | D5 工程与档案 | `build/ data/ deploy/ patches/ record/ ship/` | 造它/验它/记它的东西；162 跟踪件 |
| ~~`business/`~~ | D2 业务上下文 | **未建**（`git ls-files business` = 0） | ⚠ **最大缺口**：31 个上下文 / 1184 文件埋在 `runtime/node/backend/src/services/domain/` |
| `runtime/substrate/` | D3 共享底座 | `platform/` | 被大量复用、只被依赖不反向依赖（§15.1 P-D 裁决降为 D1 子层） |

> D3 在 `DOMAIN-DEPS.json` 仍登记为独立第五域（`targets.D3 = runtime/substrate`），
> 只是物理上不再与 D1/D2/D4/D5 并列。故「五域四席」。

## ② 机器契约（工具按根路径读取，**永不动**）— 16 项

- **git 族（4）**：`.gitignore` `.gitattributes` `.editorconfig` `.github/`
- **包管理族（7）**：`package.json` `package-lock.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` `.npmrc` `pyproject.toml` `MANIFEST.in`
- **便携/部署族（5）**：`.portable` `Dockerfile` `docker-compose.yml` `fly.staging.toml` `.dockerignore`
  （`.env.example` 与 `fly.staging.toml` 属 D9 迁出候选，见 `[RESEARCH-026]` §3.5）

## ③ 入口族（零依赖引导壳，裁决二：留根不进 `entries/`）— 6 项

`khy.bat` `khy.sh` `khy-cli.bat` `install-khy.ps1` `portable-setup.bat` `portable-setup.sh`
——各有 20+ 引用点（启动器定位、打包脚本、软著选材），位置即契约。
（D8 批拟迁 `runtime/bin/` 并留 3 行 shim 一个发布周期，见 `[RESEARCH-026]` §4）

## ④ 人读文档（GitHub 约定根文档 / agent 根读取位）— 3 项

`README.md`（含维护者导航）`AGENTS.md`（AI 与人工维护总入口）`CLAUDE.md`（Claude Code 根读取位）
（`CONTRIBUTING.md`、`SECURITY.md` 已在 `.github/`；`CHANGELOG.md` 属 D9 迁出候选）

## ⑤ 横切层（跨板块服务，**尚未归域**）— 4 项

`scripts/`（461 跟踪件，33 项）`docs/`（本索引在此，1990 跟踪件）`entries/`（产物单一根，Lay-4；4 跟踪件）`apps/`（仅剩 `khyos-desktop`，286 跟踪件）
——四者均为 `[RESEARCH-026]` §4 的归域对象：`scripts/ → works/build/`、`docs/ → works/archive/`（待裁）、
`entries/ → delivery/artifact/`、`apps/ → delivery/desktop/`。
`.editorconfig` 若按 §16.2「五域各一份」拆分，本条再 −1。

## ⑥ 本机态与工具位（gitignored、符号链接或工具私有）— 16 项

| 条目 | 型 | 性质 |
| --- | --- | --- |
| `node_modules/` | DIR | 依赖（仅 W7 可下沉，见 `[DESIGN-LAY-008]` §22.1） |
| `.khy/` | DIR | ⚠ 残留：数据家已迁 `works/data/khy`（2026-10-02 W9′，`[RESEARCH-026]` §0.2 实测），根上 11 项是迁移后空壳 |
| `.khyos/` | DIR | ⚠ 残留：同上，`works/data/khyos` 已降级为兼容 junction（2026-10-08 人裁） |
| `.ai/` | DIR | ⚠ 残留：仅 `__scope_probe`（0 跟踪）；种子文档已在 `works/record/ai/` |
| `.claude/` | DIR | Claude Code 本机配置（仅 `settings.local.json`） |
| `.cursor/` `.opencode/` `.zcode/` `.codeartsdoer/` `.workbuddy/` `.workbuddy-ai/` `khy-Trajectory` | LINK | 符号链接 → `works/data/<同名>`；第三方工具只认根路径，**圈留不可移**（§17.2 人裁；`.opencode` 复审 2026-11-15、`.zcode` 2026-12-31、`.codeartsdoer` 待复审） |
| `.clinerules` | FILE | Cline 生态指令文件，§17.2 人裁**圈留** |

> **一条必须写清的机制事实**（`[DESIGN-LAY-008]` §22.3 实测 + `[RESEARCH-026]` §0.3）：
> 符号链接/junction 在资源管理器**仍显示为一个目录条目，不减视觉数**。
> 本仓 W9′ 走的是「建别名」路线（真身已在 `works/data/`，根上留链），
> 所以根视觉数降不到 10 以下 unless 工具位退役或改为「改指向、不建别名」。

---

## 附：六族覆盖对账（49 项逐条归属，未分类 = 0）

| 族 | 项数 | 条目 |
|---|---:|---|
| ① 域目录 | **3** | `runtime/` `delivery/` `works/`（`business/` 待建，建成后 +1 → 4） |
| ② 机器契约 | 16 | `.gitignore` `.gitattributes` `.editorconfig` `.github/` `package.json` `package-lock.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` `.npmrc` `pyproject.toml` `MANIFEST.in` `.portable` `Dockerfile` `docker-compose.yml` `fly.staging.toml` `.dockerignore` |
| ③ 入口族 | 6 | `khy.bat` `khy.sh` `khy-cli.bat` `install-khy.ps1` `portable-setup.bat` `portable-setup.sh` |
| ④ 人读文档 | 3 | `README.md` `AGENTS.md` `CLAUDE.md` |
| ⑤ 横切层 | 5 | `scripts/` `docs/` `entries/` `apps/` `.env.example` |
| ⑥ 本机态/工具位 | 15 | `node_modules/` `.khy/` `.khyos/` `.ai/` `.claude/` `.cursor/` `.opencode/` `.zcode/` `.codeartsdoer/` `.workbuddy/` `.workbuddy-ai/` `khy-Trajectory` `.clinerules` `CHANGELOG.md` `khy-os.lnk` |
| **合计** | **48** | 与 §0 清点一致（13 DIR + 7 LINK + 28 FILE）；`.git/` 资源管理器不显，不计 |

> 注：`.env.example` 与 `CHANGELOG.md` 在族归属上跨②/④与⑤/⑥（既是契约面又是迁出候选），
> 此处各归其主要消费方，**不重复计数**——这正是"48 = 13+7+28"能对上的原因。
