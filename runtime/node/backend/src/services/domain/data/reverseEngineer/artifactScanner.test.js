'use strict';

/**
 * artifactScanner.test.js — 只读制品分诊 契约共置测试（批次 27）。
 *
 * 这一层是整条逆向流水线的入口，两条契约最要紧：
 *   1. 绝不执行制品，也绝不抛——不可读/畸形/空文件一律降级为 unknown 事实；
 *   2. 判定是封闭集合：format 来自 FORMATS 首个签名命中，family/recoverability
 *      只能来自 registry 声明，嵌入标记只「升级」档位而不臆造新事实。
 * 所有期望值取自当前实测（构造输入跑过 scanner），不是设想。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanner = require('./artifactScanner');
const registry = require('./formatRegistry');

const { scanFile, scanFileSync, HEADER_BYTES, _disambiguateCafebabe, _isStrongerRecoverability } = scanner;

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let _dir = null;
function tmpDir() {
  if (!_dir) {
    _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b27-scan-'));
  }
  return _dir;
}

/** 在系统临时区写一个合成产物，返回路径（绝不落在工作区内）。 */
function writeArtifact(name, buf) {
  const p = path.join(tmpDir(), name);
  fs.writeFileSync(p, buf);
  return p;
}

function elf(opts = {}) {
  const buf = Buffer.alloc(256, 0);
  buf.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0); // \x7fELF
  buf[4] = opts.cls ?? 2; // ELFCLASS64
  buf[5] = opts.data ?? 1; // ELFDATA2LSB
  const machine = opts.machine ?? 0x3e; // x86-64
  if (opts.machineBe) {
    buf.writeUInt16BE(machine, 18);
  } else {
    buf.writeUInt16LE(machine, 18);
  }
  return buf;
}

function pe(machine = 0x8664) {
  const buf = Buffer.alloc(0x48, 0);
  buf.set(Buffer.from('MZ', 'ascii'), 0);
  buf.writeUInt32LE(0x40, 0x3c); // e_lfanew → PE\0\0 紧接其后
  buf.set(Buffer.from('PE\0\0', 'ascii'), 0x40);
  buf.writeUInt16LE(machine, 0x44);
  return buf;
}

// ── 降级路径：不存在 / 目录 / 空文件 / 乱码 ────────────────────────────────

test('不存在的产物：exists=false 且各字段为中性值，扩展名仍按小写记录', () => {
  const r = scanFileSync(path.join(tmpDir(), 'nope.PY'));
  assert.deepStrictEqual(r, {
    path: path.join(tmpDir(), 'nope.PY'),
    exists: false,
    sizeBytes: 0,
    sha256: null,
    format: 'unknown',
    family: 'unknown',
    recoverability: 'unknown',
    label: 'Unknown / opaque bytes',
    ext: '.py',
    arch: {},
    markers: [],
    candidateTools: [],
    note: '',
  });
});

test('目录不是产物：statSync 成功也判 exists=false（不因此去读字节）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir(), ' subdir-'));
  const r = scanFileSync(dir);
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.sha256, null);
});

test('0 字节文件：exists=true，sha256 为空串哈希，格式 unknown 且不抛', () => {
  const r = scanFileSync(writeArtifact('empty.bin', Buffer.alloc(0)));
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.sizeBytes, 0);
  assert.strictEqual(r.sha256, EMPTY_SHA256);
  assert.strictEqual(r.format, 'unknown');
});

test('无签名命中的乱码：事实照收（大小/哈希/ext），判定留 unknown', () => {
  const body = crypto.randomBytes(4096);
  const p = writeArtifact('noise.bin', body);
  const r = scanFileSync(p);
  assert.strictEqual(r.format, 'unknown');
  assert.strictEqual(r.sizeBytes, 4096);
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.deepStrictEqual([r.markers, r.candidateTools, r.arch], [[], [], {}]);
});

test('scanFile 与 scanFileSync 对同一文件给出逐字节相同的结果', async () => {
  const p = writeArtifact('same.elf', elf());
  assert.deepStrictEqual(await scanFile(p), scanFileSync(p));
});

// ── 头部窗口与签名匹配 ────────────────────────────────────────────────────

test('HEADER_BYTES=512 是有意为之：最深签名 tar 的 magic 在 257', () => {
  assert.strictEqual(HEADER_BYTES, 512);
  const buf = Buffer.alloc(512, 0);
  buf.set(Buffer.from('ustar', 'ascii'), 257);
  const r = scanFileSync(writeArtifact('x.tar', buf));
  assert.deepStrictEqual([r.format, r.family, r.recoverability], ['archive-tar', 'archive', 'archive']);
  assert.deepStrictEqual(r.candidateTools, []);
});

test('签名窗口外的 magic 不算命中（前 512 字节之外即未知）', () => {
  const buf = Buffer.alloc(1024, 0);
  buf.set(Buffer.from('ustar', 'ascii'), 600);
  assert.strictEqual(scanFileSync(writeArtifact('late.tar', buf)).format, 'unknown');
});

test('ELF x86-64：架构字段按 e_class/e_data/e_machine 还原', () => {
  const r = scanFileSync(writeArtifact('a.out', elf()));
  assert.deepStrictEqual([r.format, r.family, r.recoverability], ['elf', 'elf', 'native']);
  assert.deepStrictEqual(r.arch, { bits: 64, endian: 'little', arch: 'x86-64' });
  assert.match(r.label, /ELF/);
  assert.deepStrictEqual(r.candidateTools, ['radare2', 'r2', 'objdump', 'nm', 'readelf']);
});

test('ELF 32 位 x86 与 arm64 各自命中，未知 e_machine 保留原值不编造名字', () => {
  assert.strictEqual(scanFileSync(writeArtifact('e32', elf({ cls: 1, machine: 0x03 }))).arch.arch, 'x86');
  assert.strictEqual(scanFileSync(writeArtifact('e32', elf({ cls: 1, machine: 0x03 }))).arch.bits, 32);
  assert.strictEqual(scanFileSync(writeArtifact('e64', elf({ machine: 0xb7 }))).arch.arch, 'arm64');
  const odd = scanFileSync(writeArtifact('e64', elf({ machine: 0x1234 })));
  assert.strictEqual(odd.arch.arch, 'machine:4660');
});

test('ELF 大端：endian 认对但 e_machine 仍按小端读（已登记的已知边界）', () => {
  // _detectArch 无条件 readUInt16LE(18)，大端 ELF 的 e_machine 会被读反。
  // 实测 0xb7(arm64 BE) → 46848 → 'machine:46848'：不抛、不冒充已知架构，
  // 只是名字退化。已写入 khy.module.json → knownBoundaries，非本批修复项。
  const r = scanFileSync(writeArtifact('eb.bin', elf({ machine: 0xb7, data: 2, machineBe: true })));
  assert.deepStrictEqual(r.arch, { bits: 64, endian: 'big', arch: 'machine:46848' });
});

test('ELF 头被截断（<20 字节）：格式仍认出，架构留空而非抛', () => {
  const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  const r = scanFileSync(writeArtifact('tiny.elf', buf));
  assert.strictEqual(r.format, 'elf');
  assert.deepStrictEqual(r.arch, {});
});

test('PE x86-64：e_lfanew 定位 PE\\0\\0 后取 COFF Machine', () => {
  const r = scanFileSync(writeArtifact('app.exe', pe(0x8664)));
  assert.deepStrictEqual([r.format, r.family, r.recoverability], ['pe', 'pe', 'native']);
  assert.deepStrictEqual(r.arch, { bits: 64, arch: 'x86-64' });
  assert.strictEqual(scanFileSync(writeArtifact('app32.exe', pe(0x14c))).arch.bits, 32);
});

test('PE 的 e_lfanew 越界或 PE\\0\\0 签名不符：架构降级为空对象', () => {
  const buf = Buffer.alloc(64, 0);
  buf.set(Buffer.from('MZ', 'ascii'), 0);
  buf.writeUInt32LE(100000, 0x3c); // 指向文件之外
  assert.deepStrictEqual(scanFileSync(writeArtifact('bad.exe', buf)).arch, {});
  const buf2 = Buffer.alloc(96, 0);
  buf2.set(Buffer.from('MZ', 'ascii'), 0);
  buf2.writeUInt32LE(0x40, 0x3c);
  buf2.set(Buffer.from('XX\0\0', 'ascii'), 0x40); // 不是 PE\0\0
  const r2 = scanFileSync(writeArtifact('bad2.exe', buf2));
  assert.strictEqual(r2.format, 'pe');
  assert.deepStrictEqual(r2.arch, {});
});

test('Mach-O 三种 magic 各自认出，32/64 与字节序按头判定', () => {
  const mk = (hex, len = 32) => Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(len - 4, 0)]);
  assert.strictEqual(scanFileSync(writeArtifact('m64', mk('feedfacf'))).arch.bits, 64);
  // cffaedfe 是 64-bit 的小端形态，_detectArch 也按 64 处理。
  assert.strictEqual(scanFileSync(writeArtifact('m64le', mk('cffaedfe'))).arch.bits, 64);
  const r32 = scanFileSync(writeArtifact('m32', mk('feedface')));
  assert.deepStrictEqual([r32.format, r32.arch], ['macho', { bits: 32, arch: 'macho' }]);
});

// ── cafebabe 撞号消歧 ─────────────────────────────────────────────────────

test('cafebabe 归 format 遍历里靠前的 macho，再由后续字节改判', () => {
  const ids = registry.FORMATS.map((f) => f.id);
  assert.ok(ids.indexOf('macho') < ids.indexOf('java-class'), '前置：macho 在 java-class 之前声明');
  const cls = Buffer.alloc(64, 0);
  cls.writeUInt32BE(0xcafebabe, 0);
  cls.writeUInt16BE(0, 4); // minor
  cls.writeUInt16BE(52, 6); // major = JDK 8
  const r = scanFileSync(writeArtifact('Foo.class', cls));
  assert.deepStrictEqual([r.format, r.family, r.recoverability], ['java-class', 'java', 'bytecode']);
});

test('_disambiguateCafebabe 实测边界（以实测为准，不按注释设想）', () => {
  const mk = (major) => {
    const b = Buffer.alloc(8, 0);
    b.writeUInt32BE(0xcafebabe, 0);
    b.writeUInt16BE(major, 6);
    return b;
  };
  assert.strictEqual(_disambiguateCafebabe(mk(44)), 'macho');
  assert.strictEqual(_disambiguateCafebabe(mk(45)), 'java-class');
  assert.strictEqual(_disambiguateCafebabe(mk(200)), 'java-class');
  assert.strictEqual(_disambiguateCafebabe(mk(201)), 'macho');
  assert.strictEqual(_disambiguateCafebabe(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), 'java-class', '不足 8 字节按 class');
});

test('fat/universal Mach-O（cafebabe + 小 nfat_arch）判成 macho，位宽按头退化为 32', () => {
  const b = Buffer.alloc(32, 0);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(2, 4); // nfat_arch = 2 → offset 6..7 = 0x0002
  const r = scanFileSync(writeArtifact('fat.bin', b));
  assert.deepStrictEqual([r.format, r.family], ['macho', 'macho']);
  // 实测：_detectArch('macho') 只看前 4 字节是否 64 位 magic，fat 头一律报 bits 32。
  assert.deepStrictEqual(r.arch, { bits: 32, arch: 'macho' });
});

// ── 嵌入标记：只升级，不臆造 ──────────────────────────────────────────────

test('PE + BSJB → dotnet 标记：家族换掉、档位升到 bytecode、工具合并、标签追加', () => {
  const body = Buffer.concat([pe(0x8664), Buffer.from('BSJB', 'ascii'), Buffer.alloc(64, 0)]);
  const r = scanFileSync(writeArtifact('managed.exe', body));
  assert.deepStrictEqual([r.format, r.family, r.recoverability], ['pe', 'dotnet', 'bytecode']);
  assert.deepStrictEqual(r.markers, ['dotnet']);
  assert.match(r.label, /·/);
  assert.match(r.label, /\.NET assembly/);
  assert.ok(r.candidateTools.includes('ilspycmd'));
  assert.ok(r.candidateTools.includes('radare2'), '原格式的工具不许被标记覆盖掉');
  assert.deepStrictEqual(Array.from(new Set(r.candidateTools)).length, r.candidateTools.length, '合并要保序去重');
});

test('标记的 appliesTo 是硬闸：BSJB 出现在 ELF 里不触发 dotnet 标记', () => {
  const body = Buffer.concat([elf(), Buffer.from('BSJB', 'ascii'), Buffer.alloc(64, 0)]);
  const r = scanFileSync(writeArtifact('notnet.elf', body));
  assert.deepStrictEqual([r.format, r.family, r.markers], ['elf', 'elf', []]);
});

test('PyInstaller cookie 在头部窗口内即命中，裸 ELF 档位升到 source', () => {
  const body = Buffer.concat([elf(), Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'binary'), Buffer.alloc(128, 0)]);
  const r = scanFileSync(writeArtifact('frozen.bin', body));
  assert.deepStrictEqual([r.family, r.recoverability], ['python', 'source']);
  assert.deepStrictEqual(r.markers, ['pyinstaller']);
  assert.ok(r.candidateTools.includes('pyinstxtractor'));
});

test('超过 256 KiB 的产物：尾部窗口确实被读（cookie 在头部窗口之外仍能命中）', () => {
  const head = Buffer.concat([elf(), Buffer.alloc(300 * 1024, 0x41)]);
  const body = Buffer.concat([head, Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'binary')]);
  assert.ok(body.length > 256 * 1024, '前置：cookie 必须落在头部窗口之外');
  const r = scanFileSync(writeArtifact('big.bin', body));
  assert.deepStrictEqual(r.markers, ['pyinstaller']);
  assert.strictEqual(r.recoverability, 'source');
});

test('node-sea 的 altMarkers 任一命中即算（PAYLOAD_POSITION / __NEXE_PATCH__）', () => {
  for (const sentinel of ['NODE_SEA_BLOB', 'PAYLOAD_POSITION', '__NEXE_PATCH__']) {
    const body = Buffer.concat([pe(0x8664), Buffer.from(sentinel, 'ascii'), Buffer.alloc(64, 0)]);
    const r = scanFileSync(writeArtifact(`sea-${sentinel.replace(/[^a-z]/gi, '')}.exe`, body));
    assert.deepStrictEqual(r.markers, ['node-sea'], sentinel);
    assert.deepStrictEqual([r.family, r.recoverability], ['node', 'source'], sentinel);
  }
});

test('标记档位不更强时只记事实不降级：go-binary 命中 ELF 仍留 native/elf', () => {
  const body = Buffer.concat([elf(), Buffer.from('Go build ID:', 'ascii'), Buffer.alloc(64, 0)]);
  const r = scanFileSync(writeArtifact('gobin.elf', body));
  assert.deepStrictEqual(r.markers, ['go-binary']);
  // 家族没换（升级未发生），但工具仍合并进来。
  assert.strictEqual(r.family, 'elf');
  assert.strictEqual(r.recoverability, 'native');
  assert.ok(r.candidateTools.includes('go'));
});

test('shebang 脚本判 SOURCE 档：源码即产物，无需反编译', () => {
  const r = scanFileSync(writeArtifact('run.sh', Buffer.from('#!/bin/sh\necho hi\n', 'ascii')));
  assert.deepStrictEqual([r.format, r.family, r.recoverability], ['script-shebang', 'script', 'source']);
  assert.strictEqual(r.ext, '.sh');
});

test('zip 的三种形态（有数据/空档/跨卷）都判 archive-zip + SOURCE 档', () => {
  for (const hex of ['504b0304', '504b0506', '504b0708']) {
    const buf = Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(64, 0)]);
    const r = scanFileSync(writeArtifact(`z-${hex}.zip`, buf));
    assert.deepStrictEqual([r.format, r.recoverability], ['archive-zip', 'source'], hex);
  }
});

test('JAR 按 zip 认出（扩展名不参与判定），mark 里没有 apk 的档位升级', () => {
  const buf = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(64, 0)]);
  const r = scanFileSync(writeArtifact('app.jar', buf));
  assert.strictEqual(r.format, 'archive-zip');
  assert.strictEqual(r.ext, '.jar');
  // apk 标记刻意不带 recoverability（见 formatRegistry.test.js）：此处即便内容命中也不升档。
  assert.strictEqual(r.family, 'archive');
});

// ── 档位强弱表 ────────────────────────────────────────────────────────────

test('_isStrongerRecoverability 按 source>bytecode>native>archive>unknown，同档不算更强', () => {
  assert.strictEqual(_isStrongerRecoverability('source', 'native'), true);
  assert.strictEqual(_isStrongerRecoverability('bytecode', 'source'), false);
  assert.strictEqual(_isStrongerRecoverability('native', 'native'), false);
  assert.strictEqual(_isStrongerRecoverability('unknown', 'archive'), false);
  // 未知档位（含原型键）一律按 0 处理：不会把已判定的档位抹掉。
  assert.strictEqual(_isStrongerRecoverability('constructor', 'source'), false);
  assert.strictEqual(_isStrongerRecoverability('source', 'toString'), false);
  // 上一条实测为 false 而非 true：`_RANK[b] || 0` 命中原型方法时拿到的是函数，
  // `4 > fn` 恒为 false —— 原型键于是**阻止**升级而非伪造升级。方向是安全的
  // （保守不升档），已作为已知边界登记；registry 的档位值域是封闭的五个字面量。
});
