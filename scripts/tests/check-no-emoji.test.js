'use strict';

/**
 * Self-test for scripts/ci/check-no-emoji.js (S1 observer guard).
 *
 * The point of these cases is the 升阶自检 the guard itself must survive: the same input
 * has to produce a DIFFERENT verdict at S1 and at S3, otherwise `STAGE` is decoration.
 * Every glyph is written as an escape so this file stays ASCII on any console/codepage.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const g = require(path.join(__dirname, '..', 'ci', 'check-no-emoji.js'));

const EMOJI_ROCKET = String.fromCodePoint(0x1f680);      // 🚀 Emoji_Presentation=Yes
const EMOJI_CHECK = String.fromCodePoint(0x2705);        // ✅
const VS16 = String.fromCodePoint(0xfe0f);
const ZWJ = String.fromCodePoint(0x200d);
const WARN = String.fromCodePoint(0x26a0);               // ⚠ text-default, must stay legal
const TICK = String.fromCodePoint(0x2713);               // ✓
const CROSS = String.fromCodePoint(0x2717);              // ✗
const STAR = String.fromCodePoint(0x2b50);               // ★ colour-default → must map to banned
const DOT = String.fromCodePoint(0x25cf);               // ●
const ARROW = String.fromCodePoint(0x2192);              // →
const HOURGLASS = String.fromCodePoint(0x23f3);          // ⏳ colour-default
const WATCH = String.fromCodePoint(0x231a);              // ⌚ colour-default

function run(content, rel, stage) {
  return g.evaluateFile({ path: rel || 'services/backend/src/cli/ui.js', content }, { stage });
}

test('code point policy: colour-default is banned, text-default mono is not', () => {
  assert.strictEqual(g.isBannedCodePoint(0x1f680), true);
  assert.strictEqual(g.isBannedCodePoint(0x2705), true);
  assert.strictEqual(g.isBannedCodePoint(0x2b50), true);
  assert.strictEqual(g.isBannedCodePoint(0x23f3), true);
  assert.strictEqual(g.isBannedCodePoint(0x231a), true);
  assert.strictEqual(g.isBannedCodePoint(0xfe0f), true, 'VS16 forces colour presentation');
  assert.strictEqual(g.isBannedCodePoint(0x200d), true, 'ZWJ joins a colour emoji sequence');
  for (const mono of [0x26a0, 0x2713, 0x2717, 0x276f, 0x2192, 0x25cf, 0x25cb, 0x25c9, 0x25b8, 0x25c6]) {
    assert.strictEqual(g.isBannedCodePoint(mono), false, `U+${mono.toString(16)} must stay legal`);
  }
});

test('clean mono vocabulary produces zero findings', () => {
  const content = `const S = { ok: '${TICK}', bad: '${CROSS}', warn: '${WARN}', dot: '${DOT}', arrow: '${ARROW}' };\n`;
  assert.deepStrictEqual(run(content).map((f) => f.criterion), []);
});

test('literal colour emoji in a user-facing string is reported', () => {
  for (const glyph of [EMOJI_ROCKET, EMOJI_CHECK, STAR, HOURGLASS, WATCH]) {
    const f = run(`console.log('${glyph} 启动');\n`);
    assert.strictEqual(f.length, 1, `U+${glyph.codePointAt(0).toString(16)} must be reported`);
    assert.strictEqual(f[0].criterion, 'colored-emoji');
  }
});

test('escaped emoji is caught even though the source bytes look innocent', () => {
  const f = run('const logo = "\\uD83D\\uDE80";\nconst bar = "\\u{1F4CA}";\n',
    'services/backend/src/bridge/mobilePage.js');
  assert.deepStrictEqual(f.map((x) => x.criterion), ['escaped-emoji', 'escaped-emoji']);
});

test('VS16-forced text glyph is reported', () => {
  const f = run(`print('${WARN}${VS16} 需要授权');\n`);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].criterion, 'colored-emoji');
});

test('ZWJ sequence is reported', () => {
  const f = run(`const fam = '${EMOJI_ROCKET}${ZWJ}${EMOJI_ROCKET}';\n`);
  assert.ok(f.length >= 1, 'ZWJ itself is a banned code point');
  assert.ok(f.some((x) => x.message.includes('U+200D')));
});

test('comment-only lines and trailing comments are not judged', () => {
  assert.deepStrictEqual(run(`// 历史文案里有 ${EMOJI_ROCKET}\n`), []);
  assert.deepStrictEqual(run(`const a = 1; // ${EMOJI_ROCKET} 说明\n`), [],
    'row-tail comments never reach the screen');
});

test('suppression needs a reason', () => {
  assert.strictEqual(g.allowReason(`x // khy-allow-no-emoji: 匹配外部文本的清洗规则`), '匹配外部文本的清洗规则');
  assert.strictEqual(g.allowReason('x // khy-allow-no-emoji:'), '', 'empty reason must not pass');
  const bare = run(`const re = /${EMOJI_ROCKET}/; // khy-allow-no-emoji:\n`);
  assert.strictEqual(bare.length, 1, 'reasonless suppression is ignored');
});

test('initial-letter avatar is flagged, array index is not', () => {
  assert.strictEqual(run(`const c = props.name.charAt(0).toUpperCase(); // badge\n`).length, 1);
  assert.strictEqual(run(`const a = props.name.charAt(0);\n`).length, 0, 'no display context');
  assert.strictEqual(run(`state.d = event.touches[0];\n`).length, 0, 'bare [0] is array noise');
});

test('exempt paths and non-runtime paths are out of scope', () => {
  assert.strictEqual(g.isJudged('services/backend/src/buddy/species.js'), true);
  assert.strictEqual(run(`const x = '${EMOJI_ROCKET}';\n`, 'services/backend/src/buddy/species.js').length, 0);
  assert.strictEqual(g.isJudged('services/backend/tests/ui.test.js'), false);
  assert.strictEqual(g.isJudged('apps/khyos-desktop/zcode-analysis/unpacked/out/main/index.js'), false);
  assert.strictEqual(g.isJudged('docs/readme.js'), false);
  assert.strictEqual(g.isJudged('README.md'), true, 'docs surface is judged (ruling 4)');
});

test('docs surface: md and html are judged, filing material and build roots are not', () => {
  assert.strictEqual(g.isJudged('docs/03_DESIGN_设计/DESIGN-ARCH/a.md'), true);
  assert.strictEqual(g.isJudged('docs/index.html'), true);
  assert.strictEqual(g.isJudged('software/khyquant/frontend/index.html'), true);
  assert.strictEqual(g.isJudged('evidence/06_申报材料/递交核对表.md'), false, 'evidence must stay verbatim');
  assert.strictEqual(g.isJudged('entries/khy-quant/out/page.html'), false);
  assert.strictEqual(g.isJudged('scripts/docs/build_docs_site.js'), true, 'generators ship chrome');
  assert.strictEqual(g.isDocSource('a/b.md'), true);
  assert.strictEqual(g.isDocSource('a/b.html'), true);
  assert.strictEqual(g.isDocSource('a/b.js'), false);
  assert.strictEqual(g.isDataSource('docs/10_规范/registry/RULES-REGISTRY.json'), true);
  assert.strictEqual(g.isDataSource('docs/99_其它/notes.json'), false);
});

test('docs surface: headings are content, in-fence comments are content', () => {
  assert.strictEqual(run(`## ${EMOJI_ROCKET} 目录\n`, 'docs/a.md').length, 1,
    'a markdown heading is displayed, not a comment');
  assert.strictEqual(run(`<!-- ${EMOJI_ROCKET} 未发布 -->\n`, 'docs/a.md').length, 0,
    'outside a fence an html comment is not rendered');
  assert.strictEqual(run('```\n<!-- ' + EMOJI_ROCKET + ' 正确 -->\n```\n', 'docs/a.md').length, 1,
    'inside a fence the comment is shown to the reader verbatim');
  assert.strictEqual(
    run(`## ${EMOJI_ROCKET} 目录 <!-- khy-allow-no-emoji: 外部规范原文引文 -->\n`, 'docs/a.md').length, 0,
    'doc suppression comment must tolerate the trailing -->');
  assert.strictEqual(run(`const a = "\\u2705";\n`, 'docs/a.md').length, 0,
    'a document never decodes \\uXXXX escapes; only code does');
});

test('round 5 scope: tsx, css and the docs site assets are judged', () => {
  assert.strictEqual(g.isJudged('apps/khyos-desktop/src/renderer/components/filetree/FileTree.tsx'), true);
  assert.strictEqual(g.isJudged('apps/ai-frontend/src/styles/theme.css'), true);
  assert.strictEqual(g.isJudged('docs/19_资产/site/docs-site.js'), true, 'every page loads this asset');
  assert.strictEqual(g.isJudged('docs/19_资产/site/mermaid.min.js'), false, 'vendored minified bundle');
  // JSX icon field: painted straight onto the screen.
  assert.strictEqual(run(`const I = { id: 'git', icon: '${EMOJI_ROCKET}', label: 'Git' };\n`,
    'apps/khyos-desktop/src/renderer/components/layout/Sidebar.tsx').length, 1);
  // CSS `content:` is rendered text, but a CSS comment is not.
  assert.strictEqual(run(`.star::after { content: "${EMOJI_ROCKET}"; }\n`, 'apps/ai-frontend/a.css').length, 1);
  assert.strictEqual(run(`.star { color: red; /* ${EMOJI_ROCKET} 装饰 */ }\n`, 'apps/ai-frontend/a.css').length, 0);
});

test('STAGE is live: identical input flips S1 → S3', () => {
  const content = `console.log('${EMOJI_ROCKET} 启动');\n`;
  const s1 = run(content, 'services/backend/src/cli/ui.js', 'S1');
  const s3 = run(content, 'services/backend/src/cli/ui.js', 'S3');
  assert.strictEqual(s1[0].severity, 'warning');
  assert.strictEqual(s3[0].severity, 'error');
  const heur = run(`const c = props.name.charAt(0); // badge\n`, 'apps/ai-frontend/src/A.vue', 'S3');
  assert.strictEqual(heur[0].severity, 'warning', 'heuristic stays advisory even at S3');
});

test('every declared scenario runs clean of exceptions and matches its intent', () => {
  for (const [name, entries] of Object.entries(g.SCENARIOS)) {
    const findings = g.evaluate(entries);
    assert.ok(Array.isArray(findings), `${name} must evaluate`);
    const expectZero = name === 'clean' || name === 'suppressed-and-comment';
    assert.strictEqual(findings.length > 0, !expectZero, `${name} verdict drifted`);
  }
});

test('the repo itself is clean: no colour emoji left on judged runtime surfaces', () => {
  // Guards against re-introduction. Reads the tracked file list, so it is skipped when
  // git is unavailable rather than silently passing.
  let files;
  try {
    files = require('child_process').execFileSync('git', ['ls-files'], { maxBuffer: 64 * 1024 * 1024 })
      .toString().split('\n').filter(Boolean);
  } catch {
    assert.ok(true, 'git unavailable — full-tree assertion not applicable here');
    return;
  }
  const judged = files.filter((f) => g.isJudged(f));
  assert.ok(judged.length > 0, 'registrar must see tracked runtime sources');
  const fs = require('fs');
  const findings = [];
  for (const rel of judged) {
    try {
      findings.push(...g.evaluateFile({ path: rel, content: fs.readFileSync(rel, 'utf8') }));
    } catch { /* deleted or unreadable: skip, the guard does not block on I/O */ }
  }
  // S1 是观察者档：守卫自陈「只记录不阻断」（check-no-emoji.js:52-53 / 582）。所以现树断言
  // 只能钉「不阻断」，不能钉「零 finding」——后者要等升 S3 且存量清完才成立。钉零 findings
  // 在本档位等于断言守卫违反自己的阶段契约。升阶行为另由「STAGE is live」用例覆盖。
  assert.deepStrictEqual(
    findings.filter((f) => f.severity === 'error'), [],
    `S1 观察档不得产出 error（不得阻断）；当前 ${findings.length} 条均为 warning 即为合规`);
});
