<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Org-wide 2FA mandate (Phase C). Toggling on sets a 7-day grace deadline
	// server-side; members are prompted during grace, then blocked at the request
	// guard (hooks.server.ts) until they enrol. API keys are exempt by construction
	// — they never hit the interactive guard. See docs/2fa.md.
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { orgRequire2fa, setOrgRequire2fa } from '$lib/rpc/domains.remote.js';
	import { errorMessage } from '$lib/utils/error-message';

	let { orgId }: { orgId: string } = $props();

	// orgId is fixed for this card instance, so capturing its initial value is fine.
	// svelte-ignore state_referenced_locally
	const q = orgRequire2fa(orgId);
	let saving = $state(false);
	// Optimistic override while a save is in flight; else the switch reflects the
	// server value directly (no seed-into-$state effect).
	let pending = $state<{ required: boolean; from: number | null } | null>(null);
	const state2fa = $derived(pending ?? q.current ?? { required: false, from: null });

	const fmtDeadline = (ms: number | null) =>
		ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

	// Org-wide consequence (a 7-day countdown to locking members out — or dropping
	// the mandate) must not fire on a single stray switch tap: the toggle opens a
	// confirm; only Confirm calls save(). The switch is controlled, so it doesn't
	// visually flip until the save actually lands.
	let confirmTo = $state<boolean | null>(null);

	async function save(required: boolean) {
		if (saving) return;
		pending = { required, from: state2fa.from };
		saving = true;
		try {
			const res = await setOrgRequire2fa({ orgId, required });
			pending = res;
			await q.refresh();
			toast.success(required ? 'Two-factor authentication is now required.' : 'Two-factor requirement removed.');
		} catch (e) {
			pending = null;
			toast.error(errorMessage(e, 'Could not save.'));
		} finally {
			saving = false;
		}
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<ShieldCheckIcon class="size-4" /> Two-factor authentication
		</Card.CardTitle>
		<Card.CardDescription>
			Require everyone in this organization to protect their account with a second factor.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="space-y-4">
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm font-medium">Require 2FA</p>
				<p class="text-muted-foreground text-xs">
					Members get a 7-day grace period to enrol, then they're blocked from the app until they do.
				</p>
			</div>
			<!-- Function binding: the switch ALWAYS mirrors state2fa (bits-ui otherwise
			     keeps internal state, so a tap would flip it visually before — and
			     survive — the confirm's Cancel). The write side only opens the confirm. -->
			<Switch
				bind:checked={() => state2fa.required, (v) => (confirmTo = v)}
				disabled={saving || q.current === undefined}
			/>
		</div>

		{#if state2fa.required && state2fa.from}
			<div class="border-brand/40 bg-brand/10 text-foreground rounded-xl border px-3 py-2 text-sm">
				Members have until <span class="font-medium">{fmtDeadline(state2fa.from)}</span> to enrol.
			</div>
		{/if}

		<!-- Stop-gate: the API-key exemption must be stated in plain words. -->
		<p class="text-muted-foreground text-xs">
			API keys are exempt — they authenticate without an interactive login, so they keep working.
		</p>
	</Card.CardContent>
</Card.Card>

<!-- Confirm before arming (or dropping) an org-wide mandate. -->
<AlertDialog.Root
	open={confirmTo !== null}
	onOpenChange={(open) => {
		if (!open) confirmTo = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{confirmTo ? 'Require two-factor authentication?' : 'Remove the two-factor requirement?'}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if confirmTo}
					Everyone in this organization must enrol within 7 days. After that, members without a
					second factor are blocked from the app until they enrol.
				{:else}
					Members will no longer be required to protect their account with a second factor.
					Existing enrolments stay in place.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					const next = confirmTo === true;
					confirmTo = null;
					void save(next);
				}}
			>
				{confirmTo ? 'Require 2FA' : 'Remove requirement'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
