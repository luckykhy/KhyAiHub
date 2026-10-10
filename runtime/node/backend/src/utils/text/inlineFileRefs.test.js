'use strict';

// 单元契约测试：inlineFileRefs 的「文档扩展名集合与图片集合刻意不相交」「引号优先且不重叠」
// 「按出现序去重」「绝不抛」三条契约。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const refs = require('./inlineFileRefs');

test('导出面与零 require 纯度', () => {
  assert.deepEqual(Object.keys(refs).sort(), [
    'D7_MEDIA_EXT_SET',
    'FILE_EXT_SET',
    '_pathAtomQuoted',
    '_pathAtomUnquoted',
    'extractAllFileReferences',
    'scanPathRefs',
  ]);
  const src = fs.readFileSync(path.join(__dirname, 'inlineFileRefs.js'), 'utf8');
  assert.ok(!src.includes('require('), '本叶子必须零 require');
});

test('图片扩展名不在文档集合里（先图后文合并才无歧义）', () => {
  for (const img of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.ok(!refs.FILE_EXT_SET.split('|').includes(img), `FILE_EXT_SET 混入了图片扩展名 ${img}`);
  }
  assert.ok(refs.FILE_EXT_SET.split('|').includes('md'));
  assert.ok(refs.FILE_EXT_SET.split('|').includes('json'));
  // D7 媒体/归档集是「追加」而非「替换」，且同样不含图片原子那五个
  for (const img of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.ok(!refs.D7_MEDIA_EXT_SET.split('|').includes(img), `D7 集混入 ${img}`);
  }
});

test('空/垃圾入参 → 空数组，绝不抛', () => {
  for (const junk of ['', '   ', null, undefined, 123, {}, []]) {
    assert.deepEqual(refs.extractAllFileReferences(junk), []);
  }
});

test('扫出多个文档路径，按出现序返回（引擎不吐 idx，只给 filePath/span）', () => {
  const out = refs.extractAllFileReferences('先看 /tmp/report.md 再看 D:\\data\\notes.txt');
  assert.deepEqual(out.map((e) => e.filePath), ['/tmp/report.md', 'D:\\data\\notes.txt']);
  assert.deepEqual(Object.keys(out[0]).sort(), ['filePath', 'span']);
  assert.ok(out[0].span.includes('/tmp/report.md'));
});

test('同一路径重复出现只留首现（去重）', () => {
  const out = refs.extractAllFileReferences('/a/x.md 以及 /a/x.md 再说一遍 /a/x.md');
  assert.equal(out.length, 1);
});

test('引号形态优先占位：带空格路径整条收，未引号扫描不得重叠切入', () => {
  const quoted = refs.extractAllFileReferences('打开 "/tmp/my report.md" 谢谢');
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].filePath, '/tmp/my report.md');
});

test('D7 追加集：默认不认 .zip，传入 extraExtSet 后认', () => {
  assert.deepEqual(refs.extractAllFileReferences('附件 /tmp/pack.zip'), []);
  const withD7 = refs.extractAllFileReferences('附件 /tmp/pack.zip', refs.D7_MEDIA_EXT_SET);
  assert.deepEqual(withD7.map((e) => e.filePath), ['/tmp/pack.zip']);
});

test('正则原子由入参驱动：scanPathRefs 只认给它的扩展集', () => {
  const quotedAtom = refs._pathAtomQuoted('log');
  const unquoted = `(${refs._pathAtomUnquoted('log')})`;
  const out = refs.scanPathRefs('/var/a.log 与 /var/b.md', quotedAtom, unquoted);
  assert.deepEqual(out.map((e) => e.filePath), ['/var/a.log']);
});
