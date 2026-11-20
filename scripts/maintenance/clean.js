#!/usr/bin/env node
/**
 * @pattern Command
 *
 * 构建与测试产物清理（零依赖、跨平台、默认干跑）。
 *
 *   npm run clean                      # 干跑：只列出将删除的目录与实测体积，什么都不删
 *   npm run clean:apply                # 真删（等价于 node scripts/maintenance/clean.js --apply）
 *   node scripts/maintenance/clean.js --apply --include-vendor   # 连可再生的 vendor 一起删
 *   node scripts/maintenance/clean.js --group=build              # 只清某一组
 *
 * ## 为什么是白名单而不是 glob
 *
 * 清理脚本最容易出的事故不是「少删了」而是「多删了」，而 glob（`**\/dist`、
 * `**\/build`）恰好是最容易多删的写法：`node_modules` 里有几十个包自带 dist/，
 * kernel/ 下的 build/ 混着编译产物与手工维护的链接脚本，`.khy/checkpoints` 是
 * 用户跑出来的、删了不可再生的现场。所以这里只认**逐条登记的相对路径**，每条
 * 都必须写清「它是什么产物」和「怎么重建」——重建命令写不出来的，就不该进这张表。
 *
 * ## 与 slim-down.{sh,bat} 的分工
 *
 * 那两个脚本清的是**运行时残留**（应用日志、sqlite 的 wal/shm、kernel 的 .o 与
 * 磁盘镜像、node-llama-cpp 用不到的平台二进制），本脚本一条都不碰，两边不重叠。
 * 本脚本清的是**构建与测试产物**，也就是 2026-08-25 依赖体积基线里量到的那
 * ~280 MB：dist/ 139 MB + android build 120 MB + 前端 dist 18 MB + build/ 18 MB。
 *
 * ## 绝不删除
 *
 * 见 PROTECTED。源码、锁文件、node_modules、.git、用户配置（~/.khyquant）、
 * 凭据（.khy/credentials）、检查点（.khy/checkpoints，实测 50 MB 且不可再生）、
 * 审计轨迹（.khy/audit-trajectory）。任何登记路径若命中 PROTECTED 或解析后
 * 逃出仓库根，脚本直接以 exit 2 拒绝运行——那是登记表写错了，不是运行时异常。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 清理登记表。每条：
 *   rel    仓库根下的相对路径
 *   group  分组；build = 默认清理，vendor = 需 --include-vendor 才清
 *   what   它是什么
 *   rebuild 怎么把它变回来（写不出来的不许登记）
 */
const TARGETS = [
  // ── Flutter 移动端（delivery/channel/mobile/khy-os-client-app）────────────
  {
    rel: 'delivery/channel/mobile/khy-os-client-app/build',
    group: 'build',
    what: 'Flutter Android 构建缓存（native libs、DEX、APK 中间产物）',
    rebuild: 'flutter build apk / flutter run（自动重建，首次 ~5 分钟）',
  },
  {
    rel: 'delivery/channel/mobile/khy-os-client-app/.dart_tool',
    group: 'build',
    what: 'Flutter/Dart 工具链缓存（build_runner、hooks）',
    rebuild: 'flutter pub get（自动重建）',
  },
  {
    rel: 'delivery/channel/mobile/khy-os-client-app/android/build',
    group: 'build',
    what: 'Gradle 中间产物（AGP 输出）',
    rebuild: 'cd delivery/channel/mobile/khy-os-client-app/android && ./gradlew assembleRelease',
  },
  {
    rel: 'delivery/channel/mobile/khy-os-client-app/android/app/build',
    group: 'build',
    what: 'Gradle app 模块中间产物（AGP 输出）',
    rebuild: 'cd delivery/channel/mobile/khy-os-client-app/android && ./gradlew assembleRelease',
  },
  {
    rel: 'delivery/channel/mobile/khy-os-client-app/android/.gradle',
    group: 'build',
    what: 'Gradle 本地缓存（依赖解析与增量状态）',
    rebuild: 'cd delivery/channel/mobile/khy-os-client-app/android && ./gradlew assembleRelease（自动重建）',
  },
  // ── 前端（delivery/channel/web 与 khyquant）─────────────────────────────
  {
    rel: 'delivery/channel/web/ai-frontend/dist',
    group: 'build',
    what: 'ai-frontend 的 Vite 产物',
    rebuild: 'npm run build --prefix delivery/channel/web/ai-frontend',
  },
  {
    rel: 'delivery/channel/web/ai-frontend/coverage',
    group: 'build',
    what: 'ai-frontend 的 Vitest 覆盖率报告',
    rebuild: 'npm run test --prefix delivery/channel/web/ai-frontend -- --coverage',
  },
  {
    rel: 'delivery/channel/web/provider-hub/dist',
    group: 'build',
    what: 'provider-hub 的 Vite 产物',
    rebuild: 'npm run build --prefix delivery/channel/web/provider-hub',
  },
  {
    rel: 'delivery/channel/khyquant/frontend/dist',
    group: 'build',
    what: 'khyquant 前端的 Vite 产物',
    rebuild: 'npm run build --prefix delivery/channel/khyquant/frontend',
  },
  // ── 桌面端（apps/khyos-desktop）────────────────────────────────────────
  {
    rel: 'apps/khyos-desktop/out',
    group: 'build',
    what: 'electron-vite 输出（main/preload/renderer/host/scheduler 五段）',
    rebuild: 'npm run build --prefix apps/khyos-desktop',
  },
  // ── 产物单一根（entries/，LAYOUT-005）──────────────────────────────────
  {
    rel: 'entries/executables',
    group: 'build',
    what: 'esbuild 模块 bundle、打包可执行文件与安装器输出（[LAYOUT-005] 单一根）',
    rebuild: 'node works/ship/build/esbuild-modules.js --prod / node works/ship/build/pack-executable.js --all / node works/ship/installer/build_installer.js',
  },
  {
    rel: 'entries/pip',
    group: 'build',
    what: 'pip 分发产物与 setuptools 中间目录（wheel / tar.gz / build / egg-info）',
    rebuild: 'node scripts/release/build-pip-dist.js',
  },
  {
    rel: 'entries/portable',
    group: 'build',
    what: '便携版打包产物（runtime / dev 两种形态的装配目录与 zip）',
    rebuild: 'npm run portable:package --prefix delivery/extension/scripts/khy-portable',
  },
  // ── 品牌 3D 桌面链路（works/brand/khyos-desktop）───────────────────────
  // 2026-11-20：原登记 out/frames 与 out/.verify 两个子路径，二者均已不存在，
  // 且 .verify 的 rebuild 写的是 capture.mjs（--selftest）——该模式只在内存里渲染、
  // 不落盘，真正的链路是 capture.mjs → assemble.mjs → extract-check.mjs。
  // 改成与 BUILD-OUTPUTS.json 的 khyos-desktop-frames 同粒度（整个 out/）。
  // 注意 out/_before、_after、_beforefix 是手写诊断快照、全仓零引用，且 capture.mjs
  // 不会重建它们——要清这三个得单独裁决，别指望这条 rebuild。
  {
    rel: 'works/brand/khyos-desktop/out',
    group: 'build',
    what: '品牌桌面链路产物（frames/ 逐场景 PNG、dist/khyos-desktop.html、preview/contact 图与音频）',
    rebuild: 'node works/brand/khyos-desktop/scripts/capture.mjs && node works/brand/khyos-desktop/scripts/assemble.mjs && node works/brand/khyos-desktop/scripts/extract-check.mjs',
  },
  {
    rel: 'works/brand/khyos-desktop/dist',
    group: 'build',
    what: '品牌桌面链路交付物（dist/khyos-desktop.html，可离线双击运行）',
    rebuild: 'npm run build --prefix works/brand/khyos-desktop',
  },
  // ── 内核构建产物（runtime/boot/kernel）────────────────────────────────
  {
    rel: 'runtime/boot/kernel/build',
    group: 'build',
    what: '内核编译输出（.o 对象与磁盘镜像）',
    rebuild: 'cd runtime/boot/kernel && make（内核 Makefile 自动重建）',
  },
  {
    rel: 'runtime/boot/kernel/moonbit/_build',
    group: 'build',
    what: 'MoonBit 工具链输出（工具写死路径，parasitic，见 BUILD-OUTPUTS.json）',
    rebuild: 'cd runtime/boot/kernel/moonbit && moon build（每次自动重建）',
  },
  // ── 前端 vendor（parasitic：Vite dev server 直接服务 public/）──────────
  {
    rel: 'delivery/channel/web/ai-frontend/public/vendor',
    group: 'vendor',
    what: '前端 vendor 目录（muya 等，寄生路径：Vite dev server 与 build 直接服务）',
    rebuild: 'node delivery/channel/web/ai-frontend/scripts/sync-md-vendor.mjs',
  },
  {
    rel: 'build',
    group: 'build',
    what: 'setuptools 的中间目录（build/lib、build/bdist.*）',
    rebuild: 'python -m build（或任一次 pip wheel 构建）',
  },
  {
    rel: 'coverage',
    group: 'build',
    what: '根级覆盖率报告',
    rebuild: 'npm run quality:pr（覆盖率环节自动生成）',
  },
  {
    rel: '.nyc_output',
    group: 'build',
    what: 'c8/nyc 的原始覆盖率数据',
    rebuild: '跑一次带覆盖率的测试即可',
  },
  {
    rel: '.cache',
    group: 'build',
    what: '治理脚本的分析缓存（quality-gate、dangling-docs、rename-map 等）',
    rebuild: '下次运行对应检查脚本时自动重建，只是第一次会慢一点',
  },
  {
    rel: 'tmp-cov',
    group: 'build',
    what: 'quality-gate 覆盖率跑测的临时工作区（k1/k2，含各自 node_modules 与 c8 原始数据）',
    rebuild: 'npm run quality:gate / npm run cover-unit 每次跑测时重新生成',
  },
  // ── vendor 组（需 --include-vendor）───────────────────────────────────
  {
    rel: 'delivery/extension/tools/khy-markdown/vendor',
    group: 'vendor',
    what: 'muya WYSIWYG 引擎（esbuild 自打包产物，不进 git）',
    rebuild: 'node delivery/extension/tools/khy-markdown/muya-embed/ensure-vendor.mjs',
  },
  {
    rel: 'delivery/extension/tools/khy-dsh-compat/vendor',
    group: 'vendor',
    what: 'khy-dsh-compat 的自打包产物',
    rebuild: 'node delivery/extension/tools/khy-dsh-compat/ensure-vendor.mjs',
  },
  {
    rel: 'docs/19_资产/site/mermaid.min.js',
    group: 'vendor',
    what: '文档站 Mermaid 引擎（esbuild 自打包，不进 git）',
    rebuild: 'npm run docs:mermaid',
  },
];

/**
 * 保护清单（子树级）：这些路径本身、以及它们下面的任何东西，都不允许登记。
 * 这里放的是「删了要么不可再生、要么直接毁掉环境」的东西。
 */
const PROTECTED_SUBTREE = [
  '.git',
  '.github',
  '.khy/checkpoints',
  '.khy/audit-trajectory',
  '.khy/credentials',
  'node_modules',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

/**
 * 保护清单（精确级）：这些**目录本身**不允许登记，但目录内部的构建产物可以
 * （apps/ai-frontend/dist、services/backend/coverage 就在这些目录里面）。
 * 这里放的是分层目录与源码根，防止有人手滑写成 `rel: 'services'`。
 */
const PROTECTED_EXACT = [
  'src',
  'kernel',
  'platform',
  'services',
  'apps',
  'software',
  'extensions',
  'tools',
  'scripts',
  'docs',
  'packaging',
  // 方案 P 后的现役源码根：登记里若出现这些前缀，说明是手滑而非产物
  'runtime',
  'delivery',
  'entries',
  'works',
  'works/data',
  'works/brand',
  // 2026-11-20 补：归档根本身。上面三个 works/ 子项唯独漏了它，而它是其它所有
  // 损失的唯一恢复源（dist-electron-pet 仍被 package-and-launch.ps1 当回退启动位）。
  'works/backup',
];

/**
 * 保护清单（精确文件级）：这些**文件本身**不允许登记为清理目标。
 *
 * 为什么单列一张表而不用 PROTECTED_SUBTREE 罩住 android/：那会连带作废已登记的
 * `android/build`、`android/app/build`、`android/.gradle` 三条合法产物，让整表校验
 * exit 2、cleaner 整体瘫痪。所以只点名到文件。
 *
 * 为什么必须有这张表：这四个文件**都没有被 git 跟踪**（.gitignore 屏蔽），
 * 因此下面那道 git-aware 删除守卫看不见它们。签名密钥一旦没了，
 * 同一签名身份永远无法复现，所有已装机客户端只能手工迁移——
 * build-android.ps1 的 rebuild 声明也随之变成"有命令、不可达"。
 */
const PROTECTED_FILE_EXACT = [
  'delivery/channel/mobile/khy-os-client-app/android/khyos-release.keystore',
  'delivery/channel/mobile/khy-os-client-app/android/key.properties',
  'delivery/channel/mobile/khy-os-client-app/android/gradlew',
  'delivery/channel/mobile/khy-os-client-app/android/gradlew.bat',
  'delivery/channel/mobile/khy-os-client-app/android/build.gradle.kts',
];

const toPosix = (p) => p.split(path.sep).join('/');
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const includeVendor = argv.includes('--include-vendor');
const onlyGroup = (() => {
  const flag = argv.find((a) => a.startsWith('--group='));
  return flag ? flag.slice('--group='.length) : null;
})();

/**
 * 校验一条登记路径是否合法。
 * @returns {string|null} 违规原因；null 表示合法
 */
function validate(rel) {
  const abs = path.resolve(ROOT, rel);
  const inside = path.relative(ROOT, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return `解析后逃出仓库根：${abs}`;
  }
  const posix = toPosix(inside);
  for (const guard of PROTECTED_SUBTREE) {
    // 前缀比较必须带 '/'，否则 'node_modules' 会误伤 'node_modules_old'。
    if (posix === guard || posix.startsWith(guard + '/')) {
      return `位于受保护子树 ${guard} 之下`;
    }
  }
  if (PROTECTED_EXACT.includes(posix)) {
    return `是受保护的目录本身：${posix}（只能登记它内部的构建产物）`;
  }
  if (PROTECTED_FILE_EXACT.includes(posix)) {
    return `是签名密钥/构建入口文件本身：${posix}（不被 git 跟踪，删了不可恢复）`;
  }
  return null;
}

/**
 * 问 git：某个路径下有多少已跟踪文件。
 *
 * 2026-11-20 事故后新增。此前 clean.js 对 git 完全无感知，删除是裸 fs.rmSync，
 * 于是登记表一旦手滑罩住已跟踪文件，一次 clean 就把版本控制内容删掉——
 * apps/khyos-desktop/dist-ts 的 61 个 tsc 产物正是这么没的，只能靠 git checkout 捞回。
 * 现在删除前先问 git，有已跟踪文件就整体拒绝。
 *
 * fail-closed：git 查询本身失败时返回 error 而不是空数组。宁可拒绝删除，
 * 也不要在"不知道有没有跟踪文件"时动手。
 *
 * @returns {{files: string[]}|{error: string}}
 */
function gitTrackedUnder(abs) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', abs], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { files: out.split(/\r?\n/).filter(Boolean) };
}

/** 递归量一个路径的字节数（文件直接返回大小）。 */
function sizeOf(abs) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) {
    return 0; // 不跟随软链，也不计它的目标体积
  }
  if (stat.isFile()) {
    return stat.size;
  }
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    total += sizeOf(path.join(abs, e.name));
  }
  return total;
}

// ── 先整表校验，任何一条不合法就整体拒绝，绝不「跳过坏的、删好的」 ──
const violations = [];
for (const t of TARGETS) {
  const why = validate(t.rel);
  if (why) {
    violations.push(`${t.rel}: ${why}`);
  }
}
if (violations.length) {
  console.error('[clean] 登记表校验失败，未删除任何内容：');
  for (const v of violations) {
    console.error('  - ' + v);
  }
  process.exit(2);
}

const groups = new Set(['build']);
if (includeVendor) {
  groups.add('vendor');
}
const selected = TARGETS.filter(
  (t) => (onlyGroup ? t.group === onlyGroup : groups.has(t.group))
);

if (!selected.length) {
  console.error(`[clean] 没有匹配的清理组（--group=${onlyGroup}）。可用：build, vendor`);
  process.exit(2);
}

console.log(
  `[clean] 模式：${apply ? '真删（--apply）' : '干跑（不加 --apply 不会删任何东西）'}` +
    `　组：${[...new Set(selected.map((t) => t.group))].join(', ')}`
);
console.log('');

let present = 0;
let totalBytes = 0;
let removed = 0;
let failed = 0;

for (const t of selected) {
  const abs = path.join(ROOT, t.rel);
  if (!fs.existsSync(abs)) {
    console.log(`  ·  ${t.rel}  —  不存在，跳过`);
    continue;
  }
  present += 1;
  const bytes = sizeOf(abs);
  totalBytes += bytes;
  console.log(`  ${apply ? '✂' : '·'}  ${t.rel}  —  ${mb(bytes)}`);
  console.log(`       内容：${t.what}`);
  console.log(`       重建：${t.rebuild}`);

  // ── git-aware 删除守卫（2026-11-20 后新增）─────────────────────────────
  // 干跑和真删都执行，让干跑也能提前暴露"这条登记罩住了版本控制内容"。
  const gitState = gitTrackedUnder(abs);
  if (gitState.error) {
    console.log(`  ⛔ ${t.rel} — git 查询失败（${gitState.error}），拒绝删除`);
    console.log('       （fail-closed：不知道有没有已跟踪文件就不动手。git 不在 PATH？）');
    continue;
  }
  if (gitState.files.length) {
    console.log(`  ⛔ ${t.rel} — 含 ${gitState.files.length} 个 git 已跟踪文件，拒绝删除`);
    console.log('       （clean.js 不得删版本控制内容。该登记要么写错了路径，要么这些文件本应 git rm --cached）');
    continue;
  }

  if (apply) {
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`       ⚠ 删除失败（${message}）——多半是文件被占用，先停掉 khy 进程再试。`);
    }
  }
}

console.log('');
if (!present) {
  console.log('[clean] 登记的产物一个都不存在，无事可做。');
  process.exit(0);
}

if (apply) {
  console.log(`[clean] 已删除 ${removed}/${present} 项，释放约 ${mb(totalBytes)}${failed ? `（${failed} 项失败）` : ''}。`);
  if (!includeVendor) {
    console.log('[clean] 未清理 vendor 组（muya 引擎、mermaid 引擎）。需要时加 --include-vendor。');
  }
  process.exit(failed ? 1 : 0);
}

console.log(`[clean] 干跑结束：${present} 项存在，合计约 ${mb(totalBytes)}。执行 npm run clean:apply 才会真删。`);
process.exit(0);
