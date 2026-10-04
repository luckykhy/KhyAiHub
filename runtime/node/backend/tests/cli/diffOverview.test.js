'use strict';

/**
 * gitDiffCollect — 文件级概览(/diff 首屏,门控 KHY_DIFF_OVERVIEW)。
 * DSH 对齐(deepseek-ai/deepseek-harness changed-files card):全量 diff 之前先给
 * 「动了哪些文件、各 ±几行」。summarizeDiffFiles 纯解析、formatDiffOverview 纯拼版。
 */

const {
  summarizeDiffFiles,
  formatDiffOverview,
  diffOverviewEnabled,
} = require('../../src/cli/gitDiffCollect');

const SAMPLE = [
  'diff --git a/services/a.js b/services/a.js',
  'index 111..222 100644',
  '--- a/services/a.js',
  '+++ b/services/a.js',
  '@@ -1,3 +1,4 @@',
  ' ctx',
  '+added1',
  '+added2',
  '-old1',
  ' ctx2',
  'diff --git a/b.js b/b.js',
  '--- a/b.js',
  '+++ b/b.js',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/new.js b/new.js',
  '--- /dev/null',
  '+++ b/new.js',
  '@@ -0,0 +1,2 @@',
  '+n1',
  '+n2',
].join('\n');

describe('summarizeDiffFiles', () => {
  test('per-file ± counts, sorted by change volume desc (stable ties)', () => {
    const rows = summarizeDiffFiles(SAMPLE);
    expect(rows).toEqual([
      { path: 'services/a.js', added: 2, removed: 1 },
      { path: 'b.js', added: 1, removed: 1 },
      { path: 'new.js', added: 2, removed: 0 },
    ]);
  });

  test('+++ / --- headers are NOT counted as body ± lines', () => {
    const rows = summarizeDiffFiles(SAMPLE);
    for (const r of rows) {
      expect(r.added + r.removed).toBeLessThan(6);
    }
  });

  test('new file (--no-index, --- /dev/null) path comes from +++ b/<path>', () => {
    const rows = summarizeDiffFiles(SAMPLE);
    expect(rows.find((r) => r.path === 'new.js')).toBeTruthy();
    expect(rows.some((r) => r.path === '/dev/null')).toBe(false);
  });

  test('empty / malformed input → empty array (never throws)', () => {
    expect(summarizeDiffFiles('')).toEqual([]);
    expect(summarizeDiffFiles(null)).toEqual([]);
    expect(summarizeDiffFiles(undefined)).toEqual([]);
  });
});

describe('formatDiffOverview', () => {
  test('header line totals + per-file rows with padding and bar', () => {
    const lines = formatDiffOverview(summarizeDiffFiles(SAMPLE));
    expect(lines[0]).toBe('改动概览: 3 个文件, +5 -2');
    expect(lines[1]).toMatch(/^ {2}services\/a\.js\s+\+2 -1 {2}[█░]+$/);
  });

  test('honest overflow line beyond maxFiles', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      path: `f${i}.js`,
      added: 1,
      removed: 0,
    }));
    const lines = formatDiffOverview(entries);
    expect(lines.filter((l) => /^ {2}f\d+\.js/.test(l))).toHaveLength(20);
    expect(lines[lines.length - 1]).toMatch(/另有 5 个文件未列出/);
  });

  test('empty entries → no lines', () => {
    expect(formatDiffOverview([])).toEqual([]);
  });
});

describe('diffOverviewEnabled gate', () => {
  const withEnv = (value, fn) => {
    const saved = process.env.KHY_DIFF_OVERVIEW;
    if (value === undefined) {
      delete process.env.KHY_DIFF_OVERVIEW;
    } else {
      process.env.KHY_DIFF_OVERVIEW = value;
    }
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.KHY_DIFF_OVERVIEW;
      else process.env.KHY_DIFF_OVERVIEW = saved;
    }
  };

  test('default on; 0/false/off/no disable', () => {
    expect(withEnv(undefined, () => diffOverviewEnabled())).toBe(true);
    expect(withEnv('0', () => diffOverviewEnabled())).toBe(false);
    expect(withEnv('off', () => diffOverviewEnabled())).toBe(false);
  });
});
