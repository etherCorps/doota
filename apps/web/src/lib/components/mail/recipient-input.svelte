<script lang="ts">
	import { recipientSuggestions } from '$lib/rpc/draft.remote';
	import SenderAvatar from './sender-avatar.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import type { RecipientSuggestion } from '@doota/mail-core/contacts';

	// Recipient token input with autocomplete: org teammates (name + avatar)
	// and prior correspondents. Addresses render in JetBrains Mono per the
	// design system.
	let {
		value = $bindable<string[]>([]),
		placeholder = 'name@domain.com',
		onchange
	}: { value?: string[]; placeholder?: string; onchange?: () => void } = $props();

	let text = $state('');
	let suggestions = $state<RecipientSuggestion[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0; // drop out-of-order fetch results
	const uid = $props.id();

	function commit(addr: string) {
		const a = addr.trim().toLowerCase();
		if (a && a.includes('@') && !value.includes(a)) {
			value = [...value, a];
			onchange?.();
		}
		text = '';
		suggestions = [];
		open = false;
		active = -1;
	}
	function remove(a: string) {
		value = value.filter((x) => x !== a);
		onchange?.();
	}
	function onInput() {
		clearTimeout(timer);
		const q = text.trim();
		if (!q) {
			suggestions = [];
			open = false;
			active = -1;
			return;
		}
		timer = setTimeout(async () => {
			const mySeq = ++seq;
			const res = (await recipientSuggestions(q)).filter((s) => !value.includes(s.address));
			// A slower earlier response must not clobber a newer one — that's the
			// "list flickers back" glitch.
			if (mySeq !== seq) return;
			suggestions = res;
			open = res.length > 0;
			active = -1;
		}, 200);
	}
	function moveActive(delta: number) {
		// Cycle over n+1 states (suggestions plus the -1 "free text" state): shift
		// to 0-based, step, wrap, shift back.
		active = ((active + 1 + delta + suggestions.length + 1) % (suggestions.length + 1)) - 1;
		if (active >= 0) {
			document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
		}
	}
	function onKeydown(e: KeyboardEvent) {
		if (open && e.key === 'ArrowDown') {
			e.preventDefault();
			moveActive(1);
		} else if (open && e.key === 'ArrowUp') {
			e.preventDefault();
			moveActive(-1);
		} else if (open && e.key === 'Escape') {
			// preventDefault keeps outer Escape handlers (close composer) from firing.
			e.preventDefault();
			open = false;
			active = -1;
		} else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && open && active >= 0)) {
			e.preventDefault();
			commit(open && active >= 0 ? suggestions[active].address : text);
		} else if (e.key === 'Backspace' && !text && value.length) {
			remove(value[value.length - 1]);
		}
	}

	/** Display name fallback: prettified local part. */
	function displayName(s: RecipientSuggestion): string {
		if (s.name) return s.name;
		const local = s.address.split('@')[0] ?? s.address;
		return local.replace(/[._-]+/g, ' ').trim() || s.address;
	}

	// Deterministic avatar tint per address, drawn from the app's own hues
	// (brand + participant palette) so chips read cohesive; tokens flip per theme.
	const TINTS = [
		'bg-brand/15 text-brand',
		'bg-p1/15 text-p1',
		'bg-p2/15 text-p2',
		'bg-p3/15 text-p3',
		'bg-ok/15 text-ok'
	];
	function tint(addr: string): string {
		let h = 0;
		for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
		return TINTS[h % TINTS.length];
	}
</script>

<div class="relative">
	<div class="focus-within:ring-ring/40 flex flex-wrap items-center gap-1 rounded-xl border bg-input/40 px-2 py-1.5 transition-colors focus-within:border-ring/60 focus-within:ring-2">
		{#each value as a (a)}
			<span class="bg-muted flex items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-0.5 text-xs">
				<span class="grid size-5 place-items-center rounded-full text-[10px] font-semibold uppercase {tint(a)}">
					{a[0] ?? '?'}
				</span>
				<span class="font-mono">{a}</span>
				<button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => remove(a)}>
					<XIcon class="size-3" />
				</button>
			</span>
		{/each}
		<input
			class="min-w-[10ch] flex-1 bg-transparent font-mono text-sm outline-none"
			{placeholder}
			role="combobox"
			aria-expanded={open}
			aria-controls="{uid}-listbox"
			aria-autocomplete="list"
			aria-activedescendant={open && active >= 0 ? `${uid}-opt-${active}` : undefined}
			bind:value={text}
			oninput={onInput}
			onkeydown={onKeydown}
			onblur={() => commit(text)}
		/>
	</div>
	{#if open}
		<ul id="{uid}-listbox" role="listbox" class="bg-popover absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-xl border p-1 shadow-lg">
			{#each suggestions as s, i (s.address)}
				<li id="{uid}-opt-{i}" role="option" aria-selected={active === i}>
					<!-- pointerdown (not click): fires before the input's blur commits the
					     raw text — same reason the old mousedown was there, but pointer
					     covers touch too. mouseenter syncs hover with the keyboard
					     highlight so there's never two highlighted rows. -->
					<button
						type="button"
						tabindex="-1"
						class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors {active === i ? 'bg-accent text-accent-foreground' : ''}"
						onpointerdown={(e) => {
							e.preventDefault();
							commit(s.address);
						}}
						onmouseenter={() => (active = i)}
					>
						<SenderAvatar from={s.address} class="size-7 text-[10px]" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-xs font-medium">{displayName(s)}</span>
							<span class="text-muted-foreground block truncate font-mono text-[11px]">{s.address}</span>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
