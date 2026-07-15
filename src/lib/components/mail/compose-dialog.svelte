<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import SendIcon from '@lucide/svelte/icons/send';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let to = $state('');
	let subject = $state('');
	let body = $state('');

	function send() {
		// TODO: wire send pipeline. No-op scaffold.
		console.log('TODO: send', { to, subject, body });
		to = subject = body = '';
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="font-heading">New message</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-3">
			<div class="space-y-1.5">
				<Label for="compose-to">To</Label>
				<Input id="compose-to" class="font-mono" placeholder="name@domain.com" bind:value={to} />
			</div>
			<div class="space-y-1.5">
				<Label for="compose-subject">Subject</Label>
				<Input id="compose-subject" placeholder="Subject" bind:value={subject} />
			</div>
			<Textarea placeholder="Write your message…" class="min-h-[160px]" bind:value={body} />
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (open = false)}>Discard</Button>
			<Button class="gap-1.5" onclick={send}><SendIcon class="size-4" /> Send</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
