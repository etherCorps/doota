// SPDX-License-Identifier: Apache-2.0
// PWA install affordance. Chromium (Chrome/Edge on any desktop + Android) fires
// `beforeinstallprompt` → a real install button. Safari (iOS AND macOS) fires no
// such event but IS installable, so we detect it and hand back a manual hint:
// touch devices (iPhone/iPad) → Add to Home Screen; macOS Safari → Add to Dock.
// Installing on iOS is what unlocks Web Push there. State is reactive.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** null = not a promptless-installable browser; else which manual gesture to show. */
type Hint = "home-screen" | "dock" | null;

export const pwa = $state<{ canInstall: boolean; installed: boolean; hint: Hint }>({
	canInstall: false,
	installed: false,
	hint: null
});

let deferred: InstallPromptEvent | null = null;

if (typeof window !== "undefined") {
	const nav = navigator as Navigator & { standalone?: boolean };
	pwa.installed = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
	// Safari (macOS or iOS), excluding Chrome/Firefox/Edge on iOS (WebKit but can't
	// install). They report Apple as the vendor; the others carry CriOS/FxiOS/EdgiOS.
	const isSafari = nav.vendor === "Apple Computer, Inc." && !/crios|fxios|edgios/i.test(nav.userAgent);
	if (isSafari && !pwa.installed) pwa.hint = nav.maxTouchPoints > 0 ? "home-screen" : "dock";

	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault(); // keep it deferred; we drive the prompt from the button
		deferred = e as InstallPromptEvent;
		pwa.canInstall = true;
	});
	window.addEventListener("appinstalled", () => {
		pwa.installed = true;
		pwa.canInstall = false;
		pwa.hint = null;
		deferred = null;
	});
}

/** Fire the browser install prompt (Chromium). No-op on Safari — show `pwa.hint`
 * (home-screen / dock) as a manual instruction instead. */
export async function installApp(): Promise<void> {
	if (!deferred) return;
	await deferred.prompt();
	await deferred.userChoice;
	deferred = null;
	pwa.canInstall = false;
}
