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
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    this.totalBytes += chunk.byteLength;
    while (this.bufferedBytes >= this.partSize) {
      await this.flushPart(false);
    }
  }

  async complete(): Promise<{ object: R2Object; size: number }> {
    if (this.bufferedBytes > 0 || this.uploadedParts.length === 0) {
      await this.flushPart(true);
    }
    const object = await this.upload.complete(this.uploadedParts);
    return { object, size: this.totalBytes };
  }

  async abort(): Promise<void> {
    await this.upload.abort();
  }

  private async flushPart(force: boolean): Promise<void> {
    if (!force && this.bufferedBytes < this.partSize) {
      return;
    }
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
