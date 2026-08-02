<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { tick } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import { addNote, mentionCandidates } from '$lib/rpc/thread.remote';

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
	let ta = $state<HTMLTextAreaElement | null>(null);

	// @mention picker — teammates are fetched ONCE (on the first '@') and cached,
	// then filtered locally per keystroke so typing never hits the server.
	type Cand = { name: string; handle: string };
	let members = $state<Cand[]>([]);
	let loaded = $state(false);
	let menu = $state<{ start: number; items: Cand[]; active: number } | null>(null);

	async function ensureMembers() {
		if (loaded) return;
		loaded = true;
		try {
			members = await mentionCandidates(mailboxId);
		} catch {
			members = [];
		}
	}

	/** An active "@token" ending at the caret: `@` at word-start followed by
	 * mention chars, with nothing but those chars up to the caret. */
	function activeToken(text: string, caret: number): { start: number; q: string } | null {
		let i = caret - 1;
		while (i >= 0 && /[a-zA-Z0-9._+-]/.test(text[i])) i--;
		if (i < 0 || text[i] !== '@') return null;
		const before = i === 0 ? '' : text[i - 1];
		if (before && !/\s/.test(before)) return null; // @ must start a word
		return { start: i, q: text.slice(i + 1, caret).toLowerCase() };
	}

	async function refreshMenu() {
		if (!ta) return;
		const caret = ta.selectionStart ?? body.length;
		const token = activeToken(body, caret);
		if (!token) {
			menu = null;
			return;
		}
		await ensureMembers();
		const items = members
			.filter((candidate) => !token.q || candidate.handle.toLowerCase().includes(token.q) || candidate.name.toLowerCase().includes(token.q))
			.slice(0, 6);
		menu = items.length ? { start: token.start, items, active: 0 } : null;
	}

	function pick(candidate: Cand) {
		if (!ta || !menu) return;
		const caret = ta.selectionStart ?? body.length;
		const before = body.slice(0, menu.start);
		const after = body.slice(caret);
		const insert = `@${candidate.handle} `;
		body = before + insert + after;
		const pos = before.length + insert.length;
		menu = null;
		tick().then(() => {
			ta?.focus();
			ta?.setSelectionRange(pos, pos);
		});
	}

	async function add() {
		if (!body.trim()) return;
		saving = true;
		try {
			await addNote({ mailboxId, threadId, body });
			body = '';
			menu = null;
			onchange?.();
		} finally {
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (menu) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				menu.active = (menu.active + 1) % menu.items.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				menu.active = (menu.active - 1 + menu.items.length) % menu.items.length;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				pick(menu.items[menu.active]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				menu = null;
				return;
			}
		}
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
	<div class="relative">
		<Textarea
			bind:value={body}
			bind:ref={ta}
			oninput={refreshMenu}
			onkeyup={refreshMenu}
			onclick={refreshMenu}
			onkeydown={onKeydown}
			onblur={() => setTimeout(() => (menu = null), 120)}
			placeholder="Write a note for your team… @mention a teammate to notify them"
			class="bg-background min-h-[60px] border-amber-300/60 dark:border-amber-500/20"
		/>
		{#if menu}
			<ul
				class="bg-popover absolute top-full right-0 left-0 z-20 mt-1 max-h-48 overflow-auto rounded-md border py-1 shadow-md"
				role="listbox"
			>
				{#each menu.items as candidate, i (candidate.handle)}
					<li>
						<button
							type="button"
							role="option"
							aria-selected={i === menu.active}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm {i === menu.active
								? 'bg-muted'
								: ''}"
							onmousedown={(e) => {
								e.preventDefault();
								pick(candidate);
							}}
							onmouseenter={() => menu && (menu.active = i)}
						>
							<AtSignIcon class="text-muted-foreground size-3.5 shrink-0" />
							<span class="truncate font-medium">{candidate.name}</span>
							<span class="text-muted-foreground truncate text-xs">@{candidate.handle}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
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
