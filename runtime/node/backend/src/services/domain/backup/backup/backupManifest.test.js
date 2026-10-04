'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  ENTRY_KINDS,
  ID_RE,
  makeBackupId,
  parseBackupId,
  makeEntry,
  buildManifest,
  validateManifest,
  planRetention,
} = require('./backupManifest.js');

const SHA_A = 'a'.repeat(64);
const VALID_ID = '20260816T074600Z-abcdef';
const VALID_CREATED = '2026-08-16T07:46:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const BACKSLASH = String.fromCharCode(92);

/** Minimal manifest that passes validateManifest, used as the happy-path baseline. */
function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: VALID_ID,
    createdAt: VALID_CREATED,
    entries: [{ kind: 'file', target: 'files/config.json', sha256: SHA_A, bytes: 12 }],
    excluded: [],
    dataHomes: { user: '/home/u/.khy' },
    ...overrides,
  };
}

describe('备份集 id：makeBackupId / parseBackupId', () => {
  test('合法 ISO 时间加 6 位以上十六进制后缀拼出紧凑 id，后缀大小写归一', () => {
    assert.equal(makeBackupId(VALID_CREATED, 'abcdef'), VALID_ID);
    assert.equal(makeBackupId('2026-08-16T07:46:00Z', 'ABCDEF'), VALID_ID);
    assert.equal(makeBackupId('2026-08-16T07:46:00.000Z', 'deadbeef'), '20260816T074600Z-deadbeef');
    assert.equal(makeBackupId('20260816T074600Z', 'abcdef'), VALID_ID);
    assert.equal(ID_RE.test(VALID_ID), true);
  });

  test('后缀短于 6 位 / 含非十六进制字符 / 缺失，以及时间形状不对，一律返回 null', () => {
    for (const suffix of ['abcde', '', null, undefined, 0, 'ghijk1', 'abc-def', 'abcdef_']) {
      assert.equal(makeBackupId(VALID_CREATED, suffix), null, String(suffix));
    }
    for (const iso of ['', null, undefined, 0, '2026-08-16 07:46:00', 'not-a-date']) {
      assert.equal(makeBackupId(iso, 'abcdef'), null, String(iso));
    }
    assert.equal(makeBackupId(undefined, undefined), null);
  });

  test('id 与时间毫秒双向换算，后缀原样还原', () => {
    const parsed = parseBackupId(VALID_ID);
    assert.deepEqual(parsed, { ok: true, timeMs: Date.parse(VALID_CREATED), suffix: 'abcdef' });
    assert.equal(new Date(parsed.timeMs).toISOString(), '2026-08-16T07:46:00.000Z');
    assert.equal(parseBackupId(makeBackupId('2026-12-31T23:59:59.000Z', 'ff00aa')).ok, true);
  });

  test('非法定位串一律给 {ok:false,timeMs:0,suffix:空}，不抛', () => {
    for (const id of ['', null, undefined, 0, NaN, {}, [], 'garbage', '20260816T074600Z-abcde', '20260816T074600Z-ABCDEF', `${VALID_ID}-extra`]) {
      assert.deepEqual(parseBackupId(id), { ok: false, timeMs: 0, suffix: '' }, String(id));
    }
  });

  test('对象入参按 toString 参与判定，两侧都不抛', () => {
    assert.deepEqual(parseBackupId({ toString: () => VALID_ID }), {
      ok: true,
      timeMs: Date.parse(VALID_CREATED),
      suffix: 'abcdef',
    });
    assert.equal(
      makeBackupId({ toString: () => VALID_CREATED }, { toString: () => 'ABCDEF' }),
      VALID_ID
    );
  });

  test('KNOWN-DEFECT: makeBackupId 只校验形状，不可能的日期也返回 id，但落盘后时间不可解析', () => {
    // backupManifest.js:39-42 strips dashes/colons and matches ID_RE without ever asking
    // whether the calendar instant exists, while parseBackupId (:63) does Date.parse.
    // The pair therefore disagrees: a manifest written with this id validates as
    // "id 合法" nowhere (validateManifest:157 rejects it), but any retention caller that
    // trusts the non-null return gets timeMs 0, i.e. the newest backup sorts as the
    // oldest and loses the "最新一份永不删除" protection.
    const id = makeBackupId('2026-13-45T99:99:99.000Z', 'abcdef');
    assert.equal(id, '20261345T999999Z-abcdef');
    assert.equal(ID_RE.test(id), true);
    assert.deepEqual(parseBackupId(id), { ok: false, timeMs: 0, suffix: '' });
    assert.equal(validateManifest(validManifest({ id })).ok, false);
    assert.match(validateManifest(validManifest({ id })).errors.join('|'), /id 非法/);
    const plan = planRetention([{ id, complete: true }], { keepCount: 1, keepDays: 1, nowMs: Date.parse('2026-09-01T00:00:00Z') });
    assert.deepEqual(plan.drop, []);
    assert.deepEqual(plan.keep, [id]);
  });
});

describe('makeEntry：条目组装', () => {
  test('kind 走白名单，四种合法 kind 原样保留，未知值回落 file', () => {
    assert.deepEqual([...ENTRY_KINDS], ['sqlite', 'pgdump', 'file', 'cold-export']);
    assert.equal(Object.isFrozen(ENTRY_KINDS), true);
    for (const kind of ENTRY_KINDS) {
      assert.equal(makeEntry({ kind }).kind, kind);
    }
    for (const bogus of ['DIRECTORY', '', null, undefined, 0, 'File', {}, []]) {
      assert.equal(makeEntry({ kind: bogus }).kind, 'file', String(bogus));
    }
  });

  test('字段强制字符串化，target 的反斜杠统一换成正斜杠', () => {
    const e = makeEntry({ home: 'user', source: `C:${BACKSLASH}khy${BACKSLASH}a.json`, target: `files${BACKSLASH}khyquant${BACKSLASH}config.json` });
    assert.equal(e.source, `C:${BACKSLASH}khy${BACKSLASH}a.json`);
    assert.equal(e.target, 'files/khyquant/config.json');
    assert.deepEqual(
      makeEntry(),
      { kind: 'file', home: '', source: '', target: '', bytes: 0, sha256: '' }
    );
    assert.equal(makeEntry({ home: null }).home, '');
    assert.equal(makeEntry({ target: undefined }).target, '');
  });

  test('bytes 与 sha256 归一：字符串数字收下，非有限落 0，sha 转小写', () => {
    assert.equal(makeEntry({ bytes: '12' }).bytes, 12);
    assert.equal(makeEntry({ bytes: Infinity }).bytes, 0);
    assert.equal(makeEntry({ bytes: NaN }).bytes, 0);
    assert.equal(makeEntry({ bytes: 'abc' }).bytes, 0);
    assert.equal(makeEntry({ bytes: -5 }).bytes, -5);
    assert.equal(makeEntry({ bytes: 0 }).bytes, 0);
    assert.equal(makeEntry({ sha256: SHA_A.toUpperCase() }).sha256, SHA_A);
    assert.equal(makeEntry({ sha256: null }).sha256, '');
  });

  test('journalMode 只在真值时出现，并强制字符串化', () => {
    assert.equal('journalMode' in makeEntry({ kind: 'sqlite', journalMode: 'WAL' }), true);
    assert.equal(makeEntry({ kind: 'sqlite', journalMode: 'WAL' }).journalMode, 'WAL');
    for (const j of [undefined, null, '', 0, NaN]) {
      assert.equal('journalMode' in makeEntry({ journalMode: j }), false, String(j));
    }
    assert.equal(makeEntry({ journalMode: { a: 1 } }).journalMode, '[object Object]');
  });

  test('cold-export 条目额外携带四个专属字段，其它 kind 不带噪音', () => {
    const cold = makeEntry({ kind: 'cold-export', target: 'cold/audit.tgz', records: '12', sourceFiles: 3, compression: 'zstd', window: { from: 1, to: 2 } });
    assert.deepEqual(
      { compression: cold.compression, records: cold.records, sourceFiles: cold.sourceFiles, window: cold.window },
      { compression: 'zstd', records: 12, sourceFiles: 3, window: { from: 1, to: 2 } }
    );
    assert.equal(makeEntry({ kind: 'cold-export' }).compression, 'gzip');
    assert.deepEqual(makeEntry({ kind: 'cold-export' }).window, {});
    assert.equal(makeEntry({ kind: 'cold-export', window: 'nope' }).window.constructor, Object);
    assert.deepEqual(Object.keys(makeEntry({ kind: 'file', records: 5 })).sort(), ['bytes', 'home', 'kind', 'sha256', 'source', 'target']);
  });

  test('KNOWN-DEFECT: cold-export 的 window 只浅拷贝，嵌套区间对象与调用方共享', () => {
    // backupManifest.js:107 `{ ...spec.window }` copies one level, so a caller-owned
    // nested range object stays live inside the manifest that later gets written to
    // disk: mutating it after build changes the "archived window" the manifest claims.
    const range = { from: 1 };
    const e = makeEntry({ kind: 'cold-export', window: { range } });
    e.window.range.from = 999;
    assert.equal(range.from, 999);
  });

  test('KNOWN-DEFECT: makeEntry(null) 抛 TypeError，与模块头「绝不抛」矛盾', () => {
    // backupManifest.js:88 `spec = {}` only fires for undefined, so a null spec — which
    // JSON.parse can legitimately produce for `"entries":[null]` in an older manifest —
    // throws through the caller instead of yielding a defaulted entry.
    assert.throws(() => makeEntry(null), TypeError);
    assert.doesNotThrow(() => makeEntry(undefined));
    assert.throws(() => makeEntry({ home: { toString() { throw new Error('boom'); } } }), /boom/);
  });
});

describe('buildManifest：清单组装', () => {
  test('空入参给出稳定的默认形状', () => {
    const m = buildManifest();
    assert.equal(m.schemaVersion, 1);
    assert.deepEqual([m.id, m.createdAt, m.tier, m.note, m.khyVersion, m.platform, m.nodeVersion, m.sqliteDriver, m.dbMode], ['', '', '', '', '', '', '', '', '']);
    assert.deepEqual(m.dataHomes, {});
    assert.deepEqual(m.entries, []);
    assert.deepEqual(m.excluded, []);
    assert.deepEqual(m.restoreHints, []);
    assert.equal(m.containsSecrets, true);
    assert.equal(m.totalBytes, 0);
    assert.deepEqual(Object.keys(m), [
      'schemaVersion', 'id', 'createdAt', 'tier', 'note', 'khyVersion', 'platform',
      'nodeVersion', 'sqliteDriver', 'dbMode', 'dataHomes', 'entries', 'excluded',
      'containsSecrets', 'restoreHints', 'totalBytes',
    ]);
  });

  test('字符串化的九个标量字段与 schemaVersion 数值归一', () => {
    const m = buildManifest({ schemaVersion: '2', tier: 'full', note: '搬迁前基线', khyVersion: 42, platform: null, dbMode: {} });
    assert.equal(m.schemaVersion, 2);
    assert.equal(m.tier, 'full');
    assert.equal(m.note, '搬迁前基线');
    assert.equal(m.khyVersion, '42');
    assert.equal(m.platform, '');
    assert.equal(m.dbMode, '[object Object]');
    assert.equal(buildManifest({ schemaVersion: NaN }).schemaVersion, 1);
    assert.equal(buildManifest({ schemaVersion: 0 }).schemaVersion, 0);
    assert.equal(buildManifest({ schemaVersion: -3 }).schemaVersion, -3);
  });

  test('containsSecrets 是 fail-closed：只有显式 false 才关', () => {
    assert.equal(buildManifest({}).containsSecrets, true);
    assert.equal(buildManifest({ containsSecrets: null }).containsSecrets, true);
    assert.equal(buildManifest({ containsSecrets: 0 }).containsSecrets, true);
    assert.equal(buildManifest({ containsSecrets: 'false' }).containsSecrets, true);
    assert.equal(buildManifest({ containsSecrets: false }).containsSecrets, false);
  });

  test('totalBytes 累加各条 bytes，字符串数字与负数都参与', () => {
    assert.equal(buildManifest({ entries: [{ bytes: 10 }, { bytes: '20' }, { bytes: 5 }] }).totalBytes, 35);
    assert.equal(buildManifest({ entries: [{ bytes: 10 }, { bytes: -5 }] }).totalBytes, 5);
    assert.equal(buildManifest({ entries: [{}, { bytes: NaN }, { bytes: 'abc' }] }).totalBytes, 0);
    assert.equal(buildManifest({ entries: 'nope' }).totalBytes, 0);
  });

  test('KNOWN-DEFECT: 一个非对象但数值假值的条目把 totalBytes 变成 NaN，落盘写成 null', () => {
    // backupManifest.js:137 guards only the *condition* with `Number.isFinite(Number(e && e.bytes))`
    // and then reads `e.bytes` unguarded in the true branch. For a falsy-but-non-null entry
    // (0, false, null-ish numbers coming from a JSON round-trip) Number(false) is 0 → finite,
    // so the guard passes, `e.bytes` is undefined and the sum becomes NaN — which JSON.stringify
    // serialises as `null`, so the manifest on disk silently states totalBytes: null.
    assert.ok(Number.isNaN(buildManifest({ entries: [0] }).totalBytes));
    assert.ok(Number.isNaN(buildManifest({ entries: [false] }).totalBytes));
    assert.ok(Number.isNaN(buildManifest({ entries: [''] }).totalBytes));
    assert.ok(Number.isNaN(buildManifest({ entries: [-0] }).totalBytes));
    assert.equal(JSON.parse(JSON.stringify(buildManifest({ entries: [0] }))).totalBytes, null);
    assert.equal(buildManifest({ entries: ['x'] }).totalBytes, 0);
    assert.equal(buildManifest({ entries: [NaN] }).totalBytes, 0);
    assert.equal(buildManifest({ entries: [{}] }).totalBytes, 0);
  });

  test('KNOWN-DEFECT: entries 里出现 null 时 buildManifest 直接抛穿', () => {
    // Same line :137: `Number(null)` is 0 (finite) so the ternary enters the true branch and
    // dereferences `null.bytes`. validateManifest (:170) explicitly tolerates a null entry,
    // so the two halves of this module disagree about whether null entries are legal input.
    assert.throws(() => buildManifest({ entries: [null] }), TypeError);
    assert.equal(validateManifest(validManifest({ entries: [null] })).errors[0], 'entries[0] 不是对象');
  });

  test('KNOWN-DEFECT: entries/excluded/dataHomes 只拷一层，清单写穿调用方的真源', () => {
    // backupManifest.js:129-131 `slice()` / one-level spread share the element objects, so a
    // caller that keeps its own array (backupService accumulates entries while walking the
    // tree) can change the "signed" manifest after the fact — including the sha256 that
    // verify later trusts.
    const entry = { kind: 'file', target: 'a.json', sha256: SHA_A, bytes: 1 };
    const excluded = { prune: true, reason: '日志,非状态' };
    const dataHomes = { user: { dir: '/home/u/.khy' } };
    const m = buildManifest({ entries: [entry], excluded: [excluded], dataHomes });
    m.entries[0].target = 'HACKED';
    m.excluded[0].prune = false;
    m.dataHomes.user.dir = '/HACKED';
    assert.equal(entry.target, 'HACKED');
    assert.equal(excluded.prune, false);
    assert.equal(dataHomes.user.dir, '/HACKED');
    assert.notEqual(m.entries, [entry]);
  });

  test('KNOWN-DEFECT: buildManifest(null) 与 throwing toString 都抛穿，违反 :16 的绝不抛契约', () => {
    // backupManifest.js:117 has no default-for-null and no try/catch, unlike makeBackupId (:38)
    // and validateManifest (:150), so a manifest spec sourced from JSON cannot be built safely.
    assert.throws(() => buildManifest(null), TypeError);
    assert.throws(() => buildManifest({ note: { toString() { throw new Error('boom'); } } }), /boom/);
  });

  test('dataHomes 传数组时被 spread 成数字键对象，仍算作有效对象', () => {
    assert.deepEqual(buildManifest({ dataHomes: ['/a', '/b'] }).dataHomes, { 0: '/a', 1: '/b' });
    assert.deepEqual(buildManifest({ dataHomes: 'nope' }).dataHomes, {});
    assert.deepEqual(buildManifest({ dataHomes: null }).dataHomes, {});
  });
});

describe('validateManifest：结构与契约校验', () => {
  test('非对象（含数组 / nullish / 原始值）给出一条错误而不是异常', () => {
    for (const junk of [null, undefined, [], 'x', 42, true, NaN, 0]) {
      assert.deepEqual(validateManifest(junk), { ok: false, errors: ['manifest 不是对象'] }, String(junk));
    }
  });

  test('由 makeEntry 与 buildManifest 组装的真品清单通过校验', () => {
    const m = buildManifest({
      id: VALID_ID,
      createdAt: VALID_CREATED,
      tier: 'full',
      entries: [makeEntry({ kind: 'sqlite', target: 'dbs/taskboard.db', sha256: SHA_A, bytes: 1024, journalMode: 'WAL' })],
    });
    assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
    assert.deepEqual(validateManifest(validManifest()), { ok: true, errors: [] });
  });

  test('schemaVersion 与 createdAt 的形状缺失各自报错', () => {
    assert.deepEqual(validateManifest(validManifest({ schemaVersion: 0 })).errors, ['schemaVersion 缺失或非法']);
    assert.match(validateManifest(validManifest({ schemaVersion: undefined })).errors.join(), /schemaVersion/);
    assert.match(validateManifest(validManifest({ createdAt: '' })).errors.join(), /createdAt 缺失或非法/);
    assert.deepEqual(validateManifest(validManifest({ createdAt: 'yesterday' })).errors, ['createdAt 缺失或非法']);
    assert.deepEqual(validateManifest(validManifest({ schemaVersion: '2' })).errors, []);
  });

  test('entries 为空或非数组，以及条目不是对象，各有确定文案', () => {
    assert.match(validateManifest(validManifest({ entries: [] })).errors.join(), /entries 为空/);
    assert.deepEqual(validateManifest(validManifest({ entries: 'x' })).errors, ['entries 不是数组']);
    assert.deepEqual(validateManifest(validManifest({ entries: [null] })).errors, ['entries[0] 不是对象']);
    assert.equal(validateManifest(validManifest({ entries: [null, 7, 'x'] })).errors.length, 3);
  });

  test('kind 非法、target 缺失、sha256 非 64 位小写十六进制、bytes 负数分别报错', () => {
    const bad = validateManifest(validManifest({
      entries: [
        { kind: 'DIRECTORY', target: 'a', sha256: SHA_A, bytes: 1 },
        { kind: 'file', target: '', sha256: SHA_A, bytes: 1 },
        { kind: 'file', target: 'a', sha256: SHA_A.toUpperCase(), bytes: 1 },
        { kind: 'file', target: 'a', sha256: 'abc', bytes: 1 },
        { kind: 'file', target: 'a', sha256: SHA_A, bytes: -1 },
        { kind: 'file', target: 'a', sha256: SHA_A, bytes: undefined },
      ],
    })).errors;
    assert.deepEqual(bad, [
      'entries[0].kind 非法: DIRECTORY',
      'entries[1].target 缺失',
      'entries[2].sha256 非法(必须是 64 位小写十六进制)',
      'entries[3].sha256 非法(必须是 64 位小写十六进制)',
      'entries[4].bytes 非法',
      'entries[5].bytes 非法',
    ]);
  });

  test('条目字段宽松收下字符串数字，但 sha256 不做大小写归一（必须由 makeEntry 先归一）', () => {
    assert.deepEqual(validateManifest(validManifest({ entries: [{ kind: 'file', target: 'a', sha256: SHA_A, bytes: '12' }] })), { ok: true, errors: [] });
    assert.equal(validateManifest(validManifest({ entries: [{ kind: 'file', target: 'a', sha256: 'A'.repeat(64), bytes: 1 }] })).ok, false);
  });

  test('cold-export 归档必须至少 1 条记录且文件非空，否则算契约违反', () => {
    const cold = (over) => validateManifest(validManifest({
      entries: [{ kind: 'cold-export', target: 'cold/audit.tgz', sha256: SHA_A, bytes: 10, records: 3, ...over }],
    })).errors;
    assert.deepEqual(cold({}), []);
    assert.match(cold({ records: 0 }).join(), /records 非法/);
    assert.match(cold({ records: -2 }).join(), /records 非法/);
    assert.match(cold({ records: undefined }).join(), /records 非法/);
    assert.match(cold({ records: '5' }).join(), /^$/);
    assert.match(cold({ bytes: 0 }).join(), /bytes 为 0/);
    assert.equal(cold({ bytes: 0, records: 0 }).length, 2);
  });

  test('excluded 必须是数组，dataHomes 必须是对象', () => {
    assert.match(validateManifest(validManifest({ excluded: 'x' })).errors.join(), /excluded 不是数组/);
    assert.match(validateManifest(validManifest({ excluded: undefined })).errors.join(), /excluded 不是数组/);
    assert.match(validateManifest(validManifest({ dataHomes: undefined })).errors.join(), /dataHomes 缺失/);
    assert.deepEqual(validateManifest(validManifest({ dataHomes: 'x' })).errors, ['dataHomes 缺失']);
    assert.deepEqual(validateManifest(validManifest({ dataHomes: [] })).errors, []);
  });

  test('KNOWN-DEFECT: 校验中途抛出的异常只留一条错误，已收集的问题被吞掉', () => {
    // backupManifest.js:158 interpolates `String(obj.id)` into the message with no guard,
    // while parseBackupId (:57) happily swallows the same hostile value. The outer catch
    // (:206) then discards everything already accumulated, so an operator reading the
    // report sees one opaque message instead of the full list of structural problems.
    const hostile = validManifest({
      id: { toString() { throw new Error('boom'); } },
      entries: [],
      excluded: 'x',
    });
    assert.deepEqual(validateManifest(hostile), { ok: false, errors: ['boom'] });
    const hostileEntry = validManifest({ entries: [{ kind: { toString() { throw new Error('kaboom'); } }, target: 'a', sha256: SHA_A, bytes: 1 }] });
    assert.deepEqual(validateManifest(hostileEntry), { ok: false, errors: ['kaboom'] });
  });
});

describe('planRetention：保留策略求解', () => {
  test('缺 .complete 的残破备份优先清理，即使它时间最新', () => {
    const r = planRetention([
      { id: '20260901T000000Z-aaaaaa', complete: false },
      { id: '20260810T074600Z-bbbbbb', complete: true },
    ], { keepCount: 5, keepDays: 365, nowMs: Date.parse('2026-09-02T00:00:00Z') });
    assert.deepEqual(r.keep, ['20260810T074600Z-bbbbbb']);
    assert.deepEqual(r.drop, [{ id: '20260901T000000Z-aaaaaa', reason: '缺少 .complete 标记(写入未完成,不可用)' }]);
  });

  test('最新一份完整备份永不删除，即便同时超份数又超天数', () => {
    const nowMs = Date.parse('2026-09-20T00:00:00Z');
    const r = planRetention([
      { id: '20260601T000000Z-aaaaaa', complete: true },
      { id: '20260919T000000Z-bbbbbb', complete: true },
    ], { keepCount: 1, keepDays: 1, nowMs });
    assert.deepEqual(r.keep, ['20260919T000000Z-bbbbbb']);
    assert.equal(r.drop.length, 1);
    assert.equal(r.drop[0].id, '20260601T000000Z-aaaaaa');
    assert.match(r.drop[0].reason, /超出保留份数\(第 2 份 > 1\)且早于 1 天/);
  });

  test('超份数与超天数必须同时成立才删（AND 语义）', () => {
    const nowMs = Date.parse('2026-08-25T00:00:00Z');
    const sets = [
      { id: '20260820T000000Z-aaaaaa', complete: true },
      { id: '20260815T000000Z-bbbbbb', complete: true },
      { id: '20260810T000000Z-cccccc', complete: true },
    ];
    assert.deepEqual(planRetention(sets, { keepCount: 3, keepDays: 1, nowMs }).drop, []);
    const overCountOnly = planRetention(sets, { keepCount: 2, keepDays: 365, nowMs });
    assert.deepEqual(overCountOnly.drop, []);
    assert.deepEqual(overCountOnly.keep, [
      '20260820T000000Z-aaaaaa',
      '20260815T000000Z-bbbbbb',
      '20260810T000000Z-cccccc',
    ]);
    const overAgeOnly = planRetention(sets, { keepCount: 10, keepDays: 1, nowMs });
    assert.deepEqual(overAgeOnly.drop, []);
  });

  test('keepDays 为 0 或负数等于不设时间闸门', () => {
    const nowMs = Date.parse('2026-08-25T00:00:00Z');
    const sets = [
      { id: '20260820T000000Z-aaaaaa', complete: true },
      { id: '20260101T000000Z-bbbbbb', complete: true },
    ];
    assert.deepEqual(planRetention(sets, { keepCount: 1, keepDays: 0, nowMs }).drop, []);
    assert.deepEqual(planRetention(sets, { keepCount: 1, keepDays: -30, nowMs }).drop, []);
  });

  test('sets 按时间倒序返回，时间相同的按 id 字典序兜底', () => {
    const nowMs = Date.parse('2026-12-01T00:00:00Z');
    const r = planRetention([
      { id: '20260810T074600Z-aaaaaa', complete: true },
      { id: '20260820T074600Z-aaaaaa', complete: true },
      { id: '20260815T074600Z-aaaaaa', complete: true },
    ], { keepCount: 3, keepDays: 1, nowMs });
    assert.deepEqual(r.keep, [
      '20260820T074600Z-aaaaaa',
      '20260815T074600Z-aaaaaa',
      '20260810T074600Z-aaaaaa',
    ]);
  });

  test('默认策略是 10 份 / 30 天，nowMs 缺省时时间闸门整体失效', () => {
    const sets = [
      { id: '20260816T074600Z-aaaaaa', complete: true },
      { id: '20260110T074600Z-bbbbbb', complete: true },
    ];
    const r = planRetention(sets, { keepCount: 1, keepDays: 1 });
    assert.deepEqual(r.keep, ['20260816T074600Z-aaaaaa', '20260110T074600Z-bbbbbb']);
    assert.deepEqual(r.drop, []);
    assert.deepEqual(planRetention(sets, {}).drop, []);
    assert.deepEqual(planRetention(sets, undefined).keep, [
      '20260816T074600Z-aaaaaa',
      '20260110T074600Z-bbbbbb',
    ]);
    const withBroken = [
      { id: '20260816T074600Z-aaaaaa', complete: true },
      { id: '20260110T074600Z-bbbbbb', complete: false },
    ];
    assert.deepEqual(planRetention(withBroken, {}).drop, [
      { id: '20260110T074600Z-bbbbbb', reason: '缺少 .complete 标记(写入未完成,不可用)' },
    ]);
    assert.deepEqual(planRetention(withBroken, {}).keep, ['20260816T074600Z-aaaaaa']);
    // Default keepCount is 10: an 11th complete backup still survives while nowMs is absent,
    // and only the single oldest one goes once a real clock is injected.
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      id: `202608${String(1 + i).padStart(2, '0')}T000000Z-${String(i).padStart(6, '0')}`,
      complete: true,
    }));
    assert.equal(planRetention(eleven, {}).drop.length, 0);
    assert.equal(planRetention(eleven, {}).keep.length, 11);
    const pruned = planRetention(eleven, { nowMs: Date.parse('2026-09-01T00:00:00Z'), keepDays: 1 });
    assert.deepEqual(pruned.drop, [
      { id: '20260801T000000Z-000000', reason: '超出保留份数(第 11 份 > 10)且早于 1 天' },
    ]);
    assert.equal(pruned.keep.length, 10);
  });

  test('垃圾输入：非数组 sets、空 id、假值 complete 都被消化成结构化结果', () => {
    assert.deepEqual(planRetention('x', {}), { keep: [], drop: [] });
    assert.deepEqual(planRetention(null, {}), { keep: [], drop: [] });
    assert.deepEqual(planRetention(undefined, {}), { keep: [], drop: [] });
    assert.deepEqual(planRetention([], {}), { keep: [], drop: [] });
    assert.deepEqual(planRetention([{ id: '' }, { id: null }, {}, null], {}), { keep: [], drop: [] });
    assert.deepEqual(planRetention([{ id: VALID_ID, complete: 1 }], {}), { keep: [VALID_ID], drop: [] });
    // `complete` is read through `!!`, so any non-empty string — including the word "no" —
    // means "this backup is complete and must be pruned with care".
    assert.deepEqual(planRetention([{ id: VALID_ID, complete: 'no' }], {}), { keep: [VALID_ID], drop: [] });
    assert.deepEqual(planRetention([{ id: VALID_ID, complete: '' }], {}), {
      keep: [],
      drop: [{ id: VALID_ID, reason: '缺少 .complete 标记(写入未完成,不可用)' }],
    });
    assert.deepEqual(planRetention([{ id: VALID_ID, complete: 0 }], {}).drop.length, 1);
  });

  test('时间戳不可解析的完整备份排在最旧，超出份数即被清理', () => {
    const nowMs = Date.parse('2026-09-01T00:00:00Z');
    const r = planRetention([
      { id: VALID_ID, complete: true },
      { id: 'garbage', complete: true },
    ], { keepCount: 1, keepDays: 1, nowMs });
    assert.deepEqual(r.keep, [VALID_ID]);
    assert.equal(r.drop[0].id, 'garbage');
    assert.equal(r.drop.length, 1);
  });

  test('KNOWN-DEFECT: 同一秒创建的多份备份，「最新一份」由 V8 排序随机决定，真最新反被删', () => {
    // backupManifest.js:241 comparator returns +1/-1 and never 0 for equal ids, so it is not
    // a valid total order. When several sets share the same second (a scripted backup run
    // does exactly that), V8's TimSort lands on a deterministic-but-arbitrary permutation:
    // for aaaaaa/bbbbbb/zzzzzz it protects bbbbbb and deletes both the newest (zzzzzz) and
    // the oldest, and the "永不删除" promise silently moves to the middle element.
    const nowMs = Date.parse('2026-12-01T00:00:00Z');
    const mk = (s) => ({ id: `20260816T074600Z-${s}`, complete: true });
    const inputs = [
      ['aaaaaa', 'bbbbbb', 'zzzzzz'],
      ['zzzzzz', 'bbbbbb', 'aaaaaa'],
      ['bbbbbb', 'zzzzzz', 'aaaaaa'],
    ];
    for (const p of inputs) {
      const r = planRetention(p.map(mk), { keepCount: 1, keepDays: 1, nowMs });
      assert.deepEqual(r.keep, ['20260816T074600Z-bbbbbb'], p.join(','));
      assert.deepEqual(r.drop.map((d) => d.id).sort(), [
        '20260816T074600Z-aaaaaa',
        '20260816T074600Z-zzzzzz',
      ], p.join(','));
    }
  });

  test('KNOWN-DEFECT: 重复 id 不去重，同名备份既占两个名额又互相顶替保护', () => {
    // backupManifest.js:247-269 walks rows without deduping, so a caller that lists the
    // same directory twice (or a retry that appends) inflates completeRank and pushes a
    // legitimate backup out of the keep window, while `keep` gains a duplicate id that
    // backupService's pruning loop would try to delete twice.
    const nowMs = Date.parse('2026-12-01T00:00:00Z');
    const r = planRetention([
      { id: '20260816T074600Z-aaaaaa', complete: true },
      { id: '20260816T074600Z-aaaaaa', complete: true },
      { id: '20260810T074600Z-bbbbbb', complete: true },
    ], { keepCount: 1, keepDays: 1, nowMs });
    assert.deepEqual(r.keep, ['20260816T074600Z-aaaaaa', '20260816T074600Z-aaaaaa']);
    assert.deepEqual(r.drop, [{ id: '20260810T074600Z-bbbbbb', reason: '超出保留份数(第 3 份 > 1)且早于 1 天' }]);
  });

  test('KNOWN-DEFECT: 求解异常时的「一份都不删」兜底自身会抛穿', () => {
    // backupManifest.js:273 re-runs the very `String((s && s.id) || '')` that threw inside
    // the map at :236, so a hostile/duplex id value escapes the catch and the whole prune
    // call dies instead of returning the documented fail-safe "keep everything".
    assert.throws(() => planRetention([{ id: { toString() { throw new Error('boom'); } }, complete: true }], {}), /boom/);
    assert.deepEqual(planRetention([{ id: VALID_ID, complete: true }], null), { keep: [VALID_ID], drop: [] });
  });

  test('nowMs 落在过去时不早于天数闸门，时钟倒挂不会误删', () => {
    const sets = [
      { id: '20260816T074600Z-aaaaaa', complete: true },
      { id: '20260110T074600Z-bbbbbb', complete: true },
    ];
    const r = planRetention(sets, { keepCount: 1, keepDays: 1, nowMs: Date.parse('2025-01-01T00:00:00Z') });
    assert.deepEqual(r.keep, ['20260816T074600Z-aaaaaa', '20260110T074600Z-bbbbbb']);
    assert.deepEqual(r.drop, []);
    assert.deepEqual(planRetention(sets, { keepCount: 1, keepDays: 1, nowMs: -1 }).drop, []);
    assert.deepEqual(planRetention(sets, { keepCount: NaN, keepDays: Infinity, nowMs: Date.now() }).drop, []);
  });
});
