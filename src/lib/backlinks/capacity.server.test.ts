import assert from "node:assert/strict";
import { test } from "node:test";
import { createScanCapacity } from "./capacity.server.ts";

test("scan capacity prevents unbounded concurrent work", () => {
  const capacity = createScanCapacity(1);
  const release = capacity.acquire();
  assert.equal(capacity.active, 1);
  assert.equal(capacity.acquire(), null);
  release?.();
  release?.();
  assert.equal(capacity.active, 0);
  const second = capacity.acquire();
  assert.equal(typeof second, "function");
  second?.();
});
