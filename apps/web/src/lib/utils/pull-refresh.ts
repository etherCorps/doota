// SPDX-License-Identifier: Apache-2.0
// Pull-to-refresh for a touch scroll container. Engages only when the container
// is already at the top and the drag is downward; preventDefault then suppresses
// the native rubber-band so the custom indicator owns the gesture. Progress is
// reported with resistance (0..~1.4 of threshold); release past 1 fires
// onRefresh and holds the busy state until it settles.

type PullOpts = {
	onRefresh: () => Promise<void> | void;
	/** px of resisted travel that counts as a trigger. */
	threshold?: number;
	/** 0 = idle · 0..1 pulling · ≥1 armed. Drives the indicator. */
	onProgress?: (ratio: number) => void;
	/** Busy flips true while onRefresh runs (spinner state). */
	onBusy?: (busy: boolean) => void;
	enabled?: () => boolean;
};

export function pullToRefresh(node: HTMLElement, opts: PullOpts) {
	const threshold = opts.threshold ?? 64;
	let startY = 0;
	let pulling = false;
	let engaged = false;
	let busy = false;
	let ratio = 0;

	function onStart(e: TouchEvent) {
		if (busy) return;
		if (opts.enabled && !opts.enabled()) return;
		if (node.scrollTop > 0) return;
		startY = e.touches[0].clientY;
		pulling = true;
		engaged = false;
		ratio = 0;
	}

	function onMove(e: TouchEvent) {
		if (!pulling || busy) return;
		const dy = e.touches[0].clientY - startY;
		if (node.scrollTop > 0 || dy <= 0) {
			if (engaged) {
				engaged = false;
				ratio = 0;
				opts.onProgress?.(0);
			}
			return;
		}
		if (!engaged && dy < 10) return; // slop before hijacking
		engaged = true;
		e.preventDefault(); // suppress native bounce; the indicator is the feedback
		ratio = Math.min((dy * 0.45) / threshold, 1.4); // resistance
		opts.onProgress?.(ratio);
	}

	async function onEnd() {
		if (!pulling) return;
		pulling = false;
		if (!engaged) return;
		engaged = false;
		if (ratio >= 1) {
			busy = true;
			opts.onBusy?.(true);
			opts.onProgress?.(1);
			try {
				await opts.onRefresh();
			} finally {
				busy = false;
				opts.onBusy?.(false);
				opts.onProgress?.(0);
			}
		} else {
			opts.onProgress?.(0);
		}
		ratio = 0;
	}

	node.addEventListener('touchstart', onStart, { passive: true });
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
