'use strict';

/**
 * version-mode 的契约测试（node:test）。
 *
 * 锁四件事：
 *   ① 开发态 bump 只 PATCH+1，且 G1 四源同步变（不许只改一处）
 *   ② 版本字段永远是纯数字 —— 不许把 v 前缀或 -dev 后缀写进任何真源
 *   ③ release 切到发布态后禁止再 bump，必须 back 才能继续
 *   ④ back 越过刚发布的版本号（不能回退到已发布的号）
 *
 * 做法：把仓库真文件复制到临时目录当 fixture，跑真实的 version-mode.js 子进程，
 * 不断言内部实现，只断言落盘结果。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'release', 'version-mode.js');

const G1_FILES = [
  'pyproject.toml',
  'works/ship/npm/package.json',
  'runtime/node/backend/package.json',
  'works/ship/modules/modules.json',
];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vmode-'));
  for (const rel of ['pyproject.toml', 'works/ship/npm/package.json', 'runtime/node/backend/package.json', 'works/ship/modules/modules.json', 'CHANGELOG.md']) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (rel === 'CHANGELOG.md') {
      fs.writeFileSync(abs, '# Changelog\n\n## 1.2.0\n\n### Fixed\n\n- 既有条目\n');
    } else if (rel === 'pyproject.toml') {
      fs.writeFileSync(abs, '[project]\nname = "khy-os"\nversion = "1.2.0"\n');
    } else {
      fs.writeFileSync(abs, JSON.stringify({ name: 'x', version: '1.2.0' }, null, 2) + '\n');
    }
  }
  fs.mkdirSync(path.join(dir, 'docs', '10_规范', 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'docs', '10_规范', 'registry', 'VERSION-MODE.json'),
    JSON.stringify({ mode: 'dev', batchesSinceRelease: 0, lastRelease: null }, null, 2) + '\n'
  );
  // 复制脚本与它依赖的 changelog-new.js，让子进程在 fixture 根下跑。
  fs.mkdirSync(path.join(dir, 'scripts', 'release'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'release', 'version-mode.js'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'release', 'changelog-new.js'), path.join(dir, 'scripts', 'release', 'changelog-new.js'));
  return dir;
}

function run(dir, ...argv) {
  return execFileSync(process.execPath, [path.join(dir, 'scripts', 'release', 'version-mode.js'), ...argv], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function versionsIn(dir) {
  const out = {};
  for (const rel of G1_FILES) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    out[rel] = (text.match(/"version"\s*:\s*"([^"]+)"/) || text.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
  }
  return out;
}

test('dev bump 只 PATCH+1 且 G1 四源同步变', () => {
  const dir = fixture();
  run(dir, 'bump');
  const vs = versionsIn(dir);
  for (const rel of G1_FILES) assert.equal(vs[rel], '1.2.1', `${rel} 应为 1.2.1，实为 ${vs[rel]}`);
  // CHANGELOG 顶部段必须跟上，否则 changelog-new --check 会红
  const cl = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(cl, /^## 1\.2\.1$/m, 'CHANGELOG 顶部应是 ## 1.2.1');
  // 批次计数 +1
  const mode = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '10_规范', 'registry', 'VERSION-MODE.json'), 'utf8'));
  assert.equal(mode.batchesSinceRelease, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('版本字段永远是纯数字，不许出现 v 前缀或 -dev 后缀', () => {
  const dir = fixture();
  run(dir, 'bump');
  run(dir, 'release', '1.0.0');
  const all = G1_FILES.map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8')).join('\n');
  assert.ok(!/"version"\s*:\s*"v\d/.test(all), '不许把 v 前缀写进 version 字段');
  assert.ok(!/^version\s*=\s*"v\d/m.test(all), '不许把 v 前缀写进 pyproject version');
  assert.ok(!/\d+\.\d+\.\d+-(dev|rc|alpha|beta)/.test(all), '不许写预发布后缀');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('release 切到发布态后禁止再 bump，必须 back', () => {
  const dir = fixture();
  run(dir, 'release', '1.0.0');
  const mode = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '10_规范', 'registry', 'VERSION-MODE.json'), 'utf8'));
  assert.equal(mode.mode, 'release');
  assert.equal(mode.lastRelease, '1.0.0');
  assert.equal(versionsIn(dir)['pyproject.toml'], '1.0.0');

  assert.throws(() => run(dir, 'bump'), /发布态/, '发布态下 bump 必须被拒');
  const out = run(dir, 'back');
  assert.match(out, /开发态/);
  assert.equal(versionsIn(dir)['pyproject.toml'], '1.0.1', 'back 应越过已发布的 1.0.0');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '10_规范', 'registry', 'VERSION-MODE.json'), 'utf8'));
  assert.equal(after.mode, 'dev');
  assert.equal(after.batchesSinceRelease, 0, '回开发态后批次计数归零');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('back 越过已发布版本号，绝不回退到已发布的号', () => {
  const dir = fixture();
  run(dir, 'release', '2.3.4');
  run(dir, 'back');
  const v = versionsIn(dir)['pyproject.toml'];
  assert.equal(v, '2.3.5');
  assert.ok(v !== '2.3.4', '不许回退到已发布的版本号');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--dry-run 一个字节都不写', () => {
  const dir = fixture();
  const before = G1_FILES.map((r) => fs.readFileSync(path.join(dir, r), 'utf8'))
    .concat(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'));
  run(dir, 'bump', '--dry-run');
  const after = G1_FILES.map((r) => fs.readFileSync(path.join(dir, r), 'utf8'))
    .concat(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'));
  assert.deepEqual(after, before, 'dry-run 不得改动任何文件');
  fs.rmSync(dir, { recursive: true, force: true });
});
