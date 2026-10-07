#!/bin/bash
set -eu
work_root="$(cd "$(dirname "$0")/../../.." && pwd)"
export FLUTTER_ROOT="$work_root/handrail-sdk-chat-flutter/build/ack-release-review/current-flutter"
exec "$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" "$@"
