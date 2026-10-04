'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const P = require('./ilinkProtocol');

describe('ilinkProtocol —— 协议常量叶子', () => {
  it('导出面收齐 9 个协议常量', () => {
    assert.deepStrictEqual(Object.keys(P).sort(), [
      'CHANNEL_VERSION',
      'ITEM_TYPE',
      'MESSAGE_STATE',
      'MESSAGE_TYPE',
      'PLATFORM',
      'PLATFORM_LABEL',
      'RET_SESSION_EXPIRED',
      'SEND_BACKOFF_MAX_MS',
      'SPLIT_NEWLINE_MIN_RATIO',
    ]);
  });

  it('平台标识与信道版本逐字固定', () => {
    assert.equal(P.PLATFORM, 'ilink');
    assert.equal(P.PLATFORM_LABEL, '微信(个人号)');
    assert.equal(P.CHANNEL_VERSION, '1.0.0');
  });

  it('MESSAGE_TYPE / ITEM_TYPE / MESSAGE_STATE 取值即报文数值', () => {
    assert.deepStrictEqual({ ...P.MESSAGE_TYPE }, { USER: 1, BOT: 2 });
    assert.deepStrictEqual({ ...P.ITEM_TYPE }, { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 });
    assert.deepStrictEqual({ ...P.MESSAGE_STATE }, { NEW: 0, GENERATING: 1, FINISH: 2 });
  });

  it('会话过期码为 -14（长暂停信号，非通用负数）', () => {
    assert.equal(P.RET_SESSION_EXPIRED, -14);
    assert.ok(P.RET_SESSION_EXPIRED < 0);
  });

  it('分片比例与退避封顶为字面常量', () => {
    assert.equal(P.SPLIT_NEWLINE_MIN_RATIO, 0.3);
    assert.equal(P.SEND_BACKOFF_MAX_MS, 8000);
  });

  // Measured: header doc claims 「冻结值」but Object.isFrozen(leaf) === false and
  // each nested enum is a plain mutable literal — mutating them leaks to every host.
  it('KNOWN-DEFECT: 文档称「冻结值」但枚举对象实际可变且无引用隔离', () => {
    assert.equal(Object.isFrozen(P), false);
    assert.equal(Object.isFrozen(P.MESSAGE_TYPE), false);
    const original = P.ITEM_TYPE.TEXT;
    try {
      P.ITEM_TYPE.TEXT = 999;
      assert.equal(P.ITEM_TYPE.TEXT, 999);
      assert.equal(require('./ilinkProtocol').ITEM_TYPE.TEXT, 999);
    } finally {
      P.ITEM_TYPE.TEXT = original;
    }
    assert.equal(require('./ilinkProtocol').ITEM_TYPE.TEXT, 1);
  });
});
