/**
 * Shared outbound fetch semaphore for Cloudflare Workers.
 *
 * Workers are limited to 6 concurrent outbound connections that are waiting
 * for response headers. This semaphore is shared between page fetches and
 * R2 multipart uploads so they never exceed the cap together.
 *
 * Usage:
 *   const slot = await semaphore.acquire();
 *   const response = await fetch(...);  // headers arrived → release
 *   slot.releaseHeader();
 *   const body = await response.arrayBuffer(); // body read after release
 *
 * For R2 uploadPart() where headers aren't exposed:
 *   const slot = await semaphore.acquire();
 *   const part = await upload.uploadPart(...); // occupies slot until done
 *   slot.release();
 */

export class HeaderSemaphore {
  private count = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<HeaderSlot> {
    if (this.count < this.max) {
      this.count += 1;
      return Promise.resolve(new HeaderSlot(this));
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.count += 1;
        resolve(new HeaderSlot(this));
      });
    });
  }

  private release(): void {
    this.count -= 1;
    this.queue.shift()?.();
  }

  /** Current active count (for tests). */
  get active(): number {
    return this.count;
  }
}

export class HeaderSlot {
  private released = false;

  constructor(private readonly semaphore: HeaderSemaphore) {}

  /** Release after response headers arrive (body can still stream). */
  releaseHeader(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.semaphore["release"]();
  }

  /** Release after the full operation completes (for R2 uploadPart). */
  release(): void {
    this.releaseHeader();
  }
}
