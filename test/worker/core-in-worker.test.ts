import { parseJpegSize } from "@zhice/core";
import { describe, expect, it } from "vitest";

describe("worker runtime smoke test", () => {
  it("runs shared core code in the Workers pool", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
    expect(parseJpegSize(jpeg)).toEqual({ width: 1, height: 1 });
  });
});
