import { vValidator } from "@hono/valibot-validator";
import {
  CreateJobSchema,
  fetchSmartEduManifest,
  parseSmartEduContentId,
  smartEduErrorMessage,
  type MaterialManifest,
} from "@zhice/core";
import { Hono } from "hono";
import type { DbJob, Env } from "../env";
import {
  createJob,
  getJob,
  getMaterial,
  recordUsage,
  updateJob,
  upsertMaterial,
} from "../services/db";
import { checkRateLimit } from "../services/security";

export const jobsRoute = new Hono<{ Bindings: Env }>();

jobsRoute.post("/", vValidator("json", CreateJobSchema), async (c) => {
  const env = c.env;
  const input = c.req.valid("json");
  const remoteIp = c.req.header("CF-Connecting-IP") ?? null;

  if (!(await checkRateLimit(env, remoteIp, "create-job"))) {
    return c.json({ error: "提交太频繁，请稍后再试" }, 429);
  }

  let contentId: string;
  try {
    contentId = parseSmartEduContentId(input.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "链接无效" }, 400);
  }

  let manifest: MaterialManifest;
  try {
    manifest = await fetchSmartEduManifest(contentId);
  } catch (error) {
    return c.json({ error: smartEduErrorMessage(error) }, 502);
  }

  await upsertMaterial(env, manifest, "resolved");

  const cached = await getMaterial(env, contentId);
  const token = crypto.randomUUID();
  const mode = input.mode ?? "auto";
  const cachedObject =
    cached?.status === "ready" && cached.pdf_r2_key
      ? await env.ZHICE_BUCKET.head(cached.pdf_r2_key)
      : null;
  if (cached?.pdf_r2_key && cachedObject) {
    const jobId = crypto.randomUUID();
    await createJob(env, {
      id: jobId,
      contentId,
      mode,
      status: "succeeded",
      title: manifest.title,
      pageCount: manifest.pageCount,
      manifestToken: token,
      downloadUrl: downloadUrl(contentId),
    });
    await recordUsage(env, "cache_hit", contentId);
    const job = await getJob(env, jobId);
    return c.json(serializeJob(job!, manifest));
  }

  const claim = await claimSingleFlight(env, contentId, crypto.randomUUID());
  if (claim.existingJobId) {
    const existing = await getJob(env, claim.existingJobId);
    if (existing) {
      return c.json(serializeJob(existing, manifest));
    }
  }

  const jobId = claim.jobId;
  const initialStatus = mode === "browser" ? "fallback_ready" : "queued";
  await createJob(env, {
    id: jobId,
    contentId,
    mode,
    status: initialStatus,
    title: manifest.title,
    pageCount: manifest.pageCount,
    manifestToken: token,
  });
  await recordUsage(env, "job_created", contentId, { mode });

  if (mode === "browser") {
    const job = await getJob(env, jobId);
    return c.json(serializeJob(job!, manifest));
  }

  try {
    await env.PDF_WORKFLOW.create({
      id: jobId,
      params: { jobId, contentId },
    });
  } catch (error) {
    await updateJob(env, jobId, {
      status: mode === "auto" ? "fallback_ready" : "failed",
      error: mode === "auto" ? "云端排队暂不可用，已准备本机生成" : String(error),
    });
  }

  const job = await getJob(env, jobId);
  return c.json(serializeJob(job!, manifest));
});

jobsRoute.get("/:jobId", async (c) => {
  const job = await getJob(c.env, c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "任务不存在" }, 404);
  }
  const material = await getMaterial(c.env, job.content_id);
  return c.json(serializeJob(job, materialToManifest(material)));
});

jobsRoute.get("/:jobId/events", async (c) => {
  const jobId = c.req.param("jobId");
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let count = 0;
      const push = async () => {
        const job = await getJob(c.env, jobId);
        if (!job) {
          controller.enqueue(encoder.encode("event: error\ndata: {}\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(serializeJob(job))}\n\n`));
        count += 1;
        if (
          ["succeeded", "failed", "fallback_ready", "canceled"].includes(job.status) ||
          count >= 180
        ) {
          controller.close();
          return;
        }
        setTimeout(push, 1000);
      };
      await push();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
});

export function serializeJob(job: DbJob, manifest?: MaterialManifest | null) {
  return {
    jobId: job.id,
    contentId: job.content_id,
    status: job.status,
    mode: job.mode,
    title: job.title ?? manifest?.title ?? "智慧教育平台教材",
    pageCount: job.page_count ?? manifest?.pageCount ?? 0,
    completedPages: job.completed_pages,
    error: job.error,
    downloadUrl:
      job.status === "succeeded" ? (job.download_url ?? downloadUrl(job.content_id)) : null,
    manifestUrl:
      job.status === "fallback_ready" || job.status === "failed"
        ? `/api/materials/${job.content_id}/manifest?jobId=${job.id}&token=${job.manifest_token}`
        : null,
    updatedAt: job.updated_at,
  };
}

function materialToManifest(
  material: Awaited<ReturnType<typeof getMaterial>>,
): MaterialManifest | null {
  if (!material) {
    return null;
  }
  return {
    contentId: material.content_id,
    title: material.title,
    pageCount: material.page_count,
    imageBasePath: material.image_base_path,
    imageSignature: material.image_signature,
  };
}

function downloadUrl(contentId: string): string {
  return `/api/materials/${contentId}/download`;
}

async function claimSingleFlight(
  env: Env,
  contentId: string,
  jobId: string,
): Promise<{ jobId: string; existingJobId?: string }> {
  const id = env.MATERIAL_COORDINATOR.idFromName(contentId);
  const stub = env.MATERIAL_COORDINATOR.get(id);
  let response: Response;
  try {
    response = await stub.fetch("https://coordinator/claim", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
  } catch {
    return { jobId };
  }
  if (!response.ok) {
    return { jobId };
  }
  return (await response.json()) as { jobId: string; existingJobId?: string };
}
