<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';

	// Address host picker for the trailing InputGroup addon: shows the selected
	// `@host` and, when the org has routing subdomains, a dropdown to switch. Drop
	// this inside an <InputGroup.Addon align="inline-end">.
	let { hosts, value = $bindable() }: { hosts: string[]; value: string } = $props();
</script>

{#if hosts.length > 1}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<InputGroup.Button {...props} class="max-w-[13rem] font-mono" aria-label="Domain">
					<span class="truncate">@{value}</span>
					<ChevronsUpDownIcon class="size-3.5 shrink-0 opacity-60" />
				</InputGroup.Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="max-h-64 overflow-y-auto">
			<DropdownMenu.RadioGroup bind:value>
				{#each hosts as h (h)}
					<DropdownMenu.RadioItem value={h} class="font-mono">@{h}</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{:else}
	<InputGroup.Text class="font-mono">@{value}</InputGroup.Text>
{/if}
