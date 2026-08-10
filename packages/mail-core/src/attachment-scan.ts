// SPDX-License-Identifier: Apache-2.0
/**
 * Attachment scan engine (Phase D). Runs in a Web Worker on the client the
 * moment a user opens an attachment — the one place the check is real, because
 * at open the attacker is the sender and the user is the victim (unlike upload,
 * where the user is the attacker and a client check is theatre).
 *
 * The engine is pure and yara-agnostic: it takes a `YaraScanner` (the yara-x
 * WASM rules, or a stub in tests) and owns the size cap, the archive zip-bomb
 * caps, and the fail-closed verdict rules. Never claims "virus-free" — YARA with
 * public rules catches known families + suspicious structure and misses novel /
 * obfuscated payloads. The verdict is advisory (a display signal), not an
 * authorization input.
 *
 * Fail-closed on the label: a timeout, oversized file, zip-bomb breach, or crash
 * records `skipped`/`error`, never `clean`. (Fail-open on the action: the caller
 * may still let the user download after an explicit confirm.)
 */

export type ScanVerdict = "clean" | "matched" | "skipped" | "error";
export type ScanResult = { verdict: ScanVerdict; rule: string | null; reason?: string };

// Beyond this, `skipped` with an honest message (the worker would lock the tab).
export const SCAN_MAX_BYTES = 25 * 1024 * 1024;
// Archive scanning is where the value is and where the DoS is. Without these
// caps a sender can hang any recipient's browser.
export const ZIP_MAX_DEPTH = 3;
export const ZIP_MAX_ENTRIES = 1000;
export const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const ZIP_MAX_RATIO = 100;

/** The yara side, injected so the engine stays testable without the WASM. */
export interface YaraScanner {
  /** Returns the identifiers of every matching rule (empty = clean). */
  scan(bytes: Uint8Array): string[];
}
/** Decompress one zip entry to bytes — injected (fflate in the worker). */
export type Inflate = (compressed: Uint8Array, method: number, uncompressedSize: number) => Uint8Array;

const clean: ScanResult = { verdict: "clean", rule: null };
const skipped = (reason: string): ScanResult => ({ verdict: "skipped", rule: null, reason });

function isZip(bytes: Uint8Array): boolean {
  // Local file header (PK\x03\x04) or empty-archive EOCD (PK\x05\x06).
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

type ZipEntry = { name: string; compSize: number; uncompSize: number; method: number; localOffset: number };

/**
 * Parse the ZIP central directory to read declared sizes + count without
 * decompressing, so a bomb is rejected on its own metadata, never expanded.
 * Returns null when the archive is malformed (caller treats as skipped).
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the End Of Central Directory record (scan back from the end; comment ≤ 64KB).
  const minEocd = 22;
  let eocd = -1;
  for (let i = bytes.length - minEocd; i >= Math.max(0, bytes.length - minEocd - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset >= bytes.length) return null;

  const entries: ZipEntry[] = [];
  let ptr = cdOffset;
  for (let i = 0; i < total; i++) {
    if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) return null;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.push({ name, compSize, uncompSize, method, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Raw compressed bytes of one entry from its local header. */
function entryCompressedBytes(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localOffset;
  if (off + 30 > bytes.length || view.getUint32(off, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const start = off + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + entry.compSize);
}

/**
 * Scan a buffer. `depth` tracks archive recursion. `budget` accumulates total
 * decompressed bytes across the whole (possibly nested) archive tree so a fan-out
 * of small archives can't collectively blow the cap.
 */
export function scanBuffer(
  scanner: YaraScanner,
  inflate: Inflate,
  bytes: Uint8Array,
  filename: string,
  depth = 0,
  budget = { used: 0 },
): ScanResult {
  try {
    if (bytes.length > SCAN_MAX_BYTES) return skipped("larger than 25 MB");

    // Always run the rules over the container bytes first (catches an embedded
    // executable / PDF JavaScript / macro markers even inside an archive entry).
    const hits = scanner.scan(bytes);
    if (hits.length) return { verdict: "matched", rule: hits[0] };

    if (isZip(bytes)) {
      if (depth >= ZIP_MAX_DEPTH) return skipped("archive nested too deep");
      const entries = readCentralDirectory(bytes);
      if (!entries) return skipped("unreadable archive");
      if (entries.length > ZIP_MAX_ENTRIES) return skipped("too many archive entries");

      // Cap on declared sizes, before decompressing anything.
      let declaredTotal = 0;
      let compTotal = 0;
      for (const entry of entries) {
        declaredTotal += entry.uncompSize;
        compTotal += entry.compSize;
      }
      if (budget.used + declaredTotal > ZIP_MAX_TOTAL_BYTES) return skipped("archive expands too large");
      if (compTotal > 0 && declaredTotal / compTotal > ZIP_MAX_RATIO) return skipped("archive expansion ratio too high");

      for (const entry of entries) {
        if (entry.name.endsWith("/")) continue; // directory
        const comp = entryCompressedBytes(bytes, entry);
        if (!comp) return skipped("unreadable archive entry");
        let inflated: Uint8Array;
        try {
          inflated = inflate(comp, entry.method, entry.uncompSize);
        } catch {
          return skipped("archive entry failed to decompress");
        }
        budget.used += inflated.length;
        if (budget.used > ZIP_MAX_TOTAL_BYTES) return skipped("archive expands too large");
        const inner = scanBuffer(scanner, inflate, inflated, entry.name, depth + 1, budget);
        if (inner.verdict !== "clean") return inner; // matched OR skipped bubbles up
      }
    }
    return clean;
  } catch (err) {
    // A crash never reads as clean — that's the worst outcome available.
    return { verdict: "error", rule: null, reason: err instanceof Error ? err.message : "scan error" };
  }
}
