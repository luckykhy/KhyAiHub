import 'dart:convert';

import 'conversation_db.dart';

/// Which line shape the exported JSONL uses.
///
/// Both stay readable by the platform-side collector
/// (runtime/node/backend/src/services/trainingDataService.js recordInteraction,
/// which reads messages/response/model/intent unconditionally); alpaca only
/// adds the instruction/input/output triple that unsloth/peft alpaca
/// templates consume. Dropping messages/response for alpaca would make every
/// line unreadable to the collector, so the triple is additive.
enum TrainingExportFormat { sharegpt, alpaca }

/// One user→assistant turn, ready to serialize.
class TrainingTurn {
  const TrainingTurn({
    required this.sessionId,
    required this.messages,
    required this.response,
    required this.model,
    required this.at,
  });

  final String sessionId;

  /// Conversation history up to and including the user message, as
  /// {role, content} pairs. The assistant reply is [response], not part of
  /// this list — same split as trainingDataService.js:72-73.
  final List<Map<String, dynamic>> messages;

  final String response;
  final String model;

  /// When the assistant reply landed.
  final DateTime at;
}

/// Splits conversations into training turns.
///
/// A turn is one user message plus the next non-empty assistant reply. System
/// and tool messages ride along in the history so a later turn still carries
/// its context; a trailing user message with no reply yields nothing — there
/// is no assistant text to train on, and emitting an empty response teaches
/// the model to answer with silence.
///
/// [model] is one value for the whole export: a local conversation does not
/// record which model answered each turn, and guessing per turn would put a
/// wrong model name in the training file. The wiring passes the configured
/// model; 'unknown' matches the platform default (trainingDataService.js:74).
List<TrainingTurn> collectTrainingTurns(
  List<Conversation> conversations, {
  String model = 'unknown',
}) {
  final turns = <TrainingTurn>[];
  for (final conversation in conversations) {
    final history = <Map<String, dynamic>>[];
    for (final msg in conversation.messages) {
      if (msg.content.isEmpty) continue;
      if (msg.role == 'user') {
        history.add({'role': 'user', 'content': msg.content});
        continue;
      }
      if (msg.role == 'assistant') {
        final lastIsUser =
            history.isNotEmpty && history.last['role'] == 'user';
        if (lastIsUser) {
          turns.add(TrainingTurn(
            sessionId: conversation.id,
            messages: history
                .map((m) => Map<String, dynamic>.of(m))
                .toList(growable: false),
            response: msg.content,
            model: model,
            at: msg.timestamp,
          ));
        }
      }
      history.add({'role': msg.role, 'content': msg.content});
    }
  }
  return turns;
}

/// Reads every local conversation and returns the JSONL text.
///
/// Walks listIds + load rather than listAll: listAll already loads each
/// conversation internally (conversation_db.dart:46-63), so pairing it with
/// another load would read every conversation out of secure storage twice.
///
/// The DB half needs FlutterSecureStorage, so it only runs on a device; the
/// pure half ([collectTrainingTurns] / [buildTrainingJsonl]) is what tests
/// cover.
Future<String> exportConversationsAsJsonl({
  TrainingExportFormat format = TrainingExportFormat.sharegpt,
  String model = 'unknown',
  String source = 'android',
}) async {
  final conversations = <Conversation>[];
  for (final id in await ConversationDB.listIds()) {
    final conversation = await ConversationDB.load(id);
    if (conversation != null) conversations.add(conversation);
  }
  final turns = collectTrainingTurns(conversations, model: model);
  return buildTrainingJsonl(turns, format: format, source: source);
}

/// Serializes turns as trainingDataService.js-compatible JSONL: one JSON
/// object per line, keys snake_case exactly like recordInteraction writes
/// them (trainingDataService.js:67-84), so the platform-side reader accepts
/// the file without a translation step.
String buildTrainingJsonl(
  List<TrainingTurn> turns, {
  TrainingExportFormat format = TrainingExportFormat.sharegpt,
  String source = 'android',
}) {
  final buffer = StringBuffer();
  for (final turn in turns) {
    buffer.writeln(jsonEncode(_record(turn, format: format, source: source)));
  }
  return buffer.toString();
}

Map<String, dynamic> _record(
  TrainingTurn turn, {
  required TrainingExportFormat format,
  required String source,
}) {
  final messages = turn.messages
      .map((m) => {
            'role': m['role'],
            'content': sanitizeTrainingText(m['content'] as String),
          })
      .toList();
  final response = sanitizeTrainingText(turn.response);
  final record = <String, dynamic>{
    'timestamp': turn.at.toIso8601String(),
    'version': '1.0',
    // The platform hashes a real user id here; the phone export has no user
    // identity to hash, and anonymizeId(null) is exactly 'anonymous'
    // (trainingDataService.js:136-141) — same value, no invented id.
    'user_id': 'anonymous',
    'session_id': turn.sessionId,
    'messages': messages,
    'response': response,
    'model': turn.model,
    // No intent classifier runs on the client; 'general' is the platform
    // default (trainingDataService.js:75), not a guess dressed as a category.
    'intent': 'general',
    'response_time_ms': null,
    'metadata': {
      'source': source,
      'adapter': null,
      'tokens_used': null,
    },
  };
  if (format == TrainingExportFormat.alpaca) {
    record['instruction'] = _lastUserText(turn.messages);
    record['input'] = _earlierUserText(turn.messages);
    record['output'] = response;
  }
  return record;
}

String _lastUserText(List<Map<String, dynamic>> messages) {
  for (final m in messages.reversed) {
    if (m['role'] == 'user') return m['content'] as String;
  }
  return '';
}

String _earlierUserText(List<Map<String, dynamic>> messages) {
  final users = messages.where((m) => m['role'] == 'user').toList();
  if (users.length <= 1) return '';
  return users.sublist(0, users.length - 1).map((m) => m['content'] as String).join('\n\n');
}

/// Masks PII the same way the platform collector does on write
/// (trainingDataService.js:146-162). The exporter writes the same field names
/// to a file the user can share, so masking only server-side would make the
/// export the bypass.
String sanitizeTrainingText(String text) => text
    .replaceAll(RegExp(r'1[3-9]\d{9}'), '[PHONE]')
    .replaceAll(RegExp(r'\d{17}[\dXx]'), '[ID]')
    .replaceAll(RegExp(r'[\w.-]+@[\w.-]+\.\w+'), '[EMAIL]')
    .replaceAll(RegExp(r'\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4,7}\b'), '[BANKCARD]')
    .replaceAll(RegExp(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b'), '[IP]');
