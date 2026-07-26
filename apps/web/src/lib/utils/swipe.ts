// SPDX-License-Identifier: Apache-2.0
// Horizontal swipe gesture for list rows (touch only). Owns the row's
// transform; vertical scrolling stays native via touch-action: pan-y and a
// horizontal-intent lock (|dx| > |dy| and past a slop threshold before we
// hijack). Past the trigger threshold on release, the row animates off-screen
// and the callback fires; otherwise it springs back.

type SwipeOpts = {
	onLeft?: () => void;
	onRight?: () => void;
	/** px travelled before release counts as a trigger. */
	threshold?: number;
	/** Reports live progress (-1..1 of threshold) for background reveals. */
	onProgress?: (ratio: number) => void;
	enabled?: () => boolean;
};

export function swipeX(node: HTMLElement, opts: SwipeOpts) {
	const threshold = opts.threshold ?? 72;
	let startX = 0;
	let startY = 0;
	let dx = 0;
	let active = false; // horizontal intent locked in
	let tracking = false;

	node.style.touchAction = 'pan-y';

	function reduce() {
		return matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	function setX(x: number, animate: boolean) {
		node.style.transition = animate && !reduce() ? 'transform 180ms cubic-bezier(0.22,1,0.36,1)' : '';
		node.style.transform = x ? `translateX(${x}px)` : '';
	}

	function onStart(e: TouchEvent) {
		if (opts.enabled && !opts.enabled()) return;
		const t = e.touches[0];
		startX = t.clientX;
		startY = t.clientY;
		dx = 0;
		active = false;
		tracking = true;
	}

	function onMove(e: TouchEvent) {
		if (!tracking) return;
		const t = e.touches[0];
		dx = t.clientX - startX;
		const dy = t.clientY - startY;
		if (!active) {
			if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
				tracking = false; // vertical scroll wins
				return;
			}
			if (Math.abs(dx) < 12) return; // slop
			// Only directions with a handler engage — no dead rubber-banding.
			if ((dx > 0 && !opts.onRight) || (dx < 0 && !opts.onLeft)) {
				tracking = false;
				return;
			}
			active = true;
		}
		// Resist past the threshold so it feels physical, not slippy.
		const capped = Math.sign(dx) * Math.min(Math.abs(dx), threshold * 1.6);
		setX(capped, false);
		opts.onProgress?.(Math.max(-1, Math.min(1, dx / threshold)));
	}

	function onEnd() {
		if (!tracking) return;
		tracking = false;
		if (!active) return;
		const fire = Math.abs(dx) >= threshold;
		if (fire) {
			// Slide off in the swipe direction; the row's exit transition (list
			// refresh) takes over from there.
			setX(Math.sign(dx) * node.offsetWidth, true);
			const cb = dx > 0 ? opts.onRight : opts.onLeft;
			setTimeout(() => cb?.(), reduce() ? 0 : 140);
		} else {
			setX(0, true);
			opts.onProgress?.(0);
		}
		active = false;
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: true });
	node.addEventListener('touchend', onEnd);
	node.addEventListener('touchcancel', onEnd);
	return {
		destroy() {
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchmove', onMove);
			node.removeEventListener('touchend', onEnd);
			node.removeEventListener('touchcancel', onEnd);
		}
	};
}
