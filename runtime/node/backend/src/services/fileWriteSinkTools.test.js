// 反向锁：所有写盘工具都必须走 fileWriteService，不许自己 fs.writeFileSync。
//
// 做法是把统一写通道的 write 换成一个**不落盘**的探针，然后调用每个工具：
// 探针收到调用且磁盘内容纹丝不动 = 工具确实把写盘交给了通道；探针收到 0 次
// 而磁盘变了 = 工具自己写了（这条断言在 M2 之前会红，正是要防的回退）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sink-tools-'));
process.env.KHYQUANT_CWD = tmpRoot;
process.env.KHY_DATA_HOME = path.join(tmpRoot, 'data-home');
process.env.KHY_FILE_LOCK_DIR = path.join(tmpRoot, 'locks');
process.env.KHY_ENFORCE_READ_BEFORE_EDIT = '0';
// 工具层的写入边界校验：临时目录既不在项目内也不在受信家目录内。
process.env.KHY_WRITE_EXTRA_ROOTS = tmpRoot;

const sink = require('./fileWriteService');
const realWrite = sink.write;
const readTracker = require('../tools/_readTracker');

const editFile = require('../tools/editFile');
const writeFileTool = require('../tools/writeFile');
const multiEdit = require('../tools/MultiEdit');
const multiEditTool = require('../tools/MultiEditTool/index.js');
const replaceAtLocation = require('../tools/replaceAtLocation');

let probeCalls = [];

function installProbe(result) {
  probeCalls = [];
  sink.write = async (args) => {
    probeCalls.push(args);
    return typeof result === 'function' ? result(args) : result;
  };
}

test.after(() => {
  sink.write = realWrite;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFile(name, content) {
  const abs = path.join(tmpRoot, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

const OK_RESULT = { ok: true, state: 'ok', mtimeMs: Date.now(), bytes: 1 };

test('editFile：写盘交给通道，工具自己不再动磁盘', async () => {
  const abs = makeFile('edit-a.txt', 'alpha beta\n');
  installProbe(OK_RESULT);

  const res = await editFile.execute({ file_path: 'edit-a.txt', old_string: 'beta', new_string: 'gamma' });

  assert.equal(res.success, true);
  assert.equal(probeCalls.length, 1);
  const call = probeCalls[0];
  assert.equal(call.actor, 'tool');
  assert.equal(call.reason, 'editFile');
  assert.equal(call.content, 'alpha gamma\n');
  assert.equal(call.beforeContent, 'alpha beta\n');
  assert.equal(typeof call.baseMtimeMs, 'number');
  assert.equal(fs.readFileSync(abs, 'utf-8'), 'alpha beta\n', '探针不落盘时磁盘必须原样');
});

test('editFile：通道拒绝时工具如实失败，绝不假装成功', async () => {
  makeFile('edit-b.txt', 'one\n');
  installProbe({ ok: false, state: 'conflict', diskMtimeMs: 1, error: '文件已在磁盘上被修改：直接覆盖会丢掉对方的改动，请重新加载后再改' });

  const res = await editFile.execute({ file_path: 'edit-b.txt', old_string: 'one', new_string: 'two' });
  assert.equal(res.success, false);
  assert.match(res.error, /已在磁盘上被修改/);
});

test('writeFile：新建/覆盖都走通道，createIfMissing 显式传下去', async () => {
  fs.mkdirSync(path.join(tmpRoot, 'nested'), { recursive: true });
  installProbe(OK_RESULT);

  const res = await writeFileTool.execute({ path: 'nested/new.txt', content: 'hello\n' });

  assert.equal(res.success, true);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].reason, 'writeFile');
  assert.equal(probeCalls[0].createIfMissing, true);
  assert.equal(probeCalls[0].content, 'hello\n');
  assert.equal(fs.existsSync(path.join(tmpRoot, 'nested', 'new.txt')), false);
});

test('MultiEdit：多块编辑先在内存合并，一次交给通道', async () => {
  makeFile('multi.txt', 'a=1\nb=2\n');
  installProbe(OK_RESULT);

  const res = await multiEdit.execute({
    edits: [
      { file_path: 'multi.txt', old_string: 'a=1', new_string: 'a=9' },
      { file_path: 'multi.txt', old_string: 'b=2', new_string: 'b=8' },
    ],
  });

  assert.equal(res.success, true);
  assert.equal(probeCalls.length, 1, '同一文件的多块编辑不能分多次写盘');
  assert.equal(probeCalls[0].reason, 'MultiEdit');
  assert.equal(probeCalls[0].content, 'a=9\nb=8\n');
});

test('MultiEditTool：单文件多块编辑同样只走一次通道', async () => {
  const abs = makeFile('multi-tool.txt', 'x\n');
  // 这个工具的先读后写闸门不看 KHY_ENFORCE_READ_BEFORE_EDIT——按真实回路先登记已读。
  readTracker.markRead(abs);
  installProbe(OK_RESULT);

  const res = await multiEditTool.execute({
    file_path: 'multi-tool.txt',
    edits: [{ old_string: 'x', new_string: 'y' }],
  });

  assert.equal(res.success, true);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].reason, 'MultiEditTool');
  assert.equal(probeCalls[0].content, 'y\n');
});

test('FileEditTool（Edit）：exact 路径走通道', async () => {
  const abs = makeFile('edit-tool.txt', 'const a = 1;\n');
  readTracker.markRead(abs);
  installProbe(OK_RESULT);

  const FileEditTool = require('../tools/FileEditTool');
  const res = await FileEditTool.execute({
    file_path: 'edit-tool.txt',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
  });

  assert.equal(res.success, true, res.error);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].reason, 'FileEditTool');
  assert.equal(probeCalls[0].baseMtimeMs > 0, true);
  assert.equal(probeCalls[0].content, 'const a = 2;\n');
  assert.equal(fs.readFileSync(abs, 'utf-8'), 'const a = 1;\n');
});

test('ApplyPatchTool：补丁写入走通道，且不再自行 tmp/rename', async () => {
  makeFile('patch-target.txt', 'old\n');
  installProbe(OK_RESULT);

  const ApplyPatchTool = require('../tools/ApplyPatchTool');
  const tool = new ApplyPatchTool();
  const patch = [
    '--- a/patch-target.txt',
    '+++ b/patch-target.txt',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  const res = await tool.execute({ patch });

  assert.equal(res.success, true, res.error);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].reason, 'ApplyPatchTool');
  assert.equal(probeCalls[0].content, 'new\n');
  // Phase 1 已按批登记审计，通道侧不得再记第二遍。
  assert.equal(probeCalls[0].skipAudit, true);
});

test('replaceAtLocation：定位替换走通道', async () => {
  makeFile('replace.txt', '只有第一处需要改。第二处不动。');
  installProbe(OK_RESULT);

  const res = await replaceAtLocation.execute({
    file_path: 'replace.txt',
    word: '处',
    replacement: '点',
    paragraph: 1,
    occurrence: 1,
  });

  assert.equal(res.success, true, res.error);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].reason, 'replaceAtLocation');
  assert.equal(probeCalls[0].content, '只有第一点需要改。第二处不动。');
});

test('真实写盘：editFile 完成后磁盘更新且该路径被记成已读', async () => {
  const abs = makeFile('real.txt', 'keep me\n');
  sink.write = realWrite;

  const res = await editFile.execute({ file_path: 'real.txt', old_string: 'keep', new_string: 'kept' });

  assert.equal(res.success, true, res.error);
  assert.equal(fs.readFileSync(abs, 'utf-8'), 'kept me\n');
  assert.equal(readTracker.hasRead(abs), true, '写后必须登记已读，否则 AI 下一次编辑会被误判过期');
});
