import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gateIdentityEnabled } from "./gate-identity.server.ts";

describe("gate identity (OSS)", () => {
  it("stays disabled — platform gate was removed from OSS", () => {
    assert.equal(gateIdentityEnabled(), false);
  });
});
