<script lang="ts">
	import { resolve } from '$app/paths';
	import AvatarCard from '$lib/components/account/avatar-card.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card/index.js';
	import UserIcon from '@lucide/svelte/icons/user';
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';

	let { data } = $props();

	const roleLabel: Record<string, string> = {
		member: 'Member',
		admin: 'Admin',
		superadmin: 'Super admin'
	};

	function fmtDate(ms: number | null): string {
		return ms
			? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
			: '—';
	}
</script>

<div class="flex flex-col gap-6">
<AvatarCard name={data.user.name} image={data.user.image} />

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<UserIcon class="size-4" /> Profile details
		</Card.CardTitle>
		<Card.CardDescription>
			Your identity across Doota. Your mailbox address is your login; recovery and security live in
			the Security tab.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<dl class="divide-y">
			<div class="flex items-center justify-between gap-4 py-3">
				<dt class="text-muted-foreground flex items-center gap-2 text-sm">
					<UserIcon class="size-4" /> Name
				</dt>
				<dd class="text-sm font-medium">{data.user.name}</dd>
			</div>

			<div class="flex items-center justify-between gap-4 py-3">
				<dt class="text-muted-foreground flex items-center gap-2 text-sm">
					<AtSignIcon class="size-4" /> Mailbox address
				</dt>
				<dd class="font-mono text-sm">{data.user.email}</dd>
			</div>

			<div class="flex items-center justify-between gap-4 py-3">
				<dt class="text-muted-foreground flex items-center gap-2 text-sm">
					<ShieldIcon class="size-4" /> Role
				</dt>
				<dd>
					<Badge variant={data.user.role === 'member' ? 'secondary' : 'default'}>
						{roleLabel[data.user.role] ?? data.user.role}
					</Badge>
				</dd>
			</div>

			<div class="flex items-center justify-between gap-4 py-3">
				<dt class="text-muted-foreground flex items-center gap-2 text-sm">
					<LifeBuoyIcon class="size-4" /> Recovery email
				</dt>
				<dd class="flex items-center gap-2">
					{#if data.user.recoveryEmail}
						<span class="font-mono text-sm">{data.user.recoveryEmail}</span>
						<Badge variant={data.user.recoveryEmailVerified ? 'default' : 'destructive'}>
							{data.user.recoveryEmailVerified ? 'Verified' : 'Unverified'}
						</Badge>
					{:else}
						<a href={resolve('/account') + '/security'} class="text-sm underline">Add one</a>
					{/if}
				</dd>
			</div>

			<div class="flex items-center justify-between gap-4 py-3">
				<dt class="text-muted-foreground flex items-center gap-2 text-sm">
					<CalendarIcon class="size-4" /> Member since
				</dt>
				<dd class="text-sm">{fmtDate(data.user.createdAt)}</dd>
			</div>
		</dl>
	</Card.CardContent>
</Card.Card>
</div>
