'use strict';

/**
 * acpAgentAdapter.js — 网关适配器：外部编辑器 ACP 智能体（面 B，[DESIGN-ARCH-184] §4.2）。
 *
 * 与 opencode/openclaw 同属「定向指挥」类：外部智能体有自己的模型配置，不抢占
 * 自动 LLM 回退，只经 preferredAdapter:'acp' / preferredModel:<agentKey> 定向路由。
 *
 * 智能体登记：KHY_ACPCLIENT_AGENTS（key=command [args...]，逗号分隔，单一真源
 * protocol-naming.json agentClientEnvAllowlist）。未登记 → detect 恒 false，网关跳过。
 *
 * 权限 fail-closed：外部智能体反向请求授权时，经网关的 onControlRequest 通道走
 * khy 自己的审批 UI；无交互通道（headless）→ 一律拒绝。
 */

const { exec } = require('child_process');

const { buildSuccess, buildFailure } = require('./_responseBuilder');
const {
  loadAgentRegistry,
  resolveAgentCommand,
  getConnection,
  destroyConnection,
} = require('./acpAgentInvocation');

const ADAPTER_NAME = 'acp';
const PROBE_TIMEOUT_MS = 3000;

let _detectError = '';

function _registryKeys(env) {
  return Object.keys(loadAgentRegistry(env));
}

/**
 * 把外部智能体的 usage_update 累计成本翻译成网关 tokenUsage 形状的中间层（纯函数）。
 * 协议 cost 为 ISO 4217 任意币种，khy 台账以人民币计价——统一 CNY（[DESIGN-ARCH-184] §11.6）。
 * @param {Array<{used:number,size:number,cost?:{amount:number,currency:string}}>} updates
 * @returns {object|null} { inputTokens, outputTokens, totalTokens, costCNY }
 */
function summarizeUsageUpdates(updates) {
  if (!Array.isArray(updates) || !updates.length) {
    return null;
  }
  let used = 0;
  let size = 0;
  let cost = 0;
  for (const u of updates) {
    if (u && typeof u.used === 'number') {
      used = Math.max(used, u.used); // used/size 是会话级快照（非增量），取最大
    }
    if (u && typeof u.size === 'number') {
      size = Math.max(size, u.size);
    }
    if (u && u.cost && typeof u.cost.amount === 'number') {
      cost += u.cost.amount; // cost 是累计值（协议口径），直接求和容快照重复
    }
  }
  return { inputTokens: used, outputTokens: 0, totalTokens: used, costCNY: cost };
}


/** 裸命令在 PATH 上可达性探测（win: where / nix: which）。 */
function _probeOnPath(command) {
  return new Promise((resolveAvailable) => {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    exec(`${checker} ${JSON.stringify(command)}`, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err) => {
      resolveAvailable(!err);
    });
  });
}

/** 首个可达的外部智能体（探测缓存由网关 detectCache 承担，这里不做二级缓存）。 */
async function detect() {
  const keys = _registryKeys(process.env);
  if (!keys.length) {
    _detectError = '未登记外部 ACP 智能体：设置 KHY_ACPCLIENT_AGENTS（如 claude-acp=npx @zed-industries/claude-code-acp）后重试';
    return false;
  }
  for (const key of keys) {
    const resolved = resolveAgentCommand(key, process.env);
    if (!resolved) {
      continue;
    }
    if (resolved.command.includes('/') || resolved.command.includes('\\')) {
      return true; // 显式路径已在 resolveAgentCommand 做过存在性检查
    }
    if (await _probeOnPath(resolved.command)) {
      return true;
    }
  }
  _detectError = `登记的智能体均不可达（PATH 探测 ${PROBE_TIMEOUT_MS / 1000}s 超时视为不可达）：${keys.join('、')}`;
  return false;
}

/**
 * 把 agent 反向请求的授权决策翻译成 ACP outcome 的中间层（纯函数，单测覆盖）。
 * @param {*} decision - onControlRequest 归一前的返回值（true/'always'/false/{behavior}）
 * @param {{allow:object|null, allowAlways:object|null, reject:object|null}} opts
 * @returns {object} ACP RequestPermissionOutcome
 */
function mapDecisionToOutcome(decision, opts) {
  const { allow, allowAlways, reject } = opts;
  const cancelled = { outcome: 'cancelled' };
  if (decision === true || decision === 'allow') {
    return allow ? { outcome: 'selected', optionId: allow.optionId } : cancelled;
  }
  if (decision === 'always' || decision === 'allow-always' || decision === 'allow_always') {
    if (allowAlways) {
      return { outcome: 'selected', optionId: allowAlways.optionId };
    }
    return allow ? { outcome: 'selected', optionId: allow.optionId } : cancelled;
  }
  return reject ? { outcome: 'selected', optionId: reject.optionId } : cancelled;
}

async function generate(prompt, options = {}) {
  const keys = _registryKeys(process.env);
  if (!keys.length) {
    return buildFailure(_detectError || '未登记外部 ACP 智能体', { adapter: ADAPTER_NAME });
  }
  // preferredModel 可指定具体智能体 key；否则用第一个登记项（确定性）。
  const wanted = String(options.preferredModel || '').trim();
  const agentKey = keys.includes(wanted) ? wanted : keys[0];
  const resolved = resolveAgentCommand(agentKey, process.env);
  if (!resolved) {
    return buildFailure(`智能体 ${agentKey} 的命令不可达，检查 KHY_ACPCLIENT_AGENTS 配置`, {
      adapter: ADAPTER_NAME,
    });
  }

  const conn = getConnection(agentKey, resolved, {
    cwd: options.cwd || process.cwd(),
    onErrorLog: (line) => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* ignore */
      }
    },
  });

  let fullText = '';
  const usageUpdates = [];
  try {
    const result = await conn.prompt(String(prompt || ''), {
      onChunk: (chunk) => {
        if (typeof options.onChunk === 'function') {
          if (chunk.type === 'text') {
            fullText += chunk.text;
          }
          options.onChunk(chunk);
        }
      },
      onUpdate: (u) => {
        if (u.sessionUpdate === 'usage_update') {
          usageUpdates.push(u);
        }
      },
      onControlRequest: options.onControlRequest,
    });
    if (result.error) {
      return buildFailure(`外部智能体回合失败: ${result.error.message || 'unknown'}`, {
        adapter: ADAPTER_NAME,
        provider: agentKey,
      });
    }
    const stopReason = (result.result && result.result.stopReason) || 'end_turn';
    return buildSuccess(fullText, {
      adapter: ADAPTER_NAME,
      provider: agentKey,
      model: (conn.agentInfo && conn.agentInfo.name) || agentKey,
      tokenUsage: summarizeUsageUpdates(usageUpdates),
      stopReason,
    });
  } catch (err) {
    if (options.abortSignal && options.abortSignal.aborted) {
      conn.cancel(); // 通知对端收尾（协议：cancel 是通知），随后按失败返回
    }
    return buildFailure(err, {
      adapter: ADAPTER_NAME,
      provider: agentKey,
      errorType: options.abortSignal && options.abortSignal.aborted ? 'aborted' : undefined,
    });
  }
}

function getStatus() {
  return {
    name: ADAPTER_NAME,
    type: 'external-agents',
    available: false,
    detail: _detectError || 'KHY_ACPCLIENT_AGENTS 未配置或探测未运行',
  };
}

function listModels() {
  return _registryKeys(process.env);
}

async function destroy() {
  await destroyConnection(ADAPTER_NAME);
}

module.exports = {
  name: ADAPTER_NAME,
  detect,
  generate,
  getStatus,
  listModels,
  destroy,
  mapDecisionToOutcome,
  summarizeUsageUpdates,
};
