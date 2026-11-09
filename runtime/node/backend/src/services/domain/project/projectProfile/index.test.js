'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PROJECT_PROFILE,
  VERSION_TRACK_SOURCES,
  WORKSPACE_SUFFIX_TEMPLATE,
  readVersionTracks,
  renderProfileSection,
} = require('./index.js');

/**
 * 仓库根：从本文件向上找 **同时** 有 CLAUDE.md 和 pyproject.toml 的目录。
 *
 * 两个坑都是实测踩到的：
 *   1. 数 `..` 层数——本单元在 domain/project/ 下已经 8 层，目录一搬数错就是静默读到
 *      错的根，测试只以一个"读不到轨道"的失败告终，指不到真正原因。
 *   2. 只锚 CLAUDE.md——runtime/node/backend/ 下也有一份 CLAUDE.md，向上 5 层就命中，
 *      于是"仓库根"被当成了 backend 目录，pyproject.toml 自然不在那儿。
 * 两个文件同时在场才认，搬走了会立刻说清缺哪个。
 */
const REPO_ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 20; i += 1) {
    const hasCharter = fs.existsSync(path.join(dir, 'CLAUDE.md'));
    const hasPackaging = fs.existsSync(path.join(dir, 'pyproject.toml'));
    if (hasCharter && hasPackaging) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'repo root not found: no directory above ' + __dirname +
      ' has both CLAUDE.md and pyproject.toml',
  );
})();

test('profile carries the identity an agent needs to know what it is maintaining', () => {
  assert.equal(PROJECT_PROFILE.name, 'khy-os');
  assert.match(PROJECT_PROFILE.oneLiner, /可扩展的应用运行时/);
  // 分发渠道写进去是有用的：agent 改版本时要先知道这项目有两条发布轨道。
  assert.match(PROJECT_PROFILE.distribution, /PyPI/);
  assert.match(PROJECT_PROFILE.distribution, /npm/);
});

test('all four red lines are present and non-empty', () => {
  // 少任何一条，agent 就有机会在不知情的情况下破线。
  const ids = PROJECT_PROFILE.redLines.map(([id]) => id);
  assert.deepEqual(ids, ['R1 分支纪律', 'R2 密钥防泄露', 'R3 版本同步', 'R4 上帝文件门']);
  for (const [, rule] of PROJECT_PROFILE.redLines) {
    assert.ok(rule.length > 0, '红线不能有空描述');
  }
});

test('no hardcoded version literal anywhere in the profile', () => {
  // 硬编码版本会和 check-copyright-readiness 的五处一致性打架，而且必然过期。
  // 先把 IP 形状的子串挖掉再匹配：127.0.0.1:8896 里的 0.1 会被 \d+\.\d+\.\d+ 命中，
  // 那条断言本来分不清版本号和地址，会给出假阳性。
  const serialized = JSON.stringify(PROJECT_PROFILE).replace(/\d+\.\d+\.\d+\.\d+/g, '<ip>');
  assert.doesNotMatch(serialized, /\b\d+\.\d+\.\d+\b/);
  // 也不该有 version 键——版本一律运行时读，见 readVersionTracks。
  assert.deepEqual(Object.keys(PROJECT_PROFILE).filter((k) => /version/i.test(k)), []);
});

test('no secret-shaped string in the profile', () => {
  // R2：画像会进系统提示、会烘进 APK，任何像密钥的东西都不能在这里出现。
  const serialized = JSON.stringify(PROJECT_PROFILE);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(serialized, /appSecret|apiKey|token\s*[:=]\s*["']/i);
});

test('renderProfileSection names the project and every red line', () => {
  const section = renderProfileSection();
  assert.match(section, /【项目画像：khy-os】/);
  for (const [id] of PROJECT_PROFILE.redLines) {
    assert.match(section, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(section, /B7 版本递增归人/);
});

test('workspace root only appears when one is supplied', () => {
  // 给了才渲染：手机侧新建对话可能还没挑目录，那句"当前工作目录：undefined"
  // 会让模型以为有个叫 undefined 的目录。
  assert.doesNotMatch(renderProfileSection(), /当前工作目录/);
  assert.match(renderProfileSection({ workspaceRoot: '/sdcard/khy-os' }), /当前工作目录：\/sdcard\/khy-os/);
});

test('version tracks render when present and are omitted cleanly when not', () => {
  const withTracks = renderProfileSection({
    versionTracks: [{ track: 'G1 主 khy-os 包', version: '9.9.9' }],
  });
  assert.match(withTracks, /G1 主 khy-os 包\s+9\.9\.9/);
  // 读不到版本时**列表标题**整条省略，不留一个空标题。
  // 断言必须钉在「版本轨道（」这个标题形状上：R3 红线文案里也有"版本轨道"四个字，
  // 用裸词断言会把红线文案一起否掉。
  assert.doesNotMatch(renderProfileSection(), /版本轨道（/);
});

test('readVersionTracks reads the real repo sources', () => {
  const repoRoot = REPO_ROOT;
  const tracks = readVersionTracks(repoRoot);
  assert.ok(tracks.length >= 1, '仓库根应该至少读得到一条轨道');
  for (const t of tracks) {
    assert.match(t.version, /^\d+\.\d+\.\d+$/, `${t.track} 应读出 semver`);
  }
});

test('readVersionTracks returns empty instead of throwing on a bogus root', () => {
  // 画像的价值在结构与红线；版本读不出来时静默省略，不让调用方崩。
  assert.deepEqual(readVersionTracks('/nonexistent/root/xyz'), []);
  assert.deepEqual(readVersionTracks(''), []);
  assert.deepEqual(readVersionTracks(undefined), []);
});

test('readVersionTracks tolerates a repo missing one track', () => {
  // 只放 G1 的真源，另两条读不到：应返回 1 条而不是抛。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-profile-'));
  try {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), 'version = "1.2.3"\n');
    const tracks = readVersionTracks(dir);
    assert.deepEqual(tracks, [{ track: 'G1 主 khy-os 包', version: '1.2.3' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VERSION_TRACK_SOURCES points at files that exist in this repo', () => {
  const repoRoot = REPO_ROOT;
  for (const src of VERSION_TRACK_SOURCES) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, src.file)),
      `${src.file} 不存在——真源路径漂了`,
    );
  }
});

// ── generated Dart stays in sync ───────────────────────────────────────────────────────
//
// The phone app holds a BAKED copy of this renderer's output. If someone edits
// the renderer and forgets to re-run the generator, the phone keeps describing
// the project the old way — and nothing reports it, because both sides still
// compile and both still look plausible. This assertion is the only thing that
// would notice.

const DART_PATH = path.join(
  REPO_ROOT,
  'delivery/mobile/khy-os-client-app/lib/core/config/project_profile.g.dart',
);

function readGeneratedDart() {
  if (!fs.existsSync(DART_PATH)) {
    throw new Error(
      DART_PATH + ' is missing — run: ' +
      'node scripts/project-profile/build-project-profile.js',
    );
  }
  return fs.readFileSync(DART_PATH, 'utf8');
}

test('the generated Dart carries the workspace suffix verbatim', () => {
  // The Dart side appends WORKSPACE_SUFFIX_TEMPLATE to its baked base. If the
  // generator ever hand-copies that string instead of importing it, the two
  // renderers drift and nothing complains — both compile, both look plausible.
  const dart = readGeneratedDart();
  assert.ok(
    dart.includes(JSON.stringify(WORKSPACE_SUFFIX_TEMPLATE)),
    'generated Dart workspaceSuffixTemplate drifted from WORKSPACE_SUFFIX_TEMPLATE — ' +
      're-run node scripts/project-profile/build-project-profile.js',
  );
});

test('the renderer really appends that same suffix', () => {
  // Ties the exported constant to what renderProfileSection actually emits, so a
  // future edit to one without the other is caught here rather than on a phone.
  const out = renderProfileSection({ workspaceRoot: '__ROOT__' });
  assert.ok(
    out.endsWith(WORKSPACE_SUFFIX_TEMPLATE.replace('%s', '__ROOT__')),
    'renderProfileSection no longer ends with WORKSPACE_SUFFIX_TEMPLATE',
  );
});

test('the generated Dart carries every red line verbatim', () => {
  const dart = readGeneratedDart();
  for (const [id, rule] of PROJECT_PROFILE.redLines) {
    assert.ok(dart.includes(JSON.stringify(id)), 'generated Dart is missing ' + id);
    assert.ok(
      dart.includes(JSON.stringify(rule)),
      'generated Dart is missing the wording of ' + id,
    );
  }
});
