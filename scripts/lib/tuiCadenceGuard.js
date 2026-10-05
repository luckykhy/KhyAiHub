'use strict';

/**
 * tuiCadenceGuard.js — `RUNTIME-011`「TUI 动画节拍三方一致」的**纯判定叶子**。
 *
 * 零 IO、确定性、绝不抛、可离线单测。读源 / 走盘 / 打印全部在
 * `scripts/ci/check-tui-cadence.js`；本文件只做判定。
 *
 * ## 为什么需要它（判据真源：[DESIGN-PERF-004] §7 防呆铁律 R1–R3）
 *
 * TUI 的动画节拍有三个可能各说各话的地方：**规范表**（`tui/AGENTS.md` §3.3）、
 * **实现真源**（`perfTunables.js` 的默认值）、**组件兜底字面量**（`Spinner.js` 的
 * `FRAME_MS`、`topicBar.js` 的 `_ANIM_MS`）。三者漂移时**没有任何一处会报错** ——
 * 用户看到的是「动画一顿一顿」，而所有守卫全绿。
 *
 * 实测（2026-09-29，[DESIGN-PERF-004] §2.1）：Spinner 规范写 80ms、实现跑 160ms，
 * 漂移 ×2.00，**存在了很久没人发现**。`perfTunables.js:9-19` 的头部注释正是那次
 * 降频决策的现场，而它自陈的「no functional change」把视觉质量排除在 functional 之外。
 *
 * | id | 判据 | 对应铁律 |
 * |---|---|---|
 * | `cadence-drift` | 绑定的规范值 ≠ 实现默认值（**未裁决**的漂移） | R1 |
 * | `cadence-drift-known` | 同上，但已裁决保留（见 `KNOWN_DRIFTS`）⇒ info | R1 |
 * | `binding-orphan` | 绑定表指向的规范行不存在（表改名了，绑定表没跟） | R1 |
 * | `spec-unreadable` | §3.3 表读不到（判据不可信） | R1 |
 * | `fallback-drift` | 组件兜底值 ≠ 规范值 | R2 |
 * | `fallback-drift-known` | 兜底对齐的是「已裁决的实现值」⇒ info，非违规 | R2 |
 * | `fallback-unreadable` | 兜底值抽取失败（正则与源码不同形） | R2 |
 * | `unbound-spec` | 规范行未纳入对账（绑定表里没有它） | R3 |
 * | `unbound-impl` | `perfTunables` 导出在 §3.3 表里无对应行 | R3 |
 *
 * ⚠ **`unbound-*` 是「缺口盘点」，不是「违规」** —— 它们说明现状（有多少项没被对账），
 * 所以 S1 记 info。这正是 `topicBar` 曾被随手放宽到 320ms 的机制：**表里没有它，
 * 它就无规范可依**（[DESIGN-PERF-004] §6 A0-a）。
 *
 * ⚠ **`unbound-impl` 在 S3 仍为 info**：`R3` 的字面判据是「表 → 导出」单向的；
 * 「导出 → 表」这个反方向本规则**未立判据**，故只盘点不判违规。要升档须先在
 * `[DESIGN-PERF-004]` §7 补一条铁律，不得由守卫自行加严。
 */

const SEV = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

/**
 * 判据强度表 —— **唯一**的强度决定点（`PROCESS-006` PP-3）。
 *
 * ⚠ 绝不在判定处写死 `warning`：那会让执行器的 `STAGE` 常量变成**装饰** ——
 * S1 与 S3 跑出完全相同的输出与退出码，升阶后**仍不拦截**，而所有守卫全绿
 * （登记表说 S3、源码常量 S3、`check-rollout-stage.js` 漂移比对也过）。
 * 验收判据：同一输入在 S1/S3 下 **error 数必须不同**（见测试 `S1/S3 强度差异`）。
 *
 * S1 列刻意等于原型（`.khyos/diag/tui-cadence-guard.js`）的实测 baseline
 * （**0 error / 0 warning / 7 info**），这样「接线」这一步不改变任何既有读数。
 */
const CRITERIA = Object.freeze({
  'cadence-drift': { rule: 'R1', s1: SEV.WARNING, s3: SEV.ERROR },
  'cadence-drift-known': { rule: 'R1', s1: SEV.INFO, s3: SEV.INFO },
  'binding-orphan': { rule: 'R1', s1: SEV.WARNING, s3: SEV.ERROR },
  'spec-unreadable': { rule: 'R1', s1: SEV.WARNING, s3: SEV.ERROR },
  'fallback-drift': { rule: 'R2', s1: SEV.WARNING, s3: SEV.ERROR },
  'fallback-drift-known': { rule: 'R2', s1: SEV.INFO, s3: SEV.INFO },
  'fallback-unreadable': { rule: 'R2', s1: SEV.WARNING, s3: SEV.ERROR },
  'unbound-spec': { rule: 'R3', s1: SEV.INFO, s3: SEV.ERROR },
  'unbound-impl': { rule: 'R3', s1: SEV.INFO, s3: SEV.INFO },
});

/** 阶段派生：按 `CRITERIA` 表取值；未知判据一律降为 warning（禁 fail-open 到 error）。 */
function severityFor(criterion, stage = 'S1') {
  const row = CRITERIA[criterion];
  if (!row) return SEV.WARNING;
  return stage === 'S3' || stage === 'S4' ? row.s3 : row.s1;
}

/** 内部 severity 只存小写规范形；渲染时经此映射成**定宽 6 字符**方言。 */
function labelOf(severity) {
  if (severity === SEV.ERROR) return '[ERROR]';
  if (severity === SEV.INFO) return '[INFO ]';
  return '[WARN ]';
}

/** 判据 → 铁律编号（`[DESIGN-PERF-004]` §7）。 */
function ruleOf(criterion) {
  const row = CRITERIA[criterion];
  return row ? row.rule : 'R?';
}

// ── 事实表 ──────────────────────────────────────────────────────────────────

const SPEC_FILE = 'runtime/node/backend/src/cli/tui/AGENTS.md';
const IMPL_FILE = 'runtime/node/backend/src/cli/tui/perfTunables.js';

/**
 * 绑定表：规范表行名 ↔ `perfTunables` 导出名 ↔ 组件兜底值所在文件。
 *
 * 只登记**真正完成对账**的绑定（`spec` 与 `impl` 都非空）。两侧名字不同是客观事实
 * （中文表头 vs 代码标识符），无法自动推导 ⇒ 必须显式登记；而登记表会腐化
 * （规范表改名后没人跟），所以 `evaluate()` 报 `binding-orphan`。
 *
 * 未登记的项**不需要**写进来 —— 规范表有、这里没有 ⇒ 自动报 `unbound-spec`；
 * `perfTunables` 有导出、这里没有 ⇒ 自动报 `unbound-impl`。**少写比多写安全**。
 *
 * ⚠ `fallbackFile` 是**仓库相对路径**（本叶子不碰 `path`/`fs`，相对化在采集侧做）。
 */
const BINDINGS = Object.freeze([
  {
    spec: 'Spinner',
    impl: 'spinnerFrameMs',
    fallbackFile: 'runtime/node/backend/src/cli/tui/ink-components/Spinner.js',
    fallbackRe: /let\s+FRAME_MS\s*=\s*(\d+)/,
  },
  {
    spec: 'topicBar',
    impl: 'topicBarAnimMs',
    fallbackFile: 'runtime/node/backend/src/cli/tui/runtime/topicBar.js',
    fallbackRe: /let\s+_ANIM_MS\s*=\s*(\d+)/,
  },
  { spec: '状态栏', impl: 'heartbeatMs', fallbackFile: null, fallbackRe: null },
]);

/**
 * **已知且已裁决**的漂移白名单（key = `${spec}|${impl}`）。
 *
 * 与「意外漂移」区别对待：命中者降为 info 并附出处，未命中者保持 warning。
 * 为什么需要它（2026-09-29 实测）：Spinner 的 `160 vs §3.3 的 80` 是**有意保留**的
 * 裁决结果（`[DESIGN-ARCH-101]` §8 冲突 1），但守卫若把它与意外漂移同等报 warning，
 * 观察者就会长期挂着一条消不掉的 warning，然后学会无视它 —— **告警疲劳比不报更糟**。
 */
const KNOWN_DRIFTS = Object.freeze({
  'Spinner|spinnerFrameMs':
    '160ms 是裁决值（[DESIGN-ARCH-101] §8 冲突 1：以 perfTunables 160ms 为准，'
    + '80ms 判为陈旧第三源）；收敛 §3.3 与 BootScreen 属 P1（D10，[DESIGN-ARCH-115] §2.2）。'
    + '见 perfTunables 头部 Background。',
});

// ── 解析（纯函数，输入字符串） ──────────────────────────────────────────────

/**
 * 解析 `tui/AGENTS.md` §3.3「计时器优先级」表。
 *
 * 行首定位一律用 `[ \t]*`，**不用 `\s*`** —— `\s` 含 `\n` 会跨行，行号会差 1（本仓实测过）。
 *
 * @param {string} md
 * @returns {{rows: Array<{name:string, ms:number, line:number}>, error: string|null}}
 */
function parseSpecTable(md) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  const start = lines.findIndex((l) => /^###[ \t]*3\.3[ \t]/.test(l));
  if (start < 0) return { rows: [], error: 'AGENTS.md 里找不到 §3.3 小节' };

  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^###/.test(l)) break; // 进入下一小节
    // | 名字 | 80ms | 优先级 | 说明 |
    const m = l.match(/^\|[ \t]*([^|]+?)[ \t]*\|[ \t]*(\d+)[ \t]*ms[ \t]*\|/);
    if (m && m[1] !== '计时器') rows.push({ name: m[1], ms: Number(m[2]), line: i + 1 });
  }
  if (rows.length === 0) return { rows, error: '§3.3 表解析出 0 行' };
  return { rows, error: null };
}

/**
 * 从组件源码抽取节拍**兜底值**（`let FRAME_MS = 80`）。
 *
 * 抽取型扫描必须带「抽到几条」自校验：抽不到要**报错**而不是静默继续
 * （否则正则与源码不同形时，R2 会静默失效 —— 那是最危险的假绿）。
 *
 * @param {string} src
 * @param {RegExp|null} re
 * @returns {{value: number|null, line: number|null, error: string|null}}
 */
function extractFallback(src, re) {
  if (!re) return { value: null, line: null, error: null };
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (m) return { value: Number(m[1]), line: i + 1, error: null };
  }
  return { value: null, line: null, error: '未抽到兜底值（正则与源码不同形？）' };
}

/**
 * 从 leaf 模块**动态**枚举节拍旋钮（`fn(env) → number`）。
 *
 * 为什么不能手写清单：原型初版把 impl 写成手写对象字面量，于是 2026-09-29 给
 * `perfTunables` 新增 `taskSnapshotTtlMs` 后本守卫**静默漏掉**它 —— 手写清单会腐化，
 * 且腐化时无声。判据收窄：只收 `typeof v === 'function' && v.length <= 1`
 * （旋钮一律是 `fn(env)`；`heartbeatAlignDelayMs(now, started, cad)` 是 3 参的
 * **纯计算**，不是旋钮，按 arity 排除）。
 *
 * @param {object} mod
 * @param {object} env
 * @returns {Record<string, number>}
 */
function loadImpl(mod, env) {
  const impl = {};
  for (const [k, v] of Object.entries(mod || {})) {
    if (typeof v !== 'function' || v.length > 1) continue;
    let out;
    try {
      out = v(env);
    } catch {
      continue;
    }
    if (typeof out === 'number' && Number.isFinite(out)) impl[k] = out;
  }
  return impl;
}

// ── 判定核心 ────────────────────────────────────────────────────────────────

/**
 * @param {{spec: {rows: Array, error: string|null}, impl: object,
 *          fallbacks: object, bindings: Array}} input
 * @param {{stage?: string}} [ctx]
 * @returns {Array<{criterion:string, severity:string, file:string, line:number|null,
 *                  message:string}>}
 */
function evaluate(input, ctx) {
  const stage = (ctx && ctx.stage) || 'S1';
  // ⚠ 解构默认值**只对 `undefined` 生效**，`null` 会漏过 —— 实测 `{ impl: null,
  // bindings: null }` 会在 `bindings.filter` 上抛 TypeError，违反「绝不抛」纪律。
  const src = input && typeof input === 'object' ? input : {};
  const spec = src.spec && typeof src.spec === 'object' ? src.spec : {};
  const impl = src.impl && typeof src.impl === 'object' ? src.impl : {};
  const fallbacks = src.fallbacks && typeof src.fallbacks === 'object' ? src.fallbacks : {};
  const bindings = Array.isArray(src.bindings) ? src.bindings : [];
  const findings = [];
  const rows = (Array.isArray(spec.rows) ? spec.rows : []).filter((r) => r && typeof r === 'object');
  const specByName = new Map(rows.map((r) => [r.name, r]));
  const push = (criterion, file, line, message) => {
    findings.push({ criterion, severity: severityFor(criterion, stage), file, line, message });
  };

  // ★ 只有 spec 与 impl 都非空的绑定才算「完成对账」（原型初版缺陷的修正点）
  const complete = bindings.filter((b) => b && b.spec && b.impl);
  const boundSpec = new Set(complete.map((b) => b.spec));
  const boundImpl = new Set(complete.map((b) => b.impl));

  const specReadable = !spec.error;
  if (!specReadable) {
    push('spec-unreadable', SPEC_FILE, null, '规范表读不到：' + (spec && spec.error));
  }
  // 表读不到时绑定必然全是 orphan —— 那是同一根因的派生噪声，抑制之，只报根因

  for (const b of bindings) {
    if (!b) continue;

    // ① binding-orphan：绑定表指向的规范行不存在（表改了名，绑定表没跟）
    if (b.spec && specReadable && !specByName.has(b.spec)) {
      push(
        'binding-orphan',
        SPEC_FILE,
        null,
        `绑定表指向的规范行「${b.spec}」在 §3.3 表里不存在（表改名了？）`
      );
      continue;
    }

    // ② cadence-drift：绑定的两边都在、值不等 —— 本规则的核心判据（R1）
    if (b.spec && b.impl && specReadable) {
      const s = specByName.get(b.spec);
      const v = impl[b.impl];
      if (s && typeof v === 'number' && v !== s.ms) {
        const known = KNOWN_DRIFTS[`${b.spec}|${b.impl}`];
        push(
          known ? 'cadence-drift-known' : 'cadence-drift',
          SPEC_FILE,
          s.line,
          `「${s.name}」规范 ${s.ms}ms（${(1000 / s.ms).toFixed(2)}fps）`
            + ` ≠ 实现 ${v}ms（${(1000 / v).toFixed(2)}fps），漂移 x${(v / s.ms).toFixed(2)}`
            + (known ? ` — 已知且已裁决保留：${known}` : '')
        );
      }
    }

    // ③ fallback-drift：组件兜底值 ≠ 规范值（R2）
    if (b.fallbackFile && b.fallbackRe && b.spec && specByName.has(b.spec)) {
      const s = specByName.get(b.spec);
      const fb = fallbacks[b.spec] || {};
      if (fb.error) {
        push('fallback-unreadable', b.fallbackFile, null, '兜底值抽取失败：' + fb.error);
      } else if (typeof fb.value === 'number' && fb.value !== s.ms) {
        // 已知漂移绑定的**兜底容差**：该绑定的规范值已被判为陈旧，故兜底对齐
        // 「已裁决的实现值」同样可接受 —— 降为 info。
        // 不这样做会对一个**正确**的收敛方向报假警：Spinner 兜底改成 160 是
        // 对齐 A0-b 裁决值，却被 R2 字面判违规 ⇒ 守卫教人改回错值。
        const known = KNOWN_DRIFTS[`${b.spec}|${b.impl}`];
        const implVal = b.impl ? impl[b.impl] : null;
        if (known && typeof implVal === 'number' && fb.value === implVal) {
          push(
            'fallback-drift-known',
            b.fallbackFile,
            fb.line,
            `兜底值 ${fb.value}ms ≠ 规范 ${s.ms}ms，但等于**已裁决的实现值** ${implVal}ms`
              + ` ⇒ 不判违规（该绑定的规范值已判为陈旧：${known}）`
          );
        } else {
          push('fallback-drift', b.fallbackFile, fb.line, `组件兜底值 ${fb.value}ms ≠ 规范 ${s.ms}ms`);
        }
      }
    }
  }

  // ④/⑤ 未完成对账的两侧 —— 缺口盘点，**不是违规**（说明现状，不误报）
  for (const r of rows) {
    if (!boundSpec.has(r.name)) {
      push('unbound-spec', SPEC_FILE, r.line, `规范行「${r.name}」(${r.ms}ms) 未纳入对账（绑定表里无完整绑定）`);
    }
  }
  for (const k of Object.keys(impl)) {
    if (typeof impl[k] === 'number' && !boundImpl.has(k)) {
      push('unbound-impl', IMPL_FILE, null, `perfTunables.${k} (${impl[k]}ms) 在 §3.3 表里无对应行`);
    }
  }

  return findings;
}

/** @param {Array<{severity:string}>} findings */
function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of list) {
    if (counts[f.severity] === undefined) continue;
    counts[f.severity] += 1;
  }
  return {
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    total: list.length,
  };
}

// ── 反例矩阵 ────────────────────────────────────────────────────────────────

/** 场景名 → 期望。`mustHave` / `mustNotHave` 断言的是**判据 id**，比裸计数更抗漂移。 */
const SCENARIO_EXPECT = Object.freeze({
  // 真实仓库现状：0 warning（Spinner 那条已裁决保留 → info）
  baseline: { warnings: 0, mustHave: ['cadence-drift-known', 'unbound-spec', 'unbound-impl'], mustNotHave: ['cadence-drift', 'fallback-drift'] },
  // 应放行：实现与兜底全部对齐规范值
  aligned: { warnings: 0, mustHave: [], mustNotHave: ['cadence-drift', 'cadence-drift-known', 'fallback-drift', 'binding-orphan'] },
  // 规范表删掉 Spinner 行（模拟改名/删除）
  'spec-missing': { warnings: 1, mustHave: ['binding-orphan'], mustNotHave: ['fallback-drift'] },
  // topicBar 兜底值被改成漂移值（topicBar **无**已知漂移 ⇒ 必须报 warning）
  'fallback-drift': { warnings: 1, mustHave: ['fallback-drift'], mustNotHave: [] },
  // Spinner 兜底值被改成 160 = 已裁决的实现值 ⇒ 必须**不**报 warning（兜底容差）
  'fallback-drift-known': { warnings: 0, mustHave: ['fallback-drift-known'], mustNotHave: ['fallback-drift'] },
  // §3.3 小节整体消失
  'spec-unreadable': { warnings: 1, mustHave: ['spec-unreadable'], mustNotHave: ['binding-orphan', 'fallback-drift'] },
  // 绑定表被清空（腐化极端形态）
  'no-binding': { warnings: 0, mustHave: ['unbound-spec', 'unbound-impl'], mustNotHave: ['cadence-drift', 'cadence-drift-known'] },
});

const SCENARIOS = Object.freeze(Object.keys(SCENARIO_EXPECT));

/**
 * 把真实采集结果变换成某个反例场景。纯函数（深拷贝输入，不改原对象）。
 * @param {string} name
 * @param {object} real
 */
function applyScenario(name, real) {
  const s = JSON.parse(JSON.stringify({ spec: real.spec, impl: real.impl, fallbacks: real.fallbacks, bindings: real.bindings }));
  const findRow = (n) => s.spec.rows.find((r) => r.name === n);

  switch (name) {
    case 'baseline':
      return s;
    case 'aligned': {
      for (const b of s.bindings) {
        if (!b.spec || !b.impl) continue;
        const row = findRow(b.spec);
        if (row) s.impl[b.impl] = row.ms;
      }
      for (const k of Object.keys(s.fallbacks)) {
        const row = findRow(k);
        if (row) s.fallbacks[k].value = row.ms;
      }
      return s;
    }
    case 'spec-missing':
      s.spec.rows = s.spec.rows.filter((r) => r.name !== 'Spinner');
      return s;
    case 'fallback-drift': {
      const row = findRow('topicBar');
      s.fallbacks.topicBar = { value: (row ? row.ms : 180) + 140, line: 62, error: null };
      return s;
    }
    case 'fallback-drift-known': {
      const b = s.bindings.find((x) => x.spec === 'Spinner');
      s.fallbacks.Spinner = { value: b && s.impl[b.impl] ? s.impl[b.impl] : 160, line: 19, error: null };
      return s;
    }
    case 'spec-unreadable':
      s.spec = { rows: [], error: 'AGENTS.md 里找不到 §3.3 小节' };
      return s;
    case 'no-binding':
      s.bindings = [];
      return s;
    default:
      throw new Error('unknown scenario: ' + name);
  }
}

/** 判定某场景是否满足期望。返回 `{ ok, reasons: string[] }`（不抛）。 */
function checkScenario(name, findings) {
  const exp = SCENARIO_EXPECT[name];
  if (!exp) return { ok: false, reasons: [`未知场景 ${name}`] };
  const list = Array.isArray(findings) ? findings : [];
  const s = summarize(list);
  const ids = new Set(list.map((f) => f.criterion));
  const reasons = [];
  if (typeof exp.warnings === 'number' && s.warnings !== exp.warnings) {
    reasons.push(`warnings 期望 ${exp.warnings} 实得 ${s.warnings}`);
  }
  for (const id of exp.mustHave || []) if (!ids.has(id)) reasons.push(`缺少判据 ${id}`);
  for (const id of exp.mustNotHave || []) if (ids.has(id)) reasons.push(`不应出现判据 ${id}`);
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  SEV,
  CRITERIA,
  BINDINGS,
  KNOWN_DRIFTS,
  SPEC_FILE,
  IMPL_FILE,
  SCENARIOS,
  SCENARIO_EXPECT,
  severityFor,
  labelOf,
  ruleOf,
  parseSpecTable,
  extractFallback,
  loadImpl,
  evaluate,
  summarize,
  applyScenario,
  checkScenario,
};
