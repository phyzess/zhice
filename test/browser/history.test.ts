import { LOCAL_HISTORY_KEY } from "@zhice/core";
import { describe, expect, it } from "vitest";

describe("browser history key", () => {
  it("uses a versioned localStorage key", () => {
    expect(LOCAL_HISTORY_KEY).toBe("zhice.localHistory.v1");
  });
});
