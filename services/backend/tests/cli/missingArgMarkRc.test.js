'use strict';

/**
 * r227/r228/r229 pin test — arg-missing/lookup-miss/未登录 族 ✗/rc=1 配对（#82 doctrine）。
 * 每形断言：rc=1 且屏面带 ✗ 与具体文案。全部探针无副作用：缺参守卫在读/写之前，
 * 双 zz-nonexistent-id 走查无分支（prompt use 命中真 ID 会转发 AI 网关，故只用不存在 ID）。
 * 真实派发链 spawn + 三重钉桩沙箱（KHY_APP_HOME + KHY_PROJECT_DATA_HOME + TMP/TEMP）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND = path.resolve(__dirname, '..', '..');
const BIN = path.join(BACKEND, 'bin', 'khy.js');

function run(args, opts = {}) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r227-'));
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd || BACKEND,
    encoding: 'utf8',
    timeout: 20000,
    input: '',
    env: {
      ...process.env,
      KHY_APP_HOME: path.join(sb, 'app'),
      KHY_PROJECT_DATA_HOME: path.join(sb, 'proj'),
      TMP: sb,
      TEMP: sb,
    },
  });
  return { out: (res.stdout || '') + (res.stderr || ''), status: res.status };
}

const SHAPES = [
  { args: ['growth', 'import'], msg: /✗ 用法: growth import <归档文件路径>/ },
  { args: ['growth', 'restore'], msg: /✗ 用法: growth restore <快照ID>/ },
  { args: ['prompt', 'save'], msg: /✗ 用法: prompt save/ },
  { args: ['prompt', 'use'], msg: /✗ 用法: prompt use <ID>/ },
  { args: ['prompt', 'use', 'zz-nonexistent-id'], msg: /✗ 未找到提示词: zz-nonexistent-id/ },
  { args: ['prompt', 'delete'], msg: /✗ 用法: prompt delete <ID>/ },
  { args: ['prompt', 'delete', 'zz-nonexistent-id'], msg: /✗ 未找到: zz-nonexistent-id/ },
  { args: ['prompt', 'search'], msg: /✗ 用法: prompt search <关键词>/ },
  { args: ['prompt', 'folder', 'new'], msg: /✗ 用法: prompt folder new <名称>/ },
  { args: ['knowledge', 'search'], msg: /✗ 请输入搜索关键词/ },
  { args: ['knowledge', 'sync', 'config'], msg: /✗ 请指定仓库地址/ },
  // r228 顺延簇: receipts 缺参/查无族 + account/position 未登录族。
  { args: ['receipts', 'show'], msg: /✗ 用法: receipts show <RCPT-id>/ },
  { args: ['receipts', 'show', 'zz-nonexistent-id'], msg: /✗ 未找到回执: zz-nonexistent-id/ },
  { args: ['receipts', 'search'], msg: /✗ 用法: receipts search <keyword>/ },
  { args: ['account'], msg: /✗ 请先登录/ },
  { args: ['position'], msg: /✗ 请先登录/ },
  // r229 顺延簇: router.js image2web/server 用法 + plugin gateway show/edit/import 查无族。
  { args: ['image2web'], msg: /✗ 用法: image2web/ },
  { args: ['server', 'zz-nonexistent-verb'], msg: /未知 server 子命令.*zz-nonexistent-verb/ },
  { args: ['server'], msg: /✗ 缺少 server 子命令/ },
  { args: ['plugin', 'gateway', 'show', 'zz-nonexistent'], msg: /✗ Plugin "zz-nonexistent" not found/ },
  { args: ['plugin', 'gateway', 'edit', 'zz-nonexistent'], msg: /✗ Plugin "zz-nonexistent" not found/ },
  { args: ['plugin', 'gateway', 'import', 'zz-nonexistent-file.js'], msg: /✗ 文件不存在/ },
  // r230 顺延簇: slash 簇 effort 无效精度 + branch 非 git cwd 读取失败族。
  { args: ['effort', 'zz-bogus'], msg: /✗ 无效精度/ },
];

// branch 的 ✗ 分支只在非 git cwd 可达（execSync('git branch -a') 抛错进 catch）；
// mkdtemp 沙箱目录在仓库外，即天然的 non-git cwd。
{
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r230-nogit-'));
  test('branch (non-git cwd) prints ✗ and exits 1 (#82 pair)', () => {
    const { out, status } = run(['branch'], { cwd: sb });
    assert.strictEqual(status, 1, `rc must be 1, got ${status}`);
    assert.match(out, /✗ 分支读取失败/);
  });
}

for (const { args, msg } of SHAPES) {
  test(`${args.join(' ')} prints ✗ and exits 1 (#82 pair)`, () => {
    const { out, status } = run(args);
    assert.strictEqual(status, 1, `rc must be 1, got ${status}`);
    assert.match(out, msg);
  });
}
