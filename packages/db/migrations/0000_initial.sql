CREATE TABLE `materials` (
  `content_id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `page_count` integer NOT NULL,
  `image_base_path` text NOT NULL,
  `image_signature` text NOT NULL,
  `pdf_r2_key` text,
  `pdf_size` integer,
  `status` text NOT NULL,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `materials_status_idx` ON `materials` (`status`);
CREATE INDEX `materials_updated_idx` ON `materials` (`updated_at`);

CREATE TABLE `jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `content_id` text NOT NULL,
  `mode` text NOT NULL,
  `status` text NOT NULL,
  `title` text,
  `page_count` integer,
  `completed_pages` integer DEFAULT 0 NOT NULL,
  `download_url` text,
  `manifest_token` text,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `finished_at` integer
);
CREATE INDEX `jobs_content_idx` ON `jobs` (`content_id`);
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);

CREATE TABLE `usage_events` (
  `id` text PRIMARY KEY NOT NULL,
  `content_id` text,
  `event_type` text NOT NULL,
  `detail` text,
  `created_at` integer NOT NULL
);
CREATE INDEX `usage_events_event_idx` ON `usage_events` (`event_type`);
CREATE INDEX `usage_events_content_idx` ON `usage_events` (`content_id`);
CREATE INDEX `usage_events_created_idx` ON `usage_events` (`created_at`);

CREATE TABLE `rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `window_start` integer NOT NULL,
  `count` integer NOT NULL,
  `expires_at` integer NOT NULL
);
CREATE INDEX `rate_limits_expires_idx` ON `rate_limits` (`expires_at`);
