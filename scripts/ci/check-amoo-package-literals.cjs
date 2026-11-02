#!/usr/bin/env node
'use strict';

/**
 * check-amoo-package-literals.cjs — freeze table for every non-test, non-doc
 * occurrence of com.stepos.ailauncher across the four source roots.
 *
 * What it guards: the khyos decouple report's static-surface claim
 * "com.stepos.ailauncher only ever shrinks" used to be a self-reported number.
 * The last round recorded 24 while the tree held 26 — the record lied about the
 * code (works/data/khy/amoo-drive/khyos-decouple-report.md, static-surface
 * criterion). This checker turns the claim into a machine-checked invariant:
 * all 26 current occurrences are frozen line by line, and three findings fire.
 *
 *   unregistered-literal  a line outside the table now carries the literal
 *                          (new literal: renamed, moved, or freshly added)
 *   frozen-line-missing   a frozen line no longer carries the literal (deleted,
 *                          or its coordinates drifted off the hit)
 *   frozen-line-drift     a frozen line's full text changed — including the
 *                          equal-count mutation this table exists to catch
 *
 * Why the table stores the whole line, not just coordinates: a coordinate-only
 * freeze cannot see the mutation it claims to catch. Misspell the package as
 * com.stepos.ailaunchere and the coordinates still match, the line is still
 * there, and a coordinate-only table stays green. Byte-exact line text is the
 * hard requirement; editing any of the 26 lines — even a comment — means
 * editing this table in the same change and saying why.
 *
 * Why the scan engine is git grep rather than a filesystem walk: reading every
 * candidate file in the same scope measured ~35s on Windows (3420 files, each
 * read paying the realtime-scanner tax), which fits no gate. git grep does the
 * same scope in ~1.1s, skips gitignored build output for free, and with
 * --untracked also covers new files — KhyAppFunctions.java is untracked, so a
 * git ls-files scan would miss it. When git itself is unavailable the checker
 * reports an error and exits 1: unable to verify means not passing.
 *
 * One engine note: git grep reads the pattern as a regex, so the dots are
 * wildcards. That is kept on purpose. A near-miss spelling such as
 * com.stepos.ailaunchere still comes back as a hit and raises
 * frozen-line-drift with the before/after text — the most informative red this
 * guard can produce, and strictly more coverage than a substring scan. On the
 * current tree both readings return the same 26 in-scope lines.
 *
 * Scope: the four source roots below, minus node_modules/build directories,
 * test files (test/tests/__tests__/androidTest path segments and
 * *.test.* / *.spec.*), and docs (*.md / *.html). Literals in test fixtures and
 * docs are protection and prose, not the count under the ratchet.
 *
 * Usage:
 *   node scripts/ci/check-amoo-package-literals.cjs
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LITERAL = 'com.stepos.ailauncher';

const SOURCE_ROOTS = [
  'delivery/mobile/khy-os-client-app/lib',
  'delivery/mobile/khy-os-client-app/android/app/src',
  'delivery/extension/bridges/khy-amoon-bridge/lib',
  'runtime/node/backend/src',
];

// Build output and test directories: any matching path segment excludes the
// file (node_modules is additionally hidden by gitignore).
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|build|test|tests|__tests__|androidTest)(?:\/|$)/;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/;
const DOC_FILE = /\.(?:md|html)$/i;

/**
 * The freeze table: every non-test, non-doc occurrence as of this commit.
 *
 * `text` must be the whole line, not a fragment — see the header for why
 * coordinates alone let the equal-count mutation through. `why` is required:
 * a frozen line with no reason is a change permanently locked without cause.
 *
 * Template literals are deliberate: these lines mix single and double quotes,
 * and backticks pin the original text in verbatim with no escape hatch for a
 * future off-by-one character.
 */
const FROZEN = [
  {
    file: 'delivery/extension/bridges/khy-amoon-bridge/lib/bridge-tools.js',
    line: 24,
    text: `const AMOON_PACKAGE = 'com.stepos.ailauncher';`,
    why: '桥侧唯一的 Amoo 包名常量，安装探测与 intent 定位都从它取。',
  },
  {
    file: 'delivery/extension/bridges/khy-amoon-bridge/lib/bridge-tools.js',
    line: 27,
    text: `const OPEN_CHAT_ACTION = 'com.stepos.ailauncher.action.OPEN_CHAT';`,
    why: 'Amoo 无 LAUNCHER 类别，只能按 action 打开聊天页；与 Dart/Kotlin 侧同一动作名。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooChatText.java',
    line: 76,
    text: `     *                   "com.stepos.ailauncher:id/chat_list"`,
    why: 'extract() 的 @param chatListId 文档示例，写清期望的资源 id 形态。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooLoop.java',
    line: 72,
    text: `    public static final String AMOO_PKG = "com.stepos.ailauncher";`,
    why: '桥侧驱动 Amoo 界面的包名常量，下面三个资源 id 由它拼接。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooSafe.java',
    line: 17,
    text: ` * returns {@code com.stepos.ailauncher:id/et_input_bar} on every node.`,
    why: 'sanitize() 行为说明：每个节点都会返回该资源 id 形态的串。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooSafe.java',
    line: 82,
    text: `    private static final String AMOO_PKG = "com.stepos.ailauncher";`,
    why: '清洗器要知道 Amoo 包名，才能把界面 dump 里的它换成 amoo，不让模型看到原始包名。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooSafe.java',
    line: 182,
    text: `    /** {@code com.stepos.ailauncher:id/et_input_bar} — a resource id. */`,
    why: '说明该串是资源 id 而非类名，防止 sanitize 的类名判定误伤它。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooSafe.java',
    line: 330,
    text: `     * MUST run before the path pass: {@code com.stepos.ailauncher:id/et_input_bar}`,
    why: '顺序约束说明：路径 pass 必须跑在包名 pass 之前。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooSafe.java',
    line: 332,
    text: `     * into {@code com.stepos.ailauncher:id/界面元素} — leaving the package`,
    why: '同一条顺序约束的后果示例，说明包名 pass 之后串变成什么形态。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/KhyAppFunctions.java',
    line: 79,
    text: `                    "com.stepos.ailauncher",`,
    why: 'ALLOWED_CALLERS 授权调用方白名单里的 Amoo 身份：点名放行，不是前缀匹配。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    line: 1880,
    text: `     * {@code com.stepos.ailauncher} 同命名空间不同包，按 {@code com.amoo.} 前缀`,
    why: 'OPTIONAL_TOOLS javadoc 的反前缀匹配警示：com.amoo.adousignin 与它同命名空间不同包，按 com.amoo. 前缀找会连带圈进别的应用——这处是防止引入前缀匹配的警示本身，不是匹配逻辑。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt',
    line: 2065,
    text: `        private const val AMOON_PACKAGE = "com.stepos.ailauncher"`,
    why: 'Android 侧 Amoo 包名常量，与 bridge-tools.js:24 同一组（见 :2064 注释）。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt',
    line: 2066,
    text: `        private const val AMOON_SHARE_ACTIVITY = "com.stepos.ailauncher.chat.activity.ShareActivity"`,
    why: '分享入口 Activity 全名，amoon_send 的 intent 目标。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt',
    line: 2067,
    text: `        private const val AMOON_CHAT_ACTIVITY = "com.stepos.ailauncher.chat.activity.ChatMainActivity"`,
    why: '聊天页 Activity 全名，打开聊天用。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt',
    line: 2068,
    text: `        private const val AMOON_OPEN_CHAT = "com.stepos.ailauncher.action.OPEN_CHAT"`,
    why: '打开聊天页的 action，Amoo 无 LAUNCHER 类别只能按 action 调。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/lib/core/services/amoo_service.dart',
    line: 18,
    text: `  static const String packageName = 'com.stepos.ailauncher';`,
    why: 'Dart 侧安装探测（PackageManager）唯一入口。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/lib/core/services/amoo_service.dart',
    line: 20,
    text: `      'com.stepos.ailauncher.chat.activity.ShareActivity';`,
    why: '分享 Activity 全名，与 Kotlin 侧同名常量对应。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/lib/core/services/amoo_service.dart',
    line: 22,
    text: `      'com.stepos.ailauncher.chat.activity.ChatMainActivity';`,
    why: '聊天页 Activity 全名，打开聊天用。',
  },
  {
    file: 'delivery/mobile/khy-os-client-app/lib/core/services/amoo_service.dart',
    line: 23,
    text: `  static const String openChatAction = 'com.stepos.ailauncher.action.OPEN_CHAT';`,
    why: '打开聊天页的 action，与桥侧同一动作名。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeConfig.js',
    line: 17,
    text: ` *   - Amoo's chat screen is com.stepos.ailauncher/.chat.activity.ChatMainActivity`,
    why: '文档注释里的聊天组件全名示例，说明 config.amoo.component 的形态。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeConfig.js',
    line: 78,
    text: `const AMOO_PACKAGE = 'com.stepos.ailauncher';`,
    why: 'PC 侧包名常量，amooBridgeClient 的发现与连接都从它取。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeConfig.js',
    line: 80,
    text: `const AMOO_LAUNCH_ACTION = 'com.stepos.ailauncher.action.OPEN_CHAT';`,
    why: 'PC 侧打开聊天页的 action，与桥侧一致。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeConfig.js',
    line: 81,
    text: `const AMOO_INPUT_ID = 'com.stepos.ailauncher:id/et_input_bar';`,
    why: '输入框资源 id，dispatch 输入定位用。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeConfig.js',
    line: 82,
    text: `const AMOO_SEND_ID = 'com.stepos.ailauncher:id/btn_text_send';`,
    why: '发送按钮资源 id，dispatch 发送定位用。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeConfig.js',
    line: 83,
    text: `const AMOO_CHAT_LIST_ID = 'com.stepos.ailauncher:id/chat_list';`,
    why: '聊天列表资源 id，抽聊天文本用。',
  },
  {
    file: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    line: 720,
    text: `  '这组助手协同工具（Amoo 反代）需要手机上已安装并启用 Amoo（com.stepos.ailauncher）。'`,
    why: 'ASSISTANT_GAP_REASON 用户可见串：助手协同工具组缺席时告诉用户需要装 Amoo，并说明 PC 侧只在桥报 withheld 时才判「不可用」、桥没报到时判「未知」——这是能力缺席时给用户的说明，不是广告。',
  },
];

const findings = [];
const add = (id, file, line, message) => findings.push({ id, file, line, message });

function inScope(rel) {
  return !EXCLUDED_SEGMENT.test(rel) && !TEST_FILE.test(rel) && !DOC_FILE.test(rel);
}

/**
 * Collect every in-scope hit via git grep (tracked + untracked, text files).
 * Returns Map<`file:line`, {file, line, text}>; null when the engine itself
 * failed — an unverifiable run must not pass silently.
 */
function scanLiterals() {
  let stdout;
  try {
    stdout = execFileSync(
      'git',
      // color.grep=never: a user-global color.ui=always would otherwise write
      // ANSI codes into the pipe and break line parsing.
      ['-c', 'core.quotePath=false', '-c', 'color.grep=never', 'grep', '-n', '--untracked', '-I', '-e', LITERAL, '--', ...SOURCE_ROOTS],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (error) {
    // git grep exits 1 when there is no match at all; that is "clean", not "broken".
    if (error && error.status === 1) return new Map();
    return null;
  }

  const found = new Map();
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const match = /^(.+?):(\d+):([\s\S]*)$/.exec(raw);
    if (!match) {
      add('amoo-literal-scan-unparsed', '(git grep output)', 1,
        `无法解析的命中行：${JSON.stringify(raw.slice(0, 120))}`);
      continue;
    }
    const [, file, line, text] = match;
    if (!inScope(file)) continue;
    // CRLF files carry a trailing \r in the hit; the table is authored LF.
    // Only the line terminator is normalized, never the content.
    found.set(`${file}:${line}`, { file, line: Number(line), text: text.replace(/\r$/, '') });
  }
  return found;
}

function checkTableIntegrity() {
  const seen = new Set();
  for (const entry of FROZEN) {
    const key = `${entry.file}:${entry.line}`;
    if (seen.has(key)) {
      add('frozen-duplicate-entry', entry.file, entry.line, `冻结表重复登记同一坐标：${key}。`);
    }
    seen.add(key);
    if (!entry.why || !String(entry.why).trim()) {
      add('frozen-missing-why', entry.file, entry.line,
        `冻结行缺理由（${key}）：无理由的冻结等于把改动永久锁死，说不清为什么就不要锁。`);
    }
    if (!entry.text.includes(LITERAL)) {
      add('frozen-text-without-literal', entry.file, entry.line,
        `冻结行的整行文本里没有 ${LITERAL}（${key}）：冻的是一个不相干的行。`);
    }
  }
}

const actual = scanLiterals();

if (actual === null) {
  add('amoo-literal-scan-failed', 'scripts/ci/check-amoo-package-literals.cjs', 1,
    'git grep 引擎失败（git 缺失或四源码根不可读）：本守卫验不了就不放行，不静默跳过。');
} else {
  checkTableIntegrity();

  const frozenByKey = new Map(FROZEN.map((entry) => [`${entry.file}:${entry.line}`, entry]));
  for (const [key, entry] of frozenByKey) {
    const hit = actual.get(key);
    if (!hit) {
      add('frozen-line-missing', entry.file, entry.line,
        `冻结行消失：${key} 处已不含 ${LITERAL}（行被删，或行号漂移后原坐标不再命中）。`
        + '若是有意减少，把该行从冻结表一并删除并留原因；否则把改动改回去。');
    } else if (hit.text !== entry.text) {
      add('frozen-line-drift', entry.file, entry.line,
        `冻结行文本变更：${key} 现在是 ${JSON.stringify(hit.text)}，冻结的是 ${JSON.stringify(entry.text)}。`
        + '等数变异（包名打错一个字母）同样逃不过；有意改动就同步更新冻结表并写清为什么。');
    }
  }
  for (const [key, hit] of actual) {
    if (!frozenByKey.has(key)) {
      add('unregistered-literal', hit.file, hit.line,
        `出现清单外行：${key} = ${JSON.stringify(hit.text.slice(0, 120))}。`
        + '非测试非文档的新字面量必须先写进冻结表（file:line + 整行文本 + 理由）才许存在。');
    }
  }
}

console.log('check-amoo-package-literals: com.stepos.ailauncher 字面量冻结表守卫');
if (actual) {
  console.log(`四源码根 ${SOURCE_ROOTS.length} 个 · 冻结 ${FROZEN.length} 行 · 实测 ${actual.size} 行`);
}
for (const finding of findings) {
  // One statement, two visual lines: check-file-ratchet caps new files at five
  // console.* calls, and the loop must not spend two of them.
  console.log(`[ERROR] ${finding.id} ${finding.file}:${finding.line}\n  ${finding.message}`);
}
console.log(`\nSummary: ${findings.length} error(s), 0 warning(s).`);

process.exitCode = findings.length ? 1 : 0;
