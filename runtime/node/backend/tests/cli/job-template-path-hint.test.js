'use strict';

/**
 * Regression for the `khy job` path hints.
 *
 * They used to be hardcoded literals ("<项目>/.khy/templates/ 或 ~/.khy/templates/",
 * "~/.khy/jobs/<ID>/"). On a portable install the second of each pair is never
 * scanned / never used, so a user who followed the advice dropped templates into
 * a directory the command would not read — a false way out, worse than none.
 *
 * The resolver is stubbed with unmistakably-fake paths: if the hint is derived
 * from it (as intended) those paths show up; if anyone re-hardcodes a literal,
 * they don't.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BE = path.resolve(__dirname, '../..');
const TPL = require.resolve(path.join(BE, 'src/jobs/jobTemplates.js'));
const STORE = require.resolve(path.join(BE, 'src/jobs/jobStore.js'));

const DIRS = ['X:\\fake-project\\.khy\\templates', 'Y:\\fake-user\\.khy\\templates'];
const JOBS_BASE = 'Z:\\fake-data-home\\jobs';

function stub(mod, exports) {
  require.cache[mod] = { id: mod, filename: mod, loaded: true, exports };
}

stub(TPL, {
  _defaultDirs: () => DIRS,
  listTemplates: () => [],
  loadTemplate: () => null,
  parseFrontmatter: () => ({}),
});
stub(STORE, {
  _jobsBase: () => JOBS_BASE,
  getJobDir: () => path.join(JOBS_BASE, 'x'),
  createJob: () => {
    throw new Error('this test must not create jobs');
  },
  readJobState: () => null,
  appendJobReply: () => {},
  listJobs: () => [],
});

const { handleJob } = require(path.join(BE, 'src/cli/handlers/job.js'));

async function capture(sub, args = []) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await handleJob(sub, args, {});
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('').replace(/\u001B\[[0-9;]*m/g, '');
}

// Every user-facing "where do templates live" sentence must agree with the
// resolver — the three sites once disagreed with each other too.
const SITES = [
  ['job list (empty)', () => capture('list')],
  ['job new <unknown>', () => capture('new', ['zzz-not-a-template'])],
  ['job (bare usage)', () => capture(undefined)],
];

for (const [label, run] of SITES) {
  test(`${label} names the real template dirs, not a literal guess`, async () => {
    const out = await run();
    for (const d of DIRS) {
      assert.ok(out.includes(d), `${label} does not mention scanned dir ${d}:\n${out}`);
    }
    assert.ok(!out.includes('~/.khy/templates'), `${label} still prints the hardcoded ~ literal`);
  });
}

test('bare usage names the real jobs base too', async () => {
  const out = await capture(undefined);
  assert.ok(out.includes(JOBS_BASE), `jobs base hint missing:\n${out}`);
  assert.ok(!out.includes('~/.khy/jobs'), 'jobs path is still a hardcoded literal');
});

test('positive control — a populated template list skips the hint entirely', async () => {
  require.cache[TPL].exports.listTemplates = () => [
    { name: 'bugfix', description: 'd', filePath: path.join(DIRS[0], 'bugfix.md') },
  ];
  try {
    const out = await capture('list');
    assert.ok(out.includes('bugfix'), `template not listed:\n${out}`);
    assert.ok(!out.includes('未找到任何模板'), 'non-empty list still reported empty');
  } finally {
    require.cache[TPL].exports.listTemplates = () => [];
  }
});
