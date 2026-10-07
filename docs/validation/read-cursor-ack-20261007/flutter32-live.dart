import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:handrail_chat/core.dart';

void check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> main(List<String> args) async {
  final origin = Uri.parse(args.single);
  // All successful response bytes below come from candidate JS over real HTTP.
  for (final mode in ['valid', 'lost', 'malformed', 'wrong-user', 'denied', '429']) {
    final id = ConversationId('flutter-$mode');
    final store = NormalizedSnapshotStore()..hydrateConversationList(snapshot(id));
    final scheduler = Scheduler();
    final transport = LiveTransport(mode);
    final retryDelays = <Duration>[];
    final client = HandrailChatClient(
      apiBaseUri: origin,
      tokenProvider: () async => mode == 'denied' ? 'other-user' : 'valid',
      transport: transport,
      normalizedSnapshotStore: store,
      generateIdempotencyKey: () => 'flutter-$mode-key',
      readVisibilityClock: () => scheduler.now,
      readVisibilityScheduler: scheduler,
      commandRetryOptions: mode == '429'
        ? ChatCommandRetryOptions(maxAttempts: 2, backoff: (_) => Duration.zero,
            now: () => scheduler.now,
            wait: (delay, _) async { retryDelays.add(delay); scheduler.now = scheduler.now.add(delay); })
        : const ChatCommandRetryOptions(maxAttempts: 1),
    );
    try {
      client.reads.setApplicationForeground(true);
      client.reads.setConversationActive(id, isActive: true);
      client.reads.reportVisibleThrough(conversationId: id, sequence: const MessageSequence(6));
      scheduler.advance(const Duration(milliseconds: 500));
      await until(() => transport.completed >= (mode == '429' ? 2 : 1));
      await flush();
      final needsVisibilityRetry = ['lost', 'malformed', 'wrong-user', 'denied'].contains(mode);
      check(scheduler.active.length == (needsVisibilityRetry ? 1 : 0), '$mode retry scheduling');
      if (needsVisibilityRetry) {
        check(scheduler.active.single.due.difference(scheduler.now) == const Duration(seconds: 2), '$mode must retain 2s retry');
        scheduler.advance(const Duration(seconds: 2));
        await until(() => transport.completed == 2);
        await flush();
        check(scheduler.active.isEmpty, '$mode bounded retry must stop');
      }
      if (mode == '429') {
        check(retryDelays.length == 1 && retryDelays.single == const Duration(seconds: 12), 'Retry-After must be honored');
      }
      if (mode != 'denied') {
        check(store.state.currentUserReadStates[id]?.lastReadSequence.value == 6, '$mode accepted durable cursor');
        final accepted = transport.bodies.last;
        check(accepted['reconciliationStatus'] == (['lost', 'malformed', 'wrong-user'].contains(mode) ? 'replayed' : 'applied'), '$mode truthful outcome');
      }
      final count = transport.requests.length;
      scheduler.advance(const Duration(seconds: 10));
      await flush();
      check(transport.requests.length == count, '$mode unnecessary extra retry');
      check(transport.requests.toSet().length == 1, '$mode exact request identity on retry');
      print('$mode: requests=$count, visibilityRetry=$needsVisibilityRetry, Retry-After=${retryDelays.map((d) => d.inSeconds).toList()}');
      if (mode == 'valid') {
        final unread = await client.markUnread(ChatMarkUnreadInput(conversationId: id,
          fromSequence: const MessageSequence(4), idempotencyKey: 'flutter-unread-key'));
        check(unread is ChatCommandSuccess<ReadCursorMutationResult>, 'mark_unread accepted');
        check(store.state.currentUserReadStates[id]?.manualUnreadFromSequence?.value == 4, 'durable manual unread');
        final replay = await client.markUnread(ChatMarkUnreadInput(conversationId: id,
          fromSequence: const MessageSequence(4), idempotencyKey: 'flutter-unread-key'));
        check(replay is ChatCommandSuccess<ReadCursorMutationResult> && replay.value.reconciliationStatus == ReadCursorReconciliationStatus.replayed, 'mark_unread replay accepted');
        print('mark_unread applied/replayed: accepted with unchanged durable receipt');
      }
    } finally {
      await client.dispose();
      scheduler.advance(const Duration(days: 1));
      check(scheduler.active.isEmpty, '$mode disposal drains scheduling');
      transport.close();
      await store.close();
    }
  }
}

ConversationListSnapshot snapshot(ConversationId id) => ConversationListSnapshot.fromJson({
  'kind': 'conversation_list', 'scope': {'type': 'organization'},
  'items': [{
    'id': id.value, 'tenantId': 'tenant-a', 'type': 'channel', 'name': id.value,
    'visibility': 'private', 'createdAt': at, 'updatedAt': at,
    'latestSequence': 10, 'activityAt': at, 'unreadMentionCount': 0,
    'activeMemberUserIds': ['reader'],
    'currentMember': {'tenantId': 'tenant-a', 'conversationId': id.value,
      'userId': 'reader', 'role': 'member', 'state': 'active', 'joinedAt': at, 'updatedAt': at},
    'currentReadState': {'conversationId': id.value, 'userId': 'reader', 'lastReadSequence': 0, 'updatedAt': at},
    'currentPreference': {'conversationId': id.value, 'userId': 'reader',
      'notificationPreference': 'all', 'mute': {'muted': false}, 'isStarred': false, 'updatedAt': at},
  }], 'page': <String, Object?>{}, '_meta': {
    'packageVersion': '1.0.54', 'protocolVersion': 4, 'schemaVersion': 9,
    'enabledFeatures': {conversationSnapshotFeature: true},
    'supportedProtocolRange': {'minimumVersion': 1, 'maximumVersion': 4},
    'feature': {'name': conversationSnapshotFeature, 'version': conversationSnapshotVersion},
  },
});
const at = '2020-01-01T00:00:00.000Z';

final class LiveTransport implements HandrailChatHttpTransport {
  LiveTransport(this.mode);
  final String mode;
  final http = HttpClient();
  final requests = <String>[];
  final bodies = <Map<String, dynamic>>[];
  int completed = 0;
  @override
  Future<HandrailChatHttpResponse> send(HandrailChatHttpRequest input) async {
    requests.add(input.body!);
    try {
      if (mode == '429' && requests.length == 1) {
        return HandrailChatHttpResponse(statusCode: 429, headers: {'Retry-After': '12'},
          body: '{"error":{"code":"RATE_LIMITED","message":"retry later"}}');
      }
      final request = await http.openUrl(input.method, input.uri);
      input.headers.forEach(request.headers.set);
      request.write(input.body);
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      final body = jsonDecode(text) as Map<String, dynamic>;
      bodies.add(body);
      if (requests.length == 1) {
        if (mode == 'lost') throw StateError('injected acknowledgement lost after HTTP commit');
        if (mode == 'malformed') { body.remove('reconciliationStatus'); body.remove('idempotencyKey'); }
        if (mode == 'wrong-user') (body['readState'] as Map)['userId'] = 'other';
      }
      return HandrailChatHttpResponse(statusCode: response.statusCode, body: jsonEncode(body));
    } finally { completed++; }
  }
  void close() => http.close(force: true);
}

final class Scheduler implements ChatReadVisibilityScheduler {
  DateTime now = DateTime.utc(2026, 10, 7);
  final timers = <Scheduled>[];
  List<Scheduled> get active => timers.where((t) => t.active).toList();
  @override
  ChatReadVisibilityTimer schedule(Duration delay, void Function() callback) {
    final timer = Scheduled(now.add(delay), callback);
    timers.add(timer);
    return timer;
  }
  void advance(Duration delay) {
    now = now.add(delay);
    for (final timer in active) {
      if (!timer.due.isAfter(now)) { timer.active = false; timer.callback(); }
    }
  }
}
final class Scheduled implements ChatReadVisibilityTimer {
  Scheduled(this.due, this.callback);
  final DateTime due;
  final void Function() callback;
  bool active = true;
  @override
  void cancel() { active = false; }
}
Future<void> flush() async {
  for (var i = 0; i < 5; i++) { await Future<void>.delayed(Duration.zero); }
}
Future<void> until(bool Function() done) async {
  for (var i = 0; i < 500; i++) {
    if (done()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  throw StateError('HTTP proof timed out');
}
