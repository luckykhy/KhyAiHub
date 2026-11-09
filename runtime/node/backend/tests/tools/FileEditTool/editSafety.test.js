'use strict';
/**
 * FileEditTool (Edit) — 三条「报 success 却写坏文件」的回退路径。
 *
 * 1. 空 old_string:计数循环的 `if (old_string.length === 0) break` 只防死循环,
 *    不防写盘。`original.indexOf('')` 返回 0 → count 恒为 1 → `count > 1` 的
 *    歧义闸门和 `count === 0` 的未找到闸门全部放行 → replace_all 走
 *    `split('').join(new_string)`(每个字符间插一遍),单次替换走 pos=0 把
 *    new_string 塞到文件头。两条路都真落盘、都返回 success:true,
 *    replacements 还谎报为 1。
 *
 * 2. 行号栏(gutter)回退:模型从 Read 里照抄,old_string 和 new_string 都带
 *    "42\t"。该分支只对 old_string 跑 _stripLineGutter,new_string 原样拼进去 ——
 *    专为「照抄 Read」设计的这条回退,反而把行号写进了源文件。修法是**拒绝**
 *    而不是无条件去壳:_stripLineGutter 的正则同样命中合法缩进/编号文本,
 *    无条件去壳会把真实内容改坏,等于用一个静默损坏换一个静默损坏。
 *
 * 3. 模糊回退整行越界:_fuzzyFind 在「整行」窗口上算相似度,而替换区间
 *    (start/end) 由行边界算出,与 needle 在行内的偏移无关。needle 只是长行的
 *    一段时也照样整行替换,行首/行尾模型从没提过的内容被一起删掉。
 *    修法:候选必须与 needle 行对齐(首行被 needle 覆盖、末行被 needle 覆盖、
 *    行数一致),否则不作为候选 —— 这样行边界算出的区间才和 needle 的覆盖
 *    区间一致。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const Edit = require('../../../src/tools/FileEditTool/index.js');
const tracker = require('../../../src/tools/_readTracker');

function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileedit-safety-'));
  const prev = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = dir;
  const f = path.join(dir, 'sample.js');
  fs.writeFileSync(f, content);
  tracker.markRead(f);
  return Promise.resolve()
    .then(() => fn(f))
    .finally(() => {
      if (prev === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

describe('Edit empty old_string', () => {
  test('replace_all + empty old_string is refused, file byte-identical', async () => {
    await withFile('function f() {\n  return 1;\n}\n', async (f) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await Edit.execute({
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

  test('empty old_string WITHOUT replace_all is refused (was: new_string prepended at pos 0)', async () => {
    await withFile('const x = 1;\n', async (f) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await Edit.execute({
        file_path: f,
        old_string: '',
        new_string: 'ZZZ',
      });
      expect(res.success).toBe(false);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  test('inputSchema declares minLength: 1 on old_string', () => {
    expect(Edit.inputSchema.properties.old_string.minLength).toBe(1);
  });
});

describe('Edit line-number gutter fallback', () => {
  test('new_string still carrying the Read gutter is refused, file byte-identical', async () => {
    await withFile('const a = 1;\nconst b = 2;\nconst c = 3;\n', async (f) => {
      const before = fs.readFileSync(f, 'utf-8');
      const res = await Edit.execute({
        file_path: f,
        old_string: '2\tconst b = 2;',
        new_string: '2\tconst b = 222;',
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/line-number gutter/);
      // 之前这一条返回 success:true 且磁盘变成 "2\tconst b = 222;"。
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  test('control: gutted old_string + clean new_string still works (byte-identical to prior good path)', async () => {
    await withFile('const a = 1;\nconst b = 2;\nconst c = 3;\n', async (f) => {
      const res = await Edit.execute({
        file_path: f,
        old_string: '2\tconst b = 2;',
        new_string: 'const b = 222;',
      });
      expect(res.success).toBe(true);
      expect(res.gutterStrip).toBe(true);
      expect(fs.readFileSync(f, 'utf-8')).toBe('const a = 1;\nconst b = 222;\nconst c = 3;\n');
    });
  });
});

describe('Edit fuzzy fallback line alignment', () => {
  test('partial-line needle does NOT replace the surrounding line', async () => {
    const line = 'const total = computeTotal(alphaValue,betaValue, gammaValue, deltaValue, epsilon);\n';
    await withFile(line, async (f) => {
      const res = await Edit.execute({
        file_path: f,
        old_string: 'computeTotal(alphaValue, betaValue, gammaValue, deltaValue, epsilon)',
        new_string: 'computeTotal(a, b)',
      });
      // 拒绝或至少不改写行首/行尾;关键断言是文件未被静默改坏。
      if (res.success) {
        throw new Error(
          'expected the partial-line needle NOT to be fuzzy-replaced over the whole line, got ' +
            JSON.stringify(res)
        );
      }
      expect(fs.readFileSync(f, 'utf-8')).toBe(line);
    });
  });

  test('multi-line partial needle does NOT eat trailing code on the last matched line', async () => {
    const content =
      '// header comment that must survive\nfunction outer() { computeTotal(alphaValue,betaValue, gammaValue, deltaValue, epsilon); tail(); }\n// footer comment that must survive\n';
    await withFile(content, async (f) => {
      const res = await Edit.execute({
        file_path: f,
        old_string: 'function outer() { computeTotal(alphaValue, betaValue, gammaValue, deltaValue, epsilon)',
        new_string: 'function outer() { computeTotal(a, b);',
      });
      if (res.success) {
        throw new Error(
          'expected refusal for a needle that does not span the matched line, got ' +
            JSON.stringify(res)
        );
      }
      expect(fs.readFileSync(f, 'utf-8')).toBe(content);
    });
  });

  test('control: a whole-line needle with a whitespace difference still fuzzy-replaces', async () => {
    await withFile('function computeTotal(items) {\n  let sum = 0;\n  return sum;\n}\n', async (f) => {
      const res = await Edit.execute({
        file_path: f,
        old_string: 'function computeTotal(items) {\n  let  sum  = 0;\n  return sum;\n}',
        new_string: 'function computeTotal(items) {\n  let sum = 0;\n  return sum * 2;\n}',
      });
      expect(res.success).toBe(true);
      expect(res.fuzzyMatch).toBe(true);
      expect(fs.readFileSync(f, 'utf-8')).toContain('return sum * 2;');
    });
  });
});

describe('Edit error messages only advertise parameters that exist', () => {
  test('inputSchema has no start_line/end_line, and no error text recommends them', () => {
    expect(Edit.inputSchema.properties.start_line).toBeUndefined();
    expect(Edit.inputSchema.properties.end_line).toBeUndefined();
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/tools/FileEditTool/index.js'),
      'utf-8'
    );
    // 文案让模型去用 schema 里不存在的参数 → 传了被静默忽略 → 原地复现同一条错。
    expect(src).not.toMatch(/start_line\/end_line/);
  });

  test('prompt() discloses that a fuzzy fallback can replace a different region', () => {
    expect(Edit.prompt()).toMatch(/fuzzyMatch: true/);
  });
});