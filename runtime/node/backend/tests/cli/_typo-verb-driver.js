'use strict';

/**
 * Child driver for typo-verb-not-silent.test.js — one process per CLI case.
 *
 * Why a child instead of capturing in-process: the cases have to read the
 * handler's output, so the original version replaced process.stdout.write for
 * the duration of each call. That stream is also how node:test reports results,
 * so the reporter's own lines for the still-pending cases were swallowed by the
 * next case's sink. `node --test` then printed "# tests 7 / # pass 7" for a file
 * that registers 14 cases — a green verdict over half the suite, with no failure
 * anywhere. Running each case in its own process removes the shared stream, and
 * as a side benefit the assertions read the real process exit code instead of a
 * `process.exitCode` proxy.
 *
 * Usage:
 *   node _typo-verb-driver.js registry   "<command line>"
 *   node _typo-verb-driver.js direct <rel module> <export name> "<command line>"
 *
 * Exit codes: 0 the handler returned normally, 1 whatever the handler marked,
 * 3 nothing was dispatched (a broken routing chain must not look like a pass).
 */

const path = require('path');

const BE = path.resolve(__dirname, '../..');
const { parseInput } = require(path.join(BE, 'src/cli/router'));

const MODE = process.argv[2];
const LINE = MODE === 'registry' ? process.argv[3] : process.argv[5];

async function main() {
  const parsed = parseInput(LINE);
  if (MODE === 'registry') {
    // Same call commandAutoRegistry.dispatch makes from the router.
    const registry = require(path.join(BE, 'src/cli/commandAutoRegistry'));
    const result = await registry.dispatch(parsed.command, { parsed });
    if (!result || !result.handled) {
      process.stdout.write(`NOT-DISPATCHED ${LINE}\n`);
      process.exitCode = 3;
    }
    return;
  }
  if (MODE === 'direct') {
    const rel = process.argv[3];
    const fnName = process.argv[4];
    const mod = require(path.join(BE, rel));
    if (typeof mod[fnName] !== 'function') {
      process.stdout.write(`NOT-A-FUNCTION ${rel}#${fnName}\n`);
      process.exitCode = 3;
      return;
    }
    // Exactly the argument order the router / slash dispatcher uses.
    await mod[fnName](parsed.subCommand, parsed.args, parsed.options);
    return;
  }
  process.stdout.write(`UNKNOWN MODE ${MODE}\n`);
  process.exitCode = 3;
}

main().catch((err) => {
  process.stdout.write(`DRIVER-THREW ${err && err.message ? err.message : err}\n`);
  process.exitCode = 3;
});
