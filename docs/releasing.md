# Releases

The chat SDK has two independently versioned distributions in separate repositories:

- `@handrail/chat` uses this repository's root `package.json`.
- `handrail_chat` uses the root `pubspec.yaml` in `handrail-sdk-chat-flutter`.

Their version numbers do not need to match. Shared protocol changes must validate
both affected SDKs using the shared-contract and cross-runtime conformance gates.

## JavaScript/TypeScript SDK

1. Update the version with `npm version X.Y.Z --no-git-tag-version`. The version
   lifecycle refreshes `src/client/generated/package-version.ts`.
2. Run `npm run check:package-version`, `npm run build`, the scoped typechecks,
   and relevant tests. `npm ci --include=dev` invokes the normal prepare build.
3. With explicit owner authorization, commit and push the implementation and
   version to the public `handrail-sdk-chat-js` Git repository.
4. Consumers pin the full release commit in their public HTTPS Git dependency
   and matching lockfile. Build through the normal install pipeline.

## Flutter SDK

1. Update the root `pubspec.yaml` and embedded package metadata in
   `handrail-sdk-chat-flutter`.
2. Run `flutter pub get --no-example`, analysis, and relevant Flutter tests.
3. With explicit owner authorization, commit and push the implementation and
   version to the public `handrail-sdk-chat-flutter` Git repository.
4. Consumers pin the full release commit in their public HTTPS Git dependency
   and matching `pubspec.lock`.

There is no separate packaging or registry publishing step. Do not install SDKs
through paths, workspace dependencies, registry versions, tarballs, branches, or
tags. For an upgrade, honor the frozen revision. For a new install, resolve the
latest committed SDK version and SHA. The migration's initial empty scaffold
commits are not installable SDK revisions; see [migration status](sdk-repository-split.md).
