<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Hallmark · component: compose page · genre: inherited app system · theme: app tokens
	// states: editing · sending · saved · uploading · disabled-send · confirm-no-subject
	//
	// The MOBILE composer — a real document-flow page, not an overlay. That is
	// the whole design: on a normal page, iOS scrolling to a focused input is
	// correct behavior, the keyboard needs no JS math, and the back gesture is
	// native. Send lives in the sticky header (the Gmail-iOS shape), so nothing
	// has to sit pinned above the keyboard. All compose behavior comes from
	// ComposeSession (shared with the desktop panel).
	import { onMount } from 'svelte';
	import { replaceState, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { watch } from 'runed';
	import { fmtSize } from '$lib/mail/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import FromSelector from '$lib/components/mail/from-selector.svelte';
	import RecipientInput from '$lib/components/mail/recipient-input.svelte';
	import TiptapEditor from '$lib/components/mail/tiptap-editor.svelte';
	import SchedulePicker from '$lib/components/mail/schedule-picker.svelte';
	import MailFrame from '$lib/components/mail/mail-frame.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import SendIcon from '@lucide/svelte/icons/send';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { compose } from '$lib/client/compose.svelte.js';
	import {
		ComposeSession,
		presetTomorrow,
		presetMonday
	} from '$lib/components/mail/compose-session.svelte.js';

	// Entry state: compose.start() populated the store right before routing here.
	// A refresh loses the store — the ?draft= param (written below once a draft
	// row exists) resumes it instead. Read once at init.
	const urlDraft = page.url.searchParams.get('draft') ?? undefined;
	const entry = {
		prefill: compose.prefill,
		resumeDraftId: compose.resumeDraftId ?? urlDraft,
		scheduleAtMs: compose.scheduleAt
	};

	function leave() {
		// Prefer the back gesture's semantics; direct/refresh entries have no
		// in-app history, so fall back to the inbox.
		if (history.length > 1) history.back();
		else void goto(resolve('/app'));
	}

	const session = new ComposeSession({
		prefill: entry.prefill,
		resumeDraftId: entry.resumeDraftId,
		scheduleAtMs: entry.scheduleAtMs,
		requestClose: leave,
		// A failed empty send can't "reopen" a page we never left — no-op.
		requestReopen: () => {}
	});
	onMount(() => void session.init());

	// Once the draft row exists, stamp it into the URL (replace, no history spam)
	// so a refresh mid-compose resumes this exact draft.
	watch(
		() => session.draftId,
		(id) => {
			if (!id || page.url.searchParams.get('draft') === id) return;
			const url = new URL(page.url);
			url.searchParams.set('draft', id);
			replaceState(url, page.state);
		}
	);

	let fileInput = $state<HTMLInputElement>();
	function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		void session.uploadFiles(files);
	}

	// Forward preview starts collapsed — the page stays light; expand on demand.
	let showForwarded = $state(false);
</script>

<svelte:window onkeydown={(e) => session.handleSendShortcut(e)} />
<!-- Tab going hidden is the last reliable moment to reach the network. -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void session.flushSave();
	}}
/>

<AlertDialog.Root bind:open={session.confirmNoSubject}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Send without a subject?</AlertDialog.Title>
			<AlertDialog.Description>This message has no subject line.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Add subject</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => session.send(true)}>Send anyway</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<div class="mx-auto flex w-full max-w-2xl flex-col">
	<!-- Sticky header: ✕ · title/state · overflow · SEND. The one bar that never
	     moves — everything below is ordinary page flow the keyboard can cover. -->
	<div class="bg-background/95 sticky top-0 z-10 flex h-12 items-center gap-1 border-b px-2 backdrop-blur">
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 grid size-10 shrink-0 place-items-center rounded-lg outline-none focus-visible:ring-2"
			aria-label="Close (keeps draft)"
			onclick={session.close}
		>
			<XIcon class="size-5" />
		</button>
		<div class="min-w-0 flex-1">
			<p class="font-heading truncate text-sm font-semibold">{session.title}</p>
			{#if session.uploading}
				<p class="text-muted-foreground text-[11px]">Uploading…</p>
			{:else if session.saved && session.draftId}
				<p class="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
					<CheckIcon class="text-ok size-3" /> Draft saved
				</p>
			{:else if session.scheduleAt}
				<p class="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
					<ClockIcon class="size-3" /> Scheduled
				</p>
			{/if}
		</div>
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 grid size-10 shrink-0 place-items-center rounded-lg outline-none focus-visible:ring-2"
			aria-label="Attach files"
			onclick={() => fileInput?.click()}
		>
			<PaperclipIcon class="size-5" />
		</button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 grid size-10 shrink-0 place-items-center rounded-lg outline-none focus-visible:ring-2"
				aria-label="More options"
			>
				<EllipsisVerticalIcon class="size-5" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				<DropdownMenu.Label class="text-muted-foreground text-xs">Send later</DropdownMenu.Label>
				<DropdownMenu.Item onSelect={() => session.armSchedule(presetTomorrow())}>Tomorrow, 8:00 AM</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => session.armSchedule(presetMonday())}>Monday, 8:00 AM</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => (session.schedulePickerOpen = true)}>Pick date &amp; time…</DropdownMenu.Item>
				{#if session.scheduleAt}
					<DropdownMenu.Item onSelect={session.clearSchedule}>Send now instead</DropdownMenu.Item>
				{/if}
				<DropdownMenu.Separator />
				<DropdownMenu.Item class="text-destructive" onSelect={() => void session.discard()}>
					<Trash2Icon class="size-4" /> Discard draft
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<Button
			variant="brand"
			size="sm"
			class="ml-1 gap-1.5"
			disabled={!session.canSend || session.phase === 'sending'}
			title={session.sendHint}
			onclick={() => session.send()}
		>
			{#if session.phase === 'sending'}
				<Spinner class="size-4" />
			{:else}
				<SendIcon class="size-4" />
			{/if}
			{session.scheduleAt ? 'Schedule' : 'Send'}
		</Button>
	</div>

	<!-- The form: plain document flow. The page scrolls; the keyboard covers the
	     bottom like on any web form, and iOS reveals the caret natively. -->
	<div class="flex flex-col gap-2 px-3 pt-3 pb-[max(env(safe-area-inset-bottom),1rem)]">
		<div class="flex items-center gap-2">
			<span class="text-muted-foreground w-10 shrink-0 text-xs">From</span>
			<FromSelector identities={session.identities} bind:mailboxId={session.mailboxId} bind:aliasId={session.aliasId} />
		</div>
		<div class="flex items-start gap-2">
			<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">To</span>
			<div class="min-w-0 flex-1"><RecipientInput bind:value={session.to} onchange={session.scheduleSave} /></div>
			<div class="flex shrink-0 items-center gap-1.5 pt-2 text-xs font-medium">
				{#if !session.showCc}
					<button type="button" class="text-muted-foreground hover:text-brand" onclick={() => (session.showCc = true)}>Cc</button>
				{/if}
				{#if !session.showBcc}
					<button type="button" class="text-muted-foreground hover:text-brand" onclick={() => (session.showBcc = true)}>Bcc</button>
				{/if}
			</div>
		</div>
		{#if session.showCc}
			<div class="flex items-start gap-2">
				<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">Cc</span>
				<div class="min-w-0 flex-1"><RecipientInput bind:value={session.cc} onchange={session.scheduleSave} /></div>
				<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 pt-2" title="Remove Cc" onclick={() => { session.showCc = false; session.cc = []; session.scheduleSave(); }}>
					<XIcon class="size-3.5" />
				</button>
			</div>
		{/if}
		{#if session.showBcc}
			<div class="flex items-start gap-2">
				<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">Bcc</span>
				<div class="min-w-0 flex-1"><RecipientInput bind:value={session.bcc} onchange={session.scheduleSave} /></div>
				<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 pt-2" title="Remove Bcc" onclick={() => { session.showBcc = false; session.bcc = []; session.scheduleSave(); }}>
					<XIcon class="size-3.5" />
				</button>
			</div>
		{/if}

		<div class="flex items-center gap-2">
			<Input
				class="h-9 min-w-0 flex-1"
				placeholder="Subject"
				aria-label="Subject"
				bind:value={session.subject}
				oninput={session.scheduleSave}
				onblur={session.flushSave}
			/>
			<!-- The schedule chip (shows the armed time; opens the picker). -->
			<SchedulePicker bind:value={session.scheduleAt} bind:open={session.schedulePickerOpen} />
		</div>

		<!-- Auto-grow editor (no `fill`): it grows with the text and the PAGE
		     scrolls — an inner scroller here would fight iOS caret-reveal. -->
		{#key session.editorKey}
			<TiptapEditor
				focusStart
				initial={session.body}
				oninput={(html) => {
					session.body = html;
					session.scheduleSave();
				}}
				onattach={() => fileInput?.click()}
				onsend={() => session.send()}
			/>
		{/key}

		{#if session.attachments.length}
			<div class="flex flex-wrap gap-2">
				{#each session.attachments as attachment (attachment.r2Key)}
					<span class="bg-muted flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
						<PaperclipIcon class="text-muted-foreground size-3" />
						<span class="max-w-[16ch] truncate">{attachment.filename}</span>
						<span class="text-faint">{fmtSize(attachment.size)}</span>
						<button type="button" aria-label="Remove attachment" class="text-muted-foreground hover:text-foreground" onclick={() => session.removeAttachment(attachment.r2Key)}>
							<XIcon class="size-3" />
						</button>
					</span>
				{/each}
			</div>
		{/if}

		{#if session.forwardMessageIds.length}
			<!-- Collapsed by default: the page stays light; the originals send with
			     full formatting either way (composed server-side from R2). -->
			<div class="rounded-md border">
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground flex w-full items-center justify-between gap-2 px-3 py-2 text-xs"
					onclick={() => (showForwarded = !showForwarded)}
				>
					<span>
						Forwarding {session.forwardMessageIds.length}
						{session.forwardMessageIds.length === 1 ? 'message' : 'messages'} · original formatting kept
					</span>
					<ChevronDownIcon class="size-4 transition-transform {showForwarded ? 'rotate-180' : ''}" />
				</button>
				{#if showForwarded}
					<div class="flex flex-col gap-2 border-t p-2">
						{#each session.forwardMessageIds as messageId (messageId)}
							<MailFrame src={`/api/messages/${messageId}/body`} collapse fadeClass="from-background" />
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
