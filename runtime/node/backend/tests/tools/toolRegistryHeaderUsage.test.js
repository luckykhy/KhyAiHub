'use strict';

/**
 * The tool registry documents its own public API in a header "Usage:" block.
 * That block used to point at `../cli/handlers/tools.js` — a CLI command
 * handler exporting only handleToolsCommand — so anyone (human or AI) coding
 * to the documented call got "tools.getAll is not a function".
 *
 * The guard is purely structural: it re-reads the documented require spec and
 * member names from the file text and checks them against the real module.
 * Nothing here invokes getAll()/get(), because that would trigger loadTools()
 * and its syntax-healer write path.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY = path.join(ROOT, 'src/tools/index.js');
// The header states the spec as seen from a src/cli/handlers consumer.
const CONSUMER_DIR = path.join(ROOT, 'src/cli/handlers');

function readUsageBlock() {
  const src = fs.readFileSync(REGISTRY, 'utf8');
  const header = src.slice(0, src.indexOf('const fs = require'));
  const spec = [...header.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const members = [...new Set([...header.matchAll(/tools\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))];
  return { spec, members };
}

describe('tool registry header Usage block', () => {
  test('NON-VACUITY: the Usage block really documents one require spec and its members', () => {
    const { spec, members } = readUsageBlock();
    expect(spec.length).toBe(1);
    expect(members.sort()).toEqual(['execute', 'get', 'getAll', 'getDefinitions']);
  });

  test('the documented spec resolves to the registry itself', () => {
    const { spec } = readUsageBlock();
    const resolved = require.resolve(spec[0], { paths: [CONSUMER_DIR] });
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(REGISTRY));
  });

  test('every member the header advertises exists on that module', () => {
    const { spec, members } = readUsageBlock();
    const mod = require(require.resolve(spec[0], { paths: [CONSUMER_DIR] }));
    for (const name of members) expect(typeof mod[name]).toBe('function');
  });

  test('negative control: the old wrong target would fail the same checks', () => {
    const legacy = require(path.join(ROOT, 'src/cli/handlers/tools.js'));
    expect(Object.keys(legacy)).toEqual(['handleToolsCommand', '__khyCommandManifest']);
    expect(typeof legacy.getAll).toBe('undefined');
  });
});
