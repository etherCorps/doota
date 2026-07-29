<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import DateTimeFields from './date-time-fields.svelte';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date';
	import { parseWhen, toLocalDatetime } from '$lib/utils/parse-when';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';

	// `value` is a datetime-local string (YYYY-MM-DDTHH:mm) — the same shape the
	// composer feeds to `new Date(...)`. '' means no schedule. It's the single
	// source of truth: calendar + time-slot are derived from it, every edit writes it.
	let {
		value = $bindable(''),
		open = $bindable(false)
	}: { value?: string; open?: boolean } = $props();

	let nlp = $state('');
	// Mobile: don't steal focus on open (keyboard would shove the picker off
	// screen), and hide the calendar/time while the phrase box is focused so the
	// popover fits above the keyboard. Tap away → keyboard closes → picker back.
	const isMobile = new IsMobile();
	let nlpFocused = $state(false);
	const showPicker = $derived(!(isMobile.current && nlpFocused));

	const cal = $derived.by<DateValue | undefined>(() => {
		if (!value) return undefined;
		try {
			return parseDate(value.slice(0, 10));
		} catch {
			return undefined;
		}
	});
	const time = $derived(value ? value.slice(11, 16) || '09:00' : '09:00');

	function setDate(v: DateValue | undefined) {
		if (v) value = `${v.toString()}T${time}`;
	}
	function setTime(t: string) {
		const d = cal ?? today(getLocalTimeZone());
		value = `${d.toString()}T${t}`;
	}
	function applyDate(d: Date) {
		value = toLocalDatetime(d);
	}

	const isPast = $derived(!!value && new Date(value).getTime() < Date.now());

	// Live preview of the typed phrase; committed on Enter.
	const nlpPreview = $derived(nlp.trim() ? parseWhen(nlp) : null);
	function applyNlp() {
		if (nlpPreview) {
			applyDate(nlpPreview);
			nlp = '';
		}
	}
	function onNlpKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			applyNlp();
		}
	}

	const label = $derived(
		value
			? new Date(value).toLocaleString(undefined, {
					weekday: 'short',
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit'
				})
			: ''
	);
	const fmtPreview = (d: Date) =>
		d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	const triggerCls = $derived(
		`focus-visible:ring-ring/50 flex max-w-[11rem] items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none ${value ? 'text-warn hover:bg-warn/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`
	);
</script>

{#snippet triggerInner()}
	<ClockIcon class="size-3.5 shrink-0" />
	<span class="truncate">{label || 'Schedule'}</span>
{/snippet}

{#snippet body()}
		<!-- Natural-language quick entry -->
		<div class="border-b p-2">
			<div class="relative">
				<SparklesIcon class="text-brand pointer-events-none absolute top-2.5 left-2 size-3.5" />
				<Input
					class="h-8 pl-7 text-xs pointer-coarse:text-base"
					placeholder="Type a time — “tomorrow 9am”"
					bind:value={nlp}
					onkeydown={onNlpKey}
					onfocus={() => (nlpFocused = true)}
					onblur={() => (nlpFocused = false)}
				/>
			</div>
			{#if nlp.trim()}
				<p class="text-muted-foreground mt-1 px-1 text-[11px]">
					{#if nlpPreview}
						→ {fmtPreview(nlpPreview)} · press Enter
					{:else}
						Couldn’t read that time
					{/if}
				</p>
			{/if}
		</div>

		{#if showPicker}
			<DateTimeFields date={cal} time={time} {open} onDate={setDate} onTime={setTime} />
		{/if}

		<div class="flex items-center gap-2 border-t p-2">
			{#if isPast}
				<span class="text-destructive text-[11px]">That time has passed</span>
			{/if}
			<Button
				variant="ghost"
				size="sm"
				class="text-muted-foreground hover:text-destructive ml-auto h-8"
				onclick={() => {
					value = '';
					open = false;
				}}
			>
				Clear
			</Button>
			<Button size="sm" class="h-8 px-4" disabled={!value || isPast} onclick={() => (open = false)}>Done</Button>
		</div>
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open>
		<Drawer.Trigger class={triggerCls}>{@render triggerInner()}</Drawer.Trigger>
		<Drawer.Content class="p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
			<div class="max-h-[78vh] overflow-y-auto">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Popover.Root bind:open>
		<Popover.Trigger class={triggerCls}>{@render triggerInner()}</Popover.Trigger>
		<Popover.Content align="end" class="w-auto max-w-[calc(100vw-1rem)] p-0">
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{/if}
