import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/khy_brand_mark.dart';
import 'package:khy_os_client/ui/widgets/khy_pet.dart';
import 'package:khy_os_client/ui/widgets/khy_pet_fortune.dart';

/// In-memory [PetStorage] so the tests never touch the platform keystore.
class _MemoryPetStorage implements PetStorage {
  final Map<String, String> values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

/// Loads the shipped data file.
///
/// The production path is `rootBundle`; the file fallback keeps the test
/// independent of the asset bundle being wired into the test runner.
Future<PetFortune> _loadFortune() async {
  try {
    return PetFortune.parse(await rootBundle.loadString(kPetFortuneAssetPath));
  } catch (_) {
    return PetFortune.parse(
      await File(kPetFortuneAssetPath).readAsString(),
    );
  }
}

void main() {
  group('fnv1a32', () {
    test('matches the published FNV-1a 32 test vectors', () {
      expect(fnv1a32(''), 0x811c9dc5);
      expect(fnv1a32('a'), 0xe40c292c);
      expect(fnv1a32('b'), 0xe70c2de5);
      expect(fnv1a32('foobar'), 0xbf9cf968);
    });

    test('hashes the UTF-8 bytes, not the code units', () {
      // '澪' is U+6F8E -> E6 BE 8E in UTF-8.
      expect(fnv1a32('澪'), 0xfc127c5d);
      expect(fnv1a32('凯'), 0x304d01be);
    });

    test('stays inside 32 bits for long inputs', () {
      final hash = fnv1a32('a' * 4096);
      expect(hash, greaterThanOrEqualTo(0));
      expect(hash, lessThanOrEqualTo(0xFFFFFFFF));
    });
  });

  group('dailyFortune', () {
    // Reference values produced by the shared algorithm
    // (fnv1a32 with Math.imul, so the 32-bit multiply is exact).
    test('matches the cross-end reference for 2026-11-03 / female', () async {
      final fortune = dailyFortune(
        await _loadFortune(),
        now: DateTime(2026, 11, 3),
        characterId: 'female',
      );
      expect(fortune.seed, 3218103208);
      expect(fortune.level.id, 'steady');
      expect(fortune.level.label, '平稳');
      expect(fortune.tip, '适合学一点新东西，一次只学一个点。');
      expect(fortune.color?.name, '米白');
    });

    test('matches the cross-end reference for 2026-11-03 / male', () async {
      final fortune = dailyFortune(
        await _loadFortune(),
        now: DateTime(2026, 11, 3),
        characterId: 'male',
      );
      expect(fortune.seed, 1865385925);
      expect(fortune.level.id, 'small');
      expect(fortune.level.label, '小吉');
      expect(fortune.tip, '适合在动手前先问一句「为什么现在要做」。');
      expect(fortune.color?.name, '好运红');
    });

    test('the same day and character always draw the same fortune', () async {
      final data = await _loadFortune();
      final first = dailyFortune(
        data,
        now: DateTime(2026, 1, 1),
        characterId: 'female',
      );
      final second = dailyFortune(
        data,
        now: DateTime(2026, 1, 1, 23, 59),
        characterId: 'female',
      );
      expect(second.seed, first.seed);
      expect(second.level.id, first.level.id);
      expect(second.tip, first.tip);
      expect(second.color?.name, first.color?.name);
    });

    test('a different day or a different character draws a different seed',
        () async {
      final data = await _loadFortune();
      final female = dailyFortune(
        data,
        now: DateTime(2026, 1, 1),
        characterId: 'female',
      );
      final male = dailyFortune(
        data,
        now: DateTime(2026, 1, 1),
        characterId: 'male',
      );
      final nextDay = dailyFortune(
        data,
        now: DateTime(2026, 1, 2),
        characterId: 'female',
      );
      expect(male.seed, isNot(female.seed));
      expect(nextDay.seed, isNot(female.seed));
    });

    test('the date key is the local calendar day', () {
      expect(dateKeyOf(DateTime(2026, 11, 3)), '2026-11-03');
      expect(dateKeyOf(DateTime(2026, 1, 9)), '2026-01-09');
    });

    test('the level is a weighted pick over the levels in order', () async {
      final data = await _loadFortune();
      final total = data.levels.fold<int>(0, (sum, l) => sum + l.weight);
      expect(total, 10);
      for (var day = 1; day <= 28; day++) {
        final fortune = dailyFortune(
          data,
          now: DateTime(2026, 3, day),
          characterId: 'female',
        );
        expect(fortune.seed % total, lessThan(total));
        expect(
          data.levels.map((l) => l.id),
          contains(fortune.level.id),
        );
      }
    });
  });

  group('PetFortune.parse', () {
    test('reads the shipped data file', () async {
      final data = await _loadFortune();
      expect(data.brandName, 'Khy OS');
      expect(data.levels.length, 4);
      expect(data.tips.length, 12);
      expect(data.luckyColors.length, 5);
      expect(data.characters.keys, containsAll(<String>['female', 'male']));
      expect(data.characters['female']?.name, '澪');
      expect(data.characters['male']?.name, '凯');
      expect(data.characters['female']?.idle, isNotEmpty);
      expect(data.characters['male']?.lucky, isNotEmpty);
    });

    test('the asset path points at a real file', () {
      expect(File(kPetFortuneAssetPath).existsSync(), isTrue);
    });

    test('a broken payload degrades instead of throwing', () {
      final data = PetFortune.parse('{"levels": "not-a-list"}');
      expect(data.levels, isEmpty);
      expect(data.tips, isEmpty);
      expect(data.characters, isEmpty);
    });
  });

  group('KhyPetOverlay', () {
    late _MemoryPetStorage storage;

    setUp(() {
      storage = _MemoryPetStorage();
    });

    Widget harness(
      Widget child, {
      bool disableAnimations = false,
    }) {
      Widget body = Scaffold(
        body: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            const SizedBox.expand(),
            Positioned(
              left: KhyPetAnchors.defaultLeft,
              bottom: KhyPetAnchors.defaultBottom,
              child: child,
            ),
          ],
        ),
      );
      if (disableAnimations) {
        // Inside the MaterialApp: the app inserts its own MediaQuery, so the
        // flag has to sit between the app and the screen to be seen.
        body = MediaQuery(
          data: const MediaQueryData(
            size: Size(800, 600),
            disableAnimations: true,
          ),
          child: body,
        );
      }
      return MaterialApp(
        theme: AppTheme.dark(),
        home: body,
      );
    }

    Widget pet({math.Random? random}) {
      return KhyPetOverlay(
        storage: storage,
        fortuneLoader: _loadFortune,
        random: random ?? math.Random(7),
      );
    }

    Future<void> pumpPet(
      WidgetTester tester, {
      bool disableAnimations = false,
    }) async {
      await tester.pumpWidget(
        harness(pet(), disableAnimations: disableAnimations),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('renders the real trademark and the wordmark', (tester) async {
      await pumpPet(tester);

      expect(find.byType(KhyPetOverlay), findsOneWidget);
      // The brand mark is the shipped PNG, not a drawn approximation.
      expect(find.byType(KhyBrandMark), findsWidgets);
      expect(find.text('Khy OS'), findsOneWidget);
      expect(find.byKey(KhyPetWidgetKeys.card), findsOneWidget);
      expect(find.byKey(KhyPetWidgetKeys.image), findsOneWidget);
    });

    testWidgets('tapping the character shows an idle line', (tester) async {
      await pumpPet(tester);

      expect(find.byKey(KhyPetWidgetKeys.bubble), findsNothing);
      await tester.tap(find.byKey(KhyPetWidgetKeys.image));
      await tester.pumpAndSettle();

      expect(find.byKey(KhyPetWidgetKeys.bubble), findsOneWidget);
      final data = await _loadFortune();
      final lines = data.characters['female']!.idle;
      expect(
        lines.any((line) => find.text(line).evaluate().isNotEmpty),
        isTrue,
      );
    });

    testWidgets('the bubble folds away after 2.5 seconds', (tester) async {
      await pumpPet(tester);

      await tester.tap(find.byKey(KhyPetWidgetKeys.image));
      await tester.pumpAndSettle();
      expect(find.byKey(KhyPetWidgetKeys.bubble), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 2600));
      await tester.pumpAndSettle();
      expect(find.byKey(KhyPetWidgetKeys.bubble), findsNothing);
    });

    testWidgets('two greetings never repeat the same line', (tester) async {
      await pumpPet(tester, disableAnimations: true);
      final data = await _loadFortune();
      final lines = data.characters['female']!.idle;

      final spoken = <String>[];
      for (var i = 0; i < 6; i++) {
        await tester.tap(find.byKey(KhyPetWidgetKeys.image));
        await tester.pumpAndSettle();
        for (final line in lines) {
          if (find.text(line).evaluate().isNotEmpty) spoken.add(line);
        }
      }
      expect(spoken.length, 6);
      // No two neighbours may repeat.
      for (var i = 1; i < spoken.length; i++) {
        expect(spoken[i], isNot(spoken[i - 1]));
      }
    });

    testWidgets('the omamori button draws the fortune of the day',
        (tester) async {
      await pumpPet(tester);

      final data = await _loadFortune();
      final fortune = dailyFortune(
        data,
        now: DateTime.now(),
        characterId: 'female',
      );

      await tester.tap(find.byKey(KhyPetWidgetKeys.drawButton));
      await tester.pumpAndSettle();

      expect(find.text('「${fortune.level.label}」签'), findsOneWidget);
      expect(find.text(fortune.level.hint), findsOneWidget);
      expect(find.text('幸运色：${fortune.color!.name}'), findsOneWidget);
      expect(find.text(fortune.tip), findsOneWidget);
    });

    testWidgets('the same day draws the same fortune twice', (tester) async {
      await pumpPet(tester);

      final data = await _loadFortune();
      final fortune = dailyFortune(
        data,
        now: DateTime.now(),
        characterId: 'female',
      );

      await tester.tap(find.byKey(KhyPetWidgetKeys.drawButton));
      await tester.pumpAndSettle();
      expect(find.text('「${fortune.level.label}」签'), findsOneWidget);

      await tester.tap(find.byKey(KhyPetWidgetKeys.drawButton));
      await tester.pumpAndSettle();
      expect(find.text('「${fortune.level.label}」签'), findsOneWidget);
    });

    testWidgets('the pose switches to the lucky art and back', (tester) async {
      await pumpPet(tester);

      List<String> assetNames() {
        return tester
            .widgetList<Image>(
              find.descendant(
                of: find.byKey(KhyPetWidgetKeys.image),
                matching: find.byType(Image),
              ),
            )
            .map((image) => (image.image as AssetImage).assetName)
            .toList();
      }

      expect(
        assetNames(),
        everyElement('assets/brand/pet/khy-pet-female-idle.png'),
      );

      await tester.tap(find.byKey(KhyPetWidgetKeys.drawButton));
      await tester.pumpAndSettle();
      expect(
        assetNames(),
        contains('assets/brand/pet/khy-pet-female-lucky.png'),
      );

      await tester.pump(const Duration(milliseconds: 2600));
      await tester.pumpAndSettle();
      expect(
        assetNames(),
        everyElement('assets/brand/pet/khy-pet-female-idle.png'),
      );
    });

    testWidgets('disableAnimations switches the pose without a transition',
        (tester) async {
      await pumpPet(tester, disableAnimations: true);

      await tester.tap(find.byKey(KhyPetWidgetKeys.drawButton));
      // One frame is enough: there is no transition to wait for.
      await tester.pump();

      final images = tester
          .widgetList<Image>(
            find.descendant(
              of: find.byKey(KhyPetWidgetKeys.image),
              matching: find.byType(Image),
            ),
          )
          .map((image) => (image.image as AssetImage).assetName)
          .toList();
      expect(images, contains('assets/brand/pet/khy-pet-female-lucky.png'));
    });

    testWidgets('the character can be switched and is remembered',
        (tester) async {
      await pumpPet(tester);

      expect(find.text('澪'), findsOneWidget);
      await tester.tap(find.byKey(KhyPetWidgetKeys.switchButton));
      await tester.pumpAndSettle();

      expect(find.text('凯'), findsOneWidget);
      await tester.pump();
      expect(storage.values[KhyPetKeys.character], 'male');

      // The new character's lines replace the old ones.
      final data = await _loadFortune();
      expect(
        data.characters['male']!.idle.any(
          (line) => find.text(line).evaluate().isNotEmpty,
        ),
        isTrue,
      );
    });

    testWidgets('collapsing leaves a brand badge that brings the pet back',
        (tester) async {
      await pumpPet(tester);

      await tester.tap(find.byKey(KhyPetWidgetKeys.collapseButton));
      await tester.pumpAndSettle();

      expect(find.byKey(KhyPetWidgetKeys.card), findsNothing);
      expect(find.byKey(KhyPetWidgetKeys.badge), findsOneWidget);
      await tester.pump();
      expect(storage.values[KhyPetKeys.hidden], '1');

      await tester.tap(find.byKey(KhyPetWidgetKeys.badge));
      await tester.pumpAndSettle();

      expect(find.byKey(KhyPetWidgetKeys.card), findsOneWidget);
      expect(find.byKey(KhyPetWidgetKeys.badge), findsNothing);
      await tester.pump();
      expect(storage.values[KhyPetKeys.hidden], '0');
    });

    testWidgets('a collapsed pet comes back collapsed', (tester) async {
      storage.values[KhyPetKeys.hidden] = '1';
      await pumpPet(tester);

      expect(find.byKey(KhyPetWidgetKeys.badge), findsOneWidget);
      expect(find.byKey(KhyPetWidgetKeys.card), findsNothing);
    });

    testWidgets('the stored character comes back on the next launch',
        (tester) async {
      storage.values[KhyPetKeys.character] = 'male';
      await pumpPet(tester);

      expect(find.text('凯'), findsOneWidget);
    });

    testWidgets('dragging the pet stores the new position', (tester) async {
      await pumpPet(tester);

      await tester.drag(
        find.byKey(KhyPetWidgetKeys.image),
        const Offset(60, -30),
      );
      await tester.pumpAndSettle();
      // The write is asynchronous; one more frame flushes the microtask.
      await tester.pump();

      final stored = storage.values[KhyPetKeys.position];
      expect(stored, isNotNull);
      final position = jsonDecode(stored!) as Map<String, dynamic>;
      expect(position['left'], KhyPetAnchors.defaultLeft + 60);
      expect(position['bottom'], KhyPetAnchors.defaultBottom + 30);
    });

    testWidgets('a stored position is restored on the next launch',
        (tester) async {
      storage.values[KhyPetKeys.position] = '{"left": 100.0, "bottom": 200.0}';
      await pumpPet(tester);

      final card = find.byKey(KhyPetWidgetKeys.card);
      expect(tester.getRect(card).left, 100.0);
    });

    testWidgets('a wobble below the threshold greets instead of dragging',
        (tester) async {
      await pumpPet(tester);

      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(KhyPetWidgetKeys.image)),
      );
      await gesture.moveBy(const Offset(2, 0));
      await gesture.up();
      await tester.pumpAndSettle();

      expect(find.byKey(KhyPetWidgetKeys.bubble), findsOneWidget);
      expect(storage.values[KhyPetKeys.position], isNull);
    });
  });
}
