import { describe, expect, it } from "vitest";
import { CORE_PACKAGE } from "../src/index.js";

describe("@codegraph/core", () => {
  it("is wired into the workspace", () => {
    expect(CORE_PACKAGE).toBe("@codegraph/core");
  });
});
