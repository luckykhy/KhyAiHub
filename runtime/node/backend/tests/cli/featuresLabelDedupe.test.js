'use strict';

/**
 * r65 contract: the /features panel must not print a label column that merely
 * re-states the command word in different casing, and must keep every
 * informative label (and the JSON surface) untouched.
 */

const { handleFeatures } = require('../../src/cli/handlers/features');

const ANSI = /\x1b\[[0-9;]*m/g;

async function renderPanel(...args) {
  // The panel prints via console.log; jest replaces console with its own mock
  // that does NOT route through process.stdout.write — capture the API layer.
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  let buf = '';
  console.log = (...parts) => { buf += parts.map(String).join(' ') + '\n'; };
  process.stdout.write = (chunk, ...rest) => { buf += String(chunk); return origWrite(chunk, ...rest); };
  try {
    await handleFeatures(...args);
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
  }
  return buf.replace(ANSI, '');
}

function labelRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{4}(\/\S+)\s+(\S+)\s*$/);
    if (m) rows.push({ cmd: m[1], label: m[2] });
  }
  return rows;
}

describe('/features label column dedupe', () => {
  test('T0 non-vacuity: panel renders a substantial set of labelled rows', async () => {
    const rows = labelRows(await renderPanel('', [], {}));
    expect(rows.length).toBeGreaterThanOrEqual(150);
  });

  test('T1 no row repeats the command word in another casing', async () => {
    const rows = labelRows(await renderPanel('', [], {}));
    const dupes = rows.filter((r) => r.label.toLowerCase() === r.cmd.slice(1).toLowerCase());
    expect(dupes).toEqual([]);
  });

  test('T2 informative labels survive (Chinese label positive control)', async () => {
    const text = await renderPanel('', [], {});
    expect(text).toMatch(/\/claim-main\s+认领主角色/);
  });

  test('T3 field-free: --json data surface is untouched by the render fix', async () => {
    const orig = console.log.bind(console);
    let out = '';
    console.log = (chunk) => { out += String(chunk); };
    try {
      await handleFeatures('', [], { json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out);
    expect(parsed.total).toBeGreaterThanOrEqual(150);
    const all = parsed.categories.flatMap((c) => c.commands);
    expect(all.some((c) => c.label && c.label.toLowerCase() === c.name)).toBe(true);
  });
});
