// Single compose controller. One ComposePanel is mounted in the (app) layout and
// bound to this store; every entry point (sidebar / top bar / ⌘K / `c` key /
// forward / resume-draft / empty-state CTA) routes through `compose.start(...)`
// instead of each mounting its own panel.

export type ComposePrefill = {
	kind?: 'new' | 'forward';
	mailboxId?: string;
	fromAliasId?: string | null;
	threadId?: string | null;
	inReplyToMessageId?: string | null;
	to?: string;
	subject?: string;
	body?: string;
};

class ComposeStore {
	open = $state(false);
	prefill = $state<ComposePrefill | undefined>(undefined);
	resumeDraftId = $state<string | undefined>(undefined);
	// Bumped on every start() so the layout can {#key} the panel — each compose
	// gets a fresh instance instead of reusing stale editor state.
	nonce = $state(0);

	/** Open the compose panel. No args = blank new message. */
	start(opts?: { prefill?: ComposePrefill; resumeDraftId?: string }) {
		this.prefill = opts?.prefill;
		this.resumeDraftId = opts?.resumeDraftId;
		this.nonce++;
		this.open = true;
	}
}

export const compose = new ComposeStore();
