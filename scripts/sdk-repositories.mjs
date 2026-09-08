import { resolve } from "node:path";

// Cross-repository development checks use an explicit checkout. SDK consumers
// must still install public HTTPS Git dependencies at full commit SHAs.
export const jsRepositoryRoot = resolve(import.meta.dirname, "..");
export const flutterRepositoryRoot = resolve(
  process.env.HANDRAIL_CHAT_FLUTTER_ROOT ||
    resolve(jsRepositoryRoot, "../handrail-sdk-chat-flutter"),
);
export const flutterExampleRoot = resolve(flutterRepositoryRoot, "example");
export const flutterWebRoot = resolve(flutterExampleRoot, "build/web");
