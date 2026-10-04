'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hotCopySqlite, restoreSqliteInPlace, _sqlPath, _pragmaValue } = require('./sqliteHotCopy.js');

const BACKSLASH = String.fromCharCode(92);
const VACUUM_RE = /^VACUUM INTO '(.*)'$/;

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45e-'));
});
after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpJoin(...segs) {
  return path.join(tmpRoot, ...segs);
}

/** The tmp name the module builds, as it appears *inside* the emitted SQL (POSIX form). */
function sqlTmpOf(dst) {
  return _sqlPath(`${dst}.tmp-${process.pid}`);
}

/** Parse the file name out of the emitted `VACUUM INTO '…'` statement. */
function vacuumTarget(sql) {
  const m = VACUUM_RE.exec(String(sql));
  return m ? m[1].replace(/''/g, "'") : null;
}

/**
 * Driver double for `config/sqlite-adapter`'s DatabaseAdapter surface
 * (constructor(filename, {readonly}), pragma(str) -> rows, exec(sql), close(),
 * get inTransaction). No real SQLite handle is ever opened by these tests.
 */
function makeDriver(behaviour = {}) {
  const calls = { opened: [], exec: [], pragma: [], closed: 0 };
  class FakeDatabase {
    constructor(file, options) {
      calls.opened.push({ file, options });
      if (behaviour.onOpen) behaviour.onOpen({ file, options, calls });
      this._file = file;
      this._options = options || {};
      this._live = true;
      if ('inTransaction' in behaviour) this.inTransaction = behaviour.inTransaction;
    }

    pragma(text) {
      calls.pragma.push(text);
      if (behaviour.onPragma) return behaviour.onPragma(text, this._file, this._options);
      return [];
    }

    exec(sql) {
      calls.exec.push(sql);
      if (behaviour.onExec) return behaviour.onExec(sql, this, calls);
      return this;
    }

    close() {
      if (this._live) {
        this._live = false;
        calls.closed += 1;
      }
      if (behaviour.onClose) behaviour.onClose(this._file);
    }
  }
  return { FakeDatabase, calls };
}

/** The honest happy-path driver: VACUUM INTO writes a fresh 256-byte file. */
function workingDriver(targetBytes = 256) {
  return makeDriver({
    onPragma: (text) => (text === 'journal_mode'
      ? [{ journal_mode: 'wal' }]
      : [{ integrity_check: 'ok' }]),
    onExec: (sql) => {
      const target = vacuumTarget(sql);
      if (!target) throw new Error(`not a VACUUM INTO statement: ${sql}`);
      if (fs.existsSync(target)) throw new Error('SQL error: target file already exists');
      fs.writeFileSync(target, Buffer.alloc(targetBytes, 7));
      return undefined;
    },
  });
}

describe('_sqlPath：SQL 字面量里的路径', () => {
  test('两种平台的分隔符都折成正斜杠，单引号成对翻倍', () => {
    assert.equal(_sqlPath(`C:${BACKSLASH}khy${BACKSLASH}data${BACKSLASH}x.db`), 'C:/khy/data/x.db');
    assert.equal(_sqlPath('C:/khy/data/x.db'), 'C:/khy/data/x.db');
    assert.equal(_sqlPath(`C:${BACKSLASH}my''db${BACKSLASH}x.db`), "C:/my''''db/x.db");
    assert.equal(_sqlPath("O'Brien/x.db"), "O''Brien/x.db");
    assert.equal(_sqlPath(`a${BACKSLASH}b${BACKSLASH}c`).includes(BACKSLASH), false);
  });

  test('非字符串入参按 String 归一，不抛', () => {
    assert.equal(_sqlPath(0), '0');
    assert.equal(_sqlPath(null), 'null');
    assert.equal(_sqlPath(undefined), 'undefined');
    assert.equal(_sqlPath(Symbol('s')), 'Symbol(s)');
    assert.equal(_sqlPath({ toString: () => 'a/b.db' }), 'a/b.db');
    assert.equal(_sqlPath([]), '');
    assert.equal(_sqlPath(''), '');
  });
});

describe('_pragmaValue：pragma 行形状归一', () => {
  test('数组首行取指定列，非数组对象直接取列，字符串行原样返回', () => {
    assert.equal(_pragmaValue([{ journal_mode: 'wal' }], 'journal_mode'), 'wal');
    assert.equal(_pragmaValue({ journal_mode: 'delete' }, 'journal_mode'), 'delete');
    assert.equal(_pragmaValue('ok', 'integrity_check'), 'ok');
    assert.equal(_pragmaValue([{ journal_mode: 1 }], 'journal_mode'), '1');
    assert.equal(_pragmaValue([{ journal_mode: 'WAL' }], 'journal_mode'), 'WAL');
  });

  test('空数组 / nullish / 原始值 / 无该列的行一律回落 unknown', () => {
    for (const rows of [[], null, undefined, 0, NaN, false, {}, [null], [7], [[]]]) {
      assert.equal(_pragmaValue(rows, 'journal_mode'), 'unknown', JSON.stringify(rows));
    }
    // A string row is passed through verbatim by the second branch, including the empty
    // string — so a driver that answers `""` reports journalMode '', not 'unknown'.
    assert.equal(_pragmaValue('', 'journal_mode'), '');
    assert.equal(_pragmaValue('ok', 'journal_mode'), 'ok');
  });

  test('列值 toString 抛错时被吞掉，返回 unknown 而不是抛穿', () => {
    assert.equal(_pragmaValue([{ journal_mode: { toString() { throw new Error('boom'); } } }], 'journal_mode'), 'unknown');
  });

  test('KNOWN-DEFECT: null 列值被字符串成 "null"，且 key in row 会读继承列', () => {
    // sqliteHotCopy.js:49-51 guards with `key in row`, which walks the prototype chain, and
    // then String()s the value. A driver that answers `[{ journal_mode: null }]` (which
    // node:sqlite does for a pragma on a locked/closed handle) therefore reports the literal
    // string 'null' — and hotCopySqlite writes that straight into the manifest's journalMode,
    // where a reader cannot tell it apart from a real journal name.
    assert.equal(_pragmaValue([{ journal_mode: null }], 'journal_mode'), 'null');
    assert.equal(_pragmaValue([{ journal_mode: undefined }], 'journal_mode'), 'undefined');
    assert.equal(_pragmaValue(Object.create({ journal_mode: 'wal' }), 'journal_mode'), 'wal');
    assert.match(_pragmaValue({}, 'constructor'), /^function/);
  });
});

describe('hotCopySqlite：VACUUM INTO 热备（驱动注入，全部落在系统临时目录）', () => {
  function seededSource(name = 'src.db', bytes = 120) {
    const file = tmpJoin(name);
    fs.writeFileSync(file, Buffer.alloc(bytes, 3));
    return file;
  }

  test('成功热备：目标生成、字节数如实回报、临时残骸清空、语句用 POSIX 分隔符', () => {
    const src = seededSource();
    const dst = tmpJoin('out', 'nested', 'copy.db');
    const { FakeDatabase, calls } = workingDriver(256);
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.error, null);
    assert.equal(r.bytes, 256);
    assert.equal(r.journalMode, 'wal');
    assert.equal(r.integrity, 'ok');
    assert.equal(typeof r.durationMs, 'number');
    assert.equal(fs.existsSync(dst), true);
    assert.equal(fs.statSync(dst).size, 256);
    assert.equal(calls.exec.length, 1);
    assert.match(calls.exec[0], /^VACUUM INTO '/);
    assert.equal(calls.exec[0].includes(BACKSLASH), false);
    assert.equal(vacuumTarget(calls.exec[0]), sqlTmpOf(dst));
    assert.equal(fs.existsSync(`${dst}.tmp-${process.pid}`), false);
    assert.deepEqual(calls.pragma, ['journal_mode', 'integrity_check']);
    assert.equal(calls.closed, 2);
  });

  test('KNOWN-DEFECT: 源库以 readonly:false 打开，取备份这件事本身会写权威源', () => {
    // sqliteHotCopy.js:125 `new Database(src, { readonly: false })` — VACUUM INTO only needs
    // a read transaction, and the header (:22-25) argues the whole primitive exists so that
    // nothing ever touches the live db. Opening WAL read-write instead lets SQLite run WAL
    // recovery against the main file (when -shm is absent) and take a write lock, so a
    // backup of a busy database can checkpoint into it and block writers.
    const src = seededSource('ro-src.db');
    const dst = tmpJoin('ro-copy.db');
    const { FakeDatabase, calls } = workingDriver();
    assert.equal(hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase }).ok, true);
    assert.deepEqual(calls.opened[0], { file: src, options: { readonly: false } });
    assert.equal(calls.opened[0].options.readonly, false);
    // The copy, by contrast, is opened read-only — proving the intent was a read handle.
    assert.deepEqual(calls.opened[1], { file: `${dst}.tmp-${process.pid}`, options: { readonly: true } });
  });

  test('目标已存在时拒绝覆盖，既有文件一个字节都不动', () => {
    const src = seededSource('src2.db');
    const dst = tmpJoin('exists.db');
    fs.writeFileSync(dst, 'KEEPME');
    const { FakeDatabase, calls } = workingDriver();
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.deepEqual(
      { ok: r.ok, journalMode: r.journalMode, integrity: r.integrity, bytes: r.bytes, error: r.error },
      { ok: false, journalMode: 'unknown', integrity: 'unknown', bytes: 0, error: `目标已存在,拒绝覆盖: ${dst}` }
    );
    assert.equal(fs.readFileSync(dst, 'utf8'), 'KEEPME');
    assert.equal(calls.opened.length, 0, 'refusal must happen before any connection is opened');
  });

  test('源不存在时结构化失败，并且不提前创建目标父目录', () => {
    const dst = tmpJoin('never', 'copy.db');
    const { FakeDatabase, calls } = workingDriver();
    const r = hotCopySqlite(tmpJoin('missing.db'), dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.match(r.error, /源库不存在/);
    assert.equal(calls.opened.length, 0);
    assert.equal(fs.existsSync(path.dirname(dst)), false);
  });

  test('空路径 / nullish / 数字入参都给同一条错误，绝不抛', () => {
    const { FakeDatabase } = workingDriver();
    for (const pair of [['', 'a'], ['a', ''], [null, 'a'], ['a', undefined], [0, 0], [false, '']]) {
      const r = hotCopySqlite(pair[0], pair[1], { DatabaseCtor: FakeDatabase });
      assert.equal(r.ok, false, JSON.stringify(pair));
      assert.equal(r.error, '源路径或目标路径为空');
    }
    assert.equal(hotCopySqlite().error, '源路径或目标路径为空');
  });

  test('源不存在时不会触发缺省驱动的惰性 require（备份永不碰真库句柄的前置闸门）', () => {
    // sqliteHotCopy.js:106-114 returns before :123 `require('config/sqlite-adapter')`, so a
    // typo / a never-created database cannot open a real handle on anything.
    const r = hotCopySqlite('definitely-not-here.db', 'also-not-here.db');
    assert.equal(r.ok, false);
    assert.match(r.error, /源库不存在: definitely-not-here\.db/);
    assert.equal(r.bytes, 0);
  });

  test('opts 为 null（JSON 传参常见）时不回落默认，只给结构化错误', () => {
    const src = seededSource('src3.db');
    const r = hotCopySqlite(src, tmpJoin('null-opts.db'), null);
    assert.equal(r.ok, false);
    assert.match(r.error, /Cannot read properties of null/);
    assert.equal(fs.existsSync(tmpJoin('null-opts.db')), false);
  });

  test('驱动构造抛错被兜住：返回错误、不落地目标、不留临时文件', () => {
    const src = seededSource('src4.db');
    const dst = tmpJoin('open-boom.db');
    const { FakeDatabase } = makeDriver({ onOpen() { throw new Error('cannot open: database locked'); } });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cannot open: database locked');
    assert.equal(fs.existsSync(dst), false);
    assert.equal(fs.existsSync(`${dst}.tmp-${process.pid}`), false);
  });

  test('抛错对象没有 message 时按字符串化兜底', () => {
    const src = seededSource('src5.db');
    const dst = tmpJoin('no-message.db');
    const { FakeDatabase } = makeDriver({
      onOpen() {
        throw { name: 'weird' };
      },
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.equal(r.error, '[object Object]');
  });

  test('KNOWN-DEFECT: 多行 SQL 错误被截成首行，manifest 里只剩 SQLITE_ERROR', () => {
    // sqliteHotCopy.js:154 keeps only `split('\n')[0]`. node:sqlite puts the useful detail on
    // the second line ("SQLITE_CANTOPEN: unable to open ..."), so an operator reading
    // manifest.json gets a code with no explanation and has to reproduce the failure to learn
    // anything.
    const src = seededSource('src6.db');
    const dst = tmpJoin('multiline.db');
    const { FakeDatabase } = makeDriver({
      onExec() {
        const err = new Error('SQLITE_ERROR\nnear "VACUUM": syntax error');
        throw err;
      },
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'SQLITE_ERROR');
    assert.equal(r.error.includes('VACUUM'), false);
  });

  test('连接已在事务内时拒绝执行 VACUUM，且不落地目标', () => {
    const src = seededSource('src7.db');
    const dst = tmpJoin('in-txn.db');
    const { FakeDatabase, calls } = makeDriver({
      inTransaction: true,
      onPragma: () => [{ journal_mode: 'wal' }],
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'VACUUM INTO 不能在事务内执行');
    assert.equal(r.journalMode, 'wal');
    assert.equal(calls.exec.length, 0);
    assert.equal(fs.existsSync(dst), false);
    assert.equal(calls.closed, 1);
  });

  test('inTransaction 为假值 0 / 空串 / null / NaN 时照常执行（门条件是真假，不是布尔）', () => {
    const src = seededSource('src8.db');
    for (const inTxn of [0, '', null, undefined, NaN]) {
      const dst = tmpJoin(`falsy-${String(inTxn) || 'empty'}.db`);
      const { FakeDatabase } = makeDriver({
        inTransaction: inTxn,
        onPragma: (text) => (text === 'journal_mode' ? [{ journal_mode: 'wal' }] : [{ integrity_check: 'ok' }]),
        onExec: (sql) => fs.writeFileSync(vacuumTarget(sql), Buffer.alloc(8, 1)),
      });
      const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
      assert.equal(r.ok, true, `${String(inTxn)} -> ${String(r.error)}`);
      assert.equal(r.bytes, 8);
    }
    // A non-empty string other than the boolean the contract documents also blocks:
    const blocked = tmpJoin('falsy-truthy.db');
    const { FakeDatabase: Str } = makeDriver({
      inTransaction: 'BEGIN',
      onPragma: () => [{ journal_mode: 'wal' }],
    });
    assert.equal(hotCopySqlite(src, blocked, { DatabaseCtor: Str }).error, 'VACUUM INTO 不能在事务内执行');
  });

  test('副本完整性校验不过时删残骸、不落地，并把 integrity 原样回报', () => {
    const src = seededSource('src9.db');
    const dst = tmpJoin('broken.db');
    const { FakeDatabase, calls } = makeDriver({
      onPragma: (text, file) => (text === 'journal_mode'
        ? [{ journal_mode: 'wal' }]
        : (file.includes('.tmp-') ? [{ integrity_check: '*** in database main *** page 1 is unused' }] : [])),
      onExec: (sql) => fs.writeFileSync(vacuumTarget(sql), Buffer.alloc(64, 2)),
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.equal(r.integrity, '*** in database main *** page 1 is unused');
    assert.match(r.error, /副本完整性校验未通过/);
    assert.equal(fs.existsSync(dst), false);
    assert.equal(fs.existsSync(`${dst}.tmp-${process.pid}`), false, 'corrupt temp copy must be unlinked');
    assert.equal(calls.closed, 2);
  });

  test('integrity 列值为 null 时被读成 "null"，副本因此被判失败（fail-closed）', () => {
    const src = seededSource('src10.db');
    const dst = tmpJoin('null-integrity.db');
    const { FakeDatabase } = makeDriver({
      onPragma: (text) => (text === 'journal_mode' ? [{ journal_mode: 'wal' }] : [{ integrity_check: null }]),
      onExec: (sql) => fs.writeFileSync(vacuumTarget(sql), Buffer.alloc(16, 4)),
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.integrity, 'null');
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(dst), false);
  });

  test('pragma 返回空数组（驱动降级路径）时 journalMode 与 integrity 都记 unknown，副本被拒', () => {
    const src = seededSource('src11.db');
    const dst = tmpJoin('empty-pragma.db');
    const { FakeDatabase } = makeDriver({
      onExec: (sql) => fs.writeFileSync(vacuumTarget(sql), Buffer.alloc(16, 5)),
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.journalMode, 'unknown');
    assert.equal(r.integrity, 'unknown');
    assert.equal(r.ok, false);
    assert.match(r.error, /副本完整性校验未通过: unknown/);
  });

  test('KNOWN-DEFECT: verifyIntegrity 关闭后未校验的副本直接改名落地并报成功', () => {
    // sqliteHotCopy.js:137 `opts.verifyIntegrity !== false` — the only way to reach this
    // branch is an explicit false, but the consequence is that a garbage copy (here: the
    // driver writes a non-database blob) is renamed into the backup set with ok:true and
    // integrity 'unknown', which restoreService later verifies by sha only. The sha of a
    // corrupt file matches itself, so a "verified" backup can be unusable.
    const src = seededSource('src12.db');
    const dst = tmpJoin('unverified.db');
    const { FakeDatabase, calls } = makeDriver({
      onPragma: () => [{ journal_mode: 'delete' }],
      onExec: (sql) => fs.writeFileSync(vacuumTarget(sql), 'this is not a sqlite file'),
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase, verifyIntegrity: false });
    assert.equal(r.ok, true);
    assert.equal(r.integrity, 'unknown');
    assert.equal(r.journalMode, 'delete');
    assert.equal(r.bytes, 25);
    assert.equal(calls.opened.length, 1, 'the copy must not even be opened when verification is off');
    assert.equal(fs.readFileSync(dst, 'utf8'), 'this is not a sqlite file');
    // Any other value keeps verification on (fail-safe direction).
    const dst2 = tmpJoin('verified.db');
    const other = workingDriver();
    const r2 = hotCopySqlite(src, dst2, { DatabaseCtor: other.FakeDatabase, verifyIntegrity: 0 });
    assert.equal(r2.ok, true);
    assert.equal(r2.integrity, 'ok');
    assert.equal(other.calls.opened.length, 2);
  });

  test('临时名残骸在开工前清掉，崩溃过的目录可以重跑', () => {
    const src = seededSource('src13.db');
    const dst = tmpJoin('leftover.db');
    fs.writeFileSync(`${dst}.tmp-${process.pid}`, 'STALE');
    const { FakeDatabase } = workingDriver(32);
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.bytes, 32);
    assert.equal(fs.existsSync(dst), true);
  });

  test('源与目标是同一个文件时按「目标已存在」拒绝', () => {
    const src = seededSource('same.db', 40);
    const { FakeDatabase, calls } = workingDriver();
    const r = hotCopySqlite(src, src, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.match(r.error, /拒绝覆盖/);
    assert.equal(calls.opened.length, 0);
    assert.equal(fs.statSync(src).size, 40);
  });

  test('路径里带单引号时 SQL 字面量被正确转义，副本落在预期文件', () => {
    const src = seededSource("we'ird.db");
    const dst = tmpJoin("out'put.db");
    const { FakeDatabase, calls } = workingDriver(12);
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(calls.exec[0], `VACUUM INTO '${sqlTmpOf(dst)}'`);
    assert.equal(vacuumTarget(calls.exec[0]), `${dst}.tmp-${process.pid}`.split(BACKSLASH).join('/'));
    assert.equal(fs.existsSync(dst), true);
  });

  test('close 抛错不影响结论，且临时文件仍被清理', () => {
    const src = seededSource('src14.db');
    const dst = tmpJoin('close-boom.db');
    const { FakeDatabase, calls } = makeDriver({
      onPragma: (text) => (text === 'journal_mode' ? [{ journal_mode: 'wal' }] : [{ integrity_check: 'ok' }]),
      onExec: (sql) => fs.writeFileSync(vacuumTarget(sql), Buffer.alloc(9, 6)),
      onClose: (file) => {
        if (file.includes('.tmp-')) throw new Error('close boom');
      },
    });
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'close boom');
    assert.equal(calls.closed >= 1, true);
    assert.equal(fs.existsSync(dst), false);
  });

  test('目标是多层不存在目录时递归创建，父目录由模块负责', () => {
    const src = seededSource('src15.db');
    const dst = tmpJoin('deep', 'deeper', 'deepest', 'copy.db');
    const { FakeDatabase } = workingDriver(4);
    const r = hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(fs.existsSync(dst), true);
    assert.equal(r.bytes, 4);
  });

  test('VACUUM 语句之外的 SQL 不会被本模块发出（exec 只调用一次）', () => {
    const src = seededSource('src16.db');
    const dst = tmpJoin('one-exec.db');
    const { FakeDatabase, calls } = workingDriver(1);
    hotCopySqlite(src, dst, { DatabaseCtor: FakeDatabase });
    assert.deepEqual(calls.exec, [`VACUUM INTO '${sqlTmpOf(dst)}'`]);
  });
});

describe('restoreSqliteInPlace：原位放回与 WAL/SHM 边车清理', () => {
  function pair(name) {
    const backup = tmpJoin(`${name}.backup`);
    const target = tmpJoin(name);
    fs.writeFileSync(backup, 'NEW-CONTENT');
    return { backup, target };
  }

  test('成功恢复：内容替换，三种边车按序删除并留痕，无恢复临时文件残留', () => {
    const { backup, target } = pair('ok.db');
    fs.writeFileSync(target, 'OLD-CONTENT');
    for (const s of ['-wal', '-shm', '-journal']) fs.writeFileSync(`${target}${s}`, 'side');
    const r = restoreSqliteInPlace(backup, target);
    assert.deepEqual({ ok: r.ok, error: r.error }, { ok: true, error: null });
    assert.equal(fs.readFileSync(target, 'utf8'), 'NEW-CONTENT');
    assert.deepEqual(r.removedSidecars, [`${target}-wal`, `${target}-shm`, `${target}-journal`]);
    for (const s of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(`${target}${s}`), false);
    assert.equal(fs.existsSync(`${target}.restore-tmp-${process.pid}`), false);
  });

  test('没有边车时 removedSidecars 为空数组，仍然算成功', () => {
    const { backup, target } = pair('noclean.db');
    const r = restoreSqliteInPlace(backup, target);
    assert.equal(r.ok, true, String(r.error));
    assert.deepEqual(r.removedSidecars, []);
  });

  test('备份文件不存在时结构化失败，目标与既有边车一律不动', () => {
    const target = tmpJoin('keep.db');
    fs.writeFileSync(target, 'OLD');
    fs.writeFileSync(`${target}-wal`, 'WAL');
    const r = restoreSqliteInPlace(tmpJoin('missing.backup'), target);
    assert.equal(r.ok, false);
    assert.match(r.error, /备份库不存在/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'OLD');
    assert.equal(fs.existsSync(`${target}-wal`), true);
    assert.deepEqual(r.removedSidecars, []);
  });

  test('空路径与 nullish 入参不抛，只给结构化错误', () => {
    for (const args of [['', 'x'], [null, 'x'], ['x', ''], ['x', null], [undefined, undefined], [0, 0]]) {
      const r = restoreSqliteInPlace(args[0], args[1]);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.equal(typeof r.error, 'string');
      assert.equal(Array.isArray(r.removedSidecars), true);
    }
  });

  test('目标父目录不存在时递归创建', () => {
    const { backup } = pair('mk.db');
    const target = tmpJoin('r-deep', 'sub', 'restored.db');
    const r = restoreSqliteInPlace(backup, target);
    assert.equal(r.ok, true, String(r.error));
    assert.equal(fs.readFileSync(target, 'utf8'), 'NEW-CONTENT');
  });

  test('备份路径是目录时复制失败被兜住，临时文件清理干净', () => {
    const dirAsBackup = tmpJoin('dir-as-backup');
    fs.mkdirSync(dirAsBackup, { recursive: true });
    const target = tmpJoin('after-dir-src.db');
    const r = restoreSqliteInPlace(dirAsBackup, target);
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.restore-tmp-${process.pid}`), false);
  });

  test('目标本身是目录时改名失败被兜住，目录内容与临时文件都不残留', () => {
    const { backup } = pair('dst-dir.db');
    const target = tmpJoin('is-a-dir.db');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'inner.txt'), 'inner');
    const r = restoreSqliteInPlace(backup, target);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.equal(fs.existsSync(path.join(target, 'inner.txt')), true);
    assert.equal(fs.existsSync(`${target}.restore-tmp-${process.pid}`), false);
  });

  test('KNOWN-DEFECT: 先换库再删边车，删失败时报告失败而库已被替换', () => {
    // sqliteHotCopy.js:200 renames the new database into place *before* the sidecar loop at
    // :203-214, and an unlink failure returns ok:false at :211. The caller (restoreService)
    // then treats the restore as failed and may retry or roll back, while the live database
    // is already the restored one sitting next to the stale WAL it promised to remove —
    // exactly the mixed state this function exists to prevent.
    const { backup } = pair('mixed.db');
    const target = tmpJoin('mixed.db');
    fs.writeFileSync(target, 'OLD');
    fs.mkdirSync(`${target}-wal`, { recursive: true });
    const r = restoreSqliteInPlace(backup, target);
    assert.equal(r.ok, false);
    assert.match(r.error, /无法删除旧 -wal/);
    assert.deepEqual(r.removedSidecars, []);
    assert.equal(fs.readFileSync(target, 'utf8'), 'NEW-CONTENT', 'the live db was already replaced');
    assert.equal(fs.existsSync(`${target}-wal`), true);
  });

  test('边车删到一半失败时留痕已删的部分，调用方看到的是不可回滚的中间态', () => {
    const { backup } = pair('partial.db');
    const target = tmpJoin('partial.db');
    fs.writeFileSync(`${target}-wal`, 'WAL');
    fs.mkdirSync(`${target}-shm`, { recursive: true });
    fs.writeFileSync(`${target}-journal`, 'J');
    const r = restoreSqliteInPlace(backup, target);
    assert.equal(r.ok, false);
    assert.deepEqual(r.removedSidecars, [`${target}-wal`]);
    assert.equal(fs.existsSync(`${target}-wal`), false);
    assert.equal(fs.existsSync(`${target}-journal`), true, 'the loop stopped, so -journal survives');
  });

  test('恢复到同名目标（备份与目标同文件）时把自身拷进临时名再换回，结果仍是成功', () => {
    const file = tmpJoin('self.db');
    fs.writeFileSync(file, 'SAME');
    const r = restoreSqliteInPlace(file, file);
    assert.equal(r.ok, true, String(r.error));
    assert.equal(fs.readFileSync(file, 'utf8'), 'SAME');
  });

  test('大文件（1 MB）内容逐字节搬运，sha 由调用方负责', () => {
    const backup = tmpJoin('big.backup');
    const target = tmpJoin('big.db');
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i += 4096) payload[i] = i % 251;
    fs.writeFileSync(backup, payload);
    const r = restoreSqliteInPlace(backup, target);
    assert.equal(r.ok, true, String(r.error));
    assert.equal(fs.statSync(target).size, payload.length);
    assert.deepEqual(fs.readFileSync(target), payload);
  });
});
