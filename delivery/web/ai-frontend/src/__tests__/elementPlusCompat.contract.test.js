/**
 * Element Plus API-compat contract (source-scan).
 *
 * Why: the 2026-09-26 console showed two classes of Element Plus warnings —
 *   1. `Invalid prop: value ... got Null at <ElOption>` (AIChat project filter
 *      used `<el-option :value="null">`), and
 *   2. `[el-radio] label act as value is about to be deprecated in 3.0.0`
 *      (`<el-radio-button label="…">` used label as the value).
 * Both become hard breakage on the next Element Plus major. Vitest runs with
 * `environment: 'node'` (no DOM), so — per the repo's established convention
 * (`componentContract.wiring.test.js`, `useProjects.wiring.test.js`) — the
 * contract is asserted at the source level.
 *
 * Run: `npx vitest run src/__tests__/elementPlusCompat.contract.test.js`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(__dirname, '..'); // apps/ai-frontend/src

function collectVueFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectVueFiles(full, out);
    else if (name.endsWith('.vue')) out.push(full);
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** All `<tag …>` open tags (multi-line safe) with their absolute offsets. */
function openTags(src, tagName) {
  const re = new RegExp(`<${tagName}\\b[\\s\\S]*?>`, 'g');
  return [...src.matchAll(re)].map((m) => ({ text: m[0], index: m.index }));
}

const vueFiles = collectVueFiles(srcRoot);

describe('el-option: value must not be null', () => {
  it('finds the checked-in .vue sources', () => {
    expect(vueFiles.length).toBeGreaterThan(10);
  });

  it('no <el-option> passes value="null" / :value="null"', () => {
    const offenders = [];
    for (const file of vueFiles) {
      const src = readFileSync(file, 'utf8');
      for (const { text, index } of openTags(src, 'el-option')) {
        if (/[:\s]value\s*=\s*"null"/.test(text) || /:value\s*=\s*'null'/.test(text)) {
          offenders.push(`${relative(srcRoot, file)}:${lineOf(src, index)} ${text.trim()}`);
        }
      }
    }
    expect(offenders, `ElOption forbids a null value (Element Plus type check):\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('el-radio-button: label is display text, value is the value', () => {
  it('no <el-radio-button> relies on label-as-value (deprecated in Element Plus 3.0)', () => {
    const offenders = [];
    for (const file of vueFiles) {
      const src = readFileSync(file, 'utf8');
      for (const { text, index } of openTags(src, 'el-radio-button')) {
        const hasLabel = /(^|\s):?label\s*=/.test(text);
        const hasValue = /(^|\s):?value\s*=/.test(text);
        if (hasLabel && !hasValue) {
          offenders.push(`${relative(srcRoot, file)}:${lineOf(src, index)} ${text.trim()}`);
        }
      }
    }
    expect(offenders, `label-as-value is deprecated — use value=:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('AIChat project filter wiring', () => {
  const aiChat = readFileSync(join(srcRoot, 'views', 'AIChat.vue'), 'utf8');

  it('the "全部项目" option uses an empty-string value, not null', () => {
    expect(aiChat).toMatch(/<el-option\s+label="全部项目"\s+value=""\s*\/>/);
    expect(aiChat).not.toMatch(/<el-option\s+label="全部项目"\s+:value="null"/);
  });

  it('select model-value mirrors activeProjectId with an "" sentinel', () => {
    expect(aiChat).toMatch(/:model-value="activeProjectId \?\? ''"/);
  });

  it('onProjectChange still routes through setActiveProject (null-ification happens there)', () => {
    expect(aiChat).toMatch(/function onProjectChange\([^)]*\)\s*\{[\s\S]{0,400}?setActiveProject\(/);
  });
});
