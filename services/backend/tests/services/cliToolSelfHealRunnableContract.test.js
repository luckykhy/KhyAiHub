'use strict';

/**
 * Contract: every `khy ...` command in cliToolSelfHeal's controlled remedy table must be
 * an actually executable form — registered verb, and every option it carries must be read
 * somewhere in src. The table is documented as "LLM 应当立即跑的修复命令", so a verb or
 * flag that no code consumes is a command the model will run and silently get nothing from.
 *
 * Round 17 found 4 of 10 non-null entries in that state (`khy ai --short-prompt "..."`,
 * `khy doctor --check python|node|git`).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC_ROOT = path.resolve(__dirname, '../../src');
const TABLE = path.join(SRC_ROOT, 'services/cliToolSelfHeal.js');

let _body = null;
function nonCommentSource() {
  if (_body === null) _body = buildBody();
  return _body;
}

function buildBody() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (/^(\/\/|\*|\/\*)/.test(t)) continue;
        out.push(line);
      }
    }
  })(SRC_ROOT);
  return out.join('\n');
}

function extractRunnables(src) {
  return [...src.matchAll(/\brunnable:\s*'([^']+)'/g)].map((m) => m[1]);
}

function violations(cmd, body) {
  const { parseInput } = require(path.join(SRC_ROOT, 'cli/router.js'));
  const schema = require(path.join(SRC_ROOT, 'constants/commandSchema.js'));
  const auto = require(path.join(SRC_ROOT, 'cli/commandAutoRegistry.js'));
  const surface = new Set([
    ...schema.getRouterCommandNames(),
    ...auto.getCommandNames(),
    ...Object.keys(auto.getAliases() || {}),
  ]);

  const argv = cmd.replace(/^khy\s+/, '').split(/\s+/);
  const parsed = parseInput(argv);
  const bad = [];
  if (!parsed || !surface.has(String(parsed.command).toLowerCase())) bad.push('verb:' + parsed.command);
  for (const key of Object.keys((parsed && parsed.options) || {})) {
    const camel = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    const readForms = [
      new RegExp("\\[\\s*['\"]" + key + "['\"]\\s*\\]"),
      new RegExp('\\b(?:options|opts|flags)\\.' + key + '\\b'),
      // raw argv token scanners; deliberately NOT a bare quoted '--key' pattern:
      // that also matches subprocess argv (`node --check`), which is not khy reading it.
      new RegExp("startsWith\\(\\s*['\"]--" + key + "['\"]"),
    ];
    const camelRead = new RegExp("\\b(?:options|opts|flags)\\." + camel + "\\b");
    if (!readForms.some((re) => re.test(body)) && !camelRead.test(body)) bad.push('unread-option:--' + key);
  }
  return bad;
}

test('NON-VACUITY: the remedy table really holds khy commands to validate', () => {
  const runnables = extractRunnables(fs.readFileSync(TABLE, 'utf8'));
  const khy = runnables.filter((r) => r.startsWith('khy '));
  assert.ok(khy.length >= 3, 'expected several khy runnables, got ' + khy.length + ' of ' + runnables.length);
});

test('every khy runnable in the table is an executable form', () => {
  const body = nonCommentSource();
  const offenders = [];
  for (const r of extractRunnables(fs.readFileSync(TABLE, 'utf8'))) {
    if (!r.startsWith('khy ')) continue;   // external commands (netstat …) are not this contract
    const v = violations(r, body);
    if (v.length) offenders.push(r + '  ->  ' + v.join(', '));
  }
  assert.deepEqual(offenders, [], 'phantom remedy commands:\n' + offenders.join('\n'));
});

test('negative control: the pre-fix strings do fail the same checks', () => {
  const body = nonCommentSource();
  for (const legacy of ['khy doctor --check python', 'khy ai --short-prompt "..."']) {
    assert.ok(violations(legacy, body).length > 0, 'validator too weak for ' + legacy);
  }
  // and a genuinely wired form must pass, so the control is not "everything fails"
  assert.deepEqual(violations('khy gateway status', body), []);
});
