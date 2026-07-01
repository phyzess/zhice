import type { DbJob, DbMaterial, Env } from "../env";
import type { MaterialManifest } from "@zhice/core";

const now = () => Date.now();

export async function getMaterial(env: Env, contentId: string): Promise<DbMaterial | null> {
  return await env.ZHICE_DB.prepare("SELECT * FROM materials WHERE content_id = ?")
    .bind(contentId)
    .first<DbMaterial>();
}

export async function upsertMaterial(
  env: Env,
  manifest: MaterialManifest,
  status: DbMaterial["status"],
): Promise<void> {
  const timestamp = now();
  await env.ZHICE_DB.prepare(
    `INSERT INTO materials
      (content_id, title, page_count, image_base_path, image_signature, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(content_id) DO UPDATE SET
      title = excluded.title,
      page_count = excluded.page_count,
      image_base_path = excluded.image_base_path,
      image_signature = excluded.image_signature,
      status = CASE
        WHEN materials.pdf_r2_key IS NOT NULL AND materials.image_signature = excluded.image_signature THEN materials.status
        ELSE excluded.status
      END,
      updated_at = excluded.updated_at`,
  )
    .bind(
      manifest.contentId,
      manifest.title,
      manifest.pageCount,
      manifest.imageBasePath,
      manifest.imageSignature,
      status,
      timestamp,
      timestamp,
    )
    .run();
}

export async function markMaterialReady(
  env: Env,
  contentId: string,
  r2Key: string,
  size: number,
): Promise<void> {
  await env.ZHICE_DB.prepare(
    `UPDATE materials
     SET status = 'ready', pdf_r2_key = ?, pdf_size = ?, error = NULL, updated_at = ?
     WHERE content_id = ?`,
  )
    .bind(r2Key, size, now(), contentId)
    .run();
}

export async function markMaterialFailed(
  env: Env,
  contentId: string,
  error: string,
): Promise<void> {
  await env.ZHICE_DB.prepare(
    `UPDATE materials
     SET status = 'failed', error = ?, updated_at = ?
     WHERE content_id = ?`,
  )
    .bind(error, now(), contentId)
    .run();
}

export async function createJob(
  env: Env,
  input: {
    id: string;
    contentId: string;
    mode: "auto" | "cloud" | "browser";
    status: DbJob["status"];
    title?: string;
    pageCount?: number;
    manifestToken: string;
    downloadUrl?: string;
  },
): Promise<void> {
  const timestamp = now();
  await env.ZHICE_DB.prepare(
    `INSERT INTO jobs
      (id, content_id, mode, status, title, page_count, completed_pages, download_url, manifest_token, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.contentId,
      input.mode,
      input.status,
      input.title ?? null,
      input.pageCount ?? null,
      input.status === "succeeded" ? (input.pageCount ?? 0) : 0,
      input.downloadUrl ?? null,
      input.manifestToken,
      timestamp,
      timestamp,
      input.status === "succeeded" ? timestamp : null,
    )
    .run();
}

export async function getJob(env: Env, jobId: string): Promise<DbJob | null> {
  return await env.ZHICE_DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<DbJob>();
}

export async function updateJob(
  env: Env,
  jobId: string,
  updates: Partial<{
    status: DbJob["status"];
    title: string;
    pageCount: number;
    completedPages: number;
    downloadUrl: string | null;
    error: string | null;
    finishedAt: number | null;
  }>,
): Promise<void> {
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now()];
  if (updates.status) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }
  if (updates.pageCount !== undefined) {
    fields.push("page_count = ?");
    values.push(updates.pageCount);
  }
  if (updates.completedPages !== undefined) {
    fields.push("completed_pages = ?");
    values.push(updates.completedPages);
  }
  if (updates.downloadUrl !== undefined) {
    fields.push("download_url = ?");
    values.push(updates.downloadUrl);
  }
  if (updates.error !== undefined) {
    fields.push("error = ?");
    values.push(updates.error);
  }
  if (updates.finishedAt !== undefined) {
    fields.push("finished_at = ?");
    values.push(updates.finishedAt);
  }
  values.push(jobId);
  await env.ZHICE_DB.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function recordUsage(
  env: Env,
  eventType:
    | "job_created"
    | "cache_hit"
    | "cloud_succeeded"
    | "cloud_failed"
    | "browser_fallback"
    | "download",
  contentId?: string,
  detail?: unknown,
): Promise<void> {
  await env.ZHICE_DB.prepare(
    `INSERT INTO usage_events (id, content_id, event_type, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      contentId ?? null,
      eventType,
      detail ? JSON.stringify(detail) : null,
      now(),
    )
    .run();
}

export async function stats(env: Env): Promise<unknown> {
  const jobs = await env.ZHICE_DB.prepare(
    "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status",
  ).all();
  const events = await env.ZHICE_DB.prepare(
    "SELECT event_type, COUNT(*) AS count FROM usage_events GROUP BY event_type",
  ).all();
  const materials = await env.ZHICE_DB.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(pdf_size), 0) AS bytes FROM materials WHERE status = 'ready'",
  ).first();
  return { jobs: jobs.results, events: events.results, materials };
}
