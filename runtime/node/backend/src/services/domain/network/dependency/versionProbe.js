'use strict';

/**
 * dependency/versionProbe.js — depId → 已装版本探针（盘点面专用叶子）。
 *
 * resolver.probe 只回答「装没装」（PATH 探活），回答不了「装的是哪个版本」——
 * 换机迁移时版本对账需要后者。本表把 (depId → bins/args/parse) 收敛为单一真源，
 * probeVersion(depId) 用 execFile 跑 `<bin> --version` 并正则提取版本号。
 *
 * 安全与超时红线（与 registry/installRunner 同源）：
 *   - bins/args 全为 curated 字面量，绝不取自报错文本/模型输入，绝不 shell 拼接。
 *   - 单 bin 5s 超时是 RUNTIME-003 的「短 I/O 超时」合法例外：探针防的是
 *     挂死的子进程 I/O，不是在杀一个活跃任务；回调只 resolve 不 kill 进程树。
 *   - 永不抛：任何失败 version=null，由调用方（inventory）如实呈现「版本未知」。
 *
 * win32 经 cmd.exe /d /s /c 解析 .cmd 垫片（tsc / moon 这类 npm 全局 shim，
 * 纯 execFile 会 ENOENT）——与 installRunner._buildExecInvocation 同一先例。
 */

// 5s：版本探针的短 I/O 超时（见头注释的 RUNTIME-003 例外声明）。
const PROBE_TIMEOUT_MS = 5000;

/** 默认版本提取：输出里第一个 x.y / x.y.z 语义版本 token。 */
const DEFAULT_PARSE = /(\d+\.\d+(?:\.\d+)?)/;

/**
 * 版本探针表。键与 registry.js 的 depId 对齐；未收录的 depId 返回 version=null。
 * bins 多候选沿用 registry python3 的先例（首中即止）。
 */
const VERSION_PROBES = {
  python3: { bins: ['python3', 'python', 'py'], args: ['--version'] },
  nodejs: { bins: ['node'], args: ['--version'] },
  openjdk: { bins: ['javac'], args: ['--version'] },
  gcc: { bins: ['gcc'], args: ['--version'] },
  gpp: { bins: ['g++'], args: ['--version'] },
  clang: { bins: ['clang'], args: ['--version'] },
  make: { bins: ['make'], args: ['--version'] },
  cmake: { bins: ['cmake'], args: ['--version'] },
  nasm: { bins: ['nasm'], args: ['--version'] },
  rust: { bins: ['rustc'], args: ['--version'] },
  go: { bins: ['go'], args: ['version'] },
  dotnet: { bins: ['dotnet'], args: ['--version'] },
  typescript: { bins: ['tsc'], args: ['--version'] },
  moonbit: { bins: ['moon'], args: ['version'] },
  wabt: { bins: ['wasm2wat'], args: ['--version'] },
};

/**
 * 把一条 argv 解析为「可执行文件 + 参数」（win32 经 cmd.exe 解析 .cmd 垫片）。
 * 与 installRunner._buildExecInvocation 同构；独立小实现避免盘点叶子反向依赖执行器。
 */
function _buildInvocation(bin, args, platform) {
  if (platform === 'win32') {
    return {
      exe: process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', bin, ...args],
    };
  }
  return { exe: bin, args };
}

/** 默认真实执行器：execFile 单条 argv，短 I/O 超时，resolve 不 reject。 */
function _realRunner(bin, args, { platform, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let execFile;
    try {
      ({ execFile } = require('child_process'));
    } catch {
      resolve({ ok: false, stdout: '', stderr: 'child_process unavailable' });
      return;
    }
    // platform 从注入缝取（缺省才落 process.platform）：_realRunner 本身也是
    // probeVersion 的 opts.runner 可替换项，签名须与注入约定一致。
    const { exe, args: exeArgs } = _buildInvocation(bin, args, platform || process.platform);
    execFile(
      exe,
      exeArgs,
      { timeout: timeoutMs || PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.message) || ''),
        });
      }
    );
  });
}

/**
 * 探测某 depId 的已装版本。永不抛。
 * @param {string} depId
 * @param {object} [opts] { runner, platform, timeoutMs }（runner 供测试注入纯内存桩）
 * @returns {Promise<{ version:(string|null), raw:string, binUsed:(string|null) }>}
 */
async function probeVersion(depId, opts = {}) {
  const spec = VERSION_PROBES[depId];
  if (!spec) {
    return { version: null, raw: '', binUsed: null };
  }
  const runner = typeof opts.runner === 'function' ? opts.runner : _realRunner;
  const platform = opts.platform || process.platform;
  for (const bin of spec.bins) {
    let res;
    try {
      res = await runner(bin, spec.args, { platform, timeoutMs: opts.timeoutMs });
    } catch {
      continue;
    }
    if (!res || !res.ok) {
      // ENOENT / 非零退出 → 换下一候选；全失败按「版本未知」如实返回。
      continue;
    }
    const raw = String(res.stdout || '').trim() || String(res.stderr || '').trim();
    const parse = spec.parse || DEFAULT_PARSE;
    const m = parse.exec(raw);
    return { version: m ? m[1] : null, raw, binUsed: bin };
  }
  return { version: null, raw: '', binUsed: null };
}

/** 列出已登记版本探针的 depId（供盘点/文档陈述）。 */
function listProbedDepIds() {
  return Object.keys(VERSION_PROBES);
}

module.exports = {
  probeVersion,
  listProbedDepIds,
  PROBE_TIMEOUT_MS,
  VERSION_PROBES,
  _internal: { _buildInvocation, _realRunner },
};
