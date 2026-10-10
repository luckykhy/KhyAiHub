'use strict';
// 一次性探针：验证「routingMode 会绕回 modelTier」这个说法是否成立。
// 若成立则 modelTier 不能 require routingMode；若不成立，我写在 modelTier 里的理由是编造的。
const fs = require('fs');
const path = require('path');

// 位置：scripts/maintenance/ —— 两级上溯是仓根。复跑：npm run audit:route185-cycles
// 它服务的判据：§16.2 / §16.4i / §16.4y 里「接这条 require 不会成环」那句话。
const SRC = path.resolve(__dirname, '../../runtime/node/backend/src');

function edges(f) {
  const s = fs.readFileSync(f, 'utf8');
  const out = [];
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(s))) {
    const p = path.resolve(path.dirname(f), m[1]);
    for (const c of [p, p + '.js', path.join(p, 'index.js')]) {
      try {
        if (fs.statSync(c).isFile()) {
          out.push(c);
          break;
        }
      } catch {
        /* not a file */
      }
    }
  }
  return out;
}

function closure(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const e of edges(f)) if (!seen.has(e)) stack.push(e);
  }
  return seen;
}

const rm = path.join(SRC, 'services/gateway/routingMode.js');
const mt = path.join(SRC, 'services/modelTier.js');

const rmClosure = closure(rm);
const mtClosure = closure(mt);

const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/');
console.log('routingMode closure size:', rmClosure.size);
console.log('routingMode reaches modelTier?', rmClosure.has(mt) ? 'YES (cycle would form)' : 'NO');
if (rmClosure.has(mt)) {
  // 找出是哪条边带回来的
  for (const f of rmClosure) {
    if (edges(f).includes(mt)) console.log('  edge from', rel(f));
  }
}
console.log('modelTier closure size:', mtClosure.size);
console.log('modelTier already reaches routingMode?', mtClosure.has(rm) ? 'YES' : 'NO');
