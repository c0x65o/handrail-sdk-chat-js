import assert from "node:assert/strict";
import test from "node:test";
import { validateThreadConversationName } from "../src/contracts/conversation.ts";

test("supplied thread names preserve valid Unicode scalar boundaries", () => {
  for (const name of ["Launch 🚀", "🚀", "🚀".repeat(100), "a".repeat(100),
    "e\u0301".repeat(50), "a b", "a\u0085b", "\u200b", "\u180e"]) {
    assert.equal(validateThreadConversationName(name), name);
    assert.equal(validateThreadConversationName(JSON.parse(JSON.stringify(name))), name);
  }
});

test("supplied thread names reject malformed and oversized values", () => {
  for (const name of [undefined, null, 42, true, [], {}, "", " ", "  \t\n",
    "a".repeat(101), "🚀".repeat(101), "e\u0301".repeat(51),
    "\ud800", "\udfff", "x\ud800y", " leading", "trailing "]) {
    assert.throws(() => validateThreadConversationName(name), TypeError);
  }
});

test("the frozen whitespace set is rejected at edges and preserved internally", () => {
  const whitespace = [9, 10, 11, 12, 13, 32, 133, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279];
  for (const point of whitespace) {
    const space = String.fromCodePoint(point);
    for (const name of [space, `${space}Launch`, `Launch${space}`]) {
      assert.throws(() => validateThreadConversationName(name), TypeError);
    }
    assert.equal(validateThreadConversationName(`a${space}b`), `a${space}b`);
  }
});
