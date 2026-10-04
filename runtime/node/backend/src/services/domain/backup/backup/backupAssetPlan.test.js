'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const plan = require('./backupAssetPlan.js');

const {
  TIER_CORE,
  TIER_FULL,
  TIERS,
  HOMES,
  SQLITE_ASSETS,
  normalizeTier,
  tierIncludes,
  isPhantomJsonDir,
  classifyDir,
  classifyFile,
  classifyColdDir,
  recordTimeMs,
  withinColdWindow,
  restoreHints,
} = plan;

const DAY = 24 * 60 * 60 * 1000;

describe('分级与家目录角色常量', () => {
  test('两档两级、三角色，且都是冻结数组', () => {
    assert.deepEqual([TIER_CORE, TIER_FULL], ['core', 'full']);
    assert.deepEqual([...TIERS], ['core', 'full']);
    assert.deepEqual([...HOMES], ['user', 'project', 'app']);
    assert.equal(Object.isFrozen(TIERS), true);
    assert.equal(Object.isFrozen(HOMES), true);
    assert.throws(() => TIERS.push('archive'), TypeError);
  });

  test('SQLite 资产清单逐条冻结且 rel 用平台分隔符拼接', () => {
    assert.equal(SQLITE_ASSETS.length, 2);
    assert.equal(SQLITE_ASSETS[0].rel, path.join('khyquant', 'data', 'khy-quant.db'));
    assert.equal(SQLITE_ASSETS[1].rel, 'taskboard.db');
    assert.equal(Object.isFrozen(SQLITE_ASSETS), true);
    assert.equal(Object.isFrozen(SQLITE_ASSETS[0]), true);
    assert.throws(() => {
      SQLITE_ASSETS[0].required = true;
    }, TypeError);
    assert.equal(
      SQLITE_ASSETS.every((a) => a.required === false && typeof a.label === 'string'),
      true
    );
  });

  test('sessions.db 不在资产清单里——它是可重建的派生副本', () => {
    assert.equal(
      SQLITE_ASSETS.some((a) => String(a.rel).includes('sessions')),
      false
    );
    assert.equal(
      restoreHints().some((h) => h.kind === 'reindex' && h.target === 'sessions.db'),
      true
    );
  });
});

describe('normalizeTier / tierIncludes', () => {
  test('大小写与空白被归一，未知值一律落 core', () => {
    assert.equal(normalizeTier('FULL'), 'full');
    assert.equal(normalizeTier('  Core  '), 'core');
    for (const junk of [null, undefined, '', 0, -1, NaN, {}, [], 'archive', '增量', true, Symbol('core')]) {
      assert.equal(normalizeTier(junk), 'core', String(junk));
    }
  });

  test('full 覆盖 core，core 不覆盖 full，同名互相覆盖', () => {
    assert.equal(tierIncludes('full', 'core'), true);
    assert.equal(tierIncludes('core', 'full'), false);
    assert.equal(tierIncludes('core', 'core'), true);
    assert.equal(tierIncludes('full', 'full'), true);
    assert.equal(tierIncludes('bogus', 'bogus'), true);
    assert.equal(tierIncludes('bogus', 'core'), true);
    assert.equal(tierIncludes('bogus', 'full'), false);
  });
});

describe('classifyDir 目录剪枝', () => {
  test('空名 / 点 / 点点目录剪掉，普通状态目录收录', () => {
    assert.deepEqual(classifyDir('', 'core'), { prune: true, reason: '非法目录名' });
    assert.deepEqual(classifyDir('.', 'core'), { prune: true, reason: '非法目录名' });
    assert.deepEqual(classifyDir('..', 'core'), { prune: true, reason: '非法目录名' });
    assert.deepEqual(classifyDir('memory', 'core'), { prune: false, reason: '' });
    assert.deepEqual(classifyDir('.hidden', 'core'), { prune: false, reason: '' });
  });

  test('幽灵 *.json 目录被识别并剪掉，大小写后缀同判', () => {
    assert.equal(isPhantomJsonDir('api_keys.json'), true);
    assert.equal(isPhantomJsonDir('SKILLS_CACHE.JSON'), true);
    assert.equal(isPhantomJsonDir('a.json.bak'), false);
    assert.equal(isPhantomJsonDir('.json'), true);
    assert.equal(isPhantomJsonDir(null), false);
    assert.equal(isPhantomJsonDir(undefined), false);
    assert.equal(isPhantomJsonDir(''), false);
    assert.equal(isPhantomJsonDir(0), false);
    assert.match(classifyDir('api_keys.json', 'full').reason, /幽灵/);
  });

  test('硬排除目录与 full-only 目录按分级分档', () => {
    assert.equal(classifyDir('logs', 'full').prune, true);
    assert.equal(classifyDir('node_modules', 'full').reason, '依赖,非状态');
    assert.equal(classifyDir('cache', 'core').prune, true);
    assert.equal(classifyDir('audit', 'core').prune, true);
    assert.equal(classifyDir('audit', 'full').prune, false);
    assert.equal(classifyDir('cognitive_snapshots', 'core').prune, true);
    assert.equal(classifyDir('cognitive_snapshots', 'full').prune, false);
  });

  test('非法 tier 落 core，因而 full-only 目录照样被剪', () => {
    assert.equal(classifyDir('receipts', 'bogus').prune, true);
    assert.equal(classifyDir('receipts', undefined).prune, true);
    assert.equal(classifyDir('receipts', 'FULL').prune, false);
  });

  test('垃圾目录名（null / 数字 / 对象 / 符号 / 超长串）都不抛且给出结构化结论', () => {
    for (const junk of [null, undefined, 0, -1, NaN, {}, [], Symbol('x'), 'd'.repeat(5000)]) {
      const r = classifyDir(junk, 'core');
      assert.equal(typeof r.prune, 'boolean', String(junk));
      assert.equal('reason' in r, true);
    }
    assert.equal(classifyDir(0, 'core').prune, false);
    assert.equal(classifyDir(null, 'core').reason, '非法目录名');
  });

  test('KNOWN-DEFECT: 排除表按原型链取值，名为 constructor 的目录被剪且 reason 是函数对象', () => {
    // backupAssetPlan.js:267 (`EXCLUDED_DIR_REASONS[n]`) is an unguarded plain-object
    // lookup, so a directory literally named `constructor` / `toString` / `hasOwnProperty`
    // hits Object.prototype. The returned reason is a Function: JSON.stringify drops it,
    // so manifest.excluded records "pruned" with no explanation at all — the exact
    // "沉默" this module's header (line 8-10) exists to prevent.
    const r = classifyDir('constructor', 'core');
    assert.equal(r.prune, true);
    assert.equal(typeof r.reason, 'function');
    assert.equal(JSON.stringify({ excluded: [r] }), '{"excluded":[{"prune":true}]}');
    assert.equal(typeof classifyDir('toString', 'full').reason, 'function');
    assert.equal(classifyDir('hasOwnProperty', 'full').prune, true);
    // A legitimately-named state directory is never affected:
    assert.equal(classifyDir('value', 'full').prune, false);
  });
});

describe('classifyFile 文件收录', () => {
  test('空文件名拒绝，普通 JSON 收录', () => {
    assert.deepEqual(classifyFile('', 'core'), { include: false, reason: '非法文件名' });
    assert.deepEqual(classifyFile(null, 'core'), { include: false, reason: '非法文件名' });
    assert.deepEqual(classifyFile('config.json', 'core'), { include: true, reason: '' });
    assert.deepEqual(classifyFile(undefined, 'full'), { include: false, reason: '非法文件名' });
  });

  test('SQLite 与其边车一律排除，理由是 hot-copy-only', () => {
    for (const n of ['sessions.db', 'khy-quant.SQLITE', 'taskboard.sqlite3']) {
      assert.deepEqual(classifyFile(n, 'full'), { include: false, reason: 'sqlite:hot-copy-only' });
    }
    for (const n of ['a.db-wal', 'a.db-shm', 'a.db-journal', 'a.sqlite-wal']) {
      assert.equal(classifyFile(n, 'full').reason, 'sqlite:hot-copy-only');
    }
  });

  test('日志 / PID / 锁 / 临时原子的产物被排除', () => {
    assert.equal(classifyFile('app.log', 'full').reason, '日志,非状态');
    assert.equal(classifyFile('daemon.PID', 'full').reason, '进程 PID');
    assert.equal(classifyFile('x.lock', 'full').reason, '锁文件,运行期');
    assert.equal(classifyFile('.tmp-abc', 'full').reason, '临时文件');
    assert.equal(classifyFile('manifest.json.tmp-4242', 'full').reason, '临时文件(原子写残留)');
    assert.equal(classifyFile('.restore-tmp-x', 'full').reason, '恢复临时文件');
  });

  test('具名排除清单命中并给出可读理由', () => {
    assert.equal(classifyFile('integrity_manifest.json', 'full').reason, '安装完整性清单,派生物,可重新生成');
    assert.equal(classifyFile('hw_probe_cache.json', 'full').reason, '硬件探针缓存');
    assert.equal(classifyFile('daemon.pid', 'full').reason, '进程 PID,恢复到别的机器上是错的');
    assert.equal(classifyFile('.install-ledger.jsonl', 'full').reason, '安装副作用台账,归 khy uninstall 域,恢复进另一次安装是错的');
    assert.equal(classifyFile('ai_manage_runtime.json', 'full').reason, '守护进程运行期端口,重启即变');
  });

  test('full-only 文件在 core 级被剪、full 级收录', () => {
    assert.equal(classifyFile('audit.jsonl', 'core').include, false);
    assert.equal(classifyFile('audit.jsonl', 'core').reason, '审计流水,core 级不收');
    assert.deepEqual(classifyFile('audit.jsonl', 'full'), { include: true, reason: '' });
  });

  test('硬排除优先于模式排除，模式排除优先于 full-only 判定', () => {
    // `daemon.pid` is in both the exact-name table and the *.pid pattern; the table wins.
    assert.equal(classifyFile('daemon.pid', 'core').reason, '进程 PID,恢复到别的机器上是错的');
    // A *.log file inside a full-only name would still be caught by the pattern first.
    assert.equal(classifyFile('audit.jsonl.log', 'full').reason, '日志,非状态');
  });

  test('KNOWN-DEFECT: 文件名查表同样走原型链，名为 valueOf 的状态文件被判排除且理由不可序列化', () => {
    // backupAssetPlan.js:289 (`EXCLUDED_FILE_REASONS[n]`) — a legitimate state file
    // named `valueOf` / `constructor` is excluded with a Function as its reason, so the
    // manifest loses both the file and the explanation.
    const r = classifyFile('valueOf', 'full');
    assert.equal(r.include, false);
    assert.equal(typeof r.reason, 'function');
    assert.equal(JSON.stringify(r), '{"include":false}');
    assert.equal(typeof classifyFile('constructor', 'full').reason, 'function');
    assert.equal(classifyFile('hasOwnProperty', 'core').include, false);
  });

  test('KNOWN-DEFECT: __proto__ 作为文件名走原型链，排除理由是不可读的原型对象', () => {
    // backupAssetPlan.js:289 (`EXCLUDED_FILE_REASONS[n]`) — the plain-object lookup
    // walks the prototype chain, so `__proto__` resolves to Object.prototype (truthy).
    // The header (line 32-33) promises "排除并给出理由"; here the reason is an object,
    // which the manifest serialises as the useless literal `{}` (JSON.stringify keeps
    // it because it is an object, not undefined — so the reader sees an empty reason
    // instead of a real explanation). Same shape at :267 for directories.
    const r = classifyFile('__proto__', 'core');
    assert.equal(r.include, false);
    assert.equal(r.reason, Object.prototype);
    assert.equal(typeof r.reason, 'object');
    assert.equal(JSON.stringify(r), '{"include":false,"reason":{}}');
    const d = classifyDir('__proto__', 'core');
    assert.equal(d.prune, true);
    assert.equal(d.reason, Object.prototype);
  });
});

describe('冷导出判定', () => {
  test('未启用冷导出时 classifyColdDir 恒为 not-cold，既有分级原样生效', () => {
    assert.deepEqual(classifyColdDir('audit', false), { cold: false, reason: '' });
    assert.deepEqual(classifyColdDir('audit', undefined), { cold: false, reason: '' });
    assert.deepEqual(classifyColdDir('audit', 0), { cold: false, reason: '' });
  });

  test('启用后冷目录命中并附中文理由，非冷目录与垃圾输入不冷', () => {
    assert.equal(classifyColdDir('audit', true).cold, true);
    assert.match(classifyColdDir('receipts', true).reason, /只增不改/);
    for (const n of ['AUDIT', '  events  ']) {
      assert.equal(classifyColdDir(n, true).cold, true, n);
    }
    for (const junk of [null, undefined, '', 'memory', 0, {}, []]) {
      assert.equal(classifyColdDir(junk, true).cold, false, JSON.stringify(junk));
    }
  });

  test('KNOWN-DEFECT: classifyColdDir 也走原型链，名为 __proto__ / Constructor 的目录被当成冷目录归档', () => {
    // backupAssetPlan.js:185 (`COLD_EXPORT_DIR_REASONS[n]`) → cold=true with a non-string
    // reason. The name is lowercased first (:184), which masks `toString` but not
    // `__proto__` nor any case variant of an Object.prototype key such as `Constructor`.
    // A cold-marked directory is then archived by coldExportService and dropped from the
    // per-file copy list, so a directory literally named `__proto__` is exported away on
    // the strength of a prototype hit rather than a real business rule.
    assert.equal(classifyColdDir('toString', true).cold, false);
    const r = classifyColdDir('__proto__', true);
    assert.equal(r.cold, true);
    assert.equal(r.reason, Object.prototype);
    assert.equal(JSON.stringify(r), '{"cold":true,"reason":{}}');
    const c = classifyColdDir('Constructor', true);
    assert.equal(c.cold, true);
    assert.equal(typeof c.reason, 'function');
    assert.equal(JSON.stringify(c), '{"cold":true}');
    assert.equal(classifyColdDir('hasOwnProperty', true).cold, false);
  });

  test('recordTimeMs 逐字段取时间戳，秒级自动升毫秒，取不到给 NaN', () => {
    const ms = 1_700_000_000_000;
    assert.equal(recordTimeMs({ ts: ms }), ms);
    assert.equal(recordTimeMs({ ts: 1_700_000_000 }), ms);
    assert.equal(recordTimeMs({ timestamp: 1_700_000_000 }), ms);
    assert.equal(recordTimeMs({ created_at: 1_700_000_000 }), ms);
    assert.equal(recordTimeMs({ at: 1_700_000_000 }), ms);
    assert.equal(recordTimeMs({ date: '2026-01-02T03:04:05Z' }), Date.parse('2026-01-02T03:04:05Z'));
    assert.equal(recordTimeMs({ ts: '2026-01-02T03:04:05Z' }), Date.parse('2026-01-02T03:04:05Z'));
    // 字段优先级：ts 先命中即返回，后面的更晚时间戳被忽略
    assert.equal(recordTimeMs({ ts: 100, timestamp: ms }), 100000);
  });

  test('recordTimeMs 对非对象 / nullish / 垃圾值给 NaN，绝不抛', () => {
    for (const junk of [null, undefined, 0, '', 'x', [], NaN, -1, 1e21, true]) {
      assert.equal(Number.isNaN(recordTimeMs(junk)), true, JSON.stringify(junk));
    }
    const circular = { ts: 1 };
    circular.self = circular;
    assert.equal(recordTimeMs(circular), 1000);
  });

  test('KNOWN-DEFECT: recordTimeMs 的 key in record 查原型链，继承来的 ts 被当作记录自带时间戳', () => {
    // backupAssetPlan.js:132 uses `key in record` instead of hasOwnProperty, so an
    // object built on a prototype carrying `ts` gets stamped with the prototype's time
    // and can be silently judged cold and archived away.
    const base = { ts: 1 };
    const record = Object.create(base);
    assert.equal(Object.keys(record).length, 0);
    assert.equal(recordTimeMs(record), 1000);
  });

  test('withinColdWindow：窗口为 0 / 负 / 非有限时全收，时间不可判定时留下', () => {
    const now = 1_800_000_000_000;
    assert.equal(withinColdWindow(now - 400 * DAY, now, 30), true);
    assert.equal(withinColdWindow(now - DAY, now, 30), false);
    assert.equal(withinColdWindow(NaN, now, 30), true);
    assert.equal(withinColdWindow(now, now, 0), true);
    assert.equal(withinColdWindow(now, now, -5), true);
    assert.equal(withinColdWindow(now, now, '30'), false);
    assert.equal(withinColdWindow(now - 100 * DAY, now, '30'), true);
    assert.equal(withinColdWindow(now - 5 * DAY, now, '30'), false);
    assert.equal(withinColdWindow(now - 100 * DAY, '1800000000000', 30), true);
    assert.equal(withinColdWindow(now - 100 * DAY, 'abc', 30), true);
    assert.equal(withinColdWindow(now - 100 * DAY, NaN, 30), true);
    assert.equal(withinColdWindow(now - 100 * DAY, 0, 30), true);
  });

  test('withinColdWindow 边界是严格大于，恰好等于窗口天数的记录留在热区', () => {
    const now = 10 * 365 * DAY;
    assert.equal(withinColdWindow(now - 30 * DAY, now, 30), false);
    assert.equal(withinColdWindow(now - 30 * DAY - 1, now, 30), true);
  });

  test('KNOWN-DEFECT: withinColdWindow 把负的 nowMs 当成「不设窗口」，未来/时钟异常时全量归档', () => {
    // backupAssetPlan.js:164-165 collapses any now <= 0 to "keep everything cold",
    // so an injected epoch-0 clock marks every record cold and the whole flow gets
    // archived out of the per-file copy list on the strength of a bogus timestamp.
    assert.equal(withinColdWindow(1, 0, 30), true);
    assert.equal(withinColdWindow(1, -1, 30), true);
    assert.equal(withinColdWindow(1, undefined, 30), true);
    assert.equal(withinColdWindow(1, null, 30), true);
  });

  test('withinColdWindow 对垃圾 windowDays 一律返回 true（等价于全收）', () => {
    const now = 1_800_000_000_000;
    for (const wd of [null, undefined, NaN, 'abc', {}, [], -0, 0, Infinity]) {
      assert.equal(withinColdWindow(now - 1000 * DAY, now, wd), true, String(wd));
    }
  });
});

describe('restoreHints 与全模块「绝不抛」契约', () => {
  test('restoreHints 每次返回全新数组，三条提示顺序与内容稳定', () => {
    const a = restoreHints();
    const b = restoreHints();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((h) => h.kind), ['reindex', 'drop-wal', 'discard']);
    assert.equal(a.length, 3);
    a.push({ kind: 'bogus' });
    assert.equal(restoreHints().length, 3);
  });

  test('KNOWN-DEFECT: 头注释承诺「绝不抛」，但带 throwing toString 的输入会抛穿 classify*', () => {
    // backupAssetPlan.js:32-33 states the contract "零 IO、确定性、绝不抛;未知输入 → 安全默认",
    // yet classifyDir/classifyFile/normalizeTier/isPhantomJsonDir call String(name) with
    // no try/catch (contrast recordTimeMs at :129 and withinColdWindow at :159, which do
    // wrap). A Symbol-with-throwing-toString or a hostile object therefore throws through
    // the whole traversal at backupService.js:203 instead of falling back to the default.
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };
    assert.throws(() => classifyDir(hostile, 'core'), /boom/);
    assert.throws(() => classifyFile(hostile, 'core'), /boom/);
    assert.throws(() => normalizeTier(hostile), /boom/);
    assert.throws(() => isPhantomJsonDir(hostile), /boom/);
    assert.throws(() => tierIncludes(hostile, 'core'), /boom/);
  });

  test('Symbol 入参走 String() 兜底，不抛且按 "Symbol(desc)" 描述串判定', () => {
    // String(Symbol('logs')) is 'Symbol(logs)', not 'logs', so the exact-name tables
    // cannot be bypassed by handing the classifier a symbol description.
    assert.equal(classifyDir(Symbol('logs'), 'core').prune, false);
    assert.equal(classifyFile(Symbol('logs'), 'core').include, true);
    assert.equal(classifyFile(Symbol('x'), 'core').include, true);
    assert.equal(classifyColdDir(Symbol('audit'), true).cold, false);
    assert.equal(isPhantomJsonDir(Symbol('a.json')), false);
    assert.equal(normalizeTier(Symbol('full')), 'core');
  });
});
