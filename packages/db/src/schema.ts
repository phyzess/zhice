import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const materials = sqliteTable(
  "materials",
  {
    contentId: text("content_id").primaryKey(),
    title: text("title").notNull(),
    pageCount: integer("page_count").notNull(),
    imageBasePath: text("image_base_path").notNull(),
    imageSignature: text("image_signature").notNull(),
    pdfR2Key: text("pdf_r2_key"),
    pdfSize: integer("pdf_size"),
    pdfEtag: text("pdf_etag"),
    pdfVersion: text("pdf_version"),
    status: text("status", {
      enum: ["resolved", "generating", "ready", "failed"],
    }).notNull(),
    error: text("error"),
    manifestCheckedAt: integer("manifest_checked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    statusIdx: index("materials_status_idx").on(table.status),
    updatedIdx: index("materials_updated_idx").on(table.updatedAt),
    readyCheckedIdx: index("materials_ready_checked_idx").on(table.status, table.manifestCheckedAt),
  }),
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id").notNull(),
    mode: text("mode", { enum: ["auto", "cloud", "browser"] }).notNull(),
    status: text("status", {
      enum: [
        "queued",
        "resolving",
        "generating",
        "uploading",
        "succeeded",
        "failed",
        "fallback_ready",
        "canceled",
      ],
    }).notNull(),
    title: text("title"),
    pageCount: integer("page_count"),
    completedPages: integer("completed_pages").notNull().default(0),
    downloadUrl: text("download_url"),
    manifestToken: text("manifest_token"),
    generatorVersion: text("generator_version").notNull().default("v1"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    contentIdx: index("jobs_content_idx").on(table.contentId),
    statusIdx: index("jobs_status_idx").on(table.status),
    createdIdx: index("jobs_created_idx").on(table.createdAt),
  }),
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id"),
    eventType: text("event_type", {
      enum: [
        "job_created",
        "cache_hit",
        "cloud_succeeded",
        "cloud_failed",
        "browser_fallback",
        "download",
      ],
    }).notNull(),
    detail: text("detail", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    eventIdx: index("usage_events_event_idx").on(table.eventType),
    contentIdx: index("usage_events_content_idx").on(table.contentId),
    createdIdx: index("usage_events_created_idx").on(table.createdAt),
  }),
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    count: integer("count").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    expiresIdx: index("rate_limits_expires_idx").on(table.expiresAt),
  }),
);

export type MaterialRow = typeof materials.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
