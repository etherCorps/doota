<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import UsersIcon from '@lucide/svelte/icons/users';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { requestSuperadminEmailVerification } from '$lib/rpc/recovery-email.remote.js';
	import { resolve } from '$app/paths';

	let { data } = $props();
	const isSuperadmin = $derived(data.user.role === 'superadmin');

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

<div class="flex w-full flex-col gap-6 p-6 md:p-8">
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
						class="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-md"
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
