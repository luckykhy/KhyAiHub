'use strict';

/**
 * CLI handler for the Arena command — run a prompt against multiple models.
 *
 * Usage:
 *   /arena "Implement quicksort" --models gpt-4,claude-sonnet,qwen-max
 *   /arena compare --models gpt-4,claude-sonnet
 *
 * @module handlers/arena
 */

const { ArenaManager, formatArenaResult } = require('../../services/arenaManager');

/**
 * Handle arena command.
 *
 * @param {string} input - The prompt or subcommand
 * @param {object} deps
 * @param {object} deps.aiModule - AI gateway module
 * @param {object} deps.chalk - Chalk instance
 * @param {object} [deps.options] - Parsed CLI options
 * @returns {Promise<void>}
 */
async function handleArena(input, deps) {
  const { aiModule, chalk: c } = deps;
  const options = deps.options || {};

  if (!input || input === 'help') {
    _printHelp(c);
    return;
  }

  // ── Subcommands ─────────────────────────────────────────────────
  const subcommand = input.split(/\s+/)[0].toLowerCase();

  if (subcommand === 'history') {
    return _handleHistory(c, options);
  }
  if (subcommand === 'leaderboard' || subcommand === 'lb') {
    return _handleLeaderboard(c, options);
  }
  if (subcommand === 'show') {
    const arenaId = input.split(/\s+/)[1];
    return _handleShow(c, arenaId);
  }

  // Parse models from --models flag or from config
  let models = [];
  if (options.models) {
    models = options.models
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  // Default: use 2-3 available models
  if (models.length === 0) {
    models = _getDefaultModels(aiModule);
  }

  if (models.length < 2) {
    console.log(c.yellow('  Arena 至少需要 2 个模型：请加 --models model1,model2'));
    console.log(c.dim('  可用模型可通过 /models 查看'));
    return;
  }

  // Extract prompt (everything that's not a flag)
  const prompt = input.replace(/--\w+\s+\S+/g, '').trim();
  if (!prompt) {
    console.log(c.yellow('  缺少提示词：请在 /arena 后输入要比对的问题，如 /arena "你的问题" --models 模型1,模型2'));
    return;
  }

  console.log('');
  console.log(c.bold(`  启动 Arena 比对，共 ${models.length} 个模型...`));
  models.forEach((m) => console.log(c.dim(`    • ${m}`)));
  console.log('');

  // Create arena manager
  const gateway = aiModule.gateway || aiModule;
  const arena = new ArenaManager(gateway, {
    timeoutMs: options.timeout ? parseInt(options.timeout, 10) * 1000 : 60_000,
  });

  // Progress tracking
  const progress = {};
  const onProgress = (model, event) => {
    if (!progress[model]) {
      progress[model] = { chunks: 0, chars: 0 };
    }
    if (event.type === 'chunk') {
      progress[model].chunks++;
      progress[model].chars += (event.content || '').length;
      // Update spinner
      if (progress[model].chunks % 10 === 0) {
        const total = Object.entries(progress)
          .map(([m, p]) => `${m.split('/').pop()}: ${p.chars}ch`)
          .join(', ');
        process.stdout.write(`\r  ${c.dim(`接收中 · ${total}`)}`);
      }
    }
  };

  try {
    const result = await arena.run({
      prompt,
      models,
      system: options.system || undefined,
      maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
      temperature: options.temperature ? parseFloat(options.temperature) : undefined,
      onProgress,
    });

    // Clear progress line
    process.stdout.write('\r' + ' '.repeat(120) + '\r');

    // Print formatted result
    console.log(formatArenaResult(result, { chalk: c }));

    // Print individual responses if --verbose
    if (options.verbose) {
      for (const entry of result.entries) {
        if (entry.failed) {
          continue;
        }
        console.log(c.bold(`  ── ${entry.model} ──`));
        console.log('');
        // Indent each line
        const indented = entry.content
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n');
        console.log(indented);
        console.log('');
      }
    } else {
      console.log(c.dim('  加 --verbose 可查看各模型的单独回复。'));
    }
  } catch (err) {
    console.log(c.red(`  Arena 执行失败：${err.message}`));
  }
}

/**
 * Get default models from the gateway configuration.
 * @param {object} aiModule
 * @returns {string[]}
 */
function _getDefaultModels(aiModule) {
  try {
    // Try to get available models from gateway
    const gw = aiModule.gateway || aiModule;
    if (typeof gw.listModels === 'function') {
      const models = gw.listModels();
      if (Array.isArray(models) && models.length >= 2) {
        return models.slice(0, 3).map((m) => m.id || m.name || m);
      }
    }
    if (typeof gw.getAvailableModels === 'function') {
      const models = gw.getAvailableModels();
      if (Array.isArray(models) && models.length >= 2) {
        return models.slice(0, 3).map((m) => m.id || m.name || m);
      }
    }
  } catch {
    /* ignore */
  }

  return [];
}

/**
 * Print help for the arena command.
 */
function _printHelp(c) {
  console.log('');
  console.log(c.bold('  Arena — 多模型比对'));
  console.log('');
  console.log('  用法:');
  console.log(c.dim('    /arena "你的提示词" --models model1,model2,model3'));
  console.log(c.dim('    /arena history                列出历史 Arena 运行记录'));
  console.log(c.dim('    /arena leaderboard            跨所有运行的模型排名'));
  console.log(c.dim('    /arena show <arenaId>         重新展示某次历史结果'));
  console.log('');
  console.log('  选项:');
  console.log(c.dim('    --models <list>      逗号分隔的模型标识'));
  console.log(c.dim('    --system <prompt>    覆盖系统提示词'));
  console.log(c.dim('    --maxTokens <n>      单次回复最大 token 数'));
  console.log(c.dim('    --temperature <n>    采样温度 (0-2)'));
  console.log(c.dim('    --timeout <s>        每个模型的超时秒数（默认 60）'));
  console.log(c.dim('    --verbose            显示各模型的单独回复'));
  console.log('');
  console.log('  示例:');
  console.log(c.dim('    /arena "实现快速排序" --models gpt-4,claude-sonnet'));
  console.log(c.dim('    /arena history'));
  console.log(c.dim('    /arena leaderboard'));
  console.log('');
}

/**
 * Handle /arena history — list past arena runs.
 */
function _handleHistory(c, options) {
  try {
    const store = require('../../services/arenaResultStore');
    const limit = options.limit ? parseInt(options.limit, 10) : 20;
    const results = store.listResults({ limit });

    if (results.length === 0) {
      console.log(c.yellow('  暂无 Arena 结果。'));
      return;
    }

    console.log('');
    console.log(c.bold(`  Arena 历史记录（${results.length} 次运行）`));
    console.log('');

    for (const r of results) {
      const date = new Date(r.savedAt).toLocaleString();
      const models = r.models.join(', ');
      const prompt = r.prompt.length > 50 ? r.prompt.slice(0, 47) + '...' : r.prompt;
      console.log(`  ${c.cyan(r.arenaId)}  ${c.dim(date)}`);
      console.log(`    模型: ${models}`);
      console.log(`    提示词: ${prompt}`);
      if (r.recommendation) {
        console.log(`    胜出: ${c.green(r.recommendation)}`);
      }
      console.log('');
    }
  } catch (err) {
    console.log(c.red(`  加载历史记录失败：${err.message}`));
  }
}

/**
 * Handle /arena leaderboard — aggregated model rankings.
 */
function _handleLeaderboard(c, options) {
  try {
    const store = require('../../services/arenaResultStore');
    const lb = store.getLeaderboard({
      minGames: options.minGames ? parseInt(options.minGames, 10) : 1,
    });

    if (lb.length === 0) {
      console.log(c.yellow('  暂无排行榜数据：请先运行几次 Arena 比对。'));
      return;
    }

    console.log('');
    console.log(c.bold('  Arena 排行榜'));
    console.log('');
    console.log(c.dim('  排名  模型                     得分  胜场  场次  延迟       失败率'));
    console.log(c.dim('  ────  ───────────────────────  ─────  ────  ─────  ─────────  ─────'));

    lb.forEach((entry, i) => {
      const rank = String(i + 1).padStart(4);
      const model = entry.model.padEnd(23).slice(0, 23);
      const score = String(entry.avgScore).padStart(5);
      const wins = String(entry.wins).padStart(4);
      const games = String(entry.games).padStart(5);
      const latency = `${entry.avgLatencyMs}ms`.padStart(9);
      const fail = `${entry.failRate}%`.padStart(5);
      const line = `  ${rank}  ${model}  ${score}  ${wins}  ${games}  ${latency}  ${fail}`;
      console.log(i === 0 ? c.green(line) : line);
    });
    console.log('');
  } catch (err) {
    console.log(c.red(`  加载排行榜失败：${err.message}`));
  }
}

/**
 * Handle /arena show <arenaId> — re-display a past result.
 */
function _handleShow(c, arenaId) {
  if (!arenaId) {
    console.log(c.yellow('  用法：/arena show <arenaId>'));
    return;
  }

  try {
    const store = require('../../services/arenaResultStore');
    const result = store.loadResult(arenaId);

    if (!result) {
      console.log(c.yellow(`  未找到 Arena 结果 "${arenaId}"。`));
      return;
    }

    console.log(formatArenaResult(result, { chalk: c }));
  } catch (err) {
    console.log(c.red(`  加载结果失败：${err.message}`));
  }
}

module.exports = { handleArena };
