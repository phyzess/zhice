import { chromium } from "@playwright/test";

const defaultSampleUrl =
  "https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=913b98d8-ee64-4b08-bb18-5c09ef22034b&catalogType=tchMaterial&subCatalog=tchMaterial";

const baseUrl = process.env.ZHICE_BASE_URL ?? "http://localhost:8787";
const sampleUrl = process.env.ZHICE_SAMPLE_URL ?? defaultSampleUrl;

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

async function dumpState() {
  return await page.evaluate(() => ({
    bodyText: document.body.textContent?.slice(0, 2000) ?? "",
    currentHref: window.location.href,
    fallbackClass: document.querySelector("#fallback-button")?.className ?? null,
    formMessage: document.querySelector("#form-message")?.textContent ?? null,
    historyCount: document.querySelector("#history-list")?.children.length ?? null,
    taskMessage: document.querySelector("#task-message")?.textContent ?? null,
    taskStatus: document.querySelector("#task-status")?.textContent ?? null,
    taskVisible: !document.querySelector("#task-card")?.classList.contains("hidden"),
  }));
}

async function waitForVisible(selector: string, timeout: number) {
  try {
    await page.locator(selector).waitFor({ state: "visible", timeout });
  } catch (error) {
    const state = await dumpState();
    throw new Error(
      `等待 ${selector} 显示超时：${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(state, null, 2)}`,
    );
  }
}

async function waitForTaskMessage(text: string, timeout: number) {
  try {
    await page.waitForFunction(
      (expected) => document.querySelector("#task-message")?.textContent?.includes(expected),
      text,
      { timeout },
    );
  } catch (error) {
    const state = await dumpState();
    throw new Error(
      `等待任务文案包含 ${text} 超时：${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(state, null, 2)}`,
    );
  }
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.localStorage.clear();
    window.indexedDB.deleteDatabase("zhice.localPdfs");
  });

  await page.getByLabel("教材链接").fill(sampleUrl);
  await page.getByRole("button", { name: "生成 PDF" }).click();
  await waitForVisible("#fallback-button:not(.hidden)", 90_000);

  await page.locator("#fallback-button").click();
  await waitForTaskMessage("已完成", 420_000);
  const pdfInfo = await page.evaluate(async () => {
    const history = JSON.parse(
      window.localStorage.getItem("zhice.localHistory.v1") ?? "[]",
    ) as Array<{
      localPdfKey?: string;
      pageCount?: number;
      title?: string;
    }>;
    const item = history[0];
    if (!item?.localPdfKey) {
      throw new Error("Local history does not contain a local PDF key.");
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open("zhice.localPdfs", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<{ blob: Blob; filename: string }>((resolve, reject) => {
      const transaction = db.transaction("pdfs", "readonly");
      const request = transaction.objectStore("pdfs").get(item.localPdfKey);
      request.onsuccess = () => resolve(request.result as { blob: Blob; filename: string });
      request.onerror = () => reject(request.error);
    });
    db.close();
    const bytes = new Uint8Array(await stored.blob.arrayBuffer());
    const needle = new TextEncoder().encode("/Type /Page /Parent");
    let pages = 0;
    outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (bytes[index + offset] !== needle[offset]) {
          continue outer;
        }
      }
      pages += 1;
    }
    return {
      filename: stored.filename,
      pageCount: item.pageCount,
      pages,
      size: stored.blob.size,
      title: item.title,
    };
  });

  await waitForVisible("#download-button:not(.hidden)", 30_000);
  const firstDownloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#download-button").click();
  const firstDownload = await firstDownloadPromise;
  await firstDownload.saveAs("/tmp/zhice-local-sample.pdf");
  const message = await page.locator("#task-message").textContent();
  const historyCount = await page.locator("#history-list > *").count();

  const secondDownloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#history-list button").filter({ hasText: "下载" }).click();
  const secondDownload = await secondDownloadPromise;
  await secondDownload.saveAs("/tmp/zhice-local-sample-history.pdf");

  console.log(
    JSON.stringify(
      {
        ok: true,
        message,
        historyCount,
        pdfInfo,
        pdf: "/tmp/zhice-local-sample.pdf",
        historyPdf: "/tmp/zhice-local-sample-history.pdf",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
