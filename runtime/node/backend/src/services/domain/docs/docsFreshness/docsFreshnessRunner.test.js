'use strict';

// Unit contract tests for docsFreshnessRunner.js — the IO shell of the docsFreshness unit.
// The shell is the only member allowed to touch fs/git/child_process, so every test here
// injects `gitSoft` (never the real git) and builds its own fixture tree under
// .khyos/tmp/ — never the repo's real docs/. Nothing here may execute md-to-pdf.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runner = require('./docsFreshnessRunner');
const { buildValueMap, NOTICE } = require('./docMarkerSync');

// docsFreshness sits 7 levels under the repo root:
// services/backend/src/services/domain/docs/docsFreshness
const REPO_ROOT = path.resolve(__dirname, '../../../../../../../');
const TMP_BASE = path.join(REPO_ROOT, '.khyos', 'tmp');
const MAX_DOC_BYTES = 512 * 1024; // 与 runner 内部上限同值，仅用于边界测试

function makeFixture(prefix, files) {
  const root = fs.mkdtempSync(path.join(TMP_BASE, `${prefix}-`));
  for (const rel of Object.keys(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel], 'utf8');
  }
  return root;
}

function drop(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

function makeGit(responder) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args: args.slice(), cwd });
    const r = responder(args, cwd);
    return r === undefined ? { ok: true, out: '' } : r;
  };
  git.calls = calls;
  return git;
}

const B = (key, extra = '') => `<!-- khy-docs-sync:begin key=${key}${extra ? ' ' + extra : ''} -->`;
const E = (key) => `<!-- khy-docs-sync:end key=${key} -->`;
const MARKER_DOC = [
  B('ai-backend-port', 'source=serviceDefaults'),
  '(旧内容)',
  '8080',
  E('ai-backend-port'),
].join('\n');

test('导出面恰为 6 个符号，且 _gitSoft 就是 D3 的那个函数（同一引用，不另抄一份）', () => {
  assert.deepEqual(Object.keys(runner).sort(), [
    '_gatherSsotDeps',
    '_gitSoft',
    '_isSourceRel',
    'collectChangedSources',
    'loadDocRecords',
    'runDocsFreshness',
  ]);
  assert.equal(runner._gitSoft, require('../../../../utils/gitSoftExec'));
});

test('_isSourceRel: 扩展名判定 + docs/.ai 排除，反斜杠先归一，裸文件名不排除', () => {
  const table = [
    ['services/backend/src/x.js', true],
    ['runtime/boot/kernel/src/sched.c', true],
    ['scripts/y.sh', true],
    ['services/backend/package.json', true],
    ['services\\x.js', true],
    ['services/backend/src/x.JS', true],
    ['x.js', true], // 根级裸文件名也算源码（无 ROOT 锚定要求）
    ['services/backend/docs/x.js', true], // 只排仓库根的 docs/，嵌套 docs 目录不排
    ['docs/A.md', false],
    ['docs\\x.js', false], // 归一后落在 docs/ 前缀
    ['works/record/ai/CONTEXT.yaml', false],
    ['.ai/x.js', false],
    ['README.md', false], // md 不是源码扩展
    ['services/x', false], // 无扩展名 → 整串当扩展名
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ];
  for (const [input, want] of table) {
    assert.equal(runner._isSourceRel(input), want, String(input));
  }
});

test('collectChangedSources: staged 只问暂存区，非 staged 问工作树+暂存区两次（命令逐字锁定）', () => {
  const stagedGit = makeGit(() => ({
    ok: true,
    out: 'services/backend/src/a.js\r\ndocs/skip.md\r\nservices/backend/src/a.js\r\n\r\nREADME.md',
  }));
  assert.deepEqual(runner.collectChangedSources('/repo', { staged: true, gitSoft: stagedGit }), [
    'services/backend/src/a.js',
  ]);
  assert.deepEqual(stagedGit.calls.map((c) => c.args), [
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
  ]);
  assert.equal(stagedGit.calls[0].cwd, '/repo');

  const bothGit = makeGit((args) => ({
    ok: true,
    out: args.includes('--cached') ? 'services/x.js' : 'services/y.js\\z.py',
  }));
  assert.deepEqual(runner.collectChangedSources('/repo', { gitSoft: bothGit }), [
    'services/y.js/z.py',
    'services/x.js',
  ]);
  assert.deepEqual(bothGit.calls.map((c) => c.args), [
    ['diff', '--name-only', '--diff-filter=ACMR'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
  ]);
});

test('collectChangedSources: git 返回失败/非对象/抛错 → 一律空数组，绝不抛', () => {
  for (const responder of [
    () => ({ ok: false, out: '' }),
    () => ({ ok: true, out: '' }),
    () => null,
    () => undefined,
    () => {
      throw new Error('git exploded');
    },
  ]) {
    assert.deepEqual(runner.collectChangedSources('/repo', { gitSoft: makeGit(responder) }), []);
  }
});

test('loadDocRecords: 只收 docs/**.md，跳过 SKIP_DIRS，空文件收，512KB 上限按 > 判', (t) => {
  const root = makeFixture('b23-load', {
    'docs/A.md': 'A',
    'docs/sub/B.md': 'B',
    'docs/empty.md': '',
    'docs/Z.txt': 'no',
    'docs/node_modules/SKIP.md': 'x',
    'docs/bundled/SKIP.md': 'x',
    'docs/coverage/SKIP.md': 'x',
    'docs/max.md': 'a'.repeat(MAX_DOC_BYTES),
    'docs/big.md': 'a'.repeat(MAX_DOC_BYTES + 1),
  });
  t.after(() => drop(root));
  const recs = runner.loadDocRecords(root);
  assert.deepEqual(recs.map((r) => r.path).sort(), [
    'docs/A.md',
    'docs/empty.md',
    'docs/max.md',
    'docs/sub/B.md',
  ]);
  const byPath = new Map(recs.map((r) => [r.path, r.text]));
  assert.equal(byPath.get('docs/A.md'), 'A');
  assert.equal(byPath.get('docs/empty.md'), '');
  assert.equal(byPath.get('docs/max.md').length, MAX_DOC_BYTES);
  assert.equal(byPath.has('docs/big.md'), false, '超过上限的文档直接不收（防超大文件）');
  for (const p of byPath.keys()) assert.match(p, /^docs\/.+\.md$/);
  assert.deepEqual(runner.loadDocRecords(path.join(root, 'no-such-dir')), []);
});

test('loadDocRecords: docs 是普通文件而非目录 → 空数组，不抛', (t) => {
  const root = makeFixture('b23-filedocs', { docs: 'i am a file' });
  t.after(() => drop(root));
  assert.deepEqual(runner.loadDocRecords(root), []);
});

test('runDocsFreshness: 门控关 → 返回逐字固定的空壳（连 changedSources 都不出现）', () => {
  const r = runner.runDocsFreshness('/nonexistent', {
    env: { KHY_DOCS_FRESHNESS: '0' },
    gitSoft: makeGit(() => ({ ok: true, out: 'services/x.js' })),
  });
  assert.deepEqual(r, {
    ran: false,
    suspects: [],
    unmatchedChanges: [],
    productActions: [],
    markerActions: [],
    restaged: [],
    warnOnly: true,
  });
});

test('runDocsFreshness: 默认 warn-only —— 报嫌疑、零写盘、零产物动作', (t) => {
  const root = makeFixture('b23-warn', { 'docs/A.md': '真源 `services/backend/src/target.js`。\n' });
  t.after(() => drop(root));
  const git = makeGit(() => ({ ok: true, out: 'services/backend/src/target.js' }));
  const r = runner.runDocsFreshness(root, { env: {}, staged: true, gitSoft: git });
  assert.equal(r.ran, true);
  assert.equal(r.warnOnly, true);
  assert.deepEqual(r.changedSources, ['services/backend/src/target.js']);
  assert.deepEqual(r.suspects, [
    { doc: 'docs/A.md', matchedSources: ['services/backend/src/target.js'], confidence: 'exact' },
  ]);
  assert.deepEqual(r.unmatchedChanges, []);
  assert.deepEqual(r.productActions, []);
  assert.deepEqual(r.markerActions, []);
  assert.deepEqual(r.restaged, []);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8'),
    '真源 `services/backend/src/target.js`。\n',
  );
  assert.deepEqual(git.calls.map((c) => c.args), [
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
  ]);
});

test('runDocsFreshness: repoRoot 缺省时按 KHYQUANT_CWD 定位（env 注入即生效）', (t) => {
  const root = makeFixture('b23-cwd', { 'docs/A.md': '实现 `services/backend/src/target.js`' });
  t.after(() => drop(root));
  const r = runner.runDocsFreshness(undefined, {
    env: { KHYQUANT_CWD: root },
    staged: true,
    gitSoft: makeGit(() => ({ ok: true, out: 'services/backend/src/target.js' })),
  });
  assert.equal(r.ran, true);
  assert.equal(r.suspects.length, 1);
  assert.equal(r.suspects[0].doc, 'docs/A.md');
});

test('runDocsFreshness: 根目录不存在 → 仍然 ran:true 且空结果（fail-soft，不抛）', () => {
  const r = runner.runDocsFreshness(path.join(TMP_BASE, 'b23-definitely-absent'), {
    env: {},
    gitSoft: makeGit(() => ({ ok: false, err: 'no repo' })),
  });
  assert.deepEqual(r, {
    ran: true,
    changedSources: [],
    suspects: [],
    unmatchedChanges: [],
    productActions: [],
    markerActions: [],
    restaged: [],
    warnOnly: true,
  });
});

test('runDocsFreshness fix: 标记块按 SSOT 落盘 + re-stage，第二次跑幂等', (t) => {
  const root = makeFixture('b23-fix', { 'docs/A.md': MARKER_DOC });
  t.after(() => drop(root));
  const port = buildValueMap(runner._gatherSsotDeps(root)).get('ai-backend-port');
  assert.equal(typeof port, 'string', 'SSOT 端口必须取得到（否则本测试失去意义）');

  const r = runner.runDocsFreshness(root, {
    env: {},
    fix: true,
    gitSoft: makeGit(() => ({ ok: true, out: '' })),
  });
  assert.deepEqual(r.markerActions, [
    { rel: 'docs/A.md', changedRegions: [{ key: 'ai-backend-port' }], ok: true, restaged: true },
  ]);
  assert.deepEqual(r.restaged, ['docs/A.md']);
  assert.deepEqual(r.productActions, [], 'fixture 里没有 committed 产物 → Layer 2 不动');
  assert.equal(
    fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8'),
    [B('ai-backend-port', 'source=serviceDefaults'), NOTICE, port, E('ai-backend-port')].join('\n'),
  );

  const r2 = runner.runDocsFreshness(root, {
    env: {},
    fix: true,
    gitSoft: makeGit(() => ({ ok: true, out: '' })),
  });
  assert.deepEqual(r2.markerActions, [], '幂等：值已对，不再写盘');
  assert.deepEqual(r2.restaged, []);
});

test('runDocsFreshness fix: markerSync:false 或 KHY_DOCS_MARKER_SYNC=0 → 一个字节都不写', (t) => {
  const root = makeFixture('b23-fixoff', { 'docs/A.md': MARKER_DOC });
  t.after(() => drop(root));
  const before = fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8');

  const a = runner.runDocsFreshness(root, {
    env: {},
    fix: true,
    markerSync: false,
    gitSoft: makeGit(() => ({ ok: true, out: '' })),
  });
  assert.deepEqual(a.markerActions, []);
  assert.deepEqual(a.restaged, []);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8'), before);

  const b = runner.runDocsFreshness(root, {
    env: { KHY_DOCS_MARKER_SYNC: '0' },
    fix: true,
    gitSoft: makeGit(() => ({ ok: true, out: '' })),
  });
  assert.deepEqual(b.markerActions, []);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8'), before);
});

test('runDocsFreshness fix: git add 返回失败 → 已落盘但 restaged 为空（如实报 restaged:false）', (t) => {
  const root = makeFixture('b23-addfail', { 'docs/A.md': MARKER_DOC });
  t.after(() => drop(root));
  const r = runner.runDocsFreshness(root, {
    env: {},
    fix: true,
    gitSoft: makeGit((args) => (args[0] === 'add' ? { ok: false, err: 'locked' } : { ok: true, out: '' })),
  });
  assert.deepEqual(r.markerActions, [
    { rel: 'docs/A.md', changedRegions: [{ key: 'ai-backend-port' }], ok: true, restaged: false },
  ]);
  assert.deepEqual(r.restaged, []);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8').includes(NOTICE), true);
});

test('runDocsFreshness fix: git add 抛错 → 动作记 ok:false + err，写盘副作用已经发生（现状锁定）', (t) => {
  const root = makeFixture('b23-addthrow', { 'docs/A.md': MARKER_DOC });
  t.after(() => drop(root));
  const r = runner.runDocsFreshness(root, {
    env: {},
    fix: true,
    gitSoft: makeGit((args) => {
      if (args[0] === 'add') throw new Error('git-add-boom');
      return { ok: true, out: '' };
    }),
  });
  assert.equal(r.markerActions.length, 1);
  assert.equal(r.markerActions[0].rel, 'docs/A.md');
  assert.equal(r.markerActions[0].ok, false);
  assert.equal(String(r.markerActions[0].err).includes('git-add-boom'), true);
  assert.equal('restaged' in r.markerActions[0], false, '失败分支不带 restaged 字段');
  assert.deepEqual(r.restaged, []);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'A.md'), 'utf8').includes(NOTICE), true);
});

test('runDocsFreshness fix: 有 committed 产物但 md-to-pdf 不在位 → Layer 2 空手而归，绝不落新产物', (t) => {
  const root = makeFixture('b23-noregen', { 'docs/A.md': '真源 `services/backend/src/target.js`' });
  t.after(() => drop(root));
  const git = makeGit((args) => {
    if (args[0] === 'ls-files') return { ok: true, out: 'docs/A.html\ndocs/A.pdf' };
    if (args[0] === 'diff') return { ok: true, out: 'docs/A.md' };
    return { ok: true, out: '' };
  });
  const r = runner.runDocsFreshness(root, {
    env: {},
    fix: true,
    markerSync: false,
    gitSoft: git,
  });
  assert.deepEqual(r.productActions, []);
  assert.deepEqual(r.restaged, []);
  assert.equal(fs.existsSync(path.join(root, 'scripts')), false, 'fixture 不该有 scripts/docs/md-to-pdf.js');
  assert.equal(fs.existsSync(path.join(root, 'docs', 'A.html')), false);

  const gated = runner.runDocsFreshness(root, {
    env: { KHY_DOCS_REGEN: '0' },
    fix: true,
    markerSync: false,
    gitSoft: makeGit(() => ({ ok: true, out: 'docs/A.html' })),
  });
  assert.deepEqual(gated.productActions, []);
});

test('_gatherSsotDeps: 三项 SSOT 齐备；仓外 repoRoot 时回退到模块自身的 backend package.json', (t) => {
  const root = makeFixture('b23-deps', {});
  t.after(() => drop(root));
  const deps = runner._gatherSsotDeps(root);
  assert.equal(Array.isArray(deps.slashCommands), true);
  assert.equal(deps.slashCommands.length > 0, true);
  assert.equal(typeof deps.aiBackendPort, 'number');
  assert.equal(typeof deps.khyVersion, 'string');
  assert.equal(/^\d+\.\d+\.\d+/.test(deps.khyVersion), true);
  assert.equal(deps.khyVersion, require('../../../../../package.json').version);
});
