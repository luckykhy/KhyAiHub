'use strict';

/**
 * hqReviewGate.test.js — `review -> done` 完成裁决门 + `todo -> doing` 边界锁的行为锁。
 *
 * 关联设计：`works/record/ai/hq/PROGRESS.json` 的 `review_done_rule` 段；机制说明见
 * `hqStore.js` 的「验收清算」与 `scope_guard` 两节。
 *
 * 2026-11-04 起，门读的不是 `acceptance.md` 里手写的 PASS，而是
 * `criteria[]` → 系统执行 → `acceptance.jsonl` 运行记录 → 四值裁决
 * （`acceptanceVerdict.js`）。所以本文件的「好数据」夹具是**结构化判据 + 运行记录**，
 * 不再是一份全勾的清算文件 —— 后者现在属于 legacy，最多判 partial。
 *
 * ⚠ **必须是 node:test 而不是 jest**：`services/backend/package.json` 里
 * `test:all = npm test && npm run test:node` —— 两套 runner 都扫全部 `*.test.js`，
 * jest 风格文件在 `test:node` 下 `jest is not defined` 落地即红；而
 * `jest.config.js:25` 会按 `require('node:test')` 标记把本文件从 jest 侧排除。
 * 这是本仓两套 runner 并存下的硬约定，勿改成 `describe/test`。
 *
 * ## 结构取舍（为什么只留 5 个 E2E spawn）
 *
 * 实测本机 `node bin/khy.js hq states` 冷启 **12~16s**（仓库体量所致，与被测
 * 逻辑无关）。若每个场景都 spawn，整文件要 4 分钟以上 —— 慢测试会被跳过，
 * 跳过的测试等于没有。所以：
 *   - **全矩阵**（9 个场景）走 `H.reviewDoneBlockers()` 纯逻辑直调 ——
 *     毫秒级，且测的就是门实际调用的那个函数；
 *   - **E2E 只留 5 个 spawn**，各证明一件纯逻辑证明不了的事：
 *     接线真实存在（拒绝非零退出码 + 状态不变 / 放行真的落盘 done /
 *     未填模板过不了门）。
 *   判据逻辑本身的回归锁在 `tests/cli/acceptanceVerdict.test.js`。
 *
 * ## 为什么这个文件存在
 *
 * 2026-09-23 取证：`review -> done` 长期是**裸箭头**（无前置条件），`T-023`（P1）
 * 卡 review 3 天；`.khy/feedback/` 52 个存证目录零个被引用；3 条 `pending_verify`
 * Bug 的 notes 为 0。本文件同时执行**反向验证**（`[DESIGN-DELIV-001]` §1.2 的教训
 * —— 本仓出过「打印 7 PASS 但恒返回 0」的记分板）：坏数据必须真的被拒（非零退出码），
 * 好数据必须真的被放行 —— 缺后者无法区分「真判据」与「一律拒绝的 stub」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const H = require('../../src/cli/hqStore');
const V = require('../../src/cli/acceptanceVerdict');
const R = require('../../src/cli/acceptanceRunner');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'khy.js');
// tests/cli → tests → backend → node → runtime → <repo>：五级
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
// HQ 状态真源 2026-09-17 从 `.ai/hq/` 迁到 `works/record/ai/hq/`，这里跟着走。
const REAL_HQ = path.join(REPO, 'works', 'record', 'ai', 'hq');

// ── 夹具 ─────────────────────────────────────────────────────────

/** 5 条判据的任务（形状对齐真实 T-023，但内容自足，不依赖真实数据）。 */
const TASK5 = () => ({
  id: 'T-999',
  status: 'review',
  acceptance: '1) 甲：npx jest 全绿；2) 乙：接口契约不变；3) 丙：新文件 eslint 零告警；4) 丁：行数 ≤800；5) 戊：文档同步',
  evidence: 'T-999-fixture',
});

/** 新契约的形状：5 条可执行判据。 */
const STRUCT5 = (overrides) => Object.assign({
  id: 'T-999',
  status: 'review',
  evidence: 'T-999-fixture',
  criteria: [1, 2, 3, 4, 5].map((n) => ({
    id: `C${n}`,
    desc: `判据 ${n}`,
    check: { kind: 'cmd', cmd: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
    paths: [],
  })),
}, overrides);

/**
 * 按任务判据造运行记录并落盘（与 `khy hq accept --run` 同源写入）。
 * mutate 返回假值即丢弃该条记录（模拟「这条没跑」）。
 */
function writeRecords(fbRoot, name, task, mutate) {
  const dir = mkEvidence(fbRoot, name, {});
  const now = Date.now();
  const head = R.currentHead(REPO);
  for (const raw of task.criteria) {
    const c = V.normalizeCriterion(raw, 0);
    let rec = {
      id: c.id,
      kind: c.kind,
      checkHash: V.checkHash(c),
      at: new Date(now).toISOString(),
      atMs: now,
      head,
      dirtyCount: 0,
      paths: c.paths,
      pathsFingerprint: null,
      result: 'pass',
      reason: '',
      exit: 0,
      timedOut: false,
      durationMs: 1,
      stdoutTail: '',
      stderrTail: '',
      source: 'system',
    };
    if (mutate) {
      rec = mutate(rec, c);
    }
    if (rec) {
      R.appendRunRecord(dir, rec);
    }
  }
  return dir;
}

/** 独立临时目录（每用例新建，绝不碰真实 `.khy/feedback/`）。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hq-gate-'));
}

/** 合格的 N 条清算。breaks[i] 注入指定坏形态。 */
function goodLedger(n, breaks = {}) {
  let s = '# 验收清算\n\n';
  for (let i = 1; i <= n; i += 1) {
    const bad = breaks[i];
    if (bad === 'skip-no-reason') {
      s += `## ${i}) 判据 ${i}\n- 结果: SKIP\n\n`;
    } else if (bad === 'pass-no-evidence') {
      s += `## ${i}) 判据 ${i}\n- 结果: PASS\n\n`;
    } else if (bad === 'fail') {
      s += `## ${i}) 判据 ${i}\n- 结果: FAIL\n- 证据: 实测未通过\n\n`;
    } else {
      s += `## ${i}) 判据 ${i}\n- 结果: PASS\n- 证据: 实测通过\n\n`;
    }
  }
  return s;
}

function mkEvidence(fbRoot, name, files) {
  const dir = path.join(fbRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, f), text, 'utf8');
  }
  return dir;
}

// ── 纯逻辑：acceptance 分句 ───────────────────────────────────────

test('splitAcceptance 认中文分号与 1) 2) 编号两种分句', () => {
  assert.deepStrictEqual(H.splitAcceptance('甲；乙；丙'), ['甲', '乙', '丙']);
  assert.deepStrictEqual(H.splitAcceptance('1) 甲；2) 乙；3) 丙'), ['甲', '乙', '丙']);
});

test('splitAcceptance 单句不裂；空输入返回空数组', () => {
  assert.deepStrictEqual(H.splitAcceptance('只有一条判据'), ['只有一条判据']);
  assert.deepStrictEqual(H.splitAcceptance(''), []);
  assert.deepStrictEqual(H.splitAcceptance(null), []);
});

test('splitAcceptance 括号内分号不切（T-024 实测回归锁：括号补充说明是本仓书写惯例）', () => {
  assert.deepStrictEqual(
    H.splitAcceptance('1) 甲（node:test；含矩阵）；2) 乙（a；b）'),
    ['甲（node:test；含矩阵）', '乙（a；b）']
  );
  assert.deepStrictEqual(H.splitAcceptance('甲（略）；乙'), ['甲（略）', '乙']);
});

// ── 纯逻辑：清算解析 ─────────────────────────────────────────────

test('parseAcceptanceLedger 合格样本零 error', () => {
  const { errors, verdicts } = H.parseAcceptanceLedger(goodLedger(3));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.result === 'PASS'));
});

test('parseAcceptanceLedger 抓 SKIP 无理由 / PASS 无证据 / FAIL / 无段落 / 取值非法 / 空文件', () => {
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: SKIP').errors.some((e) => /理由/.test(e)));
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: PASS').errors.some((e) => /证据/.test(e)));
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: FAIL\n- 证据: 挂了').errors.some((e) => /FAIL/.test(e)));
  assert.ok(H.parseAcceptanceLedger('随便写点什么').errors.some((e) => /##/.test(e)));
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: 大概行吧').errors.some((e) => /非法/.test(e)));
  assert.ok(H.parseAcceptanceLedger('').errors.some((e) => /空/.test(e)));
});

// ── 纯逻辑：reviewDoneBlockers 全矩阵（门实际调用的函数）─────────

test('矩阵 A：缺 evidence 字段 → 阻断', () => {
  const { blockers } = H.reviewDoneBlockers({ ...TASK5(), evidence: undefined }, REPO);
  assert.ok(blockers.some((b) => /缺 evidence/.test(b)), JSON.stringify(blockers));
});

test('矩阵 A2：evidence 名称非法 → 阻断', () => {
  const { blockers } = H.reviewDoneBlockers({ ...TASK5(), evidence: 'a b/c' }, REPO);
  assert.ok(blockers.some((b) => /名称非法/.test(b)), JSON.stringify(blockers));
});

test('矩阵 B：evidence 目录不存在 → 阻断', () => {
  const fb = tmpDir();
  try {
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /目录不存在/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 C：evidence 目录为空 → 阻断', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', {});
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /目录为空/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 D：只有散文、无可执行判据 → 阻断（acceptance.md 不再是真相）', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', { 'acceptance.md': goodLedger(5) });
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /legacy-markdown-acceptance/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 E/F/G：FAIL / SKIP 缺理由 / 人工项缺签名 → 都阻断', () => {
  const fb = tmpDir();
  try {
    const failTask = STRUCT5();
    writeRecords(fb, 'T-999-fixture', failTask, (rec) =>
      (rec.id === 'C2' ? Object.assign({}, rec, { result: 'fail', reason: 'exit=1（期望 0）' }) : rec)
    );
    const fail = H.reviewDoneBlockers(failTask, REPO, fb);
    assert.ok(fail.blockers.some((b) => /C2.*FAIL/.test(b)), JSON.stringify(fail.blockers));

    fs.rmSync(path.join(fb, 'T-999-fixture'), { recursive: true, force: true });
    const manualTask = STRUCT5({
      criteria: [{ id: 'C1', desc: '手测界面', check: { kind: 'manual' } }],
    });
    writeRecords(fb, 'T-999-fixture', manualTask, (rec) =>
      Object.assign({}, rec, { kind: 'manual', result: 'skip', signedBy: '孔浩原', note: '' })
    );
    const skip = H.reviewDoneBlockers(manualTask, REPO, fb);
    assert.ok(skip.blockers.some((b) => /C1.*SKIP/.test(b)), JSON.stringify(skip.blockers));

    fs.rmSync(path.join(fb, 'T-999-fixture'), { recursive: true, force: true });
    writeRecords(fb, 'T-999-fixture', manualTask, (rec) =>
      Object.assign({}, rec, { kind: 'manual', result: 'pass', signedBy: '' })
    );
    const unsigned = H.reviewDoneBlockers(manualTask, REPO, fb);
    assert.ok(unsigned.blockers.some((b) => /缺签名/.test(b)), JSON.stringify(unsigned.blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 H：只跑了部分判据（其余无运行记录）→ 阻断', () => {
  const fb = tmpDir();
  try {
    const task = STRUCT5();
    writeRecords(fb, 'T-999-fixture', task, (rec) => (rec.id === 'C1' || rec.id === 'C2' ? rec : null));
    const { blockers } = H.reviewDoneBlockers(task, REPO, fb);
    assert.ok(blockers.some((b) => /C3.*没有运行记录/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 I：全条判据都有通过记录 → 零阻断（防「一律拒绝的 stub」）', () => {
  const fb = tmpDir();
  try {
    const task = STRUCT5();
    writeRecords(fb, 'T-999-fixture', task);
    const { blockers, verdicts, verdict } = H.reviewDoneBlockers(task, REPO, fb);
    assert.deepStrictEqual(blockers, [], JSON.stringify(blockers));
    assert.strictEqual(verdicts.length, 5);
    assert.strictEqual(verdict, 'done');
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 附：路径失效只 warning 不阻断（防误报率失控）', () => {
  const fb = tmpDir();
  try {
    // 可执行判据全过，但散文里引用了不存在的路径
    const t = STRUCT5({ acceptance: '按 _meta/SPLIT-PLAN.md 执行；界面好看；用户满意' });
    writeRecords(fb, 'T-999-fixture', t);
    const { blockers, warnings } = H.reviewDoneBlockers(t, REPO, fb);
    assert.deepStrictEqual(blockers, [], '形式问题不得阻断');
    assert.ok(warnings.some((w) => /SPLIT-PLAN/.test(w)), JSON.stringify(warnings));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 附2：legacy 任务的散文质量审计仍只 warning，阻断来自「没有可执行判据」', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', { 'acceptance.md': goodLedger(3) });
    const { blockers, warnings } = H.reviewDoneBlockers(
      { ...TASK5(), acceptance: '界面好看；用户满意' },
      REPO,
      fb
    );
    assert.ok(warnings.some((w) => /无.*命令|数字/.test(w)), JSON.stringify(warnings));
    assert.ok(blockers.every((b) => /legacy-markdown-acceptance/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

// ── 纯逻辑：validateTask 新字段（出现即校验，存量不追溯）──────────

const base = { id: 'T-998', domain: 'cli', type: 'feature', priority: 'P1', status: 'todo' };

test('validateTask 放过不带新字段的存量条目；校验 evidence/baseline_metrics/scope_guard 形状', () => {
  assert.deepStrictEqual(H.validateTask({ ...base }), []);
  assert.ok(H.validateTask({ ...base, evidence: '   ' }).length);
  assert.ok(H.validateTask({ ...base, evidence: 'a b/c' }).length);
  assert.deepStrictEqual(H.validateTask({ ...base, evidence: 'T-998-slug' }), []);
  assert.ok(H.validateTask({ ...base, baseline_metrics: { jest_suites: '1231' } }).length);
  assert.deepStrictEqual(H.validateTask({ ...base, baseline_metrics: { jest_suites: 1231 } }), []);
  assert.ok(H.validateTask({ ...base, scope_guard: [] }).length);
  assert.ok(H.validateTask({ ...base, scope_guard: '不改 gateway' }).length);
  assert.deepStrictEqual(H.validateTask({ ...base, scope_guard: ['不改 gateway'] }), []);
});

// ── 纯逻辑：scope_guard 前缀抽取与越界判定 ───────────────────────

test('scopeGuardPrefixes 抽路径前缀；语义约束归人工；盘符剔除', () => {
  const { prefixes, manual } = H.scopeGuardPrefixes([
    '不改 services/backend 以外',
    '不动 keyStore 的对外契约',
    '绝不碰 D:/Portable 之外的盘',
  ]);
  assert.ok(prefixes.includes('services/backend'), JSON.stringify(prefixes));
  assert.ok(!prefixes.some((p) => /^D:/.test(p)), '盘符路径不得进前缀');
  assert.ok(manual.includes('不动 keyStore 的对外契约'), JSON.stringify(manual));
});

test('scopeViolations 判定边界之外的文件', () => {
  const sg = ['只改 services/backend 与 apps/ai-frontend'];
  const { outside } = H.scopeViolations(sg, [
    'services/backend/src/cli/hqStore.js',
    'apps/ai-frontend/src/views/Layout.vue',
    'kernel/foo.c',
  ]);
  assert.deepStrictEqual(outside, ['kernel/foo.c']);
});

// ── 端到端：接线证明（5 个 spawn，每个 ~13s）─────────────────────

/**
 * 真跑一次 CLI。
 *
 * ⚠ stdio 必须落**文件**而不是管道（2026-09-23 实测教训）：spawnSync 的管道版
 * 会等到「所有持有写端的后代进程都退出」才返回 —— 而 khy.js 启动时会拉起
 * 后台辅助进程（gateway warmup 等），其存活时间不可控（实测一次 988s，
 * 远超 120s 的 kill 超时：kill 只杀直接子进程，管道被孙进程攥着导致
 * spawnSync 迟迟不返回，r.status=null）。stdio 重定向到文件后，
 * 直接子进程一退出 spawnSync 即返回，后代进程攥着的文件句柄与我们无关。
 *
 * 同时显式关掉三类启动期后台行为（warmup / 更新检查 / 自动安装），
 * 让被测时间只含被测逻辑。
 */
function runCli(args, extraEnv, sandboxDir) {
  const outFile = path.join(
    sandboxDir,
    `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: Object.assign({}, process.env, extraEnv, {
        KHY_GATEWAY_WARMUP_ON_BOOT: '0',
        KHY_STARTUP_UPDATE_CHECK: '0',
        KHY_AUTO_UPDATE: '0',
      }),
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 120000,
    });
    return { code: r.status, signal: r.signal, output: fs.readFileSync(outFile, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** 建独立沙箱（真实 `.ai/hq/` 拷贝 + 空反馈目录），返回 env 覆盖。 */
function newSandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hq-gate-e2e-'));
  const hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  for (const f of ['BUGS.json', 'PROGRESS.json', 'ROADMAP.md', 'MODELS.json']) {
    fs.copyFileSync(path.join(REAL_HQ, f), path.join(hq, f));
  }
  fs.cpSync(path.join(REAL_HQ, 'prompts'), path.join(hq, 'prompts'), { recursive: true });
  const fb = path.join(root, 'feedback');
  fs.mkdirSync(fb, { recursive: true });
  return { root, hq, fb, env: { KHY_HQ_DIR: hq, KHY_FEEDBACK_DIR: fb } };
}

function sandboxStatus(env, id) {
  const d = JSON.parse(fs.readFileSync(path.join(env.hq, 'PROGRESS.json'), 'utf8'));
  const t = (d.tasks || []).find((x) => x.id === id);
  return t ? t.status : null;
}

test('E2E 缺 evidence → 非零退出码且状态不变（接线真实存在的证明）', () => {
  const env = newSandboxEnv();
  try {
    // 真实盘上的 T-023 早已 done —— 先摆成 review 且抹掉 evidence，才测得到这条分支
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    delete t.evidence;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `应被拒但退出码 ${r.code}；输出：\n${r.output}`);
    assert.strictEqual(sandboxStatus(env, 'T-023'), 'review', '被拒时状态必须不变');
    assert.ok(r.output.includes('缺 evidence'), r.output);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E 存在 FAIL 的运行记录 → 拒（记录内容真的被读，不是只查目录存在）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    t.evidence = 'T-023-e2e';
    t.criteria = STRUCT5().criteria.slice(0, 2);
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
    writeRecords(env.fb, 'T-023-e2e', t, (rec) =>
      (rec.id === 'C2' ? Object.assign({}, rec, { result: 'fail', reason: 'exit=1（期望 0）' }) : rec)
    );

    const r = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `应被拒；输出：\n${r.output}`);
    assert.ok(r.output.includes('FAIL'), r.output);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E 全部判据通过 → 放行落盘 done 且裁决入账（防「一律拒绝的 stub」）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    t.evidence = 'T-023-e2e';
    t.criteria = STRUCT5().criteria;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
    writeRecords(env.fb, 'T-023-e2e', t);

    const r = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.strictEqual(r.code, 0, `应放行；输出：\n${r.output}`);
    assert.strictEqual(sandboxStatus(env, 'T-023'), 'done', '放行后应为 done');

    const d2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t2 = d2.tasks.find((x) => x.id === 'T-023');
    assert.ok(t2.acceptance_audit, '放行后应写入 acceptance_audit');
    assert.strictEqual(t2.acceptance_audit.verdict, 'done');
    assert.strictEqual(t2.acceptance_audit.total, 5);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ── close：done 存证裁决必须复算（2026-11-05 补）─────────────────
//
// `khy hq close` 曾对带 `acceptance_audit.verdict` 的 done 任务直接采信账本里那句
// 字符串，连它自己注释里承诺的 checkHash / 路径漂移校验一起跳过。账本是可手改的
// JSON，「项目面绿色」于是能脱离运行记录存在。修法是只报不改裁决：仍是 done，
// 但漂移必须留痕，且不能混进 blockers（否则从 warning 变成拦截）。

test('E2E close 复算 done 的存证裁决：证据漂移只报不改裁决', () => {
  const env = newSandboxEnv();
  try {
    const t = STRUCT5({ id: 'T-DRIFT', status: 'done', evidence: 'T-DRIFT-e2e' });
    // 新版门写入的形状（handlers/hq.js 的 acceptance_audit）：声称 5 条判据全过
    t.acceptance_audit = {
      at: '2026-11-05',
      verdict: 'done',
      source: 'criteria',
      counts: { total: 5, required: 5, passed: 5, failed: 0, unresolved: 0 },
      total: 5,
      verdicts: t.criteria.map((c) => `pass:${c.desc}`),
    };
    // 留一条 todo 让项目面落在 partial —— 退出码由它决定，与漂移无关
    fs.writeFileSync(
      path.join(env.hq, 'PROGRESS.json'),
      JSON.stringify({ tasks: [t, { id: 'T-OPEN', status: 'todo' }] }, null, 2) + '\n',
      'utf8'
    );
    // 运行记录与存证矛盾：C1 已 FAIL —— 当下复算不可能是 done
    writeRecords(env.fb, 'T-DRIFT-e2e', t, (rec) =>
      (rec.id === 'C1' ? Object.assign({}, rec, { result: 'fail', reason: 'exit=1（期望 0）' }) : rec)
    );

    const reports = path.join(env.root, 'reports');
    const r = runCli(
      ['hq', 'close', '--json'],
      Object.assign({ KHY_REPORTS_DIR: reports }, env.env),
      env.root
    );
    assert.strictEqual(r.code, 0, `漂移只报不拦；输出：\n${r.output}`);

    const rep = JSON.parse(fs.readFileSync(path.join(reports, 'PROJECT-STATUS.json'), 'utf8'));
    const row = rep.tasks.find((x) => x.id === 'T-DRIFT');
    assert.strictEqual(row.verdict, 'done', '存证裁决不因漂移被推翻');
    assert.ok(Array.isArray(rep.drifts) && rep.drifts.length === 1, JSON.stringify(rep.drifts));
    assert.ok(rep.drifts[0].includes('当下复算 failed'), rep.drifts[0]);
    assert.ok(!rep.blockers.some((b) => String(b).includes('存证裁决')), JSON.stringify(rep.blockers));
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ── close：存量 audit 块缺 verdict 必须报漂移，legacy 阻断必须进报告（2026-11-06 补）──
//
// 存量 4 个 acceptance_audit 块（T-023/T-024/T-029/T-030）是门改形状前的手写形态：
// 只有 at/total/verdicts，没有 verdict。漂移分支曾要求 verdict 才进，这条安全网于是
// 对最需要它的 done 任务整段静默；blockers 通道又只收 failed，recomputed 给 legacy 的
// partial + 「机器无法复算」总阻断被一并丢弃 —— 报告 drifts/blockers 双空。

test('E2E close 对缺 verdict 的存量 audit 块报漂移，legacy 阻断不再被丢弃', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 存量形态：done + 散文 acceptance + 手写 audit 块（无 verdict）
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'done';
    delete t.criteria;
    t.acceptance_audit = { at: '2026-09-23', total: 5, verdicts: ['PASS:1) 甲'] };
    fs.writeFileSync(p, JSON.stringify({ tasks: [t] }, null, 2) + '\n', 'utf8');

    const reports = path.join(env.root, 'reports');
    const r = runCli(['hq', 'close', '--json'], Object.assign({ KHY_REPORTS_DIR: reports }, env.env), env.root);
    assert.strictEqual(r.code, 0, `只报不拦；输出：\n${r.output}`);

    const rep = JSON.parse(fs.readFileSync(path.join(reports, 'PROJECT-STATUS.json'), 'utf8'));
    const row = rep.tasks.find((x) => x.id === 'T-023');
    assert.strictEqual(row.verdict, 'partial', '缺 verdict 时行裁决落回复算值');
    assert.ok(rep.drifts.some((x) => /T-023.*缺 verdict/.test(x)), JSON.stringify(rep.drifts));
    assert.ok(
      rep.blockers.some((b) => /T-023.*legacy-markdown-acceptance/.test(b)),
      `legacy 总阻断必须进 close 报告；实际：${JSON.stringify(rep.blockers)}`
    );
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ── verify：done 的完成态必须可复算（2026-11-06 补，2026-11-07 补处分流）──────
//
// done 在迁移表里没有出边，验收门只在 `review -> done` 那一刻跑过一次。存量 9 条
// done 早于当前 `acceptance_audit` 形状（无 verdict、无 `acceptance.jsonl`、散文
// 判据还指向已搬走的路径），今天复算一条也回不到 done，而它们**永远不会再被门
// 复检**。`khy hq verify` 此前对此一言不发 —— 「账本体检全绿」与「done 不可复算」
// 可以同时成立。修法是 verify 增开 done 复算段：只 warning 不 error（补跑要人签名
// `--by`，AI 代签就是伪造验收）。
//
// 2026-11-07 第二轮：处方按裁决来源分流。存量 9 条的 acceptance 散文里零反引号命令
// （实测 9/9），脚手架只能拆出 manual 判据，照「--scaffold 再 --run」做到底也是
// 0 条记录、裁决仍 partial，只把 1 条 legacy 阻断摊成 N 条「未验证」。所以 legacy
// 分支必须写明「要人签名」，structured 分支才给 `--run`。

test('E2E verify 报出不可复算的 done，放行可复算的那条', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    // T-023 保持存量形态：散文 acceptance、无 criteria[]、存证目录里只有人手写的 md
    const legacy = d.tasks.find((x) => x.id === 'T-023');
    mkEvidence(env.fb, legacy.evidence, { 'acceptance.md': '# 手写清算\n' });
    // T-030 摆成过了门的形态：结构化判据 + 系统写下的运行记录
    const gated = d.tasks.find((x) => x.id === 'T-030');
    gated.criteria = STRUCT5({ id: gated.id }).criteria;
    writeRecords(env.fb, gated.evidence, gated);
    // T-029 摆成「有判据、没记录」：结构化但缺运行记录，处方应当只要 --run、不要人签名
    const noRun = d.tasks.find((x) => x.id === 'T-029');
    noRun.criteria = STRUCT5({ id: noRun.id }).criteria;
    // T-007 摆成「连完成定义都没有」：无 criteria[] 也无 acceptance → source=none
    const none = d.tasks.find((x) => x.id === 'T-007');
    delete none.criteria;
    delete none.acceptance;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r = runCli(['hq', 'verify', '--json'], env.env, env.root);
    // 退出码由 ROADMAP 不同步等既有 error 决定，与本条无关；只断言告警内容
    const rep = JSON.parse(r.output);
    const legacyHit = rep.warnings.find((w) => w.startsWith('T-023 ') && /不可复算/.test(w));
    assert.ok(legacyHit, `应报出 T-023 不可复算；实际告警：\n${r.output}`);
    assert.ok(legacyHit.includes('0/5'), legacyHit);
    assert.ok(legacyHit.includes('khy hq accept T-023 --scaffold'), legacyHit);
    assert.ok(legacyHit.includes('khy hq accept T-023 --run'), legacyHit);
    // 散文无反引号命令 → 只能拆出人工判据 → 处方必须点明要人签名
    assert.ok(legacyHit.includes('--manual'), legacyHit);
    assert.ok(legacyHit.includes('--by <签名人>'), legacyHit);

    const noRunHit = rep.warnings.find((w) => w.startsWith('T-029 ') && /不可复算/.test(w));
    assert.ok(noRunHit, `应报出 T-029 不可复算；实际告警：\n${r.output}`);
    assert.ok(noRunHit.includes('khy hq accept T-029 --run'), noRunHit);
    assert.ok(!noRunHit.includes('--by'), `有判据只缺记录不该要人签名：${noRunHit}`);

    const noneHit = rep.warnings.find((w) => w.startsWith('T-007 ') && /不可复算/.test(w));
    assert.ok(noneHit, `应报出 T-007 不可复算；实际告警：\n${r.output}`);
    assert.ok(noneHit.includes('没有完成定义'), noneHit);
    assert.ok(noneHit.includes('khy hq accept T-007 --scaffold'), noneHit);
    assert.ok(!noneHit.includes('--by'), `连定义都没有，谈不上签名：${noneHit}`);

    assert.ok(
      !rep.warnings.some((w) => w.startsWith('T-030 ') && /不可复算/.test(w)),
      `过了门的 done 不该被报；实际告警：\n${r.output}`
    );
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E accept 生成的未填模板必须过不了门（防「生成即完成」的形式主义）', () => {
  const env = newSandboxEnv();
  try {
    const r1 = runCli(['hq', 'accept', 'T-023', '--evidence', 'T-023-tpl'], env.env, env.root);
    assert.strictEqual(r1.code, 0, r1.output);
    const ledger = path.join(env.fb, 'T-023-tpl', 'acceptance.md');
    assert.ok(fs.existsSync(ledger), '应生成 acceptance.md');

    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    t.evidence = 'T-023-tpl';
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r2 = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.notStrictEqual(r2.code, 0, '未填的模板必须被拒');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E accept 不覆盖已存在的清算文件', () => {
  const env = newSandboxEnv();
  try {
    mkEvidence(env.fb, 'T-023-keep', { 'acceptance.md': '我手写的，别动\n' });
    const r = runCli(['hq', 'accept', 'T-023', '--evidence', 'T-023-keep'], env.env, env.root);
    assert.strictEqual(r.code, 0, r.output);
    const text = fs.readFileSync(path.join(env.fb, 'T-023-keep', 'acceptance.md'), 'utf8');
    assert.strictEqual(text, '我手写的，别动\n', '已存在时不得覆盖');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ── 纯逻辑：acceptance 路径失效检测（含中文前缀回归锁）────────────

test('auditAcceptancePaths 抓不存在路径、放过真实路径、不被中文前缀污染', () => {
  const bad = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '按 _meta/SPLIT-PLAN.md 执行' },
    REPO
  );
  assert.strictEqual(bad.length, 1, JSON.stringify(bad));

  const ok = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '改 runtime/node/backend/src/cli/hqStore.js' },
    REPO
  );
  assert.deepStrictEqual(ok, []);

  // 曾把「终点：services/…」的中文前缀吞进路径 → 真实文件被误报（2026-09-23 修复）
  const cn = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '4) 终点：runtime/node/backend/src/cli/hqStore.js ≤800 行' },
    REPO
  );
  assert.deepStrictEqual(cn, [], JSON.stringify(cn));
});

// ── 纯逻辑：布局迁移后的三类路径写法（2026-11-06 断点）──────────────
//
// 2026-10 布局迁移（services/backend → runtime/node/backend）后，只按仓库根
// 解析把 14 条 finding 里的 13 条指向了确实存在的文件。三类合法写法都必须
// 放过：子项目 cwd 相对（prose 形式）、迁移前旧根前缀、显式 (cwd: ...) 声明。

test('auditAcceptancePaths 按声明 cwd / 旧布局根二次解析，真阳性不放过', () => {
  // prose 声明：「（runtime/node/backend 下运行）」+ 子项目相对路径
  const subRel = H.auditAcceptancePaths(
    {
      id: 'T-998',
      acceptance:
        'node --test tests/services/opencodeFreeChannels.test.js 18/18 通过（runtime/node/backend 下运行）',
    },
    REPO
  );
  assert.deepStrictEqual(subRel, [], JSON.stringify(subRel));

  // 迁移前旧根前缀：services/backend/... → runtime/node/backend/...
  const legacy = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '4) 终点：services/backend/src/cli/replSession.js ≤800 行' },
    REPO
  );
  assert.deepStrictEqual(legacy, [], JSON.stringify(legacy));

  // 显式机读声明：路径只在被声明的 cwd 下存在（仓库根无 hq/ 目录）
  const declared = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '核对 hq/ROADMAP.md 的状态行 (cwd: works/record/ai)' },
    REPO
  );
  assert.deepStrictEqual(declared, [], JSON.stringify(declared));

  // 真阳性仍须报：.ai/MAP.md 确系改名，仓内另有两个同名文件但都不在仓库根，
  // 按旧行为给「疑似改名」线索而不是静默放过。
  const renamed = H.auditAcceptancePaths(
    { id: 'T-004', acceptance: '.ai/MAP.md 目录树与仓库现状一致' },
    REPO
  );
  assert.strictEqual(renamed.length, 1, JSON.stringify(renamed));
  assert.ok(/works\/record\/ai\/MAP\.md/.test(renamed[0]), renamed[0]);

  // 真缺失仍须报
  const gone = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '改 services/backend/src/nope/notHere.js' },
    REPO
  );
  assert.strictEqual(gone.length, 1, JSON.stringify(gone));
});

// ── 纯逻辑：done 任务的验收路径失效必须升为 error ──────────────────
//
// 2026-11-06 断点：`review -> done` 的门只在翻转瞬间跑一次，通过后没有任何
// 门禁级事后复核。实测 T-024（done）自称判据 4「auditAcceptancePaths 全量 0
// 告警」，而同一次 verify 报出 14 条 acceptance 路径 warning —— 泛化 warning
// 分不出「这条 finding 属于一条已 done 的任务」，error 与 warning 各自独立
// 呈现，矛盾每次跑都复现，却没有 finding 把它点名。

/** 最小 HQ 夹具：validateDataset(root) 的 repoRoot = root 上两级，故真实文件放 root 下。 */
function minimalHq(root, tasks) {
  const hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  fs.cpSync(path.join(REAL_HQ, 'prompts'), path.join(hq, 'prompts'), { recursive: true });
  fs.copyFileSync(path.join(REAL_HQ, 'MODELS.json'), path.join(hq, 'MODELS.json'));
  fs.writeFileSync(path.join(hq, 'BUGS.json'), JSON.stringify({ bugs: [], next_id: 1 }));
  fs.writeFileSync(path.join(hq, 'PROGRESS.json'), JSON.stringify({ tasks }));
  fs.writeFileSync(path.join(root, 'alive.md'), '# 真实文件\n', 'utf8');
  fs.writeFileSync(
    path.join(hq, 'ROADMAP.md'),
    '# ROADMAP\n\n| ID | 标题 | 类型 | 优先级 | 状态 |\n'
      + tasks.map((t) => `| ${t.id} | ${t.title} | ${t.type} | ${t.priority} | ${t.status} |`).join('\n')
      + '\n'
  );
  return hq;
}

const T900 = (status, ref) => ({
  id: 'T-900',
  title: '夹具',
  domain: 'cli',
  type: 'feature',
  priority: 'P1',
  status,
  acceptance: `1) 改 ${ref} 全绿`,
});

test('validateDataset：done 任务 acceptance 路径失效 → error；todo 同类只 warning', () => {
  const root = tmpDir();
  try {
    const hq = minimalHq(root, [
      T900('done', 'gone/dead.js'),
      Object.assign(T900('todo', 'gone/dead.js'), { id: 'T-901' }),
      Object.assign(T900('done', 'alive.md'), { id: 'T-902' }),
    ]);

    const r = H.validateDataset(hq, {});

    const doneErrs = r.errors.filter((e) => /T-900/.test(e));
    assert.strictEqual(doneErrs.length, 1, JSON.stringify(r.errors, null, 2));
    assert.ok(/该任务已 done/.test(doneErrs[0]), doneErrs[0]);
    // 处方必须在场：只说「判据失效」不说怎么修，读数就退回不可行动 ——
    // 那正是断点里「没有任何 finding 把它联系起来」的翻版。
    assert.ok(/改指现存文件/.test(doneErrs[0]), doneErrs[0]);
    assert.ok(/打回 review/.test(doneErrs[0]), doneErrs[0]);
    // todo 的同一条死路径不许被升级 —— 升级会把「路标搬走」变成全表 error，
    // 那正是原告警只做 warning 的理由（2026-09-23：文档改名是正常操作）。
    assert.ok(r.warnings.some((w) => /T-901/.test(w)), JSON.stringify(r.warnings));
    assert.ok(!r.errors.some((e) => /T-901/.test(e)), JSON.stringify(r.errors));
    // done 但路径仍有效的任务不报
    assert.ok(!r.errors.some((e) => /T-902/.test(e)), JSON.stringify(r.errors));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validateDataset：done 任务路径全部仍有效 → 给一条 ✓ 复核读数', () => {
  const root = tmpDir();
  try {
    const hq = minimalHq(root, [
      Object.assign(T900('done', 'alive.md'), { id: 'T-900' }),
      Object.assign(T900('done', 'alive.md'), { id: 'T-902' }),
    ]);

    const r = H.validateDataset(hq, {});

    assert.ok(
      r.checks.some((c) => /2 条 done 任务的验收判据路径复核通过/.test(c)),
      JSON.stringify(r.checks)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 纯逻辑：todo→doing 边界锁（不 spawn，直查 _applyState 同源判据）──
//
// E2E 版本需要真实 git 状态，且 `_applyState` 在 handlers 层（有 IO）。
// 这里锁「判据」本身：scope_guard 缺失/空数组/全空白都必须算「没锁边界」。
// 接线（handler 在 todo→doing 时调用它）由下方 spawn 用例覆盖。

test('边界锁判据：scope_guard 缺失 / 空数组 / 全空白都算未声明', () => {
  const missing = H.scopeGuardPrefixes(undefined);
  assert.deepStrictEqual(missing.prefixes, []);

  const empty = H.scopeGuardPrefixes([]);
  assert.deepStrictEqual(empty.prefixes, []);

  const blank = H.scopeGuardPrefixes(['  ', '']);
  assert.deepStrictEqual(blank.prefixes, []);
  assert.deepStrictEqual(blank.manual, []);
});

test('E2E todo→doing 未声明 scope_guard → 拒并指路（边界锁接线证明）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-001'); // 真实数据里的 todo 任务
    t.status = 'todo';
    delete t.scope_guard;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r = runCli(['hq', 'task', 'set', 'T-001', 'doing'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `应被拒；输出：\n${r.output}`);
    assert.ok(r.output.includes('scope_guard'), r.output);
    assert.strictEqual(sandboxStatus(env, 'T-001'), 'todo', '被拒时状态必须不变');
    const t2 = JSON.parse(fs.readFileSync(p, 'utf8')).tasks.find((x) => x.id === 'T-001');
    assert.strictEqual(t2.started_at, undefined, '没过门就不得有开工戳');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E task note --scope 写入边界后 todo→doing 放行（锁可以被满足）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-001');
    t.status = 'todo';
    delete t.scope_guard;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    // ⚠ 每条边界一次调用：router.js 的 options 解析对重复 --key 是 last-wins
    // （router.js:764，`--scope a --scope b` 只会剩下 b）—— 实测教训，勿合并成一行。
    const r1 = runCli(
      ['hq', 'task', 'note', 'T-001', '--scope', '不改 services/backend 以外'],
      env.env,
      env.root
    );
    assert.strictEqual(r1.code, 0, r1.output);
    const r1b = runCli(
      ['hq', 'task', 'note', 'T-001', '--scope', '不动 keyStore 对外契约'],
      env.env,
      env.root
    );
    assert.strictEqual(r1b.code, 0, r1b.output);

    const d2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t2 = d2.tasks.find((x) => x.id === 'T-001');
    assert.ok(Array.isArray(t2.scope_guard) && t2.scope_guard.length === 2, JSON.stringify(t2.scope_guard));

    const r2 = runCli(['hq', 'task', 'set', 'T-001', 'doing'], env.env, env.root);
    assert.strictEqual(r2.code, 0, `声明边界后应放行；输出：\n${r2.output}`);
    assert.strictEqual(sandboxStatus(env, 'T-001'), 'doing');
    const t3 = JSON.parse(fs.readFileSync(p, 'utf8')).tasks.find((x) => x.id === 'T-001');
    assert.match(t3.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, '过门即盖章');
    assert.strictEqual(typeof t3.start_note_count, 'number', '开工基线入账');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ── close 交付面：未测项必须逐条点名（2026-11-05 补）─────────────────
//
// `khy hq close` 曾只把交付面的 UNKNOWN 折成一句「N 项未测」，且该句在有 GAP 时
// 整个不出现；人读到的只有 GAP 清单，未测项的 id/detail 无从下手。判定语义
// （status 与 _combineVerdict）不变，这里只锁「未测被逐条带出」。

const HQH = require('../../src/cli/handlers/hq.js');

test('交付面裁决：UNKNOWN 逐条带出 id/title/detail，有 GAP 时也不被吞', () => {
  const v = HQH._deliveryVerdict({
    ok: true,
    report: {
      at: '2026-11-05T00:00:00.000Z',
      source: 'cache',
      counts: { PASS: 8, PARTIAL: 0, GAP: 1, UNKNOWN: 2 },
      results: [
        { id: 'D1', title: '仓库完整性', status: 'UNKNOWN', detail: '无 git 可用，无法遍历对象库' },
        { id: 'D2', title: '发布物真实存在', status: 'GAP', detail: 'dist/ 缺 wheel,sdist' },
        { id: 'D3', title: '新克隆零缺件', status: 'UNKNOWN', detail: '?? = 506 · D = 5' },
      ],
    },
  });
  assert.strictEqual(v.status, 'gap', '有 GAP 时状态语义不变（两轴判定不并入未测）');
  assert.deepStrictEqual(v.gaps, ['D2 发布物真实存在']);
  assert.deepStrictEqual(v.unknowns.map((u) => u.id), ['D1', 'D3']);
  assert.strictEqual(v.unknowns[0].detail, '无 git 可用，无法遍历对象库', 'detail 是「为什么测不了」的唯一来源');
  assert.match(v.reason, /1 项 GAP/);
  assert.match(v.reason, /2 项未测（见下方清单）/, `有 GAP 时未测不得被吞：${v.reason}`);
});

test('交付面裁决：只有 UNKNOWN 时同样点名；无报告时不伪造清单', () => {
  const only = HQH._deliveryVerdict({
    ok: true,
    report: {
      counts: { UNKNOWN: 1 },
      results: [{ id: 'D9', title: '端到端黄金路径', status: 'UNKNOWN', detail: '未接进发布门' }],
    },
  });
  assert.strictEqual(only.status, 'unknown');
  assert.deepStrictEqual(only.unknowns.map((u) => u.id), ['D9']);
  assert.match(only.reason, /1 项未测/);

  const missing = HQH._deliveryVerdict({ ok: false, reason: '无缓存报告（加 --run-delivery 现跑）' });
  assert.strictEqual(missing.status, 'unknown');
  assert.deepStrictEqual(missing.unknowns, []);
  assert.deepStrictEqual(missing.gaps, []);
  assert.strictEqual(missing.reason, '无缓存报告（加 --run-delivery 现跑）');
});
