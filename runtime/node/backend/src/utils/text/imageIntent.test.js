'use strict';

// 单元契约测试：图片意图抽取的三条契约——扩展名原子只认图（与文档集合互斥）、
// 引号形态优先、多路径非重叠扫描；以及场景提示的历史过滤规则。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ii = require('./imageIntent');
const refs = require('./inlineFileRefs');

test('导出面 + 单元内互引（只准引 ./inlineFileRefs，不得伸回 cli/）', () => {
  assert.deepEqual(Object.keys(ii).sort(), [
    'buildContextualImagePrompt',
    'buildImageSceneHint',
    'buildWebRebuildPrompt',
    'extractAllInlineImageIntents',
    'extractInlineImageIntent',
    'isWebRebuildIntent',
  ]);
  const src = fs.readFileSync(path.join(__dirname, 'imageIntent.js'), 'utf8');
  const requires = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.ok(requires.includes('./inlineFileRefs'), '引擎真源就是同目录的 inlineFileRefs');
  for (const r of requires) {
    assert.ok(!/\.\.[\/\\](cli|services|routes)[\/\\]/.test(r), `伸回运行时：${r}`);
  }
});

test('图片原子与文档扩展名集合互斥（先图后文合并才无歧义）', () => {
  for (const img of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.ok(!refs.FILE_EXT_SET.split('|').includes(img));
  }
  assert.equal(ii.extractInlineImageIntent('/tmp/a.md'), null, '文档路径不该被图片抽取器认领');
});

test('空/无路径/垃圾入参 → null，绝不抛', () => {
  for (const junk of ['', '   ', '随便说点什么', null, undefined, 42]) {
    assert.equal(ii.extractInlineImageIntent(junk), null);
  }
});

test('引号形态优先：带空格的 Windows 路径整条认领，剩余文本进 prompt', () => {
  const out = ii.extractInlineImageIntent('帮我看看 "C:\\tmp\\my shot.png" 这个报错');
  assert.equal(out.filePath, 'C:\\tmp\\my shot.png');
  assert.equal(typeof out.prompt, 'string');
  assert.ok(out.prompt.length > 0);
  assert.ok(!out.prompt.includes('my shot.png'), '路径不得残留在 prompt 里');
});

test('未引号形态：Unix 绝对路径也可识别', () => {
  const out = ii.extractInlineImageIntent('/var/log/screen.jpg 看一下');
  assert.equal(out.filePath, '/var/log/screen.jpg');
});

test('多路径扫描按出现序返回；同一路径的引号态与裸态只留首现（不重叠、不重复）', () => {
  const two = ii.extractAllInlineImageIntents('对比 "/a/x.png" 和 /b/y.jpg 两张图');
  assert.deepEqual(two.map((e) => e.filePath), ['/a/x.png', '/b/y.jpg']);
  assert.ok(two[0].span.includes('x.png') && two[1].span.includes('y.jpg'));
  const dup = ii.extractAllInlineImageIntents('"/a/x.png" 再说一次 /a/x.png');
  assert.deepEqual(dup.map((e) => e.filePath), ['/a/x.png']);
});

test('网页还原意图：动作+对象双序都要认，无关句不认', () => {
  assert.equal(ii.isWebRebuildIntent('把这张网页截图还原成 html'), true);
  assert.equal(ii.isWebRebuildIntent('recreate this website from the screenshot'), true);
  assert.equal(ii.isWebRebuildIntent('今天天气如何'), false);
  assert.equal(ii.isWebRebuildIntent(''), false);
});

test('网页还原提示词：空入参回退默认目标，正文含七条要求与输出格式', () => {
  const p = ii.buildWebRebuildPrompt('');
  assert.ok(p.includes('请把这张网页截图还原成可运行网页代码。'));
  assert.ok(p.includes('请按以下要求执行：'));
  assert.ok(p.includes('```html'));
});

test('场景提示：取最近 4 条真实历史，过滤斜杠命令与粘贴噪声', () => {
  assert.equal(ii.buildImageSceneHint('基线', []), '基线');
  assert.equal(ii.buildImageSceneHint('基线', 'not-an-array'), '基线');
  const hist = ['/status', '粘贴', '第一句', '第二句', '第三句', '第四句', '第五句'];
  assert.equal(ii.buildImageSceneHint('基线', hist), '基线 第二句 第三句 第四句 第五句');
});

test('上下文化提示：泛泛指令换成场景模板，具体诉求原样保留', () => {
  assert.equal(ii.buildContextualImagePrompt('分析这张图片', '报错 traceback'),
    '请先提取图片中的报错/堆栈信息，再定位可能原因，并给出可执行的修复步骤。');
  assert.equal(ii.buildContextualImagePrompt('把这个按钮改成圆角', ''), '把这个按钮改成圆角');
});
