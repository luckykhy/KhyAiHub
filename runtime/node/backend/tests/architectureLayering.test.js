'use strict';

/**
 * architectureLayering.test.js — 分层边界守卫（DESIGN-ARCH-057）。
 *
 * 契约：cli → services 合法；services → cli 为反向违例。除已登记延后的边外，
 * service 层不得 require cli/*。本测试把"现存反向边"钉成一份显式白名单：
 *   - 新增任何 service→cli 反向边 → 红灯（防止架构债回潮）。
 *   - 白名单里的边被切断后忘了更新白名单 → 红灯（提示收紧白名单）。
 *
 * 已切断（经端口倒置，零反向边）：
 *   toolCalling / preflightPermission → permissionDialog（permissionPromptPort）
 *   inputPreprocessor → inkComponents（interactiveMenuPort）
 *   daemonEntry / crashRecovery → cliErrorReporter（describeCliError 下沉 cliErrorDescriptor）
 *
 * 已切断（经"叶子迁移"——把错放在 cli/ 但零 cli 消费者的纯叶子归位到 services/）：
 *   aiManagementServer → cli/webContextStats     ┐ 上下文可视化家族(webContextStats/
 *   （及其家族 messageBreakdown/contextSuggestions/│ messageBreakdown/contextSuggestions/
 *     contextBreakdown 一并迁至 services/context/）┘ contextBreakdown)本是上下文域逻辑，
 *                                                   与 ctxWindowStats 同属 services/context/。
 *   postEditDiagnostics / toolUseLoop → cli/postEditDiagnosticsSummary（零 cli 消费者 → 迁 services/）
 *   tipHistoryStore → cli/tipScheduler（零 cli 消费者 → 迁 services/）
 *
 * 仍延后（[MGMT-RPT-020] 痛点诊断报告，225KB 巨石，单列后续 PR）：
 *   aiManagementServer → cli/ai
 *   ilinkDispatcher → cli/ai（走 aiChatPort 的会话控制，注册点在 cli/ai.js）
 *
 * 已切断（共享内核叶子归位 D3 + 原路径留再导出壳，[RESEARCH-018] §3.1 P2 批次表）：
 *   deliveryFormatter → cli/toolCallNoise        （toolCallNoise 归位，12.2p）
 *   gatewayResetService → cli/formatters         （consoleNotice 三打印器归位，12.2r）
 *   imageService / tokenUsageService → cli/ccFormat、tokenUsageService → cli/ccModelName
 *                                                （ccFormat / ccModelName 归位，12.2o/p）
 *   toolCallingPermissions → cli/permissionReply （permissionReply 零 require 纯叶，批 18）
 *   tool/toolUseLoopCore + toolUseLoopHelpers → cli/keyFindings、cli/resultGuard
 *                                                （两纯叶归位 utils/text/，批 18）
 *   sessionForestService → cli/ai                （森林三叶子归位，批 16）
 *   —— 其余仍以反向边形态存在的，逐条登记在 ALLOWED_REVERSE_EDGES。
 *
 * 采集器口径（2026-09-28 修正，此前本守卫长期红灯 = 完全失效）：
 *   - 注释不计为边：'../cli/x' 出现在 doc 注释里不是现役 require
 *     （sessionForestService.js:32、markdownWorkbench.js:6 两例即历史注释）；
 *   - 正则锚定 `cli/` 目录段：旧写法 (\.\.\/cli[^'"]*) 会把 '../clients/terminalClient'
 *     从第 3 个字符起误读成 '../cli'（crossPlatform/ws/e2e-test.js 一例）；
 *   - 被 require 的路径按源码深度原样登记（'../../cli/x' ≠ '../cli/x'）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..', 'src', 'services');

// 显式登记：当前允许存在的 service→cli 反向边。键=相对 src/services 的文件，值=被 require 的 cli 路径片段。
// 路径深度按源码原样写（'../../cli/x' 与 '../cli/x' 是不同字符串，本表与采集器逐字比对）。
const ALLOWED_REVERSE_EDGES = [
  { from: 'aiManagementServer.js', to: '../cli/ai' },
  { from: 'domain/messaging/channels/ilinkDispatcher.js', to: '../../../../cli/ai' },
  { from: 'gateway/aiGatewayGenerateMethod.js', to: '../../cli/handlers/mcp' },
  { from: 'tool/toolUseLoopCore.js', to: '../../cli/toolPrefaceVoice' },

  // ── 共享内核债 [DESIGN-ARCH-057] ──────────────────────────────────────────
  // 以下 cli/ 叶子被 cli 与 services 双方消费（纯格式化/域工具，无 IO），是错置在
  // cli/ 的"共享内核"。切断方式=整文件归位 D3 + 原路径留再导出壳（壳不被扫描器跟随，
  // 所以只有消费者改指真身时边才会少）。逐条见 [RESEARCH-018] §3.1 P2 批次表。
  { from: 'aiManagementChatHttp.js', to: '../cli/toolResultSummary' },
  { from: 'healEscalationService.js', to: '../cli/handlers/publish' },
];

const REVERSE_EDGE_RE = /require\(\s*['"]((?:\.\.\/)+cli\/[^'"]*)['"]\s*\)/g;

function stripComments(src) {
  // 只去块注释与整行 // 注释：不截「行尾之后的内容」，否则 'https://' 这类串会把
  // 同一行里真正现役的 require 吞掉（那就是 fail-open）。
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function collectReverseEdges() {
  const edges = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(p, 'utf8'));
      let m;
      REVERSE_EDGE_RE.lastIndex = 0;
      while ((m = REVERSE_EDGE_RE.exec(src))) {
        edges.push({ from: path.relative(SERVICES_DIR, p).split(path.sep).join('/'), to: m[1] });
      }
    }
  };
  walk(SERVICES_DIR);
  return edges;
}

test('service→cli 反向边精确等于已登记白名单（防架构债回潮）', () => {
  const found = collectReverseEdges();
  const norm = (e) => `${e.from} -> ${e.to}`;
  const foundSet = new Set(found.map(norm));
  const allowSet = new Set(ALLOWED_REVERSE_EDGES.map(norm));

  const unexpected = [...foundSet].filter((e) => !allowSet.has(e));
  assert.deepStrictEqual(
    unexpected, [],
    `发现未登记的 service→cli 反向边（架构债回潮）：\n  ${unexpected.join('\n  ')}\n` +
    `若为有意延后，请加入 ALLOWED_REVERSE_EDGES；否则用端口倒置切断。`,
  );

  const stale = [...allowSet].filter((e) => !foundSet.has(e));
  assert.deepStrictEqual(
    stale, [],
    `白名单中的反向边已不存在（应收紧白名单）：\n  ${stale.join('\n  ')}`,
  );
});

test('interactiveMenuPort 是零依赖叶子（永不参与成环）', () => {
  const p = path.join(SERVICES_DIR, 'interactiveMenuPort.js');
  const src = fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/\brequire\s*\(/.test(src), 'interactiveMenuPort 不得 require 任何模块');
});

test('inputPreprocessor 经 interactiveMenuPort 取菜单，不再反向 require cli', () => {
  const src = fs.readFileSync(path.join(SERVICES_DIR, 'inputPreprocessor.js'), 'utf8');
  assert.ok(!/require\(\s*['"]\.\.\/cli\/ui\/inkComponents['"]\s*\)/.test(src),
    'inputPreprocessor 不得直接 require cli/ui/inkComponents');
  assert.ok(/require\(\s*['"]\.\/interactiveMenuPort['"]\s*\)/.test(src),
    'inputPreprocessor 应经 interactiveMenuPort 取交互菜单');
});

test('cli/ui/inkComponents 在加载时把 selectMenu 自注册进端口', () => {
  const port = require('../src/services/interactiveMenuPort');
  port._resetForTest();
  assert.strictEqual(port.getMenuPrompter(), null, '加载渲染器前应为 null（headless 降级）');
  require('../src/cli/ui/inkComponents');
  assert.strictEqual(typeof port.getMenuPrompter(), 'function', '加载后应注册 selectMenu 函数');
});

test('describeCliError 已下沉 service 层，daemonEntry/crashRecovery 不再反向 require cliErrorReporter', () => {
  const descriptorPath = path.join(SERVICES_DIR, 'cliErrorDescriptor.js');
  assert.ok(fs.existsSync(descriptorPath), 'cliErrorDescriptor.js 应存在于 service 层');
  for (const f of ['daemonEntry.js', 'crashRecovery.js']) {
    const src = fs.readFileSync(path.join(SERVICES_DIR, f), 'utf8');
    assert.ok(!/require\(\s*['"]\.\.\/cli\/cliErrorReporter['"]\s*\)/.test(src),
      `${f} 不得反向 require cli/cliErrorReporter`);
    assert.ok(/require\(\s*['"]\.\/cliErrorDescriptor['"]\s*\)/.test(src),
      `${f} 应经 ./cliErrorDescriptor 取 describeCliError`);
  }
  // cli 层仍能从原入口拿到（向后兼容再导出），且是下沉后的同一函数
  const fromCli = require('../src/cli/cliErrorReporter').describeCliError;
  const fromSvc = require('../src/services/cliErrorDescriptor').describeCliError;
  assert.strictEqual(fromCli, fromSvc, 'cli 入口应再导出下沉后的同一 describeCliError');
});
