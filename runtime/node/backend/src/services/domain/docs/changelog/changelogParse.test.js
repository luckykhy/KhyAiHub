'use strict';

// Colocated tests for changelogParse.js (pure leaf: zero IO, never throws).

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('./changelogParse');

const SAMPLE = [
  '# Changelog',
  '',
  '## 0.2.0',
  '本版重写了回测引擎，并新增数据看板。',
  '',
  '### Highlights',
  '- **回测引擎 2.0**: 支持分钟级撮合',
  '  续接行也并入同一条亮点',
  '- 修复：`khy doctor` 误报',
  '',
  '### Compatibility',
  '- 需要 Python 3.10+',
  '---',
  '',
  '## 0.1.9',
  '小版本，仅修复。',
  '',
  '### Highlights',
  '- **热修**: 导出崩溃',
].join('\n');

test('parseChangelog 垃圾入参返空数组，绝不抛', () => {
  for (const raw of [null, undefined, '', 0, NaN, {}, [], '   ']) {
    assert.deepEqual(svc.parseChangelog(raw), []);
  }
});

test('parseChangelog：版本头前的前言整体忽略', () => {
  const entries = svc.parseChangelog(SAMPLE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '0.2.0');
  assert.equal(entries[1].version, '0.1.9'); // 物理顺序，新在上
});

test('parseChangelog：摘要段收束为单行字符串', () => {
  const entries = svc.parseChangelog(SAMPLE);
  assert.equal(entries[0].summary, '本版重写了回测引擎，并新增数据看板。');
  assert.equal(entries[1].summary, '小版本，仅修复。');
});

test('parseChangelog：Highlights 的 **粗体** 拆 title/detail，多行续接并合并空白', () => {
  const entries = svc.parseChangelog(SAMPLE);
  const hs = entries[0].highlights;
  assert.equal(hs.length, 2);
  assert.deepEqual(hs[0], { title: '回测引擎 2.0', detail: '支持分钟级撮合 续接行也并入同一条亮点' });
  assert.deepEqual(hs[1], { title: '修复：`khy doctor` 误报', detail: '' });
});

test('parseChangelog：非 Highlights 小节只进 sections 不进 highlights', () => {
  const entries = svc.parseChangelog(SAMPLE);
  assert.deepEqual(entries[0].sections, ['Compatibility']);
  assert.equal(entries[0].highlights.length, 2);
});

test('parseChangelog：--- 分隔线收束 bullet 但不结束条目', () => {
  const entries = svc.parseChangelog(SAMPLE);
  // '---' 在 Compatibility 小节内，不应产生 highlights，也不应截断 0.2.0
  assert.equal(entries[0].version, '0.2.0');
});

test('parseChangelog：CRLF 行分隔与 * 列表符', () => {
  const entries = svc.parseChangelog('## 1.0\r\n摘要 A\r\n\r\n### Highlights\r\n* **X**: y\r\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary, '摘要 A');
  assert.deepEqual(entries[0].highlights, [{ title: 'X', detail: 'y' }]);
});

test('parseChangelog：无版本头的纯文本 → 空数组（前言忽略契约）', () => {
  assert.deepEqual(svc.parseChangelog('随便什么\n没有版本行\n- 也不是亮点'), []);
});

test('splitHighlight：粗体有无、中文冒号、垃圾入参', () => {
  assert.deepEqual(svc.splitHighlight('**标题**: 详情'), { title: '标题', detail: '详情' });
  assert.deepEqual(svc.splitHighlight('**标题**：详情'), { title: '标题', detail: '详情' });
  assert.deepEqual(svc.splitHighlight('**只有粗体**'), { title: '只有粗体', detail: '' });
  assert.deepEqual(svc.splitHighlight('整句当标题'), { title: '整句当标题', detail: '' });
  assert.deepEqual(svc.splitHighlight(''), { title: '', detail: '' });
  assert.deepEqual(svc.splitHighlight(null), { title: '', detail: '' });
  // String() 强转语义：非字符串真值先转字符串再当标题
  assert.deepEqual(svc.splitHighlight(0), { title: '0', detail: '' });
  assert.deepEqual(svc.splitHighlight({}), { title: '[object Object]', detail: '' });
  assert.deepEqual(svc.splitHighlight('  **A**  '), { title: 'A', detail: '' });
});

test('selectReleaseNotes：version 精确匹配（忽略前导 v）', () => {
  const entries = svc.parseChangelog(SAMPLE);
  assert.equal(svc.selectReleaseNotes(entries, { version: '0.1.9' })[0].version, '0.1.9');
  assert.equal(svc.selectReleaseNotes(entries, { version: 'v0.2.0' })[0].version, '0.2.0');
  assert.equal(svc.selectReleaseNotes(entries, { version: 'V0.2.0' }).length, 1);
  assert.deepEqual(svc.selectReleaseNotes(entries, { version: '9.9.9' }), []);
});

test('selectReleaseNotes：无 version → 前 limit 条，limit 垃圾回退 1', () => {
  const entries = svc.parseChangelog(SAMPLE);
  assert.equal(svc.selectReleaseNotes(entries).length, 1);
  assert.equal(svc.selectReleaseNotes(entries, {}).length, 1);
  assert.equal(svc.selectReleaseNotes(entries, { limit: 2 }).length, 2);
  assert.equal(svc.selectReleaseNotes(entries, { limit: 99 }).length, 2);
  for (const bad of [0, -1, NaN, 'abc', null]) {
    assert.equal(svc.selectReleaseNotes(entries, { limit: bad }).length, 1, String(bad));
  }
});

test('selectReleaseNotes 垃圾入参返空/兜底', () => {
  assert.deepEqual(svc.selectReleaseNotes(null), []);
  assert.deepEqual(svc.selectReleaseNotes('x'), []);
  assert.deepEqual(svc.selectReleaseNotes(undefined, { version: '1.0.0' }), []);
});
