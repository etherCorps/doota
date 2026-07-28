<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Org policy for remote content (images + fonts) in received mail. "Auto-load"
	// on = allow (still same-origin proxied, never a direct sender fetch); off =
	// block (readers opt in per message/sender). "Lock" prevents users overriding —
	// enforced server-side in the message body route.
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import ImageIcon from '@lucide/svelte/icons/image';
	import { orgRemoteContent, setOrgRemoteContent } from '$lib/rpc/domains.remote.js';

	let { orgId }: { orgId: string } = $props();

	const q = orgRemoteContent(orgId);
	let saving = $state(false);
	// Optimistic override shown while a save is in flight; else the switches
	// reflect the server value directly (no seed-into-$state effect).
	let pending = $state<{ allow: boolean; locked: boolean } | null>(null);
	const allow = $derived(pending?.allow ?? q.current?.mode === 'allow');
	const locked = $derived(pending?.locked ?? q.current?.locked ?? false);

	async function save(next: { allow?: boolean; locked?: boolean }) {
		if (saving) return;
		const merged = { allow: next.allow ?? allow, locked: next.locked ?? locked };
		pending = merged;
		saving = true;
		try {
			await setOrgRemoteContent({ orgId, mode: merged.allow ? 'allow' : 'block', locked: merged.locked });
			await q.refresh();
			toast.success('Remote-content policy saved.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save.');
		} finally {
			pending = null;
			saving = false;
		}
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<ImageIcon class="size-4" /> Remote content
		</Card.CardTitle>
		<Card.CardDescription
			>Images and web fonts in received mail. Always fetched through our proxy — the sender never
			sees the reader.</Card.CardDescription
		>
	</Card.CardHeader>
	<Card.CardContent class="space-y-4">
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm font-medium">Auto-load remote content</p>
				<p class="text-muted-foreground text-xs">
					Off (default) blocks it until a reader opts in per message or sender.
				</p>
			</div>
			<Switch checked={allow} disabled={saving || q.current === undefined} onCheckedChange={(v) => save({ allow: v })} />
		</div>
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm font-medium">Lock this policy</p>
				<p class="text-muted-foreground text-xs">
					Members can't override it (server-enforced). For privacy-strict orgs.
				</p>
			</div>
			<Switch checked={locked} disabled={saving || q.current === undefined} onCheckedChange={(v) => save({ locked: v })} />
		</div>
	</Card.CardContent>
</Card.Card>
