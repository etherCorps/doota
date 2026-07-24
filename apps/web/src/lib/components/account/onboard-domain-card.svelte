<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { invalidateAll } from '$app/navigation';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import * as Card from '$lib/components/ui/card/index.js';
	import DomainOnboarder from '$lib/components/admin/domain-onboarder.svelte';
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<GlobeIcon class="size-4" /> Onboard a mail domain
		</Card.CardTitle>
		<Card.CardDescription>
			Connect a Cloudflare domain so Doota can send and receive mail. An active zone wires
			immediately; a new zone returns nameservers to delegate — you can continue once it's added
			and finish DNS later.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<DomainOnboarder onChange={() => invalidateAll()} />
	</Card.CardContent>
</Card.Card>
