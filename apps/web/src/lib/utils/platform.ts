// SPDX-License-Identifier: Apache-2.0
// OS detection for shortcut display. Mac shows ⌘/⌥; everyone else Ctrl/Alt.
// The key HANDLERS already accept metaKey||ctrlKey cross-OS — this is purely
// what we render to the user.

function detectMac(): boolean {
	if (typeof navigator === "undefined") return false;
	// userAgentData.platform is the modern signal (Chromium only); fall back to
	// the deprecated-but-universal navigator.platform / UA string.
	const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
	if (uaData?.platform) return uaData.platform === "macOS";
	return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

export const isMac = detectMac();

/** iOS device (any browser — all WebKit, sharing the keyboard/drawer quirks).
 * iPadOS 13+ reports as "Macintosh", so also match touch + Mac UA. */
export function isIOS(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent;
	return /iphone|ipad|ipod/i.test(ua) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(ua));
}

/** Primary modifier symbol/word for this OS (⌘ on Mac, Ctrl elsewhere). */
export const MOD = isMac ? "⌘" : "Ctrl";
export const ALT = isMac ? "⌥" : "Alt";
export const SHIFT = isMac ? "⇧" : "Shift";
export const ENTER = isMac ? "⏎" : "Enter";
