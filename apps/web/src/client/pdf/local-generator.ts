/**
 * Browser-side local PDF generator.
 *
 * Uses OPFS for streaming PDF writes (if available), or falls back to
 * in-memory Blob. Pages are fetched with bounded concurrency through
 * the Worker proxy (/api/page).
 */

import { PdfWriter } from "@zhice/core";
import { fetchPagesInOrder } from "./fetch-pages";
import { BrowserMemoryPdfSink, isOpfsAvailable, OpfsPdfSink } from "./opfs-sink";

export type LocalGeneratorOptions = {
  title: string;
  pageCount: number;
  pageUrlTemplate: string;
  jobId: string;
  onProgress?: (page: number, total: number, phase: "fetching" | "writing") => void;
  signal?: AbortSignal;
  concurrency?: number;
};

export type LocalGeneratorResult = {
  /** A File handle (OPFS) or Blob (memory fallback). */
  pdf: File | Blob;
  /** Human-readable filename. */
  filename: string;
  /** Backend used: "opfs" or "memory". */
  storage: "opfs" | "idb";
  /** Key for persisting to OPFS history. */
  localPdfKey: string;
  size: number;
};

/**
 * Generate a PDF locally in the browser.
 *
 * Uses OPFS streaming by default; falls back to in-memory Blob if
 * OPFS is not supported (older browsers, some mobile environments).
 */
export async function generateLocalPdf(
  options: LocalGeneratorOptions,
): Promise<LocalGeneratorResult> {
  const { title, pageCount, pageUrlTemplate, jobId, onProgress, signal, concurrency = 6 } = options;

  const useOpfs = isOpfsAvailable();
  let sink;
  let writer;

  const localPdfKey = `${jobId}.pdf`;

  if (useOpfs) {
    try {
      sink = await OpfsPdfSink.create(localPdfKey);
      writer = new PdfWriter(sink, { title });
    } catch {
      // OPFS init failed — fall back to memory.
      console.warn("OPFS init failed, falling back to memory PDF");
      sink = new BrowserMemoryPdfSink();
      writer = new PdfWriter(sink, { title });
    }
  } else {
    sink = new BrowserMemoryPdfSink();
    writer = new PdfWriter(sink, { title });
  }

  try {
    await writer.start();

    let lastYield = 0;
    for await (const { page, bytes } of fetchPagesInOrder(pageCount, {
      concurrency,
      pageUrlTemplate,
      signal,
      onPageFetched: (p) => {
        onProgress?.(p, pageCount, "fetching");
      },
    })) {
      await writer.addJpegPage({ bytes });

      // Yield to the UI every 5 pages.
      if (page - lastYield >= 5) {
        lastYield = page;
        await nextFrame();
      }
    }

    onProgress?.(pageCount, pageCount, "writing");
    await writer.finish();
  } catch (error) {
    // Clean up on failure.
    if (sink instanceof OpfsPdfSink) {
      await sink.abort();
    }
    throw error;
  }

  const filename = `${sanitizeFilename(title)}.pdf`;

  let pdf: File | Blob;
  let storage: "opfs" | "idb";
  let size: number;

  if (sink instanceof OpfsPdfSink) {
    pdf = await sink.toFile(filename);
    storage = "opfs";
    size = sink.size;
  } else if (sink instanceof BrowserMemoryPdfSink) {
    pdf = sink.toBlob();
    storage = "idb";
    size = sink.size;
  } else {
    throw new Error("Unknown sink type");
  }

  return {
    pdf,
    filename,
    storage,
    localPdfKey,
    size,
  };
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
