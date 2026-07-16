/**
 * OPFS-based PDF sink that streams chunks directly to disk.
 * Avoids keeping the full PDF in JS heap, Blob, or IndexedDB.
 *
 * Usage:
 *   const sink = await OpfsPdfSink.create("job-123.pdf");
 *   writer.pipeTo(sink);
 *   await writer.finish();
 *   const file = await sink.toFile("教材名称.pdf");
 *   // Download via object URL or showSaveFilePicker.
 *
 * Falls back to MemoryPdfSink if OPFS is not available.
 */

import { type PdfSink } from "@zhice/core";

const OPFS_ROOT = "zhice-pdfs";

export class OpfsPdfSink implements PdfSink {
  private writable: FileSystemWritableFileStream | null = null;
  private handle: FileSystemFileHandle | null = null;
  private root: FileSystemDirectoryHandle | null = null;
  private _size = 0;
  private closed = false;

  private constructor() {}

  static async create(filename: string): Promise<OpfsPdfSink> {
    const sink = new OpfsPdfSink();
    try {
      sink.root = await navigator.storage.getDirectory();
      // Create or replace the file.
      sink.handle = await sink.root.getFileHandle(`${OPFS_ROOT}/${filename}`, { create: true });
      sink.writable = await sink.handle.createWritable();
    } catch (error) {
      console.warn("OPFS not available, using in-memory sink", error);
      throw error;
    }
    return sink;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new Error("Sink closed");
    }
    if (this.writable) {
      // TS: Uint8Array<ArrayBufferLike> is not assignable to FileSystemWriteChunkType.
      // Create a fresh Uint8Array backed by a new ArrayBuffer to satisfy the type.
      const copy = new Uint8Array(chunk.length);
      copy.set(chunk);
      await this.writable.write(copy);
    }
    this._size += chunk.byteLength;
  }

  async complete(): Promise<FileSystemFileHandle> {
    if (this.closed) {
      throw new Error("Sink already closed");
    }
    this.closed = true;
    if (this.writable) {
      await this.writable.close();
    }
    if (!this.handle) {
      throw new Error("No file handle");
    }
    return this.handle;
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      if (this.writable) {
        await this.writable.abort();
      }
    } catch {
      // Best-effort.
    }
    // Remove the temporary file.
    try {
      if (this.root && this.handle) {
        await this.root.removeEntry(`${OPFS_ROOT}/${this.handle.name}`);
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  /** Get a File object backed by OPFS (no JS heap copy). */
  async toFile(_filename: string): Promise<File> {
    if (!this.handle) {
      throw new Error("No file handle");
    }
    return await this.handle.getFile();
  }

  get size(): number {
    return this._size;
  }
}

/**
 * Check if OPFS (Origin Private File System) is available for createWritable.
 * Baseline 2025: supported in Chrome, Edge, Safari.
 */
export function isOpfsAvailable(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.storage !== "undefined" &&
      typeof navigator.storage.getDirectory === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Fallback PdfSink that collects chunks in memory.
 */
export class BrowserMemoryPdfSink implements PdfSink {
  readonly chunks: BlobPart[] = [];
  size = 0;

  write(chunk: Uint8Array): void {
    const copy = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(copy).set(chunk);
    this.chunks.push(copy);
    this.size += chunk.byteLength;
  }

  toBlob(): Blob {
    return new Blob(this.chunks, { type: "application/pdf" });
  }
}
