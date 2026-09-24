'use strict';

/**
 * Regression for the silent-typo verb family: CLI handlers that opened their
 * dispatch with `String(subCommand || '<default>')`. parseInput only
 * fills `subCommand` for verbs the schema declares, so an undeclared word is
 * dropped into `args` and the `||` default took over: `khy notify tst` printed
 * the byte-identical output of `khy notify` with exit code 0, and each file's own
 * unknown-sub-command branch was unreachable for exactly the input it was written
 * for.
 *
 * Real CLI output before the fix (see .khy/feedback/silent-verb-sweep/raw/):
 *   khy notify lst  ->  the provider table of the status view, rc=0 (same as bare)
 *   khy evolve zqx  ->  the evolve status report, rc=0 (same as bare)
 *
 * Every case starts at `parseInput`, because that is where the undeclared verb
 * loses its slot. Self-registering commands (notify, tools, capability, replay,
 * guide) go through `commandAutoRegistry.dispatch`; the router/slash-owned ones
 * (evolve, deps, statusline, remotedev, verdict) are called with the same
 * (subCommand, args, options) order their call sites use. Both shapes run in a
 * child process — see _typo-verb-driver.js for what capturing in-process did to
 * this file's own report.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const BE = path.resolve(__dirname, '../..');
const { parseInput } = require(path.join(BE, 'src/cli/router'));

const TYPO = 'zqxtyvo';
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const DRIVER = path.join(__dirname, '_typo-verb-driver.js');

// The child's real exit code, exposed as `marked` so the cases read the same
// signal a shell would. Each helper sets it immediately before the assertions.
let marked;

// Each case runs in its own process. Capturing in-process instead (replacing
// process.stdout.write, which is what the first version did) also captured
// node:test's own reporter writes: `node --test` on this file printed
// "# tests 7 / # pass 7" while 14 cases are registered, i.e. half the suite
// went unreported and the run still looked green.
function spawnCase(args, line) {
  let out = '';
  let rc = 0;
  try {
    out = execFileSync(process.execPath, [DRIVER, ...args], {
      encoding: 'utf8',
      cwd: BE,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (typeof err.status !== 'number') {
      assert.fail(`driver failed to run "${line}": ${err && err.message}`);
    }
    out = `${err.stdout || ''}${err.stderr || ''}`;
    rc = err.status;
  }
  marked = rc;
  assert.ok(rc !== 3, `driver could not dispatch "${line}": ${out.slice(0, 200)}`);
  assert.ok(!out.includes('DRIVER-THREW'), `driver threw for "${line}": ${out.slice(0, 300)}`);
  return out.replace(ANSI, '');
}

function run(line) {
  return spawnCase(['registry', line], line);
}

// Commands the router switch owns are not self-registering, so the registry
// cannot dispatch them. These are called exactly the way the router calls them:
// routerDispatchTail.js:1905-1906 handleEvolve(subCommand, args, options) and
// :1914 handleDeps(subCommand, args, options).
function runDirect(line, rel, fnName) {
  return spawnCase(['direct', rel, fnName, line], line);
}

const runEvolve = (line) => runDirect(line, 'src/cli/handlers/evolve', 'handleEvolve');
const runDeps = (line) => runDirect(line, 'src/cli/handlers/deps', 'handleDeps');
// Router/slash-owned, same (subCommand, args, options) order as the call sites:
// routerDispatchTail.js:1826 handleRemoteDev, :1899 handleVerdict,
// routerDispatchSlash.js:778 handleStatusLine.
const runStatusline = (line) => runDirect(line, 'src/cli/handlers/statusline', 'handleStatusLine');
const runRemotedev = (line) => runDirect(line, 'src/cli/handlers/remotedev', 'handleRemoteDev');
const runVerdict = (line) => runDirect(line, 'src/cli/handlers/verdict', 'handleVerdict');

test('fixture guard: parseInput really drops the typo into args', () => {
  assert.equal(parseInput(`notify ${TYPO}`).subCommand, null);
  assert.deepEqual(parseInput(`notify ${TYPO}`).args, [TYPO]);
  assert.equal(parseInput(`evolve ${TYPO}`).subCommand, null);
  // and the declared verbs still arrive in the verb slot
  assert.equal(parseInput('notify status').subCommand, 'status');
  assert.equal(parseInput('evolve rules').subCommand, 'rules');
});

test('khy notify <typo> is rejected and names the word', async () => {
  const out = await run(`notify ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.ok(!out.includes('尚未配置推送'), `typo still rendered the status view: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell, not just print red');
});

test('khy evolve <typo> is rejected and names the word', async () => {
  const out = await runEvolve(`evolve ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  // The error branch also prints the usage list, so the discriminator has to be a
  // row only the status report emits — not a phrase the help text repeats.
  assert.ok(!/kernel-abi/.test(out), `typo still rendered the status view: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell, not just print red');
});

test('a bare command keeps its default view and stays green', async () => {
  const notify = await run('notify');
  assert.ok(notify.trim().length > 0, 'bare notify printed nothing');
  assert.ok(!notify.includes('未知子命令'), `bare notify reported an unknown verb`);
  assert.ok(!marked, `bare "notify" marked the process failed: ${marked}`);

  const evolve = await runEvolve('evolve');
  assert.ok(evolve.trim().length > 0, 'bare evolve printed nothing');
  assert.ok(!evolve.includes('未知子命令'), 'bare evolve reported an unknown verb');
  assert.ok(!marked, `bare "evolve" marked the process failed: ${marked}`);
});

// ── Round four: three self-registering handlers found by the exit-code probe ─
// Same sink, same rescue channel: notify/tools/deps/statusline/remotedev/verdict
// were the ones a grep for `|| 'default'` surfaced; capability, replay and guide
// carry it too, and all three were CLEAN files. Their default views are a data
// table (已登记能力 3 项 / session list / map list), so a typo answered a report
// nobody asked for and returned 0.

test('khy capability <typo> does not print the capability registry', async () => {
  // capability.js reads parsed.subCommand only; the typo sat in parsed.args[0].
  const out = await run(`capability ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  // Derived from the real CLI pair (.khy/feedback/silent-verb-round4/raw/): this
  // summary line is emitted only by _handleList, never by the usage line.
  assert.ok(!out.includes('已登记能力'), `typo still rendered the list view`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const bare = await run('capability');
  assert.ok(bare.includes('已登记能力'), `bare capability lost its view: ${bare.slice(0, 200)}`);
  assert.ok(!marked, `bare "capability" marked the process failed: ${marked}`);
});

test('khy replay <typo> reaches the error branch that already existed', async () => {
  const out = await run(`replay ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.ok(!/暂无带回放账本|回放账本/.test(out), `typo still rendered the session list`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const bare = await run('replay');
  assert.ok(!bare.includes('未知子命令'), `bare replay reported an unknown verb`);
  assert.ok(/暂无带回放账本|回放账本/.test(bare), `bare replay lost its view: ${bare.slice(0, 200)}`);
  assert.ok(!marked, `bare "replay" marked the process failed: ${marked}`);
});

test('khy guide <typo> does not answer with the map list', async () => {
  const out = await run(`guide ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.ok(!/暂无地图模板|地图模板/.test(out), `typo still rendered the map list`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const bare = await run('guide');
  assert.ok(!bare.includes('未知子命令'), `bare guide reported an unknown verb`);
  assert.ok(/暂无地图模板|地图模板/.test(bare), `bare guide lost its view: ${bare.slice(0, 200)}`);
  assert.ok(!marked, `bare "guide" marked the process failed: ${marked}`);
});

test('positive controls - declared read-only verbs unaffected', async () => {
  const a = await run('notify status');
  assert.ok(!a.includes('未知子命令'), `notify status broke: ${a.slice(0, 200)}`);
  assert.ok(!marked, `notify status marked the process failed: ${marked}`);
  const b = await runEvolve('evolve rules');
  assert.ok(!b.includes('未知子命令'), `evolve rules broke: ${b.slice(0, 200)}`);
  assert.ok(!marked, `evolve rules marked the process failed: ${marked}`);
  const c = await run('capability toggles');
  assert.ok(!c.includes('未知子命令'), `capability toggles broke: ${c.slice(0, 200)}`);
  assert.ok(!marked, `capability toggles marked the process failed: ${marked}`);
});

// Same sink shape, found by sweeping the other handlers (the first detector
// skipped these two because it tested for a rescue channel file-wide instead of
// in the branch that owns the verb slot).
test('khy tools <typo> is rejected and names the word', async () => {
  const out = await run(`tools ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const bare = await run('tools');
  assert.ok(!bare.includes('未知子命令'), 'bare tools reported an unknown verb');
  assert.ok(!marked, `bare "tools" marked the process failed: ${marked}`);
});

test('khy tools help answers instead of rejecting its own advertised verb', async () => {
  // The usage line in the error branch lists 「help」, yet no branch handled it, so
  // `khy tools help` answered 「未知子命令: help」 with exit code 1.
  const out = await run('tools help');
  assert.ok(!out.includes('未知子命令'), `tools help rejected itself: ${out.slice(0, 200)}`);
  assert.ok(out.includes('便携 CLI'), `tools help printed no usage: ${out.slice(0, 200)}`);
  assert.ok(!marked, `tools help marked the process failed: ${marked}`);
});

test('khy deps <typo> reaches the branch the author wrote for it', async () => {
  // deps.js carries the comment 「未知子命令:保守走 help,避免把任意字符串误当
  // 依赖名直接安装」 — that intent was unreachable for a typo, which rendered the
  // dependency list instead and left the name available to an install branch.
  const out = await runDeps(`deps ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const list = await runDeps('deps list');
  assert.ok(!list.includes('未知子命令'), 'deps list broke');
  assert.ok(!marked, `deps list marked the process failed: ${marked}`);
});

// ── Round three: three handlers whose typo answer was a *data view* ───────
// Worse than the help-wall shape: `khy statusline <typo>` printed 「状态行:未配置」,
// `khy remotedev <typo>` printed 「未连接（无活动会话）」 and `khy verdict <typo>`
// printed 「❓ 无法判断（uncertain）」 — each a wrong answer to a question nobody
// asked, all with exit code 0.

test('khy statusline <typo> does not answer with the status snapshot', async () => {
  const out = await runStatusline(`statusline ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  // "门控 KHY_STATUS_LINE: on" is emitted only by the show view; the help block
  // spells the same gate as "KHY_STATUS_LINE=0", so a looser match would pass.
  assert.ok(!out.includes('门控 KHY_STATUS_LINE:'), `typo still rendered the show view`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const bare = await runStatusline('statusline');
  assert.ok(bare.includes('门控 KHY_STATUS_LINE:'), `bare statusline lost its view: ${bare.slice(0, 200)}`);
  assert.ok(!marked, `bare "statusline" marked the process failed: ${marked}`);
});

test('khy remotedev <typo> does not claim there is no session', async () => {
  const gated = await runRemotedev('remotedev');
  if (gated.includes('已禁用')) {
    // KHY_REMOTEDEV=0 in this environment: the branch under test is unreachable,
    // so say so instead of passing on an empty assertion.
    assert.fail('remotedev is gated off here (KHY_REMOTEDEV=0) - case would be vacuous');
  }
  const out = await runRemotedev(`remotedev ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.ok(!out.includes('未连接（使用'), `typo still answered "not connected": ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  const bare = await runRemotedev('remotedev');
  assert.ok(!bare.includes('未知子命令'), 'bare remotedev reported an unknown verb');
  assert.ok(!marked, `bare "remotedev" marked the process failed: ${marked}`);
});

test('khy verdict <typo> does not invent a verdict', async () => {
  const out = await runVerdict(`verdict ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  // The show renderer prints one of these three labels; the help block never does.
  assert.ok(!/无法判断|改动通过|判定不通过|uncertain|correct|incorrect/.test(out),
    `typo still rendered a verdict: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');
  // 'status' was never declared but has always fallen through to the show
  // renderer; the fix must keep that alias working rather than reject it.
  const alias = await runVerdict('verdict status');
  assert.ok(!alias.includes('未知子命令'), `verdict status alias broke: ${alias.slice(0, 200)}`);
  assert.ok(!marked, `verdict status marked the process failed: ${marked}`);
});

// ── Round five: five handlers whose default branch already had an error branch ─
// Swept the remaining `String(subCommand || '<view>')` sinks in handlers/. These
// five differ from the earlier rounds in that the 「未知子命令」 branch was already
// written (and even returned 1) — it was simply unreachable, because the undeclared
// word never reached `subCommand`. msg/vault/feishu/mesh also interpolated the
// *empty* `subCommand` into their own message, so even a reachable branch would
// have said 「未知子命令:。」. lazy/mesh/msg/vault carry on/off verbs that persist
// env, so the cases below touch only the read-only default view.

const ROUND_FIVE = ['msg', 'vault', 'feishu', 'lazy', 'mesh'];
for (const name of ROUND_FIVE) {
  test(`khy ${name} <typo> reaches the error branch instead of the default view`, async () => {
    const typo = await run(`${name} ${TYPO}`);
    assert.ok(typo.includes('未知子命令'), `typo silently accepted: ${typo.slice(0, 200)}`);
    assert.ok(typo.includes(TYPO), `the typo was not echoed back: ${typo.slice(0, 200)}`);
    assert.strictEqual(marked, 1, `khy ${name} <typo> must fail the shell`);

    const bare = await run(name);
    assert.ok(!bare.includes('未知子命令'), `bare ${name} reported an unknown verb`);
    assert.ok(!marked, `bare "${name}" marked the process failed: ${marked}`);
    // The defect was byte-identical output, so the assertion is the negation of
    // that rather than a hardcoded view string: every line the bare view prints
    // in this environment must not also appear on the typo path. Hardcoding a
    // token would go vacuous the moment the view is legitimately empty
    // (no peers online, empty vault).
    const onlyBare = bare.split('\n').filter((l) => l.trim() && !typo.includes(l));
    assert.ok(onlyBare.length > 0, `typo still rendered the ${name} default view`);
  });
}

test('positive control - msg platforms still answers', async () => {
  const out = await run('msg platforms');
  assert.ok(!out.includes('未知子命令'), `msg platforms broke: ${out.slice(0, 200)}`);
  assert.ok(!marked, `msg platforms marked the process failed: ${marked}`);
});

// ── Round six: `doc` — one verb only, so the sink is a usage wall ───────────
// handlers/doc.js has no default *view*; anything that is not `title` printed the
// usage line and returned true. The noise is that the wall never named the word
// it rejected: `khy doc tile` and bare `khy doc` were byte-identical (116 B each,
// captured in .khy/feedback/silent-verb-round6/), so a near-miss spelling gave the
// user nothing to correct. The fix is additive, hence the discriminator runs the
// other way — nothing may vanish from the bare output.

test('khy doc <typo> names the offending token instead of a bare usage wall', async () => {
  const typo = await run(`doc ${TYPO}`);
  assert.ok(typo.includes('未知子命令'), `typo silently accepted: ${typo.slice(0, 200)}`);
  assert.ok(typo.includes(TYPO), `the typo was not echoed back: ${typo.slice(0, 200)}`);

  const bare = await run('doc');
  assert.ok(!bare.includes('未知子命令'), `bare doc reported an unknown verb: ${bare.slice(0, 200)}`);
  // Compare content, not decoration: printError prefixes 「  ✗ 」, and on the typo
  // path that marker now sits before 「未知子命令:…」 rather than before the usage
  // text, so a verbatim line match would fail on the glyph alone (measured).
  const strip = (s) => s.replace(/^\s*✗\s*/, '');
  const nl = String.fromCharCode(10);
  const hay = typo.split(nl).map(strip).join(nl);
  const lost = bare.split(nl).map(strip).filter((l) => l.trim() && !hay.includes(l));
  assert.strictEqual(lost.length, 0, `bare doc lines missing from the typo output: ${lost.join(' | ')}`);
  // rc deliberately stays 0 here and is NOT asserted: `doc` is also an AI tool,
  // this branch is reachable from an in-process tool call, and `_markFailure()`
  // would then set the session's exit code from a recovered tool error. Filed
  // report-only as the exit-code half of the same family.
});

test('positive control - doc title still dispatches', async () => {
  const out = await run('doc title');
  assert.ok(!out.includes('未知子命令'), `doc title broke: ${out.slice(0, 200)}`);
});

// ── Round seven: the severity glyph must agree with the exit code ──────────
// `khy evolve <typo>` and `khy deps <typo>` printed ⚠ (printWarn) from a branch
// that also calls _markFailure(): the screen said "warning", the shell said exit 1
// (both captured in .khy/feedback/warn-glyph-round7/). Contract, checked over the
// whole fixed family rather than the two offenders: if the usage error fails the
// shell, it renders as an error. `doc` is deliberately NOT in this table — it
// prints ✗ with rc 0, which is the other half of the same inconsistency and is
// still open (task #37, blocked on the branch also serving in-process tool calls).

const MARKED_VERBS = [
  ['evolve', runEvolve],
  ['deps', runDeps],
  ['statusline', runStatusline],
  ['remotedev', runRemotedev],
  ['verdict', runVerdict],
  ...['notify', 'tools', 'capability', 'replay', 'guide', 'msg', 'vault', 'feishu', 'lazy', 'mesh']
    .map((name) => [name, run]),
];

test('a usage error that exits 1 renders as an error, not a warning', async () => {
  const nl = String.fromCharCode(10);
  const offenders = [];
  for (const [name, invoke] of MARKED_VERBS) {
    const out = invoke(`${name} ${TYPO}`);
    const line = (out.split(nl).find((l) => l.includes('未知子命令')) || '').trim();
    if (marked !== 1) {
      offenders.push(`${name}: branch must fail the shell, rc=${marked || 0}`);
    } else if (!line.includes('✗') || line.includes('⚠')) {
      offenders.push(`${name}: rc=1 but rendered 「${line}」`);
    }
  }
  assert.deepStrictEqual(offenders, [], `severity/exit-code disagreement: ${offenders.join(' ; ')}`);
});

// Characterization test for tasks #44/#45 — it locks in the *current, defective*
// reality on purpose, so that landing either side of the fix has to come through
// here and say so. `khy backup help` promises `--dry-run, -n` (backup.js:314) and
// prune derives dryRun from `_bool(options, 'dry-run', 'dryRun', 'n')` (:224), but
// parseInput only ever builds options from `--` tokens, so the advertised `-n`
// reaches the handler as a bare arg and dryRun stays false — i.e. the safety阀 the
// help text describes as "只预演,不改动任何文件" silently selects the real-delete
// branch. The destructive end of that chain is deliberately NOT executed anywhere
// in this repo's tests; the two assertions below are the whole claim.
//
// Expected flips: adding short-flag support to parseInput reddens assertion (2);
// dropping `-n` from the help text reddens assertion (1). Both are correct outcomes
// — update this file together with whichever fix lands.
test('#45 characterizes that the advertised `-n` dry-run flag cannot reach options', () => {
  const src = require('fs').readFileSync(
    path.join(BE, 'src/cli/handlers/backup.js'), 'utf8'
  );
  // (1) the promise is still made to users
  assert.match(src, /--dry-run,\s*-n/, 'help text no longer advertises `-n`; update #44/#45');

  // (2) the parser still cannot deliver it, while the long form works
  const shortForm = parseInput('backup prune -n');
  assert.strictEqual(shortForm.options.n, undefined);
  assert.ok(shortForm.args.includes('-n'), '`-n` should still be sitting in args');
  assert.strictEqual(parseInput('backup prune --dry-run').options['dry-run'], true);
});

// Found while re-testing the round-six probe for agent-assets: the typo path was
// silent for the same `|| '<default>'` reason as the rest of this family, and
// fixing it surfaced a second, worse defect on the same file — `agentAssets.js`
// required the CLI *command* registry (`src/cli/commands/registry.js`) while using
// `AGENT_ASSET_SOURCES` / `describeSources`, which only exist on the domain
// registry (`services/domain/agents/agentAssets/registry.js`). Same name, wrong
// module, so `caps` and `help` threw and the router then printed 「未知命令」.
test('#46 khy agent-assets <typo> is rejected and names the word', async () => {
  const out = await run(`agent-assets ${TYPO}`);
  assert.equal(parseInput(`agent-assets ${TYPO}`).subCommand, null, 'fixture moved');
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.ok(!out.includes('已注册外部 agent 工具'), `typo still ran the discover scan: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell, not just print red');
});

test('#46 agent-assets caps/help report instead of throwing on the wrong registry', async () => {
  const caps = await run('agent-assets caps');
  assert.ok(caps.includes('可读') || caps.includes('可写'), `caps produced no report: ${caps.slice(0, 200)}`);
  const help = await run('agent-assets help');
  assert.ok(help.includes('agent-assets'), `help produced no usage: ${help.slice(0, 200)}`);
  for (const [line, out] of [['caps', caps], ['help', help]]) {
    assert.ok(!/is not a function|Cannot read properties/.test(out), `${line} threw: ${out.slice(0, 300)}`);
    assert.ok(!out.includes('未知命令'), `${line} failed dispatch: ${out.slice(0, 300)}`);
  }
});

// #43 (FIXED 2026-09-24, not a characterization): an unknown `--flag` unconditionally ate the
// next token as its value, so `msg --zqxflag platforms` silently downgraded the platform table
// to the bare status view. The gated leaf `src/cli/optionValueGuard.js` keeps a *declared
// sub-command* in the value slot as a positional; every other value still gets consumed.
test('#43 an unknown flag must not swallow the sub-command that follows it', () => {
  const guarded = parseInput('msg --zqxflag platforms');
  assert.strictEqual(guarded.subCommand, 'platforms', 'sub-command was still eaten');
  assert.strictEqual(guarded.options.zqxflag, true);

  // control for the guard's other side: a non-sub-command value must still be consumed
  assert.strictEqual(parseInput('msg send --platform wecom').options.platform, 'wecom');

  // gate off = byte-identical legacy greedy path
  const prev = process.env.KHY_OPTION_VALUE_SUBCMD_GUARD;
  process.env.KHY_OPTION_VALUE_SUBCMD_GUARD = '0';
  try {
    const legacy = parseInput('msg --zqxflag platforms');
    assert.strictEqual(legacy.options.zqxflag, 'platforms');
    assert.strictEqual(legacy.subCommand, null);
  } finally {
    if (prev === undefined) delete process.env.KHY_OPTION_VALUE_SUBCMD_GUARD;
    else process.env.KHY_OPTION_VALUE_SUBCMD_GUARD = prev;
  }
});

// companion.js went CLEAN on 2026-09-24 (author landed it with the args[0] self-peel).// What was left: the typo branch printed ✗ then the full 12-line usage wall, rc=0,
// and the manifest declared no subCommands — so parseInput/Tab-completion/the #43
// option guard all had a hole for its 11 verbs.
test('#53 khy companion <near-miss> gets a suggestion, not the usage wall, and exits 1', async () => {
  const out = await run('companion lst');
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes('你是不是想说 companion list'), `no near-miss suggestion: ${out.slice(0, 300)}`);
  assert.ok(!out.includes('khy companion create <name>'), `typo still dumped the full usage wall: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');

  const bare = await run('companion');
  assert.ok(bare.includes('khy companion create <name>'), 'bare companion lost its usage view');
  assert.ok(!bare.includes('未知子命令'), 'bare companion reported an unknown verb');
  assert.ok(!marked, `bare "companion" marked the process failed: ${marked}`);
});

test('#53 companion manifest verbs are static-visible and drift-free', () => {
  const mod = require(path.join(BE, 'src/cli/handlers/companion'));
  const manifest = mod[require(path.join(BE, 'src/cli/commandManifest')).MANIFEST_EXPORT_KEY];
  const src = require('fs').readFileSync(path.join(BE, 'src/cli/handlers/companion.js'), 'utf8');
  // The hint list comes from _COMPANION_VERBS; the routing/completion channel is the
  // manifest literal. They may not drift apart.
  const m = src.match(/const _COMPANION_VERBS = \[([\s\S]*?)\];/);
  assert.ok(m, '_COMPANION_VERBS const disappeared (probe blind, not a pass)');
  const hint = [...m[1].matchAll(/'([^']+)'/g)].map((g) => g[1]);
  assert.ok(hint.length >= 11, `hint list too short: ${hint}`);
  assert.deepEqual([...manifest.subCommands].sort(), [...hint].sort(), 'manifest vs hint drift');
  // Load-bearing half: the static scan must actually see the literal (identifier
  // values extract as [] and silently open a hole in parseInput/Tab/#43 guard).
  assert.deepEqual(
    [...require(path.join(BE, 'src/constants/commandSchema')).getRouterSubCommands().companion].sort(),
    [...hint].sort(),
    'getRouterSubCommands lost companion (manifest subCommands must stay a literal array)'
  );
});

// app.js carried the same hole in a different form: `case 'list': default:` merged the
// bare view with unknown verbs, so `khy app zqxtyvo` was byte-identical to `khy app`
// (rc=0), and the khy-*/cli-* proxy onboarding was unreachable from the CLI because
// parseInput never fills subCommand for undeclared tokens.
test('#54 khy app <typo> is rejected, bare keeps its table', async () => {
  const out = await run(`app ${TYPO}`);
  assert.ok(out.includes('未知子命令'), `typo silently accepted: ${out.slice(0, 200)}`);
  assert.ok(out.includes(TYPO), `the typo was not echoed back: ${out.slice(0, 200)}`);
  assert.ok(!out.includes('KHY 应用管理'), `typo still rendered the app table: ${out.slice(0, 200)}`);
  assert.strictEqual(marked, 1, 'a usage error must fail the shell');

  const bare = await run('app');
  assert.ok(bare.includes('KHY 应用管理'), 'bare app lost its table');
  assert.ok(!bare.includes('未知子命令'), 'bare app reported an unknown verb');
  assert.ok(!marked, `bare "app" marked the process failed: ${marked}`);
});

test('#54 app khy-* proxy is reachable from the CLI and hints route', async () => {
  const prox = await run('app khy-proxies');
  assert.ok(!prox.includes('未知子命令'), `proxy verb rejected: ${prox.slice(0, 200)}`);
  assert.ok(prox.includes('代理'), `proxy view missing: ${prox.slice(0, 200)}`);
  const guess = await run('app sttus');
  assert.ok(guess.includes('你是不是想说 app status'), `no near-miss hint: ${guess.slice(0, 300)}`);
  assert.strictEqual(marked, 1, 'near-miss must still fail the shell');
});

test('#54 app manifest verbs stay static-visible and drift-free', () => {
  const mod = require(path.join(BE, 'src/cli/handlers/app'));
  const manifest = mod[require(path.join(BE, 'src/cli/commandManifest')).MANIFEST_EXPORT_KEY];
  const src = require('fs').readFileSync(path.join(BE, 'src/cli/handlers/app.js'), 'utf8');
  const m = src.match(/const _APP_VERBS = \[([\s\S]*?)\];/);
  assert.ok(m, '_APP_VERBS const disappeared (probe blind, not a pass)');
  const hint = [...m[1].matchAll(/'([^']+)'/g)].map((g) => g[1]);
  assert.ok(hint.length >= 10, `hint list too short: ${hint}`);
  assert.deepEqual([...manifest.subCommands].sort(), [...hint].sort(), 'manifest vs hint drift');
  // app is keyed in the STATIC ROUTER_SUB_COMMANDS (unlike companion), and the
  // getRouterSubCommands merge guard `!out[def.name]` means the manifest never
  // merges into that table — parseInput reads only the static list here. That
  // static list intentionally carries extra `cli-*`/`khy-*` proxy verbs, so the
  // load-bearing assertion is superset, not equality: every advertised verb must
  // be reachable through the channel parseInput actually consults.
  const staticApp = require(path.join(BE, 'src/constants/commandSchema')).getRouterSubCommands().app;
  assert.ok(Array.isArray(staticApp) && staticApp.length > 0, 'static app verb table vanished');
  for (const v of hint) {
    assert.ok(staticApp.includes(v), `static app table lost advertised verb: ${v}`);
  }
});

