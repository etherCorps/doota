<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Snooze picker: one-tap presets + a natural-language box (reuses parseWhen,
	// the same parser the schedule picker uses — "2 days from now", "day after
	// tomorrow", "fri 5pm"). Commits immediately via snoozeThread; the caller patches
	// the row out. When already snoozed, offers Unsnooze instead of a wake time.
	import * as Popover from '$lib/components/ui/popover/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import DateTimeFields from './date-time-fields.svelte';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { getLocalTimeZone, today, type DateValue } from '@internationalized/date';
	import { toast } from 'svelte-sonner';
	import { parseWhen } from '$lib/utils/parse-when';
	import { snoozeThread, unsnoozeThread } from '$lib/rpc/thread.remote';
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import AlarmClockOffIcon from '@lucide/svelte/icons/alarm-clock-off';

	let {
		mailboxId,
		threadId,
		snoozed = false,
		onchange,
		triggerClass = ''
	}: {
		mailboxId: string;
		threadId: string;
		/** True in the Snoozed view — adds an Unsnooze action alongside reschedule. */
		snoozed?: boolean;
		/** Fired after a successful snooze/unsnooze. `kept` = the thread is still
		 *  snoozed (a reschedule from the Snoozed view) so the caller should keep +
		 *  re-sort the row rather than drop it. */
		onchange?: (info?: { kept?: boolean }) => void;
		/** Override the trigger button styling (e.g. a hover-reveal list-row action). */
		triggerClass?: string;
	} = $props();

	// Manual date + time — the calendar + slot scroller live in DateTimeFields.
	const pad = (n: number) => String(n).padStart(2, '0');
	// Nearest upcoming half-hour (rounds now UP) — the time selector opens on a
	// sensible default instead of a fixed 9am.
	function nearestSlot(): string {
		const now = new Date();
		const h = now.getHours();
		return now.getMinutes() < 30 ? `${pad(h)}:30` : `${pad((h + 1) % 24)}:00`;
	}
	// Default to today + the nearest slot so the picker opens on a valid, one-tap
	// future time (past slots for today are disabled below).
	let calDate = $state<DateValue | undefined>(today(getLocalTimeZone()));
	let calTime = $state(nearestSlot());
	// The composed date+time; null until a day is picked. Drives the Snooze button
	// so a past selection can't be committed (belt to the calendar/slot disabling).
	const customUntil = $derived.by<Date | null>(() => {
		if (!calDate) return null;
		const d = calDate.toDate(getLocalTimeZone());
		const [h, m] = calTime.split(':').map(Number);
		d.setHours(h, m, 0, 0);
		return d;
	});
	const customPast = $derived(!!customUntil && customUntil.getTime() <= Date.now());
	function snoozeCustom() {
		if (customUntil) void snooze(customUntil);
	}

	let open = $state(false);
	let busy = $state(false);
	let nlp = $state('');
	// Mobile: presets-first. The full calendar/time is revealed on demand so the
	// quick options + commit button stay above the fold (and above the keyboard).
	// Desktop shows the calendar inline — there's room, so no extra tap.
	const isMobile = new IsMobile();
	let showCal = $state(false);
	// Mobile only: when the calendar is open it takes the WHOLE sheet — presets + NLP
	// are swapped out so the month grid + time list aren't crowded off the fold.
	// Desktop always shows the calendar inline (there's room), so no switch there.
	const fullCal = $derived(isMobile.current && showCal);

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
			// From the Snoozed view this is a reschedule — the thread stays snoozed, so
			// tell the caller to keep the row (re-sort) instead of dropping it.
			onchange?.(snoozed ? { kept: true } : undefined);
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

	const triggerCls = $derived(
		`${triggerClass || 'text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg outline-none transition-colors hover:shadow-xs focus-visible:ring-2'} ${snoozed ? 'text-warn' : ''}`
	);
	const triggerTitle = $derived(snoozed ? 'Snoozed' : 'Snooze');
</script>

<!-- Selected time + Snooze — sticky to the sheet bottom so it never scrolls off. -->
{#snippet manualFooter()}
	<div class="bg-popover sticky bottom-0 flex items-center gap-2 border-t p-2">
		{#if customPast}
			<p class="text-destructive text-[11px] leading-tight">That time has passed.</p>
		{:else if customUntil}
			<p class="text-muted-foreground text-[11px] leading-tight tabular-nums">Snoozes {fmt(customUntil)}</p>
		{/if}
		<Button size="sm" class="ml-auto h-8" disabled={!customUntil || customPast || busy} onclick={snoozeCustom}>Snooze</Button>
	</div>
{/snippet}

{#snippet body()}
	{#if fullCal}
		<!-- Mobile full-sheet calendar: presets + NLP swapped out for room. -->
		<div class="flex items-center border-b p-1.5">
			<button
				type="button"
				onclick={() => (showCal = false)}
				class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-1 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2"
			>
				<ChevronLeftIcon class="size-4" /> Back
			</button>
		</div>
		<DateTimeFields
			date={calDate}
			time={calTime}
			{open}
			onDate={(v) => (calDate = v)}
			onTime={(t) => (calTime = t)}
		/>
		{@render manualFooter()}
	{:else}
		{#if snoozed}
			<!-- Snoozed view: unsnooze (remove) up top; the picker below reschedules
			     (edit) — the presets/NLP/calendar re-snooze to a new time. -->
			<div class="border-b p-1">
				<Button
					variant="destructive"
					size="sm"
					disabled={busy}
					onclick={wake}
					class="text-warn py-4 hover:text-warn hover:bg-warn/10 w-full justify-start gap-2"
				>
					<AlarmClockOffIcon class="size-4" /> Unsnooze — back to inbox
				</Button>
			</div>
		{/if}
		<div class="border-b p-2">
			<div class="relative">
				<SparklesIcon class="text-brand pointer-events-none absolute top-2.5 left-2 size-3.5" />
				<Input
					class="h-8 pl-7 text-xs pointer-coarse:text-base"
					placeholder="Type a time — “2 days from now”"
					bind:value={nlp}
					onkeydown={onNlpKey}
				/>
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
		{#if isMobile.current}
			<!-- Opens the full-sheet calendar mode above. -->
			<button
				type="button"
				onclick={() => (showCal = true)}
				class="text-muted-foreground hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center justify-between gap-2 border-t px-3 py-2.5 text-sm outline-none focus-visible:ring-2"
			>
				<span class="flex items-center gap-2"><CalendarIcon class="size-4" /> Pick exact date &amp; time</span>
				<ChevronDownIcon class="size-4" />
			</button>
		{:else}
			<!-- Desktop: calendar inline (room for it beside the presets). -->
			<div class="border-t">
				<DateTimeFields
					date={calDate}
					time={calTime}
					{open}
					onDate={(v) => (calDate = v)}
					onTime={(t) => (calTime = t)}
				/>
			</div>
			{@render manualFooter()}
		{/if}
	{/if}
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open>
		<Drawer.Trigger title={triggerTitle} aria-label={triggerTitle} class={triggerCls}>
			<AlarmClockIcon class="size-4" />
		</Drawer.Trigger>
		<Drawer.Content class="p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
			<div class="min-h-0 flex-1 overflow-y-auto">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Popover.Root bind:open>
		<Popover.Trigger title={triggerTitle} aria-label={triggerTitle} class={triggerCls}>
			<AlarmClockIcon class="size-4" />
		</Popover.Trigger>
		<Popover.Content align="end" class="max-h-[85vh] w-auto max-w-[calc(100vw-1rem)] overflow-y-auto p-0">
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{/if}
