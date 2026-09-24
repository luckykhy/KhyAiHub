'use strict';

/**
 * [DESIGN-ARCH-163] D4 视觉能力登记求真 —— 探针 verdict 灌入 adapterVisionCapability。
 * node:test。台账文件经 KHY_VISION_CAP_FILE 指向临时 fixture。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'khy-d4-vision-probe-test');
fs.mkdirSync(TMP_DIR, { recursive: true });
const CAP_FILE = path.join(TMP_DIR, 'vision_capability.json');

const cap = require('../../src/services/gateway/adapterVisionCapability');
const store = require('../../src/services/gateway/visionCapabilityStore');

function writeLedger(entries) {
  fs.writeFileSync(CAP_FILE, JSON.stringify({ version: 1, entries }), 'utf8');
  store.resetCache();
}

function withCapFile(fn) {
  const prev = process.env.KHY_VISION_CAP_FILE;
  process.env.KHY_VISION_CAP_FILE = CAP_FILE;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_VISION_CAP_FILE;
    else process.env.KHY_VISION_CAP_FILE = prev;
    store.resetCache();
  }
}

function entry(overrides) {
  return {
    verdict: 'supported',
    model: 'some-model',
    adapter: 'sensenova',
    pool: '',
    apiFormat: '',
    endpoint: '',
    measuredAt: Date.now(),
    latencyMs: 100,
    reason: 'probe_visual_attributes_observed',
    source: 'probe',
    ...overrides,
  };
}

test('D4-1 实测 supported 的 adapter(非内置)自动获得 native-vision 判定', () => {
  withCapFile(() => {
    writeLedger({ 'k|a|b|c|d|e': entry({ adapter: 'sensenova' }) });
    assert.strictEqual(cap.adapterHandlesImagesNatively('sensenova', {}), true);
  });
});

test('D4-2 实测 unsupported 可否决内置名单(codex 被上游拒图 → 剥 OCR 才是真话)', () => {
  withCapFile(() => {
    writeLedger({ 'k|a|b|c|d|e': entry({ adapter: 'codex', verdict: 'unsupported' }) });
    assert.strictEqual(cap.adapterHandlesImagesNatively('codex', {}), false);
  });
});

test('D4-3 env 显式覆盖优先级不变:unsupported 台账下 KHY_NATIVE_VISION_ADAPTERS 仍放行', () => {
  withCapFile(() => {
    writeLedger({ 'k|a|b|c|d|e': entry({ adapter: 'codex', verdict: 'unsupported' }) });
    assert.strictEqual(
      cap.adapterHandlesImagesNatively('codex', { KHY_NATIVE_VISION_ADAPTERS: 'codex' }),
      true
    );
  });
});

test('D4-4 过 TTL 的实测记录被忽略 → 回退内置名单', () => {
  withCapFile(() => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    writeLedger({
      'k|a|b|c|d|e': entry({ adapter: 'sensenova', measuredAt: ancient }),
      'k2|a|b|c|d|e': entry({ adapter: 'codex', verdict: 'unsupported', measuredAt: ancient }),
    });
    assert.strictEqual(cap.adapterHandlesImagesNatively('sensenova', {}), false);
    assert.strictEqual(cap.adapterHandlesImagesNatively('codex', {}), true);
  });
});

test('D4-5 无实测记录 → 逐字节回退旧行为(内置名单)', () => {
  withCapFile(() => {
    writeLedger({});
    assert.strictEqual(cap.adapterHandlesImagesNatively('codex', {}), true);
    assert.strictEqual(cap.adapterHandlesImagesNatively('sensenova', {}), false);
  });
});

test('D4-6 门控 KHY_ADAPTER_NATIVE_VISION=0 → supported 台账也恒 false', () => {
  withCapFile(() => {
    writeLedger({ 'k|a|b|c|d|e': entry({ adapter: 'sensenova' }) });
    assert.strictEqual(
      cap.adapterHandlesImagesNatively('sensenova', { KHY_ADAPTER_NATIVE_VISION: '0' }),
      false
    );
  });
});

test('D4-7 台账文件损坏 → 不抛,回退内置名单', () => {
  withCapFile(() => {
    fs.writeFileSync(CAP_FILE, '{not json', 'utf8');
    store.resetCache();
    assert.strictEqual(cap.adapterHandlesImagesNatively('codex', {}), true);
    assert.strictEqual(cap.adapterHandlesImagesNatively('sensenova', {}), false);
  });
});

test('D4-8 adapter 名大小写不敏感匹配台账条目', () => {
  withCapFile(() => {
    writeLedger({ 'k|a|b|c|d|e': entry({ adapter: 'SenseNova' }) });
    assert.strictEqual(cap.adapterHandlesImagesNatively('SENSENOVA', {}), true);
  });
});
