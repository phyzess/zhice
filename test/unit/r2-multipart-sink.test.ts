import { R2MultipartPdfSink } from "../../apps/worker/src/services/r2-multipart-sink";
import { describe, expect, it } from "vitest";

class FakeMultipartUpload {
  readonly partSizes: number[] = [];
  completedParts: R2UploadedPart[] = [];

  async uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPart> {
    this.partSizes.push(value.byteLength);
    return { etag: `part-${partNumber}`, partNumber };
  }

  async complete(parts: R2UploadedPart[]): Promise<R2Object> {
    this.completedParts = parts;
    return { size: this.partSizes.reduce((sum, size) => sum + size, 0) } as R2Object;
  }

  async abort(): Promise<void> {}
}

describe("R2 multipart PDF sink", () => {
  it("uploads fixed-size non-trailing parts", async () => {
    const upload = new FakeMultipartUpload();
    const bucket = {
      createMultipartUpload: async () => upload,
    } as unknown as R2Bucket;
    const sink = await R2MultipartPdfSink.create(bucket, "sample.pdf", 8);

    await sink.write(new Uint8Array(3));
    await sink.write(new Uint8Array(7));
    await sink.write(new Uint8Array(10));
    await sink.write(new Uint8Array(1));
    const result = await sink.complete();

    expect(upload.partSizes).toEqual([8, 8, 5]);
    expect(upload.completedParts).toHaveLength(3);
    expect(result.size).toBe(21);
  });
});
