-- Migration: PDF pipeline v2
-- Adds cache version metadata to materials and jobs tables.
-- All changes are additive; existing rows are preserved.

-- Add manifest_checked_at, pdf_etag, pdf_version to materials
ALTER TABLE `materials` ADD COLUMN `manifest_checked_at` integer;
ALTER TABLE `materials` ADD COLUMN `pdf_etag` text;
ALTER TABLE `materials` ADD COLUMN `pdf_version` text;

-- Add generator_version to jobs (default 'v1' for legacy jobs)
ALTER TABLE `jobs` ADD COLUMN `generator_version` text NOT NULL DEFAULT 'v1';

-- Index for ready materials with stale manifest check
CREATE INDEX `materials_ready_checked_idx` ON `materials` (`status`, `manifest_checked_at`);
