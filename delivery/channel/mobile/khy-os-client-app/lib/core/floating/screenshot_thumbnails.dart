// Screenshot thumbnails for the floating capsule / status screen.
//
// WHY A COPY, NOT THE ORIGINAL. Vision tools hold the screenshot only in
// memory (base64 in the request); nothing on disk shows what the agent is
// looking at, so the overlay's screenshot column would always be empty. The
// thumbnail is a second, bounded artifact: <=320px wide, newest 5 kept — a
// directory that grows one file per tool step would outlive the task and
// slowly eat storage for pixels nobody looks at any more.
//
// Fail-soft end to end: a thumbnail that cannot be written must never break
// the tool call that produced it (the hook is fire-and-forget and every error
// collapses to null).

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

class ScreenshotThumbnailStore {
  ScreenshotThumbnailStore(
    this.dir, {
    this.keep = 5,
    this.maxWidth = 320,
    Future<Uint8List?> Function(Uint8List raw, int maxWidth)? shrink,
  }) : _shrink = shrink ?? shrinkToPng;

  final Directory dir;

  /// 目录里最多留几张。参考效果只看「最新一屏」，5 张是翻旧账的余量。
  final int keep;

  final int maxWidth;

  final Future<Uint8List?> Function(Uint8List raw, int maxWidth) _shrink;

  /// 同一毫秒内连写会撞名（测试里 fake shrink 不耗真实时间），加序号兜底。
  int _seq = 0;

  /// vision 工具拿到的 JPEG base64（可能是 data URL）。写盘成功返回路径，
  /// 失败回 null——调用方据此不更新 lastScreenshotPath。
  Future<String?> saveFromBase64(String base64Image) async {
    try {
      var b64 = base64Image.trim();
      final comma = b64.indexOf(',');
      if (b64.startsWith('data:') && comma > 0) b64 = b64.substring(comma + 1);
      b64 = b64.replaceAll(RegExp(r'\s'), '');
      if (b64.isEmpty) return null;
      final raw = base64Decode(b64);
      if (raw.isEmpty) return null;
      final png = await _shrink(raw, maxWidth);
      if (png == null || png.isEmpty) return null;
      if (!dir.existsSync()) dir.createSync(recursive: true);
      // 用平台分隔符拼：返回值要进 task_state.json 被消费方当字面路径用，
      // 而同步清理按字符串比对路径——混着写 '/' 和 '\' 在 Windows 上
      // 永远对不上（实测把「保留最新 5 张」搞成删错文件）。
      final sep = Platform.pathSeparator;
      final name = 'shot-${DateTime.now().millisecondsSinceEpoch}-${_seq++}.png';
      final file = File('${dir.path}$sep$name');
      await file.writeAsBytes(png, flush: true);
      _prune();
      return file.path;
    } catch (_) {
      return null;
    }
  }

  /// 只保留最新 [keep] 张。按文件名排——名字里嵌了毫秒与自增序号，
  /// 比文件 mtime 可靠（Windows 的 mtime 有计时器粒度，快写快删时会
  /// 乱序，实测会把最新的当成最旧的删掉）。
  void _prune() {
    try {
      if (!dir.existsSync()) return;
      final pngs = dir
          .listSync()
          .whereType<File>()
          .where((f) => f.path.toLowerCase().endsWith('.png'))
          .toList()
        ..sort((a, b) => b.path.compareTo(a.path));
      for (final old in pngs.skip(keep)) {
        try {
          old.deleteSync();
        } catch (_) {
          // 删不掉的留个尸体也无妨：下一轮截图还会再试。
        }
      }
    } catch (_) {
      // 清理失败不升级：这是增益产物，不是任务数据。
    }
  }
}

/// 解码原图并缩到 [maxWidth] 宽（高按比例），编码回 PNG。dart:ui 的软解码
/// 不依赖任何第三方包。任何一步失败回 null。
Future<Uint8List?> shrinkToPng(Uint8List raw, int maxWidth) async {
  ui.Codec? codec;
  ui.Image? image;
  try {
    codec = await ui.instantiateImageCodec(raw, targetWidth: maxWidth);
    final frame = await codec.getNextFrame();
    image = frame.image;
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return data?.buffer.asUint8List();
  } catch (_) {
    return null;
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}
