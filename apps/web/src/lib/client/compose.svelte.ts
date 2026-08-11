// SPDX-License-Identifier: Apache-2.0
// Single compose controller. One ComposePanel is mounted in the (app) layout and
// bound to this store; every entry point (sidebar / top bar / ⌘K / `c` key /
// forward / resume-draft / empty-state CTA) routes through `compose.start(...)`
// instead of each mounting its own panel.
import { network } from './online.svelte.js';
import { toast } from 'svelte-sonner';

export type ComposePrefill = {
	kind?: 'new' | 'forward';
	mailboxId?: string;
	fromAliasId?: string | null;
	threadId?: string | null;
	inReplyToMessageId?: string | null;
	to?: string;
	subject?: string;
	body?: string;
	/** Source message ids to forward — the HTML is composed server-side at Send
	 * (raw email HTML never reaches the client), so marketing templates survive. */
	forwardMessageIds?: string[];
};

class ComposeStore {
	open = $state(false);
	prefill = $state<ComposePrefill | undefined>(undefined);
	resumeDraftId = $state<string | undefined>(undefined);
	// Pre-fill the schedule picker (epoch ms) — set when editing a scheduled send
	// so its original send time is preserved.
	scheduleAt = $state<number | undefined>(undefined);
	// Bumped on every start() so the layout can {#key} the panel — each compose
	// gets a fresh instance instead of reusing stale editor state.
	nonce = $state(0);

	/** Open the compose panel. No args = blank new message. */
	start(opts?: { prefill?: ComposePrefill; resumeDraftId?: string; scheduleAt?: number }) {
		// Composing needs the server (drafts, send, forward HTML are all server-side).
		// Every entry point routes through here, so one guard covers them all.
		if (network.offline) {
			toast.error("You're offline — composing needs a connection.");
			return;
		}
		this.prefill = opts?.prefill;
		this.resumeDraftId = opts?.resumeDraftId;
		this.scheduleAt = opts?.scheduleAt;
		this.nonce++;
		this.open = true;
	}
}

export const compose = new ComposeStore();
