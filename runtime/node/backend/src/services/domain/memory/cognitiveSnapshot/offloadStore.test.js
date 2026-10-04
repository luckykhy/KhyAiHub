'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const offloadStore = require('./offloadStore.js');

const { offload, load, _resolvePath } = offloadStore;

const DATA_HOME = require.resolve('../../../../utils/dataHome.js');
let tmpRoot = '';
let bucket = '';
let savedDataHome = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45e-'));
  bucket = path.join(tmpRoot, 'offload-bucket');
  savedDataHome = require.cache[DATA_HOME];
  require.cache[DATA_HOME] = {
    id: DATA_HOME,
    filename: DATA_HOME,
    loaded: true,
    exports: { getProjectDataDir: (...segs) => path.join(bucket, ...segs) },
  };
});

after(() => {
  if (savedDataHome) require.cache[DATA_HOME] = savedDataHome;
  else delete require.cache[DATA_HOME];
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('offload 卸载落盘', () => {
  test('返回 ref/file/key/sha/bytes 五元组，ref 是可直接回填上下文的寻址指针', () => {
    const r = offload('task-1', 'step3', { text: '冷数据', n: 1 });
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'file', 'key', 'ref', 'sha']);
    assert.equal(r.key, 'step3');
    assert.match(r.sha, /^[0-9a-f]{16}$/);
    assert.equal(
      r.ref,
      `<offloaded ref="${r.file}" sha="${r.sha}" bytes="${r.bytes}"/>`
    );
    assert.equal(r.bytes, Buffer.byteLength(fs.readFileSync(r.file)));
  });

  test('落盘内容含 taskId/key/data/at 四字段，data 原样可解析', () => {
    const r = offload('task-2', 7, [{ a: 1 }, 'b']);
    const payload = JSON.parse(fs.readFileSync(r.file, 'utf-8'));
    assert.deepEqual(Object.keys(payload).sort(), ['at', 'data', 'key', 'taskId']);
    assert.equal(payload.taskId, 'task-2');
    assert.equal(payload.key, 7);
    assert.deepEqual(payload.data, [{ a: 1 }, 'b']);
    assert.equal(Number.isFinite(payload.at), true);
  });

  test('落点目录按 taskId 分桶并被自动创建，全部在注入的桶目录内', () => {
    const r = offload('task-3', 'k', 'payload');
    assert.equal(path.dirname(r.file), path.join(bucket, 'cognitive_snapshots', 'offload', 'task-3'));
    assert.equal(fs.existsSync(path.dirname(r.file)), true);
    assert.equal(r.file.startsWith(tmpRoot), true);
    assert.equal(r.file.includes(path.join('services', 'backend')), false);
  });

  test('文件名是 <safe(key)>.<sha>.json，同 key 不同数据落成两个文件互不覆盖', () => {
    const a = offload('task-4', 'snap', { v: 1 });
    const b = offload('task-4', 'snap', { v: 2 });
    assert.notEqual(a.sha, b.sha);
    assert.notEqual(a.file, b.file);
    assert.match(path.basename(a.file), /^snap\.[0-9a-f]{16}\.json$/);
    assert.deepEqual(load(a.ref), { v: 1 });
    assert.deepEqual(load(b.ref), { v: 2 });
  });

  test('原子写不留 .tmp 残骸', () => {
    const r = offload('task-5', 'k', 'x');
    const leftovers = fs.readdirSync(path.dirname(r.file)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(fs.existsSync(`${r.file}.tmp-${process.pid}`), false);
  });

  test('key / taskId 的穿越与非法字符被文件名安全化收敛', () => {
    const r = offload('../../evil', '../../../etc/passwd', 'x');
    const dir = path.dirname(r.file);
    assert.equal(dir, path.join(bucket, 'cognitive_snapshots', 'offload', '.._.._evil'));
    assert.equal(fs.existsSync(path.join(bucket, 'cognitive_snapshots', 'offload', '..', '..', 'etc')), false);
    assert.equal(path.basename(r.file).includes('/'), false);
    assert.equal(path.basename(r.file).includes('\\'), false);
    assert.deepEqual(load(r.ref), 'x');
  });

  test('假值 key 与 taskId 各自落到稳定名字上（0 保留，null 走 default）', () => {
    const zero = offload('task-6', 0, 'zero-key');
    assert.match(path.basename(zero.file), /^0\./);
    assert.equal(zero.key, '0');
    const nil = offload(null, null, 'nil-both');
    assert.equal(path.basename(path.dirname(nil.file)), 'default');
    assert.equal(path.basename(nil.file).startsWith('null.'), true);
    assert.equal(nil.key, 'null');
  });

  test('超大 payload 与多字节中文按 UTF-8 字节数记账', () => {
    const payload = '汉'.repeat(5000);
    const big = offload('task-7', 'big', payload);
    assert.equal(big.bytes, Buffer.byteLength(fs.readFileSync(big.file)));
    assert.ok(big.bytes > payload.length);
    assert.equal(big.ref.includes(`bytes="${big.bytes}"`), true);
    assert.deepEqual(load(big.ref), payload);
  });

  test('不可序列化数据（BigInt / 循环引用）直接抛穿——offload 无 fail-soft 契约', () => {
    assert.throws(() => offload('task-8', 'k', BigInt(1)), TypeError);
    const circular = { taskId: 'x' };
    circular.self = circular;
    assert.throws(() => offload('task-8', 'k', circular), TypeError);
  });

  test('data 为 undefined 时 JSON 丢字段，写盘仍是成功（见下方 KNOWN-DEFECT 的往返面）', () => {
    const r = offload('task-9', 'k', undefined);
    assert.equal(fs.existsSync(r.file), true);
    assert.equal('data' in JSON.parse(fs.readFileSync(r.file, 'utf-8')), false);
  });

  test('KNOWN-DEFECT: 卸载 undefined 后按指针回读拿回的是信封而不是原值，往返不保真', () => {
    // offloadStore.js:53 drops `data` from the JSON entirely (undefined is not
    // serialized) while offloadStore.js:78 (`'data' in parsed ? parsed.data : parsed`)
    // then treats the whole envelope as the payload. Context offloaded as undefined
    // comes back as {taskId,key,at}, so a model reading the pointer sees bookkeeping
    // data where its cold record used to be.
    const r = offload('task-10', 'k', undefined);
    const back = load(r.ref);
    assert.deepEqual(back, { taskId: 'task-10', key: 'k', at: back.at });
    assert.notEqual(back, undefined);
    // null survives because JSON keeps the key with an explicit null value.
    const n = offload('task-10', 'n', null);
    assert.equal(load(n.ref), null);
  });

  test('KNOWN-DEFECT: sha 只截 16 位且文件名带 sha，同 key 同内容的第二次卸载仍复制一份新文件', () => {
    // offloadStore.js:53-56 hashes payload including `at`, so identical cold data
    // re-offloaded a millisecond later yields a different sha and therefore a second
    // file. The caller holds only the newest pointer; the older copy is never listed
    // or reclaimed, so the offload bucket grows monotonically per repeated eviction.
    const a = offload('task-11', 'same', { v: 1 });
    const b = offload('task-11', 'same', { v: 1 });
    assert.notEqual(a.file, b.file);
    const listed = fs.readdirSync(path.dirname(a.file));
    assert.equal(listed.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(a.file, 'utf-8')).data, { v: 1 });
  });
});

describe('load / _resolvePath 回读', () => {
  test('指针串与裸路径都能取回，取回的是原始 data 而非信封', () => {
    const r = offload('task-12', 'k', { deep: { arr: [1, 2, 3] } });
    assert.deepEqual(load(r.ref), { deep: { arr: [1, 2, 3] } });
    assert.deepEqual(load(r.file), { deep: { arr: [1, 2, 3] } });
  });

  test('_resolvePath 从 ref="…" 取路径，裸路径原样返回，假值给空串', () => {
    assert.equal(_resolvePath('<offloaded ref="C:/x/y.json" sha="a" bytes="1"/>'), 'C:/x/y.json');
    assert.equal(_resolvePath('/plain/path.json'), '/plain/path.json');
    assert.equal(_resolvePath(''), '');
    assert.equal(_resolvePath(null), '');
    assert.equal(_resolvePath(undefined), '');
    assert.equal(_resolvePath(0), '');
    assert.equal(_resolvePath('ref="a" ref="b"'), 'a');
  });

  test('缺失 / 损坏 / 无 ref 的输入一律返回 null（契约：绝不抛）', () => {
    assert.equal(load('/no/such/file.json'), null);
    assert.equal(load('<offloaded ref="/no/such/file.json" />'), null);
    assert.equal(load(''), null);
    assert.equal(load(null), null);
    assert.equal(load(undefined), null);
    assert.equal(load({}), null);
    assert.equal(load([]), null);
    const broken = path.join(bucket, 'broken.json');
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(broken, '[不是 JSON');
    assert.equal(load(broken), null);
  });

  test('盘上是合法 JSON 对象但无 data 字段时原样返回整个解析结果（读旧文件的兼容路径）', () => {
    const plain = path.join(bucket, 'plain-bucket.json');
    fs.mkdirSync(path.dirname(plain), { recursive: true });
    fs.writeFileSync(plain, JSON.stringify({ hello: 'world' }));
    assert.deepEqual(load(plain), { hello: 'world' });
    fs.writeFileSync(plain, JSON.stringify({ data: null }));
    assert.equal(load(plain), null);
  });

  test('非信封的顶层标量文件回读为 null：in 运算符在原始值上抛穿后被 catch 收敛', () => {
    // offloadStore.js:78 evaluates `'data' in parsed`; `in` throws TypeError on a
    // primitive, and the catch at :79 maps that to the same null it returns for a
    // missing file. Real offload() payloads are always envelopes, so this only bites
    // foreign/truncated files — but "not our format" and "record lost" stay identical.
    const scalar = path.join(bucket, 'scalar.json');
    fs.mkdirSync(path.dirname(scalar), { recursive: true });
    for (const v of ['裸串', 12, true]) {
      fs.writeFileSync(scalar, JSON.stringify(v));
      assert.equal(load(scalar), null, JSON.stringify(v));
    }
    fs.writeFileSync(scalar, JSON.stringify(null));
    assert.equal(load(scalar), null);
  });

  test('KNOWN-DEFECT: load 的 catch 同时吞掉解析与文件系统错误，坏指针与坏数据无法区分', () => {
    // offloadStore.js:71-82 returns one null for "no such file", "unreadable" and
    // "corrupt JSON" alike. A caller cannot tell whether the cold record is missing
    // (should re-run the step) or damaged (should report data loss), so 断点恢复
    // silently restarts work over a destroyed archive.
    const r = offload('task-13', 'k', { keep: true });
    fs.writeFileSync(r.file, '}{');
    assert.equal(load(r.ref), null);
    assert.equal(load(path.join(bucket, 'definitely-missing.json')), null);
  });

  test('指针里内嵌的是绝对路径，跨机搬迁后原样失效', () => {
    // offloadStore.js:58 puts `file` (absolute) straight into the ref the context keeps,
    // so a snapshot offloaded on one machine resolves to nothing after storage migrate.
    const r = offload('task-14', 'k', 'x');
    assert.equal(path.isAbsolute(r.file), true);
    assert.equal(r.ref.includes(r.file), true);
    fs.renameSync(r.file, path.join(bucket, 'moved.json'));
    assert.equal(load(r.ref), null);
    assert.equal(load(path.join(bucket, 'moved.json')), 'x');
  });
});
