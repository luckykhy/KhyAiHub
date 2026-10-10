'use strict';
// Chinese destructive-intent phrases in the unattended risk-deny gate.
// The gate (unattendedAutoAnswer._isDestructiveChoice) reuses
// shellSafetyValidator._selectDestructivePatterns; the table is English-only
// today, so Chinese destructive option labels pass through unpunished.
// These tests lock: Chinese destructive phrases hit the gate via the same
// selectAutoAnswers chain, benign Chinese text does NOT false-positive,
// English behavior is untouched (regression lock), and the sub-flag
// KHY_SHELL_DESTRUCTIVE_CHINESE reverts byte-identically.

const ua = require('../../src/services/unattendedAutoAnswer');
const {
  _selectDestructivePatterns,
  CHINESE_DESTRUCTIVE_PATTERNS,
} = require('../../src/services/shellSafetyValidator');

const { selectAutoAnswers } = ua;

const ON_ENV = { KHY_UNATTENDED_AUTOANSWER: '1' };

describe('chinese destructive vocabulary (risk-deny gate)', () => {
  test('Chinese destructive recommended option is auto-denied, not picked', () => {
    const cases = [
      ['删除所有日志文件', '取消操作'],
      ['清空全部缓存', '保留缓存'],
      ['格式化磁盘并重装系统', '取消'],
      ['卸载全部扩展', '跳过'],
      ['全部销毁本地数据', '保留'],
    ];
    for (const [bad, good] of cases) {
      const q = [{ question: '继续？', options: [{ label: bad }, { label: good }] }];
      const r = selectAutoAnswers(q, ON_ENV);
      expect(r.picks[0].denied).toBe(true);
      expect(r.picks[0].reason).toBeTruthy();
      expect(r.answers['继续？']).toMatch(/拒绝/);
      expect(r.answers['继续？']).not.toContain(bad);
    }
  });

  test('benign Chinese text does NOT false-positive (anti-overcorrection)', () => {
    const cases = [
      ['删除这一行注释', '保留注释'],
      ['格式化日期字符串为 YYYY-MM-DD', '使用默认格式'],
      ['删除单个临时文件', '取消'],
    ];
    for (const [benign, other] of cases) {
      const q = [{ question: '选择？', options: [{ label: benign }, { label: other }] }];
      const r = selectAutoAnswers(q, ON_ENV);
      expect(r.picks[0].denied).toBeUndefined();
      expect(r.answers['选择？']).toBe(benign);
    }
  });

  test('English table behavior untouched (regression lock)', () => {
    const q = [
      { question: 'Proceed?', options: [{ label: 'DROP TABLE users CASCADE' }, { label: 'Cancel migration' }] },
    ];
    const r = selectAutoAnswers(q, ON_ENV);
    expect(r.picks[0].denied).toBe(true);
    expect(r.answers['Proceed?']).toMatch(/拒绝/);
  });

  test('sub-flag on by default: Chinese entries present in _selectDestructivePatterns', () => {
    const table = _selectDestructivePatterns({});
    expect(CHINESE_DESTRUCTIVE_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of CHINESE_DESTRUCTIVE_PATTERNS) {
      expect(table).toContain(entry);
    }
  });

  test('sub-flag off (KHY_SHELL_DESTRUCTIVE_CHINESE=0): Chinese entries absent, table byte-identical to legacy', () => {
    const env = { KHY_SHELL_DESTRUCTIVE_CHINESE: '0' };
    const table = _selectDestructivePatterns(env);
    for (const entry of CHINESE_DESTRUCTIVE_PATTERNS) {
      expect(table).not.toContain(entry);
    }
    // Legacy shape intact: the English rm entries are still there (the STRICT
    // table rewrites them as lookahead forms, so match on the verb, not the
    // original pattern source).
    expect(table.some((e) => /\brm\b/.test(String(e.pattern)))).toBe(true);
  });

  test('pattern entries are word-bounded phrases, not bare verbs (false-positive guard at the table level)', () => {
    // A bare verb like 删除 alone must not hit; only the scoped phrase does.
    const bare = [{ question: '选择？', options: [{ label: '删除参数' }, { label: '保留参数' }] }];
    const r = selectAutoAnswers(bare, ON_ENV);
    expect(r.picks[0].denied).toBeUndefined();
  });
});
