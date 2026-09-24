'use strict';

/**
 * `khy pool add` — honest write receipt (#74-family fake-success fix).
 *
 * accountPool.addAccount ends in `accounts.find(...) || null`: it returns null
 * when the upserted row can't be read back — an UNCONFIRMED write. The pre-fix
 * handler printed `已添加账号 …` (printSuccess) unconditionally via
 * `account?.tokenPreview || ''`, so a null receipt still claimed success.
 *
 * We drive the REAL handlePoolAdd through the production dispatch, faking only
 * the three modules it binds at require time (formatters → capture the print
 * calls; uiPrompt → no interactive block; accountPool → controlled receipt).
 * Asserts the fix's contract: null → error + NO success; truthy → success.
 *
 * Runs under jest or `node --test` via the shim (no jest binary in this checkout).
 */

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
  });
}

const poolPath = require.resolve('../../src/cli/handlers/pool');
const formattersPath = require.resolve('../../src/cli/formatters');
const uiPromptPath = require.resolve('../../src/cli/uiPrompt');
const accountPoolPath = require.resolve('../../src/services/accountPool');

function seedCache(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
}

function loadHandler({ addAccountImpl }) {
  const calls = { success: [], error: [] };
  seedCache(formattersPath, {
    printSuccess: (m) => calls.success.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
    printInfo: () => {},
    printWarn: () => {},
    printTable: () => {},
  });
  seedCache(uiPromptPath, {
    promptCompat: async () => ({ label: '', token: 't', activateNow: false }),
  });
  seedCache(accountPoolPath, {
    init: async () => {},
    addAccount: addAccountImpl,
    useAccount: async () => {},
  });

  delete require.cache[poolPath];
  const mod = require(poolPath);
  return { handlePoolAdd: mod.handlePoolAdd, calls };
}

function restore() {
  for (const p of [formattersPath, uiPromptPath, accountPoolPath, poolPath]) {
    delete require.cache[p];
  }
}

_describe('pool add honest write receipt', () => {
  _test('null addAccount receipt does NOT print success — prints error + no-repeat hint', async () => {
    const { handlePoolAdd, calls } = loadHandler({ addAccountImpl: async () => null });
    try {
      await handlePoolAdd('qoder', 'sk-supersecret-token');
      _expect(calls.success.length).toBe(0);
      _expect(calls.error.length).toBe(1);
      _expect(calls.error[0]).toContain('未确认');
      _expect(calls.error[0]).toContain('khy pool list');
    } finally {
      restore();
    }
  });

  _test('truthy addAccount receipt DOES print success with token preview', async () => {
    const { handlePoolAdd, calls } = loadHandler({
      addAccountImpl: async () => ({ id: 7, tokenPreview: 'sk-***abc' }),
    });
    try {
      await handlePoolAdd('qoder', 'sk-supersecret-token');
      _expect(calls.success.length).toBe(1);
      _expect(calls.error.length).toBe(0);
      _expect(calls.success[0]).toContain('sk-***abc');
    } finally {
      restore();
    }
  });

  _test('thrown hard failure is reported as error, never success', async () => {
    const { handlePoolAdd, calls } = loadHandler({
      addAccountImpl: async () => {
        throw new Error('db down');
      },
    });
    try {
      await handlePoolAdd('qoder', 'sk-supersecret-token');
      _expect(calls.success.length).toBe(0);
      _expect(calls.error.length).toBe(1);
      _expect(calls.error[0]).toContain('db down');
    } finally {
      restore();
    }
  });
});
