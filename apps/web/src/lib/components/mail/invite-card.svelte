<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Themed calendar-invite card. Renders a parsed iMIP invite (see
	// mail-core/calendar.ts) in the app's own surface instead of a raw .ics
	// download. RSVP is LOCAL status (organizer not notified) plus, when the
	// invite carried the provider's own Yes/Maybe/No links, a pass-through to
	// Google/Microsoft's real RSVP flow. Times render in the event's own timezone
	// (honest — matches how Gmail shows them) with the viewer's zone as a hint.
	import type { CalendarInviteDTO, InviteRsvpStatus } from '@doota/mail-core/mail-thread-contract';
	import CalendarCheckIcon from '@lucide/svelte/icons/calendar-check';
	import CalendarXIcon from '@lucide/svelte/icons/calendar-x';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import VideoIcon from '@lucide/svelte/icons/video';
	import UsersIcon from '@lucide/svelte/icons/users';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import HelpCircleIcon from '@lucide/svelte/icons/circle-help';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GlobeIcon from '@lucide/svelte/icons/globe';

	let {
		invite,
		onRsvp
	}: {
		invite: CalendarInviteDTO;
		/** Persist the local status; parent calls setInviteRsvp + patches the DTO. */
		onRsvp: (status: InviteRsvpStatus) => void | Promise<void>;
	} = $props();

	const cancelled = $derived(invite.method === 'CANCEL' || invite.status === 'CANCELLED');

	// The viewer's local timezone label, shown only when it differs from the
	// event's own zone (so "3:00 PM EDT · your time 12:00 PM PDT" only when useful).
	const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	function fmt(ms: number, tz: string | null, allDay: boolean): string {
		const zone = tz ?? 'UTC';
		const opts: Intl.DateTimeFormatOptions = allDay
			? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: zone }
			: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' };
		return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
	}
	// Same-day end → time only; different day → full.
	function fmtEnd(startMs: number, endMs: number, tz: string | null): string {
		const zone = tz ?? 'UTC';
		const sameDay = new Date(startMs).toDateString() === new Date(endMs).toDateString();
		return new Intl.DateTimeFormat(undefined, {
			...(sameDay ? {} : { weekday: 'short', month: 'short', day: 'numeric' }),
			hour: 'numeric',
			minute: '2-digit',
			timeZone: zone,
			timeZoneName: 'short'
		}).format(new Date(endMs));
	}

	const when = $derived(fmt(invite.startMs, invite.tz, invite.allDay));
	const whenEnd = $derived(!invite.allDay && invite.endMs ? fmtEnd(invite.startMs, invite.endMs, invite.tz) : null);
	const isPast = $derived(invite.endMs != null ? invite.endMs < Date.now() : invite.startMs < Date.now());

	// Show the viewer's own timezone time as a hint only when the event zone differs.
	const viewerHint = $derived.by(() => {
		if (invite.allDay || !invite.tz || invite.tz === viewerTz) return null;
		const t = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(invite.startMs));
		return `${t} your time`;
	});

	const ORIGIN_LABEL: Record<string, string> = {
		google: 'Google Calendar',
		microsoft: 'Outlook',
		apple: 'Apple Calendar',
		other: 'Calendar'
	};
	const PLATFORM_LABEL: Record<string, string> = {
		zoom: 'Zoom',
		teams: 'Microsoft Teams',
		meet: 'Google Meet',
		webex: 'Webex'
	};

	const going = $derived(invite.attendees.filter((a) => a.partstat === 'ACCEPTED').length);
	const invited = $derived(invite.attendees.length);

	// RSVP is optimistic: the parent patches invite.myRsvp so the pressed state
	// updates instantly; a failed persist reverts (handled by the parent's toast).
	let busy = $state<InviteRsvpStatus | null>(null);
	async function pick(status: InviteRsvpStatus) {
		if (busy) return;
		busy = status;
		try {
			await onRsvp(status);
		} finally {
			busy = null;
		}
	}

	const RSVP: { key: InviteRsvpStatus; label: string; icon: typeof CheckIcon }[] = [
		{ key: 'accepted', label: 'Yes', icon: CheckIcon },
		{ key: 'tentative', label: 'Maybe', icon: HelpCircleIcon },
		{ key: 'declined', label: 'No', icon: XIcon }
	];
	// A provider RSVP link exists for this answer → open the real flow instead of
	// (only) recording local status.
	function providerLink(key: InviteRsvpStatus): string | null {
		return invite.rsvpLinks[key] ?? null;
	}

	// Download the event as .ics for "add to my calendar" (re-serialise the fields
	// we kept — enough for every calendar app to import).
	function icsHref(): string {
		const dt = (ms: number, allDay: boolean) => {
			const d = new Date(ms);
			const p = (n: number) => String(n).padStart(2, '0');
			return allDay
				? `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
				: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
		};
		const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
		const lines = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//Doota//Invite//EN',
			'BEGIN:VEVENT',
			`UID:${invite.uid}`,
			`DTSTART:${dt(invite.startMs, invite.allDay)}`,
			...(invite.endMs ? [`DTEND:${dt(invite.endMs, invite.allDay)}`] : []),
			...(invite.summary ? [`SUMMARY:${esc(invite.summary)}`] : []),
			...(invite.location ? [`LOCATION:${esc(invite.location)}`] : []),
			...(invite.organizer.email ? [`ORGANIZER:mailto:${invite.organizer.email}`] : []),
			'END:VEVENT',
			'END:VCALENDAR'
		];
		return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
	}
</script>

<!-- GlobeChip snippet removed — using lucide GlobeIcon inline. -->

<div class="border-border bg-card overflow-hidden rounded-2xl border shadow-xs">
	<!-- Header: accent rail + title + source badges. Cancelled invites read muted
	     with a struck title so a stale REQUEST above it isn't mistaken for live. -->
	<div class="flex items-start gap-3 border-b p-3.5 {cancelled ? 'bg-muted/40' : 'bg-brand/5'}">
		<div class="grid size-10 shrink-0 place-items-center rounded-xl {cancelled ? 'bg-muted text-muted-foreground' : 'bg-brand/15 text-brand'}">
			{#if cancelled}<CalendarXIcon class="size-5" />{:else}<CalendarCheckIcon class="size-5" />{/if}
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span class="text-[11px] font-medium tracking-wide uppercase {cancelled ? 'text-muted-foreground' : 'text-brand'}">
					{cancelled ? 'Event cancelled' : invite.method === 'REPLY' ? 'RSVP' : 'Invitation'}
				</span>
				{#if invite.calOrigin}
					<span class="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
						<GlobeIcon class="size-3" />{ORIGIN_LABEL[invite.calOrigin]}
					</span>
				{/if}
				{#if invite.meetingPlatform}
					<span class="bg-brand/10 text-brand inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
						<VideoIcon class="size-3" />{PLATFORM_LABEL[invite.meetingPlatform]}
					</span>
				{/if}
			</div>
			<h3 class="text-foreground mt-0.5 truncate text-sm font-semibold {cancelled ? 'text-muted-foreground line-through' : ''}">
				{invite.summary || '(no title)'}
			</h3>
		</div>
	</div>

	<div class="space-y-2.5 p-3.5 text-sm">
		<!-- When -->
		<div class="flex items-start gap-2.5">
			<ClockIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
			<div class="min-w-0">
				<div class="text-foreground {isPast && !cancelled ? 'text-muted-foreground' : ''}">
					{when}{#if whenEnd}<span class="text-muted-foreground"> – {whenEnd}</span>{/if}
				</div>
				{#if viewerHint}<div class="text-faint text-xs">{viewerHint}</div>{/if}
				{#if isPast && !cancelled}<div class="text-faint text-xs">This event has ended.</div>{/if}
			</div>
		</div>

		<!-- Where / join -->
		{#if invite.joinUrl}
			<div class="flex items-center gap-2.5">
				<VideoIcon class="text-muted-foreground size-4 shrink-0" />
				<a href={invite.joinUrl} target="_blank" rel="noopener noreferrer" class="text-brand inline-flex items-center gap-1 truncate font-medium hover:underline">
					Join {invite.meetingPlatform ? PLATFORM_LABEL[invite.meetingPlatform] : 'meeting'}<ExternalLinkIcon class="size-3 shrink-0" />
				</a>
			</div>
		{:else if invite.location}
			<div class="flex items-start gap-2.5">
				<MapPinIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
				<span class="text-foreground min-w-0 break-words">{invite.location}</span>
			</div>
		{/if}

		<!-- Who -->
		{#if invited > 0}
			<div class="flex items-start gap-2.5">
				<UsersIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
				<div class="text-muted-foreground min-w-0 text-xs">
					<span class="text-foreground">{going} going</span> · {invited} invited
					{#if invite.organizer.email}<span class="block truncate">Organized by {invite.organizer.name || invite.organizer.email}</span>{/if}
				</div>
			</div>
		{/if}

		{#if invite.description}
			<p class="text-muted-foreground border-t pt-2.5 text-xs whitespace-pre-line">{invite.description}</p>
		{/if}
	</div>

	<!-- RSVP + add-to-calendar. Hidden for cancellations (nothing to respond to). -->
	{#if !cancelled}
		<div class="flex flex-wrap items-center gap-2 border-t p-3">
			<div role="group" aria-label="RSVP" class="border-border bg-muted flex items-center gap-1 rounded-lg border p-1">
				{#each RSVP as opt (opt.key)}
					{@const Icon = opt.icon}
					{@const active = invite.myRsvp === opt.key}
					{@const link = providerLink(opt.key)}
					{#if link}
						<!-- Real provider RSVP (updates the organizer). Still record local
						     status so the pressed state persists across reloads. -->
						<a
							href={link}
							target="_blank"
							rel="noopener noreferrer"
							onclick={() => pick(opt.key)}
							aria-current={active ? 'true' : undefined}
							class="focus-visible:ring-ring flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 {active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
						>
							<Icon class="size-3.5" />{opt.label}
						</a>
					{:else}
						<button
							type="button"
							onclick={() => pick(opt.key)}
							aria-pressed={active}
							disabled={busy !== null}
							class="focus-visible:ring-ring flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 disabled:opacity-60 {active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
						>
							<Icon class="size-3.5" />{opt.label}
						</button>
					{/if}
				{/each}
			</div>
			{#if invite.myRsvp && !Object.values(invite.rsvpLinks).some(Boolean)}
				<span class="text-faint text-[11px]">Saved for you — the organizer isn't notified.</span>
			{/if}
			<a href={icsHref()} download={`${(invite.summary || 'event').replace(/[^\w.-]+/g, '-')}.ics`} class="text-muted-foreground hover:text-foreground ml-auto text-xs font-medium hover:underline">
				Add to calendar
			</a>
		</div>
	{/if}
</div>
