'use strict';

const {
  NODE_EOL_TABLE,
  NODE_EOL_SOURCE,
  NODE_EOL_UPDATED_AT,
  parseNodeVersion,
  parseMinNodeVersion,
  getNodeEolInfo,
} = require('../../src/constants/nodeEol');

describe('nodeEol', () => {
  test('表带离线数据来源与更新日期', () => {
    expect(NODE_EOL_SOURCE).toMatch(/^https:\/\/github\.com\/nodejs\/Release/);
    expect(NODE_EOL_UPDATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(NODE_EOL_TABLE).length).toBeGreaterThan(0);
    for (const [major, entry] of Object.entries(NODE_EOL_TABLE)) {
      expect(Number(major)).toBeGreaterThan(0);
      expect(entry.eol).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.lts).toBe('boolean');
    }
  });

  test('parseNodeVersion 接受 v 前缀与不完整版本', () => {
    expect(parseNodeVersion('v22.18.0')).toEqual({ major: 22, minor: 18, patch: 0 });
    expect(parseNodeVersion('20.11.1')).toEqual({ major: 20, minor: 11, patch: 1 });
    expect(parseNodeVersion('18')).toEqual({ major: 18, minor: 0, patch: 0 });
    expect(parseNodeVersion('not-a-version')).toBeNull();
    expect(parseNodeVersion('')).toBeNull();
    expect(parseNodeVersion(null)).toBeNull();
  });

  test('parseMinNodeVersion 从 engines 范围取下限', () => {
    expect(parseMinNodeVersion('>=20.18.1')).toEqual({ major: 20, minor: 18, patch: 1 });
    expect(parseMinNodeVersion('>= 20.18.1')).toEqual({ major: 20, minor: 18, patch: 1 });
    expect(parseMinNodeVersion('^22.0.0')).toEqual({ major: 22, minor: 0, patch: 0 });
    expect(parseMinNodeVersion('20.x')).toEqual({ major: 20, minor: 0, patch: 0 });
    expect(parseMinNodeVersion('')).toBeNull();
    expect(parseMinNodeVersion(undefined)).toBeNull();
  });

  test('已知版本按 UTC 日界给出距 EOL 天数', () => {
    const info = getNodeEolInfo('v22.18.0', new Date('2026-11-18T12:00:00Z'));
    expect(info).toMatchObject({
      major: 22,
      known: true,
      eol: '2027-04-30',
      lts: true,
      daysLeft: 163,
      expired: false,
    });
  });

  test('EOL 当天仍未过期,次日起过期', () => {
    const lastDay = getNodeEolInfo('v22.1.0', new Date('2027-04-30T23:59:59Z'));
    expect(lastDay.daysLeft).toBe(0);
    expect(lastDay.expired).toBe(false);

    const nextDay = getNodeEolInfo('v22.1.0', new Date('2027-05-01T00:00:00Z'));
    expect(nextDay.daysLeft).toBe(-1);
    expect(nextDay.expired).toBe(true);
  });

  test('表外版本返回 known:false,不猜过期也不猜安全', () => {
    const info = getNodeEolInfo('v99.1.0', new Date('2026-11-18T00:00:00Z'));
    expect(info).toMatchObject({
      major: 99,
      known: false,
      eol: null,
      daysLeft: null,
      expired: false,
    });
  });

  test('非法输入不抛,返回未知', () => {
    expect(getNodeEolInfo('', new Date('2026-11-18T00:00:00Z'))).toMatchObject({
      major: null,
      known: false,
    });
  });
});
