#!/usr/bin/env node
'use strict';

/**
 * check-version-freshness.js — 「该换版本号了」提示器。
 *
 * 解决什么问题：R-1/T1/T2/T3 规定了什么时候该 bump，但**没有任何东西在那个时候提醒你**。
 * 结果是版本号长期不动，「现在跑到哪了」只能靠 git log 数——正是这个仓一直在消灭的
 * 「靠人记」模式。人开发时尤其如此：没有 AI 在场提示，改完就推送，版本号原地不动。
 *
 * 判据（机械、不猜语义）：开发态下，距上次 bump 已有提交 → 该考虑 bump 了。
 * 不判断「这些提交算不算 T1/T2/T3」——那是 R-1 的事，本脚本只负责把事实摆到台面上，
 * 让人/ AI 在该做决定的时刻看见它。
 *
 * 用法：
 *   node scripts/ci/check-version-freshness.js            # 人读报告，恒 exit 0
 *   node scripts/ci/check-version-freshness.js --json     # 机读
 *   node scripts/ci/check-version-freshness.js --strict   # 超阈值则 exit 1（CI 用）
 *
 * 挂在 pre-push 上：推一次报一次，推完即忘，不阻断。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODE_REL = 'docs/10_规范/registry/VERSION-MODE.json';

/** G1 四个版本真源（与 check-version-sync.js 的 VERSION_SPECS 同源）。 */
const G1_SOURCES = [
  'pyproject.toml',
  'works/ship/npm/package.json',
  'runtime/node/backend/package.json',
  'works/ship/modules/modules.json',
];

/** 提交数超过这个数就升级为 warning（--strict 下判红）。 */
const NAG_THRESHOLD = 5;

const args = process.argv.slice(2);
const isJson = args.includes('--json');
const strict = args.includes('--strict');

function git(argv) {
  try {
    return execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

function readMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MODE_REL), 'utf8'));
  } catch (e) {
    return null;
  }
}

function currentVersion() {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'pyproject.toml'), 'utf8');
  const m = text.match(/^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

// 最近一次改动任一版本真源的提交
const lastBumpCommit = git(['log', '-1', '--format=%H', '--', ...G1_SOURCES]);
const head = git(['rev-parse', 'HEAD']);

let commitsSince = 0;
let filesSince = 0;
if (lastBumpCommit && head && lastBumpCommit !== head) {
  const out = git(['rev-list', '--count', `${lastBumpCommit}..HEAD`]);
  commitsSince = Number(out) || 0;
  const numstat = git(['diff', '--numstat', `${lastBumpCommit}..HEAD`]);
  filesSince = numstat ? numstat.split('\n').filter(Boolean).length : 0;
}

const mode = readMode();
const version = currentVersion();
const isDev = !mode || mode.mode !== 'release';
const shouldNag = isDev && commitsSince > 0;

const report = {
  mode: isDev ? 'dev' : 'release',
  version,
  lastRelease: (mode && mode.lastRelease) || null,
  batchesSinceRelease: (mode && Number.isFinite(mode.batchesSinceRelease)) ? mode.batchesSinceRelease : null,
  lastBumpCommit: lastBumpCommit ? lastBumpCommit.slice(0, 9) : null,
  commitsSinceBump: commitsSince,
  filesSinceBump: filesSince,
  shouldNag,
  threshold: NAG_THRESHOLD,
};

if (isJson) {
  console.log(JSON.stringify(report, null, 2));
} else if (!isDev) {
  console.log(`版本态：发布态 · ${version}（冻结中，${report.lastRelease || '?'} 已发布）`);
  console.log('  继续开发用：node scripts/release/version-mode.js back');
} else if (!shouldNag) {
  console.log(`版本态：开发态 · ${version} · 工作树与版本号同步，无需 bump`);
} else {
  const over = commitsSince >= NAG_THRESHOLD;
  console.log(`版本态：开发态 · 当前版本 ${version}`);
  console.log(`  距上次 bump：${commitsSince} 个提交 / ${filesSince} 个文件`);
  console.log(`  本批计数  ：${report.batchesSinceRelease}`);
  if (over) {
    console.log(`  ⚠ 已积压 ${commitsSince} 个提交（阈值 ${NAG_THRESHOLD}）——该 bump 了：`);
  } else {
    console.log('  若这批工作已收口，该 bump 了：');
  }
  console.log('    node scripts/release/version-mode.js bump');
  console.log('  （PATCH，开发态已预授权；小/大版本须人批准，见 CLAUDE.md B7）');
}

// 恒不阻断推送，除非 --strict 且超阈值。
if (strict && over) process.exit(1);
process.exit(0);
