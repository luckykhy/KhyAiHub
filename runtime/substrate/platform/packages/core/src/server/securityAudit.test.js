'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSecurityAudit } = require('./securityAudit');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-security-audit-'));
  const filePath = path.join(dir, 'audit.jsonl');
  const instances = [];
  t.after(() => {
    try {
      for (const instance of instances) instance.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    dir,
    filePath,
    open(options = {}) {
      const instance = createSecurityAudit({ filePath, now: () => 1234, ...options });
      instances.push(instance);
      return instance;
    },
  };
}

function input(extra = {}) {
  return {
    subject: 'operator', action: 'read', object: 'secret', decision: 'deny',
    reason: 'missing ticket', ticket_id: null, ...extra,
  };
}

function rehash(record) {
  const { hash, ...body } = record;
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

test('append fsynced JSONL and resume the sequence and hash chain after reopen', (t) => {
  const f = fixture(t);
  const first = f.open();
  const entry = first.append(input());
  assert.equal(entry.seq, 1);
  assert.equal(entry.time, 1234);
  assert.equal(entry.prev_hash, null);
  assert.equal(entry.hash, rehash(entry).hash);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), `${JSON.stringify(entry)}\n`);
  first.close();
  first.close();
  assert.equal(fs.existsSync(`${f.filePath}.lock`), false);
  assert.throws(() => first.append(input()), /已关闭/);
  const second = f.open();
  assert.deepEqual(second.query(), [entry]);
  const next = second.append(input({ ticket_id: 'ticket-1' }));
  assert.equal(next.seq, 2);
  assert.equal(next.time, 1234);
  assert.equal(next.prev_hash, entry.hash);
  assert.deepEqual(second.query().map((record) => record.seq), [2, 1]);
});

test('same-millisecond duplicates are preserved; queries filter in reverse sequence order', (t) => {
  const audit = fixture(t).open();
  const event = input({ terminal_id: 'terminal-1', task_id: 'task-1' });
  audit.append(event);
  audit.append(event);
  audit.append(input({ terminal_id: 'terminal-2', task_id: 'task-1' }));
  audit.append(input({ terminal_id: 'terminal-1', task_id: 'task-2' }));
  assert.deepEqual(audit.query().map((record) => record.seq), [4, 3, 2, 1]);
  assert.ok(audit.query().every((record) => record.time === 1234));
  assert.deepEqual(audit.query({ terminal_id: 'terminal-1', task_id: 'task-1', limit: 1 }).map((r) => r.seq), [2]);
  assert.deepEqual(audit.query({ task_id: 'task-1' }).map((r) => r.seq), [3, 2, 1]);
  assert.deepEqual(audit.query({ limit: 0 }), []);
  assert.deepEqual(audit.query({ terminal_id: 'absent' }), []);
});

test('input, append return values, and query results cannot mutate stored records', (t) => {
  const f = fixture(t);
  const audit = f.open();
  const event = input({ details: { items: [{ value: 'original' }] } });
  const returned = audit.append(event);
  event.details.items[0].value = 'input mutation';
  returned.details.items[0].value = 'return mutation';
  returned.hash = 'forged';
  const result = audit.query();
  result[0].details.items.push('query mutation');
  result[0].seq = 999;
  result.pop();
  assert.deepEqual(audit.query()[0].details, { items: [{ value: 'original' }] });
  audit.close();
  assert.equal(f.open().query()[0].seq, 1);
});

test('invalid paths and clocks do not create directories or locks', (t) => {
  const f = fixture(t);
  for (const filePath of [undefined, null, '', 'relative.jsonl', 42]) {
    assert.throws(() => createSecurityAudit({ filePath }), /绝对路径/);
  }
  assert.throws(() => f.open({ now: 1 }), /now/);
  assert.throws(() => f.open({ filePath: path.join(f.dir, 'missing', 'audit.jsonl') }), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

const cycle = {};
cycle.self = cycle;
const invalidInputs = [
  undefined, null, [], 'record', {},
  ...['subject', 'action', 'object', 'decision', 'reason'].map((key) => input({ [key]: ' ' })),
  input({ ticket_id: undefined }), input({ ticket_id: 3 }), input({ time: null }),
  input({ time: NaN }), input({ time: -1 }), input({ time: 1.5 }),
  input({ time: 42 }),
  ...['seq', 'hash', 'prev_hash'].map((key) => input({ [key]: 'forged' })),
  input({ extra: undefined }), input({ extra: Infinity }), input({ extra: 1n }),
  input({ extra: () => {} }), input({ extra: Symbol('bad') }), input({ extra: cycle }),
  input({ extra: new Date() }), input({ extra: Array(2) }),
  input({ extra: { get value() { throw new Error('getter must not run'); } } }),
  input({ extra: { [Symbol('hidden')]: 1 } }), input({ terminal_id: 1 }),
];

for (const [index, value] of invalidInputs.entries()) {
  test(`invalid input ${index + 1} is rejected without writing and poisons the instance`, (t) => {
    const f = fixture(t);
    const audit = f.open();
    assert.throws(() => audit.append(value), TypeError);
    assert.equal(audit.poisoned, true);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), '');
    assert.throws(() => audit.append(input()), /poisoned/);
  });
}

test('invalid now result poisons append; invalid query options do not poison', (t) => {
  const audit = fixture(t).open({ now: () => NaN });
  for (const limit of [-1, 0.5, Infinity, '1', null]) {
    assert.throws(() => audit.query({ limit }), TypeError);
  }
  assert.throws(() => audit.query({ task_id: 3 }), TypeError);
  assert.equal(audit.poisoned, false);
  assert.throws(() => audit.append(input()), /time/);
  assert.equal(audit.poisoned, true);
});

for (const change of ['truncate', 'overwrite', 'replace']) {
  for (const operation of ['append', 'query']) {
    test(`runtime ${change} is rejected by ${operation} without changing evidence`, (t) => {
      const f = fixture(t);
      const audit = f.open();
      audit.append(input());
      const original = fs.readFileSync(f.filePath, 'utf8');
      if (change === 'truncate') fs.truncateSync(f.filePath, 0);
      if (change === 'overwrite') fs.writeFileSync(f.filePath, original.replace('missing ticket', 'changed ticket'));
      if (change === 'replace') {
        fs.renameSync(f.filePath, `${f.filePath}.old`);
        fs.writeFileSync(f.filePath, original);
      }
      const evidence = fs.readFileSync(f.filePath);
      assert.throws(() => operation === 'append' ? audit.append(input()) : audit.query());
      assert.equal(audit.poisoned, true);
      assert.deepEqual(fs.readFileSync(f.filePath), evidence);
    });
  }
}

const corruptions = {
  'changed contents': (rows) => { rows[0].reason = 'changed'; },
  'broken previous hash': (rows) => { rows[1] = rehash({ ...rows[1], prev_hash: '0'.repeat(64) }); },
  'sequence gap': (rows) => { rows[1] = rehash({ ...rows[1], seq: 3 }); },
  'invalid required field with valid hash': (rows) => { rows[1] = rehash({ ...rows[1], subject: '' }); },
  'duplicate row': (rows) => { rows.push(rows[1]); },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`open refuses ${name}, preserves bytes, and releases only its initialization lock`, (t) => {
    const f = fixture(t);
    const audit = f.open();
    const rows = [audit.append(input()), audit.append(input())];
    audit.close();
    corrupt(rows);
    const content = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    fs.writeFileSync(f.filePath, content);
    assert.throws(() => f.open());
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), content);
    assert.equal(fs.existsSync(`${f.filePath}.lock`), false);
    assert.throws(() => f.open());
  });
}

for (const suffix of ['', '\n', '{broken\n', '{"partial":', '\ufffd\n']) {
  test(`open rejects incomplete, blank, malformed or invalid tail ${JSON.stringify(suffix)}`, (t) => {
    const f = fixture(t);
    const audit = f.open();
    const row = audit.append(input());
    audit.close();
    const content = JSON.stringify(row) + (suffix === '' ? '' : `\n${suffix}`);
    fs.writeFileSync(f.filePath, content);
    assert.throws(() => f.open());
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), content);
    assert.equal(fs.existsSync(`${f.filePath}.lock`), false);
  });
}

test('exclusive lock rejects a second instance without disturbing the first', (t) => {
  const f = fixture(t);
  const first = f.open();
  const identity = fs.statSync(`${f.filePath}.lock`).ino;
  assert.throws(() => f.open(), { code: 'EEXIST' });
  assert.equal(fs.statSync(`${f.filePath}.lock`).ino, identity);
  assert.equal(first.append(input()).seq, 1);
  first.close();
  assert.equal(f.open().append(input()).seq, 2);
});

test('a pre-existing stale lock is never removed', (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.filePath}.lock`, 'crashed owner');
  assert.throws(() => f.open(), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(`${f.filePath}.lock`, 'utf8'), 'crashed owner');
  assert.equal(fs.existsSync(f.filePath), false);
});

test('initialization open failure releases the newly created lock', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.filePath);
  assert.throws(() => f.open());
  assert.equal(fs.existsSync(`${f.filePath}.lock`), false);
});

test('partial writes are completed before fsync and append returns', (t) => {
  const f = fixture(t);
  const audit = f.open();
  const originalWrite = fs.writeSync;
  const originalSync = fs.fsyncSync;
  let writes = 0;
  let synced = false;
  try {
    fs.writeSync = (fd, buffer, offset, length) => {
      writes++;
      return originalWrite(fd, buffer, offset, Math.min(length, 7));
    };
    fs.fsyncSync = (fd) => { originalSync(fd); synced = true; };
    audit.append(input());
    assert.equal(synced, true);
    assert.ok(writes > 1);
  } finally {
    fs.writeSync = originalWrite;
    fs.fsyncSync = originalSync;
  }
  audit.close();
  assert.equal(f.open().query().length, 1);
});

for (const failure of ['write', 'zero write', 'partial then throw', 'fsync']) {
  test(`${failure} failure is thrown, poisons the instance, and never truncates the file`, (t) => {
    const f = fixture(t);
    const audit = f.open();
    audit.append(input());
    const before = fs.readFileSync(f.filePath);
    const originalWrite = fs.writeSync;
    const originalSync = fs.fsyncSync;
    const error = new Error(`injected ${failure}`);
    let wrote = false;
    try {
      if (failure === 'fsync') fs.fsyncSync = () => { throw error; };
      else fs.writeSync = (fd, buffer, offset, length) => {
        if (failure === 'zero write') return 0;
        if (failure === 'partial then throw' && !wrote) {
          wrote = true;
          return originalWrite(fd, buffer, offset, Math.min(length, 10));
        }
        throw error;
      };
      assert.throws(() => audit.append(input()), failure === 'zero write' ? /写入未推进/ : (e) => e === error);
    } finally {
      fs.writeSync = originalWrite;
      fs.fsyncSync = originalSync;
    }
    assert.equal(audit.poisoned, true);
    const after = fs.readFileSync(f.filePath);
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.throws(() => audit.append(input()), /poisoned/);
    assert.throws(() => audit.query(), /poisoned/);
    assert.deepEqual(fs.readFileSync(f.filePath), after);
    assert.throws(() => f.open(), { code: 'EEXIST' });
    audit.close();
    if (failure === 'partial then throw') assert.throws(() => f.open(), /尾行不完整/);
    else assert.equal(f.open().query().length, failure === 'fsync' ? 2 : 1);
  });
}
