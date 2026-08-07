// SPDX-License-Identifier: Apache-2.0
// Phase D stop gates (scanner): rules match known-bad structure, clean is clean,
// and the zip-bomb caps abort to `skipped` WITHOUT expanding the archive — with
// the real yara-x WASM engine, not a stub.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync, zipSync } from "fflate";
import { Compiler, initSync } from "@virustotal/yara-x";
import {
  scanBuffer,
  type YaraScanner,
  type Inflate,
  ZIP_MAX_TOTAL_BYTES,
} from "@doota/mail-core/attachment-scan";
import { DEFAULT_YARA_RULES } from "@doota/mail-core/attachment-scan-rules";

let scanner: YaraScanner;
const inflate: Inflate = (comp, method) => (method === 0 ? comp : inflateSync(comp));
const bytes = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
  const wasmPath = fileURLToPath(
    new URL("../../node_modules/@virustotal/yara-x/pkg/yara_x_js_bg.wasm", import.meta.url),
  );
  initSync({ module: readFileSync(wasmPath) });
  const compiler = new Compiler();
  compiler.addSource(DEFAULT_YARA_RULES);
  const rules = compiler.build();
  // yara-x scan() returns { matching_rules: [{ identifier }] } — normalize to names.
  scanner = {
    scan(input) {
      const result = rules.scan(input) as { matches?: { identifier: string }[] };
      return (result.matches ?? []).map((r) => r.identifier);
    },
  };
});

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("attachment scanner — rules", () => {
  it("matches the EICAR test file", () => {
    const r = scanBuffer(scanner, inflate, bytes(EICAR), "eicar.txt");
    expect(r.verdict).toBe("matched");
    expect(r.rule).toBe("eicar_test_file");
  });

  it("matches an embedded PE executable", () => {
    // MZ header, e_lfanew=0x40, "PE\\0\\0" at 0x40.
    const pe = new Uint8Array(0x48);
    pe[0] = 0x4d; pe[1] = 0x5a; // MZ
    new DataView(pe.buffer).setUint32(0x3c, 0x40, true); // e_lfanew
    pe[0x40] = 0x50; pe[0x41] = 0x45; pe[0x42] = 0; pe[0x43] = 0; // PE\0\0
    const r = scanBuffer(scanner, inflate, pe, "setup.exe");
    expect(r.verdict).toBe("matched");
    expect(r.rule).toBe("embedded_pe_executable");
  });

  it("passes an ordinary PDF with /OpenAction as clean (rules-2 false-positive fix)", () => {
    // Nearly every Word/LaTeX/print-to-PDF document carries an /OpenAction
    // goto-page action; rules-1 flagged them all as threats.
    const pdf = "%PDF-1.7\n1 0 obj<</Type/Catalog/OpenAction[3 0 R /Fit]/AA<<>>>>endobj\ntrailer";
    expect(scanBuffer(scanner, inflate, bytes(pdf), "report.pdf").verdict).toBe("clean");
  });

  it("still matches a PDF carrying JavaScript", () => {
    const pdf = "%PDF-1.7\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj";
    const r = scanBuffer(scanner, inflate, bytes(pdf), "invoice.pdf");
    expect(r.verdict).toBe("matched");
    expect(r.rule).toBe("pdf_active_content");
  });

  it("still matches a PDF with a Launch action", () => {
    const pdf = "%PDF-1.7\n1 0 obj<</S/Launch/F(cmd.exe)>>endobj";
    expect(scanBuffer(scanner, inflate, bytes(pdf), "x.pdf").rule).toBe("pdf_active_content");
  });

  it("passes a plain-text file as clean", () => {
    expect(scanBuffer(scanner, inflate, bytes("just a normal note, nothing here"), "note.txt").verdict).toBe("clean");
  });

  it("finds a threat nested inside a real archive", () => {
    const zip = zipSync({ "readme.txt": bytes("hi"), "payload.txt": bytes(EICAR) });
    const r = scanBuffer(scanner, inflate, zip, "bundle.zip");
    expect(r.verdict).toBe("matched");
    expect(r.rule).toBe("eicar_test_file");
  });
});

describe("attachment scanner — zip-bomb caps (fail-closed, never expands)", () => {
  it("skips an archive whose declared uncompressed size exceeds the cap — without decompressing", () => {
    // A real 1-entry zip, then LIE in the central directory: claim a huge
    // uncompressed size. The cap must read that and abort to `skipped`.
    const zip = zipSync({ "a.txt": bytes("small") });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Find the central-directory header (PK\x01\x02) and overwrite uncompSize (+24).
    for (let i = 0; i < zip.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, ZIP_MAX_TOTAL_BYTES + 1, true);
        break;
      }
    }
    let inflated = false;
    const spyInflate: Inflate = (c, m) => {
      inflated = true;
      return m === 0 ? c : inflateSync(c);
    };
    const r = scanBuffer(scanner, spyInflate, zip, "bomb.zip");
    expect(r.verdict).toBe("skipped");
    expect(inflated).toBe(false); // never expanded the bomb
  });

  it("skips an archive nested past the depth cap", () => {
    let inner = zipSync({ "x.txt": bytes("hi") });
    for (let d = 0; d < 4; d++) inner = zipSync({ "nested.zip": inner });
    const r = scanBuffer(scanner, inflate, inner, "deep.zip");
    expect(r.verdict).toBe("skipped");
  });

  it("never returns clean for an oversized file", () => {
    const big = new Uint8Array(26 * 1024 * 1024); // > 25 MB
    const r = scanBuffer(scanner, inflate, big, "huge.bin");
    expect(r.verdict).toBe("skipped");
    expect(r.verdict).not.toBe("clean");
  });
});
