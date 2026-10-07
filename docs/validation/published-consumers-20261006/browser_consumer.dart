import 'dart:async';
import 'dart:convert';
import 'package:handrail_chat/core.dart';
import 'package:web/web.dart' as web;
import 'SHIPPED_BROWSER_ADAPTER';

class ObservedTransport implements HandrailChatHttpTransport {
  final inner = BrowserChatTransport();
  final responses = <Map<String, Object?>>[];
  @override
  Future<HandrailChatHttpResponse> send(HandrailChatHttpRequest request) async {
    final response = await inner.send(request);
    responses.add({'status': response.statusCode, 'headers': response.headers});
    return response;
  }
}
Future<void> main() async {
  final output = web.document.querySelector('#result')!;
  try {
    final query = Uri.parse(web.window.location.href).queryParameters;
    final base = query['api']!;
    final cors = query['cors']!;
    final results = <Object?>[];
    for (final mode in ['seconds','date','invalid','cancel','real']) {
      if (cors == 'hidden' && (mode == 'cancel' || mode == 'real')) continue;
      var time = DateTime.utc(2026, 10, 6, 19);
      final waits = <int>[];
      final started = Completer<void>();
      final cancel = ChatCommandCancellationController();
      final transport = ObservedTransport();
      final dispatcher = ChatCommandDispatcher(
        apiBaseUri: Uri.parse('$base/api/flutter/$cors/$mode/'),
        tokenProvider: () async => 'synthetic-loopback-token',
        transport: transport,
        generateIdempotencyKey: () => 'synthetic-flutter-$cors-$mode',
        retryOptions: mode == 'real' ? const ChatCommandRetryOptions() : ChatCommandRetryOptions(
          now: () => time,
          wait: (delay, _) async {
            waits.add(delay.inMilliseconds);
            if (mode == 'cancel') {started.complete(); await Completer<void>().future;}
            time = time.add(delay);
          },
        ),
      );
      final descriptor = ChatCommandDescriptor<Object?,Object?,Object?>(
        name:'fixture.command',method:ChatCommandMethod.post,path:'/commands',
        retrySafety:ChatCommandRetrySafety.safe,validateInput:(x)=>x,parseResult:(x)=>x);
      final watch = Stopwatch()..start();
      final future = dispatcher.dispatch(descriptor, {'synthetic': true}, options: ChatCommandDispatchOptions(cancellationSignal:cancel.signal));
      if(mode == 'cancel') {await started.future; cancel.cancel();}
      final result = await future;
      watch.stop();
      results.add({'mode':mode,'status':result.status,'waits':waits,'responses':transport.responses,'elapsedMs':watch.elapsedMilliseconds,'version':handrailChatPackageVersion});
      dispatcher.closeActive();
    }
    output.textContent=jsonEncode({'sdk':'flutter','cors':cors,'results':results});
  } catch(e,st) {output.textContent=jsonEncode({'error':'$e','stack':'$st'});}
}
