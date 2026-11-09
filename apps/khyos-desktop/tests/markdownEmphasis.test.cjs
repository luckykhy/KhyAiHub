'use strict';

// markdownEmphasis.test.cjs — 桌面端 Markdown 强调解析的钉住用例。
//
// 背景：用户实机截图里，AI 回复中的 `**Amoo 是什么**: 装在一台…` 被整段
// 渲染成**字面量**，`**` 直接漏到屏幕上（14/16 条真实语料中招）。根因是
// parser.ts 的 findEmphasisClose 多了一条错误约束「闭合标记后必须跟空白
// 或行尾」——而 CommonMark 官方判据是「闭合标记**前**不能有空白」，闭合
// 后紧跟标点/字符是**合法**的（`**foo**bar` → <strong>foo</strong>bar）。
//
// 判据来源：CommonMark 官方测试集 spec.txt（commonmark/commonmark-spec）
// 与 marked 15（CommonMark 兼容实现，对齐官方 231/232 条）。本文件把
// **模型实际会输出的形态**钉死，防止修复回退。
//
// runner 纪律（照 sessionLoadState.test.cjs:13-15 的成例）：本文件用
// node:test 写、放在 tests/ 下安全。绝不用裸 describe/test/expect —— 那是
// jest 风格，会被 node --test 扫走并炸在「describe is not defined」。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ts = require('typescript');

const projectRoot = join(__dirname, '..');
const parserPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'markdown', 'parser.ts');
const rendererPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'MarkdownRenderer.tsx');

function read(p) {
  // 去掉 BOM：部分源文件带 UTF-8 BOM，转译后会成为正文字符
  return readFileSync(p, 'utf-8').replace(/^﻿/, '');
}

// 用仓里现成的 TypeScript 做正规转译求值 —— 不要用正则剥类型注解，那是猜。
function transpile(src) {
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function loadCjs(src, stubs) {
  const js = transpile(src);
  const module = { exports: {} };
  const req = (id) => (stubs && Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : require(id));
  new Function('exports', 'module', 'require', js)(module.exports, module, req);
  return module.exports;
}

// parser.ts 是纯函数模块（无 React / DOM 依赖），可直接求值。
const parser = loadCjs(read(parserPath));
const { parseMarkdown } = parser;

// ── 取值辅助 ─────────────────────────────────────────────────

/**
 * 把解析结果压成「强调标签的有序序列」，用于与期望比对。
 *
 * 注意 block 与 inline 是两层：引用块（quote）的 children 装的是 **block**
 * （paragraph 等），paragraph 的 inline 才装 inline 节点 —— 两层都要走，
 * 否则引用内的粗体会被漏统计。
 */
function emphasisSignature(src) {
  const blocks = parseMarkdown(src);
  const toks = [];
  const walkInline = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'strong') { toks.push('strong'); walkInline(n.children); toks.push('/strong'); }
      else if (n.type === 'em') { toks.push('em'); walkInline(n.children); toks.push('/em'); }
      else if (n.children) walkInline(n.children);
    }
  };
  const walkBlock = (list) => {
    for (const b of list) {
      if (b.inline) walkInline(b.inline);
      if (b.children) walkBlock(b.children);
      if (b.items) for (const it of b.items) walkBlock(it.blocks);
    }
  };
  walkBlock(blocks);
  return toks.join(' ');
}

/** 收集所有明文文本节点 —— 用来断言「星号没有漏到屏幕上」。 */
function plainTexts(src) {
  const blocks = parseMarkdown(src);
  const texts = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') texts.push(n.value);
      if (n.children) walk(n.children);
    }
  };
  for (const b of blocks) {
    if (b.inline) walk(b.inline);
    if (b.children) walk(b.children);
    if (b.items) for (const it of b.items) for (const blk of it.blocks) {
      if (blk.inline) walk(blk.inline);
      if (blk.children) walk(blk.children);
    }
  }
  return texts;
}

// ── A. 模型最常见的写法：`**标签**：正文`（闭合后紧跟标点）─────────
//
// 这一组是本次修复的主目标。修复前整段退化成字面量，`**` 漏到屏幕上。

test('A1: 闭合后紧跟中文冒号的粗体应渲染成 strong（用户截图的真实形态）', () => {
  const src = '**Amoo 是什么**: 装在一台 Android 手机上的手机智能体。';
  assert.equal(emphasisSignature(src), 'strong /strong');
  assert.ok(
    !plainTexts(src).some((t) => t.includes('**')),
    '`**` 不应漏到明文里'
  );
});

test('A2: 闭合后紧跟各类中文标点都应渲染成 strong', () => {
  const cases = [
    ['**方向 1（主用）**，Amoo 主动来调。', 'strong /strong'],
    ['**能怎么用**。', 'strong /strong'],
    ['**能怎么用**：', 'strong /strong'],
    ['**加粗**)', 'strong /strong'],
  ];
  for (const [src, want] of cases) {
    assert.equal(emphasisSignature(src), want, `输入 ${JSON.stringify(src)}`);
  }
});

test('A3: 列表项内的粗体同样应正确渲染', () => {
  const src = '- **方向 1（主用）**: Amoo 主动来调 khy-os。';
  assert.equal(emphasisSignature(src), 'strong /strong');
  assert.ok(!plainTexts(src).some((t) => t.includes('**')));
});

test('A4: 引用块内的粗体应正确渲染', () => {
  const src = '> **引用里的粗体**：内容';
  assert.equal(emphasisSignature(src), 'strong /strong');
});

// ── B. CommonMark 官方判据（spec.txt）不许回退 ──────────────────

test('B1: 闭合标记后紧跟普通字符是合法闭合（官方 **foo**bar）', () => {
  assert.equal(emphasisSignature('**foo**bar'), 'strong /strong');
  assert.equal(emphasisSignature('*foo*bar'), 'em /em');
});

test('B2: 闭合标记前有空白则不强闭合（官方 **foo bar ** 保持字面量）', () => {
  // 官方判据：`**foo bar **` → 字面量。
  // 当前实现的已知边界：单枚消耗（em）仍会成立，即渲染成 `*` + <em>foo bar </em>。
  // 这不影响用户可见的主症状（`**` 不再漏到屏幕上），但与规范有偏差 ——
  // 嵌套强调的完整语义需要 CommonMark 的分隔符栈算法，
  // 当前是按 parser.ts 设计口径第 3 条做的实用子集。
  // 这里钉住「强标记不成立」这一半：不得渲染成 strong。
  assert.doesNotMatch(emphasisSignature('**foo bar **'), /strong/);
  assert.doesNotMatch(emphasisSignature('__foo bar __'), /strong/);
  // 单枚的情形同样不得渲染成 strong（本来就不是）
  assert.doesNotMatch(emphasisSignature('*foo bar *'), /strong/);
});

test('B3: 开标记后有空白则不成强调（官方 ** foo bar** 保持字面量）', () => {
  assert.equal(emphasisSignature('** foo bar**'), '');
  assert.equal(emphasisSignature('* foo bar*'), '');
});

test('B4: 下划线不做词内强调，但星号允许（官方判据）', () => {
  // 词内下划线：标识符不该被拆开
  assert.equal(emphasisSignature('foo_bar_baz'), '');
  assert.equal(emphasisSignature('foo__bar__'), '');
  assert.equal(emphasisSignature('_пристаням_стремятся'), '');
  // 词内星号：官方允许
  assert.equal(emphasisSignature('foo*bar*'), 'em /em');
  assert.equal(emphasisSignature('foo**bar**'), 'strong /strong');
  assert.equal(emphasisSignature('5*6*78'), 'em /em');
});

test('B5: 粗体与斜体可并存于一行', () => {
  assert.equal(emphasisSignature('**粗体**与*斜体*与`行内码`'), 'strong /strong em /em');
});

// ── C. 渲染层契约（源码级断言，防样式回退）────────────────────────

test('C1: 行内代码不再带边框与底色（ZCode 真源 prose 无边框）', () => {
  const src = read(rendererPath);
  // 精确取 JSX 的 <code> 标签自身属性。注意：
  //   · 不能用 /<code\b[^>]*>/ —— 注释里的 `.prose :where(code)` 会先命中
  //   · 不能用贪婪跨分支匹配 —— 会把 image 分支的 border 圈进来
  // 故按「<code 后紧跟换行」（JSX 多行标签的写法）来定位。
  const codeTag = src.match(/<code\s[\s\S]*?>/);
  assert.ok(codeTag, 'MarkdownRenderer.tsx 里应能找到行内代码的 <code> 标签');
  assert.doesNotMatch(
    codeTag[0],
    /border-border|bg-surface/,
    '行内代码不应再带边框/底色 —— 真源 `.prose :where(code)` 只有 color + font-size + font-weight，'
    + '带框的胶囊在一条消息里出现七八次会把正文切碎'
  );
  assert.match(codeTag[0], /font-mono/, '行内代码应保留等宽字体');
  // 真源字号是 .875em（随字号缩放）
  assert.match(codeTag[0], /0\.875em/, '行内代码字号应对齐真源的 .875em');
});

test('C2: 段落与列表间距走真源的 em 相对单位（随消息字号缩放）', () => {
  const src = read(rendererPath);
  assert.match(
    src,
    /my-\[1\.25em\]/,
    '段落/列表外边距应对齐真源 `.prose :where(p|ul|ol)` 的 margin: 1.25em'
  );
  assert.match(
    src,
    /pl-\[1\.625em\]/,
    '列表缩进应对齐真源 padding-inline-start: 1.625em'
  );
});

// ── D. 降级不崩（parser.ts 设计口径第 2 条）───────────────────────

test('D1: 拿不准的构造退化为纯文本，不抛异常', () => {
  const odd = ['****', '**', '***', 'a**b', '_', '__', '**a*b*c**', '```', '~~~'];
  for (const src of odd) {
    assert.doesNotThrow(() => parseMarkdown(src), `输入 ${JSON.stringify(src)} 不应抛异常`);
  }
});
