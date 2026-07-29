<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import TemplateBuilder from '$lib/components/templates/template-builder.svelte';
	let { data } = $props();
</script>

<div class="mx-auto w-full max-w-5xl p-4 sm:p-6 md:p-8">
	<h1 class="font-heading mb-4 text-xl font-semibold">New template</h1>
	<TemplateBuilder orgId={data.orgId} />
</div>
