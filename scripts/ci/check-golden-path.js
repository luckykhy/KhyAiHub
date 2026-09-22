#!/usr/bin/env node
'use strict';

/**
 * check-golden-path.js — 端到端黄金路径验证（[DESIGN-DELIV-001] D9）。
 *
 * ## 为什么需要它
 *
 * [DESIGN-DELIV-001] D9：**"从零到可运行"必须有一条被端到端验证过的路径**。
 * 本仓此前只有一条 MANUAL 承诺（scripts/release/lib/releaseGateStages.js 的
 * `fresh-install` 环境门，内容是 `pip install khy-os && khy --version && khy doctor`），
 * 由人在某台干净机器上手敲。MANUAL 的意思是**没有人验证过**——它进不了 CI，
 * 也无法在生产事故时回答"上一次验证是什么时候"。
 *
 * 本脚本把那句话变成机器可执行、可重复、有退出码的验证。
 *
 * ## 判据真源（不得在本文件内硬编码命令）
 *
 * 要验证哪条路径，来自 `[DESIGN-DELIV-002] 产品任务面与交付律.md` §4 的
 * ```json khy-delivery-surface/1``` 代码块里每个渠道的 `goldenPath` 字段
 * （pypi / npm / docker 各有一条）。本脚本**只读**它，并在输出里回显被验证的
 * 声明原文，读到哪条验证哪条。声明被改动而本脚本未跟随 → 输出会出现
 * `drift` 提示，而不是静默按老命令跑。
 *
 * ## 语义（诚实优先：绝不用 SKIP 冒充 PASS）
 *
 *   PASS —— 路径真的跑完了，且断言全部成立。
 *   FAIL —— 路径跑起来了，但断言不成立（安装失败 / 版本不符 / doctor 有硬失败）。
 *   SKIP —— 前置不满足，**本次没有验证任何东西**。每一条 SKIP 都必须打印缺失
 *           的前置是什么，以及补上它的命令。SKIP 不是 PASS 的近义词：本脚本
 *           退出码为 0 只是不阻断双渠道，读数上必须读成"未验证"。
 *
 * 这正是本仓两次踩过的「空转断言」形态（check-zcode-baseline.js 打印 PASS 却恒
 * 返回 0、source-hygiene-scan.js 自述 ALWAYS exits 0）的反面：**跑不动就说跑不动**。
 *
 * ## 落地阶段（PROCESS-008 PP-1）
 *
 * 本检查是**报告型**（enterprise fail-soft）：缺前置 → SKIP + exit 0，与
 * scripts/release/verify-android-signature.js 同款。它是发布门里的一个
 * `recommended` 阶段，不构成新的阻断型机制，故无需从 S1 起步。
 *
 * 纪律：[RUNTIME-001] 无字面量路径/主机（根由 __dirname 推导，解释器与端口可
 * env 覆盖）；[RUNTIME-002] 每条状态含动作+目标+进度；[RUNTIME-003] 只对短探测
 * 设上限，安装步不设任务截止（见 PROBE_TIMEOUT_MS 注释）；[RUNTIME-004] 无滚动区。
 *
 * Usage:
 *   node scripts/ci/check-golden-path.js                  # 验全部渠道
 *   node scripts/ci/check-golden-path.js --only pypi      # 只验一条
 *   node scripts/ci/check-golden-path.js --json           # 机读
 *   node scripts/ci/check-golden-path.js --explain        # 打印判据与真源
 * Env:
 *   KHY_GOLDEN_ROOT     仓库根覆盖（测试用）
 *   KHY_GOLDEN_PYTHON   python 解释器（默认按平台探测 python3/python/py）
 *   KHY_GOLDEN_DOCKER   docker CLI 可执行文件（默认从 PATH 解析 `docker`；
 *                       Windows 便携版 Docker Desktop 常常不在 PATH 上 —— 实测
 *                       D:\Portable\Apps\DockerDesktop\resources\bin\docker.exe 能跑，
 *                       但 PATH 里没有，默认读数会退化成"本机没有 docker CLI"）
 *   KHY_GOLDEN_KEEP_TMP 设为 1 时保留临时安装目录（排查用）
 * Exit: 0 全部 PASS 或 SKIP · 1 有 FAIL · 2 用法错误
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = process.env.KHY_GOLDEN_ROOT
  ? path.resolve(process.env.KHY_GOLDEN_ROOT)
  : path.resolve(__dirname, '..', '..');

const THRESHOLD_DOC_REL = 'docs/10_规范/其它规范/[DESIGN-DELIV-002] 产品任务面与交付律.md';
const THRESHOLD_SCHEMA = 'khy-delivery-surface/1';

/**
 * 短探测的上限，属 [RUNTIME-003] 合法例外（≤10s 的握手/探测超时）。
 * 只用于 `--version` 这类"读一行就返回"的调用，防的是挂死的 I/O。
 * 安装与 doctor 跑的是真任务，**不设**任务截止：卡住了就让它卡住并如实显示，
 * 而不是到点砍掉一个仍在推进的安装（规则 3 的红线）。
 */
const PROBE_TIMEOUT_MS = 10000;

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const explainMode = args.includes('--explain');
const onlyIdx = args.indexOf('--only');
const onlyChannel = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '') : '';
if (args.some((a) => a.startsWith('-') && !['--json', '--explain', '--only'].includes(a) && a !== onlyChannel)) {
  process.stderr.write('用法：node scripts/ci/check-golden-path.js [--json] [--explain] [--only <channel>]\n');
  process.exit(2);
}

const log = (s) => process.stdout.write(`${s}\n`);

// ── 事实采集（全部 fail-soft：读不到返回 null，绝不抛） ──────────────────────

const readText = (rel) => {
  try {
    const abs = path.join(ROOT, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
};

const relExists = (rel) => {
  try {
    return fs.existsSync(path.join(ROOT, rel));
  } catch {
    return false;
  }
};

/**
 * 已声明交付渠道与其 goldenPath 的唯一真源。
 * 缺文档或代码块 → 返回 null，调用方报 UNKNOWN 并退出 0（不假装验证过）。
 */
function loadChannels() {
  const text = readText(THRESHOLD_DOC_REL);
  if (text === null) return { ok: false, reason: `阈值真源文档不存在：${THRESHOLD_DOC_REL}` };
  const fence = /```json\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue; // 同文档里的其它示例块与本块无关
    }
    if (parsed && parsed.$schema === THRESHOLD_SCHEMA) {
      return { ok: true, channels: parsed.channels || {} };
    }
  }
  return { ok: false, reason: `文档里找不到 $schema=${THRESHOLD_SCHEMA} 的 json 代码块` };
}

/** pyproject.toml 的 [project] version —— 安装后版本比对的锚。 */
function expectedPipVersion() {
  const text = readText('pyproject.toml');
  if (!text) return null;
  const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text);
  return m ? m[1] : null;
}

/** 跨平台 python 解释器：env 覆盖优先，其次按平台探测。 */
function resolvePython() {
  if (process.env.KHY_GOLDEN_PYTHON) return process.env.KHY_GOLDEN_PYTHON;
  const isWin = process.platform === 'win32';
  const candidates = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = cp.spawnSync(c, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/** dist/ 下最新的非空 wheel。 */
function newestWheel() {
  const dir = path.join(ROOT, 'dist');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const wheels = entries.filter((f) => f.endsWith('.whl'));
  let best = null;
  for (const w of wheels) {
    const abs = path.join(dir, w);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.size <= 0) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { abs, name: w, size: st.size, mtimeMs: st.mtimeMs };
  }
  return best;
}

/** fail-soft 运行一个子进程，返回 {status,out,err,error}。timeoutMs 只在短探测时给。 */
function run(cmd, argv, opts = {}) {
  const r = cp.spawnSync(cmd, argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return {
    error: r.error ? r.error.code || r.error.message : null,
    status: typeof r.status === 'number' ? r.status : -1,
    out: r.stdout || '',
    err: r.stderr || '',
  };
}

const tmpRoots = [];
function makeTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-golden-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}

function cleanup() {
  if (process.env.KHY_GOLDEN_KEEP_TMP === '1') return;
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
}

// ── 渠道验证实现 ────────────────────────────────────────────────────────────

/**
 * pypi 通道：声明的 goldenPath 形如
 *   `pip install khy-os && khy doctor --check`
 * 本地可验证的等价物：**安装刚构建出的那个 wheel**，再跑同一条 doctor 自检。
 * 用 dist/*.whl 而不是从 PyPI 拉，是因为发布门要判的是"这一批产物能不能装"，
 * 而不是"已经发布的旧版还能不能装"。
 *
 * 优先用 venv 装（最接近用户：独立的 site-packages + 真正的 khy 控制台脚本）。
 * venv 不可用时（部分便携版 Python 裁掉了 venv 模块）退化为
 * `pip install --target` + `python -m khy_platform`：仍证明"能装上、能起来"，
 * 但不覆盖控制台脚本 shim，输出里如实标注这一点。
 */
function verifyPypi(declared) {
  const py = resolvePython();
  if (!py) return { status: 'SKIP', reason: '本机没有可用的 python 解释器（设 KHY_GOLDEN_PYTHON 指定）' };
  const wheel = newestWheel();
  if (!wheel) {
    return {
      status: 'SKIP',
      reason: 'dist/ 下没有非空 *.whl —— 先跑：npm run build:pip（或 bash scripts/release/build-and-audit-pip-purity.sh）',
    };
  }
  const expected = expectedPipVersion();
  const tmp = makeTmp('pypi');

  const venvDir = path.join(tmp, 'venv');
  const mkvenv = run(py, ['-m', 'venv', venvDir], { timeout: undefined });
  const useVenv = !mkvenv.error && mkvenv.status === 0;
  const steps = [];

  let pyExe = py;
  let entryLabel = '';
  if (useVenv) {
    const isWin = process.platform === 'win32';
    pyExe = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
    entryLabel = isWin ? path.join(venvDir, 'Scripts', 'khy.exe') : path.join(venvDir, 'bin', 'khy');
    steps.push(`venv: ${venvDir}`);
  } else {
    const target = path.join(tmp, 'site');
    fs.mkdirSync(target, { recursive: true });
    steps.push(`venv 不可用（${mkvenv.err.split(/\r?\n/)[0] || mkvenv.error || '未知原因'}）→ 回退 pip --target`);
    const inst = run(py, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--no-deps', '--target', target, wheel.abs], {
      timeout: undefined,
    });
    steps.push(`pip install --target → 退出码 ${inst.status}`);
    if (inst.status !== 0) {
      return { status: 'FAIL', reason: `wheel 装不上：${(inst.err || inst.out).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`, steps };
    }
    // ⚠ 回退路径必须用 `-S` 起进程，否则**测的不是这份安装**：
    // 本机若装过 khy-os（尤其 editable 安装），setuptools 的 editable finder 是
    // meta-path finder，优先于 sys.path，PYTHONPATH 压不过它——实测本机就读到了
    // 仓库源码里的 1.1.11 而非 target 里的 1.2.0。`-S` 不加载 site 模块 ⇒ 不处理
    // site-packages 的 .pth / editable finder，只留显式 sys.path。khy-os 是零依赖
    // 包，因此"关掉 site-packages"不会误伤它自己的依赖。
    const launcher = path.join(tmp, 'run_khy.py');
    fs.writeFileSync(
      launcher,
      [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(target)})`,
        'from khy_platform.cli import main',
        "sys.argv = ['khy'] + sys.argv[1:]",
        'main()',
        '',
      ].join('\n'),
      'utf8'
    );
    const iso = ['-S', launcher];
    const ver = run(py, [...iso, '--version'], { cwd: tmp, timeout: PROBE_TIMEOUT_MS });
    const verText = `${ver.out}${ver.err}`;
    const got = /khy-os version:\s*([0-9][^\s]*)/.exec(verText) || /^\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(verText);
    steps.push(`khy --version（-S 隔离）→ 退出码 ${ver.status}，读数 ${got ? got[1] : '(未解析到)'}`);
    if (ver.status !== 0 || !got) {
      return { status: 'FAIL', reason: `安装后 khy --version 未输出可解析版本（退出码 ${ver.status}）：${verText.trim().split(/\r?\n/).pop() || '(无输出)'}`, steps };
    }
    if (expected && got[1] !== expected) {
      return { status: 'FAIL', reason: `装出来的版本是 ${got[1]}，pyproject.toml 声明 ${expected} —— 产物与真源不一致`, steps };
    }
    const doc = run(py, [...iso, 'doctor', '--json'], { cwd: tmp, timeout: undefined });
    return judgeDoctor(doc, steps, `${py} -S ${path.basename(launcher)}（无 venv 回退：不覆盖控制台脚本 shim）`);
  }

  const inst = run(pyExe, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--no-deps', wheel.abs], {
    timeout: undefined,
  });
  steps.push(`venv pip install ${wheel.name} → 退出码 ${inst.status}`);
  if (inst.status !== 0) {
    return { status: 'FAIL', reason: `wheel 装不进干净的 venv：${(inst.err || inst.out).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`, steps };
  }
  const hasScript = fs.existsSync(entryLabel);
  const verArgv = hasScript ? [entryLabel, '--version'] : [pyExe, '-m', 'khy_platform', '--version'];
  if (!hasScript) steps.push(`venv 里没有 ${path.basename(entryLabel)} 控制台脚本，退化为 python -m khy_platform`);
  const ver = run(verArgv[0], verArgv.slice(1), { cwd: tmp, timeout: PROBE_TIMEOUT_MS });
  const verText = `${ver.out}${ver.err}`;
  const got = /khy-os version:\s*([0-9][^\s]*)/.exec(verText);
  steps.push(`khy --version → 退出码 ${ver.status}，读数 ${got ? got[1] : '(未解析到)'}`);
  if (ver.status !== 0 || !got) {
    return { status: 'FAIL', reason: `干净装出来的 khy --version 失败（退出码 ${ver.status}）：${verText.trim().split(/\r?\n/).pop() || '(无输出)'}`, steps };
  }
  if (expected && got[1] !== expected) {
    return { status: 'FAIL', reason: `装出来的版本是 ${got[1]}，pyproject.toml 声明 ${expected} —— 产物与真源不一致`, steps };
  }
  // doctor 走模块入口（与控制台脚本同一条代码路径），避免不同平台上 shim 后缀差异。
  const doc = run(pyExe, ['-m', 'khy_platform', 'doctor', '--json'], { cwd: tmp, timeout: undefined });
  return judgeDoctor(doc, steps, hasScript ? entryLabel : `${pyExe} -m khy_platform`);
}

/**
 * doctor 判据：声明的 goldenPath 以 `khy doctor` 收尾，所以这里判的就是它。
 * `counts.fail` 是项目自己的硬失败口径（level=error 的检查项），
 * 只有它为 0 才算"陌生机器上装完能起来"。warn 不判红（那是环境差异，不是交付缺陷）。
 */
function judgeDoctor(doc, steps, entryLabel) {
  const text = `${doc.out}${doc.err}`;
  if (doc.status !== 0) {
    return { status: 'FAIL', reason: `khy doctor 退出码 ${doc.status}：${text.trim().split(/\r?\n/).pop() || '(无输出)'}`, steps };
  }
  let parsed;
  try {
    parsed = JSON.parse(doc.out);
  } catch {
    return { status: 'FAIL', reason: 'khy doctor --json 输出不是合法 JSON ⇒ 无法判定自检结果', steps };
  }
  const counts = parsed.counts || {};
  steps.push(`doctor: ok=${counts.ok} warn=${counts.warn} fail=${counts.fail}（入口 ${entryLabel}）`);
  if (Number(counts.fail) > 0) {
    // 列出**具体哪几项**失败。只报计数等于把定位工作全推给读者：装机差异、
    // 打包布局错位、首次运行状态三类原因的修法完全不同，读者需要知道是哪一类。
    // 取 doctor 自身的检查结构（freshInstallDoctor.js 的 _check：{category,label,ok,detail,level}）。
    // ⚠ 必须按 level 分级显示：`counts.fail` 只数 level=error 的项，而返回里
    //   ok===false 的项里还混着 warn/指引级（"akshare 未安装"、"未登录"这类）。
    //   把两者混排成一个列表，读者会看到 12 项而 summary 说 7 项 —— 口径不一致
    //   本身就是一种隐瞒，所以硬失败与指引分开打印。
    const notOk = (Array.isArray(parsed.checks) ? parsed.checks : []).filter((c) => c && c.ok === false);
    const describe = (c) =>
      `${c.label || c.category || '(未命名检查)'} — ${String(c.detail || '').split(/\r?\n/)[0].slice(0, 150)}`;
    const hard = notOk.filter((c) => !c.level || c.level === 'error');
    const soft = notOk.filter((c) => c.level && c.level !== 'error');
    for (const c of hard.slice(0, 10)) steps.push(`硬失败: ${describe(c)}`);
    if (hard.length > 10) steps.push(`…另有 ${hard.length - 10} 项硬失败，完整读数请直接跑 khy doctor`);
    for (const c of soft.slice(0, 6)) steps.push(`指引(${c.level}): ${describe(c)}`);
    if (soft.length > 6) steps.push(`…另有 ${soft.length - 6} 项指引级未通过（不参与硬失败计数）`);
    return {
      status: 'FAIL',
      reason: `干净装出来的环境有 ${counts.fail} 项硬失败（doctor status=${parsed.status}）⇒ 陌生人装完起不来`,
      steps,
    };
  }
  return { status: 'PASS', reason: `安装 → khy --version → khy doctor 全部通过（${counts.total} 项检查，0 硬失败）`, steps };
}

/**
 * 从 npm 的原始输出里挑出**病因行**，而不是末行。
 *
 * 实测：npm 失败时末行是 `A complete log of this run can be found in: <路径>`——
 * 照抄它等于把定位工作推给读者去翻日志；真正的原因在 stdout 里，形如
 * `[audit:purity FAIL] package.json declares postinstall`（prepack 钩子里的第一手判定）。
 * 优先取带方括号的判定行（本仓各检查器的统一方言），其次 `npm error` 行，
 * 最后才退化为末行。
 */
function npmCause(res) {
  const lines = `${res.out}${res.err}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tagged = lines.filter((l) => /\[[^\]]*(FAIL|ERROR)[^\]]*\]/i.test(l));
  if (tagged.length) return tagged.slice(0, 3).join(' · ');
  const errs = lines.filter((l) => /^npm (error|ERR!)/i.test(l) && !/A complete log|^npm error code/i.test(l));
  if (errs.length) return errs.slice(0, 3).join(' · ');
  return lines[lines.length - 1] || '(无输出)';
}

/**
 * npm 通道：声明的 goldenPath 形如 `npm i -g @khy-os/khy-os && khy doctor --check`。
 * 本地可验证的等价物：把 packaging/npm 打成 tarball 装进临时 prefix，再跑同一条自检。
 * 前置：`npm run assemble` 产出的 bundled/ 运行时（audit-purity 也要求它存在）。
 */
function verifyNpm(declared) {
  const pkgDir = path.join(ROOT, 'packaging', 'npm');
  if (!relExists('packaging/npm/package.json')) return { status: 'SKIP', reason: 'packaging/npm/package.json 不存在' };
  if (!relExists('packaging/npm/bundled/runtime/khy/bundle.mjs')) {
    return {
      status: 'SKIP',
      reason: '缺 packaged 运行时 packaging/npm/bundled/runtime/khy/bundle.mjs —— 先跑：cd packaging/npm && npm run assemble',
    };
  }
  const tmp = makeTmp('npm');
  const pack = run('npm', ['pack', '--pack-destination', tmp], { cwd: pkgDir, timeout: undefined, shell: process.platform === 'win32' });
  const tarball = (pack.out.match(/([^\s]+\.tgz)/) || [])[1];
  const steps = [`npm pack → 退出码 ${pack.status}`];
  if (pack.status !== 0 || !tarball) {
    return { status: 'FAIL', reason: `npm pack 失败（prepack 钩子在包发出去之前就拦下了）：${npmCause(pack)}`, steps };
  }
  const tap = path.join(tmp, 'tarball.tgz');
  try {
    fs.copyFileSync(path.join(tmp, path.basename(tarball)), tap);
  } catch {
    return { status: 'FAIL', reason: `找不到 pack 出的 tarball：${tarball}`, steps };
  }
  const prefix = path.join(tmp, 'prefix');
  const inst = run('npm', ['install', '-g', '--prefix', prefix, tap], { cwd: tmp, timeout: undefined, shell: process.platform === 'win32' });
  steps.push(`npm install -g --prefix → 退出码 ${inst.status}`);
  if (inst.status !== 0) {
    return { status: 'FAIL', reason: `tarball 装不进干净 prefix：${npmCause(inst)}`, steps };
  }
  const isWin = process.platform === 'win32';
  const bin = isWin ? path.join(prefix, 'khy.cmd') : path.join(prefix, 'bin', 'khy');
  const ver = run(bin, ['--version'], { cwd: tmp, timeout: PROBE_TIMEOUT_MS, shell: isWin });
  const verText = `${ver.out}${ver.err}`;
  const m = /khy-os version:\s*([0-9][^\s]*)/.exec(verText) || /([0-9]+\.[0-9]+\.[0-9]+)/.exec(verText);
  steps.push(`khy --version → 退出码 ${ver.status}，读数 ${m ? m[1] : '(未解析到)'}`);
  if (ver.status !== 0 || !m) {
    return { status: 'FAIL', reason: `装出来的 npm 包 khy --version 失败（退出码 ${ver.status}）：${verText.trim().split(/\r?\n/).pop() || '(无输出)'}`, steps };
  }
  const doc = run(bin, ['doctor', '--json'], { cwd: tmp, timeout: undefined, shell: isWin });
  return judgeDoctor(doc, steps, bin);
}

/**
 * docker 通道：声明的 goldenPath 是 `docker compose up -d --build`。
 * 真跑要拉基础镜像并起容器（数分钟、需要 daemon），不适合放进每次发布门，
 * 故本机只做**配置可解析性**这一层验证，并如实标注这不是端到端。
 * 起容器的端到端留给 `--profile` 部署演练（[DESIGN-DEPLOY-001] §3.3）。
 *
 * 两条 SKIP 都必须回答"缺什么前置、怎么补"——SKIP 的读者正是想补上它的人：
 *   缺 CLI   → 装 Docker，或用 KHY_GOLDEN_DOCKER 指向已有的可执行文件
 *   缺 daemon → 换一台有 daemon 的主机，或走 docker.yml CI
 */
function resolveDocker() {
  return process.env.KHY_GOLDEN_DOCKER || 'docker';
}

/** daemon 是否可达（`docker info` 是短探测，10s 上限；不是任务截止）。 */
function dockerDaemonProbe(cli) {
  const r = run(cli, ['info', '--format', '{{.ServerVersion}}'], { timeout: PROBE_TIMEOUT_MS, shell: process.platform === 'win32' });
  if (r.error || r.status !== 0) {
    const why = `${r.err}${r.out}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    return { ok: false, why: why || r.error || `退出码 ${r.status}` };
  }
  return { ok: true, version: r.out.trim() };
}

function verifyDocker() {
  const cli = resolveDocker();
  const shell = process.platform === 'win32';
  const probe = run(cli, ['--version'], { timeout: PROBE_TIMEOUT_MS, shell });
  if (probe.error || probe.status !== 0) {
    return {
      status: 'SKIP',
      reason:
        `缺前置：本机没有可用的 docker CLI（试过 \`${cli}\`：${probe.error || `退出码 ${probe.status}`}）⇒ 容器渠道未验证。` +
        `补上它：装 Docker，或把 KHY_GOLDEN_DOCKER 指向已有的 docker 可执行文件，再重跑 npm run check:golden-path -- --only docker`,
    };
  }
  if (!relExists('docker-compose.yml')) return { status: 'FAIL', reason: 'docker CLI 可用但 docker-compose.yml 不存在' };
  const cfg = run(cli, ['compose', '-f', 'docker-compose.yml', 'config', '--quiet'], {
    cwd: ROOT,
    timeout: undefined,
    shell,
  });
  if (cfg.status !== 0) {
    return { status: 'FAIL', reason: `docker compose 配置不可解析：${(cfg.err || cfg.out).trim().split(/\r?\n/).pop() || '(无输出)'}` };
  }
  const daemon = dockerDaemonProbe(cli);
  return {
    status: 'SKIP',
    reason: daemon.ok
      ? `docker compose 配置可解析（已验）· 本机 daemon 可达（server ${daemon.version}）⇒ 端到端仍未验证。` +
        `补上它：在演练主机跑 docker compose up -d --build（[DESIGN-DEPLOY-001] §3.3）`
      : `docker compose 配置可解析（已验）· 本机 daemon 不可达（${daemon.why}）⇒ up -d --build 在本机跑不了，端到端仍未验证。` +
        `补上它：在有 daemon 的主机或 docker.yml CI 上跑 docker compose up -d --build`,
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  const loaded = loadChannels();
  const results = [];
  if (!loaded.ok) {
    results.push({ channel: '-', status: 'UNKNOWN', declared: '', reason: loaded.reason });
  } else {
    const ch = loaded.channels;
    const wanted = onlyChannel ? [onlyChannel] : ['pypi', 'npm', 'docker', 'portable', 'electron', 'android', 'nsis'];
    for (const name of wanted) {
      const cfg = ch[name];
      if (!cfg || typeof cfg !== 'object') {
        results.push({ channel: name, status: 'SKIP', declared: '', reason: '阈值真源里没有该渠道的声明' });
        continue;
      }
      const declared = String(cfg.goldenPath || '');
      if (cfg.ciWorkflow === null) {
        results.push({
          channel: name,
          status: 'SKIP',
          declared,
          reason: '边界文档声明本渠道不承诺交付（ciWorkflow=null）⇒ 无黄金路径可验',
        });
        continue;
      }
      if (!declared) {
        results.push({ channel: name, status: 'SKIP', declared, reason: '声明了渠道但没有 goldenPath 字段' });
        continue;
      }
      let r;
      if (name === 'pypi') r = verifyPypi(declared);
      else if (name === 'npm') r = verifyNpm(declared);
      else if (name === 'docker') r = verifyDocker();
      else r = { status: 'SKIP', reason: '本机没有该渠道的验证实现（需专用工具链）' };
      results.push({ channel: name, status: r.status, declared, reason: r.reason, steps: r.steps });
    }
  }

  const fails = results.filter((r) => r.status === 'FAIL');
  const passes = results.filter((r) => r.status === 'PASS');
  const skips = results.filter((r) => r.status === 'SKIP');
  const unknown = results.filter((r) => r.status === 'UNKNOWN');

  if (jsonMode) {
    log(JSON.stringify({ schema: 'khy-golden-path/1', root: ROOT, results, counts: { PASS: passes.length, FAIL: fails.length, SKIP: skips.length, UNKNOWN: unknown.length } }, null, 2));
  } else {
    log('== 黄金路径验证（[DESIGN-DELIV-001] D9）==');
    log(`根: ${ROOT}   真源: ${THRESHOLD_DOC_REL}`);
    log('-'.repeat(72));
    for (const r of results) {
      log(`[${String(r.status).padEnd(7)}] ${r.channel}`);
      if (r.declared) log(`          声明: ${r.declared}`);
      log(`          ${r.reason}`);
      for (const s of r.steps || []) log(`          · ${s}`);
    }
    log('-'.repeat(72));
    log(`汇总: PASS ${passes.length} · FAIL ${fails.length} · SKIP ${skips.length} · UNKNOWN ${unknown.length}`);
    if (skips.length) {
      log(`注: SKIP 表示**本次没有验证任何东西**（前置不满足），不是通过。`);
    }
    if (explainMode) {
      log('判据来源: [DESIGN-DELIV-001] §3 D9；声明与阈值见 [DESIGN-DELIV-002] §4 的 channels[].goldenPath。');
      log('语义: PASS=跑通且断言成立 · FAIL=跑起来但断言不成立 · SKIP=前置缺失，未验证。');
    }
  }

  cleanup();
  return fails.length > 0 ? 1 : 0;
}

process.exit(main());