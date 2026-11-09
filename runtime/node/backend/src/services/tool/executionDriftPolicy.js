'use strict';

/**
 * executionDriftPolicy.js — 执行漂移读数（S1 观察者；纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * 已认领的缺口：工具循环里已有四套判据，各自止步点不同——
 *   · ToolLoopDetector 判「原地打转」（重复 / 无进展 / 乒乓 / 读文件循环）；
 *   · devCourseMonitor 判「回归 / 无验证狂奔 / 反复改同一文件 / 连续失败」并注入航向提示；
 *   · goalStopGate 判「目标声明的完成标准有没有证据」，但只在 goal 模式生效；
 *   · docVsMeasuredPolicy 判「草稿引述了本回合没碰过的仓内路径」。
 * 四者都不回答「这一轮的动作还在不在本轮请求的锚点上」，于是跑偏要等撞上
 * max-iterations 才暴露 —— 那已经太晚。devCourseMonitor 负责「劝」，本叶子只负责「记」，
 * 判据不重叠：它看改动节奏，本叶子看动作与原始请求的锚点关系。
 *
 * 本叶子只观察、不改控制流：调用方在轮首与收尾各调一次，observed:true 时往既有
 * toolLoopJournal 写 event 'exec-drift'。不 nudge / 不 continue / 不改输出。
 * 门控 KHY_EXEC_DRIFT（默认开，仅显式 0/false/off/no 关；关 → 两个观察函数都返
 * observed:false，接缝逐字节回退到「不观察」）。
 *
 * 四条判据全部确定性、零模型：
 *   anchor-unused         连续 N 轮没有任何工具动作触碰用户消息点名的路径/标识符
 *   plan-unfinished       第 1 轮解析出计划（≥2 步），收尾时仍有未完成步骤
 *   acceptance-skipped    用户消息点名了命令，该 run 从未执行
 *   unverified-completion 宣布完成，但本 run 零工具调用，或声称测试/构建通过却没跑过
 *
 * 阶段 S1（PROCESS-008）：只记录、不阻断。样本落 toolLoopJournal 的 exec-drift 事件，
 * 累计 ≥200 条且无误报解释不了前不升阶。
 *
 * @module services/tool/executionDriftPolicy
 */

const STAGE = 'S1';

/** 连续多少轮没碰锚点才记 anchor-unused。 */
const ANCHOR_UNUSED_ROUNDS = 3;
const ANCHOR_CAP = 8;

const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry（集中优先级 + dogfood），不可用时回退本地词表。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../../utils/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_EXEC_DRIFT', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_EXEC_DRIFT;
  return !(v !== undefined && OFF_WORDS.has(String(v).trim().toLowerCase()));
}

const CODE_EXT = 'js|jsx|ts|tsx|mjs|cjs|json|md|py|vue|css|scss|html|sh|ps1|ya?ml|toml|sql|db|log|txt|ini|cfg|conf';
// 两种书写：带分隔符的路径（/d/xxx、./src/a、src/host/index.ts），或带已知扩展名的文件名。
// 首段必须是盘符/./../ 或绝对路径，且前面不能紧贴字母数字 —— 否则 "and/or" 里的 "/or"
// 会被当成路径锚点，anchor-unused 从此永远误报。
const PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_.@-])(?:(?:[A-Za-z]:[\\\\/]|[./]{1,2}[\\\\/]|/)[A-Za-z0-9_.@-]+(?:[\\\\/][A-Za-z0-9_.@-]+)*|[A-Za-z0-9_.@-]+(?:[\\\\/][A-Za-z0-9_.@-]+)*\\.(?:${CODE_EXT}))\\b`,
  'g'
);
const URL_RE = /https?:\/\/\S+/g;
const TICK_RE = /`([^`\n]{1,200})`/g;
const LINE_RE = /^[ \t]*([^\n]{1,200})$/gm;

// 命令前缀：只认「真的能被执行」的形态，避免把普通英文句子当命令。
const CMD_PREFIXES = [
  'npm run',
  'npm test',
  'npm install',
  'node ',
  'khy ',
  'git ',
  'python ',
  'python3 ',
  'pip ',
  'npx ',
  'yarn ',
  'pnpm ',
  'cargo ',
  'go test',
  'jest',
  'vitest',
  'pytest',
  'tsc',
];

// 完成词。判定前先看前 4 个字符有无否定词，避免把「未完成 / 没修好」当成功。
const COMPLETION_RE = new RegExp(
  '(已完成|完成了|已搞定|搞定了|已修复|修好了|已实现|已添加|已改好|已处理|已解决|全部通过|测试通过|构建成功|编译通过|跑通了|done\\b|fixed\\b|implemented\\b|all tests pass)',
  'gi'
);
const TEST_CLAIM_RE = new RegExp(
  '(测试[^，。；\\n]{0,8}通过|全部通过|构建成功|编译通过|tests? pass|build succeed)',
  'gi'
);
const NEGATION_RE = /[未没不无]/;
// 「别跑 npm test」不是验收命令：紧贴命令的否定动词（别跑/不要执行/禁止修改…）后面不收。
// 只看到命令前 ≤4 个非标点字符，避免「先别管，改完跑 npm test」里的别把真命令也吞掉。
const CMD_NEGATION_RE = /(?:别|不要|不用|无需|禁止|勿|不必)[^。；，,！!？?\n]{0,4}$/;
const VERIFY_CMD_RE =
  /(npm (?:run )?(?:test|check|lint|build|typecheck)|node --test|jest\b|vitest\b|pytest\b|tsc\b|cargo test|go test|check-[a-z-]+\.js)/i;

function _clip(list, cap) {
  return list.slice(0, cap);
}

function _normalizePath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  if (!p) return '';
  p = p.replace(/\\/g, '/');
  p = p.replace(/:\d+(?::\d+)?$/, '');
  p = p.replace(/[.,;:!?。，；、）)】\]"'`]+$/, '');
  if (p.length < 3) return '';
  if (!/[A-Za-z]/.test(p)) return '';
  return p;
}

function _normalizeCommand(raw) {
  let c = String(raw == null ? '' : raw).trim();
  if (!c) return '';
  c = c.replace(/\s+/g, ' ').replace(/[。，；、]+$/, '');
  return c;
}

/**
 * 从用户消息里提取本轮请求的锚点。
 * 只认三类可机判的东西：路径、命令、反引号里的符号名。提取不到 = 没有锚点，
 * 观察函数一律 observed:false —— 宁可不记，也不拿「我以为的锚点」制造噪声。
 * @param {string} userMessage
 * @returns {{paths:string[], commands:string[], identifiers:string[]}}
 */
function buildAnchors(userMessage) {
  const out = { paths: [], commands: [], identifiers: [] };
  try {
    const text = String(userMessage == null ? '' : userMessage);
    if (!text) return out;

    const seenPath = new Set();
    const addPath = (raw) => {
      const p = _normalizePath(raw);
      if (!p || seenPath.has(p)) return;
      seenPath.add(p);
      if (out.paths.length < ANCHOR_CAP) out.paths.push(p);
    };

    // URL 先剔掉：它的路径段不是仓内路径，混进来会让 anchor-unused 永远误报。
    const stripped = text.replace(URL_RE, ' ');

    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(stripped)) !== null) {
      addPath(m[0]);
    }

    const seenCmd = new Set();
    const addCmd = (raw, at) => {
      const c = _normalizeCommand(raw);
      if (!c || seenCmd.has(c)) return;
      const low = c.toLowerCase();
      if (!CMD_PREFIXES.some((prefix) => low.startsWith(prefix))) return;
      // 「别跑 `npm test`」不是验收命令。只看同一行前缀，避免上一行的否定词误伤本行。
      const prefix = text.slice(Math.max(0, Number(at) - 12), Number(at));
      const before = prefix.slice(prefix.lastIndexOf('\n') + 1).replace(/[ \t]+$/, '');
      if (CMD_NEGATION_RE.test(before)) return;
      seenCmd.add(c);
      if (out.commands.length < ANCHOR_CAP) out.commands.push(c);
    };
    TICK_RE.lastIndex = 0;
    while ((m = TICK_RE.exec(text)) !== null) {
      addCmd(m[1], m.index);
    }
    LINE_RE.lastIndex = 0;
    while ((m = LINE_RE.exec(text)) !== null) {
      addCmd(m[1], m.index + m[0].indexOf(m[1]));
    }

    const seenId = new Set();
    const addId = (raw) => {
      const id = String(raw == null ? '' : raw).trim().replace(/\(\)$/, '');
      if (!/^[A-Za-z_$][\w$]*$/.test(id) || id.length < 4) return;
      // 只收看起来像符号名的：带下划线/$,或驼峰。普通英文词太容易误碰。
      if (!/[_$]/.test(id) && !/[a-z][A-Z]/.test(id)) return;
      if (seenId.has(id)) return;
      seenId.add(id);
      if (out.identifiers.length < ANCHOR_CAP) out.identifiers.push(id);
    };
    TICK_RE.lastIndex = 0;
    while ((m = TICK_RE.exec(text)) !== null) {
      addId(m[1]);
    }
  } catch {
    /* 提取失败 = 没有锚点，绝不抛 */
  }
  return out;
}

function _blobOf(entry) {
  try {
    const params = entry && entry.params ? JSON.stringify(entry.params) : '';
    return `${String((entry && entry.tool) || '')} ${params}`.replace(/\\/g, '/');
  } catch {
    return String((entry && entry.tool) || '');
  }
}

function _pathHit(blob, normPath) {
  if (!blob || !normPath) return false;
  if (blob.includes(normPath)) return true;
  const base = normPath.slice(normPath.lastIndexOf('/') + 1);
  // 短基名（a.ts / b.js）出现在任意参数里太容易误碰，要求 ≥8 字符。
  return base.length >= 8 && blob.includes(base);
}

function _idHit(blob, id) {
  if (!blob || !id) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${id.replace(/[$]/g, '\\$')}(?:$|[^A-Za-z0-9_$])`).test(blob);
}

function _cmdHit(blob, cmd) {
  if (!blob || !cmd) return false;
  const normBlob = String(blob).replace(/\s+/g, ' ');
  return normBlob.includes(cmd);
}

function _roundsOf(toolCallLog) {
  const by = new Map();
  for (const entry of Array.isArray(toolCallLog) ? toolCallLog : []) {
    const it = Number(entry && entry.iteration);
    if (!Number.isFinite(it)) continue;
    if (!by.has(it)) by.set(it, []);
    by.get(it).push(entry);
  }
  return by;
}

function _roundTouchesAnchors(entries, anchors) {
  for (const entry of entries) {
    const blob = _blobOf(entry);
    for (const p of anchors.paths) {
      if (_pathHit(blob, p)) return true;
    }
    for (const id of anchors.identifiers) {
      if (_idHit(blob, id)) return true;
    }
  }
  return false;
}

function _claimsMatch(text, re) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const before = s.slice(Math.max(0, m.index - 4), m.index);
    if (!NEGATION_RE.test(before)) return true;
  }
  return false;
}

function _hasVerificationCall(toolCallLog) {
  for (const entry of Array.isArray(toolCallLog) ? toolCallLog : []) {
    if (VERIFY_CMD_RE.test(_blobOf(entry))) return true;
  }
  return false;
}

function _isGoalActive(hasGoal) {
  return hasGoal === true;
}

const EMPTY = { observed: false, findings: [] };

/**
 * 轮首观察：只看 anchor-unused。这一轮的动作是否还在本轮请求的锚点上。
 *
 * 调用时机是「上一轮的结果已齐备、下一轮即将开始」，所以分组一律用 toolCallLog
 * 条目自带的 iteration，不信调用方传进来的轮号（journal 的 iteration 有 grace 语义）。
 * @param {{userMessage?:string, toolCallLog?:Array, iteration?:number}} input
 * @param {object} [opts] {env}
 * @returns {{observed:boolean, findings:Array<{code:string, evidence:object}>}}
 */
function observeRound(input, opts = {}) {
  try {
    if (!isEnabled((opts && opts.env) || process.env)) return EMPTY;
    const i = input && typeof input === 'object' ? input : {};
    const anchors = buildAnchors(i.userMessage);
    if (anchors.paths.length === 0 && anchors.identifiers.length === 0) return EMPTY;

    const byRound = _roundsOf(i.toolCallLog);
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    if (rounds.length < ANCHOR_UNUSED_ROUNDS) return EMPTY;
    // 只有「刚落幕的那一轮确实产生过调用」才判：轮首调用发生在第 K 轮，日志里最后一轮
    // 应是 K-1。否则纯文本轮（被 nudge 顶回）会让同一段漂移每轮重记一条。
    const current = Number(i.iteration);
    if (Number.isFinite(current) && rounds[rounds.length - 1] !== current - 1) return EMPTY;

    const tail = rounds.slice(-ANCHOR_UNUSED_ROUNDS);
    for (const round of tail) {
      if (_roundTouchesAnchors(byRound.get(round), anchors)) return EMPTY;
    }
    // 边沿触发：只在「刚跨进连续 N 轮不碰锚点」时记一次。否则往后每一轮都会再记一条
    // 同样的读数，样本被同一次漂移灌满，S1 的 200 条门槛就失去意义。
    const priorIndex = rounds.length - ANCHOR_UNUSED_ROUNDS - 1;
    if (priorIndex >= 0 && !_roundTouchesAnchors(byRound.get(rounds[priorIndex]), anchors)) {
      return EMPTY;
    }

    let lastHit = null;
    for (const round of rounds) {
      if (_roundTouchesAnchors(byRound.get(round), anchors)) lastHit = round;
    }
    return {
      observed: true,
      findings: [
        {
          code: 'anchor-unused',
          evidence: {
            rounds: tail,
            lastHitRound: lastHit,
            anchors: _clip([...anchors.paths, ...anchors.identifiers], ANCHOR_CAP),
          },
        },
      ],
    };
  } catch {
    return EMPTY;
  }
}

/**
 * 收尾观察：模型不再调工具、准备交付时判三条。
 *
 * unverified-completion 在 goal 模式下跳过 —— goalStopGate 已经按目标声明的完成标准
 * 逐条核对证据，这里再记一遍只是同一件事的第二份账。
 * @param {{userMessage?:string, toolCallLog?:Array, plan?:object, draft?:string, hasGoal?:boolean}} input
 * @param {object} [opts] {env}
 * @returns {{observed:boolean, findings:Array<{code:string, evidence:object}>}}
 */
function observeConclusion(input, opts = {}) {
  try {
    if (!isEnabled((opts && opts.env) || process.env)) return EMPTY;
    const i = input && typeof input === 'object' ? input : {};
    const findings = [];
    const log = Array.isArray(i.toolCallLog) ? i.toolCallLog : [];

    const plan = i.plan && Array.isArray(i.plan.steps) ? i.plan : null;
    if (plan && plan.steps.length >= 2) {
      const pending = plan.steps.filter((s) => s && s.status !== 'completed');
      if (pending.length > 0) {
        findings.push({
          code: 'plan-unfinished',
          evidence: {
            total: plan.steps.length,
            pending: _clip(
              pending.map((s) => ({ id: s.id, status: s.status || 'pending', description: String(s.description || '').slice(0, 80) })),
              ANCHOR_CAP
            ),
          },
        });
      }
    }

    const anchors = buildAnchors(i.userMessage);
    if (anchors.commands.length > 0) {
      const missing = anchors.commands.filter((cmd) => {
        return !log.some((entry) => _cmdHit(_blobOf(entry), cmd));
      });
      if (missing.length > 0) {
        findings.push({
          code: 'acceptance-skipped',
          evidence: { commands: _clip(missing, ANCHOR_CAP), total: anchors.commands.length },
        });
      }
    }

    if (!_isGoalActive(i.hasGoal) && _claimsMatch(i.draft, COMPLETION_RE)) {
      const noCalls = log.length === 0;
      const claimsVerified = _claimsMatch(i.draft, TEST_CLAIM_RE);
      const missingEvidence = noCalls || (claimsVerified && !_hasVerificationCall(log));
      if (missingEvidence) {
        findings.push({
          code: 'unverified-completion',
          evidence: {
            toolCalls: log.length,
            claimed: _clip(claimsVerified ? ['tests-or-build'] : [], ANCHOR_CAP),
            reason: noCalls ? 'zero-tool-calls' : 'claim-without-verification-call',
          },
        });
      }
    }

    return { observed: findings.length > 0, findings };
  } catch {
    return EMPTY;
  }
}

module.exports = {
  STAGE,
  ANCHOR_UNUSED_ROUNDS,
  isEnabled,
  buildAnchors,
  observeRound,
  observeConclusion,
};
