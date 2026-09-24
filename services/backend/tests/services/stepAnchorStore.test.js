'use strict';

/**
 * stepAnchorStore.test.js — 步骤锚点的单测（[IMPL-DOC-001] §12.7）。
 *
 * ## 本测试要防的头号问题
 *
 * ① **「还原成功」不能只看它说成功**：必须验**逐字节相等**。故核心用例用**二进制**内容
 *    （含 `0x00` 与非法 UTF-8 字节）—— 纯文本用例在「按 utf8 读写」的实现下也会绿，
 *    测不出字节被破坏。
 * ② **「还原」不能越界**：manifest 被外部改过时，绝不照着它写到 cwd 之外。
 * ③ **锚点自己出错不许抛**：fail-soft 是硬契约，坏输入（null / 非数组 / 非法 stepIndex）必须返回
 *    失败结果而不是异常 —— 锚点出错绝不能阻断步骤执行。
 *
 * 全部离线：用**内存 FS 适配器**注入，不碰真实磁盘、不依赖 `~/.khyquant`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const A = require('../../src/services/stepAnchorStore.js');

// ── 内存 FS 适配器（接口与 fs 同形；mkdirSync 忠实模拟 recursive）──────────
function makeIo(seed = {}) {
  const files = new Map();
  const dirs = new Set();
  for (const [k, v] of Object.entries(seed)) {
    files.set(path.resolve(k), Buffer.isBuffer(v) ? Buffer.from(v) : Buffer.from(String(v)));
  }
  const addDir = (p) => {
    let cur = path.resolve(p);
    while (!dirs.has(cur)) {
      dirs.add(cur);
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  };
  const enoent = () => {
    const e = new Error('ENOENT');
    e.code = 'ENOENT';
    return e;
  };
  return {
    _files: files,
    _dirs: dirs,
    statSync(p) {
      const k = path.resolve(p);
      if (!files.has(k)) throw enoent();
      return { isFile: () => true, size: files.get(k).length };
    },
    readFileSync(p, enc) {
      const k = path.resolve(p);
      if (!files.has(k)) throw enoent();
      const b = files.get(k);
      return enc === 'utf8' ? b.toString('utf8') : b;
    },
    writeFileSync(p, data) {
      const k = path.resolve(p);
      files.set(k, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
    },
    mkdirSync(p) {
      addDir(p);
    },
    existsSync(p) {
      const k = path.resolve(p);
      return files.has(k) || dirs.has(k);
    },
    readdirSync(p) {
      const k = path.resolve(p);
      const out = [];
      for (const f of files.keys()) if (path.dirname(f) === k) out.push(path.basename(f));
      for (const d of dirs) if (path.dirname(d) === k) out.push(path.basename(d));
      return out;
    },
    rmSync(p) {
      files.delete(path.resolve(p));
    },
  };
}

const CWD = path.resolve('/w');
const ROOT = path.resolve('/anchors');
const abs = (rel) => path.join(CWD, rel);

// ── 门控 ────────────────────────────────────────────────────────────────
test('门控默认开、阶段默认 S1；仅 CANON 4 词可关', () => {
  assert.equal(A.isEnabled({}), true);
  assert.equal(A.isEnabled({ KHY_STEP_ANCHOR: 'off' }), false);
  assert.equal(A.isEnabled({ KHY_STEP_ANCHOR: '0' }), false);
  assert.equal(A.isEnabled({ KHY_STEP_ANCHOR: 'yes' }), true);
  assert.equal(A.getStage({}), 'S1');
  assert.equal(A.getStage({ KHY_STEP_ANCHOR_STAGE: 's3' }), 'S3');
  assert.equal(A.getStage({ KHY_STEP_ANCHOR_STAGE: '乱写' }), 'S1', '非法阶段必须回落 S1，不许 fail-open');
});

test('门控判定确实走中央注册表（登记条目不是装饰性的），且两路逐值一致', () => {
  const { FLAGS, isFlagEnabled } = require('../../src/services/flagRegistry.js');
  assert.ok(FLAGS.KHY_STEP_ANCHOR, 'KHY_STEP_ANCHOR 必须已登记');
  assert.deepEqual(
    {
      mode: FLAGS.KHY_STEP_ANCHOR.mode,
      off: FLAGS.KHY_STEP_ANCHOR.off,
      def: FLAGS.KHY_STEP_ANCHOR.default,
    },
    { mode: 'default-on', off: 'CANON', def: true },
    '登记条目必须与模块的本地 CANON 语义一致'
  );
  // 两路（注册表 vs 本地回退）在所有方言取值上必须一致 —— 否则「回退」会悄悄改变行为。
  for (const v of [undefined, '', '1', 'true', 'yes', 'disable', '0', 'false', 'off', 'no', 'OFF', ' off ']) {
    const env = v === undefined ? {} : { KHY_STEP_ANCHOR: v };
    assert.equal(
      A.isEnabled(env),
      isFlagEnabled('KHY_STEP_ANCHOR', env),
      `env=${JSON.stringify(v)} 时注册表与本地回退不一致`
    );
  }
});

// ── 纯逻辑：planAnchor 的边界 ───────────────────────────────────────────
test('planAnchor：只收 cwd 内、非 DENY 的文件；重复去重；越界与拒绝项进 skipped', () => {
  const io = makeIo({ [abs('a.js')]: 'A', [abs('b.js')]: 'B' });
  const { entries, skipped } = A.planAnchor({
    cwd: CWD,
    files: ['a.js', 'a.js', 'b.js', '../escape.js', '.git/config', 'node_modules/x.js', '.khyos/diag/y.js', ''],
    io,
  });
  assert.deepEqual(
    entries.map((e) => e.rel),
    ['a.js', 'b.js'],
    '只留 cwd 内合法项，且 a.js 去重'
  );
  assert.equal(skipped.length, 5, `越界/拒绝/空路径都必须记 skipped，实测 ${JSON.stringify(skipped)}`);
  assert.ok(skipped.every((s) => s.reason === 'outside-cwd-or-denied'));
});

test('planAnchor：本步删除的文件记 missing（还原时要把它删回去）', () => {
  const io = makeIo({});
  const { entries } = A.planAnchor({ cwd: CWD, files: ['gone.js'], io });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].missing, true);
});

// ── 核心：二进制逐字节还原 ──────────────────────────────────────────────
test('createAnchor → restoreAnchor：二进制内容逐字节还原，verified 为真', () => {
  const BIN = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80, 0x7f, 0x00]);
  const io = makeIo({ [abs('bin.dat')]: BIN, [abs('txt.md')]: 'hello 世界' });

  const made = A.createAnchor({
    cwd: CWD,
    runId: 'run/1 脏 字符',
    stepIndex: 2,
    files: ['bin.dat', 'txt.md'],
    io,
    root: ROOT,
    now: Date.parse('2026-09-26T12:00:00Z'),
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.files.length, 2);

  // 把两个文件都改坏（含非法 UTF-8），再还原
  io.writeFileSync(abs('bin.dat'), Buffer.from([0x01, 0x02]));
  io.writeFileSync(abs('txt.md'), 'corrupted');

  const res = A.restoreAnchor({ cwd: CWD, runId: 'run/1 脏 字符', stepIndex: 2, io, root: ROOT });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verified, true, `逐字节验收必须为真：${JSON.stringify(res.mismatches)}`);
  assert.deepEqual(res.restored.sort(), ['bin.dat', 'txt.md']);
  assert.deepEqual(io.readFileSync(abs('bin.dat')), BIN, '二进制必须逐字节相等');
  assert.equal(io.readFileSync(abs('txt.md'), 'utf8'), 'hello 世界');
});

test('verifyRestore 能真的报出不一致（不是恒真）', () => {
  const io = makeIo({ [abs('x.js')]: 'one' });
  A.createAnchor({ cwd: CWD, runId: 'r', stepIndex: 0, files: ['x.js'], io, root: ROOT });
  io.writeFileSync(abs('x.js'), 'two');
  const v = A.verifyRestore({ cwd: CWD, runId: 'r', stepIndex: 0, io, root: ROOT });
  assert.equal(v.equal, false, '内容不同必须报不一致');
  assert.deepEqual(v.mismatches.map((m) => m.rel), ['x.js']);
});

test('restoreAnchor：锚点时不存在（missing）的文件，还原时被删掉', () => {
  const io = makeIo({ [abs('keep.js')]: 'K' });
  A.createAnchor({ cwd: CWD, runId: 'r2', stepIndex: 0, files: ['keep.js', 'later.js'], io, root: ROOT });
  io.writeFileSync(abs('later.js'), 'created in a later step');

  const res = A.restoreAnchor({ cwd: CWD, runId: 'r2', stepIndex: 0, io, root: ROOT });
  assert.equal(res.verified, true, JSON.stringify(res));
  assert.deepEqual(res.deleted, ['later.js']);
  assert.equal(io.existsSync(abs('later.js')), false, '锚点态不存在的文件必须被删回不存在');
});

test('blob 运行级内容寻址：同一内容跨步只落一份（累积式 manifest 能负担得起的前提）', () => {
  const io = makeIo({ [abs('same.js')]: 'SAME-CONTENT' });
  // 三步都锚「全计划目标」；same.js 内容全程不变 ⇒ 3 次 createAnchor 只应落 1 份 blob。
  // 没有去重的话，落盘量会是 O(步数 × 文件数)。
  for (const i of [0, 1, 2]) {
    const r = A.createAnchor({ cwd: CWD, runId: 'r7', stepIndex: i, files: ['same.js'], io, root: ROOT });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const blobsDir = path.join(ROOT, 'r7', 'blobs');
  const blobs = io.readdirSync(blobsDir);
  assert.equal(blobs.length, 1, `同内容应去重（实测 ${JSON.stringify(blobs)}）`);
  assert.match(blobs[0], /^[0-9a-f]{64}\.bin$/, 'blob 名必须是 sha256 内容寻址');

  // 内容变了 ⇒ 新增一份；旧的那份**不能就地覆盖**（更早的步还引用着它）。
  io.writeFileSync(abs('same.js'), 'CHANGED');
  A.createAnchor({ cwd: CWD, runId: 'r7', stepIndex: 3, files: ['same.js'], io, root: ROOT });
  assert.equal(io.readdirSync(blobsDir).length, 2, '内容变化必须新增 blob，不是覆盖');

  // 还原回第 0 步 → 拿回旧内容，这正说明旧 blob 没被覆盖。
  const res = A.restoreAnchor({ cwd: CWD, runId: 'r7', stepIndex: 0, io, root: ROOT });
  assert.equal(res.verified, true, JSON.stringify(res));
  assert.equal(io.readFileSync(abs('same.js'), 'utf8'), 'SAME-CONTENT');
});

test('blob 回退读：兼容落地当天更早的步级布局（step-NNNN/blobs/<n>.bin）', () => {
  const io = makeIo({ [abs('legacy.js')]: 'LEGACY' });
  A.createAnchor({ cwd: CWD, runId: 'r8', stepIndex: 0, files: ['legacy.js'], io, root: ROOT });

  // 把这份锚点改造成**旧布局**：blob 挪到步目录、manifest 指向序号名、运行级 blob 删掉。
  const stepDir = path.join(ROOT, 'r8', 'step-0000');
  const manPath = path.join(stepDir, 'manifest.json');
  const man = JSON.parse(io.readFileSync(manPath, 'utf8'));
  const runBlob = path.join(ROOT, 'r8', 'blobs', man.files[0].blob);
  const bytes = io.readFileSync(runBlob);
  io.writeFileSync(path.join(stepDir, 'blobs', '000.bin'), bytes);
  man.files[0].blob = '000.bin';
  io.writeFileSync(manPath, JSON.stringify(man));
  io.rmSync(runBlob);

  io.writeFileSync(abs('legacy.js'), 'CORRUPTED');
  const res = A.restoreAnchor({ cwd: CWD, runId: 'r8', stepIndex: 0, io, root: ROOT });
  assert.equal(res.verified, true, JSON.stringify(res));
  assert.equal(io.readFileSync(abs('legacy.js'), 'utf8'), 'LEGACY', '旧步级布局的 blob 仍必须读得出来');
});

// ── 越界防护 ────────────────────────────────────────────────────────────
test('manifest 被外部改成越界路径 → 跳过，绝不写到 cwd 之外', () => {
  const io = makeIo({ [abs('ok.js')]: 'OK' });
  A.createAnchor({ cwd: CWD, runId: 'r3', stepIndex: 0, files: ['ok.js'], io, root: ROOT });

  // 篡改 manifest：塞一条指向 cwd 之外的写动作
  const manPath = path.join(ROOT, 'r3', 'step-0000', 'manifest.json');
  const man = JSON.parse(io.readFileSync(manPath, 'utf8'));
  man.files.push({ rel: '../outside.js', missing: false, blob: '000.bin', sha256: 'x', bytes: 1 });
  io.writeFileSync(manPath, JSON.stringify(man));

  const res = A.restoreAnchor({ cwd: CWD, runId: 'r3', stepIndex: 0, io, root: ROOT });
  assert.ok(
    res.skipped.some((s) => s.path === '../outside.js' && s.reason === 'outside-cwd-or-denied'),
    `越界项必须被跳过：${JSON.stringify(res.skipped)}`
  );
  assert.equal(io.existsSync(path.resolve('/outside.js')), false, '绝不创建 cwd 之外的文件');
});

// ── fail-soft ───────────────────────────────────────────────────────────
test('坏输入绝不抛：null / 非数组 / 非法 stepIndex / 不存在的锚点', () => {
  const io = makeIo({});
  assert.doesNotThrow(() => A.planAnchor({ cwd: CWD, files: null, io }));
  assert.deepEqual(A.planAnchor({ cwd: CWD, files: null, io }).entries, []);
  assert.doesNotThrow(() => A.createAnchor({ cwd: CWD, runId: 'r', stepIndex: -1, files: [], io, root: ROOT }));
  assert.equal(A.createAnchor({ cwd: CWD, runId: 'r', stepIndex: -1, files: [], io, root: ROOT }).ok, false);
  assert.doesNotThrow(() => A.restoreAnchor({ cwd: CWD, runId: 'nope', stepIndex: 9, io, root: ROOT }));
  assert.equal(A.readAnchor({ cwd: CWD, runId: 'nope', stepIndex: 9, io, root: ROOT }), null);
  assert.deepEqual(A.listAnchors({ cwd: CWD, runId: 'nope', io, root: ROOT }), []);
  assert.doesNotThrow(() => A.verifyRestore({ cwd: CWD, runId: 'nope', stepIndex: 9, io, root: ROOT }));
});

test('门控关 → 不写锚点（且不是「写了再删」）', () => {
  const io = makeIo({ [abs('a.js')]: 'A' });
  const made = A.createAnchor({
    cwd: CWD,
    runId: 'r4',
    stepIndex: 0,
    files: ['a.js'],
    io,
    root: ROOT,
    env: { KHY_STEP_ANCHOR: 'off' },
  });
  assert.equal(made.ok, false);
  assert.equal(made.reason, 'gate-off');
  assert.equal(io.existsSync(path.join(ROOT, 'r4')), false, '门控关时不得留下任何痕迹');
});

test('dryRun：只算不写', () => {
  const io = makeIo({ [abs('d.js')]: 'D' });
  A.createAnchor({ cwd: CWD, runId: 'r5', stepIndex: 0, files: ['d.js'], io, root: ROOT });
  io.writeFileSync(abs('d.js'), 'changed');
  const res = A.restoreAnchor({ cwd: CWD, runId: 'r5', stepIndex: 0, io, root: ROOT, dryRun: true });
  assert.deepEqual(res.restored, ['d.js'], 'dryRun 仍要报出「会还原什么」');
  assert.equal(io.readFileSync(abs('d.js'), 'utf8'), 'changed', 'dryRun 不得真的写盘');
  assert.equal(res.verified, false, 'dryRun 后内容当然还不一致');
});

// ── 步骤枚举与旁路台账 ──────────────────────────────────────────────────
test('listAnchors 按步序号升序，且台账有 anchor-created / restore-applied 记录', () => {
  const io = makeIo({ [abs('a.js')]: 'A' });
  A.createAnchor({ cwd: CWD, runId: 'r6', stepIndex: 1, files: ['a.js'], io, root: ROOT });
  A.createAnchor({ cwd: CWD, runId: 'r6', stepIndex: 0, files: ['a.js'], io, root: ROOT });
  const list = A.listAnchors({ cwd: CWD, runId: 'r6', io, root: ROOT });
  assert.deepEqual(list.map((x) => x.stepIndex), [0, 1]);
  assert.deepEqual(list.map((x) => x.fileCount), [1, 1]);

  A.restoreAnchor({ cwd: CWD, runId: 'r6', stepIndex: 0, io, root: ROOT });
  const ledger = io.readFileSync(path.join(ROOT, 'r6', 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"event":"anchor-created"/);
  assert.match(ledger, /"event":"restore-applied"/);
  assert.match(ledger, /"stage":"S1"/, 'S1 阶段必须被记录进台账（旁路记录）');
});
