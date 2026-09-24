'use strict';

/**
 * releaseNotesMarkdownStrip.test.js — `_renderEntry` 摘要脱 markdown 契约。
 *
 * 复现的真实缺陷:`khy release-notes` 把 CHANGELOG.md 的 blockquote 摘要原样打终端,
 * 里面是终端无渲染器的 markdown —— 反引号、行首 `>`、以及被 URL 编码成 %5B/%5D 的
 * `` `[DESIGN-ARCH-138]`(docs/…%5BDESIGN-ARCH-138%5D…md) `` 式嵌套链接,一屏读不懂。
 * 修复只脱行内记号、不删正文;`## 版本` 头部是既有契约(releaseNotes.test.js 锁定)须保留。
 */

const assert = require('assert');
const nt = require('node:test');

const { _renderEntry } = require('../../../src/cli/handlers/releaseNotes');

nt.test('嵌套 URL 编码链接 / 反引号 / blockquote 全脱成纯文本', () => {
  const entry = {
    version: '1.2.0',
    summary:
      '> 修复记录：`BUG-014` ｜ 设计真源：[`[DESIGN-ARCH-138]`](docs/03_DESIGN_设计/DESIGN-ARCH/%5BDESIGN-ARCH-138%5D%20工具调用.md) ｜ 取证。',
    highlights: [],
    sections: [],
  };
  const out = _renderEntry(entry);
  // 非空断言:确认真的读进了摘要(防空转假绿)。
  assert.ok(out.includes('修复记录'), '正文须保留');
  // 旧的 markdown 记号必须消失。
  assert.ok(!out.includes('`'), '反引号须被脱掉');
  assert.ok(!out.includes('%5B'), 'URL 编码路径须整段消失');
  assert.ok(!out.includes('(docs/'), '链接目标须被删掉');
  assert.ok(!/> 修复/.test(out), '行首 blockquote 标记须被去掉');
  // 规则 ID 以可读形式存活。
  assert.ok(out.includes('[DESIGN-ARCH-138]'), '链接 label 须保留为纯文本');
});

nt.test('普通 [label](url) 脱去 url 与 **粗体**(label 的方括号刻意保留)', () => {
  const out = _renderEntry({
    version: '2.0.0',
    summary: '见 [官网](https://example.com) 的 **重点** 说明。',
    highlights: [],
    sections: [],
  });
  // 链接目标(含 URL)整段删除,label 文本存活。
  assert.ok(out.includes('官网'), 'label 须保留');
  assert.ok(!out.includes('https://example.com'), 'URL 须消失');
  assert.ok(!out.includes(']('), '不得残留 ]( 链接语法');
  // 粗体记号脱掉,内容存活。
  assert.ok(!out.includes('**'), '粗体记号须消失');
  assert.ok(out.includes('重点'), '粗体内容须保留');
});

nt.test('纯文本摘要逐字节不变 + 版本头 `## ` 保留(既有契约)', () => {
  const out = _renderEntry({
    version: '0.3.0',
    summary: '这是一段没有任何 markdown 的普通中文摘要。',
    highlights: [{ title: 'A', detail: '' }],
    sections: ['Fixed'],
  });
  assert.ok(/^## 0\.3\.0/m.test(out), '## 版本头部须原样保留');
  assert.ok(out.includes('这是一段没有任何 markdown 的普通中文摘要。'), '纯文本摘要须逐字不变');
  assert.ok(out.includes('• A'), '亮点仍渲染');
});
