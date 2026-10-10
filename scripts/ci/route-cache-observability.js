'use strict';

/**
 * route-cache-observability — 数一遍「哪些适配器真的能观测到 prompt cache」
 * （[DESIGN-ARCH-185] §14-D5 / §5.4 的 switchPenalty 前置测量）。
 *
 * 为什么要有这个文件：§5.4 的 `switchPenalty` 建模的前提是
 * 「换模型会作废 provider 侧 prompt cache，且这个损失可计量」。
 * 这句话在论文里是断言（E2），在 opensquilla 代码里是一个 `kv_cache_aware: true` 开关（E1），
 * 但**本仓是否成立从未量过**。量之前把它置 0 是诚实；量完还是置 0 就是**依据**。
 *
 * 它测三件事：
 *   ① 哪些适配器 require 了 cache 用量规范化器（= 能产出 cacheRead 计量）；
 *   ② 本地 promptCacheService 的 cache key 含不含 model（含 → 换模型必 miss）；
 *   ③ 那个本地服务在请求路径上到底有没有消费者。
 *
 * ③ 是决定性的：② 为真但 ③ 为零时，「换模型会作废本地缓存」只是**纸面成本**，
 * 把它计入 penalty 会让路由表上多一项不存在的损失。
 *
 * 只读：不联网、不调模型、不改任何文件。
 */

const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..', 'runtime', 'node', 'backend');
const ADAPTER_DIR = path.join(BACKEND, 'src', 'services', 'gateway', 'adapters');
const CACHE_NORMALIZER = '_cacheUsage';

function _listJs(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  } catch {
    return [];
  }
}

function _read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 去掉注释与字符串外的干扰：注释里提到 cache 不算实现。 */
function _stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[^:]\/\/.*$/gm, '');
}

function scan() {
  const report = {
    adaptersScanned: 0,
    cacheAwareAdapters: [],
    cacheBlindAdapters: [],
    localCacheKeyIncludesModel: null,
    localCacheConsumers: [],
    decision: null,
    gaps: [],
  };

  const files = _listJs(ADAPTER_DIR);
  // 排除共享件（下划线前缀）与测试，只数真适配器
  const adapters = files.filter(
    (f) => !f.startsWith('_') && !f.endsWith('.test.js') && /Adapter\.js$/.test(f)
  );
  report.adaptersScanned = adapters.length;

  for (const f of adapters) {
    const src = _stripComments(_read(path.join(ADAPTER_DIR, f)));
    const requires = new RegExp(`require\\(['"]\\.\\/${CACHE_NORMALIZER}['"]\\)`).test(src);
    const emits = /cacheReadInputTokens|cache_read_input_tokens/.test(src);
    // 判据是 **或** 不是 **与**：relayApiAdapter 只调 normalizeCacheUsage()，
    // 自己文件里不出现 cacheReadInputTokens 字面量 —— 用「与」会把它漏判成不可观测。
    // （第一版就是犯了这个错，实测少算一个。）
    if (requires || emits) report.cacheAwareAdapters.push(f.replace(/\.js$/, ''));
    else report.cacheBlindAdapters.push(f.replace(/\.js$/, ''));
  }
  if (report.adaptersScanned === 0) {
    report.gaps.push('适配器目录为空或路径错 —— 本次扫描的「零」不可信');
  }

  // ② 本地 prompt cache 的 key 组成
  const pcs = _read(path.join(BACKEND, 'src', 'services', 'promptCacheService.js'));
  if (!pcs) {
    report.gaps.push('promptCacheService.js 读不到 —— 本地缓存那一半无法判定');
  } else {
    const keyFn = pcs.match(/computeKey\([\s\S]*?\n\s*\}/);
    report.localCacheKeyIncludesModel = !!keyFn && /\bmodel\b/.test(String(keyFn));
  }

  // ③ 本地缓存的消费者（排除它自己与 index.js 的再导出）
  const srcRoot = path.join(BACKEND, 'src');
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        const base = path.basename(full);
        if (base === 'promptCacheService.js' || base === 'index.js') continue;
        if (/promptCacheService/.test(_stripComments(_read(full)))) {
          report.localCacheConsumers.push(path.relative(BACKEND, full).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(srcRoot, 0);

  const aware = report.cacheAwareAdapters.length;
  const total = report.adaptersScanned;
  if (total > 0 && aware === 0) {
    report.gaps.push('没有任何适配器产出 cacheRead 计量：switchPenalty 无处取值');
  }
  if (aware > 0 && aware < total) {
    report.gaps.push(
      `cache 可观测性不对称：${aware}/${total} 个适配器可计量。`
      + '此时若只对可观测的那几个计 penalty，会把路由**系统性推离**支持 cache 的渠道 —— '
      + 'penalty 的作用是抑制档位振荡，不是惩罚有缓存的渠道。'
    );
  }

  report.decision = {
    switchPenalty: 0,
    reason:
      report.localCacheConsumers.length === 0 && aware < total
        ? `本地 prompt cache 零消费者（纸面成本），provider 侧仅 ${aware}/${total} 可观测`
        : '见 gaps：需重判',
    reversibleBy: '把 switchPenalty 从 0 改为公式前，本探针必须显示全池可观测',
  };
  return report;
}

function main() {
  const r = scan();
  const asJson = process.argv.includes('--json');
  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    const lines = [];
    lines.push(`适配器扫描数: ${r.adaptersScanned}`);
    lines.push(`可观测 cacheRead: ${r.cacheAwareAdapters.length} → ${r.cacheAwareAdapters.join(', ') || '(无)'}`);
    lines.push(`不可观测: ${r.cacheBlindAdapters.length} 个`);
    lines.push(`本地 promptCacheService 的 key 含 model: ${r.localCacheKeyIncludesModel}`);
    lines.push(`本地 promptCacheService 请求路径消费者: ${r.localCacheConsumers.length} → ${r.localCacheConsumers.join(', ') || '(无)'}`);
    lines.push(`结论: switchPenalty = ${r.decision.switchPenalty}｜${r.decision.reason}`);
    if (r.gaps.length) {
      lines.push('GAP / 风险:');
      for (const g of r.gaps) lines.push(`  - ${g}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stdout.write(`探针自身异常（不阻断）: ${e && e.message}\n`);
    process.exitCode = 0;
  }
}

module.exports = { scan };
