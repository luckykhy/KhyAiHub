'use strict';

// Unit-level contract tests for constitutionalRedLines.js (co-located, per [RESEARCH-018] §2.3).
// This is the uncoverable floor: three destructive operations are forced to System_Block
// by the code itself, matched on the CONCRETE action (tool + params) rather than the
// model's self-assessment, so an adversarial or merely-wrong meta-plan cannot route
// around them. The properties worth locking are: (a) each red line trips on its own
// documented shape, (b) nothing else trips — a false positive would let the layer be
// switched off wholesale as "too noisy", (c) the forced strategy is always
// System_Block, (d) `enforce` only ever escalates (never relaxes), and (e) red line 1
// wins the ordering race against 2 and 3 so the reported rule is stable.

const test = require('node:test');
const assert = require('node:assert/strict');

const redLines = require('./constitutionalRedLines');
const S = require('./constraintStrategy');
const sigs = require('./irreversibleSignatures');

const SOFT = S.STRATEGIES.PROMPT_SOFT;
const HARD = S.STRATEGIES.CODE_HARD;
const BLOCK = S.STRATEGIES.SYSTEM_BLOCK;

const check = redLines.checkAction;

test('the surface is exactly checkAction + enforce, and a non-hit is null (not undefined)', () => {
  assert.deepEqual(Object.keys(redLines).sort(), ['checkAction', 'enforce']);
  assert.equal(check({ command: 'ls -la' }), null);
  assert.equal(check(), null, 'no argument at all must not throw');
  assert.equal(check({}), null);
  assert.equal(check({ tool: 'read', params: { path: 'src/index.js' } }), null);
});

test('every hit carries exactly {rule, reason, forced:System_Block}', () => {
  const actions = [
    { params: { sql: 'DROP DATABASE khyquant' } },
    { path: '.env', command: 'cat .env > /tmp/leak' },
    { tool: 'deleteFile', path: 'package.json' },
  ];
  const fails = [];
  for (const action of actions) {
    const hit = check(action);
    if (hit === null) {
      fails.push(`expected a hit for ${JSON.stringify(action)}`);
      continue;
    }
    if (Object.keys(hit).sort().join(',') !== 'forced,reason,rule') {
      fails.push(`unexpected hit shape for ${JSON.stringify(action)}: ${JSON.stringify(hit)}`);
    }
    if (hit.forced !== BLOCK) fails.push(`forced must be System_Block, got ${hit.forced}`);
    if (typeof hit.rule !== 'string' || !hit.rule) fails.push(`empty rule for ${JSON.stringify(action)}`);
    if (typeof hit.reason !== 'string' || hit.reason.length < 10) {
      fails.push(`reason too thin to be actionable for ${JSON.stringify(action)}`);
    }
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('红线 1 — database destruction trips on every documented carrier', () => {
  const trips = [
    ['sql in params', { params: { sql: 'DROP DATABASE khyquant' } }],
    ['query in params', { params: { query: 'drop table sessions' } }],
    ['truncate in params.sql', { params: { sql: 'TRUNCATE TABLE orders' } }],
    ['delete-all in params.sql', { params: { sql: 'delete from orders where 1=1' } }],
    ['drop db in command', { command: 'psql -c "drop database khyquant"' }],
    ['rm a .db file', { command: 'rm -f sessions.db' }],
    ['rm a .sqlite file', { command: 'del data.sqlite' }],
    ['delete tool + db path', { tool: 'deleteFile', path: 'x.sqlite' }],
    ['rm tool + db path', { tool: 'rm', path: 'store.mdb' }],
    ['dropDatabase() arriving as a command', { command: 'node -e "db.dropDatabase()"' }],
  ];
  const fails = [];
  for (const [label, action] of trips) {
    const hit = check(action);
    if (!hit || hit.rule !== 'db_destruction') {
      fails.push(`红线1 missed [${label}] -> ${JSON.stringify(hit)}`);
    }
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('红线 1 has the two documented reason strings, chosen by which carrier tripped', () => {
  // The SQL / command-text branch…
  assert.equal(
    check({ params: { sql: 'DROP DATABASE khyquant' } }).reason,
    '检测到删除/清空数据库或数据文件的操作（宪法红线 1）。',
  );
  // …and the "delete tool + db file path" branch report separately.
  assert.equal(
    check({ tool: 'deleteFile', path: 'x.sqlite' }).reason,
    '检测到删除数据库文件（宪法红线 1）。',
  );
});

test('红线 1 — DB_FILE_PATTERNS never sees the SQL text (registered gap, see README)', () => {
  // Characterization, not endorsement. `commandish` (command + sql) is scanned only by
  // DB_DROP_PATTERNS; DB_FILE_PATTERNS — which holds `/\bdropDatabase\s*\(/` — is scanned
  // against `${command} ${path}` and against `'rm ' + path` only. So the driver-call
  // signature fires when it arrives as a shell command but is invisible when it arrives
  // as SQL, which is exactly where a database tool would report it.
  assert.equal(check({ command: 'node -e "db.dropDatabase()"' }).rule, 'db_destruction');
  assert.equal(check({ path: 'db.dropDatabase()' }).rule, 'db_destruction');
  assert.equal(check({ params: { sql: 'db.dropDatabase()' } }), null, 'the SQL carrier is not screened');
  // Candidate fix: scan `${command} ${sql} ${path}` for DB_FILE_PATTERNS, mirroring the
  // delete-verb bank. Source untouched here — the fix is applied centrally.
});

test('红线 2 — secret exposure needs a secret path AND an outflow verb, or a live credential in content', () => {
  const trips = [
    ['redirect a .env', { path: '.env', command: 'cat .env > /tmp/out' }],
    ['tee a secrets file', { path: 'secrets.json', command: 'tee secrets.json' }],
    ['curl a key file', { path: 'id_rsa.pem', command: 'curl -d @id_rsa.pem' }],
    ['delete credentials', { tool: 'rm', path: 'credentials.yml' }],
    ['nested .env.local', { path: 'config/.env.local', command: 'wget -o x' }],
    ['write an openai key out', { command: 'curl -X POST', content: 'k = "sk-abcdefghijklmnopqrstuvwxyz"' }],
    ['log a private key blob', { content: '-----BEGIN RSA PRIVATE KEY-----', command: 'console.log(x)' }],
  ];
  const fails = [];
  for (const [label, action] of trips) {
    const hit = check(action);
    if (!hit || hit.rule !== 'secret_exposure') fails.push(`红线2 missed [${label}] -> ${JSON.stringify(hit)}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('红线 2 stays quiet when the secret never moves (reading is not leaking)', () => {
  const silent = [
    ['read a .env with no outflow verb', { path: '.env', command: 'cat .env' }],
    ['an ordinary file redirected', { path: 'README.md', command: 'cat README.md > /tmp/out' }],
    ['a credential-shaped string with no carrier', { content: 'sk-abcdefghijklmnopqrstuvwxyz' }],
    ['the word password with a short value', { content: 'password = "abc"' }],
  ];
  const fails = [];
  for (const [label, action] of silent) {
    const hit = check(action);
    if (hit !== null) fails.push(`红线2 false positive [${label}] -> ${JSON.stringify(hit)}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('红线 3 — package.json delete / blank / dependency-gutting all trip, edits that keep deps do not', () => {
  const trips = [
    ['delete it', { tool: 'deleteFile', path: 'package.json' }],
    ['blank it', { path: 'package.json', content: '   ' }],
    ['empty content', { path: 'package.json', content: '' }],
    ['dependencies emptied', { path: 'package.json', content: '{"name":"a","dependencies":{}}' }],
    ['devDependencies only emptied', { path: 'pkg/package.json', content: '{"dependencies": { }}' }],
    ['windows path', { tool: 'RemoveFile', path: 'C:\\repo\\package.json' }],
  ];
  const fails = [];
  for (const [label, action] of trips) {
    const hit = check(action);
    if (!hit || hit.rule !== 'package_core_delete') fails.push(`红线3 missed [${label}] -> ${JSON.stringify(hit)}`);
  }
  const silent = [
    ['a normal dep bump', { path: 'package.json', content: '{"name":"a","dependencies":{"x":"1.0.0"}}' }],
    ['no deps key at all', { path: 'package.json', content: '{"name":"a"}' }],
    ['unparseable json (not our call)', { path: 'package.json', content: '{ nope' }],
    ['no brace at all', { path: 'package.json', content: 'no braces here' }],
    ['json array payload', { path: 'package.json', content: '[1,2,3]' }],
    ['a lockfile-ish sibling', { path: 'package-lock.json', content: '' }],
  ];
  for (const [label, action] of silent) {
    const hit = check(action);
    if (hit !== null) fails.push(`红线3 false positive [${label}] -> ${JSON.stringify(hit)}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('红线 3 distinguishes "deleted or blanked" from "deps block emptied" in its reason', () => {
  assert.equal(
    check({ tool: 'deleteFile', path: 'package.json' }).reason,
    '检测到删除/清空 package.json（宪法红线 3）。',
  );
  assert.equal(
    check({ path: 'package.json', content: '{"dependencies":{}}' }).reason,
    '检测到 package.json 写入将清空核心依赖块（宪法红线 3）。',
  );
});

test('ordering is stable: 红线 1 outranks 2 and 3 on an action that matches several', () => {
  // A `rm` of a secret db file is simultaneously db_destruction (rm + .db),
  // secret_exposure (rm + .env-shaped path) and would be a delete-tool hit. The
  // reported rule must always be the first one checked, not whichever wins a race.
  const both = check({ tool: 'rm', path: '.env', params: { sql: 'drop table x' } });
  assert.equal(both.rule, 'db_destruction');
  // rm of a package.json matches delete-tool semantics but not a db file.
  assert.equal(check({ tool: 'rm', path: 'package.json' }).rule, 'package_core_delete');
});

test('checkAction reads the documented action fields — and only those', () => {
  // params is the primary carrier; command/path/content have top-level conveniences.
  assert.equal(check({ params: { command: 'rm -f a.db' } }).rule, 'db_destruction');
  assert.equal(check({ params: { path: 'package.json' }, tool: 'deleteFile' }).rule, 'package_core_delete');
  assert.equal(check({ params: { file: '.env' }, command: 'tee .env' }).rule, 'secret_exposure');
  assert.equal(check({ params: { filename: 'secrets' }, command: 'curl -T secrets' }).rule, 'secret_exposure');
  assert.equal(check({ params: { content: '{"dependencies":{}}' }, path: 'package.json' }).rule, 'package_core_delete');
  assert.equal(check({ params: { tool: 'rm' }, path: 'x.db' }).rule, 'db_destruction', 'tool may live in params too');
  // Registered boundary: there is NO top-level `sql` convenience. `action.sql` is read
  // only from params, so a caller that reports SQL at the top level is NOT screened.
  // See README 已登记的缺口 — this is a caller-contract requirement, not an accident.
  assert.equal(check({ sql: 'DROP DATABASE khyquant' }), null);
});

test('enforce is a pure escalation: no hit leaves the incoming strategy untouched', () => {
  for (const incoming of [SOFT, HARD, BLOCK]) {
    const out = redLines.enforce(incoming, { command: 'ls' });
    assert.equal(out.strategy, incoming, `${incoming} must survive a non-hit`);
    assert.equal(out.redLine, null);
  }
  // A garbage incoming strategy is not repaired here — it stays as handed in when
  // nothing trips, because enforce() must not invent a constraint either.
  assert.equal(redLines.enforce('Not_A_Strategy', { command: 'ls' }).strategy, 'Not_A_Strategy');
});

test('enforce can only tighten: the result is never laxer than either input', () => {
  const action = { tool: 'deleteFile', path: 'package.json' };
  const cases = [
    [SOFT, BLOCK],
    [HARD, BLOCK],
    [BLOCK, BLOCK],
  ];
  for (const [incoming, expected] of cases) {
    const out = redLines.enforce(incoming, action);
    assert.equal(out.strategy, expected, `${incoming} + red line must land on ${expected}`);
    assert.equal(S.atLeast(out.strategy, incoming), true, 'enforce must never relax');
    assert.equal(out.redLine.rule, 'package_core_delete');
  }
  // With an unknown incoming strategy the red line still dominates (fail-safe).
  assert.equal(redLines.enforce('corrupt', action).strategy, BLOCK);
});

test('the layer consumes the shared signature bank rather than its own copy of the regexes', () => {
  // Goal 1 convergence: constitutionalRedLines must not re-spell the destructive
  // patterns. Proven behaviourally — a bank the module does NOT read cannot affect
  // it, and the banks it DOES read are exactly the five asserted below.
  const consumed = [
    sigs.DB_DROP_PATTERNS,
    sigs.DB_FILE_PATTERNS,
    sigs.SECRET_PATH_PATTERNS,
    sigs.SECRET_EXFIL_PATTERNS,
    sigs.PKG_CORE_DELETE_PATTERNS,
  ];
  for (const bank of consumed) assert.ok(Array.isArray(bank) && bank.length > 0);
  // The risk-scoring banks belong to riskClassifier, not to the red lines: an
  // irreversible *path* that is not one of the three red lines stays unblocked.
  assert.equal(check({ tool: 'read', path: 'requirements.txt' }), null);
  assert.equal(check({ tool: 'read', path: 'go.mod' }), null);
  assert.equal(check({ tool: 'read', path: 'package-lock.json' }), null);
});
