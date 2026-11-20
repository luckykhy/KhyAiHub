// Inbound sender admission, two-layer simplified port of ilinkPeerAllowlist.js.
//
// Why an explicit list at all (carried from ilinkPeerAllowlist.js:5-9): the
// binding QR code is FORWARDABLE — anyone who obtains it can open a chat with
// this bot, and anything they type used to flow straight into the agent with
// its tools. "Who may drive this instance" must therefore be an explicit
// list, not "whoever scanned".
//
// Two layers, allowed when either hits:
//   1. implicit: the account owner's own userId (from the login record) —
//      the owner should not need extra configuration to talk to their own bot;
//   2. explicit: the peer KV persisted in docs/ilink/peers.json.
//
// MVP drops the env layer and the warn-only observation mode on purpose:
// the Node side needed them for multi-account daemon ops, the App has a
// single account and a settings screen instead. Unlisted senders get one
// honest refusal line — fail-closed, a gate prefers false rejects.

import 'ilink_stores.dart';

/// Same refusal everywhere, so the wording does not fork across call sites.
const String kIlinkPeerDeniedReply =
    '这台机器的助手只对名单内的联系人开放。请机主把你的微信号加入名单后再试。';

class IlinkPeerAllowlist {
  IlinkPeerAllowlist(this._file);

  final IlinkJsonFileStore _file;

  Map<String, dynamic> _raw() => _file.readRoot();

  /// Is this sender allowed to drive the channel? [ownerUserId] comes from
  /// the loaded account (implicit layer, computed not persisted).
  bool isAllowed(String ownerUserId, String userId) {
    final uid = userId.trim();
    if (uid.isEmpty) return false;
    if (ownerUserId.isNotEmpty && ownerUserId == uid) return true;
    final peers = _raw()['peers'];
    if (peers is Map && peers.containsKey(uid)) return true;
    return false;
  }

  /// Add a peer. Returns false when the write failed (UI must say so, not
  /// pretend the peer is trusted now).
  bool add(String userId, {String source = 'app'}) {
    final uid = userId.trim();
    if (uid.isEmpty) return false;
    final all = _raw();
    final peers =
        all['peers'] is Map ? Map<String, dynamic>.from(all['peers'] as Map) : <String, dynamic>{};
    final existing = peers[uid];
    peers[uid] = <String, dynamic>{
      'addedAt': existing is Map && existing['addedAt'] is String
          ? existing['addedAt']
          : DateTime.now().toUtc().toIso8601String(),
      'source': source,
    };
    all['peers'] = peers;
    return _file.writeRoot(all);
  }

  bool remove(String userId) {
    final uid = userId.trim();
    if (uid.isEmpty) return false;
    final all = _raw();
    final peers =
        all['peers'] is Map ? Map<String, dynamic>.from(all['peers'] as Map) : <String, dynamic>{};
    peers.remove(uid);
    all['peers'] = peers;
    return _file.writeRoot(all);
  }

  List<String> list() {
    final peers = _raw()['peers'];
    if (peers is! Map) return const <String>[];
    return peers.keys.map((k) => k.toString()).toList()..sort();
  }
}
