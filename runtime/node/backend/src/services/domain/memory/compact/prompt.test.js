'use strict';

/**
 * Co-located behaviour tests for ./prompt.js (compaction prompt templates).
 * Pure string computation — no model call, no IO.
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('./prompt');
const {
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
  getCompactPrompt,
  getPartialCompactPrompt,
  getAnchoredCompactPrompt,
  formatCompactSummary,
  getCompactUserMessage,
} = leaf;

// ── templates ──────────────────────────────────────────────────────────

test('both variants are wrapped by the no-tools preamble and trailer', () => {
  for (const p of [getCompactPrompt(), getPartialCompactPrompt(), getAnchoredCompactPrompt()]) {
    assert.strictEqual(p.startsWith(NO_TOOLS_PREAMBLE), true);
    assert.strictEqual(p.endsWith(NO_TOOLS_TRAILER), true);
  }
});

test('the two variants differ in scope wording and share the 9-section contract', () => {
  const full = getCompactPrompt();
  const partial = getPartialCompactPrompt();
  assert.notStrictEqual(full, partial);
  assert.match(full, /summary of the conversation so far/);
  assert.match(partial, /RECENT portion/);
  // partial must tell the model the earlier context is already retained
  assert.match(partial, /earlier messages are being kept intact/);
  for (const section of [
    '1. Primary Request and Intent',
    '2. Key Technical Concepts',
    '3. Files and Code Sections',
    '6. All user messages',
    '9. Optional Next Step',
  ]) {
    assert.strictEqual(full.includes(section), true, `full missing ${section}`);
    assert.strictEqual(partial.includes(section), true, `partial missing ${section}`);
  }
});

test('customInstructions are appended verbatim only when non-blank', () => {
  const withText = getCompactPrompt('focus on test output');
  assert.strictEqual(withText.includes('Additional Instructions:\nfocus on test output'), true);
  // blank/whitespace/absent must not inject an empty instruction block
  for (const blank of [undefined, '', '   ', '\n']) {
    assert.strictEqual(getCompactPrompt(blank), getCompactPrompt(), 'blank leaked a block');
    assert.strictEqual(getPartialCompactPrompt(blank), getPartialCompactPrompt(), 'blank leaked a block');
  }
});

// ── formatCompactSummary ───────────────────────────────────────────────

test('formatCompactSummary drops the analysis scratchpad and unwraps the summary', () => {
  const raw = '<analysis>private drafting\nlines</analysis>\n<summary>\n  1. Goal: ship it  \n</summary>';
  assert.strictEqual(formatCompactSummary(raw), 'Summary:\n1. Goal: ship it');
});

test('formatCompactSummary passes an untagged model reply through, trimmed', () => {
  assert.strictEqual(formatCompactSummary('   just plain text  \n\n'), 'just plain text');
});

test('formatCompactSummary keeps model prose around the tags', () => {
  const raw = 'prefix <analysis>x</analysis>mid <summary>s</summary> suffix';
  assert.strictEqual(formatCompactSummary(raw), 'prefix mid Summary:\ns suffix');
});

test('formatCompactSummary only rewrites the first tag pair of each kind', () => {
  // Non-global regexes: a second <analysis>/<summary> block survives as raw tags.
  const two = '<analysis>a</analysis><summary>x</summary><analysis>b</analysis><summary>y</summary>';
  const out = formatCompactSummary(two);
  assert.strictEqual(out.startsWith('Summary:\nx'), true);
  assert.strictEqual(out.includes('<analysis>b</analysis>'), true);
  assert.strictEqual(out.includes('<summary>y</summary>'), true);
});

test('formatCompactSummary requires a string (no content-block coercion here)', () => {
  // Contract: callers must pass the model's text, not msg.content (which can be
  // a block array). Pinning it keeps a future wiring change honest.
  assert.throws(() => formatCompactSummary(undefined), TypeError);
  assert.throws(() => formatCompactSummary([{ type: 'text', text: 'x' }]), TypeError);
});

// ── getCompactUserMessage ──────────────────────────────────────────────

test('getCompactUserMessage builds the continuation header with the formatted body', () => {
  const msg = getCompactUserMessage('<summary>alpha</summary>');
  assert.strictEqual(msg.startsWith('This session is being continued'), true);
  assert.strictEqual(msg.includes('Summary:\nalpha'), true);
  assert.strictEqual(msg.includes('<summary>'), false);
  assert.strictEqual(msg.includes('If you need specific details'), false);
  assert.strictEqual(msg.includes('preserved verbatim'), false);
});

test('getCompactUserMessage optional clauses are each independently gated', () => {
  const withAll = getCompactUserMessage('<summary>a</summary>', {
    transcriptPath: '/tmp/x.jsonl',
    recentPreserved: true,
    suppressFollowUp: true,
  });
  assert.strictEqual(withAll.includes('/tmp/x.jsonl'), true);
  assert.strictEqual(withAll.includes('Recent messages are preserved verbatim.'), true);
  assert.strictEqual(withAll.includes('Resume directly'), true);
  // transcriptPath is the only clause that mentions the path
  const onlyPath = getCompactUserMessage('<summary>a</summary>', { transcriptPath: '/tmp/y' });
  assert.strictEqual(onlyPath.includes('/tmp/y'), true);
  assert.strictEqual(onlyPath.includes('Resume directly'), false);
});

test('getCompactUserMessage falsy options omit their clause', () => {
  const base = getCompactUserMessage('<summary>a</summary>');
  for (const opts of [{ transcriptPath: '' }, { transcriptPath: null }, { recentPreserved: 0 }, { suppressFollowUp: false }]) {
    assert.strictEqual(getCompactUserMessage('<summary>a</summary>', opts), base);
  }
});

// ── getAnchoredCompactPrompt ───────────────────────────────────────────

test('anchored prompt starts fresh when there is no previous summary', () => {
  const p = getAnchoredCompactPrompt();
  assert.strictEqual(p.includes('Create a new anchored summary'), true);
  assert.strictEqual(p.includes('<previous-summary>'), false);
  assert.strictEqual(p.includes('## Goal'), true);
  assert.strictEqual(p.includes('## Relevant Files'), true);
});

test('anchored prompt echoes the previous summary inside its tag pair', () => {
  const p = getAnchoredCompactPrompt({ previousSummary: 'old summary body' });
  assert.strictEqual(p.includes('Update the anchored summary below'), true);
  assert.strictEqual(p.includes('<previous-summary>\nold summary body\n</previous-summary>'), true);
  assert.strictEqual(p.includes('Create a new anchored summary'), false);
});

test('anchored prompt joins context lines and honours customInstructions', () => {
  const p = getAnchoredCompactPrompt({ context: ['line one', 'line two'], customInstructions: 'keep diffs' });
  assert.strictEqual(p.includes('Additional context:\nline one\nline two'), true);
  assert.strictEqual(p.includes('Additional Instructions:\nkeep diffs'), true);
  assert.strictEqual(getAnchoredCompactPrompt({ context: [] }).includes('Additional context'), false);
});

test('anchored prompt defaults context only for an absent key', () => {
  // [] (and undefined) use the default; an explicit null reaches .length and throws.
  assert.throws(() => getAnchoredCompactPrompt({ context: null }), TypeError);
});
