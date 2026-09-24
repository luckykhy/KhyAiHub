'use strict';

/**
 * Regression for undeclared sub-command verbs: a handler branch that exists in
 * the source but is missing from the command's own `subCommands` declaration is
 * unreachable, and the user silently gets a *different* view with exit code 0.
 *
 *   khy repo info      -> 「📂 当前项目状态」 (the status view, not the workspace one)
 *   khy project struct -> the 「📁 项目分析命令」 usage wall
 *
 * Unlike `receipts-orch-routing.test.js`, which calls the handler directly,
 * every case below goes through the real routing chain
 * (`parseInput` -> `commandAutoRegistry.dispatch` -> `_alignSubCommand` ->
 * manifest handler), because the bug lives in that chain and a direct handler
 * call cannot see it.
 *
 * Layer two is a static drift guard: every verb a dispatch switch compares
 * against must appear in the manifest that feeds the parser.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '../..');
const { parseInput } = require(path.join(BE, 'src/cli/router'));
const registry = require(path.join(BE, 'src/cli/commandAutoRegistry'));
const { MANIFEST_EXPORT_KEY } = require(path.join(BE, 'src/cli/commandManifest'));

// A small real directory so the structural/scan branches do bounded work.
const TINY = path.resolve(BE, '../../platform/khy_platform');

function loadManifest(rel) {
  const file = path.join(BE, rel);
  const { [MANIFEST_EXPORT_KEY]: manifest, ...rest } = require(file);
  void rest;
  return { file, manifest };
}

const project = loadManifest('src/cli/handlers/project.js');
const repo = loadManifest('src/cli/handlers/repo.js');

// node:test reports the child process's exit status for the whole file, so a
// handler that legitimately marks failure (process.exitCode = 1) would fail
// every case in here. run() exposes the marking through `lastExitCode` and then
// restores it.
let lastExitCode;

/** Run a whole command line through the real dispatcher, capturing its output. */
async function run(line) {
  assert.ok(fs.existsSync(TINY), `fixture directory missing: ${TINY}`);
  const parsed = parseInput(line);
  const chunks = [];
  const sink = (c) => {
    chunks.push(String(c));
    return true;
  };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = sink;
  process.stderr.write = sink;
  const savedExitCode = process.exitCode;
  let handled;
  try {
    handled = await registry.dispatch(parsed.command, { parsed });
    lastExitCode = process.exitCode;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = savedExitCode;
  }
  assert.ok(handled.handled, `nothing dispatched for "${line}" — routing chain broken`);
  return chunks.join('').replace(/\u001B\[[0-9;]*m/g, '');
}

// ── repo: `info` was swallowed by the bare-form case ────────────────────

test('khy repo info renders the workspace overview', async () => {
  const out = await run(`repo info`);
  assert.ok(out.includes('当前工作区'), `info branch not reached: ${out}`);
  assert.ok(!out.includes('当前项目状态'), `info still answered with the status view: ${out}`);
});

test('positive controls — repo status / repo workspace unchanged', async () => {
  const status = await run('repo status');
  assert.ok(status.includes('当前项目状态'), `status view lost: ${status}`);
  const ws = await run('repo workspace');
  assert.ok(ws.includes('当前工作区'), `workspace view lost: ${ws}`);
});

test('a bare `khy repo` still defaults to the status view', async () => {
  const out = await run('repo');
  assert.ok(out.includes('当前项目状态'), `bare repo lost its default: ${out}`);
  assert.ok(!out.includes('未知子命令'), `bare repo reported an unknown verb: ${out}`);
  assert.ok(!lastExitCode, `bare "repo" marked the process failed: ${lastExitCode}`);
});

// Second half of the same verb slot: the handler's own 「未知子命令」 branch was
// unreachable, so any typo rendered the status view with exit code 0.
test('an undeclared verb is rejected instead of rendering the status view', async () => {
  const out = await run('repo statuss');
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out}`);
  assert.ok(out.includes('statuss'), `typo not echoed back to the user: ${out}`);
  assert.ok(!out.includes('当前项目状态'), `typo still rendered the status view: ${out}`);
  assert.strictEqual(lastExitCode, 1, 'a usage error must also fail the shell, not just print red');
});

test('the repo hint advertises every declared verb', async () => {
  const out = await run('repo zzz-not-a-verb');
  for (const verb of repo.manifest.subCommands) {
    assert.ok(out.includes(verb), `hint omits declared verb "${verb}"`);
  }
});

// ── project: five implemented verbs were never typeable ─────────────────

for (const verb of ['struct', 'mini']) {
  test(`khy project ${verb} renders its own view, not the help wall`, async () => {
    const out = await run(`project ${verb} ${TINY}`);
    assert.ok(!out.includes('项目分析命令'), `${verb} still printed the usage wall`);
    assert.ok(out.trim().length > 0, `${verb} printed nothing`);
  });
}

test('khy project struct reaches the structure view', async () => {
  const out = await run(`project struct ${TINY}`);
  assert.ok(out.includes('项目结构分析'), `struct branch not reached: ${out.slice(0, 200)}`);
});

test('positive control — khy project structure is unchanged', async () => {
  const out = await run(`project structure ${TINY}`);
  assert.ok(out.includes('项目结构分析'), `structure view lost: ${out.slice(0, 200)}`);
});

test('khy project find reaches the scan view and reports matches', async () => {
  const out = await run(`project find *.py --path ${TINY}`);
  assert.ok(out.includes('扫描结果'), `find branch not reached: ${out.slice(0, 200)}`);
  const m = /共 (\d+) 个文件/.exec(out);
  assert.ok(m && Number(m[1]) > 0, `scan reported zero files over a non-empty directory: ${out}`);
});

test('a bare `khy project` still prints the usage help', async () => {
  const out = await run('project');
  assert.ok(out.includes('项目分析命令'), `bare project lost its help: ${out.slice(0, 200)}`);
});

// ── Layer two: the declaration must not drift from the dispatch ──────────

/** Case labels of one dispatch switch, as written in the source. */
function switchVerbs(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf(`async function ${fnName}(`);
  assert.ok(start >= 0, `fixture guard: ${fnName} not found in ${path.basename(file)}`);
  const body = src.slice(start, src.indexOf('\n}', start));
  const verbs = new Set();
  for (const m of body.matchAll(/^\s*case\s+'([a-z][a-z0-9-]{2,})'\s*:/gm)) verbs.add(m[1]);
  return verbs;
}

test('drift guard: every project verb the switch dispatches is declared', () => {
  const verbs = switchVerbs(project.file, 'handleProjectCommand');
  assert.ok(verbs.has('struct'), 'fixture guard: expected a "struct" case in the switch');
  assert.ok(verbs.has('analysis'), 'fixture guard: expected an "analysis" case');
  for (const v of verbs) {
    assert.ok(
      project.manifest.subCommands.includes(v),
      `"${v}" is dispatched by project but missing from manifest.subCommands`,
    );
  }
});

test('drift guard: every repo verb the switch dispatches is declared', () => {
  const verbs = switchVerbs(repo.file, 'handleRepo');
  assert.ok(verbs.has('info'), 'fixture guard: expected an "info" case in the switch');
  for (const v of verbs) {
    assert.ok(
      repo.manifest.subCommands.includes(v),
      `"${v}" is dispatched by repo but missing from manifest.subCommands`,
    );
  }
});

test('fixture guard: the manifest is what feeds the reconciler (not an empty list)', () => {
  assert.ok(Array.isArray(project.manifest.subCommands) && project.manifest.subCommands.length >= 6);
  assert.ok(Array.isArray(repo.manifest.subCommands) && repo.manifest.subCommands.length >= 15);
  // The bug class: parseInput alone cannot rescue these, the reconciler can.
  assert.equal(parseInput(`project struct ${TINY}`).subCommand, null);
  assert.equal(parseInput('repo info').subCommand, null);
});
