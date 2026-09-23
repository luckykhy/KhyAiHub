'use strict';
/**
 * check-delivery-baseline.test.js — PROCESS-014 执行器的单测。
 *
 * ## 本测试要防的头号问题：空转断言
 *
 * 本仓已有两次前科（`check-zcode-baseline.js` 打印 `PASS 7` 却自述"恒返回 0"；
 * `source-hygiene-scan.js` 自述 `ALWAYS exits 0`）。**一个恒真的断言与没有断言等价。**
 * 故本测试的核心断言是**反向验证**：同一份 fixture 只注入一处违规，
 * 记分板对应项必须真的从 PASS 翻成 GAP，`--strict` 退出码必须从 0 翻成 1。
 * 若某天有人把检查改成恒真，这些用例会红。
 *
 * ## 判据来源
 *
 * 每条用例都对应 [DESIGN-DELIV-001] 的一条 D 判据或 [DESIGN-DELIV-002] 的一只棘轮，
 * 断言的是**结构化读数**（`--json` 的 `results[].status` 与 `findings[].finding`），
 * 不认人读文案 —— 对齐 [DESIGN-DELIV-001] §4.2 的三条硬要求。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CHECKER = path.resolve(__dirname, '..', 'ci', 'check-delivery-baseline.js');
const DOC_REL = path.join('docs', '10_规范', '其它规范', '[DESIGN-DELIV-002] 产品任务面与交付律.md');

let seq = 0;
const TMP_ROOTS = [];

function mkFixture(mutate) {
  seq += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-deliv-${seq}-`));
  TMP_ROOTS.push(root);

  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  };

  // ── 阈值真源：一份"干净"的 fixture，四个棘轮基线都被刻意设为与实测相等 ──
  const surface = {
    $schema: 'khy-delivery-surface/1',
    updated: '2026-09-24',
    taskFacing: { T0: ['khy'] },
    ratchet: {
      routerCommands: { baseline: 2, method: 'fixture', source: 'fixture' },
      aliasEntries: { baseline: 3, method: 'fixture', source: 'fixture' },
      handlerFiles: { baseline: 1, method: 'fixture', source: 'fixture' },
      ruleCount: { baseline: 1, method: 'fixture', source: 'fixture' },
    },
    thresholds: { s1MaxDays: 90 },
    channels: {
      pypi: { manifest: 'pyproject.toml', ciWorkflow: 'w.yml' },
      electron: { manifest: 'electron/main.js', ciWorkflow: null },
      android: { manifest: 'pubspec.yaml', ciWorkflow: null },
      nsis: { manifest: 'setup.nsi', ciWorkflow: null },
    },
    boundaryDoc: { docPath: DOC_REL.split(path.sep).join('/'), sectionAnchor: '§3', requiresUnsupportedList: true },
    artifactRoot: { path: 'dist', requiredFiles: ['wheel', 'sdist'] },
  };
  write(
    DOC_REL,
    [
      '# fixture 边界文档',
      '',
      '## §3 边界声明',
      '',
      '明确不支持清单：electron、android、nsis 三条渠道不承诺交付。',
      '',
      '```json',
      JSON.stringify(surface, null, 2),
      '```',
      '',
    ].join('\n')
  );

  // ── D2 发布物存在且非零字节 ──
  write(path.join('dist', 'khy_os-1.0.0-py3-none-any.whl'), 'WHEEL-PAYLOAD');
  write(path.join('dist', 'khy_os-1.0.0.tar.gz'), 'SDIST-PAYLOAD');

  // ── D4/D5/D6 发布链：无吞错、有校验和回路、SBOM 有消费者 ──
  write(
    path.join('.github', 'workflows', 'dual-channel-release.yml'),
    [
      'name: release',
      'jobs:',
      '  release:',
      '    steps:',
      '      - run: sha256sum dist/* > dist/SHA256SUMS',
      '      - run: gh release upload v1 dist/SHA256SUMS',
      '      - run: cyclonedx-npm --output-file dist/sbom-npm.json',
      '      - run: grype dist/sbom-npm.json',
      '',
    ].join('\n')
  );

  // ── D7 复用既有棘轮（fixture 里给一个恒通过的替身） ──
  write(path.join('scripts', 'ci', 'check-debt-ledger.js'), 'process.exit(0);\n');

  // ── D9 黄金路径：脚本存在 + 被发布门阶段表引用 ──
  write(path.join('scripts', 'ci', 'check-golden-path.js'), 'process.exit(0);\n');
  write(
    path.join('scripts', 'release', 'lib', 'releaseGateStages.js'),
    "const STAGES = [{ id: 'golden', command: 'node scripts/ci/check-golden-path.js' }];\n"
  );

  // ── 棘轮：四项实测值都与基线相等 ──
  write(
    path.join('services', 'backend', 'src', 'constants', 'commandSchema.js'),
    "const ROUTER_COMMANDS = ['a', 'b'];\nmodule.exports = { ROUTER_COMMANDS };\n"
  );
  write(
    path.join('services', 'backend', 'src', 'cli', 'aliases.js'),
    "module.exports = [{ command: 'a' }, { command: 'b' }, { command: 'c' }];\n"
  );
  write(path.join('services', 'backend', 'src', 'cli', 'handlers', 'a.js'), "module.exports = {};\n");
  write(
    path.join('docs', '10_规范', 'registry', 'RULES-REGISTRY.json'),
    JSON.stringify({ meta: { ruleCount: 1 }, rules: [{ id: 'X-001' }] }, null, 2) + '\n'
  );

  // ── D8 阶段结算：无机制登记 ⇒ 无逾期项 ──
  write(
    path.join('docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json'),
    JSON.stringify({ rollout: { mechanisms: [] } }, null, 2) + '\n'
  );

  if (typeof mutate === 'function') mutate(write, root);
  return { root, write };
}

function run(root, extraArgs = []) {
  const r = cp.spawnSync(process.execPath, [CHECKER, '--json', ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_DELIVERY_ROOT: root },
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  return { status: typeof r.status === 'number' ? r.status : -1, json: parsed, stdout: r.stdout, stderr: r.stderr };
}

const statusOf = (json, id) => {
  const hit = (json.results || []).find((x) => x.id === id);
  return hit ? hit.status : 'MISSING';
};
const findingIds = (json) => (json.findings || []).map((f) => f.finding);

test.after(() => {
  for (const r of TMP_ROOTS) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言结论 */
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 正向：干净 fixture 上，凡 fixture 覆盖到的判据必须 PASS
// ─────────────────────────────────────────────────────────────────────────

test('干净 fixture：覆盖到的判据全 PASS（D2/D4/D5/D6/D7/D8/D9/D10/TS/CH）', () => {
  const { root } = mkFixture();
  const { json } = run(root);
  assert.ok(json, 'JSON 输出必须可解析');
  for (const id of ['D2', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'TS', 'CH']) {
    assert.strictEqual(statusOf(json, id), 'PASS', `${id} 应为 PASS，实际 ${statusOf(json, id)}`);
  }
  assert.strictEqual(json.counts.GAP, 0, '干净 fixture 不应有 GAP');
  assert.deepStrictEqual(findingIds(json), [], '干净 fixture 不应有 finding');
});

test('干净 fixture：D1/D3 在无 git 时判 UNKNOWN，绝不假装 PASS', () => {
  const { root } = mkFixture();
  const { json } = run(root);
  // fixture 不是 git 仓库 ⇒ D1/D3 无法判定
  assert.strictEqual(statusOf(json, 'D1'), 'UNKNOWN');
  assert.strictEqual(statusOf(json, 'D3'), 'UNKNOWN');
});

test('输出契约：非 --json 时 stdout 只放 finding、记分板走 stderr；--json 时 stdout 是纯 JSON', () => {
  const { root } = mkFixture();
  const { json, stdout } = run(root);
  assert.ok(json, '--json 模式下 stdout 必须是可解析的 JSON');
  assert.ok(stdout.trim().startsWith('{'), 'stdout 首字符必须是 {');

  // 非 --json 模式：stdout 留给 finding（ruleguard 方言），记分板必须走 stderr。
  const plain = cp.spawnSync(process.execPath, [CHECKER], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_DELIVERY_ROOT: root },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(/可交付性记分板/.test(plain.stderr), '人读记分板必须在 stderr 上');
  assert.ok(!/可交付性记分板/.test(plain.stdout), 'stdout 不得混入记分板');
  assert.ok(/^Summary: \d+ error\(s\), \d+ warning\(s\)\.$/m.test(plain.stdout), 'stdout 末尾须有 Summary 行');
});

test('阶段 S1：默认不阻断（有 GAP 也 exit 0），--strict 才 exit 1', () => {
  const { root } = mkFixture((write, r) => {
    fs.rmSync(path.join(r, 'dist'), { recursive: true, force: true });
  });
  const normal = run(root);
  assert.ok(normal.json.counts.GAP > 0, '该 fixture 应当有 GAP（dist/ 被删）');
  assert.strictEqual(normal.status, 0, 'S1 观察者：有 GAP 也必须 exit 0（PROCESS-008 PP-3）');
  assert.strictEqual(normal.json.stage, 'S1');

  const strict = run(root, ['--strict']);
  assert.strictEqual(strict.status, 1, '--strict 下 GAP 必须 exit 1');
});

// ─────────────────────────────────────────────────────────────────────────
// 反向验证：同一 fixture 只注入一处违规，对应项必须真的翻红
// ─────────────────────────────────────────────────────────────────────────

test('反向验证 D2：删掉 dist/ ⇒ delivery-artifact-missing，且只此一项翻红', () => {
  const clean = mkFixture();
  const broken = mkFixture((write, root) => {
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  });

  const a = run(clean.root).json;
  const b = run(broken.root).json;

  assert.strictEqual(statusOf(a, 'D2'), 'PASS');
  assert.strictEqual(statusOf(b, 'D2'), 'GAP', '删掉 dist/ 后 D2 必须翻红');
  assert.ok(findingIds(b).includes('delivery-artifact-missing'));

  // 只有 D2 变了 —— 证明该项不是随手恒真恒假的常量
  const changed = ['D2', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'TS', 'CH'].filter(
    (id) => statusOf(a, id) !== statusOf(b, id)
  );
  assert.deepStrictEqual(changed, ['D2'], `只应 D2 变化，实际 ${changed.join(',')}`);
});

test('反向验证 D2：dist/ 存在但缺 sdist ⇒ 同样翻红（"命令写好了"≠"产物做出来了"）', () => {
  const { root } = mkFixture((write, r) => {
    fs.rmSync(path.join(r, 'dist', 'khy_os-1.0.0.tar.gz'));
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D2'), 'GAP');
  assert.ok(findingIds(json).includes('delivery-artifact-missing'));
});

test('反向验证 D4：校验类步骤被 || echo 吞掉 ⇒ delivery-swallowed-failure，行号真实', () => {
  const { root } = mkFixture((write) => {
    write(
      path.join('.github', 'workflows', 'dual-channel-release.yml'),
      [
        'name: release',
        'jobs:',
        '  release:',
        '    steps:',
        '      - run: sha256sum dist/* > dist/SHA256SUMS',
        '      - run: gh release upload v1 dist/SHA256SUMS',
        '      - run: sigstore sign dist/*.whl || echo "sign failed (non-fatal, continuing)"',
        '      - run: grype dist/sbom-npm.json',
        '',
      ].join('\n')
    );
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D4'), 'GAP');
  const hit = (json.findings || []).find((f) => f.finding === 'delivery-swallowed-failure');
  assert.ok(hit, '必须报 delivery-swallowed-failure');
  assert.strictEqual(hit.line, 7, `行号必须真实（第 7 行），实际 ${hit.line}`);
  assert.ok(!/\s/.test(hit.file), 'findings 的 file 不得含空格（ruleguard 方言 \\S+）');
});

test('反向验证 D6：SBOM 只生成无消费者 ⇒ delivery-sbom-unconsumed', () => {
  const { root } = mkFixture((write) => {
    write(
      path.join('.github', 'workflows', 'dual-channel-release.yml'),
      [
        'name: release',
        'jobs:',
        '  release:',
        '    steps:',
        '      - run: sha256sum dist/* > dist/SHA256SUMS',
        '      - run: gh release upload v1 dist/SHA256SUMS',
        '      - run: cyclonedx-npm --output-file dist/sbom-npm.json',
        '      - uses: actions/upload-artifact@v4',
        '',
      ].join('\n')
    );
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D6'), 'GAP');
  assert.ok(findingIds(json).includes('delivery-sbom-unconsumed'));
});

test('反向验证 D9：黄金路径脚本不存在 ⇒ delivery-golden-path-unverified', () => {
  const { root } = mkFixture((write, r) => {
    fs.rmSync(path.join(r, 'scripts', 'ci', 'check-golden-path.js'));
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D9'), 'GAP');
  assert.ok(findingIds(json).includes('delivery-golden-path-unverified'));
});

test('反向验证 D10：边界文档删掉"不支持清单" ⇒ delivery-boundary-missing', () => {
  const { root } = mkFixture((write, r) => {
    const abs = path.join(r, DOC_REL);
    const text = fs.readFileSync(abs, 'utf8').replace(/明确不支持清单：[\s\S]*?\n/, '');
    fs.writeFileSync(abs, text.replace(/不支持/g, '待定'), 'utf8');
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D10'), 'GAP');
  assert.ok(findingIds(json).includes('delivery-boundary-missing'));
});

test('反向验证棘轮：多一个命令 / 多一条规则 ⇒ delivery-surface-ratchet-breach', () => {
  const { root } = mkFixture((write) => {
    write(
      path.join('services', 'backend', 'src', 'constants', 'commandSchema.js'),
      "const ROUTER_COMMANDS = ['a', 'b', 'c'];\nmodule.exports = { ROUTER_COMMANDS };\n"
    );
    write(
      path.join('docs', '10_规范', 'registry', 'RULES-REGISTRY.json'),
      JSON.stringify({ meta: { ruleCount: 2 }, rules: [{ id: 'X-001' }, { id: 'X-002' }] }, null, 2) + '\n'
    );
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'TS'), 'GAP');
  const hit = (json.findings || []).find((f) => f.finding === 'delivery-surface-ratchet-breach');
  assert.ok(hit, '必须报棘轮越界');
  assert.ok(/routerCommands=3\/2/.test(hit.message), `消息须给出实测/基线对，实际：${hit.message}`);
  assert.ok(/ruleCount=2\/1/.test(hit.message), `消息须给出实测/基线对，实际：${hit.message}`);
});

test('反向验证 D8：发布相关机制停在 S1 超期 ⇒ delivery-stage-unsettled', () => {
  const { root } = mkFixture((write) => {
    write(
      path.join('docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json'),
      JSON.stringify(
        {
          rollout: {
            mechanisms: [
              {
                id: 'stale-mechanism',
                rules: ['X-001'],
                executor: 'scripts/ci/check-golden-path.js',
                executorStage: { file: 'scripts/ci/check-golden-path.js', constant: 'STAGE' },
                stage: 'S1',
                stageSince: '2024-01-01',
                rollback: '删除登记条目',
              },
            ],
          },
        },
        null,
        2
      ) + '\n'
    );
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D8'), 'GAP', '停在 S1 超过 90 天必须翻红');
  assert.ok(findingIds(json).includes('delivery-stage-unsettled'));
});

test('反向验证 D8：同一机制改了 stageSince 到近期 ⇒ 不报（防"见谁都报"的误报）', () => {
  const { root } = mkFixture((write) => {
    write(
      path.join('docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json'),
      JSON.stringify(
        {
          rollout: {
            mechanisms: [
              {
                id: 'fresh-mechanism',
                rules: ['X-001'],
                executor: 'scripts/ci/check-golden-path.js',
                executorStage: { file: 'scripts/ci/check-golden-path.js', constant: 'STAGE' },
                stage: 'S1',
                stageSince: new Date().toISOString().slice(0, 10),
                rollback: '删除登记条目',
              },
            ],
          },
        },
        null,
        2
      ) + '\n'
    );
  });
  const { json } = run(root);
  assert.strictEqual(statusOf(json, 'D8'), 'PASS', '未超期不应报');
});

test('反向验证 thresholds：删掉阈值 JSON 块 ⇒ 报 missing，且不静默退回内置默认值', () => {
  const { root } = mkFixture((write, r) => {
    const abs = path.join(r, DOC_REL);
    fs.writeFileSync(abs, '# 只有正文，没有阈值块\n\n不支持清单在此。\n', 'utf8');
  });
  const { json } = run(root);
  assert.ok(findingIds(json).includes('delivery-thresholds-missing'), '删掉真源必须报');
  assert.strictEqual(json.thresholds.ok, false);
  // 阈值缺失时棘轮失去基线 ⇒ 不得凭空判定，只记读数
  assert.strictEqual(statusOf(json, 'TS'), 'PASS');
});

// ─────────────────────────────────────────────────────────────────────────
// 防空转总闸：记分板不得是常量
// ─────────────────────────────────────────────────────────────────────────

test('防空转：干净 vs 全违规 两份 fixture 的 GAP 数必须不同且严格有序', () => {
  const clean = mkFixture();
  const broken = mkFixture((write, r) => {
    fs.rmSync(path.join(r, 'dist'), { recursive: true, force: true });
    fs.rmSync(path.join(r, 'scripts', 'ci', 'check-golden-path.js'));
    write(
      path.join('.github', 'workflows', 'dual-channel-release.yml'),
      [
        'name: release',
        'jobs:',
        '  release:',
        '    steps:',
        '      - run: sigstore sign dist/* || echo "non-fatal, continuing"',
        '      - run: cyclonedx-npm --output-file dist/sbom-npm.json',
        '',
      ].join('\n')
    );
  });
  const a = run(clean.root).json;
  const b = run(broken.root).json;
  assert.strictEqual(a.counts.GAP, 0);
  assert.ok(b.counts.GAP >= 4, `全违规 fixture 应至少 4 个 GAP，实际 ${b.counts.GAP}`);
  assert.ok(b.counts.GAP > a.counts.GAP, '违规更多 ⇒ GAP 必须更多（否则记分板是常量）');
});

test('S1 观察者语义：error 级 finding 在默认模式下降级为 warning', () => {
  const { root } = mkFixture((write, r) => {
    fs.rmSync(path.join(r, 'dist'), { recursive: true, force: true });
  });
  const normal = run(root).json;
  assert.ok(normal.findings.length > 0, '应有 finding');
  assert.ok(
    normal.findings.every((f) => f.severity === 'warning'),
    'S1 下所有 finding 必须降级为 warning（不参与放行）'
  );

  const strict = run(root, ['--strict']).json;
  assert.ok(
    strict.findings.some((f) => f.severity === 'error'),
    '--strict 必须保留真实 error 级（否则升阶后无从阻断）'
  );
});

test('--changed：全仓状态项（D2）不报，但棘轮恒报', () => {
  const { root } = mkFixture((write, r) => {
    fs.rmSync(path.join(r, 'dist'), { recursive: true, force: true });
    write(
      path.join('services', 'backend', 'src', 'constants', 'commandSchema.js'),
      "const ROUTER_COMMANDS = ['a', 'b', 'c', 'd'];\nmodule.exports = { ROUTER_COMMANDS };\n"
    );
  });
  const changed = run(root, ['--changed']).json;
  assert.strictEqual(statusOf(changed, 'D2'), 'GAP', '--changed 下仍要测量并计入 JSON');
  assert.ok(!findingIds(changed).includes('delivery-artifact-missing'), '--changed 下不应报 dist/ 缺失');
  assert.ok(findingsOf(changed, 'delivery-surface-ratchet-breach'), '--changed 下棘轮必须仍报');
});

function findingsOf(json, id) {
  return (json.findings || []).some((f) => f.finding === id);
}

test('阈值外部化：改基线即可改变判定（证明阈值真的来自文档，不是硬编码）', () => {
  const { root } = mkFixture((write, r) => {
    write(
      path.join('services', 'backend', 'src', 'constants', 'commandSchema.js'),
      "const ROUTER_COMMANDS = ['a', 'b', 'c'];\nmodule.exports = { ROUTER_COMMANDS };\n"
    );
  });
  assert.strictEqual(statusOf(run(root).json, 'TS'), 'GAP', '基线 2 / 实测 3 ⇒ GAP');

  // 只改文档里的基线，不动任何代码 ⇒ 判定必须随之改变
  const abs = path.join(root, DOC_REL);
  const text = fs.readFileSync(abs, 'utf8').replace('"baseline": 2', '"baseline": 3');
  fs.writeFileSync(abs, text, 'utf8');
  assert.strictEqual(statusOf(run(root).json, 'TS'), 'PASS', '基线改为 3 ⇒ PASS（阈值确实外部化）');
});