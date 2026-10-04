'use strict';

/**
 * Co-located tests for markdownToAst.js — the deterministic Markdown → semantic
 * AST parser (no model in the loop, no presentation honoured).
 *
 * Pinned contract from the file header: page breaks come ONLY from an explicit
 * sentinel line (never blank lines / form feeds / `---`), inline emphasis maps
 * to semantic run flags, and `---` is a horizontal rule that is *dropped*.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { markdownToAst, parseInlineRuns, PAGEBREAK_SENTINELS } = require('./markdownToAst.js');
const { validateDocument } = require('./contentSchema.js');

const types = (md, opts) => markdownToAst(md, opts).blocks.map((b) => b.type);

describe('入口形状', () => {
  test('空输入 / null / 只有空白 → 零块文档', () => {
    for (const src of ['', null, undefined, '   \n  \n']) {
      assert.deepEqual(markdownToAst(src), { type: 'document', blocks: [] }, JSON.stringify(src));
    }
  });

  test('CRLF / CR 一律先归一成 LF，块面不受换行符影响', () => {
    assert.deepEqual(markdownToAst('# 甲\r\n\r\n正文'), markdownToAst('# 甲\n\n正文'));
    assert.deepEqual(markdownToAst('# 甲\r正文'), markdownToAst('# 甲\n正文'));
  });
});

describe('标题 / 段落', () => {
  test('ATX 标题 1..6 带级别，正文两侧空白剥除', () => {
    const doc = markdownToAst('# 一\n## 二\n######  六  ');
    assert.deepEqual(doc.blocks, [
      { type: 'heading', level: 1, text: '一' },
      { type: 'heading', level: 2, text: '二' },
      { type: 'heading', level: 6, text: '六' },
    ]);
  });

  test('# 后无空格、或 7 个 # 起头 → 不是标题，落回段落', () => {
    assert.deepEqual(markdownToAst('#nospace').blocks, [{ type: 'paragraph', text: '#nospace' }]);
    assert.deepEqual(markdownToAst('####### seven').blocks, [{ type: 'paragraph', text: '####### seven' }]);
  });

  test('setext 下划线式标题不支持（本解析器只认 #）', () => {
    assert.deepEqual(markdownToAst('title\n===').blocks, [{ type: 'paragraph', text: 'title ===' }]);
  });

  test('连续行并进同一段落（空格连接），空行断段', () => {
    const doc = markdownToAst('甲\n乙\n\n丙');
    assert.deepEqual(doc.blocks, [
      { type: 'paragraph', text: '甲 乙' },
      { type: 'paragraph', text: '丙' },
    ]);
  });

  test('水平分隔线被丢弃，不是块也不是分页', () => {
    assert.deepEqual(markdownToAst('***\n___\n文字').blocks, [{ type: 'paragraph', text: '文字' }]);
    assert.deepEqual(markdownToAst('---').blocks, []);
  });
});

describe('行内语义 run', () => {
  test('加粗 / 斜体映射成 run 标志，纯文本段坍缩成单一 text', () => {
    assert.deepEqual(parseInlineRuns('**粗** 与 *斜*'), [
      { text: '粗', bold: true },
      { text: ' 与 ' },
      { text: '斜', italic: true },
    ]);
    assert.deepEqual(parseInlineRuns('纯文本'), [{ text: '纯文本' }]);
    assert.deepEqual(markdownToAst('纯文本').blocks, [{ type: 'paragraph', text: '纯文本' }]);
    assert.deepEqual(markdownToAst('**粗**').blocks[0], {
      type: 'paragraph',
      runs: [{ text: '粗', bold: true }],
    });
  });

  test('反引号只是剥掉标记，样式主张不落进 AST（头注释明示 no styling claim）', () => {
    assert.deepEqual(parseInlineRuns('`code`'), [{ text: 'code' }]);
    assert.deepEqual(markdownToAst('`x` 与 **y**').blocks, [
      { type: 'paragraph', runs: [{ text: 'x' }, { text: ' 与 ' }, { text: 'y', bold: true }] },
    ]);
  });

  test('未闭合的标记按字面留着，不吞后文', () => {
    assert.deepEqual(parseInlineRuns('**b** and *i'), [
      { text: 'b', bold: true },
      { text: ' and *i' },
    ]);
    assert.deepEqual(parseInlineRuns('**'), [{ text: '**' }]);
  });

  test('空串交出单个空 text run（解析器永不交空数组）', () => {
    assert.deepEqual(parseInlineRuns(''), [{ text: '' }]);
  });
});

describe('列表 / 引用', () => {
  test('无序 - * + 与有序 n. / n) 各自成块，ordered 标志区分', () => {
    assert.deepEqual(markdownToAst('- 甲\n- 乙').blocks, [{ type: 'list', ordered: false, items: ['甲', '乙'] }]);
    assert.deepEqual(markdownToAst('* 甲\n+ 乙').blocks, [{ type: 'list', ordered: false, items: ['甲', '乙'] }]);
    assert.deepEqual(markdownToAst('1. 甲\n2. 乙').blocks, [{ type: 'list', ordered: true, items: ['甲', '乙'] }]);
    assert.deepEqual(markdownToAst('1) 甲\n2) 乙').blocks, [{ type: 'list', ordered: true, items: ['甲', '乙'] }]);
  });

  test('标记类型一换即断列表（不合并成一块）', () => {
    const blocks = markdownToAst('- 甲\n1. 乙').blocks;
    assert.deepEqual(blocks.map((b) => [b.type, b.ordered, b.items]), [
      ['list', false, ['甲']],
      ['list', true, ['乙']],
    ]);
  });

  test('相邻 > 行并成一条引用，标记剥除', () => {
    assert.deepEqual(markdownToAst('> 一\n> 二').blocks, [{ type: 'quote', text: '一 二' }]);
  });
});

describe('代码围栏', () => {
  test('``` 与 ~~~ 都识别，语言名进 lang，正文逐行保留', () => {
    assert.deepEqual(markdownToAst('```js\nconst a = 1;\n```').blocks, [
      { type: 'code', text: 'const a = 1;', lang: 'js' },
    ]);
    assert.deepEqual(markdownToAst('~~~\nx\n~~~').blocks, [{ type: 'code', text: 'x' }]);
    assert.ok(!('lang' in markdownToAst('~~~\nx\n~~~').blocks[0]));
  });

  test('围栏不闭合 → 吃到文末仍出块（不抛，也不丢正文）', () => {
    assert.deepEqual(markdownToAst('```\nx').blocks, [{ type: 'code', text: 'x' }]);
  });

  test('围栏前的段落先落块，围栏内 markdown 不再被解析', () => {
    assert.deepEqual(types('前文\n```\n# 不是标题\n```'), ['paragraph', 'code']);
    assert.deepEqual(markdownToAst('前文\n```\n# 不是标题\n```').blocks[1].text, '# 不是标题');
  });
});

describe('分页哨兵（唯一的强制分页手段）', () => {
  test('[[newpage]] 与 <<<pagebreak>>> 都识别，空白/大小写宽容', () => {
    assert.deepEqual(types('a\n[[newpage]]\nb'), ['paragraph', 'pagebreak', 'paragraph']);
    assert.deepEqual(types('a\n<<<pagebreak>>>\nb'), ['paragraph', 'pagebreak', 'paragraph']);
    assert.deepEqual(types('  [[ NewPage ]]  '), ['pagebreak']);
    assert.deepEqual(PAGEBREAK_SENTINELS.length, 2);
  });

  test('opts.pagebreakSentinels 可整体替换哨兵集', () => {
    assert.deepEqual(types('a\n---SPLIT---\nb', { pagebreakSentinels: [/^---SPLIT---$/] }),
      ['paragraph', 'pagebreak', 'paragraph']);
    // 替换后原哨兵不再生效，`[[newpage]]` 掉回普通正文（与前后行并成同一段）
    assert.deepEqual(types('a\n[[newpage]]\nb', { pagebreakSentinels: [/^---SPLIT---$/] }), ['paragraph']);
    assert.deepEqual(markdownToAst('a\n[[newpage]]\nb', { pagebreakSentinels: [/^---SPLIT---$/] }).blocks[0].text,
      'a [[newpage]] b');
    // 反过来：把 --- 指定为哨兵才分页
    assert.deepEqual(types('a\n---\nb', { pagebreakSentinels: [/^-+$/] }),
      ['paragraph', 'pagebreak', 'paragraph']);
  });

  test('防呆：空行与连续空行都不产生分页', () => {
    assert.deepEqual(types('a\n\n\n\nb'), ['paragraph', 'paragraph']);
  });
});

describe('表格', () => {
  test('表头 + 分隔行 + 数据行，首尾竖线剥除、单元格 trim', () => {
    assert.deepEqual(markdownToAst('| a | b |\n| --- | --- |\n| 1 | 2 |').blocks, [
      { type: 'table', header: ['a', 'b'], rows: [['1', '2']] },
    ]);
  });

  test('数据行遇到不含竖线的行即停，后续行归回段落', () => {
    const blocks = markdownToAst('| a | b |\n| --- | --- |\n| 1 | 2 |\nplain\n| 3 | 4 |').blocks;
    assert.deepEqual(blocks.map((b) => b.type), ['table', 'paragraph']);
    assert.deepEqual(blocks[0].rows, [['1', '2']]);
  });

  test('缺分隔行的两行竖线文本不是表格', () => {
    assert.deepEqual(types('| a | b |\n| 1 | 2 |'), ['paragraph']);
  });
});

describe('功能单元内自洽：解析产物必须过本单元自己的校验器', () => {
  test('一份覆盖全部块型的 Markdown，解析结果 validateDocument 全绿', () => {
    const md = [
      '# 标题',
      '',
      '正文 **粗** 与 *斜* 及 `code`',
      '',
      '- 甲',
      '- 乙',
      '',
      '> 引用一行',
      '> 第二行',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '| 列 | 列 |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '[[newpage]]',
      '',
      '1. 有序一',
      '2. 有序二',
    ].join('\n');
    const doc = markdownToAst(md);
    assert.deepEqual(doc.blocks.map((b) => b.type), [
      'heading', 'paragraph', 'list', 'quote', 'code', 'table', 'pagebreak', 'list',
    ]);
    assert.deepEqual(validateDocument(doc), { valid: true });
  });
});

describe('KNOWN-DEFECT：只有表头的表格被凭空补出一行空数据', () => {
  // 源文本里没有数据行，解析器却交出 rows:[['','']]。下游按行数排版就会多出
  // 一行空白；而且它让 contentSchema 的「table.rows 必须非空」这条判据永远拦不到
  // 「用户只写了表头」的输入——空表被伪装成合法文档通过。
  test('markdownToAst 交出空串行，validateDocument 照样 valid', () => {
    const doc = markdownToAst('| a | b |\n| --- | --- |');
    assert.deepEqual(doc.blocks, [
      { type: 'table', header: ['a', 'b'], rows: [['', '']] },
    ]);
    assert.deepEqual(validateDocument(doc), { valid: true });
  });
});

describe('KNOWN-DEFECT：单破折号分隔行整表退化成段落', () => {
  // CommonMark 允许 `| - | - |`。_isTableSep 要求 `-{2,}`，于是不匹配的表格
  // 不报错、不警告，整块掉回 paragraph —— 用户的表格内容变成一串竖线正文。
  test('| - | - | 形态的表格静默降级', () => {
    const blocks = markdownToAst('| a | b |\n| - | - |\n| 1 | 2 |').blocks;
    assert.deepEqual(blocks.map((b) => b.type), ['paragraph']);
    assert.match(blocks[0].text, /\| - \| - \|/);
  });
});

describe('KNOWN-DEFECT：空强调标记产出零宽 run', () => {
  test('**** 产出一个 text 为空串的 bold run', () => {
    assert.deepEqual(parseInlineRuns('****'), [{ text: '', bold: true }]);
  });
});
