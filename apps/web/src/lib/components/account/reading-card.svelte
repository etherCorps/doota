<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: reading/display preferences. Device-local (localStorage) —
	// unlike remote-images this never gates a network fetch, so no server round
	// trip; the pattern matches the thread chat/mail view toggle.
	import * as Card from '$lib/components/ui/card/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import BookOpenTextIcon from '@lucide/svelte/icons/book-open-text';
	import { showSignatures } from '$lib/client/reading-prefs';
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<BookOpenTextIcon class="size-4" /> Reading
		</Card.CardTitle>
		<Card.CardDescription>How messages render in the thread view, on this device.</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm font-medium">Always show signatures</p>
				<p class="text-muted-foreground text-xs">
					Off collapses each sender's sign-off behind a “···” you can tap per message.
				</p>
			</div>
			<Switch
				checked={showSignatures.current}
				onCheckedChange={(value) => (showSignatures.current = value)}
				aria-label="Always show signatures"
			/>
		</div>
	</Card.CardContent>
</Card.Card>
