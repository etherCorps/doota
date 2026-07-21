<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import type { ChartConfig } from '$lib/components/ui/chart/index.js';

	// Stacked delivered/failed-per-day bars. Data is expected oldest→newest.
	type Row = { date: string; delivered: number; failed: number };
	let {
		data,
		class: className = 'aspect-[3/1] w-full'
	}: { data: Row[]; class?: string } = $props();

	const config = {
		delivered: { label: 'Delivered', color: 'var(--chart-5)' },
		failed: { label: 'Failed', color: 'var(--chart-4)' }
	} satisfies ChartConfig;
</script>

<Chart.Container {config} class={className}>
	<BarChart
		{data}
		x="date"
		seriesLayout="stack"
		series={[
			{ key: 'delivered', label: 'Delivered', value: (d: Row) => d.delivered, color: 'var(--color-delivered)' },
			{ key: 'failed', label: 'Failed', value: (d: Row) => d.failed, color: 'var(--color-failed)' }
		]}
		props={{ xAxis: { format: (d: string) => d.slice(5) } }}
	>
		{#snippet tooltip()}
			<Chart.Tooltip />
		{/snippet}
	</BarChart>
</Chart.Container>
