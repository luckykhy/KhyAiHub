'use strict';

/**
 * routePersistRoundTrip.test.js — §7-⑪/§4.4 的持久化回路，量的是**整条链**而不是两端。
 *
 * §11 那行从前写「✅（§16.4c）」，但 §16.4c 只证了「档位卡读得到」与「选择器画得出」，
 * 从没测过 `persistGatewayPreference` 写下的东西被**下一个进程**读回后，
 * 模式轴是否真的看见这一档。这条测试补的就是那一跳：
 *   写（临时 .env，绝不碰仓库里的）→ 新进程 `dotenv` 装载 → `currentModeName()` →
 *   `requestModeIntent()` 的 β/π 意图。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BE = path.resolve(__dirname, '..', '..');
const envFile = require(path.join(BE, 'src/services/gatewayEnvFile'));

function _roundTrip(modeKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p185-roundtrip-'));
  const target = path.join(dir, '.env');
  // 预置一条要被封禁的钉选 + 一条无关键：验证 unset 只删该删的
  fs.writeFileSync(target, 'GATEWAY_PREFERRED_MODEL=api:some:model\nOTHER=keep\n', 'utf8');
  try {
    envFile.writeEnvPatch(
      {
        GATEWAY_PREFERRED_ADAPTER: 'auto',
        GATEWAY_PREFERRED_STRICT: 'true',
        GATEWAY_ROUTING_MODE: modeKey,
      },
      ['GATEWAY_PREFERRED_MODEL'],
      { envPath: target }
    );
    const written = fs.readFileSync(target, 'utf8');
    const child = execFileSync(
      process.execPath,
      [
        '-e',
        `require('dotenv').config({ path: ${JSON.stringify(target)} });
         const rm = require(${JSON.stringify(path.join(BE, 'src/services/gateway/routingMode'))});
         process.stdout.write(JSON.stringify({
           raw: process.env.GATEWAY_ROUTING_MODE,
           enabled: rm.isEnabled(),
           current: rm.currentModeName(),
           intent: rm.requestModeIntent({ tier: 'T2', prompt: '帮我把这个函数改成异步的', env: process.env }),
         }));`,
      ],
      { encoding: 'utf8', cwd: BE }
    );
    return { written, back: JSON.parse(child) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('写下的档名被新进程读回，且模式轴真的认这一档（§4.4 整条回路）', () => {
  const { written, back } = _roundTrip('economy');
  assert.match(written, /^GATEWAY_ROUTING_MODE=economy$/m, `落盘没有这一行：${written}`);
  assert.ok(!/GATEWAY_PREFERRED_MODEL=/.test(written), 'unset 没生效：钉选键还在，R1 会一直旁路模式轴');
  assert.match(written, /OTHER=keep/, 'patch 把无关键冲掉了');
  assert.equal(back.raw, 'economy', `dotenv 没把它读进 env：${JSON.stringify(back)}`);
  assert.equal(back.enabled, true, '总闸未开 ⇒ 这一档读回来也不参与');
  assert.equal(back.current, 'economy', `currentModeName 没认它：${JSON.stringify(back)}`);
  assert.equal(back.intent.mode, 'economy', `意图里的档名不对：${JSON.stringify(back.intent)}`);
});

test('β/π 意图确实由这一档导出（不是叶子自说自话）', () => {
  const { back } = _roundTrip('economy');
  assert.equal(back.intent.promptVerbosity, 'lean');
  assert.equal(back.intent.thinkingFloor, 'low');
  assert.equal(back.intent.via, 'static-mode');
});

test('正对照：换成 extreme 时导出必须跟着变（否则上一条断言可以被恒真骗过）', () => {
  const { back } = _roundTrip('extreme');
  assert.equal(back.current, 'extreme');
  assert.notEqual(
    JSON.stringify(back.intent),
    JSON.stringify(_roundTrip('economy').back.intent),
    '两档导出完全相同 ⇒ 前面的 intent 断言其实什么都没测'
  );
});
