const fs = require('fs');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const l = fs.readFileSync(__dirname + '/tools/runtime-entries.txt', 'utf8').trim().split('\n').slice(0, -1);
const names = l.map((x) => x.split('\t')[3]).filter((n) => /^(lib\/node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*))\/package\.json$/.test(n));
console.log('package.json count:', names.length);
const want = ['sharp', 'node-pty', 'koffi', 'sherpa-onnx-node', 'ripgrep', 'libreoffice-kit', 'node-addon-system', 'openai', 'bedrock', 'modelcontextprotocol', 'agentclientprotocol'];
for (const n of names) {
  if (want.some((w) => n.includes(w))) console.log(n);
}
