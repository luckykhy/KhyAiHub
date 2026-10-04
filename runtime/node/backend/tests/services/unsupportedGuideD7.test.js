'use strict';

/**
 * [DESIGN-ARCH-163] D7-a 纯叶 unsupportedGuide 单测（node:test，零 IO）。
 *
 * 锁定:
 *  ① 门控 KHY_HONEST_UNSUPPORTED_GUIDE 默认开、falsy 关;
 *  ② KHY_VIDEO_THUMB_FRAMES 默认 3、钳 1–8、≤0 → 0、非法 → 3;
 *  ③ makeGuide kind × facts 三态文案（清单/加密/无 ffmpeg/字幕轨/达上限/verdict 三态）;
 *  ④ guideLines 三段式排版 + 卡尾恒有【行为约定】;
 *  ⑤ 垃圾输入绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ug = require('../../src/services/unsupportedGuide');

test('D7-1 gate: 默认开；0/off/false/no 关', () => {
  assert.strictEqual(ug.guideEnabled({}), true);
  assert.strictEqual(ug.guideEnabled({ KHY_HONEST_UNSUPPORTED_GUIDE: '0' }), false);
  assert.strictEqual(ug.guideEnabled({ KHY_HONEST_UNSUPPORTED_GUIDE: 'off' }), false);
  assert.strictEqual(ug.guideEnabled({ KHY_HONEST_UNSUPPORTED_GUIDE: '1' }), true);
});

test('D7-2 frameCount: 默认3 钳8 ≤0归0 非法回3', () => {
  assert.strictEqual(ug.frameCount({}), 3);
  assert.strictEqual(ug.frameCount({ KHY_VIDEO_THUMB_FRAMES: '5' }), 5);
  assert.strictEqual(ug.frameCount({ KHY_VIDEO_THUMB_FRAMES: '99' }), 8);
  assert.strictEqual(ug.frameCount({ KHY_VIDEO_THUMB_FRAMES: '0' }), 0);
  assert.strictEqual(ug.frameCount({ KHY_VIDEO_THUMB_FRAMES: 'abc' }), 3);
});

test('D7-3 archive 清单成功: 声明未展开 + 加密条目动作', () => {
  const g = ug.makeGuide({
    kind: 'archive',
    facts: { listingOk: true, encrypted: true, python: true },
  });
  assert.match(g.declaration, /包内文件未展开/);
  assert.ok(g.actions.some((a) => a.includes('展开后按路径重发')));
  assert.ok(g.actions.some((a) => a.includes('加密')));
});

test('D7-4 archive 清单失败: 无 python 与格式无解法两种原因', () => {
  const noPy = ug.makeGuide({ kind: 'archive', facts: { listingOk: false, python: false } });
  assert.match(noPy.reason, /python/);
  assert.ok(noPy.actions.some((a) => a.includes('khy doctor')));
  const rar = ug.makeGuide({ kind: 'archive', facts: { listingOk: false, python: true } });
  assert.match(rar.reason, /rar\/7z|损坏/);
});

test('D7-5 audio: 旋律未转录 + 时长 + 歌词文本轨声明；不挂视觉动作', () => {
  const g = ug.makeGuide({
    kind: 'audio',
    facts: { ffmpeg: true, duration: 125, lyricsFound: true, visionVerdict: 'supported' },
  });
  assert.match(g.declaration, /旋律与人声内容未转录/);
  assert.match(g.declaration, /时长约 2m 5s/);
  assert.ok(g.actions.some((a) => a.includes('不是听写结果')));
  assert.ok(!g.actions.some((a) => a.includes('识图')));
});

test('D7-6 video 三态: 已抽帧 / 达上限 / 无 ffmpeg', () => {
  const done = ug.makeGuide({
    kind: 'video',
    facts: { ffmpeg: true, framesDone: 3, hasSubtitleTrack: true, visionVerdict: null },
  });
  assert.match(done.declaration, /以 3 帧抽样/);
  assert.ok(done.actions.some((a) => a.includes('摘录≠看懂画面')));
  const capped = ug.makeGuide({ kind: 'video', facts: { ffmpeg: true, framesSkippedByCap: true } });
  assert.match(capped.declaration, /已达单轮图上限/);
  const noFf = ug.makeGuide({ kind: 'video', facts: { ffmpeg: false } });
  assert.match(noFf.declaration, /本机无 ffmpeg/);
  assert.ok(noFf.actions.some((a) => a.includes('khy doctor')));
});

test('D7-7 bitmap 视觉 verdict 三态文案', () => {
  const sup = ug.makeGuide({ kind: 'bitmap', facts: { dimsKnown: true, visionVerdict: 'supported' } });
  assert.ok(sup.actions.some((a) => a.includes('已实测支持识图')));
  const uns = ug.makeGuide({ kind: 'bitmap', facts: { dimsKnown: true, visionVerdict: 'unsupported' } });
  assert.ok(uns.actions.some((a) => a.includes('不收图')));
  const unk = ug.makeGuide({ kind: 'bitmap', facts: { dimsKnown: false, visionVerdict: null } });
  assert.ok(unk.actions.some((a) => a.includes('未实测')));
  assert.match(unk.declaration, /未读取图片内容/);
});

test('D7-8 guideLines: 三段式 + 末尾恒有行为约定；空 guide 零行', () => {
  const g = ug.makeGuide({ kind: 'archive', facts: { listingOk: true } });
  const lines = ug.guideLines(g);
  assert.match(lines[0], /^【声明】/);
  assert.ok(lines.some((l) => l.startsWith('【原因】')));
  assert.ok(lines.some((l) => l === '【可行动作】'));
  assert.ok(lines.some((l) => /^\s+① /.test(l)));
  assert.strictEqual(lines[lines.length - 1], ug.CONTRACT);
  assert.deepStrictEqual(ug.guideLines(null), []);
});

test('D7-9 垃圾输入绝不抛', () => {
  assert.doesNotThrow(() => ug.makeGuide());
  assert.doesNotThrow(() => ug.makeGuide({ kind: 'zzz', facts: null }));
  assert.doesNotThrow(() => ug.guideLines({ declaration: 5, actions: 'no' }));
  const other = ug.makeGuide({ kind: 'other', failNote: 'x'.repeat(300) });
  assert.ok(other.declaration.length < 200);
});
