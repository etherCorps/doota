<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import { addNote } from '$lib/rpc/thread.remote';

	// Internal-note composer — DELIBERATELY distinct from the reply composer
	// (amber, "not sent" label) so a note is never mistaken for an email and the
	// note surface is never mistaken for the reply surface.
	let {
		mailboxId,
		threadId,
		onchange
	}: { mailboxId: string; threadId: string; onchange?: () => void } = $props();

	let body = $state('');
	let saving = $state(false);

	async function add() {
		if (!body.trim()) return;
		saving = true;
		try {
			await addNote({ mailboxId, threadId, body });
			body = '';
			onchange?.();
		} finally {
			saving = false;
		}
	}
	function onKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			add();
		}
	}
</script>

<div class="border-t border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/20 dark:bg-amber-950/25">
	<div class="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500">
		<StickyNoteIcon class="size-3.5" />
		Internal note — only your team sees this, never sent to anyone
	</div>
	<Textarea
		bind:value={body}
		onkeydown={onKeydown}
		placeholder="Write a note for your team…"
		class="bg-background min-h-[60px] border-amber-300/60 dark:border-amber-500/20"
	/>
	<div class="mt-2 flex justify-end">
		<Button
			size="sm"
			class="gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
			disabled={!body.trim() || saving}
			onclick={add}
		>
			<StickyNoteIcon class="size-3.5" /> Add note
		</Button>
	</div>
</div>
