import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

describe("MaterialCoordinator single-flight lease", () => {
  it("second claim returns existingJobId", async () => {
    const id = env.MATERIAL_COORDINATOR.idFromName("test-content-1");
    const stub = env.MATERIAL_COORDINATOR.get(id);

    // First claim.
    const res1 = await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-1" }),
    });
    const body1 = (await res1.json()) as {
      jobId: string;
      existingJobId?: string;
      acquired: boolean;
    };
    expect(body1.acquired).toBe(true);
    expect(body1.jobId).toBe("job-1");

    // Second claim should return existing job.
    const res2 = await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-2" }),
    });
    const body2 = (await res2.json()) as {
      jobId: string;
      existingJobId?: string;
      acquired: boolean;
    };
    expect(body2.acquired).toBe(false);
    expect(body2.existingJobId).toBe("job-1");
  });

  it("non-owner cannot release", async () => {
    const id = env.MATERIAL_COORDINATOR.idFromName("test-content-2");
    const stub = env.MATERIAL_COORDINATOR.get(id);

    // Owner claims.
    await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-3" }),
    });

    // Non-owner tries to release.
    const res = await stub.fetch("https://coordinator/release", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-4" }),
    });
    expect(res.status).toBe(409);
  });

  it("owner can renew", async () => {
    const id = env.MATERIAL_COORDINATOR.idFromName("test-content-3");
    const stub = env.MATERIAL_COORDINATOR.get(id);

    await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-5" }),
    });

    const res = await stub.fetch("https://coordinator/renew", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-5" }),
    });
    expect(res.ok).toBe(true);
  });

  it("force-release clears any lease", async () => {
    const id = env.MATERIAL_COORDINATOR.idFromName("test-content-4");
    const stub = env.MATERIAL_COORDINATOR.get(id);

    await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-6" }),
    });

    const res = await stub.fetch("https://coordinator/force-release", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(true);

    // New claim after force-release.
    const res2 = await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-7" }),
    });
    const body2 = (await res2.json()) as { acquired: boolean };
    expect(body2.acquired).toBe(true);
  });
});
