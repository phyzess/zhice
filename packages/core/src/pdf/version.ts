/**
 * Immutable, content-addressed PDF artifact keying.
 *
 * A PDF version key is SHA-256(imageSignature + "|" + generatorVersion)
 * in lowercase hex. The R2 key is `materials/<contentId>/<pdfVersion>.pdf`.
 *
 * Keys are pure ASCII: lowercase hex + "/" + ".pdf". No colons, backslashes,
 * or the legacy full imageBasePath — so the file name is always safe on disk.
 */

export async function buildPdfVersionKey(
  imageSignature: string,
  generatorVersion: string,
): Promise<string> {
  const canonical = `${imageSignature}|${generatorVersion}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function buildR2Key(contentId: string, pdfVersion: string): string {
  return `materials/${contentId}/${pdfVersion}.pdf`;
}
