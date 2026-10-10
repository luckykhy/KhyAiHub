#!/usr/bin/env node
'use strict';

/**
 * build-pip-dist.js — 跨平台产出 pip 发布物（entries/pip/*.whl + entries/pip/*.tar.gz）。
 *
 * ## 为什么需要它
 *
 * 产出 pip 发布物的唯一既有入口是 `scripts/release/build-and-audit-pip-purity.sh`，
 * 它需要 bash 与 python3 两个命令。Windows 上没有 bash（本仓交付物之一偏偏是
 * Windows 便携版），于是"能不能构建出发布物"取决于开发机装了哪个 shell——
 * 这与 [DESIGN-DELIV-001] D2「发布物必须真实存在」直接冲突：产物不存在时，
 * 所有下游判据（纯净度审计、D9 黄金路径、装出来能不能跑）全部无从谈起。
 *
 * 本脚本做同一件事，用 Node 编排，因此三个平台同一条命令：
 *   npm run build:pip
 *
 * ## 与 bash 孪生脚本的关系（防漂移）
 *
 * 步骤序列与 build-and-audit-pip-purity.sh 逐条一致：
 *   1. node scripts/release/assemble-pip-runtime.js      （装配零依赖运行时）
 *   2. python scripts/release/check_manifest_sync.py      （MANIFEST.in 与规则同源）
 *   3. 清理可再生的旧产物 → python -m build --sdist --wheel --outdir entries/pip
 *      （在**临时 cwd** 里以仓库为显式 srcdir 构建：setuptools 的 sdist 暂存目录
 *      `khy_os-<version>/` 落在 cwd 且并不总能被它自己清掉 —— 实测一次构建就能在
 *      仓库根留下 4825 个未跟踪文件。产物归 entries/pip/（[LAYOUT-005] 单一根），
 *      build/ 与 egg-info 残渣由本脚本搬进 entries/pip/{build,egg-info}。）
 *   4. python scripts/release/audit_pip_artifacts.py      （产物纯净度审计）
 *
 * 两条编排可以并存，但**判定不能有两份**：第 2 步与第 4 步是共享契约——MANIFEST
 * 一致性由 render_manifest() 单点生成，纯净度由 audit_pip_artifacts.py 单点判定。
 * 无论走哪条编排，产物必须过同一组判据；新增/修改排除规则只改
 * scripts/release/pip_packaging_rules.py 一处（改完跑 render_manifest.py 同步）。
 *
 * ## 隔离构建的降级
 *
 * `python -m build` 默认在隔离环境里构建（要联网取 build 依赖），隔离靠 venv 模块。
 * 部分便携版/裁剪版 Python 没有 venv（实测 D:\Portable\Python 即如此）⇒ 本脚本自动
 * 降级为 `--no-isolation`（要求本机已有 setuptools + wheel），并**明确打印降级原因**，
 * 因为隔离与非隔离产出的可复现性不同，读者有权知道这次是哪一种。bash 孪生脚本的
 * `--no-isolation` 选项是同一条降级路径的手动版本。
 *
 * 纪律：[RUNTIME-001] 无字面量路径（根由 __dirname 推导，解释器可 env 覆盖）；
 * [RUNTIME-002] 每条状态含动作+目标；[RUNTIME-003] **不对构建设任务截止**——构建是
 * 长任务，卡住就如实显示卡在哪一步，不到点砍掉仍在推进的工作；[RUNTIME-004] 无滚动区。
 *
 * Usage:
 *   node scripts/release/build-pip-dist.js
 *   node scripts/release/build-pip-dist.js --no-isolation   # 离线/无 venv 环境
 *   node scripts/release/build-pip-dist.js --skip-build     # 只审计现成 entries/pip/
 *   node scripts/release/build-pip-dist.js --keep-dist      # 不清理旧产物
 * Env:
 *   KHY_PYTHON_BIN  指定 python 解释器（默认按平台探测 python3/python/py）
 * Exit: 0 建成且审计通过 · 1 任一步失败 · 2 用法错误
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// [LAYOUT-005] 构建产物单一根：pip 产物落 entries/pip（BUILD-OUTPUTS.json 已登记），
// 2026-09-29 由根级 dist/ 迁入（方案 R-R2，[DESIGN-LAY-008] §12.55）。
const DIST_DIR = path.join(ROOT, 'entries', 'pip');

const args = process.argv.slice(2);
const noIsolation = args.includes('--no-isolation');
const skipBuild = args.includes('--skip-build');
const keepDist = args.includes('--keep-dist');
const wantHelp = args.includes('-h') || args.includes('--help');
if (args.some((a) => a.startsWith('-') && !['--no-isolation', '--skip-build', '--keep-dist', '-h', '--help'].includes(a))) {
  process.stderr.write('用法：node scripts/release/build-pip-dist.js [--no-isolation] [--skip-build] [--keep-dist]\n');
  process.exit(2);
}

const step = (s) => process.stderr.write(`[build:pip] ${s}\n`);
const fail = (s) => process.stderr.write(`[build:pip][FAIL] ${s}\n`);

/**
 * 可再生的旧产物——与 bash 孪生脚本的清理清单逐条一致。
 * entries/pip 是登记过的产物根（[LAYOUT-005]），整目录清掉只会被重建；
 * setuptools 的 build/ 与 *.egg-info 仍会短暂写在项目根（与 cwd 无关，见步骤 3b 注），
 * 构建结束后由本脚本搬进 entries/pip/{build,egg-info}，根目录回归零产物。
 */
const REGENERABLE = [path.join('entries', 'pip'), 'build', 'khy_os.egg-info', path.join('platform', 'khy_os.egg-info')];

function resolvePython() {
  if (process.env.KHY_PYTHON_BIN) return process.env.KHY_PYTHON_BIN;
  const isWin = process.platform === 'win32';
  for (const c of isWin ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = cp.spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/** 长任务：继承 stdio 让进度直接可见，不设任务截止（[RUNTIME-003]）。 */
function runInherit(cmd, argv, opts) {
  const r = cp.spawnSync(cmd, argv, { cwd: (opts && opts.cwd) || ROOT, stdio: 'inherit' });
  return r.error ? 127 : typeof r.status === 'number' ? r.status : 1;
}

function hasVenv(py) {
  const r = cp.spawnSync(py, ['-c', 'import venv'], { encoding: 'utf8', timeout: 10000 });
  return !r.error && r.status === 0;
}

function main() {
  if (wantHelp) {
    process.stdout.write(
      [
        '用法：node scripts/release/build-pip-dist.js [选项]',
        '',
        '  --no-isolation  用 python -m build --no-isolation（离线/无 venv 环境）',
        '  --skip-build    不重建，只审计现成 entries/pip/',
        '  --keep-dist     不清理旧产物（默认会清 entries/pip 与 setuptools 残留）',
        '',
        '产物：entries/pip/*.whl + entries/pip/*.tar.gz（审计由 audit_pip_artifacts.py 判定）',
        '',
      ].join('\n')
    );
    return 0;
  }

  const py = resolvePython();
  if (!py) {
    fail('本机没有可用的 python 解释器 ⇒ 无法构建（装 Python 3 或设 KHY_PYTHON_BIN）');
    return 1;
  }

  if (!skipBuild) {
    step('步骤 1/4: 装配零依赖运行时 (assemble-pip-runtime.js)');
    if (runInherit(process.execPath, [path.join(ROOT, 'scripts', 'release', 'assemble-pip-runtime.js')]) !== 0) {
      fail('运行时装配失败 ⇒ 中止（未产出任何发布物）');
      return 1;
    }

    step('步骤 2/4: 校验 MANIFEST.in 与打包规则同源 (check_manifest_sync.py)');
    if (runInherit(py, [path.join(ROOT, 'scripts', 'release', 'check_manifest_sync.py')]) !== 0) {
      fail('MANIFEST.in 与 pip_packaging_rules.py 不同源 ⇒ 中止。修复：python scripts/release/render_manifest.py');
      return 1;
    }

    if (!keepDist) {
      step(`步骤 3a/4: 清理可再生的旧产物 — ${REGENERABLE.join(' · ')}`);
      for (const rel of REGENERABLE) {
        const abs = path.join(ROOT, rel);
        try {
          fs.rmSync(abs, { recursive: true, force: true });
        } catch (e) {
          fail(`清理 ${rel} 失败：${e.message}`);
          return 1;
        }
      }
    }

    const useIsolation = noIsolation ? false : hasVenv(py);
    if (!noIsolation && !useIsolation) {
      step('注: 本机 python 缺 venv 模块 ⇒ 自动降级为 --no-isolation（要求已有 setuptools + wheel）。');
      step('    隔离与非隔离构建的可复现性不同，本次读数请按"非隔离"理解。');
    }
    step(`步骤 3b/4: 构建 sdist + wheel（${useIsolation ? '隔离' : '非隔离'}）`);
    // 别试图把构建 cwd 挪到临时目录来"保持仓库根干净"：`python -m build <srcdir>` 会自己
    // chdir 到 srcdir，setuptools 的 `build/`、`*.egg-info/` 与 sdist 暂存树
    // `khy_os-<version>/` **全都写在项目根**，与调用方 cwd 无关 —— 实测：临时 cwd 全程为空，
    // 仓库根照样出现这三者（暂存树在构建结束后被 setuptools 清掉，随后根目录重新干净）。
    // 前两者已被 .gitignore 覆盖（不进 `??`）；只有暂存树会在构建期间短暂出现在 `??` 计数里
    // ——交付基线 D3「新克隆零缺件」读的正是这个计数。要消掉它得走 BUILD-OUTPUTS.json 登记，
    // 不是挪 cwd：挪 cwd 只会留下一个宣称了保护、实际空转的注释。
    const buildArgv = useIsolation
      ? ['-m', 'build', '--sdist', '--wheel', '--outdir', DIST_DIR]
      : ['-m', 'build', '--no-isolation', '--sdist', '--wheel', '--outdir', DIST_DIR];
    if (runInherit(py, buildArgv) !== 0) {
      fail('构建失败 ⇒ 未产出可发布的 entries/pip/（上面是构建器原始输出，未转述）');
      return 1;
    }

    // setuptools 的中间目录与 egg-info 无视 cwd 写在项目根（见上注）——构建完把它们
    // 搬进登记位 entries/pip/{build,egg-info}（[LAYOUT-005] 单一根），根目录零产物残留。
    for (const [from, to] of [
      ['build', path.join('entries', 'pip', 'build')],
      ['khy_os.egg-info', path.join('entries', 'pip', 'egg-info')],
    ]) {
      const src = path.join(ROOT, from);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(ROOT, to);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      step(`产物归位: ${from}/ → ${to}/`);
    }
  } else {
    step('步骤 1-3: 已跳过（--skip-build）');
  }

  if (!fs.existsSync(DIST_DIR)) {
    fail('entries/pip/ 不存在 ⇒ 无可审计的产物（先去掉 --skip-build 重建）');
    return 1;
  }

  step('步骤 4/4: 产物纯净度审计 (audit_pip_artifacts.py)');
  const audit = runInherit(py, [path.join(ROOT, 'scripts', 'release', 'audit_pip_artifacts.py'), '--dist-dir', DIST_DIR]);
  if (audit !== 0) {
    fail('产物未通过纯净度审计 ⇒ 本次 entries/pip/ 不可发布（按上面列出的越界文件改 pip_packaging_rules.py）');
    return 1;
  }

  const names = fs.readdirSync(DIST_DIR).filter((f) => /\.(whl|tar\.gz)$/.test(f));
  step(`完成：entries/pip/ 就绪（${names.join(' + ')}）—— 下一步可跑 npm run check:golden-path 验证"装得上、起得来"`);
  return 0;
}

process.exit(main());