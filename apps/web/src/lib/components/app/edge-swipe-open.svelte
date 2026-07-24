<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import { compose } from '$lib/client/compose.svelte.js';

	// Gmail-style edge swipe: a left-edge touch dragged right opens the mobile
	// sidebar sheet. Must be rendered inside Sidebar.Provider. The touch has to
	// START within EDGE px of the screen edge, so horizontal scrollers (editor
	// toolbar strip) and list swipes never trigger it. On iOS Safari in-browser
	// the system back gesture owns the very edge — this still works in
	// standalone/PWA mode and everywhere on Android.
	const sidebar = useSidebar();

	const EDGE = 24; // px from the left edge that arms the gesture
	const OPEN_DX = 48; // horizontal travel that commits the open
	let startX = 0;
	let startY = 0;
	let tracking = false;

	function onTouchStart(e: TouchEvent) {
		const t = e.touches[0];
		tracking = sidebar.isMobile && !sidebar.openMobile && !compose.open && t.clientX <= EDGE;
		startX = t.clientX;
		startY = t.clientY;
	}
	function onTouchMove(e: TouchEvent) {
		if (!tracking) return;
		const t = e.touches[0];
		const dx = t.clientX - startX;
		const dy = Math.abs(t.clientY - startY);
		if (dy > 40 && dy > dx) {
			tracking = false; // it's a vertical scroll
			return;
		}
		if (dx > OPEN_DX && dx > dy * 1.5) {
			tracking = false;
			sidebar.setOpenMobile(true);
		}
	}
</script>

<svelte:window ontouchstart={onTouchStart} ontouchmove={onTouchMove} />
