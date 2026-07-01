const defaultSampleUrl =
  "https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=913b98d8-ee64-4b08-bb18-5c09ef22034b&catalogType=tchMaterial&subCatalog=tchMaterial";

const baseUrl = process.env.ZHICE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.OPS_TOKEN;
const sampleUrl = process.env.ZHICE_SAMPLE_URL ?? defaultSampleUrl;
const timeoutMs = Number(process.env.ZHICE_VERIFY_TIMEOUT_MS ?? 15 * 60 * 1000);
const purge = process.env.ZHICE_VERIFY_PURGE === "1";

if (!token) {
  console.error("OPS_TOKEN is required.");
  process.exit(1);
}

const firstJob = await createVerifyJob({ purge });
const completed = await waitForJob(firstJob.jobId, timeoutMs);
await verifyDownload(completed);

const cacheJob = await createVerifyJob({ purge: false });
if (cacheJob.status !== "succeeded") {
  throw new Error(`Cache verification did not return a ready PDF. Status: ${cacheJob.status}`);
}
await verifyDownload(cacheJob);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      contentId: completed.contentId,
      title: completed.title,
      pages: completed.pageCount,
      firstJob: completed.jobId,
      cacheJob: cacheJob.jobId,
    },
    null,
    2,
  ),
);

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
      throw new Error(job.error ?? `Production verification stopped with status: ${job.status}`);
    }
    await delay(2500);
  }
  throw new Error(`Timed out waiting for job ${jobId}.`);
}

async function verifyDownload(job: JobView): Promise<void> {
  if (!job.downloadUrl) {
    throw new Error(`Job ${job.jobId} has no downloadUrl.`);
  }
  const response = await fetch(new URL(job.downloadUrl, baseUrl));
  if (!response.ok) {
    throw new Error(`PDF download failed with HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!startsWith(bytes, "%PDF-")) {
    throw new Error("Downloaded file is not a PDF.");
  }
  const pages = countNeedle(bytes, "/Type /Page /Parent");
  if (pages !== job.pageCount) {
    throw new Error(`PDF page count mismatch: expected ${job.pageCount}, found ${pages}.`);
  }
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

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  const encoded = new TextEncoder().encode(prefix);
  return encoded.every((byte, index) => bytes[index] === byte);
}

function countNeedle(bytes: Uint8Array, needle: string): number {
  const encoded = new TextEncoder().encode(needle);
  let count = 0;
  outer: for (let index = 0; index <= bytes.length - encoded.length; index += 1) {
    for (let offset = 0; offset < encoded.length; offset += 1) {
      if (bytes[index + offset] !== encoded[offset]) {
        continue outer;
      }
    }
    count += 1;
  }
  return count;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
