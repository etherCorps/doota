<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import { mergeProps } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import MailboxSwitcher from './mailbox-switcher.svelte';
	import UserChip from './user-chip.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import RolePreviewSwitcher from './role-preview-switcher.svelte';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import SendIcon from '@lucide/svelte/icons/send';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import BellIcon from '@lucide/svelte/icons/bell';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PaletteIcon from '@lucide/svelte/icons/palette';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { myFolders, createFolder, updateFolder, deleteFolder } from '$lib/rpc/label.remote';
	import { goto } from '$app/navigation';
	import { unread } from '$lib/client/unread.svelte.js';
	import { fly } from 'svelte/transition';
	import { notifPerm, enableOsNotifications } from '$lib/client/os-notify.svelte.js';
	import { pwa, installApp } from '$lib/client/pwa-install.svelte.js';
	import { toast } from 'svelte-sonner';
	import { errorMessage } from '$lib/utils/error-message';

	let {
		user,
		onCompose
	}: {
		user: { id: string; name: string; email: string; role: string; image?: string | null };
		onCompose: () => void;
	} = $props();

	// The real folder set, matching the mail view's FOLDERS (drafts/scheduled are
	// virtual client folders; the rest are thread placements).
	const FOLDERS = [
		{ id: 'inbox', name: 'Inbox', icon: InboxIcon },
		{ id: 'snoozed', name: 'Snoozed', icon: AlarmClockIcon },
		{ id: 'sent', name: 'Sent', icon: SendIcon },
		{ id: 'drafts', name: 'Drafts', icon: FileTextIcon },
		{ id: 'scheduled', name: 'Scheduled', icon: ClockIcon },
		{ id: 'archived', name: 'Archive', icon: ArchiveIcon },
		{ id: 'spam', name: 'Spam', icon: ShieldAlertIcon },
		{ id: 'trash', name: 'Trash', icon: Trash2Icon }
	] as const;

	// Active folder comes from the ?folder= param; inbox is the default view.
	// ?label= selects an org folder instead — it suppresses the system highlight.
	const activeFolder = $derived(page.url.searchParams.get('folder') ?? 'inbox');
	const activeLabel = $derived(page.url.searchParams.get('label'));
	const activeMailbox = $derived(page.url.searchParams.get('mailbox'));

	// Org folders (labels) — shared vocabulary, per-mailbox unread counts. The
	// page writes ?mailbox back on a bare load, so the param is reliably there.
	const foldersQ = $derived(activeMailbox ? myFolders({ mailboxId: activeMailbox }) : null);
	const orgFolders = $derived(foldersQ?.current ?? []);
	// Roots name-sorted, each followed by its (sorted) children — max depth 2.
	const folderTree = $derived.by(() => {
		type OrgFolder = (typeof orgFolders)[number];
		const byName = (a: OrgFolder, b: OrgFolder) => a.name.localeCompare(b.name);
		const out: (OrgFolder & { depth: number })[] = [];
		for (const root of orgFolders.filter((folder) => !folder.parentId).sort(byName)) {
			out.push({ ...root, depth: 0 });
			for (const child of orgFolders.filter((folder) => folder.parentId === root.id).sort(byName)) {
				out.push({ ...child, depth: 1 });
			}
		}
		return out;
	});
	const rootFolders = $derived(orgFolders.filter((folder) => !folder.parentId));

	const labelHref = (id: string) => {
		const sp = new URLSearchParams({ label: id });
		if (activeMailbox) sp.set('mailbox', activeMailbox);
		return `${resolve('/app')}?${sp}`;
	};

	// Inline "new folder" popover. Color is optional (dot falls back to muted);
	// parent select offers roots only (depth is capped at 2).
	const PALETTE = ['#ef4444', '#f59e0b', '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#64748b'];
	let newOpen = $state(false);
	let newName = $state('');
	let newColor = $state<string | null>(null);
	let newParent = $state('');
	let creatingFolder = $state(false);
	async function submitNewFolder() {
		const name = newName.trim();
		const mb = activeMailbox;
		if (!name || !mb || creatingFolder) return;
		creatingFolder = true;
		try {
			await createFolder({ mailboxId: mb, name, color: newColor, parentId: newParent || null });
			await foldersQ?.refresh();
			newOpen = false;
			newName = '';
			newColor = null;
			newParent = '';
		} catch (e) {
			toast.error(errorMessage(e, 'Could not create the folder.'));
		} finally {
			creatingFolder = false;
		}
	}

	// Folder manage — the "…" menu. Small patches (color/notify) write straight
	// through; rename + delete get dialogs. Every write refreshes the shared
	// myFolders query (the mail page reads the same one).
	async function patchFolder(labelId: string, patch: { name?: string; color?: string | null; notifyNewMail?: boolean }) {
		const mb = activeMailbox;
		if (!mb) return;
		try {
			await updateFolder({ mailboxId: mb, labelId, ...patch });
			await foldersQ?.refresh();
		} catch (e) {
			toast.error(errorMessage(e, 'Could not update the folder.'));
		}
	}

	let renameTarget = $state<{ id: string; name: string } | null>(null);
	let renameName = $state('');
	let renameBusy = $state(false);
	async function submitRename() {
		const target = renameTarget;
		const name = renameName.trim();
		if (!target || !name || renameBusy) return;
		renameBusy = true;
		try {
			await patchFolder(target.id, { name });
			renameTarget = null;
		} finally {
			renameBusy = false;
		}
	}

	// Delete is never immediate — the dialog always asks where the contents go
	// ("" = they just lose the label; mail keeps its placement either way).
	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let deleteMoveTo = $state('');
	let deleteBusy = $state(false);
	async function submitDelete() {
		const target = deleteTarget;
		const mb = activeMailbox;
		if (!target || !mb || deleteBusy) return;
		deleteBusy = true;
		try {
			await deleteFolder({ mailboxId: mb, labelId: target.id, moveContentsToLabelId: deleteMoveTo || null });
			await foldersQ?.refresh();
			deleteTarget = null;
			// Viewing the folder we just deleted — fall back to the inbox.
			if (activeLabel === target.id) void goto(folderHref('inbox'));
		} catch (e) {
			toast.error(errorMessage(e, 'Could not delete the folder.'));
		} finally {
			deleteBusy = false;
		}
	}

	// Keep the current mailbox when switching folders — otherwise the mailbox
	// param drops and the mail page falls back to the first mailbox (a surprise
	// auto-switch). Only the switcher changes mailbox.
	const folderHref = (id: string) => {
		const sp = new URLSearchParams({ folder: id });
		if (activeMailbox) sp.set('mailbox', activeMailbox);
		return `${resolve('/app')}?${sp}`;
	};

	// On mobile the sidebar is a sheet — navigating from it should close it.
	// No-op on desktop (openMobile only drives the sheet).
	const sidebar = useSidebar();
	const closeMobile = () => sidebar.setOpenMobile(false);

	// ✱ badge → rules settings (?rules=1 on the mail page, current view kept).
	function openRules() {
		closeMobile();
		const sp = new URLSearchParams(page.url.searchParams);
		sp.set('rules', '1');
		void goto(`${resolve('/app')}?${sp}`);
	}
</script>

<!-- New-folder trigger + form body, shared between the desktop popover and the
     mobile drawer. -->
{#snippet newFolderTrigger(triggerProps: Record<string, unknown>)}
	<Sidebar.MenuButton tooltipContent="New folder">
		{#snippet child({ props })}
			<button type="button" {...mergeProps(props, triggerProps, { class: 'text-muted-foreground' })}>
				<PlusIcon class="size-4" />
				<span>New folder</span>
			</button>
		{/snippet}
	</Sidebar.MenuButton>
{/snippet}

{#snippet newFolderBody()}
	<Input
		class="h-8 text-xs pointer-coarse:text-base"
		placeholder="Name"
		aria-label="Folder name"
		bind:value={newName}
		disabled={creatingFolder}
		onkeydown={(event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void submitNewFolder();
			}
		}}
	/>
	<div class="mt-2 flex items-center gap-1.5">
		{#each PALETTE as color (color)}
			<button
				type="button"
				title="Folder color"
				aria-label="Folder color {color}"
				aria-pressed={newColor === color}
				onclick={() => (newColor = newColor === color ? null : color)}
				class="focus-visible:ring-ring/50 size-5 rounded-full border outline-none transition-transform focus-visible:ring-2 {newColor === color ? 'ring-ring scale-110 ring-2' : ''}"
				style="background: {color}"
			></button>
		{/each}
	</div>
	{#if rootFolders.length}
		<Select.Root type="single" bind:value={newParent} disabled={creatingFolder}>
			<Select.Trigger size="sm" class="mt-2 w-full text-xs" aria-label="Parent folder">
				<span class="truncate">
					{rootFolders.find((root) => root.id === newParent)?.name ?? 'No parent'}
				</span>
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="" label="No parent" />
				{#each rootFolders as root (root.id)}
					<Select.Item value={root.id} label={root.name} />
				{/each}
			</Select.Content>
		</Select.Root>
	{/if}
	<Button
		size="sm"
		class="mt-2 h-8 w-full"
		disabled={!newName.trim() || creatingFolder}
		onclick={submitNewFolder}
	>
		Create
	</Button>
{/snippet}

<!-- collapsible="icon": desktop collapse leaves an icon rail (tooltips carry the
     labels) instead of removing navigation entirely. -->
<Sidebar.Root collapsible="icon">
	<Sidebar.Header class="gap-2">
		<div class="flex items-center gap-2 px-2 pt-1">
			<Logo size={26} />
			<span class="font-heading text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">Doota</span>
		</div>
		<Sidebar.Menu class="group-data-[collapsible=icon]:hidden">
			<Sidebar.MenuItem>
				<MailboxSwitcher />
			</Sidebar.MenuItem>
		</Sidebar.Menu>
		<Button
			variant="brand"
			title="Compose"
			onclick={() => {
				closeMobile();
				onCompose();
			}}
			class="mx-1 mt-1 justify-start gap-2 group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
		>
			<PenLineIcon class="size-4" />
			<span class="group-data-[collapsible=icon]:hidden">Compose</span>
		</Button>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Mail</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each FOLDERS as folder (folder.id)}
						{@const Icon = folder.icon}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={activeFolder === folder.id && !activeLabel} tooltipContent={folder.name}>
								{#snippet child({ props })}
									<!-- mergeProps: a plain onclick before the spread gets clobbered by
									     the menu-button/tooltip handlers inside `props`. -->
									<a href={folderHref(folder.id)} {...mergeProps(props, { onclick: closeMobile, class: 'sb-folder' })}>
										<Icon class="size-4 sb-ico sb-ico--{folder.id}" />
										<span>{folder.name}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
							{#if folder.id === 'inbox' && unread.count > 0}
								<Sidebar.MenuBadge class="bg-brand/10 text-brand overflow-hidden rounded-full group-data-[collapsible=icon]:hidden">
									<!-- Keyed pop-in: the count drops in from above when it changes. -->
									{#key unread.count}
										<span
											class="inline-block tabular-nums"
											in:fly={{ y: -10, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220 }}
										>
											{unread.count > 99 ? '99+' : unread.count}
										</span>
									{/key}
								</Sidebar.MenuBadge>
							{/if}
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		{#if activeMailbox}
			<Sidebar.Group>
				<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each folderTree as orgFolder (orgFolder.id)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={activeLabel === orgFolder.id} tooltipContent={orgFolder.name}>
									{#snippet child({ props })}
										<a
											href={labelHref(orgFolder.id)}
											{...mergeProps(props, {
												onclick: closeMobile,
												// Child rows carry a left guide line (border-l) so nesting reads
												// as a tree, not just a subtle indent; contiguous children share
												// one continuous rail.
												class: orgFolder.depth
													? 'relative ml-[0.9rem] border-l border-sidebar-border !pl-[0.75rem]'
													: ''
											})}
										>
											<span
												class="size-2.5 shrink-0 rounded-full"
												style="background: {orgFolder.color ?? 'var(--color-muted-foreground)'}"
											></span>
											<span class="truncate">{orgFolder.name}</span>
											{#if orgFolder.ruleFed}
												<!-- span-as-button: a real <button> can't nest inside the row's <a>.
												     Clicking opens rules settings instead of the folder. -->
												<span
													role="button"
													tabindex="0"
													title="Fed by a rule"
													aria-label="Fed by a rule — open rules"
													class="text-brand/70 hover:text-brand focus-visible:ring-ring/50 -my-1 shrink-0 rounded p-1 outline-none focus-visible:ring-2"
													onclick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														openRules();
													}}
													onkeydown={(event) => {
														if (event.key === 'Enter' || event.key === ' ') {
															event.preventDefault();
															event.stopPropagation();
															openRules();
														}
													}}
												>
													<SparklesIcon class="size-3" />
												</span>
											{/if}
										</a>
									{/snippet}
								</Sidebar.MenuButton>
								{#if orgFolder.unread > 0}
									<Sidebar.MenuBadge class="bg-brand/10 text-brand rounded-full group-data-[collapsible=icon]:hidden">
										<span class="tabular-nums">{orgFolder.unread > 99 ? '99+' : orgFolder.unread}</span>
									</Sidebar.MenuBadge>
								{/if}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props: triggerProps })}
											<Sidebar.MenuAction showOnHover>
												{#snippet child({ props })}
													<button type="button" {...mergeProps(props, triggerProps, { class: 'bg-sidebar' })}>
														<EllipsisIcon class="size-4" />
														<span class="sr-only">Folder actions for {orgFolder.name}</span>
													</button>
												{/snippet}
											</Sidebar.MenuAction>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content class="w-48" side="right" align="start">
										<DropdownMenu.Item
											onSelect={() => {
												renameTarget = { id: orgFolder.id, name: orgFolder.name };
												renameName = orgFolder.name;
											}}
										>
											<PencilIcon class="size-4" /> Rename
										</DropdownMenu.Item>
										<DropdownMenu.Sub>
											<DropdownMenu.SubTrigger>
												<PaletteIcon class="size-4" /> Color
											</DropdownMenu.SubTrigger>
											<DropdownMenu.SubContent class="flex w-auto items-center gap-1.5 p-2">
												{#each PALETTE as color (color)}
													<button
														type="button"
														aria-label="Folder color {color}"
														aria-pressed={orgFolder.color === color}
														onclick={() => void patchFolder(orgFolder.id, { color: orgFolder.color === color ? null : color })}
														class="focus-visible:ring-ring/50 size-5 rounded-full border outline-none transition-transform focus-visible:ring-2 {orgFolder.color === color ? 'ring-ring scale-110 ring-2' : ''}"
														style="background: {color}"
													></button>
												{/each}
											</DropdownMenu.SubContent>
										</DropdownMenu.Sub>
										<DropdownMenu.CheckboxItem
											checked={orgFolder.notifyNewMail}
											closeOnSelect={false}
											onCheckedChange={(value) => void patchFolder(orgFolder.id, { notifyNewMail: value })}
										>
											Notify on new mail
										</DropdownMenu.CheckboxItem>
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											variant="destructive"
											onSelect={() => {
												deleteTarget = { id: orgFolder.id, name: orgFolder.name };
												deleteMoveTo = '';
											}}
										>
											<Trash2Icon class="size-4" /> Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Sidebar.MenuItem>
						{/each}
						<Sidebar.MenuItem>
							<!-- Mobile: a right-side popover from the near-full-width sidebar
							     sheet spills off-screen, so open the create form as a drawer. -->
							{#if sidebar.isMobile}
								<Drawer.Root bind:open={newOpen}>
									<Drawer.Trigger>
										{#snippet child({ props: triggerProps })}{@render newFolderTrigger(triggerProps)}{/snippet}
									</Drawer.Trigger>
									<Drawer.Content class="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
										<Drawer.Header class="p-0 pb-3 text-left">
											<Drawer.Title class="text-sm font-medium">New folder</Drawer.Title>
										</Drawer.Header>
										{@render newFolderBody()}
									</Drawer.Content>
								</Drawer.Root>
							{:else}
								<Popover.Root bind:open={newOpen}>
									<Popover.Trigger>
										{#snippet child({ props: triggerProps })}{@render newFolderTrigger(triggerProps)}{/snippet}
									</Popover.Trigger>
									<Popover.Content class="w-64 p-3" side="right" align="start">
										<p class="mb-2 text-xs font-medium">New folder</p>
										{@render newFolderBody()}
									</Popover.Content>
								</Popover.Root>
							{/if}
						</Sidebar.MenuItem>
						<!-- Always-visible entry to the rules surface. Rules are authored in
						     the move sheet's "always file mail from…" row, so without this a
						     rule not tied to a badged folder would be unreachable. -->
						<Sidebar.MenuItem>
							<Sidebar.MenuButton tooltipContent="Rules" onclick={openRules}>
								<SparklesIcon class="size-4" />
								<span>Rules</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}
		</Sidebar.Content>

	<Sidebar.Footer>
		<div class="group-data-[collapsible=icon]:hidden">
			<RolePreviewSwitcher />
		</div>
		<Sidebar.Menu>
			<!-- One-time affordance: permission prompts need a user gesture, so ask
			     via a click. Disappears once granted or denied. -->
			{#if notifPerm.current === 'default'}
				<Sidebar.MenuItem>
					<Sidebar.MenuButton
						tooltipContent="Enable notifications"
						onclick={() => void enableOsNotifications()}
					>
						<BellIcon class="size-4" />
						<span>Enable notifications</span>
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			{/if}
			<!-- Install to the home screen / dock. Chromium (Chrome/Edge, any desktop
			     + Android) gets a real prompt; Safari (iOS + macOS) can't be prompted,
			     so hint the manual gesture — installing is what turns on push there.
			     Hidden once installed. -->
			{#if !pwa.installed && (pwa.canInstall || pwa.hint)}
				<Sidebar.MenuItem>
					<Sidebar.MenuButton
						tooltipContent="Install app"
						onclick={() =>
							pwa.canInstall
								? void installApp()
								: toast.info('Install Doota', {
										description:
											pwa.hint === 'dock'
												? 'In Safari, open the Share menu → “Add to Dock”.'
												: 'Tap the Share button, then “Add to Home Screen”.'
									})}
					>
						<DownloadIcon class="size-4" />
						<span>Install app</span>
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			{/if}
			{#if user.role === 'admin'}
				<Sidebar.MenuItem>
					<Sidebar.MenuButton tooltipContent="Templates">
						{#snippet child({ props })}
							<a href={resolve('/templates')} {...mergeProps(props, { onclick: closeMobile })}>
								<FileTextIcon class="size-4" />
								<span>Templates</span>
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton tooltipContent="Admin dashboard">
						{#snippet child({ props })}
							<a href={resolve('/admin')} {...mergeProps(props, { onclick: closeMobile })}>
								<ShieldIcon class="size-4" />
								<span>Admin dashboard</span>
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			{/if}
		</Sidebar.Menu>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<UserChip userId={user.id} name={user.name} email={user.email} role={user.role} image={user.image} />
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>

<!-- Rename folder -->
<Dialog.Root open={!!renameTarget} onOpenChange={(value) => { if (!value) renameTarget = null; }}>
	<Dialog.Content class="max-w-xs">
		<Dialog.Header>
			<Dialog.Title class="text-sm">Rename folder</Dialog.Title>
		</Dialog.Header>
		<Input
			class="h-8 text-xs pointer-coarse:text-base"
			aria-label="Folder name"
			bind:value={renameName}
			disabled={renameBusy}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void submitRename();
				}
			}}
		/>
		<Button size="sm" class="h-8 w-full" disabled={!renameName.trim() || renameBusy} onclick={submitRename}>
			Rename
		</Button>
	</Dialog.Content>
</Dialog.Root>

<!-- Delete folder — always confirmed, always asks where the mail's label goes. -->
<Dialog.Root open={!!deleteTarget} onOpenChange={(value) => { if (!value) deleteTarget = null; }}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title class="text-sm">Delete folder “{deleteTarget?.name}”?</Dialog.Title>
			<Dialog.Description class="text-xs">
				Conversations are never deleted — they only lose this folder's label.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-1.5 text-xs">
			<Label for="delete-folder-move-to" class="text-muted-foreground text-xs font-normal">
				Move its conversations to
			</Label>
			<Select.Root type="single" bind:value={deleteMoveTo} disabled={deleteBusy}>
				<Select.Trigger id="delete-folder-move-to" size="sm" class="w-full text-xs">
					<span class="truncate">
						{folderTree.find((folderOption) => folderOption.id === deleteMoveTo)?.name ??
							'None — just remove the label'}
					</span>
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="None — just remove the label" />
					{#each folderTree.filter((folderOption) => folderOption.id !== deleteTarget?.id) as folderOption (folderOption.id)}
						<Select.Item
							value={folderOption.id}
							label={folderOption.name}
							class={folderOption.depth ? 'pl-6' : ''}
						/>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<Button variant="destructive" size="sm" class="h-8 w-full" disabled={deleteBusy} onclick={submitDelete}>
			Delete folder
		</Button>
	</Dialog.Content>
</Dialog.Root>
