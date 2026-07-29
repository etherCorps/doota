<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Shared calendar + half-hour time-slot scroller, used by the schedule picker
	// (send-later) and the snooze menu. Callback-driven so each parent keeps its own
	// value model (datetime-local string vs. separate date+time) with no two-way
	// bind loops. Past slots disable when the picked day is today.
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
	const fmtSlot = (s: string) =>
		new Date(`2000-01-01T${s}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	// No date picked yet → assume today, so past slots are disabled from the start
	// (a future day re-enables them). Prevents selecting an already-passed time.
	const isToday = $derived(!date || date.toString() === minDay.toString());
	function slotPast(s: string): boolean {
		if (!isToday) return false;
		const [h, m] = s.split(':').map(Number);
		const d = new Date();
		d.setHours(h, m, 0, 0);
		return d.getTime() <= Date.now();
	}

	let scroller = $state<HTMLElement>();
	// Bring the active slot into view whenever the popover opens.
	$effect(() => {
		if (open && scroller) scroller.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' });
	});
</script>

<!-- Side column ≥ sm; stacked under the calendar on narrow phones (calendar +
     112px column won't fit under ~390px). -->
<div class="flex flex-col sm:flex-row sm:items-start">
	<Calendar type="single" value={date} onValueChange={onDate} minValue={minDay} class="px-2 py-1" />
	<div class="flex w-full flex-col border-t sm:w-28 sm:border-t-0 sm:border-l pb-4">
		<div class="text-muted-foreground border-b px-3 py-2 text-xs font-medium">Time</div>
		<div bind:this={scroller} class="scrollbar-thin h-32 space-y-0.5 overflow-y-auto p-2 sm:h-56">
			{#each SLOTS as s (s)}
				{@const active = s === time}
				<button
					type="button"
					data-active={active}
					disabled={slotPast(s)}
					onclick={() => onTime(s)}
					class="focus-visible:ring-ring/50 w-full rounded-md px-2 py-1.5 text-left text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 {active
						? 'bg-accent text-accent-foreground font-medium'
						: 'hover:bg-muted'}"
				>
					{fmtSlot(s)}
				</button>
			{/each}
		</div>
	</div>
</div>
