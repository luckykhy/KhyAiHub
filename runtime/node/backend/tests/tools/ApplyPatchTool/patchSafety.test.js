'use strict';
/**
 * ApplyPatchTool (apply_patch) — 路径围栏 / 回滚覆盖失败文件 / `--- ` 切分歧义。
 *
 * 1. 路径围栏:apply_patch 的唯一参数是自由文本 `patch`,路径全部来自
 *    `--- a/` / `+++ b/` 头,原样 `path.resolve(root, filePath)` 无任何校验 ——
 *    `../` 穿越与绝对路径都能写到项目外并覆盖,且 Phase 3 的递归 mkdir 会顺手
 *    把目录树建出来。守卫层也没兜底(toolGuards 的两条边界 guard pattern 不含
 *    apply_patch,且只认 file_path 字段,而本工具的入参里没有这个键)。
 *
 * 2. 回滚漏掉失败文件本身:Phase 3 是先 `fs.writeFileSync(abs, content)` 再
 *    `written.push(abs)`,回滚只遍历 `written`。写入中途抛错时该文件从未进入
 *    回滚集合,留在磁盘上是截断的半截内容,而返回文案声称 "all changes rolled
 *    back"。Phase 1 的 backups 早已备好它的原内容,只是没纳入回滚。
 *
 * 3. `--- ` 行首切分歧义:`patch.split(/^(?=--- )/m)` 不区分「文件头」和 hunk 体
 *    内以 `-` 为前缀的删除行。源码行本身以 `-- ` 开头(SQL/Lua 注释)时,渲染成
 *    `--- old comment`,正好命中切分点 —— 该 hunk 被截断成只剩上下文行,
 *    removed/added 都是空数组,补丁「成功」但一个字符都没改。
 *
 * 沙箱建在 os.tmpdir() 下(物理上位于用户 home 内,默认算可信用户目录),
 * 因此用例统一开 KHY_STRICT_WRITE_BOUNDARY=1。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ApplyPatchTool = require('../../../src/tools/ApplyPatchTool/index.js');
const { parsePatch } = ApplyPatchTool.__test__;

function withSandbox(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'applypatch-safety-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  const prevCwd = process.env.KHYQUANT_CWD;
  const prevStrict = process.env.KHY_STRICT_WRITE_BOUNDARY;
  process.env.KHYQUANT_CWD = proj;
  process.env.KHY_STRICT_WRITE_BOUNDARY = '1';
  return Promise.resolve()
    .then(() => fn({ base, proj }))
    .finally(() => {
      if (prevCwd === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prevCwd;
      if (prevStrict === undefined) delete process.env.KHY_STRICT_WRITE_BOUNDARY;
      else process.env.KHY_STRICT_WRITE_BOUNDARY = prevStrict;
      fs.rmSync(base, { recursive: true, force: true });
    });
}

const tool = new ApplyPatchTool();

test('"../" traversal in a patch header is refused; the outside file is untouched', async () => {
  await withSandbox(async ({ base }) => {
    const victim = path.join(base, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    const rel = path.relative(path.join(base, 'proj'), victim).replace(/\\/g, '/');
    const patch = [`--- a/${rel}`, `+++ b/${rel}`, '@@ -1 +1 @@', '-ORIGINAL', '+PWNED', ''].join('\n');

    const res = await tool.execute({ patch });
    assert.strictEqual(res.success, false, JSON.stringify(res));
    assert.match(res.error, /outside the project directory|Refused to patch/);
    assert.strictEqual(fs.readFileSync(victim, 'utf-8'), 'ORIGINAL');
  });
});

test('an absolute path in a patch header is refused; the file is untouched', async () => {
  await withSandbox(async ({ base }) => {
    const victim = path.join(base, 'victim-abs.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    const posix = victim.replace(/\\/g, '/');
    const patch = [`--- a/${posix}`, `+++ b/${posix}`, '@@ -1 +1 @@', '-ORIGINAL', '+PWNED', ''].join('\n');

    const res = await tool.execute({ patch });
    assert.strictEqual(res.success, false, JSON.stringify(res));
    assert.strictEqual(fs.readFileSync(victim, 'utf-8'), 'ORIGINAL');
  });
});

test('a patch that escapes the project does NOT create the escaping directory tree', async () => {
  await withSandbox(async ({ base }) => {
    const rel = path.relative(path.join(base, 'proj'), path.join(base, 'newdir', 'x.txt')).replace(/\\/g, '/');
    const patch = [`--- /dev/null`, `+++ b/${rel}`, '@@ -0,0 +1 @@', '+hello', ''].join('\n');

    const res = await tool.execute({ patch });
    assert.strictEqual(res.success, false, JSON.stringify(res));
    assert.strictEqual(fs.existsSync(path.join(base, 'newdir')), false);
  });
});

test('an in-project patch is unaffected by the fence', async () => {
  await withSandbox(async ({ proj }) => {
    const f = path.join(proj, 'ok.txt');
    fs.writeFileSync(f, 'before\n');
    const patch = ['--- a/ok.txt', '+++ b/ok.txt', '@@ -1 +1 @@', '-before', '+after', ''].join('\n');
    const res = await tool.execute({ patch });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'after\n');
  });
});

test('rollback restores the file whose write threw (was: left truncated, claimed "rolled back")', async () => {
  await withSandbox(async ({ proj }) => {
    const a = path.join(proj, 'a.txt');
    const b = path.join(proj, 'b.txt');
    fs.writeFileSync(a, 'A1\nA2\nA3\n');
    fs.writeFileSync(b, 'B1\nB2\n');
    const originalA = fs.readFileSync(a, 'utf-8');
    const originalB = fs.readFileSync(b, 'utf-8');

    const patch = [
      '--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,3 @@', ' A1', '-A2', '+A2-PATCHED', ' A3', '',
      '--- a/b.txt', '+++ b/b.txt', '@@ -1,2 +1,2 @@', ' B1', '-B2', '+B2-PATCHED', '',
    ].join('\n');

    // Simulate the write of b.txt failing after the target path was already
    // touched. Hook renameSync — Phase 3 now commits via tmp + renameSync, so
    // that is where a commit failure surfaces (ENOSPC / EACCES / kill).
    const realRename = fs.renameSync;
    fs.renameSync = function (from, to, ...rest) {
      if (String(to).endsWith('b.txt')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return realRename.call(fs, from, to, ...rest);
    };
    let res;
    try {
      res = await tool.execute({ patch });
    } finally {
      fs.renameSync = realRename;
    }

    assert.strictEqual(res.success, false);
    // The file whose write threw must be back to its pre-patch content.
    assert.strictEqual(fs.readFileSync(a, 'utf-8'), originalA, 'a.txt must be rolled back');
    assert.strictEqual(fs.readFileSync(b, 'utf-8'), originalB, 'b.txt (the failing write) must be rolled back');
    // No stray temp files left behind by the atomic write.
    const strays = fs.readdirSync(proj).filter((n) => n.includes('.tmp-'));
    assert.deepStrictEqual(strays, [], 'atomic write must clean up its temp file');
  });
});

test('a commit failure never leaves the target truncated (tmp + rename)', async () => {
  await withSandbox(async ({ proj }) => {
    const a = path.join(proj, 'keep.txt');
    fs.writeFileSync(a, 'ORIGINAL\n');
    const patch = ['--- a/keep.txt', '+++ b/keep.txt', '@@ -1 +1 @@', '-ORIGINAL', '+REPLACED', ''].join('\n');

    const realRename = fs.renameSync;
    fs.renameSync = function () {
      throw new Error('ENOSPC: no space left on device');
    };
    let res;
    try {
      res = await tool.execute({ patch });
    } finally {
      fs.renameSync = realRename;
    }

    assert.strictEqual(res.success, false);
    // fs.writeFileSync would have truncated this to zero bytes before failing.
    assert.strictEqual(fs.readFileSync(a, 'utf-8'), 'ORIGINAL\n');
  });
});

test('parsePatch keeps a hunk whose deleted source line starts with "-- "', () => {
  const patch = [
    '--- a/x.sql', '+++ b/x.sql', '@@ -1,3 +1,3 @@',
    ' SELECT 1;', '--- old comment', '+-- new comment', ' FROM t;', '',
  ].join('\n');
  const files = parsePatch(patch);
  assert.strictEqual(files.length, 1);
  const hunk = files[0].hunks[0];
  assert.deepStrictEqual(hunk.removed, ['-- old comment']);
  assert.deepStrictEqual(hunk.added, ['-- new comment']);
  assert.notStrictEqual(hunk.malformed, true);
});

test('end-to-end: a SQL comment patch applies the change instead of silently no-op\'ing', async () => {
  await withSandbox(async ({ proj }) => {
    const f = path.join(proj, 'x.sql');
    fs.writeFileSync(f, 'SELECT 1;\n-- old comment\nFROM t;\n');
    const patch = [
      '--- a/x.sql', '+++ b/x.sql', '@@ -1,3 +1,3 @@',
      ' SELECT 1;', '--- old comment', '+-- new comment', ' FROM t;', '',
    ].join('\n');
    const res = await tool.execute({ patch });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'SELECT 1;\n-- new comment\nFROM t;\n');
  });
});

test('a hunk with body lines but no +/- content is reported, not silently applied', async () => {
  await withSandbox(async ({ proj }) => {
    const f = path.join(proj, 'y.txt');
    fs.writeFileSync(f, 'one\ntwo\nthree\n');
    // Truncated/unparseable hunk: context only.
    const patch = ['--- a/y.txt', '+++ b/y.txt', '@@ -1,3 +1,3 @@', ' one', ''].join('\n');
    const res = await tool.execute({ patch });
    assert.strictEqual(res.success, false, JSON.stringify(res));
    assert.match(res.error, /Malformed patch/);
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'one\ntwo\nthree\n');
  });
});

test('two file sections still parse as two files (the split fix is not over-eager)', () => {
  const patch = [
    '--- a/one.txt', '+++ b/one.txt', '@@ -1 +1 @@', '-a', '+b', '',
    '--- a/two.txt', '+++ b/two.txt', '@@ -1 +1 @@', '-c', '+d', '',
  ].join('\n');
  const files = parsePatch(patch);
  assert.deepStrictEqual(files.map((f) => f.dstPath), ['one.txt', 'two.txt']);
  assert.deepStrictEqual(files[1].hunks[0].removed, ['c']);
});