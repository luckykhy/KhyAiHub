# CLAUDE.md — khyOS Desktop 操作手册

> khyOS 桌面端：ZCode 1:1 复刻，对外呈现与 ZCode Desktop v3.11.2 完全一致的界面、交互、文案与数据契约。

---

## 唯一设计文档

**本项目的一切实现以 `docs/[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md` 为唯一真源。**

其他任何文档（包括本文件）不得与 DESIGN-ARCH-092 冲突。若发现冲突，以 DESIGN-ARCH-092 为准。

## 项目定位

- **产品**：以 KhyOS 桌面端壳为交付物，1:1 复刻 ZCode Desktop v3.11.2 的界面、交互、文案与数据契约。
- **方法**：解包 ZCode `app.asar` 提取一手真源 + 官方站/更新日志交叉验证。
- **状态**：设计定稿，全部待实现（本仓库当前视为零基础）。

## 技术栈（锁定版本）

| 组件 | 版本 | 说明 |
|------|------|------|
| React | ^19.2.4 | 前端框架 |
| react-dom | ^19.2.4 | |
| Electron | 44.2.0 | 桌面框架 |
| electron-vite | 5.0.0 | 构建工具 |
| electron-builder | 26.15.3 | 打包（锁版本，v27 有 ESM 破坏性变更） |
| electron-updater | 6.8.9 | 自动更新 |
| TypeScript | 5.x | 类型系统 |
| Tailwind CSS | 4.2.2 | 样式（OKLCH） |
| Redux Toolkit | latest | 状态管理 |
| @xterm/xterm | 6.0.0 | 终端 |
| node-pty | ^1.0.0 | pty 宿主 |

## 进程架构

**四进程 + 五 preload**（非 Electron 常见的两进程）：

| 进程 | 角色 |
|------|------|
| main | 窗口、菜单、托盘、更新、系统能力、IPC 注册 |
| host | Agent 运行时适配，桥接 KhyOS 后端（五通道决策矩阵） |
| scheduler | 定时任务、闲时算力 |
| preload ×6 | 主 preload（127 RPC 方法）+ 5 个专用 preload |

## 关键约束

1. **零硬编码**：端点一律从 `services/backend/src/constants/serviceDefaults.js` 导入或 env 覆盖。
2. **状态透明**：所有状态文案遵守「动作 + 目标 + 进度」。
3. **基于活动的超时**：Agent 循环、自动化任务禁止硬 kill。
4. **终端渲染**：不用 ANSI 滚动区（除备用缓冲区全屏 UI）。

## 开发流程

```bash
# 安装依赖
cd apps/khyos-desktop
npm install

# 开发模式
npm run dev          # 仅 renderer
npm run electron:dev # 完整四进程

# 构建
npm run electron:build

# 校验
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-version-sync.js
```

> **2026-11-02 更正**：本条原先列有 `node scripts/ci/check-i18n-fidelity.js`，
> 该脚本**在本仓不存在**（`scripts/ci/` 下无此文件），照抄会直接报 MODULE_NOT_FOUND。
> 仓内没有任何守卫比对 `zh-CN.json` 与 `zcode-analysis/i18n-zh.json` 的文案一致性
> （`check-zcode-baseline.js` 是架构代理指标记分板，S1 观察者，不碰文案）。
> **i18n 与 ZCode 真源的分歧靠人工核对**，见下节。

## 真源资产

所有数值、文案、CSS 令牌的真源在 `zcode-analysis/` 目录：

| 文件 | 内容 |
|------|------|
| `tokens.txt` | 456 个 CSS 自定义属性 |
| `i18n-zh.json` | 5070 条中文文案（嵌套对象） |
| `i18n-zh.jsonl` | 同上（机器安全格式） |
| `rpc-surface.json` | 127 个 RPC 方法标识符 |
| `unpacked/` | ZCode 解包产物（只读参考） |

**禁止凭记忆改数值。一切以真源文件为准。**

### 与真源的有意分歧登记（2026-11-02）

`zcode-analysis/` 是**只读参考真源**，不是可执行契约。凡实现刻意偏离真源文案的，
在此登记理由；没有登记的偏离视为漂移，应修。

| 键 | 真源原文（`i18n-zh.json`） | KhyOS 现值（`src/renderer/i18n/zh-CN.json`） | 分歧理由 |
|---|---|---|---|
| `settings.messageStreamShowReasoningDescription` | 「在消息流中展示完整的模型思考内容；**关闭时每轮仍展示第一次思考**。」 | 「在消息流中展示模型的思考内容；**关闭后思考块不再显示**。」 | 真源描述的「仍展示第一次思考」这个语义在 khy-os 任何一层都不存在（全仓 grep `第一次思考\|首次思考\|firstThinking` = 0 命中）。照抄等于对用户作无法兑现的承诺，故按实现改写。 |

### 目录结构决策与偏差登记（2026-11-19 重组）

2026-11-19 目录重组的落地形态与设计草图的差异，逐条登记；**没有登记的偏离视为漂移，应修**。

| 项 | 草图 | 实际 | 理由 / 状态 |
|---|---|---|---|
| `scripts/` 四层分类 | `dev/build/check/ci` | 同左 | `scripts/build`（generate-icon.cjs 等源码）曾被 `check-build-root` 按目录名误判为构建产物；已在 `scripts/lib/buildRootGuard.js` 的 `SOURCE_DIR_ALLOWLIST` 补登并附理由（该名单本就是「源码目录恰好叫产物名」的正规逃生口）。**规则已修，偏差消除。** |
| 设计文档位置 | `docs/design/` 子目录 | 留 `docs/` 根 | `zcode-analysis/check-structure.cjs` 硬编码读 `docs/[DESIGN-ARCH-092]….md`；移目录即断该脚本，而改它违反上文「不修改 zcode-analysis」红线。 |
| `zcode-analysis/` 分层 | `tools/`+`truth/`+`unpacked/` | 保持平铺 | 同上：该目录整体只读，且设计文档真源表写死其内部路径（`tokens.txt` / `i18n-zh.json` 等）。 |
| 构建产物位置 | app 内 `build/` | **打包输出 `entries/electron/dist-electron`；Vite 产物 `out/` 留 app 目录内（legacy/migrating，目标实测不可达）** | 两者分治，理由都有源码依据：**打包输出**（纯输出、无运行时解析语义）迁 `entries/` 成立，electron-builder 日志实锤接受目录外 `appOutDir`；**`out/`** 必须留 app 内——package.json 的 `main` 在开发态（`electron .`）与打包态（asar 内解析）须指向同一处，且 electron-builder 的 `files` 匹配走不出 app 目录（`filter.js` 的 `createFilter` 只算「相对 appDir」路径，`../` 字符串 pattern 静默零匹配）。2026-11-19 曾试迁 `out/`，实跑打包前读源码发现会静默产出空 asar，已全量回退；三个 vite 配置头部留了警告注释。语义上正对口 parasitic（工具强制路径），但 `parasiticBudget=6` 已满、棘轮只降不升，故维持 `BUILD-OUTPUTS.json` 的 migrating + 未来 sunset（warning 级）；**要改判 parasitic 需人先拍板升预算**。 |
| `tests/` 按域分组 | `agentbus/amoon/editor/…` | 保持平铺 | 43 个测试文件用 `__dirname`/`import.meta.url` 相对定位项目根，分组即全部断链；且 `node --test` 对缺失路径**静默跳过**（status 0），少跑测试无人知晓。 |
| `src/main` 根文件 / `src/renderer/components/` 重组 | 按领域分组 | 原样冻结 | 契约测试硬编码路径：`agentbusPanel`/`amooSecretary`/`khyPet` 读 `src/main` 根文件；10 个 `*UiContract.test.cjs` 读 `components/<域>/<文件>.tsx`。 |
| Vue 时代死件 | — | 已删 | `vite.config.js`（Vue 插件配置）、根 `index.html`（引不存在的 `/src/main.js`）、`dist/`，无任何现行构建链引用。 |

**另记一枚 2026-11-19 事故**：`scripts/ci/brand-replace.cjs` 无 dry-run，执行即从 ZCode 真源**全量重生** `src/renderer/i18n/zh-CN.json`——会静默删除真源没有的手加键（`codeEditor.*` 全族）并冲掉上表登记的有意分歧。脚本头已加警告注释；**别随手跑**，跑前先 `git diff` 该文件。

## 品牌规则

本项目复刻 ZCode 的**布局、结构、尺寸、交互、信息层级**，但**不复用品牌资产**：

| 替换 | 说明 |
|------|------|
| ZCode → KhyOS | 名称替换 |
| GLM 图标素材 → 自研 | 美术资产自研 |
| zcode.z.ai → khyquant.top | 域名替换 |
| 智谱反馈表单 → KhyOS 反馈渠道 | 链接替换 |
| 智谱遥测 → 默认关 | 不接入 ARMS RUM |

品牌替换目前**没有自动守卫**（`scripts/ci/` 下不存在 `check-brand-replacement.js`），
按下表**人工核对**。

## 相关文件

| 用途 | 文件 |
|------|------|
| 设计文档 | `docs/[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md` |
| khy-os 工程红线 | `../../AGENTS.md` |
| khyos-hq 指挥部 | `../khy-os-hq/` |

---

*最后更新：2026-09-08*
*本文件指向 DESIGN-ARCH-092 为唯一真源*
