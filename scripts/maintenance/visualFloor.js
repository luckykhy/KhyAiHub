'use strict';

/**
 * visualFloor.js — 根目录「视觉层」收敛器（方案 P §14 的视觉半区）。
 *
 * 为什么存在：5-3-1 §1 管的是人眼感知到的组件数；资源管理器用 Hidden 属性决定可见性，
 * 而 .git 本就因隐藏位不出现在用户视野里。把机器契约面（dot 配置位、锁文件、构建清单）
 * 统一打 +h，不移动任何文件、不改 git 跟踪面，任何工具（node/git/npm/AI）都不读文件属性，
 * 用户在 Explorer 勾「显示隐藏项」即可原路回退。
 *
 * 属性不随 clone 传播 ⇒ 本脚本幂等、可重复执行；新机器/换库后跑一次即可。
 *
 * 用法：
 *   node scripts/maintenance/visualFloor.js --report   # 只列将改动的项
 *   node scripts/maintenance/visualFloor.js            # 执行
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

// 只收「机器读的文件」与「工具配置位」。人读文档(README/AGENTS/CLAUDE/CHANGELOG…)、
// 板块目录、启动器一律不动——它们要么是人打开的对象，要么是方案 P 物理化后要归域的主体。
const HIDE = [
  // 工具契约 dot 目录
  '.ai', '.claude', '.commandcode', '.cursor', '.githooks', '.github',
  '.khy', '.khyos', '.opencode', '.workbuddy', '.workbuddy-ai', '.zcode',
  // dot 文件
  '.clinerules', '.dockerignore', '.editorconfig', '.env.example',
  '.gitattributes', '.git-blame-ignore-revs', '.gitignore', '.mailmap',
  '.npmrc', '.portable',
  // 锁文件与构建/部署清单（机器按名读取，人不经 Explorer 打开它们）
  'package-lock.json', 'pnpm-lock.yaml', 'MANIFEST.in',
  'Dockerfile', 'docker-compose.yml', 'fly.staging.toml',
  // 依赖树（npm 官方行为即在 Windows 给 node_modules 打隐藏位）
  'node_modules',
];

function isHidden(p) {
  try {
    // attrib 输出: "A    H      C:\path" — 含 H 即 hidden。用 fs 无 Windows 属性 API，走 attrib。
    const out = execFileSync('attrib', [p], { encoding: 'utf8' });
    return /\bH\b/.test(out);
  } catch {
    return false;
  }
}

const report = process.argv.includes('--report');
let changed = 0;
for (const name of HIDE) {
  const p = path.join(REPO, name);
  if (!fs.existsSync(p)) continue;
  if (isHidden(p)) continue;
  changed += 1;
  if (report) {
    console.log(`  will hide: ${name}`);
  } else {
    execFileSync('attrib', ['+h', p]);
    console.log(`  hidden: ${name}`);
  }
}
console.log(`${report ? '[report] 待隐藏' : '已隐藏'} ${changed} 项；回退：Explorer 勾「显示隐藏项」或 attrib -h <路径>`);
