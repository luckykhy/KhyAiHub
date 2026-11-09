'use strict';

/**
 * scripts/ci/check-delegation-boundary.js 的规则测试。
 *
 * 重点覆盖 finding id 7 `delegation-bypass-spawn` 的**判据边界**：
 * 它用 SPAWN_CALL_RE（含 `exec\b`）逐行找外部 CLI 的进程拉起点，而 JS 里
 * `/…/i.exec(s)` 这种**正则方法调用**会被 `exec\b` 命中，且 slug 解析行天然含
 * `claude` 字样 —— 二者同时出现即产生纯误报（曾实测把
 * `runtime/node/backend/src/utils/format/ccModelName.js` 的 slug 正则报成「旁路拉起 claude」）。
 *
 * 本文件把这条边界钉成回归：正则字面量不得被判为 spawn 点，而真旁路
 * （含与正则同行的真 spawn、含除法之后的真 spawn）必须照旧被抓 ——
 * 只断「修完变绿」而不断「真信号仍在」，就分不清「修好」与「修没了」。
 *
 * 刻意**不**对着真实仓库跑 bypass-spawn 的判据边界：真仓库的状态会随治理进度变化。
 * 唯一例外是 finding 11 `delegation-cascade-ungated` 的零误报用例——它钉的是 2026-10-19
 * 刚落地的候选池修复（aiMessageBuilder 预检过滤 + aiGatewayGenerateMethod 组装后剔除），
 * 镜像 fixture 只能证明「长得像真代码的形状绿」，证明不了真代码本身绿，故直接对真仓库断言。
 * 每个用例建一个临时仓库当 fixture，用 KHY_DELEGATION_ROOT 把守卫指过去，只注入一处变量。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-delegation-boundary.js');
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/**
 * 最小 fixture：让 checkSsotAndGates / checkInjectedText / checkNudgeGate /
 * checkBoundaryIsCalled 各自能通过（否则输出里会混入别的 finding，干扰断言）。
 * 各用例只在 bypass-spawn 的判据输入上做一处变化。
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-delg-'));
  tempDirs.push(root);
  writeFile(root, 'runtime/node/backend/src/services/externalAgentDirective.js', "'use strict';\n");
  writeFile(root, 'runtime/node/backend/src/tools/AgentTool/delegation.js', "'use strict';\n");
  return root;
}

function runGuard(root) {
  const result = cp.spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_DELEGATION_ROOT: root },
    timeout: 120000,
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/**
 * finding 11 的全绿基线：三处源码各司其职——delegationGate 的外部 key 谓词与剔除纯函数、
 * 预检自动候选链的排除过滤、组装后的剔除写回。回归用例只在此基线上做一处变化
 * （删掉预检那条过滤行），以便把「是这个变化导致的红」与「fixture 本身不绿」分开。
 */
function makeCascadeFixture() {
  const root = makeFixture();
  writeFile(
    root,
    'runtime/node/backend/src/services/gateway/delegationGate.js',
    [
      "'use strict';",
      "const EXTERNAL_DELEGATION_ADAPTER_KEYS = ['claude', 'codex'];",
      'function isExternalDelegationAdapter(key) {',
      "  return EXTERNAL_DELEGATION_ADAPTER_KEYS.includes(String(key || '').toLowerCase());",
      '}',
      "const HUMAN_PIN_APPROVED = 'user-command';",
      'function stripUnapprovedExternalAdapters(adapters, opts) {',
      '  if ((opts || {}).delegationApprovedByUser === HUMAN_PIN_APPROVED) {',
      '    return { kept: adapters, removedKeys: [] };',
      '  }',
      '  const removed = adapters.filter((a) => isExternalDelegationAdapter(a && a.key));',
      '  return { kept: adapters, removedKeys: removed.map((a) => a.key) };',
      '}',
      'module.exports = { EXTERNAL_DELEGATION_ADAPTER_KEYS, isExternalDelegationAdapter, stripUnapprovedExternalAdapters };',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'runtime/node/backend/src/cli/aiMessageBuilder.js',
    [
      "'use strict';",
      "const { isExternalDelegationAdapter } = require('../services/gateway/delegationGate');",
      'function build(gw, maxAutoCandidates) {',
      '  // Auto-pick first operational adapter, skip relay-like adapters for chat by default.',
      '  const statuses = gw',
      '    .getStatus()',
      '    .filter((s) => s.enabled && s.available)',
      '    .filter((s) => !isExternalDelegationAdapter(s.type))',
      '    .slice(0, maxAutoCandidates);',
      '  return statuses;',
      '}',
      'module.exports = { build };',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js',
    [
      "'use strict';",
      "const delegationGate = require('./delegationGate');",
      'function generate(options) {',
      '  let orderedAdapters = collect();',
      '  const strip = delegationGate.stripUnapprovedExternalAdapters(orderedAdapters, {',
      '    delegationApprovedByUser: options.delegationApprovedByUser,',
      '    userPinnedAdapter: options.userPinnedAdapter,',
      '  });',
      '  if (strip.removedKeys.length > 0) {',
      '    orderedAdapters = strip.kept;',
      '  }',
      '  return orderedAdapters;',
      '}',
      'module.exports = { generate };',
      '',
    ].join('\n'),
  );
  return root;
}

/** 抽出输出里 delegation-cascade-ungated 命中的文件（相对路径，去重）。 */
function cascadeHits(out) {
  return [
    ...new Set(
      out
        .split('\n')
        .filter((l) => l.includes('delegation-cascade-ungated'))
        .map((l) => (l.match(/runtime\/node\/backend\/src\/[^\s:]+/) || [''])[0])
        .filter(Boolean),
    ),
  ];
}

/** 抽出输出里 delegation-bypass-spawn 命中的文件（相对路径，去重）。 */
function bypassHits(out) {
  return [
    ...new Set(
      out
        .split('\n')
        .filter((l) => l.includes('delegation-bypass-spawn'))
        .map((l) => (l.match(/runtime\/node\/backend\/src\/[^\s:]+/) || [''])[0])
        .filter(Boolean),
    ),
  ];
}

describe('check-delegation-boundary: bypass-spawn 判据边界', () => {
  test('真旁路：spawnSync("claude", …) 必须被抓', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/services/foo/realBypass.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        "const { spawnSync } = require('child_process');",
        "const probe = () => spawnSync('claude', ['--version'], { encoding: 'utf8' });",
        'module.exports = { probe };',
        '',
      ].join('\n'),
    );
    assert.ok(bypassHits(runGuard(root)).includes(f), '真旁路漏检');
  });

  test('正则字面量：/^claude-…/i.exec(raw) 不得被判为 spawn 点（历史误报）', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/utils/format/slugParse.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        'function fmt(model){',
        '  const raw = String(model);',
        '  const m = /^claude-(opus|sonnet|haiku)-(\\d+)/i.exec(raw);',
        '  return m ? m[2] : raw;',
        '}',
        'module.exports = { fmt };',
        '',
      ].join('\n'),
    );
    assert.deepEqual(bypassHits(runGuard(root)), [], '正则字面量被误报为旁路 spawn');
  });

  test('正则与真旁路同行：真信号不得被正则剥除逻辑吞掉', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/services/foo/mixed.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        "const { spawn } = require('child_process');",
        'const RE = /^claude-(\\d+)/i;',
        "const go = (raw) => (RE.exec(raw) ? spawn('claude', ['-p', raw]) : null);",
        'module.exports = { go };',
        '',
      ].join('\n'),
    );
    assert.ok(bypassHits(runGuard(root)).includes(f), '同行有正则时真旁路被漏检');
  });

  test('除法不是正则：`a / b` 之后的真旁路不得被漏检', () => {
    const root = makeFixture();
    const f = 'runtime/node/backend/src/services/foo/divThenSpawn.js';
    writeFile(
      root,
      f,
      [
        "'use strict';",
        "const { execFileSync } = require('child_process');",
        'const run = (a, b) => {',
        '  const ratio = a / b;',
        "  return execFileSync('codex', ['--version']) + ratio;",
        '};',
        'module.exports = { run };',
        '',
      ].join('\n'),
    );
    assert.ok(bypassHits(runGuard(root)).includes(f), '除法被误判为正则起点导致真旁路漏检');
  });

  test('白名单目录（src/cli/）内的外部 CLI 拉起不报', () => {
    const root = makeFixture();
    writeFile(
      root,
      'runtime/node/backend/src/cli/probe.js',
      [
        "'use strict';",
        "const { spawnSync } = require('child_process');",
        "module.exports = () => spawnSync('claude', ['--version']);",
        '',
      ].join('\n'),
    );
    assert.deepEqual(bypassHits(runGuard(root)), [], '白名单目录被误报');
  });

  test('行内 khy-allow-PROCESS-004 抑制生效（理由非空）', () => {
    const root = makeFixture();
    writeFile(
      root,
      'runtime/node/backend/src/services/foo/suppressed.js',
      [
        "'use strict';",
        "const { spawnSync } = require('child_process');",
        '// khy-allow-PROCESS-004: fixture 里这是唯一入口，已过三闸门',
        "const probe = () => spawnSync('claude', ['--version']);",
        'module.exports = { probe };',
        '',
      ].join('\n'),
    );
    assert.deepEqual(bypassHits(runGuard(root)), [], '合法抑制未生效');
  });
});

describe('check-delegation-boundary: delegation-face-ungated 判据边界', () => {
  /**
   * finding 8 的判据是「AgentTool 里把可委派面直接赋给 preferredAdapter」——
   * 外部适配器只能取自决策结果（d.adapter），直连即绕过三闸门。
   *
   * 这条判据原来只认**单引号**（`'codex'`）：把同一个赋值写成双引号或模板字符串
   * 就绕过去了，而守卫照样绿。一扇能被子串撬开的门，红着等于没红。
   * 用例把三种引号形态都钉住，同时钉住两头：
   *   · 注释里的同形文字不得算旁路（解释性文字不是接线）
   *   · 走决策点的赋值不得算旁路（d.adapter 取自 decideExternalDelegation）
   */
  function makeFaceFixture(agentToolBody) {
    const root = makeFixture();
    writeFile(
      root,
      'runtime/node/backend/src/services/externalAgentDirective.js',
      [
        "'use strict';",
        'const EXTERNAL_AGENTS = {',
        "  claude: { id: 'claude', delegatable: true },",
        "  codex: { id: 'codex', delegatable: true },",
        "  opencode: { id: 'opencode', delegatable: true },",
        '};',
        'module.exports = { EXTERNAL_AGENTS };',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'runtime/node/backend/src/tools/AgentTool/index.js',
      [
        "'use strict';",
        "const { decideExternalDelegation } = require('../../services/externalAgentDirective');",
        'function run(d) {',
        "  let preferredAdapter = '';",
        '  const decision = decideExternalDelegation(d);',
        ...agentToolBody,
        '  return preferredAdapter;',
        '}',
        'module.exports = { run };',
        '',
      ].join('\n'),
    );
    return root;
  }

  /** 抽出输出里 delegation-face-ungated 命中 AgentTool 的行。 */
  function faceHits(out) {
    return out
      .split('\n')
      .filter((l) => l.includes('delegation-face-ungated'))
      .filter((l) => l.includes('tools/AgentTool/index.js'));
  }

  test('真旁路（单引号）：preferredAdapter = \'codex\' 必须被抓', () => {
    const root = makeFaceFixture(["  preferredAdapter = 'codex';"]);
    assert.ok(faceHits(runGuard(root)).length > 0, '单引号直连适配器被漏检');
  });

  test('双引号旁路：preferredAdapter = "codex" 必须被抓（同一语义、另一种引号）', () => {
    const root = makeFaceFixture(['  preferredAdapter = "codex";']);
    assert.ok(faceHits(runGuard(root)).length > 0, '双引号直连适配器被漏检——判据只认单引号，门能被子串撬开');
  });

  test('模板字符串旁路：preferredAdapter = `codex` 必须被抓', () => {
    const root = makeFaceFixture(['  preferredAdapter = `codex`;']);
    assert.ok(faceHits(runGuard(root)).length > 0, '模板字符串直连适配器被漏检');
  });

  test('注释里的同形文字不得被判为旁路（解释性文字不是接线）', () => {
    const root = makeFaceFixture(["  // 此前 preferredAdapter = 'codex' 直连适配器，已收掉"]);
    assert.deepEqual(faceHits(runGuard(root)), [], '注释被误判为旁路');
  });

  test('块注释里夹的同形文字也不得被判为旁路', () => {
    const root = makeFaceFixture([
      '  /*',
      "   * 历史写法：preferredAdapter = 'codex'",
      '   */',
    ]);
    assert.deepEqual(faceHits(runGuard(root)), [], '块注释被误判为旁路');
  });

  test('走决策点的赋值不得被判为旁路（d.adapter 取自 decideExternalDelegation）', () => {
    const root = makeFaceFixture(["  preferredAdapter = decision.adapter || 'claude';"]);
    assert.deepEqual(faceHits(runGuard(root)), [], '决策结果赋值被误判为旁路');
  });

  test('真仓库零误报：已收敛到决策点的实现不得被判红', () => {
    assert.deepEqual(
      faceHits(runGuard(ROOT)),
      [],
      '真仓库里已收敛到 decideExternalDelegation 的实现被误报为「可委派面未过准入」'
    );
  });
});

describe('check-delegation-boundary: delegation-cascade-ungated 判据边界', () => {
  test('真回归：预检自动候选链删掉外部委派过滤必须被抓', () => {
    const root = makeCascadeFixture();
    const f = 'runtime/node/backend/src/cli/aiMessageBuilder.js';
    const abs = path.join(root, f);
    const before = fs.readFileSync(abs, 'utf8');
    // 只做一处变化：删掉候选链里的外部委派过滤行，其余 fixture 保持全绿基线。
    const after = before.replace(/^.*isExternalDelegationAdapter\(s\.type\).*\n/m, '');
    assert.notEqual(before, after, 'fixture 基线没有可删除的委派过滤行，用例需同步更新');
    writeFile(root, f, after);
    assert.ok(cascadeHits(runGuard(root)).includes(f), '预检候选池的委派过滤被删却未被抓');
  });

  test('真仓库零误报：已落地的候选池修复不得被判红', () => {
    assert.deepEqual(
      cascadeHits(runGuard(ROOT)),
      [],
      '真仓库已落地的候选池修复被误报为「自动候选池含未批准的外部委派 key」'
    );
  });
});
