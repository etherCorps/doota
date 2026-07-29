<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account setting: turn OS/push notifications on or off. "On" requests
	// permission (must be a user gesture) + registers this browser's push
	// subscription; "off" unsubscribes and forgets it server-side. Reflects the
	// browser permission state (a denied permission can only be changed in the
	// browser's own settings, so the switch disables with a hint).
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import BellIcon from '@lucide/svelte/icons/bell';
	import { notifPerm, enableOsNotifications } from '$lib/client/os-notify.svelte.js';
	import { pushSupported, isPushSubscribed, subscribeToPush, unsubscribeFromPush } from '$lib/client/push.js';

	const supported = pushSupported();
	let subscribed = $state(false);
	let busy = $state(false);

	const denied = $derived(notifPerm.current === 'denied');
	const on = $derived(subscribed && notifPerm.current === 'granted');

	onMount(async () => {
		subscribed = await isPushSubscribed();
		// Permission already granted but no live subscription on THIS device (new
		// device, the push endpoint rotated, or a prior enable that never persisted):
		// reconcile silently so the toggle reflects reality instead of showing off.
		if (!subscribed && supported && notifPerm.current === 'granted') {
			try {
				subscribed = (await subscribeToPush()) === 'ok';
			} catch {
				/* leave off — the toggle still works */
			}
		}
	});

	async function toggle(next: boolean) {
		if (busy) return;
		busy = true;
		try {
			if (next) {
				// Awaits the full chain: permission → browser subscribe → server save.
				// "ok" means browser AND server are in sync — not just a local sub.
				const res = await enableOsNotifications();
				subscribed = res === 'ok';
				if (res === 'ok') toast.success('Notifications on.');
				else if (res === 'denied') toast.error('Notifications are blocked in your browser.');
				else if (res === 'no-vapid') toast.error('Push isn’t set up on the server yet.');
				else if (res === 'unsupported') toast.error('This browser doesn’t support push notifications.');
				else toast.error('Could not enable notifications on this device.');
			} else {
				await unsubscribeFromPush();
				subscribed = false;
				toast.success('Notifications off.');
			}
		} catch (e) {
			// Belt to the internal catches — never let a rejected permission/RPC call
			// escape as an unhandled error; surface it and keep the toggle usable.
			console.error('notifications toggle failed', e);
			toast.error('Something went wrong updating notifications.');
		} finally {
			busy = false;
		}
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<BellIcon class="size-4" /> Notifications
		</Card.CardTitle>
		<Card.CardDescription>Get a push when new mail arrives — even with the app closed.</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm font-medium">Push notifications</p>
				<p class="text-muted-foreground text-xs">
					{#if !supported}
						Not supported on this browser. On iPhone, install Doota to your Home Screen first.
					{:else if denied}
						Blocked — turn them back on in your browser or system settings, then reload.
					{:else}
						Applies to this browser/device. Enable it on each device you want alerts on.
					{/if}
				</p>
			</div>
			<Switch checked={on} disabled={!supported || denied || busy} onCheckedChange={toggle} aria-label="Push notifications" />
		</div>
	</Card.CardContent>
</Card.Card>
