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

/** Direction-locked swipe math (pure, unit-tested). Once a gesture commits to
 * `dir` (+1 right / -1 left) at activation, travel past zero into the other
 * direction is ignored — `eff` is the effective offset and `fire` whether
 * release should trigger the callback. Without this, a folder that handles only
 * one side (e.g. trash: no left) still animates + slides off in the other. */
export function swipeCommit(dx: number, dir: number, threshold: number) {
	const eff = Math.sign(dx) === dir ? dx : 0;
	return { eff, fire: eff !== 0 && Math.abs(eff) >= threshold };
}

export function swipeX(node: HTMLElement, opts: SwipeOpts) {
	const threshold = opts.threshold ?? 72;
	// Screen edges belong to navigation, not rows: left edge is the sidebar
	// edge-swipe / iOS back gesture, right edge the iOS forward gesture. A row
	// swipe starting there would double-fire with them (archive + sidebar open).
	const EDGE_GUARD = 28;
	let startX = 0;
	let startY = 0;
	let dx = 0;
	let active = false; // horizontal intent locked in
	let dir = 0; // committed swipe direction (+1 right / -1 left); locked at activation
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
		if (t.clientX <= EDGE_GUARD || t.clientX >= window.innerWidth - EDGE_GUARD) return;
		startX = t.clientX;
		startY = t.clientY;
		dx = 0;
		active = false;
		dir = 0;
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
			dir = Math.sign(dx); // commit to this direction for the rest of the gesture
		}
		// Horizontal intent locked: claim the gesture so pan-y can't keep
		// vertically drifting the page under the finger (needs passive:false).
		if (e.cancelable) e.preventDefault();
		// Clamp to the committed direction (see swipeCommit): dragging back past
		// zero into the other side does nothing.
		const { eff } = swipeCommit(dx, dir, threshold);
		// Resist past the threshold so it feels physical, not slippy.
		const capped = Math.sign(eff) * Math.min(Math.abs(eff), threshold * 1.6);
		setX(capped, false);
		opts.onProgress?.(Math.max(-1, Math.min(1, eff / threshold)));
	}

	function onEnd() {
		if (!tracking) return;
		tracking = false;
		if (!active) return;
		// Only the committed direction can fire — a drag reversed past zero springs back.
		const { fire } = swipeCommit(dx, dir, threshold);
		if (fire) {
			// Slide off in the swipe direction; the row's exit transition (list
			// refresh) takes over from there.
			setX(dir * node.offsetWidth, true);
			const cb = dir > 0 ? opts.onRight : opts.onLeft;
			setTimeout(() => cb?.(), reduce() ? 0 : 140);
		} else {
			setX(0, true);
			opts.onProgress?.(0);
		}
		active = false;
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	// Non-passive: onMove preventDefaults once the horizontal swipe is locked in,
	// which stops the vertical page drift during a left/right row swipe.
	node.addEventListener('touchmove', onMove, { passive: false });
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
