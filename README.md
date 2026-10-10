<h1 align="center">Khy-OS</h1>

<p align="center">
  <b>你的 AI 主机 —— 一个终端，吃遍你所有的 AI 订阅。</b><br>
  自动省钱、自动容错；微信和手机上，随时使唤它。<br>
  安装后运行 <code>khy about</code> 可随时查看完整定位。
</p>

<p align="center">
  <a href="https://pypi.org/project/khy-os/"><img alt="PyPI" src="https://img.shields.io/pypi/v/khy-os?logo=pypi&logoColor=white&label=pip%20khy-os"></a>
  <a href="https://www.npmjs.com/package/@khy-os/khy-os"><img alt="npm" src="https://img.shields.io/npm/v/@khy-os/khy-os?logo=npm&label=npm%20%40khy-os%2Fkhy-os"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="License" src="https://img.shields.io/badge/license-Source--Available-lightgrey">
</p>

---

## 为什么是 Khy-OS

如果你手里有 2~5 家 AI 订阅（Claude / Codex / Cursor / Kiro / Trae / 国内模型…），
每月为一堆工具花几百块，却只能在各自的入口里分别使用——Khy-OS 把它们收进**一个终端**：

- **订阅套利**：一个 CLI 接入多家订阅，熔断与故障转移自动兜底，用量按人民币计价；
- **随身性**：微信、手机上随时使唤你的 agent，活干完回来汇报；
- **本土化**：中文与拼音命令、中文错误消息、国内模型与镜像优先；
- **私有与便携**：数据全在本地，便携版随身带，源码可见。

## 快速开始

```powershell
python -m pip install -U khy-os -i https://pypi.tuna.tsinghua.edu.cn/simple   # 国内镜像，更快；直连 PyPI 亦可
khy preflight                     # 环境体检；每个卡点都给一条修复命令
khy                               # 进入智能体终端，直接对话
```

装完运行 `khy`，你会直接进入流式对话终端（TUI），用自然语言下指令即可；
`khy about` 随时查看完整产品定位。**首跑 10 分钟承诺**——卡住就提 Issue。

> 首跑会自动补装内置后端的 Node 依赖（`khy` 首次启动时进行，preflight 会明确提示进度与修复命令）。
> npm 渠道：`npm install -g @khy-os/khy-os`，与 pip 渠道内容一致。

Khy-OS **不是**传统发行版意义上的操作系统：`kernel/` 下的手写 C 内核是实验与教学资产
（定位裁决见 [INIT-PRD-003]），不在安装/运行链路上。

## 使用示例

```powershell
khy                        # 启动智能体终端
khy preflight              # 首次运行前诊断 PATH / Node / 依赖
khy about                  # 产品定位一览：为谁做、凭什么、OS 何来
khy ai "总结这个仓库"       # 一次性 AI 调用，不进 REPL
khy gateway status         # 查看各 AI 后端的可用状态
khy doctor                 # 系统健康检查
```

## 安装

### 包管理器安装（二选一，两渠道内容一致）

```powershell
# pip 渠道
python -m pip install -U khy-os

# npm 渠道
npm install -g @khy-os/khy-os
```

### Docker Compose 一键部署

```bash
cp .env.example .env            # 可选：改端口、填 AI Key
docker compose up -d --build    # 一键启动（默认只启动 backend 一个服务）
docker compose ps               # 等 backend 变成 healthy
curl -fsS http://127.0.0.1:13000/health   # 宿主端口可用 KHY_HTTP_PORT 覆盖（真源 .env.example）
```

前端与 AI 后端属按需扩展，用 profile 显式启用（`--profile web` / `--profile ai`），
端口全部变量见 [`.env.example`](.env.example)；生产部署**务必**覆盖 `JWT_SECRET`。
服务契约、健康检查、镜像构建纪律、故障排查见
[`[DESIGN-DEPLOY-001] 部署规范`](docs/10_规范/其它规范/[DESIGN-DEPLOY-001]%20部署规范.md) §3.3；
依赖来源纪律见 [`[DESIGN-DEP-001] 依赖管理规范`](docs/10_规范/其它规范/[DESIGN-DEP-001]%20依赖管理规范.md) §10。

## 配置与数据

### 配置文件位置

| 文件 | 位置 |
|------|------|
| 用户配置 | `~/.khyquant/config.json` |
| Token 用量 | `~/.khyquant/token_usage.json` |
| 对话记录 | `~/.khyquant/conversations/` |
| 训练数据 | `~/.khyquant/training_data/` |
| 模型 | `~/.khyquant/models/` |
| 命令历史 | `~/.khyquant_history` |

> 归属说明：`~/.khyquant/` 是 khy CLI 与后端的**全局数据目录**（命名属历史沿袭，与量化应用无关），
> 由 `services/backend/src/services/configSyncService.js` 等数十处 `os.homedir()/.khyquant` 共同消费。
> API key 存于 `~/.khyquant/config.json`（已 gitignore），Token 用量数据仅存于本地。

### 本地开发服务与端口

后端与前端各占一个终端窗口；端口全部可用环境变量覆盖，**真源是
`services/backend/src/constants/serviceDefaults.js`**：

| 服务 | 端口环境变量 |
|------|------|
| AI 管理前端（Vue 3 管理 UI） | `AI_FRONTEND_PORT` |
| 后端 API / WebSocket | `PORT`（被占用时自动探测下一个端口） |
| AI 管理后端 daemon | `AI_MGMT_PORT` |

只想用 CLI 而不开 Web 界面时，不需要起前端——直接 `.\khy.bat`（或在
`services\backend` 下 `npm run cli`）即可。

### 管理页登录

后端启动时**自动初始化**默认管理员（幂等，绝不覆盖现有密码）：密码由机器指纹 + 随机熵生成，
保存于数据目录 `.khy/credentials/default-admin.json`。生产环境**务必修改默认密码**（或设置
`KHY_ADMIN_PASSWORD`）。入口、免登录桥接、重置与故障排查见
[`[OPS-MAN-003] ai-管理-访问与登录`](docs/07_OPS_运维/OPS-MAN/[OPS-MAN-003]%20ai-管理-访问与登录.md)。

## 面向开发者

### 源码运行

要求 Python ≥ 3.8、Node.js ≥ 20.18.1（阈值真源分别是根 `pyproject.toml` 与
`services/backend/package.json` 的 `engines`）。这是一份 monorepo（npm workspaces + pnpm workspace）：

```powershell
npm run install:core        # 只装运行时最小闭包（backend + ai-backend + @khy/shared）
npm run install:all         # 全量安装（corepack pnpm install --frozen-lockfile）

.\khy.bat                   # 仓库根目录进入 CLI（Windows；Linux/macOS 用 ./khy.sh）
```

各 workspace 可单独起服务：`services\backend` 下 `npm start` / `npm run dev` / `npm run cli`；
`apps\ai-frontend` 下 `npm run dev` / `npm run build`。便携化开发启动器见
[PORTABLE.md](docs/06_DEPLOY_部署/DEPLOY/[DEPLOY-0101] PORTABLE.md)。

> 根 `package.json` 只登记 curated 任务入口（`check:` / `docs:` / `rules:` / `gate:` /
> `portable:` 等，见 [DESIGN-LAY-005] 第四节），**没有** `dev` / `build` 顶层脚本——
> 构建与开发命令一律落到具体 workspace。
>
> 仓库**不跟踪可再生的构建产物**：muya WYSIWYG 引擎、离线文档站的 mermaid.min.js 均由
> 同级源码按需重建（`ensure-vendor.mjs` / `npm run docs:mermaid`），开发路径 fail-soft；
> 构建产物落点与登记规则见下方「仓库结构」一节的守卫指针。

### 架构概览

**Khy-OS** 是通过 PyPI（`pip install khy-os`）和 npm（`@khy-os/khy-os`）双渠道分发的
AI 平台操作系统。模型调用被当作系统调用统一收口：**壳**（CLI/TUI）→ **漏斗**（工具唯一出口）
→ **网关**（多供应商路由，支持级联故障转移与熔断，无供应商锁定）。内核、应用与拓展都是挂在
这套运行时上的**可增删单元**——这是名字里「OS」的由来（`khy about` 有完整解释）。

```text
User → khy 命令 → Python cli.py → Node.js services/backend/bin/khy.js
                                          │
                         ┌────────────────┼────────────────┐
                         ▼                ▼                ▼
                   CLI Layer        Service Layer      Web API
                  (src/cli/)      (src/services/)    (src/routes/)
```

### 仓库结构（分层，非目录树）

| 层 | 目录 | 一句话定位 |
|----|------|------------|
| L0 | `kernel/` | 手写 C 语言 OS 内核（实验/教学资产，需自行 `make` 出 ISO 后 QEMU 引导） |
| L1 | `platform/` | Python 启动器、`@khy/shared` / `@khy/ui-shared` / plugin-sdk 包、多渠道交付编排 |
| L2 | `services/` | `backend`（CLI、AI 网关、各类服务、Web API）+ `ai-backend`（独立版本轨道） |
| L3 | `apps/` | `ai-frontend`（Vue 3 管理 UI）、Electron 桌面端、provider-hub、Flutter Android App |
| L4 | `software/` | 随平台分发的独立项目接入载体：khyquant 量化终端（**独立项目**，连接 Khy OS 使用，非其内置组成）、akshare_scripts |
| L5 | `extensions/` | 内置拓展：一个目录一个拓展，删目录即卸载（tools / bridges / scripts） |
| L6 | `tools/` | 独立开发者工具，不参与运行时 |

顶层七个业务目录的**层级定位、允许的依赖方向、以及新文件该放哪一层**，真源是
[`[DESIGN-LAY-005] 仓库层级板块规范`](docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005]%20仓库层级板块规范.md)，
由 `npm run check:layout` 强制执行，新增文件或新增顶层目录前先读它。
横切目录：`scripts/`（CI 守卫与质量门）、`packaging/`（发布清单）、`docs/`（全套中文文档）、
`entries/`（构建产物单一根，登记于 `docs/10_规范/registry/BUILD-OUTPUTS.json`，
`.gitignore`/`.dockerignore` 由该登记表派生，守卫 `npm run check:build-root`）。

### 版本同步

版本号由 `scripts/ci/check-version-sync.js` 强制校验：**三条独立版本轨道、共 9 个真源**
（组内必须一致，组间刻意不同）；发布时 `scripts/release/publish-dual.sh` 从单一 `--version`
输入同步。不要在 `platform/khy_platform/__init__.py` 中硬编码 `__version__`——它从
`pyproject.toml` / 已安装元数据动态解析，硬编码会导致版本同步检查失败。

## 文档导航

- 文档总索引：[docs/00_INDEX_文档索引.md](docs/00_INDEX_文档索引.md)
- 概念入门（Agent / Tool Calling / MCP / LLM 等）：`docs/02_CONCEPTS_概念入门/`
- 设计与实现记录：`docs/03_DESIGN_设计/`、`docs/04_IMPL_实现/`
- 部署与运维手册：`docs/06_DEPLOY_部署/`、`docs/07_OPS_运维/`
- 规范与规则登记表：`docs/10_规范/`（`RULES-REGISTRY.json` 是规则真源）

`docs/` 顶层采用**单一编号轴**：`01`–`09` 是生命周期阶段，`10`–`19` 是跨阶段资产。
离线文档站（`docs/**/*.html`）随仓库提供，可直接用浏览器打开；首次克隆后跑一次
`npm run docs:build` 生成图表引擎，Mermaid 图表才会渲染（在此之前留白但不会报错）。

## 贡献与维护

- AI 助手与维护者指南（架构速查、工程规则、代码风格、评审清单）：[AGENTS.md](AGENTS.md)；同一份内容的人类指南见 [CONTRIBUTING.md](.github/CONTRIBUTING.md)
- 便携模式说明：[PORTABLE.md](docs/06_DEPLOY_部署/DEPLOY/[DEPLOY-0101] PORTABLE.md)
- 工程红线（零硬编码、状态透明、活动超时、终端渲染）详见 AGENTS.md 的「工程规则」章节。

提交前建议跑这几道门：

```powershell
node scripts\ci\check-agent-rules.js --changed   # 工程红线静态体检
npm run check:layout                             # 顶层层级与依赖方向
npm run rules:gate                               # 规则门（pr 档；commit 档更快）
npm run rules:apply -- <改动文件路径>              # 查「我要改这个文件，适用哪些规则」
```

规则登记表在 `docs/10_规范/registry/RULES-REGISTRY.json`，**门的成员资格由登记表派生**；
覆盖率与红线用 `npm run rules:coverage` 查看。

> 维护者导航：仓库根 61 项按六族分组索引见 [docs/00_INDEX_仓库根.md](docs/00_INDEX_仓库根.md)——机器契约族位置即契约，永不动。

代码风格：JS 用 2 空格缩进、单引号、分号；命名 camelCase（JS）/ snake_case（Python）；面向用户的字符串用中文，代码注释用英文。

## 许可

**基于执行轨迹记录与链路校验技术的AI助手平台**（Khy-OS）采用 **Source-available（源码可见）** 模式：
可免费下载、运行、学习与非商业使用；复制、修改、再分发源码及商业使用需获得作者
（孔浩原 / Kong Haoyuan）的书面许可。
