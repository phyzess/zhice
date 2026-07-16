import { Hono } from "hono";
import { getPdfConfig } from "../config";
import type { Env } from "../env";
import { getJob, getMaterial, recordUsage } from "../services/db";
import { proxyPageImage } from "../services/images";

export const materialsRoute = new Hono<{ Bindings: Env }>();

materialsRoute.get("/:contentId/download", async (c) => {
  const env = c.env;
  const contentId = c.req.param("contentId");
  const config = getPdfConfig(env as unknown as Record<string, unknown>);

  const material = await getMaterial(env, contentId);
  if (!material) {
    return c.json({ error: "PDF 还没有生成" }, 404);
  }

  // ── v2 artifact: 302 redirect to R2 CDN ──
  if (material.pdf_version && material.pdf_r2_key && config.publicBaseUrl) {
    const cdnUrl = `${config.publicBaseUrl.replace(/\/+$/, "")}/${material.pdf_r2_key}`;

    // Record download asynchronously.
    c.executionCtx.waitUntil(recordUsage(env, "download", contentId));

    console.log(
      JSON.stringify({
        type: "pdf_download_redirected",
        contentId,
        pdfVersion: material.pdf_version,
      }),
    );

    return new Response(null, {
      status: 302,
      headers: {
        location: cdnUrl,
        "cache-control": "no-store",
      },
    });
  }

  // ── v1 legacy or CDN fallback: serve directly from R2 Worker binding ──
  if (!material.pdf_r2_key) {
    return c.json({ error: "PDF 还没有生成" }, 404);
  }

  // Record download asynchronously.
  c.executionCtx.waitUntil(recordUsage(env, "download", contentId));

  // Forward request headers for Range/conditional requests.
  const requestHeaders = new Headers();
  const range = c.req.header("Range");
  const ifNoneMatch = c.req.header("If-None-Match");
  const ifModifiedSince = c.req.header("If-Modified-Since");

  if (range) {
    requestHeaders.set("Range", range);
  }
  if (ifNoneMatch) {
    requestHeaders.set("If-None-Match", ifNoneMatch);
  }
  if (ifModifiedSince) {
    requestHeaders.set("If-Modified-Since", ifModifiedSince);
  }

  const object = await env.ZHICE_BUCKET.get(material.pdf_r2_key, {
    range: requestHeaders,
    onlyIf: requestHeaders,
  });

  if (!object) {
    // Check if the key exists at all.
    const head = await env.ZHICE_BUCKET.head(material.pdf_r2_key);
    if (!head) {
      return c.json({ error: "缓存文件不存在" }, 404);
    }
    // Key exists but range/conditional didn't match.
    return new Response(null, { status: 416 });
  }

  const responseHeaders = new Headers();
  responseHeaders.set("content-type", object.httpMetadata?.contentType ?? "application/pdf");
  responseHeaders.set("accept-ranges", "bytes");

  if (object.range) {
    responseHeaders.set(
      "content-range",
      `bytes ${object.range.offset}-${object.range.offset + (object.size - 1)}/${headSize(object)}`,
    );
  }

  if (object.size) {
    responseHeaders.set("content-length", String(object.size));
  }

  if (object.httpEtag) {
    responseHeaders.set("etag", object.httpEtag);
  }

  const filename = encodeURIComponent(`${safeFilename(material.title)}.pdf`);
  responseHeaders.set("content-disposition", `attachment; filename*=UTF-8''${filename}`);
  responseHeaders.set("cache-control", "private, max-age=0");

  const status = object.range ? 206 : ifNoneMatch && object.httpEtag === ifNoneMatch ? 304 : 200;

  if (status === 304) {
    return new Response(null, { status: 304, headers: responseHeaders });
  }

  return new Response(object.body, {
    status,
    headers: responseHeaders,
  });
});

function headSize(object: R2ObjectBody | R2Object): number {
  // R2ObjectBody might not have size directly when using range; use the stored size.
  // The object from get() with range should have .size on the response.
  return object.size;
}

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
