// SPDX-License-Identifier: Apache-2.0
// Chunked mbox upload. The file stays on disk — `File.slice()` is lazy, so a
// 10 GB archive never enters memory; only one 8 MB chunk does at a time.
//
// The tab has to stay open for the upload (a File handle dies with the page
// that opened it, and nothing else can read it). The IMPORT itself is
// background — once the last chunk lands, the queue owns it and the browser is
// free. Interrupting an upload is a pause, not a loss: parts are indexed and
// idempotent, so a resumed upload just skips what already landed.
import { PART_PLAINTEXT_BYTES } from "@doota/mail-core/import";

export type UploadProgress = { uploadedBytes: number; totalBytes: number; partIndex: number; partCount: number };

export class UploadAborted extends Error {
  constructor() {
    super("Upload stopped");
    this.name = "UploadAborted";
  }
}

/**
 * Push `file` to /api/import in PART_PLAINTEXT_BYTES chunks.
 *
 * `fromPart` resumes: parts below it are assumed already stored. The chunk size
 * is fixed by the server contract — the job maps a byte cursor to a part index
 * by division, so a client that chose its own size would corrupt the cursor.
 */
export async function uploadMbox(
  file: File,
  importId: string,
  options: {
    fromPart?: number;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
  } = {},
): Promise<void> {
  const partCount = Math.max(1, Math.ceil(file.size / PART_PLAINTEXT_BYTES));
  const start = options.fromPart ?? 0;

  for (let partIndex = start; partIndex < partCount; partIndex++) {
    if (options.signal?.aborted) throw new UploadAborted();
    const from = partIndex * PART_PLAINTEXT_BYTES;
    const chunk = file.slice(from, Math.min(from + PART_PLAINTEXT_BYTES, file.size));

    const response = await fetch(`/api/import?importId=${encodeURIComponent(importId)}&index=${partIndex}`, {
      method: "POST",
      body: chunk,
      signal: options.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail.slice(0, 200) || `Chunk ${partIndex + 1} failed (${response.status})`);
    }

    options.onProgress?.({
      uploadedBytes: Math.min(from + chunk.size, file.size),
      totalBytes: file.size,
      partIndex: partIndex + 1,
      partCount,
    });
  }
}
