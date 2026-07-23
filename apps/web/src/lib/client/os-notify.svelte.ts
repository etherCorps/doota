// Tab-open OS notifications (Notification API). Events only arrive over the
// mailEvents live stream, so these fire while some tab is open but hidden or
// unfocused — which is exactly when in-app toasts/badges are invisible.
// ponytail: no service worker — move to Web Push when the PWA lands.

export const notifPerm = $state({
	current: (typeof Notification === 'undefined'
		? 'denied'
		: Notification.permission) as NotificationPermission
});

/** Must be called from a user gesture (browsers block ambient prompts). */
export async function enableOsNotifications() {
	if (typeof Notification === 'undefined') return;
	notifPerm.current = await Notification.requestPermission();
}

// Soft two-tone chirp for the focused-tab case (where the OS notification
// no-ops and the system sound never plays). Web Audio oscillator — no asset.
// Throttled so a burst of replies doesn't machine-gun; the browser's autoplay
// policy keeps it silent until the user has interacted with the page.
// ponytail: no volume/off toggle — add a settings switch if the chirp annoys.
let lastChirp = 0;
function chirp() {
	const now = Date.now();
	if (now - lastChirp < 3_000) return;
	lastChirp = now;
	try {
		const ctx = new AudioContext();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.connect(gain).connect(ctx.destination);
		osc.type = 'sine';
		osc.frequency.setValueAtTime(880, ctx.currentTime);
		osc.frequency.setValueAtTime(1175, ctx.currentTime + 0.09);
		gain.gain.setValueAtTime(0.06, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
		osc.start();
		osc.stop(ctx.currentTime + 0.25);
		osc.onended = () => void ctx.close();
	} catch {
		// no audio available — stay silent
	}
}

/** Focused tab → in-app chirp; hidden/unfocused → OS notification (system
 * sound comes with it, so no chirp — avoids the double sound). Both gated on
 * the user having granted notification permission. */
export function osNotify(title: string, body?: string, tag?: string) {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
	if (document.visibilityState === 'visible' && document.hasFocus()) {
		chirp();
		return;
	}
	try {
		const n = new Notification(title, { body, tag });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {
		// Some platforms throw without a service worker (Android Chrome) — fine,
		// those get real push when the PWA lands.
	}
}
