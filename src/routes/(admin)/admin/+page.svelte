<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import UsersIcon from '@lucide/svelte/icons/users';
	import MailIcon from '@lucide/svelte/icons/mail';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { users, mailboxes } from '$lib/mock/index.js';

	let { data } = $props();
	const isSuperadmin = $derived(data.user.role === 'superadmin');

	// Overview stats. Domains come from the real org list; users/mailboxes are mock
	// until the mailbox milestone lands.
	const stats = $derived([
		{ label: 'Domains', value: data.orgs.length, icon: GlobeIcon },
		{ label: 'Users', value: users.length, icon: UsersIcon },
		{ label: 'Mailboxes', value: mailboxes.length, icon: MailIcon }
	]);

	let domain = $state('');
	let creating = $state(false);

	function slugify(d: string) {
		return d
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9.]/g, '')
			.replace(/\./g, '-');
	}

	async function createOrg(e: SubmitEvent) {
		e.preventDefault();
		const d = domain.trim().toLowerCase();
		if (!d) return;
		creating = true;
		// `domain` is a server additionalField; the client types don't infer it,
		// so cast the payload. The server validates domain (required/unique/format).
		const payload = { name: d, slug: slugify(d), domain: d };
		const { error } = await authClient.organization.create(
			payload as unknown as Parameters<typeof authClient.organization.create>[0]
		);
		creating = false;
		if (error) {
			toast.error(error.message ?? 'Could not create organization.');
			return;
		}
		domain = '';
		toast.success(`Organization ${d} created.`);
		await invalidateAll();
	}
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
	<div class="flex flex-col gap-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Dashboard</h1>
		<p class="text-muted-foreground text-sm">
			<span class="font-mono">{data.user.email}</span> · {data.user.role}
		</p>
	</div>

	<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
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

	{#if isSuperadmin}
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="flex items-center gap-2 font-heading">
					<PlusIcon class="size-4" /> Create organization
				</Card.CardTitle>
				<Card.CardDescription>
					One organization per mail domain you operate. You become its owner.
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent>
				<form onsubmit={createOrg} class="flex items-end gap-2">
					<Field.Field class="flex-1">
						<Field.Label>Domain</Field.Label>
						<Input
							type="text"
							class="font-mono"
							placeholder="acme.com"
							bind:value={domain}
							required
						/>
					</Field.Field>
					<Button type="submit" disabled={creating}>
						{#if creating}<Spinner class="mr-1" />{/if}
						Create
					</Button>
				</form>
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
						<li class="flex items-center justify-between py-2.5">
							<div class="flex flex-col">
								<span class="font-mono text-sm font-medium">{org.domain}</span>
								<span class="text-muted-foreground text-xs capitalize">{org.membershipRole}</span>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-muted-foreground text-sm">
					No organizations yet.{isSuperadmin ? ' Create one above.' : ''}
				</p>
			{/if}
		</Card.CardContent>
	</Card.Card>
</div>
