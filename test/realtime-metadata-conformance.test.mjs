import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { createChatClient } from "../dist/client/index.js";

const fixturesDirectory = new URL(
  "../conformance-tests/realtime-metadata/",
  import.meta.url,
);

const fixtureFiles = (await readdir(fixturesDirectory))
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();

test("GET /_meta matches every shared realtime metadata fixture", async () => {
  assert.ok(fixtureFiles.length > 0, "expected realtime metadata fixtures");

  for (const fileName of fixtureFiles) {
    const fixture = JSON.parse(
      await readFile(new URL(fileName, fixturesDirectory), "utf8"),
    );
    assert.ok(
      fixture.expected === "accept" || fixture.expected === "reject",
      `${fileName} must declare an accept or reject outcome`,
    );

    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "conformance-test-token",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => fixture.metadata,
      }),
    });
    const state = await client.start();
    const outcome = state.state === "error" ? "reject" : "accept";

    assert.equal(outcome, fixture.expected, fixture.id ?? fileName);
    assert.equal(
      state.state,
      fixture.expectedClientState,
      `${fixture.id ?? fileName} client state`,
    );
    if (state.state === "error") {
      assert.equal(state.diagnostic.code, "malformed_metadata");
    }
  }
});
