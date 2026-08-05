<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Member detail: opened by clicking a row on the org members table. Sheet on
	// desktop / Drawer on mobile (same split as contact-card-sheet). Detail loads
	// lazily via getMemberDetail; all mutations refresh it and notify the parent.
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { toast } from 'svelte-sonner';
	import {
		getMemberDetail,
		updateMemberProfile,
		changeMemberRole,
		revokeMemberSessions,
		pauseUser,
		removeUser
	} from '$lib/rpc/manage-users.remote';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { errorMessage } from '$lib/utils/error-message';

	type MemberSummary = { id: string; name: string; email: string; role: string; status: string };
	let {
		member,
		organizationId,
		onClose,
		onChanged
	}: {
		/** Row summary from the table; non-null opens the sheet. */
		member: MemberSummary | null;
		organizationId: string;
		onClose: () => void;
		/** Parent re-loads the table after any successful mutation. */
		onChanged: () => void;
	} = $props();

	const isMobile = new IsMobile();

	// Lazy: the query only instantiates once the sheet opens.
	const detailQuery = $derived(
		member ? getMemberDetail({ userId: member.id, organizationId }) : null
	);
	// ?? guard: remote-query proxies can resolve undefined mid-hydration.
	const detail = $derived(detailQuery?.current ?? null);

	// Header prefers refreshed detail over the table-row snapshot, so role/status
	// badges update right after a mutation instead of only after a page reload.
	const headerName = $derived(detail?.name ?? member?.name ?? '');
	const headerRole = $derived(detail?.role ?? member?.role ?? '');
	const headerStatus = $derived(detail?.status ?? member?.status ?? '');

	// Writable deriveds: reset to the server values whenever the detail (re)loads.
	let editName = $derived(detail?.name ?? '');
	let editRecovery = $derived(detail?.recoveryEmail ?? '');

	const shortDate = (value: Date | string | number) =>
		new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

	let saving = $state(false);
	async function saveProfile() {
		if (!member) return;
		saving = true;
		try {
			await updateMemberProfile({ userId: member.id, name: editName.trim(), recoveryEmail: editRecovery.trim() });
			toast.success('Profile saved.');
			await detailQuery?.refresh();
			onChanged();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not save the profile.'));
		} finally {
			saving = false;
		}
	}

	let pendingRole = $state<'member' | 'admin' | null>(null);
	let applyingRole = $state(false);
	async function applyRole() {
		if (!member || !detail || !pendingRole) return;
		applyingRole = true;
		try {
			await changeMemberRole({
				userId: member.id,
				memberRowId: detail.memberRowId,
				organizationId,
				role: pendingRole
			});
			toast.success(`Role changed to ${pendingRole}.`);
			pendingRole = null;
			await detailQuery?.refresh();
			onChanged();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not change the role.'));
		} finally {
			applyingRole = false;
		}
	}

	let pausing = $state(false);
	async function togglePause() {
		if (!member) return;
		pausing = true;
		try {
			const { paused } = await pauseUser(member.id);
			toast.success(paused ? 'Login paused.' : 'Login resumed.');
			await detailQuery?.refresh();
			onChanged();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not update login access.'));
		} finally {
			pausing = false;
		}
	}

	let revoking = $state(false);
	async function signOutEverywhere() {
		if (!member) return;
		revoking = true;
		try {
			await revokeMemberSessions(member.id);
			toast.success('Signed out everywhere.');
			await detailQuery?.refresh();
			onChanged();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not revoke sessions.'));
		} finally {
			revoking = false;
		}
	}

	let removing = $state(false);
	async function remove() {
		if (!member) return;
		removing = true;
		try {
			await removeUser(member.id);
			toast.success('User removed.');
			onClose();
			onChanged();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not remove user.'));
		} finally {
			removing = false;
		}
	}
</script>

{#snippet header()}
	{#if member}
		<div class="flex flex-col gap-1.5 pr-8">
			<span class="text-base font-semibold">{headerName}</span>
			<span class="text-muted-foreground font-mono text-xs">{member.email}</span>
			<div class="flex items-center gap-2">
				<Badge variant={headerRole === 'member' ? 'secondary' : 'info'} class="capitalize">
					{headerRole}
				</Badge>
				<StatusChip status={headerStatus} />
			</div>
		</div>
	{/if}
{/snippet}

{#snippet detailRow(label: string, value: string)}
	<div class="flex items-baseline justify-between gap-3">
		<dt class="text-muted-foreground shrink-0">{label}</dt>
		<dd class="min-w-0 truncate text-right">{value}</dd>
	</div>
{/snippet}

{#snippet body()}
	<div class="flex flex-col gap-5 px-4 py-4">
		{#if detailQuery?.error}
			<div class="flex items-center justify-between gap-2 text-sm">
				<span class="text-destructive">Couldn't load this member.</span>
				<Button variant="outline" size="sm" onclick={() => detailQuery?.refresh()}>Retry</Button>
			</div>
		{:else if !detail}
			<div class="flex flex-col gap-3">
				<Skeleton class="h-5 w-full" />
				<Skeleton class="h-5 w-3/4" />
				<Skeleton class="h-5 w-full" />
				<Skeleton class="h-5 w-2/3" />
			</div>
		{:else}
			<section class="flex flex-col gap-2">
				<h3 class="text-muted-foreground text-xs font-medium tracking-wide uppercase">Details</h3>
				<dl class="flex flex-col gap-2 text-sm">
					<div class="flex items-baseline justify-between gap-3">
						<dt class="text-muted-foreground shrink-0">Recovery email</dt>
						<dd class="flex min-w-0 items-center gap-1.5">
							<span class="min-w-0 truncate font-mono text-xs">{detail.recoveryEmail ?? '—'}</span>
							{#if detail.recoveryEmail}
								<StatusChip status={detail.recoveryEmailVerified ? 'verified' : 'unverified'} />
							{/if}
						</dd>
					</div>
					{@render detailRow('Two-factor', detail.twoFactorEnabled ? 'On' : 'Off')}
					{@render detailRow('Joined', shortDate(detail.memberSince))}
					{@render detailRow('Account created', shortDate(detail.createdAt))}
					{@render detailRow('Invited by', detail.inviterName ?? '—')}
					{@render detailRow('Active sessions', String(detail.sessionCount))}
				</dl>
				{#if detail.mustChangePassword}
					<p class="text-warn text-xs">Must change password on next login.</p>
				{/if}
				{#if headerStatus === 'pending'}
					<p class="text-warn text-xs">Pending invite — they haven't confirmed yet.</p>
				{/if}
			</section>

			{#if !detail.editable}
				<p class="text-muted-foreground text-sm">
					Your own account and protected accounts can't be edited here.
				</p>
			{:else}
				<section class="flex flex-col gap-3 border-t pt-4">
					<h3 class="text-muted-foreground text-xs font-medium tracking-wide uppercase">Edit</h3>
					<Field.Field>
						<Field.Label for="member-edit-name">Name</Field.Label>
						<Input id="member-edit-name" bind:value={editName} />
					</Field.Field>
					<Field.Field>
						<Field.Label for="member-edit-recovery">Recovery email</Field.Label>
						<Input id="member-edit-recovery" type="email" bind:value={editRecovery} />
					</Field.Field>
					<Button class="self-start" disabled={saving || editName.trim().length < 2} onclick={saveProfile}>
						{#if saving}<Spinner class="mr-1" />{/if}
						Save
					</Button>

					<Field.Field>
						<Field.Label for="member-edit-role">Role</Field.Label>
						{#if detail.role === 'owner'}
							<p class="text-muted-foreground text-sm">The owner role can't be changed here.</p>
						{:else}
							<Select.Root
								type="single"
								value={detail.role}
								onValueChange={(value) => {
									if (value !== detail.role) pendingRole = value as 'member' | 'admin';
								}}
							>
								<Select.Trigger id="member-edit-role" class="w-full capitalize">
									{detail.role}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="member" label="Member" />
									<Select.Item value="admin" label="Admin" />
								</Select.Content>
							</Select.Root>
						{/if}
					</Field.Field>
				</section>
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet footer()}
	{#if detail?.editable}
		<div class="grid grid-cols-2 gap-2 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
			{#if detail.banned}
				<Button variant="outline" size="sm" class="w-full" disabled={pausing} onclick={togglePause}>
					{#if pausing}<Spinner class="mr-1" />{:else}<PauseIcon class="size-3.5" />{/if}
					Resume
				</Button>
			{:else}
				<AlertDialog.Root>
					<AlertDialog.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="outline" size="sm" class="w-full" disabled={pausing}>
								{#if pausing}<Spinner class="mr-1" />{:else}<PauseIcon class="size-3.5" />{/if}
								Pause
							</Button>
						{/snippet}
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>Pause {member?.name}?</AlertDialog.Title>
							<AlertDialog.Description>
								They'll be signed out of all sessions and can't log in again until you resume their
								access.
							</AlertDialog.Description>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
							<AlertDialog.Action onclick={togglePause}>Pause</AlertDialog.Action>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
			{/if}
			<AlertDialog.Root>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm" class="w-full" disabled={revoking}>
							{#if revoking}<Spinner class="mr-1" />{:else}<LogOutIcon class="size-3.5" />{/if}
							Sign out everywhere
						</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>Sign out {member?.name} everywhere?</AlertDialog.Title>
						<AlertDialog.Description>
							All their sessions end and every device will need to log in again.
						</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
						<AlertDialog.Action onclick={signOutEverywhere}>Sign out</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
			<AlertDialog.Root>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							size="sm"
							class="text-destructive hover:text-destructive col-span-2 w-full"
							disabled={removing}
						>
							{#if removing}<Spinner class="mr-1" />{:else}<Trash2Icon class="size-3.5" />{/if}
							Remove
						</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>Remove {member?.name}?</AlertDialog.Title>
						<AlertDialog.Description>
							This deletes the account, its mailbox membership and all active sessions. This can't
							be undone.
						</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel disabled={removing}>Cancel</AlertDialog.Cancel>
						<AlertDialog.Action
							disabled={removing}
							onclick={(event) => {
								event.preventDefault();
								remove();
							}}
							class="bg-destructive text-white hover:bg-destructive/90"
						>
							{#if removing}<Spinner class="mr-1" />{/if}
							Remove
						</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</div>
	{/if}
{/snippet}

<AlertDialog.Root open={pendingRole !== null} onOpenChange={(open) => !open && (pendingRole = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Change role to {pendingRole}?</AlertDialog.Title>
			<AlertDialog.Description>
				{member?.name} will {pendingRole === 'admin'
					? 'be able to manage members and settings for this organization.'
					: 'lose admin access to this organization.'}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={applyingRole}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={applyingRole}
				onclick={(event) => {
					event.preventDefault();
					applyRole();
				}}
			>
				{#if applyingRole}<Spinner class="mr-1" />{/if}
				Change role
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

{#if isMobile.current}
	<Drawer.Root open={member !== null} onOpenChange={(open) => !open && onClose()}>
		<Drawer.Content class="p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
			<Drawer.Header class="pb-0 text-left">{@render header()}</Drawer.Header>
			<!-- Footer pinned below the scroll area so actions are visible without
			     scrolling; only the body scrolls (and it holds the inputs, so the
			     iOS keyboard resize still keeps the focused field in view). -->
			<div class="min-h-0 flex-1 overflow-y-auto">
				{@render body()}
			</div>
			{@render footer()}
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Sheet.Root open={member !== null} onOpenChange={(open) => !open && onClose()}>
		<Sheet.Content side="right" class="gap-0 p-0 sm:max-w-md">
			<Sheet.Header class="border-b px-4 py-4">{@render header()}</Sheet.Header>
			<div class="min-h-0 flex-1 overflow-y-auto">{@render body()}</div>
			{@render footer()}
		</Sheet.Content>
	</Sheet.Root>
{/if}
