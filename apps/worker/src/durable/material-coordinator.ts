export class MaterialCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/claim" && request.method === "POST") {
      const body = (await request.json()) as { jobId: string };
      const active = await this.state.storage.get<{
        jobId: string;
        expiresAt: number;
      }>("active");
      const now = Date.now();
      if (active && active.expiresAt > now) {
        return Response.json({ jobId: active.jobId, existingJobId: active.jobId });
      }
      await this.state.storage.put("active", {
        jobId: body.jobId,
        expiresAt: now + 30 * 60 * 1000,
      });
      return Response.json({ jobId: body.jobId });
    }

    if (url.pathname === "/release" && request.method === "POST") {
      await this.state.storage.delete("active");
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
