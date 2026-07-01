import type { JobStatus } from "./validation";

export type LocalHistoryItem = {
  jobId: string;
  contentId: string;
  title: string;
  pageCount: number;
  status: JobStatus;
  downloadUrl?: string;
  localPdfKey?: string;
  filename?: string;
  createdAt: number;
  updatedAt: number;
};

export const LOCAL_HISTORY_KEY = "zhice.localHistory.v1";
