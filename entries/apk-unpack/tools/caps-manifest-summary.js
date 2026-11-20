// 统计 caps-manifest.json 的能力条目分布，只读文件、不执行其中的任何代码
const fs = require('fs');
const path = process.argv[2];
const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
const caps = doc.capabilities;

console.log('version:', doc.version, '| 顶层键:', Object.keys(doc).join(','));
console.log('条目数:', caps.length);

const by = (key) => {
  const m = {};
  for (const c of caps) {
    const v = typeof c[key] === 'object' && c[key] !== null ? JSON.stringify(c[key]) : String(c[key]);
    m[v] = (m[v] || 0) + 1;
  }
  return m;
};
console.log('\ncategory 分布:', JSON.stringify(by('category')));
console.log('risk 分布:', JSON.stringify(by('risk')));
console.log('irreversible 分布:', JSON.stringify(by('irreversible')));
console.log('requiresConfirmation 分布:', JSON.stringify(by('requiresConfirmation')));
console.log('legal.basis 分布:', JSON.stringify(by('legal')));

console.log('\naudit.log 分布:');
for (const c of caps) {
  const k = c.audit ? c.audit.log : '(缺失)';
  console.log('  ', k, '—', c.id, 'redact=' + JSON.stringify(c.audit ? c.audit.redact : null));
}

console.log('\nreversible 非空条目:');
for (const c of caps) {
  if (c.reversible) console.log('  ', c.id, JSON.stringify(c.reversible));
}

console.log('\nscope 非空条目:');
for (const c of caps) {
  if (c.scope && Object.keys(c.scope).length) console.log('  ', c.id, JSON.stringify(c.scope));
}

console.log('\n字段完备性（每条是否含 7 字段）:');
for (const c of caps) {
  const miss = ['id', 'category', 'title', 'risk', 'irreversible', 'requiresConfirmation', 'scope', 'reversible', 'audit', 'legal']
    .filter((k) => !(k in c));
  if (miss.length) console.log('  ', c.id, '缺:', miss.join(','));
}
console.log('  （无输出 = 45 条全部含 id/category/title/risk/irreversible/requiresConfirmation/scope/reversible/audit/legal）');

console.log('\nid 唯一性:', new Set(caps.map((c) => c.id)).size, '/', caps.length);

console.log('\n全部条目（id | title | category | risk | irreversible | requiresConfirmation）:');
for (const c of caps) {
  console.log('  ' + [c.id, c.title, c.category, c.risk, c.irreversible, c.requiresConfirmation].join(' | '));
}
