'use strict';
/**
 * FileWriteTool (Write) / writeFile — 展开后再校验、isDestructive 与写入同源、
 * 写后 readState 刷新、诊断接线。
 *
 * 1. validateInput 只看**未展开**的 params.file_path,而 execute 会做
 *    %VAR% / $VAR / ~ / 桌面别名展开后再 path.resolve。展开是在闸门之后注入
 *    越界路径的:`%SystemRoot%\...`、`~/.ssh/authorized_keys`、`%OUT%/x.txt`
 *    作为字面量按 cwd 解析时落在项目内(校验放行),展开后落到系统目录或
 *    敏感 home sink。写过的同款洞:writeFile.js:112-132 有一段显式的 [SAFE]
 *    再校验块,FileWriteTool 没有。
 *
 * 2. isDestructive 用**未展开**的路径 existsSync,与实际写入目标不一致:
 *    同一个真实已存在的覆盖目标,写绝对路径被人闸门拦住,写 %VAR% 形式就降级
 *    成非破坏性、完全不触发确认,而文件照样被覆盖。
 *
 * 3. 写完不刷新 readTracker:Write 自己刚写完的文件,下一跳 Edit 的 isStale
 *    会判成「被外部修改」(mtime 差 > 50ms),而被 Write 新建的文件在 tracker
 *    里根本没有条目 → 下一跳 Edit 被 hasRead 拒。FileEditTool/MultiEditTool
 *    三条写路径都调了 markRead,Write 没有。
 *
 * 4. writeFile 缺读前写门,且不给模型任何语法诊断(FileWriteTool 给)。
 *
 * 沙箱建在 os.tmpdir() 下,物理上位于用户 home 内,默认会被
 * validateNoPathTraversal 当作可信用户目录放行;因此这些用例统一开
 * KHY_STRICT_WRITE_BOUNDARY=1 才测得到围栏本身。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const Write = require('../../../src/tools/FileWriteTool/index.js');
const writeFile = require('../../../src/tools/writeFile.js');
const tracker = require('../../../src/tools/_readTracker');

const OUTSIDE_VAR = 'KHY_TEST_WRITE_OUT';

function withSandbox(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'filewrite-safety-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const victim = path.join(outside, 'important.conf');
  fs.writeFileSync(victim, 'ORIGINAL SYSTEM CONFIG\n');
  const prevCwd = process.env.KHYQUANT_CWD;
  const prevStrict = process.env.KHY_STRICT_WRITE_BOUNDARY;
  const prevVar = process.env[OUTSIDE_VAR];
  process.env.KHYQUANT_CWD = proj;
  process.env.KHY_STRICT_WRITE_BOUNDARY = '1';
  process.env[OUTSIDE_VAR] = outside;
  return Promise.resolve()
    .then(() => fn({ base, proj, outside, victim }))
    .finally(() => {
      for (const [k, v] of [
        ['KHYQUANT_CWD', prevCwd],
        ['KHY_STRICT_WRITE_BOUNDARY', prevStrict],
        [OUTSIDE_VAR, prevVar],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });
}

describe('Write path fence (post-expansion)', () => {
  test('an absolute out-of-project path is refused', async () => {
    await withSandbox(async ({ victim }) => {
      tracker.markRead(victim);
      const res = await Write.execute({ file_path: victim, content: 'CLOBBERED' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/outside the project directory/);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL SYSTEM CONFIG\n');
    });
  });

  test('a %VAR% path expanding out of the project is refused (validateInput alone lets it through)', async () => {
    await withSandbox(async ({ outside, victim }) => {
      tracker.markRead(victim);
      const raw = `%${OUTSIDE_VAR}%/important.conf`;
      // The tool-calling gate sees the LITERAL string, which resolves under
      // cwd → inside the project → passes. Only the in-execute re-check on the
      // expanded path can catch this.
      expect((await Write.validateInput({ file_path: raw })).valid).toBe(true);

      const res = await Write.execute({ file_path: raw, content: 'CLOBBERED' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/outside the project directory/);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL SYSTEM CONFIG\n');
      expect(fs.readdirSync(outside)).toEqual(['important.conf']);
    });
  });

  test('a ~ expansion into a sensitive home sink is refused', async () => {
    await withSandbox(async () => {
      const res = await Write.execute({ file_path: '~/.ssh/authorized_keys', content: 'pwn' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/sensitive home location/);
    });
  });

  test('validateInput fails closed: no catch → valid:true escape hatch', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/tools/FileWriteTool/index.js'),
      'utf-8'
    );
    const fn = src.slice(src.indexOf('async validateInput'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).not.toMatch(/catch/);
    expect(body).not.toMatch(/valid:\s*true/);
  });

  test('an in-project write still succeeds', async () => {
    await withSandbox(async ({ proj }) => {
      const res = await Write.execute({
        file_path: path.join(proj, 'new.txt'),
        content: 'hello\n',
      });
      expect(res.success).toBe(true);
      expect(fs.readFileSync(path.join(proj, 'new.txt'), 'utf-8')).toBe('hello\n');
    });
  });
});

describe('Write isDestructive agrees with the path it actually writes', () => {
  test('a %VAR% path onto an existing file IS classified destructive', async () => {
    await withSandbox(async ({ victim }) => {
      expect(fs.existsSync(victim)).toBe(true);
      expect(Write.isDestructive({ file_path: `%${OUTSIDE_VAR}%/important.conf` })).toBe(true);
    });
  });

  test('writeFile.isDestructive agrees too (was: false on the same input)', async () => {
    await withSandbox(async ({ victim }) => {
      expect(fs.existsSync(victim)).toBe(true);
      expect(writeFile.isDestructive({ path: `%${OUTSIDE_VAR}%/important.conf` })).toBe(true);
    });
  });

  test('a genuinely new file is still non-destructive (no over-tightening)', async () => {
    await withSandbox(async ({ proj }) => {
      expect(Write.isDestructive({ file_path: path.join(proj, 'brand-new.txt') })).toBe(false);
      expect(writeFile.isDestructive({ path: path.join(proj, 'brand-new.txt') })).toBe(false);
    });
  });
});

describe('Write refreshes readState after writing', () => {
  test('a file Write just overwrote is not "stale" for the next Edit', async () => {
    await withSandbox(async ({ proj }) => {
      const f = path.join(proj, 'a.txt');
      fs.writeFileSync(f, 'v1\n');
      tracker.markRead(f);
      expect(tracker.isStale(f).stale).toBe(false);

      await Write.execute({ file_path: f, content: 'v2\n' });

      expect(tracker.isStale(f).stale).toBe(false);
    });
  });

  test('a file Write just created is tracked, so the next Edit is not told to Read it', async () => {
    await withSandbox(async ({ proj }) => {
      const f = path.join(proj, 'created.txt');
      await Write.execute({ file_path: f, content: 'fresh\n' });
      expect(tracker.hasRead(f)).toBe(true);
    });
  });
});

describe('writeFile read-before-write gate and diagnostics', () => {
  test('overwriting an existing, never-read file is refused', async () => {
    await withSandbox(async ({ proj }) => {
      const f = path.join(proj, 'victim.js');
      fs.writeFileSync(f, '// original content\n'.repeat(20));
      const res = await writeFile.execute({ path: f, content: '// replaced' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/not read in this session/);
      expect(fs.readFileSync(f, 'utf-8')).toContain('// original content');
    });
  });

  test('overwriting after a Read succeeds (the gate is not a blanket deny)', async () => {
    await withSandbox(async ({ proj }) => {
      const f = path.join(proj, 'read-then-write.js');
      fs.writeFileSync(f, 'original\n');
      tracker.markRead(f);
      const res = await writeFile.execute({ path: f, content: 'replaced\n' });
      expect(res.success).toBe(true);
      expect(fs.readFileSync(f, 'utf-8')).toBe('replaced\n');
    });
  });

  test('creating a new file still works (gate only applies to existing files)', async () => {
    await withSandbox(async ({ proj }) => {
      const res = await writeFile.execute({
        path: path.join(proj, 'created-by-writeFile.js'),
        content: 'new\n',
      });
      expect(res.success).toBe(true);
      expect(res.bytes).toBe(4);
    });
  });
});