'use strict';
// hci-r50 contract: every `khy <verb>` remedy advertised in DataLocation.js
// must resolve through the CURRENT dispatcher. Regression pin for the
// `khy migrate-data` phantom (never existed on either leg; replaced by the
// live `khy storage status` viewer — legacy-dir one-shot migration has no
// CLI today, so no command may promise it either).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_FILE = path.join(__dirname, '../../src/services/domain/data/data/DataLocation.js');
const router = require('../../src/cli/router.js');

// Keep string literals, drop comments (round-21 lesson: comment examples are fake hits).
function stripComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (code[i] === '\\') { out += code[i] + (code[i + 1] || ''); i += 2; continue; }
        if (code[i] === q) { out += q; i++; break; }
        if (q !== '`' && code[i] === '\n') break;
        out += code[i];
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function advertisedVerbs(code) {
  const verbs = [];
  const re = /\bkhy\s+([a-z][a-z0-9-]{2,})/g;
  let m;
  while ((m = re.exec(code))) verbs.push(m[1]);
  return verbs;
}

test('DataLocation 广告语里的每个 khy 动词都能被当下分派点解析', () => {
  const code = stripComments(fs.readFileSync(SRC_FILE, 'utf-8'));
  const verbs = advertisedVerbs(code);
  // Non-vacuity: the file must actually advertise at least one command today.
  assert.ok(verbs.length >= 1, `未发现任何 khy 动词广告语——探针读空了 (contract vacuous)`);
  for (const verb of verbs) {
    const parsed = router.parseInput(`khy ${verb}`);
    const known = router.COMMANDS.includes(parsed.command) || router.COMMANDS.includes(verb);
    assert.ok(known, `幻影 remedy: 「khy ${verb}」不在 COMMANDS/${'router 分派'} 中`);
  }
});

test('遗留目录建议语的修法回归钉: 禁 migrate-data、须指向 storage status', () => {
  const src = fs.readFileSync(SRC_FILE, 'utf-8');
  assert.ok(!/khy\s+migrate-data/.test(src), '「khy migrate-data」幻影回归(该命令两条腿都不存在)');
  assert.ok(
    /检测到遗留数据目录[^\n]*khy\s+storage\s+status/.test(src),
    '遗留目录分支必须继续指向 LIVE 的 khy storage status(本轮修复的语义)'
  );
});
