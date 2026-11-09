'use strict';

// bench-tooltag-holdback.js — 量「工具标签回压把可见文本扣住」造成的可见延迟。
//
// 缺陷机制：useQueryBridge.js:1923-1925 在 text chunk 分支调 splitPendingToolTag，
// 只把 settled 部分交给 setStreamingBoth(:1955)，扣住的尾巴（pendingTagBuf）留到
// 下一个 chunk / tool_use(:2011) / finalize(:3264) 才释放。
//
// 被扣住的是**整行**（工具 JSON / bracket marker 的行首形状），而「像不像工具调用」
// 是在每个 chunk 到达时重算的。该行只要还没闭合，逐个 chunk 到达就逐个被扣一次，
// 直到某个 chunk 让它闭合（或流结束触发 finalize flush）才一次性上屏。
//
// 被量的量：holdStartAt = 扣住第一次发生的那次 chunk 到达时刻，
//         visibleAt   = 该内容真正出现在屏幕上（emit 非空）的时刻，
//         delay      = visibleAt - holdStartAt。
// 也就是说，用户眼睁睁看着模型在生成、屏幕却不动的那段时间。
//
// 用法（从仓库根）：node runtime/node/backend/scripts/bench-tooltag-holdback.js

const tcNoise = require('../src/utils/toolCallNoise');

// 模型边生成边吐 token 的 chunk 到达间隔量级。基准给量级，不给绝对真值。
const CHUNK_GAP_MS = 40;
const REPEATS = 15;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 照抄 useQueryBridge.js:1923-1925（join → split → 只有 emit 上屏）
// 与 :1879-1910 的 flushPendingTag（finalize 时释放）。
function delayOf(chunks) {
  let pendingTagBuf = '';
  let holdStartAt = null;
  let visibleAt = null;
  let now = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) now += CHUNK_GAP_MS;
    const split = tcNoise.splitPendingToolTag(pendingTagBuf + chunks[i]);
    const wasHeld = pendingTagBuf.length > 0 || split.pending.length > 0;
    pendingTagBuf = split.pending;
    if (split.pending.length > 0 && holdStartAt === null) holdStartAt = now;
    if (split.emit.length > 0) {
      visibleAt = now;
      if (holdStartAt !== null) break; // 扣住的内容已上屏
    }
    if (!wasHeld) holdStartAt = null;
  }
  // 还没上屏 → finalize（:3264）flush。
  if (holdStartAt !== null && visibleAt === null) {
    let cleaned = pendingTagBuf;
    try {
      cleaned = tcNoise.stripInlineToolCallNoise(pendingTagBuf, process.env);
    } catch {
      cleaned = pendingTagBuf;
    }
    visibleAt = now;
  }
  if (holdStartAt === null || visibleAt === null) return 0;
  return visibleAt - holdStartAt;
}

// 前置正文 + 一段被切成 N 个 chunk 的可疑 JSON 行（每 chunk 都没闭合 → 每 chunk 被扣）。
function buildHeldCase(bodyChunks) {
  const pre = ['分析如下：\n'];
  for (let i = 0; i < bodyChunks; i++) {
    pre.push('{"name":"open_app","params":{"key' + i + '":"' + 'v'.repeat(60) + '"');
    if (i === bodyChunks - 1) pre.push('}}}\n结论：已完成。');
  }
  return pre;
}

// 同形状对照组：同样的行数与字数，行首不是可疑形状（不触发 hold，delay 应恒为 0）。
function buildPlainCase(bodyChunks) {
  const pre = ['分析如下：\n'];
  for (let i = 0; i < bodyChunks; i++) {
    pre.push('结果' + i + '：键' + i + '的值是' + 'v'.repeat(60));
    if (i === bodyChunks - 1) pre.push('。\n结论：已完成。');
  }
  return pre;
}

function measure(chunks) {
  const samples = [];
  for (let i = 0; i < REPEATS; i++) samples.push(delayOf(chunks));
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function main() {
  const points = [];
  for (const bodyChunks of [1, 4, 16, 64]) {
    points.push({ label: `held${bodyChunks}chunks`, ms: measure(buildHeldCase(bodyChunks)) });
    points.push({ label: `plain${bodyChunks}chunks`, ms: measure(buildPlainCase(bodyChunks)) });
  }
  process.stdout.write(JSON.stringify({ subject: 'tooltag-holdback/visible-delay', points }) + '\n');
}

main();