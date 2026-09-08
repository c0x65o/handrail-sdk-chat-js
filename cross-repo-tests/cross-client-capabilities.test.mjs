import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  readCapabilityManifest,
  REVIEWED_CAPABILITY_FAMILY_IDS,
  validateCapabilityManifest,
} from "../scripts/validate-cross-client-capabilities.mjs";

const clone = (value) => structuredClone(value);
const capability = (manifest, id) =>
  manifest.capabilities.find((candidate) => candidate.id === id);

test("the checked-in cross-client capability manifest is valid", async () => {
  await validateCapabilityManifest(await readCapabilityManifest());
});

test("capability IDs and statuses use closed vocabularies", async () => {
  const manifest = await readCapabilityManifest();

  const duplicate = clone(manifest);
  duplicate.capabilities.push(clone(duplicate.capabilities[0]));
  await assert.rejects(
    validateCapabilityManifest(duplicate),
    /duplicate capability IDs/,
  );

  const unknownId = clone(manifest);
  unknownId.capabilities[0].id = "future_aspirational_capability";
  await assert.rejects(
    validateCapabilityManifest(unknownId),
    /unknown capability IDs/,
  );

  const unknownStatus = clone(manifest);
  unknownStatus.capabilities[0].surfaces.server.status = "planned";
  await assert.rejects(
    validateCapabilityManifest(unknownStatus),
    /unknown status planned/,
  );
});

test("the manifest exactly covers the independently reviewed family registry", async () => {
  const manifest = await readCapabilityManifest();
  assert.deepEqual(
    manifest.capabilities.map(({ id }) => id).sort(),
    [...REVIEWED_CAPABILITY_FAMILY_IDS].sort(),
  );

  for (const familyId of [
    "messages",
    "read_state",
    "realtime",
    "attachments",
    "huddles",
  ]) {
    const missingFamily = clone(manifest);
    missingFamily.capabilities = missingFamily.capabilities.filter(
      ({ id }) => id !== familyId,
    );
    await assert.rejects(
      validateCapabilityManifest(missingFamily),
      new RegExp(`missing reviewed capability families: ${familyId}`),
    );
  }
});

test("every capability has exactly the five required surfaces", async () => {
  const manifest = await readCapabilityManifest();

  const missing = clone(manifest);
  delete missing.capabilities[0].surfaces.flutter_widgets;
  await assert.rejects(
    validateCapabilityManifest(missing),
    /must contain exactly server, typescript_client, react_ui, flutter_client, flutter_widgets/,
  );

  const extra = clone(manifest);
  extra.capabilities[0].surfaces.desktop = {
    status: "product_decision_required",
    reason: "Not part of this contract.",
  };
  await assert.rejects(validateCapabilityManifest(extra), /desktop/);
});

test("supported entries require well-formed, publicly reachable citations", async () => {
  const manifest = await readCapabilityManifest();

  const malformed = clone(manifest);
  malformed.capabilities[0].surfaces.server.citations[0].symbol =
    "createConversation()";
  await assert.rejects(validateCapabilityManifest(malformed), /symbol is malformed/);

  const citation = capability(manifest, "saved_messages")
    .surfaces.typescript_client.citations[0];
  const source = await readFile(citation.source, "utf8");
  const withoutCitedSymbol = source.replaceAll(citation.symbol, "removedSymbol");
  assert.notEqual(withoutCitedSymbol, source, "fixture must remove the cited symbol");
  await assert.rejects(
    validateCapabilityManifest(manifest, {
      sourceOverrides: new Map([[citation.source, withoutCitedSymbol]]),
    }),
    /cites missing public symbol listSavedMessages/,
  );
});

test("unsupported entries require a concrete host or product reason", async () => {
  const manifest = await readCapabilityManifest();
  const unsupported = manifest.capabilities
    .flatMap(({ id, surfaces }) => Object.entries(surfaces).map(
      ([surface, entry]) => ({ id, surface, entry }),
    ))
    .find(({ entry }) => entry.status !== "supported");
  assert.ok(unsupported, "fixture requires an unsupported surface");

  const blankReason = clone(manifest);
  capability(blankReason, unsupported.id).surfaces[unsupported.surface].reason = "";
  await assert.rejects(
    validateCapabilityManifest(blankReason),
    /reason must be a non-empty trimmed string/,
  );
});

test("known parity boundaries remain explicit", async () => {
  const manifest = await readCapabilityManifest();
  const savedMessages = capability(manifest, "saved_messages");
  const archive = capability(manifest, "conversation_archive_restore");
  const directory = capability(manifest, "directory_search");

  assert.equal(savedMessages.surfaces.server.status, "supported");
  assert.equal(savedMessages.surfaces.typescript_client.status, "supported");
  assert.equal(savedMessages.surfaces.react_ui.status, "supported");
  assert.equal(
    savedMessages.surfaces.flutter_client.status,
    "product_decision_required",
  );
  assert.equal(
    savedMessages.surfaces.flutter_widgets.status,
    "product_decision_required",
  );
  assert.equal(archive.surfaces.flutter_client.status, "supported");
  assert.equal(
    archive.surfaces.flutter_widgets.status,
    "product_decision_required",
  );
  assert.equal(directory.surfaces.flutter_client.status, "host_composed");
  assert.equal(directory.surfaces.flutter_widgets.status, "supported");
});
