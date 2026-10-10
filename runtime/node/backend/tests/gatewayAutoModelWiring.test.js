'use strict';
/**
 * gatewayAutoModelWiring.test.js — 接线契约:CLI gateway handler 把「Auto」选择持久化成
 * adapter=auto 哨兵 + 清空 GATEWAY_PREFERRED_MODEL(而非把字�?'auto' 写进 model),门控关则
 * 逐字节回退旧持久化�?goal「khy 在模型列表下设置一�?auto 模型」�?
 *
 * 手法:�?require 缓存�?gatewayEnvFile.writeEnvPatch 替换�?spy(零真�?.env 写入),
 * 再直接调 persistGatewayPreference 断言落到 env �?map/unset�?
 */
const path = require('node:path');
const assert = require('node:assert');
const BACKEND = path.join(__dirname, '..');
const envFilePath = require.resolve(path.join(BACKEND, 'src/services/gatewayEnvFile'));
const handlerPath = require.resolve(path.join(BACKEND, 'src/cli/handlers/gateway'));
// Install a spy over gatewayEnvFile.writeEnvPatch before the handler binds it.
const realEnvFile = require(envFilePath);
const _origWrite = realEnvFile.writeEnvPatch;
let _lastPatch = null;
realEnvFile.writeEnvPatch = (envMap, unsetKeys, options) => {
  _lastPatch = { envMap, unsetKeys, options };
  return { ok: true };
};
const handler = require(handlerPath);
afterAll(() => { realEnvFile.writeEnvPatch = _origWrite; });
function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}
const ON = (fn) => withEnv('KHY_AUTO_MODEL_SELECT', undefined, fn);
const OFF = (fn) => withEnv('KHY_AUTO_MODEL_SELECT', '0', fn);

describe('Gateway Auto Model Wiring', () => {
  test('ON: Auto selection �?adapter=auto + GATEWAY_PREFERRED_MODEL unset (not literal auto)', () => {
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
        expect(_lastPatch).toBeTruthy();
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('auto');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_STRICT).toBe('true');
        // model must NOT be persisted as the literal 'auto'
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe(undefined);
        assert.deepEqual(_lastPatch.unsetKeys, ['GATEWAY_PREFERRED_MODEL']);
      });
  });

  test('ON: concrete model selection still persists model normally (superset �?no behavior change)', () => {
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'api', model: 'glm-4.6' });
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('api');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe('glm-4.6');
        assert.deepEqual(_lastPatch.unsetKeys, []);
      });
  });

  test('OFF byte-revert: Auto value falls through to canonical persistence (model=auto literal)', () => {
      OFF(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
        // Legacy path: model truthy �?persisted verbatim (documents the pre-fix behavior)
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('auto');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe('auto');
        assert.deepEqual(_lastPatch.unsetKeys, []);
      });
  });

  test('ON: adapter-only auto (model null) also normalizes via legacy unset (no regression)', () => {
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'claude', model: null });
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('claude');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe(undefined);
        assert.deepEqual(_lastPatch.unsetKeys, ['GATEWAY_PREFERRED_MODEL']);
      });
  });

  test('non-interactive blind fallback skips the Auto sentinel (Auto is explicit-only)', () => {
      // Documents the regression fix: with the Auto entry unshifted to the front, the
      // "pick first non-disabled" fallback in handleGatewaySelectModel must NOT pick Auto.
      const autoSelect = require(path.join(BACKEND, 'src/services/gateway/autoModelSelect'));
      const modelChoices = [
        autoSelect.buildAutoChoice(),
        { value: { adapter: 'codex', model: 'gpt-5.3-codex-review' }, disabled: false },
      ];
      const isAuto = autoSelect.isAutoSelection;
      const pick = modelChoices.find(c => c && c.value && !c.disabled && !isAuto(c.value));
      expect(pick.value.adapter).toBe('codex');
      expect(pick.value.model).toBe('gpt-5.3-codex-review');
  });

  test('RUNTIME-006: pinning a REAL channel persists STRICT=false (soft pin, no lease unpin)', () => {
      // 规则 RUNTIME-006 的判据：GATEWAY_PREFERRED_ADAPTER 非空且非 auto 时，
      // GATEWAY_PREFERRED_STRICT 必须显式为 false —— 语义是「首选但不抑制级联回退」。
      // 写 'true' 会让 strictPreferredOnly 为真，进而触发 aiGatewayGenerateMethod 的
      // 「钉选租约」在连续 2 次不可用后把 .env 自动改回 adapter=auto，
      // 用户刚钉的通道被静默抹掉（事故史 codex→windsurf→windsurf→api→api→claude 的复发机制）。
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'trae' });
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('trae');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_STRICT).toBe('false');
        // 判据复述：ADAPTER 非空非 auto ⇒ STRICT === 'false'
        const a = _lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER;
        const s = _lastPatch.envMap.GATEWAY_PREFERRED_STRICT;
        expect(!a || a === 'auto' || s === 'false').toBe(true);
      });
  });

  test('RUNTIME-006: adapter=auto sentinel is exempt and keeps STRICT=true', () => {
      // auto 哨兵不受该规则约束（规则只约束「钉真实通道」），且钉选租约在
      // preferredAdapter === 'auto' 时直接跳过，故保留 true 不改语义。
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('auto');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_STRICT).toBe('true');
      });
  });

});

