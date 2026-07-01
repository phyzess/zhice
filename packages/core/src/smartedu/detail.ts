import type { MaterialManifest } from "../validation";
import { SmartEduError } from "./errors";

type DetailItem = {
  ti_file_flag?: string;
  ti_storage?: string;
  custom_properties?: {
    requirements?: Array<{ name?: string; value?: string }>;
  };
};

type DetailDocument = {
  title?: string;
  custom_properties?: {
    title?: string;
  };
  ti_items?: DetailItem[];
};

export function parseSmartEduDetail(contentId: string, detail: DetailDocument): MaterialManifest {
  const imageItem = detail.ti_items?.find(
    (item) => item.ti_file_flag === "image" && item.ti_storage,
  );
  if (!imageItem?.ti_storage) {
    throw new SmartEduError("这个资源没有公开预览页图，无法生成 PDF。", "MISSING_IMAGE_ITEM");
  }

  const requirements = Object.fromEntries(
    (imageItem.custom_properties?.requirements ?? []).map((requirement) => [
      String(requirement.name ?? "").toLowerCase(),
      requirement.value,
    ]),
  );
  const pageCount = Number(requirements.pagesize);
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new SmartEduError("没有识别到教材页数，暂时无法生成。", "MISSING_PAGE_COUNT");
  }

  const imageBasePath = normalizeStoragePath(imageItem.ti_storage);
  const title =
    detail.title?.trim() || detail.custom_properties?.title?.trim() || "智慧教育平台教材";

  return {
    contentId,
    title,
    pageCount,
    imageBasePath,
    imageSignature: `${imageBasePath}:${pageCount}`,
  };
}

export function normalizeStoragePath(storage: string): string {
  let value = storage.replace("cs_path:${ref-path}", "");
  if (/^https?:\/\//i.test(value)) {
    value = new URL(value).pathname;
  }
  if (!value.startsWith("/")) {
    value = `/${value}`;
  }
  return value.replace(/\/+$/, "");
}

export async function fetchSmartEduManifest(
  contentId: string,
  fetcher: typeof fetch = fetch,
): Promise<MaterialManifest> {
  let response: Response;
  try {
    response = await fetcher(
      `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${contentId}.json`,
      {
        headers: {
          accept: "application/json",
          referer: "https://basic.smartedu.cn/",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
        },
      },
    );
  } catch {
    throw new SmartEduError("智慧教育平台暂时连接不上，请稍后再试。", "DETAIL_NETWORK_FAILED");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new SmartEduError("这个资源没有公开预览，无法生成 PDF。", "DETAIL_NOT_PUBLIC");
    }
    throw new SmartEduError("智慧教育平台暂时无法访问，请稍后再试。", "DETAIL_FETCH_FAILED");
  }

  let detail: DetailDocument;
  try {
    detail = (await response.json()) as DetailDocument;
  } catch {
    throw new SmartEduError("教材信息格式异常，暂时无法生成。", "DETAIL_INVALID_JSON");
  }
  return parseSmartEduDetail(contentId, detail);
}
