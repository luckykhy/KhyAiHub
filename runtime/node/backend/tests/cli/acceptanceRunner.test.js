'use strict';

/**
 * acceptanceRunner.test.js — 运行记录引擎的端到端回归锁。
 *
 * 这层唯一的职责是「真的去跑命令，并把可复算的结果写进证据目录」。它一旦
 * 静默失败（比如 spawn 失败被记成 pass），上面的四值裁决就会全部变成假绿，
 * 所以每条测试都断言**运行记录本身**，而不只是最终 verdict。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../../src/cli/acceptanceRunner');
const H = require('../../src/cli/hqStore');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function tempEvidence() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-accept-'));
}

function taskWith(criteria, extra) {
  return Object.assign({ id: 'T-TEST', acceptance: '', criteria }, extra);
}

function cmdCriterion(id, cmd) {
  return {
    id,
    desc: `判据 ${id}`,
    check: { kind: 'cmd', cmd, expect: { kind: 'exit', value: 0 } },
  };
}

describe('acceptanceRunner', () => {
  let dir;

  beforeEach(() => {
    dir = tempEvidence();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('全部通过 → done，且记录落盘可读回', () => {
    const task = taskWith([cmdCriterion('C1', 'node -e "process.exit(0)"')]);
    const run = R.runAcceptance(task, { repoRoot: REPO_ROOT, evidenceDir: dir });
    expect(run.result.verdict).toBe('done');
    expect(run.newRecords).toHaveLength(1);
    expect(run.newRecords[0].result).toBe('pass');
    expect(run.newRecords[0].source).toBe('system');
    expect(run.newRecords[0].checkHash).toBeTruthy();
    const records = R.readRunRecords(dir);
    expect(records).toHaveLength(1);
  });

  test('命令退出码非零 → failed，并留下原因', () => {
    const task = taskWith([cmdCriterion('C1', 'node -e "process.exit(3)"')]);
    const run = R.runAcceptance(task, { repoRoot: REPO_ROOT, evidenceDir: dir });
    expect(run.result.verdict).toBe('failed');
    expect(run.result.criteria[0].reason).toContain('exit=3');
  });

  test('stdout 正则命中才算通过', () => {
    const task = taskWith([{
      id: 'C1',
      desc: '输出含 DONE',
      check: { kind: 'cmd', cmd: 'node -e "console.log(\'DONE\')"', expect: { kind: 'stdout-match', re: 'DONE' } },
    }]);
    const run = R.runAcceptance(task, { repoRoot: REPO_ROOT, evidenceDir: dir });
    expect(run.result.verdict).toBe('done');
  });

  test('超时记 unknown 而不是 fail（没得出结论 ≠ 结论是失败）', () => {
    const task = taskWith([{
      id: 'C1',
      desc: '慢命令',
      check: { kind: 'cmd', cmd: 'node -e "setTimeout(()=>{}, 5000)"', expect: { kind: 'exit', value: 0 } },
    }]);
    const run = R.runAcceptance(task, { repoRoot: REPO_ROOT, evidenceDir: dir, timeoutMs: 400 });
    expect(run.newRecords[0].timedOut).toBe(true);
    expect(run.result.criteria[0].state).toBe('unknown');
  });

  test('人工判据无签名不落 pass', () => {
    const task = taskWith([{ id: 'M1', desc: '手测', check: { kind: 'manual' } }]);
    const run = R.runAcceptance(task, {
      repoRoot: REPO_ROOT,
      evidenceDir: dir,
      manual: { M1: { result: 'pass', signedBy: '' } },
    });
    expect(run.result.criteria[0].state).toBe('unknown');
    expect(run.result.criteria[0].reason).toBe('unsigned-manual');
  });

  test('人工判据带签名可通过，且记录标 source=human', () => {
    const task = taskWith([{ id: 'M1', desc: '手测', check: { kind: 'manual' } }]);
    const run = R.runAcceptance(task, {
      repoRoot: REPO_ROOT,
      evidenceDir: dir,
      manual: { M1: { result: 'pass', signedBy: '孔浩原', note: '现场确认' } },
    });
    expect(run.result.verdict).toBe('done');
    expect(run.newRecords[0].source).toBe('human');
    expect(run.newRecords[0].signedBy).toBe('孔浩原');
  });

  test('没给人工结果就不记录 —— 不替人签名', () => {
    const task = taskWith([{ id: 'M1', desc: '手测', check: { kind: 'manual' } }]);
    const run = R.runAcceptance(task, { repoRoot: REPO_ROOT, evidenceDir: dir });
    expect(run.newRecords).toHaveLength(0);
    expect(run.result.criteria[0].state).toBe('unknown');
  });

  test('运行记录的 checkHash 与判据一致，改命令后旧记录不再算数', () => {
    const task = taskWith([cmdCriterion('C1', 'node -e "process.exit(0)"')]);
    R.runAcceptance(task, { repoRoot: REPO_ROOT, evidenceDir: dir });
    const changed = taskWith([cmdCriterion('C1', 'node -e "process.exit(1)"')]);
    const run = R.runAcceptance(changed, { repoRoot: REPO_ROOT, evidenceDir: dir });
    expect(run.result.verdict).toBe('failed');
    const records = R.readRunRecords(dir);
    expect(records.length).toBe(2);
    expect(records[0].checkHash).not.toBe(records[1].checkHash);
  });

  test('validateCriteria 拒收缺 id / 缺 cmd 的判据', () => {
    expect(H.validateCriteria([]).length).toBeGreaterThan(0);
    expect(H.validateCriteria([{ desc: 'x', check: { kind: 'manual' } }]).join('\n')).toContain('缺 id');
    expect(H.validateCriteria([{ id: 'C1', desc: 'x', check: { kind: 'cmd' } }]).join('\n')).toContain('缺 check.cmd');
    expect(H.validateCriteria([
      { id: 'C1', desc: 'x', check: { kind: 'manual' } },
      { id: 'C1', desc: 'y', check: { kind: 'manual' } },
    ]).join('\n')).toContain('id 重复');
    expect(H.validateCriteria([{ id: 'C1', desc: 'x', check: { kind: 'cmd', cmd: 'node x.js', expect: { kind: 'nope' } } }]).join('\n')).toContain('expect.kind');
  });
});
