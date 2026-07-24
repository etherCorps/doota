<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { toast } from 'svelte-sonner';
	import Login from '$lib/components/pages/login.svelte';

	let { data } = $props();

	// Surface a redirect notice (e.g. "admin already exists") once on arrival.
	$effect(() => {
		if (data.notice) toast.error(data.notice);
	});
</script>

<Login />
