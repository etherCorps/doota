<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { cn } from '$lib/utils/ui.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Badge } from '$lib/components/ui/badge';
	import UserIcon from '@lucide/svelte/icons/user';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import MailIcon from '@lucide/svelte/icons/mail';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';

	let { data, children } = $props();

	const elevated = $derived(data.user.role === 'admin' || data.user.role === 'superadmin');
	const needsSecondFactor = $derived(
		elevated && !data.user.twoFactorEnabled && data.passkeys.length === 0
	);
	const hasSecondFactor = $derived(data.user.twoFactorEnabled || data.passkeys.length > 0);

	const roleLabel: Record<string, string> = {
		member: 'Member',
		admin: 'Admin',
		superadmin: 'Super admin'
	};
	const initials = $derived(
		data.user.name
			.split(' ')
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	const base = resolve('/account');
	const TABS = [
		{ slug: 'profile', label: 'Profile', icon: UserIcon },
		{ slug: 'security', label: 'Security', icon: ShieldIcon },
		{ slug: 'mail', label: 'Mail', icon: MailIcon },
		{ slug: 'developer', label: 'Developer', icon: KeyRoundIcon }
	];
	const current = $derived(page.url.pathname.split('/').filter(Boolean).pop());
</script>

<div class="flex w-full flex-col">
	<!-- Identity banner — full-width bar, the anchor every tab shares. -->
	<header class="bg-card flex flex-wrap items-center gap-4 border-b px-6 py-5 md:px-8">
		<Avatar.Root class="size-16 shrink-0">
			{#if data.user.image}<Avatar.Image src={data.user.image} alt={data.user.name} />{/if}
			<Avatar.Fallback class="text-lg">{initials}</Avatar.Fallback>
		</Avatar.Root>
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2">
				<h1 class="font-heading truncate text-xl font-semibold tracking-tight">{data.user.name}</h1>
				<Badge variant={data.user.role === 'member' ? 'secondary' : 'default'}>
					{roleLabel[data.user.role] ?? data.user.role}
				</Badge>
			</div>
			<p class="text-muted-foreground truncate font-mono text-sm">{data.user.email}</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<span
				class={cn(
					'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
					hasSecondFactor
						? 'text-foreground'
						: 'border-destructive/40 text-destructive'
				)}
			>
				<ShieldCheckIcon class="size-3.5" />
				{hasSecondFactor ? '2FA on' : '2FA off'}
			</span>
			<span
				class={cn(
					'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
					data.user.recoveryEmailVerified ? 'text-foreground' : 'text-muted-foreground'
				)}
			>
				<LifeBuoyIcon class="size-3.5" />
				{data.user.recoveryEmail
					? data.user.recoveryEmailVerified
						? 'Recovery set'
						: 'Recovery unverified'
					: 'No recovery'}
			</span>
		</div>
	</header>

	<div class="flex w-full max-w-5xl flex-col gap-6 p-6 md:p-8">
	{#if needsSecondFactor}
		<Card.Card class="border-destructive">
			<Card.CardHeader>
				<Card.CardTitle class="flex items-center gap-2">
					<ShieldAlertIcon class="size-4" /> Second factor required
				</Card.CardTitle>
				<Card.CardDescription>
					Admin accounts must have two-factor authentication or a passkey. Set one up in the
					<a href="{base}/security" class="underline">Security</a> tab to continue.
				</Card.CardDescription>
			</Card.CardHeader>
		</Card.Card>
	{/if}

	<div class="flex flex-col gap-6 md:flex-row md:gap-10">
		<!-- Nav: horizontal tab strip on mobile, vertical rail on desktop. -->
		<nav class="md:w-52 md:shrink-0">
			<div class="flex gap-1 border-b md:flex-col md:gap-0.5 md:border-b-0">
				{#each TABS as t (t.slug)}
					<a
						href="{base}/{t.slug}"
						class={cn(
							'flex items-center gap-2 text-sm font-medium transition-colors',
							// mobile underline tabs / desktop pill rail
							'-mb-px border-b-2 px-3 py-2 md:mb-0 md:rounded-md md:border-b-0 md:px-3 md:py-2',
							current === t.slug
								? 'border-primary text-foreground md:bg-muted md:border-transparent'
								: 'text-muted-foreground hover:text-foreground hover:md:bg-muted/60 border-transparent'
						)}
					>
						<t.icon class="size-4 shrink-0" />
						<span class="hidden sm:inline">{t.label}</span>
					</a>
				{/each}
			</div>
		</nav>

		<div class="min-w-0 max-w-2xl flex-1">
			{@render children()}
		</div>
	</div>
	</div>
</div>
