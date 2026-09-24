'use strict';

// khy 网关重置（gatewayResetService.maybeResetGateway）在写配置失败时曾把原始
// errno 语句直接吐给用户：`重置失败: EISDIR: illegal operation on a directory, read`
// ——违反 AGENTS.md 规则 2.2「错误消息不得空洞泛指，必须说明问题+修复建议」，且
// 内部 syscall 措辞对用户毫无意义。同时旧 _writeEnvPatch 对多目标（canonical + 镜像）
// 是「一刀切」：只要任一文件写失败就整体抛错报「失败」，哪怕另一个已落盘——这是
// 假失败（half-write 反向谎报），与真话「部分成功」不符。
//
// 修复：helper 逐文件 try/catch 累计 written[]/failed[]，仅在确有文件写成功后才
// 同步 process.env（避免把未落盘的默认值假装生效）；调用点组装三态中文消息——
//   · 全部失败：`网关配置重置未完全成功：N 个配置文件均写入失败（<code>）`
//   · 部分失败：`网关配置重置未完全成功：已写入 M 个、失败 N 个配置文件（<code>）`
//   · 读失败(抛出)：`网关配置重置失败（<code>）`
// 保留 errno CODE 供诊断，但去掉 syscall 英文整句；修复建议由 cli/bootstrap.js 追加，
// 此处刻意只报问题、不重复 remedy。
//
// 故障注入跨平台：KHY_ENV_FILE 指向目录 → readFileSync 抛 EISDIR（只读路径）；
// monkeypatch fs.writeFileSync → 写失败（写/部分路径）。全程临时目录，不碰仓库真配置。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

const assert = require('assert');
const nt = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { maybeResetGateway } = require('../../src/services/gatewayResetService');

const POLLUTION_KEYS = [
  'GATEWAY_PREFERRED_ADAPTER',
  'RELAY_API_ENDPOINT',
  'RELAY_API_KEY',
  'RELAY_API_MODEL',
  'RELAY_API_COMPATIBILITY',
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

nt.describe('maybeResetGateway honest error / half-write messages (Rule 2.2)', () => {
  nt.test('read-failure: humanized Chinese + errno code, raw syscall sentence gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwreset-dir-'));
    return withEnv({ KHY_ENV_FILE: dir, KHY_ENV_SYNC_ROOT: 'false' }, async () => {
      const r = await maybeResetGateway({ force: true, interactive: false });
      assert.strictEqual(r.reset, false);
      assert.strictEqual(r.reason, 'error');
      assert.ok(/网关配置重置失败/.test(r.message), `expected Chinese problem line: ${r.message}`);
      assert.ok(/EISDIR/.test(r.message), `errno code kept for diagnosis: ${r.message}`);
      // 反例锁：绝不再吐 errno 的 syscall 英文整句。
      assert.ok(!/illegal operation/i.test(r.message), `raw syscall leaked: ${r.message}`);
      assert.ok(!/EISDIR:/.test(r.message), `errno colon-sentence leaked: ${r.message}`);
    });
  });

  nt.test('write-failure (all): honest "均写入失败" + code, no process.env pollution', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwreset-wf-'));
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'GATEWAY_PREFERRED_ADAPTER=stale\n');
    const real = fs.writeFileSync;
    let called = 0;
    fs.writeFileSync = (file, ...rest) => {
      called += 1;
      const err = new Error('injected');
      err.code = 'EISDIR';
      throw err;
    };
    for (const k of POLLUTION_KEYS) delete process.env[k];
    return withEnv({ KHY_ENV_FILE: envFile, KHY_ENV_SYNC_ROOT: 'false' }, async () => {
      const r = await maybeResetGateway({ force: true, interactive: false });
      assert.ok(called > 0, 'writeFileSync should have been attempted');
      assert.strictEqual(r.reset, false);
      assert.strictEqual(r.reason, 'error');
      assert.ok(/未完全成功/.test(r.message), `expected partial/failed wording: ${r.message}`);
      assert.ok(/均写入失败/.test(r.message), `expected all-failed phrase: ${r.message}`);
      assert.ok(/EISDIR/.test(r.message), `errno code kept: ${r.message}`);
      // 未落盘却把默认值同步进 process.env = 假装生效。必须保持未污染。
      for (const k of POLLUTION_KEYS) {
        assert.strictEqual(process.env[k], undefined, `env polluted despite failed write: ${k}`);
      }
    }).finally(() => { fs.writeFileSync = real; });
  });

  nt.test('write-failure (partial): reports both counts, does not claim full success', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwreset-pf-'));
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'GATEWAY_PREFERRED_ADAPTER=stale\n');
    const real = fs.writeFileSync;
    let called = 0;
    fs.writeFileSync = (file, data, ...rest) => {
      called += 1;
      if (called === 1) return real.call(fs, file, data, ...rest); // canonical 成功
      const err = new Error('injected');
      err.code = 'EPERM';
      throw err; // 镜像失败
    };
    return withEnv({ KHY_ENV_FILE: envFile, KHY_ENV_SYNC_ROOT: 'true' }, async () => {
      const r = await maybeResetGateway({ force: true, interactive: false });
      assert.ok(called >= 2, `expected a mirror target too, got ${called} writes`);
      assert.strictEqual(r.reset, false, 'partial must NOT report success');
      assert.ok(/已写入 1 个、失败 1 个/.test(r.message), `expected both counts: ${r.message}`);
      assert.ok(/EPERM/.test(r.message), `errno code kept: ${r.message}`);
      // canonical 已落盘 → 运行时同步允许（written.length>0）。
      assert.notStrictEqual(process.env.GATEWAY_PREFERRED_ADAPTER, undefined,
        'env should sync after a successful write');
    }).finally(() => { fs.writeFileSync = real; });
  });

  nt.test('success path unchanged: reset:true + Chinese success line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwreset-ok-'));
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'GATEWAY_PREFERRED_ADAPTER=stale\n');
    return withEnv({ KHY_ENV_FILE: envFile, KHY_ENV_SYNC_ROOT: 'false' }, async () => {
      const r = await maybeResetGateway({ force: true, interactive: false });
      assert.strictEqual(r.reset, true);
      assert.ok(/网关配置已重置/.test(r.message), `expected success message: ${r.message}`);
    });
  });
});
