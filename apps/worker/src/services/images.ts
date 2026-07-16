import type { MaterialManifest } from "@zhice/core";
import { parseJpegSize } from "@zhice/core";
import { HeaderSemaphore } from "./concurrency";

const imageHeaders = {
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  referer: "https://basic.smartedu.cn/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
};

const PAGE_TIMEOUT_MS = 15_000;

export type PageFetchResult = {
  page: number;
  bytes: Uint8Array;
};

export type PrefetchOptions = {
  concurrency: number;
  signal?: AbortSignal;
  onPageFetched?: (page: number) => void;
  semaphore?: HeaderSemaphore;
};

/**
 * Fetch pages with bounded concurrency. Pages may complete out of order
 * but are yielded in strict page-number order. At most `concurrency`
 * requests are in-flight at once, and at most the same number of completed
 * Uint8Arrays are buffered before the consumer catches up.
 *
 * Single-page retry rules:
 *  - Preferred host: `(page - 1) % 3 + 1`
 *  - Each mirror tried at most once
 *  - 15 s timeout per request
 *  - Network errors, 408, 429, 5xx → next mirror
 *  - 401, 403 → non-retryable
 *  - 404 → try next mirror; all three 404 → fail
 *  - Validates HTTP status, Content-Type, JPEG SOI, and parseJpegSize()
 */
export async function* prefetchPagesInOrder(
  manifest: MaterialManifest,
  options: PrefetchOptions,
): AsyncGenerator<PageFetchResult, void, undefined> {
  const { concurrency, signal, onPageFetched, semaphore } = options;
  const total = manifest.pageCount;
  const pending = new Map<number, Promise<PageFetchResult>>();
  let nextToYield = 1;
  let done = false;

  const fetchOne = async (page: number): Promise<PageFetchResult> => {
    const bytes = await fetchPageImage(manifest, page, { semaphore, signal });
    return { page, bytes };
  };

  // Prefill the window.
  for (let page = 1; page <= Math.min(concurrency, total); page += 1) {
    pending.set(page, fetchOne(page));
  }
  let nextToFetch = Math.min(concurrency, total) + 1;

  while (!done) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const promise = pending.get(nextToYield);
    if (!promise) {
      // Should not happen if we manage the window correctly.
      done = true;
      break;
    }

    let result: PageFetchResult;
    try {
      result = await promise;
    } catch (error) {
      // Cancel remaining in-flight requests.
      done = true;
      throw error;
    }

    pending.delete(nextToYield);
    yield result;
    onPageFetched?.(nextToYield);
    nextToYield += 1;

    // Replenish the window.
    if (nextToFetch <= total) {
      pending.set(nextToFetch, fetchOne(nextToFetch));
      nextToFetch += 1;
    }

    if (nextToYield > total) {
      done = true;
    }
  }
}

export async function fetchPageImage(
  manifest: MaterialManifest,
  page: number,
  options?: { semaphore?: HeaderSemaphore; signal?: AbortSignal },
): Promise<Uint8Array> {
  return fetchPageImageByBasePath(manifest.imageBasePath, page, options);
}

export async function fetchPageImageByBasePath(
  imageBasePath: string,
  page: number,
  options?: { semaphore?: HeaderSemaphore; signal?: AbortSignal },
): Promise<Uint8Array> {
  const preferred = ((page - 1) % 3) + 1;
  const hosts = [preferred, ...[1, 2, 3].filter((index) => index !== preferred)];
  const errors: PageFetchError[] = [];

  for (const hostIndex of hosts) {
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      const bytes = await fetchSingleImage(imageBasePath, page, hostIndex, options);
      return bytes;
    } catch (error) {
      const entry: PageFetchError = {
        page,
        mirror: hostIndex,
        code: error instanceof Error ? error.message : "UNKNOWN",
      };
      if (error instanceof PageFetchError) {
        entry.httpStatus = error.httpStatus;
        entry.code = error.code;
      }
      errors.push(entry);

      // 401/403: upstream access denied — no point retrying mirrors.
      if (entry.httpStatus === 401 || entry.httpStatus === 403) {
        break;
      }
      // 404: try next mirror.
      if (entry.httpStatus === 404) {
        continue;
      }
    }
  }

  const last = errors.at(-1);
  throw new PageFetchError(
    page,
    last?.mirror ?? 0,
    `第 ${page} 页下载失败`,
    last?.code ?? "ALL_MIRRORS_FAILED",
    last?.httpStatus,
  );
}

async function fetchSingleImage(
  imageBasePath: string,
  page: number,
  hostIndex: number,
  options?: { semaphore?: HeaderSemaphore; signal?: AbortSignal },
): Promise<Uint8Array> {
  const url = getImageUrlForHost(imageBasePath, page, hostIndex);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

  // Chain the external AbortSignal if provided.
  if (options?.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // Acquire semaphore slot before fetch.
  const slot = options?.semaphore ? await options.semaphore.acquire() : null;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: imageHeaders,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    slot?.release();
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new PageFetchError(page, hostIndex, "请求超时", "TIMEOUT");
    }
    throw new PageFetchError(page, hostIndex, "网络错误", "NETWORK_ERROR");
  }

  // Release header slot now; body download continues below.
  slot?.releaseHeader();
  clearTimeout(timeoutId);

  if (!response.ok) {
    // Consume body to release connection.
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      throw new PageFetchError(page, hostIndex, "无权访问", "FORBIDDEN", response.status);
    }
    if (response.status === 404) {
      throw new PageFetchError(page, hostIndex, "图片不存在", "NOT_FOUND", response.status);
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new PageFetchError(
        page,
        hostIndex,
        "服务暂时不可用",
        "UPSTREAM_ERROR",
        response.status,
      );
    }
    throw new PageFetchError(
      page,
      hostIndex,
      `HTTP ${response.status}`,
      "HTTP_ERROR",
      response.status,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.includes("image/") &&
    !contentType.includes("jpeg") &&
    !contentType.includes("jpg")
  ) {
    await response.body?.cancel();
    throw new PageFetchError(page, hostIndex, "非图片响应", "BAD_CONTENT_TYPE");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new PageFetchError(page, hostIndex, "响应读取失败", "BODY_READ_ERROR");
  }

  // Validate JPEG.
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new PageFetchError(page, hostIndex, "不是 JPEG 图片", "NOT_JPEG");
  }

  // Validate we can parse dimensions (catches truncated images).
  try {
    parseJpegSize(bytes);
  } catch {
    throw new PageFetchError(page, hostIndex, "JPEG 尺寸解析失败", "BAD_JPEG");
  }

  return bytes;
}

export async function proxyPageImage(
  imageBasePath: string,
  page: number,
  options?: { semaphore?: HeaderSemaphore },
): Promise<Response> {
  try {
    const bytes = await fetchPageImageByBasePath(imageBasePath, page, options);
    return new Response(bytes, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch {
    return Response.json({ error: `第 ${page} 页图片读取失败，请稍后重试。` }, { status: 502 });
  }
}

function getImageUrlForHost(basePath: string, page: number, hostIndex: number): string {
  return `https://r${hostIndex}-ndr.ykt.cbern.com.cn${basePath}/${page}.jpg`;
}

export class PageFetchError extends Error {
  constructor(
    readonly page: number,
    readonly mirror: number,
    message: string,
    readonly code: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "PageFetchError";
  }
}
