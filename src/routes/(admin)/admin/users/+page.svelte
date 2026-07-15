<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { users } from '$lib/mock/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
	<div class="flex items-center justify-between">
		<div class="flex flex-col gap-1">
			<h1 class="font-heading text-2xl font-semibold tracking-tight">Users &amp; Mailboxes</h1>
			<p class="text-muted-foreground text-sm">People with access to your domains.</p>
		</div>
		<Button class="gap-1.5" onclick={() => console.log('TODO: create user')}>
			<PlusIcon class="size-4" /> Add user
		</Button>
	</div>

	<Card.Card class="overflow-hidden py-0">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>User</Table.Head>
					<Table.Head>Role</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head class="text-right">Mailboxes</Table.Head>
					<Table.Head class="text-right">Last seen</Table.Head>
					<Table.Head class="w-10"></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each users as user (user.id)}
					<Table.Row>
						<Table.Cell>
							<div class="flex flex-col">
								<span class="font-medium">{user.name}</span>
								<span class="text-muted-foreground font-mono text-xs">{user.email}</span>
							</div>
						</Table.Cell>
						<Table.Cell>
							<Badge variant={user.role === 'member' ? 'secondary' : 'default'} class="capitalize">
								{user.role}
							</Badge>
						</Table.Cell>
						<Table.Cell><StatusChip status={user.status} /></Table.Cell>
						<Table.Cell class="text-right">{user.mailboxes}</Table.Cell>
						<Table.Cell class="text-muted-foreground text-right text-sm">{user.lastSeen}</Table.Cell>
						<Table.Cell>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button variant="ghost" size="icon" class="text-muted-foreground size-8" {...props}>
											<MoreHorizontalIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onSelect={() => console.log('TODO: pause login', user.id)}>
										<PauseIcon class="size-4" /> Pause login
									</DropdownMenu.Item>
									<DropdownMenu.Item
										variant="destructive"
										onSelect={() => console.log('TODO: remove user', user.id)}
									>
										<Trash2Icon class="size-4" /> Remove
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Card>
</div>
