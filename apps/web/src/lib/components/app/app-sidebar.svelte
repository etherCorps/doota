<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import MailboxSwitcher from './mailbox-switcher.svelte';
	import UserChip from './user-chip.svelte';
	import BrandMark from './brand-mark.svelte';
	import RolePreviewSwitcher from './role-preview-switcher.svelte';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import SendIcon from '@lucide/svelte/icons/send';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ShieldIcon from '@lucide/svelte/icons/shield';

	let {
		user,
		onCompose
	}: {
		user: { name: string; email: string; role: string; image?: string | null };
		onCompose: () => void;
	} = $props();

	// The real folder set, matching the mail view's FOLDERS (drafts/scheduled are
	// virtual client folders; the rest are thread placements).
	const FOLDERS = [
		{ id: 'inbox', name: 'Inbox', icon: InboxIcon },
		{ id: 'sent', name: 'Sent', icon: SendIcon },
		{ id: 'drafts', name: 'Drafts', icon: FileTextIcon },
		{ id: 'scheduled', name: 'Scheduled', icon: ClockIcon },
		{ id: 'archived', name: 'Archive', icon: ArchiveIcon },
		{ id: 'spam', name: 'Spam', icon: ShieldAlertIcon },
		{ id: 'trash', name: 'Trash', icon: Trash2Icon }
	] as const;

	// Active folder comes from the ?folder= param; inbox is the default view.
	const activeFolder = $derived(page.url.searchParams.get('folder') ?? 'inbox');

	const folderHref = (id: string) => `${resolve('/app')}?folder=${id}`;
</script>

<Sidebar.Root>
	<Sidebar.Header class="gap-2">
		<div class="flex items-center gap-2 px-2 pt-1">
			<BrandMark size={26} />
			<span class="font-heading text-lg font-semibold tracking-tight">Doota</span>
		</div>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<MailboxSwitcher />
			</Sidebar.MenuItem>
		</Sidebar.Menu>
		<Button onclick={onCompose} class="mx-1 mt-1 justify-start gap-2">
			<PenLineIcon class="size-4" /> Compose
		</Button>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each FOLDERS as folder (folder.id)}
						{@const Icon = folder.icon}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={activeFolder === folder.id}>
								{#snippet child({ props })}
									<a href={folderHref(folder.id)} {...props}>
										<Icon class="size-4" />
										<span>{folder.name}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		{#if user.role === 'admin'}
			<Sidebar.Group>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton>
								{#snippet child({ props })}
									<a href={resolve('/admin')} {...props}>
										<ShieldIcon class="size-4" />
										<span>Admin dashboard</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}
	</Sidebar.Content>

	<Sidebar.Footer>
		<RolePreviewSwitcher />
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<UserChip name={user.name} email={user.email} role={user.role} image={user.image} />
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
