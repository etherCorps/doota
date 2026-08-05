<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import { onMount } from 'svelte';
	import { authClient } from '$lib/client/auth-client';
	import { deviceLabel } from '$lib/utils/device-label';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	type SessionRow = {
		token: string;
		userAgent?: string | null;
		ipAddress?: string | null;
		createdAt: Date | string;
		updatedAt: Date | string;
	};

	let sessions = $state<SessionRow[]>([]);
	let currentToken = $state('');
	let loading = $state(true);
	let loadFailed = $state(false);
	let revokingToken = $state<string | null>(null);
	let revokingAll = $state(false);

	// Dates arrive as ISO strings over the wire despite the client types.
	const shortDate = (date: Date | string) =>
		new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

	const sessionLabel = (session: SessionRow) =>
		session.userAgent ? deviceLabel(session.userAgent) : 'Unknown device';

	// Current row first, then newest first.
	const sorted = $derived(
		[...sessions].sort((first, second) => {
			if (first.token === currentToken) return -1;
			if (second.token === currentToken) return 1;
			return (
				new Date(second.updatedAt ?? second.createdAt).getTime() -
				new Date(first.updatedAt ?? first.createdAt).getTime()
			);
		})
	);

	async function loadSessions() {
		const [listRes, sessionRes] = await Promise.all([
			authClient.listSessions(),
			authClient.getSession()
		]);
		sessions = (listRes?.data as SessionRow[] | null) ?? [];
		currentToken = sessionRes?.data?.session.token ?? '';
		// better-auth fresh-gates session management (~1 day): an older-but-valid
		// session gets a 401 here — say so instead of rendering an empty card.
		loadFailed = !!listRes?.error;
		loading = false;
	}
	onMount(() => void loadSessions());

	async function revokeOne(session: SessionRow) {
		revokingToken = session.token;
		const { error } = await authClient.revokeSession({ token: session.token });
		revokingToken = null;
		if (error) {
			toast.error(error.message ?? 'Could not sign out that device.');
			return;
		}
		toast.success('Device signed out.');
		await loadSessions();
	}

	async function revokeOthers() {
		revokingAll = true;
		const { error } = await authClient.revokeOtherSessions();
		revokingAll = false;
		if (error) {
			toast.error(error.message ?? 'Could not sign out other devices.');
			return;
		}
		toast.success('All other devices signed out.');
		await loadSessions();
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<MonitorSmartphoneIcon class="size-4" /> Devices
		</Card.CardTitle>
		<Card.CardDescription>
			Everywhere you're signed in. Sign out anything you don't recognize.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-4">
		{#if loading}
			<div class="flex flex-col gap-3">
				<Skeleton class="h-9 w-full" />
				<Skeleton class="h-9 w-full" />
			</div>
		{:else if loadFailed}
			<p class="text-muted-foreground text-sm">
				Your session is too old to manage devices — log in again to see them.
			</p>
		{:else if sorted.length}
			<ul class="flex flex-col gap-2 text-sm">
				{#each sorted as session (session.token)}
					{@const rowLabel = sessionLabel(session)}
					{@const isCurrent = session.token === currentToken}
					<li class="flex items-center gap-2">
						<MonitorSmartphoneIcon class="text-muted-foreground size-3.5 shrink-0" />
						<div class="min-w-0 flex-1">
							<p class="flex items-center gap-2">
								<span class="truncate">{rowLabel}</span>
								{#if isCurrent}
									<Badge variant="secondary">This device</Badge>
								{/if}
							</p>
							<p class="text-muted-foreground text-xs">
								{#if session.ipAddress}{session.ipAddress} · {/if}Active {shortDate(
									session.updatedAt ?? session.createdAt
								)}
							</p>
						</div>
						{#if !isCurrent}
							<AlertDialog.Root>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											size="icon"
											variant="ghost"
											class="text-destructive hover:text-destructive size-8"
											title="Sign out"
											aria-label="Sign out {rowLabel}"
											disabled={revokingToken === session.token}
										>
											{#if revokingToken === session.token}
												<Spinner class="size-3.5" />
											{:else}
												<LogOutIcon class="size-3.5" />
											{/if}
										</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>Sign out this device?</AlertDialog.Title>
										<AlertDialog.Description>It will need to log in again.</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
										<AlertDialog.Action
											onclick={() => revokeOne(session)}
											class="bg-destructive text-white hover:bg-destructive/90"
										>
											Sign out
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-muted-foreground text-sm">No active sessions.</p>
		{/if}
		{#if !loading && sorted.length > 1}
			<AlertDialog.Root>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" class="self-start" disabled={revokingAll}>
							{#if revokingAll}<Spinner class="mr-1" />{/if}
							Sign out all other devices
						</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>Sign out all other devices?</AlertDialog.Title>
						<AlertDialog.Description>
							Every session except this one will need to log in again.
						</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
						<AlertDialog.Action
							onclick={revokeOthers}
							class="bg-destructive text-white hover:bg-destructive/90"
						>
							Sign out all
						</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		{/if}
	</Card.CardContent>
</Card.Card>
