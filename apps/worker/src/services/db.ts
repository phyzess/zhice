import type { DbJob, DbMaterial, Env } from "../env";
import type { MaterialManifest } from "@zhice/core";

const now = () => Date.now();

// ── Material queries ─────────────────────────────────────────────

export async function getMaterial(env: Env, contentId: string): Promise<DbMaterial | null> {
  return await env.ZHICE_DB.prepare("SELECT * FROM materials WHERE content_id = ?")
    .bind(contentId)
    .first<DbMaterial>();
}

/**
 * Fast-path: fetch a ready material + check manifest freshness.
 * Returns null if no ready material exists.
 */
export async function getFreshReadyMaterial(
  env: Env,
  contentId: string,
  _manifestTtlMs: number,
): Promise<DbMaterial | null> {
  const raw = await env.ZHICE_DB.prepare(
    `SELECT * FROM materials
     WHERE content_id = ? AND status = 'ready'
     AND pdf_r2_key IS NOT NULL`,
  )
    .bind(contentId)
    .first<DbMaterial>();

  if (!raw) {
    return null;
  }

  // If no checked time or stale, the caller handles revalidation.
  // We still return the material so the user gets the cached PDF.
  return raw;
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
      manifest_checked_at = excluded.updated_at,
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

/**
 * Revalidate a material manifest. If the image signature changed,
 * clear the old artifact references so the next request regenerates.
 */
export async function revalidateMaterial(
  env: Env,
  contentId: string,
  manifest: MaterialManifest,
): Promise<void> {
  const timestamp = now();
  const existing = await getMaterial(env, contentId);

  if (!existing || existing.image_signature === manifest.imageSignature) {
    // Signature matches — just bump the checked time and update title/pageCount.
    await env.ZHICE_DB.prepare(
      `UPDATE materials
       SET title = ?, page_count = ?, manifest_checked_at = ?, updated_at = ?
       WHERE content_id = ?`,
    )
      .bind(manifest.title, manifest.pageCount, timestamp, timestamp, contentId)
      .run();
    return;
  }

  // Signature changed — clear old artifact references.
  await env.ZHICE_DB.prepare(
    `UPDATE materials
     SET title = ?, page_count = ?,
         image_base_path = ?, image_signature = ?,
         pdf_r2_key = NULL, pdf_size = NULL, pdf_etag = NULL, pdf_version = NULL,
         status = 'resolved', error = NULL,
         manifest_checked_at = ?, updated_at = ?
     WHERE content_id = ?`,
  )
    .bind(
      manifest.title,
      manifest.pageCount,
      manifest.imageBasePath,
      manifest.imageSignature,
      timestamp,
      timestamp,
      contentId,
    )
    .run();
}

/**
 * Atomically commit a completed material + job + usage event.
 * Uses a conditional update on image_signature to prevent an old
 * workflow from overwriting a newer manifest.
 */
export async function completeGeneration(
  env: Env,
  contentId: string,
  imageSignature: string,
  r2Key: string,
  size: number,
  etag: string,
  pdfVersion: string,
  generatorVersion: string,
  jobId: string,
  pageCount: number,
  metrics?: Record<string, unknown>,
): Promise<boolean> {
  const timestamp = now();

  // Use batch for atomicity.
  const results = await env.ZHICE_DB.batch([
    // 1. Conditional update on materials — only if image_signature still matches.
    env.ZHICE_DB.prepare(
      `UPDATE materials
       SET status = 'ready',
           pdf_r2_key = ?, pdf_size = ?, pdf_etag = ?, pdf_version = ?,
           error = NULL, updated_at = ?
       WHERE content_id = ? AND image_signature = ?`,
    ).bind(r2Key, size, etag, pdfVersion, timestamp, contentId, imageSignature),

    // 2. Update job to succeeded.
    env.ZHICE_DB.prepare(
      `UPDATE jobs
       SET status = 'succeeded', completed_pages = ?, error = NULL,
           finished_at = ?, generator_version = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(pageCount, timestamp, generatorVersion, timestamp, jobId),

    // 3. Record usage event.
    env.ZHICE_DB.prepare(
      `INSERT INTO usage_events (id, content_id, event_type, detail, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      contentId,
      "cloud_succeeded",
      JSON.stringify({ bytes: size, pages: pageCount, generatorVersion, ...metrics }),
      timestamp,
    ),
  ]);

  // Check if the material update affected any row.
  const materialResult = results[0];
  return materialResult.meta.changed_db === true || (materialResult.meta.rows_written ?? 0) > 0;
}

/**
 * Atomically commit a failed generation: material → failed, job → fallback_ready.
 */
export async function failGeneration(
  env: Env,
  contentId: string,
  jobId: string,
  error: string,
): Promise<void> {
  const timestamp = now();
  await env.ZHICE_DB.batch([
    env.ZHICE_DB.prepare(
      `UPDATE materials
       SET status = 'failed', error = ?, updated_at = ?
       WHERE content_id = ?`,
    ).bind(error, timestamp, contentId),

    env.ZHICE_DB.prepare(
      `UPDATE jobs
       SET status = 'fallback_ready', error = '云端生成失败，已准备本机生成',
           finished_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(timestamp, timestamp, jobId),

    env.ZHICE_DB.prepare(
      `INSERT INTO usage_events (id, content_id, event_type, detail, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), contentId, "cloud_failed", JSON.stringify({ error }), timestamp),
  ]);
}

export async function invalidateMaterialArtifact(env: Env, contentId: string): Promise<void> {
  await env.ZHICE_DB.prepare(
    `UPDATE materials
     SET pdf_r2_key = NULL, pdf_size = NULL, pdf_etag = NULL, pdf_version = NULL,
         status = 'resolved', error = NULL, updated_at = ?
     WHERE content_id = ?`,
  )
    .bind(now(), contentId)
    .run();
}

// Legacy compatibility — keep old function signatures for incremental migration.
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

// ── Job queries ───────────────────────────────────────────────────

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
    generatorVersion?: string;
  },
): Promise<DbJob> {
  const timestamp = now();
  const genVersion = input.generatorVersion ?? "v2";
  await env.ZHICE_DB.prepare(
    `INSERT INTO jobs
      (id, content_id, mode, status, title, page_count, completed_pages, download_url, manifest_token, generator_version, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      genVersion,
      timestamp,
      timestamp,
      input.status === "succeeded" ? timestamp : null,
    )
    .run();

  // Return the constructed job without a second read.
  return {
    id: input.id,
    content_id: input.contentId,
    mode: input.mode,
    status: input.status,
    title: input.title ?? null,
    page_count: input.pageCount ?? null,
    completed_pages: input.status === "succeeded" ? (input.pageCount ?? 0) : 0,
    download_url: input.downloadUrl ?? null,
    manifest_token: input.manifestToken,
    generator_version: genVersion,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    finished_at: input.status === "succeeded" ? timestamp : null,
  };
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

// ── Stats ─────────────────────────────────────────────────────────

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

  // Extended stats.
  const recent = await env.ZHICE_DB.prepare(
    `SELECT event_type, COUNT(*) AS count
     FROM usage_events
     WHERE created_at > ?
     GROUP BY event_type`,
  )
    .bind(now() - 60 * 60 * 1000)
    .all();

  const avgSize = await env.ZHICE_DB.prepare(
    "SELECT COALESCE(AVG(pdf_size), 0) AS avg FROM materials WHERE status = 'ready' AND pdf_size IS NOT NULL",
  ).first();

  const queuedStale = await env.ZHICE_DB.prepare(
    "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued' AND updated_at < ?",
  )
    .bind(now() - 5 * 60 * 1000)
    .first();

  const failedMaterials = await env.ZHICE_DB.prepare(
    "SELECT COUNT(*) AS count FROM materials WHERE status = 'failed'",
  ).first();

  return {
    jobs: jobs.results,
    events: events.results,
    materials,
    lastHourEvents: recent.results,
    avgPdfSize: avgSize,
    queuedOver5min: queuedStale,
    failedMaterials,
  };
}
