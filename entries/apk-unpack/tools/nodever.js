const fs = require('fs');
const out = fs.readFileSync(__dirname + '/tools/scratch/bin__node');
const s = out.toString('latin1');
for (const pat of ['24.18.0', 'v24.18.0', 'node/v', 'NODE_VERSION', 'modules/116']) {
  let i = s.indexOf(pat);
  console.log(`--- "${pat}" first at ${i}`);
  if (i >= 0) console.log(JSON.stringify(s.slice(Math.max(0, i - 120), i + 120)));
}
// count how many times 24.18.0 appears
console.log('count 24.18.0:', (s.match(/24\.18\.0/g) || []).length);
// check embedded openssl/uv versions
for (const pat of ['OpenSSL 3', 'libuv', 'v8 ', 'V8 ']) {
  const i = s.indexOf(pat);
  if (i >= 0) console.log(`${pat} @${i}:`, JSON.stringify(s.slice(i, i + 60)));
}
