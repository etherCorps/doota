<script lang="ts">
	import { Calendar } from '$lib/components/ui/calendar/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
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

	const pad = (n: number) => String(n).padStart(2, '0');

	let nlp = $state('');
	let scroller = $state<HTMLElement>();

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

	// Half-hour slots 00:00 … 23:30 for the scroll column; odd minutes go through
	// the phrase box. Past slots are disabled when the picked day is today.
	const SLOTS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
	const fmtSlot = (s: string) =>
		new Date(`2000-01-01T${s}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

	const minDay = today(getLocalTimeZone());
	const isToday = $derived(!!cal && cal.toString() === minDay.toString());
	const isPast = $derived(!!value && new Date(value).getTime() < Date.now());
	function slotPast(s: string): boolean {
		if (!isToday) return false;
		const [h, m] = s.split(':').map(Number);
		const d = new Date();
		d.setHours(h, m, 0, 0);
		return d.getTime() < Date.now();
	}

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

	// Bring the selected slot into view whenever the popover opens.
	$effect(() => {
		if (open && scroller) {
			scroller.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' });
		}
	});

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
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="focus-visible:ring-ring/50 flex max-w-[11rem] items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none {value
					? 'text-warn hover:bg-warn/10'
					: 'text-muted-foreground hover:text-foreground hover:bg-muted'}"
			>
				<ClockIcon class="size-3.5 shrink-0" />
				<span class="truncate">{label || 'Schedule'}</span>
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-auto max-w-[calc(100vw-1rem)] p-0">
		<!-- Natural-language quick entry -->
		<div class="border-b p-2">
			<div class="relative">
				<SparklesIcon class="text-brand pointer-events-none absolute top-2.5 left-2 size-3.5" />
				<Input
					class="h-8 pl-7 text-xs"
					placeholder="Type a time — “tomorrow 9am”"
					bind:value={nlp}
					onkeydown={onNlpKey}
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

		<!-- Date + time-slot column -->
		<div class="flex items-start">
			<Calendar type="single" value={cal} onValueChange={setDate} minValue={minDay} class="p-2" />
			<div class="flex w-28 flex-col border-l">
				<div class="text-muted-foreground border-b px-3 py-2 text-xs font-medium">Time</div>
				<div bind:this={scroller} class="scrollbar-thin h-64 space-y-0.5 overflow-y-auto p-2">
					{#each SLOTS as s (s)}
						{@const active = s === time}
						<button
							type="button"
							data-active={active}
							disabled={slotPast(s)}
							onclick={() => setTime(s)}
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
	</Popover.Content>
</Popover.Root>
