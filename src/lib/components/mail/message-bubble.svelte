<script lang="ts">
	import { messageById, participant, type Message } from '$lib/mock/index.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CheckCheckIcon from '@lucide/svelte/icons/check-check';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';

	let { message }: { message: Message } = $props();

	const pColors = ['var(--p1)', 'var(--p2)', 'var(--p3)'];
	const author = $derived(message.sentByMe ? null : participant(message.authorId));
	const spine = $derived(author ? pColors[author.color] : 'var(--foreground)');
	const parent = $derived(message.replyTo ? messageById(message.replyTo) : undefined);
</script>

<div class="flex flex-col {message.sentByMe ? 'items-end' : 'items-start'}">
	{#if author}
		<span class="mb-1 px-1 text-xs font-medium" style="color:{spine}">{author.name}</span>
	{/if}

	<div class="flex max-w-[78%] flex-col gap-1">
		{#if message.variant === 'card' && message.card}
			<!-- rich card variant (invoice / newsletter) -->
			<div class="overflow-hidden rounded-xl border bg-card">
				<div class="flex items-center gap-2 border-b px-3 py-2">
					{#if message.card.kind === 'invoice'}
						<ReceiptIcon class="text-p3 size-4" />
					{:else}
						<FileTextIcon class="text-p1 size-4" />
					{/if}
					<span class="text-muted-foreground text-xs">{message.card.meta}</span>
				</div>
				<div class="space-y-1 px-3 py-3">
					<p class="font-heading text-base font-semibold">{message.card.title}</p>
					<p class="text-muted-foreground text-sm">{message.card.body}</p>
				</div>
				{#if message.card.cta}
					<button
						type="button"
						onclick={() => console.log('TODO: open card', message.id)}
						class="text-brand w-full border-t px-3 py-2 text-left text-sm font-medium hover:bg-accent"
					>
						{message.card.cta} →
					</button>
				{/if}
			</div>
		{:else}
			<!-- text bubble. Sent = graphite (ink), never brand. -->
			<div
				class="rounded-2xl px-3.5 py-2 text-sm leading-relaxed {message.sentByMe
					? 'bg-primary text-primary-foreground rounded-br-sm'
					: 'bg-card rounded-bl-sm border'}"
				style={message.sentByMe ? '' : `border-inline-start:3px solid ${spine}`}
			>
				{#if parent}
					{@const pAuthor = parent.sentByMe ? null : participant(parent.authorId)}
					<div
						class="mb-1.5 rounded-md border-l-2 px-2 py-1 text-xs opacity-80 {message.sentByMe
							? 'bg-white/10'
							: 'bg-muted'}"
						style="border-color:{parent.sentByMe ? 'currentColor' : pColors[pAuthor!.color]}"
					>
						<span class="font-medium">{parent.sentByMe ? 'You' : pAuthor!.name}</span>
						<span class="line-clamp-1 opacity-80">{parent.body}</span>
					</div>
				{/if}
				<p>{message.body}</p>
			</div>
		{/if}

		{#if message.attachments}
			{#each message.attachments as file (file.name)}
				<button
					type="button"
					onclick={() => console.log('TODO: download', file.name)}
					class="flex items-center gap-2 self-start rounded-lg border bg-card px-2.5 py-1.5 text-xs hover:bg-accent"
				>
					<PaperclipIcon class="text-muted-foreground size-3.5" />
					<span class="font-mono">{file.name}</span>
					<span class="text-muted-foreground">{file.size}</span>
				</button>
			{/each}
		{/if}

		<div class="flex items-center gap-1 px-1 {message.sentByMe ? 'self-end' : 'self-start'}">
			<span class="text-faint text-[11px]">{message.at}</span>
			{#if message.sentByMe && message.delivery}
				{#if message.delivery === 'read'}
					<CheckCheckIcon class="text-ok size-3.5" />
				{:else if message.delivery === 'delivered'}
					<CheckCheckIcon class="text-faint size-3.5" />
				{:else}
					<CheckIcon class="text-faint size-3.5" />
				{/if}
			{/if}
		</div>
	</div>
</div>
