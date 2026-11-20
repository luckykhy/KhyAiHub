/// Amoo identity — the credential half of B3.
///
/// WHY THIS EXISTS. The bridge's bearer token is 32 hex characters sitting in
/// `/sdcard/bridge-amoobridge/token.txt` (`bridge/HttpBridge.java`). Anything
/// with storage permission — any installed app, `adb shell`, a PC on the same
/// cable — can read that file, so "holds the bridge token" was never a strong
/// claim about *who* is calling. B3 replaces it for the cloud direction:
/// pairing hands out a short-lived certificate bound to the peer that was
/// paired and to the backend it was paired against, and the private key never
/// leaves the app's private directory.
///
/// WHAT THIS FILE IS NOT. It is not the handshake (that is B1's adapter) and
/// not a key store. It owns the *shape* of the credential: how long it lives,
/// when it counts as expiring, which rejection code applies, and where the key
/// is allowed to live. Whoever performs the handshake writes the key through
/// [AmooIdentitySpec.privateKeyPath] — the location predicate and the location
/// itself have to be the same code path, or a predicate that correctly refuses
/// `/sdcard` can sit next to a writer that puts the key there anyway.
///
/// Rejection codes are the contract's (`contract.md` §2 K-23), not invented
/// here: `unknown_peer` for a peer that never shook hands, `credential_expired`
/// for a certificate that ran out. K-14 wants a third state — "renewal failed,
/// still good for X" — that the contract's three-state vocabulary has no word
/// for, so this file does not invent one; it only pins "expired means stop
/// accepting new work".
library;

import '../gateway/pairing.dart';

/// How a certificate stands at a given instant.
enum AmooCertState {
  /// Outside the renewal window: accept normally.
  valid,

  /// Inside the renewal window but not yet expired. A reminder, not a
  /// rejection — the contract's error table has no "expiring soon" code, so
  /// this state must never turn into one.
  expiringSoon,

  /// Past `expiresAt`. The only state that produces a rejection code.
  expired,
}

/// A short-lived credential minted from a pairing payload.
///
/// Bound to the peer it was issued for and to the backend that was paired, so
/// a certificate lifted off one connection cannot be replayed against another
/// peer or another backend.
class AmooCert {
  final String peerId;
  final String apiBaseUrl;
  final DateTime issuedAt;
  final DateTime expiresAt;

  const AmooCert({
    required this.peerId,
    required this.apiBaseUrl,
    required this.issuedAt,
    required this.expiresAt,
  });
}

/// The numbers, the predicates and the rejection codes.
///
/// Everything here is a pure function of its arguments: no clock is read
/// internally, because a credential check whose "now" is hidden inside the
/// module cannot be tested, and the device-side reading of B3-c has to be
/// reproducible from the same inputs.
abstract final class AmooIdentitySpec {
  /// 24h is criterion N11's number, not a convenient default.
  static const Duration certLifetime = Duration(hours: 24);

  /// How long before expiry the certificate counts as "renew me".
  ///
  /// Must sit strictly inside (0, certLifetime): 0 makes every certificate
  /// expiring from the moment it is issued, and >= certLifetime means the
  /// renewal window is never reached at all — either way "renews within 24h"
  /// becomes an empty promise. One hour leaves room for a renewal round trip
  /// plus a retry inside a 24h certificate.
  static const Duration renewLead = Duration(hours: 1);

  /// Certificate ran out and was not renewed (K-14).
  static const String errorCredentialExpired = 'credential_expired';

  /// `from`/`to` was never exchanged in a handshake (K-13).
  static const String errorUnknownPeer = 'unknown_peer';

  /// File name of the private key inside the app's private directory.
  static const String privateKeyFileName = 'amoo_key.pem';

  /// Identity shape, deliberately the same as the envelope's `session_id`
  /// (contract §3.1): both ends then need no second rule for what the other
  /// side's names look like.
  static final RegExp _identityPattern = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

  /// Android application ids always carry at least one dot. Used to tell an
  /// app-private `/data/...` path from the non-private directories that share
  /// the prefix (`/data/local/tmp` is shell-writable and is not anybody's
  /// private directory).
  static final RegExp _appIdPattern = RegExp(
    r'^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$',
  );

  static bool isValidIdentity(String identity) =>
      _identityPattern.hasMatch(identity);

  /// Where a certificate stands at [now].
  ///
  /// [issuedAt] is part of the shape check, not decoration: a certificate
  /// whose window is empty or inverted can never be valid, and reporting it as
  /// `expiringSoon` would hand the caller a renewal window that does not exist.
  static AmooCertState stateAt({
    required DateTime issuedAt,
    required DateTime expiresAt,
    required DateTime now,
  }) {
    if (!expiresAt.isAfter(issuedAt)) return AmooCertState.expired;
    if (!now.isBefore(expiresAt)) return AmooCertState.expired;
    return remainingUntilExpiry(expiresAt: expiresAt, now: now) > renewLead
        ? AmooCertState.valid
        : AmooCertState.expiringSoon;
  }

  /// The rejection code a state produces, or `null` when it produces none.
  ///
  /// Only expiry rejects. A certificate inside its renewal window is still a
  /// usable certificate; turning the reminder into a refusal would make the
  /// last [renewLead] of every certificate a rejection window.
  static String? stateErrorCode(AmooCertState state) =>
      state == AmooCertState.expired ? errorCredentialExpired : null;

  /// How long until expiry, for K-14's "credential expires in X" message.
  ///
  /// Clamped at zero: a negative duration pasted into that sentence reads
  /// "expires in -1 hours", which is worse than saying nothing.
  static Duration remainingUntilExpiry({
    required DateTime expiresAt,
    required DateTime now,
  }) {
    final left = expiresAt.difference(now);
    return left.isNegative ? Duration.zero : left;
  }

  /// Where the private key belongs: the app's private directory.
  ///
  /// Forward slashes on purpose. `package:path` joins with the host separator,
  /// which on a Windows test host would produce a path the predicate below
  /// then has to understand; the Android path is a `/` path everywhere.
  ///
  /// `files` is not a guess: the runtime writes through
  /// `DeviceIdentity.keyFile(ctx)` → `new File(ctx.getFilesDir(), KEY_FILE)`,
  /// and `Context.getFilesDir()` is `/data/user/0/<pkg>/files`. An earlier
  /// spelling said `app_flutter` (where `getApplicationDocumentsDirectory()`
  /// lands); both are private, but a spec that names a different directory than
  /// the code writes to is the kind of drift that makes a later auditor
  /// conclude the key is somewhere it is not.
  ///
  /// `0` is the primary user. [isPrivateLocation] accepts any uid, so a
  /// work-profile path is still recognised as private even though this app has
  /// no secondary-user story today.
  static String privateKeyPath(String appId) =>
      '/data/user/0/$appId/files/$privateKeyFileName';

  /// Whether [path] is inside an app's private directory.
  ///
  /// The predicate exists because the bridge token showed what the alternative
  /// costs: a key on shared storage is readable by every app with the storage
  /// permission, by `adb shell`, and by anything plugged into the same cable.
  static bool isPrivateLocation(String path) {
    final text = path.trim();
    // A relative path resolves against the process cwd, which is not a
    // guarantee about anything.
    if (!text.startsWith('/')) return false;
    final segments = text
        .split('/')
        .where((segment) => segment.isNotEmpty)
        .toList();
    if (segments.length < 3 || segments[0] != 'data') return false;
    if (segments[1] == 'user') {
      // /data/user/<uid>/<appId>/...
      return segments.length >= 4 &&
          int.tryParse(segments[2]) != null &&
          _appIdPattern.hasMatch(segments[3]);
    }
    if (segments[1] == 'data') {
      // /data/data/<appId>/... — the pre-multi-user spelling, still what
      // `run-as` and most shell one-liners print.
      return _appIdPattern.hasMatch(segments[2]);
    }
    return false;
  }
}

/// Mints and checks certificates.
abstract final class AmooIdentity {
  /// Exchange a pairing payload for a 24h certificate.
  ///
  /// Throws [ArgumentError] when [peerId] is not a valid identity: an identity
  /// that cannot be registered (K-13) must not be minted a certificate either,
  /// otherwise the failure surfaces at handshake time as a peer nobody can name.
  static AmooCert issue({
    required PairingPayload pairing,
    required String peerId,
    required DateTime issuedAt,
  }) {
    if (!AmooIdentitySpec.isValidIdentity(peerId)) {
      throw ArgumentError.value(
        peerId,
        'peerId',
        '对等体身份必须是 1-64 位 [A-Za-z0-9_-]，与信封 session_id 同一套形状',
      );
    }
    return AmooCert(
      peerId: peerId,
      apiBaseUrl: pairing.apiBaseUrl,
      issuedAt: issuedAt,
      expiresAt: issuedAt.add(AmooIdentitySpec.certLifetime),
    );
  }

  /// Whether a certificate may be accepted right now.
  ///
  /// Returns `null` when it may, otherwise the contract's rejection code.
  /// Registration is checked first: an unregistered peer is told `unknown_peer`
  /// and nothing else, because confirming that its certificate is otherwise
  /// well-formed is free information for a caller that has not shaken hands.
  static String? verify({
    required AmooCert cert,
    required AmooPeerRegistry peers,
    required DateTime now,
  }) {
    if (!peers.isRegistered(cert.peerId)) {
      return AmooIdentitySpec.errorUnknownPeer;
    }
    final state = AmooIdentitySpec.stateAt(
      issuedAt: cert.issuedAt,
      expiresAt: cert.expiresAt,
      now: now,
    );
    return AmooIdentitySpec.stateErrorCode(state);
  }
}

/// The peers this connection has shaken hands with (K-13).
///
/// One registry per handshake, never a process-wide singleton: a registry that
/// outlives its connection keeps accepting identities from a connection that
/// is gone, which is the same as not checking at all.
class AmooPeerRegistry {
  final Set<String> _peers = <String>{};

  /// Record [identity] as shaken hands with. Case-sensitive on purpose —
  /// `amoo-Cloud` folding onto `amoo-cloud` would let a peer pick a name the
  /// other end never agreed to.
  void register(String identity) {
    if (!AmooIdentitySpec.isValidIdentity(identity)) {
      throw ArgumentError.value(
        identity,
        'identity',
        '对等体身份必须是 1-64 位 [A-Za-z0-9_-]，与信封 session_id 同一套形状',
      );
    }
    _peers.add(identity);
  }

  bool isRegistered(String identity) => _peers.contains(identity);
}
