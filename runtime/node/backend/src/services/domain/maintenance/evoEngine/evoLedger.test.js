'use strict';

/**
 * evoLedger.test.js — co-located suite for the append-only evolution evidence log.
 *
 * WRITE CHANNEL: this module is one of the two files in this unit that touches the disk.
 * Every data home (KHY_DATA_HOME / KHY_PROJECT_DATA_HOME / HOME / XDG_CONFIG_HOME) is pinned
 * into a fresh fs.mkdtempSync directory BEFORE the module is required, so no ledger byte can
 * land inside the repository. Each test writes under its own branch name, so the suites do
 * not order-depend on one another.
 *
 * Defect assertions (B31-E7 / B31-E8 / B31-E9 in khy.module.json) pin CURRENT behaviour —
 * documentation, not approval.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-ledger-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('./evoLedger');
const {
  LEDGER_VERSION,
  GENESIS_PREV,
  KIND,
  append,
  read,
  verify,
  _hashEntry,
  _file,
} = ledger;

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('evoLedger — surface and containment', () => {
  test('module.exports keys are exactly the seven documented names', () => {
    assert.deepEqual(Object.keys(ledger).sort(), [
      'GENESIS_PREV',
      'KIND',
      'LEDGER_VERSION',
      '_file',
      '_hashEntry',
      'append',
      'read',
      'verify',
    ]);
  });

  test('KIND covers the seven lifecycle stages and is frozen', () => {
    assert.equal(Object.isFrozen(KIND), true);
    assert.deepEqual(Object.keys(KIND).sort(), [
      'ALERT',
      'CODE',
      'FUSE',
      'HOTLOAD',
      'REQUIREMENT',
      'ROLLBACK',
      'SANDBOX',
    ]);
    assert.equal(KIND.REQUIREMENT, 'requirement');
    assert.equal(KIND.HOTLOAD, 'hotload');
  });

  test('LEDGER_VERSION is 1 and the genesis prev hash is 64 zeros', () => {
    assert.equal(LEDGER_VERSION, 1);
    assert.equal(GENESIS_PREV, '0'.repeat(64));
  });

  test('CONTAINMENT: every ledger path resolves inside the pinned temp home, never the repo', () => {
    const f = _file('containment');
    assert.equal(path.resolve(f).startsWith(path.resolve(TMP)), true, `escaped: ${f}`);
    assert.equal(f.includes(`${path.sep}khy-os${path.sep}`), false, 'must not sit under the repo root');
    assert.match(path.basename(f), /^ledger\.containment\.json$/);
  });

  test('there is no update/delete API — append is the only writer', () => {
    assert.equal(ledger.update, undefined);
    assert.equal(ledger.delete, undefined);
    assert.equal(ledger.remove, undefined);
    assert.equal(ledger.truncate, undefined);
  });
});

describe('evoLedger — append / read / verify happy path', () => {
  test('first append roots at genesis and returns ok with seq 0', () => {
    const r = append(KIND.REQUIREMENT, { want: 'a parser' }, { branch: 'happy1' });
    assert.equal(r.ok, true, r.error || '');
    assert.equal(r.seq, 0);
    assert.match(r.hash, /^[0-9a-f]{64}$/);
    const chain = read({ branch: 'happy1' });
    assert.equal(chain.length, 1);
    assert.equal(chain[0].prevHash, GENESIS_PREV);
    assert.equal(chain[0].kind, 'requirement');
    assert.equal(chain[0].version, LEDGER_VERSION);
    assert.equal(chain[0].payload.want, 'a parser');
    assert.equal(typeof chain[0].at, 'number');
  });

  test('second append links to the previous hash and seq advances', () => {
    append(KIND.REQUIREMENT, { n: 1 }, { branch: 'happy2' });
    const b = append(KIND.SANDBOX, { passed: true }, { branch: 'happy2' });
    assert.equal(b.seq, 1);
    const chain = read({ branch: 'happy2' });
    assert.equal(chain[1].prevHash, chain[0].hash);
    assert.equal(verify({ branch: 'happy2' }).ok, true);
    assert.equal(verify({ branch: 'happy2' }).length, 2);
    assert.equal(verify({ branch: 'happy2' }).brokenAt, null);
  });

  test('branch defaults to "main" for all three entry points', () => {
    append(KIND.ALERT, { a: 1 });
    assert.equal(read().length >= 1, true);
    assert.equal(_file(), _file('main'));
    assert.equal(_file(null), _file('main'));
    assert.equal(verify({ branch: 'main' }).ok, true);
  });

  test('null / undefined payload is normalized to null and still hashes', () => {
    const r = append(KIND.CODE, null, { branch: 'nullish' });
    assert.equal(r.ok, true);
    assert.equal(read({ branch: 'nullish' })[0].payload, null);
  });

  test('an unknown kind is stringified rather than rejected', () => {
    const r = append('made-up-kind', { x: 1 }, { branch: 'kindstr' });
    assert.equal(r.ok, true);
    assert.equal(read({ branch: 'kindstr' })[0].kind, 'made-up-kind');
    assert.equal(verify({ branch: 'kindstr' }).ok, true);
  });

  test('read() returns a copy from disk, not a shared live array', () => {
    append(KIND.REQUIREMENT, { v: 1 }, { branch: 'copycheck' });
    const a = read({ branch: 'copycheck' });
    a[0].payload.v = 99;
    a.push({ fake: true });
    assert.equal(read({ branch: 'copycheck' }).length, 1);
    assert.equal(read({ branch: 'copycheck' })[0].payload.v, 1);
  });

  test('_hashEntry is a pure function of seq/kind/prevHash/payload/at', () => {
    const entry = { seq: 0, kind: 'requirement', prevHash: GENESIS_PREV, payload: { a: 1 }, at: 5 };
    assert.equal(_hashEntry(entry), _hashEntry({ ...entry }));
    assert.notEqual(_hashEntry(entry), _hashEntry({ ...entry, at: 6 }));
    assert.notEqual(_hashEntry(entry), _hashEntry({ ...entry, payload: { a: 2 } }));
    // DEFECT B31-E10 (current behaviour): `version` is outside the hash basis, so a record can
    // be relabeled to any LEDGER_VERSION without breaking verify().
    assert.equal(_hashEntry(entry), _hashEntry({ ...entry, version: 999 }));
    const branch = 'version-labeled';
    append(KIND.REQUIREMENT, { a: 1 }, { branch });
    const chain = JSON.parse(fs.readFileSync(_file(branch), 'utf-8'));
    chain[0].version = 42;
    fs.writeFileSync(_file(branch), JSON.stringify(chain));
    assert.equal(verify({ branch }).ok, true, 'the ledger schema version is not covered by the chain');
  });

  test('a non-serializable payload makes append fail soft, never throw', () => {
    const circular = {};
    circular.self = circular;
    const r = append(KIND.ALERT, circular, { branch: 'circular' });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.equal(read({ branch: 'circular' }).length, 0);
  });
});

describe('evoLedger — tamper detection (防呆⑤ as advertised)', () => {
  test('mid-chain payload edit is caught at the exact record', () => {
    const branch = 'tamper1';
    append(KIND.REQUIREMENT, { a: 1 }, { branch });
    append(KIND.CODE, { b: 2 }, { branch });
    append(KIND.SANDBOX, { c: 3 }, { branch });
    const chain = JSON.parse(fs.readFileSync(_file(branch), 'utf-8'));
    chain[1].payload = { b: 'forged' };
    fs.writeFileSync(_file(branch), JSON.stringify(chain));
    const v = verify({ branch });
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
    assert.match(v.reason, /内容哈希不匹配/);
  });

  test('seq renumbering is caught as a seq break', () => {
    const branch = 'tamper2';
    append(KIND.REQUIREMENT, { a: 1 }, { branch });
    append(KIND.CODE, { b: 2 }, { branch });
    const chain = JSON.parse(fs.readFileSync(_file(branch), 'utf-8'));
    chain[1].seq = 7;
    fs.writeFileSync(_file(branch), JSON.stringify(chain));
    const v = verify({ branch });
    assert.equal(v.ok, false);
    assert.match(v.reason, /seq 不连续/);
    assert.equal(v.brokenAt, 1);
  });

  test('prevHash splice is caught before the content hash check', () => {
    const branch = 'tamper3';
    append(KIND.REQUIREMENT, { a: 1 }, { branch });
    append(KIND.CODE, { b: 2 }, { branch });
    const chain = JSON.parse(fs.readFileSync(_file(branch), 'utf-8'));
    chain[1].prevHash = '1'.repeat(64);
    fs.writeFileSync(_file(branch), JSON.stringify(chain));
    const v = verify({ branch });
    assert.equal(v.ok, false);
    assert.match(v.reason, /prevHash 断链/);
  });

  test('an empty ledger verifies ok with length 0 (the baseline B31-E7 builds on)', () => {
    const v = verify({ branch: 'never-written' });
    assert.deepEqual(v, { ok: true, length: 0, brokenAt: null, reason: null });
  });

  test('a non-array JSON document is read as an empty chain', () => {
    const branch = 'notarray';
    fs.mkdirSync(path.dirname(_file(branch)), { recursive: true });
    fs.writeFileSync(_file(branch), JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(read({ branch }), []);
    assert.equal(verify({ branch }).ok, true);
  });
});

describe('evoLedger — DEFECTS B31-E7 / B31-E8', () => {
  test('DEFECT B31-E7 (current behaviour): an unparseable ledger file is read as EMPTY, so the '
    + 'next append silently restarts the chain at genesis and the lost evidence verifies ok', () => {
      const branch = 'corrupt';
      append(KIND.REQUIREMENT, { keep: 'evidence-1' }, { branch });
      append(KIND.CODE, { keep: 'evidence-2' }, { branch });
      assert.equal(read({ branch }).length, 2);
      // Any damage that is not valid JSON — a half-written file, a truncate, an editor slip.
      fs.writeFileSync(_file(branch), '{ this is not json');
      const beforeVerify = verify({ branch });
      assert.equal(beforeVerify.ok, true, 'the header promises 篡改即被 verify 抓出; here it reports a clean empty chain');
      assert.equal(beforeVerify.length, 0);
      const r = append(KIND.SANDBOX, { after: 'wipe' }, { branch });
      assert.equal(r.ok, true, 'append succeeds');
      assert.equal(r.seq, 0, 'and silently numbers the new record as the FIRST one');
      const after = read({ branch });
      assert.equal(after.length, 1);
      assert.equal(after[0].payload.keep, undefined, 'both previous records are gone');
      assert.equal(verify({ branch }).ok, true, 'and the surviving chain is self-consistent');
    });

  test('DEFECT B31-E8 (current behaviour): dropping the tail of the chain is undetectable — a '
    + 'valid prefix plus fresh appends verifies ok, so 防呆⑤ covers edits but not deletions', () => {
      const branch = 'trunc';
      append(KIND.REQUIREMENT, { n: 1 }, { branch });
      append(KIND.REQUIREMENT, { n: 2 }, { branch });
      append(KIND.REQUIREMENT, { n: 3 }, { branch });
      const chain = JSON.parse(fs.readFileSync(_file(branch), 'utf-8'));
      fs.writeFileSync(_file(branch), JSON.stringify(chain.slice(0, 1)));
      append(KIND.REQUIREMENT, { n: 'new-after-loss' }, { branch });
      const v = verify({ branch });
      assert.equal(v.ok, true);
      assert.equal(v.length, 2, 'record #2 and #3 vanished with no trace in the file');
      assert.equal(read({ branch }).map((e) => e.payload.n).join(','), '1,new-after-loss');
    });

  test('write failure is converted to {ok:false} with an error (append never throws)', () => {
    const branch = 'blocked';
    fs.mkdirSync(path.dirname(_file(branch)), { recursive: true });
    fs.mkdirSync(_file(branch), { recursive: true }); // a DIRECTORY squatting the ledger path
    const r = append(KIND.ALERT, { x: 1 }, { branch });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.match(r.error, /原子写失败|EBUSY|EPERM|EISDIR/);
    assert.equal(verify({ branch }).ok, true, 'and a failed write still reads as a clean chain');
  });
});

describe('evoLedger — branch addressing', () => {
  test('DEFECT B31-E9 (current behaviour): the branch name is slugified into the file name, so '
    + 'two distinct branches share ONE immutable chain', () => {
      assert.equal(_file('a/b'), _file('a_b'), 'the file name cannot distinguish these two branches');
      append(KIND.REQUIREMENT, { from: 'a/b' }, { branch: 'a/b' });
      append(KIND.REQUIREMENT, { from: 'a_b' }, { branch: 'a_b' });
      const shared = read({ branch: 'a/b' });
      assert.equal(shared.length, 2, 'the second branch appended into the first branch chain');
      assert.equal(read({ branch: 'a_b' }).length, 2);
      assert.equal(verify({ branch: 'a_b' }).ok, true, 'and the merged chain still verifies');
    });

  test('an empty branch name falls back to the "main" file', () => {
    assert.equal(_file(''), _file('main'));
    assert.equal(_file(undefined), _file('main'));
  });

  test('a branch with only unsafe characters still produces a writable file name', () => {
    const f = _file('///');
    assert.match(path.basename(f), /^ledger\..+\.json$/);
    const r = append(KIND.ALERT, { ok: 1 }, { branch: '///' });
    assert.equal(r.ok, true, r.error || '');
  });

  test('the on-disk shape is one pretty-printed JSON array (tmp+fsync+rename primitive)', () => {
    const branch = 'shape';
    append(KIND.REQUIREMENT, { z: 1 }, { branch });
    const text = fs.readFileSync(_file(branch), 'utf-8');
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2), 'pretty-2, no trailing newline');
    assert.equal(fs.existsSync(`${_file(branch)}.tmp`), false, 'the atomic temp file is cleaned up');
  });

  test('append is a read-modify-write over the whole chain (quadratic growth, no lock)', () => {
    const branch = 'growth';
    for (let i = 0; i < 5; i += 1) {
      assert.equal(append(KIND.REQUIREMENT, { i }, { branch }).ok, true);
    }
    const chain = read({ branch });
    assert.equal(chain.length, 5);
    assert.equal(chain[4].seq, 4);
    assert.equal(chain[4].prevHash, chain[3].hash);
    // Structural note only (registered, not asserted as a failure): every append rewrites the
    // whole file, and two processes appending to the same branch can clobber each other
    // because there is no lock — see contract.registered_defects B31-E11.
  });
});
