/**
 * MaterialCoordinator — single-flight lease for PDF generation.
 *
 * Ensures only one Workflow generates a given contentId at a time.
 * Owner-safe: only the job that acquired the lease can renew or release it.
 * Lease defaults to 30 minutes.
 */

const LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

type Lease = {
  jobId: string;
  expiresAt: number;
};

export class MaterialCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    // ── claim(jobId) → { acquired: boolean, ownerJobId: string } ──
    if (url.pathname === "/claim" && request.method === "POST") {
      const body = (await request.json()) as { jobId: string };
      const active = await this.state.storage.get<Lease>("active");

      if (active && active.expiresAt > now) {
        return Response.json({
          jobId: body.jobId,
          existingJobId: active.jobId,
          acquired: false,
        });
      }

      const lease: Lease = {
        jobId: body.jobId,
        expiresAt: now + LEASE_TTL_MS,
      };
      await this.state.storage.put("active", lease);
      return Response.json({
        jobId: body.jobId,
        acquired: true,
      });
    }

    // ── renew(jobId) — only the current owner can extend the lease ──
    if (url.pathname === "/renew" && request.method === "POST") {
      const body = (await request.json()) as { jobId: string };
      const active = await this.state.storage.get<Lease>("active");

      if (!active) {
        return Response.json({ error: "no active lease" }, { status: 404 });
      }

      if (active.jobId !== body.jobId) {
        return Response.json({ error: "lease owned by a different job" }, { status: 409 });
      }

      // Extend the lease.
      active.expiresAt = now + LEASE_TTL_MS;
      await this.state.storage.put("active", active);
      return Response.json({ ok: true });
    }

    // ── release(jobId) — only the current owner can release ──
    if (url.pathname === "/release" && request.method === "POST") {
      const body = (await request.json()) as { jobId: string };
      const active = await this.state.storage.get<Lease>("active");

      if (!active) {
        return Response.json({ ok: true });
      }

      // Old workflows cannot release a lease held by a newer job.
      if (active.jobId !== body.jobId) {
        return Response.json(
          { error: "cannot release lease owned by a different job" },
          { status: 409 },
        );
      }

      await this.state.storage.delete("active");
      return Response.json({ ok: true });
    }

    // ── force-release (for ops purge with force=true) ──
    if (url.pathname === "/force-release" && request.method === "POST") {
      await request.json(); // consume body
      const active = await this.state.storage.get<Lease>("active");
      if (active) {
        await this.state.storage.delete("active");
      }
      return Response.json({ ok: true, releasedJobId: active?.jobId ?? null });
    }

    return new Response("Not found", { status: 404 });
  }
}
