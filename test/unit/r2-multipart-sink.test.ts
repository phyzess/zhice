import { R2MultipartPdfSink } from "../../apps/worker/src/services/r2-multipart-sink";
import { describe, expect, it, vi } from "vitest";

class FakeMultipartUpload {
  readonly partSizes: number[] = [];
  completedParts: R2UploadedPart[] = [];
  private uploadCallCount = 0;

  async uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPart> {
    this.uploadCallCount += 1;
    // Simulate some async work.
    await Promise.resolve();
    this.partSizes.push(value.byteLength);
    return { etag: `part-${partNumber}`, partNumber };
  }

  async complete(parts: R2UploadedPart[]): Promise<R2Object> {
    this.completedParts = parts;
    return {
      size: this.partSizes.reduce((sum, size) => sum + size, 0),
      httpEtag: `"etag-${this.partSizes.length}"`,
      key: "test-key",
    } as unknown as R2Object;
  }

  async abort(): Promise<void> {}
}

function makeBucket(multipart: FakeMultipartUpload): R2Bucket {
  return {
    createMultipartUpload: async () => multipart,
  } as unknown as R2Bucket;
}

describe("R2 multipart PDF sink", () => {
  it("uploads fixed-size non-trailing parts", async () => {
    const upload = new FakeMultipartUpload();
    const sink = await R2MultipartPdfSink.create(makeBucket(upload), "sample.pdf", { partSize: 8 });

    await sink.write(new Uint8Array(3));
    await sink.write(new Uint8Array(7));
    await sink.write(new Uint8Array(10));
    await sink.write(new Uint8Array(1));
    const result = await sink.complete();

    expect(upload.partSizes).toEqual([8, 8, 5]);
    expect(upload.completedParts).toHaveLength(3);
    expect(result.size).toBe(21);
    expect(result.etag).toBeTruthy();
  });

  it("sorts completed parts by partNumber", async () => {
    const upload = new FakeMultipartUpload();
    const sink = await R2MultipartPdfSink.create(makeBucket(upload), "sample.pdf", {
      partSize: 8,
      uploadConcurrency: 2,
    });

    await sink.write(new Uint8Array(16)); // 2 parts
    await sink.write(new Uint8Array(4)); // 1 small part
    await sink.complete();

    const partNumbers = upload.completedParts.map((p) => p.partNumber);
    expect(partNumbers).toEqual([1, 2, 3]);
  });

  it("applies backpressure with uploadConcurrency=2 and many writes", async () => {
    // Track max concurrent in-flight uploads.
    let concurrent = 0;
    let maxConcurrent = 0;

    const upload = new FakeMultipartUpload();
    const origUploadPart = upload.uploadPart.bind(upload);
    upload.uploadPart = async (partNumber: number, value: Uint8Array) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      const result = await origUploadPart(partNumber, value);
      concurrent -= 1;
      return result;
    };

    const sink = await R2MultipartPdfSink.create(makeBucket(upload), "sample.pdf", {
      partSize: 4,
      uploadConcurrency: 2,
    });

    // Write 16 bytes → 4 parts of 4 bytes each.
    await sink.write(new Uint8Array(16));
    await sink.complete();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("reports metadata correctly", async () => {
    let capturedMeta: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    } = {};
    const upload = {
      partSizes: [] as number[],
      completedParts: [] as R2UploadedPart[],
      async uploadPart(partNumber: number, _value: Uint8Array) {
        return { etag: `part-${partNumber}`, partNumber } as R2UploadedPart;
      },
      async complete(_parts: R2UploadedPart[]) {
        return {
          size: 50,
          httpEtag: '"abc"',
          key: "materials/test/abc.pdf",
        } as unknown as R2Object;
      },
      async abort() {},
    };
    const bucket = {
      createMultipartUpload: async (
        _key: string,
        opts?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
      ) => {
        capturedMeta = opts ?? {};
        return upload;
      },
    } as unknown as R2Bucket;

    const sink = await R2MultipartPdfSink.create(bucket, "materials/test/abc.pdf", {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { contentId: "test-id", pdfVersion: "v2" },
    });

    await sink.write(new Uint8Array(10));
    await sink.complete();

    expect(capturedMeta.httpMetadata).toEqual({ contentType: "application/pdf" });
    expect(capturedMeta.customMetadata).toEqual({ contentId: "test-id", pdfVersion: "v2" });
  });

  it("aborts cleanly after failure propagates", async () => {
    const upload = new FakeMultipartUpload();
    const abortSpy = vi.spyOn(upload, "abort");
    upload.uploadPart = async () => {
      throw new Error("upload failed");
    };

    const sink = await R2MultipartPdfSink.create(makeBucket(upload), "sample.pdf", {
      partSize: 8,
      uploadConcurrency: 1,
    });

    // Write exactly one part — the upload will fail when complete() awaits it.
    await sink.write(new Uint8Array(8));
    await expect(sink.complete()).rejects.toThrow("upload failed");

    // Caller should abort to clean up.
    await sink.abort();
    expect(abortSpy).toHaveBeenCalled();
  });

  it("total bytes matches input", async () => {
    const upload = new FakeMultipartUpload();
    const sink = await R2MultipartPdfSink.create(makeBucket(upload), "sample.pdf", { partSize: 8 });

    await sink.write(new Uint8Array(1));
    await sink.write(new Uint8Array(2));
    await sink.write(new Uint8Array(3));
    const result = await sink.complete();
    expect(result.size).toBe(6);
  });
});
