'use strict';
/**
 * editFile.js — 空 old_string 死循环 / isStale 真值误用 / 重叠计数。
 *
 * 1. 空 old_string:计数循环 `while ((idx = original.indexOf(old_string, idx + 1)) !== -1)`
 *    在空串下**永不返回** —— `'x'.indexOf('', n)` 恒等于 n,不是 -1。那是一个
 *    同步无限循环,占死整个事件循环(连 setTimeout 定时器都触发不了)。
 *    FileEditTool/index.js:339 早就加了 `if (old_string.length === 0) break`
 *    这道循环内守卫,editFile.js 与 delivery 副本一直没同步。
 *    注:notebookEdit compat 分支(toolCalling.js:1295-1315)直接调 execute 而
 *    不走 validateParams,所以这条是可真实触发的挂死入口,不是理论问题。
 *
 * 2. isStale 真值误用:_readTracker.isStale() 返回 `{stale:boolean, reason?}` 对象
 *    而非布尔(`_readTracker.js:68` 的 @returns 写死了这个形状)。原代码把它直接
 *    当布尔用,非空对象恒为真 → 只要过了 hasRead 就 100% 走 stale 分支:
 *    默认 stage=S1 时每次编辑都打一条误导性的「文件已过期」告警,
 *    stage=S2 时变成拒绝一切对已读文件的编辑。
 *
 * 3. 重叠计数:游标每次只步进 1 个字符,与实际的 `split().join()`(非重叠)
 *    语义不一致。文件 'x---y' + old_string '--' 只有一个非重叠出现,却被数成
 *    2 次而在未设 replace_all 时误拒一次合法的唯一编辑。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const editFile = require('../../src/tools/editFile.js');
const tracker = require('../../src/tools/_readTracker');

function withFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editfile-safety-'));
  const prev = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = dir;
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  tracker.markRead(f);
  return Promise.resolve()
    .then(() => fn(f, dir))
    .finally(() => {
      if (prev === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

describe('editFile empty old_string', () => {
  test('empty old_string returns an error instead of hanging (must not block)', async () => {
    await withFile('a.txt', 'function f() {\n  return 1;\n}\n', async (f) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await editFile.execute({
        file_path: f,
        old_string: '',
        new_string: 'X',
        replace_all: true,
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/must not be empty/);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  test('inputSchema declares minLength: 1 on old_string', () => {
    expect(editFile.inputSchema.old_string.minLength).toBe(1);
  });
});

describe('editFile read-before-edit staleness', () => {
  test('a freshly read, unmodified file is NOT treated as stale', async () => {
    await withFile('fresh.js', 'const A = 1;\n', async (f) => {
      const stale = tracker.isStale(f);
      expect(stale.stale).toBe(false);
      // stage=S2 时旧代码会拒绝这次编辑;修好后必须成功。
      const prevStage = process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE;
      process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE = 'S2';
      try {
        const res = await editFile.execute({
          file_path: f,
          old_string: 'const A = 1;',
          new_string: 'const A = 2;',
        });
        expect(res.success).toBe(true);
        expect(fs.readFileSync(f, 'utf-8')).toBe('const A = 2;\n');
      } finally {
        if (prevStage === undefined) delete process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE;
        else process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE = prevStage;
      }
    });
  });

  test('a file modified externally since the last read IS still refused', async () => {
    await withFile('stale.js', 'const A = 1;\n', async (f) => {
      // 把 tracker 里的 mtime 推到过去,模拟「读完之后文件被别人改过」
      const st = fs.statSync(f);
      tracker.markRead(f, st.mtimeMs - 10_000);
      const prevStage = process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE;
      process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE = 'S2';
      try {
        const res = await editFile.execute({
          file_path: f,
          old_string: 'const A = 1;',
          new_string: 'const A = 2;',
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/文件已过期/);
      } finally {
        if (prevStage === undefined) delete process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE;
        else process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE = prevStage;
      }
    });
  });
});

describe('editFile occurrence counting', () => {
  test('overlap "replace_all" reports the NON-overlapping count it actually performed', async () => {
    await withFile('overlap2.txt', 'x----y\n', async (f) => {
      const res = await editFile.execute({
        file_path: f,
        old_string: '--',
        new_string: '++',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.replacements).toBe(2); // was 3 (overlapping)
      expect(fs.readFileSync(f, 'utf-8')).toBe('x++++y\n');
    });
  });

  test('a genuinely unique self-overlapping needle is NOT refused as ambiguous', async () => {
    // 'x---y' 只有 1 处非重叠的 '--';旧代码数成 2 处 → 未设 replace_all 时误拒。
    await withFile('unique.txt', 'x---y\n', async (f) => {
      const res = await editFile.execute({
        file_path: f,
        old_string: '--',
        new_string: '++',
      });
      expect(res.success).toBe(true);
      expect(fs.readFileSync(f, 'utf-8')).toBe('x++-y\n');
    });
  });

  test('a truly duplicated needle is still refused, with the true count', async () => {
    await withFile('dup.txt', 'x----y\n', async (f) => {
      const res = await editFile.execute({
        file_path: f,
        old_string: '--',
        new_string: '++',
      });
      expect(res.success).toBe(false);
      expect(res.occurrences).toBe(2); // was 3
    });
  });

  test('a non-self-overlapping needle is byte-identical (count unchanged)', async () => {
    await withFile('plain.txt', 'alpha\nbeta\nalpha\n', async (f) => {
      const res = await editFile.execute({
        file_path: f,
        old_string: 'alpha',
        new_string: 'ALPHA',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.replacements).toBe(2);
      expect(fs.readFileSync(f, 'utf-8')).toBe('ALPHA\nbeta\nALPHA\n');
    });
  });
});