'use strict';

// 纯叶子单测:零网络、零 mock、零 IO。叶子 = src/services/tool/searchFailureSignal.js
const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../src/services/tool/searchFailureSignal');

async function withEnv(val, fn) {
  const prev = process.env.KHY_SEARCH_FAILURE_SIGNAL;
  if (val === undefined) delete process.env.KHY_SEARCH_FAILURE_SIGNAL;
  else process.env.KHY_SEARCH_FAILURE_SIGNAL = val;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_SEARCH_FAILURE_SIGNAL;
    else process.env.KHY_SEARCH_FAILURE_SIGNAL = prev;
  }
}

// ── 门控 ────────────────────────────────────────────────────────────
test('isEnabled:默认开,仅 0/false/off/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_SEARCH_FAILURE_SIGNAL: '' }), true);
  assert.equal(leaf.isEnabled({ KHY_SEARCH_FAILURE_SIGNAL: 'maybe' }), true);
  for (const off of ['0', 'false', 'OFF', 'No']) {
    assert.equal(leaf.isEnabled({ KHY_SEARCH_FAILURE_SIGNAL: off }), false, `${off} 应关门`);
  }
});

// ── 分类:全引擎失败 / 零结果 / 有结果 ────────────────────────────────
test('classifySearchPayload:失败 → all-sources-failed,并带上逐引擎成因', () => {
  const s = leaf.classifySearchPayload(
    {
      success: false,
      error: '当前环境无法访问外网搜索引擎',
      partialFailures: [
        { engine: 'baidu', message: 'Baidu search timed out' },
        { engine: 'bing-cn', message: 'no results parsed from response' },
      ],
    },
    { query: 'node 22 lts release date' }
  );
  assert.equal(s.kind, leaf.KINDS.ALL_SOURCES_FAILED);
  assert.equal(s.tool, 'webSearch');
  assert.equal(s.target, 'node 22 lts release date');
  assert.deepEqual(s.attempted, [
    { source: 'baidu', reason: 'Baidu search timed out' },
    { source: 'bing-cn', reason: 'no results parsed from response' },
  ]);
  assert.match(s.detail, /无法访问外网/);
});

test('classifySearchPayload:成功但零条 → no-results', () => {
  const s = leaf.classifySearchPayload({ success: true, results: [] }, { query: 'q' });
  assert.equal(s.kind, leaf.KINDS.NO_RESULTS);
});

test('classifySearchPayload:成功且有条目 → null(不误报)', () => {
  assert.equal(
    leaf.classifySearchPayload({ success: true, results: [{ url: 'https://example.org/a' }] }),
    null
  );
});

test('classifySearchPayload:坏输入 → null(绝不抛)', () => {
  for (const bad of [null, undefined, 0, '', 'x', []]) {
    assert.equal(leaf.classifySearchPayload(bad), null);
  }
});

test('classifySearchPayload:target 截断到上限,不随查询无界增长', () => {
  const s = leaf.classifySearchPayload({ success: false }, { query: 'x'.repeat(500) });
  assert.ok(s.target.length <= leaf.MAX_TARGET_CHARS, `target 长度 ${s.target.length} 应 <= ${leaf.MAX_TARGET_CHARS}`);
});

// ── 分类:抓取成功但正文为空 ──────────────────────────────────────────
test('classifyFetchResult:contentLength=0 → empty-extraction', () => {
  const s = leaf.classifyFetchResult({ url: 'https://example.org/spa', contentLength: 0 });
  assert.equal(s.kind, leaf.KINDS.EMPTY_EXTRACTION);
  assert.equal(s.tool, 'WebFetch');
});

test('classifyFetchResult:有正文 / 无计数 → null(零假阳性)', () => {
  assert.equal(leaf.classifyFetchResult({ url: 'u', contentLength: 10 }), null);
  assert.equal(leaf.classifyFetchResult({ url: 'u' }), null);
  assert.equal(leaf.classifyFetchResult({ url: 'u', contentLength: NaN }), null);
});

// ── normalizeAttempted ──────────────────────────────────────────────
test('normalizeAttempted:容忍缺字段与坏条目,上限 4 条', () => {
  const out = leaf.normalizeAttempted([
    { engine: 'a', message: 'm' },
    { message: 'only-reason' },
    { engine: 'only-source' },
    null,
    'garbage',
    { engine: 'e', message: 'f' },
  ]);
  assert.equal(out.length, leaf.MAX_ATTEMPTED);
  assert.deepEqual(out[1], { source: 'unknown-source', reason: 'only-reason' });
  assert.deepEqual(out[2], { source: 'only-source', reason: 'no reason reported' });
});

test('normalizeAttempted:非数组 → []', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.deepEqual(leaf.normalizeAttempted(bad), []);
  }
});

// ── 替代路径与渲染 ──────────────────────────────────────────────────
test('buildFallbackPaths:检索类给 2–3 条,含「抓已知站点」与「诚实回报」', () => {
  const paths = leaf.buildFallbackPaths({ kind: leaf.KINDS.ALL_SOURCES_FAILED });
  assert.ok(paths.length >= 2 && paths.length <= 3, `路径数 ${paths.length} 应在 2–3`);
  assert.match(paths[0], /WebFetch/);
  assert.match(paths[paths.length - 1], /[Dd]o NOT fabricate/);
});

test('buildFallbackPaths:空提取类的路径指向换源/换页,而非重搜同页', () => {
  const paths = leaf.buildFallbackPaths({ kind: leaf.KINDS.EMPTY_EXTRACTION });
  assert.equal(paths.length, 3);
  assert.match(paths[0], /different, static page/);
});

test('renderSignal:含机读标记 + 已试来源 + 编号路径 + 强制决策祈使句', () => {
  const s = leaf.classifySearchPayload(
    { success: false, partialFailures: [{ engine: 'baidu', message: 'boom' }] },
    { query: 'q' }
  );
  const text = leaf.renderSignal(s);
  assert.ok(text.includes(leaf.MARKER), '必须含可机读标记');
  assert.match(text, /Attempted sources:/);
  assert.match(text, /- baidu: boom/);
  assert.match(text, /You must now take one of these paths/);
  assert.match(text, /^\s*1\. /m);
});

test('renderSignal:非法信号 → \'\'(绝不抛)', () => {
  for (const bad of [null, undefined, {}, { kind: '' }]) {
    assert.equal(leaf.renderSignal(bad), '');
  }
});

test('标记能穿透 _buildToolResultMessage(否则模型/循环再也认不出来)', () => {
  const helpers = require('../src/services/tool/toolUseLoopHelpers');
  const msg = helpers._buildToolResultMessage([
    {
      tool: 'webSearch',
      result: {
        success: false,
        error: '当前环境无法访问外网搜索引擎',
        failureSignal: leaf.classifySearchPayload(
          { success: false, partialFailures: [{ engine: 'baidu', message: 'Baidu search timed out' }] },
          { query: 'q' }
        ),
      },
    },
  ]);
  assert.ok(msg.text.includes(`Error: 当前环境无法访问外网搜索引擎`), '既有 Error 行须保留');
  assert.ok(msg.text.includes(leaf.MARKER), '标记必须原样穿透 sanitize');
  assert.ok(msg.text.includes('- baidu: Baidu search timed out'), '逐引擎成因须内联');
  assert.ok(msg.text.includes('You must now take one of these paths'), '强制决策祈使句须内联');
  // 防注入改写仍须生效（信号不得把 [SYSTEM: 带进去）
  assert.ok(!/\[SYSTEM:/.test(msg.text), '工具结果正文里不得出现真实 [SYSTEM: 指令');
  // 结构化块同步带上
  const entry = msg.structuredToolResults.find((e) => e.tool === 'webSearch');
  assert.ok(entry && entry.content.includes(leaf.MARKER), 'structured 路径同样须含标记');
  assert.equal(entry.is_error, true);
});

test('_buildToolResultMessage:覆盖面不全走**中性** Coverage 标注,而非红色失败', () => {
  const helpers = require('../src/services/tool/toolUseLoopHelpers');
  // 成功路径要读 payload,而 _extractToolOutput 由 core 在加载时注入 —— 这里补一个最小实现。
  const leafOutput = require('../src/services/tool/loop/toolOutput');
  helpers.setToolUseLoopHelpersDeps({ _extractToolOutput: leafOutput._extractToolOutput });
  const msg = helpers._buildToolResultMessage([
    {
      tool: 'webSearch',
      result: {
        success: true,
        content: '{"results":[{"url":"https://example.org/a"}]}',
        data: { results: [{ url: 'https://example.org/a' }] },
        coverageNotice: '仅 1 个引擎失败,本次结果为其余引擎的合并召回(覆盖面不全,勿当作全网共识):baidu(Baidu search timed out)',
      },
    },
  ]);
  assert.ok(msg.text.includes('[Coverage: 仅 1 个引擎失败'), '须标注覆盖面不全');
  const entry = msg.structuredToolResults.find((e) => e.tool === 'webSearch');
  assert.equal(entry.is_error, false, '有结果就不是错误 —— 不得走红色失败通道');
  assert.ok(!msg.text.includes(leaf.MARKER), '有结果不得出现失败标记');
});

// ── 轮级指令 ────────────────────────────────────────────────────────
test('buildRoundDirective:预算未耗尽 → 允许一次换词重试,禁止重复同一查询', () => {
  const d = leaf.buildRoundDirective({ attemptsUsed: 1, maxAttempts: 2, signalCount: 1 });
  assert.match(d, /^\[SYSTEM: /);
  assert.match(d, /Do NOT repeat the same query/);
});

test('buildRoundDirective:预算耗尽 → 停止检索并要求诚实收尾', () => {
  const d = leaf.buildRoundDirective({ attemptsUsed: 2, maxAttempts: 2, signalCount: 2 });
  assert.match(d, /Stop calling web tools now/);
  assert.match(d, /Do not fabricate/);
});

test('buildRoundDirective:坏输入仍返回合法指令(不抛)', () => {
  assert.match(leaf.buildRoundDirective({}), /^\[SYSTEM: /);
  assert.match(leaf.buildRoundDirective(), /^\[SYSTEM: /);
});

// ── hasUsableWebData:循环侧判定入口 ──────────────────────────────────
test('hasUsableWebData:失败 / 空条目 / 空正文 / 自带失败信号 → false', () => {
  assert.equal(leaf.hasUsableWebData({ success: false, error: 'x' }), false);
  assert.equal(leaf.hasUsableWebData({ success: true, results: [] }), false);
  assert.equal(leaf.hasUsableWebData({ success: true, data: { results: [] } }), false);
  assert.equal(leaf.hasUsableWebData({ success: true, contentLength: 0 }), false);
  assert.equal(
    leaf.hasUsableWebData({
      success: true,
      contentLength: 500,
      failureSignal: { kind: leaf.KINDS.EMPTY_EXTRACTION },
    }),
    false,
    '工具自打的失败信号优先级最高'
  );
});

test('hasUsableWebData:成功且有条目 / 有正文 → true', () => {
  assert.equal(leaf.hasUsableWebData({ success: true, results: [{ url: 'u' }] }), true);
  assert.equal(leaf.hasUsableWebData({ success: true, data: { results: [{ url: 'u' }] } }), true);
  assert.equal(leaf.hasUsableWebData({ success: true, contentLength: 42 }), true);
});

test('hasUsableWebData:非检索/抓取族工具不得被误判为空手而归', () => {
  // read_file 之类只有 content 字符串 —— 必须放行(true),否则会误触强制兜底。
  assert.equal(leaf.hasUsableWebData({ success: true, content: 'file body' }), true);
  assert.equal(leaf.hasUsableWebData({ success: true }), true);
});

test('hasUsableWebData:非对象(结果缺失/裸值)→ false —— 确实没有数据可读', () => {
  for (const bad of [null, undefined, 0, 'x']) {
    assert.equal(leaf.hasUsableWebData(bad), false);
  }
});

test('isWebLookupTool:归一化后识别 webSearch/WebFetch 及其别名', () => {
  for (const name of ['webSearch', 'web_search', 'WebSearch', 'WebFetch', 'web-fetch', 'web_fetch', 'fetch_url']) {
    assert.equal(leaf.isWebLookupTool(name), true, `${name} 应属检索族`);
  }
  for (const name of ['read_file', 'grep', 'shell_command', '']) {
    assert.equal(leaf.isWebLookupTool(name), false, `${name} 不应属检索族`);
  }
});

test('isWebLookupTool:裸 search(本地行情目录检索)必须排除,否则行情查空会被误报成联网失败', () => {
  assert.equal(leaf.isWebLookupTool('search'), false);
  assert.equal(leaf.isWebLookupTool('Search'), false);
  // 与工具循环里的历史宽松口径不同 —— 这是一个刻意的分歧,不是遗漏。
  const helpers = require('../src/services/tool/toolUseLoopHelpers');
  assert.equal(helpers._isWebLookupToolName('search'), true, '既有宽松口径保持不变(历史行为)');
});

// ── 工具返回契约(webSearch 工具真的把信号挂上去了)────────────────────────
// 关键:mock 必须在 execute() 期间保持安装 —— 工具是**惰性** require 服务的,
// 提前还原缓存会让真实服务接管(会真的联网)。
async function withMockedWebSearchService(fake, fn) {
  const svcPath = require.resolve('../src/services/webSearchService');
  const toolPath = require.resolve('../src/tools/webSearch');
  const prevSvc = require.cache[svcPath];
  delete require.cache[toolPath]; // 重新加载工具,确保走本次注入的服务
  require.cache[svcPath] = {
    id: svcPath,
    filename: svcPath,
    loaded: true,
    exports: { search: async () => fake },
  };
  try {
    return await fn(require('../src/tools/webSearch'));
  } finally {
    if (prevSvc === undefined) delete require.cache[svcPath];
    else require.cache[svcPath] = prevSvc;
    delete require.cache[toolPath];
  }
}

test('webSearch 工具:全引擎失败 → 返回契约带上 failureSignal + 不可用判定', async () => {
  await withMockedWebSearchService(
    {
      success: false,
      error: '当前环境无法访问外网搜索引擎',
      partialFailures: [{ engine: 'baidu', message: 'Baidu timed out' }],
      depId: 'cheerio',
    },
    async (tool) => {
      const out = await tool.execute({ query: 'node 22 lts' }, {});
      assert.equal(out.success, false);
      assert.equal(typeof out.error, 'string', 'error 仍是字符串(向后兼容,不改既有契约)');
      assert.equal(out.depId, 'cheerio', 'depId 自愈通道保持不变');
      assert.ok(out.failureSignal, '必须挂上失败信号');
      assert.equal(out.failureSignal.kind, leaf.KINDS.ALL_SOURCES_FAILED);
      assert.equal(out.failureSignal.target, 'node 22 lts');
      assert.equal(leaf.hasUsableWebData(out), false, '循环侧须判定为无可用数据');
    }
  );
});

test('webSearch 工具:有结果但部分引擎失败 → 只挂中性 coverageNotice,不挂失败信号', async () => {
  await withMockedWebSearchService(
    {
      success: true,
      results: [{ title: 'a', url: 'https://example.org/a' }],
      formatted: 'ok',
      partialFailures: [{ engine: 'sogou', message: 'Sogou timed out' }],
    },
    async (tool) => {
      const out = await tool.execute({ query: 'q' }, {});
      assert.equal(out.success, true);
      assert.ok(!out.failureSignal, '有结果就不是失败,不得挂失败信号');
      assert.match(out.coverageNotice, /覆盖面不全/);
      assert.match(out.coverageNotice, /sogou/);
      assert.equal(leaf.hasUsableWebData(out), true, '有结果 → 不得触发强制兜底');
    }
  );
});

test('webSearch 工具:门控关 → 不挂任何新字段,逐字节回退', async () => {
  await withEnv('0', () =>
    withMockedWebSearchService(
      { success: false, error: 'boom', partialFailures: [{ engine: 'baidu', message: 'x' }] },
      async (tool) => {
        const out = await tool.execute({ query: 'q' }, {});
        assert.equal('failureSignal' in out, false, '门关不得引入新字段');
        assert.equal('coverageNotice' in out, false, '门关不得引入新字段');
      }
    )
  );
});

test('_buildToolResultMessage:抓取成功但正文为空(WebFetch 形态)→ 空提取信号内联', () => {
  const helpers = require('../src/services/tool/toolUseLoopHelpers');
  const signal = leaf.classifyFetchResult({ url: 'https://example.org/spa', contentLength: 0 });
  const msg = helpers._buildToolResultMessage([
    { tool: 'WebFetch', result: { success: true, content: '', contentLength: 0, failureSignal: signal } },
  ]);
  assert.ok(msg.text.includes(leaf.MARKER), '空提取须带机读标记');
  assert.ok(msg.text.includes('empty body'), '须说明是空正文');
  assert.ok(msg.text.includes('different, static page'), '须内联换源路径');
  assert.equal(leaf.hasUsableWebData({ success: true, contentLength: 0, failureSignal: signal }), false);
});
