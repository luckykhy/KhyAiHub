'use strict';

// Unit-level contract tests for irreversibleSignatures.js (co-located, per [RESEARCH-018] §2.3).
// This module is the 单一真源 pattern bank that Goal 1 converged: the same "delete / drop /
// leak-a-key / gut-a-manifest" regexes used to be written out twice (once in
// metaConstraint/riskClassifier.js to score risk, once here-adjacent in
// constitutionalRedLines.js to trip a red line) and the two copies drifted. The tests
// therefore lock (a) the bank membership and ordering, (b) which strings each bank is
// supposed to catch and — just as important — what it must NOT catch, and (c) the two
// coercion helpers every consumer depends on. If a pattern here changes meaning, BOTH
// consumers change meaning at once, which is the point of the convergence.

const test = require('node:test');
const assert = require('node:assert/strict');

const I = require('./irreversibleSignatures');

test('the delete-tool vocabulary is exactly the union of the two historical definitions', () => {
  assert.equal(I.DELETE_TOOL_NAMES instanceof Set, true);
  assert.deepEqual([...I.DELETE_TOOL_NAMES].sort(), [
    'delete_file',
    'deletefile',
    'remove_file',
    'removefile',
    'rm',
    'rmdir',
    'unlink',
  ]);
});

test('isDeleteTool normalizes case and whitespace, and is prototype-safe', () => {
  for (const name of ['deletefile', 'DELETE_FILE', ' RemoveFile ', 'rm', 'UNLINK', 'rmdir']) {
    assert.equal(I.isDeleteTool(name), true, `${name} must read as a delete tool`);
  }
  // Non-delete verbs must stay non-delete or every write would look destructive.
  for (const name of ['read', 'write', 'edit', 'bash', '', 'del', null, undefined]) {
    assert.equal(I.isDeleteTool(name), false, `${String(name)} must not read as a delete tool`);
  }
  // Set.has() is not a prototype-chain lookup, so Object.prototype keys are rejected.
  assert.equal(I.isDeleteTool('constructor'), false);
  assert.equal(I.isDeleteTool('toString'), false);
});

test('isDeleteCommand matches delete verbs on word boundaries only', () => {
  assert.equal(I.isDeleteCommand('rm -rf ./cache'), true);
  assert.equal(I.isDeleteCommand('del x.txt'), true);
  assert.equal(I.isDeleteCommand('sudo unlink /mnt/a'), true);
  assert.equal(I.isDeleteCommand('rmdir build'), true);
  assert.equal(I.isDeleteCommand('RM BUILD'), true, 'the pattern is case-insensitive');
  // `\b` discipline: a word that merely CONTAINS the verb is not a delete.
  assert.equal(I.isDeleteCommand('warm up the cache'), false);
  assert.equal(I.isDeleteCommand('confirm the order'), false);
  assert.equal(I.isDeleteCommand('delete rows from the ui list'), false, 'delete is not in the verb list');
  assert.equal(I.isDeleteCommand(null), false);
  assert.equal(I.isDeleteCommand(''), false);
});

test('DELETE_CMD_RE is the same verb list isDeleteCommand uses', () => {
  assert.equal(I.DELETE_CMD_RE.source, '\\b(rm|del|unlink|rmdir)\\b');
  assert.equal(I.DELETE_CMD_RE.flags, 'i');
  const fails = [];
  for (const t of ['rm x', 'del x', 'unlink x', 'rmdir x']) {
    if (!I.DELETE_CMD_RE.test(t)) fails.push(`verb bank misses: ${t}`);
  }
  for (const t of ['warm', 'confirmation', 'delicious', 'rmfilt']) {
    if (I.DELETE_CMD_RE.test(t)) fails.push(`verb bank over-matches: ${t}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('the seven banks carry the documented number of patterns', () => {
  // Membership counts are a ratchet: dropping one silently removes a red line for
  // both consumers, so the shape is asserted before the semantics.
  assert.equal(I.DB_DROP_PATTERNS.length, 4);
  assert.equal(I.DB_FILE_PATTERNS.length, 2);
  assert.equal(I.SECRET_PATH_PATTERNS.length, 4);
  assert.equal(I.SECRET_EXFIL_PATTERNS.length, 4);
  assert.equal(I.PKG_CORE_DELETE_PATTERNS.length, 1);
  assert.equal(I.IRREVERSIBLE_CMD_PATTERNS.length, 9);
  assert.equal(I.IRREVERSIBLE_PATH_PATTERNS.length, 6);
  for (const bank of [
    I.DB_DROP_PATTERNS,
    I.DB_FILE_PATTERNS,
    I.SECRET_PATH_PATTERNS,
    I.SECRET_EXFIL_PATTERNS,
    I.PKG_CORE_DELETE_PATTERNS,
    I.IRREVERSIBLE_CMD_PATTERNS,
    I.IRREVERSIBLE_PATH_PATTERNS,
  ]) {
    for (const re of bank) {
      assert.ok(re instanceof RegExp, 'banks must hold RegExp, not strings');
    }
  }
});

test('DB_DROP_PATTERNS covers the four documented SQL destruction shapes', () => {
  const hits = [
    'DROP DATABASE khyquant',
    'drop table sessions',
    'TRUNCATE TABLE orders',
    'delete from orders where 1=1',
  ];
  const misses = ['select * from orders', 'drop the ball', 'delete from orders where id=7'];
  const fails = [];
  for (const s of hits) if (!I._any(I.DB_DROP_PATTERNS, s)) fails.push(`missed: ${s}`);
  for (const s of misses) if (I._any(I.DB_DROP_PATTERNS, s)) fails.push(`false positive: ${s}`);
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('DB_FILE_PATTERNS needs BOTH a delete verb and a database extension', () => {
  const fails = [];
  for (const s of ['rm -f sessions.db', 'del data.sqlite', 'unlink x.mdb', 'rmdir y.frm', 'rm z.ibd']) {
    if (!I._any(I.DB_FILE_PATTERNS, s)) fails.push(`missed: ${s}`);
  }
  // No verb → a plain read of a db file must not be flagged as destruction.
  for (const s of ['cat sessions.db', 'sessions.db', 'dropDatabase']) {
    if (I._any(I.DB_FILE_PATTERNS, s)) fails.push(`false positive: ${s}`);
  }
  // The driver-API form needs the call parentheses.
  assert.equal(I._any(I.DB_FILE_PATTERNS, 'db.dropDatabase()'), true);
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('SECRET_PATH_PATTERNS anchors on path segments, not substrings', () => {
  const fails = [];
  for (const s of [
    '.env',
    '.env.production',
    'config/.env.local',
    'C:\\proj\\.env',
    'secrets.json',
    'credentials.yml',
    'tls/server.pem',
    'id_rsa',
    'keys/client.key',
  ]) {
    if (!I._any(I.SECRET_PATH_PATTERNS, s)) fails.push(`missed: ${s}`);
  }
  // A `.env` that is not a path segment (mid-word) must not match — otherwise every
  // file named e.g. "the.enviro.txt" would trip red line 2.
  for (const s of ['senvironment', 'mysecret-notes.txt', 'readme.md', '']) {
    if (I._any(I.SECRET_PATH_PATTERNS, s)) fails.push(`false positive: ${s}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('SECRET_EXFIL_PATTERNS recognize live credential shapes', () => {
  const fails = [];
  for (const s of [
    'AKIAABCDEFGHIJKLMNOP',
    'ASIAABCDEFGHIJKLMNOP',
    'sk-abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN RSA PRIVATE KEY-----',
    'password = "hunter2hunter2"',
    'api_key: "abcdef123456"',
  ]) {
    if (!I._any(I.SECRET_EXFIL_PATTERNS, s)) fails.push(`missed: ${s}`);
  }
  for (const s of [
    'sk-short', // too few characters after the prefix
    'AKIA123', // too few characters after the prefix
    'password = "abc"', // value under 6 chars
    'the token bucket algorithm', // the word alone is not a credential
    '-----BEGIN CERTIFICATE-----',
    '',
  ]) {
    if (I._any(I.SECRET_EXFIL_PATTERNS, s)) fails.push(`false positive: ${s}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('PKG_CORE_DELETE_PATTERNS matches package.json as a filename, anywhere, not a substring', () => {
  const fails = [];
  for (const s of ['package.json', 'apps/cli/package.json', 'C:\\repo\\package.json']) {
    if (!I._any(I.PKG_CORE_DELETE_PATTERNS, s)) fails.push(`missed: ${s}`);
  }
  for (const s of ['package.json.bak', 'package.jsonld', 'packaging', 'packages/mylib/index.js', '']) {
    if (I._any(I.PKG_CORE_DELETE_PATTERNS, s)) fails.push(`false positive: ${s}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('the risk-score banks catch the irreversible command/path surface riskClassifier needs', () => {
  const cmdFails = [];
  for (const s of [
    'rm -rf /var/lib/data',
    'DROP TABLE users',
    'truncate table logs',
    'git push --force origin main',
    'git push -f',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    'shred secrets.bin',
    'wipefs -a /dev/sda',
    'npm uninstall lodash',
    'yarn remove left-pad',
    'pnpm remove left-pad',
  ]) {
    if (!I._any(I.IRREVERSIBLE_CMD_PATTERNS, s)) cmdFails.push(`missed: ${s}`);
  }
  for (const s of ['npm install lodash', 'git push origin main', 'ls -la', 'echo hi']) {
    if (I._any(I.IRREVERSIBLE_CMD_PATTERNS, s)) cmdFails.push(`false positive: ${s}`);
  }
  assert.deepEqual(cmdFails, [], cmdFails.join('\n'));

  const pathFails = [];
  for (const s of [
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.toml',
    'Cargo.lock',
    'go.mod',
    'go.sum',
    'requirements.txt',
    'pyproject.toml',
    'Pipfile',
    'Pipfile.lock',
    '.env',
    'secrets',
    'server.pem',
  ]) {
    if (!I._any(I.IRREVERSIBLE_PATH_PATTERNS, s)) pathFails.push(`missed: ${s}`);
  }
  for (const s of ['src/index.js', 'docs/README.md', 'package.json.md']) {
    if (I._any(I.IRREVERSIBLE_PATH_PATTERNS, s)) pathFails.push(`false positive: ${s}`);
  }
  assert.deepEqual(pathFails, [], pathFails.join('\n'));
});

test('_str coerces the shapes callers actually hand it', () => {
  assert.equal(I._str(null), '');
  assert.equal(I._str(undefined), '');
  assert.equal(I._str('rm x'), 'rm x', 'strings pass through untouched');
  assert.equal(I._str(''), '');
  assert.equal(I._str(5), '5');
  assert.equal(I._str(true), 'true');
  assert.equal(I._str(['rm', 'x']), '["rm","x"]');
  assert.equal(I._str({ command: 'rm x' }), '{"command":"rm x"}');
  const circular = {};
  circular.self = circular;
  // JSON.stringify throws on the cycle; the catch falls back to String().
  assert.equal(I._str(circular), '[object Object]');
});

test('known gap (see README 已登记的缺口): _str returns undefined for a function value', () => {
  // Characterization, not endorsement. `JSON.stringify(function(){})` is `undefined`
  // (it does not throw), so the catch arm never runs and _str hands back a non-string
  // from a function named "to string". Downstream `_any` then tests the literal text
  // "undefined", which no bank matches — so today it mis-types without mis-tripping.
  // Candidate fix: `return typeof x === 'string' ? x : String(x)` after the JSON attempt,
  // or reject non-plain values up front.
  assert.equal(I._str(function noop() {}), undefined);
  const arrow = () => 1;
  assert.equal(I._str(arrow), undefined);
  assert.equal(I._any(I.DB_DROP_PATTERNS, I._str(arrow)), false, 'no bank matches the text "undefined"');
});

test('_any is a plain some() over the bank and never throws on odd input', () => {
  assert.equal(I._any([], 'anything'), false, 'an empty bank cannot match');
  assert.equal(I._any([/a/], 'abc'), true);
  assert.equal(I._any([/z/], 'abc'), false);
  // Regexes with the /g flag would carry lastIndex state; none of the banks do.
  const stateful = I.IRREVERSIBLE_CMD_PATTERNS.concat(
    I.IRREVERSIBLE_PATH_PATTERNS,
    I.DB_DROP_PATTERNS,
    I.DB_FILE_PATTERNS,
    I.SECRET_PATH_PATTERNS,
    I.SECRET_EXFIL_PATTERNS,
    I.PKG_CORE_DELETE_PATTERNS,
  ).filter((re) => re.global);
  assert.deepEqual(stateful, [], 'a /g pattern would make _any return alternating results');
  // And a repeated call must be stable (that is what the /g check above protects).
  const text = 'git push --force origin main';
  assert.equal(I._any(I.IRREVERSIBLE_CMD_PATTERNS, text), true);
  assert.equal(I._any(I.IRREVERSIBLE_CMD_PATTERNS, text), true);
});

test('the module surface is the nine banks plus four helpers', () => {
  assert.deepEqual(Object.keys(I).sort(), [
    'DB_DROP_PATTERNS',
    'DB_FILE_PATTERNS',
    'DELETE_CMD_RE',
    'DELETE_TOOL_NAMES',
    'IRREVERSIBLE_CMD_PATTERNS',
    'IRREVERSIBLE_PATH_PATTERNS',
    'PKG_CORE_DELETE_PATTERNS',
    'SECRET_EXFIL_PATTERNS',
    'SECRET_PATH_PATTERNS',
    '_any',
    '_str',
    'isDeleteCommand',
    'isDeleteTool',
  ]);
});
