<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: vacation auto-responder, per sendable mailbox (same list
	// source as signatures-card). Sparse per-mailbox drafts over the live server
	// value (signatures-card pattern): a mailbox is dirty only once edited; Save
	// writes the merged form and drops the draft.
	import PlaneIcon from '@lucide/svelte/icons/plane';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';
	import WhenPicker from '$lib/components/account/when-picker.svelte';
	import { myMailboxSignatures } from '$lib/rpc/signature.remote';
	import { vacationSettings, setVacationSettings } from '$lib/rpc/vacation.remote';
	import { errorMessage } from '$lib/utils/error-message';

	// The form as edited; startsAt/endsAt are epoch ms (null = unset), the same
	// shape the server holds and setVacationSettings takes — no string round-trip.
	type VacationForm = {
		enabled: boolean;
		subject: string;
		bodyText: string;
		startsAt: number | null;
		endsAt: number | null;
		intervalDays: number;
	};
	type ServerSettings = {
		enabled: boolean;
		subject: string;
		bodyText: string;
		startsAt: number | null;
		endsAt: number | null;
		intervalDays: number;
	};

	// Page-level mailbox scope (see signatures-card): only that mailbox's form
	// renders and its address heading drops.
	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const mailboxes = myMailboxSignatures();
	const visible = $derived(
		mailboxes.current === undefined
			? undefined
			: mailboxId
				? mailboxes.current.filter((box) => box.mailboxId === mailboxId)
				: mailboxes.current
	);
	// Header summary reads the same per-mailbox query the form uses (cached by args).
	const summaryQuery = $derived(mailboxId ? vacationSettings({ mailboxId }) : undefined);

	const INTERVAL_CHOICES = [1, 2, 4, 7, 14];
	const intervalLabel = (days: number) => (days === 1 ? 'once a day' : `once every ${days} days`);
	const shortDate = (ms: number) =>
		new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	const rangeLabel = (startsAt: number | null, endsAt: number | null) =>
		startsAt && endsAt
			? ` · ${shortDate(startsAt)} – ${shortDate(endsAt)}`
			: startsAt
				? ` · from ${shortDate(startsAt)}`
				: endsAt
					? ` · until ${shortDate(endsAt)}`
					: '';

	let drafts = $state<Record<string, Partial<VacationForm>>>({});
	let saving = $state<string | null>(null);

	const toForm = (server: ServerSettings): VacationForm => ({
		enabled: server.enabled,
		subject: server.subject,
		bodyText: server.bodyText,
		startsAt: server.startsAt,
		endsAt: server.endsAt,
		intervalDays: server.intervalDays
	});

	function patch(mailboxId: string, change: Partial<VacationForm>) {
		drafts[mailboxId] = { ...drafts[mailboxId], ...change };
	}

	async function save(mailboxId: string, form: VacationForm) {
		if (saving) return;
		saving = mailboxId;
		try {
			await setVacationSettings({
				mailboxId,
				enabled: form.enabled,
				subject: form.subject,
				bodyText: form.bodyText,
				startsAt: form.startsAt,
				endsAt: form.endsAt,
				intervalDays: form.intervalDays
			});
			delete drafts[mailboxId];
			drafts = { ...drafts };
			await vacationSettings({ mailboxId }).refresh();
			toast.success('Auto-reply settings saved.');
		} catch (err) {
			toast.error(errorMessage(err, 'Could not save the auto-reply.'));
		} finally {
			saving = null;
		}
	}
</script>

<SettingsCollapsibleCard contentClass="flex flex-col gap-6">
	{#snippet title()}
		<PlaneIcon class="size-4" /> Vacation auto-reply
	{/snippet}
	{#snippet summary()}
		{#if summaryQuery?.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else if !summaryQuery.current.enabled}
			Off
		{:else}
			On · {intervalLabel(summaryQuery.current.intervalDays)}{rangeLabel(
				summaryQuery.current.startsAt,
				summaryQuery.current.endsAt
			)}
		{/if}
	{/snippet}
	<Card.CardDescription>
		Automatically answer new mail while you're away. Each sender gets at most one auto-reply
		every few days, so back-and-forth threads aren't flooded.
	</Card.CardDescription>
	<div class="flex flex-col gap-6">
		{#if visible === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-5 w-40 rounded-md" />
				<Skeleton class="h-24 w-full rounded-md" />
			</div>
		{:else if visible.length === 0}
			<p class="text-muted-foreground text-sm">
				{mailboxId ? "You can't send from this mailbox." : "You don't have any sending addresses yet."}
			</p>
		{:else}
			{#each visible as box (box.mailboxId)}
				{@const settingsQuery = vacationSettings({ mailboxId: box.mailboxId })}
				<section
					class="flex flex-col gap-3 border-t pt-6 first:border-t-0 first:pt-0"
					aria-label="Auto-reply for {box.address}"
				>
					{#if settingsQuery.current === undefined}
						<Skeleton class="h-24 w-full rounded-md" />
					{:else}
						{@const form = { ...toForm(settingsQuery.current), ...drafts[box.mailboxId] }}
						{@const dirty = drafts[box.mailboxId] !== undefined}
						{@const busy = saving === box.mailboxId}
						<div class="flex items-center justify-between gap-4">
							<div class="min-w-0">
								{#if !mailboxId}
									<span class="block min-w-0 truncate font-mono text-sm font-medium">{box.address}</span>
								{/if}
								<p class="text-muted-foreground text-xs">Reply automatically to new mail here.</p>
							</div>
							<Switch
								checked={form.enabled}
								onCheckedChange={(value) => patch(box.mailboxId, { enabled: value })}
								aria-label="Auto-reply for {box.address}"
							/>
						</div>
						<!-- Fields disable while the responder is off — the Switch is the one
						     decision that matters; everything else waits until it's on. -->
						<fieldset class="contents" disabled={!form.enabled}>
							<div class="flex flex-col gap-1.5 {form.enabled ? '' : 'opacity-60'}">
								<Label for="vacation-subject-{box.mailboxId}">Subject</Label>
								<Input
									id="vacation-subject-{box.mailboxId}"
									value={form.subject}
									oninput={(event) => patch(box.mailboxId, { subject: event.currentTarget.value })}
									placeholder="Auto: Re: <subject>"
									maxlength={200}
								/>
								<span class="text-muted-foreground text-xs">
									Leave empty to reply with "Auto: Re:" plus the original subject.
								</span>
							</div>
							<div class="flex flex-col gap-1.5 {form.enabled ? '' : 'opacity-60'}">
								<Label for="vacation-body-{box.mailboxId}">Message</Label>
								<Textarea
									id="vacation-body-{box.mailboxId}"
									value={form.bodyText}
									oninput={(event) => patch(box.mailboxId, { bodyText: event.currentTarget.value })}
									placeholder="I'm away and will get back to you when I return…"
									rows={4}
								/>
							</div>
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 {form.enabled ? '' : 'opacity-60'}">
								<div class="flex flex-col gap-1.5">
									<Label for="vacation-starts-{box.mailboxId}">
										Starts <span class="text-muted-foreground font-normal">(optional)</span>
									</Label>
									<WhenPicker
										id="vacation-starts-{box.mailboxId}"
										label="Auto-reply starts"
										value={form.startsAt}
										onChange={(next) => patch(box.mailboxId, { startsAt: next })}
									/>
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="vacation-ends-{box.mailboxId}">
										Ends <span class="text-muted-foreground font-normal">(optional)</span>
									</Label>
									<WhenPicker
										id="vacation-ends-{box.mailboxId}"
										label="Auto-reply ends"
										value={form.endsAt}
										onChange={(next) => patch(box.mailboxId, { endsAt: next })}
									/>
								</div>
							</div>
							<div class="flex flex-col gap-1.5 {form.enabled ? '' : 'opacity-60'}">
								<Label for="vacation-interval-{box.mailboxId}">Reply to each sender at most</Label>
								<Select.Root
									type="single"
									value={String(form.intervalDays)}
									onValueChange={(value) => patch(box.mailboxId, { intervalDays: Number(value) })}
								>
									<Select.Trigger id="vacation-interval-{box.mailboxId}" class="w-full sm:max-w-60">
										<span class="truncate">{intervalLabel(form.intervalDays)}</span>
									</Select.Trigger>
									<Select.Content>
										{#each INTERVAL_CHOICES as days (days)}
											<Select.Item value={String(days)} label={intervalLabel(days)} />
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
						</fieldset>
						<div class="flex items-center justify-end gap-2">
							{#if dirty}
								<span
									class="border-warn/40 text-warn mr-auto inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
								>
									Unsaved
								</span>
							{/if}
							<Button size="sm" disabled={!dirty || busy} onclick={() => save(box.mailboxId, form)}>
								{#if busy}
									<Spinner class="mr-1 size-3.5" /> Saving…
								{:else}
									Save
								{/if}
							</Button>
						</div>
					{/if}
				</section>
			{/each}
		{/if}
	</div>
</SettingsCollapsibleCard>
