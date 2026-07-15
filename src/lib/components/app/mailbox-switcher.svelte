<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { myMailboxes } from '$lib/mock/index.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import MailIcon from '@lucide/svelte/icons/mail';

	let active = $state(myMailboxes[0]);
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
					<span class="truncate text-sm font-medium">{active.label}</span>
					<span class="text-muted-foreground truncate font-mono text-xs">{active.address}</span>
				</div>
				<ChevronsUpDownIcon class="text-muted-foreground ml-auto size-4" />
			</Sidebar.MenuButton>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="w-64" align="start" sideOffset={8}>
		<DropdownMenu.Label class="text-muted-foreground text-xs">Mailboxes</DropdownMenu.Label>
		{#each myMailboxes as mailbox (mailbox.id)}
			<DropdownMenu.Item onSelect={() => (active = mailbox)}>
				<div class="grid flex-1 leading-tight">
					<span class="text-sm">{mailbox.label}</span>
					<span class="text-muted-foreground font-mono text-xs">{mailbox.address}</span>
				</div>
				{#if active.id === mailbox.id}<CheckIcon class="size-4" />{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
