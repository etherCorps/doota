// SPDX-License-Identifier: Apache-2.0
// The ONE keyboard/viewport controller for the app frame. iOS never resizes the
// layout viewport for the keyboard (100dvh/svh ignore it) — visualViewport is
// the only honest signal. Every surface that used to run its own copy of this
// math (compose drawer, iOS compose overlay) either died with the /app/compose
// page rework or reads this instead (the app shell → the reply bar).
//
// Two jobs:
//  1. `height` — the visible viewport height. The (app) shell sizes itself to
//     it, so bottom-of-flex elements (the reply bar) sit exactly above the
//     keyboard with no per-component math.
//  2. Scroll pinning — iOS scrolls the WINDOW to reveal a focused input even
//     when the app manages its own scrollers, shoving the whole frame up.
//     While the keyboard is up, force the window back to 0 so the frame stays
//     put and the inner scrollers do their job.

class AppViewport {
	/** Visible viewport height in px; 0 until attached (use a svh fallback). */
	height = $state(0);
	/** Keyboard overlap in px (0 = no keyboard / hardware keyboard). */
	keyboardInset = $state(0);

	/** Wire the listeners — call from the app layout's onMount; returns cleanup. */
	attach(): () => void {
		const vv = window.visualViewport;
		if (!vv) return () => {};
		let raf = 0;
		const measure = () => {
			this.height = Math.round(vv.height);
			this.keyboardInset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
		};
		const update = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(measure);
		};
		// iOS auto-scrolls the window on input focus; while the keyboard is up,
		// pin it back so the frame doesn't get shoved off-screen.
		const pinWindow = () => {
			if (this.keyboardInset > 0 && (window.scrollY !== 0 || window.scrollX !== 0)) {
				window.scrollTo(0, 0);
			}
		};
		update();
		vv.addEventListener('resize', update);
		vv.addEventListener('scroll', update);
		window.addEventListener('scroll', pinWindow);
		return () => {
			cancelAnimationFrame(raf);
			vv.removeEventListener('resize', update);
			vv.removeEventListener('scroll', update);
			window.removeEventListener('scroll', pinWindow);
		};
	}
}

export const appViewport = new AppViewport();
