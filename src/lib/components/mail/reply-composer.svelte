<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import SendIcon from '@lucide/svelte/icons/send';

	let { to }: { to: string } = $props();
	let body = $state('');

	function send() {
		// TODO: wire send pipeline. No-op scaffold.
		console.log('TODO: send reply to', to, body);
		body = '';
	}
</script>

<div class="border-t bg-card p-3">
	<div class="focus-within:ring-ring/40 rounded-xl border focus-within:ring-2">
		<Textarea
			bind:value={body}
			placeholder="Reply to {to}…"
			class="min-h-[60px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
		/>
		<div class="flex items-center justify-between px-2 py-1.5">
			<Button
				variant="ghost"
				size="icon"
				class="text-muted-foreground"
				onclick={() => console.log('TODO: attach')}
			>
				<PaperclipIcon class="size-4" />
			</Button>
			<Button size="sm" class="gap-1.5" disabled={!body.trim()} onclick={send}>
				<SendIcon class="size-3.5" /> Send
			</Button>
		</div>
	</div>
</div>
