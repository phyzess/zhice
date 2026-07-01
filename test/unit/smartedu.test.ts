import {
  fetchSmartEduManifest,
  parseSmartEduContentId,
  parseSmartEduDetail,
  SmartEduError,
} from "@zhice/core";
import { describe, expect, it } from "vitest";

const contentId = "913b98d8-ee64-4b08-bb18-5c09ef22034b";

describe("SmartEdu parsing", () => {
  it("extracts contentId from supported detail links", () => {
    expect(
      parseSmartEduContentId(
        `https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=${contentId}`,
      ),
    ).toBe(contentId);
  });

  it("rejects unsupported hosts", () => {
    expect(() => parseSmartEduContentId(`https://example.com/?contentId=${contentId}`)).toThrow(
      SmartEduError,
    );
  });

  it("parses image item and page count", () => {
    const manifest = parseSmartEduDetail(contentId, {
      title: "数学七年级上册",
      ti_items: [
        {
          ti_file_flag: "image",
          ti_storage: "cs_path:${ref-path}/edu_product/esp/assets/book/transcode/image",
          custom_properties: {
            requirements: [{ name: "pagesize", value: "205" }],
          },
        },
      ],
    });

    expect(manifest).toMatchObject({
      contentId,
      title: "数学七年级上册",
      pageCount: 205,
      imageBasePath: "/edu_product/esp/assets/book/transcode/image",
    });
  });

  it("uses a teacher-facing message when the detail JSON is not public", async () => {
    await expect(
      fetchSmartEduManifest(contentId, async () => new Response("not found", { status: 404 })),
    ).rejects.toMatchObject({
      code: "DETAIL_NOT_PUBLIC",
      message: "这个资源没有公开预览，无法生成 PDF。",
    });
  });

  it("uses a teacher-facing message when preview images are missing", () => {
    expect(() =>
      parseSmartEduDetail(contentId, {
        title: "无公开预览资源",
        ti_items: [{ ti_file_flag: "pdf", ti_storage: "/private/source.pdf" }],
      }),
    ).toThrow("这个资源没有公开预览页图，无法生成 PDF。");
  });
});
