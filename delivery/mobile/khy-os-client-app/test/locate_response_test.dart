import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vision/locate_response.dart';

/// LocateResponseParser — the eight shapes a vision model actually answers in.
///
/// WHY SO MANY TESTS FOR ONE PARSER. The thing being defended against is not a
/// crash, it is a plausible-looking wrong answer. A parser that quietly
/// returns `found:false` for every prose response passes the obvious tests and
/// fails in exactly the situation that matters: the model did look, did find
/// the element, and wrote a sentence instead of JSON. Every test below is
/// either a real shape a model produced or a shape one plausibly would.
void main() {
  group('shape 1: the contract', () {
    test('a bare JSON object with 0-1000 coordinates', () {
      final r = LocateResponseParser.parse(
          '{"x":500,"y":300,"found":true,"what":"搜索框"}');
      expect(r.found, true);
      expect(r.normX, 500);
      expect(r.normY, 300);
      expect(r.what, '搜索框');
      expect(r.coordSpace, CoordSpace.norm1000);
      expect(r.clamped, false);
      expect(r.unparsable, false);
    });

    test('found defaults to true when coordinates are present', () {
      // A model that omits `found` but gives coordinates is not saying "not
      // found" — it answered the question and skipped a field.
      final r = LocateResponseParser.parse('{"x":10,"y":20}');
      expect(r.found, true);
      expect(r.hasCoordinates, true);
    });

    test('what is optional', () {
      final r = LocateResponseParser.parse('{"x":1,"y":2}');
      expect(r.what, isNull);
    });
  });

  group('shape 2: fenced JSON', () {
    test('a ```json fence is stripped', () {
      final r = LocateResponseParser.parse(
          '```json\n{"x":500,"y":500,"found":true}\n```');
      expect(r.hasCoordinates, true);
      expect(r.normX, 500);
    });

    test('a bare ``` fence is stripped too', () {
      final r = LocateResponseParser.parse('```\n{"x":100,"y":200}\n```');
      expect(r.normX, 100);
      expect(r.normY, 200);
    });

    test('an unclosed fence still parses', () {
      // Models truncate. A trailing fence is more common than a matching pair.
      final r = LocateResponseParser.parse('```json\n{"x":100,"y":200}');
      expect(r.normX, 100);
    });
  });

  group('shape 3: JSON embedded in prose', () {
    test('prose before the object is ignored', () {
      final r = LocateResponseParser.parse(
          '好的，我找到了。搜索框在这里：{"x":480,"y":210,"found":true,"what":"搜索框"}');
      expect(r.normX, 480);
      expect(r.what, '搜索框');
    });

    test('prose after the object is ignored', () {
      final r = LocateResponseParser.parse(
          '{"x":480,"y":210} —— 这就是你要的输入框。');
      expect(r.normX, 480);
    });

    test('an unbalanced brace in the prose does not defeat the scan', () {
      // This is why the scan tries every opening brace rather than the first
      // one: a stray `{` before the real object would otherwise end the search.
      final r = LocateResponseParser.parse(
          '这个界面用 { 花括号开头很奇怪，不过答案是 {"x":700,"y":900}');
      expect(r.normX, 700);
      expect(r.normY, 900);
    });

    test('a brace inside a JSON string is not counted as structure', () {
      // The regex version of this parser would fail here. Braces inside
      // strings are legal JSON and common in `what` values.
      final r = LocateResponseParser.parse(
          '{"x":300,"y":400,"what":"那个带 {花括号} 的按钮"}');
      expect(r.normX, 300);
      expect(r.what, '那个带 {花括号} 的按钮');
    });

    test('nested objects are handled', () {
      final r = LocateResponseParser.parse(
          '{"box":{"x":10,"y":20},"x":500,"y":600,"found":true}');
      expect(r.normX, 500);
      expect(r.normY, 600);
    });

    test('escaped quotes inside strings do not end the string early', () {
      final r = LocateResponseParser.parse(
          r'{"x":100,"y":200,"what":"带 \"引号\" 的标签"}');
      expect(r.normX, 100);
      expect(r.what, '带 "引号" 的标签');
    });
  });

  group('shape 4: prose with no JSON', () {
    test('unparsable is reported, not silently "not found"', () {
      // THE distinction this whole file exists for. "Model rambled" and
      // "model says the element is absent" need different follow-ups; if both
      // come back as found:false the caller starts reporting the first as the
      // second, and the user is told an element is missing when in fact the
      // model never looked.
      final r = LocateResponseParser.parse('我觉得屏幕中间好像有个按钮，大概在偏左的位置。');
      expect(r.found, false);
      expect(r.unparsable, true);
      expect(r.hasCoordinates, false);
      expect(r.reason, isNotNull);
      expect(r.reason, contains('按钮'));
    });

    test('an explicit not-found in JSON is NOT unparsable', () {
      final r = LocateResponseParser.parse(
          '{"found":false,"reason":"屏幕上没有搜索框"}');
      expect(r.found, false);
      expect(r.unparsable, false);
      expect(r.reason, '屏幕上没有搜索框');
    });

    test('an empty response is unparsable', () {
      final r = LocateResponseParser.parse('   ');
      expect(r.unparsable, true);
      expect(r.found, false);
    });

    test('coordinates plus found:false believes the flag', () {
      // The model is saying "roughly here, but I am not confident". Tapping an
      // unconfirmed coordinate is worse than not tapping.
      final r = LocateResponseParser.parse(
          '{"x":500,"y":500,"found":false,"reason":"不确定是不是"}');
      expect(r.found, false);
      expect(r.hasCoordinates, false);
      expect(r.reason, '不确定是不是');
    });

    test('JSON with no coordinates and no found flag is unparsable', () {
      final r = LocateResponseParser.parse('{"status":"ok"}');
      expect(r.unparsable, true);
      expect(r.found, false);
    });
  });

  group('shape 5: the 0-1 unit space', () {
    test('fractional coordinates are scaled by 1000', () {
      final r = LocateResponseParser.parse('{"x":0.5,"y":0.25,"found":true}');
      expect(r.coordSpace, CoordSpace.unit);
      expect(r.normX, closeTo(500, 0.001));
      expect(r.normY, closeTo(250, 0.001));
    });

    test('the space used is recorded so the guess is auditable', () {
      final r = LocateResponseParser.parse('{"x":0.5,"y":0.5}');
      expect(r.coordSpace, CoordSpace.unit);
      expect(r.toJson()['coord_space'], 'unit');
    });

    test('an integral 1 is treated as 0-1000, not as the far corner', () {
      // (1,1) in the unit space is the bottom-right corner; in 0-1000 it is
      // 0.1% from the top-left. Those are opposite ends of the screen, and the
      // prompt asked for 0-1000 — so the documented space wins on a tie.
      final r = LocateResponseParser.parse('{"x":1,"y":1}');
      expect(r.coordSpace, CoordSpace.norm1000);
      expect(r.normX, 1);
    });

    test('0,0 is unambiguous because both spaces agree on that pixel', () {
      final r = LocateResponseParser.parse('{"x":0,"y":0}');
      expect(r.hasCoordinates, true);
      expect(r.normX, 0);
    });
  });

  group('shape 6: the percent space', () {
    test('coordinates 2-100 are treated as percent', () {
      final r = LocateResponseParser.parse('{"x":50,"y":25,"found":true}');
      expect(r.coordSpace, CoordSpace.percent);
      expect(r.normX, closeTo(500, 0.001));
      expect(r.normY, closeTo(250, 0.001));
    });

    test('exactly 100 is percent, not 0-1000', () {
      // 100 in 0-1000 is 10% across; in percent it is the right edge. The
      // prompt asked for 0-1000, so a bare 100 is ambiguous — percent is the
      // reading that makes 100 mean something a model would actually intend.
      final r = LocateResponseParser.parse('{"x":100,"y":100}');
      expect(r.coordSpace, CoordSpace.percent);
      expect(r.normX, closeTo(1000, 0.001));
    });

    test('101 is 0-1000', () {
      final r = LocateResponseParser.parse('{"x":101,"y":50}');
      expect(r.coordSpace, CoordSpace.norm1000);
      expect(r.normX, 101);
      expect(r.normY, 50);
    });
  });

  group('shape 7: out of range', () {
    test('coordinates beyond 1000 are clamped and marked', () {
      // A silent clamp is the worst option: the tap lands somewhere plausible
      // and nothing says the model's answer was outside the space it was
      // asked for.
      final r = LocateResponseParser.parse('{"x":1500,"y":-200,"found":true}');
      expect(r.clamped, true);
      expect(r.normX, 1000);
      expect(r.normY, 0);
      expect(r.coordSpace, CoordSpace.norm1000);
    });

    test('clamping survives the unit conversion', () {
      // A negative unit coordinate. (1.5, 0.5) would NOT test this — 1.5 is
      // above 1, so it is read as percent, which is the documented heuristic.
      final r = LocateResponseParser.parse('{"x":-0.5,"y":0.5}');
      expect(r.coordSpace, CoordSpace.unit);
      expect(r.clamped, true);
      expect(r.normX, 0);
      expect(r.normY, closeTo(500, 0.001));
    });

    test('a fractional value above 1 is percent, not an overflowing unit', () {
      // Worth pinning because the two readings give answers 100x apart, and
      // "it looked fractional so it must be the 0-1 space" is the tempting
      // mistake. The threshold is on magnitude, not on whether a decimal
      // point is present.
      final r = LocateResponseParser.parse('{"x":1.5,"y":0.5}');
      expect(r.coordSpace, CoordSpace.percent);
      expect(r.normX, closeTo(15, 0.001));
      expect(r.clamped, false);
    });

    test('in-range coordinates are not marked clamped', () {
      final r = LocateResponseParser.parse('{"x":0,"y":1000}');
      expect(r.clamped, false);
    });
  });

  group('shape 8: image pixels', () {
    test('pixel coordinates are converted with the image size', () {
      final r = LocateResponseParser.parse(
          '{"x":540,"y":1200,"found":true}', imgW: 1080, imgH: 2400);
      // 540/1080 = 0.5 → 500 in the 0-1000 space. The 1200 is what marks this
      // as pixels at all — it cannot be a 0-1000 coordinate.
      expect(r.coordSpace, CoordSpace.pixels);
      expect(r.normX, closeTo(500, 0.001));
      expect(r.normY, closeTo(500, 0.001));
    });

    test('non-square images scale per axis', () {
      // A single ratio here would be the classic off-by-a-few-pixels bug.
      final r = LocateResponseParser.parse(
          '{"x":270,"y":1200,"found":true}', imgW: 1080, imgH: 1200);
      expect(r.normX, closeTo(250, 0.001));
      expect(r.normY, closeTo(1000, 0.001));
    });

    test('a value that does not fit the image is an overflow, not a pixel', () {
      // 1500 exceeds a 1080-wide image, so it cannot be a pixel coordinate of
      // that image. Treating it as 0-1000 and clamping is the honest read;
      // converting it as a pixel would need an image that does not exist.
      final r = LocateResponseParser.parse(
          '{"x":1500,"y":1200,"found":true}', imgW: 1080, imgH: 2400);
      expect(r.coordSpace, CoordSpace.norm1000);
      expect(r.clamped, true);
      expect(r.normX, 1000);
    });

    test('a negative coordinate is never a pixel coordinate', () {
      final r = LocateResponseParser.parse(
          '{"x":-50,"y":1200,"found":true}', imgW: 1080, imgH: 2400);
      expect(r.coordSpace, CoordSpace.norm1000);
      expect(r.clamped, true);
      expect(r.normX, 0);
    });

    test('an above-1000 answer with no image size is reported, not guessed', () {
      // 1200 with no image size: pixel answer or overflow? The two need
      // opposite handling and guessing is silent either way, so the parser
      // says what is missing instead of picking one.
      final r = LocateResponseParser.parse('{"x":540,"y":1200}', imgW: 0, imgH: 0);
      expect(r.found, true);
      expect(r.hasCoordinates, false);
      expect(r.coordSpace, CoordSpace.none);
      expect(r.reason, contains('图像尺寸'));
    });
  });

  group('alias keys', () {
    test('px/py are accepted', () {
      final r = LocateResponseParser.parse('{"px":400,"py":600}');
      expect(r.normX, 400);
      expect(r.normY, 600);
    });

    test('left/top are accepted', () {
      final r = LocateResponseParser.parse('{"left":400,"top":600}');
      expect(r.normX, 400);
      expect(r.normY, 600);
    });

    test('cx/cy are accepted', () {
      final r = LocateResponseParser.parse('{"cx":400,"cy":600}');
      expect(r.normX, 400);
      expect(r.normY, 600);
    });

    test('numeric strings are accepted', () {
      final r = LocateResponseParser.parse('{"x":"400","y":"600"}');
      expect(r.normX, 400);
      expect(r.normY, 600);
    });

    test('label is accepted for what', () {
      final r = LocateResponseParser.parse('{"x":1,"y":1,"label":"发送按钮"}');
      expect(r.what, '发送按钮');
    });

    test('x wins over px when both are present', () {
      // Preference order, so the documented key is never overridden by an
      // alias a model threw in as an afterthought. Both values are above 100
      // so neither trips the percent heuristic — an alias test that used
      // values from different spaces would be testing the classifier, not the
      // alias preference.
      final r = LocateResponseParser.parse(
          '{"x":150,"px":900,"y":160,"py":800}');
      expect(r.normX, 150);
      expect(r.normY, 160);
      expect(r.coordSpace, CoordSpace.norm1000);
    });
  });

  group('non-finite and hostile input', () {
    test('NaN coordinates do not produce a NaN answer', () {
      final r = LocateResponseParser.parse('{"x":NaN,"y":100}');
      expect(r.unparsable, true);
    });

    test('a very long prose response is truncated in reason, not dropped', () {
      final long = '屏幕上' * 500;
      final r = LocateResponseParser.parse(long);
      expect(r.unparsable, true);
      expect(r.reason!.length, lessThanOrEqualTo(401));
    });

    test('a JSON array is not an object, but the object inside it is found', () {
      // Not a special case — the brace scan simply walks past the `[`. The
      // result is the useful one: the coordinates are recovered.
      // Note (1,2) is read as the percent space (max 2, in 1..100), which is
      // the documented heuristic; both readings land in the same corner.
      final r = LocateResponseParser.parse('[{"x":1,"y":2}]');
      expect(r.hasCoordinates, true);
      expect(r.coordSpace, CoordSpace.percent);
      expect(r.normX, closeTo(10, 0.001));
      expect(r.normY, closeTo(20, 0.001));
    });

    test('deeply nested prose does not blow the stack', () {
      final sb = StringBuffer('{'.padRight(1));
      for (var i = 0; i < 200; i++) {
        sb.write('{"a":');
      }
      sb.write('1');
      for (var i = 0; i < 200; i++) {
        sb.write('}');
      }
      sb.write('}');
      final r = LocateResponseParser.parse(sb.toString());
      // Unbalanced at the top level; must not hang or throw.
      expect(r.found, anyOf(true, false));
    });
  });

  group('serialisation', () {
    test('toJson carries the space and the clamp flag', () {
      final r = LocateResponseParser.parse('{"x":0.5,"y":0.5,"found":true,"what":"按钮"}');
      final j = r.toJson();
      expect(j['found'], true);
      expect(j['x'], 500);
      expect(j['y'], 500);
      expect(j['coord_space'], 'unit');
      expect(j['clamped'], false);
      expect(j['what'], '按钮');
      expect(j.containsKey('unparsable_response'), false);
    });

    test('toJson marks an unparsable response', () {
      final r = LocateResponseParser.parse('完全不是 JSON');
      expect(r.toJson()['unparsable_response'], true);
      expect(r.toJson().containsKey('x'), false);
    });

    test('CoordSpace round-trips through its wire name', () {
      for (final s in CoordSpace.values) {
        expect(CoordSpace.fromWire(s.wire), s);
      }
      expect(CoordSpace.fromWire('nonsense'), CoordSpace.none);
      expect(CoordSpace.fromWire(null), CoordSpace.none);
    });
  });
}
