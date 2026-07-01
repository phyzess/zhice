import * as v from "valibot";

export const JobModeSchema = v.optional(v.picklist(["auto", "cloud", "browser"]), "auto");

export const CreateJobSchema = v.object({
  url: v.pipe(v.string(), v.trim(), v.minLength(1, "请粘贴教材页面链接")),
  mode: JobModeSchema,
});

export const JobStatusSchema = v.picklist([
  "queued",
  "resolving",
  "generating",
  "uploading",
  "succeeded",
  "failed",
  "fallback_ready",
  "canceled",
]);

export const MaterialManifestSchema = v.object({
  contentId: v.string(),
  title: v.string(),
  pageCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  imageBasePath: v.string(),
  imageSignature: v.string(),
});

export const PageParamSchema = v.object({
  contentId: v.string(),
  page: v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)),
});

export type CreateJobInput = v.InferOutput<typeof CreateJobSchema>;
export type JobMode = v.InferOutput<typeof JobModeSchema>;
export type JobStatus = v.InferOutput<typeof JobStatusSchema>;
export type MaterialManifest = v.InferOutput<typeof MaterialManifestSchema>;
