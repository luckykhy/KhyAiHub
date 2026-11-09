'use strict';

/**
 * ecoMarkets 服务的对抗性回归测试。
 *
 * 夹具全部用 fs.mkdtempSync 自造 tmp 根，绝不依赖未入仓的 delivery/market——那份
 * 编目在 CI clone 里整个目录都不存在，测试必须自己在磁盘上复现三态数据根
 * （env / 仓库 / 工作区）与全部坏形状（越界 file、eco 错配、非法 JSON、非数组
 * 字段、写错的 entryCount）。
 *
 * 跑法：node --test src/services/ecoMarkets.test.js（jest.config.js 把
 * require('node:test') 的套件让给内置 runner）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./ecoMarkets');
const dataHome = require('../utils/dataHome');

const _fixtures = [];

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-eco-${prefix}-`));
  _fixtures.push(root);
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const UPSTREAM = 'https://github.com/wshobson/agents';

function writeEco(root, eco, body) {
  return writeJson(path.join(root, 'catalogs', `${eco}.json`), { eco, ...body });
}

// 索引故意写错 entryCount（99/0），并挂上 eco 错配 / 越界 file / 缺失 file /
// 缺 eco 四种坏条目，剩下的好生态必须照常装配。
function writeIndex(root) {
  const tag = path.basename(root);
  writeJson(path.join(root, 'index.json'), {
    generatedAt: '2026-10-29',
    ecosystems: [
      { eco: 'claude-code', file: 'catalogs/claude-code.json', title: 'Claude Code 生态', entryCount: 99, blockedCount: 7 },
      { eco: 'opencode', file: 'catalogs/opencode.json', title: 'OpenCode 生态', entryCount: 0, blockedCount: 0 },
      { eco: 'mismatch', file: 'catalogs/mismatch.json', title: '错配生态' },
      { eco: 'escape', file: `../outside-${tag}.json`, title: '越界生态' },
      { eco: 'missing', file: 'catalogs/nope.json', title: '缺失生态' },
      { eco: '', file: 'catalogs/opencode.json', title: '无 eco' },
    ],
    markets: { rules: ['1. compat=blocked → 不路由。', '', 42], licenseGate: 'A 档可 vendored 进仓' },
  });
}

// 两个生态收录同名条目 wshobson/agents 但判定不同（按名合并即错判）。
// 字段形状照真实编目（delivery/market/catalogs/*.json）：entries / blocked /
// marketplaces 是对象数组，uncertainties 是字符串数组——实测六个生态 36 条
// uncertainties 全是 string。夹具写成别的形状，测试就守不住真实数据的回归。
function buildCatalogRoot() {
  const root = makeRoot('catalog');
  writeEco(root, 'claude-code', {
    surveyedAt: '2026-10-29',
    marketplaces: [{ name: 'anthropics/claude-plugins-official', kind: '清单' }],
    entries: [
      { name: 'wshobson/agents', upstreamUrl: UPSTREAM, type: 'plugin', khyosMarket: 'extension', compat: 'adapter-needed', license: 'MIT' },
    ],
    blocked: [],
    uncertainties: ['上游元数据缺失，条目总数未查实'],
  });
  writeEco(root, 'opencode', {
    surveyedAt: '2026-10-29',
    marketplaces: 'not-an-array',
    entries: [
      { name: 'wshobson/agents', upstreamUrl: UPSTREAM, type: 'plugin', khyosMarket: 'skill', compat: 'direct', license: 'unknown' },
    ],
    blocked: [{ name: 'blocked-one' }, 'junk', null, [1, 2]],
    uncertainties: ['许可证未定档', '', '   ', 42, null, { risk: '对象不是字符串' }],
  });
  writeJson(path.join(root, 'catalogs', 'mismatch.json'), { eco: 'someone-else', entries: [] });
  // 越界夹具写在 tmp 根的同级：它在盘上、合法、却不是本数据根的内容。
  _fixtures.push(writeJson(path.resolve(root, '..', `outside-${path.basename(root)}.json`), { eco: 'outside', entries: [] }));
  writeIndex(root);
  return root;
}

test('resolveRoot：env 显式覆盖优先，指向不存在的目录也照样胜出', () => {
  const root = makeRoot('env');
  const hit = svc.resolveRoot({ KHY_ECO_MARKET_DIR: root });
  assert.deepStrictEqual(hit, { root: path.resolve(root), source: 'env' });

  // 显式覆盖的故障必须可见：不能因为目录不存在就静默回落到另一份编目。
  const gone = svc.resolveRoot({ KHY_ECO_MARKET_DIR: path.join(root, 'no-such-dir') });
  assert.strictEqual(gone.source, 'env');
  assert.ok(!fs.existsSync(gone.root));

  // 无 env 时是仓库内 delivery/market（本工作树有）或空（CI clone 没有）。
  // 编目未入仓，两种树态都算正确，这里只锁形状不锁具体是哪一态。
  const fallback = svc.resolveRoot({});
  assert.ok(fallback.source === 'repo' || fallback.source === '', `source=${fallback.source}`);
  if (fallback.source === 'repo') {
    assert.ok(fallback.root.endsWith(path.join('delivery', 'market')), fallback.root);
  } else {
    assert.strictEqual(fallback.root, '');
  }
});

test('resolveRoot：仓库回落 → 工作区数据家 → 空（KHY_OS_ROOT 夹具）', () => {
  const prevRoot = process.env.KHY_OS_ROOT;
  try {
    const repoRoot = makeRoot('repo');
    writeJson(path.join(repoRoot, 'delivery', 'market', 'index.json'), {});
    process.env.KHY_OS_ROOT = repoRoot;
    dataHome._resetStorageCaches();
    const repo = svc.resolveRoot({});
    assert.strictEqual(repo.source, 'repo');
    assert.strictEqual(repo.root, path.join(repoRoot, 'delivery', 'market'));

    const wsRoot = makeRoot('workspace');
    writeJson(path.join(wsRoot, 'works', 'data', 'khy', 'eco-markets', 'index.json'), {});
    process.env.KHY_OS_ROOT = wsRoot;
    dataHome._resetStorageCaches();
    const ws = svc.resolveRoot({});
    assert.strictEqual(ws.source, 'works');
    assert.strictEqual(ws.root, path.join(wsRoot, 'works', 'data', 'khy', 'eco-markets'));

    const emptyRoot = makeRoot('empty');
    process.env.KHY_OS_ROOT = emptyRoot;
    dataHome._resetStorageCaches();
    assert.deepStrictEqual(svc.resolveRoot({}), { root: '', source: '' });
  } finally {
    if (prevRoot === undefined) {
      delete process.env.KHY_OS_ROOT;
    } else {
      process.env.KHY_OS_ROOT = prevRoot;
    }
    dataHome._resetStorageCaches();
  }
});

test('装配：按 index 顺序逐文件读，eco↔file 错配/越界/缺失全部跳过并记 warnings', () => {
  const root = buildCatalogRoot();
  const payload = svc.loadEcoMarkets({ root });

  assert.strictEqual(payload.status, 'ok');
  assert.deepStrictEqual(
    payload.ecosystems.map((m) => m.eco),
    ['claude-code', 'opencode']
  );
  assert.strictEqual(payload.generatedAt, '2026-10-29');
  assert.deepStrictEqual(payload.rules, ['1. compat=blocked → 不路由。']);
  assert.strictEqual(payload.licenseGate, 'A 档可 vendored 进仓');

  assert.strictEqual(payload.warnings.length, 4, `warnings=${payload.warnings.join(' | ')}`);
  assert.ok(payload.warnings.some((w) => w.includes('mismatch') && w.includes('someone-else')));
  assert.ok(payload.warnings.some((w) => w.includes('escape') && w.includes('越界')));
  assert.ok(payload.warnings.some((w) => w.includes('missing')));
  assert.ok(payload.warnings.some((w) => w.includes('eco/file')));

  // 越界文件在盘上存在且合法，却一条都不能进响应。
  const names = payload.ecosystems.flatMap((m) => m.entries.map((e) => e.name));
  assert.ok(!names.includes('outside'));
});

test('同名条目按 eco 隔离：wshobson/agents 两侧 khyosMarket 不同且非同一对象', () => {
  const payload = svc.loadEcoMarkets({ root: buildCatalogRoot() });
  const cc = svc.findEcoMarket(payload, 'claude-code');
  const oc = svc.findEcoMarket(payload, 'opencode');

  const ccEntry = cc.entries.find((e) => e.name === 'wshobson/agents');
  const ocEntry = oc.entries.find((e) => e.name === 'wshobson/agents');
  assert.strictEqual(ccEntry.khyosMarket, 'extension');
  assert.strictEqual(ccEntry.license, 'MIT');
  assert.strictEqual(ocEntry.khyosMarket, 'skill');
  assert.strictEqual(ocEntry.license, 'unknown');
  assert.notStrictEqual(ccEntry, ocEntry, '同一对象被两个生态共享即互串');
});

test('计数由数组长度现算：index.entryCount 写错也不进响应', () => {
  const payload = svc.loadEcoMarkets({ root: buildCatalogRoot() });
  const cc = payload.ecosystems[0];
  assert.strictEqual(cc.entries.length, 1, 'index 写 99，实际只有 1 条');
  assert.ok(!('entryCount' in cc), 'entryCount 是生成时快照，不得透出');
  assert.ok(!('blockedCount' in cc));
  assert.strictEqual(cc.title, 'Claude Code 生态');
  assert.strictEqual(cc.surveyedAt, '2026-10-29');
});

test('非数组 / 含非对象的字段一律收敛为 []', () => {
  const payload = svc.loadEcoMarkets({ root: buildCatalogRoot() });
  const oc = payload.ecosystems[1];
  assert.deepStrictEqual(oc.marketplaces, [], '字符串不是数组');
  assert.strictEqual(oc.entries.length, 1);
  assert.deepStrictEqual(oc.blocked, [{ name: 'blocked-one' }], '只留对象');
  // uncertainties 是字符串数组（真实编目形状）：空串/空白/数字/null/对象全丢掉，
  // 只留非空字符串。这里若退回 normList（只留对象）就会收敛成 []。
  assert.deepStrictEqual(oc.uncertainties, ['许可证未定档']);
});

test('uncertainties 照真实编目形状透传：字符串一条不丢', () => {
  const payload = svc.loadEcoMarkets({ root: buildCatalogRoot() });
  const cc = payload.ecosystems[0];
  assert.deepStrictEqual(cc.uncertainties, ['上游元数据缺失，条目总数未查实']);

  // 缺字段 / 非数组都不抛，收敛为空数组而不是 undefined。
  const bare = makeRoot('bare');
  writeEco(bare, 'bare', { entries: [] });
  writeJson(path.join(bare, 'index.json'), {
    ecosystems: [{ eco: 'bare', file: 'catalogs/bare.json' }],
  });
  const built = svc.loadEcoMarkets({ root: bare }).ecosystems[0];
  assert.deepStrictEqual(built.uncertainties, []);

  const wrong = makeRoot('wrong-shape');
  writeEco(wrong, 'wrong-shape', { entries: [], uncertainties: '一条字符串' });
  writeJson(path.join(wrong, 'index.json'), {
    ecosystems: [{ eco: 'wrong-shape', file: 'catalogs/wrong-shape.json' }],
  });
  assert.deepStrictEqual(svc.loadEcoMarkets({ root: wrong }).ecosystems[0].uncertainties, []);
});

test('降级：空 root / index 缺失 / index 非法 JSON 都不抛且文案含 env 名', () => {
  for (const root of ['', path.join(os.tmpdir(), 'khy-eco-never-existed-dir')]) {
    const payload = svc.loadEcoMarkets({ root });
    assert.strictEqual(payload.status, 'degraded');
    assert.deepStrictEqual(payload.ecosystems, []);
    assert.match(payload.degraded, /KHY_ECO_MARKET_DIR/);
    assert.match(payload.degraded, /修复/);
  }

  const broken = makeRoot('broken');
  fs.writeFileSync(path.join(broken, 'index.json'), '{not json');
  const payload = svc.loadEcoMarkets({ root: broken });
  assert.strictEqual(payload.status, 'degraded');
  assert.match(payload.degraded, /KHY_ECO_MARKET_DIR/);

  const noEcosystems = makeRoot('no-eco-key');
  writeJson(path.join(noEcosystems, 'index.json'), { ecosystems: 'nope' });
  assert.strictEqual(svc.loadEcoMarkets({ root: noEcosystems }).status, 'degraded');
});

test('TTL 缓存：命中不重读、过期重读、降级载荷不落缓存', () => {
  const root = buildCatalogRoot();
  const env = { KHY_ECO_MARKET_DIR: root };
  const first = svc.getEcoMarkets({ env, nowMs: 1_000 });

  const ccFile = path.join(root, 'catalogs', 'claude-code.json');
  const catalog = JSON.parse(fs.readFileSync(ccFile, 'utf8'));
  catalog.entries.push({ name: 'late-arrival', type: 'plugin' });
  writeJson(ccFile, catalog);

  const hit = svc.getEcoMarkets({ env, nowMs: 1_000 + svc.DEFAULT_TTL_MS - 1 });
  assert.strictEqual(hit, first, 'TTL 内必须返回同一实例（不重读盘）');
  assert.strictEqual(hit.ecosystems[0].entries.length, 1);

  const expired = svc.getEcoMarkets({ env, nowMs: 1_000 + svc.DEFAULT_TTL_MS + 1 });
  assert.notStrictEqual(expired, first, 'TTL 过后必须重读');
  assert.strictEqual(expired.ecosystems[0].entries.length, 2);

  // 降级不缓存：数据根修好后要立刻可见，而不是再等一个 TTL。
  const late = makeRoot('late');
  const lateEnv = { KHY_ECO_MARKET_DIR: late };
  const degraded = svc.getEcoMarkets({ env: lateEnv, nowMs: 5_000 });
  assert.strictEqual(degraded.status, 'degraded');
  writeJson(path.join(late, 'index.json'), {
    ecosystems: [{ eco: 'zcode', file: 'catalogs/zcode.json', title: 'ZCode 生态' }],
  });
  writeJson(path.join(late, 'catalogs', 'zcode.json'), { eco: 'zcode', entries: [] });
  const healed = svc.getEcoMarkets({ env: lateEnv, nowMs: 5_000 });
  assert.strictEqual(healed.status, 'ok');
  assert.deepStrictEqual(healed.ecosystems.map((m) => m.eco), ['zcode']);
});

test('findEcoMarket：命中 / 未知 / 空 eco / 降级载荷全部为 null 或对象', () => {
  const payload = svc.loadEcoMarkets({ root: buildCatalogRoot() });
  assert.strictEqual(svc.findEcoMarket(payload, 'opencode').eco, 'opencode');
  assert.strictEqual(svc.findEcoMarket(payload, 'nope'), null);
  assert.strictEqual(svc.findEcoMarket(payload, ''), null);
  assert.strictEqual(svc.findEcoMarket(payload, '   '), null);
  assert.strictEqual(svc.findEcoMarket(null, 'opencode'), null);
  assert.strictEqual(svc.findEcoMarket(svc.buildDegraded('x'), 'opencode'), null);
});

test('catalogFile / readJson：目录边界与外部 JSON 系统边界', () => {
  const root = makeRoot('boundary');
  const inside = writeJson(path.join(root, 'catalogs', 'a.json'), { eco: 'a' });
  assert.strictEqual(svc.catalogFile(root, 'catalogs/a.json'), inside);
  assert.strictEqual(svc.catalogFile(root, path.relative(root, inside)), inside);
  assert.strictEqual(svc.catalogFile(root, '../a.json'), null, '越界相对路径');
  assert.strictEqual(svc.catalogFile(root, path.resolve(root, '..', 'a.json')), null, '绝对路径');
  assert.strictEqual(svc.catalogFile(root, ''), null);
  assert.strictEqual(svc.catalogFile(root, '   '), null);
  assert.strictEqual(svc.catalogFile('', 'catalogs/a.json'), null);
  assert.strictEqual(svc.catalogFile(root, 42), null);

  assert.deepStrictEqual(svc.readJson(inside), { eco: 'a' });
  assert.strictEqual(svc.readJson(path.join(root, 'catalogs', 'nope.json')), null);
  assert.strictEqual(svc.readJson(root), null, '目录不是 JSON');
});

test('degradedReason / buildDegraded：统一降级载荷形状', () => {
  const degraded = svc.buildDegraded(svc.degradedReason('index.json 缺失'));
  assert.deepStrictEqual(Object.keys(degraded), ['status', 'ecosystems', 'degraded']);
  assert.strictEqual(degraded.status, 'degraded');
  assert.deepStrictEqual(degraded.ecosystems, []);
  assert.match(degraded.degraded, /问题|不可用/);
  assert.match(degraded.degraded, /识别码 KHY_ECO_MARKET_DIR/);
  assert.match(degraded.degraded, /修复：/);
});

test.after(() => {
  for (const item of _fixtures) {
    fs.rmSync(item, { recursive: true, force: true });
  }
  _fixtures.length = 0;
});
