import { createPdfFromJpegs, parseJpegSize, PdfWriter, type PdfSink } from "@zhice/core";
import { describe, expect, it } from "vitest";

const tinyJpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);

describe("PDF writer", () => {
  it("parses JPEG dimensions from SOF marker", () => {
    expect(parseJpegSize(tinyJpeg)).toEqual({ width: 3, height: 2 });
  });

  it("creates a PDF containing one image page", async () => {
    const pdf = await createPdfFromJpegs([{ bytes: tinyJpeg }], {
      title: "测试教材",
    });
    const text = new TextDecoder().decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 1");
    expect(text).toContain("/DCTDecode");
    expect(text).toContain("startxref");
  });

  it("encodes Chinese document title as UTF-16BE metadata", async () => {
    const pdf = await createPdfFromJpegs([{ bytes: tinyJpeg }], {
      title: "测试教材",
    });
    const text = new TextDecoder().decode(pdf);
    expect(text).toContain("/Producer (zhice)");
    expect(text).toContain("/Title <FEFF6D4B8BD565596750>");
  });

  it("writes pages incrementally to a custom sink", async () => {
    class CountingSink implements PdfSink {
      readonly chunks: Uint8Array[] = [];

      write(chunk: Uint8Array): void {
        this.chunks.push(chunk);
      }
    }

    const sink = new CountingSink();
    const writer = new PdfWriter(sink, { title: "流式教材" });
    await writer.start();
    await writer.addJpegPage({ bytes: tinyJpeg });
    await writer.addJpegPage({ bytes: tinyJpeg });
    await writer.finish();

    const text = new TextDecoder().decode(Buffer.concat(sink.chunks));
    expect(text).toContain("/Count 2");
    expect(text).toContain("startxref");
  });
});
