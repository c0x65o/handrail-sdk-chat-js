# Reviewed-source preparation

These tools qualify the uncommitted reviewed source candidate, not a public Git
release. They never install the Handrail SDK as a local/file dependency. Release
qualification still requires reviewed public HTTPS full Git SHAs and matching
consumer locks. Do not change the source lock to match an existing installation.

Use `snapshot.py WORKSPACE FRESH_DESTINATION` to copy the reviewed working-tree
bytes into an isolated directory. It rejects drift against the three reviewed
maps plus this assignment’s recorded compatibility delta, excluding only this preparation tooling directory, and checks copied bytes
again. Preserve both its source inventory and the full workspace inventory.

Before **every** first lifecycle command in each disposable JS copy:

```sh
node scripts/generate-package-version.mjs --check
NODE_ENV=development npm ci --engine-strict
npm run build
npm run typecheck
```

Run these with actual Node 22.0.0 and the supported current runtime on PATH.
`NODE_ENV=development` is essential in workers whose inherited environment omits
devDependencies; keep npm's cache private. Never link shared `node_modules`.

Then run this directory's payload auditor using absolute paths:

```sh
python3 audit-payloads.py CHECKOUT PRIVATE_ARCHIVE_CACHE OUTPUT_JSON
```

The auditor authenticates registry archives against lock SRI and compares every
shipped regular file, including actual package versions. It records optional
omissions and generated extra files. Two explicit npm `.gitignore` renames and
esbuild's Linux x64 native-binary substitution are checked against authenticated
bytes, not ignored. It is a Linux x64 preparation audit. Package-version and
payload-tampering negative controls were executed in a disposable installation;
both failed as expected and the original bytes were restored. Hidden lock
metadata is never used as payload proof.

The retained work-request evidence contains the complete explicit Node/PG file
inventories, commands, original/effective locks, private real-tool launchers,
PostgreSQL 16 build/cluster teardown procedure, failure dispositions and logs.
Run expensive checks sequentially, Node concurrency 1 / timeout 120000 on the
current runtime, Flutter concurrency 2, PostgreSQL harness pool maximum 4.
Keep the separately prepared React 18.2 and Flutter 3.19/Dart 3.3 resolutions out
of the reviewed source locks. Modern unchanged Flutter acceptance evidence is
retained by identity; do not repeat it for another receipt.
