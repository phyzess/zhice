import { LOCAL_HISTORY_KEY, PdfWriter, type JobStatus, type LocalHistoryItem } from "@zhice/core";

type JobView = {
  jobId: string;
  contentId: string;
  status: JobStatus;
  mode: "auto" | "cloud" | "browser";
  title: string;
  pageCount: number;
  completedPages: number;
  error?: string | null;
  downloadUrl?: string | null;
  manifestUrl?: string | null;
  updatedAt: number;
};

type BrowserManifest = {
  contentId: string;
  title: string;
  pageCount: number;
  pageUrlTemplate: string;
};

type SaveHistoryOptions = {
  localPdfKey?: string;
  filename?: string;
};

type StoredPdf = {
  blob: Blob;
  filename: string;
};

class BrowserPdfSink {
  readonly chunks: BlobPart[] = [];
  size = 0;

  write(chunk: Uint8Array): void {
    const copy = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(copy).set(chunk);
    this.chunks.push(copy);
    this.size += chunk.byteLength;
  }

  toBlob(): Blob {
    return new Blob(this.chunks, { type: "application/pdf" });
  }
}

type CurrentLocalPdf = {
  jobId: string;
  localPdfKey: string;
  filename: string;
};

declare global {
  interface Window {
    turnstile?: {
      getResponse: () => string;
      reset: () => void;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorPayload(value: unknown): value is { error?: string | null } {
  return isRecord(value) && "error" in value;
}

function isJobView(value: unknown): value is JobView {
  return (
    isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.contentId === "string" &&
    typeof value.status === "string" &&
    typeof value.mode === "string" &&
    typeof value.title === "string" &&
    typeof value.pageCount === "number" &&
    typeof value.completedPages === "number" &&
    typeof value.updatedAt === "number"
  );
}

const form = byId<HTMLFormElement>("job-form");
const urlInput = byId<HTMLInputElement>("material-url");
const submitButton = byId<HTMLButtonElement>("submit-button");
const pasteSubmitButton = byId<HTMLButtonElement>("paste-submit-button");
const formMessage = byId<HTMLParagraphElement>("form-message");
const browserWarning = byId<HTMLParagraphElement>("browser-warning");
const browserWarningText = byId<HTMLSpanElement>("browser-warning-text");

const taskCard = byId<HTMLElement>("task-card");
const taskStatus = byId<HTMLElement>("task-status");
const taskMode = byId<HTMLElement>("task-mode");
const taskTitle = byId<HTMLElement>("task-title");
const taskSummary = byId<HTMLElement>("task-summary");
const taskProgress = byId<HTMLElement>("task-progress");
const taskMessage = byId<HTMLElement>("task-message");
const taskSpinner = byId<HTMLElement>("task-spinner");
const downloadButton = byId<HTMLButtonElement>("download-button");
const fallbackButton = byId<HTMLButtonElement>("fallback-button");
const copyButton = byId<HTMLButtonElement>("copy-button");
const resetButton = byId<HTMLButtonElement>("reset-button");
const historyList = byId<HTMLElement>("history-list");
const emptyHistory = byId<HTMLElement>("empty-history");
const clearHistoryButton = byId<HTMLButtonElement>("clear-history-button");

let currentJob: JobView | null = null;
let currentLocalPdf: CurrentLocalPdf | null = null;
let eventSource: EventSource | null = null;
let pollTimer: number | null = null;
const LOCAL_PDF_DB_NAME = "zhice.localPdfs";
const LOCAL_PDF_STORE = "pdfs";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitJob(urlInput.value, "auto");
});

pasteSubmitButton.addEventListener("click", async () => {
  clearFormMessage();
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    await submitJob(urlInput.value, "auto");
  } catch {
    showFormMessage("无法读取剪贴板，请手动粘贴链接。");
  }
});

downloadButton.addEventListener("click", async () => {
  if (!currentJob) {
    return;
  }
  if (currentJob.downloadUrl) {
    saveHistory(currentJob);
    setTaskMessage("已开始下载，请在浏览器下载列表查看。");
    location.href = currentJob.downloadUrl;
    return;
  }
  if (currentLocalPdf?.jobId !== currentJob.jobId) {
    return;
  }
  const stored = await readLocalPdf(currentLocalPdf.localPdfKey);
  if (!stored) {
    setTaskMessage("本地 PDF 已被清理，请重新生成。");
    return;
  }
  downloadBlob(stored.blob, stored.filename);
  setTaskMessage("已开始下载，请在浏览器下载列表查看。");
});

fallbackButton.addEventListener("click", () => {
  if (currentJob) {
    void runBrowserFallback(currentJob);
  }
});

copyButton.addEventListener("click", async () => {
  if (!currentJob?.downloadUrl) {
    return;
  }
  await navigator.clipboard.writeText(new URL(currentJob.downloadUrl, location.origin).href);
  setTaskMessage("下载链接已复制。");
});

resetButton.addEventListener("click", () => {
  stopWatching();
  currentJob = null;
  currentLocalPdf = null;
  taskCard.classList.add("hidden");
  urlInput.focus();
});

clearHistoryButton.addEventListener("click", async () => {
  localStorage.removeItem(LOCAL_HISTORY_KEY);
  await clearLocalPdfs();
  currentLocalPdf = null;
  if (currentJob) {
    renderJob(currentJob);
  }
  renderHistory();
});

renderHistory();
renderBrowserWarning();

async function submitJob(url: string, mode: "auto" | "cloud" | "browser"): Promise<void> {
  clearFormMessage();
  if (!url.includes("basic.smartedu.cn") || !url.includes("contentId=")) {
    showFormMessage("请粘贴智慧教育平台教材详情页链接。");
    return;
  }

  setSubmitting(true);
  currentLocalPdf = null;
  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        mode,
        turnstileToken: window.turnstile?.getResponse() || undefined,
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message =
        isErrorPayload(body) && typeof body.error === "string" && body.error.length > 0
          ? body.error
          : "提交失败";
      throw new Error(message);
    }
    if (!isJobView(body)) {
      throw new Error("提交失败，请稍后再试。");
    }
    currentJob = body;
    renderJob(body);
    saveHistory(body);
    watchJob(body.jobId);
  } catch (error) {
    showFormMessage(error instanceof Error ? error.message : "提交失败，请稍后再试。");
    window.turnstile?.reset();
  } finally {
    setSubmitting(false);
  }
}

function watchJob(jobId: string): void {
  stopWatching();
  if ("EventSource" in window) {
    eventSource = new EventSource(`/api/jobs/${jobId}/events`);
    eventSource.onmessage = (event) => {
      const job = JSON.parse(event.data) as JobView;
      currentJob = job;
      renderJob(job);
      saveHistory(job);
      if (isTerminal(job.status)) {
        stopWatching();
      }
    };
    eventSource.onerror = () => {
      stopWatching();
      pollJob(jobId);
    };
  }
  pollTimer = window.setTimeout(() => pollJob(jobId), 2500);
}

function pollJob(jobId: string): void {
  const run = async () => {
    const response = await fetch(`/api/jobs/${jobId}`);
    if (!response.ok) {
      return;
    }
    const job = (await response.json()) as JobView;
    currentJob = job;
    renderJob(job);
    saveHistory(job);
    if (isTerminal(job.status)) {
      stopWatching();
      return;
    }
    pollTimer = window.setTimeout(run, 1500);
  };
  void run();
}

function stopWatching(): void {
  eventSource?.close();
  eventSource = null;
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function renderJob(job: JobView): void {
  const hasLocalPdf = currentLocalPdf?.jobId === job.jobId;
  taskCard.classList.remove("hidden");
  taskTitle.textContent = job.title || "正在读取教材信息";
  taskSummary.textContent =
    job.pageCount > 0 ? `${job.pageCount} 页 · ${modeText(job.mode)}` : modeText(job.mode);
  taskStatus.textContent = statusText(job.status);
  taskStatus.className =
    "inline-flex items-center rounded-full border-4 border-black px-3 py-1 text-xs font-black uppercase tracking-widest shadow-[3px_3px_0_0_#000] " +
    statusToneClass(job.status);
  taskMode.textContent = job.mode === "browser" ? "本机生成" : "云端优先";
  const progress = job.pageCount > 0 ? Math.round((job.completedPages / job.pageCount) * 100) : 0;
  taskProgress.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  setTaskMessage(messageText(job));
  taskSpinner.classList.toggle("hidden", isTerminal(job.status));
  downloadButton.classList.toggle("hidden", !job.downloadUrl && !hasLocalPdf);
  copyButton.classList.toggle("hidden", !job.downloadUrl);
  fallbackButton.classList.toggle(
    "hidden",
    !(job.status === "fallback_ready" || job.status === "failed"),
  );
}

async function runBrowserFallback(job: JobView): Promise<void> {
  if (!job.manifestUrl) {
    setTaskMessage("本机生成所需信息缺失，请重新提交。");
    return;
  }
  fallbackButton.disabled = true;
  downloadButton.classList.add("hidden");
  setTaskMessage("正在切换到本机生成...");
  try {
    const manifestResponse = await fetch(job.manifestUrl);
    if (!manifestResponse.ok) {
      throw new Error("本机生成信息读取失败");
    }
    const manifest = (await manifestResponse.json()) as BrowserManifest;
    const sink = new BrowserPdfSink();
    const writer = new PdfWriter(sink, { title: manifest.title });
    await writer.start();
    for (let page = 1; page <= manifest.pageCount; page += 1) {
      setTaskMessage(`正在整理第 ${page} / ${manifest.pageCount} 页`);
      taskProgress.style.width = `${Math.round((page / manifest.pageCount) * 100)}%`;
      const imageResponse = await fetch(manifest.pageUrlTemplate.replace("{page}", String(page)));
      if (!imageResponse.ok) {
        throw new Error(await responseErrorMessage(imageResponse, `第 ${page} 页读取失败`));
      }
      await writer.addJpegPage({ bytes: new Uint8Array(await imageResponse.arrayBuffer()) });
      if (page % 5 === 0) {
        await nextFrame();
      }
    }
    setTaskMessage("正在生成 PDF...");
    await writer.finish();
    const pdf = sink.toBlob();
    const filename = `${safeFilename(manifest.title)}.pdf`;
    const localPdfKey = `${job.jobId}.pdf`;
    await saveLocalPdf(localPdfKey, pdf, filename);
    downloadBlob(pdf, filename);
    currentLocalPdf = { jobId: job.jobId, localPdfKey, filename };
    const updated: JobView = {
      ...job,
      status: "succeeded",
      completedPages: manifest.pageCount,
      downloadUrl: undefined,
      updatedAt: Date.now(),
    };
    currentJob = updated;
    saveHistory(updated, { localPdfKey, filename });
    renderJob(updated);
    setTaskMessage("已完成，已开始下载。");
  } catch (error) {
    setTaskMessage(error instanceof Error ? error.message : "本机生成失败。");
  } finally {
    fallbackButton.disabled = false;
  }
}

function saveHistory(job: JobView, options: SaveHistoryOptions = {}): void {
  if (!job.contentId || !job.title) {
    return;
  }
  const previous = loadHistory();
  const existing = previous.find((item) => item.jobId === job.jobId);
  const items = previous.filter((item) => item.jobId !== job.jobId);
  const item: LocalHistoryItem = {
    jobId: job.jobId,
    contentId: job.contentId,
    title: job.title,
    pageCount: job.pageCount,
    status: job.status,
    downloadUrl: job.downloadUrl ?? undefined,
    localPdfKey: options.localPdfKey ?? existing?.localPdfKey,
    filename: options.filename ?? existing?.filename,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify([item, ...items].slice(0, 12)));
  renderHistory();
}

function loadHistory(): LocalHistoryItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderHistory(): void {
  const items = loadHistory();
  historyList.replaceChildren();
  emptyHistory.classList.toggle("hidden", items.length > 0);
  clearHistoryButton.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const row = document.createElement("div");
    row.className =
      "flex flex-wrap items-center justify-between gap-4 border-4 border-black bg-white p-4 shadow-[4px_4px_0_0_#000] transition-transform duration-100 ease-linear hover:-translate-y-1";
    const title = document.createElement("div");
    title.className = "min-w-0 flex-1";
    title.innerHTML = `<div class="font-black leading-snug">${escapeHtml(item.title)}</div><div class="mt-1 text-sm font-black uppercase tracking-wide text-black">${item.pageCount || "-"} 页 · ${formatDate(item.updatedAt)}</div>`;
    const actions = document.createElement("div");
    actions.className = "flex flex-wrap gap-2";
    if (item.downloadUrl) {
      const link = document.createElement("a");
      link.href = item.downloadUrl;
      link.className =
        "inline-flex min-h-10 items-center border-4 border-black bg-[var(--color-primary)] px-3 text-sm font-black uppercase tracking-wide text-black shadow-[3px_3px_0_0_#000] transition duration-100 ease-linear active:translate-x-1 active:translate-y-1 active:shadow-none";
      link.textContent = "下载";
      actions.append(link);
    } else if (item.localPdfKey) {
      const download = document.createElement("button");
      download.type = "button";
      download.className =
        "inline-flex min-h-10 items-center border-4 border-black bg-[var(--color-primary)] px-3 text-sm font-black uppercase tracking-wide text-black shadow-[3px_3px_0_0_#000] transition duration-100 ease-linear active:translate-x-1 active:translate-y-1 active:shadow-none";
      download.textContent = "下载";
      download.addEventListener("click", async () => {
        const stored = await readLocalPdf(item.localPdfKey ?? "");
        if (!stored) {
          setTaskMessage("本地文件已失效，请重新生成。");
          return;
        }
        downloadBlob(stored.blob, stored.filename);
        if (!taskCard.classList.contains("hidden")) {
          setTaskMessage("已开始下载，请在浏览器下载列表查看。");
        }
      });
      actions.append(download);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className =
      "inline-flex min-h-10 items-center border-4 border-black bg-white px-3 text-sm font-black uppercase tracking-wide text-black shadow-[3px_3px_0_0_#000] transition duration-100 ease-linear active:translate-x-1 active:translate-y-1 active:shadow-none";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (item.localPdfKey) {
        await deleteLocalPdf(item.localPdfKey);
      }
      localStorage.setItem(
        LOCAL_HISTORY_KEY,
        JSON.stringify(loadHistory().filter((existing) => existing.jobId !== item.jobId)),
      );
      renderHistory();
    });
    actions.append(remove);
    row.append(title, actions);
    historyList.append(row);
  }
}

function setSubmitting(value: boolean): void {
  submitButton.disabled = value;
  pasteSubmitButton.disabled = value;
  submitButton.textContent = value ? "提交中..." : "生成 PDF";
}

function showFormMessage(message: string): void {
  formMessage.textContent = message;
  formMessage.classList.remove("hidden");
}

function clearFormMessage(): void {
  formMessage.textContent = "";
  formMessage.classList.add("hidden");
}

function renderBrowserWarning(): void {
  const message = browserWarningMessage();
  if (!message) {
    return;
  }
  browserWarningText.textContent = message;
  browserWarning.classList.remove("hidden");
}

function browserWarningMessage(): string | null {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("micromessenger") || userAgent.includes("wxwork")) {
    return "检测到微信内置浏览器，大文件下载可能失败。请点右上角，用系统浏览器打开。";
  }
  if (!("indexedDB" in window) || !("Blob" in window) || !("URL" in window)) {
    return "这个浏览器不支持本机生成 PDF，请换 Chrome、Edge 或 Safari 打开。";
  }
  if (/iphone|ipad|ipod|android/.test(userAgent)) {
    return "手机生成大文件时请保持页面打开；如果下载无反应，请换系统浏览器打开。";
  }
  return null;
}

function setTaskMessage(message: string): void {
  taskMessage.textContent = message;
}

function statusText(status: JobStatus): string {
  const map: Record<JobStatus, string> = {
    queued: "排队中",
    resolving: "读取中",
    generating: "整理中",
    uploading: "保存中",
    succeeded: "已完成",
    failed: "失败",
    fallback_ready: "可本机生成",
    canceled: "已取消",
  };
  return map[status];
}

function statusToneClass(status: JobStatus): string {
  if (status === "succeeded") {
    return "bg-[var(--color-success)] text-black";
  }
  if (status === "failed" || status === "fallback_ready") {
    return "bg-[var(--color-primary)] text-black";
  }
  return "bg-[var(--color-violet)] text-black";
}

function messageText(job: JobView): string {
  if (job.status === "queued") {
    return "正在排队，请稍等。";
  }
  if (job.status === "resolving") {
    return "正在读取教材信息。";
  }
  if (job.status === "generating") {
    return `正在整理第 ${job.completedPages} / ${job.pageCount} 页`;
  }
  if (job.status === "uploading") {
    return "正在保存 PDF。";
  }
  if (job.status === "succeeded") {
    return "已完成，可以下载。";
  }
  if (job.status === "fallback_ready") {
    return job.error || "云端生成失败，已切换到本机生成。";
  }
  if (job.status === "failed") {
    return job.error || "生成失败，可以改用本机生成。";
  }
  return "任务已取消。";
}

function modeText(mode: JobView["mode"]): string {
  return mode === "browser" ? "本机生成" : "云端优先";
}

function isTerminal(status: JobStatus): boolean {
  return ["succeeded", "failed", "fallback_ready", "canceled"].includes(status);
}

async function saveLocalPdf(key: string, blob: Blob, filename: string): Promise<void> {
  const db = await openLocalPdfDb();
  const transaction = db.transaction(LOCAL_PDF_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(LOCAL_PDF_STORE).put(
    {
      blob,
      filename,
    } satisfies StoredPdf,
    key,
  );
  await done;
  db.close();
}

async function readLocalPdf(key: string): Promise<StoredPdf | null> {
  const db = await openLocalPdfDb();
  const transaction = db.transaction(LOCAL_PDF_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestToPromise<unknown>(transaction.objectStore(LOCAL_PDF_STORE).get(key));
  await done;
  db.close();
  if (!isStoredPdf(value)) {
    return null;
  }
  return value;
}

async function deleteLocalPdf(key: string): Promise<void> {
  const db = await openLocalPdfDb();
  const transaction = db.transaction(LOCAL_PDF_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(LOCAL_PDF_STORE).delete(key);
  await done;
  db.close();
}

async function clearLocalPdfs(): Promise<void> {
  const db = await openLocalPdfDb();
  const transaction = db.transaction(LOCAL_PDF_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(LOCAL_PDF_STORE).clear();
  await done;
  db.close();
}

function openLocalPdfDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_PDF_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(LOCAL_PDF_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function isStoredPdf(value: unknown): value is StoredPdf {
  return (
    isRecord(value) &&
    value.blob instanceof Blob &&
    typeof value.filename === "string" &&
    value.filename.length > 0
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const value = (await response.clone().json()) as unknown;
    if (isErrorPayload(value) && typeof value.error === "string" && value.error.length > 0) {
      return value.error;
    }
  } catch {
    // Keep the teacher-facing fallback below.
  }
  return fallback;
}

function safeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char] ?? char,
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}
