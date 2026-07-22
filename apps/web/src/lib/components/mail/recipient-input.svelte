<script lang="ts">
	import { recipientSuggestions } from '$lib/rpc/draft.remote';
	import XIcon from '@lucide/svelte/icons/x';

	// Recipient token input with autocomplete from prior correspondents (Part C).
	// Addresses render in JetBrains Mono per the design system.
	let {
		value = $bindable<string[]>([]),
		placeholder = 'name@domain.com',
		onchange
	}: { value?: string[]; placeholder?: string; onchange?: () => void } = $props();

	let text = $state('');
	let suggestions = $state<string[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let timer: ReturnType<typeof setTimeout> | undefined;
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
			return;
		}
		timer = setTimeout(async () => {
			suggestions = (await recipientSuggestions(q)).filter((s) => !value.includes(s));
			open = suggestions.length > 0;
			active = -1;
		}, 200);
	}
	function moveActive(delta: number) {
		active = (active + delta + suggestions.length + 1) % (suggestions.length + 1) - 1; // -1 = free text
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
		} else if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			commit(open && active >= 0 ? suggestions[active] : text);
		} else if (e.key === 'Backspace' && !text && value.length) {
			remove(value[value.length - 1]);
		}
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
		<ul id="{uid}-listbox" role="listbox" class="bg-popover absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-xl border p-1 shadow-lg">
			{#each suggestions as s, i (s)}
				<li id="{uid}-opt-{i}" role="option" aria-selected={active === i}>
					<button
						type="button"
						tabindex="-1"
						class="w-full rounded-lg px-2 py-1.5 text-left font-mono text-xs transition-colors {active === i ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}"
						onmousedown={(e) => {
							e.preventDefault();
							commit(s);
						}}
					>
						{s}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
