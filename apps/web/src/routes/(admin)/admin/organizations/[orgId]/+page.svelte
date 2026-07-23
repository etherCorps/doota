<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import DeliveryChart from '$lib/components/admin/delivery-chart.svelte';
	import { zoneAnalytics, zoneUsage, sendingReputation } from '$lib/rpc/cf-insights.remote';
	import UsersIcon from '@lucide/svelte/icons/users';
	import MailIcon from '@lucide/svelte/icons/mail';
	import BotIcon from '@lucide/svelte/icons/bot';
	import UserIcon from '@lucide/svelte/icons/user';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckCircle2Icon from '@lucide/svelte/icons/circle-check-big';

	let { data } = $props();
	const org = $derived(data.org);
	const base = $derived(`${resolve('/admin/organizations')}/${org.id}`);
	const active = $derived(org.status === 'active');

	const STATUS_CHIP: Record<string, string> = {
		pending_zone: 'pending',
		pending_nameservers: 'pending',
		wiring: 'pending',
		active: 'active',
		error: 'failed'
	};
	const STATUS_LABEL: Record<string, string> = {
		pending_zone: 'Creating the Cloudflare zone…',
		pending_nameservers: 'Waiting for nameserver delegation',
		wiring: 'Wiring up mail routing…',
		active: 'Mail is live',
		error: 'Setup error — check DNS'
	};

	const stats = $derived([
		{ label: 'Members', value: data.counts.members, icon: UsersIcon, href: `${base}/members` },
		{ label: 'Shared', value: data.counts.shared, icon: MailIcon, href: `${base}/mailboxes` },
		{ label: 'Service', value: data.counts.service, icon: BotIcon, href: `${base}/mailboxes` },
		{ label: 'Individual', value: data.counts.personal, icon: UserIcon, href: `${base}/mailboxes` },
		{ label: 'Aliases', value: data.counts.aliases, icon: ShuffleIcon, href: `${base}/mailboxes` }
	]);

	// Live email-delivery snapshot (7d) — lazy, once, best-effort (a CF hiccup
	// must not break the overview). Deep-dive lives on the Insights tab.
	let mail = $state<{ rows: Awaited<ReturnType<typeof zoneAnalytics>>; usage: Awaited<ReturnType<typeof zoneUsage>> } | null>(null);
	let reputation = $state<Awaited<ReturnType<typeof sendingReputation>>>(null);
	let mailLoading = $state(false);

	// One-shot on mount — NOT a reactive $effect (which would retry forever if the
	// fetch rejects, hanging the tab).
	onMount(() => {
		if (!org.zoneId) return;
		mailLoading = true;
		Promise.all([zoneAnalytics({ orgId: org.id, days: 7 }), zoneUsage(org.id)])
			.then(([rows, usage]) => (mail = { rows, usage }))
			.catch(() => {})
			.finally(() => (mailLoading = false));
		sendingReputation(org.id)
			.then((r) => (reputation = r))
			.catch(() => {});
	});

	// Reputation tone: green while healthy, amber when mailbox providers start
	// pushing back, red when the domain is in trouble.
	const repTone = (rate: number | null) =>
		rate === null ? 'text-muted-foreground' : rate >= 95 ? 'text-ok' : rate >= 80 ? 'text-warn' : 'text-destructive';

	const isFail = (s: string) => /fail|bounce|drop|reject/i.test(s);
	const mailStats = $derived.by(() => {
		let delivered = 0,
			total = 0;
		for (const r of mail?.rows ?? []) {
			total += r.count;
			if (r.status === 'delivered') delivered += r.count;
		}
		return { delivered, rate: total ? Math.round((delivered / total) * 100) : null };
	});
	const mailChart = $derived.by(() => {
		const m = new Map<string, { delivered: number; failed: number }>();
		for (const r of mail?.rows ?? []) {
			const d = m.get(r.date) ?? { delivered: 0, failed: 0 };
			if (r.status === 'delivered') d.delivered += r.count;
			else if (isFail(r.status)) d.failed += r.count;
			m.set(r.date, d);
		}
		return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
	});
</script>

<div class="flex flex-col gap-6">
	<!-- Domain status -->
	<Card.Card>
		<Card.CardContent class="flex flex-wrap items-center justify-between gap-4 py-5">
			<div class="flex items-center gap-3">
				<div
					class="flex size-10 items-center justify-center rounded-full {active
						? 'bg-ok/10 text-ok'
						: 'bg-warn/10 text-warn'}"
				>
					<CheckCircle2Icon class="size-5" />
				</div>
				<div class="flex flex-col gap-0.5">
					<span class="flex items-center gap-2 text-sm font-medium">
						{STATUS_LABEL[org.status] ?? org.status}
						<StatusChip status={STATUS_CHIP[org.status] ?? 'pending'} />
					</span>
					<span class="text-muted-foreground font-mono text-xs">{org.domain}</span>
				</div>
			</div>
			{#if !active}
				<Button variant="outline" size="sm" class="gap-1.5" href="{base}/domain">
					Finish setup <ArrowRightIcon class="size-3.5" />
				</Button>
			{/if}
		</Card.CardContent>
	</Card.Card>

	<!-- Counts -->
	<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
		{#each stats as s (s.label)}
			<a href={s.href} class="group">
				<Card.Card class="transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-foreground/20 group-hover:shadow-lg">
					<Card.CardContent class="flex items-center gap-3 py-4">
						<div class="bg-muted text-muted-foreground group-hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors">
							<s.icon class="size-4" />
						</div>
						<div>
							<p class="font-heading text-2xl font-semibold leading-none tabular-nums">{s.value}</p>
							<p class="text-muted-foreground text-xs">{s.label}</p>
						</div>
					</Card.CardContent>
				</Card.Card>
			</a>
		{/each}
	</div>

	<!-- Email delivery snapshot (live) -->
	{#if org.zoneId}
		<Card.Card>
			<Card.CardContent class="flex flex-col gap-4 py-5">
				<div class="flex items-center justify-between gap-2">
					<div class="flex flex-col gap-0.5">
						<span class="text-sm font-medium">Email delivery</span>
						<span class="text-muted-foreground text-xs">Last 7 days · live from Cloudflare</span>
					</div>
					<Button variant="ghost" size="sm" class="gap-1.5" href="{base}/insights">
						Insights <ArrowRightIcon class="size-3.5" />
					</Button>
				</div>

				{#if mailLoading && !mail}
					<div class="text-muted-foreground flex items-center gap-2 py-6 text-sm">
						<Spinner /> Loading…
					</div>
				{:else if mail}
					<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
						<div>
							<div class="text-muted-foreground text-xs">Sent today</div>
							<div class="mt-0.5 text-xl font-semibold tabular-nums">{mail.usage.today.toLocaleString()}</div>
						</div>
						<div>
							<div class="text-muted-foreground text-xs">Delivered (7d)</div>
							<div class="text-ok mt-0.5 text-xl font-semibold tabular-nums">
								{mailStats.delivered.toLocaleString()}
							</div>
						</div>
						<div>
							<div class="text-muted-foreground text-xs">Delivery rate</div>
							<div class="mt-0.5 text-xl font-semibold tabular-nums">{mailStats.rate === null ? '—' : `${mailStats.rate}%`}</div>
						</div>
						<div>
							<div class="text-muted-foreground text-xs">Reputation (24h)</div>
							<div class="mt-0.5 text-xl font-semibold tabular-nums {repTone(reputation?.h24.rate ?? null)}">
								{reputation?.h24.rate == null ? '—' : `${reputation.h24.rate}%`}
							</div>
						</div>
						<div>
							<div class="text-muted-foreground text-xs">Reputation (7d)</div>
							<div class="mt-0.5 text-xl font-semibold tabular-nums {repTone(reputation?.d7.rate ?? null)}">
								{reputation?.d7.rate == null ? '—' : `${reputation.d7.rate}%`}
							</div>
						</div>
					</div>
					{#if mailChart.length}
						<DeliveryChart data={mailChart} days={7} class="aspect-[5/1] w-full" />
					{/if}
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}
</div>
