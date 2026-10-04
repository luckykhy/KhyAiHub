'use strict';

/**
 * Co-located tests for contentSchema.js — the closed semantic AST plus the
 * 防呆 interception that rejects raw typesetting codes smuggled inside text.
 *
 * Pinned contract from the file header: the model emits ONLY semantic blocks
 * (no \textbf / <b> / w: tags / RTF), `code` block bodies are exempt because they
 * render verbatim, and pagebreak is the only pagination block.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cs = require('./contentSchema.js');

// Written in a JS source escape so the value is one literal backslash + textbf.
const LATEX_BF = '\\textbf{X}';

describe('块型封闭集', () => {
  test('九种块型，且 JSON Schema 的 enum 与真源逐项相等', () => {
    assert.deepEqual([...cs.BLOCK_TYPES].sort(), [
      'code', 'figure', 'heading', 'list', 'pagebreak', 'paragraph', 'quote', 'reference', 'table',
    ].sort());
    assert.deepEqual(
      cs.DOCUMENT_JSON_SCHEMA.properties.blocks.items.properties.type.enum,
      [...cs.BLOCK_TYPES]
    );
  });

  test('未知块型 → 报错并把允许集摊开给用户', () => {
    const r = cs.validateBlock({ type: 'mystery' }, 0);
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /^block\[0\] has unknown type "mystery"; allowed: heading, paragraph/);
  });

  test('非对象块（数组 / null / 字符串）一律拒', () => {
    for (const bad of [[1], null, 'x', 7]) {
      assert.strictEqual(cs.validateBlock(bad, 3).valid, false, JSON.stringify(bad));
      assert.match(cs.validateBlock(bad, 3).error, /block\[3\] must be an object/);
    }
  });
});

describe('逐块型结构判据', () => {
  test('heading：level 必须是 1..6 的整数，text 非空', () => {
    assert.deepEqual(cs.validateBlock({ type: 'heading', level: 1, text: '标题' }, 0), { valid: true });
    assert.deepEqual(cs.validateBlock({ type: 'heading', level: 6, text: '标题' }, 0), { valid: true });
    for (const level of [0, 7, -1, 1.5, '2', null, undefined, NaN]) {
      assert.strictEqual(cs.validateBlock({ type: 'heading', level, text: 'x' }, 0).valid, false, String(level));
    }
    assert.strictEqual(cs.validateBlock({ type: 'heading', level: 2, text: '  ' }, 0).valid, false);
    assert.strictEqual(cs.MAX_HEADING_LEVEL, 6);
  });

  test('paragraph：text 或 runs 二选一，runs 每项要带字符串 text', () => {
    assert.deepEqual(cs.validateBlock({ type: 'paragraph', text: '正文' }, 0), { valid: true });
    assert.deepEqual(cs.validateBlock({ type: 'paragraph', runs: [{ text: '甲' }, { text: '乙', bold: true }] }, 0),
      { valid: true });
    assert.match(cs.validateBlock({ type: 'paragraph' }, 0).error, /needs "text" or "runs"/);
    assert.match(cs.validateBlock({ type: 'paragraph', runs: [{ text: 5 }] }, 0).error, /runs\[0\]\.text must be a string/);
    assert.match(cs.validateBlock({ type: 'paragraph', runs: [null] }, 0).error, /runs\[0\]\.text must be a string/);
  });

  test('list：items 必须是非空字符串数组', () => {
    assert.deepEqual(cs.validateBlock({ type: 'list', ordered: false, items: ['甲'] }, 0), { valid: true });
    assert.match(cs.validateBlock({ type: 'list', items: [] }, 0).error, /non-empty array/);
    assert.match(cs.validateBlock({ type: 'list', items: [1] }, 0).error, /must all be strings/);
    assert.match(cs.validateBlock({ type: 'list' }, 0).error, /non-empty array/);
  });

  test('table：rows 非空且每格是字符串，header 给了就得是字符串数组', () => {
    assert.deepEqual(cs.validateBlock({ type: 'table', header: ['a'], rows: [['1']] }, 0), { valid: true });
    assert.match(cs.validateBlock({ type: 'table', rows: [] }, 0).error, /non-empty array of arrays/);
    assert.match(cs.validateBlock({ type: 'table', rows: [['a'], 'b'] }, 0).error, /must be arrays of strings/);
    assert.match(cs.validateBlock({ type: 'table', rows: [[1]] }, 0).error, /must be arrays of strings/);
    assert.match(cs.validateBlock({ type: 'table', rows: [['a']], header: 'a' }, 0).error, /table\.header must be an array of strings/);
  });

  test('quote 非空、code 只要字符串、pagebreak 无载荷、figure 字段按类型、reference 非空字符串数组', () => {
    assert.deepEqual(cs.validateBlock({ type: 'quote', text: '引用' }, 0), { valid: true });
    assert.strictEqual(cs.validateBlock({ type: 'quote', text: '  ' }, 0).valid, false);
    assert.deepEqual(cs.validateBlock({ type: 'code', text: '', lang: 'js' }, 0), { valid: true });
    assert.match(cs.validateBlock({ type: 'code', text: 5 }, 0).error, /code\.text must be a string/);
    assert.deepEqual(cs.validateBlock({ type: 'pagebreak' }, 0), { valid: true });
    assert.match(cs.validateBlock({ type: 'figure', path: 5 }, 0).error, /figure\.path must be a string/);
    assert.match(cs.validateBlock({ type: 'figure', caption: 5 }, 0).error, /figure\.caption must be a string/);
    assert.match(cs.validateBlock({ type: 'reference', entries: [] }, 0).error, /non-empty array/);
    assert.match(cs.validateBlock({ type: 'reference', entries: [1] }, 0).error, /must all be strings/);
  });
});

describe('scanFormatCodes：五类禁入格式码', () => {
  test('LaTeX 排版/分页命令', () => {
    for (const [src, label] of [
      [LATEX_BF, 'LaTeX command'],
      ['\\newpage', 'LaTeX command'],
      ['\\vspace{1cm}', 'LaTeX command'],
      ['\\section{甲}', 'LaTeX command'],
    ]) {
      const r = cs.scanFormatCodes(src);
      assert.strictEqual(r.clean, false, src);
      assert.strictEqual(r.label, label, src);
    }
  });

  test('裸宏（\word{）即便不在命令清单里也拦', () => {
    const r = cs.scanFormatCodes('\\usepackage{fontspec}');
    assert.strictEqual(r.clean, false);
    assert.strictEqual(r.label, 'LaTeX macro');
    assert.strictEqual(r.match, '\\usepackage{');
  });

  test('HTML / XML（含 WordprocessingML 的 w: 前缀）', () => {
    for (const src of ['<b>x</b>', '<font size="2">', '<w:tbl>', '<h1>甲</h1>']) {
      assert.strictEqual(cs.scanFormatCodes(src).label, 'HTML/XML tag', src);
    }
  });

  test('行内 CSS 与 RTF 控制字', () => {
    assert.strictEqual(cs.scanFormatCodes('style="font-size:12pt"').label, 'inline CSS');
    assert.strictEqual(cs.scanFormatCodes('{\\rtf1\\ansi}').label, 'RTF control word');
  });

  test('不误伤普通正文：不等式、英文单词里的 end/bf、空串与非字符串', () => {
    assert.deepEqual(cs.scanFormatCodes('a < b 与 x > y'), { clean: true });
    assert.deepEqual(cs.scanFormatCodes('the end of it'), { clean: true });
    assert.deepEqual(cs.scanFormatCodes(''), { clean: true });
    assert.deepEqual(cs.scanFormatCodes(null), { clean: true });
    assert.deepEqual(cs.scanFormatCodes(42), { clean: true });
  });
});

describe('防呆拦截落进每个文本位，code 正文豁免', () => {
  test('heading / 段落 run / 列表项 / 引用 / 表头 / 单元格 / 条目 / 图注 逐一被扫', () => {
    const smuggled = (block) => cs.validateBlock(block, 0);
    assert.strictEqual(smuggled({ type: 'heading', level: 1, text: LATEX_BF }).valid, false);
    assert.strictEqual(smuggled({ type: 'paragraph', runs: [{ text: '<b>甲</b>' }] }).valid, false);
    assert.strictEqual(smuggled({ type: 'list', items: ['正常', LATEX_BF] }).valid, false);
    assert.strictEqual(smuggled({ type: 'quote', text: LATEX_BF }).valid, false);
    assert.strictEqual(smuggled({ type: 'table', header: [LATEX_BF], rows: [['ok']] }).valid, false);
    assert.strictEqual(smuggled({ type: 'table', rows: [['<i>格</i>']] }).valid, false);
    assert.strictEqual(smuggled({ type: 'reference', entries: [LATEX_BF] }).valid, false);
    assert.strictEqual(smuggled({ type: 'figure', caption: LATEX_BF }).valid, false);
  });

  test('code 正文里的反斜杠与标签放行（逐字进等宽，永不被解释）', () => {
    assert.deepEqual(cs.validateBlock({ type: 'code', text: '\\textbf{x} <b>' }, 0), { valid: true });
  });

  test('错误消息给得出「是哪一类码、命中了什么、该怎么办」', () => {
    const r = cs.validateBlock({ type: 'paragraph', text: LATEX_BF }, 7);
    assert.match(r.error, /block\[7\] \(paragraph\) contains a forbidden LaTeX command \("\\textbf"\)/);
    assert.match(r.error, /style template/);
  });
});

describe('validateDocument：文档级判据', () => {
  test('非对象 / 数组 / blocks 缺失 / type 与 title 与 meta 类型不符', () => {
    assert.match(cs.validateDocument(null).error, /document must be an object/);
    assert.match(cs.validateDocument([]).error, /document must be an object/);
    assert.match(cs.validateDocument({ title: 'x' }).error, /document\.blocks must be an array/);
    assert.match(cs.validateDocument({ type: 'doc', blocks: [] }).error, /must be "document"/);
    assert.match(cs.validateDocument({ title: 5, blocks: [] }).error, /document\.title must be a string/);
    assert.match(cs.validateDocument({ meta: [1], blocks: [] }).error, /document\.meta must be an object/);
  });

  test('type 省略是允许的（blocks 才是必需项）', () => {
    assert.deepEqual(cs.validateDocument({ blocks: [{ type: 'pagebreak' }] }), { valid: true });
    assert.deepEqual(cs.validateDocument({ type: 'document', blocks: [] }), { valid: true });
  });

  test('title 同样受防呆扫描', () => {
    const r = cs.validateDocument({ title: LATEX_BF, blocks: [] });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /document\.title contains a forbidden LaTeX command/);
  });

  test('逐块校验，第一条违规即返回（不累积）', () => {
    const r = cs.validateDocument({
      blocks: [{ type: 'paragraph', text: 'ok' }, { type: 'mystery' }, { type: 'quote', text: LATEX_BF }],
    });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /block\[1\] has unknown type/);
  });

  test('块数上限 20000', () => {
    assert.deepEqual(cs.validateDocument({ blocks: new Array(2).fill({ type: 'pagebreak' }) }), { valid: true });
    assert.match(cs.validateDocument({ blocks: new Array(20001).fill({ type: 'pagebreak' }) }).error,
      /too many blocks \(>20000\)/);
  });
});

describe('KNOWN-DEFECT：meta 完全不过防呆', () => {
  // 头注释的判据 #2 是「拒绝夹在文本里的原始排版码」，title 与各块文本都扫，
  // meta 的 author / abstract / keywords 却一行都不扫：同样的 \textbf 放进
  // title 被拒，放进 meta.abstract 就长驱直入渲染层。
  test('meta 夹带 LaTeX 与 HTML，validateDocument 仍判 valid', () => {
    const r = cs.validateDocument({
      title: '正常标题',
      meta: { author: LATEX_BF, abstract: '见 <b>乙</b>', keywords: ['\\vspace{1cm}'] },
      blocks: [{ type: 'paragraph', text: '正文' }],
    });
    assert.deepEqual(r, { valid: true });
  });
});

describe('KNOWN-DEFECT：封闭集只封块型，不封字段', () => {
  // 「AST 刻意小而封闭」针对的是 block type；块上的未知字段照单全收，
  // 于是 {text:'x', fontSize:99} 这类伪装成语义结构的排版主张能穿过校验器。
  test('块上的任意未知字段不影响 valid', () => {
    assert.deepEqual(cs.validateBlock({ type: 'paragraph', text: 'x', fontSize: 99, color: 'red' }, 0), { valid: true });
    assert.deepEqual(cs.validateDocument({
      blocks: [{ type: 'paragraph', runs: [{ text: 'a', underline: true, rawNpStyle: 'Strong' }] }],
    }), { valid: true });
  });
});

describe('KNOWN-DEFECT：空集合的判据在各块型之间不一致', () => {
  // list.items / table.rows / reference.entries 都要求非空，paragraph.runs 却
  // 允许空数组 —— 空 runs 的段落一路 valid，渲染出一个占位段落。
  test('paragraph 的空 runs 放行，而同为「条目集」的 list/table 拒绝', () => {
    assert.deepEqual(cs.validateBlock({ type: 'paragraph', runs: [] }, 0), { valid: true });
    assert.strictEqual(cs.validateBlock({ type: 'list', items: [] }, 0).valid, false);
    assert.strictEqual(cs.validateBlock({ type: 'table', rows: [] }, 0).valid, false);
  });

  test('figure 两个字段都可缺，空图块照样 valid', () => {
    assert.deepEqual(cs.validateBlock({ type: 'figure' }, 0), { valid: true });
  });
});
