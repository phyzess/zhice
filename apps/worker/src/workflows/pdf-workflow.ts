import { fetchSmartEduManifest, PdfWriter, type MaterialManifest } from "@zhice/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, PdfWorkflowParams } from "../env";
import {
  getMaterial,
  markMaterialFailed,
  markMaterialReady,
  recordUsage,
  updateJob,
  upsertMaterial,
} from "../services/db";
import { fetchPageImage } from "../services/images";
import { R2MultipartPdfSink } from "../services/r2-multipart-sink";

export class PdfWorkflow extends WorkflowEntrypoint<Env, PdfWorkflowParams> {
  async run(event: WorkflowEvent<PdfWorkflowParams>, step: WorkflowStep): Promise<void> {
    const payload = event.payload;
    const manifest = await step.do("resolve", async () => {
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
      const fetched = await fetchSmartEduManifest(payload.contentId);
      await upsertMaterial(this.env, fetched, "resolved");
      return fetched;
    });

    try {
      await step.do(
        "generate and upload",
        {
          timeout: "20 minutes",
        },
        async () => {
          await generatePdf(this.env, payload.jobId, manifest);
        },
      );
    } finally {
      await releaseSingleFlight(this.env, payload.contentId);
    }
  }
}

async function generatePdf(env: Env, jobId: string, manifest: MaterialManifest): Promise<void> {
  const r2Key = `materials/${manifest.contentId}/${manifest.imageSignature.replaceAll("/", "_")}.pdf`;
  const sink = await R2MultipartPdfSink.create(env.ZHICE_BUCKET, r2Key);
  const writer = new PdfWriter(sink, { title: manifest.title });
  try {
    await updateJob(env, jobId, {
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
    for (let page = 1; page <= manifest.pageCount; page += 1) {
      const bytes = await fetchPageImage(manifest, page);
      await writer.addJpegPage({ bytes });
      if (page % 5 === 0 || page === manifest.pageCount) {
        await updateJob(env, jobId, {
          status: page === manifest.pageCount ? "uploading" : "generating",
          completedPages: page,
        });
      }
    }
    await writer.finish();
    const result = await sink.complete();
    await markMaterialReady(env, manifest.contentId, r2Key, result.size);
    await updateJob(env, jobId, {
      status: "succeeded",
      completedPages: manifest.pageCount,
      downloadUrl: `/api/materials/${manifest.contentId}/download`,
      error: null,
      finishedAt: Date.now(),
    });
    await recordUsage(env, "cloud_succeeded", manifest.contentId, {
      bytes: result.size,
      pages: manifest.pageCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await sink.abort();
    } catch {
      // The user-facing fallback matters more than cleaning up a failed multipart session.
    }
    await markMaterialFailed(env, manifest.contentId, message);
    await updateJob(env, jobId, {
      status: "fallback_ready",
      error: "云端生成失败，已准备本机生成",
      finishedAt: Date.now(),
    });
    await recordUsage(env, "cloud_failed", manifest.contentId, { error: message });
  }
}

async function releaseSingleFlight(env: Env, contentId: string): Promise<void> {
  const id = env.MATERIAL_COORDINATOR.idFromName(contentId);
  const stub = env.MATERIAL_COORDINATOR.get(id);
  await stub.fetch("https://coordinator/release", { method: "POST" });
}
