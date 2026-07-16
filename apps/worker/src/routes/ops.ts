import { vValidator } from "@hono/valibot-validator";
import {
  fetchSmartEduManifest,
  parseSmartEduContentId,
  smartEduErrorMessage,
  type MaterialManifest,
} from "@zhice/core";
import { Hono } from "hono";
import * as v from "valibot";
import { getPdfConfig } from "../config";
import type { Env } from "../env";
import { serializeJob } from "./jobs";
import {
  createJob,
  getJob,
  getMaterial,
  invalidateMaterialArtifact,
  recordUsage,
  stats,
  updateJob,
  upsertMaterial,
} from "../services/db";
import { requireOpsToken } from "../services/security";

export const opsRoute = new Hono<{ Bindings: Env }>();

const OpsVerifySchema = v.object({
  url: v.pipe(v.string(), v.trim(), v.minLength(1, "请提供教材页面链接")),
  purge: v.optional(v.boolean(), false),
});

opsRoute.use("*", async (c, next) => {
  const response = requireOpsToken(c.req.raw, c.env);
  if (response) {
    return response;
  }
  await next();
});

opsRoute.get("/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

opsRoute.get("/stats", async (c) => c.json(await stats(c.env)));

opsRoute.post("/verify", vValidator("json", OpsVerifySchema), async (c) => {
  const env = c.env;
  const input = c.req.valid("json");
  const config = getPdfConfig(env as unknown as Record<string, unknown>);

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
  if (input.purge) {
    await purgeMaterialCache(env, contentId);
  }

  const token = crypto.randomUUID();
  const material = await getMaterial(env, contentId);

  // Hot cache check.
  if (material?.status === "ready" && material.pdf_r2_key) {
    const job = await createJob(env, {
      id: crypto.randomUUID(),
      contentId,
      mode: "cloud",
      status: "succeeded",
      title: manifest.title,
      pageCount: manifest.pageCount,
      manifestToken: token,
      downloadUrl: cdnOrLegacyUrl(config.publicBaseUrl, material),
    });
    await recordUsage(env, "cache_hit", contentId, { source: "ops_verify" });
    return c.json(serializeJob(job, manifest));
  }

  // Claim single-flight before starting.
  const claim = await claimSingleFlight(env, contentId, crypto.randomUUID());
  const jobId = claim.jobId;

  const job = await createJob(env, {
    id: jobId,
    contentId,
    mode: "cloud",
    status: "queued",
    title: manifest.title,
    pageCount: manifest.pageCount,
    manifestToken: token,
    generatorVersion: config.generatorVersion,
  });
  await recordUsage(env, "job_created", contentId, { mode: "cloud", source: "ops_verify" });
  await env.PDF_WORKFLOW.create({
    id: jobId,
    params: { jobId, contentId },
  });
  return c.json(serializeJob(job, manifest));
});

opsRoute.post("/jobs/:jobId/retry", async (c) => {
  const env = c.env;
  const job = await getJob(env, c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "任务不存在" }, 404);
  }

  // Claim single-flight before retrying.
  const claim = await claimSingleFlight(env, job.content_id, job.id);
  if (claim.existingJobId) {
    return c.json({ error: "该教材已有正在进行的任务", existingJobId: claim.existingJobId }, 409);
  }

  await updateJob(env, job.id, {
    status: "queued",
    error: null,
    completedPages: 0,
    finishedAt: null,
  });
  await env.PDF_WORKFLOW.create({
    id: `${job.id}-retry-${Date.now()}`,
    params: { jobId: job.id, contentId: job.content_id },
  });
  return c.json({ ok: true });
});

opsRoute.delete("/materials/:contentId", async (c) => {
  const env = c.env;
  const material = await getMaterial(env, c.req.param("contentId"));
  if (!material) {
    return c.json({ ok: true });
  }

  // Force-release lease if active.
  const force = c.req.query("force") === "true";
  if (force) {
    await forceReleaseLease(env, material.content_id);
  }

  await purgeMaterialCache(env, material.content_id);

  // Return CDN URL for manual purge if configured.
  const config = getPdfConfig(env as unknown as Record<string, unknown>);
  const cdnUrl =
    material.pdf_r2_key && config.publicBaseUrl
      ? `${config.publicBaseUrl.replace(/\/+$/, "")}/${material.pdf_r2_key}`
      : null;

  return c.json({ ok: true, cdnUrl });
});

opsRoute.post("/materials/:contentId/regenerate", async (c) => {
  const env = c.env;
  const config = getPdfConfig(env as unknown as Record<string, unknown>);
  const contentId = c.req.param("contentId");

  const material = await getMaterial(env, contentId);
  if (!material) {
    return c.json(
      { error: "教材信息不存在，请先通过 POST /api/jobs 建立。先去主站提交一次即可。" },
      404,
    );
  }

  // Clear old artifact.
  if (material.pdf_r2_key) {
    await env.ZHICE_BUCKET.delete(material.pdf_r2_key);
  }
  await invalidateMaterialArtifact(env, contentId);

  // Force-release lease to allow new generation.
  await forceReleaseLease(env, contentId);

  const token = crypto.randomUUID();
  const jobId = crypto.randomUUID();

  // Claim the new lease.
  await claimSingleFlight(env, contentId, jobId);

  const job = await createJob(env, {
    id: jobId,
    contentId,
    mode: "cloud",
    status: "queued",
    title: material.title,
    pageCount: material.page_count,
    manifestToken: token,
    generatorVersion: config.generatorVersion,
  });

  await recordUsage(env, "job_created", contentId, { mode: "cloud", source: "ops_regenerate" });
  await env.PDF_WORKFLOW.create({
    id: jobId,
    params: { jobId, contentId },
  });

  return c.json(
    serializeJob(job, {
      contentId: material.content_id,
      title: material.title,
      pageCount: material.page_count,
      imageBasePath: material.image_base_path,
      imageSignature: material.image_signature,
    }),
  );
});

async function purgeMaterialCache(env: Env, contentId: string): Promise<void> {
  const material = await getMaterial(env, contentId);
  if (!material) {
    return;
  }
  if (material.pdf_r2_key) {
    await env.ZHICE_BUCKET.delete(material.pdf_r2_key);
  }
  await env.ZHICE_DB.prepare(
    "UPDATE materials SET status = 'resolved', pdf_r2_key = NULL, pdf_size = NULL, pdf_etag = NULL, pdf_version = NULL, updated_at = ? WHERE content_id = ?",
  )
    .bind(Date.now(), contentId)
    .run();
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

async function forceReleaseLease(env: Env, contentId: string): Promise<void> {
  const id = env.MATERIAL_COORDINATOR.idFromName(contentId);
  const stub = env.MATERIAL_COORDINATOR.get(id);
  await stub.fetch("https://coordinator/force-release", {
    method: "POST",
  });
}

function cdnOrLegacyUrl(
  publicBaseUrl: string,
  material: NonNullable<Awaited<ReturnType<typeof getMaterial>>>,
): string {
  if (publicBaseUrl && material.pdf_r2_key) {
    return `${publicBaseUrl.replace(/\/+$/, "")}/${material.pdf_r2_key}`;
  }
  return `/api/materials/${material.content_id}/download`;
}
