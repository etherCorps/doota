// SPDX-License-Identifier: Apache-2.0
/**
 * OPFS-backed cache for template-editor drafts. Templates can be large
 * (compiled HTML, inline assets), so drafts persist to the Origin Private File
 * System on disk rather than living in memory / localStorage. Best-effort:
 * every call is a no-op (or null) when OPFS is unavailable or errors.
 */
function available(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** Write a string to the OPFS cache (overwrites). */
export async function opfsWrite(key: string, data: string): Promise<void> {
  if (!available()) return;
  try {
    const fh = await (await root()).getFileHandle(safeName(key), { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  } catch {
    // best-effort cache — never throw into the editor
  }
}

/** Read a string from the OPFS cache, or null if absent/unavailable. */
export async function opfsRead(key: string): Promise<string | null> {
  if (!available()) return null;
  try {
    const fh = await (await root()).getFileHandle(safeName(key));
    return await (await fh.getFile()).text();
  } catch {
    return null;
  }
}

/** Remove a cache entry (e.g. after publishing). */
export async function opfsDelete(key: string): Promise<void> {
  if (!available()) return;
  try {
    await (await root()).removeEntry(safeName(key));
  } catch {
    // ignore
  }
}
