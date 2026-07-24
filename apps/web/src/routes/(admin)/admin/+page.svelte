<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import UsersIcon from '@lucide/svelte/icons/users';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { requestSuperadminEmailVerification } from '$lib/rpc/recovery-email.remote.js';
	import { accountLimits } from '$lib/rpc/cf-insights.remote';
	import SendIcon from '@lucide/svelte/icons/send';
	import { resolve } from '$app/paths';

	let { data } = $props();
	const isSuperadmin = $derived(data.user.role === 'superadmin');

	// Account daily sending limit + usage, live from Cloudflare (superadmin only —
	// it's the whole account). Lazy, once, best-effort.
	let acct = $state<Awaited<ReturnType<typeof accountLimits>> | null>(null);
	let acctLoading = $state(false);
	// One-shot on mount — NOT a reactive $effect (which would retry forever if the
	// fetch rejects, hanging the tab).
	onMount(() => {
		if (!isSuperadmin) return;
		acctLoading = true;
		accountLimits()
			.then((r) => (acct = r))
			.catch(() => {})
			.finally(() => (acctLoading = false));
	});
	const acctPct = $derived(
		acct && acct.dailyLimit && acct.sent != null ? Math.min(100, Math.round((acct.sent / acct.dailyLimit) * 100)) : 0
	);
	const fmtReset = (iso: string | null) =>
		iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

	let verifying = $state(false);

	async function verifyEmail() {
		verifying = true;
		try {
			const res = await requestSuperadminEmailVerification();
			if (res.success) toast.success(res.message);
			else toast.error(res.message);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not send verification email.');
		} finally {
			verifying = false;
		}
	}

	// Overview stats — all real, scoped to the orgs the actor administers.
	const stats = $derived([
		{ label: 'Domains', value: data.orgs.length, icon: GlobeIcon },
		{ label: 'Users', value: data.userCount, icon: UsersIcon },
		{ label: 'Mailboxes', value: data.mailboxCount, icon: MailIcon }
	]);
</script>

<div class="flex w-full flex-col gap-6 p-4 sm:p-6 md:p-8">
	<div class="flex flex-col gap-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Dashboard</h1>
		<p class="text-muted-foreground text-sm">
			<span class="font-mono">{data.user.email}</span> · {data.user.role}
		</p>
	</div>

	{#if data.isSuperadmin && !data.emailVerified}
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="font-heading">Verify your email</Card.CardTitle>
				<Card.CardDescription>
					Your login email <span class="font-mono">{data.email}</span> is unverified. Verifying it
					enables email-based password recovery. This is only available once a domain is active
					(a working sending path).
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent>
				{#if data.hasActiveDomain}
					<Button onclick={verifyEmail} disabled={verifying}>
						{#if verifying}<Spinner class="mr-1" />{/if}
						Send verification email
					</Button>
				{:else}
					<p class="text-muted-foreground text-sm">
						Onboard a domain first — until then, recover with the
						<code>reset-admin</code> CLI.
					</p>
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}

	<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
		{#each stats as stat (stat.label)}
			<Card.Card>
				<Card.CardContent class="flex items-center gap-3 py-4">
					<div
						class="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-xl"
					>
						<stat.icon class="size-4" />
					</div>
					<div>
						<p class="font-heading text-2xl font-semibold leading-none">{stat.value}</p>
						<p class="text-muted-foreground text-xs">{stat.label}</p>
					</div>
				</Card.CardContent>
			</Card.Card>
		{/each}
	</div>

	{#if isSuperadmin}
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="flex items-center gap-2 font-heading">
					<SendIcon class="size-4" /> Email sending
				</Card.CardTitle>
				<Card.CardDescription>
					Account-wide daily sending limit · live from Cloudflare.
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent>
				{#if acctLoading && !acct}
					<div class="text-muted-foreground flex items-center gap-2 py-4 text-sm">
						<Spinner /> Loading…
					</div>
				{:else if acct}
					<div class="flex flex-col gap-4">
						<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
							<div>
								<div class="text-muted-foreground text-xs">Sent today</div>
								<div class="mt-0.5 text-2xl font-semibold tabular-nums">
									{acct.sent === null ? '—' : acct.sent.toLocaleString()}
								</div>
							</div>
							<div>
								<div class="text-muted-foreground text-xs">Daily limit</div>
								<div class="mt-0.5 text-2xl font-semibold tabular-nums">
									{#if acct.dailyLimit === null}
										<span class="text-muted-foreground text-base font-normal">Unknown</span>
									{:else}
										{acct.dailyLimit.toLocaleString()}<span class="text-muted-foreground text-sm font-normal">/{acct.unit ?? 'day'}</span>
									{/if}
								</div>
							</div>
							<div>
								<div class="text-muted-foreground text-xs">Status</div>
								<div class="mt-0.5 text-2xl font-semibold tabular-nums">
									{#if acct.overQuota}
										<span class="text-destructive text-base font-medium">Over quota</span>
									{:else if acct.dailyLimit && acct.sent != null}
										<span class="text-base font-normal">{Math.max(0, acct.dailyLimit - acct.sent).toLocaleString()} <span class="text-muted-foreground">left</span></span>
									{:else}
										<span class="text-muted-foreground text-base font-normal">—</span>
									{/if}
								</div>
							</div>
						</div>
						{#if acct.dailyLimit && acct.sent != null}
							<div class="flex flex-col gap-1.5">
								<div class="bg-muted h-2 w-full overflow-hidden rounded-full">
									<div
										class="h-full rounded-full transition-all {acctPct >= 90
											? 'bg-destructive'
											: acctPct >= 75
												? 'bg-warn'
												: 'bg-brand'}"
										style="width: {acctPct}%"
									></div>
								</div>
								<p class="text-muted-foreground text-xs">
									{acct.sent.toLocaleString()} of {acct.dailyLimit.toLocaleString()} sent today ({acctPct}%).
									{#if fmtReset(acct.resetsAt)}Resets {fmtReset(acct.resetsAt)}.{/if}
									The daily limit is dynamic — Cloudflare scales it with your account's sending reputation.
								</p>
							</div>
						{:else}
							<p class="text-muted-foreground text-xs">
								Cloudflare didn't return a limit for this account. It scales automatically with sending reputation.
							</p>
						{/if}
					</div>
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}

	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="flex items-center gap-2 font-heading">
				<GlobeIcon class="size-4" /> Organizations
			</Card.CardTitle>
			<Card.CardDescription>Domains you own or administer.</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent>
			{#if data.orgs.length}
				<ul class="flex flex-col divide-y">
					{#each data.orgs as org (org.id)}
					<li>
							<a
								href={`${resolve('/admin/organizations')}/${org.id}`}
								title={org.domain}
								class="hover:bg-muted/50 flex items-center justify-between rounded-md px-2 py-2.5"
							>
									<div class="flex flex-col">
								<span class="font-mono text-sm font-medium">{org.domain}</span>
								<span class="text-muted-foreground text-xs capitalize">{org.membershipRole}</span>
							</div>
						</a>
					</li>
					{/each}
				</ul>
			{:else}
				<p class="text-muted-foreground text-sm">
					No organizations yet.{#if isSuperadmin}
						<a href={resolve('/admin/organizations')} class="text-foreground underline">Onboard a domain</a> to create one.
					{/if}
				</p>
			{/if}
		</Card.CardContent>
	</Card.Card>
</div>
