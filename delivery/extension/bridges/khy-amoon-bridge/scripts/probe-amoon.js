#!/usr/bin/env node
'use strict';

/**
 * scripts/probe-amoon.js — Phase 0 capability gate (no device access).
 *
 * It only prints instructions and records human-provided evidence. It never
 * runs adb, never writes to /sdcard, and never calls the model. A probe result
 * produced by the PC's adb is NOT evidence of amoon's ability; only amoon
 * running the three actions counts.
 *
 * Usage:
 *   node scripts/probe-amoon.js instructions [--state-dir <dir>] [--port <n>]
 *   node scripts/probe-amoon.js record --shell --http --file-write --file-read \
 *        --doze-writer --by <name> [--evidence <text>] [--state-dir <dir>]
 *   node scripts/probe-amoon.js show [--state-dir <dir>]
 */

const fs = require('fs');
const path = require('path');

const C = require('../lib/contracts');
const { loadConfig, ensureStateDirs } = require('../lib/config');

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @param {{config: object}} options
 * @returns {string[]} three instructions for amoon (or a human relaying them)
 */
function buildProbeInstructions(options = {}) {
  const config = options.config || loadConfig();
  const root = (config.remote && config.remote.root) || C.REMOTE_ROOT;
  const port = config.port || C.DEFAULTS.port;
  const tokenFile = (config.remote && config.remote.files && config.remote.files.token) || `${root}/token`;
  return [
    `[Phase 0 / a] 在 amoon 中执行：sh ${root}/kb health`,
    `[Phase 0 / b] 在 amoon 中向 ${root}/inbox/ 写一个 cmd_<id>.json（id 为 8..64 位 [A-Za-z0-9_-]），例如：` +
      `{"v":1,"id":"probe00001","tool":"ping","args":{}}`,
    `[Phase 0 / c] 在 amoon 中执行：TOKEN=$(cat ${tokenFile}); curl --noproxy '*' -sS --max-time 5 ` +
      `-H "Authorization: Bearer $TOKEN" http://127.0.0.1:${port}/health`,
    `只有以上三项由 amoon 自己完成才算证据；PC 侧 adb shell 的结果不算 amoon 能力。`,
  ];
}

/**
 * Record evidence and compute the gate status.
 *
 * @param {{config: object, evidence?: object, by?: string}} options
 * @returns {object} capability.json contents
 */
function recordCapability(options = {}) {
  const config = options.config || loadConfig();
  const evidence = options.evidence && typeof options.evidence === 'object' ? options.evidence : {};
  const shell = evidence.shell === true;
  const http = evidence.http === true;
  const fileWrite = evidence.fileWrite === true;
  const fileRead = evidence.fileRead === true;
  const dozeWriter = evidence.dozeWriter === true;
  const any = shell || http || fileWrite || fileRead || dozeWriter;
  const coreOk = shell && http && fileWrite;
  const status = !any
    ? C.CAPABILITY_STATUS.UNAVAILABLE
    : coreOk
      ? C.CAPABILITY_STATUS.VERIFIED
      : C.CAPABILITY_STATUS.PARTIAL;
  const record = {
    status,
    shell,
    http,
    fileWrite,
    fileRead,
    dozeWriter,
    evidence: typeof evidence.note === 'string' ? evidence.note.slice(0, 4000) : null,
    at: new Date().toISOString(),
    by: typeof options.by === 'string' && options.by ? options.by.slice(0, 200) : null,
  };
  ensureStateDirs(config);
  atomicWrite(config.paths.capability, record);
  return record;
}

function showCapability(config) {
  try {
    return JSON.parse(fs.readFileSync(config.paths.capability, 'utf8'));
  } catch {
    return { status: C.CAPABILITY_STATUS.UNVERIFIED, evidence: null };
  }
}

function parseArgs(argv) {
  const out = { command: argv[0] || 'instructions', flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--shell') out.flags.shell = true;
    else if (arg === '--http') out.flags.http = true;
    else if (arg === '--file-write') out.flags.fileWrite = true;
    else if (arg === '--file-read') out.flags.fileRead = true;
    else if (arg === '--doze-writer') out.flags.dozeWriter = true;
    else if (arg === '--by') out.flags.by = argv[++i] || null;
    else if (arg === '--evidence') out.flags.note = argv[++i] || null;
    else if (arg === '--state-dir') out.flags.stateDir = argv[++i] || null;
    else if (arg === '--port') out.flags.port = Number(argv[++i]);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const config = loadConfig({
    stateDir: parsed.flags.stateDir || undefined,
    env: parsed.flags.port ? { ...process.env, KHY_AMOON_PORT: String(parsed.flags.port) } : process.env,
  });

  if (parsed.command === 'instructions') {
    for (const line of buildProbeInstructions({ config })) process.stdout.write(`${line}\n`);
    return 0;
  }
  if (parsed.command === 'record') {
    const record = recordCapability({
      config,
      by: parsed.flags.by,
      evidence: {
        shell: parsed.flags.shell,
        http: parsed.flags.http,
        fileWrite: parsed.flags.fileWrite,
        fileRead: parsed.flags.fileRead,
        dozeWriter: parsed.flags.dozeWriter,
        note: parsed.flags.note,
      },
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  if (parsed.command === 'show') {
    process.stdout.write(`${JSON.stringify(showCapability(config), null, 2)}\n`);
    return 0;
  }
  process.stderr.write('用法：instructions | record [--shell --http --file-write --file-read --doze-writer --by <name>] | show\n');
  return 2;
}

module.exports = { buildProbeInstructions, recordCapability, showCapability, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
