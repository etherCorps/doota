<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import FileTextIcon from '@lucide/svelte/icons/file-text';

	let { data } = $props();
	const fmt = (ms: number) => new Date(ms).toLocaleDateString();
</script>

<div class="w-full p-4 sm:p-6 md:p-8">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div>
			<h1 class="font-heading text-xl font-semibold">Templates</h1>
			<p class="text-muted-foreground text-sm">Reusable email templates for API sending.</p>
		</div>
		{#if data.orgId}
			<Button href={resolve('/templates/new')}>New template</Button>
		{/if}
	</div>

	{#if !data.orgId}
		<Card.Card>
			<Card.CardContent class="text-muted-foreground py-10 text-center text-sm">
				You need to manage an organization to create templates.
			</Card.CardContent>
		</Card.Card>
	{:else if data.templates.length}
		<ul class="flex flex-col divide-y rounded-lg border">
			{#each data.templates as template (template.id)}
				<li>
					<a href="/templates/{template.id}" class="hover:bg-muted flex items-center gap-3 p-3 transition-colors">
						<FileTextIcon class="text-muted-foreground size-5 shrink-0" />
						<div class="flex min-w-0 flex-1 flex-col">
							<span class="truncate text-sm font-medium">{template.name}</span>
							<span class="text-muted-foreground truncate font-mono text-xs">{template.slug} · updated {fmt(template.updatedAt)}</span>
						</div>
						{#if template.archived}<Badge variant="outline">Archived</Badge>{/if}
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<Card.Card>
			<Card.CardContent class="text-muted-foreground py-10 text-center text-sm">
				No templates yet. Create one to send templated mail via the API.
			</Card.CardContent>
		</Card.Card>
	{/if}
</div>
