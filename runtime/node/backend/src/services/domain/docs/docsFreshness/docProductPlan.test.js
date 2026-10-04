'use strict';

// Unit contract tests for docProductPlan.js — the Layer-2 pure planner of the
// docsFreshness unit (which committed .html/.pdf siblings may be regenerated).
// The planner never touches fs/git: it maps (changed md, committed products) → plan.

const test = require('node:test');
const assert = require('node:assert/strict');

const { docRegenEnabled, planDocProducts, _stripExt } = require('./docProductPlan');

test('docRegenEnabled: 注入 env 优先于进程环境；{0,false,off,no} 关', () => {
  const saved = process.env.KHY_DOCS_REGEN;
  process.env.KHY_DOCS_REGEN = '0';
  try {
    assert.equal(docRegenEnabled({}), true, 'explicit {} must ignore ambient env');
  } finally {
    if (saved === undefined) delete process.env.KHY_DOCS_REGEN;
    else process.env.KHY_DOCS_REGEN = saved;
  }
  assert.equal(docRegenEnabled(), true);
  const table = [
    ['', true],
    ['1', true],
    ['never', true],
    ['0', false],
    ['false', false],
    ['OFF', false],
    [' No ', false],
  ];
  for (const [raw, want] of table) {
    assert.equal(docRegenEnabled({ KHY_DOCS_REGEN: raw }), want, JSON.stringify(raw));
  }
  assert.equal(docRegenEnabled({ KHY_DOCS_REGEN: 0 }), false);
  assert.equal(docRegenEnabled({ KHY_DOCS_REGEN: false }), false);
  assert.equal(docRegenEnabled({ KHY_DOCS_REGEN: null }), true);
});

test('_stripExt: 只在最后一个点属于文件名时才剥（点号可出现在目录段）', () => {
  const table = [
    ['docs/X.md', 'docs/X'],
    ['a/b.c.md', 'a/b.c'],
    ['a.b/c', 'a.b/c'], // 点在斜杠之前 → 属于目录，不剥
    ['a/no-ext', 'a/no-ext'],
    ['noext', 'noext'],
    ['', ''],
    ['docs/07_OPS_运维/[OPS-MAN-043] 成长路线.md', 'docs/07_OPS_运维/[OPS-MAN-043] 成长路线'],
    ['.md', ''], // 点文件名退化情形：基名变成空串
    ['docs/.hidden', 'docs/'], // 隐藏文件：剥完只剩目录
  ];
  for (const [input, want] of table) {
    assert.equal(_stripExt(input), want, JSON.stringify(input));
  }
});

test('md-only（无 committed 兄弟）→ skip md-only，regen 恒空', () => {
  for (const committed of [[], null, undefined, 'docs/X.html', 42, ['']]) {
    const r = planDocProducts('docs/X.md', committed);
    assert.deepEqual(r.regen, []);
    assert.deepEqual(r.skip, [{ md: 'docs/X.md', reason: 'md-only' }]);
  }
});

test('committed .html 兄弟 → 一条 regen，mode 恰好是 --html-only', () => {
  const r = planDocProducts('docs/X.md', ['docs/X.html', 'docs/Other.html', 'docs/X.md']);
  assert.deepEqual(r.regen, [{ md: 'docs/X.md', products: ['docs/X.html'], mode: '--html-only' }]);
  assert.deepEqual(r.skip, [], '有产物兄弟时不再进 skip');
});

test('committed .html+.pdf 兄弟 → 全量（mode 严格等于 null，不是 undefined），产物升序', () => {
  const a = planDocProducts('docs/X.md', ['docs/X.pdf', 'docs/X.html']);
  const b = planDocProducts('docs/X.md', ['docs/X.html', 'docs/X.pdf']);
  assert.deepEqual(a, b, 'committed 清单顺序不得影响计划');
  assert.equal(a.regen.length, 1);
  assert.equal(a.regen[0].mode === null, true, 'mode 必须是 null（全量），而非 undefined');
  assert.deepEqual(a.regen[0].products, ['docs/X.html', 'docs/X.pdf']);
});

// 已修偏差：pdf-only 兄弟此前归为「全量」，而 md-to-pdf 无 flag 时默认同时写 .html 与
// .pdf（scripts/docs/md-to-pdf.js:581/585）——committed 清单里没有 .html 时就会新建一个
// 从未提交过的产物，「绝不新建产物」这条红线在该分支上不成立。复现
// .khy/feedback/b23-docsFreshness/repro-before.txt，复诊 repro-after.txt；planner 现给 '--pdf-only'。
test('committed 只有 .pdf → mode 为 --pdf-only，不新建未提交的 .html', () => {
  const r = planDocProducts('docs/X.md', ['docs/X.pdf']);
  assert.deepEqual(r.regen, [{ md: 'docs/X.md', products: ['docs/X.pdf'], mode: '--pdf-only' }]);
  assert.deepEqual(r.skip, []);
});

test('同名兄弟判据：其它文档的产物一律不算，跨目录不误伤', () => {
  const r = planDocProducts('docs/A.md', ['docs/B.html', 'docs/B.pdf', 'docs/sub/A.html']);
  assert.deepEqual(r.regen, []);
  assert.equal(r.skip[0].reason, 'md-only');
});

test('归一化：./ 、反斜杠、前导 / 与空白都能对上同名兄弟', () => {
  const r = planDocProducts('  ./docs\\X.md  ', ['docs\\X.html', '/docs/X.pdf ']);
  assert.deepEqual(r.regen, [
    { md: 'docs/X.md', products: ['docs/X.html', 'docs/X.pdf'], mode: null },
  ]);
});

test('非 .md 输入 → not-md（保留归一化后的 md 值）', () => {
  assert.deepEqual(planDocProducts('docs/X.txt', ['docs/X.html']), {
    regen: [],
    skip: [{ md: 'docs/X.txt', reason: 'not-md' }],
  });
  assert.deepEqual(planDocProducts(42, ['docs/42.html']), {
    regen: [],
    skip: [{ md: '42', reason: 'not-md' }],
  });
  assert.deepEqual(planDocProducts('docs/X.MD', []).skip, [{ md: 'docs/X.MD', reason: 'not-md' }]);
});

test('空 / null 输入 → 空计划（连 skip 都不造），绝不抛', () => {
  for (const input of ['', null, undefined]) {
    assert.deepEqual(planDocProducts(input, ['docs/X.html']), { regen: [], skip: [] });
  }
  // 非字符串入参先被 String() 化，因此走 not-md 而不是空计划。
  assert.deepEqual(planDocProducts({}, []), {
    regen: [],
    skip: [{ md: '[object Object]', reason: 'not-md' }],
  });
});

test('不变式：regen.products 永远是 committed 的子集（清单侧「绝不新建产物」）', () => {
  const committed = ['docs/X.html', 'docs/X.pdf', 'docs/Y.html'];
  for (const md of ['docs/X.md', './docs\\X.md', 'docs//X.md']) {
    const r = planDocProducts(md, committed);
    for (const item of r.regen) {
      for (const p of item.products) assert.equal(committed.includes(p), true, `${md} -> ${p}`);
    }
  }
  // docs//X.md 的基名带双斜杠，与 committed 的 docs/X.html 对不上 → 不进计划（现状锁定）。
  assert.deepEqual(planDocProducts('docs//X.md', committed).regen, []);
});

test('点文件名退化：.md 的「同名兄弟」是 .html/.pdf（现状锁定）', () => {
  const r = planDocProducts('.md', ['.html']);
  assert.deepEqual(r.regen, [{ md: '.md', products: ['.html'], mode: '--html-only' }]);
});

test('确定性：同一输入两次调用产出逐字节相同的计划', () => {
  const md = 'docs/07_OPS_运维/[OPS-MAN-043] 成长路线.md';
  const committed = ['docs/07_OPS_运维/[OPS-MAN-043] 成长路线.html', 'docs/Z.pdf'];
  assert.equal(
    JSON.stringify(planDocProducts(md, committed)),
    JSON.stringify(planDocProducts(md, committed)),
  );
  assert.equal(planDocProducts(md, committed).regen[0].mode, '--html-only');
});

test('纯度锁：本叶子零 require，且没有第二处 process.env 读取', () => {
  const src = require('node:fs').readFileSync(require.resolve('./docProductPlan'), 'utf8');
  assert.equal(src.includes('require('), false);
  assert.equal(src.includes('fs.'), false);
  assert.equal(src.includes('child_process'), false);
  const envLines = src
    .split(/\r?\n/)
    .filter((l) => l.includes('process.env') && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assert.deepEqual(envLines, ['function docRegenEnabled(env = process.env) {']);
});
