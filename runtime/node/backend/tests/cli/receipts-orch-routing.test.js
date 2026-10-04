'use strict';

/**
 * Regression for `khy receipts orch` answering with the receipt *list*.
 *
 * The handler dispatched on `cmd === 'orch'`, but the command manifest omitted
 * `subCommands`, so parseInput left the typed token in args[0] and
 * commandAutoRegistry._alignSubCommand had nothing to reconcile it against.
 * Result: a branch that exists in the source was unreachable dead code, and the
 * user silently got a different view than the one they asked for.
 *
 * Two layers are pinned:
 *  1. behavioural — 'orch' / 'orchestration' render the orchestration view,
 *     with 'list' as the positive control that the list view still works.
 *  2. structural drift guard — every verb the handler compares against
 *     `subCommand` must be declared in the manifest. This is what keeps the
 *     whole family closed, not just the one verb that was reported.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '../..');
const HANDLER = path.join(BE, 'src/cli/handlers/receipts.js');
const SERVICE = require.resolve(path.join(BE, 'src/services/receiptService.js'));

function installServiceStub() {
  require.cache[SERVICE] = {
    id: SERVICE,
    filename: SERVICE,
    loaded: true,
    exports: {
      listReceipts: () => [],
      listOrchestrationReceipts: () => [],
      getReceipt: () => null,
      searchReceipts: () => [],
    },
  };
}

installServiceStub();
const { handleReceipts, ...rest } = require(HANDLER);
const { MANIFEST_EXPORT_KEY } = require(path.join(BE, 'src/cli/commandManifest'));
const manifest = rest[MANIFEST_EXPORT_KEY];

// node:test runs one file per child process and reports that process's exit
// status, so a handler that legitimately marks failure (process.exitCode = 1)
// would fail the whole file even with every assertion passing. capture() keeps
// the marking observable through `lastExitCode` but restores it afterwards.
let lastExitCode;

async function capture(sub, args = []) {
  const chunks = [];
  const outs = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = (target) => (c) => {
    target.push(String(c));
    return true;
  };
  process.stdout.write = sink(chunks);
  process.stderr.write = sink(outs);
  const savedExitCode = process.exitCode;
  try {
    await handleReceipts(sub, args, {});
    lastExitCode = process.exitCode;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = savedExitCode;
  }
  return chunks.concat(outs).join('').replace(/\u001B\[[0-9;]*m/g, '');
}

test('orch renders the orchestration view, not the receipt list', async () => {
  const out = await capture('orch');
  assert.ok(out.includes('编排回执'), `orch branch not reached: ${out}`);
  assert.ok(!out.includes('执行回执'), `orch still answered with the list view: ${out}`);
});

test('orchestration (long form) renders the same view', async () => {
  const out = await capture('orchestration');
  assert.ok(out.includes('编排回执'), `orchestration branch not reached: ${out}`);
});

test('positive control — list still renders the receipt list', async () => {
  const out = await capture('list');
  assert.ok(out.includes('执行回执'), `list branch not reached: ${out}`);
  assert.ok(!out.includes('编排回执'), `list leaked into the orchestration view: ${out}`);
});

test('drift guard: every verb compared against subCommand is declared in the manifest', () => {
  assert.ok(manifest, 'fixture broken — manifest export not found');
  const declared = manifest.subCommands || [];
  const src = fs.readFileSync(HANDLER, 'utf8');
  const compared = new Set();
  for (const m of src.matchAll(/\bcmd\s*===\s*'([a-z][\w-]*)'/g)) compared.add(m[1]);
  for (const m of src.matchAll(/'([a-z][\w-]*)'\s*===\s*\bcmd\b/g)) compared.add(m[1]);
  // 'help' is the reserved exemption token of the whole 回捞门 family (r216/r219/r220:
  // `<cmd> help` prints the usage wall with rc=0), not a dispatched verb — exempt.
  compared.delete('help');
  for (const verb of compared) {
    assert.ok(declared.includes(verb), `"${verb}" is dispatched but missing from manifest.subCommands`);
  }
  assert.ok(compared.has('orch'), 'fixture guard: expected the handler to dispatch "orch"');
});

test('empty orchestration table states who fills it', async () => {
  const out = await capture('orch');
  assert.ok(/子智能体|Agent 委派/.test(out), `empty orch has no remedy: ${out}`);
  assert.ok(!out.includes('✗'), `empty state rendered as a failure: ${out}`);
});

// Second defect, same verb slot: an unmatched token used to be discarded, so
// `khy receipts lst` answered with the receipt list and exit 0 — the user could
// not tell a typo from a query.
test('an unknown verb is rejected instead of rendering the list', async () => {
  const out = await capture(null, ['lst']);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out}`);
  assert.ok(!out.includes('执行回执'), `typo still rendered the list view: ${out}`);
  assert.strictEqual(lastExitCode, 1, 'a usage error must also fail the shell, not just print red');
});

test('positive control — a bare command still defaults to the list view', async () => {
  const out = await capture(null, []);
  assert.ok(out.includes('执行回执'), `bare "receipts" lost its default view: ${out}`);
  assert.ok(!out.includes('未知子命令'), `bare "receipts" reported an unknown verb: ${out}`);
  assert.ok(!lastExitCode, `bare "receipts" marked the process failed: ${lastExitCode}`);
});

test('the unknown-verb hint advertises every declared verb', async () => {
  const out = await capture(null, ['zzz-not-a-verb']);
  for (const verb of manifest.subCommands || []) {
    assert.ok(out.includes(verb), `hint omits declared verb "${verb}": ${out}`);
  }
  assert.ok(out.includes('zzz-not-a-verb'), 'hint does not echo what the user typed');
});
