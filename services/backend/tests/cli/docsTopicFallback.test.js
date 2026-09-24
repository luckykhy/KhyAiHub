'use strict';

// Regression for `khy docs <topic>`: the else-branch fallback conflated
// "no topic given" with "unknown topic given", so a typo (`khy docs protocl`)
// printed the quick-start page byte-identical to bare `khy docs` — the user read
// the wrong document with no signal that it was the wrong one.

const { test } = require('node:test');
const assert = require('node:assert');

// node:test reports the child process's exit status for the whole file, so the
// handler legitimately marking a usage error (process.exitCode = 1) would fail
// every case in here. runDocs() exposes the marking and restores the old value.
let lastExitCode;

async function runDocs(parsedArgs) {
  const reg = require('../../src/cli/commandAutoRegistry');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  const savedExitCode = process.exitCode;
  try {
    const r = await reg.dispatch('docs', {
      parsed: { command: 'docs', subCommand: null, args: parsedArgs, options: {} },
    });
    lastExitCode = process.exitCode;
    return { handled: !!(r && r.handled), out: lines.join('\n') };
  } finally {
    console.log = orig;
    process.exitCode = savedExitCode;
  }
}

test('unknown docs topic reports itself instead of silently showing the quickstart', async () => {
  for (const token of ['protocl', 'backup', 'quickstar']) {
    const { handled, out } = await runDocs([token]);
    assert.ok(handled, 'docs disappeared from the auto registry');
    assert.ok(out.includes(`未知文档主题: ${token}`), `khy docs ${token} produced no report:\n${out}`);
    assert.ok(!out.includes('快速开始'),
      `khy docs ${token} still fell back to the quickstart page:\n${out}`);
    // The remedy lines must name real, reachable commands.
    assert.ok(out.includes('khy docs search') && out.includes('可用主题'),
      `unknown-topic report lost its hints:\n${out}`);
    assert.strictEqual(lastExitCode, 1, `khy docs ${token} printed a usage error but exited 0`);
  }
});

test('bare khy docs keeps showing the quickstart', async () => {
  const { out } = await runDocs([]);
  assert.ok(out.includes('快速开始'), `bare khy docs lost its default page:\n${out}`);
  assert.ok(!out.includes('未知文档主题'), `bare khy docs now complains about a missing topic:\n${out}`);
  assert.ok(!lastExitCode, `bare "docs" marked the process failed: ${lastExitCode}`);
});

test('declared topics still reach their own pages', async () => {
  const faq = await runDocs(['faq']);
  assert.ok(faq.out.includes('常见问题'), `khy docs faq no longer renders the FAQ:\n${faq.out}`);
  assert.ok(!faq.out.includes('未知文档主题'), 'khy docs faq was rejected as an unknown topic');
  assert.ok(!lastExitCode, `khy docs faq marked the process failed: ${lastExitCode}`);

  const guide = await runDocs(['start']);
  assert.ok(guide.out.includes('快速开始'), 'the `start` alias no longer resolves');
});
