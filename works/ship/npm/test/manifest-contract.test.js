'use strict';

/**
 * npm 渠道的清单契约 —— devenv 单元测试（`npm test`，由 publish-dual.sh 的
 * npm 步骤与审计一起跑）。
 *
 * 这一组断言的来历是一次真实事故：package.json 声明了 `postinstall`，
 * 而 scripts/audit-purity.js 禁止一切 install 钩子。两条声明互相矛盾，于是每次
 * `npm publish` 都在 prepack 的审计上死掉——死在发包之前，现象是"发布没反应"。
 * 审计只在发布那一刻说话，本文件让同一件事在**编辑源码那一刻**就说话。
 *
 * 只读清单、不依赖 bundled/ 产物：全新克隆（尚未 assemble）也必须通过。这里判的是
 * "声明是否守约"，不是"产物是否已生成"——后者是 prepack 的职责，混进来会让本测试
 * 在克隆后无故变红，进而被人加 --force 绕过。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

// 与 scripts/audit-purity.js 的 install-hook 判据保持同一份清单。
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

// publish-dual.sh 第 306 行按名调用这三个；改名/删除会让发布链在最后一跳失败。
const GATE_SCRIPTS = ['assemble', 'prepack', 'audit:purity', 'test'];

// audit-purity.js 要求的包内路径（缺一即拒发）。
const REQUIRED_PATHS = ['bin', 'bundled'];

test('declares no install hooks', () => {
  for (const hook of INSTALL_HOOKS) {
    assert.equal(
      manifest.scripts[hook],
      undefined,
      `npm 渠道不得声明 ${hook}（audit-purity 会因此拒绝发布）。` +
        '若确需在安装后做一次性动作，改为显式命令并在文档里写明。'
    );
  }
});

test('declares no runtime dependencies', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest[field] || {};
    assert.equal(Object.keys(deps).length, 0, `${field} 必须为空：运行时已内嵌在 bundled/`);
  }
});

test('keeps the gate scripts publish-dual.sh calls by name', () => {
  for (const name of GATE_SCRIPTS) {
    assert.ok(
      manifest.scripts[name],
      `scripts.${name} 缺失 —— scripts/release/publish-dual.sh 按名调用它，发布链会断在这里`
    );
  }
});

test('every bin target exists in the package', () => {
  assert.ok(manifest.bin && Object.keys(manifest.bin).length > 0, 'bin 不得为空');
  for (const [name, rel] of Object.entries(manifest.bin)) {
    assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, rel)), `bin.${name} → ${rel} 不存在`);
  }
});

test('files[] ships what the purity audit requires', () => {
  const declared = (manifest.files || []).map((f) => f.replace(/\/$/, ''));
  for (const need of REQUIRED_PATHS) {
    assert.ok(declared.includes(need), `files[] 缺 ${need}/ —— 审计要求它在包内，缺了会拒发`);
  }
});