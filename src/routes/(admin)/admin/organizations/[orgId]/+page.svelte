<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { createUser, pauseUser, removeUser } from '$lib/rpc/manage-users.remote';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	let { data } = $props();

	let addOpen = $state(false);
	let handled: unknown;

	$effect(() => {
		const result = createUser.result;
		if (result && result !== handled) {
			handled = result;
			if (result.success) {
				toast.success(result.message);
				addOpen = false;
				invalidateAll();
			} else {
				toast.error(result.message);
			}
		}
	});

	async function pause(userId: string) {
		const { paused } = await pauseUser(userId);
		toast.success(paused ? 'Login paused.' : 'Login resumed.');
		await invalidateAll();
	}

	async function remove(userId: string) {
		await removeUser(userId);
		toast.success('User removed.');
		await invalidateAll();
	}
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<div class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-md">
				<GlobeIcon class="size-5" />
			</div>
			<div class="flex flex-col gap-0.5">
				<h1 class="font-heading text-2xl font-semibold tracking-tight">{data.org.domain}</h1>
				<p class="text-muted-foreground text-sm">{data.members.length} members</p>
			</div>
		</div>
		<Button class="gap-1.5" onclick={() => (addOpen = true)}>
			<PlusIcon class="size-4" /> Add member
		</Button>
	</div>

	<Card.Card class="overflow-hidden py-0">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Member</Table.Head>
					<Table.Head>Role</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head class="w-10"></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.members as member (member.id)}
					<Table.Row>
						<Table.Cell>
							<div class="flex flex-col">
								<span class="font-medium">{member.name}</span>
								<span class="text-muted-foreground font-mono text-xs">{member.email}</span>
							</div>
						</Table.Cell>
						<Table.Cell>
							<Badge variant={member.role === 'member' ? 'secondary' : 'default'} class="capitalize">
								{member.role}
							</Badge>
						</Table.Cell>
						<Table.Cell><StatusChip status={member.status} /></Table.Cell>
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
									<DropdownMenu.Item onSelect={() => pause(member.id)}>
										<PauseIcon class="size-4" />
										{member.status === 'paused' ? 'Resume login' : 'Pause login'}
									</DropdownMenu.Item>
									<DropdownMenu.Item variant="destructive" onSelect={() => remove(member.id)}>
										<Trash2Icon class="size-4" /> Remove
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={4} class="text-muted-foreground py-8 text-center text-sm">
							No members yet. Add one to send an invite.
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Card>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add member</Dialog.Title>
			<Dialog.Description>
				A mailbox on <span class="font-mono">{data.org.domain}</span> is created and an invite with a
				temporary password is sent to their external recovery address.
			</Dialog.Description>
		</Dialog.Header>

		<form {...createUser} class="flex flex-col gap-3 py-2">
			<input {...createUser.fields.organizationId.as('text')} type="hidden" value={data.org.id} />
			<Field.Field>
				<Field.Label>Name</Field.Label>
				<Input {...createUser.fields.name.as('text')} placeholder="Ada Lovelace" required />
				{#each createUser.fields.name.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>Mailbox email</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						{...createUser.fields.email.as('text')}
						placeholder="ada"
						autocomplete="off"
						required
					/>
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono">@{data.org.domain}</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>
				{#each createUser.fields.email.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>Recovery email (external)</Field.Label>
				<Input
					{...createUser.fields.recoveryEmail.as('email')}
					placeholder="ada@gmail.com"
					autocomplete="off"
					required
				/>
				{#each createUser.fields.recoveryEmail.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>Role</Field.Label>
				<select
					{...createUser.fields.role.as('text')}
					class="border-input bg-background h-9 rounded-md border px-3 text-sm"
				>
					<option value="member">Member</option>
					<option value="admin">Admin</option>
				</select>
				{#each createUser.fields.role.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<div class="flex justify-end gap-2 pt-2">
				<Button
					type="button"
					variant="ghost"
					onclick={() => (addOpen = false)}
					disabled={createUser.pending > 0}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={createUser.pending > 0}>
					{#if createUser.pending > 0}<Spinner class="mr-1" />{/if}
					Send invite
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
