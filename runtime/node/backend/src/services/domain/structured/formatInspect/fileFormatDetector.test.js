'use strict';

/**
 * fileFormatDetector.js contract tests — the pure detection layer (extension
 * profile, magic bytes, binary heuristic) is what every read/replace tool trusts,
 * so its decision tables are locked here. detectFile/inspectProject do real IO and
 * are exercised by the repo-level suite instead of being faked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXT_FORMAT,
  SKIP_DIRS,
  fromExtension,
  detectByMagic,
  looksBinary,
  detectBuffer,
} = require('./fileFormatDetector');

test('fromExtension: dotted and dotless spellings agree, case is ignored', () => {
  assert.deepEqual(fromExtension('js'), fromExtension('.js'));
  assert.deepEqual(fromExtension('JS'), fromExtension('.js'));
  assert.deepEqual(fromExtension('  .PY  '.trim()), fromExtension('py'));
  assert.equal(fromExtension('.js').format, 'javascript');
  assert.equal(fromExtension('.py').language, 'python');
});

test('fromExtension: unknown and empty spellings fall back to the UNKNOWN profile', () => {
  for (const e of ['.xyz', '', null, undefined, 'nope']) {
    const p = fromExtension(e);
    assert.equal(p.format, 'unknown', `${String(e)}: format`);
    assert.equal(p.category, 'unknown', `${String(e)}: category`);
    assert.equal(p.language, null, `${String(e)}: language`);
    assert.equal(p.mime, 'application/octet-stream', `${String(e)}: mime`);
  }
});

test('fromExtension hands out copies — a caller mutation cannot poison the table', () => {
  const p = fromExtension('.md');
  assert.notEqual(p, EXT_FORMAT['.md'], 'must not be the table object itself');
  p.format = 'MUTATED';
  p.category = 'MUTATED';
  assert.equal(fromExtension('.md').format, 'markdown', 'table still intact after the mutation');
  assert.equal(EXT_FORMAT['.md'].category, 'document');
});

test('detectByMagic: nothing to read yields null rather than a guess', () => {
  for (const empty of [null, undefined, Buffer.alloc(0), '']) {
    assert.equal(detectByMagic(empty), null, String(empty));
  }
});

test('detectByMagic: signature table (PDF / PNG / JPEG / ELF / PE)', () => {
  const cases = [
    [Buffer.from('%PDF-1.7\n'), { format: 'pdf', category: 'document', mime: 'application/pdf' }],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), { format: 'png', category: 'image', mime: 'image/png' }],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { format: 'jpeg', category: 'image', mime: 'image/jpeg' }],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { format: 'elf', category: 'binary', mime: 'application/x-elf' }],
    [Buffer.from([0x4d, 0x5a, 0x90]), { format: 'pe', category: 'binary', mime: 'application/x-dosexec' }],
  ];
  for (const [buf, want] of cases) {
    const got = detectByMagic(buf);
    assert.ok(got, `must recognise ${want.format}`);
    assert.equal(got.format, want.format);
    assert.equal(got.category, want.category);
    assert.equal(got.mime, want.mime);
  }
  assert.equal(detectByMagic(Buffer.from('just plain text, no signature at all')), null);
});

test('detectByMagic: a prefix shorter than the signature must not match', () => {
  assert.equal(detectByMagic(Buffer.from([0x89, 0x50])), null, 'truncated PNG magic');
  assert.equal(detectByMagic(Buffer.from('%PD')), null, 'truncated %PDF-');
});

test('looksBinary: NUL anywhere in the window is decisive; clean text is not binary', () => {
  assert.equal(looksBinary(null), false);
  assert.equal(looksBinary(Buffer.alloc(0)), false);
  assert.equal(looksBinary(Buffer.from('你好 hello\r\n\tform-feed \f and spaces')), false);
  assert.equal(looksBinary(Buffer.from([0x41, 0x42, 0x00, 0x43])), true, 'one NUL byte');
  const controlHeavy = Buffer.alloc(100, 0x01);
  assert.equal(looksBinary(controlHeavy), true, '>30% control bytes');
  const mostlyText = Buffer.concat([Buffer.from('a'.repeat(80)), Buffer.alloc(20, 0x01)]);
  assert.equal(looksBinary(mostlyText), false, '20% control stays under the 0.3 ratio');
});

test('detectBuffer: content wins over the extension, with confidence=magic', () => {
  const r = detectBuffer(Buffer.from('%PDF-1.4\n'), 'resume.txt');
  assert.equal(r.format, 'pdf', 'a pdf payload disguised as .txt is reported as pdf');
  assert.equal(r.confidence, 'magic');
  const ok = detectBuffer(Buffer.from('%PDF-1.4\n'), 'resume.pdf');
  assert.equal(ok.format, 'pdf');
  assert.equal(ok.mismatch, false, 'matching ext and magic must not flag a conflict');
});

test('the detector re-exports the data leaf by reference (no second profile table)', () => {
  const data = require('./fileFormatData');
  assert.equal(EXT_FORMAT, data.EXT_FORMAT);
  assert.equal(SKIP_DIRS, data.SKIP_DIRS);
});

test('prototype keys cannot reach the bare table lookup (keys are dot-normalised)', () => {
  for (const hostile of ['constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'toString']) {
    const p = fromExtension(hostile);
    assert.equal(p.format, 'unknown', `${hostile}: must not resolve an inherited member`);
    assert.equal(p.mime, 'application/octet-stream', `${hostile}: UNKNOWN fallback`);
  }
  assert.equal(EXT_FORMAT['.constructor'], undefined, 'no dotted spelling of a prototype key exists');
});
