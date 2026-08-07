<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Themed calendar-invite card. Renders a parsed iMIP invite (see
	// mail-core/calendar.ts) in the app's own surface instead of a raw .ics
	// download. RSVP is LOCAL status (organizer not notified) plus, when the
	// invite carried the provider's own Yes/Maybe/No links, a pass-through to
	// Google/Microsoft's real RSVP flow. Times render in the VIEWER's local zone;
	// the organizer's original timezone is a tap-away (Popover on the time line).
	import type { CalendarInviteDTO, InviteRsvpStatus } from '@doota/mail-core/mail-thread-contract';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import VideoIcon from '@lucide/svelte/icons/video';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import HelpCircleIcon from '@lucide/svelte/icons/circle-help';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import CalendarPlusIcon from '@lucide/svelte/icons/calendar-plus';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { linkifySegments } from '$lib/utils/linkify.js';

	let {
		invite,
		originalHref = null,
		flat = false,
		onRsvp
	}: {
		invite: CalendarInviteDTO;
		originalHref?: string | null;
		/** Drop the card's own border/radius/shadow so it fills the message card
		 * flush (one card + one radius, not a nested box). */
		flat?: boolean;
		onRsvp: (status: InviteRsvpStatus) => void | Promise<void>;
	} = $props();

	// `cancelled` is resolved server-side across the thread (a later CANCEL
	// supersedes an earlier REQUEST); fall back to the raw method/status.
	const cancelled = $derived(
		invite.cancelled || invite.method === 'CANCEL' || invite.status === 'CANCELLED'
	);
	// A REPLY is someone else's RSVP notification (e.g. "X accepted") — the viewer
	// can't RSVP to a reply, so the Yes/Maybe/No row is suppressed (Join + calendar
	// actions stay). The eyebrow already reads "RSVP" to signal the card's nature.
	const isReply = $derived(invite.method === 'REPLY');

	const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	// Everything renders in the VIEWER's local zone (their perspective) — the
	// organizer's original timezone is a tap-away (origLine). All-day
	// events are tz-agnostic, so their wall date is shown in UTC (undefined tz =
	// viewer local for timed events; 'UTC' pins the all-day date).
	const dispTz = $derived<string | undefined>(invite.allDay ? 'UTC' : undefined);
	const part = (ms: number, opts: Intl.DateTimeFormatOptions, tz?: string) =>
		new Intl.DateTimeFormat(undefined, { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(new Date(ms));

	// Tear-off calendar chip — month tab over the day number, in the viewer's zone.
	const chip = $derived({
		month: part(invite.startMs, { month: 'short' }, dispTz).toUpperCase(),
		day: part(invite.startMs, { day: 'numeric' }, dispTz)
	});
	// Chip carries month + day, so the text line only needs weekday + time.
	const weekdayShort = $derived(part(invite.startMs, { weekday: 'short' }, dispTz));
	const eventYear = $derived(part(invite.startMs, { year: 'numeric' }, dispTz));
	const showYear = $derived(eventYear !== String(new Date().getFullYear()));

	const tzLabel = (tz?: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz ?? viewerTz, timeZoneName: 'short' })
			.formatToParts(new Date(invite.startMs))
			.find((tzPart) => tzPart.type === 'timeZoneName')?.value ?? '';
	const timeRange = (tz?: string) => {
		const fmt = (ms: number) => part(ms, { hour: 'numeric', minute: '2-digit' }, tz);
		return invite.endMs ? `${fmt(invite.startMs)} – ${fmt(invite.endMs)} ${tzLabel(tz)}` : `${fmt(invite.startMs)} ${tzLabel(tz)}`;
	};
	const timeLine = $derived(invite.allDay ? 'All day' : timeRange(undefined));
	// The organizer's original timezone rendering — for the tap-popover, only when
	// it differs from the viewer's (and the event is timed).
	const origLine = $derived.by(() => {
		if (invite.allDay || !invite.tz || invite.tz === viewerTz) return null;
		const d = part(invite.startMs, { weekday: 'short', month: 'short', day: 'numeric' }, invite.tz);
		return `${d} · ${timeRange(invite.tz)}`;
	});
	const isPast = $derived(invite.endMs != null ? invite.endMs < Date.now() : invite.startMs < Date.now());

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
	// Each provider's official signature colour — recognition by hue, no
	// trademarked logo art (those aren't cleanly available and are legally
	// fussy). Brand constants, not palette tokens; applied only to the small
	// glyph so the card stays on-theme. null = no tint (use current colour).
	const ORIGIN_HUE: Record<string, string | null> = {
		google: '#4285F4',
		microsoft: '#0078D4',
		apple: null,
		other: null
	};
	const PLATFORM_HUE: Record<string, string> = {
		zoom: '#2D8CFF',
		teams: '#6264A7',
		meet: '#00AC47',
		webex: '#00BCEB'
	};

	const going = $derived(invite.attendees.filter((attendee) => attendee.partstat === 'ACCEPTED').length);
	const invited = $derived(invite.attendees.length);

	// Full guest list for the popover: attendees, plus the organizer prepended
	// when they aren't already listed (they always count as going).
	type Guest = { email: string; name: string | null; partstat: string | null };
	const roster = $derived.by<Guest[]>(() => {
		const list: Guest[] = [...invite.attendees];
		const org = invite.organizer.email;
		if (org && !list.some((guest) => guest.email.toLowerCase() === org.toLowerCase())) {
			list.unshift({ email: org, name: invite.organizer.name, partstat: 'ACCEPTED' });
		}
		return list;
	});
	const isOrganizer = (email: string) =>
		!!invite.organizer.email && email.toLowerCase() === invite.organizer.email.toLowerCase();
	function initials(guest: Guest): string {
		const n = (guest.name || guest.email || '?').trim();
		const parts = n.split(/\s+/).filter(Boolean);
		return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : n.slice(0, 2)).toUpperCase();
	}
	const STATUS: Record<string, { label: string; cls: string }> = {
		ACCEPTED: { label: 'Going', cls: 'text-ok' },
		DECLINED: { label: 'Declined', cls: 'text-destructive' },
		TENTATIVE: { label: 'Maybe', cls: 'text-warn' }
	};
	const statusMeta = (partstat: string | null) =>
		STATUS[(partstat ?? '').toUpperCase()] ?? { label: 'No response', cls: 'text-muted-foreground' };

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

	// Selected answer carries meaning through colour: Yes → ok, Maybe → warn,
	// No → destructive (not a neutral grey pressed-state).
	const RSVP: { key: InviteRsvpStatus; label: string; icon: typeof CheckIcon; active: string }[] = [
		{ key: 'accepted', label: 'Yes', icon: CheckIcon, active: 'bg-ok/15 text-ok ring-1 ring-ok/25' },
		{ key: 'tentative', label: 'Maybe', icon: HelpCircleIcon, active: 'bg-warn/15 text-warn ring-1 ring-warn/25' },
		{ key: 'declined', label: 'No', icon: XIcon, active: 'bg-destructive/15 text-destructive ring-1 ring-destructive/25' }
	];
	// A provider RSVP link exists for this answer → open the real flow instead of
	// (only) recording local status.
	function providerLink(key: InviteRsvpStatus): string | null {
		return invite.rsvpLinks[key] ?? null;
	}

	// Outlook/Teams write description links as `Label<https://url>` (RFC5545
	// text with the URL in angle brackets). Rendered raw that reads like broken
	// markdown, so fold each `Label<url>` into a real link (label as the text),
	// and run the plain runs between them through the shared linkify grammar.
	type Seg = { type: 'text'; value: string } | { type: 'link'; value: string; href: string } | { type: 'email'; value: string; address: string };
	function descSegments(desc: string): Seg[] {
		// Greedy label = the non-delimiter run right before `<url>` (stops at a
		// newline / pipe so it never swallows a whole paragraph).
		const RE = /([^\n|<>]*)<(https?:\/\/[^>\s]+)>/g;
		const out: Seg[] = [];
		let last = 0;
		for (const match of desc.matchAll(RE)) {
			// Inter-match text (newlines/pipes/plain runs) → shared linkify.
			const before = desc.slice(last, match.index);
			if (before) out.push(...(linkifySegments(before) as Seg[]));
			const label = match[1].trim();
			out.push({ type: 'link', value: label || match[2], href: match[2] });
			last = match.index + match[0].length;
		}
		if (last < desc.length) out.push(...(linkifySegments(desc.slice(last)) as Seg[]));
		return out.length ? out : (linkifySegments(desc) as Seg[]);
	}

	// Google (and others) append a fenced machine block to DESCRIPTION — Meet
	// links, dial-in, "please do not edit", wrapped in `-::~:~::-` rules. Split
	// the human text (before the fence) from that block so the card shows what a
	// person typed, and tucks the boilerplate behind a "Meeting details"
	// disclosure. Runs client-side so it also tidies already-stored invites.
	// Divider rules: Google `-::~:~::-`, Teams/Zoom `________`. Plus a keyword
	// fallback for providers that emit no divider at all (join info inline).
	const FENCE = /[-~:_]{6,}/;
	const BOILERPLATE = /^(join zoom meeting|microsoft teams meeting|join on your computer|join with google meet)/i;
	const descParts = $derived.by(() => {
		const raw = invite.description;
		if (!raw) return { text: null as string | null, details: null as string | null };
		const lines = raw.split('\n');
		const at = lines.findIndex((line) => {
			const t = line.trim();
			return FENCE.test(t) || BOILERPLATE.test(t);
		});
		if (at === -1) return { text: raw.trim() || null, details: null };
		const text = lines.slice(0, at).join('\n').trim();
		const details = lines
			.slice(at)
			.filter((line) => !FENCE.test(line.trim()) && !/please do not edit/i.test(line))
			.join('\n')
			.trim();
		return { text: text || null, details: details || null };
	});

	// webcal:// opens the OS calendar app to add the event (vs a .ics file
	// download). Needs a real fetchable URL, so only the ORIGINAL attachment
	// qualifies; the re-serialised data: URI can't be webcal (download only).
	const webcalHref = $derived.by(() => {
		if (!originalHref || typeof window === 'undefined') return null;
		return `webcal://${window.location.host}${originalHref}`;
	});

	// Download the event as .ics for "add to my calendar" (re-serialise the fields
	// we kept — enough for every calendar app to import).
	function icsHref(): string {
		const dt = (ms: number, allDay: boolean) => {
			const d = new Date(ms);
			const pad = (n: number) => String(n).padStart(2, '0');
			return allDay
				? `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
				: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
		};
		const esc = (str: string) => str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
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

<div class="overflow-hidden {flat ? '' : 'border-border bg-card rounded-2xl border shadow-xs'}">
	<!-- Header: tear-off date chip anchors the invite; title wraps (it's the
	     headline); date + time promoted right under it. Cancelled reads muted
	     with a struck title so a stale REQUEST isn't mistaken for live. -->
	<div class="flex items-start gap-3.5 border-b p-3.5 {cancelled ? 'bg-muted/40' : 'bg-brand/5'}">
		<!-- Date chip: the invite's anchor, sized to carry the header (month tab +
		     big day number), not a stamp in the corner. -->
		<div class="border-border/70 w-14 shrink-0 overflow-hidden rounded-xl border text-center leading-none shadow-xs {cancelled ? 'opacity-60' : ''}">
			<div class="py-1 text-[10px] font-bold tracking-widest uppercase {cancelled ? 'bg-muted text-muted-foreground' : 'bg-brand text-brand-foreground'}">
				{chip.month}
			</div>
			<div class="bg-card text-foreground py-2 text-2xl font-bold tabular-nums">{chip.day}</div>
		</div>
		<div class="min-w-0 flex-1">
			<!-- Eyebrow (accent) + provider marks: brand-hued glyphs make the source
			     recognizable at a glance. Origin is quiet; the platform keeps a badge. -->
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
				<span class="font-medium tracking-wide uppercase {cancelled ? 'text-muted-foreground' : 'text-brand'}">
					{cancelled ? 'Event cancelled' : invite.method === 'REPLY' ? 'RSVP' : 'Invitation'}
				</span>
				{#if invite.calOrigin}
					<span class="text-muted-foreground inline-flex items-center gap-1">
						<CalendarIcon class="size-3" style={ORIGIN_HUE[invite.calOrigin] ? `color:${ORIGIN_HUE[invite.calOrigin]}` : ''} />
						{ORIGIN_LABEL[invite.calOrigin]}
					</span>
				{/if}
				{#if invite.meetingPlatform}
					<span class="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
						<VideoIcon class="size-3" style={`color:${PLATFORM_HUE[invite.meetingPlatform]}`} />{PLATFORM_LABEL[invite.meetingPlatform]}
					</span>
				{/if}
			</div>
			<h3 class="text-foreground mt-1 line-clamp-2 text-base leading-snug font-semibold {cancelled ? 'text-muted-foreground line-through' : ''}">
				{invite.summary || '(no title)'}
			</h3>
			<!-- One when-line: weekday (chip carries month/day) + time; year only when
			     not the current one; past events get a muted "Ended" pill inline. -->
			<div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				{#if origLine}
					<!-- Viewer-local time is primary; tap/click reveals the organizer's own
					     zone (Popover works on touch + mouse, unlike a hover tooltip). -->
					<Popover.Root>
						<Popover.Trigger class="focus-visible:ring-ring decoration-muted-foreground/40 rounded font-medium underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 {isPast && !cancelled ? 'text-muted-foreground' : 'text-foreground'}">
							{weekdayShort} · {timeLine}{#if showYear} · {eventYear}{/if}
						</Popover.Trigger>
						<Popover.Content align="start" class="w-auto max-w-[16rem] p-2.5 text-xs">
							<span class="text-muted-foreground block text-[11px] font-medium tracking-wide uppercase">Organizer's time</span>
							<span class="text-foreground mt-0.5 block">{origLine}</span>
						</Popover.Content>
					</Popover.Root>
				{:else}
					<span class="{isPast && !cancelled ? 'text-muted-foreground' : 'text-foreground'} font-medium">
						{weekdayShort} · {timeLine}{#if showYear} · {eventYear}{/if}
					</span>
				{/if}
				{#if isPast && !cancelled}<span class="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">Ended</span>{/if}
			</div>
		</div>
	</div>

	{#if (invite.location && !invite.joinUrl) || roster.length || invite.description}
		<div class="space-y-2.5 p-3.5 text-sm">
			<!-- Physical location only — a meeting link becomes the Join button below. -->
			{#if invite.location && !invite.joinUrl}
				<div class="flex items-start gap-2.5">
					<MapPinIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
					<span class="text-foreground min-w-0 break-words">{invite.location}</span>
				</div>
			{/if}

			{#if roster.length}
				<!-- Avatar stack → click/tap opens the full guest list with RSVP status. -->
				<Popover.Root>
					<Popover.Trigger class="hover:bg-muted/50 focus-visible:ring-ring -mx-1 flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left transition-colors outline-none focus-visible:ring-2">
						<span class="flex shrink-0 -space-x-2">
							{#each roster.slice(0, 5) as guest (guest.email)}
								<span class="border-card bg-muted text-muted-foreground grid size-6 place-items-center rounded-full border-2 text-[9px] font-semibold">{initials(guest)}</span>
							{/each}
							{#if roster.length > 5}
								<span class="border-card bg-muted text-muted-foreground grid size-6 place-items-center rounded-full border-2 text-[9px] font-semibold">+{roster.length - 5}</span>
							{/if}
						</span>
						<span class="min-w-0 flex-1 text-xs">
							<span class="text-foreground"><span class="text-ok">{going}</span> going</span> · {invited} invited
							{#if invite.organizer.email}<span class="text-muted-foreground block truncate">Organized by {invite.organizer.name || invite.organizer.email}</span>{/if}
						</span>
					</Popover.Trigger>
					<Popover.Content align="start" class="w-64 p-0">
						<div class="text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">Guests · {invited}</div>
						<div class="max-h-64 overflow-y-auto py-1">
							{#each roster as guest (guest.email)}
								{@const status = statusMeta(guest.partstat)}
								<div class="flex items-center gap-2.5 px-3 py-1.5">
									<span class="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold">{initials(guest)}</span>
									<span class="min-w-0 flex-1">
										<span class="text-foreground block truncate text-xs font-medium">{guest.name || guest.email}</span>
										{#if guest.name}<span class="text-faint block truncate text-[11px]">{guest.email}</span>{/if}
									</span>
									<span class="shrink-0 text-[11px] font-medium {isOrganizer(guest.email) ? 'text-muted-foreground' : status.cls}">{isOrganizer(guest.email) ? 'Organizer' : status.label}</span>
								</div>
							{/each}
						</div>
					</Popover.Content>
				</Popover.Root>
			{/if}

			{#if descParts.text || descParts.details}
				<div class="text-muted-foreground border-t pt-2.5 text-xs">
					{#if descParts.text}<p class="whitespace-pre-line">{@render descText(descParts.text)}</p>{/if}
					{#if descParts.details}
						<!-- Machine boilerplate (dial-in, "learn more") tucked away; native details. -->
						<details class="group mt-2">
							<summary class="hover:text-foreground flex cursor-pointer list-none items-center gap-1 font-medium select-none [&::-webkit-details-marker]:hidden">
								<ChevronRightIcon class="size-3 transition-transform group-open:rotate-90" /> Meeting details
							</summary>
							<p class="mt-1.5 whitespace-pre-line">{@render descText(descParts.details)}</p>
						</details>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Actions. Hidden for cancellations (nothing to respond to / join). -->
	{#if !cancelled}
		<div class="space-y-2.5 border-t p-3">
			<!-- Full-width segmented pill: the three answers split the row evenly; the
			     selected segment fills as a coloured pill (Yes/Maybe/No). Shown ONLY
			     when the viewer is an attendee with a valid organizer to reply to
			     (server-gated, canRsvp); otherwise a quiet reason. Hidden on a REPLY. -->
			{#if invite.canRsvp}
			<div role="group" aria-label="RSVP" class="border-border bg-muted flex w-full items-center gap-1 rounded-full border p-1">
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
							class="focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 {active ? opt.active : 'text-muted-foreground hover:text-foreground'}"
						>
							<Icon class="size-3.5" />{opt.label}
						</a>
					{:else}
						<button
							type="button"
							onclick={() => pick(opt.key)}
							aria-pressed={active}
							disabled={busy !== null}
							class="focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 disabled:opacity-60 {active ? opt.active : 'text-muted-foreground hover:text-foreground'}"
						>
							<Icon class="size-3.5" />{opt.label}
						</button>
					{/if}
				{/each}
			</div>
			{:else if !isReply && invite.rsvpDisabledReason}
				<p class="text-muted-foreground text-[11px]">{invite.rsvpDisabledReason}</p>
			{/if}

			{#if invite.joinUrl}
				<!-- Primary CTA for a virtual meeting: its own full-width filled button. -->
				<a
					href={invite.joinUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="bg-brand text-brand-foreground hover:bg-brand/90 focus-visible:ring-ring flex w-full items-center justify-center gap-1.5 rounded-4xl px-3 py-2 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
				>
					<VideoIcon class="size-4" /> Join {invite.meetingPlatform ? PLATFORM_LABEL[invite.meetingPlatform] : 'meeting'}
				</a>
			{/if}

			<!-- Secondary: the "saved" note, then Add to calendar (webcal → opens the
			     OS calendar app) + a plain .ics Download. -->
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
				{#if invite.myRsvp && !Object.values(invite.rsvpLinks).some(Boolean)}
					<p class="text-faint text-[11px]">Saved for you — the organizer isn't notified.</p>
				{/if}
				<div class="ml-auto flex items-center gap-x-4">
					{#if webcalHref}
						<a
							href={webcalHref}
							class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
						>
							<CalendarPlusIcon class="size-3.5" /> Add to calendar
						</a>
					{/if}
					<a
						href={originalHref ?? icsHref()}
						download={originalHref ? undefined : `${(invite.summary || 'event').replace(/[^\w.-]+/g, '-')}.ics`}
						class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
					>
						<DownloadIcon class="size-3.5" /> Download
					</a>
				</div>
			</div>
		</div>
	{/if}
</div>


{#snippet descText(text: string)}{#each descSegments(text) as seg, i (i)}{#if seg.type === 'link'}<a
			href={seg.href}
			target="_blank"
			rel="noopener noreferrer"
			class="text-brand font-medium break-all underline underline-offset-2">{seg.value}</a>{:else if seg.type === 'email'}<a
			href={`mailto:${seg.address}`}
			class="text-brand font-medium break-all underline underline-offset-2">{seg.value}</a>{:else}{seg.value}{/if}{/each}{/snippet}
