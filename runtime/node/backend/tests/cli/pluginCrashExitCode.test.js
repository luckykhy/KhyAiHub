// r210 钉桩:用户插件(handler)抛错时,plugins.js catch 打 ✗ 却 return true,
// 派发层吞掉返回值 → 进程 rc=0,shell/CI 看不见失败(#82 Morph-2 同族)。
// 修复 = catch 里补 markProcessFailure。本测试用 KHY_APP_HOME 把 PLUGINS_DIR
// 沙箱到临时目录,dataHome.getAppHome 对该 env 直读(_appHome 在 load 时定格,
// spawn 新进程每次重新解析,夹具不落入仓库/用户真实插件目录)。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.resolve(__dirname, '../../bin/khy.js');

function spawnWithPluginFixture(fileName, src, verb) {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-plugin-pin-'));
  try {
    const dir = path.join(appHome, 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), src);
    return spawnSync(process.execPath, [BIN, verb], {
      encoding: 'utf8',
      input: '',
      timeout: 60000,
      env: { ...process.env, KHY_APP_HOME: appHome },
    });
  } finally {
    fs.rmSync(appHome, { recursive: true, force: true });
  }
}

test('khy <插件抛错> says it failed AND exits 1', () => {
  const r = spawnWithPluginFixture(
    'zzthrow-r210.js',
    "module.exports={name:'zzthrow-r210',description:'pin fixture',async handler(){throw new Error('boom-r210')}};\n",
    'zzthrow-r210',
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(out.includes("插件 'zzthrow-r210' 执行出错"),
    `error text lost (output was:\n${out.slice(0, 400)})`);
  assert.strictEqual(r.status, 1, `plugin crash exits ${r.status} — shell cannot see it`);
});

// 反向控制:合法插件成功路径必须仍 rc=0(门不得误伤)。
test('khy <插件成功执行> stays silent-success AND exits 0', () => {
  const r = spawnWithPluginFixture(
    'zzok-r210.js',
    "module.exports={name:'zzok-r210',description:'pin fixture',async handler(){}};\n",
    'zzok-r210',
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(!out.includes('执行出错'), `success path wrongly failed:\n${out.slice(0, 400)}`);
  assert.strictEqual(r.status, 0, `successful plugin drifts to rc=${r.status}`);
});
