<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Snooze picker: one-tap presets + a natural-language box (reuses parseWhen,
	// the same parser the schedule picker uses — "2 days from now", "day after
	// tomorrow", "fri 5pm"). Commits immediately via snoozeThread; the caller patches
	// the row out. When already snoozed, offers Unsnooze instead of a wake time.
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Calendar } from '$lib/components/ui/calendar/index.js';
	import { getLocalTimeZone, today, type DateValue } from '@internationalized/date';
	import { toast } from 'svelte-sonner';
	import { parseWhen } from '$lib/utils/parse-when';
	import { snoozeThread, unsnoozeThread } from '$lib/rpc/thread.remote';
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';

	let {
		mailboxId,
		threadId,
		snoozed = false,
		onchange,
		triggerClass = ''
	}: {
		mailboxId: string;
		threadId: string;
		/** True in the Snoozed view — show Unsnooze instead of preset times. */
		snoozed?: boolean;
		/** Fired after a successful snooze/unsnooze so the caller can drop the row. */
		onchange?: () => void;
		/** Override the trigger button styling (e.g. a hover-reveal list-row action). */
		triggerClass?: string;
	} = $props();

	const minDay = today(getLocalTimeZone());
	// A picked calendar day snoozes to 9am local that morning (the sensible default;
	// the phrase box handles specific times).
	function pickDate(v: DateValue | undefined) {
		if (!v) return;
		const d = v.toDate(getLocalTimeZone());
		d.setHours(9, 0, 0, 0);
		void snooze(d);
	}

	let open = $state(false);
	let busy = $state(false);
	let nlp = $state('');

	// Presets resolve through parseWhen so wording + rules stay in one place.
	const PRESETS = [
		{ label: 'Later today', phrase: 'tonight' },
		{ label: 'Tomorrow', phrase: 'tomorrow' },
		{ label: 'This weekend', phrase: 'this weekend' },
		{ label: 'Next week', phrase: 'next week' }
	];
	const fmt = (d: Date) =>
		d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	const nlpPreview = $derived(nlp.trim() ? parseWhen(nlp) : null);

	async function snooze(until: Date) {
		if (busy) return;
		if (until.getTime() <= Date.now()) {
			toast.error('Pick a time in the future.');
			return;
		}
		busy = true;
		try {
			await snoozeThread({ mailboxId, threadId, until: until.getTime() });
			toast.success(`Snoozed until ${fmt(until)}.`);
			open = false;
			nlp = '';
			onchange?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not snooze.');
		} finally {
			busy = false;
		}
	}

	async function wake() {
		if (busy) return;
		busy = true;
		try {
			await unsnoozeThread({ mailboxId, threadId });
			toast.success('Back in your inbox.');
			open = false;
			onchange?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not unsnooze.');
		} finally {
			busy = false;
		}
	}

	function onNlpKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && nlpPreview) {
			e.preventDefault();
			void snooze(nlpPreview);
		}
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				title={snoozed ? 'Snoozed' : 'Snooze'}
				aria-label={snoozed ? 'Snoozed' : 'Snooze'}
				class="{triggerClass ||
					'text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg outline-none transition-colors hover:shadow-xs focus-visible:ring-2'} {snoozed
					? 'text-warn'
					: ''}"
			>
				<AlarmClockIcon class="size-4" />
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="{snoozed ? 'w-56' : 'w-auto max-w-[calc(100vw-1rem)]'} p-0">
		{#if snoozed}
			<button
				type="button"
				disabled={busy}
				onclick={wake}
				class="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-50"
			>
				Unsnooze — back to inbox
			</button>
		{:else}
			<div class="border-b p-2">
				<div class="relative">
					<SparklesIcon class="text-brand pointer-events-none absolute top-2.5 left-2 size-3.5" />
					<Input class="h-8 pl-7 text-xs" placeholder="Type a time — “2 days from now”" bind:value={nlp} onkeydown={onNlpKey} />
				</div>
				{#if nlp.trim()}
					<p class="text-muted-foreground mt-1 px-1 text-[11px]">
						{#if nlpPreview}→ {fmt(nlpPreview)} · press Enter{:else}Couldn’t read that time{/if}
					</p>
				{/if}
			</div>
			<ul class="p-1">
				{#each PRESETS as p (p.label)}
					{@const when = parseWhen(p.phrase)}
					<li>
						<button
							type="button"
							disabled={busy || !when}
							onclick={() => when && snooze(when)}
							class="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 disabled:opacity-50"
						>
							<span>{p.label}</span>
							{#if when}<span class="text-muted-foreground text-[11px] tabular-nums">{fmt(when)}</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
			<!-- Manual date — snoozes to 9am on the picked morning. -->
			<div class="border-t">
				<p class="text-muted-foreground px-3 pt-2 text-[11px]">Pick a date (9:00am)</p>
				<Calendar type="single" minValue={minDay} onValueChange={pickDate} class="p-2" />
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
