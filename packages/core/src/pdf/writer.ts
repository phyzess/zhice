import { concatBytes, encodeAscii, formatPdfString } from "./bytes";
import { parseJpegSize, type JpegSize } from "./jpeg";

export type PdfSink = {
  write(chunk: Uint8Array): void | Promise<void>;
};

export type PdfPageInput = {
  bytes: Uint8Array;
  size?: JpegSize;
};

export class MemoryPdfSink implements PdfSink {
  readonly chunks: Uint8Array[] = [];

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }

  toUint8Array(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

export class PdfWriter {
  private readonly offsets: number[] = [0];
  private readonly pageIds: number[] = [];
  private readonly pageObjectsId: number;
  private readonly catalogId: number;
  private readonly infoId: number;
  private position = 0;
  private nextObjectId = 1;

  constructor(
    private readonly sink: PdfSink,
    private readonly options: { title?: string; dpi?: number } = {},
  ) {
    this.pageObjectsId = this.allocateObjectId();
    this.catalogId = this.allocateObjectId();
    this.infoId = this.allocateObjectId();
  }

  async start(): Promise<void> {
    await this.write("%PDF-1.4\n%âãÏÓ\n");
  }

  async addJpegPage(input: PdfPageInput): Promise<void> {
    const size = input.size ?? parseJpegSize(input.bytes);
    const imageId = this.allocateObjectId();
    const contentId = this.allocateObjectId();
    const pageId = this.allocateObjectId();
    const dpi = this.options.dpi ?? 180;
    const pageWidth = (size.width * 72) / dpi;
    const pageHeight = (size.height * 72) / dpi;

    await this.writeObjectHeader(imageId);
    await this.write(
      `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${input.bytes.byteLength} >>\nstream\n`,
    );
    await this.writeBytes(input.bytes);
    await this.write("\nendstream\nendobj\n");

    const content = `q\n${formatNumber(pageWidth)} 0 0 ${formatNumber(pageHeight)} 0 0 cm\n/Im${imageId} Do\nQ\n`;
    await this.writeObject(
      contentId,
      `<< /Length ${encodeAscii(content).byteLength} >>\nstream\n${content}endstream`,
    );

    await this.writeObject(
      pageId,
      `<< /Type /Page /Parent ${this.pageObjectsId} 0 R /MediaBox [0 0 ${formatNumber(pageWidth)} ${formatNumber(pageHeight)}] /Resources << /XObject << /Im${imageId} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    this.pageIds.push(pageId);
  }

  async finish(): Promise<void> {
    await this.writeObject(
      this.pageObjectsId,
      `<< /Type /Pages /Kids [${this.pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pageIds.length} >>`,
    );
    await this.writeObject(this.catalogId, `<< /Type /Catalog /Pages ${this.pageObjectsId} 0 R >>`);
    await this.writeObject(
      this.infoId,
      `<< /Producer ${formatPdfString("zhice")} /Creator ${formatPdfString("zhice")} /Title ${formatPdfString(this.options.title ?? "zhice")} >>`,
    );

    const xrefOffset = this.position;
    await this.write(`xref\n0 ${this.offsets.length}\n`);
    await this.write("0000000000 65535 f \n");
    for (let id = 1; id < this.offsets.length; id += 1) {
      await this.write(`${String(this.offsets[id]).padStart(10, "0")} 00000 n \n`);
    }
    await this.write(
      `trailer\n<< /Size ${this.offsets.length} /Root ${this.catalogId} 0 R /Info ${this.infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    );
  }

  private allocateObjectId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  private async writeObject(id: number, body: string): Promise<void> {
    await this.writeObjectHeader(id);
    await this.write(`${body}\nendobj\n`);
  }

  private async writeObjectHeader(id: number): Promise<void> {
    this.offsets[id] = this.position;
    await this.write(`${id} 0 obj\n`);
  }

  private async write(value: string): Promise<void> {
    await this.writeBytes(encodeAscii(value));
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    await this.sink.write(bytes);
    this.position += bytes.byteLength;
  }
}

export async function createPdfFromJpegs(
  pages: PdfPageInput[],
  options: { title?: string; dpi?: number } = {},
): Promise<Uint8Array> {
  const sink = new MemoryPdfSink();
  const writer = new PdfWriter(sink, options);
  await writer.start();
  for (const page of pages) {
    await writer.addJpegPage(page);
  }
  await writer.finish();
  return sink.toUint8Array();
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
