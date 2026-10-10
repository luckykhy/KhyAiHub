#!/usr/bin/env node
/**
 * 渲染软著证据图片：图表 + 架构图，全部由 evidence/04_机器可读/contribution-metrics.json
 * 的实测数据生成，**一张都不手绘**。
 *
 * 渲染方式：本机 Edge 无头截图（HTML → PNG），故中文与字体用系统真渲染，不依赖任何 npm 包。
 * 重跑顺序：collect-contribution.js → build-index.js → render-images.js
 *
 * 浏览器可执行文件按规则 1（零硬编码）动态发现：env KHY_EVIDENCE_BROWSER →
 * 扫描 %PROGRAMFILES% / %PROGRAMFILES(X86)% / %LOCALAPPDATA% 下的标准安装位置 → PATH。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const EV = path.join(REPO, 'evidence');
const IMG_ROOT = path.join(EV, '03_图片');
const SRC_DIR = path.join(IMG_ROOT, 'HTML源码');
const METRICS = path.join(EV, '04_机器可读', 'contribution-metrics.json');
const BROWSER_ENV = 'KHY_EVIDENCE_BROWSER';
const VIEWPORT = { w: 1500, h: 1000 };

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function findBrowser() {
  const fromEnv = process.env[BROWSER_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const names = ['Microsoft/Edge/Application/msedge.exe', 'Chromium/Application/chrome.exe', 'Google/Chrome/Application/chrome.exe'];
  for (const r of roots) {
    for (const n of names) {
      const p = path.join(r, n);
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    const found = execFileSync('where', ['msedge'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) return found;
  } catch (e) {
    // PATH 里没有就算了，下面统一报错
  }
  return null;
}

function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');
}

function shot(browser, htmlPath, pngPath) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=FFFFFFFF',
    `--window-size=${VIEWPORT.w},${VIEWPORT.h}`,
    `--screenshot=${pngPath}`,
    fileUrl(htmlPath),
  ];
  execFileSync(browser, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  if (!fs.existsSync(pngPath)) fail(`截图未落盘: ${path.basename(pngPath)}（Edge 无输出目录，检查 --screenshot 路径）`);
  const buf = fs.readFileSync(pngPath);
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(`输出不是合法 PNG: ${path.basename(pngPath)}`);
  return { 字节: buf.length, 宽: buf.readUInt32BE(16), 高: buf.readUInt32BE(20), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

// ── 页面模板 ───────────────────────────────────────────────────────────────
const CSS = [
  'body{margin:0;background:#fff;color:#111827;font-family:"Microsoft YaHei","Segoe UI",sans-serif;padding:28px 34px}',
  'h1{font-size:26px;margin:0 0 4px}',
  '.sub{font-size:14px;color:#4b5563;margin-bottom:20px}',
  '.src{font-size:12px;color:#6b7280;margin-top:22px;border-top:1px solid #e5e7eb;padding-top:10px;line-height:1.6}',
  '.bar-row{display:flex;align-items:center;margin:9px 0;font-size:14px}',
  '.bar-label{width:280px;flex:none;text-align:right;padding-right:12px;color:#374151}',
  '.bar-track{flex:1;background:#f3f4f6;border-radius:3px;height:26px;position:relative}',
  '.bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#1d4ed8,#3b82f6)}',
  '.bar-val{position:absolute;left:calc(100% + 8px);top:4px;font-size:13px;color:#111827;white-space:nowrap}',
  '.tiles{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}',
  '.tile{flex:1;min-width:210px;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;background:#f9fafb}',
  '.tile .n{font-size:30px;font-weight:700;color:#1d4ed8}',
  '.tile .k{font-size:13px;color:#374151;margin-top:4px;line-height:1.5}',
  '.chart{margin:6px 0 2px}',
  'svg{display:block}',
  '.tag{display:inline-block;font-size:12px;color:#374151;border:1px solid #d1d5db;border-radius:11px;padding:1px 9px;margin-right:6px}',
].join('\n');

function page(title, subtitle, body, source, tags) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<h1>${title}</h1>
<div class="sub">${subtitle}</div>
<div>${(tags || []).map((t) => `<span class="tag">${t}</span>`).join('')}</div>
<div class="chart">${body}</div>
<div class="src">${source}</div>
</body></html>`;
}

function bars(rows, opts) {
  const max = Math.max(...rows.map((r) => r.v), 1);
  const fmt = (opts && opts.fmt) || ((n) => n.toLocaleString('en-US'));
  return rows.map((r) => {
    const pct = (r.v / max) * 82;
    return `<div class="bar-row"><div class="bar-label">${r.k}</div><div class="bar-track">`
      + `<div class="bar-fill" style="width:${pct.toFixed(2)}%"></div>`
      + `<div class="bar-val">${fmt(r.v)}</div></div></div>`;
  }).join('\n');
}

function tiles(items) {
  return `<div class="tiles">${items.map((i) => `<div class="tile"><div class="n">${i.n}</div><div class="k">${i.k}</div></div>`).join('')}</div>`;
}

// ── 图片清单：每张写清「回答哪个判据 + 数据出自哪个字段 + 复算命令」──────────
function buildPages(m) {
  const g = m.人类贡献度量.git;
  const f = m.人类贡献度量.反馈存证;
  const h = m.人类贡献度量.人类指令语料;
  const L = m.人类贡献度量.台账;
  const o = m.原创性度量;
  const gov = m.治理体系度量;
  const stamp = m.生成时间.slice(0, 10);

  const pages = [];

  pages.push({
    文件: '图表/01_提交活跃度_全分支按月.png',
    标题: 'KhyOS 开发过程提交活跃度（全部分支，按月）',
    判据: 'C-M4 第④类痕迹：迭代过程，不是一次成型',
    标签: [`口径：--all 全分支 ${g.全分支口径.提交总数} 条`, `分支数 ${g.全分支口径.分支数}`, `快照 ${stamp}`],
    正文: tiles([
      { n: g.全分支口径.提交总数, k: '全分支提交总数（完整开发历史）' },
      { n: g.提交总数, k: '本分支 main 的提交数（重建后的短历史）' },
      { n: Object.keys(g.作者).length, k: '作者数（唯一署名人）' },
      { n: g.全分支口径.含AI署名提交_全分支, k: `含 AI 署名的提交（占 ${g.全分支口径.占比_全分支}%，未抹改历史）` },
    ]) + bars(Object.keys(g.全分支口径.月度提交).sort().map((mo) => ({ k: mo, v: g.全分支口径.月度提交[mo] }))),
    数据源: '人类贡献度量.git.全分支口径.月度提交 / 作者 / 含AI署名提交_全分支',
    复算: ['git log --all --format=%ad --date=format:%Y-%m | sort | uniq -c', 'git rev-list --count --all'],
  });

  const kindRows = Object.keys(f.逐存证类型计数).map((k) => ({ k, v: f.逐存证类型计数[k] }));
  pages.push({
    文件: '图表/02_三模态反馈存证构成.png',
    标题: '修复-新增-删除三模态的过程存证构成（works/data/khy/feedback/）',
    判据: 'C-M4 第③类痕迹（验收动作）+ 规则 5/6/7 的落盘',
    标签: [`任务目录 ${f.任务目录数} 个`, `复现-修复往返 ${f.复现修复往返数} 组`, `快照 ${stamp}`],
    正文: tiles([
      { n: f.任务目录数, k: '留痕的任务目录数' },
      { n: f.复现修复往返数, k: '同一命令「改前 + 改后」双份输出的任务数' },
      { n: f.逐存证类型计数['repro-before.txt'], k: '改前原始输出（规则 5：没复现不许开药）' },
      { n: f.逐存证类型计数['rollback.txt'], k: '可执行回滚命令（规则 7）' },
    ]) + bars(kindRows),
    数据源: '人类贡献度量.反馈存证.逐存证类型计数 / 复现修复往返数',
    复算: ["find works/data/khy/feedback -maxdepth 2 -type f | sed 's#.*/##' | sort | uniq -c"],
  });

  const dayRows = Object.keys(f.按日分布).sort().map((d) => ({ k: d, v: f.按日分布[d] }));
  pages.push({
    文件: '图表/03_存证按日分布.png',
    标题: '过程存证的按日分布（每格 = 当天有活动的任务数）',
    判据: 'C-M4 第④类痕迹：多轮「提出 → 实现 → 反馈 → 修改」',
    标签: [`活跃日 ${f.存证活跃日数} 天`, `${f.存证跨度.起} → ${f.存证跨度.止}`, '时间取存证文件 mtime'],
    正文: bars(dayRows),
    数据源: '人类贡献度量.反馈存证.按日分布',
    复算: ['node scripts/evidence/collect-contribution.js（第 2/5 段）'],
  });

  pages.push({
    文件: '图表/04_人类意愿痕迹.png',
    标题: '人类意愿与验收痕迹的可回查条目数',
    判据: 'C-M4 第①类痕迹（需求来源）+ 软著三问「谁要的 / 怎么验证的」',
    标签: [`扫描 ${h.扫描文件数} 个文件`, `快照 ${stamp}`, '逐条出处见 01_人类贡献/人类指令语料.md'],
    正文: tiles([
      { n: h.source字段行.命中, k: '需求五问里带 source: 出处的行' },
      { n: h.用户引述句.去重, k: '「用户原话 / 要求 / 拍板」引述句（去重）' },
      { n: h.人写的验收标准.条数, k: '人写明的验收标准（= 成功长什么样）' },
      { n: L.任务条目原始.length + L.Bug条目原始.length, k: `任务 ${L.任务条目原始.length} + Bug ${L.Bug条目原始.length} 条台账（.ai/hq/）` },
    ]) + bars([
      { k: 'source: 出处行', v: h.source字段行.命中 },
      { k: '用户原话/要求/拍板 引述句', v: h.用户引述句.去重 },
      { k: '人写的验收标准', v: h.人写的验收标准.条数 },
      { k: '每日工作笔记', v: L.每日工作笔记.文件数 },
    ]),
    数据源: '人类贡献度量.人类指令语料 / 台账',
    复算: ['grep -rn "source:" works/data/khy/feedback --include=*.md | wc -l'],
  });

  const codeRows = ['.c', '.h', '.asm', '.py', '.js']
    .filter((e) => o.内核手写层.按扩展名[e])
    .map((e) => ({ k: `kernel/${e}`, v: o.内核手写层.按扩展名[e].行数 }));
  codeRows.push({ k: '被剔除的 vendor / 生成物（不计原创）', v: o.内核手写层.被剔除的vendor行数 });
  pages.push({
    文件: '图表/05_原创代码规模.png',
    标题: '手写内核层（L0）代码规模与第三方剔除',
    判据: 'C-X3：第三方不得冒充原创；口径 = 非 vendor、非 *_gen.*',
    标签: [`已剔除 ${o.内核手写层.被剔除的vendor文件数} 个 vendor 文件`, `快照 ${stamp}`],
    正文: tiles([
      { n: o.内核手写层.总行数_已剔除第三方, k: '手写行数（剔除第三方后）' },
      { n: o.内核手写层.按扩展名['.c'] ? o.内核手写层.按扩展名['.c'].文件数 : 0, k: '.c 文件数' },
      { n: o.内核手写层.按扩展名['.asm'] ? o.内核手写层.按扩展名['.asm'].文件数 : 0, k: '.asm 文件数' },
      { n: o.第三方与生成物.vendor目录, k: 'vendor/ 下文件数（不进登记材料）' },
    ]) + bars(codeRows),
    数据源: '原创性度量.内核手写层 / 第三方与生成物',
    复算: ['find kernel -name "*.c" -not -path "*vendor*" | xargs wc -l | tail -1'],
  });

  const docRows = Object.keys(o.文档分轴md数).sort().map((k) => ({ k, v: o.文档分轴md数[k] }));
  pages.push({
    文件: '图表/06_治理与设计留痕规模.png',
    标题: '人提出的约束有多少：治理体系与文档留痕规模',
    判据: 'C-E2 设计决策落文档 + C-M4 第②③类痕迹',
    标签: [`规则 ${gov.规则总数} 条（${gov.有执行器的规则数} 条有执行器）`, `检查器 ${gov.CI检查器文件数} 个`, `快照 ${stamp}`],
    正文: tiles([
      { n: gov.CI检查器文件数, k: 'CI 检查器（scripts/ci/check-*）' },
      { n: gov.有执行器的规则数, k: '有执行器的规则（门会真的挡回提交）' },
      { n: gov.纯人工规则数, k: '纯人工判据的规则' },
      { n: gov.提示词文件数, k: `提示词库文件（${gov.提示词分类数} 个分类）` },
    ]) + bars(docRows),
    数据源: '治理体系度量 / 原创性度量.文档分轴md数',
    复算: ['ls scripts/ci/check-*.js scripts/ci/check-*.py | wc -l', 'node scripts/ci/check-rules-registry.js'],
  });

  return pages;
}

// ── 架构图：分层与允许的依赖方向（真源 [DESIGN-LAY-005] 一、二节）────────────
function archPage(m) {
  const stamp = m.生成时间.slice(0, 10);
  const L = [
    ['L0', 'kernel/', '手写 OS 内核：调度 / 分页 / COW fork / 中断 / ELF+PE 双加载器', '#7c3aed'],
    ['L1', 'platform/', 'Python 启动器（探测环境、拉起 Node）+ 共享包 + 交付编排', '#2563eb'],
    ['L2', 'services/', 'Node 运行时，全部业务逻辑：CLI、AI 网关、Web API', '#0891b2'],
    ['L3', 'apps/', '平台自带管理前端（AI 平台 UI）', '#059669'],
    ['L4', 'software/', '跑在平台之上的内置应用（khyquant 量化终端）', '#65a30d'],
    ['L5', 'extensions/', '内置拓展，随主包分发，运行时被发现并激活', '#d97706'],
    ['L6', 'tools/', '独立开发者工具，不参与运行时', '#dc2626'],
  ];
  const CROSS = ['scripts/', 'packaging/', 'docs/', '_source/', 'entries/', 'evidence/', 'electron/', 'tests/', 'deploy/', 'patches/'];
  const EDGES = [
    'L1 → L2：进程启动（spawn），非模块导入',
    'L2 → L1：workspace 包导入 @khy/shared',
    'L3 → L2：HTTP / REST，不得跨目录 import',
    'L4 → L2：HTTP + 少量进程调用',
    'L4 → L1：打包清单',
    'L2 → L4：仅限纯 re-export 壳',
    '横切 → 任意层：按路径引用',
  ];
  const FORBID = [
    'L0 与任何层之间：内核独立，与 Node 栈无运行时耦合',
    'L3 ↔ L4：两个前端不得互相 import',
    'L2 → L3：后端不得反向 import 前端源码',
    '任何层 → L5 / L6：拓展与工具是叶子，只按契约被发现',
    '跨 workspace 的深层相对路径 require',
  ];
  const rows = L.map(([tag, dir, duty, color]) =>
    `<div style="display:flex;align-items:center;margin:7px 0">
      <div style="width:52px;flex:none;font-weight:700;color:${color};font-size:16px">${tag}</div>
      <div style="width:170px;flex:none;font-family:Consolas,monospace;font-size:15px">${dir}</div>
      <div style="flex:1;font-size:13.5px;color:#374151;border-left:4px solid ${color};padding-left:10px">${duty}</div>
    </div>`).join('');
  const body = `<div style="display:flex;gap:26px">
    <div style="flex:1.35">
      <div style="font-size:15px;font-weight:700;margin-bottom:8px">层级 L0–L6（顶层七板块）</div>
      ${rows}
      <div style="font-size:15px;font-weight:700;margin:16px 0 6px">横切层（不参与 L0–L6 依赖判定）</div>
      <div style="font-family:Consolas,monospace;font-size:13px;color:#374151;line-height:1.9">${CROSS.join(' · ')}</div>
    </div>
    <div style="flex:1">
      <div style="font-size:15px;font-weight:700;margin-bottom:8px">允许的依赖方向（白名单）</div>
      ${EDGES.map((e) => `<div style="font-size:13.5px;color:#065f46;margin:5px 0">✓ ${e}</div>`).join('')}
      <div style="font-size:15px;font-weight:700;margin:16px 0 8px">禁止边（守卫 cross-layer-require 执行）</div>
      ${FORBID.map((e) => `<div style="font-size:13.5px;color:#991b1b;margin:5px 0">◉ ${e}</div>`).join('')}
    </div>
  </div>`;
  return {
    文件: '架构图/01_分层架构与依赖方向.png',
    标题: 'KhyOS 仓库层级结构与允许的依赖方向',
    判据: 'C-E2：架构分层是有意设计的，且有机器守卫执行（npm run check:layout）',
    标签: ['真源 [DESIGN-LAY-005] 一、二节', `执行器 scripts/ci/check-repo-layout.js`, `快照 ${stamp}`],
    正文: body,
    数据源: 'docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md（人工规范，非派生数据）',
    复算: ['node scripts/ci/check-repo-layout.js'],
  };
}

// ── 模块依赖图：节点与边全部来自 collect-contribution.js 解析出的真实引用 ────
const SCOPE_COLOR = {
  backend: '#0891b2', 'ai-backend': '#7c3aed', 'ai-frontend': '#059669',
  'khyquant-fe': '#65a30d', pkg: '#d97706', kernel: '#dc2626',
  extensions: '#2563eb', tools: '#4b5563',
};

function depsPage(m) {
  const d = m.模块依赖度量;
  if (!d) fail('contribution-metrics.json 里缺「模块依赖度量」，先重跑 collect-contribution.js（采集 6/6）');
  if (!(d.可解析边 > 500)) fail(`模块依赖边仅 ${d.可解析边} 条（<500），采集器大概率读错了范围，拒绝出图`);
  const top = d.目录权重.slice(0, 16);
  const keep = new Set(top.map((t) => t.目录));
  const edges = d.最强边.filter((e) => keep.has(e.源) && keep.has(e.目标));
  const maxW = Math.max(...edges.map((e) => e.次数), 1);
  const cx = 430, cy = 400, R = 240;
  const pos = new Map();
  top.forEach((n, i) => {
    const a = (i / top.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.目录, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a, n });
  });
  const lines = edges.map((e) => {
    const A = pos.get(e.源), B = pos.get(e.目标);
    const w = 0.8 + 5.2 * Math.sqrt(e.次数 / maxW);
    const mx = (A.x + B.x) / 2 + (cx - (A.x + B.x) / 2) * 0.35;
    const my = (A.y + B.y) / 2 + (cy - (A.y + B.y) / 2) * 0.35;
    const c = SCOPE_COLOR[e.源.split(':')[0]] || '#6b7280';
    return `<path d="M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}" fill="none" stroke="${c}" stroke-width="${w.toFixed(2)}" stroke-opacity="0.42"/>`;
  }).join('\n');
  const SCOPE_ABBR = { backend: 'be', 'ai-backend': 'ab', 'ai-frontend': 'fe', 'khyquant-fe': 'kq', pkg: 'pk', kernel: 'ke', extensions: 'ex', tools: 'to' };
  const shortName = (b) => {
    const i = b.indexOf(':');
    const scope = i < 0 ? b : b.slice(0, i);
    const seg = i < 0 ? '' : b.slice(i + 1).split('/').pop();
    return (SCOPE_ABBR[scope] || scope.slice(0, 2)) + (seg ? ':' + seg : '');
  };
  const nodes = top.map((t) => {
    const p = pos.get(t.目录);
    const c = SCOPE_COLOR[t.目录.split(':')[0]] || '#6b7280';
    const label = `${shortName(t.目录)} ${t.出}/${t.入}`;
    const half = label.length * 3.4;
    let lx = cx + (R + 24) * Math.cos(p.a);
    const ny = cy + (R + 24) * Math.sin(p.a);
    // 一律居中挂在节点外侧，再把 x 夹到画布内，避免长目录名溢出被裁
    lx = Math.min(850 - half, Math.max(10 + half, lx));
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(5 + 9 * Math.sqrt((t.入 + t.出) / (top[0].入 + top[0].出))).toFixed(1)}" fill="${c}" fill-opacity="0.85"/>`
      + `<text x="${lx.toFixed(1)}" y="${ny.toFixed(1)}" font-size="12.5" fill="#111827" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
  }).join('\n');
  const svg = `<svg width="860" height="800" viewBox="0 0 860 800" xmlns="http://www.w3.org/2000/svg"><g>${lines}${nodes}</g></svg>`;
  const legend = Object.entries(SCOPE_COLOR).map(([k, v]) =>
    `<span style="display:inline-block;margin:0 12px 6px 0;font-size:12.5px"><span style="display:inline-block;width:10px;height:10px;background:${v};border-radius:2px;margin-right:5px"></span>${k}</span>`).join('');
  const table = d.最强边.slice(0, 14).map((e) =>
    `<div class="bar-row"><div class="bar-label" style="width:330px">${e.源} → ${e.目标}</div><div class="bar-track"><div class="bar-fill" style="width:${((e.次数 / maxW) * 82).toFixed(2)}%"></div><div class="bar-val">${e.次数}</div></div></div>`).join('');
  const cross = d.跨板块边.slice(0, 8).map((e) => `<div style="font-size:13px;color:#374151;margin:3px 0">${e.路径} · <b>${e.次数}</b></div>`).join('');
  const body = `<div style="display:flex;gap:22px">
    <div style="flex:none">${svg}</div>
    <div style="flex:1;min-width:0">
      <div style="margin-bottom:10px">${legend}
        <div style="font-size:11.5px;color:#6b7280;margin-top:4px">节点标签缩写：be=backend · ab=ai-backend · fe=ai-frontend · kq=khyquant-fe · pk=pkg · ke=kernel · ex=extensions · to=tools；数字为 出/入 引用次数</div>
      </div>
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">最强目录级依赖边（节点标注 出↗ / 入↙）</div>
      ${table}
      <div style="font-size:14px;font-weight:700;margin:16px 0 4px">跨板块引用（层级规范里「允许方向」的实测读数）</div>
      ${cross}
      <div style="font-size:12.5px;color:#4b5563;margin-top:14px;line-height:1.7">
        解析口径：${d.口径}<br>
        扫描范围：${d.统计范围.join(' ｜ ')}<br>
        实测：源文件 ${d.测量文件数.toLocaleString('en-US')} 个 · 内部可解析边 ${d.可解析边.toLocaleString('en-US')} 条 ·
        目录节点 ${d.目录节点数} 个 · 目录级边 ${d.目录级边数} 条 · 未解析 ${d.未解析相对引用} · 外部 npm 包引用 ${d.外部包引用.toLocaleString('en-US')}（不计为内部边）
      </div>
    </div>
  </div>`;
  return {
    文件: '架构图/02_模块依赖图_实测.png',
    标题: '模块依赖图：由源码真实引用解析得到的目录级依赖边',
    判据: 'C-E2：模块划分与依赖方向是有意设计的结果，且边数可机器复算（非手绘示意）',
    标签: ['节点与边 = 实测', `口径 [DESIGN-LAY-005] 第二节`, `快照 ${m.生成时间.slice(0, 10)}`],
    正文: body,
    数据源: 'evidence/04_机器可读/contribution-metrics.json → 模块依赖度量（由源码 require/import specifier 解析）',
    复算: ['node scripts/evidence/collect-contribution.js', "grep -rhoE \"require\\('\\.\\./(services|utils|constants)/\" services/backend/src --include=*.js | wc -l"],
  };
}

function main() {
  const browser = findBrowser();
  if (!browser) {
    fail(`找不到浏览器可执行文件。可显式指定：${BROWSER_ENV}=<msedge 或 chrome 的绝对路径>`);
  }
  process.stdout.write(`渲染器: ${path.basename(browser)}（动态发现，未硬编码路径）\n`);
  if (!fs.existsSync(METRICS)) fail('缺少输入 evidence/04_机器可读/contribution-metrics.json，先跑 node scripts/evidence/collect-contribution.js（5 个采集段）');
  const m = JSON.parse(fs.readFileSync(METRICS, 'utf8'));

  const pages = buildPages(m).concat([archPage(m), depsPage(m)]);
  fs.mkdirSync(SRC_DIR, { recursive: true });

  const manifest = [];
  let i = 0;
  for (const p of pages) {
    i++;
    const html = page(p.标题, p.判据, p.正文, `数据来源：${p.数据源}<br>生成命令：<code>node scripts/evidence/render-images.js</code><br>复算命令：${p.复算.map((c) => `<code>${c}</code>`).join(' ｜ ')}`, p.标签);
    const base = p.文件.replace(/\.png$/, '');
    const htmlPath = path.join(SRC_DIR, base + '.html');
    const pngPath = path.join(IMG_ROOT, p.文件);
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, html, 'utf8');
    const info = shot(browser, htmlPath, pngPath);
    manifest.push({
      图片: p.文件.replace(/\\/g, '/'),
      页面标题: p.标题,
      回答的判据: p.判据,
      数据来源: p.数据源,
      复算命令: p.复算,
      HTML源码: ('03_图片/HTML源码/' + base + '.html'),
      渲染器: path.basename(browser),
      PNG: { 宽: info.宽, 高: info.高, 字节: info.字节, sha256: info.sha256 },
    });
    process.stdout.write(`渲染 ${i}/${pages.length}: ${p.文件} —— ${info.宽}x${info.高}，${info.字节} 字节\n`);
  }

  const out = path.join(IMG_ROOT, '图片清单.json');
  fs.writeFileSync(out, JSON.stringify({
    生成时间: new Date().toISOString(),
    生成器: 'scripts/evidence/render-images.js',
    说明: '本目录所有图片由仓库实测数据经 Edge 无头渲染生成，无一张手绘；HTML源码/ 里是每张图的排版源，可与 PNG 逐条对照。',
    条目数: manifest.length,
    条目: manifest,
  }, null, 2) + '\n', 'utf8');
  process.stdout.write(`落盘 03_图片/图片清单.json —— ${manifest.length} 张\n`);
}

main();
