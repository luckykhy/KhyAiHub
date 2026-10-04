'use strict';

// Unit contract tests for docMarkerSync.js — the Layer-3 pure rewriter of the
// docsFreshness unit (`<!-- khy-docs-sync:begin/end key=... -->` regions).
// Locks: gate dialect, marker grammar (begin tolerant / end strict), the three
// dispositions (filled / unknown / skipped), idempotence, and buildValueMap SSOT rules.
// Everything here is in-memory: the leaf never touches fs, so no fixture is needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { docMarkerSyncEnabled, syncManagedRegions, buildValueMap, NOTICE } = require('./docMarkerSync');

const B = (key, extra = '') => `<!-- khy-docs-sync:begin key=${key}${extra ? ' ' + extra : ''} -->`;
const E = (key) => `<!-- khy-docs-sync:end key=${key} -->`;

test('docMarkerSyncEnabled: 注入 env 优先于进程环境；{0,false,off,no} 关', () => {
  const saved = process.env.KHY_DOCS_MARKER_SYNC;
  process.env.KHY_DOCS_MARKER_SYNC = '0';
  try {
    assert.equal(docMarkerSyncEnabled({}), true, 'explicit {} must ignore ambient env');
  } finally {
    if (saved === undefined) delete process.env.KHY_DOCS_MARKER_SYNC;
    else process.env.KHY_DOCS_MARKER_SYNC = saved;
  }
  assert.equal(docMarkerSyncEnabled(), true);
  for (const [raw, want] of [
    ['', true],
    ['1', true],
    ['yes', true],
    ['0', false],
    ['False', false],
    [' OFF ', false],
    ['\toFF\t', false],
    ['no', false],
  ]) {
    assert.equal(docMarkerSyncEnabled({ KHY_DOCS_MARKER_SYNC: raw }), want, JSON.stringify(raw));
  }
  assert.equal(docMarkerSyncEnabled({ KHY_DOCS_MARKER_SYNC: 0 }), false);
  assert.equal(docMarkerSyncEnabled({ KHY_DOCS_MARKER_SYNC: null }), true);
});

test('NOTICE 是块内固定提示行，字面量冻结（幂等重发与 README 都按它定位区块）', () => {
  assert.equal(NOTICE, '(此区块由 khy docs check --fix 依据 SSOT 自动生成,请勿手工编辑)');
});

test('已知 key：块内重建为 NOTICE + 值，begin/end 标记行逐字保留（含 begin 的额外属性）', () => {
  const doc = ['# Doc', B('ai-backend-port', 'source=serviceDefaults'), '(旧内容)', '1234', E('ai-backend-port'), '正文'].join('\n');
  const r = syncManagedRegions(doc, new Map([['ai-backend-port', '9090']]));
  assert.equal(r.changed, true);
  assert.deepEqual(r.changedRegions, [{ key: 'ai-backend-port' }]);
  assert.deepEqual(r.unknownKeys, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(
    r.text,
    ['# Doc', B('ai-backend-port', 'source=serviceDefaults'), NOTICE, '9090', E('ai-backend-port'), '正文'].join('\n'),
  );
});

test('未知 key：整块原样保留（begin..end 都在），只上报 unknownKeys，不清空不猜测', () => {
  const doc = ['head', B('mystery'), 'keep-me', E('mystery'), 'tail'].join('\n');
  const r = syncManagedRegions(doc, new Map([['ai-backend-port', '9090']]));
  assert.equal(r.changed, false);
  assert.deepEqual(r.unknownKeys, ['mystery']);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.text, doc);
});

test('begin 无 end → skipped(unbalanced)，文本逐字不变', () => {
  const doc = ['a', B('k'), 'orphan begin'].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v']]));
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped, [{ key: 'k', reason: 'unbalanced' }]);
  assert.equal(r.text, doc);
});

test('end 的 key 与 begin 不一致 → unbalanced；后面的正确 end 也不回填（一次只认最近一个 end）', () => {
  const doc = [B('k'), 'body', E('other'), E('k')].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v'], ['other', 'w']]));
  assert.deepEqual(r.skipped, [{ key: 'k', reason: 'unbalanced' }]);
  assert.equal(r.changed, false);
  assert.equal(r.text, doc, '不配对就不动，绝不猜哪一行是块尾');
});

test('END 标记严格：end 行带额外属性即不认（begin 容错、end 不容错）', () => {
  const doc = [B('k'), 'body', '<!-- khy-docs-sync:end key=k source=x -->'].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v']]));
  assert.deepEqual(r.skipped, [{ key: 'k', reason: 'unbalanced' }]);
  assert.equal(r.text, doc);
});

test('key 字符集 [A-Za-z0-9._-]：合法标点照常工作，越界标记整行当正文且不报 skipped/unknown（静默忽略）', () => {
  const ok = [B('ai.backend-port_1'), 'x', E('ai.backend-port_1')].join('\n');
  assert.equal(syncManagedRegions(ok, new Map([['ai.backend-port_1', 'v']])).changed, true);
  const weird = [B('端口'), 'body', E('端口')].join('\n');
  const r = syncManagedRegions(weird, new Map([['端口', 'v']]));
  assert.equal(r.text, weird);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.unknownKeys, []);
  assert.equal(r.changed, false);
});

test('嵌套：外层判 nested 跳过，内层照常配对填充（跳过只作用于外层）', () => {
  const doc = [B('k'), B('k2'), 'inner-body', E('k2'), E('k')].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v'], ['k2', 'w']]));
  assert.deepEqual(r.skipped, [{ key: 'k', reason: 'nested' }]);
  assert.deepEqual(r.changedRegions, [{ key: 'k2' }]);
  assert.equal(r.text, [B('k'), B('k2'), NOTICE, 'w', E('k2'), E('k')].join('\n'));
});

test('同一 key 两个区块 → 都填充，changedRegions 出现两次', () => {
  const doc = [B('k'), 'one', E('k'), 'mid', B('k'), 'two', E('k')].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v']]));
  assert.deepEqual(r.changedRegions, [{ key: 'k' }, { key: 'k' }]);
  assert.equal(r.text.split(NOTICE).length - 1, 2);
  assert.equal(r.text, [B('k'), NOTICE, 'v', E('k'), 'mid', B('k'), NOTICE, 'v', E('k')].join('\n'));
});

test('幂等：填过的文本再跑一次 changed=false；多行值（含空行）按行展开', () => {
  const map = new Map([['slash-commands', '- `/a`\n\n- `/b`']]);
  const doc = [B('slash-commands'), 'old', E('slash-commands')].join('\n');
  const once = syncManagedRegions(doc, map);
  assert.equal(
    once.text,
    [B('slash-commands'), NOTICE, '- `/a`', '', '- `/b`', E('slash-commands')].join('\n'),
  );
  const twice = syncManagedRegions(once.text, map);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test('值非字符串按 String() 处理（数字端口 9090 → 一行 9090）', () => {
  const doc = [B('ai-backend-port'), 'old', E('ai-backend-port')].join('\n');
  assert.equal(
    syncManagedRegions(doc, { 'ai-backend-port': 9090 }).text,
    [B('ai-backend-port'), NOTICE, '9090', E('ai-backend-port')].join('\n'),
  );
});

test('valueMap 形态：Map / 普通对象 / null / 数组 / 字符串——只有前两种真的给值', () => {
  const doc = [B('k'), 'old', E('k')].join('\n');
  const filled = (map) => syncManagedRegions(doc, map);
  assert.equal(filled(new Map([['k', 'v']])).changed, true);
  assert.equal(filled({ k: 'v' }).changed, true);
  for (const bad of [null, undefined, 'x', ['v'], 42]) {
    const r = filled(bad);
    assert.equal(r.changed, false, JSON.stringify(String(bad)));
    assert.deepEqual(r.unknownKeys, ['k'], `${String(bad)} 应表现为「未知 key」而不是报错`);
    assert.equal(r.text, doc);
  }
  // 数组被当对象取索引键：只有 key '0' 拿得到值。
  assert.equal(syncManagedRegions([B('0'), 'x', E('0')].join('\n'), ['v']).changed, true);
});

test('free prose 与孤立 end 行绝不动；空文档与非字符串文档返回空文本', () => {
  const prose = '# 纯正文\n没有标记\n`services/x.js`\n' + E('orphan') + '\n结束';
  const r = syncManagedRegions(prose, new Map([['orphan', 'v']]));
  assert.equal(r.changed, false);
  assert.equal(r.text, prose);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.unknownKeys, []);
  for (const junk of ['', 42, null, undefined, {}, [], true]) {
    const bad = syncManagedRegions(junk, new Map([['k', 'v']]));
    assert.equal(bad.text, '');
    assert.equal(bad.changed, false);
  }
});

test('CRLF 文档：块内注入行用 LF（与文档 CRLF 混排），第二次跑即收敛（现状锁定）', () => {
  const doc = ['# Doc', B('k'), '(old)', '1234', E('k'), 'tail'].join('\r\n') + '\r\n';
  const map = new Map([['k', '9090']]);
  const one = syncManagedRegions(doc, map);
  assert.equal(one.changed, true);
  assert.equal(
    one.text,
    ['# Doc\r', `${B('k')}\r`, NOTICE, '9090', `${E('k')}\r`, 'tail\r', ''].join('\n'),
  );
  const two = syncManagedRegions(one.text, map);
  assert.equal(two.changed, false, '一次改写后即幂等，不会反复 re-stage');
});

test('buildValueMap: 三个已知 key 的取值与字段优先级', () => {
  const m = buildValueMap({
    slashCommands: [
      { cmd: '/a', desc: 'A' },
      { command: '/b', description: 'B' },
      { name: '/c', label: 'C' },
      { cmd: '/d' },
      { desc: '只有说明没有命令' },
      '裸字符串',
      null,
    ],
    aiBackendPort: 9090,
    khyVersion: ' 0.1.148 ',
  });
  assert.equal(m instanceof Map, true);
  assert.equal(
    m.get('slash-commands'),
    ['- `/a` — A', '- `/b` — B', '- `/c` — C', '- `/d`'].join('\n'),
  );
  assert.equal(m.get('ai-backend-port'), '9090');
  assert.equal(m.get('khy-version'), '0.1.148');
  assert.equal(m.has('frontend-port'), false, '无 SSOT 的值绝不入表');
});

test('buildValueMap: 空/缺依赖不入表（不杜撰），0 与 false 是「有值」', () => {
  assert.equal(buildValueMap({}).size, 0);
  assert.equal(buildValueMap().size, 0);
  assert.equal(buildValueMap({ slashCommands: [] }).has('slash-commands'), false);
  assert.equal(buildValueMap({ slashCommands: 'not-array' }).has('slash-commands'), false);
  assert.equal(buildValueMap({ slashCommands: [{ desc: 'x' }] }).has('slash-commands'), false);
  assert.equal(buildValueMap({ aiBackendPort: '   ', khyVersion: '' }).size, 0);
  assert.equal(buildValueMap({ aiBackendPort: '', khyVersion: null }).size, 0);
  assert.equal(buildValueMap({ aiBackendPort: 0 }).get('ai-backend-port'), '0');
  assert.equal(buildValueMap({ aiBackendPort: false }).get('ai-backend-port'), 'false');
  for (const junk of [null, undefined, 42, 'string']) assert.equal(buildValueMap(junk).size, 0);
});

test('端到端：buildValueMap 的表直接喂 syncManagedRegions 即可填值', () => {
  const map = buildValueMap({ aiBackendPort: 9090, khyVersion: '1.2.3' });
  const doc = [
    B('ai-backend-port', 'source=serviceDefaults'),
    '8080',
    E('ai-backend-port'),
    B('khy-version'),
    'x',
    E('khy-version'),
  ].join('\n');
  const r = syncManagedRegions(doc, map);
  assert.equal(r.changed, true);
  assert.deepEqual(r.changedRegions, [{ key: 'ai-backend-port' }, { key: 'khy-version' }]);
  assert.equal(r.text.includes('\n9090\n'), true);
  assert.equal(r.text.includes('\n1.2.3\n'), true);
});

test('纯度锁：本叶子零 require，process.env 只出现在默认参数里', () => {
  const src = require('node:fs').readFileSync(require.resolve('./docMarkerSync'), 'utf8');
  assert.equal(src.includes('require('), false);
  assert.equal(src.includes('fs.'), false);
  const envLines = src
    .split(/\r?\n/)
    .filter((l) => l.includes('process.env') && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assert.deepEqual(envLines, ['function docMarkerSyncEnabled(env = process.env) {']);
});
