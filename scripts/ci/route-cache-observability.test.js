'use strict';

/**
 * cache 可观测性探针的自证测试。
 *
 * 这个探针的产出是一条**决策依据**（switchPenalty 该不该非零），
 * 所以它必须满足：扫到了东西（不是路径写错导致的空）、正控命中、且判据不对称时自己报 GAP。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const { scan } = require('./route-cache-observability');
const REPO = path.resolve(__dirname, '..', '..');

test('扫描非空（路径写错会让「零」看起来像结论）', () => {
  const r = scan();
  assert.ok(r.adaptersScanned >= 10, `只扫到 ${r.adaptersScanned} 个适配器 = 目录路径大概率错`);
  assert.strictEqual(
    r.cacheAwareAdapters.length + r.cacheBlindAdapters.length,
    r.adaptersScanned,
    '两类之和不等于扫描数 = 有适配器被漏分类'
  );
});

test('正控：已知会规范化 cache 用量的三个适配器都必须被判为可观测', () => {
  const r = scan();
  for (const a of ['claudeAdapter', 'codexAdapter', 'relayApiAdapter']) {
    assert.ok(r.cacheAwareAdapters.includes(a), `${a} 被判为不可观测 —— 判据太严`);
  }
});

test('负控：一个确实不碰 cache 的适配器不许被误判为可观测', () => {
  const r = scan();
  // clipboard/本地类通道没有厂商 cache 语义；若这里被判可观测，说明判据在乱匹配
  for (const a of ['clipboardRelayAdapter', 'localLLMAdapter']) {
    if (!r.cacheBlindAdapters.includes(a) && !r.cacheAwareAdapters.includes(a)) continue;
    assert.ok(
      r.cacheBlindAdapters.includes(a),
      `${a} 被判为可观测 —— 请核对它是否真的开始产出 cacheRead`
    );
  }
});

test('本地 prompt cache：key 含 model，但请求路径零消费者 → 纸面成本', () => {
  const r = scan();
  assert.strictEqual(r.localCacheKeyIncludesModel, true,
    'computeKey 的 model 字段被删了？那换模型不再必然 miss，结论要重判');
  assert.ok(Array.isArray(r.localCacheConsumers));
  assert.strictEqual(r.localCacheConsumers.length, 0,
    '本地缓存出现了消费者 —— switchPenalty 的前提变了，必须重读 §5.4 再决定');
});

test('决策：可观测性不对称时必须给出 0 并说明理由', () => {
  const r = scan();
  assert.strictEqual(r.decision.switchPenalty, 0);
  assert.ok(typeof r.decision.reason === 'string' && r.decision.reason.length > 10);
  assert.ok(r.gaps.some((g) => /不对称/.test(g)), '3/19 的不对称必须被报出来，不能静默给结论');
});

test('CLI 可跑且输出含决策行', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'route-cache-observability.js')], {
    cwd: REPO, encoding: 'utf8', timeout: 60000,
  });
  assert.match(out, /switchPenalty = 0/);
  assert.match(out, /适配器扫描数: \d+/);
});
