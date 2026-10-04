'use strict';

// Co-located contract tests for proxyCoreConfigGen.js (pure leaf: node object → egress class /
// minimal mihomo config). No I/O involved, so nothing is stubbed; every expectation below was
// measured against the real module.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gen = require('./proxyCoreConfigGen');

const VMESS = { type: 'vmess', server: 'h.example.com', port: 443, uuid: 'u-1' };
const TROJAN = { type: 'trojan', server: 'h.example.com', port: 443, password: 'p-1' };

test('classifyNodeEgress 三通道:http/https 直连、八种机场协议走内核、其余 unsupported', () => {
  for (const t of ['http', 'https']) {
    assert.equal(gen.classifyNodeEgress({ type: t }), 'direct-connect', t);
  }
  for (const t of ['vmess', 'vless', 'trojan', 'ss', 'ssr', 'hysteria', 'hysteria2', 'tuic']) {
    assert.equal(gen.classifyNodeEgress({ type: t }), 'core-required', t);
  }
  for (const t of ['socks5', 'socks', 'socks5-tls', 'wireguard', 'anytls', 'direct', 'reject', 'Unknown']) {
    assert.equal(gen.classifyNodeEgress({ type: t }), 'unsupported', t);
  }
  // 类型串先 trim + lowerCase,所以大小写/空白不影响判定。
  assert.equal(gen.classifyNodeEgress({ type: ' VMess ' }), 'core-required');
  assert.equal(gen.classifyNodeEgress({ type: 'HTTPS\n' }), 'direct-connect');
});

test('classifyNodeEgress 缺 type 时退回 protocol 字段,两者都在时 type 优先', () => {
  assert.equal(gen.classifyNodeEgress({ protocol: 'trojan' }), 'core-required');
  assert.equal(gen.classifyNodeEgress({ protocol: 'socks5' }), 'unsupported');
  assert.equal(gen.classifyNodeEgress({ type: 'http', protocol: 'vmess' }), 'direct-connect');
  // type 为空串时 `node.type || node.protocol` 让位给 protocol。
  assert.equal(gen.classifyNodeEgress({ type: '', protocol: 'ss' }), 'core-required');
  assert.equal(gen.classifyNodeEgress({ type: 0, protocol: 'ss' }), 'core-required');
});

test('classifyNodeEgress 垃圾入参一律 unsupported 且绝不抛', () => {
  for (const bad of [null, undefined, {}, 0, -1, '', NaN, false, true, [], ['vmess'], 'vmess']) {
    assert.equal(gen.classifyNodeEgress(bad), 'unsupported', String(bad));
  }
  // 对象/数字类型的 type 走 String() 强转:toString 可编程,但不改变判定通路。
  assert.equal(gen.classifyNodeEgress({ type: { toString: () => 'vmess' } }), 'core-required');
  assert.equal(gen.classifyNodeEgress({ type: {} }), 'unsupported');
  assert.equal(gen.classifyNodeEgress({ type: [] }), 'unsupported');
  assert.equal(gen.classifyNodeEgress({ type: true }), 'unsupported');
  assert.equal(gen.classifyNodeEgress({ type: 7899 }), 'unsupported');
});

test('buildMihomoConfig 产出完整 mihomo 骨架:全局段 + 单节点 select 组 + MATCH 兜底规则', () => {
  const r = gen.buildMihomoConfig(VMESS, { mixedPort: 7000 });
  assert.equal(r.ok, true);
  assert.equal(r.nodeName, 'vmess-node');
  assert.deepEqual(r.config, {
    'mixed-port': 7000,
    'allow-lan': false,
    mode: 'global',
    'log-level': 'warning',
    proxies: [{ name: 'vmess-node', type: 'vmess', server: 'h.example.com', port: 443, uuid: 'u-1' }],
    'proxy-groups': [{ name: 'KHY', type: 'select', proxies: ['vmess-node'] }],
    rules: ['MATCH,KHY'],
  });
  assert.deepEqual(Object.keys(r.config), ['mixed-port', 'allow-lan', 'mode', 'log-level', 'proxies', 'proxy-groups', 'rules']);
});

test('出站按白名单透传:展示别名 protocol/remarks/tag 丢弃,hysteria 的 protocol 保留', () => {
  const vmess = gen.buildMihomoConfig({
    ...VMESS, protocol: 'vmess', remarks: 'drop', tag: 'drop', servername: 'sni.example.com',
    cipher: 'auto', 'skip-cert-verify': true, 'ws-opts': { path: '/x', headers: { Host: 'h' } },
  });
  assert.deepEqual(Object.keys(vmess.config.proxies[0]), [
    'name', 'type', 'server', 'port', 'uuid', 'cipher', 'servername', 'skip-cert-verify', 'ws-opts',
  ]);
  assert.deepEqual(vmess.config.proxies[0]['ws-opts'], { path: '/x', headers: { Host: 'h' } });
  // hysteria(v1) 的 protocol 是真实传输字段。
  const hy = gen.buildMihomoConfig({ type: 'hysteria', server: 'h', port: 1, protocol: 'faketcp', up: '50', down: '200' });
  assert.deepEqual(hy.config.proxies[0], {
    name: 'hysteria-node', type: 'hysteria', server: 'h', port: 1, up: '50', down: '200', protocol: 'faketcp',
  });
  // 白名单外的密钥形态字段一律不进配置(plugin 例外:它在名单里)。
  const ss = gen.buildMihomoConfig({ type: 'ss', server: 'h', port: 1, cipher: 'a', password: 'p', plugin: 'obfs-local', passwordExtra: 'x' });
  assert.equal(ss.config.proxies[0].plugin, 'obfs-local');
  assert.equal('passwordExtra' in ss.config.proxies[0], false);
});

test('alterId 0 / tls false / udp false 不被真值门吞掉,undefined/null/空串才被丢', () => {
  const r = gen.buildMihomoConfig({
    ...TROJAN, alterId: 0, tls: false, udp: false, sni: null, flow: undefined, 'obfs-param': '', tfo: 0,
  });
  const out = r.config.proxies[0];
  assert.equal(out.alterId, 0);
  assert.equal(out.tls, false);
  assert.equal(out.udp, false);
  assert.equal(out.tfo, 0);
  assert.equal('sni' in out, false);
  assert.equal('flow' in out, false);
  assert.equal('obfs-param' in out, false);
});

test('必填字段缺失返回结构化 missing 列表,错误文案不回显节点密钥', () => {
  const ss = gen.buildMihomoConfig({ type: 'ss', server: 'h', port: 'x', cipher: '', password: 'TOPSECRET' });
  assert.equal(ss.ok, false);
  assert.deepEqual(ss.missing, ['port', 'cipher']);
  assert.equal(ss.error, '节点缺少必填字段: port, cipher(协议 ss)。无法生成内核配置。');
  assert.equal(JSON.stringify(ss).includes('TOPSECRET'), false);

  assert.deepEqual(gen.buildMihomoConfig({ type: 'trojan', server: 'h', port: 1 }).missing, ['password']);
  assert.deepEqual(gen.buildMihomoConfig({ type: 'vmess', server: 'h', port: 1 }).missing, ['uuid']);
  assert.deepEqual(gen.buildMihomoConfig({ type: 'vless', server: 'h', port: 1, uuid: '' }).missing, ['uuid']);
  assert.deepEqual(gen.buildMihomoConfig({ type: 'hysteria2', server: 'h', port: 1 }).missing, ['password']);
  // hysteria(v1)/tuic 只硬要求 server+port:认证形态多样,缺 password 也放行。
  assert.equal(gen.buildMihomoConfig({ type: 'hysteria', server: 'h', port: 1 }).ok, true);
  assert.equal(gen.buildMihomoConfig({ type: 'tuic', server: 'h', port: 1 }).ok, true);
  // server 缺失同样入列。
  assert.deepEqual(gen.buildMihomoConfig({ type: 'ss', port: 1, cipher: 'a', password: 'p' }).missing, ['server']);
});

test('port 走 Number.parseInt 宽松解析:443abc→443、含空白可过、0x10→0、-1 原样', () => {
  const portOf = (p) => gen.buildMihomoConfig({ ...TROJAN, port: p }).config.proxies[0].port;
  assert.equal(portOf('443abc'), 443);
  assert.equal(portOf('  80  '), 80);
  assert.equal(portOf('0x10'), 0);
  assert.equal(portOf('+80'), 80);
  assert.equal(portOf('-1'), -1);
  assert.equal(portOf('99999'), 99999);
  assert.equal(portOf(443.9), 443);
  // 校验用的是同一个 parseInt,所以 '443abc' 视为「已填」,而 'x' 才被记为缺失。
  assert.deepEqual(gen.buildMihomoConfig({ ...TROJAN, port: 'x' }).missing, ['port']);
  const rejected = gen.buildMihomoConfig({ ...TROJAN, port: NaN });
  assert.equal(rejected.ok, false);
  assert.equal('config' in rejected, false);
});

test('http/https 与 unsupported 走两条不同拒绝文案,且都不产出 config', () => {
  const direct = gen.buildMihomoConfig({ type: 'https', server: 'h', port: 1 });
  assert.equal(direct.ok, false);
  assert.equal(direct.error, '直连型节点(http/https)无需内核配置,应由调用方直接 applyProxy。');
  assert.equal('config' in direct, false);
  assert.equal('missing' in direct, false);

  const uns = gen.buildMihomoConfig({ type: 'socks5', server: 'h', port: 1 });
  assert.equal(uns.ok, false);
  assert.equal(uns.error, gen.describeUnsupported({ type: 'socks5' }));
  assert.match(uns.error, /暂不支持经内核承载协议 "socks5"/);
  assert.match(uns.error, /请改用本机 Clash 混合端口/);
});

test('describeUnsupported 对空/非法节点显示 "(未知)",并如实列出支持的协议集', () => {
  for (const bad of [null, undefined, {}, 0, '', []]) {
    assert.match(gen.describeUnsupported(bad), /"\(未知\)"/);
  }
  assert.match(gen.describeUnsupported({ type: 'WIREGUARD' }), /"wireguard"/);
  // 承诺的清单必须与实际放行的 CORE_REQUIRED_TYPES 一致(文档漂移即失败)。
  const text = gen.describeUnsupported({ type: 'x' });
  for (const t of gen.CORE_REQUIRED_TYPES) {
    assert.ok(text.includes(t), `文案应列出 ${t}`);
  }
  assert.ok(!text.includes('socks5;'));
});

test('纯函数契约:不 mutate 入参、同输入同输出、两次调用不共享配置对象', () => {
  const node = { ...VMESS, name: '  HK 🚀  ', 'ws-opts': { path: '/x' } };
  const snapshot = JSON.stringify(node);
  const a = gen.buildMihomoConfig(node, { mixedPort: 7001 });
  const b = gen.buildMihomoConfig(node, { mixedPort: 7001 });
  assert.equal(JSON.stringify(node), snapshot);
  assert.deepEqual(a, b);
  assert.notEqual(a.config, b.config);
  assert.notEqual(a.config.proxies, b.config.proxies);
  assert.notEqual(a.config.proxies[0], node);
  assert.equal(node.name, '  HK 🚀  ', '入参的 name 不被就地 trim');
  assert.equal(a.nodeName, 'HK 🚀');
  // 改返回值不写穿入参。
  a.config.proxies[0].server = 'ATTACKED';
  assert.equal(node.server, 'h.example.com');
});

test('节点名与代理组名同源:空名/0 名回落 <type>-node,组内成员与 rules 指向同一名字', () => {
  for (const name of ['   ', '', null, undefined, 0]) {
    const r = gen.buildMihomoConfig({ ...VMESS, name });
    assert.equal(r.nodeName, 'vmess-node', String(name));
    assert.equal(r.config.proxies[0].name, r.nodeName);
    assert.deepEqual(r.config['proxy-groups'][0].proxies, [r.nodeName]);
    assert.deepEqual(r.config.rules, ['MATCH,KHY']);
  }
  const named = gen.buildMihomoConfig({ ...VMESS, name: '  Tokyo 02 ' });
  assert.equal(named.nodeName, 'Tokyo 02');
  assert.equal(named.config['proxy-groups'][0].proxies[0], 'Tokyo 02');
  // label/id 别名不参与命名:只有 name 字段被认。
  assert.equal(gen.buildMihomoConfig({ ...VMESS, label: 'lbl', id: 'x' }).nodeName, 'vmess-node');
});

test('JSON 污染字面量(__proto__ 键)不改变分类,也不被当成节点字段', () => {
  const polluted = JSON.parse('{"__proto__":{"type":"vmess","server":"evil","port":1,"uuid":"x"}}');
  assert.equal(polluted.type, undefined);
  assert.equal(gen.classifyNodeEgress(polluted), 'unsupported');
  const r = gen.buildMihomoConfig(polluted);
  assert.equal(r.ok, false);
  assert.match(r.error, /"\(未知\)"/);
  // 原型链上伪造的 type 同样被读到(继承读取,非污染缺陷):own-property 判定并不存在,
  // 因此调用方必须保证传入的是解析后的纯对象。
  const inherited = Object.create({ type: 'vmess', server: 'i', port: 1, uuid: 'u' });
  assert.equal(gen.classifyNodeEgress(inherited), 'core-required');
});

test('KNOWN-DEFECT: server/port 写成数字 0 时必填校验放行,产出空主机/0 端口的“合法”配置', () => {
  // proxyCoreConfigGen.js:174 用 String(v).trim() === '' 判空(0 → '0' 算已填),
  // 而 :152 的出站构造用 `node.server || ''`(0 被真值门吞成空串)、:153 直接 parseInt(0) → 0。
  // 于是 buildMihomoConfig 返回 ok:true,配置里 server 是空串、port 是 0 —— 交给
  // proxyCoreManager 会原样写盘并 spawn,内核必然拒绝该 outbound。
  const zeroServer = gen.buildMihomoConfig({ type: 'ss', server: 0, port: 443, cipher: 'aes-128-gcm', password: 'p' });
  assert.equal(zeroServer.ok, true);
  assert.equal(zeroServer.config.proxies[0].server, '');
  assert.equal('server' in zeroServer.config.proxies[0], true);

  const zeroPort = gen.buildMihomoConfig({ type: 'ss', server: 'h', port: 0, cipher: 'aes-128-gcm', password: 'p' });
  assert.equal(zeroPort.ok, true);
  assert.equal(zeroPort.config.proxies[0].port, 0);

  // 密钥写成 0 同样原样透传(类型不再是字符串)。
  const zeroPw = gen.buildMihomoConfig({ type: 'ss', server: 'h', port: 1, cipher: 'a', password: 0 });
  assert.equal(zeroPw.ok, true);
  assert.equal(zeroPw.config.proxies[0].password, 0);
});

test('KNOWN-DEFECT: mixedPort 不做 1–65535 取值域约束,越界值原样进配置、1e21 静默变 1', () => {
  const mp = (v) => gen.buildMihomoConfig(TROJAN, { mixedPort: v }).config['mixed-port'];
  // 只有 parseInt 失败或 <=0 才回落 7899;上界从不检查。
  assert.equal(mp(65536), 65536);
  assert.equal(mp(70000), 70000);
  assert.equal(mp('99999'), 99999);
  assert.equal(mp(1e21), 1);
  assert.equal(mp('1e5'), 1);
  // proxyCoreConfigGen.js:208-209 `Number.isFinite(mixedPort) && mixedPort > 0` 之后直接用值,
  // 没有 % 65536 也没有区间守卫;而 1e21 经 parseInt 字符串化后只剩首位数字。
  assert.equal(mp('abc'), 7899);
  assert.equal(mp([]), 7899);
  assert.equal(mp({}), 7899);
  assert.equal(mp(true), 7899);
});

test('KNOWN-DEFECT: 契约「绝不抛」在 options 为 null 时被打破', () => {
  // proxyCoreConfigGen.js:187 的 `options = {}` 只挡 undefined;:15 的契约声明「绝不抛」。
  assert.throws(() => gen.buildMihomoConfig(TROJAN, null), TypeError);
  // 其余 falsy options 会被装箱取属性,只得到 undefined → 回落默认端口。
  for (const boxed of [false, 0, '', NaN]) {
    assert.equal(gen.buildMihomoConfig(TROJAN, boxed).config['mixed-port'], 7899, String(boxed));
  }
  assert.equal(gen.buildMihomoConfig(TROJAN, 'x').config['mixed-port'], 7899);
  assert.equal(gen.buildMihomoConfig(TROJAN, []).config['mixed-port'], 7899);
  // 节点是不可信解析产物时,一个抛错的 getter 就击穿整个纯叶子(同样没有守卫)。
  const boom = Object.create({}, { type: { get() { throw new Error('boom'); } } });
  assert.throws(() => gen.classifyNodeEgress(boom), /boom/);
  assert.throws(() => gen.buildMihomoConfig(boom), /boom/);
});

test('KNOWN-DEFECT: 导出的协议表与字段表是可写的进程级真源,任一改写影响全部调用方', () => {
  // proxyCoreConfigGen.js:227-233 直接把 Set/字面量对象挂到 exports 上,既没 freeze 也没拷贝。
  assert.equal(gen.classifyNodeEgress({ type: 'socks5' }), 'unsupported');
  gen.CORE_REQUIRED_TYPES.add('socks5');
  try {
    assert.equal(gen.classifyNodeEgress({ type: 'socks5' }), 'core-required');
    assert.equal(gen.buildMihomoConfig({ type: 'socks5', server: 'h', port: 1 }).ok, true,
      '新增协议无必填字段表 → REQUIRED_FIELDS 查不到 → 全字段放行');
  } finally {
    gen.CORE_REQUIRED_TYPES.delete('socks5');
  }
  assert.equal(gen.classifyNodeEgress({ type: 'socks5' }), 'unsupported');
  // REQUIRED_FIELDS 同理:清掉 ss 的必填即产出无 cipher/password 的配置。
  const saved = gen.REQUIRED_FIELDS.ss;
  delete gen.REQUIRED_FIELDS.ss;
  try {
    const r = gen.buildMihomoConfig({ type: 'ss', server: 'h', port: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.config.proxies[0]), ['name', 'type', 'server', 'port']);
  } finally {
    gen.REQUIRED_FIELDS.ss = saved;
  }
  assert.deepEqual(gen.REQUIRED_FIELDS.ss, ['server', 'port', 'cipher', 'password']);
});
