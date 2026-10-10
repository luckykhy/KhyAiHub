'use strict';

/**
 * End-to-end WIRING test for the memory-notice delivery path ([DESIGN-MEM-008] V3/V5).
 * Uses node:test (run via `node --test`), never jest.
 *
 * Why this exists: the leaf tests prove the notice *text* is well-formed, and the
 * process-wiring test proves the two label tables recognise the phase. Neither proves
 * that the notice **reaches the two consumers through the real chain**:
 *
 *     memoryEngine.buildProactiveMemoryResult   (produce filenames + types)
 *       → formatRecallNoticePayload             (produce {kind, text})
 *         → noticeInbox.push / onStatus         (transport)
 *           → REPL: status.kind==='memory-notice' → printStepLine  (persistent line)
 *           → TUI : evt.kind==='memory-notice'    → role:'notice'  (persistent line)
 *
 * A wrong field name (`kind` → `type`) would leave BOTH consumers silent while every
 * other test stayed green. Hence: assert the transport carries `kind`, and assert each
 * consumer's guard is expressed against the **same** payload the transport produces.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const NOTICE_PATH = path.join(SRC, 'services', 'memoryOpsNotice.js');
const notice = require(NOTICE_PATH);

const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('transport: payload carries kind==="memory-notice" (BOTH consumers branch on evt.kind)', () => {
  const payload = notice.formatRecallNoticePayload(new Set(['reference_seed-alpha.md']), { types: ['reference'] });
  assert.ok(payload && typeof payload === 'object', 'payload must be an object');
  assert.strictEqual(payload.kind, 'memory-notice',
    'both REPL and TUI branch on evt.kind — a rename here silences both consumers');
  assert.strictEqual(typeof payload.text, 'string');
  assert.ok(payload.text.length > 0);
  assert.ok(payload.text.includes('reference_seed-alpha'), 'notice text should name the recalled file');
});

test('transport: payload keys are exactly {kind, text} (no silent shape drift)', () => {
  const payload = notice.formatRecallNoticePayload(new Set(['a.md']), { types: ['reference'] });
  assert.ok(payload);
  assert.deepStrictEqual(Object.keys(payload).sort(), ['kind', 'text']);
});

test('REPL consumer: branches on status.kind, not on a text prefix', () => {
  const src = readSrc(path.join('cli', 'replSession.js'));
  assert.ok(/status\.kind === 'memory-notice'/.test(src),
    'REPL must classify by the kind field (a prefix match would silently break on wording changes)');
  // 反模式护栏：不得出现按 emoji 前缀判据
  assert.ok(!/includes\(\s*'🧠'\s*\)/.test(src), 'REPL must not classify by the 🧠 text prefix');
});

test('TUI consumer: branches on evt.kind, falls through to role:"notice"', () => {
  const src = readSrc(path.join('cli', 'tui', 'hooks', 'useQueryBridge.js'));
  assert.ok(/evt\.kind === 'memory-notice'/.test(src), 'TUI must classify by the evt.kind field');
  assert.ok(/role:\s*'notice'/.test(src), 'TUI notice must land as a persistent transcript line');
});

test('both consumers agree on the SAME literal the producer emits', () => {
  // 这条是真正的「跨文件一致」断言：把三处串起来，任一处改了字面量就红。
  const produced = notice.formatRecallNoticePayload(new Set(['a.md']), { types: ['reference'] }).kind;
  const replSrc = readSrc(path.join('cli', 'replSession.js'));
  const tuiSrc = readSrc(path.join('cli', 'tui', 'hooks', 'useQueryBridge.js'));
  assert.ok(replSrc.includes(`'${produced}'`), `REPL must compare against '${produced}'`);
  assert.ok(tuiSrc.includes(`'${produced}'`), `TUI must compare against '${produced}'`);
});

test('gate off: producer returns null ⇒ both consumers stay silent', () => {
  const prev = process.env.KHY_MEMORY_NOTICE;
  process.env.KHY_MEMORY_NOTICE = '0';
  delete require.cache[NOTICE_PATH];
  try {
    const off = require(NOTICE_PATH);
    assert.strictEqual(off.formatRecallNoticePayload(new Set(['a.md']), { types: ['reference'] }), null,
      'gate off must yield null so no branch can fire (byte-revert)');
  } finally {
    delete require.cache[NOTICE_PATH];
    if (prev === undefined) delete process.env.KHY_MEMORY_NOTICE;
    else process.env.KHY_MEMORY_NOTICE = prev;
  }
});
