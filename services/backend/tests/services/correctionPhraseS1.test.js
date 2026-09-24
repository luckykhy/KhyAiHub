'use strict';

/**
 * [DESIGN-ARCH-163] D5 校准话术 S1-only —— 纯叶子判定 + 观测台账（只记录、不改写）。
 * node:test。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'khy-d5-calibrate-test');
fs.mkdirSync(TMP_DIR, { recursive: true });

const leaf = require('../../src/services/correctionPhraseCard');
const svc = require('../../src/services/correctionPhraseService');

function samplesFile(name) {
  const file = path.join(TMP_DIR, `${name}.jsonl`);
  fs.rmSync(file, { force: true }); // 每次运行从空台账开始(tmp 目录跨运行存活)
  return file;
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('D5-1 五类句式各命中一例，普通闲聊零命中', () => {
  assert.deepStrictEqual(leaf.classifyCorrectionPhrase('按钮字号太大了一点'), [{ category: '尺寸偏差', keyword: '太大' }]);
  assert.ok(leaf.classifyCorrectionPhrase('这个底色颜色不对').length >= 1);
  assert.ok(leaf.classifyCorrectionPhrase('标题漏了一个图标').some((h) => h.category === '遗漏元素'));
  assert.ok(leaf.classifyCorrectionPhrase('点击没反应，逻辑不对').some((h) => h.category === '逻辑错误'));
  assert.ok(leaf.classifyCorrectionPhrase('这里有个错别字').some((h) => h.category === '文字错误'));
  assert.deepStrictEqual(leaf.classifyCorrectionPhrase('帮我看看今天的天气如何'), []);
  assert.deepStrictEqual(leaf.classifyCorrectionPhrase(null), []);
});

test('D5-2 门控档位：默认 log；off 关；on 在 S1 收敛为 log', () => {
  assert.strictEqual(leaf.hintMode({}), 'log');
  assert.strictEqual(leaf.hintMode({ KHY_IMAGE_CALIBRATE_HINT: 'off' }), 'off');
  assert.strictEqual(leaf.hintMode({ KHY_IMAGE_CALIBRATE_HINT: 'no' }), 'off');
  assert.strictEqual(leaf.hintMode({ KHY_IMAGE_CALIBRATE_HINT: 'on' }), 'inject');
  assert.strictEqual(leaf.effectiveMode({}), 'log');
  assert.strictEqual(leaf.effectiveMode({ KHY_IMAGE_CALIBRATE_HINT: 'off' }), 'off');
  assert.strictEqual(leaf.effectiveMode({ KHY_IMAGE_CALIBRATE_HINT: 'on' }), 'log', 'S1 铁律：inject 必须被收敛');
  assert.strictEqual(leaf.KHY_CALIBRATE_HINT_STAGE, 'S1');
});

test('D5-3 上一条助手消息产物判定：string / block-array / 无 assistant → null', () => {
  assert.strictEqual(
    leaf.assistantHadArtifacts([{ role: 'assistant', content: '改好了：\n```vue\n<template>...```' }]),
    true
  );
  assert.strictEqual(
    leaf.assistantHadArtifacts([{ role: 'assistant', content: [{ type: 'text', text: '已写入 App.vue' }] }]),
    true
  );
  assert.strictEqual(
    leaf.assistantHadArtifacts([{ role: 'assistant', content: '只是普通寒暄，没有代码' }]),
    false
  );
  assert.strictEqual(leaf.assistantHadArtifacts([{ role: 'user', content: 'hi' }]), null);
  assert.strictEqual(leaf.assistantHadArtifacts(undefined), null);
});

test('D5-4 观测落样本：无图 + 命中 → 一行 JSONL；返回值不碰 prompt', () => {
  const file = samplesFile('hit');
  const env = { KHY_CORRECTION_PHRASE_SAMPLES: file };
  const prompt = '按钮字号太大了，应该是 14px 而不是 18px';
  const before = prompt;
  const logged = svc.observeCorrectionPhrase(prompt, { messages: [{ role: 'assistant', content: '```css\n.x{font-size:18px}```' }] }, env);
  assert.strictEqual(logged, true);
  assert.strictEqual(prompt, before, 'S1：绝不改写用户消息');
  const lines = readLines(file);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].stage, 'S1');
  assert.strictEqual(lines[0].assistantArtifacts, true);
  assert.ok(lines[0].categories.some((h) => h.category === '尺寸偏差'));
  assert.ok(/^[0-9a-f]{16}$/.test(lines[0].digest));
});

test('D5-5 不带样本条件：有图 / 不命中 / off 档 → 零落盘', () => {
  const file = samplesFile('miss');
  const env = { KHY_CORRECTION_PHRASE_SAMPLES: file };
  assert.strictEqual(svc.observeCorrectionPhrase('颜色太暗了', { images: [{ base64: 'AAA' }] }, env), false);
  assert.strictEqual(svc.observeCorrectionPhrase('帮我查个 API 用法', {}, env), false);
  assert.strictEqual(
    svc.observeCorrectionPhrase('颜色太暗了', {}, { ...env, KHY_IMAGE_CALIBRATE_HINT: 'off' }),
    false
  );
  assert.strictEqual(readLines(file).length, 0);
});

test('D5-6 误报样本也被记录（artifacts=false 带字段），供 S2 误报率计算', () => {
  const file = samplesFile('fp');
  const env = { KHY_CORRECTION_PHRASE_SAMPLES: file };
  assert.strictEqual(
    svc.observeCorrectionPhrase('这段逻辑不对', { messages: [{ role: 'assistant', content: '好的，收到。' }] }, env),
    true
  );
  const lines = readLines(file);
  assert.strictEqual(lines[0].assistantArtifacts, false);
});

test('D5-7 fail-soft：样本路径不可写 → 不抛、返回 false', () => {
  const notAFile = path.join(TMP_DIR, 'no-such-dir', 'deep', 'x.jsonl');
  fs.writeFileSync(path.join(TMP_DIR, 'notadir'), 'x'); // 占位成文件 → mkdir 必失败
  const env = { KHY_CORRECTION_PHRASE_SAMPLES: path.join(TMP_DIR, 'notadir', 'sub', 's.jsonl') };
  assert.doesNotThrow(() => svc.observeCorrectionPhrase('间距太大了', {}, env));
  assert.strictEqual(svc.observeCorrectionPhrase('间距太大了', {}, env), false);
  assert.ok(notAFile);
});
