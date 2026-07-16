import { vValidator } from "@hono/valibot-validator";
import {
  CreateJobSchema,
  fetchSmartEduManifest,
  parseSmartEduContentId,
  smartEduErrorMessage,
  type MaterialManifest,
} from "@zhice/core";
import { Hono } from "hono";
import { getPdfConfig } from "../config";
import type { DbJob, Env } from "../env";
import {
  createJob,
  getFreshReadyMaterial,
  getJob,
  getMaterial,
  recordUsage,
  revalidateMaterial,
  updateJob,
  upsertMaterial,
} from "../services/db";
import { checkRateLimit } from "../services/security";

export const jobsRoute = new Hono<{ Bindings: Env }>();

jobsRoute.post("/", vValidator("json", CreateJobSchema), async (c) => {
  const env = c.env;
  const input = c.req.valid("json");
  const remoteIp = c.req.header("CF-Connecting-IP") ?? null;
  const config = getPdfConfig(env as unknown as Record<string, unknown>);

  if (!(await checkRateLimit(env, remoteIp, "create-job"))) {
    return c.json({ error: "提交太频繁，请稍后再试" }, 429);
  }

  let contentId: string;
  try {
    contentId = parseSmartEduContentId(input.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "链接无效" }, 400);
  }

  const mode = input.mode ?? "auto";
  const token = crypto.randomUUID();

  // ── Hot cache fast path: check D1 only (no upstream, no R2 head) ──
  const cached = await getFreshReadyMaterial(env, contentId, config.manifestTtlMs);

  if (cached?.status === "ready" && cached.pdf_r2_key) {
    // Determine download URL: v2 artifacts go to CDN, v1/legacy go through Worker.
    const downloadUrl = cached.pdf_version
      ? cdnDownloadUrl(config.publicBaseUrl, cached.pdf_r2_key)
      : legacyDownloadUrl(contentId);

    const job = await createJob(env, {
      id: crypto.randomUUID(),
      contentId,
      mode,
      status: "succeeded",
      title: cached.title,
      pageCount: cached.page_count,
      manifestToken: token,
      downloadUrl,
      generatorVersion: config.generatorVersion,
    });

    await recordUsage(env, "cache_hit", contentId);
    console.log(
      JSON.stringify({
        type: "pdf_cache_hit",
        contentId,
        jobId: job.id,
      }),
    );

    // ── Background revalidation (fire-and-forget) ──
    const checkedAt = cached.manifest_checked_at ?? 0;
    if (Date.now() - checkedAt > config.manifestTtlMs) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const manifest = await fetchSmartEduManifest(contentId);
            await revalidateMaterial(env, contentId, manifest);
            console.log(
              JSON.stringify({
                type: "pdf_manifest_revalidated",
                contentId,
                signatureChanged: manifest.imageSignature !== cached.image_signature,
              }),
            );
          } catch (error) {
            // Background revalidation failure — keep serving the old PDF.
            console.log(
              JSON.stringify({
                type: "pdf_manifest_revalidation_failed",
                contentId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        })(),
      );
    }

    return c.json(serializeJob(job, cached));
  }

  // ── Cold path: fetch manifest, claim single-flight, start workflow ──
  let manifest: MaterialManifest;
  try {
    manifest = await fetchSmartEduManifest(contentId);
  } catch (error) {
    return c.json({ error: smartEduErrorMessage(error) }, 502);
  }

  await upsertMaterial(env, manifest, "resolved");

  const claim = await claimSingleFlight(env, contentId, crypto.randomUUID());
  if (claim.existingJobId) {
    const existing = await getJob(env, claim.existingJobId);
    if (existing) {
      return c.json(serializeJob(existing, manifest));
    }
  }

  const jobId = claim.jobId;
  const initialStatus = mode === "browser" ? "fallback_ready" : "queued";
  const job = await createJob(env, {
    id: jobId,
    contentId,
    mode,
    status: initialStatus,
    title: manifest.title,
    pageCount: manifest.pageCount,
    manifestToken: token,
    generatorVersion: config.generatorVersion,
  });
  await recordUsage(env, "job_created", contentId, { mode });

  if (mode === "browser") {
    return c.json(serializeJob(job, manifest));
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

  const updated = await getJob(env, jobId);
  return c.json(serializeJob(updated!, manifest));
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
  const env = c.env;
  const jobId = c.req.param("jobId");
  const signal = c.req.raw.signal;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let count = 0;
      const maxPolls = 600; // 10 minutes at 1s interval

      const push = async () => {
        // Stop if client disconnected or aborted.
        if (signal.aborted) {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          return;
        }

        try {
          const job = await getJob(env, jobId);
          if (!job) {
            controller.enqueue(encoder.encode("event: error\ndata: {}\n\n"));
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(serializeJob(job))}\n\n`));
          count += 1;

          if (["succeeded", "failed", "fallback_ready", "canceled"].includes(job.status)) {
            controller.close();
            return;
          }

          if (count >= maxPolls) {
            controller.close();
            return;
          }

          // Send heartbeat every 15s to keep connection alive.
          if (count % 15 === 0) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        } catch (_error) {
          // Enqueue failure — client likely disconnected.
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          return;
        }
      };

      // Initial push.
      await push();

      // Poll interval.
      const interval = setInterval(async () => {
        await push();
        if (signal.aborted) {
          clearInterval(interval);
        }
      }, 1000);

      // Clean up on abort.
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(interval);
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
});

export function serializeJob(job: DbJob, manifest?: MaterialManifest | DbMaterial | null) {
  const material = manifest as DbMaterial | null;
  return {
    jobId: job.id,
    contentId: job.content_id,
    status: job.status,
    mode: job.mode,
    title: job.title ?? material?.title ?? "智慧教育平台教材",
    pageCount: job.page_count ?? material?.page_count ?? 0,
    completedPages: job.completed_pages,
    error: job.error,
    downloadUrl:
      job.status === "succeeded" ? (job.download_url ?? legacyDownloadUrl(job.content_id)) : null,
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

function legacyDownloadUrl(contentId: string): string {
  return `/api/materials/${contentId}/download`;
}

function cdnDownloadUrl(publicBaseUrl: string, r2Key: string): string {
  if (!publicBaseUrl) {
    return "";
  }
  return `${publicBaseUrl.replace(/\/+$/, "")}/${r2Key}`;
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
  const body = (await response.json()) as { jobId: string; existingJobId?: string };
  return body;
}
