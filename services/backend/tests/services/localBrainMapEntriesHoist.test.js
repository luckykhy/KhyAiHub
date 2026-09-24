'use strict';
/**
 * localBrainMapEntriesHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of Object.entries(_CRYPTO_MAP) and
 * Object.entries(_COUNTRY_CODE_MAP) out of _detectCrypto / _detectHoliday.
 * Each was allocated fresh on every crypto/holiday-intent turn; now built once
 * at module load. First-match insertion order and read-only consumption of the
 * maps must stay stable.
 *
 * 2026-09-27 契约变更:「抽不到实体就回退到默认值」这套 fallback 已被**有意移除**
 * （币价 → bitcoin、节假日 → CN 属于「把猜测当事实答给用户」）。未命中关键词时改为
 * 返回 needsInput 要求补全实体。故下方两条断言从「回退到默认值」改为「拒绝臆测」——
 * 本文件的原始目的（map 条目 hoist 后仍按插入序命中、可重复调用）不变。
 * 详见 .khy/feedback/web-nousable-data-20260927/ 与 localBrainNoGuessContract.test.js。
 */
const brain = require('../../src/services/localBrainService');
const { _detectCrypto, _detectHoliday } = brain;

describe('Local Brain Map Entries Hoist', () => {
  test('crypto detection resolves known keywords to coin ids', () => {
      expect(_detectCrypto('比特币价格').coin).toBe('bitcoin');
      expect(_detectCrypto('eth 现在多少').coin).toBe('ethereum');
      expect(_detectCrypto('狗狗币').coin).toBe('dogecoin');
  });

  test('crypto detection refuses instead of guessing a default coin', () => {
      // No specific coin keyword present -> ask which coin; never pick one for the user.
      const plan = _detectCrypto('币价怎么样');
      expect(plan.coin).toBeUndefined();
      expect(plan.needsInput).toBeTruthy();
      expect(plan.needsInput.field).toBe('币种');
  });

  test('holiday detection resolves country keywords to ISO codes', () => {
      expect(_detectHoliday('美国节假日').country).toBe('US');
      expect(_detectHoliday('japan holiday').country).toBe('JP');
      expect(_detectHoliday('德国假期').country).toBe('DE');
  });

  test('holiday detection refuses instead of guessing a default country', () => {
      const plan = _detectHoliday('放假安排');
      expect(plan.country).toBeUndefined();
      expect(plan.needsInput).toBeTruthy();
      expect(plan.needsInput.field).toBe('国家/地区');
  });

  test('repeated calls are stable (shared entries arrays not corrupted)', () => {
      expect(_detectCrypto('比特币').coin).toBe(_detectCrypto('比特币').coin);
      expect(_detectHoliday('美国').country).toBe(_detectHoliday('美国').country);
  });

});
