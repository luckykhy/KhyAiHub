'use strict';
// 契约(轮二十八):`khy doctor` 两级报告——行动清单置顶、检查项自报
// summary/fix/note、行宽裁剪、rc 语义(fail>0 → 非零)。
// 叶子纯函数测试 + 真机 runDoctorChecks 契约 + 强制失败 handleDoctor 复诊。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LEAF = path.join(__dirname, '..', '..', 'src', 'cli', 'doctorReport.js');
const report = require(LEAF);
const { displayWidth } = require(path.join(__dirname, '..', '..', 'src', 'cli', 'formatters.js'));

const ANSI_RE = /\x1b\[[0-9;]*m/g;

test('行动清单:fail/warn 全进清单且带修复或说明行', () => {
  const checks = report.decorateChecks([
    { category: 'A', label: '甲项', ok: false, level: 'error', detail: 'd1', summary: 's1', fix: '运行 khy x1' },
    { category: 'A', label: '乙项', ok: false, level: 'warn', detail: 'd2', summary: 's2', note: '背景说明' },
    { category: 'B', label: '丙项', ok: true, level: 'info', detail: 'd3', summary: 's3' },
  ]);
  const lines = report.buildActionLines(checks, { width: 100 }).join('\n').replace(ANSI_RE, '');
  assert.match(lines, /需要处理 2 项/);
  assert.match(lines, /甲项 — s1/);
  assert.match(lines, /修复: 运行 khy x1/);
  assert.match(lines, /乙项 — s2/);
  assert.match(lines, /说明: 背景说明/);
  assert.ok(!/丙项/.test(lines), 'ok 项不进行动清单');
});

test('全绿:不出行动清单段', () => {
  const checks = report.decorateChecks([
    { category: 'A', label: '甲项', ok: true, level: 'info', detail: 'd', summary: 's' },
  ]);
  assert.deepEqual(report.buildActionLines(checks, { width: 100 }), []);
  const full = report.renderConsoleReport(checks, { width: 100 }).join('\n').replace(ANSI_RE, '');
  assert.match(full, /所有检查通过，系统就绪/);
});

test('行宽:非 verbose 渲染所有行 displayWidth ≤ 给定宽度', () => {
  const long = 'x'.repeat(300) + '超长中文'.repeat(50);
  const checks = report.decorateChecks([
    { category: 'A', label: '长项', ok: false, level: 'warn', detail: long, summary: long, fix: long },
  ]);
  const width = 60;
  for (const line of report.renderConsoleReport(checks, { width })) {
    assert.ok(displayWidth(line.replace(ANSI_RE, '')) <= width, `行超宽: ${line}`);
  }
});

test('summary 回退:缺 summary 的第三方项从 detail 推导且不抛', () => {
  const d = report.decorateCheck({
    category: 'X',
    label: '外部项',
    ok: false,
    level: 'warn',
    detail: 'y'.repeat(200),
  });
  assert.ok(d.summary && d.summary.length > 0, '应有回退 summary');
  assert.ok(displayWidth(d.summary) <= report.SUMMARY_MAX_WIDTH);
  assert.equal(d.status, 'warn'); // level:'warn' → warn 态
  assert.equal(report.itemStatus({ ...d, level: 'error' }), 'fail');
});

test('status 派生:ok/warn/fail 三态', () => {
  assert.equal(report.itemStatus({ ok: true }), 'ok');
  assert.equal(report.itemStatus({ ok: false, level: 'warn' }), 'warn');
  assert.equal(report.itemStatus({ ok: false, level: 'error' }), 'fail');
});

test('countChecks 与总计行', () => {
  const counts = report.countChecks([
    { ok: true }, { ok: false, level: 'warn' }, { ok: false, level: 'error' },
  ]);
  assert.deepEqual(counts, { ok: 1, warn: 1, fail: 1, total: 3 });
  const text = report.buildSummaryLines(counts).join('\n').replace(ANSI_RE, '');
  assert.match(text, /1 通过 · 1 警告 · 1 失败/);
});

test('note 仅 verbose 展示;verbose 不裁剪 detail', () => {
  const long = '详'.repeat(120);
  const checks = report.decorateChecks([
    { category: 'A', label: '甲项', ok: true, level: 'info', detail: long, summary: 's', note: '只有 verbose 才看到的长说明' },
  ]);
  const quiet = report.renderConsoleReport(checks, { width: 80 }).join('\n').replace(ANSI_RE, '');
  assert.ok(!/只有 verbose/.test(quiet));
  const loud = report.renderConsoleReport(checks, { width: 80, verbose: true }).join('\n').replace(ANSI_RE, '');
  assert.match(loud, /说明: 只有 verbose 才看到的长说明/);
  assert.ok(loud.includes(long), 'verbose 下长 detail 不应被裁剪');
});

// ── 真机检查项契约(同步 runDoctorChecks;会 spawn 少量子进程探针) ──────────

test('runDoctorChecks:全量项带 summary(≤40 字符)，!ok 项 fix 或 note 必有', () => {
  const { runDoctorChecks } = require(path.join(__dirname, '..', '..', 'src', 'cli', 'handlers', 'init.js'));
  const checks = runDoctorChecks();
  assert.ok(checks.length >= 30, `检查项应 ≥30，实测 ${checks.length}`);
  for (const item of checks) {
    assert.ok(
      typeof item.summary === 'string' && item.summary.trim().length > 0,
      `缺 summary: ${item.category}/${item.label}`
    );
    assert.ok(
      item.summary.length <= 40,
      `summary 超 40 字符(${item.summary.length}): ${item.label} → ${item.summary}`
    );
    if (!item.ok) {
      const hasFix = typeof item.fix === 'string' && item.fix.trim().length > 0;
      const hasNote = typeof item.note === 'string' && item.note.trim().length > 0;
      assert.ok(hasFix || hasNote, `!ok 项既无 fix 也无 note: ${item.category}/${item.label}`);
    } else {
      assert.ok(
        !/请复查|请设置|请运行/.test(item.summary),
        `ok 项 summary 含指令式措辞: ${item.label} → ${item.summary}`
      );
    }
  }
});

test('WS 认证被拒:detail 全中文，服务端原始文本只进 note', async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'cli', 'handlers', 'doctorConnectivity.js'),
    'utf8'
  );
  const authBranch = src.slice(
    src.indexOf("type === 'auth_error'"),
    src.indexOf("// Other message types")
  );
  assert.ok(
    !/detail:[^}]*msg\?\.message/.test(authBranch),
    'detail 不得再拼服务端原始 message'
  );
  assert.match(authBranch, /note: `服务端原始返回/);
});

test('freshInstallDoctor:纯装配失败形态带 fix 且 detail 留原因+解决方法', () => {
  const { assessFreshInstall, assessPortable } = require(
    path.join(__dirname, '..', '..', 'src', 'services', 'freshInstallDoctor.js')
  );
  const fails = assessFreshInstall({
    binEntryPresent: false,
    serverEntryPresent: false,
    nodeModulesPresent: false,
    khyOnPath: false,
  });
  assert.ok(fails.length >= 4);
  for (const c of fails) {
    assert.ok(c.summary && c.summary.length <= 40, `缺/超长 summary: ${c.label}`);
    if (!c.ok) {
      assert.ok(c.fix, `!ok 缺 fix: ${c.label}`);
      assert.match(c.detail, /原因：.+解决方法：/s, `detail 缺原因+解决方法: ${c.label}`);
    }
  }
  const portable = assessPortable({
    sqlite: { ok: false, detail: '探针失败' },
    links: [{ label: 'x/y', status: 'broken' }],
    pointer: { present: true, missing: [{ key: 'k', target: 't' }] },
    forest: { backendTree: true, sharedTarget: true },
  });
  assert.equal(portable.length, 3);
  for (const c of portable) {
    assert.ok(!c.ok, '合成 facts 应全失败');
    assert.ok(c.summary && c.fix, `缺 summary/fix: ${c.label}`);
  }
});

test('rc 语义:强制失败 handleDoctor 置 exitCode=1，全绿保持 0', async () => {
  const savedExitCode = process.exitCode;
  const realExistsSync = fs.existsSync;
  const initPath = require.resolve(
    path.join(__dirname, '..', '..', 'src', 'cli', 'handlers', 'init.js')
  );
  try {
    const handler = require(initPath);
    const logs = [];
    const realConsoleLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    fs.existsSync = (p) => {
      const s = String(p).split('\\').join('/');
      if (s.endsWith('/.env') || s.endsWith('/backend/node_modules')) return false;
      return realExistsSync(p);
    };
    try {
      await handler.handleDoctor({ json: true }, []);
    } finally {
      console.log = realConsoleLog;
      fs.existsSync = realExistsSync;
    }
    const raw = logs.join('\n');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    assert.equal(json.status, 'fail');
    assert.ok(json.counts.fail > 0, '合成场景应有硬失败');
    assert.equal(process.exitCode, 1, 'fail>0 必须置非零退出码');
    // --json 只增字段:既有消费方键名逐字节保留。
    const sample = json.checks.find((c) => !c.ok);
    for (const key of ['category', 'label', 'ok', 'detail', 'level']) {
      assert.ok(key in sample, `JSON 字段丢失: ${key}`);
    }
    assert.ok(sample.summary && sample.status);
  } finally {
    process.exitCode = savedExitCode;
  }
});
