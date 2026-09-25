'use strict';

/**
 * Regression for the wrong-registry-binding family on the compile tools.
 *
 * `src/tools/compileFile.js` and `src/tools/executeCode.js` required
 * `src/cli/commands/registry.js` (the CLI *command* table: getCommandNames /
 * getHandler / …) while calling `getLanguage` / `listLanguages` / `_javaClass` /
 * `_canon`, which only exist on `src/services/domain/build/compile/registry.js`.
 * The very first statement of `compile_file`'s execute() was such a call, so the
 * tool threw `TypeError: compileRegistry.getLanguage is not a function` for every
 * input, including valid ones — measured 2026-09-24 before the fix.
 *
 * Same病因 as `agentAssets/sync.js` (fixed 2026-09-22, guarded by
 * agentAssets.syncRegistry.test.js) and as the deploy / reverse_engineer shims.
 * Two assertions per site: the require TARGET is bound (a behavioural-only test
 * stays green after a revert), and the real tool path returns its designed
 * friendly error instead of a TypeError.
 */

const fs = require('fs');
const path = require('path');

const FILES = {
  compileFile: '../../src/tools/compileFile.js',
  executeCode: '../../src/tools/executeCode.js',
};
// `.js` is optional on purpose: the reverted form is written WITH the extension,
// and a pattern that cannot match it would be a vacuous negative assertion.
const WRONG_TARGET = /require\(['"][^'"]*commands\/registry(?:\.js)?['"]\)/;
const RIGHT_TARGET = /require\(['"][^'"]*domain\/build\/compile\/registry(?:\.js)?['"]\)/;
const MEMBERS = ['getLanguage', 'listLanguages', '_javaClass', '_canon'];

describe('compile tools — registry binding (wrong-registry family)', () => {
  for (const [label, rel] of Object.entries(FILES)) {
    it(`${label} binds the compile registry, not the CLI command registry`, () => {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf-8');
      expect(src).toMatch(RIGHT_TARGET);
      expect(src).not.toMatch(WRONG_TARGET);
    });
  }

  it('the compile registry really provides every member those files call', () => {
    const registry = require('../../src/services/domain/build/compile/registry.js');
    for (const member of MEMBERS) {
      expect(typeof registry[member]).toBe('function');
    }
  });

  it('the CLI command registry really does NOT (negative control, keeps the assertion live)', () => {
    const cliRegistry = require('../../src/cli/commands/registry.js');
    for (const member of MEMBERS) {
      expect(cliRegistry[member]).toBeUndefined();
    }
    // And the pattern must actually catch the historical bad line, otherwise
    // the `not.toMatch` above proves nothing.
    expect(WRONG_TARGET.test("const r = require('../cli/commands/registry.js');")).toBe(true);
  });

  it('compile_file answers an unsupported language instead of throwing', async () => {
    const tool = require('../../src/tools/compileFile.js');
    const res = await tool.execute({ language: 'zqx-bogus', code: 'int main(){}' }, {});
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/Unsupported language "zqx-bogus"/);
    expect(String(res.error)).toMatch(/Supported: .*c.*rust.*go/);
  });

  it('executeCode reaches _canon and reports an unsupported language (gated path)', async () => {
    // execute() returns early unless the operator opts in, so without the env the
    // wrong binding below would never be exercised. An unregistered language is
    // still dispatched to the native path, which rejects before any subprocess.
    process.env.KHY_ENABLE_EXECUTE_CODE = '1';
    try {
      const tool = require('../../src/tools/executeCode.js');
      const res = await tool.execute({ language: 'zqx-bogus', code: 'x' }, {});
      expect(String(res.error)).toMatch(/Unsupported language/);
    } finally {
      delete process.env.KHY_ENABLE_EXECUTE_CODE;
    }
  });
});
