'use strict';

/**
 * positioning SSOT tests (node:test) — INIT-PRD-004 的代码化（2026-09-23）。
 *
 * 锁定三条不变式：
 *   1. 定位真源形状完整（tagline/oneLiner/audience/claims/os/doc 全在位，
 *      claims 恒 4 条——对应 INIT-PRD-004 §三 的四条真实理由）；
 *   2. 品牌链同源：ccBrand.tagline === POSITIONING.tagline，
 *      logoArt.TAGLINE === BRAND.tagline（不写第二份字面量）；
 *   3. `khy about` 渲染面输出真源内容（tagline/主张/OS 层/doc 指针全可见）。
 *
 * Run: `node --test tests/positioning.test.js`
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { POSITIONING } = require('../src/constants/positioning');
const { BRAND } = require('../src/cli/tui/utils/ccBrand');
const logoArt = require('../src/cli/tui/logoArt');
const about = require('../src/cli/handlers/about');

test('POSITIONING 形状完整且 tagline 单行', () => {
  assert.equal(typeof POSITIONING.tagline, 'string');
  assert.ok(POSITIONING.tagline.length >= 8, 'tagline 不应为空话');
  assert.ok(!POSITIONING.tagline.includes('\n'), 'tagline 必须单行（横幅第二行契约）');
  assert.equal(typeof POSITIONING.oneLiner, 'string');
  assert.ok(POSITIONING.oneLiner.length > POSITIONING.tagline.length);
  assert.equal(typeof POSITIONING.audience, 'string');
  assert.equal(typeof POSITIONING.doc, 'string');
  assert.ok(POSITIONING.doc.includes('INIT-PRD-004'), 'doc 指针应指向定位文档');
});

test('claims 恒为四条（订阅套利/随身性/本土化/私有）', () => {
  assert.equal(POSITIONING.claims.length, 4);
  const titles = POSITIONING.claims.map((c) => c.title);
  assert.deepEqual(titles, ['订阅套利', '随身性', '本土化', '私有与便携']);
  for (const c of POSITIONING.claims) {
    assert.ok(c.title && c.body, '每条主张必须有标题与正文');
  }
});

test('os 块给出「为什么叫 OS」与四层栈', () => {
  assert.ok(POSITIONING.os.headline.includes('OS'));
  assert.ok(POSITIONING.os.body.includes('网关'));
  assert.equal(POSITIONING.os.layers.length, 4);
  assert.ok(POSITIONING.os.layers[0].startsWith('kernel'));
  assert.ok(POSITIONING.os.layers[3].startsWith('extensions'));
});

test('品牌链同源：logoArt.TAGLINE === BRAND.tagline === POSITIONING.tagline', () => {
  assert.equal(BRAND.tagline, POSITIONING.tagline, 'ccBrand.tagline 必须取自定位真源');
  assert.equal(logoArt.TAGLINE, BRAND.tagline, 'logoArt.TAGLINE 必须复用 BRAND.tagline');
});

test('khy about 渲染面输出真源内容（tagline/主张/OS 层/doc 指针）', () => {
  const lines = about.buildAboutLines('1.2.0');
  const text = lines.join('\n');
  assert.ok(lines[0].includes('khy OS v1.2.0'));
  assert.ok(text.includes(POSITIONING.tagline));
  for (const c of POSITIONING.claims) {
    assert.ok(text.includes(c.title), `主张「${c.title}」应可见`);
  }
  assert.ok(text.includes(POSITIONING.os.headline));
  assert.ok(text.includes(POSITIONING.doc));
});

test('khy about 自注册 manifest 合法（name/aliases/category/handler）', () => {
  const m = about[require('../src/cli/commandManifest').MANIFEST_EXPORT_KEY];
  assert.ok(m, '必须导出 MANIFEST_EXPORT_KEY manifest');
  assert.equal(m.name, 'about');
  assert.deepEqual(m.aliases, ['关于', 'guanyu']);
  assert.equal(m.category, 'system');
  assert.equal(typeof m.handler, 'function');
});
