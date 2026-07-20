<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { authClient } from '$lib/client/auth-client.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import LogOutIcon from '@lucide/svelte/icons/log-out';

	let {
		name,
		email,
		role,
		image = null
	}: { name: string; email: string; role: string; image?: string | null } = $props();

	const initials = $derived(
		name
			.split(' ')
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	async function logout() {
		await authClient.signOut();
		await goto(resolve('/login'));
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Sidebar.MenuButton
				size="lg"
				class="data-[state=open]:bg-sidebar-accent"
				{...props}
			>
				<Avatar.Root class="size-8 rounded-md">
					{#if image}<Avatar.Image src={image} alt={name} class="rounded-md" />{/if}
					<Avatar.Fallback class="rounded-md text-xs">{initials}</Avatar.Fallback>
				</Avatar.Root>
				<div class="grid flex-1 text-left leading-tight">
					<span class="truncate text-sm font-medium">{name}</span>
					<span class="text-muted-foreground truncate font-mono text-xs">{email}</span>
				</div>
				<ChevronsUpDownIcon class="text-muted-foreground ml-auto size-4" />
			</Sidebar.MenuButton>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="w-56" align="end" side="top" sideOffset={8}>
		<DropdownMenu.Label>
			<div class="grid leading-tight">
				<span class="text-sm font-medium">{name}</span>
				<span class="text-muted-foreground font-mono text-xs">{role}</span>
			</div>
		</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => goto(resolve('/account/security'))}>
			<SettingsIcon class="size-4" /> Account settings
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={logout}>
			<LogOutIcon class="size-4" /> Log out
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
