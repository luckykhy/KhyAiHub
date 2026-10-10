'use strict';

/**
 * traceChain.test.js — 轨迹防篡改哈希链（DESIGN-ARCH-047 PHASE 2）的本目录单测。
 *
 * 与 tests/services/trajectoryProvenance/p2Chain.test.js 的分工：那份走 sessionPersistence
 * 端到端「链写得出来」；这份只管 traceChain 自身的判据，并刻意去打它**没有文档承诺的面**：
 * 全函数性（append 永不抛 / verify 会抛）、空链真空绿、截尾不报、损坏后静默重启 genesis、
 * 哈希基恰好 7 字段（version 不在内）、_hashEntry 的跨进程字节契约。
 *
 * 常量 CHAIN_EXT 的字面值 '.trace-chain.json' 是**外部依赖点**：
 *   - sessionPersistence.js:148 `_SIDECAR_SUFFIXES` 硬编码同一串，把链文件从「会话快照」
 *     采集里排除（链的顶层是 JSON 数组，误读会造出 sessionId=undefined 的幽灵行）；
 *   - cleanupService.js:1040 又硬编码一份，用于轨迹清理时保留边车；
 *   - `khy trace` CLI 侧读链同样按这串派生路径。
 * 三处字面量与 CHAIN_EXT 一旦漂移，边车就会重新被当成正文读 → 本文件把字面值钉死。
 *
 * 全部读写落在一个 mkdtemp 临时根（os.tmpdir()），after() 删除；绝不写入仓库、
 * 绝不触碰 D:/Portable/khy-os/.khy/sessions 的真实用户数据，也不设 KHY_DATA_HOME /
 * KHY_PROJECT_DATA_HOME —— 本模块所有 API 都吃显式绝对路径，不需要环境变量。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const traceChain = require('./traceChain');
const khyTrace = require('./khyTrace');

const { PRODUCER, TRUST } = khyTrace;

// —— 本测试唯一的写盘根：require 被测模块之前就位，after() 无条件删除 ——
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tracechain-'));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const SHA_EMPTY = crypto.createHash('sha256').update('').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

let _seq = 0;
function tmpFile(tag) {
  _seq += 1;
  return path.join(ROOT, `${tag}-${_seq}${traceChain.CHAIN_EXT}`);
}

/** 建一条 N 链并把链文件路径返回；每个 append 都必须落绿，否则先红在这里。 */
function buildChain(file, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = traceChain.append(file, {
      uuid: `u${i}`,
      producer: PRODUCER.CODEX,
      trust: TRUST.CLAIMED,
      content: `body-${i}`,
      at: 1000 + i,
    });
    assert.equal(r.ok, true, `buildChain append #${i} 应成功：${JSON.stringify(r)}`);
  }
  return file;
}

/** 读盘上链（数组拷贝），并对「写盘必须真的落地」这一前提断言。 */
function chainOnDisk(file) {
  assert.ok(fs.existsSync(file), `链文件应已落盘：${file}`);
  return traceChain.read(file);
}

/**
 * 反空转护栏：任何「链校验通过」的断言都必须先证明链非空。
 * 空数组文件同样 verify=ok，忘了这一条整份套件会在零证据上变绿。
 */
function assertGreen(file) {
  const v = traceChain.verify(file);
  assert.ok(v.length > 0, `反空转护栏失败：链长度为 ${v.length}，verify 绿不携带任何证据`);
  assert.equal(v.ok, true, `链本应完好：${JSON.stringify(v)}`);
  assert.equal(v.available, true);
  assert.equal(v.brokenAt, null);
  assert.equal(v.reason, null);
  return v;
}

function writeRaw(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

// ───────────────────────────────── 常量与导出面 ─────────────────────────────────

test('导出面恰为 10 个符号；CHAIN_VERSION/GENESIS_PREV/CHAIN_EXT 字面值钉死（边车排除依赖它）', () => {
  assert.deepStrictEqual(Object.keys(traceChain).sort(), [
    'CHAIN_EXT',
    'CHAIN_VERSION',
    'GENESIS_PREV',
    '_hashEntry',
    'append',
    'chainPathFor',
    'contentHash',
    'read',
    'verify',
    'verifyAgainstEntries',
  ]);
  assert.strictEqual(traceChain.CHAIN_VERSION, 1);
  assert.strictEqual(traceChain.GENESIS_PREV, '0'.repeat(64));
  assert.strictEqual(traceChain.CHAIN_EXT, '.trace-chain.json');
  // 链文件名同时满足 endsWith('.json')（所以会被快照采集扫到）与 endsWith(CHAIN_EXT)
  // （所以被 _SIDECAR_SUFFIXES 排除）。少了后半句就是 p2Chain 注释里那场幽灵行崩溃。
  assert.ok(traceChain.CHAIN_EXT.endsWith('.json'));
  assert.equal(traceChain.CHAIN_EXT.endsWith('.jsonl'), false);
});

test('chainPathFor：.jsonl 换扩展名，大小写后缀同样剥掉', () => {
  const p = traceChain.chainPathFor(path.join(ROOT, 'sub', 's.jsonl'));
  assert.strictEqual(path.basename(p), `s${traceChain.CHAIN_EXT}`);
  assert.strictEqual(path.dirname(p), path.join(ROOT, 'sub'));
  assert.strictEqual(path.basename(traceChain.chainPathFor(path.join(ROOT, 'A.JSONL'))), `A${traceChain.CHAIN_EXT}`);
});

test('chainPathFor：非 .jsonl 结尾是「追加」而非替换扩展名 —— s.json → s.json.trace-chain.json', () => {
  // 实测答案（不是猜测）：`basename.replace(/\.jsonl$/i,'')` 只在 .jsonl 时剥掉，
  // 其余扩展名原样保留再拼 CHAIN_EXT。副作用是链文件名仍以 CHAIN_EXT 结尾，
  // 因此边车排除依然成立 —— 这才是那处硬编码真正依赖的不变量。
  assert.strictEqual(path.basename(traceChain.chainPathFor(path.join(ROOT, 's.json'))), `s.json${traceChain.CHAIN_EXT}`);
  assert.strictEqual(path.basename(traceChain.chainPathFor(path.join(ROOT, 'sess'))), `sess${traceChain.CHAIN_EXT}`);
  for (const p of ['s.jsonl', 's.json', 's', 's.txt', 'a.b.c.JSONL']) {
    assert.ok(traceChain.chainPathFor(path.join(ROOT, p)).endsWith(traceChain.CHAIN_EXT), p);
  }
});

test('chainPathFor 不幂等：对边车再取一次得到双后缀（登记的派生陷阱，不修）', () => {
  const once = traceChain.chainPathFor(path.join(ROOT, 's.jsonl'));
  const twice = traceChain.chainPathFor(once);
  assert.notStrictEqual(twice, once);
  assert.strictEqual(path.basename(twice), `s${traceChain.CHAIN_EXT}${traceChain.CHAIN_EXT}`);
});

// ───────────────────────────────── contentHash ─────────────────────────────────

test('contentHash：null/undefined/缺参/空串 全部坍缩到 sha256("")', () => {
  assert.strictEqual(traceChain.contentHash(null), SHA_EMPTY);
  assert.strictEqual(traceChain.contentHash(undefined), SHA_EMPTY);
  assert.strictEqual(traceChain.contentHash(), SHA_EMPTY);
  // 对抗面：空正文与「无正文」在哈希层不可区分 —— 删掉 content 字段不留任何痕迹。
  assert.strictEqual(traceChain.contentHash(''), traceChain.contentHash(null));
});

test('contentHash：字符串走原文，对象走 JSON.stringify；同值不同键序哈希不同（不防键名洗牌）', () => {
  assert.strictEqual(
    traceChain.contentHash('hello'),
    crypto.createHash('sha256').update('hello').digest('hex')
  );
  assert.strictEqual(
    traceChain.contentHash({ a: 1, b: 2 }),
    crypto.createHash('sha256').update(JSON.stringify({ a: 1, b: 2 })).digest('hex')
  );
  const one = { x: 1, y: 2 };
  const two = { y: 2, x: 1 };
  assert.deepEqual(one, two); // 语义上相等的两个对象
  assert.notStrictEqual(traceChain.contentHash(one), traceChain.contentHash(two));
  // 钉死事实：键序变化会被判成「改正文」。任何按 JSON 往返/键排序重排过正文的
  // 序列化器（或攻击者的字段洗牌）都会触发假阳性的 疑似改正文。
});

test('contentHash：循环引用不抛（catch → sha256(String(content))），代价是不同循环对象哈希相撞', () => {
  const c1 = { name: 'a' };
  c1.self = c1;
  const c2 = { name: 'b', extra: [1, 2, 3] };
  c2.self = c2;
  let h1;
  assert.doesNotThrow(() => {
    h1 = traceChain.contentHash(c1);
  }, '热路径上循环正文绝不允许抛');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.strictEqual(h1, crypto.createHash('sha256').update('[object Object]').digest('hex'));
  // 对抗面：兜底把结构压成 '[object Object]'，于是两个完全不同的循环正文同一个哈希。
  assert.strictEqual(traceChain.contentHash(c1), traceChain.contentHash(c2));
});

test('contentHash：数字/布尔也走 String() 兜底，与同字面字符串等价', () => {
  assert.strictEqual(traceChain.contentHash(0), traceChain.contentHash('0'));
  assert.strictEqual(traceChain.contentHash(false), traceChain.contentHash('false'));
  assert.notStrictEqual(traceChain.contentHash([1, 2]), traceChain.contentHash('1,2'));
});

// ───────────────────────────────── append 记录形状 ─────────────────────────────────

test('append：seq 从 0 递增、首条 prevHash=genesis、次条 prevHash=首条 hash', () => {
  const f = tmpFile('link');
  const r0 = traceChain.append(f, { uuid: 'a', producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED, content: 'one' });
  assert.deepStrictEqual(Object.keys(r0).sort(), ['hash', 'ok', 'seq']);
  assert.equal(r0.ok, true);
  assert.equal(r0.seq, 0);
  assert.match(r0.hash, HEX64);
  const r1 = traceChain.append(f, { uuid: 'b', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'two' });
  assert.equal(r1.seq, 1);
  const chain = chainOnDisk(f);
  assert.equal(chain.length, 2);
  assert.strictEqual(chain[0].prevHash, traceChain.GENESIS_PREV);
  assert.strictEqual(chain[1].prevHash, chain[0].hash);
  assert.strictEqual(r1.hash, chain[1].hash);
  assertGreen(f);
});

test('append：记录键序与 64hex 的 hash/seal 就位；seal 逐条不同（HMAC 输入含各自 hash）', () => {
  const f = tmpFile('shape');
  traceChain.append(f, { uuid: 'a', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'x' });
  traceChain.append(f, { uuid: 'b', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'y' });
  const chain = chainOnDisk(f);
  assert.deepStrictEqual(Object.keys(chain[0]), [
    'version', 'seq', 'uuid', 'prevHash', 'producer', 'trust', 'contentHash', 'at', 'hash', 'seal',
  ]);
  for (const e of chain) {
    assert.match(e.hash, HEX64);
    assert.match(e.seal, HEX64);
    assert.equal(e.version, traceChain.CHAIN_VERSION);
  }
  assert.notStrictEqual(chain[0].seal, chain[1].seal);
});

test('append：显式 contentHash 压过 content；缺省 contentHash 由 content 派生；两者都缺 → sha256("")', () => {
  const f = tmpFile('chash');
  traceChain.append(f, {
    uuid: 'a',
    producer: PRODUCER.CODEX,
    trust: TRUST.CLAIMED,
    content: 'will-be-ignored',
    contentHash: 'DEADBEEF',
  });
  const chain = chainOnDisk(f);
  assert.strictEqual(chain[0].contentHash, 'DEADBEEF'); // 不经哈希、原样 String() 落盘
  const f2 = tmpFile('chash2');
  traceChain.append(f2, { uuid: 'b', content: 'body' });
  assert.strictEqual(traceChain.read(f2)[0].contentHash, traceChain.contentHash('body'));
  const f3 = tmpFile('chash3');
  traceChain.append(f3, { uuid: 'c' });
  assert.strictEqual(traceChain.read(f3)[0].contentHash, SHA_EMPTY);
  assertGreen(f2);
});

test('append：at 缺省取时钟、给了就原样采用（连字符串与 0 都不归一）', () => {
  const before = Date.now();
  const f = tmpFile('at');
  traceChain.append(f, { uuid: 'a' });
  const auto = chainOnDisk(f)[0].at;
  assert.ok(auto >= before && auto <= Date.now(), `at=${auto} 应落在调用前后时钟之间`);
  const fs2 = tmpFile('at-str');
  traceChain.append(fs2, { at: 'yesterday' });
  assert.strictEqual(traceChain.read(fs2)[0].at, 'yesterday'); // 非数字也照写：链不做类型校验
  const fs3 = tmpFile('at-zero');
  traceChain.append(fs3, { at: 0 });
  assert.strictEqual(traceChain.read(fs3)[0].at, 0); // `!= null` 判定，0 不被时钟覆盖
});

test('append：uuid/producer/trust 缺省坍缩为 null，非字符串被 String() 拉平（数字 7 → "7"）', () => {
  const f = tmpFile('nulls');
  traceChain.append(f, {});
  const bare = chainOnDisk(f)[0];
  assert.equal(bare.uuid, null);
  assert.equal(bare.producer, null);
  assert.equal(bare.trust, null);
  const f2 = tmpFile('str');
  traceChain.append(f2, { uuid: 7, producer: 'codex', trust: true });
  const e = traceChain.read(f2)[0];
  assert.strictEqual(e.uuid, '7');
  assert.strictEqual(e.trust, 'true'); // 非枚举 trust 也照收：链记录不是信封，无人归一
  assertGreen(f2);
});

test('append 全函数性：目标不可写时返回 {ok:false,error} 且绝不抛（热路径不被链 brick）', () => {
  const dir = path.join(ROOT, 'iam-a-dir');
  fs.mkdirSync(dir, { recursive: true });
  let r1;
  assert.doesNotThrow(() => {
    r1 = traceChain.append(dir, { uuid: 'x' });
  });
  assert.equal(r1.ok, false);
  assert.equal(typeof r1.error, 'string');
  assert.ok(r1.error.length > 0);
  // 父路径是普通文件 → mkdir 递归失败，同样只返错误。
  const blocker = writeRaw(path.join(ROOT, 'blocker.txt'), 'not a dir');
  let r2;
  assert.doesNotThrow(() => {
    r2 = traceChain.append(path.join(blocker, 'nested', 'x.trace-chain.json'), { uuid: 'y' });
  });
  assert.equal(r2.ok, false);
  assert.equal(typeof r2.error, 'string');
  // 对抗面（可解释性护栏）：同一路径族在「父目录不存在」时反而是成功的 ——
  // atomicWriteJson 的 ensureDir 会静默 mkdir。调用方无法用「写失败」区分两者。
  const made = traceChain.append(path.join(ROOT, 'auto', 'deep', 's.trace-chain.json'), { uuid: 'z' });
  assert.equal(made.ok, true);
  assert.ok(fs.existsSync(path.join(ROOT, 'auto', 'deep', 's.trace-chain.json')));
});

test('append 之后盘上就是那条记录：read 返回拷贝，改它不回写', () => {
  const f = tmpFile('copy');
  traceChain.append(f, { uuid: 'a', content: 'x' });
  const r = chainOnDisk(f);
  r[0].producer = 'hacked';
  assert.strictEqual(chainOnDisk(f)[0].producer, null); // 内存改动静音落不了盘
});

// ───────────────────────── 安全发现①：损坏 → 静默重启 genesis ─────────────────────────

test('安全发现（登记，不修）：损坏的边车被 _readRaw 吞成 []，append 从 seq 0/genesis 静默重启，verify 仍报 ok', () => {
  const f = buildChain(tmpFile('corrupt'), 2);
  const before = assertGreen(f);
  assert.equal(before.length, 2);
  // 攻击者只需把 sidecar 写成非 JSON（或空串 / 顶层对象）—— 不需要任何密钥。
  writeRaw(f, '{{{ 不是 JSON');
  const mid = traceChain.verify(f);
  assert.deepEqual(mid, { ok: true, available: true, length: 0, brokenAt: null, reason: null });
  const r = traceChain.append(f, { uuid: 'c', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'three' });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 0); // ← 历史蒸发：序号重新从 0 开始
  const after = chainOnDisk(f);
  assert.equal(after.length, 1);
  assert.strictEqual(after[0].prevHash, traceChain.GENESIS_PREV); // ← 断链点被抹平
  assertGreen(f); // 全绿 —— 篡改擦除在这套 API 上不可见
  // 空串与非法 JSON 同一条路；这里给出对抗对照：合法的两条链（未被截断）依然可查。
  const keep = buildChain(tmpFile('keep'), 2);
  const arr = chainOnDisk(keep);
  writeRaw(keep, arr.slice(0, 1));
  assert.equal(traceChain.verifyAgainstEntries(keep, [{ uuid: 'u0', content: 'body-0' }]).ok, true);
});

// ───────────────────────── 安全发现②：verify 的空/截尾真空绿 ─────────────────────────

test('verify 入口三态：缺文件 → available:false；空数组文件 → ok 且 length 0（真空绿陷阱）', () => {
  const missing = path.join(ROOT, 'never-existed', `x${traceChain.CHAIN_EXT}`);
  assert.deepEqual(traceChain.verify(missing), {
    ok: false,
    available: false,
    length: 0,
    brokenAt: null,
    reason: 'chain 文件不存在',
  });
  const empty = writeRaw(tmpFile('empty'), []);
  const v = traceChain.verify(empty);
  assert.equal(v.ok, true); // 空链「完好」—— 调用方若只读 ok 就会在零证据上报绿
  assert.equal(v.available, true);
  assert.equal(v.length, 0);
  // 护栏示范：先证非空再谈绿。
  assert.equal(v.length > 0, false, '本用例断言的正是「空链也绿」这件事');
  assert.notStrictEqual(traceChain.verify(empty).ok, traceChain.verify(missing).ok);
});

test('verify 对畸形顶层静默当作空链：对象/目录/空文件一律 ok+length 0（不是报错）', () => {
  const obj = writeRaw(tmpFile('obj'), { hash: 'x', seq: 0 });
  assert.deepEqual(traceChain.verify(obj), { ok: true, available: true, length: 0, brokenAt: null, reason: null });
  const blank = writeRaw(tmpFile('blank'), '');
  assert.equal(traceChain.verify(blank).ok, true);
  assert.equal(traceChain.verify(blank).length, 0);
  const dir = path.join(ROOT, 'verify-dir');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(traceChain.verify(dir).ok, true); // existsSync 过、readFileSync 抛、catch 成 []
  assert.deepEqual(traceChain.read(obj), []);
});

test('verify 非全函数（登记，不修）：链内含 null → TypeError 直冲调用方；含数字却只报 seq 不连续', () => {
  const f = writeRaw(tmpFile('nul'), [null]);
  assert.throws(
    () => traceChain.verify(f),
    (e) => e instanceof TypeError && /seq/.test(e.message),
    'verify 未声明会抛：null 条目让 e.seq 直接抛 TypeError'
  );
  // 对照：同族畸形但是「对象形状的缺字段」，走的是普通报错路径。
  const nums = writeRaw(tmpFile('nums'), [1, 2, 3]);
  const v = traceChain.verify(nums);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
  assert.strictEqual(v.reason, 'seq 不连续：期望 0 实为 undefined');
  // 同一模块里 append 永不抛、verify 会抛 —— 消费方（CLI / sessionPersistence）若不套
  // try/catch，一条坏 sidecar 就能把只读命令打成崩溃。_hashEntry(null) 同族。
  assert.throws(() => traceChain._hashEntry(null), TypeError);
});

test('安全发现（登记，不修）：删掉链尾记录后 verify 依旧全绿 —— 截尾不在防篡改模型内', () => {
  const f = buildChain(tmpFile('trunc'), 3);
  assert.equal(assertGreen(f).length, 3);
  const arr = chainOnDisk(f);
  writeRaw(f, arr.slice(0, 2)); // 只删最后一条，剩余部分自洽
  const v = traceChain.verify(f);
  assert.equal(v.ok, true); // ← 少了一条记录，链「完好」
  assert.equal(v.length, 2);
  // verifyAgainstEntries 也抓不到：它只遍历链，不遍历 entries。
  const full = [0, 1, 2].map((i) => ({ uuid: `u${i}`, content: `body-${i}` }));
  assert.equal(traceChain.verifyAgainstEntries(f, full).ok, true);
  assert.equal(traceChain.verifyAgainstEntries(f, full).length, 2);
  // 唯一能看出「少了一条」的判据是拿 transcript 行数比长度 —— 本模块不提供。
  assert.equal(traceChain.verifyAgainstEntries(f, full).length < full.length, true);
  // 对抗面（对照）：删的是中间一条 → seq 连续性立刻暴露。
  const g = buildChain(tmpFile('mid'), 3);
  const gar = chainOnDisk(g);
  writeRaw(g, [gar[0], gar[2]]);
  const gv = traceChain.verify(g);
  assert.equal(gv.ok, false);
  assert.equal(gv.brokenAt, 1);
  assert.strictEqual(gv.reason, 'seq 不连续：期望 1 实为 2');
});

// ───────────────────────── 篡改定位与判据顺序 ─────────────────────────

test('篡改 7 个哈希基字段中任一个 → 「内容哈希不匹配于 #N（疑似篡改）」且 N 精确', () => {
  const fields = ['contentHash', 'producer', 'trust', 'at', 'uuid'];
  for (const key of fields) {
    const f = buildChain(tmpFile(`tamper-${key}`), 3);
    const arr = chainOnDisk(f);
    arr[1][key] = key === 'at' ? arr[1].at + 1 : key === 'contentHash' ? 'f'.repeat(64) : `hacked-${key}`;
    writeRaw(f, arr);
    const v = traceChain.verify(f);
    assert.equal(v.ok, false, `改 ${key} 必须暴露`);
    assert.equal(v.brokenAt, 1);
    assert.strictEqual(v.reason, '内容哈希不匹配于 #1（疑似篡改）');
    assert.equal(v.length, 3);
    assert.equal(v.available, true);
  }
});

test('只改 seq → 「seq 不连续：期望 N 实为 M」；交换两条 → 在第 0 位就被 seq 判出', () => {
  const f = buildChain(tmpFile('seqgap'), 3);
  const arr = chainOnDisk(f);
  arr[1].seq = 5;
  writeRaw(f, arr);
  const v = traceChain.verify(f);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.strictEqual(v.reason, 'seq 不连续：期望 1 实为 5');

  const g = buildChain(tmpFile('reorder'), 3);
  const gar = chainOnDisk(g);
  writeRaw(g, [gar[1], gar[0], gar[2]]);
  const gv = traceChain.verify(g);
  assert.equal(gv.ok, false);
  assert.equal(gv.brokenAt, 0);
  assert.strictEqual(gv.reason, 'seq 不连续：期望 0 实为 1');
});

test('prevHash 断链（保持 seq 连续）→ 「prevHash 断链于 #N」；判据顺序 seq 先于 prevHash 先于 hash', () => {
  const f = buildChain(tmpFile('prevbreak'), 3);
  const arr = chainOnDisk(f);
  arr[1].prevHash = 'e'.repeat(64);
  writeRaw(f, arr);
  const v = traceChain.verify(f);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.strictEqual(v.reason, 'prevHash 断链于 #1');
  // 同一条既断 prevHash 又改 hash：prevHash 判据先命中（报错顺序即优先级）。
  const g = buildChain(tmpFile('prevfirst'), 3);
  const gar = chainOnDisk(g);
  gar[1].prevHash = 'e'.repeat(64);
  gar[1].hash = 'a'.repeat(64);
  writeRaw(g, gar);
  assert.strictEqual(traceChain.verify(g).reason, 'prevHash 断链于 #1');
});

test('verify 定位到「首坏块」：坏在前面的遮蔽后面的坏（一处报警≠只坏一处）', () => {
  const f = buildChain(tmpFile('firstbad'), 3);
  const arr = chainOnDisk(f);
  arr[2].contentHash = 'b'.repeat(64);
  arr[0].producer = 'khy-local'; // 洗白 #0
  writeRaw(f, arr);
  const v = traceChain.verify(f);
  assert.equal(v.brokenAt, 0);
  assert.strictEqual(v.reason, '内容哈希不匹配于 #0（疑似篡改）');
});

test('篡改证据只防「事后改」，不防「整链重算」：全链重算后 verify 全绿（登记，不修）', () => {
  const f = buildChain(tmpFile('regen'), 3);
  assert.equal(assertGreen(f).length, 3);
  const arr = chainOnDisk(f);
  arr.forEach((e, i) => {
    e.seq = i;
    e.prevHash = i ? arr[i - 1].hash : traceChain.GENESIS_PREV;
    e.trust = TRUST.VERIFIED; // 把「外部声称」全部洗成「本地已验证」
    e.producer = PRODUCER.KHY_LOCAL;
    e.hash = traceChain._hashEntry(e); // sha256 无密钥，任何人都能重算
  });
  writeRaw(f, arr);
  const v = traceChain.verify(f);
  assert.equal(v.ok, true);
  assert.equal(v.length, 3);
  assertGreen(f);
});

test('verify 刻意忽略 seal：垃圾 seal 不影响判绿（跨进程不可验 → 防误报，也防不住伪造）', () => {
  const f = buildChain(tmpFile('seal'), 3);
  const arr = chainOnDisk(f);
  arr.forEach((e) => {
    e.seal = 'z'.repeat(64);
  });
  writeRaw(f, arr);
  assertGreen(f);
  // 对照：seal 不在基里（改它不动 hash），producer 在基里（改它必炸）。
  const g = buildChain(tmpFile('seal-contrast'), 2);
  const gar = chainOnDisk(g);
  gar[0].producer = PRODUCER.KHY_LOCAL;
  writeRaw(g, gar);
  assert.equal(traceChain.verify(g).ok, false);
});

test('基外字段是免检通道：注入任意新键 / 改 version 都不被哈希覆盖（登记，不修）', () => {
  const f = buildChain(tmpFile('inject'), 2);
  assert.equal(assertGreen(f).length, 2);
  const arr = chainOnDisk(f);
  arr[0].injected = 'attacker-controlled';
  arr[1].version = 99; // 链版本漂移对哈希不可见 → 未来 CHAIN_VERSION 升级无法被验出
  writeRaw(f, arr);
  const v = traceChain.verify(f);
  assert.equal(v.ok, true);
  assert.equal(v.length, 2);
});

// ───────────────────────── verifyAgainstEntries 交叉核对 ─────────────────────────

test('verifyAgainstEntries：链与正文都一致 → ok（先证链非空）', () => {
  const f = buildChain(tmpFile('xae-ok'), 3);
  const entries = [0, 1, 2].map((i) => ({ uuid: `u${i}`, content: `body-${i}` }));
  assert.equal(assertGreen(f).length, 3);
  const v = traceChain.verifyAgainstEntries(f, entries);
  assert.equal(v.ok, true);
  assert.equal(v.length, 3);
  assert.equal(v.brokenAt, null);
  // 对抗面：多给一条 entry（transcript 比链长）不报错 —— 它只遍历链。
  assert.equal(traceChain.verifyAgainstEntries(f, [...entries, { uuid: 'u9', content: 'orphan' }]).ok, true);
});

test('verifyAgainstEntries：改 transcript 正文而链未重算 → 「疑似改正文」带 uuid', () => {
  const f = buildChain(tmpFile('xae-body'), 2);
  assert.equal(assertGreen(f).length, 2);
  const tampered = [{ uuid: 'u1', content: 'HACKED' }, { uuid: 'u0', content: 'body-0' }];
  const v = traceChain.verifyAgainstEntries(f, tampered);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.strictEqual(v.reason, 'transcript 正文哈希不匹配于 #1（uuid=u1，疑似改正文）');
});

test('verifyAgainstEntries：链记录的 uuid 在 transcript 里缺席 → 「疑似删行」', () => {
  const f = buildChain(tmpFile('xae-del'), 2);
  assert.equal(assertGreen(f).length, 2);
  const v = traceChain.verifyAgainstEntries(f, [{ uuid: 'u0', content: 'body-0' }]);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.strictEqual(v.reason, '链记录 #1 在 transcript 中缺失（uuid=u1，疑似删行）');
  // entries 缺省为 [] → 等价于「所有行都被删了」，第 0 位就报删行。
  assert.strictEqual(traceChain.verifyAgainstEntries(f).reason, '链记录 #0 在 transcript 中缺失（uuid=u0，疑似删行）');
});

test('verifyAgainstEntries：链记录 uuid===null 被跳过（无主链记录不参与交叉核对）', () => {
  const f = tmpFile('xae-nulluuid');
  traceChain.append(f, { uuid: null, producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'body-0' });
  traceChain.append(f, { uuid: 'u1', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'body-1' });
  assert.equal(chainOnDisk(f)[0].uuid, null);
  const v = traceChain.verifyAgainstEntries(f, [{ uuid: 'u1', content: 'body-1' }]);
  assert.equal(v.ok, true);
  assert.equal(v.length, 2); // 链有 2 条，但只有 1 条被交叉核对过
  // 对抗面：把 uuid 补上再核，同一条正文就必须对上。
  const v2 = traceChain.verifyAgainstEntries(f, [{ uuid: 'u1', content: 'WRONG' }]);
  assert.equal(v2.ok, false);
  assert.equal(v2.brokenAt, 1);
});

test('verifyAgainstEntries 对 entries 里的 null/无 uuid 条目免疫；数字 uuid 按 String() 匹配', () => {
  const f = tmpFile('xae-shape');
  traceChain.append(f, { uuid: 7, producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'x' });
  assert.equal(chainOnDisk(f)[0].uuid, '7');
  assert.equal(traceChain.verifyAgainstEntries(f, [null, { uuid: 7, content: 'x' }, { content: 'no-uuid' }]).ok, true);
  // 对抗面：正文不同就必须红。
  assert.equal(traceChain.verifyAgainstEntries(f, [{ uuid: 7, content: 'y' }]).ok, false);
});

test('verifyAgainstEntries 底层链已坏时直接透传链的判决，不做交叉核对', () => {
  const f = buildChain(tmpFile('xae-base'), 2);
  const arr = chainOnDisk(f);
  arr[0].producer = 'hacked';
  writeRaw(f, arr);
  // 正文「全对」也救不回来：报的是链自身的判决，而不是 疑似改正文。
  const v = traceChain.verifyAgainstEntries(f, [0, 1].map((i) => ({ uuid: `u${i}`, content: `body-${i}` })));
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
  assert.strictEqual(v.reason, '内容哈希不匹配于 #0（疑似篡改）');
  assert.equal(v.length, 2);
  // 对照：链缺文件时透传 available:false。
  const gone = path.join(ROOT, 'nope-gone', `x${traceChain.CHAIN_EXT}`);
  assert.deepEqual(traceChain.verifyAgainstEntries(gone, []), traceChain.verify(gone));
});

// ───────────────────────── _hashEntry 的跨进程字节契约 ─────────────────────────

test('_hashEntry：基恰为 {seq,uuid,prevHash,producer,trust,contentHash,at}，键序固定；hash/seal/version 不在基内', () => {
  const f = tmpFile('basis');
  traceChain.append(f, { uuid: 'a', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'hello', at: 123 });
  const rec = chainOnDisk(f)[0];
  assert.equal(traceChain._hashEntry(rec), rec.hash); // 跨「进程」重放：只读盘即可复算
  const basis = JSON.stringify({
    seq: rec.seq,
    uuid: rec.uuid,
    prevHash: rec.prevHash,
    producer: rec.producer,
    trust: rec.trust,
    contentHash: rec.contentHash,
    at: rec.at,
  });
  assert.strictEqual(
    traceChain._hashEntry(rec),
    crypto.createHash('sha256').update(basis).digest('hex'),
    '基的键序/键名是跨进程契约，改动即整链重算'
  );
  const base = traceChain._hashEntry(rec);
  const covered = [];
  for (const k of ['seq', 'uuid', 'prevHash', 'producer', 'trust', 'contentHash', 'at']) {
    const mutated = { ...rec };
    mutated[k] = k === 'seq' || k === 'at' ? 99 : `X${rec[k]}`;
    if (traceChain._hashEntry(mutated) !== base) covered.push(k);
  }
  assert.deepStrictEqual(covered, ['seq', 'uuid', 'prevHash', 'producer', 'trust', 'contentHash', 'at']);
  assert.equal(traceChain._hashEntry({ ...rec, hash: '0'.repeat(64) }), base);
  assert.equal(traceChain._hashEntry({ ...rec, seal: '0'.repeat(64) }), base);
  assert.equal(traceChain._hashEntry({ ...rec, version: 999 }), base); // ← 登记发现：version 免检
  assert.equal(traceChain._hashEntry({ ...rec, injected: 'x' }), base); // ← 基外新键免检
  assert.strictEqual(traceChain._hashEntry({}), crypto.createHash('sha256').update(JSON.stringify({ seq: undefined, uuid: undefined, prevHash: undefined, producer: undefined, trust: undefined, contentHash: undefined, at: undefined })).digest('hex'));
  assert.match(traceChain._hashEntry({}), HEX64);
});

test('read 对缺文件/目录/坏 JSON 一律返回 [] 不抛（与 append 同为全函数）', () => {
  assert.deepEqual(traceChain.read(path.join(ROOT, 'ghost', `x${traceChain.CHAIN_EXT}`)), []);
  const dir = path.join(ROOT, 'read-dir');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(traceChain.read(dir), []);
  assert.deepEqual(traceChain.read(writeRaw(tmpFile('read-bad'), 'not json')), []);
  assert.deepEqual(traceChain.read(writeRaw(tmpFile('read-obj'), { a: 1 })), []);
});
