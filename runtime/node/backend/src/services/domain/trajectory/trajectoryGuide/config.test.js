'use strict';

/**
 * config.test.js — co-located suite for the trajectoryGuide env knob source.
 *
 * IO: none on disk — the module only reads process.env. Every KHY_TRAJ_* key touched
 * here is snapshotted before the suite and restored verbatim in `after`, so ambient
 * CI/user env survives the run.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'KHY_TRAJ_AI_REPLAY',
  'KHY_TRAJ_GUIDE_INJECT',
  'KHY_TRAJ_REPAIR_MAX',
  'KHY_TRAJ_REPAIR_TIMEOUT_MS',
  'KHY_TRAJ_REPAIR_MODEL',
  'KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH',
  'KHY_TRAJ_GUIDE_CHARS',
];

const SAVED = {};
for (const k of ENV_KEYS) {
  SAVED[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
}

function clearEnv() {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

function setEnv(patch) {
  clearEnv();
  for (const [k, v] of Object.entries(patch)) {
    process.env[k] = v;
  }
}

const cfg = require('./config');

after(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = SAVED[k];
    }
  }
});

describe('trajectoryGuide/config — 能力开关与数值旋钮', () => {
  it('未设任何环境变量时两能力默认关、数值取命名默认', () => {
    clearEnv();
    assert.equal(cfg.isAiReplayEnabled(), false);
    assert.equal(cfg.isGuideInjectEnabled(), false);
    assert.equal(cfg.repairMax(), 1);
    assert.equal(cfg.repairTimeoutMs(), 120000);
    assert.equal(cfg.repairModel(), null);
    assert.equal(cfg.mapAuthorMinStrength(), 'strong');
    assert.equal(cfg.guideChars(), 1200);
  });

  it('布尔开关接受 on/1/true/yes 且大小写不敏感、容忍首尾空白', () => {
    for (const v of ['on', 'ON', '1', 'true', 'TRUE', 'yes', 'Yes', '  on  ']) {
      setEnv({ KHY_TRAJ_AI_REPLAY: v });
      assert.equal(cfg.isAiReplayEnabled(), true, v);
    }
  });

  it('布尔开关拒绝 0/off/空串/乱值/带后缀的值', () => {
    for (const v of ['0', 'off', '', 'no', 'false', 'onions', '1x', 'onn', 'yess']) {
      setEnv({ KHY_TRAJ_GUIDE_INJECT: v });
      assert.equal(cfg.isGuideInjectEnabled(), false, JSON.stringify(v));
    }
  });

  it('repairMax 只接受正整数：0/负数/乱值回退默认，小数截断', () => {
    setEnv({ KHY_TRAJ_REPAIR_MAX: '3' });
    assert.equal(cfg.repairMax(), 3);
    for (const [v, want] of [['0', 1], ['-2', 1], ['abc', 1], ['', 1], ['2.9', 2]]) {
      setEnv({ KHY_TRAJ_REPAIR_MAX: v });
      assert.equal(cfg.repairMax(), want, v);
    }
  });

  it('repairTimeoutMs 与 guideChars 走同一正整数解析', () => {
    setEnv({ KHY_TRAJ_REPAIR_TIMEOUT_MS: '5000', KHY_TRAJ_GUIDE_CHARS: '800' });
    assert.equal(cfg.repairTimeoutMs(), 5000);
    assert.equal(cfg.guideChars(), 800);
    setEnv({ KHY_TRAJ_REPAIR_TIMEOUT_MS: 'NaN', KHY_TRAJ_GUIDE_CHARS: '-1' });
    assert.equal(cfg.repairTimeoutMs(), 120000);
    assert.equal(cfg.guideChars(), 1200);
  });

  it('repairModel 去空白返回字符串，全空白或未设返回 null', () => {
    setEnv({ KHY_TRAJ_REPAIR_MODEL: '  gemini-3  ' });
    assert.equal(cfg.repairModel(), 'gemini-3');
    setEnv({ KHY_TRAJ_REPAIR_MODEL: '   ' });
    assert.equal(cfg.repairModel(), null);
    clearEnv();
    assert.equal(cfg.repairModel(), null);
  });

  it('mapAuthorMinStrength 只认 weak/strong（小写化），其余值回退 strong', () => {
    setEnv({ KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH: 'WEAK' });
    assert.equal(cfg.mapAuthorMinStrength(), 'weak');
    setEnv({ KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH: ' Strong ' });
    assert.equal(cfg.mapAuthorMinStrength(), 'strong');
    setEnv({ KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH: 'medium' });
    assert.equal(cfg.mapAuthorMinStrength(), 'strong');
  });

  it('每次调用现读 env，开关可在运行中翻转', () => {
    clearEnv();
    assert.equal(cfg.isAiReplayEnabled(), false);
    process.env.KHY_TRAJ_AI_REPLAY = '1';
    assert.equal(cfg.isAiReplayEnabled(), true);
    delete process.env.KHY_TRAJ_AI_REPLAY;
    assert.equal(cfg.isAiReplayEnabled(), false);
  });

  it('DEFAULTS 被 Object.freeze 冻结，strict 模式下改写抛 TypeError', () => {
    assert.throws(() => {
      cfg.DEFAULTS.repairMax = 99;
    }, TypeError);
    assert.equal(cfg.DEFAULTS.repairMax, 1);
    assert.deepEqual(Object.keys(cfg.DEFAULTS).sort(), [
      'guideChars',
      'mapAuthorMinStrength',
      'repairMax',
      'repairTimeoutMs',
    ]);
  });
});
