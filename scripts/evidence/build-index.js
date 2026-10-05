#!/usr/bin/env node
/**
 * 由 works/record/evidence/04_机器可读/contribution-metrics.json 生成人类贡献与原创性文档。
 *
 * 为什么用脚本生成而不是手写：这些文档里的每一个数字都要能被复算，手写就会漂移。
 * 重跑顺序：collect-contribution.js → build-index.js。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const EV = path.join(REPO, 'evidence');
const METRICS = path.join(EV, '04_机器可读', 'contribution-metrics.json');

function load() {
  if (!fs.existsSync(METRICS)) {
    process.stderr.write('缺少输入 ' + path.relative(REPO, METRICS).replace(/\\/g, '/') + '，请先跑 node scripts/evidence/collect-contribution.js（8 个采集段）\n');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(METRICS, 'utf8'));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function head(title, subtitle) {
  return [
    '<!-- 本文件由 scripts/evidence/build-index.js 生成，勿手改数字；要改口径请改采集器。 -->',
    '# ' + title,
    '',
    '> ' + subtitle,
    '>',
    '> 数据快照时间：' + new Date().toISOString().slice(0, 10) + '；输入：`works/record/evidence/04_机器可读/contribution-metrics.json`。',
    '',
  ].join('\n');
}

// ── 01_人类贡献/人类指令语料.md ────────────────────────────────────────────
function buildHumanCorpus(m) {
  const h = m.人类贡献度量.人类指令语料;
  const src = h.source字段行.条目;
  // 「人类指向」必须是**真实引述**（用户原话/要求/拍板…），而不是讨论规则文本时提到的字句
  const QUOTE_VERB = /(用户|客户)(原话|要求|指示|指令|拍板|点头|决定|确认|明确)/;
  const humanSrc = src.filter((s) => QUOTE_VERB.test(s.原文));
  const quotes = h.用户引述句.条目;
  const acc = h.人写的验收标准.条目;

  const lines = [head(
    '人类指令语料（需求来源原文）',
    '回答软著三问的第一问「**谁要的**」。以下每条都是仓库内文件的**原文摘录**，附 `文件:行`，任何人不依赖本文件即可回查原处。'
  )];

  lines.push('## 一、`source:` 字段行（规则 6「需求五问」的出处登记）', '');
  lines.push(`实测：扫描 ${h.扫描文件数} 个文件，命中 ${h.source字段行.命中} 行，去重 ${h.source字段行.去重} 条，其中**直指人类指令** ${h.source字段行.其中人类指向} 条。`, '');
  lines.push('| # | 原文 | 出处 |');
  lines.push('|---|------|------|');
  humanSrc.slice(0, 80).forEach((s, i) => {
    lines.push(`| ${i + 1} | ${esc(truncate(s.原文, 220))} | \`${esc(s.文件)}:${s.行}\` |`);
  });
  lines.push('');
  lines.push(`> 只列「人类指向」的 ${humanSrc.length} 条中的前 ${Math.min(80, humanSrc.length)} 条；`
    + `其余 ${h.source字段行.去重 - humanSrc.length} 条 source 行指向文档编号或 issue，全量在 \`works/record/evidence/04_机器可读/contribution-metrics.json\` 的「人类指令语料.source字段行.条目」。`, '');

  lines.push('## 二、「用户原话 / 用户要求 / 用户拍板」引述句', '');
  lines.push(`实测去重 ${quotes.length} 条。这些句子出现在**改动当时**的存证里，不是事后补写。`, '');
  lines.push('| # | 原文 | 出处 |');
  lines.push('|---|------|------|');
  quotes.slice(0, 80).forEach((s, i) => {
    lines.push(`| ${i + 1} | ${esc(truncate(s.原文, 220))} | \`${esc(s.文件)}:${s.行}\` |`);
  });
  lines.push('');

  lines.push('## 三、人写的验收标准（回答第三问「怎么验证的」）', '');
  lines.push(`任务台账 ${m.人类贡献度量.台账.任务条目原始.length} 项中，**${h.人写的验收标准.条数} 项带人写明的验收标准**`
    + '（即规则 6 第 4 问「成功长什么样 = 命令 + 期望输出」的落地）。', '');
  lines.push('| id | 标题 | 验收标准（原文摘录） | 状态 |');
  lines.push('|----|------|---------------------|------|');
  for (const a of acc) {
    lines.push(`| ${esc(a.id)} | ${esc(truncate(a.标题, 46))} | ${esc(truncate(a.验收标准, 200))} | ${esc(a.状态)} |`);
  }
  lines.push('');
  lines.push('## 四、复算方式', '');
  lines.push('```bash', ...h.复算命令, '```', '');
  return lines.join('\n');
}

// ── 01_人类贡献/迭代与验收.md ──────────────────────────────────────────────
function buildIteration(m) {
  const f = m.人类贡献度量.反馈存证;
  const g = m.人类贡献度量.git;
  const L = m.人类贡献度量.台账;
  const lines = [head(
    '迭代与验收（不是一次成型的证据）',
    '回答软著三问的第三问「**怎么验证的**」与 C-M4 第 ④ 类痕迹「迭代过程」。'
    + '核心证据是规则 5/6/7 的落盘存证：每次修复都留了**改前原始输出**与**改后同一命令的输出**。'
  )];

  lines.push('## 一、三模态反馈存证（`works/data/khy/feedback/`）', '');
  lines.push(`共 **${f.任务目录数} 个任务目录**，覆盖 ${f.存证活跃日数} 个活跃日（${f.存证跨度 ? f.存证跨度.起 + ' → ' + f.存证跨度.止 : '无'}）。`, '');
  lines.push('| 存件 | 份数 | 含义 |');
  lines.push('|------|------|------|');
  const MEAN = {
    'complaint.md': '主诉：谁、在什么条件下、什么现象（规则 7 之「病状」）',
    'repro-before.txt': '**改前原始输出**——没量体温不许开药（规则 5，缺则判 error）',
    'differential.md': '≥2 个候选病因，每个给一条可证伪预测',
    'repro-after.txt': '改后跑同一条命令的输出（复诊）',
    'requirement-5q.md': '新增功能前答完的需求五问（规则 6）',
    'rollback.txt': '可执行的回滚命令（规则 7，缺则判 error）',
    'mode.json': '本次改动的模态声明（FIX / BUILD / DELETE）',
  };
  for (const k of Object.keys(f.逐存证类型计数)) {
    lines.push(`| \`${k}\` | ${f.逐存证类型计数[k]} | ${MEAN[k] || ''} |`);
  }
  lines.push('');
  lines.push(`**复现-修复往返 ${f.复现修复往返数} 组**——同一任务既有改前输出又有改后输出。`
    + '这是「人有在逐轮检查」最硬的证据：AI 自说自话的改动不会留下改前的真实报错。', '');

  lines.push('## 二、按日分布（每格 = 当天新增存证的任务数）', '');
  lines.push('| 日期 | 任务数 | 日期 | 任务数 |');
  lines.push('|------|--------|------|--------|');
  const days = Object.keys(f.按日分布).sort();
  for (let i = 0; i < days.length; i += 2) {
    const a = days[i];
    const b = days[i + 1];
    lines.push(`| ${a} | ${f.按日分布[a]} | ${b || ''} | ${b ? f.按日分布[b] : ''} |`);
  }
  lines.push('');

  lines.push('## 三、提交历史（两个口径必须分开引用）', '');
  lines.push(`- **本分支 main**：${g.提交总数} 条提交，作者 ${Object.keys(g.作者).length} 位（${esc(g.首位作者署名 || '')}），跨度 ${g.提交日期范围.起} → ${g.提交日期范围.止}。`, '');
  lines.push(`- **全部 ${g.全分支口径.分支数} 个分支**：${g.全分支口径.提交总数} 条提交。含 AI 署名者 ${g.全分支口径.含AI署名提交_全分支} 条（${g.全分支口径.占比_全分支}%）。`, '');
  lines.push('- 两个口径差异的原因：`main` 是被**重建过的短历史**，完整过程留在各功能分支上。引用时不得混用，否则数字对不上。', '');
  lines.push('', '| 月份 | 本分支 | 全分支 |', '|------|--------|--------|');
  const months = Array.from(new Set([...Object.keys(g.月度提交), ...Object.keys(g.全分支口径.月度提交)])).sort();
  for (const mo of months) {
    lines.push(`| ${mo} | ${g.月度提交[mo] || 0} | ${g.全分支口径.月度提交[mo] || 0} |`);
  }
  lines.push('');

  lines.push('## 四、任务 / Bug 台账（`.ai/hq/`，多机共享、已入仓）', '');
  lines.push(`- 任务 ${L.任务条目原始.length} 项，状态分布：${JSON.stringify(L.任务台账.按状态)}；`, '');
  lines.push(`- Bug ${L.Bug条目原始.length} 项，状态分布：${JSON.stringify(L.Bug台账.按状态)}；`, '');
  lines.push(`- 每日工作笔记 ${L.每日工作笔记.文件数} 篇（\`.workbuddy/memory/\`）。`, '');
  lines.push('');
  lines.push('### 逐条 Bug（标题 + 症状摘录）', '');
  lines.push('| id | 级别 | 状态 | 标题 |');
  lines.push('|----|------|------|------|');
  for (const b of L.Bug条目原始) {
    if (!b || !b.id) continue;
    lines.push(`| ${esc(b.id)} | ${esc(b.severity)} | ${esc(b.status)} | ${esc(truncate(b.title, 70))} |`);
  }
  lines.push('');
  lines.push('## 五、复算方式', '');
  lines.push('```bash', ...f.复算命令, ...g.复算命令, '```', '');
  return lines.join('\n');
}

// ── 02_独创性/原创代码规模.md ──────────────────────────────────────────────
function buildOriginality(m) {
  const o = m.原创性度量;
  const gov = m.治理体系度量;
  const lines = [head(
    '原创代码规模与第三方边界',
    '回答「独创性在哪」。口径：**只计非 vendor、非 `*_gen.*` 的源文件**——把第三方代码计入手写行数，'
    + '正是 C-X3 判死的那种事。'
  )];

  lines.push('## 一、手写内核层（`kernel/`，L0）', '');
  lines.push(`剔除第三方后共 **${o.内核手写层.总行数_已剔除第三方} 行**（被剔除的 vendor / 生成物 ${o.内核手写层.被剔除的vendor行数} 行、${o.内核手写层.被剔除的vendor文件数} 个文件）。`, '');
  lines.push('| 扩展名 | 文件数 | 行数 |');
  lines.push('|--------|--------|------|');
  const order = ['.c', '.h', '.asm', '.s', '.moonbit', '.rs', '.ld', '.py', '.js', '.md', '.txt', '.toml', '.json'];
  for (const ext of order) {
    const v = o.内核手写层.按扩展名[ext];
    if (v) lines.push(`| \`${ext}\` | ${v.文件数} | ${v.行数} |`);
  }
  lines.push('');
  lines.push('### 被剔除项（逐文件，防「口径含糊」）', '');
  lines.push('| 文件 | 行数 |');
  lines.push('|------|------|');
  for (const k of Object.keys(o.内核手写层.剔除明细)) {
    lines.push(`| \`${esc(k)}\` | ${o.内核手写层.剔除明细[k]} |`);
  }
  lines.push('');

  lines.push('## 二、第三方与生成物边界（C-X3）', '');
  lines.push(`- \`vendor/\` 下文件数：${o.第三方与生成物.vendor目录}；顶层 \`node_modules\` 包数：${o.第三方与生成物.node_modules顶层包数}；`, '');
  lines.push(`- 生成物形态命中（\`*_gen.*\` / \`*_blob.h\` / \`*.min.js\`）：${o.第三方与生成物.生成物形态命中} 处 —— 全部**不得进登记材料**，\`npm run check:copyright\` 逐候选核验。`, '');
  lines.push('');

  lines.push('## 三、文档与治理体系规模（人提出的约束有多大）', '');
  lines.push('| 指标 | 实测 |');
  lines.push('|------|------|');
  lines.push(`| CI 检查器（\`scripts/ci/check-*.js\` / \`.py\`） | ${gov.CI检查器文件数} 个 |`);
  lines.push(`| 规则登记表条目 | ${gov.规则总数} 条，其中 ${gov.有执行器的规则数} 条有执行器、${gov.纯人工规则数} 条纯人工 |`);
  lines.push(`| 提示词库（\`.ai/hq/prompts/\`） | ${gov.提示词文件数} 篇 / ${gov.提示词分类数} 个分类 |`);
  for (const k of Object.keys(o.文档分轴md数).sort()) {
    lines.push(`| 文档轴 \`docs/${k}/\` | ${o.文档分轴md数[k]} 篇 md |`);
  }
  lines.push('');
  lines.push('> 这套治理体系是**约束 AI 自己的**：门成员资格从规则登记表派生（`[DESIGN-ARCH-111]`），'
    + '违规要写理由才能抑制（`// khy-allow-<规则ID>: <理由>`），P2 规则走只降不升的基线棘轮。'
    + 'AI 不会自发地给自己造一道会挡回自己提交的门——这套东西的存在本身就是「人提出了目标与约束」的证据。', '');
  lines.push('');
  lines.push('## 四、复算方式', '');
  lines.push('```bash', ...o.复算命令, ...gov.复算命令, '```', '');
  return lines.join('\n');
}

// ── 05_索引与对账/证据总清单.json ──────────────────────────────────────────
function buildManifest() {
  const items = [];
  (function scan(dir, depth) {
    if (depth > 5) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full, depth + 1);
      else if (e.isFile()) {
        const buf = fs.readFileSync(full);
        const rel = path.relative(EV, full).replace(/\\/g, '/');
        items.push({
          路径: rel,
          字节: buf.length,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          类型: /\.(png|jpg|jpeg|svg|gif)$/i.test(rel) ? '图片' : /\.(md|html)$/i.test(rel) ? '文档' : '数据',
          行数: (() => {
            let n = 0;
            for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
            return n;
          })(),
          PNG尺寸: (() => {
            if (!/\.png$/i.test(rel) || buf.length < 24) return null;
            const sig = buf.slice(0, 8).toString('hex');
            if (sig !== '89504e470d0a1a0a') return '非法PNG';
            return { 宽: buf.readUInt32BE(16), 高: buf.readUInt32BE(20) };
          })(),
        });
      }
    }
  })(EV, 0);
  items.sort((a, b) => a.路径.localeCompare(b.路径, 'zh-Hans-CN'));
  return {
    生成时间: new Date().toISOString(),
    生成器: 'scripts/evidence/build-index.js',
    说明: 'works/record/evidence/ 全量清单：路径 / 字节 / sha256 / 类型 / 行数 / PNG 宽高（PNG 由 IHDR 直接解析，可用来核验图片真实可解码）。',
    条目数: items.length,
    图片数: items.filter((i) => i.类型 === '图片').length,
    零字节条目: items.filter((i) => i.字节 === 0).map((i) => i.路径),
    条目: items,
  };
}

function main() {
  const m = load();
  const f = m.人类贡献度量.反馈存证;
  const bugs = m.人类贡献度量.台账.Bug条目原始.filter((b) => b && b.id).length;
  const o = m.原创性度量.内核手写层.剔除明细;
  const targets = [
    {
      路径: '01_人类贡献/人类指令语料.md',
      文本: buildHumanCorpus(m),
      // 非空核验按「输入条目数」逐项对账，不用凭空拍一个行数门槛
      检查: (t) => (t.match(/^\| \d+ \|/gm) || []).length >= Math.min(80, m.人类贡献度量.人类指令语料.用户引述句.条目.length),
      期望: '逐条引述表格的行数应覆盖输入条目',
    },
    {
      路径: '01_人类贡献/迭代与验收.md',
      文本: buildIteration(m),
      检查: (t) => (t.match(/^\| BUG-/gm) || []).length === bugs && (t.match(/^\| `.+\` \| \d+/gm) || []).length === Object.keys(f.逐存证类型计数).length,
      期望: `Bug 表 ${bugs} 行、存证类型表 ${Object.keys(f.逐存证类型计数).length} 行，逐条对齐输入`,
    },
    {
      路径: '02_独创性/原创代码规模.md',
      文本: buildOriginality(m),
      检查: (t) => (t.match(/^\| `[^`]+` \| \d+ \|$/gm) || []).length >= Object.keys(o).length,
      期望: `vendor 剔除明细 ${Object.keys(o).length} 行全部落地`,
    },
  ];
  for (const g of targets) {
    const out = path.join(EV, ...g.路径.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, g.文本.endsWith('\n') ? g.文本 : g.文本 + '\n', 'utf8');
    if (!g.检查(g.文本)) {
      process.stderr.write(`生成异常（对账不通过）: ${g.路径} —— ${g.期望}\n`);
      process.exitCode = 1;
    }
    process.stdout.write(`生成 ${g.路径} —— ${g.文本.split('\n').length} 行 / ${fs.statSync(out).size} 字节\n`);
  }

  const man = buildManifest();
  const manOut = path.join(EV, '05_索引与对账', '证据总清单.json');
  fs.mkdirSync(path.dirname(manOut), { recursive: true });
  fs.writeFileSync(manOut, JSON.stringify(man, null, 2) + '\n', 'utf8');
  process.stdout.write(`生成 05_索引与对账/证据总清单.json —— ${man.条目数} 个条目，图片 ${man.图片数} 张，零字节 ${man.零字节条目.length} 个\n`);
  if (man.零字节条目.length) {
    process.stderr.write('存在零字节证据文件（空文件不是证据）: ' + man.零字节条目.join(' ｜ ') + '\n');
    process.exitCode = 1;
  }
}

main();
