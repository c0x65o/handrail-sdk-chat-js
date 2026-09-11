import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:handrail_chat/core.dart' as core;
import 'package:handrail_chat/flutter.dart' as bindings;
import 'package:handrail_chat/ui.dart' as ui;
import 'package:handrail_chat/media.dart' as media;
import 'package:handrail_chat/testing.dart' as fixtures;
import 'package:handrail_chat/saved_message_snapshot.dart' as saved;

void main() {
  testWidgets('public imports compile and chat widget mounts', (tester) async {
    const conversation = core.ConversationId('consumer-channel');
    expect(bindings.ChatScope, isNotNull);
    expect(media.ChatMediaPermission.microphone.name, 'microphone');
    expect(fixtures.InMemoryApplicationChatStorage(), isNotNull);
    expect(saved.SavedMessageUnavailableReason.values, isNotEmpty);
    const workspace = ui.HandrailChatWorkspace();
    expect(workspace.compactBreakpoint, 720);
    final states = fixtures.ScriptedChatStateStream<String>('ready');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: bindings.ChatStateBuilder<String>(
        source: states,
        initialState: states.state,
        states: states.states,
        builder: (context, value) => Text(value,
          style: ui.HandrailChatTheme.of(context).typography.message),
      )),
    ));
    expect(find.text('ready'), findsOneWidget);
    states.emit('updated');
    await tester.pump();
    expect(find.text('updated'), findsOneWidget);
    expect(conversation.value, 'consumer-channel');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await states.dispose();
  });
}
