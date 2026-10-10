'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  COLD_SUBDIR,
  EXPORTABLE_EXTS,
  exportColdDir,
  readColdArchive,
  expandColdArchive,
  _isExportableFile,
  _listFlowFiles,
  _readRecords,
} = require('./coldExportService.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T00:00:00Z');
const BACKSLASH = String.fromCharCode(92);

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

function writeFlow(dir, name, lines) {
  const abs = path.join(dir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${lines.join('\n')}\n`, 'utf8');
  return abs;
}

function coldRecord(ageDays, extra = {}) {
  return JSON.stringify({ ts: NOW - ageDays * DAY, actor: 'u1', ...extra });
}

function makeColdDir(name, files = {}) {
  const dir = tmpJoin(name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) writeFlow(dir, file, lines);
  return dir;
}

describe('导出白名单与流水读取', () => {
  test('白名单只有行式两种后缀且被冻结，.json/.log/.db 一概不碰', () => {
    assert.deepEqual([...EXPORTABLE_EXTS], ['.jsonl', '.ndjson']);
    assert.equal(Object.isFrozen(EXPORTABLE_EXTS), true);
    assert.throws(() => EXPORTABLE_EXTS.push('.json'), TypeError);
    assert.equal(COLD_SUBDIR, 'cold');
  });

  test('后缀判定取最后一个点，点开头文件与复合后缀都不收', () => {
    assert.equal(_isExportableFile('audit.jsonl'), true);
    assert.equal(_isExportableFile('AUDIT.NDJSON'), true);
    assert.equal(_isExportableFile('  a.jsonl  '), false);
    assert.equal(_isExportableFile('a.json'), false);
    assert.equal(_isExportableFile('a.log'), false);
    assert.equal(_isExportableFile('taskboard.db'), false);
    assert.equal(_isExportableFile('a.jsonl.gz'), false);
    assert.equal(_isExportableFile('.jsonl'), false, 'a leading dot makes it a dotfile, not a flow');
    assert.equal(_isExportableFile('ndjson'), false);
    assert.equal(_isExportableFile(''), false);
    for (const junk of [null, undefined, 0, NaN, {}, [], true]) {
      assert.equal(_isExportableFile(junk), false, JSON.stringify(junk));
    }
  });

  test('递归列出可导出文件并按相对路径排序（同一目录两次枚举同序）', () => {
    const dir = makeColdDir('walk', {
      'z.jsonl': [coldRecord(90)],
      'a.ndjson': [coldRecord(80)],
      'nested/deep/b.jsonl': [coldRecord(70)],
      'nested/skip.json': ['{"a":1}'],
      'nested/also.db': ['not text'],
    });
    assert.deepEqual(_listFlowFiles(dir), ['a.ndjson', 'nested/deep/b.jsonl', 'z.jsonl']);
    assert.deepEqual(_listFlowFiles(dir), _listFlowFiles(dir));
    assert.deepEqual(_listFlowFiles(tmpJoin('no-such-dir')), []);
    assert.deepEqual(_listFlowFiles(path.join(dir, 'nested', 'skip.json')), []);
  });

  test('目录里的 *.json 幽灵目录（dataHome 误用产物）不会被当文件收', () => {
    const dir = tmpJoin('phantom');
    fs.mkdirSync(path.join(dir, 'api_keys.json'), { recursive: true });
    writeFlow(dir, 'audit.jsonl', [coldRecord(60)]);
    assert.deepEqual(_listFlowFiles(dir), ['audit.jsonl']);
  });

  test('JSONL 逐行解析，坏行原样留成 _raw 而不是被悄悄吃掉', () => {
    const file = tmpJoin('mixed.jsonl');
    fs.writeFileSync(file, `${'{"ts":1}'}\n\n  ${'{"ts":2}'}  \nnot json at all\n{broken\n`);
    assert.deepEqual(_readRecords(file), [
      { ts: 1 },
      { ts: 2 },
      { _raw: 'not json at all' },
      { _raw: '{broken' },
    ]);
  });

  test('顶层数组与顶层单对象整份解析，退回逐行不误判', () => {
    const arr = tmpJoin('arr.jsonl');
    fs.writeFileSync(arr, '[{"ts":1},{"ts":2}]\n');
    assert.deepEqual(_readRecords(arr), [{ ts: 1 }, { ts: 2 }]);
    const obj = tmpJoin('obj.ndjson');
    fs.writeFileSync(obj, '{"ts":9}\n');
    assert.deepEqual(_readRecords(obj), [{ ts: 9 }]);
    // A JSONL file whose first character is '[' but is not valid JSON falls back to lines.
    const half = tmpJoin('half.jsonl');
    fs.writeFileSync(half, '[{"ts":1}\n{"ts":2}\n');
    assert.deepEqual(_readRecords(half), [{ _raw: '[{"ts":1}' }, { ts: 2 }]);
  });

  test('空文件给空数组，读不到的文件给 null（调用方据此不收）', () => {
    const empty = tmpJoin('empty.jsonl');
    fs.writeFileSync(empty, '   \n\n');
    assert.deepEqual(_readRecords(empty), []);
    assert.equal(_readRecords(tmpJoin('missing.jsonl')), null);
    assert.equal(_readRecords(tmpJoin('walk')), null, 'a directory is not readable as text');
    assert.equal(_readRecords(''), null);
    assert.equal(_readRecords(null), null);
  });
});

describe('exportColdDir：按窗口封存冷流水', () => {
  test('全冷目录导出：归档落地、记账齐全、coveredFiles 列出被折叠的文件', () => {
    const src = makeColdDir('audit', {
      'day1.jsonl': [coldRecord(90), coldRecord(89)],
      'nested/day2.ndjson': [coldRecord(120)],
    });
    const set = tmpJoin('setA');
    const r = exportColdDir({ sourceDir: src, setDir: set, role: 'user', dirName: 'audit', nowMs: NOW, windowDays: 30 });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.exported, true);
    assert.equal(r.error, null);
    assert.equal(r.target, `${COLD_SUBDIR}/user-audit.jsonl.gz`);
    assert.equal(r.records, 3);
    assert.equal(r.sourceFiles, 2);
    assert.equal(r.skippedRecent, 0);
    assert.deepEqual(r.coveredFiles, ['day1.jsonl', 'nested/day2.ndjson']);
    assert.equal(/^[0-9a-f]{64}$/.test(r.sha256), true);
    assert.equal(r.bytes, fs.statSync(path.join(set, COLD_SUBDIR, 'user-audit.jsonl.gz')).size);
    const back = readColdArchive(path.join(set, COLD_SUBDIR, 'user-audit.jsonl.gz'));
    assert.equal(back.ok, true);
    assert.deepEqual(back.records.map((x) => x._source), ['day1.jsonl', 'day1.jsonl', 'nested/day2.ndjson']);
  });

  test('同一份数据两次导出字节完全相同（排序刻意，sha 才有比对价值）', () => {
    const src = makeColdDir('det', { 'b.jsonl': [coldRecord(70)], 'a.jsonl': [coldRecord(80)] });
    const r1 = exportColdDir({ sourceDir: src, setDir: tmpJoin('det1'), role: 'user', dirName: 'det', nowMs: NOW, windowDays: 30 });
    const r2 = exportColdDir({ sourceDir: src, setDir: tmpJoin('det2'), role: 'user', dirName: 'det', nowMs: NOW, windowDays: 30 });
    assert.equal(r1.sha256, r2.sha256);
    assert.equal(r1.bytes, r2.bytes);
    assert.deepEqual(r1.coveredFiles, ['a.jsonl', 'b.jsonl']);
  });

  test('文件级覆盖判定：只要有一条热记录，整份都不进归档', () => {
    const src = makeColdDir('hotmix', {
      'cold.jsonl': [coldRecord(60)],
      'mixed.jsonl': [coldRecord(60), coldRecord(1)],
    });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setHot'), role: 'user', dirName: 'hotmix', nowMs: NOW, windowDays: 30 });
    assert.deepEqual(r.coveredFiles, ['cold.jsonl']);
    assert.equal(r.skippedRecent, 1);
    assert.equal(r.records, 1);
    assert.equal(r.sourceFiles, 2);
    const back = readColdArchive(path.join(tmpJoin('setHot'), COLD_SUBDIR, 'user-hotmix.jsonl.gz'));
    assert.deepEqual(back.records.map((x) => x._source), ['cold.jsonl']);
  });

  test('取不到时间戳的记录按冷处理，坏行仍然进归档', () => {
    const src = makeColdDir('norow', { 'weird.jsonl': ['not json', '{"no_ts":true}', '{"at":"2026-08-01T00:00:00Z"}'] });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setNoTs'), role: 'project', dirName: 'norow', nowMs: NOW, windowDays: 30 });
    assert.equal(r.records, 3);
    assert.equal(r.skippedRecent, 0);
    assert.deepEqual(r.coveredFiles, ['weird.jsonl']);
  });

  test('windowDays<=0 表示全收，没有一条记录算热', () => {
    const src = makeColdDir('allcold', { 'today.jsonl': [coldRecord(0)] });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setWin0'), role: 'user', dirName: 'allcold', nowMs: NOW, windowDays: 0 });
    assert.equal(r.records, 1);
    assert.equal(r.skippedRecent, 0);
    assert.deepEqual(r.coveredFiles, ['today.jsonl']);
  });

  test('全热目录不产归档：exported=false、coveredFiles 必须为空', () => {
    const src = makeColdDir('allhot', { 'today.jsonl': [coldRecord(1)] });
    const set = tmpJoin('setAllHot');
    const r = exportColdDir({ sourceDir: src, setDir: set, role: 'user', dirName: 'allhot', nowMs: NOW, windowDays: 30 });
    assert.deepEqual(
      { ok: r.ok, exported: r.exported, records: r.records, coveredFiles: r.coveredFiles, target: r.target, error: r.error },
      { ok: true, exported: false, records: 0, coveredFiles: [], target: '', error: null }
    );
    assert.equal(r.skippedRecent, 1);
    assert.equal(fs.existsSync(path.join(set, COLD_SUBDIR)), false, 'no empty cold/ directory either');
  });

  test('只有空文件 / 只有非白名单文件时同样不产归档', () => {
    const src = tmpJoin('empties');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'zero.jsonl'), '');
    fs.writeFileSync(path.join(src, 'state.json'), '[]');
    fs.writeFileSync(path.join(src, 'run.log'), 'noise');
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setEmpty'), role: 'user', dirName: 'empties', nowMs: NOW, windowDays: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.exported, false);
    assert.equal(r.sourceFiles, 1);
    assert.deepEqual(r.coveredFiles, []);
  });

  test('流水目录不存在算成功跳过，不产目录也不抛', () => {
    const set = tmpJoin('setMissing');
    const r = exportColdDir({ sourceDir: tmpJoin('never-created'), setDir: set, role: 'user', dirName: 'ghost', nowMs: NOW, windowDays: 30 });
    assert.deepEqual(
      { ok: r.ok, exported: r.exported, sourceFiles: r.sourceFiles, error: r.error },
      { ok: true, exported: false, sourceFiles: 0, error: null }
    );
    assert.equal(fs.existsSync(set), false);
  });

  test('三个必填参数各自缺失都给同一条参数错误', () => {
    const src = makeColdDir('params', { 'a.jsonl': [coldRecord(90)] });
    const base = { sourceDir: src, setDir: tmpJoin('setP'), role: 'user', dirName: 'params', nowMs: NOW, windowDays: 30 };
    for (const key of ['sourceDir', 'setDir', 'dirName']) {
      const spec = { ...base, [key]: '' };
      assert.equal(exportColdDir(spec).error, '冷导出参数不完整(sourceDir / setDir / dirName)', key);
      assert.equal(exportColdDir({ ...spec, [key]: undefined }).exported, false, key);
      assert.equal(exportColdDir({ ...spec, [key]: null }).exported, false, key);
    }
    assert.equal(exportColdDir().error, '冷导出参数不完整(sourceDir / setDir / dirName)');
  });

  test('role 缺省给空串（归档名以 - 开头），不影响成功', () => {
    const src = makeColdDir('norole', { 'a.jsonl': [coldRecord(90)] });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setNoRole'), dirName: 'norole', nowMs: NOW, windowDays: 30 });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.target, `${COLD_SUBDIR}/-norole.jsonl.gz`);
    assert.equal(fs.existsSync(path.join(tmpJoin('setNoRole'), COLD_SUBDIR, '-norole.jsonl.gz')), true);
  });

  test('归档目标已存在时拒绝覆盖，既有归档一字节不动', () => {
    const src = makeColdDir('reuse', { 'a.jsonl': [coldRecord(90)] });
    const set = tmpJoin('setReuse');
    const first = exportColdDir({ sourceDir: src, setDir: set, role: 'user', dirName: 'reuse', nowMs: NOW, windowDays: 30 });
    const keep = fs.readFileSync(path.join(set, COLD_SUBDIR, 'user-reuse.jsonl.gz'));
    const second = exportColdDir({ sourceDir: src, setDir: set, role: 'user', dirName: 'reuse', nowMs: NOW, windowDays: 30 });
    assert.equal(first.exported, true);
    assert.equal(second.ok, false);
    assert.equal(second.exported, false);
    assert.match(second.error, /冷归档目标已存在,拒绝覆盖/);
    assert.deepEqual(second.coveredFiles, []);
    assert.deepEqual(fs.readFileSync(path.join(set, COLD_SUBDIR, 'user-reuse.jsonl.gz')), keep);
    assert.equal(fs.existsSync(`${path.join(set, COLD_SUBDIR, 'user-reuse.jsonl.gz')}.tmp-${process.pid}`), false);
  });

  test('spec 为 null（JSON 传参）时给结构化错误而不是抛穿', () => {
    assert.deepEqual(exportColdDir(null).error, "Cannot read properties of null (reading 'sourceDir')");
    assert.equal(exportColdDir(null).ok, false);
    assert.equal(exportColdDir(null).coveredFiles.length, 0);
  });

  test('nowMs 缺省用当前时间，字符串入参照样参与窗口判定', () => {
    const src = makeColdDir('clock', { 'old.jsonl': [JSON.stringify({ ts: NOW - 400 * DAY })], 'new.jsonl': [JSON.stringify({ ts: NOW + 400 * DAY })] });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setClock'), role: 'user', dirName: 'clock', nowMs: String(NOW), windowDays: '30' });
    assert.deepEqual(r.coveredFiles, ['old.jsonl']);
    assert.equal(r.skippedRecent, 1);
    const fallback = exportColdDir({ sourceDir: makeColdDir('clock2', { 'a.jsonl': ['{"ts":1000}'] }), setDir: tmpJoin('setClock2'), role: 'user', dirName: 'clock2', windowDays: 30 });
    assert.deepEqual(fallback.coveredFiles, ['a.jsonl']);
    assert.equal(fallback.records, 1);
  });

  test('KNOWN-DEFECT: 记录自带 _source 时覆盖归档的来源标记，恢复端把记录写进别的文件', () => {
    // coldExportService.js:259 `JSON.stringify({ _source: _posix(rel), ...record })` spreads
    // the record *after* the provenance field, so an audit line that happens to carry its own
    // `_source` (a real shape: khy writes records copied from other subsystems) rewrites the
    // pointer. coveredFiles still claims the whole file was archived, so the caller stops
    // copying it and expandColdArchive recreates a *different* file — the original silently
    // disappears from the restored home directory.
    const src = makeColdDir('spoof', {
      'a.jsonl': [coldRecord(90, { _source: 'evil.jsonl' }), coldRecord(91)],
    });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setSpoof'), role: 'user', dirName: 'spoof', nowMs: NOW, windowDays: 30 });
    assert.equal(r.records, 2);
    assert.deepEqual(r.coveredFiles, ['a.jsonl']);
    const back = readColdArchive(path.join(tmpJoin('setSpoof'), COLD_SUBDIR, 'user-spoof.jsonl.gz'));
    assert.deepEqual(back.records.map((x) => x._source), ['evil.jsonl', 'a.jsonl']);
    const dest = tmpJoin('destSpoof');
    const e = expandColdArchive({ archiveAbs: path.join(tmpJoin('setSpoof'), COLD_SUBDIR, 'user-spoof.jsonl.gz'), destDir: dest });
    assert.equal(e.ok, true);
    assert.equal(e.files, 2, 'a.jsonl and the invented evil.jsonl');
    assert.deepEqual(fs.readdirSync(dest).sort(), ['a.jsonl', 'evil.jsonl']);
    const rebuilt = fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rebuilt.length, 1, 'coveredFiles promised the whole file, only the un-spoofed line came back');
    assert.equal(JSON.parse(rebuilt[0]).ts, NOW - 91 * DAY);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'evil.jsonl'), 'utf8').trim()).ts, NOW - 90 * DAY);
  });

  test('KNOWN-DEFECT: 标量记录被对象展开吞掉，归档与恢复出来的文件不再是原文件', () => {
    // coldExportService.js:259 spreads every record into an object literal, and spreading a
    // primitive yields nothing (`{...123}` -> {}). A JSONL of scalars is legal flow data, so
    // the archive silently stores `{_source}` shells (and index maps for strings/arrays),
    // records/exported both report success, and expanding rewrites the file as `{}` lines.
    const src = makeColdDir('scalars', { 'n.jsonl': ['1', '"str"', 'true', 'null', '[1,2]'] });
    const r = exportColdDir({ sourceDir: src, setDir: tmpJoin('setScalar'), role: 'user', dirName: 'scalars', nowMs: NOW, windowDays: 30 });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.exported, true);
    assert.equal(r.records, 5);
    assert.deepEqual(r.coveredFiles, ['n.jsonl'], 'the caller is told the whole file is archived');
    const back = readColdArchive(path.join(tmpJoin('setScalar'), COLD_SUBDIR, 'user-scalars.jsonl.gz'));
    assert.deepEqual(back.records, [
      { _source: 'n.jsonl' },
      { '0': 's', '1': 't', '2': 'r', _source: 'n.jsonl' },
      { _source: 'n.jsonl' },
      { _source: 'n.jsonl' },
      { '0': 1, '1': 2, _source: 'n.jsonl' },
    ]);
    const dest = tmpJoin('destScalar');
    expandColdArchive({ archiveAbs: path.join(tmpJoin('setScalar'), COLD_SUBDIR, 'user-scalars.jsonl.gz'), destDir: dest });
    assert.equal(fs.readFileSync(path.join(dest, 'n.jsonl'), 'utf8'), '{}\n{"0":"s","1":"t","2":"r"}\n{}\n{}\n{"0":1,"1":2}\n');
  });

  test('KNOWN-DEFECT: role 里带路径分隔符时归档掉出 cold/ 目录，恢复端根本找不到', () => {
    // coldExportService.js:277 interpolates role/dirName into the target name before
    // path.join normalises it, and :278 joins that onto setDir — so `role` is never
    // sanitised the way expandColdArchive sanitises `_source` (:391). The archive is written
    // outside COLD_SUBDIR while the result still says ok/exported, and restoreService
    // addresses cold archives strictly by the COLD_EXPORT.SUBDIR constant, so the data is
    // backed up but never restorable.
    const src = makeColdDir('escaperole', { 'a.jsonl': [coldRecord(90)] });
    const set = path.join(tmpJoin('setEscape', 'nested'));
    fs.mkdirSync(set, { recursive: true });
    const r = exportColdDir({
      sourceDir: src,
      setDir: set,
      role: `..${path.sep}..${path.sep}escaped`,
      dirName: 'audit',
      nowMs: NOW,
      windowDays: 30,
    });
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.exported, true);
    assert.equal(r.target, '../escaped-audit.jsonl.gz');
    assert.equal(fs.existsSync(path.join(set, COLD_SUBDIR, 'user-audit.jsonl.gz')), false);
    assert.equal(fs.existsSync(path.resolve(set, '..', 'escaped-audit.jsonl.gz')), true);
  });
});

describe('readColdArchive / expandColdArchive：归档读回与摊平', () => {
  const archiveOf = (name, lines) => {
    const abs = tmpJoin(name);
    fs.writeFileSync(abs, zlib.gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
    return abs;
  };

  test('导出再摊回是逐字节往返（含当初解析不了的原始行）', () => {
    const src = makeColdDir('roundtrip', {
      'day.jsonl': ['{"ts":1,"nested":{"a":[1,2]}}', 'not json at all', '{"ts":2}'],
    });
    const set = tmpJoin('setRound');
    const r = exportColdDir({ sourceDir: src, setDir: set, role: 'user', dirName: 'roundtrip', nowMs: 2e12, windowDays: 30 });
    assert.equal(r.exported, true, String(r.error));
    const dest = tmpJoin('destRound');
    const e = expandColdArchive({ archiveAbs: path.join(set, COLD_SUBDIR, 'user-roundtrip.jsonl.gz'), destDir: dest });
    assert.deepEqual({ ok: e.ok, files: e.files, records: e.records, skipped: e.skipped, error: e.error }, {
      ok: true, files: 1, records: 3, skipped: [], error: null,
    });
    assert.equal(fs.readFileSync(path.join(dest, 'day.jsonl'), 'utf8'), fs.readFileSync(path.join(src, 'day.jsonl'), 'utf8'));
  });

  test('保真边界如约：内容无损但行内空白被规范化，键序保持解析顺序', () => {
    const abs = archiveOf('norm.jsonl.gz', [
      JSON.stringify({ _source: 'sp.jsonl', z: 1, a: { b: [1, 2] } }),
      JSON.stringify({ _source: 'sp.jsonl', _raw: '  keep me verbatim  ' }),
    ]);
    const dest = tmpJoin('destNorm');
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true, String(e.error));
    assert.equal(fs.readFileSync(path.join(dest, 'sp.jsonl'), 'utf8'), '{"z":1,"a":{"b":[1,2]}}\n  keep me verbatim  \n');
  });

  test('深层 _source 重建子目录，摊回不留临时文件', () => {
    const abs = archiveOf('deep.jsonl.gz', [
      JSON.stringify({ _source: 'nested/deep/a.ndjson', ts: 1 }),
      JSON.stringify({ _source: 'nested/deep/a.ndjson', ts: 2 }),
      JSON.stringify({ _source: 'b.jsonl', _raw: 'raw line' }),
    ]);
    const dest = tmpJoin('destDeep');
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true, String(e.error));
    assert.equal(e.files, 2);
    assert.equal(e.records, 3);
    assert.equal(fs.readFileSync(path.join(dest, 'nested', 'deep', 'a.ndjson'), 'utf8'), '{"ts":1}\n{"ts":2}\n');
    assert.equal(fs.readFileSync(path.join(dest, 'b.jsonl'), 'utf8'), 'raw line\n');
    assert.deepEqual(_listFlowFiles(dest).sort(), ['b.jsonl', 'nested/deep/a.ndjson']);
    assert.equal(fs.existsSync(`${path.join(dest, 'b.jsonl')}.cold-tmp-${process.pid}`), false);
  });

  test('路径穿越防线拦住 ../ 、绝对路径、空 _source 与 a/../b', () => {
    const abs = archiveOf('traversal.jsonl.gz', [
      JSON.stringify({ _source: '../up.jsonl', ts: 1 }),
      JSON.stringify({ _source: '/abs.jsonl', ts: 1 }),
      JSON.stringify({ _source: 'a/../ok.jsonl', ts: 1 }),
      JSON.stringify({ _source: '', ts: 1 }),
      JSON.stringify({ ts: 1 }),
      '123',
      'totally unparseable line',
    ]);
    const dest = tmpJoin('destTraversal');
    fs.mkdirSync(dest, { recursive: true });
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true);
    assert.equal(e.files, 0);
    assert.equal(e.records, 0);
    assert.deepEqual(e.skipped, [
      { path: '../up.jsonl', reason: '非法或缺失的 _source' },
      { path: '/abs.jsonl', reason: '非法或缺失的 _source' },
      { path: 'a/../ok.jsonl', reason: '非法或缺失的 _source' },
      { path: '(空)', reason: '非法或缺失的 _source' },
      { path: '(空)', reason: '非法或缺失的 _source' },
      { path: '(空)', reason: '非法或缺失的 _source' },
      { path: '(空)', reason: '非法或缺失的 _source' },
    ]);
    assert.equal(fs.readdirSync(dest).length, 0);
  });

  test('KNOWN-DEFECT: 穿越防线只按正斜杠拆段，Windows 上反斜杠 _source 直接写到 destDir 之外', () => {
    // coldExportService.js:391 splits on '/' only and path.isAbsolute() does not recognise a
    // relative `..\x` segment, while :409 re-joins with path.sep. On Windows (the shipped
    // platform) a crafted archive therefore writes straight over files outside the restore
    // target — the exact hole the guard at :390 claims to close.
    const abs = archiveOf('bs.jsonl.gz', [JSON.stringify({ _source: `..${BACKSLASH}pwned.jsonl`, ts: 1 })]);
    const dest = path.join(tmpJoin('destBs'), 'inner');
    fs.mkdirSync(dest, { recursive: true });
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true);
    assert.equal(e.files, 1);
    assert.deepEqual(e.skipped, []);
    if (path.sep === BACKSLASH) {
      assert.equal(fs.existsSync(path.join(tmpJoin('destBs'), 'pwned.jsonl')), true);
      assert.deepEqual(fs.readdirSync(dest), [], 'destDir itself stayed empty — the write went out of bounds');
    } else {
      assert.equal(fs.existsSync(path.join(dest, `..${BACKSLASH}pwned.jsonl`)), true);
      assert.equal(fs.existsSync(path.join(tmpJoin('destBs'), 'pwned.jsonl')), false);
    }
  });

  test('KNOWN-DEFECT: 每一条写回都失败时仍然返回 ok:true，调用方看到的是成功', () => {
    // coldExportService.js:418-422 records the failure in `skipped` but :434 sets ok
    // unconditionally, so `restoreService` counts a cold archive as restored while zero
    // files were written. Here destDir/<blocker> is a regular file, so mkdirSync of the
    // nested path fails for every record.
    const abs = archiveOf('blocked.jsonl.gz', [
      JSON.stringify({ _source: 'blocker/inner.jsonl', ts: 1 }),
      JSON.stringify({ _source: 'blocker/inner2.jsonl', ts: 2 }),
    ]);
    const dest = tmpJoin('destBlocked');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'blocker'), 'I am a file, not a directory');
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true, 'the contract says ok even though nothing was written');
    assert.equal(e.files, 0);
    assert.equal(e.records, 2);
    assert.equal(e.skipped.length, 2);
    assert.match(e.skipped[0].reason, /^写回失败: /);
    assert.equal(e.error, null);
  });

  test('KNOWN-DEFECT: _raw 不是字符串时被 String() 成对象字面量文本，恢复出当初不存在的内容', () => {
    // coldExportService.js:400 `String(rest._raw)` — a hand-crafted (or truncated/corrupted)
    // archive whose _raw is an object yields "[object Object]" in the rebuilt flow file while
    // the header (:355-358) promises _raw lines are written back "一个字符不动".
    const abs = archiveOf('rawobj.jsonl.gz', [
      JSON.stringify({ _source: 'o.jsonl', _raw: { a: 1 } }),
      JSON.stringify({ _source: 'o.jsonl', _raw: 42 }),
      JSON.stringify({ _source: 'o.jsonl', _raw: null }),
    ]);
    const dest = tmpJoin('destRawObj');
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true);
    assert.equal(fs.readFileSync(path.join(dest, 'o.jsonl'), 'utf8'), '[object Object]\n42\nnull\n');
  });

  test('摊平阶段跳过 _source 非法的记录，但 JSON 结构本身仍然算读成功', () => {
    const abs = archiveOf('shapes.jsonl.gz', [
      JSON.stringify([1, 2]),
      JSON.stringify('plain string'),
      JSON.stringify(null),
      JSON.stringify({ _source: 'good.jsonl', ts: 1 }),
    ]);
    const dest = tmpJoin('destShapes');
    const e = expandColdArchive({ archiveAbs: abs, destDir: dest });
    assert.equal(e.ok, true);
    assert.equal(e.records, 1);
    assert.equal(e.files, 1);
    assert.equal(e.skipped.length, 3);
    assert.equal(fs.readFileSync(path.join(dest, 'good.jsonl'), 'utf8'), '{"ts":1}\n');
  });

  test('destDir 缺失 / 归档读不到 / spec 为 null 都给结构化失败', () => {
    assert.deepEqual(expandColdArchive({ destDir: '' }), { ok: false, files: 0, records: 0, skipped: [], error: '冷归档摊回参数不完整(destDir)' });
    const missing = expandColdArchive({ archiveAbs: tmpJoin('nope.jsonl.gz'), destDir: tmpJoin('destMissing') });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /冷归档读取失败: /);
    const nullSpec = expandColdArchive(null);
    assert.equal(nullSpec.ok, false);
    assert.equal(nullSpec.error, "Cannot read properties of null (reading 'destDir')");
  });

  test('读回归档：gzip 之外的字节、目录、空串都是结构化错误而不是抛穿', () => {
    const notGzip = tmpJoin('notgzip.jsonl.gz');
    fs.writeFileSync(notGzip, 'plain text, not gzip');
    assert.equal(readColdArchive(notGzip).ok, false);
    assert.equal(Array.isArray(readColdArchive(notGzip).records), true);
    assert.equal(readColdArchive(tmpJoin('walk')).ok, false, 'a directory is not an archive');
    assert.equal(readColdArchive('').ok, false);
    assert.equal(readColdArchive(null).ok, false);
    assert.equal(readColdArchive(undefined).ok, false);
    assert.equal(readColdArchive(tmpJoin('nothing-here.gz')).ok, false);
    assert.match(readColdArchive(notGzip).error, /.+/);
  });

  test('空归档读回 0 条记录仍算 ok，摊平则是 0 文件 0 记录', () => {
    const abs = archiveOf('zero.jsonl.gz', []);
    const read = readColdArchive(abs);
    assert.deepEqual(read, { ok: true, records: [], error: null });
    const e = expandColdArchive({ archiveAbs: abs, destDir: tmpJoin('destZero') });
    assert.deepEqual({ ok: e.ok, files: e.files, records: e.records, skipped: e.skipped }, { ok: true, files: 0, records: 0, skipped: [] });
  });

  test('归档里读不懂的行按 _raw 返回，verify 端不会因此判失败', () => {
    const abs = archiveOf('rawrows.jsonl.gz', ['{"ts":1}', 'corrupted line', '']);
    const read = readColdArchive(abs);
    assert.equal(read.ok, true);
    assert.deepEqual(read.records, [{ ts: 1 }, { _raw: 'corrupted line' }]);
  });

  test('exportColdDir 与 readColdArchive 的字节口径一致：bytes 就是 gzip 文件长度', () => {
    const src = makeColdDir('bytesmatch', { 'a.jsonl': [coldRecord(200)] });
    const set = tmpJoin('setBytes');
    const r = exportColdDir({ sourceDir: src, setDir: set, role: 'user', dirName: 'bytesmatch', nowMs: NOW, windowDays: 30 });
    const abs = path.join(set, COLD_SUBDIR, 'user-bytesmatch.jsonl.gz');
    const buf = fs.readFileSync(abs);
    assert.equal(r.bytes, buf.length);
    assert.equal(r.sha256.length, 64);
    assert.equal(r.target.split('/')[0], COLD_SUBDIR);
  });
});
