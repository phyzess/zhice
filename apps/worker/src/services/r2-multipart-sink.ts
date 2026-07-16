import { concatBytes } from "@zhice/core";
import type { PdfSink } from "@zhice/core";
import type { HeaderSemaphore } from "./concurrency";

export type R2MultipartSinkOptions = {
  /** Minimum part size in bytes (default 8 MiB). Last part may be smaller. */
  partSize?: number;
  /** Max concurrent uploadPart calls (default 2). */
  uploadConcurrency?: number;
  /** Shared semaphore for outbound connections. */
  semaphore?: HeaderSemaphore;
  /** HTTP metadata written on object creation. */
  httpMetadata?: Record<string, string>;
  /** Custom metadata written on object creation. */
  customMetadata?: Record<string, string>;
};

type UploadTask = {
  partNumber: number;
  data: Uint8Array;
  promise: Promise<R2UploadedPart>;
};

/**
 * R2 multipart upload sink that overlaps uploads of full parts while
 * the next part is being filled. Applies backpressure to the PdfWriter
 * when `uploadConcurrency` parts are already uploading.
 */
export class R2MultipartPdfSink implements PdfSink {
  private readonly chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private nextPartNumber = 1;
  private readonly inflight: UploadTask[] = [];
  private readonly completedParts: R2UploadedPart[] = [];
  private totalBytes = 0;
  private failed = false;
  private readonly uploadConcurrency: number;
  private readonly semaphore: HeaderSemaphore | undefined;

  private constructor(
    private readonly upload: R2MultipartUpload,
    private readonly partSize: number,
    options: R2MultipartSinkOptions,
  ) {
    this.uploadConcurrency = options.uploadConcurrency ?? 2;
    this.semaphore = options.semaphore;
  }

  static async create(
    bucket: R2Bucket,
    key: string,
    options: R2MultipartSinkOptions = {},
  ): Promise<R2MultipartPdfSink> {
    const upload = await bucket.createMultipartUpload(key, {
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    return new R2MultipartPdfSink(upload, options.partSize ?? 8 * 1024 * 1024, options);
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.failed) {
      throw new Error("Multipart upload already failed");
    }
    this.totalBytes += chunk.byteLength;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const available = this.partSize - this.bufferedBytes;
      const nextOffset = Math.min(chunk.byteLength, offset + available);
      const piece = chunk.subarray(offset, nextOffset);
      this.chunks.push(piece);
      this.bufferedBytes += piece.byteLength;
      offset = nextOffset;
      if (this.bufferedBytes === this.partSize) {
        await this.flushPart();
      }
    }
  }

  async complete(): Promise<{ size: number; etag: string; r2Key: string }> {
    if (this.failed) {
      throw new Error("Multipart upload already failed");
    }
    // Flush remaining buffered bytes (last part, may be smaller than partSize).
    if (
      this.bufferedBytes > 0 ||
      (this.completedParts.length === 0 && this.inflight.length === 0)
    ) {
      await this.flushPart();
    }
    // Wait for all inflight uploads.
    for (const task of this.inflight) {
      try {
        this.completedParts.push(await task.promise);
      } catch (error) {
        this.failed = true;
        try {
          await this.upload.abort();
        } catch {
          // Best-effort cleanup.
        }
        throw error;
      }
    }
    this.inflight.length = 0;

    // Sort parts by partNumber before completing.
    this.completedParts.sort((a, b) => a.partNumber - b.partNumber);
    const object = await this.upload.complete(this.completedParts);
    return {
      size: this.totalBytes,
      etag: object.httpEtag ?? "",
      r2Key: object.key,
    };
  }

  async abort(): Promise<void> {
    this.failed = true;
    // Don't wait for inflight uploads — just abort the multipart session.
    try {
      await this.upload.abort();
    } catch {
      // Best-effort.
    }
    this.inflight.length = 0;
  }

  private async flushPart(): Promise<void> {
    const data = concatBytes(this.chunks.splice(0));
    this.bufferedBytes = 0;
    if (data.byteLength === 0) {
      return;
    }

    const partNumber = this.nextPartNumber;
    this.nextPartNumber += 1;

    // Apply backpressure: wait for an inflight slot.
    while (this.inflight.length >= this.uploadConcurrency) {
      // Wait for the oldest inflight to complete.
      const oldest = this.inflight.shift()!;
      try {
        this.completedParts.push(await oldest.promise);
      } catch (error) {
        this.failed = true;
        // Drain remaining inflight before aborting.
        await this.drainInflight();
        throw error;
      }
    }

    // Start upload (occupies a semaphore slot if provided).
    const task: UploadTask = {
      partNumber,
      data,
      promise: this.uploadPartWithSemaphore(partNumber, data),
    };
    this.inflight.push(task);
  }

  private async uploadPartWithSemaphore(
    partNumber: number,
    data: Uint8Array,
  ): Promise<R2UploadedPart> {
    const slot = this.semaphore ? await this.semaphore.acquire() : null;
    try {
      return await this.upload.uploadPart(partNumber, data);
    } finally {
      slot?.release();
    }
  }

  private async drainInflight(): Promise<void> {
    for (const task of this.inflight) {
      try {
        this.completedParts.push(await task.promise);
      } catch {
        // Ignore — we're already in a failure state.
      }
    }
    this.inflight.length = 0;
  }
}
