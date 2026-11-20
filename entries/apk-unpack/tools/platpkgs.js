// Print os/cpu/main fields for platform-specific native packages
const fs = require('fs');
const zlib = require('zlib');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const buf = fs.readFileSync(zip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const cdCount = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
const interesting = [
  '@deepseek-ai/libreoffice-kit', '@deepseek-ai/libreoffice-kit-win32-x64',
  '@img/sharp', '@img/sharp-wasm32', '@img/sharp-win32-x64',
  'node-pty', 'koffi', '@koromix/koffi-win32-x64',
  'sherpa-onnx-node', 'sherpa-onnx-win-x64',
  '@vscode/ripgrep', '@vscode/ripgrep-win32-x64', '@vscode/ripgrep-android-arm64',
  '@emnapi/runtime', 'node-addon-require-builtin', 'node-addon-require-builtin-win32-x64-msvc',
  '@deepseek-ai/node-addon-system', 'openai', '@anthropic-ai/sdk', '@google/genai',
  '@aws-sdk/client-bedrock-runtime', '@modelcontextprotocol/client', '@agentclientprotocol/sdk',
];
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(p + 28);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const lho = buf.readUInt32LE(p + 42);
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  const m = name.match(/^(lib\/node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*))\/package\.json$/);
  if (!m || !interesting.includes(m[2])) continue;
  const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const raw = buf.slice(dataStart, dataStart + csize);
  const j = JSON.parse((method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8'));
  console.log(`${j.name}@${j.version}  os=${JSON.stringify(j.os)} cpu=${JSON.stringify(j.cpu)} libc=${JSON.stringify(j.libc)} main=${j.main || ''} deps=${j.dependencies ? Object.keys(j.dependencies).length : 0}`);
}
