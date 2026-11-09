import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/screen_metrics.dart';

/// ScreenMetrics — the one reader of two vocabularies.
///
/// WHY THIS FILE EXISTS AT ALL. Before it, one screenshot path reported no
/// geometry and the other reported `orig_w`/`w`, so every caller that needed
/// "which pixel is this" either guessed or special-cased the path it was on.
/// The guesses were silent: a coordinate converted with a ratio that was
/// merely close lands near the target, and there is nothing in any log to say
/// the conversion was wrong.
///
/// These tests pin three things that guessing got wrong:
///   1. the two vocabularies must produce the SAME numbers for the same
///      screen — otherwise "which path am I on" changes the answer;
///   2. an unusable state must say WHICH unusable it is, because each one has
///      a different fix;
///   3. the rotation guard must actually fire, because the alternative is a
///      silent mis-tap.
void main() {
  group('the projection vocabulary', () {
    // A 1080x2400 screen, projection capped to 720 on the long side.
    const projection = <String, dynamic>{
      'screen_w': 1080,
      'screen_h': 2400,
      'disp_w': 1080,
      'disp_h': 2400,
      'img_w': 720,
      'img_h': 1600,
      'rotation': 0,
      'setup_rotation': 0,
      'stale': false,
      'density_dpi': 440,
      'source': 'projection',
    };

    test('reads every field', () {
      final m = ScreenMetrics.fromMap(projection);
      expect(m.imgW, 720);
      expect(m.imgH, 1600);
      expect(m.gestureW, 1080);
      expect(m.gestureH, 2400);
      expect(m.usable, true);
      expect(m.whyUnusable, isNull);
    });

    test('converts image pixels to gesture pixels', () {
      final m = ScreenMetrics.fromMap(projection);
      // 720 → 1080 is a 1.5x scale; 1600 → 2400 likewise.
      expect(m.imgToPixelsX(360), closeTo(540, 0.001));
      expect(m.imgToPixelsY(800), closeTo(1200, 0.001));
    });

    test('converts normalised 0-1000 to gesture pixels', () {
      final m = ScreenMetrics.fromMap(projection);
      expect(m.normToPixelsX(500), closeTo(540, 0.001));
      expect(m.normToPixelsY(250), closeTo(600, 0.001));
    });
  });

  group('the accessibility vocabulary', () {
    // KhyUi.shot: orig_* is the full display, w/h is the scaled JPEG.
    const a11y = <String, dynamic>{
      'orig_w': 1080,
      'orig_h': 2400,
      'w': 540,
      'h': 1200,
      'scale': 0.5,
    };

    test('maps orig_w to the display and w to the image', () {
      final m = ScreenMetrics.fromMap(a11y);
      expect(m.gestureW, 1080, reason: 'orig_w 是整屏，不是截图尺寸');
      expect(m.gestureH, 2400);
      expect(m.imgW, 540);
      expect(m.imgH, 1200);
      expect(m.usable, true);
    });

    test('the two vocabularies agree on the same screen', () {
      // This is the whole point of the class. Same physical screen, same
      // effective scale, different key names — the pixel answers must match
      // to within the rounding the two paths do.
      final p = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
        'rotation': 0, 'setup_rotation': 0, 'stale': false,
        'source': 'projection',
      });
      final a = ScreenMetrics.fromMap(a11y);
      expect(a.imgToPixelsX(270), closeTo(p.imgToPixelsX(270), 0.001));
      expect(a.normToPixelsY(500), closeTo(p.normToPixelsY(500), 0.001));
    });
  });

  group('the MethodChannel envelope', () {
    test('unwraps {success, metrics}', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'success': true,
        'metrics': <String, dynamic>{
          'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
          'rotation': 0, 'setup_rotation': 0, 'stale': false,
          'source': 'projection',
        },
      });
      expect(m.usable, true);
      expect(m.imgW, 540);
    });

    test('a flat map with no envelope also works', () {
      // KhyUi.shot hands back a flat object; the caller should not have to
      // know which wrapper it arrived in.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
      });
      expect(m.usable, true);
    });
  });

  group('malformed input must not throw', () {
    test('wrong types become unusable, not a crash', () {
      // This data crossed a platform channel. A TypeError here would surface
      // as a red screen in the middle of a tool call that asked a perfectly
      // reasonable question.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 'not-a-number',
        'img_w': <int>[1, 2],
        'stale': 'maybe',
        'source': 42,
      });
      expect(m.usable, false);
      expect(m.whyUnusable, isNotNull);
    });

    test('empty map is unusable and says why', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{});
      expect(m.usable, false);
      expect(m.whyUnusable, contains('截图'));
    });

    test('nulls are tolerated', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': null, 'disp_h': null, 'img_w': null, 'img_h': null,
        'rotation': null, 'setup_rotation': null, 'stale': null,
      });
      expect(m.usable, false);
    });
  });

  group('each unusable state names its own fix', () {
    test('no projection yet — the fix is to start screen capture', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'source': 'none', 'img_w': 0, 'img_h': 0, 'stale': true,
      });
      expect(m.whyUnusable, contains('屏幕捕获'));
    });

    test('projection up but no frame yet — the fix is to capture', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'source': 'projection', 'img_w': 0, 'img_h': 0, 'stale': false,
      });
      expect(m.whyUnusable, contains('截图'));
      expect(m.whyUnusable, isNot(contains('屏幕捕获')));
    });

    test('rotated since setup — the fix is to rotate back or re-capture', () {
      // The dangerous one. Converting anyway would tap the wrong place with
      // nothing in any log to explain it.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 2400, 'disp_h': 1080, 'img_w': 1600, 'img_h': 720,
        'rotation': 1, 'setup_rotation': 0, 'stale': true,
        'source': 'projection',
      });
      expect(m.usable, false);
      expect(m.whyUnusable, contains('旋转'));
    });
  });

  group('the rotation guard', () {
    test('stale is derived when the caller does not pass it', () {
      // KhyUi.shot does not report rotation at all. Deriving it means the
      // accessibility path gets the guard too, without that path having to
      // learn about it.
      final rotated = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
        'rotation': 1, 'setup_rotation': 0,
      });
      expect(rotated.stale, true);
      expect(rotated.usable, false);
    });

    test('matching rotation is not stale', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
        'rotation': 3, 'setup_rotation': 3,
      });
      expect(m.stale, false);
      expect(m.usable, true);
    });

    test('an explicit stale=false wins over a rotation mismatch', () {
      // The projection path knows something the derived rule does not — it
      // re-reads the rotation itself. When it says not stale, believe it.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
        'rotation': 1, 'setup_rotation': 0, 'stale': false,
      });
      expect(m.stale, false);
      expect(m.usable, true);
    });
  });

  group('clamping', () {
    test('a coordinate at the very edge is nudged inward', () {
      // A gesture at exactly 0 is dropped by the input system on some
      // devices. The model answering "top edge" as 0 is not wrong; sending 0
      // is.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
        'rotation': 0, 'setup_rotation': 0, 'stale': false,
      });
      final top = m.clampPixels(0, 0);
      expect(top.x, 1);
      expect(top.y, 1);
      final bottom = m.clampPixels(1080, 2400);
      expect(bottom.x, 1079);
      expect(bottom.y, 2399);
    });

    test('NaN and infinity fall back to the centre rather than propagating', () {
      // A model occasionally returns a non-finite coordinate. Tapping the
      // centre of the screen is a better outcome than an exception, and far
      // better than NaN reaching the platform channel, where it becomes 0 or
      // a crash depending on the build.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1200,
        'rotation': 0, 'setup_rotation': 0, 'stale': false,
      });
      expect(m.clampPixels(double.nan, double.infinity).x, 540);
      expect(m.clampPixels(double.nan, double.infinity).y, 1200);
    });
  });

  group('display metrics', () {
    test('scaleX and scaleY are reported so a missed tap is diagnosable', () {
      // Without these, "the model pointed at the wrong place" and "we
      // converted with the wrong ratio" look identical from the outside.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 720, 'img_h': 1600,
        'rotation': 0, 'setup_rotation': 0, 'stale': false,
      });
      expect(m.scaleX, closeTo(1.5, 0.001));
      expect(m.scaleY, closeTo(1.5, 0.001));
    });

    test('a zero image size does not divide by zero', () {
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 0, 'img_h': 0,
      });
      expect(m.scaleX, 0);
      expect(m.scaleY, 0);
    });

    test('non-uniform scaling is handled per axis', () {
      // KhyUi.shot rounds the height when it scales the width, so the two
      // ratios genuinely differ. Treating them as one ratio is the classic
      // off-by-a-few-pixels bug.
      final m = ScreenMetrics.fromMap(const <String, dynamic>{
        'disp_w': 1080, 'disp_h': 2400, 'img_w': 540, 'img_h': 1199,
        'rotation': 0, 'setup_rotation': 0, 'stale': false,
      });
      expect(m.scaleX, closeTo(2.0, 0.001));
      expect(m.scaleY, closeTo(2400 / 1199, 0.001));
      expect(m.scaleX, isNot(closeTo(m.scaleY, 0.001)));
    });
  });

  group('none()', () {
    test('is unusable and carries its reason', () {
      final m = ScreenMetrics.none('因为测试');
      expect(m.usable, false);
      expect(m.whyUnusable, '因为测试');
    });
  });
}
