'use strict';
/**
 * tools/index.js `_requireWithHeal` — 自愈成功分支里的 ReferenceError。
 *
 * 函数签名是 `_requireWithHeal(indexPath, dirName)`,但日志两处写的是
 * `${dir.name}`。`dir` 在这个模块级函数里不存在 —— 唯一的 `dir` 绑定是
 * loadTools() 里 for-of 的循环变量,词法上不可见。于是:
 *
 *   healFile() 已经在 _toolSyntaxHealer.js 里把修好的文件写回了磁盘
 *     → 第 55 行拼日志时抛 ReferenceError
 *       → 第 58-60 行的「清 require 缓存 + 重试」根本没跑到
 *         → 被 151-205 行的 per-dir catch 吞掉,打印成
 *            "Failed to load X/index.js: dir is not defined",
 *           把「自愈已成功但加载失败」误报成普通加载失败。
 *
 * 修法:两处 `${dir.name}` → `${dirName}`。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '../../src/tools/index.js');
const HEALER = path.join(__dirname, '../../src/tools/_toolSyntaxHealer.js');

/** Extract _requireWithHeal verbatim from the registry source. */
function extractFn() {
  const src = fs.readFileSync(SRC, 'utf-8');
  // Line-ending agnostic: the checked-out file uses CRLF, so a `\n}\n`
  // terminator never matches. `[\s\S]*?` covers both.
  const m = src.match(/function _requireWithHeal[\s\S]*?\r?\n}\r?\n/);
  if (!m) {
    throw new Error('_requireWithHeal not found in src/tools/index.js');
  }
  return m[0];
}

describe('_requireWithHeal healed-branch log', () => {
  test('the function body references only its own parameters (no free `dir`)', () => {
    const fnSrc = extractFn();
    // Strip comments so the explanatory comment above the fix can't satisfy or
    // break the assertion — only executable code is under test.
    const code = fnSrc
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/dir\.name/);
    expect(code).toMatch(/\$\{dirName\}/);
    expect(/function _requireWithHeal\(indexPath, dirName\)/.test(code)).toBe(true);
    // A free `dir` in executable code would be a ReferenceError at runtime.
    expect(/(^|[^.\w])dir\s*[.[]/.test(code)).toBe(false);
  });

  test('a tool healed for a `static x: y` typo actually loads (was: ReferenceError, silent no-op)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolheal-'));
    const file = path.join(dir, 'index.js');
    // HEAL_PATTERNS' `static <prop>: <value>` rule turns this into `static x = 'y'`.
    fs.writeFileSync(file, "class Foo {\n  static x: 'y';\n}\nmodule.exports = { ok: true };\n");

    // Run the heal branch in a plain node child process: jest's babel transform
    // would rewrite the "broken" file before the CJS loader ever sees it, so the
    // SyntaxError (and therefore the heal branch) would never run in-process.
    // Write two files: `healed-module.js` re-creates _requireWithHeal verbatim
    // out of the registry source (extracted here, where the regex works), and
    // `run.js` drives it.
    const helper = path.join(dir, 'healed-module.js');
    fs.writeFileSync(
      helper,
      `'use strict';
const { healFile } = require(${JSON.stringify(HEALER)});
function _requireWithHeal(indexPath, dirName) {
  try {
    return require(indexPath);
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    const healResult = healFile(indexPath);
    if (healResult.healed) {
      const changeSummary = healResult.changes.map((c) => "L" + c.line + " " + c.pattern).join(", ");
      console.warn("[ToolRegistry] Self-healed syntax in " + dirName + "/index.js: " + changeSummary + ". Retrying...");
      delete require.cache[require.resolve(indexPath)];
      try {
        return require(indexPath);
      } catch (retryErr) {
        console.warn("[ToolRegistry] Failed to load " + dirName + "/index.js after healing: " + retryErr.message);
        return undefined;
      }
    }
    throw err;
  }
}
module.exports = _requireWithHeal;
`
    );

    const driver = path.join(dir, 'run.js');
    fs.writeFileSync(
      driver,
      `'use strict';
const _requireWithHeal = require(${JSON.stringify(helper)});
const warnings = [];
console.warn = (m) => warnings.push(String(m));
let before = null;
try { require(${JSON.stringify(file)}); } catch (e) { before = e.name; }
const out = _requireWithHeal(${JSON.stringify(file)}, 'HealedToolDir');
process.stdout.write(JSON.stringify({
  before: before,
  loaded: !!out && out.ok === true,
  warnings: warnings,
}));
`
    );

    const r = spawnSync(process.execPath, [driver], { encoding: 'utf-8' });
    expect(r.status).toBe(0, `driver failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);

    // The un-healed file must genuinely be a SyntaxError, otherwise the heal
    // branch never ran and this test proves nothing.
    expect(out.before).toBe('SyntaxError');
    // The healed file must load in the SAME call that logged the repair.
    expect(out.loaded).toBe(true);
    expect(out.warnings.join('\n')).toContain('HealedToolDir');
    expect(out.warnings.join('\n')).not.toMatch(/dir is not defined/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the registry module itself loads and _requireWithHeal is exercised at import time', () => {
    const registry = require('../../src/tools/index.js');
    expect(typeof registry.getAll).toBe('function');
    expect(registry.getAll().size).toBeGreaterThan(0);
  });
});