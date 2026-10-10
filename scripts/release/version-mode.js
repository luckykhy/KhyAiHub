#!/usr/bin/env node
'use strict';

/**
 * version-mode.js — 开发态 / 发布态双态版本管理。
 *
 * 解决什么问题：仓里原先只有一套版本号，它同时承担「开发迭代到哪了」和「发布的是什么」
 * 两件事，而 `[DESIGN-SEMVER-002]` R-1 只允许在面向用户的变更上 bump。AI 迭代期的大半
 * 工作是测试接线、守卫修订、文档销账——按 R-1 全都不该 bump，于是版本号长期不动，
 * 「现在跑到哪了」只能靠 git log 数。
 *
 * 双态模型（版本字段**始终纯数字**，守卫 isSemver 不接受 v 前缀与预发布后缀）：
 *
 *   dev      AI 迭代期。字段 X.Y.Z，每个工作批次 PATCH+1；无 v* tag，不触发发布链。
 *   release  正式发布态。字段冻结为发布号，打 v<X.Y.Z> tag → A1 全链发布。
 *
 *   dev → release : `version-mode.js release <X.Y.Z>`
 *   release → dev : `version-mode.js back`（PATCH+1 越过刚发布的号，批次计数归零）
 *
 * 「切换为 v1」不是改版本号格式，而是打 tag —— R-2 原话「tag 才带 v，版本号字段不带」。
 * 所以本脚本永远只写纯数字进字段，v 只出现在它提示你去打的那条 tag 上。
 *
 * 用法：
 *   node scripts/release/version-mode.js status
 *   node scripts/release/version-mode.js bump            # 开发态：PATCH+1 + CHANGELOG 段
 *   node scripts/release/version-mode.js release 1.0.0   # 冻结为发布号
 *   node scripts/release/version-mode.js back            # 发布态 → 开发态
 *   node scripts/release/version-mode.js dev             # 仅切到开发态，不动版本号
 *
 * 任一步都可加 --dry-run 只看不改。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODE_REL = 'docs/10_规范/registry/VERSION-MODE.json';

/** G1 主包的四个版本真源。regex 与 scripts/ci/check-version-sync.js 的 VERSION_SPECS 同源。 */
const G1_SOURCES = [
  { file: 'pyproject.toml', regex: /^version\s*=\s*"([^"]+)"/m, kind: 'toml' },
  { file: 'works/ship/npm/package.json', regex: /"version"\s*:\s*"([^"]+)"/m, kind: 'json' },
  { file: 'runtime/node/backend/package.json', regex: /"version"\s*:\s*"([^"]+)"/m, kind: 'json' },
  { file: 'works/ship/modules/modules.json', regex: /"version"\s*:\s*"([^"]+)"/m, kind: 'json' },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const command = args.find((a) => !a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--') && a !== command);

function fail(msg) {
  console.error(`version-mode: ${msg}`);
  process.exit(1);
}

function isSemver(v) {
  return /^\d+\.\d+(?:\.\d+)?$/.test(String(v || '').trim());
}

function readMode() {
  const abs = path.join(REPO_ROOT, MODE_REL);
  if (!fs.existsSync(abs)) fail(`状态文件缺失：${MODE_REL}`);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function writeMode(mode) {
  const abs = path.join(REPO_ROOT, MODE_REL);
  const next = Object.assign({}, mode, { updated: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(abs, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function readVersion(spec) {
  const abs = path.join(REPO_ROOT, spec.file);
  if (!fs.existsSync(abs)) fail(`版本源缺失：${spec.file}`);
  const text = fs.readFileSync(abs, 'utf8');
  const m = text.match(spec.regex);
  if (!m) fail(`在 ${spec.file} 里找不到版本号（regex 未命中）`);
  return m[1];
}

function writeVersion(spec, next) {
  const abs = path.join(REPO_ROOT, spec.file);
  const text = fs.readFileSync(abs, 'utf8');
  const before = text.match(spec.regex);
  if (!before) fail(`在 ${spec.file} 里找不到版本号`);
  // 只替换版本串本身，保留文件其余字节与缩进风格。
  const replaced = text.replace(spec.regex, (whole) => whole.replace(before[1], next));
  if (replaced === text) fail(`${spec.file} 替换未生效（新旧值相同？）`);
  fs.writeFileSync(abs, replaced);
}

function bumpPatch(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) fail(`无法对 "${v}" 取 PATCH+1（必须是 X.Y.Z）`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 复用 changelog-new.js 的 insertStub，避免第二套 CHANGELOG 写入逻辑。
 *  注意其签名是 insertStub(text, version)，返回 { changed, text, reason }。 */
function insertChangelog(version) {
  const changelog = require('./changelog-new.js');
  const abs = path.join(REPO_ROOT, 'CHANGELOG.md');
  const text = fs.readFileSync(abs, 'utf8');
  const result = changelog.insertStub(text, version);
  if (!result.changed) {
    console.log(`  CHANGELOG.md 顶部已是 ## ${version}，跳过插入（${result.reason}）`);
    return;
  }
  fs.writeFileSync(abs, result.text);
  console.log(`  CHANGELOG.md 已插入 ## ${version} 段（${result.reason}）`);
}

function setAllSources(version, label) {
  for (const spec of G1_SOURCES) {
    const cur = readVersion(spec);
    if (cur === version) {
      console.log(`  ${spec.file} 已是 ${version}`);
      continue;
    }
    console.log(`  ${spec.file}  ${cur} → ${version}`);
    if (!dryRun) writeVersion(spec, version);
  }
  void label;
}

function verifySources() {
  const seen = new Map();
  for (const spec of G1_SOURCES) {
    const v = readVersion(spec);
    seen.set(spec.file, v);
  }
  const uniq = [...new Set(seen.values())];
  if (uniq.length !== 1) {
    fail(`G1 四源不一致：${[...seen.entries()].map(([f, v]) => `${f}=${v}`).join(', ')}`);
  }
  return uniq[0];
}

// ── 子命令 ─────────────────────────────────────────────────────────────────

function cmdStatus() {
  const mode = readMode();
  const v = verifySources();
  console.log(`版本态      : ${mode.mode === 'release' ? '发布态 (release)' : '开发态 (dev)'}`);
  console.log(`当前版本    : ${v}  （G1 四源一致）`);
  console.log(`本批计数    : ${mode.batchesSinceRelease}（自上次发布以来的工作批次）`);
  console.log(`上次发布    : ${mode.lastRelease || '（尚无）'}`);
  if (mode.mode === 'dev') {
    console.log(`下一个批次  : bump → ${bumpPatch(v)}`);
  } else {
    console.log(`发布态已冻结；继续开发用 back → ${bumpPatch(v)}`);
    console.log(`打 tag 发布 : git tag -a v${v} -m "..." && git push <remote> v${v}`);
  }
}

function cmdBump() {
  const mode = readMode();
  if (mode.mode !== 'dev') {
    fail('当前是发布态，不能 bump。先 `version-mode.js back` 回开发态。');
  }
  const cur = verifySources();
  const next = bumpPatch(cur);
  console.log(`开发态批次 bump：${cur} → ${next}`);
  setAllSources(next);
  if (!dryRun) {
    insertChangelog(next);
    const m = writeMode(Object.assign({}, mode, {
      batchesSinceRelease: Number(mode.batchesSinceRelease || 0) + 1,
    }));
    console.log(`本批计数    : ${m.batchesSinceRelease}`);
  }
  console.log(dryRun ? '\n（--dry-run，未写入）' : '\n完成。按 R-1 的「一次提交只做一步」，这笔 bump 请单独成一个 commit。');
}

function cmdRelease(target) {
  if (!target) fail('release 需要目标版本号，如：release 1.0.0');
  if (!isSemver(target)) fail(`"${target}" 不是合法 SemVer（须为 X.Y.Z 纯数字，v 前缀只属于 tag）`);
  const cur = verifySources();
  console.log(`进入发布态：${cur} → ${target}`);
  if (target === cur) {
    console.log('  版本号未变（已是目标值），只切状态。');
  } else {
    setAllSources(target);
  }
  if (!dryRun) {
    insertChangelog(target);
    writeMode(Object.assign({}, readMode(), {
      mode: 'release',
      lastRelease: target,
      batchesSinceRelease: 0,
    }));
  }
  console.log('');
  console.log('下一步（A1 全链发布，四硬条件见 [DESIGN-SEMVER-002] §2.4）：');
  console.log(`  1. node scripts/ci/check-version-sync.js          # 9 源一致`);
  console.log(`  2. node scripts/release/changelog-new.js --check  # 顶部段 == pyproject`);
  console.log(`  3. node scripts/release/release-gate.js           # tier=must 全 PASS`);
  console.log(`  4. git tag -a v${target} -m "v${target}" && git push <remote> v${target}`);
  console.log('');
  console.log('注意：软著登记版本现为 V1.2.0（COPYRIGHT.json）。若正式发布号与之不同，');
  console.log('      须先修订 COPYRIGHT.json 与申请表，否则 check-copyright-readiness 会红。');
}

function cmdBack() {
  const mode = readMode();
  if (mode.mode !== 'release') {
    fail('当前已是开发态。要推进版本用 `version-mode.js bump`。');
  }
  const cur = verifySources();
  const next = bumpPatch(cur);
  console.log(`发布态 → 开发态：${cur} → ${next}（越过刚发布的 ${mode.lastRelease}）`);
  setAllSources(next);
  if (!dryRun) {
    insertChangelog(next);
    writeMode(Object.assign({}, mode, { mode: 'dev', batchesSinceRelease: 0 }));
  }
  console.log(dryRun ? '\n（--dry-run，未写入）' : '\n完成，回到开发态，批次计数已归零。');
}

function cmdDev() {
  const mode = readMode();
  if (mode.mode === 'dev') {
    console.log('已是开发态。');
    return;
  }
  if (!dryRun) writeMode(Object.assign({}, mode, { mode: 'dev' }));
  console.log(`已切到开发态（版本号保持 ${verifySources()} 不动）。`);
}

// ── 入口 ───────────────────────────────────────────────────────────────────

const USAGE = `用法:
  node scripts/release/version-mode.js status
  node scripts/release/version-mode.js bump [--dry-run]
  node scripts/release/version-mode.js release <X.Y.Z> [--dry-run]
  node scripts/release/version-mode.js back [--dry-run]
  node scripts/release/version-mode.js dev [--dry-run]`;

switch (command) {
  case 'status': cmdStatus(); break;
  case 'bump': cmdBump(); break;
  case 'release': cmdRelease(positional[0]); break;
  case 'back': cmdBack(); break;
  case 'dev': cmdDev(); break;
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
