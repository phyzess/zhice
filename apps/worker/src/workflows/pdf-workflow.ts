import { buildPdfVersionKey, buildR2Key, PdfWriter, type MaterialManifest } from "@zhice/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getPdfConfig } from "../config";
import type { Env, PdfWorkflowParams } from "../env";
import { completeGeneration, failGeneration, getMaterial, updateJob } from "../services/db";
import { prefetchPagesInOrder } from "../services/images";
import { R2MultipartPdfSink } from "../services/r2-multipart-sink";
import { HeaderSemaphore } from "../services/concurrency";

export class PdfWorkflow extends WorkflowEntrypoint<Env, PdfWorkflowParams> {
  async run(event: WorkflowEvent<PdfWorkflowParams>, step: WorkflowStep): Promise<void> {
    const payload = event.payload;
    const config = getPdfConfig(this.env as unknown as Record<string, unknown>);

    // Step 1: Resolve manifest.
    const manifest = await step.do("resolve manifest", async () => {
      await updateJob(this.env, payload.jobId, { status: "resolving" });
      const material = await getMaterial(this.env, payload.contentId);
      if (material) {
        return {
          contentId: material.content_id,
          title: material.title,
          pageCount: material.page_count,
          imageBasePath: material.image_base_path,
          imageSignature: material.image_signature,
        } satisfies MaterialManifest;
      }
      // If material isn't in DB (shouldn't happen), the caller must ensure it's upserted first.
      throw new Error("Material not found in database");
    });

    // Step 2: Renew single-flight lease.
    await step.do("renew single flight", async () => {
      await renewSingleFlight(this.env, payload.contentId, payload.jobId);
    });

    // Step 3: Generate artifact (idempotent).
    const result = await step.do(
      "generate artifact",
      {
        timeout: "20 minutes",
      },
      async () => {
        return generateArtifact(this.env, payload, manifest, config);
      },
    );

    // Step 4: Commit ready state (atomically).
    const committed = await step.do("commit ready state", async () => {
      return completeGeneration(
        this.env,
        payload.contentId,
        manifest.imageSignature,
        result.r2Key,
        result.size,
        result.etag,
        result.pdfVersion,
        config.generatorVersion,
        payload.jobId,
        manifest.pageCount,
        result.metrics,
      );
    });

    if (!committed) {
      // Manifest changed during generation — clean up and mark as canceled.
      await deleteR2Object(this.env, result.r2Key);
      await updateJob(this.env, payload.jobId, {
        status: "canceled",
        error: "教材版本已更新，请重新提交",
        finishedAt: Date.now(),
      });
    }

    // Step 5: Release single-flight.
    await step.do("release single flight", async () => {
      await releaseSingleFlight(this.env, payload.contentId, payload.jobId);
    });
  }
}

type ArtifactResult = {
  r2Key: string;
  size: number;
  etag: string;
  pdfVersion: string;
  metrics: Record<string, unknown>;
};

async function generateArtifact(
  env: Env,
  params: PdfWorkflowParams,
  manifest: MaterialManifest,
  config: ReturnType<typeof getPdfConfig>,
): Promise<ArtifactResult> {
  const pdfVersion = await buildPdfVersionKey(manifest.imageSignature, config.generatorVersion);
  const r2Key = buildR2Key(manifest.contentId, pdfVersion);

  // Idempotency: check if object already exists.
  const existing = await env.ZHICE_BUCKET.head(r2Key);
  if (existing) {
    const customMeta = existing.customMetadata ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = customMeta as Record<string, any>;
    if (meta.pdfVersion === pdfVersion) {
      console.log(
        JSON.stringify({
          type: "pdf_generation_idempotent",
          contentId: manifest.contentId,
          r2Key,
        }),
      );
      return {
        r2Key,
        size: existing.size,
        etag: existing.httpEtag ?? "",
        pdfVersion,
        metrics: { reused: true },
      };
    }
    // Object exists but metadata doesn't match — delete and regenerate.
    await env.ZHICE_BUCKET.delete(r2Key);
  }

  const start = Date.now();
  const semaphore = new HeaderSemaphore(config.fetchConcurrency + config.uploadConcurrency);

  const sink = await R2MultipartPdfSink.create(env.ZHICE_BUCKET, r2Key, {
    partSize: config.partSizeBytes,
    uploadConcurrency: config.uploadConcurrency,
    semaphore,
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(manifest.title))}.pdf`,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      contentId: manifest.contentId,
      pdfVersion,
      generatorVersion: config.generatorVersion,
      pageCount: String(manifest.pageCount),
    },
  });

  const writer = new PdfWriter(sink, { title: manifest.title });

  let pageRetries = 0;
  let fetchStart = 0;
  let fetchAggregate = 0;
  let lastProgressPage = 0;

  try {
    await updateJob(env, params.jobId, {
      status: "generating",
      title: manifest.title,
      pageCount: manifest.pageCount,
    });

    await env.ZHICE_DB.prepare(
      "UPDATE materials SET status = 'generating', updated_at = ? WHERE content_id = ?",
    )
      .bind(Date.now(), manifest.contentId)
      .run();

    await writer.start();
    fetchStart = Date.now();

    for await (const { bytes } of prefetchPagesInOrder(manifest, {
      concurrency: config.fetchConcurrency,
      semaphore,
      onPageFetched: (page) => {
        // Update progress every 10 pages or at least 1 second apart.
        const now = Date.now();
        if (page % 10 === 0 || page === manifest.pageCount || now - lastProgressPage >= 1000) {
          lastProgressPage = now;
          env.ZHICE_DB.prepare("UPDATE jobs SET completed_pages = ?, updated_at = ? WHERE id = ?")
            .bind(page, now, params.jobId)
            .run()
            .catch(() => {
              // Fire-and-forget progress update — best effort.
            });
        }
      },
    })) {
      await writer.addJpegPage({ bytes });
    }

    fetchAggregate = Date.now() - fetchStart;

    // Signal uploading phase.
    await updateJob(env, params.jobId, {
      status: "uploading",
      completedPages: manifest.pageCount,
    });

    await writer.finish();

    const uploadStart = Date.now();
    const result = await sink.complete();
    const uploadDrainMs = Date.now() - uploadStart;

    const totalMs = Date.now() - start;
    const metrics = {
      manifestMs: 0, // measured outside workflow
      queueMs: 0,
      pageFetchWallMs: fetchAggregate,
      pageFetchAggregateMs: fetchAggregate,
      pdfWriteMs: totalMs - fetchAggregate - uploadDrainMs,
      uploadDrainMs,
      totalMs,
      bytes: result.size,
      pages: manifest.pageCount,
      pageRetries,
      fetchConcurrency: config.fetchConcurrency,
      uploadConcurrency: config.uploadConcurrency,
    };

    console.log(
      JSON.stringify({
        type: "pdf_generation_completed",
        jobId: params.jobId,
        contentId: manifest.contentId,
        generatorVersion: config.generatorVersion,
        ...metrics,
      }),
    );

    return {
      r2Key,
      size: result.size,
      etag: result.etag,
      pdfVersion,
      metrics,
    };
  } catch (error) {
    // Abort multipart upload — best-effort.
    try {
      await sink.abort();
    } catch {
      // Ignore.
    }

    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        type: "pdf_generation_failed",
        jobId: params.jobId,
        contentId: manifest.contentId,
        error: message,
      }),
    );

    await failGeneration(env, manifest.contentId, params.jobId, message);
    throw error;
  }
}

async function renewSingleFlight(env: Env, contentId: string, jobId: string): Promise<void> {
  const id = env.MATERIAL_COORDINATOR.idFromName(contentId);
  const stub = env.MATERIAL_COORDINATOR.get(id);
  await stub.fetch("https://coordinator/renew", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

async function releaseSingleFlight(env: Env, contentId: string, jobId: string): Promise<void> {
  const id = env.MATERIAL_COORDINATOR.idFromName(contentId);
  const stub = env.MATERIAL_COORDINATOR.get(id);
  await stub.fetch("https://coordinator/release", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

async function deleteR2Object(env: Env, key: string): Promise<void> {
  try {
    await env.ZHICE_BUCKET.delete(key);
  } catch {
    // Best-effort.
  }
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}
