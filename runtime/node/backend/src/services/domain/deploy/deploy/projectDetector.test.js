'use strict';

// Co-located tests for projectDetector.js. All filesystem access is injected
// through an in-memory fs-like object (existsSync/readFileSync), so detection
// runs with zero real I/O. One end-to-end case uses a real tmp dir to cover
// the defaultFs path.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const det = require('./projectDetector');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-detector-'));

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

function memFs(files = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [path.resolve('/proj', k), v]));
  const rp = (p) => path.resolve(p);
  return {
    existsSync: (p) => map.has(rp(p)),
    readFileSync: (p) => {
      if (!map.has(rp(p))) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      const v = map.get(rp(p));
      if (typeof v !== 'string') { const e = new Error(`EISDIR: ${p}`); e.code = 'EISDIR'; throw e; }
      return v;
    },
  };
}

const DIR = '/proj';

describe('resolveExe', () => {
  test('win32 下 npm/npx/pnpm/yarn 补 .cmd 后缀', () => {
    for (const n of ['npm', 'npx', 'pnpm', 'yarn']) assert.equal(det.resolveExe(n, 'win32'), `${n}.cmd`);
  });

  test('node/go/cargo 等非包装器与 linux 平台不加后缀', () => {
    assert.equal(det.resolveExe('node', 'win32'), 'node');
    assert.equal(det.resolveExe('go', 'win32'), 'go');
    assert.equal(det.resolveExe('npm', 'linux'), 'npm');
    assert.equal(det.resolveExe('npm', undefined), 'npm');
  });
});

describe('node 项目', () => {
  const pkg = (o) => JSON.stringify(o);

  test('有 start 脚本 + lockfile → npm.cmd ci / npm.cmd run start（win32）', () => {
    const plan = det.detectProject(DIR, {
      fs: memFs({ 'package.json': pkg({ scripts: { start: 'node s.js', build: 'webpack' } }), 'package-lock.json': '' }),
      platform: 'win32',
    });
    assert.equal(plan.type, 'node');
    assert.equal(plan.packageManager, 'npm');
    assert.equal(plan.install.exe, 'npm.cmd');
    assert.deepEqual(plan.install.args, ['ci']);
    assert.deepEqual(plan.build.args, ['run', 'build']);
    assert.deepEqual(plan.start.args, ['run', 'start']);
    assert.equal(plan.start.display, 'npm.cmd run start');
    assert.deepEqual(plan.signals, ['package.json', 'lockfile']);
  });

  test('pnpm/yarn/bun lockfile 决定 packageManager 与命令形态', () => {
    const p1 = det.detectProject(DIR, { fs: memFs({ 'package.json': pkg({ scripts: { start: 'x' } }), 'pnpm-lock.yaml': '' }), platform: 'linux' });
    assert.equal(p1.packageManager, 'pnpm');
    assert.deepEqual(p1.install.args, ['install']);
    assert.deepEqual(p1.start.args, ['run', 'start']);
    const p2 = det.detectProject(DIR, { fs: memFs({ 'package.json': pkg({ scripts: { start: 'x' } }), 'yarn.lock': '' }), platform: 'linux' });
    assert.equal(p2.packageManager, 'yarn');
    assert.deepEqual(p2.start.args, ['start'], 'yarn run 省略 run 子命令');
  });

  test('KNOWN-DEFECT: win32 下 bun lockfile 产出的裸 `bun` 命令缺 .cmd 解析分支', () => {
    // projectDetector.js:45 — resolveExe's win32 list covers only
    // npm/npx/pnpm/yarn. bun also ships as a .cmd shim on Windows, so the
    // plan this detector emits for a bun project would fail on spawn with the
    // exact "bare names fail spawn" the comment warns about.
    const plan = det.detectProject(DIR, { fs: memFs({ 'package.json': pkg({ scripts: { start: 'x' } }), 'bun.lockb': '' }), platform: 'win32' });
    assert.equal(plan.packageManager, 'bun');
    assert.equal(plan.install.exe, 'bun');
    assert.equal(det.resolveExe('bun', 'win32'), 'bun');
  });

  test('无 lockfile 时 packageManager 字段兜底；未知字段值回退 npm', () => {
    const s = { 'package.json': pkg({ packageManager: 'pnpm@9.1.0', scripts: { start: 'x' } }) };
    assert.equal(det.detectProject(DIR, { fs: memFs(s), platform: 'linux' }).packageManager, 'pnpm');
    const s2 = { 'package.json': pkg({ packageManager: 'deno@1', scripts: { start: 'x' } }) };
    assert.equal(det.detectProject(DIR, { fs: memFs(s2), platform: 'linux' }).packageManager, 'npm');
  });

  test('无 start 脚本回退 main，再回退常见入口文件，并留下诚实 note', () => {
    const p1 = det.detectProject(DIR, { fs: memFs({ 'package.json': pkg({ main: 'lib/entry.js' }), 'lib/entry.js': '' }), platform: 'linux' });
    assert.deepEqual(p1.start, { exe: 'node', args: ['lib/entry.js'], display: 'node lib/entry.js' });
    assert.ok(p1.notes.some((n) => n.includes('main')));
    const p2 = det.detectProject(DIR, { fs: memFs({ 'package.json': pkg({}), 'dist/index.js': '' }), platform: 'linux' });
    assert.deepEqual(p2.start.args, ['dist/index.js']);
    assert.ok(p2.notes.some((n) => n.includes('dist/index.js')));
  });

  test('main 声明了但文件不存在时不虚构命令，start 保持 null', () => {
    const p = det.detectProject(DIR, { fs: memFs({ 'package.json': pkg({ main: 'ghost.js' }) }), platform: 'linux' });
    assert.equal(p.start, null);
    assert.ok(p.notes.some((n) => n.includes('--cmd')));
  });

  test('package.json 损坏 → 仍识别为 node，脚本面按空对象处理', () => {
    const p = det.detectProject(DIR, { fs: memFs({ 'package.json': '{broken' }), platform: 'linux' });
    assert.equal(p.type, 'node');
    assert.equal(p.packageManager, 'npm');
    assert.deepEqual(p.install.args, ['install']);
    assert.equal(p.build, null);
  });

  test('detectNodePackageManager 优先 lockfile 而非声明字段', () => {
    const pm = det.detectNodePackageManager(memFs({ 'package.json': JSON.stringify({ packageManager: 'yarn@3' }), 'package-lock.json': '' }), DIR, { packageManager: 'yarn@3' });
    assert.equal(pm, 'npm');
  });
});

describe('python 项目', () => {
  test('requirements.txt 决定安装命令；win32 用 python，其他用 python3', () => {
    const w = det.detectProject(DIR, { fs: memFs({ 'requirements.txt': '' , 'app.py': '' }), platform: 'win32' });
    assert.equal(w.type, 'python');
    assert.equal(w.install.exe, 'python');
    assert.deepEqual(w.install.args, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
    assert.deepEqual(w.start, { exe: 'python', args: ['app.py'], display: 'python app.py' });
    const l = det.detectProject(DIR, { fs: memFs({ 'pyproject.toml': '', 'main.py': '' }), platform: 'linux' });
    assert.equal(l.install.exe, 'python3');
    assert.deepEqual(l.install.args, ['-m', 'pip', 'install', '.']);
  });

  test('Procfile web 行优先于 manage.py 与入口文件', () => {
    const p = det.detectProject(DIR, {
      fs: memFs({ 'requirements.txt': '', 'Procfile': 'web: gunicorn app:main -b 0.0.0.0:5000\nworker: x\n', 'manage.py': '' }),
      platform: 'linux',
    });
    assert.equal(p.start.exe, 'gunicorn');
    assert.deepEqual(p.start.args, ['app:main', '-b', '0.0.0.0:5000']);
    assert.equal(p.port, null, 'Procfile 分支不设端口');
    assert.ok(p.signals.includes('Procfile'));
  });

  test('KNOWN-DEFECT: Procfile 的空 web 行产出 exe 为空串的启动命令', () => {
    // projectDetector.js:211-218 — `command.split(/\s+/)` on an empty web
    // line yields [''], so the plan carries exe:'' which the runner would
    // hand straight to spawnSync. An "unknown" note would be honest here.
    const p = det.detectProject(DIR, {
      fs: memFs({ 'requirements.txt': '', 'Procfile': 'web:' }),
      platform: 'linux',
    });
    assert.equal(p.start.exe, '');
    assert.deepEqual(p.start.args, []);
    assert.equal(p.start.display, '');
  });

  test('Django manage.py → runserver 且端口 8000；无任何入口则诚实报未知', () => {
    // Dispatch only enters the python branch via requirements/pyproject/setup;
    // manage.py alone is NOT a dispatch signal, so a bare Django repo with no
    // dependency file lands in 'unknown' with start/install both null.
    const p = det.detectProject(DIR, { fs: memFs({ 'requirements.txt': '', 'manage.py': '' }), platform: 'win32' });
    assert.equal(p.type, 'python');
    assert.equal(p.start.exe, 'python');
    assert.deepEqual(p.start.args, ['manage.py', 'runserver']);
    assert.equal(p.port, 8000);
    assert.ok(p.install.args.join(' ').includes('requirements.txt'), 'requirements 分支产出 pip -r');
    const bare = det.detectProject(DIR, { fs: memFs({ 'manage.py': '' }), platform: 'win32' });
    assert.equal(bare.type, 'unknown');
    assert.equal(bare.start, null);
    assert.equal(bare.install, null, '没有 requirements/pyproject/setup 就没有安装命令');
    const q = det.detectProject(DIR, { fs: memFs({ 'setup.py': '' }), platform: 'linux' });
    assert.equal(q.start, null);
    assert.ok(q.notes.some((n) => n.includes('无法确定')));
  });
});

describe('其他类型与优先级', () => {
  test('go/rust/docker/static 各产出约定命令与信号', () => {
    const go = det.detectProject(DIR, { fs: memFs({ 'go.mod': '' }), platform: 'linux' });
    assert.deepEqual(go.install, { exe: 'go', args: ['mod', 'download'], display: 'go mod download' });
    assert.deepEqual(go.build.args, ['build', './...']);
    const rs = det.detectProject(DIR, { fs: memFs({ 'Cargo.toml': '' }), platform: 'linux' });
    assert.deepEqual(rs.build.args, ['build', '--release']);
    const docker = det.detectProject(DIR, { fs: memFs({ 'Dockerfile': '' }), platform: 'linux' });
    assert.equal(docker.start, null);
    const st = det.detectProject(DIR, { fs: memFs({ 'index.html': '' }), platform: 'win32' });
    assert.deepEqual(st.start, { exe: 'python', args: ['-m', 'http.server', '8080'], display: 'python -m http.server 8080' });
    assert.equal(st.port, 8080);
  });

  test('多清单并存时 node 优先、python 次之、go 先于 rust', () => {
    const p = det.detectProject(DIR, { fs: memFs({ 'package.json': '{}', 'requirements.txt': '' }), platform: 'linux' });
    assert.equal(p.type, 'node');
    const q = det.detectProject(DIR, { fs: memFs({ 'requirements.txt': '', 'go.mod': '' }), platform: 'linux' });
    assert.equal(q.type, 'python');
    const r = det.detectProject(DIR, { fs: memFs({ 'go.mod': '', 'Cargo.toml': '', 'Dockerfile': '', 'index.html': '' }), platform: 'linux' });
    assert.equal(r.type, 'go');
  });

  test('Makefile 目标解析：tab 缩进的 recipe 行不算目标', () => {
    const ok = det.detectProject(DIR, { fs: memFs({ Makefile: 'build:\n\techo x\nstart:\n\techo y\n' }), platform: 'linux' });
    assert.deepEqual(ok.build.args, ['build']);
    assert.deepEqual(ok.start.args, ['start']);
    const bad = det.detectProject(DIR, { fs: memFs({ Makefile: 'all:\n\trun: nested\n' }), platform: 'linux' });
    assert.equal(bad.start, null);
    assert.ok(bad.notes.some((n) => n.includes('无 run/start/serve 目标')));
  });

  test('空目录 → unknown，且 notes 指向 --cmd', () => {
    const p = det.detectProject(DIR, { fs: memFs({}), platform: 'linux' });
    assert.equal(p.type, 'unknown');
    assert.equal(p.start, null);
    assert.deepEqual(p.signals, []);
    assert.ok(p.notes.length === 1 && p.notes[0].includes('--cmd'));
  });

  test('默认 fs（真实 tmp 目录）能读包并给出 win/linux 一致的计划形态', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'real-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node s.js' } }));
    const p = det.detectProject(dir, { platform: 'linux' });
    assert.equal(p.type, 'node');
    assert.deepEqual(p.start, { exe: 'npm', args: ['run', 'start'], display: 'npm run start' });
  });

  test('fs.existsSync 抛错时按不存在处理（exists 包装吞异常）', () => {
    const hostile = { existsSync: () => { throw new Error('EACCES'); }, readFileSync: () => { throw new Error('no'); } };
    const p = det.detectProject(DIR, { fs: hostile, platform: 'linux' });
    assert.equal(p.type, 'unknown');
  });
});
