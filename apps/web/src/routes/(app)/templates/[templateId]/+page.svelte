<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import TemplateBuilder from '$lib/components/templates/template-builder.svelte';
	let { data } = $props();

	// Parse the stored block document (builder-authored templates). Code-authored
	// templates have no editorJson — the builder starts empty over their content.
	function parseBlocks(json: string | null | undefined) {
		if (!json) return [];
		try {
			const doc = JSON.parse(json);
			return Array.isArray(doc?.blocks) ? doc.blocks : [];
		} catch {
			return [];
		}
	}
	const blocks = $derived(parseBlocks(data.template.version?.editorJson));
</script>

<div class="mx-auto w-full max-w-5xl p-4 sm:p-6 md:p-8">
	<h1 class="font-heading mb-4 text-xl font-semibold">Edit template</h1>
	<TemplateBuilder
		orgId={data.orgId}
		templateId={data.template.id}
		initialName={data.template.name}
		initialSubject={data.template.version?.subjectTemplate ?? ''}
		initialBlocks={blocks}
	/>
</div>
