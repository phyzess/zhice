import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchPageImageByBasePath } from "../../apps/worker/src/services/images";
import { HeaderSemaphore } from "../../apps/worker/src/services/concurrency";

describe("page prefetch with bounded concurrency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = "/base/path";

  function makeJpeg(): Uint8Array {
    // Minimal valid JPEG with SOF0: 3×2 pixels.
    return new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
  }

  it("fetches a single page", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(makeJpeg(), {
        headers: { "content-type": "image/jpeg" },
      }),
    );

    const bytes = await fetchPageImageByBasePath(base, 1);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it("validates JPEG SOI marker", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x00, 0x00]), {
        headers: { "content-type": "image/jpeg" },
      }),
    );

    await expect(fetchPageImageByBasePath(base, 1)).rejects.toThrow();
  });

  it("tries next mirror on 404, succeeds", async () => {
    const jpeg = makeJpeg();
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(new Response(jpeg, { headers: { "content-type": "image/jpeg" } }));
    });

    const bytes = await fetchPageImageByBasePath(base, 1);
    expect(bytes[0]).toBe(0xff);
    expect(callCount).toBe(2);
  });

  it("stops retrying on 403", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));

    await expect(fetchPageImageByBasePath(base, 1)).rejects.toThrow("第 1 页");
    // Only one mirror tried (the preferred one), not all three.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("aborts when signal is triggered", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }
      });
    });

    const promise = fetchPageImageByBasePath(base, 1, { signal: controller.signal });
    // Give the fetch a microtick to start.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(promise).rejects.toThrow("Aborted");
  });

  it("reports correct page number and mirror on error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x00, 0x00]), {
        headers: { "content-type": "image/jpeg" },
      }),
    );

    try {
      await fetchPageImageByBasePath(base, 5);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).toContain("第 5 页");
    }
  });
});

describe("HeaderSemaphore", () => {
  it("limits concurrent acquires", async () => {
    const semaphore = new HeaderSemaphore(2);
    const s1 = await semaphore.acquire();
    await semaphore.acquire();
    expect(semaphore.active).toBe(2);

    let acquired = false;
    const p3 = semaphore.acquire().then((s) => {
      acquired = true;
      return s;
    });

    // Not yet acquired.
    await new Promise((r) => setTimeout(r, 5));
    expect(acquired).toBe(false);

    s1.release();
    await p3;
    expect(acquired).toBe(true);
  });

  it("releaseHeader and release both free a slot", async () => {
    const semaphore = new HeaderSemaphore(1);
    const s1 = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    s1.releaseHeader();
    expect(semaphore.active).toBe(0);

    const s2 = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    s2.release();
    expect(semaphore.active).toBe(0);
  });
});
