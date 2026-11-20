'use strict';

/**
 * computerUseStuckVerify.test.js — verify 相位的起效判定 + is_stuck 止损。
 *
 * 两个断言面：
 *   1. _verifyActionEffect 是纯函数：三态（已生效 / 未生效 / 无证据）可直测；
 *   2. 整轮驱动（fake gateway + fake controller）证明计数与止损真的接在循环里。
 * 全程注入替身，零真实截屏与桌面操控。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { ComputerUseAgent, _internals } = require('./computerUseAgent');

// 不碰本机 dataHome：轨迹日志与经验记忆都在文件级关掉（两条都是既有 env 开关）。
process.env.KHY_COMPUTER_USE_JOURNAL = '0';
process.env.KHY_COMPUTER_USE_EXPERIENCE = '0';

// ── 测试用 PNG 编码器（与 stateDetector / computerUseAgent 测试同一套最小实现）──

function _crc32(buf) {
  let table = _crc32.table;
  if (!table) {
    table = _crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function _chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(_crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodeGrayPng(w, h, paint) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const v = paint(x, y);
      raw[p++] = v; raw[p++] = v; raw[p++] = v;
    }
  }
  return Buffer.concat([
    sig,
    _chunk('IHDR', ihdr),
    _chunk('IDAT', zlib.deflateSync(raw)),
    _chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FLAT = () => 128;
const HALF_BRIGHT = (x, y) => (y < 32 ? 255 : 128);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 写一帧到指定目录；同内容不同文件名 = 「画面没变，但确实又拍了一张」 */
function writeFrame(dir, name, paint) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, encodeGrayPng(64, 64, paint));
  return p;
}

// ── 1. 纯函数：三态判定 ───────────────────────────────────────────────────

test('同内容的两帧（不同文件名）→ 未生效', () => {
  const dir = tmpDir('khy-cu-verify-');
  try {
    const a = writeFrame(dir, 'a.png', FLAT);
    const b = writeFrame(dir, 'b.png', FLAT);
    const v = _internals._verifyActionEffect({ prevScreenPath: a, postPath: b });
    assert.equal(v.effective, false);
    assert.equal(v.method, 'screenshot-dhash');
    assert.deepEqual(v.evidence, { distance: 0, lumaDiff: 0 });
    assert.equal(v.error, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('画面变化的两帧 → 已生效，并带 distance / lumaDiff 证据', () => {
  const dir = tmpDir('khy-cu-verify-');
  try {
    const a = writeFrame(dir, 'a.png', FLAT);
    const b = writeFrame(dir, 'b.png', HALF_BRIGHT);
    const v = _internals._verifyActionEffect({ prevScreenPath: a, postPath: b });
    assert.equal(v.effective, true);
    assert.equal(v.method, 'screenshot-dhash');
    assert.ok(v.evidence.distance > 0 || v.evidence.lumaDiff > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缺基线 / 缺后帧 → 无证据（null），不退化成「未生效」', () => {
  const noPrev = _internals._verifyActionEffect({ prevScreenPath: null, postPath: 'x.png' });
  assert.equal(noPrev.effective, null);
  assert.equal(noPrev.error, 'no_baseline');
  assert.equal(noPrev.evidence, null);

  const noPost = _internals._verifyActionEffect({ prevScreenPath: 'x.png' });
  assert.equal(noPost.effective, null);
  assert.equal(noPost.error, 'no_baseline');

  assert.equal(_internals._verifyActionEffect().effective, null);
});

test('同一帧（同一路径）→ 无证据，不是「未生效」', () => {
  const dir = tmpDir('khy-cu-verify-');
  try {
    const a = writeFrame(dir, 'a.png', FLAT);
    const v = _internals._verifyActionEffect({ prevScreenPath: a, postPath: a });
    assert.equal(v.effective, null);
    assert.equal(v.error, 'same_frame');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('解码失败 → null 且不抛', () => {
  const dir = tmpDir('khy-cu-verify-');
  try {
    const a = writeFrame(dir, 'a.png', FLAT);
    const missing = path.join(dir, 'not-there.png');
    let v;
    assert.doesNotThrow(() => {
      v = _internals._verifyActionEffect({ prevScreenPath: a, postPath: missing });
    });
    assert.equal(v.effective, null);
    assert.ok(v.error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detector 报 ok:false → null 并转述原因，不抛', () => {
  const v = _internals._verifyActionEffect({
    prevScreenPath: 'a.png',
    postPath: 'b.png',
    screenshotChanged: { ok: false, error: 'bad png' },
  });
  assert.equal(v.effective, null);
  assert.equal(v.error, 'bad png');
});

test('已算好的 detector 结果被直接采用（不再自己解码）', () => {
  const v = _internals._verifyActionEffect({
    prevScreenPath: 'a.png',
    postPath: 'b.png',
    screenshotChanged: { ok: true, changed: true, distance: 64, lumaDiff: 255 },
  });
  assert.equal(v.effective, true);
  assert.deepEqual(v.evidence, { distance: 64, lumaDiff: 255 });
});

test('外部已算好的结果优先于阈值（thresholds 只影响内部自己解码的那条路）', () => {
  // 调用方给的是 ok:true / changed:true，即使把阈值收到最严也不该翻成「未生效」
  const given = _internals._verifyActionEffect({
    prevScreenPath: 'a.png',
    postPath: 'b.png',
    screenshotChanged: { ok: true, changed: true, distance: 1, lumaDiff: 0.01 },
    thresholds: { thresholdBits: 64, thresholdLuma: 255 },
  });
  assert.equal(given.effective, true);
  // 内部解码那条路用同一组阈值：默认阈值下这两帧（同内容）判为未生效
  const dir = tmpDir('khy-cu-verify-');
  try {
    const a = writeFrame(dir, 'a.png', FLAT);
    const b = writeFrame(dir, 'b.png', FLAT);
    const v = _internals._verifyActionEffect({
      prevScreenPath: a,
      postPath: b,
      thresholds: { thresholdBits: 1, thresholdLuma: 0.01 },
    });
    assert.equal(v.effective, false);
    assert.equal(v.error, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. 提示词：只追加 verdict 行 ──────────────────────────────────────────

test('提示词只追加「动作起效判定」一行，原有段落标题保持原文', () => {
  const prompt = _internals._buildDecisionPrompt({
    goal: '点提交',
    history: [],
    lastElements: [],
    lastClickable: [],
    lastOcrText: '',
    lastActionResult: { summary: 'clicked e1', success: true, actionKey: 'clickElement' },
    lastChange: {
      screenChange: { changed: false, distance: 0, lumaDiff: 0 },
      elementChange: { addedCount: 0, removedCount: 0, changedCount: 0 },
    },
    lastActionVerify: { effective: false, method: 'screenshot-dhash', evidence: { distance: 0, lumaDiff: 0 } },
    _noChangeStreak: 2,
  });
  assert.match(prompt, /## 上一步动作后的状态变化/);
  assert.match(prompt, /- 屏幕画面: 未变化/);
  assert.match(prompt, /- UI 元素: 新增 0 \/ 消失 0 \/ 位置变化 0/);
  assert.match(prompt, /- 动作起效判定：未生效（可能没点中，建议换目标或路径）/);
  assert.match(prompt, /## ⚠ 卡住检测/);
});

test('无证据时如实写原因；lastChange 为 null 也不炸', () => {
  const prompt = _internals._buildDecisionPrompt({
    goal: 'x',
    history: [],
    lastElements: [],
    lastClickable: [],
    lastOcrText: '',
    lastChange: null,
    lastActionVerify: { effective: null, method: 'screenshot-dhash', evidence: null, error: 'same_frame' },
  });
  assert.match(prompt, /## 上一步动作后的状态变化/);
  assert.match(prompt, /- 动作起效判定：无法判断（same_frame）/);
});

test('已生效 → 明确写「已生效」', () => {
  const prompt = _internals._buildDecisionPrompt({
    goal: 'x',
    history: [],
    lastElements: [],
    lastClickable: [],
    lastOcrText: '',
    lastActionVerify: { effective: true, method: 'screenshot-dhash', evidence: { distance: 8, lumaDiff: 12 } },
  });
  assert.match(prompt, /- 动作起效判定：已生效/);
});

// ── 3. 整轮驱动 ───────────────────────────────────────────────────────────

/**
 * 假控制器：observe 返回给定帧，screenshot 按调用序号返回给定帧。
 * observe 与 screenshot 分开计数，因为快轮 observe 与 verify 都走 screenshot。
 */
function fakeController(frames, opts = {}) {
  const calls = { observe: 0, screenshot: 0 };
  return {
    calls,
    capabilities: () => ({ summary: { canSee: true } }),
    observe: async () => {
      calls.observe++;
      return {
        success: true,
        path: frames.observe(calls.observe),
        elements: [],
        clickable: [],
        recognized: null,
      };
    },
    screenshot: async () => {
      calls.screenshot++;
      return { success: true, path: frames.screenshot(calls.screenshot) };
    },
    clickElement: async () =>
      opts.clickFails ? { success: false, error: 'element not found' } : { success: true },
  };
}

function inertGateway(responses, prompts) {
  const queue = responses.slice();
  return {
    generate: async (prompt) => {
      prompts.push(typeof prompt === 'string' ? prompt : '');
      return queue.shift() || { content: '{"action":"finish","summary":"queue drained"}' };
    },
  };
}

test('连续三轮「有证据的未生效」→ 第 3 轮后止损（提示在 2，止损在 3）', async () => {
  const dir = tmpDir('khy-cu-stuck-');
  try {
    // 动作前后都是同一份灰屏内容、但每次都是新文件 —— 真实 capture 的形状。
    const still = writeFrame(dir, 'still.png', FLAT);
    const posts = Array.from({ length: 6 }, (_, i) => writeFrame(dir, `post${i}.png`, FLAT));
    const controller = fakeController({
      observe: () => still,
      screenshot: (n) => posts[(n - 1) % posts.length],
    });
    const prompts = [];
    const streaks = [];
    const gateway = inertGateway(
      [
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state) => streaks.push({
        streak: state._noChangeStreak,
        ineffective: state._ineffectiveStreak || 0,
        isStuck: state.isStuck,
        verify: state.lastActionVerify && state.lastActionVerify.effective,
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.finished, false);
    assert.equal(result.stoppedReason, 'repeated_no_effect');
    assert.match(result.summary, /已连续 3 轮操作后画面无变化/);
    assert.equal(result.iterations, 3);
    assert.equal(result.history.length, 3);

    // verify 每轮都真跑过，且三轮都是「未生效」；提示账与止损账同步走到 3
    assert.deepEqual(streaks.map((s) => s.verify), [false, false, false]);
    assert.deepEqual(streaks.map((s) => s.streak), [1, 2, 3]);
    assert.deepEqual(streaks.map((s) => s.ineffective), [1, 2, 3]);
    // 提示阈值 2：第 3 次决策的提示词里已经出现「卡住检测」
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[1], /## ⚠ 卡住检测/);
    assert.match(prompts[2], /## ⚠ 卡住检测/);
    assert.match(prompts[1], /- 动作起效判定：未生效/);
    // is_stuck 跟着计数走
    assert.equal(streaks[1].isStuck, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('已生效 → 计数清零，继续原来的流程（不误止损）', async () => {
  const dir = tmpDir('khy-cu-ok-');
  try {
    const before = writeFrame(dir, 'before.png', FLAT);
    const after = writeFrame(dir, 'after.png', HALF_BRIGHT);
    const controller = fakeController({
      observe: () => before,
      screenshot: () => after,
    });
    const prompts = [];
    const streaks = [];
    const gateway = inertGateway(
      [
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"finish","summary":"保存成功"}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state) => streaks.push({
        streak: state._noChangeStreak,
        verify: state.lastActionVerify && state.lastActionVerify.effective,
      }),
    });

    assert.equal(result.stoppedReason, 'goal_achieved');
    assert.equal(result.finished, true);
    assert.equal(streaks[0].verify, true);
    assert.equal(streaks[0].streak, 0);
    assert.match(prompts[1], /- 动作起效判定：已生效/);
    assert.doesNotMatch(prompts[1], /## ⚠ 卡住检测/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('无证据（同一帧）→ verify 不计数，提示词写「无法判断」', async () => {
  const dir = tmpDir('khy-cu-null-');
  try {
    const only = writeFrame(dir, 'only.png', FLAT);
    // 替身里 observe 与 screenshot 返回同一个文件：两帧不可比
    const controller = fakeController({
      observe: () => only,
      screenshot: () => only,
    });
    const prompts = [];
    const streaks = [];
    const gateway = inertGateway(
      [
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"finish","summary":"ok"}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state) => streaks.push({
        streak: state._noChangeStreak,
        verify: state.lastActionVerify && state.lastActionVerify.effective,
      }),
    });

    assert.equal(result.stoppedReason, 'goal_achieved');
    // verify 拿到的是 null，没有给计数加一
    assert.equal(streaks[0].verify, null);
    assert.equal(streaks[0].streak, 0);
    assert.match(prompts[1], /- 动作起效判定：无法判断（same_frame）/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('纯观察轮不触发 verify，也不会把旧裁决带到下一轮', async () => {
  const dir = tmpDir('khy-cu-observe-');
  try {
    const before = writeFrame(dir, 'before.png', FLAT);
    const after = writeFrame(dir, 'after.png', HALF_BRIGHT);
    const controller = fakeController({
      observe: () => before,
      screenshot: () => after,
    });
    const prompts = [];
    const gateway = inertGateway(
      [
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"observe"}' },
        { content: '{"action":"finish","summary":"ok"}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {});
    assert.equal(result.stoppedReason, 'goal_achieved');
    // 第 2 次决策能看到上一轮的裁决，第 3 次决策看不到（observe 轮把它清了）
    assert.match(prompts[1], /- 动作起效判定：已生效/);
    assert.doesNotMatch(prompts[2], /- 动作起效判定/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 止损账的豁免（三条误止损路径 + 迟到变化）────────────────────────────

test('wait 轮不是操作轮：2 次无效点击 + 1 次 wait 不会止损', async () => {
  const dir = tmpDir('khy-cu-wait-');
  try {
    const still = writeFrame(dir, 'still.png', FLAT);
    const posts = Array.from({ length: 8 }, (_, i) => writeFrame(dir, `w${i}.png`, FLAT));
    const controller = fakeController({
      observe: () => still,
      screenshot: (n) => posts[(n - 1) % posts.length],
    });
    const prompts = [];
    const snaps = [];
    const gateway = inertGateway(
      [
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"wait","ms":10}' },
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"finish","summary":"done"}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state, info) =>
        snaps.push({
          action: info.action && info.action.action,
          ineffective: state._ineffectiveStreak || 0,
        }),
    });
    assert.equal(result.stoppedReason, 'goal_achieved');
    // 止损账在 wait 前后都停在 1/2：把 wait 当操作轮时这里会在 2 次点击后就报 repeated_no_effect
    assert.deepEqual(snaps.map((s) => s.ineffective), [1, 1, 2, 2]);
    assert.deepEqual(result.history.map((h) => h.action), [
      'clickElement',
      'wait',
      'clickElement',
      'finish',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LLM 输出解析失败（continue 轮）不重计上一个动作：2 次无效点击不止损', async () => {
  const dir = tmpDir('khy-cu-continue-');
  try {
    const still = writeFrame(dir, 'still.png', FLAT);
    const posts = Array.from({ length: 8 }, (_, i) => writeFrame(dir, `c${i}.png`, FLAT));
    const controller = fakeController({
      observe: () => still,
      screenshot: (n) => posts[(n - 1) % posts.length],
    });
    const prompts = [];
    const snaps = [];
    const gateway = inertGateway(
      [
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '这不是一个动作对象' },
        { content: '{"action":"clickElement","target":"e1","waitMs":10}' },
        { content: '{"action":"finish","summary":"done"}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state) =>
        snaps.push({
          streak: state._noChangeStreak,
          ineffective: state._ineffectiveStreak || 0,
        }),
    });
    assert.equal(result.stoppedReason, 'goal_achieved');
    // 同一个 click 被 verify 判过账后，解析失败的 continue 轮不能再给同一段变化记一次
    assert.deepEqual(snaps.map((s) => s.ineffective), [1, 2, 2]);
    assert.deepEqual(snaps.map((s) => s.streak), [1, 2, 2]);
    assert.deepEqual(result.history.map((h) => h.action), [
      'clickElement',
      'think',
      'clickElement',
      'finish',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify 恒无证据（同一帧）→ 不触发硬止损，兜底提示照旧给出', async () => {
  const dir = tmpDir('khy-cu-all-null-');
  try {
    const only = writeFrame(dir, 'only.png', FLAT);
    const controller = fakeController({ observe: () => only, screenshot: () => only });
    const prompts = [];
    const snaps = [];
    const click = { content: '{"action":"clickElement","target":"e1","waitMs":10}' };
    const gateway = inertGateway([click, click, click, click, click], prompts);
    const agent = new ComputerUseAgent({ gateway, controller, maxIterations: 5 });
    const result = await agent.run('点保存', {
      onIteration: (state) =>
        snaps.push({
          streak: state._noChangeStreak,
          ineffective: state._ineffectiveStreak || 0,
          verify: state.lastActionVerify && state.lastActionVerify.effective,
        }),
    });
    assert.equal(result.stoppedReason, 'max_iterations_reached');
    // 五轮都没有可比的两帧：止损账始终为 0，绝不靠「没证据」中止任务
    assert.equal(snaps.every((s) => s.verify === null), true);
    assert.equal(snaps.every((s) => s.ineffective === 0), true);
    // 但兜底的观察信号仍在：第 3 次决策时卡住提示照旧出现
    assert.match(prompts[2], /## ⚠ 卡住检测/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('执行失败的动作不进止损账（没碰到界面，「画面没变」不是它无效的证据）', async () => {
  const dir = tmpDir('khy-cu-failed-');
  try {
    const still = writeFrame(dir, 'still.png', FLAT);
    const posts = Array.from({ length: 6 }, (_, i) => writeFrame(dir, `f${i}.png`, FLAT));
    const controller = fakeController(
      { observe: () => still, screenshot: (n) => posts[(n - 1) % posts.length] },
      { clickFails: true }
    );
    const prompts = [];
    const snaps = [];
    const click = { content: '{"action":"clickElement","target":"e1","waitMs":10}' };
    const gateway = inertGateway([click, click, click, { content: '{"action":"finish","summary":"ok"}' }], prompts);
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state) =>
        snaps.push({
          ineffective: state._ineffectiveStreak || 0,
          verify: state.lastActionVerify,
        }),
    });
    assert.equal(result.stoppedReason, 'goal_achieved');
    assert.equal(snaps.every((s) => s.ineffective === 0), true);
    assert.equal(snaps.every((s) => s.verify === null), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('画面迟到变化 → 止损账清零，不误止损', async () => {
  const dir = tmpDir('khy-cu-late-');
  try {
    const flat = writeFrame(dir, 'l1.png', FLAT);
    const bright = writeFrame(dir, 'l2.png', HALF_BRIGHT);
    const post = writeFrame(dir, 'l3.png', FLAT);
    // 第 1 轮 verify 判无效（ineffective=1）；随后满轮 observe 见到真实变化 → 归零
    const controller = fakeController({
      observe: (n) => (n === 1 ? flat : bright),
      screenshot: (n) => (n === 1 ? post : bright),
    });
    const prompts = [];
    const snaps = [];
    const click = { content: '{"action":"clickElement","target":"e1","waitMs":10}' };
    const gateway = inertGateway([click, click, click, { content: '{"action":"finish","summary":"ok"}' }], prompts);
    const agent = new ComputerUseAgent({ gateway, controller });
    const result = await agent.run('点保存', {
      onIteration: (state) => snaps.push({ ineffective: state._ineffectiveStreak || 0 }),
    });
    assert.equal(result.stoppedReason, 'goal_achieved');
    assert.equal(snaps[0].ineffective, 1);
    assert.equal(snaps[snaps.length - 1].ineffective, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
