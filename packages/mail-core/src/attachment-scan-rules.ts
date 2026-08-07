// SPDX-License-Identifier: Apache-2.0
/**
 * Default YARA rule set (Phase D), bundled at build time — the product NEVER
 * fetches rules from a third party by default (a privacy-positioned self-hosted
 * mail client must not phone home to a security vendor on attachment open). An
 * operator MAY point at their own feed URL later.
 *
 * HONEST SCOPE: these catch KNOWN-family structure — embedded executables,
 * Office macros, PDF JavaScript/auto-actions, script-bearing SVG — plus the
 * EICAR test file. They MISS novel and obfuscated payloads entirely. The UI must
 * say "checked against known threat patterns", never "virus-free".
 */

// Engine + ruleset version — stamped on every verdict so a rules update is
// visible and re-scans can be triggered. Bump the rules suffix when editing below.
// (The gate rescans any persisted verdict whose version doesn't match this.)
export const SCANNER_VERSION = "yara-x-1.19.0+rules-2";

export const DEFAULT_YARA_RULES = String.raw`
rule embedded_pe_executable {
  meta:
    description = "Windows executable (PE) — .exe/.dll/.scr payload"
  strings:
    $mz = { 4D 5A }
  condition:
    $mz at 0 and uint32(uint32(0x3C)) == 0x00004550
}

rule ole_compound_document {
  meta:
    description = "OLE compound document (legacy Office — may carry a macro)"
  strings:
    $ole = { D0 CF 11 E0 A1 B1 1A E1 }
  condition:
    $ole at 0
}

rule ooxml_vba_macro {
  meta:
    description = "Office document with a VBA macro project"
  strings:
    $vba = "vbaProject.bin"
  condition:
    uint16(0) == 0x4B50 and $vba
}

rule pdf_active_content {
  meta:
    description = "PDF with embedded JavaScript or a launch action"
  strings:
    $js = "/JavaScript"
    $js2 = /\/JS\s*[\[(<]/
    $launch = "/Launch"
  condition:
    uint32(0) == 0x46445025 and any of ($js, $js2, $launch)
}
// NOT flagged: /OpenAction and /AA alone. Nearly every benign PDF (Word/LaTeX/
// print-to-PDF) carries an /OpenAction goto-page action — flagging it marked
// ordinary documents as threats (rules-1 false positive, found live). The
// dangerous auto-run payloads are JavaScript and Launch actions, both of which
// still match above regardless of how they're triggered.

rule script_bearing_svg {
  meta:
    description = "SVG/XML document carrying a script (stored-XSS vector)"
  strings:
    $svg = "<svg" nocase
    $script = "<script" nocase
    $onload = "onload=" nocase
  condition:
    $svg and ($script or $onload)
}

rule eicar_test_file {
  meta:
    description = "EICAR antivirus test string (harmless test payload)"
  strings:
    $eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
  condition:
    $eicar
}
`;
