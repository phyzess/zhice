/**
 * PDF pipeline configuration — validated once at module load.
 * All values come from Wrangler `vars` (available on env at runtime).
 * Invalid values fall back to safe defaults with a single structured warning.
 */

export type PdfConfig = {
  /** Public base URL for R2 custom domain downloads (must be HTTPS). */
  publicBaseUrl: string;
  /** Max concurrent outbound fetch requests for page images. Range: 1..6. */
  fetchConcurrency: number;
  /** Max concurrent R2 multipart upload parts. Range: 1..2. */
  uploadConcurrency: number;
  /** Minimum part size in bytes for R2 multipart uploads (min 5 MiB). */
  partSizeBytes: number;
  /** How long a ready material's manifest is considered fresh (ms). Default 24h. */
  manifestTtlMs: number;
  /** Immutable generator version included in the PDF version key. */
  generatorVersion: string;
};

let config: PdfConfig | null = null;
let configWarning: string | null = null;

export function getPdfConfig(raw: Record<string, unknown>): PdfConfig {
  if (config) {
    return config;
  }
  const warnings: string[] = [];

  const publicBaseUrl = readString(raw, "PDF_PUBLIC_BASE_URL", "");
  if (publicBaseUrl && !publicBaseUrl.startsWith("https://")) {
    warnings.push(
      "PDF_PUBLIC_BASE_URL must use HTTPS — downloads will route through Worker instead.",
    );
  }

  const fetchConcurrency = readInt(raw, "PDF_FETCH_CONCURRENCY", 6, 1, 6, warnings);
  const uploadConcurrency = readInt(raw, "PDF_UPLOAD_CONCURRENCY", 2, 1, 2, warnings);
  const partSizeBytes = readInt(
    raw,
    "PDF_PART_SIZE_BYTES",
    8 * 1024 * 1024,
    5 * 1024 * 1024,
    Number.MAX_SAFE_INTEGER,
    warnings,
  );
  const manifestTtlMs = readInt(
    raw,
    "MATERIAL_MANIFEST_TTL_MS",
    24 * 60 * 60 * 1000,
    0,
    Number.MAX_SAFE_INTEGER,
    warnings,
  );
  const generatorVersion = readString(raw, "PDF_GENERATOR_VERSION", "v2");

  config = {
    publicBaseUrl,
    fetchConcurrency,
    uploadConcurrency,
    partSizeBytes,
    manifestTtlMs,
    generatorVersion,
  };

  if (warnings.length > 0) {
    const message = `[pdf-config] ${warnings.join("; ")}`;
    if (configWarning !== message) {
      configWarning = message;
      console.warn(JSON.stringify({ type: "pdf_config_warning", warnings }));
    }
  }

  return config;
}

function readString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallback;
}

function readInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < min || value > max) {
      warnings.push(`${key}=${value} out of range [${min}..${max}], using ${fallback}`);
      return fallback;
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      if (parsed < min || parsed > max) {
        warnings.push(`${key}=${parsed} out of range [${min}..${max}], using ${fallback}`);
        return fallback;
      }
      return parsed;
    }
  }
  return fallback;
}
