'use strict';

/**
 * deliveriesLedgerWiring.test.js — 交付台账接线契约(hci-r47)。
 *
 * 复现源自 .khy/feedback/hci-r47-deliveries-silent/ :DESIGN-ARCH-076 §2.2 的
 * 台账半环整体缺失——`khy deliveries` 无 dispatch(未知命令)、
 * backgroundTaskManager 终态咽喉零入账(recordDelivery 全仓零生产者)、
 * 真实台账文件从未存在。叶子与 handler 的原测试双双被编码损坏隔离成空壳
 * (QUARANTINE),接线零回归网——本文件就是把这张网补回来。
 *
 * 契约面:
 *  T1 handler 自描述 manifest 形状(查询面上线的前提);
 *  T2 commandAutoRegistry 静态发现该命令 + 中文别名可解析(不依赖禁改的 router.js);
 *  T3 咽喉写入点:register→complete/fail/cancel 各落一条台账(真实文件回读);
 *  T4 r46 同族诚实面:--limit 非正整数 / --status 非法值必须打印替换提示,
 *     合法值/缺省路径零噪音(对照组);
 *  T5 manifest.handler 适配层把 parsed.stats 真送进 stats 分支。
 *
 * 全部 IO 经 KHY_DATA_HOME 隔离到临时目录,断言读**真实 jsonl 回读**(非空转)。
 * node --test only。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

const rec = { info: [], error: [], warn: [], success: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: (m) => rec.warn.push(String(m)),
  printTable: () => {},
});

const deliveriesH = require(path.join(SRC, 'cli', 'handlers', 'deliveries.js'));
const { MANIFEST_EXPORT_KEY } = require(path.join(SRC, 'cli', 'commandManifest.js'));
const ledger = require(path.join(SRC, 'services', 'deliveryLedger.js'));
const dataHome = require(path.join(SRC, 'utils', 'dataHome.js'));

const ORIG_DATA_HOME = process.env.KHY_DATA_HOME;
function tempDataHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r47t-${tag}-`));
  process.env.KHY_DATA_HOME = dir;
  dataHome._resetStorageCaches();
  return dir;
}
function restoreDataHome() {
  if (ORIG_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
  else process.env.KHY_DATA_HOME = ORIG_DATA_HOME;
  dataHome._resetStorageCaches();
}

test('T1 manifest 形状:名字/handler/subCommands/别名齐备', () => {
  const mf = deliveriesH[MANIFEST_EXPORT_KEY];
  assert.ok(mf, '缺 manifest 导出(r47 前状态:命令根本不可 dispatch)');
  assert.equal(mf.name, 'deliveries');
  assert.equal(typeof mf.handler, 'function');
  assert.deepEqual(mf.subCommands, ['list', 'stats']);
  for (const a of ['交付', '交付记录', '台账', 'jiaofu']) {
    assert.ok(mf.aliases.includes(a), `缺别名 ${a}`);
  }
});

test('T2 autoRegistry 静态发现命令与中文别名(零改 router.js 上线)', () => {
  const reg = require(path.join(SRC, 'cli', 'commandAutoRegistry.js'));
  assert.ok(reg.getCommandNames().includes('deliveries'));
  assert.equal(reg.getAliases()['台账'], 'deliveries');
  assert.equal(reg.getAliases()['jiaofu'], 'deliveries');
});

test('T3 咽喉写入点:complete/fail/cancel 各入账一条(真实 jsonl 回读)', async () => {
  tempDataHome('t3');
  try {
    const btm = require(path.join(SRC, 'services', 'backgroundTaskManager.js'));
    const a = btm.register({ type: 't', label: '任务甲' }).task;
    const b = btm.register({ type: 't', label: '任务乙' }).task;
    const c = btm.register({ type: 't', label: '任务丙' }).task;
    assert.equal(btm.complete(a.id, '甲的交付摘要').success, true);
    assert.equal(btm.fail(b.id, '乙炸了').success, true);
    assert.equal(btm.cancel(c.id, '丙被叫停').success, true);

    const rows = ledger.listDeliveries({ limit: 10 });
    assert.equal(rows.length, 3, '非空转对照:3 次终态必须 3 条入账');
    const byId = Object.fromEntries(rows.map((r) => [r.taskId, r]));
    assert.equal(byId[a.id].status, 'succeeded');
    assert.equal(byId[a.id].source, 'background');
    assert.equal(byId[a.id].closure, 'unknown'); // BTM 不知裁决层结论,自报未知
    assert.equal(byId[a.id].summary, '甲的交付摘要');
    assert.equal(byId[b.id].status, 'failed');
    assert.equal(byId[b.id].closure, 'error');
    assert.match(byId[b.id].error, /乙炸了/);
    assert.equal(byId[c.id].status, 'cancelled');
    assert.equal(byId[c.id].closure, 'cancelled');
    assert.match(byId[c.id].error, /丙被叫停/);
  } finally {
    restoreDataHome();
  }
});

test('T4 非法 --limit/--status 打印替换提示;合法/缺省零噪音(对照组)', async () => {
  tempDataHome('t4');
  try {
    ledger.recordDelivery({ taskId: 'x1', source: 'manual', task: '种子', status: 'succeeded', closure: 'close' });
    assert.equal(ledger.listDeliveries({ limit: 10 }).length, 1, '非空转:先种 1 条');

    rec.info.length = 0;
    await deliveriesH.handleDeliveries(undefined, [], { limit: 'abc' });
    assert.ok(rec.info.some((s) => s.includes('数量「abc」不是正整数')), '非法 limit 须有提示');

    rec.info.length = 0;
    await deliveriesH.handleDeliveries(undefined, [], { limit: '5' });
    assert.equal(rec.info.filter((s) => s.includes('不是正整数')).length, 0, '合法 limit 不得有提示');

    rec.info.length = 0;
    await deliveriesH.handleDeliveries(undefined, [], { status: 'succeed' });
    assert.ok(rec.info.some((s) => s.includes('状态「succeed」不是已知值')), '非法 status 须有提示');

    rec.info.length = 0;
    await deliveriesH.handleDeliveries(undefined, [], { status: 'succeeded' });
    assert.equal(rec.info.filter((s) => s.includes('不是已知值')).length, 0, '合法 status 不得有提示');

    rec.info.length = 0;
    await deliveriesH.handleDeliveries(undefined, [], {});
    assert.equal(rec.info.join('\n').includes('不是'), false, '缺省路径不得有提示');
  } finally {
    restoreDataHome();
  }
});

test('T5 manifest.handler 适配:stats 子命令真落到 stats 分支', async () => {
  tempDataHome('t5');
  try {
    const mf = deliveriesH[MANIFEST_EXPORT_KEY];
    const ok = await mf.handler({ subCommand: 'stats', args: [], options: {} });
    assert.equal(ok, true);
    assert.equal(
      rec.info.some((s) => s.includes('不是正整数') || s.includes('不是已知值')),
      false,
      'stats 分支不应触发 list 的提示'
    );
  } finally {
    restoreDataHome();
  }
});
