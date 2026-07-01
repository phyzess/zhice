import { SmartEduError } from "./errors";

export const SMARTEDU_HOST = "basic.smartedu.cn";
export const CONTENT_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function parseSmartEduContentId(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SmartEduError("请粘贴完整的教材页面链接", "INVALID_URL");
  }

  if (url.hostname !== SMARTEDU_HOST) {
    throw new SmartEduError("目前只支持 basic.smartedu.cn 的教材页面", "UNSUPPORTED_HOST");
  }

  const fromQuery = url.searchParams.get("contentId");
  if (fromQuery && CONTENT_ID_PATTERN.test(fromQuery)) {
    return fromQuery.toLowerCase();
  }

  const fromUrl = input.match(CONTENT_ID_PATTERN)?.[0];
  if (fromUrl) {
    return fromUrl.toLowerCase();
  }

  throw new SmartEduError("链接里没有找到教材 contentId", "MISSING_CONTENT_ID");
}

export function getDetailUrl(contentId: string): string {
  return `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${contentId}.json`;
}

export function getImageUrl(basePath: string, page: number): string {
  const hostIndex = ((page - 1) % 3) + 1;
  return `https://r${hostIndex}-ndr.ykt.cbern.com.cn${basePath}/${page}.jpg`;
}
