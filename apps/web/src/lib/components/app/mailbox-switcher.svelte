<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import MailIcon from '@lucide/svelte/icons/mail';

	type Box = { id: string; address: string; displayName: string | null };
	let mailboxes = $state<Box[]>([]);
	onMount(async () => {
		mailboxes = await myMailboxes();
	});

	const activeId = $derived(page.url.searchParams.get('mailbox') ?? mailboxes[0]?.id ?? null);
	const active = $derived(mailboxes.find((m) => m.id === activeId) ?? mailboxes[0]);

	const sidebar = useSidebar();
	function pick(id: string) {
		// Switch mailbox on the mail route; reset the open thread. On mobile the
		// sidebar is a sheet — close it so the list is visible.
		sidebar.setOpenMobile(false);
		goto(`${resolve('/app')}?mailbox=${id}`, { keepFocus: true });
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Sidebar.MenuButton size="lg" class="data-[state=open]:bg-sidebar-accent" {...props}>
				<div
					class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md"
				>
					<MailIcon class="size-4" />
				</div>
				<div class="grid flex-1 text-left leading-tight">
					<span class="truncate text-sm font-medium">{active?.displayName ?? 'Mailbox'}</span>
					<span class="text-muted-foreground truncate font-mono text-xs">{active?.address ?? '…'}</span>
				</div>
				<ChevronsUpDownIcon class="text-muted-foreground ml-auto size-4" />
			</Sidebar.MenuButton>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="w-64" align="start" sideOffset={8}>
		<DropdownMenu.Label class="text-muted-foreground text-xs">Mailboxes</DropdownMenu.Label>
		{#each mailboxes as mailbox (mailbox.id)}
			<DropdownMenu.Item onSelect={() => pick(mailbox.id)}>
				<div class="grid flex-1 leading-tight">
					<span class="text-sm">{mailbox.displayName ?? mailbox.address}</span>
					<span class="text-muted-foreground font-mono text-xs">{mailbox.address}</span>
				</div>
				{#if activeId === mailbox.id}<CheckIcon class="size-4" />{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
