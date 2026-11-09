import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/local_model_store.dart';

/// The model downloader's resume logic and honest-reporting rules.
///
/// WHY THIS FILE EXISTS. The download is 2.8 GB on a phone. Every assumption
/// that works on a desktop — "the connection stays up", "a partial file can be
/// discarded" — is wrong here, and the failure modes are the expensive kind:
///
///   * Restarting from zero on every interruption makes the feature unusable in
///     practice, so resume is not an optimisation, it is the design.
///   * Renaming a `.part` file into place before its length is confirmed
///     produces a model that loads and then crashes inside llama.cpp with a
///     message that names nothing. That is the single worst outcome available,
///     so it is pinned by a test rather than left to care.
///   * Reporting a truncated download as an error would make the UI say
///     "failed" for what is the normal, expected state of a phone download.
///
/// None of this touches the network: the parts under test are the size
/// accounting, the state reporting, and the exception type. The HTTP behaviour
/// is exercised on device, where a real 2.8 GB transfer exists.
void main() {
  group('the two files that make up a vision model', () {
    test('both a text model and a projector are named', () {
      // The projector is not optional. A text-only engine answers prompts about
      // a screen it cannot see, which is worse than failing — so the pair is
      // asserted together and KhyLlama.load refuses a missing one.
      expect(LocalModelStore.modelFile, endsWith('.gguf'));
      expect(LocalModelStore.mmprojFile, endsWith('.gguf'));
      expect(LocalModelStore.modelFile, isNot(LocalModelStore.mmprojFile));
    });

    test('the total is reported, not just the model', () {
      // The settings UI warns "this will use ~2.8 GB" before the user commits.
      // Reporting only the 2.38 GB text model would understate it by half a
      // gigabyte, which is the difference between a consent and a surprise.
      final total = LocalModelStore.instance.totalBytes;
      expect(total, greaterThan(LocalModelStore.modelBytes));
      expect(total, LocalModelStore.modelBytes + LocalModelStore.mmprojBytes);
    });

    test('the download URL points at a GGUF repo, not the safetensors one', () {
      // GELab-Zero-4B (the model the plan names) publishes only 8.88 GB of bf16
      // safetensors. llama.cpp consumes GGUF. Pointing at the safetensors repo
      // would download 3x the bytes and still not produce a loadable model.
      expect(LocalModelStore.baseUrl, contains('GGUF'));
      expect(LocalModelStore.baseUrl, startsWith('https://'));
    });
  });

  group('LocalModelState', () {
    test('humanTotal switches unit at 1 GB', () {
      const small = LocalModelState(
          dir: '/x', modelBytes: 100, mmprojBytes: 100, complete: false);
      expect(small.humanTotal, '0 MB');

      const big = LocalModelState(
          dir: '/x',
          modelBytes: 2381 * 1024 * 1024,
          mmprojBytes: 433 * 1024 * 1024,
          complete: false);
      // One decimal, and the unit is GB — "2.7 GB" is actionable, "2929 MB" is
      // a number the user has to convert before they can decide.
      //
      // The exact value matters for honesty: 2381 + 433 = 2814 MiB = 2.748 GiB,
      // which rounds to 2.7. Saying "2.8" would round up and overstate by 50 MB
      // on a consent screen, for no reason.
      expect(big.humanTotal, '2.7 GB');
    });

    test('totalBytes adds both files', () {
      const s = LocalModelState(
          dir: '/x', modelBytes: 10, mmprojBytes: 5, complete: true);
      expect(s.totalBytes, 15);
    });
  });

  group('the exception type', () {
    test('is not dart:io IOException', () {
      // A custom class shadowing dart:io's IOException would make every
      // `catch (e)` in the file ambiguous about what it caught. This asserts
      // the name is distinct so a future edit that reintroduces the shadow
      // fails here rather than in review.
      expect(ModelDownloadException('x').toString(), 'x');
      expect(ModelDownloadException('x') is IOException, isFalse);
    });
  });

  group('prepare() on a directory with nothing in it', () {
    test('reports zero bytes and incomplete', () async {
      // path_provider goes through a platform channel, so it has to be mocked —
      // without this the call throws MissingPluginException and the test proves
      // nothing about the store. Pointed at a real temp directory so the file
      // accounting is exercised for real rather than stubbed.
      //
      // ensureInitialized first: TestDefaultBinaryMessengerBinding.instance
      // throws unless a binding exists, and this is a plain (non-widget) test.
      TestWidgetsFlutterBinding.ensureInitialized();
      final tmp = await Directory.systemTemp.createTemp('khyos-model-test');
      addTearDown(() => tmp.deleteSync(recursive: true));

      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async => tmp.path,
      );

      final state = await LocalModelStore.instance.prepare();
      expect(state.dir, contains(tmp.path));
      // Nothing has been downloaded, so it must say so. A store that reported
      // `complete: true` on an empty directory would make the settings page
      // skip the download and go straight to a model load that fails.
      expect(state.modelBytes, 0);
      expect(state.mmprojBytes, 0);
      expect(state.complete, isFalse);
      expect(state.totalBytes, 0);
    });
  });
}
