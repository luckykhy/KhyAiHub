'use strict';

/**
 * voiceBridge.test.js — co-located suite for the mouth/ears adapter (DESIGN-ARCH-056).
 *
 * IO: none — every case injects a fake voiceService via `deps.voiceService`, so no
 * TTS/STT binary is ever spawned and no temp file is created. The lazy
 * `require('../../../voiceService')` branch is covered by temporarily replacing the
 * resolved module in require.cache (restored in `after`).
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   VB-E1  speak() reports success even when the service returns no handle, so the
 *          documented handle.cancel() interrupt path does not exist.
 *   VB-E2  listen() drops the transcript when the service resolves a bare string.
 *   VB-E3  listen() forwards duration verbatim, so a non-numeric duration leaks out
 *          under a contract that types it as number.
 *   VB-E4  listen() only honours truthy `error`, so falsy error markers are success.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const bridge = require('./voiceBridge');

const VOICE_PATH = require.resolve('../../../voiceService');
const ORIGINAL_VOICE = require.cache[VOICE_PATH];

after(() => {
  if (ORIGINAL_VOICE) require.cache[VOICE_PATH] = ORIGINAL_VOICE;
  else delete require.cache[VOICE_PATH];
});

// Swap the module the lazy require would load, run fn, then put the cache back.
function withLazyVoiceService(stub, fn) {
  const replacement = new Module(VOICE_PATH, null);
  replacement.filename = VOICE_PATH;
  replacement.loaded = true;
  replacement.exports = stub;
  require.cache[VOICE_PATH] = replacement;
  try {
    return fn();
  } finally {
    if (ORIGINAL_VOICE) require.cache[VOICE_PATH] = ORIGINAL_VOICE;
    else delete require.cache[VOICE_PATH];
  }
}

const deps = (voiceService) => ({ voiceService });

const echoVoice = {
  speak: (text, options) => ({ tag: 'handle', text, options }),
  stopSpeaking: () => { echoVoice._stopCalls += 1; },
  listen: async (options) => ({ text: '转写结果', duration: 2, options }),
  getCapabilities: () => ({ tts: 'edge-tts', stt: 'whisper', platform: 'win32' }),
};
echoVoice._stopCalls = 0;

test('模块导出四个感官适配函数', () => {
  assert.deepEqual(Object.keys(bridge).sort(), ['capabilities', 'listen', 'speak', 'stopSpeaking']);
  for (const fn of Object.values(bridge)) assert.equal(typeof fn, 'function');
});

test('speak 注入服务时返回 success 与 handle 与固定 note', () => {
  const r = bridge.speak('你好', {}, deps(echoVoice));
  assert.equal(r.success, true);
  assert.equal(r.note, '已开始朗读（异步，不阻塞）。');
  assert.equal(r.handle.tag, 'handle');
  assert.deepEqual(Object.keys(r), ['success', 'handle', 'note']);
});

test('speak 拒绝非字符串与纯空白文本，且完全不触碰服务', () => {
  let calls = 0;
  const spy = deps({ speak: () => { calls += 1; return {}; } });
  const junk = [null, undefined, '', '   ', '\n\t ', 0, -1, 123, NaN, true, false, {}, [], 1e21];
  for (const bad of junk) {
    const r = bridge.speak(bad, {}, spy);
    assert.equal(r.success, false, String(bad));
    assert.equal(r.error, '朗读文本必须为非空字符串。', String(bad));
    assert.equal(r.handle, undefined);
  }
  assert.equal(calls, 0);
});

test('speak 原样转发未 trim 的文本与 options（默认 {}）', () => {
  const r = bridge.speak('  带空格  ', undefined, deps(echoVoice));
  assert.equal(r.handle.text, '  带空格  ');
  assert.deepEqual(r.handle.options, {});
  assert.equal(bridge.speak('a', { rate: 2, provider: 'x' }, deps(echoVoice)).handle.options.rate, 2);
});

test('speak 把服务抛出的各类异常收敛成 TTS 失败 前缀文案', () => {
  assert.equal(bridge.speak('a', {}, deps({ speak: () => { throw new Error('boom'); } })).error, 'TTS 失败：boom');
  assert.equal(bridge.speak('a', {}, deps({ speak: () => { throw 'plain string'; } })).error, 'TTS 失败：plain string');
  assert.equal(bridge.speak('a', {}, deps({ speak: () => { throw { message: 'obj-throw' }; } })).error, 'TTS 失败：obj-throw');
  assert.equal(bridge.speak('a', {}, deps({ speak: () => { throw new Error(); } })).error, 'TTS 失败：Error');
  assert.equal(bridge.speak('a', {}, deps({ speak: () => { throw new Error(); } })).success, false);
});

test('speak 服务缺方法或 deps 为 null 时 fail-soft 不抛出', () => {
  const noMethod = bridge.speak('a', {}, deps({}));
  assert.equal(noMethod.success, false);
  assert.match(noMethod.error, /speak is not a function/);

  const nullDeps = bridge.speak('a', {}, null);
  assert.equal(nullDeps.success, false);
  assert.match(nullDeps.error, /Cannot read properties of null \(reading 'voiceService'\)/);
});

test('未注入 voiceService 时按相对路径延迟加载同一模块', () => {
  const r = withLazyVoiceService({ speak: (t) => ({ lazy: true, t }) }, () => bridge.speak('hi'));
  assert.equal(r.success, true);
  assert.deepEqual(r.handle, { lazy: true, t: 'hi' });
  const r2 = withLazyVoiceService({ speak: (t) => ({ lazy: true, t }) }, () => bridge.speak('hi', {}, undefined));
  assert.equal(r2.handle.lazy, true);
});

test('stopSpeaking 只回 success 布尔并恰好调用一次服务', () => {
  const before = echoVoice._stopCalls;
  const r = bridge.stopSpeaking(deps(echoVoice));
  assert.deepEqual(r, { success: true });
  assert.equal(echoVoice._stopCalls, before + 1);
});

test('stopSpeaking 把服务异常收敛为 success false 与原始 message', () => {
  assert.deepEqual(
    bridge.stopSpeaking(deps({ stopSpeaking: () => { throw new Error('no proc'); } })),
    { success: false, error: 'no proc' }
  );
  assert.deepEqual(
    bridge.stopSpeaking(deps({ stopSpeaking: () => { throw 'bare'; } })),
    { success: false, error: 'bare' }
  );
  assert.deepEqual(bridge.stopSpeaking(null), {
    success: false,
    error: "Cannot read properties of null (reading 'voiceService')",
  });
});

test('listen 成功时返回 text 与 duration 两字段并原样转发 options', async () => {
  const spy = { listen: async (o) => ({ text: JSON.stringify(o), duration: 2 }) };
  const r = await bridge.listen({ maxDurationSeconds: 5, language: 'zh' }, deps(spy));
  assert.equal(r.success, true);
  assert.equal(r.text, '{"maxDurationSeconds":5,"language":"zh"}');
  assert.equal(r.duration, 2);
  assert.deepEqual(Object.keys(r), ['success', 'text', 'duration']);
});

test('listen 缺省 options 时转发空对象并透传 error 字段', async () => {
  const forwarded = await bridge.listen(undefined, deps({ listen: async (o) => ({ text: JSON.stringify(o) }) }));
  assert.equal(forwarded.text, '{}');
  const failed = await bridge.listen({}, deps({ listen: async () => ({ error: 'mic busy' }) }));
  assert.deepEqual(failed, { success: false, error: 'mic busy' });
});

test('listen 对 null/undefined/空对象结果一律回空文本零时长', async () => {
  for (const res of [null, undefined, {}, '', 42, []]) {
    const r = await bridge.listen({}, deps({ listen: async () => res }));
    assert.equal(r.success, true, JSON.stringify(res));
    assert.equal(r.text, '', JSON.stringify(res));
    assert.equal(r.duration, 0, JSON.stringify(res));
  }
});

test('listen 把 reject 与同步抛错与非函数都收敛成 STT 失败 前缀', async () => {
  assert.equal((await bridge.listen({}, deps({ listen: async () => { throw new Error('no audio'); } }))).error, 'STT 失败：no audio');
  assert.equal((await bridge.listen({}, deps({ listen: async () => { throw 'sync fail'; } }))).error, 'STT 失败：sync fail');
  assert.equal((await bridge.listen({}, deps({ listen: () => { throw new Error('sync boom'); } }))).error, 'STT 失败：sync boom');
  assert.match((await bridge.listen({}, deps({ listen: 'nope' }))).error, /listen is not a function/);
  assert.equal((await bridge.listen({}, null)).success, false);
});

test('capabilities 把 tts/stt 映射为 mouth/ears 并丢弃其余字段', () => {
  const r = bridge.capabilities(deps({ getCapabilities: () => ({ tts: 'edge-tts', stt: 'whisper', platform: 'win32', extra: 1 }) }));
  assert.deepEqual(r, {
    mouth: { available: true, provider: 'edge-tts' },
    ears: { available: true, provider: 'whisper' },
  });
});

test('capabilities 单边能力只点亮对应一侧，另一侧 provider 归 null', () => {
  const mouthOnly = bridge.capabilities(deps({ getCapabilities: () => ({ tts: 'say' }) }));
  assert.deepEqual(mouthOnly, {
    mouth: { available: true, provider: 'say' },
    ears: { available: false, provider: null },
  });
  const earOnly = bridge.capabilities(deps({ getCapabilities: () => ({ stt: 'w' }) }));
  assert.deepEqual(earOnly, {
    mouth: { available: false, provider: null },
    ears: { available: true, provider: 'w' },
  });
});

test('capabilities 对垃圾返回值一律判 available false 且 provider null', () => {
  const cases = [
    {},
    null,
    undefined,
    'nope',
    [],
    { tts: '', stt: '' },
  ];
  for (const caps of cases) {
    const r = bridge.capabilities(deps({ getCapabilities: () => caps }));
    assert.deepEqual(Object.keys(r), ['mouth', 'ears']);
    assert.deepEqual(Object.keys(r.mouth), ['available', 'provider']);
    assert.equal(r.mouth.available, false, JSON.stringify(caps));
    assert.equal(r.ears.available, false, JSON.stringify(caps));
    assert.equal(r.mouth.provider, null, JSON.stringify(caps));
    assert.equal(r.ears.provider, null, JSON.stringify(caps));
  }
});

test('capabilities 探测异常或缺方法时静默降级为双 false', () => {
  const thrown = bridge.capabilities(deps({ getCapabilities: () => { throw new Error('detect failed'); } }));
  assert.equal(thrown.mouth.available, false);
  assert.equal(thrown.ears.available, false);
  assert.deepEqual(bridge.capabilities(deps({})), thrown);
  assert.deepEqual(bridge.capabilities(null), thrown);
});

test('无参 capabilities 走真实 voiceService 但只保证结构契约', () => {
  const r = bridge.capabilities();
  assert.equal(typeof r.mouth.available, 'boolean');
  assert.equal(typeof r.ears.available, 'boolean');
  assert.ok(r.mouth.provider === null || typeof r.mouth.provider === 'string');
});

test('KNOWN-DEFECT: VB-E1 speak 在服务未返回句柄时仍报 success，承诺的 handle.cancel 不存在', () => {
  // measured: handle absent / null / 0 / false all still yield success true with note.
  for (const handle of [undefined, null, 0, false]) {
    const r = bridge.speak('a', {}, deps({ speak: () => handle }));
    assert.equal(r.success, true, String(handle));
    assert.equal(r.handle, handle);
    assert.equal(r.note, '已开始朗读（异步，不阻塞）。');
    assert.notEqual(typeof (r.handle && r.handle.cancel), 'function');
    assert.equal(r.error, undefined);
  }
});

test('KNOWN-DEFECT: VB-E2 listen 在服务直接 resolve 裸字符串时丢掉转写正文', async () => {
  // measured: { success: true, text: '', duration: 0 } — the actual words are lost.
  const r = await bridge.listen({}, deps({ listen: async () => 'raw transcript' }));
  assert.deepEqual(r, { success: true, text: '', duration: 0 });
});

test('KNOWN-DEFECT: VB-E3 listen 把非数字 duration 原样透出，text 为 0 时被吞成空串', async () => {
  // measured: duration 'long' survives the || 0 fallback because it is truthy.
  const r = await bridge.listen({}, deps({ listen: async () => ({ text: 0, duration: 'long' }) }));
  assert.equal(r.success, true);
  assert.equal(r.text, '');
  assert.equal(r.duration, 'long');
  assert.equal(typeof r.duration, 'string');
});

test('KNOWN-DEFECT: VB-E4 listen 只认真值的 error，假值错误标记被当成成功', async () => {
  for (const err of ['', false, 0, NaN]) {
    const r = await bridge.listen({}, deps({ listen: async () => ({ error: err, text: 'kept' }) }));
    assert.equal(r.success, true, String(err));
    assert.equal(r.text, 'kept');
  }
  const objErr = await bridge.listen({}, deps({ listen: async () => ({ error: { code: 1 } }) }));
  assert.equal(objErr.success, false);
  assert.deepEqual(objErr.error, { code: 1 });
});

test('KNOWN-DEFECT: capabilities 的 provider 未做类型收敛，真值数字被当成供应商标识', () => {
  // measured: { tts: 5 } -> mouth { available: true, provider: 5 }.
  const r = bridge.capabilities(deps({ getCapabilities: () => ({ tts: 5, stt: 0 }) }));
  assert.equal(r.mouth.available, true);
  assert.equal(r.mouth.provider, 5);
  assert.equal(r.ears.available, false);
});
