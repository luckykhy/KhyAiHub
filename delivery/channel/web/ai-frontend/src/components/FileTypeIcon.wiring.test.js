/**
 * FileTypeIcon wiring —— 附件 chip 的格式字形（Web 端）。
 *
 * 锁定三件事（源码断言，与 chatAttachments.wiring.test.js 同款做法 —— 本 app 没有
 * @vue/test-utils）：
 *   1. 12 个 format 都有字形，且字形真的由 path 组成（不是空数组、不是占位）；
 *   2. 图标跟随 currentColor（气泡底色深浅不定，写死颜色会在某个主题里消失）；
 *   3. 三个渲染点都按 attachmentFormat(att) 取，而不是后端的粗分 att.kind ——
 *      这正是本次要修的缺陷：document / text / code 三个 kind 共用一个 Document。
 *
 * Run: node_modules/.bin/vitest run src/components/FileTypeIcon.wiring.test.js
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_FORMATS } from '@/utils/attachmentView';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const read = (...p) => readFileSync(join(srcRoot, ...p), 'utf8');

const iconSrc = read('components/FileTypeIcon.vue');
const chatSrc = read('views/AIChat.vue');
const bubbleSrc = read('views/components/MessageAttachment.vue');

// 只取 ICONS 字面量本身：从 `const ICONS = {` 到配对的 `\n};`。不截断的话后面
// 的 SEMANTIC_TONE 也会被算进 key，数量断言直接失真。
const iconsStart = iconSrc.indexOf('const ICONS = {');
const iconsEnd = iconSrc.indexOf('\n};', iconsStart);
const iconsBlock = iconSrc.slice(iconsStart, iconsEnd + 3);
const iconKeys = [...iconsBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

describe('FileTypeIcon: 字形表', () => {
  it('12 个 format 全部有字形', () => {
    for (const format of FILE_FORMATS) {
      expect(iconKeys).toContain(format);
    }
    expect(iconKeys.length).toBe(FILE_FORMATS.length);
  });

  it('每个字形都有 path，且不是空数组', () => {
    const entries = [...iconsBlock.matchAll(/^\s{2}(\w+):\s*(\[[\s\S]*?\]|SHELL)/gm)];
    expect(entries.length).toBe(iconKeys.length);
    for (const [, format, value] of entries) {
      if (value === 'SHELL') {
        expect(iconSrc).toMatch(/const SHELL = \[\s*'M6 22/);
        continue;
      }
      const paths = [...value.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(paths.length, `${format} 没有 path`).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d.startsWith('M') || d.startsWith('m'), `${format} 的 path 不是合法起始：${d}`).toBe(true);
      }
    }
  });

  it('md 与 txt 不共形（本次的核心诉求）', () => {
    const grab = (format) => {
      const start = iconsBlock.indexOf(`  ${format}:`);
      return iconsBlock.slice(start, iconsBlock.indexOf('\n  ', start + 4));
    };
    expect(grab('md')).not.toBe(grab('text'));
    expect(grab('pdf')).not.toBe(grab('doc'));
  });
});

describe('FileTypeIcon: 取色', () => {
  it('stroke 走 currentColor，不写死颜色', () => {
    expect(iconSrc).toMatch(/stroke="currentColor"/);
    expect(iconSrc).not.toMatch(/stroke="#[0-9a-fA-F]{3,6}"/);
  });

  it('semantic 色只给惯用色的几个桶，其余跟随文字色', () => {
    expect(iconSrc).toMatch(/const SEMANTIC_TONE = \{[\s\S]*pdf: 'var\(--khy-danger\)'/);
    expect(iconSrc).toMatch(/sheet: 'var\(--khy-success\)'/);
    expect(iconSrc).toMatch(/tone === 'semantic'/);
  });
});

describe('三处渲染点都按格式取图标', () => {
  it('AIChat 旧路径 chip 与输入区 pending chip', () => {
    expect(chatSrc).toMatch(/<FileTypeIcon :format="attachmentFormat\(att\)"/);
    expect(chatSrc).toMatch(/tone="semantic"/);
    expect(chatSrc).not.toMatch(/attachmentIcon\(att\.kind\)/);
  });

  it('MessageAttachment 的两个分支', () => {
    const hits = bubbleSrc.match(/:format="attachmentFormat\(att\)"/g) || [];
    expect(hits.length).toBe(2);
    expect(bubbleSrc).not.toMatch(/iconFor\(att\.kind\)/);
  });

  it('不再残留 element-plus 的粗分图标表', () => {
    expect(chatSrc).not.toMatch(/const ATTACHMENT_ICONS = \{/);
    expect(bubbleSrc).not.toMatch(/const ICONS = \{\s*image: Picture/);
  });
});
