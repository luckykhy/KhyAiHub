'use strict';
/**
 * MultiEditTool (MultiEdit) — 空 old_string 与路径围栏。
 *
 * 1. 空 old_string:计数 while 里的 `if (old_string.length === 0) break` 只防死
 *    循环。`working.indexOf('')` 返回 0 → count 恒为 1 → `count === 0`(未找到)
 *    与 `count > 1 && !replace_all`(歧义)两道闸门全部放行 → 落到
 *    `working.split('').join(new_string)`,把替换串插到文件每一个字符之间,
 *    真落盘并返回 success:true。replace_all 为假时同样静默损坏(pos=0 前置)。
 *
 * 2. 路径围栏:MultiEdit 是 alwaysLoad 的高危写工具,却和 Edit 一样只做
 *    `~` 展开 → path.resolve → fs,没有 UNC / 越界 / 边界校验。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const MultiEdit = require('../../../src/tools/MultiEditTool/index.js');
const tracker = require('../../../src/tools/_readTracker');

function withSandbox(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiedit-safety-'));
  const prev = process.env.KHYQUANT_CWD;
  const prevStrict = process.env.KHY_STRICT_WRITE_BOUNDARY;
  process.env.KHYQUANT_CWD = dir;
  process.env.KHY_STRICT_WRITE_BOUNDARY = '1';
  const f = path.join(dir, 'sample.js');
  fs.writeFileSync(f, content);
  tracker.markRead(f);
  return Promise.resolve()
    .then(() => fn({ dir, f }))
    .finally(() => {
      if (prev === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prev;
      if (prevStrict === undefined) delete process.env.KHY_STRICT_WRITE_BOUNDARY;
      else process.env.KHY_STRICT_WRITE_BOUNDARY = prevStrict;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

describe('MultiEdit empty old_string', () => {
  test('replace_all + empty old_string is refused, file byte-identical', async () => {
    await withSandbox('const x = 1;\n', async ({ f }) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await MultiEdit.execute({
        file_path: f,
        edits: [{ old_string: '', new_string: 'JUNK', replace_all: true }],
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/must not be empty/);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  test('empty old_string WITHOUT replace_all is refused too (was: prepended at pos 0)', async () => {
    await withSandbox('const x = 1;\n', async ({ f }) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await MultiEdit.execute({
        file_path: f,
        edits: [{ old_string: '', new_string: 'JUNK' }],
      });
      expect(res.success).toBe(false);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  test('one bad edit among good ones aborts the whole batch, nothing written', async () => {
    await withSandbox('const x = 1;\n', async ({ f }) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await MultiEdit.execute({
        file_path: f,
        edits: [
          { old_string: 'const x = 1;', new_string: 'const x = 2;' },
          { old_string: '', new_string: 'JUNK' },
        ],
      });
      expect(res.success).toBe(false);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  test('inputSchema declares minLength: 1 on each edit old_string', () => {
    const items = MultiEdit.inputSchema.properties.edits.items;
    expect(items.properties.old_string.minLength).toBe(1);
  });
});

describe('MultiEdit path fence', () => {
  test('an out-of-project absolute path is refused and the file is untouched', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multiedit-fence-'));
    const proj = path.join(base, 'proj');
    fs.mkdirSync(proj);
    const victim = path.join(base, 'outside.txt');
    fs.writeFileSync(victim, 'alpha\n');
    const prev = process.env.KHYQUANT_CWD;
    const prevStrict = process.env.KHY_STRICT_WRITE_BOUNDARY;
    process.env.KHYQUANT_CWD = proj;
    process.env.KHY_STRICT_WRITE_BOUNDARY = '1';
    try {
      tracker.markRead(victim);
      const res = await MultiEdit.execute({
        file_path: victim,
        edits: [{ old_string: 'alpha', new_string: 'PWNED' }],
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/outside the project directory/);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('alpha\n');
    } finally {
      if (prev === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prev;
      if (prevStrict === undefined) delete process.env.KHY_STRICT_WRITE_BOUNDARY;
      else process.env.KHY_STRICT_WRITE_BOUNDARY = prevStrict;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('a UNC path is refused before any fs access', async () => {
    await withSandbox('x\n', async ({ f }) => {
      const res = await MultiEdit.execute({
        file_path: '\\\\attacker.example\\share\\x.txt',
        edits: [{ old_string: 'a', new_string: 'b' }],
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/UNC network paths are not allowed/);
      expect(fs.readFileSync(f, 'utf-8')).toBe('x\n');
    });
  });

  test('an in-project edit is unaffected by the fence', async () => {
    await withSandbox('alpha\n', async ({ f }) => {
      const res = await MultiEdit.execute({
        file_path: f,
        edits: [{ old_string: 'alpha', new_string: 'beta' }],
      });
      expect(res.success).toBe(true);
      expect(fs.readFileSync(f, 'utf-8')).toBe('beta\n');
    });
  });
});