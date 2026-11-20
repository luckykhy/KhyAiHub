'use strict';

/**
 * androidAgentKitConformance.test.js — vendored android-agent-kit 行为闸门
 *
 * 锁死的契约（实测依据）：
 *   ① 上游自带的 conformance 壳（uidref 7 个向量 / 45 例，screendiff 6 个向量 / 27 例）
 *      在本仓拷贝上必须原样全绿——向量随包入库，这是「逐字入库但行为可验证」的回归门。
 *      为什么用子进程跑壳：conformance.js 没有 module.exports、顶层 main()、直接
 *      process.exit()（uidref/js/conformance.js:94/:97），当库 require 会退出测试进程。
 *   ② 测试进程内直接 require 两个核心库，按向量的 case.in → case.out 逐字段深比对，
 *      兜住「壳绿但库被换掉」的缝隙。
 *   ③ 三份真实设备 dump 的冒烟钉值（2026-11-16 实跑钉入，见 SOURCE.md）。
 *
 * 不要断言 p.digest() 的文本：上游闭包没传 snapshot_id（uidref.js:320-321），
 * 首行渲染成 "[undefined] <pkg> ..."；适配层要用 snapshot id 就取 p.snapshot_id。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// tests/vendor → backend/vendor；绝对路径拼装，不依赖 CWD
const VENDOR = path.join(__dirname, '..', '..', 'vendor', 'android-agent-kit');
const UIDREF = path.join(VENDOR, 'uidref');
const SCREENDIFF = path.join(VENDOR, 'screendiff');

const uidref = require(path.join(UIDREF, 'js', 'uidref.js'));
const screendiff = require(path.join(SCREENDIFF, 'js', 'screendiff.js'));

const vectorFiles = (dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

/** 与上游 uidref/js/conformance.js 的 outOf() 同一投影——向量期望值就是按它写的 */
function uidrefOutOf(snapshot) {
  return {
    package: snapshot.package,
    rotation: snapshot.rotation,
    elements: snapshot.elements.map((e) => ({
      ref: e.ref,
      role: e.role,
      label: e.label,
      bounds: e.bounds,
      center: e.center,
      clickable: e.clickable,
      long_clickable: e.long_clickable,
      scrollable: e.scrollable,
      editable: e.editable,
      checked: e.checked,
      disabled: e.disabled,
      password: e.password,
    })),
  };
}

test('uidref conformance shell passes all vectors in-process (45 cases)', () => {
  const dir = path.join(UIDREF, 'vectors');
  const files = vectorFiles(dir);
  assert.strictEqual(files.length, 7, `expected 7 vector files, got ${files.length}`);

  let cases = 0;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    d.cases.forEach((c, i) => {
      cases++;
      const got = uidrefOutOf(uidref.parse(c.in));
      // deepStrictEqual 会连字段顺序都无视（只比结构与值），比壳的逐 key 比对更严
      assert.deepStrictEqual(got, c.out, `${f} case#${i}（${c.why.slice(0, 40)}）`);
    });
  }
  assert.strictEqual(cases, 45, `expected 45 uidref cases, got ${cases}`);
});

test('screendiff conformance shell passes all vectors in-process (27 cases)', () => {
  const dir = path.join(SCREENDIFF, 'vectors');
  const files = vectorFiles(dir);
  assert.strictEqual(files.length, 6, `expected 6 vector files, got ${files.length}`);

  let cases = 0;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    d.cases.forEach((c, i) => {
      cases++;
      const got = screendiff.diff(c.in.prev, c.in.cur).to_dict();
      assert.deepStrictEqual(got, c.out, `${f} case#${i}（${c.why.slice(0, 40)}）`);
    });
  }
  assert.strictEqual(cases, 27, `expected 27 screendiff cases, got ${cases}`);
});

test('upstream conformance shells exit 0 as subprocesses (7 ok / 6 ok lines)', () => {
  // 壳用 argv[2] 当向量目录；require 相对 script 自身解析，子进程不受 CWD 影响
  for (const [shell, vectorsDir, expectOk, expectCases] of [
    [path.join(UIDREF, 'js', 'conformance.js'), path.join(UIDREF, 'vectors'), 7, 45],
    [path.join(SCREENDIFF, 'js', 'conformance.js'), path.join(SCREENDIFF, 'vectors'), 6, 27],
  ]) {
    const stdout = execFileSync(process.execPath, [shell, vectorsDir], { encoding: 'utf8' });
    const okLines = stdout.split('\n').filter((l) => l.startsWith('ok '));
    assert.strictEqual(okLines.length, expectOk,
      `${path.basename(shell)}: expected ${expectOk} ok lines, got ${okLines.length}\n${stdout}`);
    for (const f of vectorFiles(vectorsDir)) {
      assert.ok(okLines.some((l) => l.includes(f)), `${shell} stdout 缺 ${f} 的 ok 行`);
    }
    assert.ok(stdout.includes(`用例 ${expectCases} 条`),
      `${shell} 汇总行应报 ${expectCases} 例`);
    assert.ok(stdout.includes('失败文件 0 个'), `${shell} 不应报失败文件`);
  }
});

test('uidref smoke on the real settings-storage dump (pinned 2026-11-16)', () => {
  const xml = fs.readFileSync(path.join(UIDREF, 'fixtures', 'settings-storage.xml'), 'utf8');
  const p = uidref.parse(xml);

  // snapshot_id 是内容哈希；metrics 里那个字段是 undefined（上游 quirk，见 SOURCE.md）
  assert.strictEqual(p.snapshot_id, 'se3522b5ce4a8');
  assert.strictEqual(p.metrics().snapshot_id, undefined);

  const m = p.metrics();
  assert.strictEqual(m.elements, 11);
  assert.strictEqual(m.xml_bytes, 29361);
  assert.strictEqual(m.digest_bytes, 659);
  assert.strictEqual(m.compression, 44.55);
  assert.strictEqual(m.est_tokens, 164);
});

test('screendiff smoke on the real c1→c2 dump pair (pinned 2026-11-16)', () => {
  const readDump = (name) => uidref.parse(
    fs.readFileSync(path.join(SCREENDIFF, 'fixtures', name), 'utf8'));
  const cs = screendiff.diff(readDump('c1.xml'), readDump('c2.xml'));

  assert.strictEqual(cs.is_identical, false);
  assert.deepStrictEqual(cs.counts, {
    matched: 7, added: 4, removed: 4, moved: 7, state_changed: 0, label_changed: 7,
  });

  // effectOf 是模块级函数，必须显式传 ChangeSet（不是 cs 的方法）
  const eff = screendiff.effectOf(cs, 'e1');
  assert.strictEqual(eff.conclusion, 'target_changed');
  assert.deepStrictEqual(eff.changes, ['moved', 'label_changed']);
  assert.strictEqual(eff.added_count, 4);
  assert.strictEqual(eff.removed_count, 4);
  // 覆盖层检测：新增的 4 个元素都压在被点目标上（>50% 重叠），点错了也看得出来
  assert.deepStrictEqual(eff.added_overlapping_target.map((e) => e.ref),
    ['e2', 'e5', 'e6', 'e7']);
});
