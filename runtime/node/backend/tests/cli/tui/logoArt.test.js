'use strict';

// logoArt.test — 品牌资产的单一真源锁定（[DESIGN-ARCH-134] §7.1 #6）。
//
// 同一进程先后出现过三种品牌符号（启动屏双菱形 / 欢迎横幅像素四叶草 / CC 模式字标），
// 另两端（Web / APK）又各画了一个字母 K。2026-10-25 起五端统一到一枚主标「内核环」，
// 本测试锁住四件事：
//   1. 点阵表自身自洽（MARK_ART / MARK_SHADE 同尺寸、空间格不染色）；
//   2. `cli/tui/**` 内 MARK_ART / MARK_SHADE 的**定义**只出现在 brandPixelArt.js 一处；
//   3. 字标 / tagline 来自 ccBrand 单一真源，不写第二份字面量；
//   4. 两个渲染器都消费共享资产，不自持像素表。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const logoArt = require('../../../src/cli/tui/logoArt');
const { BRAND } = require('../../../src/cli/tui/utils/ccBrand');

test('点阵表自洽：MARK_ART 与 MARK_SHADE 同尺寸，空格不染色', () => {
  assert.equal(logoArt.MARK_ART.length, logoArt.MARK_ROWS);
  assert.equal(logoArt.MARK_SHADE.length, logoArt.MARK_ROWS);
  assert.ok(logoArt.MARK_COLS > 0, 'MARK_COLS 必须是正数');
  for (let i = 0; i < logoArt.MARK_ROWS; i++) {
    assert.equal(logoArt.MARK_ART[i].length, logoArt.MARK_COLS, `art 第 ${i} 行`);
    assert.equal(logoArt.MARK_SHADE[i].length, logoArt.MARK_COLS, `shade 第 ${i} 行`);
  }
});

test('markRows：逐格结构正确，空格不着色，非法档位回退主体色', () => {
  const rows = logoArt.markRows();
  assert.equal(rows.length, logoArt.MARK_ROWS);
  rows.forEach((cells, i) => {
    assert.equal(cells.length, logoArt.MARK_COLS, `第 ${i} 行`);
    cells.forEach((c, j) => {
      assert.equal(c.ch, logoArt.MARK_ART[i][j], `(${i},${j}) 字符必须与点阵表逐字一致`);
      if (c.ch === ' ') {
        assert.equal(c.shade, ' ', `(${i},${j}) 空格不参与着色`);
      } else {
        assert.ok(['D', 'M', 'B'].includes(c.shade), `(${i},${j}) 非法档位 ${c.shade}`);
      }
    });
  });
  // 抽查两档明暗语汇：暗边 D 存在，且必须保留高光 B（否则三档纵深退化成单色）。
  assert.equal(rows[0][0].shade, ' ', '左上角是空白');
  assert.ok(
    rows.some((cells) => cells.some((c) => c.shade === 'B')),
    '必须保留 B 高光档'
  );
  assert.ok(
    rows.some((cells) => cells.some((c) => c.shade === 'D')),
    '必须保留 D 暗边档'
  );
});

test('markRows 返回新对象：改动结果不得污染下一次调用', () => {
  const a = logoArt.markRows();
  a[0][0].ch = 'X';
  a[0][0].shade = 'Z';
  const b = logoArt.markRows();
  assert.equal(b[0][0].ch, logoArt.MARK_ART[0][0]);
  assert.notEqual(b[0][0].shade, 'Z');
});

test('三档明暗的终端颜色只有一份（logoArt.SHADE_COLOR）', () => {
  for (const k of ['D', 'M', 'B']) {
    assert.match(logoArt.SHADE_COLOR[k], /^#[0-9A-Fa-f]{6}$/, `${k} 档必须是 #RRGGBB 字面量`);
  }
  assert.notEqual(logoArt.SHADE_COLOR.D, logoArt.SHADE_COLOR.B, '暗边与高光不得同色');
});

test('字标与 tagline 来自 ccBrand 单一真源', () => {
  assert.equal(logoArt.WORDMARK, 'khy OS');
  assert.equal(logoArt.TAGLINE, BRAND.tagline, 'tagline 必须复用 BRAND.tagline，不得写字面量');
  assert.ok(!/khy-os/i.test(logoArt.WORDMARK), '字标不得用仓库目录名 khy-os');
});

// ── 单一资产：定义只允许出现在 brandPixelArt.js 一处 ────────────────────────

const TUI_DIR = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui');

function walk(dir, out) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('MARK_ART / MARK_SHADE 的定义在 cli/tui/** 内只出现一次', () => {
  const files = walk(TUI_DIR, []);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const isOwner = path.basename(f) === 'brandPixelArt.js';
    if (!isOwner && /const MARK_ART|const MARK_SHADE/.test(src)) {
      offenders.push(path.relative(TUI_DIR, f));
    }
  }
  assert.deepEqual(offenders, [], '品牌点阵表不得在任何其它文件里再定义一份');
});

test('两个渲染器都必须消费共享资产', () => {
  const boot = fs.readFileSync(
    path.join(TUI_DIR, 'ink-components', 'BootScreen.js'),
    'utf8'
  );
  const banner = fs.readFileSync(
    path.join(TUI_DIR, 'ink-components', 'WelcomeBanner.js'),
    'utf8'
  );
  assert.ok(/require\('\.\.\/logoArt'\)/.test(boot), 'BootScreen 必须 require logoArt');
  assert.ok(/require\('\.\.\/logoArt'\)/.test(banner), 'WelcomeBanner 必须 require logoArt');
  assert.ok(/markRows\(\)/.test(banner), 'WelcomeBanner 必须走 markRows()，不得自持像素表');
  assert.ok(/markRows\(\)/.test(boot), 'BootScreen 必须走 markRows()，不得自持像素表');
  assert.ok(
    !/const SHADE_COLOR\s*=\s*\{/.test(banner),
    'WelcomeBanner 不得自写一份明暗配色（应从 logoArt.SHADE_COLOR 取）'
  );
});
