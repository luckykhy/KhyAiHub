'use strict';

/**
 * check-native-registry.test.js — `PROCESS-013` 执行器的反例矩阵。
 *
 * 覆盖三类断言：
 *   ① 应放行：官方源配置、已门控的运行时镜像 —— 必须 0 finding（否则守卫会被绕过）；
 *   ② 应拦截：构建配置里的镜像、注入开关、非官方锁文件、未门控运行时；
 *   ③ **阶段派生**：同一改动集在 S1 与 S3 下的 error 数**必须不同** —— 这条是
 *      「severity 写死在判定处」这个静默失真的唯一机械防线：若 severity 被写死，
 *      S1 与 S3 会跑出完全相同的输出，升阶后仍然不拦截，而所有守卫全绿。
 *
 * 全部离线：只调纯函数 `evaluate()`，不读盘、不 spawn。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../ci/check-native-registry.js');
const {
  evaluate,
  evaluateFile,
  summarize,
  severityFor,
  isBuildConfig,
  isLockfile,
  isRuntimeSource,
  isCommentLine,
  normalize,
  SCENARIOS,
  STAGE,
} = mod;

// ── ① 应放行 ────────────────────────────────────────────────────────────────

test('官方源配置：0 finding（应放行）', () => {
  const entries = SCENARIOS['official-only'];
  assert.equal(evaluate(entries).length, 0);
});

test('锁文件只解析到 registry.npmjs.org：0 finding', () => {
  const entries = [
    {
      path: 'package-lock.json',
      content:
        '{"packages":{"node_modules/a":{"resolved":"https://registry.npmjs.org/a/-/a-1.0.0.tgz"}}}',
    },
  ];
  assert.equal(evaluate(entries).length, 0);
});

test('运行时镜像已被显式开关门控：0 finding', () => {
  const entries = SCENARIOS['runtime-gated'];
  assert.equal(evaluate(entries).length, 0);
});

test('与依赖源无关的文件完全不进入判定面', () => {
  const entries = [
    { path: 'services/backend/src/services/foo.js', content: 'const x = 1;\n' },
    { path: 'README.md', content: 'registry.npmmirror.com\n' },
    { path: 'docs/07_OPS_运维/OPS-MAN/x.md', content: 'mirrors.aliyun.com\n' },
  ];
  assert.equal(evaluate(entries).length, 0);
});

test('豁免登记的文件不被报出', () => {
  const entries = [
    {
      path: 'services/backend/src/services/offlineKnowledge.js',
      content: '国内镜像: https://registry.npmmirror.com\n',
    },
  ];
  assert.equal(evaluate(entries).length, 0);
  assert.ok(mod.EXEMPT.length >= 1);
  // 每条豁免必须带理由与到期日，否则会退化成「永久忽略」
  for (const e of mod.EXEMPT) {
    assert.ok(e.reason && e.reason.length > 4, `${e.path} 缺理由`);
    assert.match(e.reviewBy, /^\d{4}-\d{2}-\d{2}$/, `${e.path} 缺复核到期日`);
  }
});

// ── ② 应拦截 ────────────────────────────────────────────────────────────────

test('Dockerfile 里的 aliyun pypi 源被判出', () => {
  const findings = evaluate(SCENARIOS['aliyun-pip']);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criterion, 'non-native-registry');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].file, 'services/backend/Dockerfile');
});

test('*_MIRROR 注入开关被判出，且同一开关只报一条', () => {
  const content = [
    'ARG APT_MIRROR=""',
    'RUN if [ -n "$APT_MIRROR" ]; then',
    '  sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list;',
    'fi',
  ].join('\n');
  const findings = evaluate([{ path: 'Dockerfile', content }]);
  const knobs = findings.filter((f) => f.criterion === 'mirror-injection-knob');
  assert.equal(knobs.length, 1, '同一开关名在一个文件里应只产出 1 条 finding');
  assert.equal(knobs[0].line, 1);
  assert.match(knobs[0].message, /出现 3 处/);
});

test('锁文件里非官方 host 按文件聚合为一条，并带 host 直方图', () => {
  const findings = evaluate(SCENARIOS['lockfile-npmmirror']);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criterion, 'non-official-lockfile-resolution');
  assert.match(findings[0].message, /2 处 resolved/);
  assert.match(findings[0].message, /registry\.npmmirror\.com×2/);
});

test('未知镜像 host（不在已知清单里）也能被锁文件判据抓到', () => {
  const entries = [
    {
      path: 'package-lock.json',
      content: '{"packages":{"a":{"resolved":"https://npm.internal-proxy.example.com/a/-/a-1.0.0.tgz"}}}',
    },
  ];
  const findings = evaluate(entries);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criterion, 'non-official-lockfile-resolution');
});

test('运行时镜像未门控：按文件聚合为一条', () => {
  const findings = evaluate(SCENARIOS['runtime-ungated']);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criterion, 'ungated-runtime-mirror');
  assert.equal(findings[0].file, 'platform/khy_platform/_bootstrap.py');
});

test('一个文件里有多张镜像表也只报一条（setup.js 场景）', () => {
  const content = [
    'const NPM_MIRRORS = {',
    "  taobao: 'https://registry.npmmirror.com',",
    "  tencent: 'https://mirrors.cloud.tencent.com/npm/',",
    '};',
    'const PIP_MIRRORS = {',
    "  aliyun: 'https://mirrors.aliyun.com/pypi/simple/',",
    '};',
  ].join('\n');
  const findings = evaluate([{ path: 'services/backend/setup.js', content }]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /3 个公共镜像/);
});

test('裸主机名（无 scheme）也能命中', () => {
  const findings = evaluate([
    { path: 'kernel/Dockerfile.kernel-build', content: "ARG X=mirrors.tuna.tsinghua.edu.cn\n" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criterion, 'non-native-registry');
});

test('CI workflow 里的镜像也算构建配置', () => {
  const findings = evaluate([
    {
      path: '.github/workflows/x.yml',
      content: 'env:\n  PIP_INDEX_URL: https://mirrors.aliyun.com/pypi/simple/\n',
    },
  ]);
  assert.equal(findings.length, 1);
});

test('构建脚本（.sh / .ps1）里的镜像也算构建配置', () => {
  assert.equal(
    evaluate([{ path: 'a/b.sh', content: 'MIRROR="https://mirrors.tuna.tsinghua.edu.cn/alpine"\n' }]).length,
    1
  );
  assert.equal(
    evaluate([{ path: 'a/b.ps1', content: '$u = "https://registry.npmmirror.com"\n' }]).length,
    1
  );
});

test('package.json 里的构建期镜像（electronDownload.mirror）应被拦', () => {
  const entries = [
    {
      path: 'apps/khyos-desktop/package.json',
      content: JSON.stringify({
        name: 'khyos-desktop',
        build: { electronDownload: { mirror: 'https://npmmirror.com/mirrors/electron/' } },
      }),
    },
  ];
  const findings = evaluate(entries);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criterion, 'non-native-registry');
});

test('package.json 无镜像时不误伤（防假红）', () => {
  const entries = [
    {
      path: 'apps/khyos-desktop/package.json',
      content: JSON.stringify({
        name: 'khyos-desktop',
        scripts: { build: 'electron-builder' },
        build: { publish: { provider: 'generic', url: 'https://update.example.com/desktop' } },
      }),
    },
  ];
  assert.equal(evaluate(entries).length, 0);
});

// ── ③ 阶段派生：**本文件最关键的断言** ────────────────────────────────────────

test('S1 与 S3 的 error 数必须不同（severity 不得写死）', () => {
  const entries = [
    { path: 'services/backend/Dockerfile', content: 'RUN pip install -i https://mirrors.aliyun.com/pypi/simple/\n' },
    { path: 'package-lock.json', content: '{"a":{"resolved":"https://registry.npmmirror.com/a/-/a-1.tgz"}}' },
    { path: 'Dockerfile', content: 'ARG APT_MIRROR=""\n' },
  ];

  const s1 = summarize(evaluate(entries, { stage: 'S1' }));
  const s3 = summarize(evaluate(entries, { stage: 'S3' }));

  assert.equal(s1.errors, 0, 'S1 观察期不得派生 error（否则一上线就阻断，违反 PP-3）');
  assert.ok(s3.errors > 0, 'S3 必须派生 error（否则升阶后仍然不拦截，而所有守卫全绿）');
  assert.notEqual(s1.errors, s3.errors);

  // finding 总数不随阶段变化 —— 阶段只改强度，不改判定
  assert.equal(s1.total, s3.total);

  // 强度映射的具体边界
  assert.equal(severityFor('non-native-registry', 'S3'), 'error');
  assert.equal(severityFor('non-official-lockfile-resolution', 'S3'), 'error');
  assert.equal(severityFor('mirror-injection-knob', 'S3'), 'warning');
  assert.equal(severityFor('ungated-runtime-mirror', 'S3'), 'warning');
  assert.equal(severityFor('non-native-registry', 'S1'), 'warning');
  assert.equal(severityFor('non-native-registry', 'S2'), 'warning');
});

test('执行器的 STAGE 常量与登记表一致（当前 S1）', () => {
  assert.equal(STAGE, 'S1');
});

// ── 文件分类与工具函数 ──────────────────────────────────────────────────────

test('文件分类：构建配置 / 锁文件 / 运行时源码互不误判', () => {
  assert.ok(isBuildConfig('Dockerfile'));
  assert.ok(isBuildConfig('apps/ai-frontend/Dockerfile'));
  assert.ok(isBuildConfig('docker-compose.yml'));
  assert.ok(isBuildConfig('.npmrc'));
  assert.ok(isBuildConfig('services/backend/.npmrc'));
  assert.ok(isBuildConfig('.github/workflows/docker.yml'));
  assert.ok(isBuildConfig('requirements.txt'));
  assert.ok(!isBuildConfig('services/backend/server.js'));

  assert.ok(isLockfile('package-lock.json'));
  assert.ok(isLockfile('apps/ai-frontend/package-lock.json'));
  assert.ok(!isLockfile('pnpm-lock.yaml')); // 只按 resolved 判 npm 锁文件

  assert.ok(isRuntimeSource('platform/khy_platform/_bootstrap.py'));
  assert.ok(isRuntimeSource('services/backend/setup.js'));
  assert.ok(!isRuntimeSource('scripts/ci/check-native-registry.js'));
});

test('路径归一化：反斜杠与 ./ 前缀', () => {
  assert.equal(normalize('.\\services\\backend\\Dockerfile'), 'services/backend/Dockerfile');
  assert.equal(normalize('./Dockerfile'), 'Dockerfile');
});

// ── 精度：守卫不得报自己的说明文字 ──────────────────────────────────────────

test('注释行被跳过（否则「解释为何删除镜像开关」的注释会自伤）', () => {
  const entries = [
    {
      path: 'Dockerfile',
      // 真实场景：删掉 APT_MIRROR 后，注释里必然要提到这个名字说明为什么删
      content: '# 刻意不提供 APT_MIRROR / NPM_REGISTRY 注入开关（PROCESS-013）\nFROM node:22-slim\n',
    },
    { path: 'kernel/Dockerfile.kernel-build', content: '# 曾经用 mirrors.tuna.tsinghua.edu.cn，已移除\n' },
    { path: '.npmrc', content: '# registry=https://registry.npmmirror.com\n' },
  ];
  assert.equal(evaluate(entries).length, 0, '注释不参与执行，不应产生 finding');
});

test('注释被跳过后，同一文件里的真实违规仍能报出', () => {
  const entries = [
    {
      path: 'Dockerfile',
      content: '# 说明：不要用 APT_MIRROR\nARG APT_MIRROR=""\nRUN pip install -i https://mirrors.aliyun.com/pypi/simple/\n',
    },
  ];
  const findings = evaluate(entries);
  const criteria = findings.map((f) => f.criterion).sort();
  assert.deepEqual(criteria, ['mirror-injection-knob', 'non-native-registry']);
  assert.equal(findings.find((f) => f.criterion === 'mirror-injection-knob').line, 2);
  assert.equal(findings.find((f) => f.criterion === 'non-native-registry').line, 3);
});

test('isCommentLine 覆盖三种注释前缀', () => {
  assert.ok(isCommentLine('# x'));
  assert.ok(isCommentLine('   // x'));
  assert.ok(isCommentLine('<!-- x -->'));
  assert.ok(!isCommentLine('ARG APT_MIRROR=""'));
  assert.ok(!isCommentLine('  RUN npm install'));
});

test('evaluateFile 是纯函数：同样输入必得同样输出', () => {
  const entry = { path: 'Dockerfile', content: 'ARG APT_MIRROR=""\n' };
  const a = JSON.stringify(evaluateFile(entry));
  const b = JSON.stringify(evaluateFile(entry));
  assert.equal(a, b);
});

test('全部离线场景都能跑出结果且不抛', () => {
  for (const name of Object.keys(SCENARIOS)) {
    assert.doesNotThrow(() => evaluate(SCENARIOS[name]), `场景 ${name} 抛异常`);
  }
});
