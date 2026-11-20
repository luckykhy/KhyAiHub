import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider/path_provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('probe: path_provider mock 在普通 test() 里', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (call) async {
        // ignore: avoid_print
        print('MOCK HIT: ${call.method}');
        if (call.method == 'getApplicationDocumentsPath') return 'C:/tmp-fake';
        return null;
      },
    );
    try {
      final dir = await getApplicationDocumentsDirectory();
      // ignore: avoid_print
      print('DOCS: ${dir.path}');
    } catch (e) {
      // ignore: avoid_print
      print('DOCS FAIL: $e');
    }
  });
}
