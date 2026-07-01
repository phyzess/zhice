import { vValidator } from "@hono/valibot-validator";
import {
  fetchSmartEduManifest,
  parseSmartEduContentId,
  smartEduErrorMessage,
  type MaterialManifest,
} from "@zhice/core";
import { Hono } from "hono";
import * as v from "valibot";
import type { Env } from "../env";
import { serializeJob } from "./jobs";
import {
  createJob,
  getJob,
  getMaterial,
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
  const input = c.req.valid("json");
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

  await upsertMaterial(c.env, manifest, "resolved");
  if (input.purge) {
    await purgeMaterialCache(c.env, contentId);
  }

  const token = crypto.randomUUID();
  const material = await getMaterial(c.env, contentId);
  const cachedObject =
    material?.status === "ready" && material.pdf_r2_key
      ? await c.env.ZHICE_BUCKET.head(material.pdf_r2_key)
      : null;
  if (material?.pdf_r2_key && cachedObject) {
    const jobId = crypto.randomUUID();
    await createJob(c.env, {
      id: jobId,
      contentId,
      mode: "cloud",
      status: "succeeded",
      title: manifest.title,
      pageCount: manifest.pageCount,
      manifestToken: token,
      downloadUrl: `/api/materials/${contentId}/download`,
    });
    await recordUsage(c.env, "cache_hit", contentId, { source: "ops_verify" });
    const job = await getJob(c.env, jobId);
    return c.json(serializeJob(job!, manifest));
  }

  const jobId = crypto.randomUUID();
  await createJob(c.env, {
    id: jobId,
    contentId,
    mode: "cloud",
    status: "queued",
    title: manifest.title,
    pageCount: manifest.pageCount,
    manifestToken: token,
  });
  await recordUsage(c.env, "job_created", contentId, { mode: "cloud", source: "ops_verify" });
  await c.env.PDF_WORKFLOW.create({
    id: jobId,
    params: { jobId, contentId },
  });
  const job = await getJob(c.env, jobId);
  return c.json(serializeJob(job!, manifest));
});

opsRoute.post("/jobs/:jobId/retry", async (c) => {
  const job = await getJob(c.env, c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "任务不存在" }, 404);
  }
  await updateJob(c.env, job.id, {
    status: "queued",
    error: null,
    completedPages: 0,
    finishedAt: null,
  });
  await c.env.PDF_WORKFLOW.create({
    id: `${job.id}-retry-${Date.now()}`,
    params: { jobId: job.id, contentId: job.content_id },
  });
  return c.json({ ok: true });
});

opsRoute.delete("/materials/:contentId", async (c) => {
  const material = await getMaterial(c.env, c.req.param("contentId"));
  if (!material) {
    return c.json({ ok: true });
  }
  await purgeMaterialCache(c.env, material.content_id);
  return c.json({ ok: true });
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
    "UPDATE materials SET status = 'resolved', pdf_r2_key = NULL, pdf_size = NULL, updated_at = ? WHERE content_id = ?",
  )
    .bind(Date.now(), material.content_id)
    .run();
}
