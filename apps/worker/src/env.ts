type SecretEnv = {
  OPS_TOKEN?: string;
  RATE_LIMIT_PEPPER?: string;
};

export type Env = Cloudflare.Env & SecretEnv;

export type PdfWorkflowParams = {
  jobId: string;
  contentId: string;
};

export type DbJob = {
  id: string;
  content_id: string;
  mode: "auto" | "cloud" | "browser";
  status:
    | "queued"
    | "resolving"
    | "generating"
    | "uploading"
    | "succeeded"
    | "failed"
    | "fallback_ready"
    | "canceled";
  title: string | null;
  page_count: number | null;
  completed_pages: number;
  download_url: string | null;
  manifest_token: string | null;
  generator_version: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

export type DbMaterial = {
  content_id: string;
  title: string;
  page_count: number;
  image_base_path: string;
  image_signature: string;
  pdf_r2_key: string | null;
  pdf_size: number | null;
  pdf_etag: string | null;
  pdf_version: string | null;
  manifest_checked_at: number | null;
  status: "resolved" | "generating" | "ready" | "failed";
  error: string | null;
  created_at: number;
  updated_at: number;
};
