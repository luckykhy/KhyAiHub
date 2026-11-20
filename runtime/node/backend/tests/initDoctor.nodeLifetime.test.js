'use strict';

const { _buildNodeLifetimeCheck } = require('../src/cli/handlers/init');

describe('doctor Node 版本寿命读数', () => {
  test('维护期内:输出「版本 · 维护期至 · 距 EOL N 天 · engines」', () => {
    const check = _buildNodeLifetimeCheck({
      version: 'v22.18.0',
      now: new Date('2026-11-18T12:00:00Z'),
      enginesRange: '>=20.18.1',
    });
    expect(check.category).toBe('运行环境');
    expect(check.label).toBe('Node 版本寿命');
    expect(check.ok).toBe(true);
    expect(check.level).toBe('info');
    expect(check.detail).toContain('v22.18.0 · 维护期至 2027-04-30 · 距 EOL 163 天');
    expect(check.detail).toContain('engines≥20.18.1');
  });

  test('已过 EOL:判 warn 但绝不判 error', () => {
    const check = _buildNodeLifetimeCheck({
      version: 'v18.19.0',
      now: new Date('2026-11-18T12:00:00Z'),
      enginesRange: '>=20.18.1',
    });
    expect(check.ok).toBe(false);
    expect(check.level).toBe('warn');
    expect(check.level).not.toBe('error');
    expect(check.detail).toContain('已过 EOL');
    expect(check.note).toContain('只提示、不阻断');
  });

  test('90 天内到期:判 warn 并给出天数', () => {
    const check = _buildNodeLifetimeCheck({
      version: 'v22.18.0',
      now: new Date('2027-04-20T12:00:00Z'),
      enginesRange: '>=20.18.1',
    });
    expect(check.ok).toBe(false);
    expect(check.level).toBe('warn');
    expect(check.summary).toContain('距 EOL 仅 10 天');
  });

  test('低于 engines 下限:判 warn,但不冒充运行不了', () => {
    const check = _buildNodeLifetimeCheck({
      version: 'v22.18.0',
      now: new Date('2026-11-18T12:00:00Z'),
      enginesRange: '>=24.0.0',
    });
    expect(check.ok).toBe(false);
    expect(check.level).toBe('warn');
    expect(check.detail).toContain('低于下限');
    expect(check.summary).toContain('低于 engines 下限');
  });

  test('表外版本:如实报未收录,不猜过期', () => {
    const check = _buildNodeLifetimeCheck({
      version: 'v99.0.0',
      now: new Date('2026-11-18T12:00:00Z'),
      enginesRange: '>=20.18.1',
    });
    expect(check.ok).toBe(true);
    expect(check.level).toBe('info');
    expect(check.detail).toContain('EOL 表未收录 v99');
  });

  test('默认读取仓内 package.json 的 engines 下限', () => {
    const check = _buildNodeLifetimeCheck({
      version: 'v22.18.0',
      now: new Date('2026-11-18T12:00:00Z'),
    });
    expect(check.detail).toContain('engines≥20.18.1');
  });
});
