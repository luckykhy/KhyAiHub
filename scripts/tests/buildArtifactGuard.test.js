'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const guard = require('../lib/buildArtifactGuard');

// The rule was repointed from apps/khy-mobile/android/ (isolated ghost endpoint,
// 0 git-tracked files — see [DESIGN-ARCH-120] §五) to the surviving Flutter app
// delivery/mobile/khy-os-client-app/android/. The rule is generic Gradle regenerable-output
// detection; these tests pin it to the surviving scope.

test('flags regenerable Android build artifacts', () => {
  const flagged = [
    'delivery/mobile/khy-os-client-app/android/app/build/outputs/apk/release/app-release.apk',
    'delivery/mobile/khy-os-client-app/android/app/build/intermediates/merged/classes.jar',
    'delivery/mobile/khy-os-client-app/android/.gradle/8.0/checksums/checksums.bin',
    'delivery/mobile/khy-os-client-app/android/app/.cxx/cmake/debug/x86/lib.so',
    'delivery/mobile/khy-os-client-app/android/app/release/app-release.aab',
    'delivery/mobile/khy-os-client-app/android/app/src/main/dump.hprof',
  ];
  for (const filePath of flagged) {
    const hit = guard.classifyPath(filePath);
    assert.ok(hit, filePath + ' should be flagged');
    assert.equal(hit.ruleId, 'android-build');
    assert.ok(hit.why.length > 0, 'a violation must explain why it is regenerable');
  }
});

test('never flags source, wrapper, or config that a clean checkout must rebuild from', () => {
  // Each of these once looked like a build artifact to a naive substring rule.
  // Deleting any of them breaks `gradlew assembleRelease` on a fresh clone, which
  // is strictly worse than leaving a few megabytes untracked.
  const safe = [
    'delivery/mobile/khy-os-client-app/android/gradlew',
    'delivery/mobile/khy-os-client-app/android/gradlew.bat',
    'delivery/mobile/khy-os-client-app/android/gradle/wrapper/gradle-wrapper.jar',
    'delivery/mobile/khy-os-client-app/android/gradle/wrapper/gradle-wrapper.properties',
    'delivery/mobile/khy-os-client-app/android/build.gradle',
    'delivery/mobile/khy-os-client-app/android/app/build.gradle',
    'delivery/mobile/khy-os-client-app/android/app/proguard-rules.pro',
    'delivery/mobile/khy-os-client-app/android/app/src/main/AndroidManifest.xml',
    'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khy/BuildConfig.java',
    'delivery/mobile/khy-os-client-app/android/app/src/main/res/values/strings.xml',
    'delivery/mobile/khy-os-client-app/android/settings.gradle',
  ];
  for (const filePath of safe) {
    assert.equal(guard.classifyPath(filePath), null, filePath + ' must not be flagged');
  }
});

test('scopes keep the rule from reaching outside delivery/mobile/khy-os-client-app/android', () => {
  // works/ship/build/ holds CI build *scripts* — the root .gitignore carries an
  // explicit `!works/ship/build/` exception for exactly this reason. A rule that
  // matched a bare `build` segment repo-wide would flag them.
  assert.equal(guard.classifyPath('works/ship/build/make-standalone.js'), null);
  assert.equal(guard.classifyPath('runtime/node/backend/dist/index.js'), null);
  assert.equal(guard.classifyPath('delivery/web/ai-frontend/dist/assets/app.js'), null);
  // The isolated ghost dir must not be flagged either — nothing lives there now.
  // Kept under delivery/mobile/ (the same parent as the scoped app) so this also
  // pins the scope boundary: a sibling app is out of scope even at the same depth.
  assert.equal(guard.classifyPath('delivery/mobile/khy-mobile/android/app/build/a.apk'), null);
});

test('windows separators are normalized before matching', () => {
  const hit = guard.classifyPath('delivery\\mobile\\khy-os-client-app\\android\\app\\build\\outputs\\app.apk');
  assert.ok(hit, 'backslash paths must classify identically');
  assert.equal(hit.path, 'delivery/mobile/khy-os-client-app/android/app/build/outputs/app.apk');
});

test('inspect survives dirty input without throwing', () => {
  const result = guard.inspect([null, undefined, 42, '', {}, 'delivery/mobile/khy-os-client-app/android/app/build/a.apk']);
  assert.equal(result.violations.length, 1);
  assert.equal(result.checked, 1);
});

test('env gate disables the guard without pretending the tree is clean', () => {
  const result = guard.inspect(
    ['delivery/mobile/khy-os-client-app/android/app/build/a.apk'],
    { KHY_BUILD_ARTIFACT_GUARD: '0' },
  );
  assert.equal(result.disabled, true);
  assert.equal(result.violations.length, 0);
  assert.match(guard.render(result), /disabled/);
});

test('render names the offending path so the fix is actionable', () => {
  const text = guard.render(guard.inspect(['delivery/mobile/khy-os-client-app/android/app/build/a.apk']));
  assert.match(text, /delivery\/mobile\/khy-os-client-app\/android\/app\/build\/a\.apk/);
  assert.match(text, /git rm --cached/);
});
