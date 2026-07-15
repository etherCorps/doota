// Mock data for the Doota UI scaffold. No backend — every screen renders from here.
// Realistic, specific content (deploy thread, external client, invoice, newsletter)
// so the design reads like a real mailbox, not lorem ipsum.

export type Role = 'member' | 'admin' | 'superadmin';

export type Participant = {
	id: string;
	name: string;
	email: string;
	/** participant accent index 0..2 → --p1/--p2/--p3 */
	color: 0 | 1 | 2;
	initials: string;
};

export type Folder = {
	id: string;
	name: string;
	icon: 'inbox' | 'file' | 'send' | 'archive' | 'shield-alert' | 'trash';
	count?: number;
};

export type Label = {
	id: string;
	name: string;
	/** css color token */
	color: string;
};

export type MessageVariant = 'text' | 'card';

export type Message = {
	id: string;
	threadId: string;
	authorId: string; // participant id, or 'me'
	sentByMe: boolean;
	at: string; // human time
	body: string;
	variant: MessageVariant;
	/** id of the message this one replies to → renders a reply-context chip */
	replyTo?: string;
	/** delivery state for own messages */
	delivery?: 'sent' | 'delivered' | 'read';
	/** rich card payload when variant === 'card' */
	card?: {
		kind: 'invoice' | 'newsletter';
		title: string;
		meta: string;
		body: string;
		cta?: string;
	};
	attachments?: { name: string; size: string }[];
};

export type Thread = {
	id: string;
	subject: string;
	participantIds: string[];
	folderId: string;
	labelIds: string[];
	snippet: string;
	at: string;
	unread: boolean;
	starred: boolean;
	messageCount: number;
};

export const me = {
	id: 'me',
	name: 'Arjun Rao',
	email: 'arjun@acme.com',
	initials: 'AR'
};

export const participants: Participant[] = [
	{ id: 'p_maya', name: 'Maya Chen', email: 'maya@acme.com', color: 0, initials: 'MC' },
	{ id: 'p_devon', name: 'Devon Ellis', email: 'devon.ellis@northwind.io', color: 1, initials: 'DE' },
	{ id: 'p_billing', name: 'Stripe Billing', email: 'invoice+statements@stripe.com', color: 2, initials: 'SB' },
	{ id: 'p_news', name: 'Bytes', email: 'hello@bytes.dev', color: 0, initials: 'BY' },
	{ id: 'p_sam', name: 'Sam Ortiz', email: 'sam@acme.com', color: 1, initials: 'SO' },
	{ id: 'p_ops', name: 'Vercel', email: 'notifications@vercel.com', color: 2, initials: 'VC' }
];

export function participant(id: string): Participant {
	return participants.find((p) => p.id === id)!;
}

export const folders: Folder[] = [
	{ id: 'inbox', name: 'Inbox', icon: 'inbox', count: 4 },
	{ id: 'drafts', name: 'Drafts', icon: 'file', count: 1 },
	{ id: 'sent', name: 'Sent', icon: 'send' },
	{ id: 'archive', name: 'Archive', icon: 'archive' },
	{ id: 'spam', name: 'Spam', icon: 'shield-alert', count: 2 },
	{ id: 'trash', name: 'Trash', icon: 'trash' }
];

export const labels: Label[] = [
	{ id: 'l_clients', name: 'Clients', color: 'var(--p1)' },
	{ id: 'l_deploys', name: 'Deploys', color: 'var(--p2)' },
	{ id: 'l_finance', name: 'Finance', color: 'var(--p3)' }
];

export const threads: Thread[] = [
	{
		id: 't_deploy',
		subject: 'Prod deploy — v2.14.0 is live',
		participantIds: ['p_ops', 'p_maya'],
		folderId: 'inbox',
		labelIds: ['l_deploys'],
		snippet: 'Deployment succeeded in 47s. All health checks green.',
		at: '9:12 AM',
		unread: true,
		starred: true,
		messageCount: 4
	},
	{
		id: 't_northwind',
		subject: 'Re: Northwind rollout — timeline for Q3',
		participantIds: ['p_devon'],
		folderId: 'inbox',
		labelIds: ['l_clients'],
		snippet: "Thanks Arjun — the mock looks great. One thing on the export flow…",
		at: '8:40 AM',
		unread: true,
		starred: false,
		messageCount: 6
	},
	{
		id: 't_invoice',
		subject: 'Your July invoice is ready',
		participantIds: ['p_billing'],
		folderId: 'inbox',
		labelIds: ['l_finance'],
		snippet: 'Invoice #ACME-0714 · $2,400.00 · due Jul 28',
		at: 'Yesterday',
		unread: true,
		starred: false,
		messageCount: 1
	},
	{
		id: 't_bytes',
		subject: 'Bytes #312 — The one about signals',
		participantIds: ['p_news'],
		folderId: 'inbox',
		labelIds: [],
		snippet: 'Svelte 5 runes, a tiny state machine, and a rant about ORMs.',
		at: 'Mon',
		unread: false,
		starred: false,
		messageCount: 1
	},
	{
		id: 't_standup',
		subject: 'Standup notes — Thu',
		participantIds: ['p_sam', 'p_maya'],
		folderId: 'inbox',
		labelIds: [],
		snippet: "Shipped the search palette. Blocked on DKIM for the new domain.",
		at: 'Mon',
		unread: false,
		starred: false,
		messageCount: 3
	}
];

export const messages: Message[] = [
	// t_deploy
	{
		id: 'm_d1',
		threadId: 't_deploy',
		authorId: 'p_ops',
		sentByMe: false,
		at: '9:04 AM',
		variant: 'text',
		body: 'Deployment of acme-web@v2.14.0 started for production.'
	},
	{
		id: 'm_d2',
		threadId: 't_deploy',
		authorId: 'p_ops',
		sentByMe: false,
		at: '9:05 AM',
		variant: 'text',
		body: 'Build succeeded in 47s. Promoting to production…'
	},
	{
		id: 'm_d3',
		threadId: 't_deploy',
		authorId: 'me',
		sentByMe: true,
		at: '9:11 AM',
		variant: 'text',
		replyTo: 'm_d2',
		body: 'Nice. @Maya can you smoke-test the billing page before we announce?',
		delivery: 'read'
	},
	{
		id: 'm_d4',
		threadId: 't_deploy',
		authorId: 'p_maya',
		sentByMe: false,
		at: '9:12 AM',
		variant: 'text',
		replyTo: 'm_d3',
		body: 'On it — checking checkout + invoices now. Will report back in 5.'
	},
	// t_northwind
	{
		id: 'm_n1',
		threadId: 't_northwind',
		authorId: 'p_devon',
		sentByMe: false,
		at: 'Tue 4:20 PM',
		variant: 'text',
		body: "Hi Arjun — following up on the rollout plan. Can we get the export flow in before Q3?"
	},
	{
		id: 'm_n2',
		threadId: 't_northwind',
		authorId: 'me',
		sentByMe: true,
		at: 'Tue 5:02 PM',
		variant: 'text',
		body: "Absolutely. I'll send a mock of the export screen tomorrow AM.",
		delivery: 'read'
	},
	{
		id: 'm_n3',
		threadId: 't_northwind',
		authorId: 'me',
		sentByMe: true,
		at: 'Wed 9:30 AM',
		variant: 'text',
		body: 'Here it is — CSV + a scheduled email digest option.',
		delivery: 'read',
		attachments: [{ name: 'export-flow-v2.pdf', size: '1.2 MB' }]
	},
	{
		id: 'm_n4',
		threadId: 't_northwind',
		authorId: 'p_devon',
		sentByMe: false,
		at: '8:40 AM',
		variant: 'text',
		replyTo: 'm_n3',
		body: 'Thanks Arjun — the mock looks great. One thing on the export flow: can the digest go weekly, not just daily?'
	},
	// t_invoice (rich card)
	{
		id: 'm_i1',
		threadId: 't_invoice',
		authorId: 'p_billing',
		sentByMe: false,
		at: 'Yesterday 6:00 PM',
		variant: 'card',
		body: 'Your July invoice is ready.',
		card: {
			kind: 'invoice',
			title: 'Invoice #ACME-0714',
			meta: '$2,400.00 · due Jul 28, 2026',
			body: 'Team plan (12 seats) · Jul 1 – Jul 31',
			cta: 'View invoice'
		}
	},
	// t_bytes (rich card newsletter)
	{
		id: 'm_b1',
		threadId: 't_bytes',
		authorId: 'p_news',
		sentByMe: false,
		at: 'Mon 7:00 AM',
		variant: 'card',
		body: 'Bytes #312',
		card: {
			kind: 'newsletter',
			title: 'The one about signals',
			meta: 'Bytes · Issue #312',
			body: 'Svelte 5 runes went stable, a 30-line finite state machine, and why your ORM is probably fine actually.',
			cta: 'Read online'
		}
	},
	// t_standup
	{
		id: 'm_s1',
		threadId: 't_standup',
		authorId: 'p_sam',
		sentByMe: false,
		at: 'Mon 9:00 AM',
		variant: 'text',
		body: 'Standup: I shipped the command palette (⌘K). Reviewing the sidebar next.'
	},
	{
		id: 'm_s2',
		threadId: 't_standup',
		authorId: 'p_maya',
		sentByMe: false,
		at: 'Mon 9:02 AM',
		variant: 'text',
		body: 'Blocked on DKIM for the new sending domain — waiting on DNS to propagate.'
	},
	{
		id: 'm_s3',
		threadId: 't_standup',
		authorId: 'me',
		sentByMe: true,
		at: 'Mon 9:05 AM',
		variant: 'text',
		body: "I'll poke the admin panel and re-verify the domain this afternoon.",
		delivery: 'delivered'
	}
];

export function threadMessages(threadId: string): Message[] {
	return messages.filter((m) => m.threadId === threadId);
}

export function messageById(id: string): Message | undefined {
	return messages.find((m) => m.id === id);
}

// ── Admin mock data ──────────────────────────────────────────────────────────

export type MailUser = {
	id: string;
	name: string;
	email: string;
	role: Role;
	status: 'active' | 'paused';
	mailboxes: number;
	lastSeen: string;
};

export type Domain = {
	id: string;
	domain: string;
	dkim: 'verified' | 'pending' | 'failed';
	sending: 'active' | 'pending' | 'disabled';
	users: number;
};

export type Mailbox = {
	id: string;
	address: string;
	owner: string;
	domainId: string;
};

export const domains: Domain[] = [
	{ id: 'd_acme', domain: 'acme.com', dkim: 'verified', sending: 'active', users: 8 },
	{ id: 'd_north', domain: 'northwind.io', dkim: 'pending', sending: 'pending', users: 2 },
	{ id: 'd_labs', domain: 'acme-labs.dev', dkim: 'failed', sending: 'disabled', users: 1 }
];

export const users: MailUser[] = [
	{ id: 'u_arjun', name: 'Arjun Rao', email: 'arjun@acme.com', role: 'admin', status: 'active', mailboxes: 2, lastSeen: '2m ago' },
	{ id: 'u_maya', name: 'Maya Chen', email: 'maya@acme.com', role: 'member', status: 'active', mailboxes: 1, lastSeen: '9m ago' },
	{ id: 'u_sam', name: 'Sam Ortiz', email: 'sam@acme.com', role: 'member', status: 'active', mailboxes: 1, lastSeen: '1h ago' },
	{ id: 'u_lee', name: 'Lee Park', email: 'lee@acme.com', role: 'member', status: 'paused', mailboxes: 1, lastSeen: '3d ago' },
	{ id: 'u_devon', name: 'Devon Ellis', email: 'devon@northwind.io', role: 'member', status: 'active', mailboxes: 1, lastSeen: '5h ago' }
];

export const mailboxes: Mailbox[] = [
	{ id: 'mb_arjun', address: 'arjun@acme.com', owner: 'Arjun Rao', domainId: 'd_acme' },
	{ id: 'mb_support', address: 'support@acme.com', owner: 'Arjun Rao', domainId: 'd_acme' },
	{ id: 'mb_maya', address: 'maya@acme.com', owner: 'Maya Chen', domainId: 'd_acme' }
];

// Mailboxes the current user can switch between (top-of-sidebar switcher).
export const myMailboxes = [
	{ id: 'mb_arjun', address: 'arjun@acme.com', label: 'Personal' },
	{ id: 'mb_support', address: 'support@acme.com', label: 'Support (shared)' }
];
