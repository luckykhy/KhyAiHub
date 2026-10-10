'use strict';

/**
 * instrumentSyncOffBootChain.test.js — 「标的同步不得回到启动链上」的结构守卫。
 *
 * 为什么需要一条源码级断言（而不是运行时用例）：
 * server.js 是顶层脚本，`require` 它会真起一个 HTTP server —— 单测里跑不了。
 * 而这条改动**恰恰是那种会静默回退的改动**：谁把
 *   `_runDeferredInstrumentSync()` 换回 `await ...syncInstrumentsFromAData()`
 * 并塞进 Promise.allSettled，功能测试全绿、守卫全绿，但 4.3s 又回到启动链上。
 * 本仓最贵的教训就是「看起来对、其实从未生效」，所以这里用**结构断言**盯住它。
 *
 * 事实来源（2026-10-01 实测）：
 *   那一支 spawn python 花 4.3s（findPython 935ms + 脚本 3302ms），
 *   而本机 python 缺 pandas/akshare → 脚本走 py:157 的 BUILTIN 兜底，
 *   即「花 4.3s 唤起一个注定失败的进程，只为读回一段写死在源码里的常量」。
 *   且它不是启动前置（CSV 缓存 + DB upsert + 每日 2:00 定时兜底）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', '..', 'server.js');

function readServer() {
  return fs.readFileSync(SERVER_JS, 'utf8');
}

/**
 * 抽出 `await Promise.allSettled([ ... ])` 的那段数组文本。
 * 用括号配对扫描而不是正则贪婪匹配 —— 数组里有大量嵌套括号。
 */
function extractAllSettledBody(src) {
  const start = src.indexOf('await Promise.allSettled([');
  if (start === -1) return null;
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * 去掉该数组里的 dailyScheduler 任务**回调体**，只留「启动时立即执行」的部分。
 *
 * 为什么必须剔：`scheduleDaily({... task: async () => { await syncInstrumentsFromAData() }})`
 * 是**每日 2:00 的定时注册**，它本身不消耗启动时间（注册是同步的），
 * 而且它正是我们依赖的兜底路径。只有「数组顶层被 await 的那一支」才不许出现。
 *
 * 剔法：把每个 `task: async () => { ... }` 整段挖掉（括号配对）。
 * ⚠ 替换串**绝不能**再含 `task: async () => {` 字面量 —— 否则 indexOf 会再次命中它、
 *   外层 for(;;) 永不退出（这个 bug 我写过一次，测试直接挂死）。
 */
function stripScheduledTaskBodies(body) {
  const MARKER = 'task: async () => {';
  const REPLACEMENT = 'task-RESERVED-PLACEHOLDER';
  let out = body;
  let guard = 0;
  for (;;) {
    if (++guard > 100) {
      throw new Error('stripScheduledTaskBodies: 迭代超出上限，疑似替换串仍含 MARKER');
    }
    const at = out.indexOf(MARKER);
    if (at === -1) return out;
    const braceOpen = out.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (let i = braceOpen; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return out;
    // 替换为不含 MARKER 的占位串
    out = out.slice(0, at) + REPLACEMENT + out.slice(end + 1);
  }
}

test('标的同步不在 await 的启动链数组里（防止性能回退）', () => {
  const src = readServer();
  const body = extractAllSettledBody(src);
  assert.ok(body, '未能定位 await Promise.allSettled([...]) —— server.js 结构变了，请更新本守卫');

  // 只查「立即执行」的部分：定时任务回调体是合法且必要的，不算回退。
  const immediate = stripScheduledTaskBodies(body);

  assert.ok(
    !/syncInstrumentsFromAData/.test(immediate),
    'syncInstrumentsFromAData 又回到了 await 的启动链上（立即执行支）：\n' +
      '它会 spawn python（实测 4.3s），且本机缺少 pandas/akshare 时只产出源码里写死的常量。\n' +
      '请改用 _runDeferredInstrumentSync()（fire-and-forget，在 /api/ready 置位之后）。\n' +
      '注：dailyScheduler 的每日 2:00 定时任务**不受本断言限制** —— 它是兜底路径，应当保留。'
  );
});

test('_runDeferredInstrumentSync 已定义且在 ready 置位之后被调用', () => {
  const src = readServer();

  assert.ok(
    /function _runDeferredInstrumentSync\s*\(/.test(src),
    '_runDeferredInstrumentSync 未定义 —— 延迟执行器丢了'
  );

  const readyAt = src.indexOf('_bootBusinessReady = true;');
  const callAt = src.indexOf('_runDeferredInstrumentSync();', readyAt);
  assert.ok(readyAt !== -1, '_bootBusinessReady = true 未找到');
  assert.ok(
    callAt !== -1,
    '调用点不在 _bootBusinessReady = true 之后：\n' +
      '「可服务」不依赖「标的已同步完」（upsert + CSV 缓存 + 每日定时兜底），\n' +
      '把同步排在 ready 之前会让 /api/ready 白等 4.3s。'
  );
});

test('延迟执行器仍是 best-effort：失败只记日志，不抛不阻塞', () => {
  const src = readServer();
  const fnAt = src.indexOf('function _runDeferredInstrumentSync');
  assert.ok(fnAt !== -1);
  // 取函数体到下一个顶层 function 声明为止
  const rest = src.slice(fnAt);
  const nextFn = rest.indexOf('\nfunction ', 1);
  const body = nextFn === -1 ? rest : rest.slice(0, nextFn);

  assert.ok(/setImmediate\(/.test(body), '延迟执行器应经 setImmediate 脱离当前 tick');
  assert.ok(/catch\s*\(/.test(body), '延迟执行器必须自带 try/catch（best-effort，绝不影响进程）');
  assert.ok(
    /_deferredInstrumentSyncStarted/.test(body),
    '延迟执行器需要 one-shot latch，避免重复调用时重复 spawn python'
  );
});
