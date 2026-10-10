'use strict';

/**
 * inertialRunService.js — 任务级惯性执行外置控制器（S1 影子模式）。
 *
 * [DESIGN-ARCH-160]：只当 runToolUseLoop 的**另一个调用方**（与 queryEngine /
 * replSession / AgentTool 并列），不碰执行内核；回滚 = 不调用即不存在。
 *
 * S1（影子，PROCESS-008 阶段语义：真跑但只记录不阻断）：
 *   - 真停类：completed（探针）/ budget（turns/wall/idle）/ error（连续错误/
 *     异常）/ privilege（硬拒或 deny 计数超限，刹车立即停）/ ambiguity
 *     （AskUserQuestion 观测，policy=stop，刹车立即停）/ external（租约/
 *     abort）。
 *   - 影子类：decay——动量照算、跌破 stopBelow 只记「若启用 S2 会在哪停」
 *     对照（firstDecayStopSeq），不真停；S2 按样本校准后启用。
 *
 * 授权执行矩阵（S1，零内核改动）：
 *   - authorization.tools → toolAccessGateway.setToolAccessGateway（工具名级
 *     真拦截：模型可见面 + 执行边缘双重，bin/khy.js -p 同款接线）；
 *   - bash 命令级硬拒/白名单 → onToolCall 机械检测（:6859 返回值只进 trace，
 *     不可否决）→ 命中即置 interruptSignal 刹车（内核 :6834/:7728 批间检查）
 *     + 停跑 + 信封披露。诚实边界：被匹配的那一条命令可能已执行一次
 *     （检测与执行同批的竞态），disclosures 必留此行。
 *   - onControlRequest：S1 不传应答器 = 内核 fail-closed deny（:6803 判据），
 *     与 -p 无头形态一致；真 deny 应答器 S2 接线。
 *
 * 状态落盘（§3.6）：<dataHome>/inertia/<runId>/{plan.json, ledger.jsonl,
 * result.json}；检查点扩展 boulderState（task_id=runId，零迁移）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DEFAULTS, MOMENTUM_START, SCHEMA_VER } = require('./defaults');
const { validatePlan, evaluateCommandAuthorization, evaluateBashPolicy } = require('./planSchema');
const { nextMomentum, decideStop } = require('./momentum');

// ── 小工具 ─────────────────────────────────────────────────────────────

function _sha12(s) {
  try {
    return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 12);
  } catch {
    return '000000000000';
  }
}

/** 规范化 JSON（键排序）→ sha256 全长，planHash 主键（§3.2 不可变指纹）。 */
function planHashOf(plan) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => {
          acc[k] = canonical(v[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

function _generateRunId(nowMs) {
  const d = new Date(nowMs);
  const ymd =
    String(d.getFullYear()).padStart(4, '0') +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `ir-${ymd}-${rand}`;
}

function _writeText(file, text) {
  try {
    fs.writeFileSync(file, text, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function _appendLedger(runDir, entry) {
  try {
    fs.appendFileSync(path.join(runDir, 'ledger.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* 账本是尽力而为：写失败不炸 run（信封披露处如实记录） */
  }
}

function _readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** 拒绝启动的轻量信封（未建 runId 目录，fail-closed 不留半态）。 */
function _rejectEnvelope(reason, extra) {
  return {
    ok: false,
    status: 'rejected',
    statusReason: reason,
    runId: null,
    planHash: null,
    kickedBy: null,
    outcome: null,
    stats: null,
    disclosures: extra && extra.disclosures ? extra.disclosures : [],
    resume: { canResume: false, checkpointTaskId: null, remainingBudget: null, openQuestions: [], contextDigest: '' },
    errors: extra && extra.errors ? extra.errors : undefined,
  };
}

/** completion 探针（§3.4 completed 判据；机械执行，无模型参与）。 */
function _defaultProbe(completion, cwd) {
  const { spawnSync } = require('child_process');
  const timeoutMs = 120000;
  try {
    const r = spawnSync(completion.command, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = typeof r.status === 'number' ? r.status : -1;
    return {
      ok: exit === completion.expectExit,
      exit,
      stdoutTail: String(r.stdout || '').slice(-400),
      stderrTail: String(r.stderr || '').slice(-400),
      timedOut: !!r.error && r.error.code === 'ETIMEDOUT',
    };
  } catch (e) {
    return { ok: false, exit: -1, stdoutTail: '', stderrTail: String((e && e.message) || e), timedOut: false };
  }
}

// ── 提示词构造（惯性单策略不进 messages 常驻——每段一条指令，§3.9） ────

function _kickMessage(plan) {
  const auth = plan.authorization;
  return (
    `[惯性执行 ${plan.runId || ''}] 你处于无人值守惯性模式，此后没有任何人会逐步指示你。\n\n` +
    `目标：${plan.goal}\n` +
    `达成判据（机械探针，由系统执行判定，不需要你运行）：\`${plan.completion.command}\` 退出码须为 ${plan.completion.expectExit}。\n\n` +
    `授权面（越出即被拒并计入越权预算）：\n` +
    `- 可用工具：${auth.tools.join(', ')}\n` +
    (auth.bashPolicy.allow.length ? `- bash 允许：${auth.bashPolicy.allow.join(' ; ')}\n` : '') +
    (auth.bashPolicy.deny.length ? `- bash 拒绝：${auth.bashPolicy.deny.join(' ; ')}\n` : '') +
    `- 硬拒清单（无论如何被拒）：git push --force / rm -rf / 各类 publish/deploy / 凭据文件读取\n\n` +
    `要求：不要请求确认、不要等待指示、不要复述计划而不动手；` +
    `遇到确实需要人来决策的歧义时，调用 AskUserQuestion（这将结束本次惯性跑并把问题交还发起方）；` +
    `持续工作直到达成判据，或确信无进一步可做的事后给出如实总结。`
  );
}

function _continueMessage(plan, segIndex, probe, lastReply) {
  return (
    `[惯性执行 续推 第 ${segIndex} 段] 达成判据尚未命中：探针 \`${plan.completion.command}\`` +
    ` 退出码 ${probe ? probe.exit : '?'} ≠ ${plan.completion.expectExit}。\n` +
    `上一段收尾（截断）：${String(lastReply || '').slice(0, 800) || '(无)'}\n` +
    `请从当前真实状态继续推进，不要重复已完成的调用；直到达成判据或无进一步可做的事。`
  );
}

// ── 主入口 ─────────────────────────────────────────────────────────────

/**
 * runInertialPlan(planPath, opts) — 蹬一脚（触发路径 C）。
 *
 * @param {string} planPath 惯性单 JSON 文件路径
 * @param {object} [opts] 依赖注入（测试与宿主可替换，缺省走真实实现）：
 *   chat         {Function} 内层 LLM（缺省 lazy require cli/ai 的 chat）
 *   loopFn       {Function} 外层循环（缺省 lazy require toolUseLoop.runToolUseLoop）
 *   runProbe     {Function} completion 探针（缺省 spawnSync）
 *   inertiaDir   {string}   run 目录根（缺省 getDataDir('inertia')）
 *   cwd          {string}   工作目录（缺省 process.cwd()）
 *   out          {object}   进度输出（缺省 process.stdout；null=静默）
 *   now          {Function} 时钟注入
 *   boulder      {object|null} 检查点模块注入（缺省 lazy require boulderState）
 *   skipActiveCheck {boolean} 跳过同 cwd 活跃 run 检查（测试用）
 * @returns {object} §3.7 结果信封
 */
async function runInertialPlan(planPath, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cwd = opts.cwd || process.cwd();
  const out = opts.out === null ? null : opts.out || process.stdout;
  const write = (s) => {
    if (out) {
      try {
        out.write(String(s));
      } catch {
        /* 输出失败不炸 run */
      }
    }
  };

  // ① 读 + 校验（fail-closed）
  let raw;
  try {
    raw = fs.readFileSync(planPath, 'utf-8');
  } catch {
    return _rejectEnvelope('plan_read_failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return _rejectEnvelope('plan_parse_failed');
  }
  const v = validatePlan(parsed);
  if (!v.ok) {
    return _rejectEnvelope('plan_schema_invalid', { errors: v.errors });
  }
  const plan = v.plan;

  const t0 = now();
  const runId = plan.runId || _generateRunId(t0);
  const dataDir = opts.inertiaDir || require('../../utils/dataHome').getDataDir('inertia');
  const runDir = path.join(dataDir, runId);

  // ③④ 租约 + 已完结检查（单实例语义，§3.8.5）
  const resultPath = path.join(runDir, 'result.json');
  if (_readJson(resultPath)) {
    return _rejectEnvelope('run_already_finished', { disclosures: [`runId=${runId} 已有 result.json`] });
  }
  const leasePath = path.join(runDir, 'lease.json');
  const existingLease = _readJson(leasePath);
  if (existingLease && Number(existingLease.expiresAt) > now()) {
    return _rejectEnvelope('lease_held', {
      disclosures: [`runId=${runId} 租约至 ${new Date(Number(existingLease.expiresAt)).toISOString()}`],
    });
  }

  // ③ 同 cwd 活跃 run 检查（§3.3 四查③；boulderState task_id 路线，零迁移）
  let boulder = null;
  if (opts.boulder !== null) {
    boulder = opts.boulder || _lazyBoulder();
  }
  if (!opts.skipActiveCheck && boulder) {
    try {
      const actives = (boulder.listResumableTasks() || []).filter(
        (t) => t && t.cwd === cwd && String(t.taskId || '').indexOf('ir-') === 0
      );
      if (actives.length > 0) {
        return _rejectEnvelope('active_run_exists', {
          disclosures: [`同 cwd 已有活跃惯性 run: ${actives.map((a) => a.taskId).join(', ')}`],
        });
      }
    } catch {
      /* 活跃检查失败不拦截启动（检查点模块可能不可用），信封披露 */
    }
  }

  // 建目录 + 落盘 plan.json（含 planHash，此后不可变）+ lease.json
  try {
    fs.mkdirSync(runDir, { recursive: true });
  } catch (e) {
    return _rejectEnvelope('run_dir_create_failed', { disclosures: [String((e && e.message) || e)] });
  }
  // planHash 绑定「落盘正文（含 runId、去 planHash 字段）」——审计回放以 plan.json 为准
  const planWithHash = { ...plan, runId };
  const planHash = planHashOf(planWithHash);
  planWithHash.planHash = planHash;
  _writeText(path.join(runDir, 'plan.json'), JSON.stringify(planWithHash, null, 2));
  _writeText(leasePath, JSON.stringify({ runId, pid: process.pid, startedAt: now(), expiresAt: now() + plan.leaseMs }));

  let ledgerWriteFailed = false;
  const ledger = (entry) => {
    if (ledgerWriteFailed) return;
    try {
      fs.appendFileSync(path.join(runDir, 'ledger.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      ledgerWriteFailed = true;
    }
  };

  const disclosures = [];
  const kickedBy = plan.kickedBy || { surface: 'cli' };
  ledger({ seq: 0, ts: now(), kind: 'kick', planHash, kickedBy, goal: plan.goal });

  // ② 白名单（四查②已在 schema 校验，此处做执行面接线：gateway 真拦截）
  let gateway = null;
  try {
    gateway = require('../toolAccessGateway');
    gateway.setToolAccessGateway({ allowed: plan.authorization.tools });
  } catch {
    gateway = null;
    disclosures.push('toolAccessGateway 不可用：工具白名单降级为仅提示词约束（诚实披露）');
  }

  // chat 构造（同 -p 模板：内层禁 NL 循环，外层 loop 主导，bin/khy.js:1860-1866）
  let chat = opts.chat;
  if (typeof chat !== 'function') {
    // Take the chat core from the inversion port (cli/ai self-registers there on
    // load) instead of requiring cli/ai from this service: same function inside a
    // CLI process, and a headless process reports a structured failure rather than
    // dragging the whole TUI-coupled CLI graph in.
    chat = require('../aiChatPort').getAiChat();
    if (typeof chat !== 'function') {
      gateway && gateway.clearToolAccessGateway();
      return _rejectEnvelope('chat_unavailable');
    }
  }
  const chatFn = (message, chatOpts = {}) =>
    chat(message, { ...chatOpts, disableNaturalToolLoop: true, onChunk: null });

  const loopFn =
    typeof opts.loopFn === 'function'
      ? opts.loopFn
      : () => {
          const m = require('../toolUseLoop');
          return m.runToolUseLoop;
        };

  const budget = plan.budget;
  const decay = plan.decay;
  const probeFn = typeof opts.runProbe === 'function' ? opts.runProbe : (completion) => _defaultProbe(completion, cwd);

  // ── run 状态 ──
  let momentum = MOMENTUM_START;
  let turnsTotal = 0;
  let toolCalls = 0;
  let costCny = 0;
  let costSeen = false;
  let seq = 0;
  let consecutiveErrors = 0;
  let denies = 0;
  let lastEventAt = t0;
  let lastReply = '';
  let lastProbe = null;
  let stop = null; // {stop, reason}
  let inheritedDedupKeys = null;
  let hardDenyHit = null;
  let ambiguityHit = false;
  let interruptedByController = false;
  const interruptSignal = { interrupted: false, _event: null };
  const shadow = { firstDecayStopSeq: null, firstDecayMomentum: null, firstPrivilegeStopSeq: null };
  let recentEvents = []; // 本段动量事件（repeat/error/deny；progress 由探针 delta 判定）
  const recentArgSignatures = []; // 近窗签名（tool:argsDigest），§3.5 重复判定
  let prevProbeExit = null; // 上一段探针退出码（进度 = 结果变化）

  const touch = () => {
    lastEventAt = now();
  };

  const doStop = (s) => {
    stop = s;
    interruptedByController = true;
    try {
      interruptSignal.interrupted = true;
      interruptSignal._event = { reason: s.reason, source: 'inertia', stop: s.stop };
    } catch {
      /* 刹车尽力而为 */
    }
  };

  try {
    let segIndex = 0;
    while (true) {
      // 段顶预算检查（turns/wall；idle 在段末判——单条长工具由内核 per-tool timeout 兜底）
      const wallMs = now() - t0;
      const idleMs = now() - lastEventAt;
      const pre = decideStop(
        { turns: turnsTotal, wallMs, idleMs, momentum, denies, consecutiveErrors, costCny },
        { decay, budget, consecutiveErrorsForStop: DEFAULTS.consecutiveErrorsForStop }
      );
      if (pre.stop === 'external' || pre.stop === 'error' || pre.stop === 'privilege') {
        stop = pre;
        break;
      }
      if (pre.stop === 'budget' && (pre.reason === 'idle' || pre.reason === 'wall')) {
        stop = pre;
        break;
      }
      if (turnsTotal >= budget.maxTurns) {
        stop = { stop: 'budget', reason: 'turns' };
        break;
      }
      if (wallMs >= budget.maxWallMs) {
        stop = { stop: 'budget', reason: 'wall' };
        break;
      }

      const userMessage =
        segIndex === 0 ? _kickMessage(planWithHash) : _continueMessage(planWithHash, segIndex, lastProbe, lastReply);
      segIndex += 1;
      ledger({ seq: ++seq, ts: now(), kind: 'segment', segment: segIndex, turnsTotal, momentum: Number(momentum.toFixed(4)) });
      touch();

      let res = null;
      try {
        res = await loopFn(userMessage, {
          chat: chatFn,
          chatOpts: { cwd },
          maxIterations: Math.max(1, budget.maxTurns - turnsTotal),
          interruptSignal,
          ...(inheritedDedupKeys ? { inheritedDedupKeys } : {}),
          onToolCall: (name, params) => {
            seq += 1;
            toolCalls += 1;
            touch();
            const argsDigest = _sha12(JSON.stringify(params == null ? '' : params));
            ledger({ seq, ts: now(), kind: 'tool_call', tool: String(name || ''), argsDigest });
            const ev = _classifyToolCall(name, params, plan, {
              setHardDeny: (h) => {
                hardDenyHit = h;
              },
              doStop,
              addDeny: () => {
                denies += 1;
              },
              note: (s) => disclosures.push(s),
            });
            if (ev === 'deny') {
              recentEvents.push('deny');
            }
          },
          onToolResult: (name, params, r) => {
            seq += 1;
            touch();
            const argsDigest = _sha12(JSON.stringify(params == null ? '' : params));
            const outText = r && typeof r === 'object' ? String(r.output != null ? r.output : '') : String(r == null ? '' : r);
            const isError = !!(r && (r.is_error === true || r.success === false));
            const isGatewayRefusal =
              outText.indexOf('--allowedTools') !== -1 || outText.indexOf('--disallowedTools') !== -1;
            ledger({
              seq,
              ts: now(),
              kind: 'tool_result',
              tool: String(name || ''),
              argsDigest,
              resultDigest: _sha12(outText.slice(0, 2000)),
              error: isError || isGatewayRefusal,
            });
            if (isGatewayRefusal) {
              denies += 1;
              recentEvents.push('deny');
              disclosures.push(`seq=${seq} 网关拒绝：工具 ${name} 不在惯性单白名单（−${decay.denyPenalty}）`);
            } else if (isError) {
              consecutiveErrors += 1;
              recentEvents.push('error');
            } else {
              consecutiveErrors = 0;
              // 重复签名判定（§3.5：与近窗 tool+argsDigest 相同 → repeat；新签名 → 中性不记账）
              const sig = String(name || '') + ':' + argsDigest;
              if (recentArgSignatures.indexOf(sig) !== -1) {
                recentEvents.push('repeat');
              } else {
                recentArgSignatures.push(sig);
                if (recentArgSignatures.length > 10) {
                  recentArgSignatures.shift();
                }
              }
            }
          },
          onCost: (tu) => {
            const c = Number(tu && (tu.costCny != null ? tu.costCny : tu.cost_cny));
            if (Number.isFinite(c) && c > 0) {
              costSeen = true;
              costCny += c;
            }
          },
        });
      } catch (e) {
        consecutiveErrors += 1;
        ledger({ seq: ++seq, ts: now(), kind: 'error', error: String((e && e.message) || e).slice(0, 300) });
        stop = { stop: 'error', reason: 'loop_exception' };
        break;
      }

      turnsTotal += Number(res && res.iterations) || 0;
      lastReply = String((res && res.finalResponse) || '');
      if (res && res.executedCallKeys instanceof Map && res.executedCallKeys.size > 0) {
        inheritedDedupKeys = res.executedCallKeys; // Ralph Loop :589-592 同源：续推不重跑已执行调用
      }

      // completion 探针（§3.4 completed；机械执行）——先探针后动量（progress = 探针结果变化）
      lastProbe = probeFn(plan.completion, cwd);
      ledger({
        seq: ++seq,
        ts: now(),
        kind: 'probe',
        command: plan.completion.command,
        exit: lastProbe.exit,
        ok: !!lastProbe.ok,
      });
      touch();

      // 段末动量结算（§3.5：每轮按事件调整）
      const segEvents = recentEvents.slice();
      if (lastProbe) {
        if (prevProbeExit === null || lastProbe.ok || lastProbe.exit !== prevProbeExit) {
          segEvents.push('progress'); // 探针结果变化（或首次运行/命中）= 可测进度
        } else {
          segEvents.push('no_progress'); // 探针结果无变化 = 本段空转（换词绕圈子的机械代理）
        }
      }
      prevProbeExit = lastProbe ? lastProbe.exit : null;
      if (segEvents.length === 0) {
        segEvents.push('no_progress'); // 段内零事件（纯叙述/零工具调用）= 空转
      }
      const mm = nextMomentum(momentum, segEvents, decay);
      momentum = mm.momentum;
      ledger({
        seq: ++seq,
        ts: now(),
        kind: 'momentum',
        events: segEvents,
        momentum: Number(momentum.toFixed(4)),
        costDelta: Number(costCny.toFixed(4)),
      });
      recentEvents = [];

      // 影子判定（S1 不真停 decay；S2 按样本校准后启用）
      if (momentum < decay.stopBelow && shadow.firstDecayStopSeq === null) {
        shadow.firstDecayStopSeq = seq;
        shadow.firstDecayMomentum = Number(momentum.toFixed(4));
        disclosures.push(
          `影子：若启用 S2 动量停车，将在 seq=${seq} 停（momentum=${momentum.toFixed(2)} < stopBelow=${decay.stopBelow}）——S1 继续跑满对照`
        );
      }
      if (denies >= budget.maxDenies && shadow.firstPrivilegeStopSeq === null) {
        shadow.firstPrivilegeStopSeq = seq;
      }

      // 检查点（boulderState，task_id=runId；best-effort）
      if (boulder) {
        try {
          boulder.saveBoulderState(cwd, {
            taskId: runId,
            userMessage: plan.goal,
            toolCallLog: Array.isArray(res && res.toolCallLog) ? res.toolCallLog : [],
            iterations: turnsTotal,
            status: 'in_progress',
            currentMessage: lastReply.slice(0, 4000),
            sessionMeta: { adapter: plan.model.preferredAdapter, model: '', sessionId: '' },
          });
        } catch {
          /* 检查点尽力而为 */
        }
      }

      // 硬拒/歧义刹车 → 真停（§3.4 privilege/ambiguity）
      if (hardDenyHit) {
        stop = { stop: 'privilege', reason: 'hard_deny:' + hardDenyHit };
        disclosures.push(
          `seq=${seq} 硬拒命中（${hardDenyHit}）：已刹车停跑。诚实披露：该条命令与检测同批，可能已执行一次`
        );
        break;
      }
      if (ambiguityHit) {
        stop = { stop: 'ambiguity', reason: 'model_decision_request' };
        break;
      }

      // 探针已在本段末运行过；此处只做 completed 判停
      if (lastProbe && lastProbe.ok) {
        stop = { stop: 'completed', reason: 'completion_probe_green' };
        break;
      }

      // 外部停：租约到期
      const lease = _readJson(leasePath);
      if (!lease || Number(lease.expiresAt) <= now()) {
        stop = { stop: 'external', reason: 'lease_expired' };
        break;
      }
      if (interruptedByController && !hardDenyHit && !ambiguityHit) {
        stop = stop || { stop: 'external', reason: 'abort_signal' };
        break;
      }
      // 探针不绿 → 惯性续推（while 顶部预算检查兜底）
    }
  } finally {
    // 恢复进程级 gateway 状态（不污染同进程其他路径）
    if (gateway) {
      try {
        gateway.clearToolAccessGateway();
      } catch {
        /* ignore */
      }
    }
  }

  // deny 计数超限的 privilege 真停（段内累积，段顶 decideStop 也会拦）
  if (!stop && denies >= budget.maxDenies) {
    stop = { stop: 'privilege', reason: 'deny_budget_exhausted' };
  }
  if (!stop) {
    stop = { stop: 'budget', reason: 'turns' };
  }

  // 终态检查点
  if (boulder) {
    try {
      const finalStatus = stop.stop === 'completed' ? 'completed' : stop.stop === 'budget' ? 'interrupted' : 'failed';
      boulder.saveBoulderState(cwd, {
        taskId: runId,
        userMessage: plan.goal,
        iterations: turnsTotal,
        status: finalStatus,
        interruptReason: stop.stop + ':' + stop.reason,
        currentMessage: lastReply.slice(0, 4000),
      });
    } catch {
      /* ignore */
    }
  }

  // lease 释放（run 已完结；目录与账本保留供回放）
  try {
    fs.unlinkSync(leasePath);
  } catch {
    /* ignore */
  }

  const wallMs = now() - t0;
  const remainingTurns = Math.max(0, budget.maxTurns - turnsTotal);
  if (!costSeen) {
    disclosures.push('cost 未知（免费通道常见）：costCny 记 0，turns 为主闸（方案 §8.1 降级语义）');
  }
  if (ledgerWriteFailed) {
    disclosures.push('ledger.jsonl 写入中途失败：账本不完整（信封为准）');
  }

  const envelope = {
    ok: stop.stop === 'completed',
    status: stop.stop,
    statusReason: stop.reason,
    runId,
    planHash,
    kickedBy,
    outcome: lastProbe
      ? {
          command: plan.completion.command,
          exit: lastProbe.exit,
          expectExit: plan.completion.expectExit,
          green: !!lastProbe.ok,
        }
      : null,
    stats: { turns: turnsTotal, toolCalls, costCny: Number(costCny.toFixed(4)), wallMs },
    shadow,
    disclosures,
    resume: {
      canResume: !lastProbe?.ok && remainingTurns > 0,
      checkpointTaskId: runId,
      remainingBudget: { turns: remainingTurns },
      openQuestions: [],
      contextDigest: _buildDigest(plan, stop, turnsTotal, toolCalls, lastProbe, lastReply),
    },
  };

  ledger({ seq: ++seq, ts: now(), kind: 'stop', status: envelope.status, reason: envelope.statusReason, stats: envelope.stats });
  _writeText(resultPath, JSON.stringify(envelope, null, 2));

  write(
    `\n[惯性执行 ${runId}] 停机 status=${envelope.status} (${envelope.statusReason})｜` +
      `turns=${envelope.stats.turns}/${budget.maxTurns}｜tools=${toolCalls}｜` +
      `探针 ${lastProbe && lastProbe.ok ? '✓' : '✗'}(${lastProbe ? lastProbe.exit : '?'})｜` +
      `momentum=${momentum.toFixed(2)}｜${wallMs}ms\n` +
      `  账本：${path.join(runDir, 'ledger.jsonl')}\n` +
      `  信封：${resultPath}\n`
  );

  return envelope;
}

// ── 工具调用分类（机械事件判定） ────────────────────────────────────────

function _classifyToolCall(name, params, plan, hooks) {
  const tool = String(name || '');
  // AskUserQuestion = 模型显式发出需决策信号（§3.4 ambiguity 行）
  if (tool === 'AskUserQuestion') {
    hooks.doStop({ stop: 'ambiguity', reason: 'model_decision_request' });
    return 'deny';
  }
  if (tool === 'Bash') {
    const command = String((params && (params.command || params.cmd)) || '');
    const verdict = evaluateCommandAuthorization(command, plan);
    if (verdict.decision === 'hard_deny') {
      hooks.setHardDeny(verdict.matchedBy);
      return 'deny';
    }
    if (verdict.decision === 'deny') {
      hooks.addDeny();
      hooks.note(`bash 越权（未命中 allow 白名单）：${command.slice(0, 120)}`);
      return 'deny';
    }
  }
  return null; // 中性：不在动量上记账（progress 由探针 delta 判定，§3.5）
}

// ── contextDigest（§3.7 四段式，机械汇总 ≤2000 字） ────────────────────

function _buildDigest(plan, stop, turns, toolCalls, probe, lastReply) {
  const seg1 = `目标：${plan.goal}`;
  const seg2 = `已完成：${turns} 轮迭代、${toolCalls} 次工具调用；末轮收尾：${String(lastReply || '').slice(0, 500) || '(无)'}`;
  const seg3 =
    `未完成：${
      probe && probe.ok ? '达成判据已命中' : `探针 \`${plan.completion.command}\` 退出码 ${probe ? probe.exit : '?'} ≠ ${plan.completion.expectExit}`
    }；停机：${stop.stop}(${stop.reason})`;
  const seg4 = `下一步选项：resume 语义 S2 提供；当前可人工接管，或修正后重跑 khy inertia run（同一惯性单文件，planHash 不变）`;
  return [seg1, seg2, seg3, seg4].join('\n').slice(0, 2000);
}

function _lazyBoulder() {
  try {
    return require('../boulderState');
  } catch {
    return null;
  }
}

module.exports = {
  runInertialPlan,
  planHashOf,
  // 内部纯逻辑导出（供单测；运行时不需要）
  _generateRunId,
  _kickMessage,
  _continueMessage,
  _buildDigest,
  _classifyToolCall,
  SCHEMA_VER,
};
