'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ledger.js — append-only violation ledger at .khy/ruleguard/violations.jsonl.
 *
 * The ledger is the evidence source for "how do we know compliance is real":
 * it turns per-run stdout into queryable history. Only violations are
 * recorded (passes are not), so volume stays bounded.
 */

const LEDGER_DIR = path.join('works', 'data', 'khy', 'ruleguard');
const LEDGER_FILE = 'violations.jsonl';
const SPLIT_BYTES = 1024 * 1024;

/** Resolve the ledger path, honoring KHY_RULEGUARD_LEDGER for fixtures/tests. */
function ledgerPath(repoRoot) {
  const env = process.env.KHY_RULEGUARD_LEDGER;
  if (env) return path.resolve(env);
  return path.join(path.resolve(repoRoot), LEDGER_DIR, LEDGER_FILE);
}

/** Commit sha for ledger provenance; empty string when not in a git tree. */
function gitHead(repoRoot) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    return '';
  }
}

/**
 * Append finding records. Each record is one JSON line. Suppressed findings
 * are written with suppressed=true plus the reason, never dropped.
 * Returns the path written to.
 */
function append(repoRoot, records, extra = {}) {
  if (!Array.isArray(records) || !records.length) return null;

  const target = ledgerPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Rotate when the file grows past the split threshold.
  let suffix = '';
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > SPLIT_BYTES) {
      suffix = `-${new Date().toISOString().slice(0, 10)}`;
    }
  } catch (error) {
    suffix = '';
  }

  const lines = records.map((record) => JSON.stringify({
    ts: extra.ts || new Date().toISOString(),
    gate: extra.gate || 'local',
    mode: extra.mode || 'run',
    commit: extra.commit || gitHead(repoRoot),
    checker: record.checker || '',
    finding: record.finding || '',
    rule: record.rule || '',
    priority: record.priority || '',
    strength: record.strength || '',
    file: record.file || '',
    line: record.line || 0,
    message: record.message || '',
    suppressed: Boolean(record.suppressed),
    suppressionReason: record.suppressionReason || '',
  })).join('\n') + '\n';

  fs.appendFileSync(suffix ? target.replace(LEDGER_FILE, `${LEDGER_FILE.replace(/\.jsonl$/, '')}${suffix}.jsonl`) : target, lines);
  return suffix ? target.replace(LEDGER_FILE, `${LEDGER_FILE.replace(/\.jsonl$/, '')}${suffix}.jsonl`) : target;
}

/** Read back the ledger as an array (newest last). Corrupt lines are skipped. */
function readAll(repoRoot) {
  const target = ledgerPath(repoRoot);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

/** Count active suppressions by rule id (for the coverage report). */
function activeSuppressions(repoRoot) {
  const byRule = {};
  for (const record of readAll(repoRoot)) {
    if (!record.suppressed) continue;
    byRule[record.rule] = (byRule[record.rule] || 0) + 1;
  }
  return byRule;
}

/**
 * Aggregate the ledger for the read-side report (the append side had no query
 * surface before: the ledger "wrote and sank" — no way to answer "which rule
 * is over baseline lately" / "which file is a repeat offender"). Pure read;
 * empty/missing ledger → an empty aggregate, never an error.
 */
function aggregate(repoRoot) {
  const records = readAll(repoRoot);
  const byRule = {};
  const byFile = {};
  const byGate = {};
  const byCommit = {};
  for (const r of records) {
    const rule = r.rule || '(unmapped)';
    const file = r.file || '(no-file)';
    const gate = r.gate || 'local';
    const commit = r.commit || '(unknown)';
    byRule[rule] = (byRule[rule] || 0) + 1;
    byFile[file] = (byFile[file] || 0) + 1;
    byGate[gate] = (byGate[gate] || 0) + 1;
    byCommit[commit] = (byCommit[commit] || 0) + 1;
  }
  const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return {
    total: records.length,
    suppressed: records.filter((r) => r.suppressed).length,
    byRule: sortDesc(byRule),
    byFile: sortDesc(byFile),
    byGate: sortDesc(byGate),
    // by-commit violation counts, oldest first — the trend series the coverage
    // report reads. Commits sort by first-seen order in the file (append order).
    byCommit: Object.entries(byCommit),
    span: {
      first: records.length ? records[0].ts : null,
      last: records.length ? records[records.length - 1].ts : null,
    },
  };
}

/**
 * SARIF 2.1.0 export (Checkov pattern): the ledger / findings as a SARIF run
 * so GitHub code scanning (or any SARIF consumer) can annotate violation lines
 * without re-parsing this repo's dialect. `results` are the aggregated records
 * themselves (readAll output or per-run findings). Pure function, zero IO.
 */
function toSarif(records, tool = 'khy-ruleguard') {
  const rules = [];
  const ruleIndex = new Map();
  const results = [];
  for (const r of records) {
    const id = r.rule || r.finding || 'unknown';
    if (!ruleIndex.has(id)) {
      ruleIndex.set(id, rules.length);
      rules.push({
        id,
        shortDescription: { text: (r.message || id).slice(0, 180) },
        defaultConfiguration: { level: r.strength === 'blocking' ? 'error' : 'warning' },
      });
    }
    results.push({
      ruleId: id,
      ruleIndex: ruleIndex.get(id),
      level: r.strength === 'blocking' ? 'error' : 'warning',
      message: { text: (r.message || r.finding || id).slice(0, 300) },
      locations: r.file ? [{
        physicalLocation: {
          artifactLocation: { uri: String(r.file).replace(/\\/g, '/') },
          region: { startLine: Number(r.line) || 1 },
        },
      }] : [],
      suppressed: r.suppressed ? true : undefined,
    });
  }
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: tool, rules } },
      results,
    }],
  };
}

module.exports = { LEDGER_DIR, ledgerPath, append, readAll, activeSuppressions, aggregate, toSarif };
