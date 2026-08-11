<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import { authClient } from '$lib/client/auth-client.js';
	import { MAX_DEVICE_SESSIONS } from '$lib/auth-limits.js';
	import { localdb } from '$lib/client/localdb';
	import { clearAppShellCache } from '$lib/client/app-shell-cache.js';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import UserPlusIcon from '@lucide/svelte/icons/user-plus';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let {
		userId,
		name,
		email,
		role,
		image = null
	}: { userId: string; name: string; email: string; role: string; image?: string | null } = $props();

	const toInitials = (fullName: string) =>
		fullName
			.split(' ')
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase();
	const initials = $derived(toInitials(name));

	const sidebar = useSidebar();

	// Device sessions (multiSession plugin) — every account signed in on this
	// browser. Fetched when the menu opens, so the list is fresh without polling.
	type DeviceSession = {
		session: { token: string };
		user: { id: string; name: string; email: string; image?: string | null };
	};
	let deviceSessions = $state<DeviceSession[]>([]);
	// The current account is identified by email (unique per user) — the props
	// come from server data, the list from the client API.
	const others = $derived(deviceSessions.filter((entry) => entry.user.email !== email));
	const current = $derived(deviceSessions.find((entry) => entry.user.email === email));

	async function loadSessions() {
		const { data } = await authClient.multiSession.listDeviceSessions();
		deviceSessions = (data as DeviceSession[] | null) ?? [];
	}
	// At the cap another sign-in wouldn't be tracked by multiSession (it works
	// until you switch away, then vanishes), so "Add account" blocks with the
	// reason. The login page guards the direct-URL path server-side too.
	const atLimit = $derived(deviceSessions.length >= MAX_DEVICE_SESSIONS);
	function onMenuOpenChange(open: boolean) {
		if (open) void loadSessions();
	}

	/**
	 * All post-auth-mutation navigation goes through /login as a full document
	 * load: the server bounces a live session to that account's home (role +
	 * onboarding aware) and shows the login form when none is left. A full load,
	 * not goto, because every layout holds the previous account's data.
	 */
	function reenter() {
		window.location.assign(resolve('/login'));
	}

	// The switch spans a setActive roundtrip + a full document load — seconds
	// during which the old account is still on screen. A blocking overlay (below)
	// covers the whole stretch; the document unload takes it down.
	let switching = $state<string | null>(null);
	async function switchTo(target: DeviceSession) {
		switching = target.user.email;
		const { error } = await authClient.multiSession.setActive({ sessionToken: target.session.token });
		if (error) {
			switching = null;
			toast.error(error.message ?? 'Could not switch accounts.');
			return;
		}
		// Clear local mirror + cached app shell before the document reload so this
		// user's plaintext thread data and identity don't persist into the next
		// account's session.
		await localdb.clear(userId).catch(() => {});
		await clearAppShellCache().catch(() => {});
		reenter();
	}

	function addAccount() {
		sidebar.setOpenMobile(false);
		goto(`${resolve('/login')}?add=1`);
	}

	// Log out: with other accounts on the device, ask which scope; alone, just
	// sign out. Revoking the active session server-side promotes the next device
	// session automatically, so "this account" lands on the next account's home.
	let confirmOpen = $state(false);
	let busy = $state(false);

	function onLogoutSelect() {
		if (others.length) confirmOpen = true;
		else void logoutAll();
	}
	async function logoutThis() {
		busy = true;
		if (current) await authClient.multiSession.revoke({ sessionToken: current.session.token });
		else await authClient.signOut();
		await localdb.clear(userId).catch(() => {});
		await clearAppShellCache().catch(() => {});
		reenter();
	}
	async function logoutAll() {
		busy = true;
		// signOut ends every device session (multiSession's sign-out hook).
		await authClient.signOut();
		await localdb.clear(userId).catch(() => {});
		await clearAppShellCache().catch(() => {});
		reenter();
	}

	function toAccount() {
		sidebar.setOpenMobile(false);
		goto(resolve('/account'));
	}
</script>

<DropdownMenu.Root onOpenChange={onMenuOpenChange}>
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
		{#if others.length}
			<DropdownMenu.Separator />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading class="text-muted-foreground text-xs">Switch account</DropdownMenu.GroupHeading>
				{#each others as other (other.user.id)}
					<DropdownMenu.Item onSelect={() => switchTo(other)}>
						<Avatar.Root class="size-6 rounded-md">
							{#if other.user.image}<Avatar.Image src={other.user.image} alt={other.user.name} class="rounded-md" />{/if}
							<Avatar.Fallback class="rounded-md text-[10px]">{toInitials(other.user.name)}</Avatar.Fallback>
						</Avatar.Root>
						<div class="grid min-w-0 flex-1 leading-tight">
							<span class="truncate text-sm">{other.user.name}</span>
							<span class="text-muted-foreground truncate font-mono text-[11px]">{other.user.email}</span>
						</div>
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
		{/if}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={addAccount} disabled={atLimit}>
			<UserPlusIcon class="size-4" />
			{#if atLimit}
				<div class="grid leading-tight">
					<span>Add account</span>
					<span class="text-muted-foreground text-[11px]">Device limit reached ({MAX_DEVICE_SESSIONS} accounts) — log one out first</span>
				</div>
			{:else}
				Add account
			{/if}
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={toAccount}>
			<SettingsIcon class="size-4" /> Account settings
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={onLogoutSelect}>
			<LogOutIcon class="size-4" /> Log out
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Log out</AlertDialog.Title>
			<AlertDialog.Description>
				Other accounts are signed in on this device. Log out of
				<span class="font-medium">{email}</span> only, or all accounts?
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action disabled={busy} onclick={logoutThis}>This account only</AlertDialog.Action>
			<AlertDialog.Action disabled={busy} onclick={logoutAll}>All accounts</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

{#if switching}
	<div
		class="bg-background/80 fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 backdrop-blur-sm"
		role="status"
	>
		<Spinner class="size-6" />
		<p class="text-muted-foreground text-sm">
			Switching to <span class="text-foreground font-medium">{switching}</span>…
		</p>
	</div>
{/if}
