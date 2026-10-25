'use strict';

/**
 * catalog.js 契约测试 —— 「应用中心」登记表真源的装载与校验。
 *
 * 钉住三件事：
 *   1. 仓内 catalog.json 本体永远合法（schema 校验全过）。
 *   2. 校验器对每一种非法形状 fail-loud（缺字段 / 非法分类 / 重复 appId / 绝对路径探针…），
 *      绝不静默补默认值。
 *   3. 登记表与既有真源不漂移：CLI 条目的 appId 必须在 ccSwitch 的 APPS 里在册；
 *      adapter 名必须在 scan.js 的 ADAPTER_LOADERS 里可达，且模块真实存在并导出 configPath()。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCatalog, CATEGORIES, PROBE_KINDS, CATALOG_FILE } = require('./catalog');
const { APPS, APP_LABELS } = require('../ccSwitch/constants');
const { ADAPTER_LOADERS } = require('./scan');

const REGISTERED_APP_IDS = Object.values(APPS);

function writeTempCatalog(doc) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-clientapps-')), 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

function validEntry(overrides = {}) {
  return {
    appId: 'claude-code',
    name: 'Claude Code',
    pkgName: 'claude-code',
    desc: 'x',
    category: 'cli',
    adapter: 'claudeCodeAdapter',
    modelSlots: [],
    // backupKeys 自 [DESIGN-ARCH-189] P3 起是必填字段（空数组须配 backupNote）。
    // 夹具代表"合法条目"，故此处必须带上。
    backupKeys: ['claude-code-settings'],
    ...overrides,
  };
}

// ── 1. 仓内登记表本体合法 ────────────────────────────────────────────────

test('仓内 catalog.json 装载通过，条目数 > 0 且 appId 全部唯一', () => {
  const { apps, count } = loadCatalog();
  assert.equal(count, apps.length);
  assert.ok(count > 0, '登记表不能为空');
  assert.equal(new Set(apps.map((a) => a.appId)).size, count, 'appId 不得重复');
});

test('仓内登记表：每个 CLI 条目的 appId 都在 ccSwitch 的 APPS 里在册（反向读配置可达）', () => {
  const { apps } = loadCatalog();
  for (const entry of apps) {
    if (entry.category !== 'cli') continue;
    assert.ok(
      REGISTERED_APP_IDS.includes(entry.appId),
      `${entry.appId} 未在 ccSwitch APPS 在册 —— detectCardInApp 将不可达`
    );
    // 卡面名称必须与 ccSwitch 的 APP_LABELS 一致，避免同一客户端两个中文名
    assert.equal(entry.name, APP_LABELS[entry.appId], `${entry.appId} 的名称须与 ccSwitch APP_LABELS 一致`);
  }
});

test('仓内登记表：每个 adapter 都在 scan.js 的 ADAPTER_LOADERS 可达，且模块导出 configPath()', () => {
  const { apps } = loadCatalog();
  for (const entry of apps) {
    if (!entry.adapter) continue;
    const loader = ADAPTER_LOADERS[entry.adapter];
    assert.ok(loader, `${entry.appId} 的 adapter "${entry.adapter}" 未在 ADAPTER_LOADERS 登记`);
    const mod = loader();
    assert.equal(typeof mod.configPath, 'function', `${entry.adapter} 必须导出 configPath()`);
  }
});

test('仓内登记表：codex 没有 externalApps 写配置器（写者在 D1 gateway/adapters），只能走 probe', () => {
  const { apps } = loadCatalog();
  const codex = apps.find((a) => a.appId === 'codex');
  assert.ok(codex, 'codex 必须在册');
  assert.equal(codex.adapter, null);
  assert.equal(codex.probe.kind, 'home');
});

// ── 2. 校验器 fail-loud 覆盖 ────────────────────────────────────────────

test('缺必填字段 → 抛 CLIENT_APPS_CATALOG_INVALID', () => {
  const entry = validEntry();
  delete entry.desc;
  const file = writeTempCatalog({ apps: [entry] });
  assert.throws(() => loadCatalog({ file }), /CLIENT_APPS_CATALOG_INVALID|登记表非法/);
});

test('非法 category → 抛错', () => {
  const file = writeTempCatalog({ apps: [validEntry({ category: 'mobile' })] });
  assert.throws(() => loadCatalog({ file }), /category 必须是/);
});

test('appId 重复 → 抛错', () => {
  const file = writeTempCatalog({ apps: [validEntry(), validEntry()] });
  assert.throws(() => loadCatalog({ file }), /重复登记/);
});

test('appId 非 kebab-case → 抛错', () => {
  const file = writeTempCatalog({ apps: [validEntry({ appId: 'ClaudeCode' })] });
  assert.throws(() => loadCatalog({ file }), /kebab-case/);
});

test('adapter=null 且无 probe → 抛错（只读卡也必须能探测「装了没」）', () => {
  const entry = validEntry({ adapter: null });
  delete entry.probe;
  const file = writeTempCatalog({ apps: [entry] });
  assert.throws(() => loadCatalog({ file }), /必须提供 probe/);
});

test('probe 含绝对路径或 .. 上跳 → 抛错（零硬编码 / 路径安全）', () => {
  for (const badSeg of ['C:\\x\\y', '/etc/passwd', '..']) {
    const file = writeTempCatalog({
      apps: [validEntry({ adapter: null, probe: { kind: 'home', segs: [badSeg] } })],
    });
    assert.throws(() => loadCatalog({ file }), /绝对路径|上跳/, `seg=${badSeg}`);
  }
});

test('modelSlots 超出合法集合 → 抛错', () => {
  const file = writeTempCatalog({ apps: [validEntry({ modelSlots: ['audio'] })] });
  assert.throws(() => loadCatalog({ file }), /modelSlots/);
});

test('登记表文件缺失 → 抛 CLIENT_APPS_CATALOG_MISSING', () => {
  assert.throws(() => loadCatalog({ file: path.join(os.tmpdir(), 'khy-no-such-catalog.json') }), /CLIENT_APPS_CATALOG_MISSING|登记表不可读/);
});

test('登记表 JSON 损坏 → 抛 CLIENT_APPS_CATALOG_INVALID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-clientapps-'));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => loadCatalog({ file }), /JSON 损坏/);
});

// ── 3. 常量面钉死（防止静默扩枚举） ─────────────────────────────────────

test('CATEGORIES / PROBE_KINDS 字面量钉死', () => {
  assert.deepEqual([...CATEGORIES].sort(), ['cli', 'desktop'].sort());
  assert.deepEqual([...PROBE_KINDS].sort(), ['home', 'userAppConfig'].sort());
  assert.ok(CATALOG_FILE.endsWith('catalog.json'));
});

// ── 4. backupKeys 校验（[DESIGN-ARCH-189] P3）────────────────────────────

test('缺 backupKeys → 抛错（不许静默没有备份）', () => {
  const e = validEntry();
  delete e.backupKeys;
  assert.throws(() => writeTempCatalog({ apps: [e] }) && loadCatalog({ file: writeTempCatalog({ apps: [e] }) }), /backupKeys 必须是数组/);
});

test('backupKeys 为空数组但无 backupNote → 抛错（fail-open 防线）', () => {
  const file = writeTempCatalog({ apps: [validEntry({ backupKeys: [] })] });
  assert.throws(() => loadCatalog({ file }), /backupNote/);
});

test('backupKeys 为空数组且有 backupNote → 合法（允许"无可备文件"，但必须说明）', () => {
  const file = writeTempCatalog({
    apps: [validEntry({ backupKeys: [], backupNote: '只写 env 引用，不落裸密钥' })],
  });
  const { apps } = loadCatalog({ file });
  assert.deepEqual(apps[0].backupKeys, []);
});

test('配了 backupKeys 又写 backupNote → 抛错（二者互斥）', () => {
  const file = writeTempCatalog({
    apps: [validEntry({ backupKeys: ['k1'], backupNote: '多余的说明' })],
  });
  assert.throws(() => loadCatalog({ file }), /互斥|不该再有/);
});

test('backupKey 字符集非法 → 抛错（判据与 backup.js 同一份）', () => {
  for (const bad of ['../escape', 'a/b', '.hidden', 'has space', '']) {
    const file = writeTempCatalog({ apps: [validEntry({ backupKeys: [bad] })] });
    assert.throws(() => loadCatalog({ file }), /backupKey/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('同一 app 内 backupKey 重复 → 抛错', () => {
  const file = writeTempCatalog({ apps: [validEntry({ backupKeys: ['dup-key', 'dup-key'] })] });
  assert.throws(() => loadCatalog({ file }), /重复/);
});

test('一个 app 可以有多份受管文件（codex 的 config.toml + auth.json）', () => {
  const file = writeTempCatalog({
    apps: [validEntry({ backupKeys: ['codex-config-toml', 'codex-auth-json'] })],
  });
  const { apps } = loadCatalog({ file });
  assert.equal(apps[0].backupKeys.length, 2);
});
