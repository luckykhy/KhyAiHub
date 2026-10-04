'use strict';

/**
 * Co-located tests for styleTemplates.js — built-in loader + deep-merge resolver
 * for document style templates (pure data under src/templates/docstyles/).
 *
 * Pinned contract from the file header: name | absolute path | inline object,
 * then `overrides` deep-merged on top so a user can tweak one key without
 * restating the baseline; every resolved template stays layered over `default`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const st = require('./styleTemplates.js');

const DEFAULT_KEYS = ['name', 'label', 'description', 'page', 'paragraph', 'fonts', 'pagination', 'list', 'table'];

describe('listTemplates / 内置模板面', () => {
  test('三个内置模板齐名，label 与 description 都是字符串', () => {
    const list = st.listTemplates();
    assert.deepEqual(list.map((t) => t.name).sort(), ['default', 'gbt7714', 'ieee']);
    for (const t of list) {
      assert.strictEqual(typeof t.label, 'string');
      assert.strictEqual(typeof t.description, 'string');
      assert.ok(t.label.length > 0, t.name);
    }
  });

  test('TEMPLATE_DIR 指向真实存在的模板目录（相对深度 4 级，搬文件必须同步）', () => {
    const fs = require('fs');
    assert.ok(fs.existsSync(path.join(st.TEMPLATE_DIR, 'default.json')), st.TEMPLATE_DIR);
  });
});

describe('resolveTemplate：三种 spec 形态', () => {
  test('空 spec（undefined / null / 空串）→ builtin:default，键面完整', () => {
    for (const spec of [undefined, null, '']) {
      const r = st.resolveTemplate(spec);
      assert.strictEqual(r.source, 'builtin:default');
      assert.strictEqual(r.error, undefined);
      assert.deepEqual(Object.keys(r.template).sort(), [...DEFAULT_KEYS].sort());
    }
  });

  test('内置名 → 该模板的身份字段生效，其余键仍来自基线', () => {
    const r = st.resolveTemplate('gbt7714');
    assert.strictEqual(r.source, 'builtin:gbt7714');
    assert.strictEqual(r.template.name, 'gbt7714');
    assert.strictEqual(r.template.label, '国标 GB/T 7714 中文学术论文');
    assert.deepEqual(Object.keys(r.template).sort(), [...DEFAULT_KEYS].sort());
    assert.deepEqual(Object.keys(r.template.page.margins), ['top', 'bottom', 'left', 'right', 'unit']);
  });

  test('内联对象 → source:inline，同样铺在 default 基线上（只写一个键也完整）', () => {
    const r = st.resolveTemplate({ name: 'mine', paragraph: { lineSpacing: 2 } });
    assert.strictEqual(r.source, 'inline');
    assert.strictEqual(r.template.name, 'mine');
    assert.strictEqual(r.template.paragraph.lineSpacing, 2);
    // 未重述的基线键全部继承
    assert.strictEqual(r.template.paragraph.firstLineIndentChars, 2);
    assert.strictEqual(r.template.paragraph.lineSpacingRule, 'multiple');
    assert.strictEqual(r.template.page.size, 'A4');
    assert.ok(r.template.fonts && typeof r.template.fonts === 'object');
  });

  test('绝对路径 spec → source:file:<原样路径>，取文件身份字段', () => {
    const abs = path.join(st.TEMPLATE_DIR, 'ieee.json');
    const r = st.resolveTemplate(abs);
    assert.strictEqual(r.source, `file:${abs}`);
    assert.strictEqual(r.template.name, 'ieee');
    assert.ok(r.template.fonts);
  });

  test('读不到的路径 → template:null + 可解的错误消息（含原路径与原因）', () => {
    const r = st.resolveTemplate(path.join(st.TEMPLATE_DIR, 'no-such-template.json'));
    assert.strictEqual(r.template, null);
    assert.match(r.error, /^Could not load template file "/);
    assert.match(r.error, /no-such-template\.json/);
  });

  test('带分隔符的名字按路径处理，不带分隔符的未知名字按内置名报错', () => {
    assert.match(st.resolveTemplate('a/b').error, /Could not load template file/);
    assert.match(st.resolveTemplate('a\\b').error, /Could not load template file/);
    const r = st.resolveTemplate('nope-not-real');
    assert.strictEqual(r.template, null);
    assert.match(r.error, /^Unknown style template "nope-not-real"\. Built-ins: /);
    assert.match(r.error, /default/);
  });

  test('非字符串非对象 spec → 明确报类型', () => {
    assert.strictEqual(st.resolveTemplate(7).error, 'Invalid template spec type: number');
    assert.strictEqual(st.resolveTemplate(true).error, 'Invalid template spec type: boolean');
  });
});

describe('_deepMerge：对象合并、数组与标量整体替换', () => {
  test('over 为 null/undefined → 原样交出 base', () => {
    assert.deepEqual(st._deepMerge({ a: 1 }, null), { a: 1 });
    assert.deepEqual(st._deepMerge({ a: 1 }, undefined), { a: 1 });
  });

  test('数组整体替换，不逐元素合并', () => {
    assert.deepEqual(st._deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
    assert.deepEqual(st._deepMerge([1, 2], { a: 1 }), { a: 1 });
  });

  test('标量替换；类型不同也直接替换', () => {
    assert.strictEqual(st._deepMerge(1, 2), 2);
    assert.deepEqual(st._deepMerge({ a: 1 }, { a: 'x' }), { a: 'x' });
  });

  test('嵌套对象逐层合并，base 不被改写', () => {
    const base = { page: { margins: { top: 1, left: 2 } } };
    const out = st._deepMerge(base, { page: { margins: { top: 3 } } });
    assert.deepEqual(out.page.margins, { top: 3, left: 2 });
    assert.deepEqual(base.page.margins, { top: 1, left: 2 });
    assert.notStrictEqual(out, base);
  });
});

describe('overrides 叠在请求的模板之上', () => {
  test('只改一个深键，其余基线键保留', () => {
    const r = st.resolveTemplate('gbt7714', { paragraph: { lineSpacing: 2 } });
    assert.strictEqual(r.template.paragraph.lineSpacing, 2);
    assert.strictEqual(r.template.paragraph.lineSpacingRule, 'multiple');
    assert.strictEqual(r.template.paragraph.firstLineIndentChars, 2);
  });

  test('overrides 改不动 source', () => {
    assert.strictEqual(st.resolveTemplate(null, { name: 'x' }).source, 'builtin:default');
  });
});

describe('KNOWN-DEFECT：原型链名字被当内置模板', () => {
  // `builtins[spec]` 是裸下标取值，没有 hasOwnProperty 守卫，于是 Object.prototype
  // 上的键全部命中「内置」分支：'constructor' 交出一个函数当模板，
  // '__proto__' 交出一份 default 的浅拷贝——两者都绕过了「未知模板名」这条本该
  // 拦住用户拼错的报错路径（同仓 toolchainVersions.supportedVersions('constructor') 一族）。
  test('resolveTemplate("constructor") 不报错，template 是个函数', () => {
    for (const name of ['constructor', 'toString', 'valueOf']) {
      const r = st.resolveTemplate(name);
      assert.strictEqual(r.error, undefined);
      assert.strictEqual(r.source, `builtin:${name}`);
      assert.strictEqual(typeof r.template, 'function');
    }
  });

  test('resolveTemplate("__proto__") 静默退回 default 内容', () => {
    const r = st.resolveTemplate('__proto__');
    assert.strictEqual(r.source, 'builtin:__proto__');
    assert.strictEqual(r.template.name, 'default');
    assert.strictEqual(r.template.page.size, 'A4');
  });
});

describe('KNOWN-DEFECT：交出缓存本体 / 别名调用方对象', () => {
  test('builtin:default 交出的是模块级缓存对象本体，改它即污染全进程后续解析', () => {
    const first = st.resolveTemplate(null);
    const second = st.resolveTemplate(null);
    assert.strictEqual(first.template, second.template);

    const original = first.template.paragraph.firstLineIndentChars;
    first.template.paragraph.firstLineIndentChars = 99;
    try {
      assert.strictEqual(st.resolveTemplate(null).template.paragraph.firstLineIndentChars, 99);
    } finally {
      first.template.paragraph.firstLineIndentChars = original;
    }
    assert.strictEqual(st.resolveTemplate(null).template.paragraph.firstLineIndentChars, original);
  });

  test('基线里不存在的键，overrides 的子对象按引用进结果（调用方后续改写会穿透）', () => {
    const overrides = { custom: { a: 1 } };
    const r = st.resolveTemplate(null, overrides);
    assert.strictEqual(r.template.custom, overrides.custom);
    overrides.custom.a = 2;
    assert.strictEqual(r.template.custom.a, 2);
  });
});
