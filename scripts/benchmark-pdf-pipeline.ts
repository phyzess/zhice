/**
 * Benchmark PDF pipeline performance.
 *
 * Measured stages: Manifest fetch, per-page fetch, total wall-clock.
 * By default benchmarks the first 24 pages with 1 vs 6 concurrency.
 * Set ZHICE_BENCH_FULL=1 to benchmark the complete 205-page textbook.
 *
 * Writes only JSON summary to stdout — never persists page images or the full PDF.
 *
 * Environment variables:
 *   ZHICE_SAMPLE_URL     — SmartEdu textbook URL (default: math grade 7 example)
 *   ZHICE_BENCH_FULL=1   — benchmark full 205 pages instead of 24
 *   ZHICE_BENCH_CONCURRENCY — override request window size (default: tests 1 & 6)
 */

import { fetchSmartEduManifest, parseSmartEduContentId } from "@zhice/core";

const defaultSampleUrl =
  "https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=913b98d8-ee64-4b08-bb18-5c09ef22034b&catalogType=tchMaterial&subCatalog=tchMaterial";

const sampleUrl = process.env.ZHICE_SAMPLE_URL ?? defaultSampleUrl;
const benchFull = process.env.ZHICE_BENCH_FULL === "1";
const benchConcurrency = Number(process.env.ZHICE_BENCH_CONCURRENCY) || undefined;

type BenchResult = {
  concurrency: number;
  pages: number;
  totalBytes: number;
  wallMs: number;
  aggregateFetchMs: number;
  maxPageMs: number;
  maxPageBytes: number;
  failedPages: number;
  retries: number;
  manifestMs: number;
};

function imageUrl(imageBasePath: string, page: number, hostIndex: number): string {
  return `https://r${hostIndex}-ndr.ykt.cbern.com.cn${imageBasePath}/${page}.jpg`;
}

const imageHeaders = {
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  referer: "https://basic.smartedu.cn/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
};

async function fetchPage(
  imageBasePath: string,
  page: number,
): Promise<{ bytes: Uint8Array; ms: number; retries: number }> {
  const preferred = ((page - 1) % 3) + 1;
  const hosts = [preferred, ...[1, 2, 3].filter((index) => index !== preferred)];
  let retries = 0;
  for (const hostIndex of hosts) {
    const start = performance.now();
    try {
      const response = await fetch(imageUrl(imageBasePath, page, hostIndex), {
        headers: imageHeaders,
      });
      if (!response.ok) {
        retries += 1;
        continue;
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        retries += 1;
        continue;
      }
      return { bytes, ms: performance.now() - start, retries };
    } catch {
      retries += 1;
    }
  }
  throw new Error(`Page ${page} failed after ${retries} retries`);
}

async function bench(
  concurrency: number,
  pageCount: number,
  imageBasePath: string,
): Promise<BenchResult> {
  const results: BenchResult = {
    concurrency,
    pages: pageCount,
    totalBytes: 0,
    wallMs: 0,
    aggregateFetchMs: 0,
    maxPageMs: 0,
    maxPageBytes: 0,
    failedPages: 0,
    retries: 0,
    manifestMs: 0,
  };

  const start = performance.now();
  const semaphore = makeSemaphore(concurrency);

  const tasks = Array.from({ length: pageCount }, (_, i) => i + 1).map(async (page) => {
    const release = await semaphore.acquire();
    try {
      const { bytes, ms, retries } = await fetchPage(imageBasePath, page);
      results.totalBytes += bytes.byteLength;
      results.aggregateFetchMs += ms;
      results.retries += retries;
      if (ms > results.maxPageMs) {
        results.maxPageMs = ms;
      }
      if (bytes.byteLength > results.maxPageBytes) {
        results.maxPageBytes = bytes.byteLength;
      }
      // Validate first byte: Range request stats
      if (bytes.length === 1) {
        results.failedPages += 1;
      }
    } catch {
      results.failedPages += 1;
    } finally {
      release();
    }
  });

  await Promise.all(tasks);
  results.wallMs = performance.now() - start;
  return results;
}

function makeSemaphore(max: number) {
  let count = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    count -= 1;
    queue.shift()?.();
  };
  const acquire = (): Promise<() => void> => {
    if (count < max) {
      count += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      queue.push(() => {
        count += 1;
        resolve(release);
      });
    });
  };
  return { acquire };
}

async function main(): Promise<void> {
  process.stderr.write("Resolving contentId...\n");
  const contentId = parseSmartEduContentId(sampleUrl);

  const manifestStart = performance.now();
  const manifest = await fetchSmartEduManifest(contentId);
  const manifestMs = performance.now() - manifestStart;

  const maxPages = benchFull ? manifest.pageCount : Math.min(24, manifest.pageCount);
  const concurrencies = benchConcurrency ? [benchConcurrency] : [1, 6];

  const allResults: BenchResult[] = [];
  for (const concurrency of concurrencies) {
    process.stderr.write(`Benchmarking ${maxPages} pages with concurrency=${concurrency}...\n`);
    const result = await bench(concurrency, maxPages, manifest.imageBasePath);
    result.manifestMs = manifestMs;
    allResults.push(result);
  }

  console.log(
    JSON.stringify(
      {
        contentId: manifest.contentId,
        title: manifest.title,
        pageCount: manifest.pageCount,
        benchmarkedPages: maxPages,
        manifestMs,
        results: allResults,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Benchmark failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
