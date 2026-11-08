'use strict';

// brandMark.test.cjs — 桌面端品牌主标与几何真源的一致性契约。
//
// 真源：delivery/brand/khy-brand-geometry.js（CJS，仓内唯一）。
// 组件里是副本（TSX 跨目录 import 真源会让 vite dev / build 行为不一致），
// 故用断言锁住漂移：改形状只能改真源后跑 `node scripts/brand/build-brand-assets.js`。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const repoRoot = join(__dirname, '..', '..', '..');
const geo = require(join(repoRoot, 'delivery', 'brand', 'khy-brand-geometry.js'));
const parts = geo.markParts();

const brandMarkPath = join(repoRoot, 'apps', 'khyos-desktop', 'src', 'renderer', 'components', 'ui', 'BrandMark.tsx');
const titleBarPath = join(repoRoot, 'apps', 'khyos-desktop', 'src', 'renderer', 'components', 'layout', 'TitleBar.tsx');

const brandMarkSrc = existsSync(brandMarkPath) ? readFileSync(brandMarkPath, 'utf-8') : '';
const titleBarSrc = existsSync(titleBarPath) ? readFileSync(titleBarPath, 'utf-8') : '';

/** 只保留路径字符，让被引号/换行拆开的同一段路径能被连续匹配。 */
function normalize(text) {
  return text.replace(/[^A-Za-z0-9.-]/g, '');
}

const normalized = normalize(brandMarkSrc);

test('BrandMark 的四段弧叶与几何真源逐条一致', () => {
  assert.equal(parts.blades.length, 4);
  for (const d of parts.blades) {
    assert.ok(normalized.includes(normalize(d)), `弧叶路径缺失：${d.slice(0, 48)}`);
  }
});

test('BrandMark 的菱形内核 + K 负槽与几何真源一致', () => {
  assert.ok(normalized.includes(normalize(parts.core)), '内核路径缺失或已漂移');
});

test('桌面端标题栏渲染了品牌主标', () => {
  assert.ok(/BrandMark/.test(titleBarSrc), 'TitleBar 必须渲染 BrandMark');
  assert.ok(/from '\.\.\/ui\/BrandMark'/.test(titleBarSrc), 'TitleBar 必须从 ui/BrandMark 引入');
});

test('标题栏品牌块用墨黑底（不再是与主色渐变的通用块）', () => {
  assert.ok(/#14110E/.test(titleBarSrc), '品牌块底色应为墨黑 #14110E');
});
