#!/usr/bin/env node
'use strict';

/**
 * record-guard-snapshot — 跑一遍守卫，把结论落成 APK 能烘进去的快照。
 *
 * 为什么单独一个脚本：整套守卫要几分钟，而且跑不跑得过取决于**改动集**，
 * 不是构建机能决定的。把它塞进 `flutter build apk` 会让每次打包都慢到不可用，
 * 还会让"构建失败"和"守卫不过"混成一句。所以拆开：
 *   人（或 CI）在合适的时机跑这个脚本 → 写 works/record/ai/GUARD-SNAPSHOT.json
 *   build-project-profile.js 只读那份快照，原样带上 takenAt。
 *
 * takenAt 必须带上：一个没有日期的绿灯比不显示更糟。基线性守卫
 * （check-repo-layout 的 domain-direction / functional-unit / entry-buffer）
 * 会随代码增长重新变红，半年前的通过看起来像刚刚的通过就是撒谎。
 *
 * 用法：
 *   node scripts/project-profile/record-guard-snapshot.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'works/record/ai/GUARD-SNAPSHOT.json');

/**
 * 本次改动触及的文件。传给 check-agent-rules，避免它去扫整个未提交仓库。
 *
 * 新增文件时要跟着补——漏一个不会报错，只会让那条守卫少查一个文件，
 * 而快照上看起来还是一盏绿灯。
 *
 * 2026-10-26：`delivery/mobile/khy-os-client-app` 整个带上，不再只列改过的子目录。
 * 补 .dart 进 CODE_EXTS 之后这半边 App 第一次真正进入扫描范围，只列子目录会让
 * 快照声称的覆盖比实际小——而读者无法从快照上看出来。
 */
const AGENT_RULE_TARGETS = [
  'runtime/node/backend/src/services/domain/project',
  'runtime/node/backend/src/services/domain/network',
  'runtime/node/backend/src/tools',
  'runtime/node/backend/src/cli/handlers/stepneo.js',
  'scripts/project-profile',
  'delivery/mobile/khy-os-client-app',
];

/**
 * 守卫清单。每条都是「会亮红灯的命令 = 做完的定义」里的一条
 * （见 CLAUDE.md 第三章）。
 *
 * 一条刻意的不包含，理由在这里——照搬会得到一份假的快照：
 *
 *   check-change-safety：按改动集扫描，本仓当前没有任何提交，`--changed` 会把整个
 *     仓库当成改动集，于是恒定报 "blast radius too large"。那不是守卫的结论，
 *     是仓库状态的副产品。
 *
 *   check-agent-rules 同理，但更贵：`--changed` 在 11662 个未跟踪文件上实测跑了
 *     30 分钟以上没结束。所以显式传 AGENT_RULE_TARGETS，既快又真的是在查这批代码。
 */
const GUARDS = [
  { id: 'gov-rules', cmd: ['scripts/ci/check-gov-rules.js'] },
  { id: 'version-sync', cmd: ['scripts/ci/check-version-sync.js'] },
  { id: 'repo-layout', cmd: ['scripts/ci/check-repo-layout.js'] },
  { id: 'copyright-readiness', cmd: ['scripts/ci/check-copyright-readiness.js'] },
  {
    id: 'agent-rules',
    cmd: ['scripts/ci/check-agent-rules.js', ...AGENT_RULE_TARGETS],
  },
];

/**
 * 密钥形状一律脱敏。
 *
 * 为什么需要：守卫的 stdout 会被烘进 APK（build-project-profile.js 读这份快照）。
 * 万一哪个守卫回显了密钥，那就是把明文密钥塞进了随包分发的产物——R2 红线。
 * 当前没有守卫会这么干，但这条路径不该依赖"将来也没有"。
 */
function redact(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/(appSecret|apiKey|api_key|token)\s*[:=]\s*["']?[^\s"',)]{8,}/gi,
        '$1=<redacted>');
}

/** 跑一条守卫，返回 {id, status, detail}。永不抛——一条跑不动不该挡住其余。 */
function runGuard({ id, cmd }) {
  try {
    const stdout = execFileSync('node', cmd, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { id, status: 'pass', detail: firstMeaningfulLine(stdout) };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return {
      id,
      status: 'fail',
      // 截断：这段文字会烘进 APK 并在设置页显示，无限长度会炸布局。
      detail: redact(firstMeaningfulLine(out)).slice(0, 200),
    };
  }
}

function firstMeaningfulLine(text) {
  const lines = redact(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function main() {
  const results = GUARDS.map(runGuard);
  const payload = {
    takenAt: new Date().toISOString(),
    note:
      '由 scripts/project-profile/record-guard-snapshot.js 生成。' +
      'check-change-safety 未包含：它按改动集扫描，本仓无提交时会恒定报 blast radius。',
    results,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);

  const failed = results.filter((r) => r.status !== 'pass');
  for (const r of results) {
    const mark = r.status === 'pass' ? '✓' : '✗';
    console.log(`${mark} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  }
  console.log(`\nwrote ${path.relative(REPO, OUT)} (${results.length} guards, ${failed.length} failed)`);

  // 快照本身记的是事实，包括"有守卫没过"这个事实。脚本以 0 退出：
  // 调用方要的是快照，不是又一次守卫失败。
  process.exit(0);
}

main();
