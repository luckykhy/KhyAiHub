'use strict';

// Co-located contract tests for trajectoryPackager.js.
// Package trees are built under os.tmpdir(); child_process is stubbed through require.cache
// so zipPackage() is asserted on WHAT IT DECIDES (argv) and never really spawns anything.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CP_ID = require.resolve('child_process');
const spawns = [];
let spawnResult = { status: 0, stdout: '', stderr: '' };
const prevCp = require.cache[CP_ID];
require.cache[CP_ID] = {
  id: CP_ID,
  filename: CP_ID,
  loaded: true,
  exports: {
    ...require('child_process'),
    spawnSync: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return spawnResult;
    },
  },
  children: [],
  paths: [],
};

const pkg = require('./trajectoryPackager');

const tmpDirs = [];
const origCwd = process.cwd;
const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');

after(() => {
  if (prevCp) require.cache[CP_ID] = prevCp; else delete require.cache[CP_ID];
  process.cwd = origCwd;
  if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkTmp(prefix = 'khy-b46-tp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeFullPackage() {
  const dir = mkTmp();
  for (const sub of ['task/assets', 'trajectory', 'screenshots', 'workspace/src/app',
    'workspace/dist', 'env', 'qc']) {
    fs.mkdirSync(path.join(dir, ...sub.split('/')), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'task', 'prompt.md'), 'prompt body');
  fs.writeFileSync(path.join(dir, 'task', 'assets', 'hero.png'), 'PNGDATA');
  fs.writeFileSync(path.join(dir, 'trajectory', '1712_api_call.json'), '{}');
  fs.writeFileSync(path.join(dir, 'trajectory', '1713_api_call.json'), '{}');
  fs.writeFileSync(path.join(dir, 'trajectory', 'notes.md'), 'not an api call');
  fs.writeFileSync(path.join(dir, 'screenshots', 's1.PNG'), 'a');
  fs.writeFileSync(path.join(dir, 'screenshots', 's2.jpg'), 'bb');
  fs.writeFileSync(path.join(dir, 'screenshots', 'clip.mp4'), 'ccc');
  fs.writeFileSync(path.join(dir, 'workspace', 'src', 'app', 'main.js'), 'dddd');
  fs.writeFileSync(path.join(dir, 'workspace', 'dist', 'index.html'), 'eeeee');
  fs.writeFileSync(path.join(dir, 'env', 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(dir, 'env', 'env_snapshot.json'), '{}');
  fs.writeFileSync(path.join(dir, 'env', 'build.md'), 'npm i');
  fs.writeFileSync(path.join(dir, 'qc', 'self_check.md'), 'check');
  return dir;
}

test('validateStructure：齐备返回 valid:true，缺项按 "名字/" 形式列出', () => {
  const dir = makeFullPackage();
  assert.deepEqual(pkg.validateStructure(dir), { valid: true, missing: [] });

  fs.rmSync(path.join(dir, 'qc'), { recursive: true });
  fs.rmSync(path.join(dir, 'env'), { recursive: true });
  const r = pkg.validateStructure(dir);
  assert.equal(r.valid, false);
  assert.deepEqual(r.missing, ['env/', 'qc/']);
});

test('validateStructure 对不存在的目录只报缺失，不抛', () => {
  const r = pkg.validateStructure(path.join(mkTmp(), 'nope'));
  assert.equal(r.valid, false);
  assert.deepEqual(r.missing, ['task/', 'trajectory/', 'screenshots/', 'workspace/', 'env/', 'qc/']);
});

test('KNOWN-DEFECT: validateStructure 收到非字符串直接抛 TypeError，违约其 {valid,missing} 契约', () => {
  // trajectoryPackager.js:43 `path.join(pkgDir, dir)` 对 null/数字抛；
  // 门面 webFrontendEval/index.js:115 直接消费返回值，于是 run.package_path 为
  // 非字符串（如 0、{}）时整条 assemblePackage 变成 unhandled rejection。
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.throws(() => pkg.validateStructure(bad), TypeError);
  }
  const empty = pkg.validateStructure('');
  assert.equal(empty.valid, false);
  // 实测补充：'' 不被拒收，而是按 **CWD** 解析相对路径。在 `services/backend/src/services/domain`
  // 下跑时 `trajectory/`、`workspace/` 恰好是真实的上下文目录，于是缺失项数量随 CWD 变化
  // （仓根跑是 6 项，此处只有 4 项）。这正是「空串未校验」的可见后果，故断言只锁
  // 「不抛 + 必判无效 + 缺失项随环境漂移」三件事，不硬编码清单。
  assert.ok(Array.isArray(empty.missing) && empty.missing.length > 0, '缺失项应是非空数组');
  assert.ok(empty.missing.includes('task/'), 'task/ 在任一 CWD 下都不存在，必在缺失项里');
});

test('generateManifest 统计各类文件并把资产 sha256/大小逐条列出', () => {
  const dir = makeFullPackage();
  const m = pkg.generateManifest(dir, { id: 3, name: '落地页', level: 'L3', category: '3d', created_by: 9 }, { id: 12, task_id: 3, ai_model: 'claude', annotator_id: 4 });
  assert.equal(m.v, 1);
  assert.equal(m.kind, 'web-frontend-traj-package');
  assert.equal(m.producer, 'khyos');
  assert.deepEqual(
    { id: m.task_id, run: m.run_id, level: m.level, cat: m.category, model: m.ai_model, by: m.created_by, ann: m.annotator_id },
    { id: 3, run: 12, level: 'L3', cat: '3d', model: 'claude', by: 9, ann: 4 },
  );
  assert.deepEqual(m.package, {
    apiCallCount: 2,
    assets: 1,
    screenshots: 2,
    workspaceSrcFiles: 1,
    workspaceDistFiles: 1,
    hasLockfile: true,
    hasEnvSnapshot: true,
    hasBuildMd: true,
    hasSelfCheck: true,
    hasQcReport: false,
  });
  assert.equal(m.files.assets[0].path, 'task/assets/hero.png');
  assert.equal(m.files.assets[0].size, 7);
  assert.equal(
    m.files.assets[0].sha256,
    crypto.createHash('sha256').update('PNGDATA').digest('hex'),
  );
  assert.deepEqual(m.files.screenshots.map((s) => s.path), ['screenshots/s1.PNG', 'screenshots/s2.jpg']);
  assert.equal(m.files.workspaceSrc[0].path, 'workspace/src/app/main.js');
  assert.equal(m.files.lockfile.path, 'env/package-lock.json');
  assert.equal(m.files.buildMd, 'env/build.md');
});

test('KNOWN-DEFECT: env/ 里任何含 "lock" 的文件都被当依赖锁（clock-sync.md 也算），QC 的 no_lockfile 被绕过', () => {
  const dir = makeFullPackage();
  fs.rmSync(path.join(dir, 'env', 'package-lock.json'));
  fs.writeFileSync(path.join(dir, 'env', 'clock-sync.md'), 'notes about deadlock');
  const m = pkg.generateManifest(dir, { id: 1 }, { id: 1 });
  // trajectoryPackager.js:121 `/lock/.test(f)` 是宽松子串匹配，排在它前面的具体
  // ^package-lock/^pnpm-lock/^yarn.lock 只是它的子集，于是「有锁文件」这一 QC 必要条件
  // 对一个 deadlock 笔记也成立 —— qcEngine 的 no_lockfile(major) 永不出声。
  assert.equal(m.package.hasLockfile, true);
  assert.equal(m.files.lockfile.name, 'clock-sync.md');
});

test('KNOWN-DEFECT: summary.totalFiles 里写死 +4，与实际文件数无关', () => {
  const dir = mkTmp();
  for (const sub of ['task', 'trajectory', 'screenshots', 'workspace', 'env', 'qc']) {
    fs.mkdirSync(path.join(dir, sub));
  }
  const m = pkg.generateManifest(dir, { id: 1 }, { id: 1 });
  assert.equal(m.files.assets.length + m.files.screenshots.length
    + m.files.workspaceSrc.length + m.files.workspaceDist.length, 0);
  // trajectoryPackager.js:175-181 —— 空包里 totalFiles 报 4，manifest 落盘即错值。
  assert.equal(m.summary.totalFiles, 4);
});

test('generateManifest 对空目录/缺失 task/run 不抛，各计数归零、字段回退默认', () => {
  const dir = mkTmp();
  const m = pkg.generateManifest(dir, null, null);
  assert.equal(m.task_id, undefined);
  assert.equal(m.task_name, '');
  assert.equal(m.level, 'L1');
  assert.equal(m.category, '2d');
  assert.equal(m.created_by, 0);
  assert.equal(m.annotator_id, 0);
  assert.equal(m.ai_model, '');
  assert.deepEqual(m.files, {
    assets: [],
    screenshots: [],
    workspaceSrc: [],
    workspaceDist: [],
    lockfile: null,
    envSnapshot: null,
    buildMd: null,
  });
});

test('KNOWN-DEFECT: task.id=0 / created_by=0 被 || 门吞成 undefined/0 默认，manifest 与 run 关联丢失', () => {
  const dir = mkTmp();
  const m = pkg.generateManifest(dir, { id: 0, name: 'zero', created_by: 0 }, { id: 5, task_id: 0 });
  // trajectoryPackager.js:141 `task?.id || run?.task_id` —— 0 是合法自增主键时同样被跳过，
  // 这里 task_id 落到 run.task_id(0)，若 run 也没带 task_id 则 manifest 里没有任务归属。
  assert.equal(m.task_id, 0);
  const m2 = pkg.generateManifest(dir, { id: 0 }, { id: 5 });
  assert.equal(m2.task_id, undefined);
});

test('writeManifest 落盘合法 JSON 并回传同一个对象引用', () => {
  const dir = mkTmp();
  const input = { v: 1, package: { apiCallCount: 3 } };
  const back = pkg.writeManifest(dir, input);
  assert.equal(back, input);
  const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
  assert.deepEqual(JSON.parse(raw), input);
  assert.match(raw, /\n {2}"v": 1/);
});

test('zipPackage 走 Windows 分支：powershell + Compress-Archive，失败时抛带 stderr 的 Error', () => {
  spawns.length = 0;
  spawnResult = { status: 0, stdout: '', stderr: '' };
  const dir = makeFullPackage();
  const out = mkTmp('khy-b46-tp-out-');
  const got = pkg.zipPackage(dir, out);
  assert.equal(got, path.join(out, `${path.basename(dir)}.zip`));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, 'powershell');
  assert.deepEqual(spawns[0].args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.match(spawns[0].args[2], /Compress-Archive -Path '.*\\\*'/);
  assert.match(spawns[0].args[2], new RegExp(`-DestinationPath '${got.replaceAll('\\', '\\\\')}' -Force`));
  assert.ok(fs.existsSync(out));

  spawnResult = { status: 1, stdout: 'oops', stderr: ' archive failed ' };
  assert.throws(() => pkg.zipPackage(dir, out), /Zip failed \(powershell\): archive failed/);
  spawnResult = { status: 2, stdout: '', stderr: '' };
  assert.throws(() => pkg.zipPackage(dir, out), /Zip failed \(powershell\): exit 2/);
  spawnResult = { status: 0, stdout: '', stderr: '' };
});

test('KNOWN-DEFECT: zipPackage 把目录名原样拼进 PowerShell -Command，单引号可逃逸成任意命令', () => {
  spawns.length = 0;
  const evil = mkTmp();
  // 名字只用 NTFS 合法字符（单引号/分号都合法），保证结论与平台无关。
  const dir = path.join(evil, "pkg'; Start-Process calc; 'tail");
  fs.mkdirSync(path.join(dir, 'task'), { recursive: true });
  const got = pkg.zipPackage(dir, evil);
  assert.equal(spawns.length, 1);
  const cmd = spawns[0].args[2];
  // trajectoryPackager.js:213 用模板字符串把绝对路径塞进单引号里，没有任何转义：
  // 一个带单引号的包目录名（订阅/下载解压出来的目录完全可能）直接闭合引号并追加命令，
  // 于是「打包」这一步在本机以当前用户权限执行了注入的命令。
  assert.match(cmd, /Start-Process calc/);
  assert.ok(got.endsWith('.zip'));
});

test('zipPackage 缺省输出目录取自 process.cwd()/dist/trajectory-packages（不在仓库外自动落地）', () => {
  spawns.length = 0;
  spawnResult = { status: 0, stdout: '', stderr: '' };
  const sandbox = mkTmp('khy-b46-tp-cwd-');
  const dir = path.join(sandbox, 'pkg-default');
  fs.mkdirSync(path.join(dir, 'task'), { recursive: true });
  process.cwd = () => sandbox;
  const got = pkg.zipPackage(dir);
  process.cwd = origCwd;
  assert.equal(got, path.join(sandbox, 'dist', 'trajectory-packages', 'pkg-default.zip'));
  assert.ok(fs.existsSync(path.join(sandbox, 'dist', 'trajectory-packages')));
});

test('非 win32 分支走 tar：路径作为 argv 传递（无注入面），失败信息为 Tar failed', () => {
  spawns.length = 0;
  spawnResult = { status: 0, stdout: '', stderr: '' };
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const sandbox = mkTmp('khy-b46-tp-tar-');
    const dir = path.join(sandbox, "weird'; rm -rf ~");
    fs.mkdirSync(path.join(dir, 'task'), { recursive: true });
    const out = path.join(sandbox, 'out');
    const got = pkg.zipPackage(dir, out);
    assert.equal(got, path.join(out, `${path.basename(dir)}.tar.gz`));
    assert.equal(spawns[0].cmd, 'tar');
    assert.deepEqual(spawns[0].args.slice(0, 2), ['-czf', got]);
    assert.deepEqual(spawns[0].args.slice(2), ['-C', sandbox, path.basename(dir)]);
    // 注入串留在 argv 里，不进 shell —— 这是与 PowerShell 分支的关键差异。
    assert.ok(spawns[0].args.some((a) => typeof a === 'string' && a.includes('rm -rf')));

    spawnResult = { status: 127, stdout: '', stderr: 'tar: not found' };
    assert.throws(() => pkg.zipPackage(dir, out), /Tar failed: tar: not found/);
  } finally {
    spawnResult = { status: 0, stdout: '', stderr: '' };
    Object.defineProperty(process, 'platform', origPlatformDesc);
  }
});

test('generateManifest 里嵌套目录路径统一用正斜杠（跨平台可读）', () => {
  const dir = makeFullPackage();
  const m = pkg.generateManifest(dir, { id: 1 }, { id: 1 });
  for (const f of [...m.files.workspaceSrc, ...m.files.workspaceDist]) {
    assert.ok(!f.path.includes('\\'), `backslash in ${f.path}`);
    assert.match(f.path, /^workspace\/(src|dist)\//);
  }
});
