import { Hono } from "hono";
import type { Env } from "../env";
import { getJob, getMaterial, recordUsage } from "../services/db";
import { proxyPageImage } from "../services/images";

export const materialsRoute = new Hono<{ Bindings: Env }>();

materialsRoute.get("/:contentId/download", async (c) => {
  const contentId = c.req.param("contentId");
  const material = await getMaterial(c.env, contentId);
  if (!material?.pdf_r2_key) {
    return c.json({ error: "PDF 还没有生成" }, 404);
  }
  const object = await c.env.ZHICE_BUCKET.get(material.pdf_r2_key);
  if (!object?.body) {
    return c.json({ error: "缓存文件不存在" }, 404);
  }
  await recordUsage(c.env, "download", contentId);
  const filename = encodeURIComponent(`${safeFilename(material.title)}.pdf`);
  return new Response(object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(object.size),
      "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      "cache-control": "private, max-age=0",
    },
  });
});

materialsRoute.get("/:contentId/manifest", async (c) => {
  const auth = await validateJobToken(
    c.env,
    c.req.param("contentId"),
    c.req.query("jobId"),
    c.req.query("token"),
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, 401);
  }
  const material = await getMaterial(c.env, c.req.param("contentId"));
  if (!material) {
    return c.json({ error: "教材信息不存在" }, 404);
  }
  return c.json({
    contentId: material.content_id,
    title: material.title,
    pageCount: material.page_count,
    token: c.req.query("token"),
    pageUrlTemplate: `/api/page/${material.content_id}/{page}?jobId=${c.req.query("jobId")}&token=${c.req.query("token")}`,
  });
});

export async function validateJobToken(
  env: Env,
  contentId: string,
  jobId?: string,
  token?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!jobId || !token) {
    return { ok: false, error: "缺少任务凭证" };
  }
  const job = await getJob(env, jobId);
  if (!job || job.content_id !== contentId || job.manifest_token !== token) {
    return { ok: false, error: "任务凭证无效" };
  }
  return { ok: true };
}

export const pageRoute = new Hono<{ Bindings: Env }>();

pageRoute.get("/:contentId/:page", async (c) => {
  const contentId = c.req.param("contentId");
  const auth = await validateJobToken(c.env, contentId, c.req.query("jobId"), c.req.query("token"));
  if (!auth.ok) {
    return c.json({ error: auth.error }, 401);
  }
  const material = await getMaterial(c.env, contentId);
  const page = Number(c.req.param("page"));
  if (!material || !Number.isInteger(page) || page < 1 || page > material.page_count) {
    return c.json({ error: "页面不存在" }, 404);
  }
  return proxyPageImage(material.image_base_path, page);
});

function safeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}
