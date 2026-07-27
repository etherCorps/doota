<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Themed calendar-invite card. Renders a parsed iMIP invite (see
	// mail-core/calendar.ts) in the app's own surface instead of a raw .ics
	// download. RSVP is LOCAL status (organizer not notified) plus, when the
	// invite carried the provider's own Yes/Maybe/No links, a pass-through to
	// Google/Microsoft's real RSVP flow. Times render in the event's own timezone
	// (honest — matches how Gmail shows them) with the viewer's zone as a hint.
	import type { CalendarInviteDTO, InviteRsvpStatus } from '@doota/mail-core/mail-thread-contract';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import VideoIcon from '@lucide/svelte/icons/video';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import HelpCircleIcon from '@lucide/svelte/icons/circle-help';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { linkifySegments } from '$lib/utils/linkify.js';

	let {
		invite,
		originalHref = null,
		onRsvp
	}: {
		invite: CalendarInviteDTO;
		originalHref?: string | null;
		onRsvp: (status: InviteRsvpStatus) => void | Promise<void>;
	} = $props();

	const cancelled = $derived(invite.method === 'CANCEL' || invite.status === 'CANCELLED');

	// The viewer's local timezone label, shown only when it differs from the
	// event's own zone (so "3:00 PM EDT · your time 12:00 PM PDT" only when useful).
	const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	const zone = $derived(invite.tz ?? 'UTC');
	const part = (ms: number, opts: Intl.DateTimeFormatOptions) =>
		new Intl.DateTimeFormat(undefined, { ...opts, timeZone: zone }).format(new Date(ms));

	// Tear-off calendar chip — month tab over the day number, in the event's zone.
	const chip = $derived({
		month: part(invite.startMs, { month: 'short' }).toUpperCase(),
		day: part(invite.startMs, { day: 'numeric' })
	});
	// Full weekday + date, promoted next to the title (the invite's real anchor).
	const dateLine = $derived(part(invite.startMs, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
	const timeLine = $derived.by(() => {
		if (invite.allDay) return 'All day';
		const t = (ms: number) => part(ms, { hour: 'numeric', minute: '2-digit' });
		const tzName =
			new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'short' })
				.formatToParts(new Date(invite.startMs))
				.find((p) => p.type === 'timeZoneName')?.value ?? '';
		return invite.endMs ? `${t(invite.startMs)} – ${t(invite.endMs)} ${tzName}` : `${t(invite.startMs)} ${tzName}`;
	});
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

	// Full guest list for the popover: attendees, plus the organizer prepended
	// when they aren't already listed (they always count as going).
	type Guest = { email: string; name: string | null; partstat: string | null };
	const roster = $derived.by<Guest[]>(() => {
		const list: Guest[] = [...invite.attendees];
		const org = invite.organizer.email;
		if (org && !list.some((a) => a.email.toLowerCase() === org.toLowerCase())) {
			list.unshift({ email: org, name: invite.organizer.name, partstat: 'ACCEPTED' });
		}
		return list;
	});
	const isOrganizer = (email: string) =>
		!!invite.organizer.email && email.toLowerCase() === invite.organizer.email.toLowerCase();
	function initials(g: Guest): string {
		const n = (g.name || g.email || '?').trim();
		const parts = n.split(/\s+/).filter(Boolean);
		return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : n.slice(0, 2)).toUpperCase();
	}
	const STATUS: Record<string, { label: string; cls: string }> = {
		ACCEPTED: { label: 'Going', cls: 'text-ok' },
		DECLINED: { label: 'Declined', cls: 'text-destructive' },
		TENTATIVE: { label: 'Maybe', cls: 'text-warn' }
	};
	const statusMeta = (p: string | null) =>
		STATUS[(p ?? '').toUpperCase()] ?? { label: 'No response', cls: 'text-muted-foreground' };

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
		for (const m of desc.matchAll(RE)) {
			// Inter-match text (newlines/pipes/plain runs) → shared linkify.
			const before = desc.slice(last, m.index);
			if (before) out.push(...(linkifySegments(before) as Seg[]));
			const label = m[1].trim();
			out.push({ type: 'link', value: label || m[2], href: m[2] });
			last = m.index + m[0].length;
		}
		if (last < desc.length) out.push(...(linkifySegments(desc.slice(last)) as Seg[]));
		return out.length ? out : (linkifySegments(desc) as Seg[]);
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
	<!-- Header: tear-off date chip anchors the invite; title wraps (it's the
	     headline); date + time promoted right under it. Cancelled reads muted
	     with a struck title so a stale REQUEST isn't mistaken for live. -->
	<div class="flex items-start gap-3.5 border-b p-3.5 {cancelled ? 'bg-muted/40' : 'bg-brand/5'}">
		<div class="border-border/80 w-13 shrink-0 overflow-hidden rounded-xl border text-center {cancelled ? 'opacity-60' : ''}">
			<div class="py-0.5 text-[10px] font-semibold tracking-wide uppercase {cancelled ? 'bg-muted text-muted-foreground' : 'bg-brand text-brand-foreground'}">
				{chip.month}
			</div>
			<div class="bg-card text-foreground py-1 text-xl leading-tight font-bold tabular-nums">{chip.day}</div>
		</div>
		<div class="min-w-0 flex-1">
			<!-- One accent focus: the eyebrow. Origin is quiet muted text; only the
			     meeting platform keeps a tinted badge (it's the actionable thing). -->
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
				<span class="font-medium tracking-wide uppercase {cancelled ? 'text-muted-foreground' : 'text-brand'}">
					{cancelled ? 'Event cancelled' : invite.method === 'REPLY' ? 'RSVP' : 'Invitation'}
				</span>
				{#if invite.calOrigin}
					<span class="text-muted-foreground">· {ORIGIN_LABEL[invite.calOrigin]}</span>
				{/if}
				{#if invite.meetingPlatform}
					<span class="bg-brand/10 text-brand inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
						<VideoIcon class="size-3" />{PLATFORM_LABEL[invite.meetingPlatform]}
					</span>
				{/if}
			</div>
			<h3 class="text-foreground mt-1 line-clamp-2 text-[15px] leading-snug font-semibold {cancelled ? 'text-muted-foreground line-through' : ''}">
				{invite.summary || '(no title)'}
			</h3>
			<div class="mt-1 text-xs">
				<div class="{isPast && !cancelled ? 'text-muted-foreground' : 'text-foreground'} font-medium">{dateLine}</div>
				<div class="text-muted-foreground">
					{timeLine}{#if viewerHint} · <span class="text-faint">{viewerHint}</span>{/if}
				</div>
				{#if isPast && !cancelled}<div class="text-faint">This event has ended.</div>{/if}
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
							{#each roster.slice(0, 5) as g (g.email)}
								<span class="border-card bg-muted text-muted-foreground grid size-6 place-items-center rounded-full border-2 text-[9px] font-semibold">{initials(g)}</span>
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
							{#each roster as g (g.email)}
								{@const s = statusMeta(g.partstat)}
								<div class="flex items-center gap-2.5 px-3 py-1.5">
									<span class="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold">{initials(g)}</span>
									<span class="min-w-0 flex-1">
										<span class="text-foreground block truncate text-xs font-medium">{g.name || g.email}</span>
										{#if g.name}<span class="text-faint block truncate text-[11px]">{g.email}</span>{/if}
									</span>
									<span class="shrink-0 text-[11px] font-medium {isOrganizer(g.email) ? 'text-muted-foreground' : s.cls}">{isOrganizer(g.email) ? 'Organizer' : s.label}</span>
								</div>
							{/each}
						</div>
					</Popover.Content>
				</Popover.Root>
			{/if}

			{#if invite.description}
				<p class="text-muted-foreground border-t pt-2.5 text-xs whitespace-pre-line">{#each descSegments(invite.description) as seg, i (i)}{#if seg.type === 'link'}<a
								href={seg.href}
								target="_blank"
								rel="noopener noreferrer"
								class="text-brand font-medium break-all underline underline-offset-2">{seg.value}</a>{:else if seg.type === 'email'}<a
								href={`mailto:${seg.address}`}
								class="text-brand font-medium break-all underline underline-offset-2">{seg.value}</a>{:else}{seg.value}{/if}{/each}</p>
			{/if}
		</div>
	{/if}

	<!-- Actions. Hidden for cancellations (nothing to respond to / join). -->
	{#if !cancelled}
		<div class="border-t p-3">
			<div class="flex flex-wrap items-center gap-2">
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
								class="focus-visible:ring-ring flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 {active ? opt.active : 'text-muted-foreground hover:text-foreground'}"
							>
								<Icon class="size-3.5" />{opt.label}
							</a>
						{:else}
							<button
								type="button"
								onclick={() => pick(opt.key)}
								aria-pressed={active}
								disabled={busy !== null}
								class="focus-visible:ring-ring flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 disabled:opacity-60 {active ? opt.active : 'text-muted-foreground hover:text-foreground'}"
							>
								<Icon class="size-3.5" />{opt.label}
							</button>
						{/if}
					{/each}
				</div>

				{#if invite.joinUrl}
					<!-- Primary CTA for a virtual meeting: a filled button, not a text row. -->
					<a
						href={invite.joinUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="bg-brand text-brand-foreground hover:bg-brand/90 focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
					>
						<VideoIcon class="size-4" /> Join {invite.meetingPlatform ? PLATFORM_LABEL[invite.meetingPlatform] : 'meeting'}
					</a>
				{/if}

				<a
					href={originalHref ?? icsHref()}
					download={originalHref ? undefined : `${(invite.summary || 'event').replace(/[^\w.-]+/g, '-')}.ics`}
					class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-medium hover:underline"
				>
					<DownloadIcon class="size-3.5" /> Download invite
				</a>
			</div>
			{#if invite.myRsvp && !Object.values(invite.rsvpLinks).some(Boolean)}
				<p class="text-faint mt-2 text-[11px]">Saved for you — the organizer isn't notified.</p>
			{/if}
		</div>
	{/if}
</div>
