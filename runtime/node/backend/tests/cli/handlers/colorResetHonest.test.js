'use strict';

/**
 * Round-36 contract: /color reset persistence honesty (handlers/color.js).
 *
 * Repro (.khy/feedback/hci-r36-color-reset/): the reset branch called
 * `_persist(sessionId, 'default')`, dropped its return value, and always
 * printed 「已将当前会话强调色重置为默认」 — while the set branch right below
 * already checked `_persist` and printed an error. Fake-success on a failed
 * write (same shape as r33's handleCacheClear).
 *
 * Pins:
 *  T1 persist→false   : 0 success lines, 1 error line (reset wording);
 *  T2 persist throws  : same honest failure (catch inside _persist feeds it);
 *  T3 persist→true    : success line AND process-level color actually cleared;
 *  T4 set-branch symmetry regression guard: valid color + persist→false still
 *     errors (the contract the reset branch was mirrored from).
 *
 * node --test only (require.cache seeding; pure leaf sessionColor stays real).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const R = (rel) => require.resolve(path.join(SRC, rel));

async function usingHandler(persistImpl, run) {
  const keys = [
    R('services/domain/session/session/sessionForestService.js'),
    R('services/sessionPersistence.js'),
    R('cli/formatters.js'),
    R('cli/handlers/color.js'),
  ];
  const prev = keys.map((p) => require.cache[p]);
  const out = { success: [], error: [], info: [] };
  try {
    const seed = (abs, exportsObj) => {
      const m = new Module(abs, null);
      m.filename = abs;
      m.loaded = true;
      m.exports = exportsObj;
      require.cache[abs] = m;
    };
    seed(keys[0], { getCurrentSessionId: () => 'sess-test' });
    seed(keys[1], { updateSessionMetadata: persistImpl });
    seed(keys[2], {
      printInfo: (m) => out.info.push(String(m)),
      printError: (m) => out.error.push(String(m)),
      printSuccess: (m) => out.success.push(String(m)),
    });
    delete require.cache[keys[3]];
    return await run(require(keys[3]), out);
  } finally {
    keys.forEach((p, i) => {
      if (prev[i]) require.cache[p] = prev[i];
      else delete require.cache[p];
    });
  }
}

test('T1 reset with persist→false → error, never a fake success', async () => {
  await usingHandler(() => false, async ({ handleColor }, out) => {
    const ret = await handleColor('default', []);
    assert.equal(ret, true, 'handler still takes over the slash command');
    assert.equal(out.success.length, 0, 'nothing was persisted — no success allowed');
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /重置会话颜色失败/);
    assert.match(out.error[0], /快照文件/, 'error must name the cause shape');
  });
});

test('T2 reset with persist throwing → same honest failure', async () => {
  await usingHandler(() => { throw new Error('disk gone'); }, async ({ handleColor }, out) => {
    await handleColor('default', []);
    assert.equal(out.success.length, 0);
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /重置会话颜色失败/);
  });
});

test('T3 reset with persist→true → success line and process color cleared', async () => {
  const colorState = require(path.join(SRC, 'cli/sessionColorState.js'));
  await usingHandler(() => true, async ({ handleColor }, out) => {
    colorState.setSessionColor('red');
    await handleColor('default', []);
    assert.equal(out.error.length, 0);
    assert.equal(out.success.length, 1);
    assert.equal(colorState.getSessionColor(), null, 'successful persist must still clear live state');
  });
});

test('T4 set-branch symmetry: valid color + persist→false errors (mirrored contract)', async () => {
  await usingHandler(() => false, async ({ handleColor }, out) => {
    await handleColor('magenta', []);
    assert.equal(out.success.length, 0);
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /写入会话颜色失败/);
  });
});
