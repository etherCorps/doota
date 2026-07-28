<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// A new build is live (SvelteKit polls version.json — see svelte.config.js
	// version.pollInterval). The running SPA still holds the old JS, so we surface
	// a persistent, dismissible prompt to reload. One prompt per detection.
	import { updated } from '$app/state';
	import { toast } from 'svelte-sonner';

	let prompted = false;
	$effect(() => {
		if (!updated.current || prompted) return;
		prompted = true;
		toast('Update ready', {
			description: 'A new version of Doota is available — restart to get it.',
			duration: Number.POSITIVE_INFINITY,
			action: { label: 'Restart', onClick: () => location.reload() }
		});
	});
</script>
