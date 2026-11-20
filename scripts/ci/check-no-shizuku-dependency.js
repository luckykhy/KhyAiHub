#!/usr/bin/env node
/**
 * check-no-shizuku-dependency.js — khyos must not depend on the official
 * Shizuku app, in any form.
 *
 * WHY THIS GUARD EXISTS. On 2026-11-12 the owner decided (see
 * [DESIGN-ARCH-212] §11): khyos stops depending on, bundling, or talking to
 * the official Shizuku app. The privilege it needs comes from khyos' OWN
 * uid-2000 agent (the sidecar) — the same privilege level Shizuku's server
 * has, without the second app.
 *
 * That decision is easy to undo by accident: one dependency line, one
 * manifest entry, one stray import — and the app silently grows a second
 * privilege path that nobody tested. This guard turns the decision into
 * something the build checks, not something a person has to remember.
 *
 * WHAT IT CHECKS (all of them are hard dependencies, not style):
 *   1. build.gradle must not pull any `dev.rikka.shizuku:*` artifact;
 *   2. no source file may import or name `rikka.shizuku.*` / `moe.shizuku.*`;
 *   3. AndroidManifest.xml must not declare the Shizuku client provider;
 *   4. no source file may reference the removed auto-install channel
 *      (`shizukuAutoInstall` / `install_shizuku` / `autoInstallShizuku`);
 *   5. no source file may hard-code the Shizuku package name;
 *   6. the bundled APK assets must not contain a Shizuku package.
 *
 * Usage:
 *   node scripts/ci/check-no-shizuku-dependency.js            # scan the repo
 *   node scripts/ci/check-no-shizuku-dependency.js <root>     # scan a tree
 *
 * Exit codes: 0 = clean, 1 = a dependency came back, 2 = the guard itself
 * could not run (which is NOT a pass — fail closed).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', '..');

const APP = 'delivery/mobile/khy-os-client-app';

const findings = [];
function add(file, line, message) {
  findings.push({ file, line, message });
}

function walk(dir, out, filter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out, filter);
    } else if (!filter || filter(full)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(path.join(repoRoot, APP), [], (f) =>
  /\.(kt|java|dart|gradle|xml|json)$/.test(f),
);

if (sourceFiles.length === 0) {
  console.error('check-no-shizuku-dependency: no source files found — the guard cannot run.');
  process.exit(2);
}

// 1. build.gradle must not depend on the Shizuku client artifacts.
const gradle = path.join(repoRoot, APP, 'android/app/build.gradle');
if (fs.existsSync(gradle)) {
  fs.readFileSync(gradle, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (/dev\.rikka\.shizuku:/.test(line)) {
        add(path.relative(repoRoot, gradle), i + 1, 'build.gradle 仍在依赖官方 Shizuku 客户端');
      }
    });
}

// 2-5. source-level references.
const RULES = [
  {
    re: /(?:import\s+)?(?:rikka\.shizuku|moe\.shizuku)\b/,
    msg: '源码里出现了官方 Shizuku 的包引用',
  },
  {
    re: /rikka\.shizuku\.ShizukuProvider/,
    msg: '清单里声明了 Shizuku 客户端 provider',
  },
  {
    re: /shizukuAutoInstall|install_shizuku|autoInstallShizuku/,
    msg: '源码里引用了已移除的「自动安装官方 Shizuku」通道',
  },
  {
    re: /moe\.shizuku\.privileged\.api/,
    msg: '源码里硬编码了官方 Shizuku 的包名',
  },
];

for (const file of sourceFiles) {
  const rel = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        add(rel, i + 1, `${rule.msg}：${line.trim().slice(0, 120)}`);
      }
    }
  });
}

// 6. no bundled Shizuku package in the assets.
const assetDir = path.join(repoRoot, APP, 'android/app/src/main/assets');
if (fs.existsSync(assetDir)) {
  for (const name of fs.readdirSync(assetDir)) {
    if (/shizuku/i.test(name)) {
      add(path.relative(repoRoot, path.join(assetDir, name)), 0, 'assets 里仍有 Shizuku 安装包');
    }
  }
}

if (findings.length === 0) {
  console.log(
    `check-no-shizuku-dependency: OK（扫描 ${sourceFiles.length} 个文件，无官方 Shizuku 依赖）`,
  );
  process.exit(0);
}

console.error(`check-no-shizuku-dependency: ${findings.length} 处官方 Shizuku 依赖回流：`);
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
}
console.error('');
console.error('依据：[DESIGN-ARCH-212] §11「完全移除官方 Shizuku」。');
console.error('提权由 khyos 自带的 uid-2000 代理（sidecar）提供，不需要第二个 App。');
process.exit(1);
