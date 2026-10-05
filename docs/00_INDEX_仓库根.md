<!-- 文档分类: INDEX | 阶段: 常驻 | 上位: [MGMT-STD-001] 第 1.3 条 / [DESIGN-LAY-005] -->
# 00_INDEX — 仓库根楼层索引

> 根目录共 **62 项**，按消费方分六族。米勒定律的兑现方式是**先分组**：人记 6 族，不记 61 项；
> 族内「机器按根路径读取」的条目位置即契约，**永不动**（真源 [DESIGN-LAY-008] §3 裁决二、§4 不变量 3）。
> 变更根条目前先读 `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-008] 目录层级重设计执行路线图.md` §13（方案 R）。
> 本索引由探针 `.khyos/tmp/root-census.js` + `.khyos/tmp/index-coverage.js` 对账（覆盖全部根条目才算数），
> 最后核对 2026-09-29（R2/R4 后：66 → 62 → 61（duplication-baseline 迁 scripts/ci/），pip/executables 两族生成物全部出根——`.workbuddy*` 与 `khy-Trajectory` 隔离后**自愈复生**，系运行中工具的自动生成物，按「自愈型本机态」登记，见 ⑥）。

## ① 七层板块（L0–L6，真源 [DESIGN-LAY-005]）— 7 项

| 条目 | 层 | 一句话 |
| --- | --- | --- |
| `runtime/boot/kernel/` | L0 | 引导内核（QEMU、ELF+PE 双加载器） |
| `platform/` | L1 | Python 启动器 + `@khy/shared`/`@khy/ui-shared` |
| `services/` | L2 | Node.js 后端全部业务（`services/backend`） |
| `apps/` | L3 | 前端应用（ai-frontend、桌面端） |
| `software/` | L4 | 独立项目随平台分发的载体（khyquant） |
| `extensions/` | L5 | 扩展 |
| `tools/` | L6 | ⚠ 内容是**独立嵌套 git 仓库**（`deepseek-eyes`，自 2026-08-27 起刻意 gitignore），仓内零运行时消费方；搬出 = 其所有者的决定（审计见 [DESIGN-LAY-008] §12.55） |

## ② 机器契约（工具按根路径读取，**永不动**）— 27 项

- **git 族（7）**：`.git/` `.gitignore` `.gitattributes` `.mailmap` `.git-blame-ignore-revs` `works/build/githooks/`（`core.hooksPath` 指此）`.github/`
- **包管理族（8）**：`package.json` `package-lock.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` `.npmrc` `pyproject.toml` `MANIFEST.in` `.portable`
- **部署/构建族（5）**：`Dockerfile` `docker-compose.yml` `fly.staging.toml` `.dockerignore` `.env.example`
- **工具链杂项（3）**：`.editorconfig` `.clinerules` `.duplication-baseline.json` `.ai/`（khy metadata 种子文档，`khy metadata refresh` 维护）
- **AI 工具配置（3，tracked）**：`.cursor/` `.opencode/` `.zcode/`

## ③ 入口族（零依赖引导壳，裁决二：留根不进 `entries/`）— 6 项

`khy.bat` `khy.sh` `khy-cli.bat` `install-khy.ps1` `portable-setup.bat` `portable-setup.sh`
——各有 20+ 引用点（L1 启动器定位、打包脚本、软著选材），位置即契约。

## ④ 人读文档（GitHub 约定根文档）— 6 项

`README.md`（含维护者导航）`CHANGELOG.md` `SECURITY.md`（`CONTRIBUTING.md` 已移入 `.github/`，见下） `AGENTS.md`（AI 与人工维护总入口，截断点前含强制工程规则）`CLAUDE.md`

## ⑤ 横切层（跨板块服务，真源 [DESIGN-LAY-005] 第二节）— 9 项

`scripts/` `packaging/` `docs/`（本索引在此）`evidence/` `entries/`（产物单一根，Lay-4；pip 族已迁入 `entries/pip`）`deploy/` `patches/` `tests/`
——方案 R-R4 的收纳候选，硬引用面实测见 [DESIGN-LAY-008] §12.54（scripts 584 / tests 403 / packaging 64…），逐族 sub-batch；`scripts/` `tests/` 依 §13 裁定**留根**。

## ⑥ 本机态（gitignored 或工具私有，不在版本库契约内）— 7 项

| 条目 | 性质 |
| --- | --- |
| `.khy/` `.khyos/` | 运行时数据 / 维护工作台（LAY-007 五档寻址） |
| `node_modules/` | 依赖 |
| `.commandcode/` | 工具私有（ignored 变体） |
| `.codeartsdoer/` | 工具私有（目录内 `.gitignore` 全忽略）；2026-10-04 补登，与 `.opencode/`/`.zcode/` 同列待复审 |
| `.workbuddy/` `.workbuddy-ai/` | 自愈型外部工具态（隔离后复生，2026-09-29 起登记不清理） |
| `khy-Trajectory` | 自愈型符号链接 → `.khy`（khy 运行时自建，已在 `check-commit-timing.js` / `pip_packaging_rules.py` 的 LOCAL_STATE 清单登记） |
| `.claude/` | Claude Code worktrees（本机在用） |
