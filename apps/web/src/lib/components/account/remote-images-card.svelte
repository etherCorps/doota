<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail setting: load remote images automatically for every sender.
	// Off by default — remote images are tracking beacons (they tell the sender
	// when/where you opened the mail). On flips the per-message block off globally;
	// per-sender "always load" still works underneath either way.
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import ImageIcon from '@lucide/svelte/icons/image';
	import { imagesLoadAll, setImagesLoadAll } from '$lib/rpc/thread.remote.js';

	const q = imagesLoadAll();
	const on = $derived(q.current ?? false);
	let busy = $state(false);

	async function toggle(next: boolean) {
		if (busy) return;
		busy = true;
		try {
			await setImagesLoadAll({ on: next });
			await q.refresh();
			toast.success(next ? 'Remote images will load automatically.' : 'Remote images are blocked until you load them.');
		} catch {
			toast.error('Could not update the setting.');
		} finally {
			busy = false;
		}
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<ImageIcon class="size-4" /> Remote images
		</Card.CardTitle>
		<Card.CardDescription>Images hosted on the sender's server (not attached to the mail).</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm font-medium">Show remote images automatically</p>
				<p class="text-muted-foreground text-xs">
					Off keeps them blocked until you tap “Load” — remote images can track when and where you open a message.
				</p>
			</div>
			<Switch checked={on} disabled={busy} onCheckedChange={toggle} aria-label="Show remote images automatically" />
		</div>
	</Card.CardContent>
</Card.Card>
