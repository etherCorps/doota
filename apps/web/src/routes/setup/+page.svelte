<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import Setup from '$lib/components/pages/setup.svelte';

	let { data } = $props();
</script>

{#if data.locked}
	<div class="flex h-screen w-full items-center justify-center px-6">
		<div class="max-w-md space-y-3 text-center">
			<h1 class="text-2xl font-bold tracking-wide">Doota setup</h1>
			{#if data.reason === 'no-token'}
				<p class="text-muted-foreground text-sm">
					The web setup wizard is disabled because <code>SETUP_TOKEN</code> is not configured.
					Create the super-admin with the CLI instead:
				</p>
				<pre class="bg-muted rounded-md p-3 text-left text-xs">pnpm reset-admin &lt;email&gt; &lt;password&gt;</pre>
			{:else}
				<p class="text-muted-foreground text-sm">
					This page needs the one-time setup token. Open it as
					<code>/setup?token=YOUR_SETUP_TOKEN</code>.
				</p>
			{/if}
		</div>
	</div>
{:else}
	<Setup token={data.token} />
{/if}
