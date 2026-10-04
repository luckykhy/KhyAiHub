'use strict';

/**
 * fileFormatData.js contract tests — the extension→format profile is the single
 * literal source the detector reads; these lock its shape, its deliberate
 * oddities and the skip list, so a retune cannot silently change detection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXT_FORMAT, SKIP_DIRS, UNKNOWN } = require('./fileFormatData');

test('EXT_FORMAT: every key is a lowercase dotted extension', () => {
  const keys = Object.keys(EXT_FORMAT);
  assert.ok(keys.length > 40, `profile must not be empty (got ${keys.length})`);
  for (const k of keys) {
    assert.match(k, /^\.[a-z0-9+]+$/, `${k}: dotted lowercase`);
    assert.equal(k, k.toLowerCase(), `${k}: already lowercase`);
  }
});

test('EXT_FORMAT: every entry carries format/category/mime and a language slot', () => {
  const categories = new Set();
  for (const [ext, p] of Object.entries(EXT_FORMAT)) {
    assert.equal(typeof p.format, 'string', `${ext}: format`);
    assert.equal(typeof p.category, 'string', `${ext}: category`);
    assert.equal(typeof p.mime, 'string', `${ext}: mime`);
    assert.ok('language' in p, `${ext}: language slot must exist (null is legal)`);
    if (p.category === 'code') {
      assert.equal(typeof p.language, 'string', `${ext}: code entries must name a language`);
    }
    categories.add(p.category);
  }
  assert.deepEqual([...categories].sort(), ['archive', 'code', 'data', 'document', 'image']);
});

test('EXT_FORMAT: the aliases that are easy to get wrong', () => {
  // MoonBit ships as .mbt in this repo while users say .moon — both must resolve.
  assert.deepEqual([EXT_FORMAT['.mbt'].format, EXT_FORMAT['.moon'].format], ['moonbit', 'moonbit']);
  // Header files keep their implementation language, not a "header" language.
  assert.equal(EXT_FORMAT['.h'].language, 'c');
  assert.equal(EXT_FORMAT['.h'].format, 'c-header');
  assert.equal(EXT_FORMAT['.hpp'].format, 'cpp-header');
  assert.equal(EXT_FORMAT['.hpp'].language, 'cpp');
  // JSX is javascript, TSX is typescript.
  assert.equal(EXT_FORMAT['.jsx'].format, 'javascript');
  assert.equal(EXT_FORMAT['.tsx'].format, 'typescript');
  // C-family spellings collapse onto one format.
  assert.deepEqual(
    ['.c', '.cpp', '.cc', '.cxx'].map((e) => EXT_FORMAT[e].format),
    ['c', 'cpp', 'cpp', 'cpp'],
  );
  // markdown has two spellings.
  assert.equal(EXT_FORMAT['.markdown'].format, EXT_FORMAT['.md'].format);
});

test('EXT_FORMAT: presentation files are documents, spreadsheets are data', () => {
  assert.equal(EXT_FORMAT['.pptx'].category, 'document');
  assert.equal(EXT_FORMAT['.xlsx'].category, 'data');
  assert.equal(EXT_FORMAT['.csv'].category, 'data');
  assert.equal(EXT_FORMAT['.zip'].category, 'archive');
  assert.equal(EXT_FORMAT['.iso'].category, 'archive');
});

test('EXT_FORMAT: mime of the office triple is the OOXML long form', () => {
  assert.match(EXT_FORMAT['.docx'].mime, /officedocument\.wordprocessingml\.document$/);
  assert.match(EXT_FORMAT['.xlsx'].mime, /officedocument\.spreadsheetml\.sheet$/);
  assert.match(EXT_FORMAT['.pptx'].mime, /officedocument\.presentationml\.presentation$/);
  assert.equal(EXT_FORMAT['.doc'].mime, 'application/msword');
});

test('SKIP_DIRS: vcs, dependency, build-output and agent-state dirs are all present', () => {
  assert.ok(SKIP_DIRS instanceof Set, 'must be a Set (membership-tested, not array-includes)');
  for (const d of [
    'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
    '.next', '.cache', 'coverage', '.venv', '__pycache__', '.vscode', '.ai',
    'vendor', 'bin', 'obj', 'tmp', 'site-packages',
  ]) {
    assert.ok(SKIP_DIRS.has(d), `skip list must contain ${d}`);
  }
  assert.equal(SKIP_DIRS.has('src'), false, 'source dirs are scanned');
  assert.equal(SKIP_DIRS.has('services'), false, 'no project-specific dir is skipped');
  assert.equal(SKIP_DIRS.has('.git/'), false, 'keys are bare names, not paths');
});

test('UNKNOWN: the fallback is a well-formed profile with an octet-stream mime', () => {
  assert.deepEqual(UNKNOWN, {
    format: 'unknown',
    language: null,
    category: 'unknown',
    mime: 'application/octet-stream',
  });
});

test('same module reference across requires (no per-caller copies to drift)', () => {
  const again = require('./fileFormatData');
  assert.equal(again.EXT_FORMAT, EXT_FORMAT);
  assert.equal(again.SKIP_DIRS, SKIP_DIRS);
  assert.equal(again.UNKNOWN, UNKNOWN);
  const detector = require('./fileFormatDetector');
  assert.equal(detector.EXT_FORMAT, EXT_FORMAT, 'detector must re-export the same object');
});
