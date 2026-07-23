<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import UserChip from '$lib/components/app/user-chip.svelte';
	import RolePreviewSwitcher from '$lib/components/app/role-preview-switcher.svelte';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import UsersIcon from '@lucide/svelte/icons/users';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import MailIcon from '@lucide/svelte/icons/mail';

	let { user }: { user: { name: string; email: string; role: string; image?: string | null } } = $props();

	const nav = [
		{ href: '/admin', label: 'Dashboard', icon: LayoutDashboardIcon },
		{ href: '/admin/organizations', label: 'Organizations', icon: UsersIcon },
		{ href: '/admin/oversight', label: 'Oversight', icon: EyeIcon, superadmin: true }
	] as const;

	const items = $derived(
		nav.filter((n) => !('superadmin' in n && n.superadmin) || user.role === 'superadmin')
	);
</script>

<Sidebar.Root>
	<Sidebar.Header class="gap-2">
		<div class="flex items-center gap-2 px-2 pt-1">
			<div
				class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md font-heading text-base font-bold"
			>
				D
			</div>
			<span class="font-heading text-lg font-semibold tracking-tight">Doota</span>
			<span class="text-faint bg-muted ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
				Admin
			</span>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each items as item (item.href)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={item.href === '/admin'
									? page.url.pathname === '/admin'
									: page.url.pathname.startsWith(item.href)}
							>
								{#snippet child({ props })}
									<a href={resolve(item.href)} {...props}>
										<item.icon class="size-4" />
										<span>{item.label}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

	</Sidebar.Content>

	<Sidebar.Footer>
		<RolePreviewSwitcher />
		{#if user.role === 'admin'}
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton>
						{#snippet child({ props })}
							<a href={resolve('/app')} {...props}>
								<MailIcon class="size-4" />
								<span>Back to mailbox</span>
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		{/if}
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<UserChip name={user.name} email={user.email} role={user.role} image={user.image}/>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
