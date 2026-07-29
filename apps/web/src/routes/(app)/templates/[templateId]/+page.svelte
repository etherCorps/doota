<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import EmailEditor from '$lib/components/templates/email-editor.svelte';
	let { data } = $props();

	// v2 templates store { doc (Tiptap), settings } in editorJson. Older/other
	// templates without a Tiptap doc open in an empty canvas.
	function parse(json: string | null | undefined): { doc: unknown; settings: Record<string, unknown> } {
		if (!json) return { doc: null, settings: {} };
		try {
			const p = JSON.parse(json);
			return { doc: p?.doc ?? null, settings: p?.settings && typeof p.settings === 'object' ? p.settings : {} };
		} catch {
			return { doc: null, settings: {} };
		}
	}
	const parsed = $derived(parse(data.template.version?.editorJson));
</script>

<div class="h-full">
	<EmailEditor
		orgId={data.orgId}
		templateId={data.template.id}
		initialName={data.template.name}
		initialSubject={data.template.version?.subjectTemplate ?? ''}
		initialDoc={parsed.doc as never}
		initialSettings={parsed.settings as never}
	/>
</div>
