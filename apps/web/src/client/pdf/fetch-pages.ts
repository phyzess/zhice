/**
 * Browser-side page fetcher with bounded concurrency.
 * Routes requests through the Worker /api/page proxy because
 * the upstream image hosts don't have CORS headers.
 */

export type PageFetchResult = {
  page: number;
  bytes: Uint8Array;
};

export type BrowserFetchOptions = {
  concurrency: number;
  pageUrlTemplate: string;
  signal?: AbortSignal;
  onPageFetched?: (page: number) => void;
};

/**
 * Fetch pages with bounded concurrency. Pages may complete out of order
 * but are yielded in strict page-number order.
 */
export async function* fetchPagesInOrder(
  pageCount: number,
  options: BrowserFetchOptions,
): AsyncGenerator<PageFetchResult, void, undefined> {
  const { concurrency, pageUrlTemplate, signal, onPageFetched } = options;
  const pending = new Map<number, Promise<PageFetchResult>>();
  let nextToYield = 1;
  let done = false;

  const fetchOne = async (page: number): Promise<PageFetchResult> => {
    const url = pageUrlTemplate.replace("{page}", String(page));
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let message = `第 ${page} 页读取失败`;
      try {
        const json = JSON.parse(body) as { error?: string };
        if (json.error) {
          message = json.error;
        }
      } catch {
        // Use the fallback message.
      }
      throw new Error(message);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { page, bytes };
  };

  // Prefill the window.
  for (let page = 1; page <= Math.min(concurrency, pageCount); page += 1) {
    pending.set(page, fetchOne(page));
  }
  let nextToFetch = Math.min(concurrency, pageCount) + 1;

  while (!done) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const promise = pending.get(nextToYield);
    if (!promise) {
      done = true;
      break;
    }

    const result = await promise;
    pending.delete(nextToYield);
    yield result;
    onPageFetched?.(nextToYield);
    nextToYield += 1;

    // Replenish the window.
    if (nextToFetch <= pageCount) {
      pending.set(nextToFetch, fetchOne(nextToFetch));
      nextToFetch += 1;
    }

    if (nextToYield > pageCount) {
      done = true;
    }
  }
}
