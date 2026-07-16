/**
 * Production verification script.
 *
 * 1. Creates a PDF generation job.
 * 2. Waits for completion.
 * 3. Validates the download (HEAD, Range, page count via streaming).
 * 4. Submits again to verify hot cache (< 2 s).
 *
 * Environment variables:
 *   ZHICE_BASE_URL          — Worker URL (default http://127.0.0.1:8787)
 *   OPS_TOKEN               — Bearer token for Ops API
 *   ZHICE_SAMPLE_URL        — SmartEdu textbook URL to test
 *   ZHICE_VERIFY_PURGE=1    — Purge cache first (cold-path test)
 *   ZHICE_VERIFY_COLD_TARGET_MS  — Max acceptable cold generation ms (default 60000)
 *   ZHICE_VERIFY_HOT_TARGET_MS   — Max acceptable hot cache ms (default 2000)
 *   ZHICE_VERIFY_TIMEOUT_MS — Max wait time for job (default 15 min)
 */

const defaultSampleUrl =
  "https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=913b98d8-ee64-4b08-bb18-5c09ef22034b&catalogType=tchMaterial&subCatalog=tchMaterial";

const baseUrl = process.env.ZHICE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.OPS_TOKEN;
const sampleUrl = process.env.ZHICE_SAMPLE_URL ?? defaultSampleUrl;
const timeoutMs = Number(process.env.ZHICE_VERIFY_TIMEOUT_MS ?? 15 * 60 * 1000);
const coldTargetMs = Number(process.env.ZHICE_VERIFY_COLD_TARGET_MS ?? 60000);
const hotTargetMs = Number(process.env.ZHICE_VERIFY_HOT_TARGET_MS ?? 2000);
const purge = process.env.ZHICE_VERIFY_PURGE === "1";

if (!token) {
  console.error("OPS_TOKEN is required.");
  process.exit(1);
}

type JobView = {
  jobId: string;
  contentId: string;
  status: string;
  title: string;
  pageCount: number;
  completedPages: number;
  error?: string | null;
  downloadUrl?: string | null;
};

// ── Cold generation (with optional purge) ─────────────────────────

const coldStart = Date.now();
const firstJob = await createVerifyJob({ purge });
const completed = await waitForJob(firstJob.jobId, timeoutMs);
const coldMs = Date.now() - coldStart;

console.log(`Cold generation: ${coldMs}ms (target ≤ ${coldTargetMs}ms)`);
if (coldMs > coldTargetMs) {
  console.error(`WARNING: cold generation exceeded target (${coldMs}ms > ${coldTargetMs}ms)`);
}

const downloadUrl = resolvedDownloadUrl(completed);
await verifyDownload(downloadUrl, completed.pageCount);
await verifyHead(downloadUrl);
await verifyRange(downloadUrl);

// ── Hot cache verification ────────────────────────────────────────

const hotStart = Date.now();
const cacheJob = await createVerifyJob({ purge: false });
const hotMs = Date.now() - hotStart;

console.log(`Hot cache: ${hotMs}ms (target ≤ ${hotTargetMs}ms)`);
if (hotMs > hotTargetMs) {
  console.error(`WARNING: hot cache exceeded target (${hotMs}ms > ${hotTargetMs}ms)`);
}

if (cacheJob.status !== "succeeded") {
  throw new Error(`Cache verification did not return a ready PDF. Status: ${cacheJob.status}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      contentId: completed.contentId,
      title: completed.title,
      pages: completed.pageCount,
      coldMs,
      hotMs,
      firstJob: completed.jobId,
      cacheJob: cacheJob.jobId,
    },
    null,
    2,
  ),
);

// ── Helpers ────────────────────────────────────────────────────────

async function createVerifyJob(input: { purge: boolean }): Promise<JobView> {
  return requestJson<JobView>("/api/ops/verify", {
    method: "POST",
    body: JSON.stringify({ url: sampleUrl, purge: input.purge }),
    headers: { "content-type": "application/json" },
  });
}

async function waitForJob(jobId: string, timeout: number): Promise<JobView> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const job = await requestJson<JobView>(`/api/jobs/${jobId}`, {}, false);
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed" || job.status === "fallback_ready" || job.status === "canceled") {
      throw new Error(job.error ?? `Job stopped with status: ${job.status}`);
    }
    await delay(2500);
  }
  throw new Error(`Timed out waiting for job ${jobId}.`);
}

async function verifyDownload(dlUrl: string, expectedPages: number): Promise<void> {
  const response = await fetch(dlUrl);
  if (!response.ok) {
    throw new Error(`PDF download failed with HTTP ${response.status}.`);
  }

  // Streaming page count — don't buffer the whole PDF in memory.
  if (!response.body) {
    throw new Error("No response body for PDF download.");
  }

  const reader = response.body.getReader();
  let pdfHeaderOk = false;
  let pages = 0;
  let totalBytes = 0;
  let tail = new Uint8Array(0);
  const needle = new TextEncoder().encode("/Type /Page /Parent");
  const pdfSig = new TextEncoder().encode("%PDF-");

  const start = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;

    // Check PDF header on first chunk.
    if (!pdfHeaderOk && value.length >= 4) {
      pdfHeaderOk = startsWith(value, pdfSig);
    }

    // Count pages across chunk boundaries.
    const combined = concat(tail, value);
    pages += countNeedle(combined, needle);
    // Keep tail for cross-chunk matching.
    tail = combined.slice(-Math.max(0, needle.length - 1));
  }
  const downloadMs = Date.now() - start;

  if (!pdfHeaderOk) {
    throw new Error("Downloaded file is not a PDF (missing %PDF- header).");
  }
  if (pages !== expectedPages) {
    throw new Error(`PDF page count mismatch: expected ${expectedPages}, found ${pages}.`);
  }

  console.log(
    `Download: ${totalBytes} bytes, ${pages} pages, ${downloadMs}ms (${(((totalBytes / downloadMs) * 1000) / 1024 / 1024).toFixed(1)} MB/s)`,
  );
}

async function verifyHead(dlUrl: string): Promise<void> {
  const response = await fetch(dlUrl, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`HEAD request failed with HTTP ${response.status}.`);
  }
  const contentLength = response.headers.get("content-length");
  const etag = response.headers.get("etag");
  console.log(`HEAD: Content-Length=${contentLength}, ETag=${etag}`);
  if (!contentLength) {
    console.error("WARNING: HEAD response missing Content-Length");
  }
}

async function verifyRange(dlUrl: string): Promise<void> {
  // Range: bytes=0-1023 (first 1 KiB).
  const response = await fetch(dlUrl, {
    headers: { Range: "bytes=0-1023" },
  });
  if (response.status !== 206) {
    throw new Error(`Range request expected 206, got ${response.status}.`);
  }
  const range = response.headers.get("content-range");
  const length = response.headers.get("content-length");
  console.log(`Range 0-1023: ${response.status}, Content-Range=${range}, Content-Length=${length}`);
  if (!range) {
    console.error("WARNING: 206 response missing Content-Range header");
  }
}

function resolvedDownloadUrl(job: JobView): string {
  if (job.downloadUrl?.startsWith("http://") || job.downloadUrl?.startsWith("https://")) {
    return job.downloadUrl;
  }
  return new URL(job.downloadUrl ?? "", baseUrl).href;
}

async function requestJson<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

function countNeedle(bytes: Uint8Array, needle: Uint8Array): number {
  let count = 0;
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    count += 1;
  }
  return count;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
