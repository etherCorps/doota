<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Svelte-native email template builder (docs/service-accounts.md § Builder).
	// Owns the block model + drag reorder; the server compiles blocks → MJML → HTML
	// (MRML) at save and for preview. No embedded editor, no second framework.
	import { untrack } from 'svelte';
	import { dndzone } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { createOrgTemplate, updateOrgTemplate, previewTemplate } from '$lib/rpc/template.remote';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	type Block =
		| { id: string; type: 'heading'; text: string; level?: 1 | 2 | 3 }
		| { id: string; type: 'text'; text: string }
		| { id: string; type: 'button'; text: string; href: string }
		| { id: string; type: 'image'; src: string; alt?: string; href?: string }
		| { id: string; type: 'divider' }
		| { id: string; type: 'spacer'; height?: number }
		| { id: string; type: 'html'; html: string };

	let {
		orgId,
		templateId = null,
		initialName = '',
		initialSubject = '',
		initialBlocks = []
	}: {
		orgId: string;
		templateId?: string | null;
		initialName?: string;
		initialSubject?: string;
		initialBlocks?: Block[];
	} = $props();

	// Seed editable state from props once (edit form); detached from later prop changes.
	let name = $state(untrack(() => initialName));
	let subject = $state(untrack(() => initialSubject));
	let blocks = $state<Block[]>(untrack(() => (initialBlocks.length ? initialBlocks : [])));
	let previewHtml = $state<string | null>(null);
	const mergeExample = '{{ variable }}';
	let previewing = $state(false);
	let saving = $state(false);

	const PALETTE: { type: Block['type']; label: string }[] = [
		{ type: 'heading', label: 'Heading' },
		{ type: 'text', label: 'Text' },
		{ type: 'button', label: 'Button' },
		{ type: 'image', label: 'Image' },
		{ type: 'divider', label: 'Divider' },
		{ type: 'spacer', label: 'Spacer' },
		{ type: 'html', label: 'HTML' }
	];

	function newBlock(type: Block['type']): Block {
		const id = crypto.randomUUID();
		switch (type) {
			case 'heading':
				return { id, type, text: 'Heading', level: 2 };
			case 'text':
				return { id, type, text: 'Some text with a {{ variable }}.' };
			case 'button':
				return { id, type, text: 'Click me', href: 'https://' };
			case 'image':
				return { id, type, src: 'https://', alt: '' };
			case 'divider':
				return { id, type };
			case 'spacer':
				return { id, type, height: 20 };
			case 'html':
				return { id, type, html: '<p>Raw HTML</p>' };
		}
	}

	function addBlock(type: Block['type']) {
		blocks = [...blocks, newBlock(type)];
	}
	function removeBlock(id: string) {
		blocks = blocks.filter((b) => b.id !== id);
	}

	// svelte-dnd-action reorder (MIT — the borrowed drag physics).
	function handleDnd(e: CustomEvent<{ items: Block[] }>) {
		blocks = e.detail.items;
	}

	const doc = $derived({ blocks: $state.snapshot(blocks) as Block[] });

	async function preview() {
		previewing = true;
		try {
			const res = await previewTemplate({
				editorJson: JSON.stringify(doc),
				subjectTemplate: subject
			});
			previewHtml = res.html;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Preview failed.');
		} finally {
			previewing = false;
		}
	}

	async function save() {
		if (!name.trim()) {
			toast.error('Give the template a name.');
			return;
		}
		saving = true;
		const editorJson = JSON.stringify(doc);
		const req = templateId
			? updateOrgTemplate({ templateId, name, subjectTemplate: subject, editorJson })
			: createOrgTemplate({ orgId, name, subjectTemplate: subject, editorJson });
		toast.promise(req as Promise<unknown>, {
			loading: 'Saving template…',
			success: 'Template saved.',
			error: (e) => (e instanceof Error ? e.message : 'Could not save the template.')
		});
		try {
			await req;
			await goto(resolve('/templates'));
		} catch {
			// surfaced by toast
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-end gap-3">
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<label class="text-xs font-medium" for="tmpl-name">Name</label>
			<Input id="tmpl-name" bind:value={name} placeholder="Welcome email" />
		</div>
		<div class="flex min-w-0 flex-[2] flex-col gap-1">
			<label class="text-xs font-medium" for="tmpl-subject">Subject</label>
			<Input id="tmpl-subject" bind:value={subject} placeholder="Welcome, {'{{ name }}'}" />
		</div>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<!-- Editor -->
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="font-heading text-base">Blocks</Card.CardTitle>
				<Card.CardDescription>
					Drag to reorder. Use <span class="font-mono">{mergeExample}</span> anywhere for merge data.
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent class="flex flex-col gap-3">
				<div class="flex flex-wrap gap-1.5">
					{#each PALETTE as p (p.type)}
						<Button size="sm" variant="outline" onclick={() => addBlock(p.type)}>+ {p.label}</Button>
					{/each}
				</div>

				<section
					use:dndzone={{ items: blocks, flipDurationMs: 150 }}
					onconsider={handleDnd}
					onfinalize={handleDnd}
					class="flex flex-col gap-2"
				>
					{#each blocks as block (block.id)}
						<div animate:flip={{ duration: 150 }} class="bg-card flex items-start gap-2 rounded-lg border p-2.5">
							<GripVerticalIcon class="text-muted-foreground mt-1 size-4 shrink-0 cursor-grab" />
							<div class="flex min-w-0 flex-1 flex-col gap-1.5">
								<Badge variant="secondary" class="w-fit capitalize">{block.type}</Badge>
								{#if block.type === 'heading' || block.type === 'text'}
									<Textarea bind:value={block.text} rows={2} />
								{:else if block.type === 'button'}
									<Input bind:value={block.text} placeholder="Label" />
									<Input bind:value={block.href} placeholder="https://…" />
								{:else if block.type === 'image'}
									<Input bind:value={block.src} placeholder="Image URL" />
									<Input bind:value={block.alt} placeholder="Alt text" />
								{:else if block.type === 'spacer'}
									<Input type="number" bind:value={block.height} placeholder="Height (px)" />
								{:else if block.type === 'html'}
									<Textarea bind:value={block.html} rows={3} class="font-mono text-xs" />
								{:else}
									<span class="text-muted-foreground text-xs">Horizontal rule.</span>
								{/if}
							</div>
							<Button
								size="icon"
								variant="ghost"
								class="text-muted-foreground hover:text-destructive size-8 shrink-0"
								onclick={() => removeBlock(block.id)}
								aria-label="Remove block"
							>
								<Trash2Icon class="size-4" />
							</Button>
						</div>
					{/each}
					{#if !blocks.length}
						<p class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
							Add a block to start.
						</p>
					{/if}
				</section>
			</Card.CardContent>
		</Card.Card>

		<!-- Preview -->
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="font-heading text-base">Preview</Card.CardTitle>
				<Card.CardAction>
					<Button size="sm" variant="outline" onclick={preview} disabled={previewing || !blocks.length}>
						{previewing ? 'Rendering…' : 'Refresh'}
					</Button>
				</Card.CardAction>
			</Card.CardHeader>
			<Card.CardContent>
				{#if previewHtml}
					<iframe title="Template preview" srcdoc={previewHtml} class="h-[28rem] w-full rounded-md border bg-white"></iframe>
				{:else}
					<p class="text-muted-foreground text-sm">Add blocks and hit Refresh to compile a preview.</p>
				{/if}
			</Card.CardContent>
		</Card.Card>
	</div>

	<div class="flex justify-end gap-2">
		<Button variant="ghost" onclick={() => goto(resolve('/templates'))}>Cancel</Button>
		<Button onclick={save} disabled={saving}>{templateId ? 'Save version' : 'Create template'}</Button>
	</div>
</div>
