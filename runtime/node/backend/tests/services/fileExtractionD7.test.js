'use strict';

/**
 * [DESIGN-ARCH-163] D7-b/c 编排层单测（node:test）。
 *
 * 锁定:
 *  ① zip 清单（假 runner 确定性 + 真 python 集成各一条，真环境缺 python 则 skip）;
 *  ② bmp 位图引用: 文件头尺寸卡 + 三段式引导；ffmpeg 在场 → 转码注入图轨;
 *  ③ audio: ffprobe 元数据 + 同名 .lrc 歌词文本轨（证据等级注记）;
 *  ④ video V2: 抽帧注入 options.images，label/对照表 `文件j·帧i/N` 同源;
 *     达 MAX_CARDS 上限 → 跳过并如实声明;
 *  ⑤ 门控 KHY_HONEST_UNSUPPORTED_GUIDE=0 → 卡逐字节回退 D6（无【声明】/【行为约定】）;
 *  ⑥ 发现层: 门控开才把 zip/mp3/mp4/bmp 路径纳入引用面。
 *
 * 工具与子进程全部走 _setD7ToolsForTest/_setD7RunnerForTest 缝，测试不依赖本机 ffmpeg。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const svc = require('../../src/services/imageContextCardService');

const JPEGISH = Buffer.from('FFD8FFE0'.repeat(32), 'hex');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-d7-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-`));
}

// 最小 store-method zip（Node 22+ zlib.crc32），不依赖外部工具。
function buildStoreZip(file) {
  const mk = (name, content) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(content);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(33, 12); // DOS date 1980-01-01（month=0 会让 zipfile.date_time 解出非法月）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    return Buffer.concat([lh, nameBuf, content]);
  };
  const entries = [
    ['hello.txt', Buffer.from('inner-one', 'utf8')],
    ['src/main.js', Buffer.from('inner-two', 'utf8')],
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const local = mk(name, content);
    locals.push(local);
    const nameBuf = Buffer.from(name, 'utf8');
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(33, 14); // DOS date
    ch.writeUInt32LE(zlib.crc32(content), 16);
    ch.writeUInt32LE(content.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

function bmpFile(file, w, h) {
  const off = 54;
  const px = Buffer.alloc(w * h * 3, 7);
  const head = Buffer.alloc(off);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(off + px.length, 2);
  head.writeUInt32LE(off, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  fs.writeFileSync(file, Buffer.concat([head, px]));
}

const NO_TOOLS = { python: null, ffmpeg: null, ffprobe: null };
const ALL_TOOLS = { python: 'py', ffmpeg: 'ff', ffprobe: 'fp' };

function runner(handlers) {
  return async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) {
      throw new Error(`unexpected cmd ${cmd}`);
    }
    return h(args);
  };
}

test('D7-B1 zip 清单(假 runner): 前 N/总数 + 未展开声明 + 行为约定', async () => {
  const dir = tmpDir();
  const zip = path.join(dir, 'x.zip');
  buildStoreZip(zip);
  svc._setD7ToolsForTest(ALL_TOOLS);
  svc._setD7RunnerForTest(
    runner({
      py: () => ({
        stdout: JSON.stringify({ entries: ['hello.txt', 'src/main.js'], total: 2, encrypted: false, error: '' }),
      }),
    })
  );
  try {
    const out = await svc.attachContextCard(`看 ${zip} 里有什么`, {}, {});
    assert.match(out, /目录清单（前 2\/2 条，未见加密条目）/);
    assert.match(out, /py:zipfile\/tarfile/);
    assert.match(out, /【声明】包内文件未展开/);
    assert.match(out, /【行为约定】/);
    assert.ok(!out.includes('该格式暂无正文提取通道'));
  } finally {
    svc._resetD7ForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7-B1b zip 清单(真 python 集成): 条目与 fixture 一致；缺 python 则 skip', (t) => {
  const candidates = ['python', 'python3'];
  let bin = null;
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf-8', timeout: 8000 });
      if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) {
        bin = c;
        break;
      }
    } catch {
      /* keep looking */
    }
  }
  if (!bin) {
    t.skip('no real python3 on PATH');
    return;
  }
  const dir = tmpDir();
  const zip = path.join(dir, 'real.zip');
  buildStoreZip(zip);
  svc._setD7ToolsForTest({ python: bin, ffmpeg: null, ffprobe: null });
  return svc
    ._listArchive(zip, {})
    .then((r) => {
      assert.strictEqual(r.ok, true, `listing failed: ${r.reason}`);
      assert.deepStrictEqual(r.entries, ['hello.txt', 'src/main.js']);
      assert.strictEqual(r.total, 2);
      assert.strictEqual(r.encrypted, false);
    })
    .finally(() => {
      svc._resetD7ForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    });
});

test('D7-B2 bmp: 文件头尺寸 + 无 ffmpeg 引导；有 ffmpeg → 转码注入图轨', async () => {
  const dir = tmpDir();
  const bmp = path.join(dir, 'shot.bmp');
  bmpFile(bmp, 8, 4);
  // 无 ffmpeg：仅尺寸+引导
  svc._setD7ToolsForTest(NO_TOOLS);
  try {
    const out = await svc.attachContextCard(`参考 ${bmp}`, {}, {});
    assert.match(out, /位图文件头解析: 8x4 · 24bpp/);
    assert.match(out, /【声明】只做文件头解析/);
    assert.match(out, /khy doctor/);
  } finally {
    svc._resetD7ForTest();
  }
  // 有 ffmpeg：转码成功 → 图轨 +1，卡注明已转码
  const options = { images: [] };
  svc._setD7ToolsForTest({ python: null, ffmpeg: 'ff', ffprobe: null });
  svc._setD7RunnerForTest(
    runner({
      ff: (args) => {
        fs.writeFileSync(args[args.length - 1], JPEGISH);
        return { stdout: '' };
      },
    })
  );
  try {
    const out = await svc.attachContextCard(`参考 ${bmp}`, options, {});
    assert.strictEqual(options.images.length, 1);
    assert.strictEqual(options.images[0].label, 'shot.bmp');
    assert.match(out, /已本地转码为标准图/);
    assert.match(out, /图1=shot\.bmp/);
  } finally {
    svc._resetD7ForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7-B3 mp3: ffprobe 元数据 + 同名 .lrc 摘录 + 旋律未转录声明', async () => {
  const dir = tmpDir();
  const mp3 = path.join(dir, 'song.mp3');
  fs.writeFileSync(mp3, Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(dir, 'song.lrc'), '[00:01.00]第一行歌词\n[00:05.00]第二行歌词\n');
  svc._setD7ToolsForTest({ python: null, ffmpeg: null, ffprobe: 'fp' });
  svc._setD7RunnerForTest(
    runner({
      fp: () => ({
        stdout: JSON.stringify({
          format: { duration: '125.4', bit_rate: '128000', tags: { TITLE: '-demo' } },
          streams: [{ codec_type: 'audio', sample_rate: '44100', channels: 2, codec_name: 'mp3' }],
        }),
      }),
    })
  );
  try {
    const out = await svc.attachContextCard(`听 ${mp3}`, {}, {});
    assert.match(out, /时长 2m 5s/);
    assert.match(out, /采样率 44100Hz/);
    assert.match(out, /以下歌词摘录来自同名 \.lrc 文本轨，不是听写结果/);
    assert.match(out, /第一行歌词/);
    assert.match(out, /【声明】旋律与人声内容未转录/);
    assert.match(out, /【行为约定】/);
  } finally {
    svc._resetD7ForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7-B4 video V2: 抽帧注入图轨 + 对照表 文件j·帧i/N 同源 + 字幕证据等级注记', async () => {
  const dir = tmpDir();
  const mp4 = path.join(dir, 'demo.mp4');
  fs.writeFileSync(mp4, Buffer.alloc(2048, 2));
  fs.writeFileSync(path.join(dir, 'demo.srt'), '1\n00:00:01,000 --> 00:00:02,000\n字幕内容一\n');
  const options = { images: [] };
  svc._setD7ToolsForTest(ALL_TOOLS);
  svc._setD7RunnerForTest(
    runner({
      fp: () => ({
        stdout: JSON.stringify({
          format: { duration: '30' },
          streams: [
            { codec_type: 'video', width: 640, height: 360, r_frame_rate: '30000/1001', codec_name: 'h264' },
            { codec_type: 'audio' },
          ],
        }),
      }),
      ff: (args) => {
        const pattern = args[args.length - 1];
        fs.writeFileSync(pattern.replace('%03d', '001'), JPEGISH);
        fs.writeFileSync(pattern.replace('%03d', '002'), JPEGISH);
        return { stdout: '' };
      },
    })
  );
  try {
    const out = await svc.attachContextCard(`看 ${mp4}`, options, {});
    assert.strictEqual(options.images.length, 2);
    assert.match(options.images[0].label, /^文件1·帧1\/3$/);
    assert.match(options.images[1].label, /^文件1·帧2\/3$/);
    assert.match(out, /【附件对照 3\/3】/);
    assert.match(out, /图1=文件1·帧1\/3/);
    assert.match(out, /分辨率 640x360/);
    assert.match(out, /帧率 29\.97/);
    assert.match(out, /含音轨\(未转录\)/);
    assert.match(out, /以下摘录来自同名 \.srt 字幕文本，非画面内容/);
    assert.match(out, /【声明】画面以 2 帧抽样进入本消息图轨/);
  } finally {
    svc._resetD7ForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7-B4b 帧数门控与上限: KHY_VIDEO_THUMB_FRAMES=0 不抽帧；图已达 MAX_CARDS 如实跳过', async () => {
  const dir = tmpDir();
  const mp4 = path.join(dir, 'clip.mp4');
  fs.writeFileSync(mp4, Buffer.alloc(1024, 3));
  svc._setD7ToolsForTest(ALL_TOOLS);
  svc._setD7RunnerForTest(
    runner({
      fp: () => ({ stdout: JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'video', width: 100, height: 100 }] }) }),
      ff: (args) => {
        fs.writeFileSync(args[args.length - 1].replace('%03d', '001'), JPEGISH);
        return { stdout: '' };
      },
    })
  );
  try {
    const off = { images: [] };
    const outOff = await svc.attachContextCard(`看 ${mp4}`, off, { KHY_VIDEO_THUMB_FRAMES: '0' });
    assert.strictEqual(off.images.length, 0);
    assert.match(outOff, /画面内容未采样/);

    const capped = { images: [{}, {}, {}] };
    const outCap = await svc.attachContextCard(`看 ${mp4}`, capped, {});
    assert.strictEqual(capped.images.length, 3);
    assert.match(outCap, /已达单轮图上限，本回合未抽帧/);
  } finally {
    svc._resetD7ForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7-B5 门控关: 引用卡逐字节回退 D6 文案，无声明/约定、无图轨注入', async () => {
  const dir = tmpDir();
  const doc = path.join(dir, 'legacy.doc');
  fs.writeFileSync(doc, Buffer.alloc(512, 4));
  const mp4 = path.join(dir, 'clip.mp4');
  fs.writeFileSync(mp4, Buffer.alloc(512, 5));
  svc._setD7ToolsForTest(ALL_TOOLS);
  svc._setD7RunnerForTest(() => {
    throw new Error('runner must not be called when gate off');
  });
  const options = { images: [] };
  const prompt = `对照 ${doc} 与 ${mp4}`;
  try {
    const out = await svc.attachContextCard(prompt, options, { KHY_HONEST_UNSUPPORTED_GUIDE: '0' });
    assert.match(out, /该格式暂无正文提取通道，仅登记引用/);
    assert.ok(!out.includes('【声明】'));
    assert.ok(!out.includes('【行为约定】'));
    assert.strictEqual(options.images.length, 0);
    // D6 引用面不含 .mp4 → 卡片区只有 legacy.doc 一张文件卡（prompt 原文里仍会有 mp4 路径）
    assert.strictEqual(out.split('【文件说明书').length - 1, 1);
    assert.ok(!out.includes('文件说明书 2'));
  } finally {
    svc._resetD7ForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7-B6 发现层: 门控开才纳入 zip/mp4/bmp 扩展面', () => {
  const leafRefs = require('../../src/cli/repl/inlineFileRefs');
  const p = 'C:\\a\\x.zip C:\\a\\y.mp4 C:\\a\\z.bmp C:\\a\\w.md';
  assert.deepStrictEqual(leafRefs.extractAllFileReferences(p).map((r) => r.filePath), ['C:\\a\\w.md']);
  const wide = leafRefs.extractAllFileReferences(p, leafRefs.D7_MEDIA_EXT_SET).map((r) => r.filePath);
  assert.deepStrictEqual(wide, ['C:\\a\\x.zip', 'C:\\a\\y.mp4', 'C:\\a\\z.bmp', 'C:\\a\\w.md']);
});
