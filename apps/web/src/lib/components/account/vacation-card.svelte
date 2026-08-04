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
	import { myMailboxSignatures } from '$lib/rpc/signature.remote';
	import { vacationSettings, setVacationSettings } from '$lib/rpc/vacation.remote';
	import { toLocalDatetime } from '$lib/utils/parse-when';

	// The form as edited; startsAt/endsAt are datetime-local strings ('' = unset).
	type VacationForm = {
		enabled: boolean;
		subject: string;
		bodyText: string;
		startsAt: string;
		endsAt: string;
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

	const mailboxes = myMailboxSignatures();

	const INTERVAL_CHOICES = [1, 2, 4, 7, 14];
	const intervalLabel = (days: number) => (days === 1 ? 'once a day' : `once every ${days} days`);

	let drafts = $state<Record<string, Partial<VacationForm>>>({});
	let saving = $state<string | null>(null);

	const toForm = (server: ServerSettings): VacationForm => ({
		enabled: server.enabled,
		subject: server.subject,
		bodyText: server.bodyText,
		startsAt: server.startsAt ? toLocalDatetime(new Date(server.startsAt)) : '',
		endsAt: server.endsAt ? toLocalDatetime(new Date(server.endsAt)) : '',
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
				startsAt: form.startsAt ? new Date(form.startsAt).getTime() : null,
				endsAt: form.endsAt ? new Date(form.endsAt).getTime() : null,
				intervalDays: form.intervalDays
			});
			delete drafts[mailboxId];
			drafts = { ...drafts };
			await vacationSettings({ mailboxId }).refresh();
			toast.success('Auto-reply settings saved.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save the auto-reply.');
		} finally {
			saving = null;
		}
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<PlaneIcon class="size-4" /> Vacation auto-reply
		</Card.CardTitle>
		<Card.CardDescription>
			Automatically answer new mail while you're away. Each sender gets at most one auto-reply
			every few days, so back-and-forth threads aren't flooded.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-6">
		{#if mailboxes.current === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-5 w-40 rounded-md" />
				<Skeleton class="h-24 w-full rounded-md" />
			</div>
		{:else if mailboxes.current.length === 0}
			<p class="text-muted-foreground text-sm">You don't have any sending addresses yet.</p>
		{:else}
			{#each mailboxes.current as box (box.mailboxId)}
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
								<span class="block min-w-0 truncate font-mono text-sm font-medium">{box.address}</span>
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
									<Input
										id="vacation-starts-{box.mailboxId}"
										type="datetime-local"
										value={form.startsAt}
										onchange={(event) => patch(box.mailboxId, { startsAt: event.currentTarget.value })}
									/>
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="vacation-ends-{box.mailboxId}">
										Ends <span class="text-muted-foreground font-normal">(optional)</span>
									</Label>
									<Input
										id="vacation-ends-{box.mailboxId}"
										type="datetime-local"
										value={form.endsAt}
										onchange={(event) => patch(box.mailboxId, { endsAt: event.currentTarget.value })}
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
	</Card.CardContent>
</Card.Card>
