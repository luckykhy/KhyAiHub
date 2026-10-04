'use strict';

/**
 * Co-located behaviour tests for ./index.js (compaction orchestrator).
 * Pure in-process: the orchestrator never calls the model itself.
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('./index');
const {
  sessionMemoryCompact,
  microCompact,
  applyCompaction,
  getCompactionPrompt,
  shouldCompact,
} = leaf;
const promptLeaf = require('./prompt');

/** n messages whose content length is EXACTLY chars, so the chars/4 math is checkable. */
function exact(n, chars) {
  return Array.from({ length: n }, () => ({ role: 'user', content: 'x'.repeat(chars) }));
}

function tagged(body) {
  return `<analysis>scratch</analysis><summary>${body}</summary>`;
}

// ── constants ──────────────────────────────────────────────────────────

test('exposes the documented compaction constants', () => {
  assert.strictEqual(leaf.DEFAULT_PRESERVE_RECENT, 10);
  assert.strictEqual(leaf.MIN_MESSAGES_FOR_COMPACTION, 20);
  assert.strictEqual(typeof leaf.formatCompactSummary, 'function');
  assert.strictEqual(typeof leaf.getCompactUserMessage, 'function');
  // the prompt leaf is re-exported, so consumers can require either entry
  assert.strictEqual(leaf.formatCompactSummary, promptLeaf.formatCompactSummary);
});

// ── sessionMemoryCompact ───────────────────────────────────────────────

test('sessionMemoryCompact skips under the floor and keeps everything', () => {
  const msgs = exact(leaf.MIN_MESSAGES_FOR_COMPACTION - 1, 8);
  const out = leaf.sessionMemoryCompact(msgs);
  assert.strictEqual(out.prompt, null);
  assert.deepStrictEqual(out.toSummarize, []);
  assert.strictEqual(out.toPreserve.length, msgs.length);
  assert.strictEqual(out.metadata.skipped, true);
  assert.match(out.metadata.reason, /Too few messages/);
});

test('sessionMemoryCompact at exactly the floor compacts', () => {
  const out = leaf.sessionMemoryCompact(exact(leaf.MIN_MESSAGES_FOR_COMPACTION, 8));
  assert.strictEqual(out.metadata.skipped, false);
  assert.strictEqual(out.toSummarize.length, 10);
  assert.strictEqual(out.toPreserve.length, 10);
});

test('sessionMemoryCompact splits at length - preserveRecent', () => {
  const msgs = exact(30, 8);
  const out = leaf.sessionMemoryCompact(msgs);
  assert.strictEqual(out.toSummarize.length, 20);
  assert.strictEqual(out.toPreserve.length, 10);
  // nothing lost: the two halves reassemble into the original order
  assert.deepStrictEqual(out.toSummarize.concat(out.toPreserve), msgs);
  assert.strictEqual(out.metadata.originalCount, 30);
  assert.strictEqual(out.metadata.summarizedCount, 20);
  assert.strictEqual(out.metadata.preservedCount, 10);
});

test('sessionMemoryCompact honours a custom preserveRecent', () => {
  const out = leaf.sessionMemoryCompact(exact(30, 8), { preserveRecent: 4 });
  assert.strictEqual(out.toPreserve.length, 4);
  assert.strictEqual(out.toSummarize.length, 26);
});

test('sessionMemoryCompact over-preserving keeps the whole transcript verbatim', () => {
  const out = leaf.sessionMemoryCompact(exact(25, 8), { preserveRecent: 99 });
  assert.deepStrictEqual(out.toSummarize, []);
  assert.strictEqual(out.toPreserve.length, 25);
});

test('sessionMemoryCompact tolerates a null message list', () => {
  const out = leaf.sessionMemoryCompact(null);
  assert.strictEqual(out.prompt, null);
  assert.deepStrictEqual(out.toPreserve, []);
  assert.strictEqual(out.metadata.skipped, true);
});

// ── microCompact ───────────────────────────────────────────────────────

test('microCompact skips while shorter than window + 5', () => {
  const msgs = exact(12, 8);
  const out = microCompact(msgs);
  assert.strictEqual(out.prompt, null);
  assert.deepStrictEqual(out.windowMessages, []);
  assert.strictEqual(out.remainingMessages.length, 12);
  assert.strictEqual(out.metadata.skipped, true);
});

test('microCompact summarizes only the oldest window', () => {
  const msgs = exact(20, 8);
  const out = microCompact(msgs, { windowSize: 6 });
  assert.strictEqual(out.windowMessages.length, 6);
  assert.strictEqual(out.remainingMessages.length, 14);
  assert.deepStrictEqual(out.windowMessages.concat(out.remainingMessages), msgs);
  assert.strictEqual(out.metadata.windowSize, 6);
  assert.strictEqual(out.metadata.remainingCount, 14);
});

test('microCompact defaults its window to 10', () => {
  const out = microCompact(exact(16, 8));
  assert.strictEqual(out.windowMessages.length, 10);
  assert.strictEqual(out.remainingMessages.length, 6);
});

// ── applyCompaction ────────────────────────────────────────────────────

test('applyCompaction puts a user summary message first, then the preserved tail', () => {
  const preserved = exact(3, 8);
  const out = applyCompaction(tagged('done the thing'), preserved);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(out[0].content.startsWith('This session is being continued'), true);
  assert.strictEqual(out[0].content.includes('done the thing'), true);
  assert.strictEqual(out[0]._meta.type, 'compaction_summary');
  assert.deepStrictEqual(out.slice(1), preserved);
});

test('applyCompaction with no preserved messages does not claim verbatim tail', () => {
  const out = applyCompaction(tagged('x'), []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content.includes('preserved verbatim'), false);
});

test('applyCompaction threads transcriptPath and suppressFollowUp through', () => {
  const out = applyCompaction(tagged('x'), exact(2, 8), {
    transcriptPath: '/tmp/t.jsonl',
    suppressFollowUp: true,
  });
  assert.strictEqual(out[0].content.includes('/tmp/t.jsonl'), true);
  assert.strictEqual(out[0].content.includes('Resume directly'), true);
});

// ── getCompactionPrompt / shouldCompact ────────────────────────────────

test('getCompactionPrompt picks the variant', () => {
  const full = getCompactionPrompt(exact(5, 8), 'full');
  const partial = getCompactionPrompt(exact(5, 8), 'partial');
  assert.match(full, /detailed summary of the conversation so far/);
  assert.match(partial, /RECENT portion/);
  assert.strictEqual(getCompactionPrompt(exact(5, 8)).includes('RECENT portion'), false);
});

test('shouldCompact is silent on an empty transcript', () => {
  assert.deepStrictEqual(shouldCompact([], 8000), { needed: false, urgency: 'none', estimatedTokens: 0 });
  assert.deepStrictEqual(shouldCompact(null, 8000), { needed: false, urgency: 'none', estimatedTokens: 0 });
});

test('shouldCompact estimates string content at ceil(chars/4) per message', () => {
  // 10 × 400 chars = 4000 tokens; window 8000 → reserve clamped to 2400 → 5600 available.
  const r = shouldCompact(exact(10, 400), 8000);
  assert.strictEqual(r.estimatedTokens, 1000);
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.urgency, 'none');
});

test('shouldCompact escalates urgency at 0.7 and 0.9 of the available budget', () => {
  // available = 8000 − 2400 = 5600 → soon at 3920, now at 5040.
  const soon = shouldCompact(exact(10, 1600), 8000); // 4000 tokens
  assert.strictEqual(soon.estimatedTokens, 4000);
  assert.strictEqual(soon.needed, true);
  assert.strictEqual(soon.urgency, 'soon');

  const now = shouldCompact(exact(10, 2100), 8000); // 5250 tokens
  assert.strictEqual(now.urgency, 'now');
});

test('shouldCompact survives the block-array content shape', () => {
  // msg.content is a string OR a block array; the non-string branch stringifies.
  const msgs = [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(400) }] }];
  const r = shouldCompact(msgs, 8000);
  assert.ok(r.estimatedTokens > 100);
  assert.strictEqual(typeof r.estimatedTokens, 'number');
  assert.strictEqual(Number.isNaN(r.estimatedTokens), false);
});

test('shouldCompact counts a content-less message as the empty JSON literal', () => {
  // undefined content → JSON.stringify('') → '""' → 2 chars → ceil(2/4) = 1 token.
  const r = shouldCompact([{ role: 'assistant' }], 8000);
  assert.strictEqual(r.estimatedTokens, 1);
  assert.strictEqual(r.needed, false);
});
