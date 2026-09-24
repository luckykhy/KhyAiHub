'use strict';
// Rule 2.2 家族回归：not_a_repo / 拓展缺失 类错误行不得是死胡同——
// 同块内必须紧跟一条给出具体出路的 printInfo。
// 复现证据: .khy/feedback/err-no-remedy-round16/repro-before.txt
//   (非 git cwd 下 `metadata hook install|status|uninstall` 各只有一行 ✗，无出路)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '../..');
const METADATA = path.join(BE, 'src/cli/handlers/metadata.js');
const MD = path.join(BE, 'src/cli/handlers/md.js');

function captureFormatters(fn) {
  const fmts = require(path.join(BE, 'src/cli/formatters'));
  const lines = [];
  const orig = {};
  for (const k of ['printInfo', 'printSuccess', 'printError', 'printWarn', 'printLine']) {
    if (typeof fmts[k] !== 'function') continue;
    orig[k] = fmts[k];
    fmts[k] = (...a) => lines.push(String(a.join(' ')));
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.assign(fmts, orig))
    .then(() => lines);
}

function nonGitDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-nongit-test-'));
  assert.ok(!d.startsWith(BE), 'temp dir must live outside the repo');
  return d;
}

async function runHook(args, cwd) {
  const prev = process.env.KHYQUANT_CWD;
  const prevRc = process.exitCode;
  process.env.KHYQUANT_CWD = cwd;
  try {
    const { handleMetadata } = require(METADATA);
    return await captureFormatters(() => handleMetadata({ args }));
  } finally {
    // ✗ 路径现在会 markProcessFailure —— 不还原会污染测试 runner 的退出码。
    process.exitCode = prevRc;
    if (prev === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = prev;
  }
}

// 每条出路引用都可证伪：命令名/参数形态来自 handler 自身 usage 块与 router 分派。
function assertPair(lines, errNeedle, remedyNeedle, label) {
  const i = lines.findIndex((l) => l.includes(errNeedle));
  assert.ok(i >= 0, `${label}: error line "${errNeedle}" vanished`);
  const remedy = lines.slice(i + 1, i + 3).find((l) => remedyNeedle.test(l));
  assert.ok(remedy, `${label}: dead end — no remedy line after "${errNeedle}"`);
}

test('live: metadata hook install in non-git dir gives cause + way out', async () => {
  const lines = await runHook(['hook', 'install'], nonGitDir());
  assertPair(lines, '当前目录不是 git 仓库', /cd 到 git 仓库|khy metadata hook install/, 'install');
});

test('live: metadata hook uninstall in non-git dir gives cause + way out', async () => {
  const lines = await runHook(['hook', 'uninstall'], nonGitDir());
  assertPair(lines, '当前目录不是 git 仓库', /cd 到 git 仓库|khy metadata hook uninstall/, 'uninstall');
});

test('live: metadata hook status in non-git dir gives cause + way out', async () => {
  const lines = await runHook(['hook', 'status'], nonGitDir());
  assertPair(lines, '当前目录不是 git 仓库', /cd 到 git 仓库|khy metadata hook status/, 'status');
});

test('ratchet: every not_a_repo printError in metadata.js is followed in-block by a remedy', () => {
  const src = fs.readFileSync(METADATA, 'utf8');
  const re = /printError\((\s*)'([^']*不是 git 仓库[^']*)'\)/g;
  let m;
  let seen = 0;
  while ((m = re.exec(src))) {
    seen++;
    const tail = src.slice(m.index, m.index + 400).split('}')[0];
    assert.ok(
      /printInfo\(/.test(tail.slice(m[0].length)),
      `metadata.js dead-end error line (offset ${m.index}): "${m[2]}"`
    );
  }
  assert.ok(seen >= 3, `expected >=3 not_a_repo sites, scanned ${seen}`);
});

test('ratchet: md.js register not-found branch carries the KHY_MD_TOOLS_DIR way out', () => {
  const src = fs.readFileSync(MD, 'utf8');
  // runRegisterScript 的 not-found 分支与 openEditor 的分支共享同一句出路文案。
  const occurrences = [...src.matchAll(
    /printError\(\s*'未找到 khy-markdown 拓展[^']*'\s*\)\s*;\s*(\/\/[^\n]*\n\s*)?printInfo\(\s*'([^']*KHY_MD_TOOLS_DIR[^']*)'/g
  )];
  assert.strictEqual(occurrences.length, 2, 'both not-found branches must keep remedy lines');
});

test('anti-phantom: remedy command name resolves through the manifest', () => {
  const { MANIFEST_EXPORT_KEY } = require(path.join(BE, 'src/cli/commandManifest'));
  const manifest = require(METADATA)[MANIFEST_EXPORT_KEY];
  assert.strictEqual(manifest.name, 'metadata');
  assert.ok(manifest.subCommands.includes('hook'), 'manifest lost the hook verb the remedy cites');
});
