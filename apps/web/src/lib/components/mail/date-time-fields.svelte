<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Shared calendar + half-hour time-slot scroller, used by the schedule picker
	// (send-later) and the snooze menu. Callback-driven so each parent keeps its own
	// value model with no two-way bind loops. Past slots disable when the picked day
	// is today. On mobile the parents give this the whole sheet (presets/NLP hidden),
	// so calendar-above-time stacks without crowding.
	import { Calendar } from '$lib/components/ui/calendar/index.js';
	import { getLocalTimeZone, today, type DateValue } from '@internationalized/date';

	let {
		date,
		time,
		open = false,
		onDate,
		onTime
	}: {
		date: DateValue | undefined;
		/** HH:mm — the selected slot. */
		time: string;
		/** The popover's open state — used to scroll the active slot into view. */
		open?: boolean;
		onDate: (v: DateValue | undefined) => void;
		onTime: (t: string) => void;
	} = $props();

	const pad = (n: number) => String(n).padStart(2, '0');
	const minDay = today(getLocalTimeZone());
	const SLOTS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
	const fmtSlot = (slot: string) =>
		new Date(`2000-01-01T${slot}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	// No date picked yet → assume today, so past slots are disabled from the start
	// (a future day re-enables them). Prevents selecting an already-passed time.
	const isToday = $derived(!date || date.toString() === minDay.toString());
	function slotPast(slot: string): boolean {
		if (!isToday) return false;
		const [h, m] = slot.split(':').map(Number);
		const d = new Date();
		d.setHours(h, m, 0, 0);
		return d.getTime() <= Date.now();
	}

	let scroller = $state<HTMLElement>();
	// Centre the active slot in the time list when the picker opens. Set scrollTop
	// directly instead of scrollIntoView — the latter also scrolls every ancestor,
	// which on mobile drags the whole bottom-sheet down and clips the calendar/NLP
	// off the top. This confines the scroll to the time column.
	$effect(() => {
		if (!open || !scroller) return;
		const active = scroller.querySelector<HTMLElement>('[data-active="true"]');
		if (!active) return;
		// Rect delta (not offsetTop — the scroller isn't the offsetParent) so the
		// active slot lands in the middle of the time column only.
		scroller.scrollTop +=
			active.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top -
			(scroller.clientHeight - active.clientHeight) / 2;
	});
</script>

<!-- Time column sits beside the calendar ≥ md (768px — matches IsMobile, so the
     drawer shell and the stacked layout flip at the same width); stacks beneath it
     below that, where the parent has hidden presets/NLP to free the whole sheet. -->
<div class="flex flex-col md:flex-row md:items-start">
	<Calendar type="single" value={date} onValueChange={onDate} minValue={minDay} class="mx-auto px-2 py-1 md:mx-0" />
	<div class="flex w-full flex-col border-t md:w-28 md:border-t-0 md:border-l md:pb-4">
		<div class="text-muted-foreground border-b px-3 py-2 text-xs font-medium">Time</div>
		<div
			bind:this={scroller}
			class="scrollbar-thin h-40 space-y-0.5 overflow-y-auto p-2 md:h-56"
		>
			{#each SLOTS as slot (slot)}
				{@const active = slot === time}
				<button
					type="button"
					data-active={active}
					disabled={slotPast(slot)}
					onclick={() => onTime(slot)}
					class="focus-visible:ring-ring/50 w-full rounded-md px-2 py-1.5 text-left text-sm tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 pointer-fine:text-xs {active
						? 'bg-accent text-accent-foreground font-medium'
						: 'hover:bg-muted'}"
				>
					{fmtSlot(slot)}
				</button>
			{/each}
		</div>
	</div>
</div>
