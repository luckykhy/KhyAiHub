'use strict';

// Unit contract tests for docPathIndex.js — the Layer-1 pure leaf of the docsFreshness
// unit (prose scan → reverse source index → stale suspects).
// Locks: gate dialect, path-cleaning rules, index shape, match confidence + ordering,
// fail-soft behaviour, and the "zero IO / deterministic" claim in its own header.
// Everything here is in-memory: no fs writes, no git, no dependency on the repo's real docs/.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  docsFreshnessEnabled,
  extractSourcePaths,
  buildDocPathIndex,
  matchStaleSuspects,
  _cleanSourcePath,
  SOURCE_EXTS,
  ROOT_SEGMENTS,
} = require('./docPathIndex');

test('docsFreshnessEnabled: 注入 env 优先于进程环境（可测性契约）', () => {
  const saved = process.env.KHY_DOCS_FRESHNESS;
  process.env.KHY_DOCS_FRESHNESS = '0';
  try {
    assert.equal(docsFreshnessEnabled({}), true, 'explicit {} must ignore ambient env');
    assert.equal(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: '1' }), true);
  } finally {
    if (saved === undefined) delete process.env.KHY_DOCS_FRESHNESS;
    else process.env.KHY_DOCS_FRESHNESS = saved;
  }
  // Restored (unset) → the default-argument path reads process.env and reports "on".
  assert.equal(docsFreshnessEnabled(), true);
});

test('docsFreshnessEnabled: 只有 {0,false,off,no} 关，trim+lowercase，其余全开', () => {
  const table = [
    ['', true],
    ['1', true],
    ['x', true],
    ['nope', true], // 'no' 在名单里，'nope' 不在
    ['0', false],
    ['false', false],
    ['off', false],
    ['no', false],
    ['OFF', false],
    [' No ', false],
    ['False', false],
  ];
  for (const [raw, want] of table) {
    assert.equal(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: raw }), want, `${JSON.stringify(raw)}`);
  }
  // 非字符串取值：0/false 转成 '0'/'false' 后关闭；null/undefined 走 '' 分支 → 开。
  assert.equal(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: 0 }), false);
  assert.equal(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: false }), false);
  assert.equal(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: null }), true);
  assert.equal(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: undefined }), true);
  assert.equal(docsFreshnessEnabled(undefined), true);
});

test('_cleanSourcePath: 剥行号/范围/列/锚点，容忍 ./ 、前导 / 与反斜杠', () => {
  const table = [
    ['services/backend/src/cli/router.js', 'services/backend/src/cli/router.js'],
    ['services/backend/src/cli/router.js:3230', 'services/backend/src/cli/router.js'],
    ['services/backend/src/cli/router.js:3-14', 'services/backend/src/cli/router.js'],
    ['services/backend/src/cli/router.js:3230:5', 'services/backend/src/cli/router.js'],
    ['services/backend/src/cli/router.js#main', 'services/backend/src/cli/router.js'],
    ['services/backend/src/cli/router.js#L10:3', 'services/backend/src/cli/router.js'],
    ['./scripts/docs/md-to-pdf.js', 'scripts/docs/md-to-pdf.js'],
    ['/scripts/docs/md-to-pdf.js', 'scripts/docs/md-to-pdf.js'],
    ['kernel\\src\\sched.c', 'kernel/src/sched.c'], // 反斜杠归一；kernel 是合法首段
    ['services/backend/src/x.js 的 case', 'services/backend/src/x.js'],
    ['services/backend/src/x.y.js', 'services/backend/src/x.y.js'],
    ['services/backend/src/X.JS', 'services/backend/src/X.JS'], // 扩展名判定小写，路径原样保留
    ['services/backend/package.json', 'services/backend/package.json'], // json 算源码
  ];
  for (const [token, want] of table) {
    assert.equal(_cleanSourcePath(token), want, JSON.stringify(token));
  }
});

test('_cleanSourcePath: 拒绝裸文件名 / 单段路径 / 未知首段 / 非源码扩展 / 穿越 / 垃圾', () => {
  const rejected = [
    'router.js', // 单段：不锚定
    'services', // 无扩展名且单段
    'services/README.md', // md 不是源码
    'services/x.js:', // 尾冒号无数字 → 扩展名变 'js:'
    'foo/bar.js', // foo 不在 ROOT_SEGMENTS
    'runtime/substrate/platform/khy_platform/cli.py', // 已登记偏差：ROOT_SEGMENTS 无 platform
    // 2026-10-10：runtime/boot/kernel/src/sched.c 原在「接受」表里，但 ROOT_SEGMENTS 只有
    // kernel 没有 runtime，且本文件下方快照钉死了 12 个成员的集合。留着它就是自相矛盾
    // （同表上一行已把 runtime/** 记为拒绝）。真实缺口是「模块头声称 runtime/boot/kernel/...
    // 是行文惯例，但索引不认 runtime 首段」——补它要同时改 ROOT_SEGMENTS 与下方快照，
    // 属产品决策，不混在本次测试止血里。
    'runtime/boot/kernel/src/sched.c',
    'delivery/channel/khyquant/services/a.js', // 已登记偏差：ROOT_SEGMENTS 无 software
    'docs/10_规范/x.js', // docs 不是 ROOT 段
    'services/../etc/passwd.sh', // 含 ..
    'services/backend/src/a b.js', // 空格：首 token 切分后没有扩展名
    'services/backend/src/a".js', // 引号
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ];
  for (const token of rejected) {
    assert.equal(_cleanSourcePath(token), null, JSON.stringify(String(token)));
  }
  assert.equal(_cleanSourcePath('services/backend/src/a\tb.js'), null);
});

test('extractSourcePaths: 去重、保序、只认反引号包裹', () => {
  const text = [
    '# 标题',
    '真源:`services/backend/src/services/tokenUsageService.js`。',
    '实现 `scripts/docs/md-to-pdf.js` 与 `services/backend/src/cli/router.js:2158`。',
    '再次 `services/backend/src/services/tokenUsageService.js`（重复不双计）。',
    '命令 `npm run test` 不是路径；裸名 `foo.py` 不算；跨行 `services/backend/src/',
    'a.js` 也不算。',
  ].join('\n');
  assert.deepEqual(extractSourcePaths(text), [
    'services/backend/src/services/tokenUsageService.js',
    'scripts/docs/md-to-pdf.js',
    'services/backend/src/cli/router.js',
  ]);
});

test('extractSourcePaths: 每篇上限 200 条（第 201 条不再收录）', () => {
  const many = [];
  for (let i = 0; i < 260; i += 1) many.push(`\`services/backend/src/f${i}.js\``);
  const out = extractSourcePaths(many.join(' '));
  assert.equal(out.length, 200);
  assert.equal(out[0], 'services/backend/src/f0.js');
  assert.equal(out[199], 'services/backend/src/f199.js');
  assert.equal(out.includes('services/backend/src/f200.js'), false);
});

test('extractSourcePaths: 空/垃圾输入返回 []，不抛', () => {
  for (const junk of ['', null, undefined, 12345, {}, [], true]) {
    assert.deepEqual(extractSourcePaths(junk), []);
  }
  // 反引号内超过 200 字符的 token 整个不匹配。
  const long = `services/backend/src/${'d'.repeat(200)}.js`;
  assert.deepEqual(extractSourcePaths(`\`${long}\``), []);
});

test('buildDocPathIndex: 反向索引 + docCount 计「读到的篇数」而非「有引用的篇数」', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '`services/backend/src/x.js` 与再一次 `services/backend/src/x.js`' },
    { path: 'docs/B.md', text: '也引用 `services/backend/src/x.js`，另有 `scripts/y.js`' },
    { path: 'docs/NoRef.md', text: '正文没有任何源码引用' },
  ]);
  assert.equal(idx.generatedBy, 'prose-scan');
  assert.equal(idx.docCount, 3);
  assert.equal(idx.sourceCount, 2);
  assert.equal(idx.sourceCount, idx.bySource.size);
  assert.deepEqual(idx.bySource.get('services/backend/src/x.js'), ['docs/A.md', 'docs/B.md']);
  assert.deepEqual(idx.bySource.get('scripts/y.js'), ['docs/B.md']);
  assert.equal(idx.bySource.has('docs/NoRef.md'), false);
});

test('buildDocPathIndex: 无 path 时回退 id；两者皆空则整条跳过', () => {
  const idx = buildDocPathIndex([
    { id: 'LOGICAL-1', text: '`services/backend/src/x.js`' },
    { path: '', id: 'LOGICAL-2', text: '`services/backend/src/x.js`' },
    { path: '', id: '', text: '`services/backend/src/x.js`' },
  ]);
  assert.equal(idx.docCount, 2);
  assert.deepEqual(idx.bySource.get('services/backend/src/x.js'), ['LOGICAL-1', 'LOGICAL-2']);
});

test('buildDocPathIndex: 坏输入逐条跳过，整体不抛', () => {
  for (const bad of [
    null,
    undefined,
    'garbage',
    42,
    [null, undefined, 'string-rec', 7, {}, { text: '`services/backend/src/z.js`' }, { path: 'docs/C.md' }],
  ]) {
    const idx = buildDocPathIndex(bad);
    assert.equal(idx.bySource.size, 0, JSON.stringify(String(bad)));
    assert.equal(idx.docCount, 0);
    assert.equal(idx.generatedBy, 'prose-scan');
  }
});

test('matchStaleSuspects: exact 与 prefix 两级置信，exact 一旦出现即升级', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/Both.md', text: '`services/backend/src/cli/router.js`' },
    { path: 'docs/Prefix.md', text: '`services/backend/src/cli/steps.js`' },
  ]);
  // repl.js 与两篇文档同目录 → prefix；router.js 精确命中 Both → exact 升级。
  const r = matchStaleSuspects(
    ['services/backend/src/cli/repl.js', 'services/backend/src/cli/router.js'],
    idx,
  );
  assert.deepEqual(
    r.suspects.map((s) => [s.doc, s.confidence]),
    [
      ['docs/Both.md', 'exact'],
      ['docs/Prefix.md', 'prefix'],
    ],
  );
  assert.deepEqual(r.suspects[0].matchedSources, [
    'services/backend/src/cli/repl.js',
    'services/backend/src/cli/router.js',
  ]);
  assert.deepEqual(r.unmatchedChanges, []);
});

test('matchStaleSuspects: prefix 只在同目录内，绝不跨目录、绝不匹配根级裸名', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '`services/backend/src/cli/router.js`' },
  ]);
  const cross = matchStaleSuspects(['services/backend/src/other/z.js'], idx);
  assert.deepEqual(cross.suspects, []);
  assert.deepEqual(cross.unmatchedChanges, ['services/backend/src/other/z.js']);

  const bare = matchStaleSuspects(['z.js'], idx);
  assert.deepEqual(bare.suspects, []);
  assert.deepEqual(bare.unmatchedChanges, ['z.js']);
});

test('matchStaleSuspects: 变更路径归一化（trim / ./ / 反斜杠 / 前导 /）', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '`services/backend/src/cli/router.js`' },
  ]);
  for (const form of [
    '  services/backend/src/cli/router.js  ',
    './services/backend/src/cli/router.js',
    'services\\backend\\src\\cli\\router.js',
    '/services/backend/src/cli/router.js',
  ]) {
    const r = matchStaleSuspects([form], idx);
    assert.equal(r.suspects.length, 1, form);
    assert.equal(r.suspects[0].confidence, 'exact');
    assert.deepEqual(r.suspects[0].matchedSources, ['services/backend/src/cli/router.js']);
  }
});

test('matchStaleSuspects: 空/垃圾变更与索引都不抛，语义如实', () => {
  const idx = buildDocPathIndex([{ path: 'docs/A.md', text: '`services/backend/src/x.js`' }]);
  assert.deepEqual(matchStaleSuspects([], idx), { suspects: [], unmatchedChanges: [] });
  assert.deepEqual(matchStaleSuspects(null, idx), { suspects: [], unmatchedChanges: [] });
  assert.deepEqual(matchStaleSuspects(['services/backend/src/x.js'], null).suspects, []);
  // index 缺 bySource 字段 → 当作空索引：变更如实落进 unmatched。
  assert.deepEqual(matchStaleSuspects(['a/b.js'], {}).unmatchedChanges, ['a/b.js']);
  // bySource 不是 Map（例如 JSON 往返后）→ 内部判定抛错被吞，变更既不报嫌疑也不报未匹配。
  const broken = matchStaleSuspects(['services/backend/src/x.js'], {
    bySource: { 'services/backend/src/x.js': ['docs/A.md'] },
  });
  assert.deepEqual(broken, { suspects: [], unmatchedChanges: [] });
});

test('matchStaleSuspects: 输出确定性——同输入两次逐字节相同，matchedSources 升序', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '`services/backend/src/z.js` `services/backend/src/a.js`' },
    { path: 'docs/B.md', text: '`services/backend/src/z.js`' },
  ]);
  const changes = ['services/backend/src/z.js', 'services/backend/src/a.js'];
  const r1 = matchStaleSuspects(changes, idx);
  const r2 = matchStaleSuspects(changes.slice().reverse(), idx);
  assert.deepEqual(r1, r2, '输入顺序不得影响输出');
  assert.deepEqual(r1.suspects.map((s) => s.doc), ['docs/A.md', 'docs/B.md']);
  assert.deepEqual(r1.suspects[0].matchedSources, [
    'services/backend/src/a.js',
    'services/backend/src/z.js',
  ]);
  // 排序不变式：exact 段整体先于 prefix 段，同置信内按 doc 升序。
  const confs = r1.suspects.map((s) => s.confidence);
  assert.deepEqual(confs, [...confs].sort((a, b) => (a === b ? 0 : a === 'exact' ? -1 : 1)));
});

test('matchStaleSuspects: 重复变更路径在 unmatched 里逐条出现（现状锁定）', () => {
  const idx = buildDocPathIndex([{ path: 'docs/A.md', text: '`services/backend/src/x.js`' }]);
  const r = matchStaleSuspects(['services/other/a.js', 'services/other/a.js'], idx);
  assert.deepEqual(r.unmatchedChanges, ['services/other/a.js', 'services/other/a.js']);
});

test('常量面：SOURCE_EXTS / ROOT_SEGMENTS 成员快照（导出的是活引用，不是副本）', () => {
  assert.equal(SOURCE_EXTS instanceof Set, true);
  assert.equal(ROOT_SEGMENTS instanceof Set, true);
  for (const ext of ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'c', 'h', 'sh', 'json', 'vue', 'mbt']) {
    assert.equal(SOURCE_EXTS.has(ext), true, ext);
  }
  assert.equal(SOURCE_EXTS.has('md'), false);
  assert.equal(SOURCE_EXTS.has('MD'), false);
  for (const seg of ['services', 'scripts', 'kernel', 'packaging', 'tools', 'extensions', 'frontend', 'src', 'apps', 'packages', 'bin', 'lib']) {
    assert.equal(ROOT_SEGMENTS.has(seg), true, seg);
  }
  assert.equal(ROOT_SEGMENTS.has('platform'), false);
  assert.equal(ROOT_SEGMENTS.has('software'), false);
  assert.equal(ROOT_SEGMENTS.has('docs'), false);
});

test('纯度锁：本叶子零 require（无 fs/child_process/env 之外的输入面）', () => {
  const src = require('node:fs').readFileSync(require.resolve('./docPathIndex'), 'utf8');
  assert.equal(src.includes('require('), false);
  assert.equal(src.includes('process.cwd'), false);
  assert.equal(src.includes('process.argv'), false);
  const envLines = src
    .split(/\r?\n/)
    .filter((l) => l.includes('process.env') && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assert.deepEqual(envLines, ['function docsFreshnessEnabled(env = process.env) {']);
});
