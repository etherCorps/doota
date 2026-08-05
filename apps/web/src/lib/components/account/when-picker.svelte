<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Labeled optional date+time field (vacation card): an outline trigger button
	// opens a popover (desktop) / drawer (mobile) with the shared NLP phrase input
	// and DateTimeFields (calendar + half-hour slots) — the schedule-picker idiom.
	// Value is epoch ms; null = unset. NLP shows on mobile too (schedule-picker is
	// NLP-first there); the drawer body scrolls so the phrase input + calendar coexist.
	import DateTimeFields from '$lib/components/mail/date-time-fields.svelte';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date';
	import { parseWhen, toLocalDatetime } from '$lib/utils/parse-when';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';

	let {
		value,
		onChange,
		label,
		id,
		placeholder = 'Pick a time…'
	}: {
		/** Epoch ms; null = unset (the field is optional). */
		value: number | null;
		onChange: (next: number | null) => void;
		/** Accessible name for the trigger button. */
		label: string;
		/** Trigger button id, so an external <Label for> can target it. */
		id?: string;
		placeholder?: string;
	} = $props();

	let open = $state(false);
	let nlp = $state('');
	const isMobile = new IsMobile();

	// ms → calendar day + HH:mm via the local datetime-local string (same shapes
	// schedule-picker slices); every edit converts straight back to epoch ms.
	const cal = $derived.by<DateValue | undefined>(() => {
		if (value === null) return undefined;
		try {
			return parseDate(toLocalDatetime(new Date(value)).slice(0, 10));
		} catch {
			return undefined;
		}
	});
	const time = $derived(value === null ? '09:00' : toLocalDatetime(new Date(value)).slice(11, 16));

	function setDate(day: DateValue | undefined) {
		if (day) onChange(new Date(`${day.toString()}T${time}`).getTime());
	}
	function setTime(slot: string) {
		const day = cal ?? today(getLocalTimeZone());
		onChange(new Date(`${day.toString()}T${slot}`).getTime());
	}

	// Live preview of the typed phrase; committed on Enter.
	const nlpPreview = $derived(nlp.trim() ? parseWhen(nlp) : null);
	function applyNlp() {
		if (nlpPreview) {
			onChange(nlpPreview.getTime());
			nlp = '';
		}
	}
	function onNlpKey(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			applyNlp();
		}
	}

	const fmt = (ms: number | Date) =>
		new Date(ms).toLocaleString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});

	const triggerCls = $derived(
		`${buttonVariants({ variant: 'outline' })} w-full justify-start font-normal ${value === null ? 'text-muted-foreground' : ''}`
	);
</script>

{#snippet triggerInner()}
	<CalendarClockIcon class="size-4 shrink-0 opacity-70" />
	<span class="truncate">{value === null ? placeholder : fmt(value)}</span>
{/snippet}

{#snippet body()}
	<!-- Natural-language quick entry — shown on desktop and mobile (schedule-picker
	     is NLP-first on touch). -->
	<div class="border-b p-2">
		<div class="relative">
			<SparklesIcon class="text-brand pointer-events-none absolute top-2.5 left-2 size-3.5" />
			<Input
				class="h-8 pl-7 text-xs pointer-coarse:text-base"
				placeholder="Type a time — “next monday 9am”"
				bind:value={nlp}
				onkeydown={onNlpKey}
			/>
		</div>
		{#if nlp.trim()}
			<p class="text-muted-foreground mt-1 px-1 text-[11px]">
				{#if nlpPreview}
					→ {fmt(nlpPreview)} · press Enter
				{:else}
					Couldn’t read that time
				{/if}
			</p>
		{/if}
	</div>
	<DateTimeFields date={cal} {time} {open} onDate={setDate} onTime={setTime} />
	<div class="bg-popover sticky bottom-0 flex items-center gap-2 border-t p-2">
		{#if value !== null}
			<span class="text-muted-foreground text-[11px] tabular-nums">{fmt(value)}</span>
		{/if}
		<Button
			variant="ghost"
			size="sm"
			class="text-muted-foreground hover:text-destructive ml-auto h-8"
			onclick={() => {
				onChange(null);
				open = false;
			}}
		>
			Clear
		</Button>
		<Button size="sm" class="h-8 px-4" onclick={() => (open = false)}>Done</Button>
	</div>
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open>
		<Drawer.Trigger {id} aria-label={label} class={triggerCls}>{@render triggerInner()}</Drawer.Trigger>
		<Drawer.Content class="p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
			<div class="min-h-0 flex-1 overflow-y-auto">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Popover.Root bind:open>
		<Popover.Trigger {id} aria-label={label} class={triggerCls}>{@render triggerInner()}</Popover.Trigger>
		<Popover.Content align="start" class="max-h-[85vh] w-auto max-w-[calc(100vw-1rem)] overflow-y-auto p-0">
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{/if}
