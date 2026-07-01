export class SmartEduError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_URL"
      | "UNSUPPORTED_HOST"
      | "MISSING_CONTENT_ID"
      | "DETAIL_NETWORK_FAILED"
      | "DETAIL_FETCH_FAILED"
      | "DETAIL_NOT_PUBLIC"
      | "DETAIL_INVALID_JSON"
      | "MISSING_IMAGE_ITEM"
      | "MISSING_PAGE_COUNT",
  ) {
    super(message);
    this.name = "SmartEduError";
  }
}

export function smartEduErrorMessage(error: unknown): string {
  if (error instanceof SmartEduError) {
    return error.message;
  }
  return "教材信息读取失败，请稍后再试。";
}
