'use strict';

// Unit contract tests for docSuggestDraft.js — the Layer-4 pure prompt builder of the
// docsFreshness unit.
// Its two hard lines: (1) it only builds text (no model call, no file write), and
// (2) the deterministic layers (1/2/3 + runner default path) must never import it.
// Both lines are locked below, plus the exact prompt layout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { docSuggestEnabled, buildSuggestionPrompt } = require('./docSuggestDraft');

const HEADER = '你是文档维护助手。以下源码文件发生了改动,可能使某篇文档过时。';
const TASK =
  '你的任务:**只输出改稿建议**(具体到「把 X 改成 Y」),绝不直接改文件,绝不虚构未在 diff 中出现的事实。';
const FORMAT = [
  '输出格式(逐条):',
  '- 位置: <文档中大致位置/小节>',
  '- 现状: <当前描述,若已过时>',
  '- 建议: <应改为的描述>',
  '- 依据: <对应 diff 里的哪处变更>',
  '',
  '若无需修改,只回复「无需修改」。',
];

test('docSuggestEnabled: 默认关，只有 {1,true,on,yes} 开（与其它门控方向相反）', () => {
  assert.equal(docSuggestEnabled({}), false);
  for (const [raw, want] of [
    ['', false],
    ['0', false],
    ['x', false],
    ['off', false],
    ['no', false],
    ['1', true],
    ['true', true],
    ['on', true],
    ['yes', true],
    ['YES', true],
    [' On ', true],
  ]) {
    assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: raw }), want, JSON.stringify(raw));
  }
});

test('docSuggestEnabled: 取值先过 || 兜底，因此布尔 true/数字 1 算开，false/0/null 算关', () => {
  assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: true }), true);
  assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: 1 }), true);
  assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: false }), false);
  assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: 0 }), false);
  assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: null }), false);
  assert.equal(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: undefined }), false);
  const saved = process.env.KHY_DOCS_AI_SUGGEST;
  process.env.KHY_DOCS_AI_SUGGEST = '1';
  try {
    assert.equal(docSuggestEnabled({}), false, '注入的 {} 必须压过进程环境');
    assert.equal(docSuggestEnabled(), true, '缺省参数才读进程环境');
  } finally {
    if (saved === undefined) delete process.env.KHY_DOCS_AI_SUGGEST;
    else process.env.KHY_DOCS_AI_SUGGEST = saved;
  }
  assert.equal(docSuggestEnabled(), false, '恢复未设置 → 默认关');
});

test('buildSuggestionPrompt: 最小输入 → 逐字节固定骨架（无片段、无 diff）', () => {
  assert.equal(
    buildSuggestionPrompt(),
    [HEADER, TASK, '', '文档: (未指定文档)', '改动的源码: (未提供)', '', ...FORMAT].join('\n'),
  );
  assert.equal(buildSuggestionPrompt({}), buildSuggestionPrompt());
});

test('buildSuggestionPrompt: doc 取真值，0/空串/未定义都落回占位符；数字 42 原样转串', () => {
  assert.equal(buildSuggestionPrompt({ doc: 0 }).includes('文档: (未指定文档)'), true);
  assert.equal(buildSuggestionPrompt({ doc: '' }).includes('文档: (未指定文档)'), true);
  assert.equal(buildSuggestionPrompt({ doc: 42 }).includes('文档: 42'), true);
  assert.equal(buildSuggestionPrompt({ doc: 'docs/A.md' }).includes('文档: docs/A.md'), true);
});

test('buildSuggestionPrompt: matchedSources 用「, 」连接；非数组或空数组落回占位符', () => {
  assert.equal(
    buildSuggestionPrompt({ matchedSources: ['s1.js', 's2.js'] }).includes('改动的源码: s1.js, s2.js'),
    true,
  );
  assert.equal(buildSuggestionPrompt({ matchedSources: [] }).includes('改动的源码: (未提供)'), true);
  assert.equal(buildSuggestionPrompt({ matchedSources: 'a,b' }).includes('改动的源码: (未提供)'), true);
  assert.equal(buildSuggestionPrompt({ matchedSources: null }).includes('改动的源码: (未提供)'), true);
  // 数组里只有一个空串：判据只看 length，因此输出「改动的源码: 」（尾随空格）。
  assert.equal(buildSuggestionPrompt({ matchedSources: [''] }).includes('改动的源码: \n'), true);
});

test('buildSuggestionPrompt: 片段与 diff 的插入顺序、围栏与位置完全固定', () => {
  const p = buildSuggestionPrompt({
    doc: 'docs/A.md',
    matchedSources: ['s.js'],
    docSection: 'SEC',
    sourceDiff: 'DIF',
  });
  assert.equal(
    p,
    [
      HEADER,
      TASK,
      '',
      '文档: docs/A.md',
      '改动的源码: s.js',
      '',
      '文档相关片段:',
      '"""',
      'SEC',
      '"""',
      '',
      '源码变更 diff(节选):',
      '```diff',
      'DIF',
      '```',
      '',
      ...FORMAT,
    ].join('\n'),
  );
});

test('buildSuggestionPrompt: 只有片段时不出现 diff 围栏；只有 diff 时不出现三引号', () => {
  const onlySec = buildSuggestionPrompt({ docSection: 'SEC' });
  assert.equal(onlySec.includes('"""'), true);
  assert.equal(onlySec.includes('```diff'), false);
  const onlyDiff = buildSuggestionPrompt({ sourceDiff: 'DIF' });
  assert.equal(onlyDiff.includes('```diff'), true);
  assert.equal(onlyDiff.includes('"""'), false);
  assert.equal(onlyDiff.indexOf('源码变更 diff(节选):') > onlyDiff.indexOf('改动的源码:'), true);
});

test('buildSuggestionPrompt: 片段与 diff 各截到 4000 字符（纯空白片段/diff 视为不提供）', () => {
  const big = 'x'.repeat(9000);
  const p = buildSuggestionPrompt({ docSection: big, sourceDiff: big });
  const sec = p.split('文档相关片段:\n"""\n')[1].split('\n"""')[0];
  const diff = p.split('源码变更 diff(节选):\n```diff\n')[1].split('\n```')[0];
  assert.equal(sec.length, 4000);
  assert.equal(diff.length, 4000);
  assert.equal(p.includes('x'.repeat(4001)), false);
  assert.equal(buildSuggestionPrompt({ docSection: '   \n  ' }).includes('文档相关片段:'), false);
  assert.equal(buildSuggestionPrompt({ sourceDiff: '  ' }).includes('源码变更 diff'), false);
});

test('红线①：本叶子是纯文本构造器——零 require、零 IO、不碰网关', () => {
  const src = fs.readFileSync(require.resolve('./docSuggestDraft'), 'utf8');
  assert.equal(src.includes('require('), false);
  for (const forbidden of ['fs.', 'child_process', 'aiGateway', 'execFileSync', 'writeFileSync', 'fetch(']) {
    assert.equal(src.includes(forbidden), false, forbidden);
  }
  const envLines = src
    .split(/\r?\n/)
    .filter((l) => l.includes('process.env') && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assert.deepEqual(envLines, ['function docSuggestEnabled(env = process.env) {']);
});

test('红线②：确定性层（Layer 1/2/3 + runner）源码里绝不出现 docSuggestDraft', () => {
  const dir = path.dirname(require.resolve('./docSuggestDraft'));
  const deterministic = ['docPathIndex.js', 'docProductPlan.js', 'docMarkerSync.js', 'docsFreshnessRunner.js'];
  for (const f of deterministic) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(src.includes('docSuggestDraft'), false, `${f} 不得依赖 Layer 4`);
    assert.equal(src.includes('buildSuggestionPrompt'), false, f);
  }
});

test('导出面恰为两个函数（新增导出必须是显式决定）', () => {
  const mod = require('./docSuggestDraft');
  assert.deepEqual(Object.keys(mod).sort(), ['buildSuggestionPrompt', 'docSuggestEnabled']);
  for (const fn of Object.values(mod)) assert.equal(typeof fn, 'function');
});
