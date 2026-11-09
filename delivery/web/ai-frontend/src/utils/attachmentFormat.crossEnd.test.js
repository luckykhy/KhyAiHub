/**
 * 跨端附件格式口径 —— 桌面端 attachmentKind.ts、Web 端 attachmentView.js、
 * 终端 attachmentFormat.js 必须对同一个扩展名给出同一个桶。
 *
 * 为什么要这条：三个 app 各自构建（apps/khyos-desktop 是 electron-vite，
 * delivery/web/ai-frontend 是 vite，runtime/node/backend 是独立 npm 包且桌面端只
 * spawn 它、不 import），共享不了同一份源码，扩展名表只能各存一份。
 * 「三份表靠人记住要一起改」在 khy-os 里等于没有约束 —— 这条测试把「一起改」
 * 变成可执行的判据：只改一端，这里立刻红。
 *
 * 2026-11-01 加入第三份（终端）：此前终端连「桶」这个概念都没有，Ink TUI 只报
 * 「已附加 N 张图片」、classic REPL 只按「能不能当 utf-8 读」分支，pdf/docx/xlsx/mp4
 * 拖进去会落空。三份表同口径是「终端也能按格式渲染」的前提。
 *
 * 为什么读源码而不是 import：vitest 的 Vite 模块解析不出 root 之外的 .ts
 * （server.fs.allow 默认锁在 ai-frontend 内），跨 app import 会直接 load 失败。
 * 两张表都是规整的 `['桶', ['ext', …]]` 数组字面量，按行解析足够稳；解析不到也会红，
 * 不会静默放过。
 *
 * Run: node_modules/.bin/vitest run src/utils/attachmentFormat.crossEnd.test.js
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachmentFormat, FILE_FORMATS } from '@/utils/attachmentView';

const here = dirname(fileURLToPath(import.meta.url));
// src/utils → src → ai-frontend → web → delivery → 仓库根
const repoRoot = join(here, '..', '..', '..', '..', '..');

/**
 * 从源码里抠出 `['桶', ['ext', …]]` 形式的表，按 `表名` 起、到下一个顶层 `];` 止。
 * 空白宽容：三端的 prettier 配置不同，同一个条目在桌面端是 `['code', [` 单行起头，
 * 在终端侧会被折成 `[` / `'code',` / `[` 三行 —— 两种都要认，否则解析会静默漏掉
 * 最长的那一条（`code` 有 25 个扩展名，漏了它这条守卫就形同虚设）。
 */
function parseTable(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return [];
  const end = src.indexOf('\n];', start);
  const body = end < 0 ? src.slice(start) : src.slice(start, end);
  return [...body.matchAll(/\[\s*'(\w+)',\s*\[\s*([^\]]*)\]/g)].map(([, bucket, list]) => [
    bucket,
    [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]),
  ]);
}

const desktopTable = parseTable(
  readFileSync(
    join(repoRoot, 'apps/khyos-desktop/src/renderer/components/composer/attachmentKind.ts'),
    'utf8'
  ),
  'export const EXT_KINDS'
);

const backendTable = parseTable(
  readFileSync(join(repoRoot, 'runtime/node/backend/src/cli/attachmentFormat.js'), 'utf8'),
  'const EXT_FORMATS'
);

const flat = (table) => Object.fromEntries(table.flatMap(([bucket, exts]) => exts.map((e) => [e, bucket])));

describe('桌面端 / Web / 终端：同一扩展名归同一桶', () => {
  it('三张表都解析得出来（解析不到就是表结构变了，别静默放过）', () => {
    for (const [label, table] of [
      ['桌面端', desktopTable],
      ['终端', backendTable],
    ]) {
      expect(table.length, `${label} 桶数`).toBeGreaterThanOrEqual(10);
      expect(table.flatMap(([, exts]) => exts).length, `${label} 扩展名数`).toBeGreaterThan(60);
    }
  });

  it('桌面端表里登记的扩展名，Web 端判成同一个桶', () => {
    const mismatches = [];
    for (const [bucket, exts] of desktopTable) {
      for (const ext of exts) {
        const web = attachmentFormat({ name: `probe.${ext}`, kind: 'other' });
        if (web !== bucket) mismatches.push(`${ext}: 桌面端=${bucket} web=${web}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('终端表与桌面端逐扩展名一致（第三份不能悄悄漂）', () => {
    expect(flat(backendTable)).toEqual(flat(desktopTable));
  });

  it('桶集合完全相同（少一个桶就是有一端认不出某种格式）', () => {
    const desktop = [...desktopTable.map(([k]) => k), 'file'].sort();
    expect([...FILE_FORMATS].sort()).toEqual(desktop);
    expect([...backendTable.map(([k]) => k), 'file'].sort()).toEqual(desktop);
  });

  it('无扩展名时都落 file（不瞎猜）', () => {
    expect(attachmentFormat({ name: 'README', kind: 'other' })).toBe('file');
  });
});
