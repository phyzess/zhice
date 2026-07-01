import { concatBytes } from "@zhice/core";
import type { PdfSink } from "@zhice/core";

export class R2MultipartPdfSink implements PdfSink {
  private readonly chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private partNumber = 1;
  private readonly uploadedParts: R2UploadedPart[] = [];
  private totalBytes = 0;

  private constructor(
    private readonly upload: R2MultipartUpload,
    private readonly partSize: number,
  ) {}

  static async create(
    bucket: R2Bucket,
    key: string,
    partSize = 8 * 1024 * 1024,
  ): Promise<R2MultipartPdfSink> {
    const upload = await bucket.createMultipartUpload(key);
    return new R2MultipartPdfSink(upload, partSize);
  }

  async write(chunk: Uint8Array): Promise<void> {
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

  async complete(): Promise<{ object: R2Object; size: number }> {
    if (this.bufferedBytes > 0 || this.uploadedParts.length === 0) {
      await this.flushPart();
    }
    const object = await this.upload.complete(this.uploadedParts);
    return { object, size: this.totalBytes };
  }

  async abort(): Promise<void> {
    await this.upload.abort();
  }

  private async flushPart(): Promise<void> {
    const data = concatBytes(this.chunks.splice(0));
    this.bufferedBytes = 0;
    if (data.byteLength === 0) {
      return;
    }
    const part = await this.upload.uploadPart(this.partNumber, data);
    this.uploadedParts.push(part);
    this.partNumber += 1;
  }
}
