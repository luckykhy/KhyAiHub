'use strict';

// 面向用户字符串应中文（AGENTS.md 语言策略）。transparencyService 的 7 个格式化
// 函数是每轮 AI 回复都会 console.log 的终端 chrome（消费者：cli/transparency.js ←
// cli/aiRenderer.js），此前整屏英文对中文用户是噪音。现把静态散文标签归一为中文；
// 动态 model/adapter/rule 名、数字/货币、↑↓⚡✻✗✓→⚠ 字形与格式单位保持原样。
// 本测试锁死中文标签在、旧英文词不在（防再次混入英文）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

const assert = require('assert');
const nt = require('node:test');
const t = require('../../src/services/transparencyService');

nt.test('formatTurnCost: 词元/已缓存/经由', () => {
  const s = t.formatTurnCost({
    inputTokens: 1234,
    outputTokens: 56,
    cacheReadTokens: 800,
    costUSD: 0.0123,
    model: 'gpt-4o',
    adapter: 'openai',
    durationMs: 5300,
  });
  assert.ok(s.includes('词元'), s);
  assert.ok(s.includes('已缓存'), s);
  assert.ok(s.includes('经由 openai'), s);
  // 动态 model 名保留
  assert.ok(s.includes('gpt-4o'), s);
  assert.ok(!/\btokens\b/.test(s), s);
  assert.ok(!/\bcached\b/.test(s), s);
});

nt.test('formatCascadeSteps: 未知/失败 兜底', () => {
  const s = t.formatCascadeSteps([{ success: false }]);
  assert.ok(s.includes('未知'), s);
  assert.ok(s.includes('失败'), s);
  assert.ok(!/\bunknown\b/.test(s), s);
  assert.ok(!/\bfailed\b/.test(s), s);
});

nt.test('formatPermissionTier: 层级/危险/已拒绝 + 安全/已批准', () => {
  const d = t.formatPermissionTier({ tier: 'dangerous', matchedRule: 'rm-rf', approved: false });
  assert.ok(d.includes('层级：'), d);
  assert.ok(d.includes('危险'), d);
  assert.ok(d.includes('已拒绝'), d);
  assert.ok(d.includes('[rm-rf]'), 'matchedRule 保留', d);
  assert.ok(!/\btier:/.test(d), d);
  assert.ok(!/\bblocked\b/.test(d), d);
  const a = t.formatPermissionTier({ tier: 'safe', approved: true });
  assert.ok(a.includes('安全'), a);
  assert.ok(a.includes('已批准'), a);
});

nt.test('checkQuotaWarning: 配额即将用尽/偏高/配额', () => {
  assert.ok(t.checkQuotaWarning({ used: 970, limit: 1000 }).includes('配额即将用尽'));
  assert.ok(t.checkQuotaWarning({ used: 920, limit: 1000 }).includes('配额偏高'));
  const low = t.checkQuotaWarning({ used: 85, limit: 100 });
  assert.ok(low.includes('配额：已用'), low);
  assert.ok(!/Quota/.test(low), low);
});

nt.test('formatCompactionNotice: 上下文已压缩/词元/节省', () => {
  const s = t.formatCompactionNotice({ beforeTokens: 12000, afterTokens: 4000, durationMs: 2300 });
  assert.ok(s.includes('上下文已压缩'), s);
  assert.ok(s.includes('节省'), s);
  assert.ok(s.includes('词元'), s);
  assert.ok(!/Context compacted/.test(s), s);
});

nt.test('formatEditPreview: 预览编辑/删除行/新增行', () => {
  const many = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13';
  const ep = t.formatEditPreview({ filePath: 'a.js', oldContent: many, newContent: many });
  assert.ok(ep.header.includes('预览编辑：'), ep.header);
  assert.ok(ep.header.includes('a.js'), 'filePath 保留', ep.header);
  const blob = ep.diffLines.join('\n');
  assert.ok(blob.includes('删除行'), blob);
  assert.ok(blob.includes('新增行'), blob);
  assert.ok(!/removed lines/.test(blob), blob);
  assert.ok(!/added lines/.test(blob), blob);
});
