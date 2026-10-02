'use strict';

/**
 * promptGuard.js contract tests — the pure restore-protection leaf: which live
 * prompt file a snapshot restore is allowed to touch, and the tolerant snapshot
 * prompt extractor.
 *
 * Only read-only fs.existsSync is exercised (never a write); existing paths come
 * from this very test file, missing paths from a name inside os.tmpdir().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  shouldSkipPromptFile,
  extractSnapshotPrompts,
  PROMPT_FILES,
} = require('./promptGuard');

// A path that is guaranteed to exist and is read-only for this suite.
const LIVE_EXISTS = __filename;
// A path that is guaranteed NOT to exist (never created by anything).
const LIVE_MISSING = path.join(os.tmpdir(), `cc-switch-absent-${process.pid}-${Date.now()}.md`);

test('PROMPT_FILES 是冻结的 app→文件名对照表，键与值逐一钉死', () => {
  assert.ok(Object.isFrozen(PROMPT_FILES));
  assert.deepEqual(PROMPT_FILES, {
    'claude-code': 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'GEMINI.md',
    opencode: 'SOUL.md',
    'command-code': 'AGENTS.md',
    ycode: 'YCODE.md',
  });
});

test('未知应用一律保守跳过（含 constants.APPS 在册但无 prompt 文件的应用）', () => {
  for (const app of ['deepseek', 'reasonix', 'zcode', 'openclaw', 'coze', 'trae', 'nope']) {
    const r = shouldSkipPromptFile({ app, snapshotPrompts: [{ enabled: true }], livePath: LIVE_EXISTS });
    assert.equal(r.skip, true, `${app} must be skipped`);
    assert.match(r.reason, new RegExp(`未知应用「${app}」`), `${app} reason names the app`);
  }
});

test('无参调用被当作未知应用：返回 skip + 字面 undefined 出现在文案里', () => {
  const r = shouldSkipPromptFile();
  assert.deepEqual(r, { skip: true, reason: '未知应用「undefined」的 prompt 文件不接管' });
});

test('快照无启用 prompt 且本地文件存在 → 完全不碰，reason 点名受保护的文件', () => {
  const r = shouldSkipPromptFile({ app: 'codex', snapshotPrompts: [], livePath: LIVE_EXISTS });
  assert.equal(r.skip, true);
  assert.match(r.reason, /没有任何已启用 prompt/);
  assert.match(r.reason, /AGENTS\.md/, 'reason carries the file name from PROMPT_FILES');
});

test('快照无启用 prompt 但本地文件本来不存在 → skip:false（无可保护之物）', () => {
  assert.deepEqual(shouldSkipPromptFile({ app: 'codex', snapshotPrompts: [], livePath: LIVE_MISSING }), {
    skip: false,
    reason: '',
  });
});

test('livePath 缺失/空串时不做存在性判定，直接放行（skip:false）', () => {
  for (const livePath of [undefined, null, '', 0, false]) {
    assert.deepEqual(
      shouldSkipPromptFile({ app: 'gemini', snapshotPrompts: [{ enabled: false }], livePath }),
      { skip: false, reason: '' },
      `livePath=${String(livePath)} skips the existsSync branch`
    );
  }
});

test('只要有一条启用 prompt 就照旧覆写，即使本地文件存在', () => {
  for (const prompts of [[{ name: 'a', enabled: true }], [{ name: 'b' }, { name: 'c', enabled: false }]]) {
    const r = shouldSkipPromptFile({ app: 'claude-code', snapshotPrompts: prompts, livePath: LIVE_EXISTS });
    assert.deepEqual(r, { skip: false, reason: '' });
  }
});

test('enabled 判定是 `!== false`：仅字面 false 算禁用，其余垃圾值都算启用', () => {
  for (const enabled of [undefined, null, 0, '', 'no', NaN, [], {}, () => false]) {
    const r = shouldSkipPromptFile({
      app: 'opencode',
      snapshotPrompts: [{ name: 'x', enabled }],
      livePath: LIVE_EXISTS,
    });
    assert.equal(r.skip, false, `enabled=${String(enabled)} still counts as enabled`);
  }
  // 对照：显式 false + 文件存在才是真保护。
  assert.equal(
    shouldSkipPromptFile({ app: 'opencode', snapshotPrompts: [{ enabled: false }], livePath: LIVE_EXISTS }).skip,
    true
  );
});

test('非对象清单项被忽略；空数组却因 typeof==="object" 被当作启用（实测钉死）', () => {
  // 全是非对象 → 无启用项 → 保护本地文件。
  for (const junk of [[null, undefined, 'str', 42, true], []]) {
    assert.equal(
      shouldSkipPromptFile({ app: 'ycode', snapshotPrompts: junk, livePath: LIVE_EXISTS }).skip,
      true,
      `junk=${JSON.stringify(junk)} yields no enabled prompt`
    );
  }
  // 数组元素本身是数组：[] 的 enabled 是 undefined → 判为启用 → 不保护。
  assert.equal(
    shouldSkipPromptFile({ app: 'ycode', snapshotPrompts: [[]], livePath: LIVE_EXISTS }).skip,
    false
  );
});

test('snapshotPrompts 非数组一律降级为空清单', () => {
  for (const bad of [undefined, null, 'prompts', 42, { a: 1 }, new Map()]) {
    assert.deepEqual(
      shouldSkipPromptFile({ app: 'codex', snapshotPrompts: bad, livePath: LIVE_EXISTS }),
      { skip: true, reason: '快照中应用「codex」没有任何已启用 prompt，保留本地手写 AGENTS.md' },
      `snapshotPrompts=${String(bad)} degrades to []`
    );
  }
});

test('shouldSkipPromptFile 不改写调用方的清单对象', () => {
  const prompts = [{ name: 'a', enabled: false }];
  const opts = { app: 'codex', snapshotPrompts: prompts, livePath: LIVE_EXISTS };
  shouldSkipPromptFile(opts);
  assert.deepEqual(prompts, [{ name: 'a', enabled: false }]);
  assert.deepEqual(opts, { app: 'codex', snapshotPrompts: prompts, livePath: LIVE_EXISTS });
});

test('extractSnapshotPrompts：非对象快照与无 prompts 字段都返回空数组', () => {
  for (const snap of [undefined, null, 'str', 42, [], {}, { prompt: [] }, { prompts: null }]) {
    assert.deepEqual(extractSnapshotPrompts(snap), [], `snapshot=${JSON.stringify(snap)}`);
  }
});

test('extractSnapshotPrompts：数组形状原样透传；对象形状归一化为 [{name,enabled}]', () => {
  const arr = [{ name: 'a', enabled: false }, 'junk'];
  assert.deepEqual(extractSnapshotPrompts({ prompts: arr }), arr);
  assert.deepEqual(
    extractSnapshotPrompts({ prompts: { a: false, b: true, c: null, d: undefined } }),
    [
      { name: 'a', enabled: false },
      { name: 'b', enabled: true },
      { name: 'c', enabled: true },
      { name: 'd', enabled: true },
    ]
  );
});

test('extractSnapshotPrompts：prompts 为字符串/数字等非对象时返回空数组而非抛错', () => {
  for (const p of ['abc', 7, true, () => 1]) {
    assert.deepEqual(extractSnapshotPrompts({ prompts: p }), []);
  }
});

test('KNOWN-DEFECT 数组分支返回调用方数组的同一引用，对象分支返回新数组（不对称）', () => {
  const snapshot = { prompts: [{ name: 'a' }] };
  const out = extractSnapshotPrompts(snapshot);
  // Measured: same reference — pushing into the result mutates the snapshot.
  assert.equal(out, snapshot.prompts, 'array branch is identity, not a copy');
  out.push({ name: 'injected' });
  assert.equal(snapshot.prompts.length, 2, 'caller object was mutated through the returned handle');

  const objSnapshot = { prompts: { a: true } };
  const copy = extractSnapshotPrompts(objSnapshot);
  copy.push({ name: 'injected' });
  assert.equal(Object.keys(objSnapshot.prompts).length, 1, 'object branch is a fresh array');
});

test('KNOWN-DEFECT codex 与 command-code 共用 AGENTS.md：单应用保护挡不住另一应用覆写', () => {
  assert.equal(PROMPT_FILES.codex, PROMPT_FILES['command-code']);
  const unique = new Set(Object.values(PROMPT_FILES));
  assert.equal(unique.size, Object.keys(PROMPT_FILES).length - 1, 'one filename collision, measured');
  // 后果实测：codex 快照为空时受保护，但 command-code 快照有启用项时判定为「可覆写」，
  // 二者指向的 livePath 若同为 AGENTS.md，保护形同虚设。
  const shared = LIVE_EXISTS;
  assert.equal(shouldSkipPromptFile({ app: 'codex', snapshotPrompts: [], livePath: shared }).skip, true);
  assert.equal(
    shouldSkipPromptFile({ app: 'command-code', snapshotPrompts: [{ enabled: true }], livePath: shared }).skip,
    false
  );
});
