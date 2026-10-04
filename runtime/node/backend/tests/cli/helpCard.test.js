'use strict';
// 契约(轮二十五):`help <真实命令>` 不再「未知帮助主题」死路——manifest 数据俱在,
// 入口拒答才是病症。叶子纯函数测试 + 主题优先 + kill switch 逐字节回退。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const LEAF = path.join(BE, 'src/cli/helpCard.js');

function freshBuild(topic, env) {
  delete require.cache[require.resolve(LEAF)];
  return require(LEAF).build(topic, env);
}

test('已知命令出卡:doc 带用法与子命令', () => {
  const lines = freshBuild('doc');
  assert.ok(Array.isArray(lines), '应返回行数组');
  assert.match(lines.join('\n'), /khy doc/);
  assert.match(lines.join('\n'), /用法: khy doc/);
  assert.match(lines.join('\n'), /子命令: title/);
});

test('子命令来自静态表:config 列 set|get|list…', () => {
  const lines = freshBuild('config');
  assert.ok(lines, 'config 应有卡');
  const joined = lines.join('\n');
  assert.match(joined, /子命令:.*set.*\|.*get.*\|.*list/);
  // usage 真缺省时(等于命令名本身)不得打印「用法: khy config」假信息
  assert.doesNotMatch(joined, /用法: khy config\s*$/m);
});

test('主题优先:gateway/quant/ops 同义词永不出卡(让位富主题帮助)', () => {
  for (const topic of ['gateway', 'gw', 'model', '模型', 'quant', '量化', 'ops', 'doctor', '排障']) {
    assert.strictEqual(freshBuild(topic), null, `主题词不应出卡: ${topic}`);
  }
});

test('未知命令返回 null(调用方保留原「未知帮助主题」路径)', () => {
  assert.strictEqual(freshBuild('nosuchcmd'), null);
  assert.strictEqual(freshBuild(''), null);
  assert.strictEqual(freshBuild(null), null);
});

test('别名出卡并点名规范名:文档 → doc', () => {
  const lines = freshBuild('文档');
  assert.ok(lines, '别名应有卡');
  assert.match(lines.join('\n'), /khy doc/);
  assert.match(lines.join('\n'), /别名/);
});

test('大小写不敏感', () => {
  const a = freshBuild('DOC');
  assert.ok(a);
  assert.match(a.join('\n'), /khy doc/);
});

test('kill switch:KHY_HELP_CARD=off → 一律 null(逐字节回退旧行为)', () => {
  for (const off of ['off', '0', 'false', 'no', 'OFF']) {
    assert.strictEqual(freshBuild('doc', { KHY_HELP_CARD: off }), null, `应关: ${off}`);
  }
  assert.ok(freshBuild('doc', { KHY_HELP_CARD: '1' }), '显式开仍出卡');
});

// ── 覆盖率守卫(轮二十六):每个顶层命令要么出卡、要么让位富主题 ──
// 病症:`khy help <cmd>` 对 259 个命令中的 119 个(46%)答「未知帮助主题」,
// 含 doctor/quote/gateway/models/status 等高频命令。数据在 slash 表/manifest 里,
// 只是 helpCard 没读。本测试把「全量可答」钉成契约:新增命令若无描述源会在此红灯。
test('覆盖率:每个 router 命令可出卡或为富主题同义词', () => {
  const { getRouterCommandNames } = require(path.join(BE, 'src/constants/commandSchema'));
  const names = getRouterCommandNames();
  assert.ok(names.length > 200, `命令枚举非空(实得 ${names.length})`);
  const { TOPIC_SYNONYMS } = require(LEAF);
  const dead = names.filter((n) => !TOPIC_SYNONYMS.includes(n.toLowerCase()) && !freshBuild(n));
  assert.deepStrictEqual(dead, [], `无帮助卡片命令: ${dead.join(', ')}`);
});

test('覆盖率棘轮:别名变体经 ALIAS_CANON 也能出卡', () => {
  const { ALIAS_CANON } = require(path.join(BE, 'src/constants/commandHelp'));
  for (const alias of Object.keys(ALIAS_CANON)) {
    assert.ok(freshBuild(alias), `别名应出卡: ${alias}`);
  }
});

test('描述本地化:卡片不得露出 auto-migrated 英文占位', () => {
  const { getRouterCommandNames } = require(path.join(BE, 'src/constants/commandSchema'));
  const offenders = [];
  for (const n of getRouterCommandNames()) {
    const lines = freshBuild(n);
    if (lines && /auto-migrated|command \(auto/.test(lines.join('\n'))) offenders.push(n);
  }
  assert.deepStrictEqual(offenders, [], `英文占位描述: ${offenders.join(', ')}`);
});
