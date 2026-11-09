'use strict';

/**
 * SendUserFile 声明回归（node:test）。
 *
 * 这个套件的存在是为了钉死一个已经被讨论过的结论：**`risk='safe'` 与
 * `isReadOnly(){return true}` 不能被「顺手」改成 false**。
 *
 * 为什么（实测，见本文件末尾的反向用例）：
 *   isReadOnly=false → intentSchema 的动作正则 /(read|glob|grep|list|stat|cat|view|search|get|ls)/
 *   对 'senduserfile' 一个都不匹配 → action=UNKNOWN → resourceClassifier 判 L2；
 *   isExemptible 对 L2 恒 false。所以「改成 false 更安全」的直觉是反的：
 *   改完之后不是多一道确认，而是落到一个**确认了也不拦**的档位
 *   （ilink 上 L2 的 typed 确认本就是伪造的 typed）。
 *
 * 真正的闸门在出站点（ilinkDeliveryGuard / ilinkFileDelivery），不在这里 ——
 * 本工具 execute 只 existsSync + statSync + 回路径，没有对外副作用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const test = require('node:test');
const assert = require('node:assert');

const SendUserFileTool = require('../../src/tools/SendUserFileTool');
const registry = require('../../src/tools/index.js');
const { buildIntent } = require('../../src/services/domain/system/syscallGateway/intentSchema.js');
const { classify, isExemptible, LEVELS } = require('../../src/services/domain/system/syscallGateway/resourceClassifier.js');

test('注册表 def:SendUserFile 在册,risk 必须是 safe', () => {
  registry.loadTools();
  const def = registry.getAll().get('SendUserFile');
  assert.ok(def, 'SendUserFile 应在注册表里');
  assert.strictEqual(def.name, 'SendUserFile');
  assert.strictEqual(
    def.risk,
    'safe',
    'risk 必须保持 safe —— 改成 medium/high 不是「更安全」，只是把声明与工具实际行为说谎'
  );
  assert.strictEqual(SendUserFileTool.risk, 'safe');
});

test('声明回归:isReadOnly 必须为 true（不得被改成 false）', () => {
  const t = new SendUserFileTool();
  assert.strictEqual(t.isReadOnly({ file_path: '/tmp/x' }), true);
  assert.strictEqual(
    t.isReadOnly({ file_path: '/tmp/x' }),
    true,
    '锁死本次结论:isReadOnly 改 false 会掉进 L2,而 L2 不可免审'
  );
});

test('execute:路径不存在 —— 返回 {error},不抛', async () => {
  const t = new SendUserFileTool();
  const r = await t.execute({ file_path: path.join(os.tmpdir(), 'definitely-not-here-12345.txt') });
  assert.strictEqual(r.success, undefined);
  assert.ok(r.error, `应返回 error,实际:${JSON.stringify(r)}`);
  assert.match(r.error, /File not found/);
});

test('execute:存在的文件 —— 只 stat 并回路径,不产生对外副作用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senduserfile-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello');
  const r = await new SendUserFileTool().execute({ file_path: f });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.file, f);
  assert.strictEqual(r.name, 'a.txt');
  assert.strictEqual(r.size, 5);
});

// ── 网关分级：正向 + 反向（把这次的教训钉在测试里）──────────────────────────

test('网关分级:isReadOnly=true → L1 且可免审（维持现状）', () => {
  // buildIntent 的 home/cwd 可显式传入(intentSchema.js:276-277)，避免受本机环境影响。
  const level = classify(
    buildIntent({
      tool: 'SendUserFile',
      params: { file_path: '/tmp/x' },
      isReadOnly: true,
      home: os.homedir(),
      cwd: os.tmpdir(),
    })
  ).level;
  assert.strictEqual(level, LEVELS.L1, `实际:${level}`);
  assert.strictEqual(isExemptible(level), true, 'L1 必须可免审');
});

test('反向说明:isReadOnly=false → L2 且不可免审（这就是「别改成 false」的机械理由）', () => {
  const level = classify(
    buildIntent({
      tool: 'SendUserFile',
      params: { file_path: '/tmp/x' },
      isReadOnly: false,
      home: os.homedir(),
      cwd: os.tmpdir(),
    })
  ).level;
  assert.strictEqual(level, LEVELS.L2, `实际:${level}`);
  assert.strictEqual(
    isExemptible(level),
    false,
    'L2 恒不可免审 —— 所以把 isReadOnly 改成 false 不是「加一道审批」'
  );
});
