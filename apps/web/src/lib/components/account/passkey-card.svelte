<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/client/auth-client';
	import { deviceLabel } from '$lib/utils/device-label';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { errorMessage } from '$lib/utils/error-message';

	let {
		passkeys
	}: { passkeys: { id: string; name: string | null; createdAt?: Date | null }[] } = $props();

	// Prefill a device-derived name — an empty field reads as optional homework;
	// a ready suggestion ("Mac \u00b7 Chrome") invites a one-click add. Editable.
	function suggestedName(): string {
		if (typeof navigator === 'undefined') return '';
		return deviceLabel(navigator.userAgent);
	}

	let showAdd = $state(false);
	let passkeyName = $state(suggestedName());
	let passkeyLoading = $state(false);
	let deletingId = $state<string | null>(null);

	const shortDate = (date: Date) =>
		date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

	async function addPasskey() {
		passkeyLoading = true;
		try {
			const res = await authClient.passkey.addPasskey({ name: passkeyName || undefined });
			if (res?.error) {
				// Surface the discriminating code — iOS PWA failures land here as a
				// bare WebAuthn error (NotAllowedError = activation/cancel, SecurityError
				// = rpID), and the generic message alone can't tell them apart.
				const errCode = 'code' in res.error ? res.error.code : '';
				const code = errCode ? ` (${errCode})` : '';
				toast.error((res.error.message ?? 'Could not add passkey.') + code);
				return;
			}
			passkeyName = suggestedName();
			showAdd = false;
			toast.success('Passkey added.');
			await invalidateAll();
		} catch (err) {
			// A rejected navigator.credentials.create surfaces as a DOMException whose
			// .name (NotAllowedError, SecurityError, NotSupportedError) is the real signal.
			const name = err instanceof Error && err.name ? ` (${err.name})` : '';
			toast.error(errorMessage(err, 'Could not add passkey.') + name);
		} finally {
			passkeyLoading = false;
		}
	}

	async function removePasskey(passkey: { id: string; name: string | null }) {
		deletingId = passkey.id;
		const { error } = await authClient.passkey.deletePasskey({ id: passkey.id });
		deletingId = null;
		if (error) {
			toast.error(error.message ?? 'Could not delete passkey.');
			return;
		}
		toast.success('Passkey deleted.');
		await invalidateAll();
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<FingerprintIcon class="size-4" /> Passkeys
		</Card.CardTitle>
		<Card.CardDescription>
			Preferred login once enrolled — a passkey is already two factors, so no TOTP step follows it.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-4">
		{#if passkeys.length}
			<ul class="flex flex-col gap-2 text-sm">
				{#each passkeys as pk (pk.id)}
					{@const pkName = pk.name ?? 'Unnamed passkey'}
					<li class="flex items-center gap-2">
						<FingerprintIcon class="text-muted-foreground size-3.5 shrink-0" />
						<div class="min-w-0 flex-1">
							<p class="truncate">{pkName}</p>
							{#if pk.createdAt}
								<p class="text-muted-foreground text-xs">Added {shortDate(pk.createdAt)}</p>
							{/if}
						</div>
						<AlertDialog.Root>
							<AlertDialog.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										size="icon"
										variant="ghost"
										class="text-destructive hover:text-destructive size-8"
										title="Delete"
										aria-label="Delete passkey {pkName}"
										disabled={deletingId === pk.id}
									>
										{#if deletingId === pk.id}
											<Spinner class="size-3.5" />
										{:else}
											<Trash2Icon class="size-3.5" />
										{/if}
									</Button>
								{/snippet}
							</AlertDialog.Trigger>
							<AlertDialog.Content>
								<AlertDialog.Header>
									<AlertDialog.Title>Delete passkey '{pkName}'?</AlertDialog.Title>
									<AlertDialog.Description>
										You'll no longer be able to sign in with it.
									</AlertDialog.Description>
								</AlertDialog.Header>
								<AlertDialog.Footer>
									<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
									<AlertDialog.Action
										onclick={() => removePasskey(pk)}
										class="bg-destructive text-white hover:bg-destructive/90"
									>
										Delete
									</AlertDialog.Action>
								</AlertDialog.Footer>
							</AlertDialog.Content>
						</AlertDialog.Root>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-muted-foreground text-sm">No passkeys yet.</p>
		{/if}
		{#if showAdd}
			<div class="flex flex-col gap-2 sm:flex-row sm:items-end">
				<Field.Field class="flex-1">
					<Field.Label>Passkey name (optional)</Field.Label>
					<Input type="text" placeholder="e.g. MacBook Touch ID" bind:value={passkeyName} />
				</Field.Field>
				<Button variant="outline" onclick={addPasskey} disabled={passkeyLoading}>
					{#if passkeyLoading}<Spinner class="mr-1" />{/if}
					Add passkey
				</Button>
			</div>
		{:else}
			<Button variant="outline" class="self-start" onclick={() => (showAdd = true)}>
				Add passkey…
			</Button>
		{/if}
	</Card.CardContent>
</Card.Card>
