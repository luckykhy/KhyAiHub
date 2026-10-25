/**
 * Getting Started Service — generates the first-run guide and welcome banner.
 *
 * The guide lives in the resolved data home (getAppHome(), which honours
 * KHY_DATA_HOME / KHY_APP_HOME and the portable deployment probe) — never at a
 * hardcoded ~/.khyquant.
 */
const fs = require('fs');
const path = require('path');

// Portable-aware app home resolved at load (legacy const semantics preserved).
function _appHome() {
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(require('os').homedir(), '.khy');
  }
}
const KHY_DIR = _appHome();
const GUIDE_PATH = path.join(KHY_DIR, 'GETTING_STARTED.md');
const SHOWN_MARKER = path.join(KHY_DIR, '.getting_started_shown');

/**
 * Generate the getting-started guide markdown file.
 */
function generateGettingStarted() {
  try {
    fs.mkdirSync(KHY_DIR, { recursive: true });
  } catch {
    /* exists */
  }

  const version = process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version;

  const content = `# khy OS v${version} — AI Platform Operating System Terminal

## AI 平台操作系统 · 可扩展应用运行时

khy OS 是一个 AI 平台操作系统：它启动一个可扩展的应用运行时，经多模型 AI 网关
接入各种模型，用计划模式与 Agentic 工具把任务做完。

khyquant（量化交易终端）是**独立项目**，连接 Khy OS 使用，**不是** Khy OS 的内置
部分 —— 量化能力的有无不影响平台本身的对话、网关与工具链。

### 核心特性

| 特性 | 说明 |
|------|------|
| 可扩展应用运行时 | 平台负责启动与托管应用；khyquant 等独立应用连接它使用 |
| 多模型 AI 网关 | Kiro / Cursor / Claude / Codex / VSCode / Ollama / 云 API |
| 计划模式 | 复杂任务自动分解 → 用户审批 → 逐步执行 |
| Agentic 工具 | Search / Read / Bash 等工具调用实时展示 |
| IDE 反向代理 | khy --kiro/--cursor/--claude/--codex 一键切换 IDE 模型源 |
| IP 匿名化 | 反向代理自动隐藏真实 IP，防止封禁 |

## 快速上手 — 6 条必备命令

| 命令 | 说明 |
|------|------|
| \`khy\` | 启动终端，直接打字描述你想做的事 |
| \`khy gateway model\` | 选择 AI 模型 / 通道 |
| \`khy gateway config\` | 配置 AI 通道与密钥 |
| \`khy doctor\` | 环境自检 |
| \`/plan\` | 进入计划模式（复杂任务先拆解再执行） |
| \`khy help\` | 查看全部命令 |

## AI 配置

khy OS 自动检测以下 AI 来源 (按优先级):

1. **Claude Code / Codex** — 本地已安装的 AI CLI 工具
2. **Kiro / Cursor / Trae / VSCode** — IDE 内置 AI 模型
3. **Ollama** — 本地大模型推理 (默认 qwen2.5:7b)
4. **云 API** — Gemini / Groq / OpenRouter / 智谱 (需配置 key)
5. **Web 中转** — 手动浏览器中转 (备用)

配置 AI 通道与密钥: 运行 \`khy gateway config\`。

## IDE 反向代理

\`\`\`bash
khy --kiro        # 使用 Kiro IDE 的 AI 模型
khy --cursor      # 使用 Cursor 的 AI 模型
khy --claude      # 使用 Claude Code
khy --codex       # 使用 OpenAI Codex
khy --vscode      # 使用 VS Code Copilot
khy --trae        # 使用 Trae (字节跳动)
khy --warp        # 使用 Warp 终端
\`\`\`

## 社区 & 支持

- 官网: https://khyquant.top
- GitHub: https://github.com/khyquant/khy-quant
- 问题反馈: https://github.com/khyquant/khy-quant/issues

_感谢使用 khy OS，祝使用顺利！_
`;

  fs.writeFileSync(GUIDE_PATH, content, 'utf8');
}

/**
 * Check if the getting-started guide should be displayed.
 */
function shouldShow() {
  return !fs.existsSync(SHOWN_MARKER);
}

/**
 * Mark the getting-started guide as shown.
 */
function markAsShown() {
  try {
    fs.mkdirSync(KHY_DIR, { recursive: true });
    fs.writeFileSync(SHOWN_MARKER, new Date().toISOString());
  } catch {
    /* ignore */
  }
}

/**
 * Display the getting-started guide in the terminal.
 * Uses aiRenderer if available, otherwise plain console output.
 */
function displayGettingStarted() {
  if (!shouldShow()) {
    return false;
  }

  try {
    const chalk = require('chalk').default || require('chalk');
    const version = process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version;

    console.log('');
    console.log(
      chalk.cyan('  ━━━ khy OS v' + version + ' — AI Platform Operating System Terminal ━━━')
    );
    console.log('');
    console.log(chalk.bold('  AI 平台操作系统 · 可扩展应用运行时'));
    console.log('');
    console.log(chalk.yellow('  快速上手:'));
    console.log(chalk.dim('    khy                 启动终端，直接打字描述任务'));
    console.log(chalk.dim('    khy gateway model   选择 AI 模型 / 通道'));
    console.log(chalk.dim('    khy gateway config  配置 AI 通道与密钥'));
    console.log(chalk.dim('    khy doctor          环境自检'));
    console.log(chalk.dim('    help                查看全部命令'));
    console.log('');
    console.log(chalk.dim(`  详细指南: ${GUIDE_PATH}`));
    console.log('');

    markAsShown();
    return true;
  } catch {
    markAsShown();
    return false;
  }
}

// Allow Node.js require() from _bootstrap.py
if (require.main === module) {
  generateGettingStarted();
}

module.exports = { generateGettingStarted, displayGettingStarted, shouldShow, markAsShown };
