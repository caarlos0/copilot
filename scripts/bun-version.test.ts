import assert from "node:assert/strict";
import { test } from "node:test";
import { bunVersionError } from "./bun-version.ts";

test("accepts the pinned version", () => {
  assert.equal(bunVersionError("1.4.5", "1.4.5"), undefined);
});

test("names both versions when they differ", () => {
  assert.equal(
    bunVersionError("1.4.0", "1.4.5"),
    "Bun 1.4.0 is installed. This repo needs Bun 1.4.5. Bundles from another version differ.",
  );
});
