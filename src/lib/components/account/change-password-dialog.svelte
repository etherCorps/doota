<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import { toast } from 'svelte-sonner';
	import {
		requestPasswordResetCode,
		confirmPasswordReset
	} from '$lib/rpc/reset-password.remote';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let step = $state<'request' | 'confirm'>('request');
	let sending = $state(false);
	// Result persists after submit; track which one we already acted on so the
	// close effect fires once per submit, not again on every reopen.
	let handled: unknown;

	// Reset to the first step whenever the dialog reopens.
	$effect(() => {
		if (open) {
			step = 'request';
			sending = false;
		}
	});

	// Close on a successful change.
	$effect(() => {
		const result = confirmPasswordReset.result;
		if (result?.success && result !== handled) {
			handled = result;
			toast.success('Password updated.');
			open = false;
		}
	});

	async function sendCode() {
		sending = true;
		const res = await requestPasswordResetCode();
		sending = false;
		if (!res.ok) {
			toast.error(res.message);
			return;
		}
		toast.success(res.message);
		step = 'confirm';
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Change password</Dialog.Title>
			<Dialog.Description>
				For your security this needs both an emailed verification code and your current
				password.
			</Dialog.Description>
		</Dialog.Header>

		{#if step === 'request'}
			<div class="flex flex-col gap-4 py-2">
				<p class="text-muted-foreground text-sm">
					We'll email a 6-digit code to the address on file for your account. Enter it along with
					your current password to set a new one.
				</p>
				<Button class="gap-1.5 self-start" onclick={sendCode} disabled={sending}>
					{#if sending}<Spinner class="mr-1" />{:else}<MailIcon class="size-4" />{/if}
					Send verification code
				</Button>
			</div>
		{:else}
			<form {...confirmPasswordReset} class="flex flex-col gap-3 py-2">
				<Field.Field>
					<Field.Label>Verification code</Field.Label>
					<Input
						{...confirmPasswordReset.fields.code.as('text')}
						inputmode="numeric"
						maxlength={6}
						placeholder="123456"
						autocomplete="one-time-code"
						class="font-mono tracking-widest"
						required
					/>
					{#each confirmPasswordReset.fields.code.issues() ?? [] as issue (issue)}
						<Field.Error>{issue.message}</Field.Error>
					{/each}
				</Field.Field>
				<Field.Field>
					<Field.Label>Current password</Field.Label>
					<Input
						{...confirmPasswordReset.fields.currentPassword.as('password')}
						autocomplete="current-password"
						required
					/>
					{#each confirmPasswordReset.fields.currentPassword.issues() ?? [] as issue (issue)}
						<Field.Error>{issue.message}</Field.Error>
					{/each}
				</Field.Field>
				<Field.Field>
					<Field.Label>New password</Field.Label>
					<Input
						{...confirmPasswordReset.fields.newPassword.as('password')}
						autocomplete="new-password"
						required
					/>
					{#each confirmPasswordReset.fields.newPassword.issues() ?? [] as issue (issue)}
						<Field.Error>{issue.message}</Field.Error>
					{/each}
				</Field.Field>
				{#if confirmPasswordReset.result && !confirmPasswordReset.result.success}
					<p class="text-destructive text-sm">{confirmPasswordReset.result.message}</p>
				{/if}
				<div class="flex items-center justify-between">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onclick={() => (step = 'request')}
					>
						Resend code
					</Button>
					<Button type="submit">Update password</Button>
				</div>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
