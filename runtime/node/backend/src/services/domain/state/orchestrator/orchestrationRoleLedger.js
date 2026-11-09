'use strict';

/**
 * orchestrationRoleLedger.js — thin IO shell for the per-role outcome ledger.
 *
 * Append-only JSONL, one file for all runs, under
 * getDataDir('orchestrator')/role-ledger.jsonl — same data root as the execution
 * journal (T1-domains/agents/orchestrator per DATA-LOCATIONS.json), so no new
 * top-level data entry is created.
 *
 * Why this exists: [RESEARCH-028] §4.1 P2-4 (DyLAN dynamic agent selection) says
 * "no data before it lands" — a selector that ranks roles by past success needs
 * the success history first. This module ONLY records; it never reads back into a
 * routing decision, and nothing in the run path consults it.
 *
 * Gate: KHY_ORCH_ROLE_LEDGER (default OFF). A new write-side mechanism ships dark
 * (PROCESS-008) until real runs show what is worth keeping; the escape hatch is
 * the same shape as the journal's.
 *
 * Every write is best-effort and never throws, so a broken data dir can never
 * break an orchestration run. Nothing is logged on failure on purpose: a ledger
 * that cannot be written is a silent degradation of a dark feature, and a vague
 * "写入失败" line would violate RUNTIME-002 without telling the user anything
 * they can act on.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_FILE = 'role-ledger.jsonl';
const DEFAULT_ROLE = 'general';
const MAX_ERROR_CHARS = 200;

function roleLedgerEnabled(env = process.env) {
  const raw = env ? env.KHY_ORCH_ROLE_LEDGER : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return false;
  }
  return ['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase());
}

function _ledgerDir() {
  // dataHome is the SSOT for the data home root; never hardcode a path here.
  const { getDataDir } = require('../../../../utils/dataHome');
  return getDataDir('orchestrator');
}

function roleLedgerPath() {
  return path.join(_ledgerDir(), LEDGER_FILE);
}

function _normalizeRole(role) {
  const str = String(role == null ? '' : role).trim();
  return str || DEFAULT_ROLE;
}

/**
 * Append one step outcome. Best-effort; returns true on write, false otherwise.
 * @param {object} outcome - { role, success, runId, stepId, durationMs, error }
 * @param {object} [env]
 * @returns {boolean}
 */
function appendRoleOutcome(outcome, env = process.env) {
  if (!roleLedgerEnabled(env)) {
    return false;
  }
  if (!outcome || typeof outcome !== 'object') {
    return false;
  }
  const record = {
    at: new Date().toISOString(),
    role: _normalizeRole(outcome.role),
    success: !!outcome.success,
    runId: outcome.runId == null ? null : String(outcome.runId),
    stepId: outcome.stepId == null ? null : String(outcome.stepId),
  };
  if (Number.isFinite(outcome.durationMs)) {
    record.durationMs = Math.round(outcome.durationMs);
  }
  if (!record.success && outcome.error) {
    record.error = String(outcome.error).slice(0, MAX_ERROR_CHARS);
  }
  try {
    const dir = _ledgerDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(roleLedgerPath(), JSON.stringify(record) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // never throw — ledger failure must not break the run
  }
}

/**
 * Read the ledger back into an array of records. Returns [] if absent/unreadable.
 * Read-side is ungated on purpose: a ledger written while the gate was on stays
 * readable after the gate flips off, so an observer can still collect samples.
 * @param {object} [env]
 * @returns {object[]}
 */
function readRoleLedger(env = process.env) {
  let text;
  try {
    text = fs.readFileSync(roleLedgerPath(), 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

module.exports = {
  LEDGER_FILE,
  roleLedgerEnabled,
  roleLedgerPath,
  appendRoleOutcome,
  readRoleLedger,
};
