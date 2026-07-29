<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Svelte-native email template builder (docs/service-accounts.md § Builder).
	// Full-bleed editor: palette · canvas · live preview. Owns the block model +
	// drag reorder; compiles blocks → MJML → HTML in the browser (mrml/web) with a
	// live, debounced auto-preview. No embedded editor, no second framework. The
	// send path stays wasm-free (un-jinja at send).
	import { untrack, type Component } from 'svelte';
	import { dndzone } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { createOrgTemplate, updateOrgTemplate } from '$lib/rpc/template.remote';
	import CodeEditor from './code-editor.svelte';
	import {
		blocksToMjml,
		extractVariables,
		variablesSchemaJson,
		type Block,
		type BlockDoc,
		type TemplateSettings
	} from '$lib/mjml/blocks';
	import { BUILTIN_VARIABLES, BUILTIN_NAMES } from '$lib/mjml/variables';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import HeadingIcon from '@lucide/svelte/icons/heading';
	import TypeIcon from '@lucide/svelte/icons/type';
	import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
	import ImageIcon from '@lucide/svelte/icons/image';
	import ListIcon from '@lucide/svelte/icons/list';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import Columns2Icon from '@lucide/svelte/icons/columns-2';
	import Share2Icon from '@lucide/svelte/icons/share-2';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import MoveVerticalIcon from '@lucide/svelte/icons/move-vertical';
	import CodeIcon from '@lucide/svelte/icons/code';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import PanelTopIcon from '@lucide/svelte/icons/panel-top';
	import Settings2Icon from '@lucide/svelte/icons/settings-2';

	let {
		orgId,
		templateId = null,
		initialName = '',
		initialSubject = '',
		initialBlocks = [],
		initialSettings = {}
	}: {
		orgId: string;
		templateId?: string | null;
		initialName?: string;
		initialSubject?: string;
		initialBlocks?: Block[];
		initialSettings?: TemplateSettings;
	} = $props();

	// Seed editable state from props once (edit form); detached from later changes.
	let name = $state(untrack(() => initialName));
	let subject = $state(untrack(() => initialSubject));
	let blocks = $state<Block[]>(untrack(() => (initialBlocks.length ? initialBlocks : [])));
	let bodyBg = $state(untrack(() => initialSettings.bodyBackground ?? ''));
	let css = $state(untrack(() => initialSettings.css ?? ''));
	let previewHtml = $state<string | null>(null);
	let previewError = $state(false);
	let compiling = $state(false);
	let saving = $state(false);
	let device = $state<'desktop' | 'mobile'>('desktop');
	let showSettings = $state(false);

	// The current editor document (blocks + template-wide settings).
	function currentDoc(): BlockDoc {
		return {
			blocks: $state.snapshot(blocks) as Block[],
			settings: { bodyBackground: bodyBg || undefined, css: css || undefined }
		};
	}

	const PALETTE: { type: Block['type']; label: string; icon: Component }[] = [
		{ type: 'heading', label: 'Heading', icon: HeadingIcon },
		{ type: 'text', label: 'Text', icon: TypeIcon },
		{ type: 'button', label: 'Button', icon: MousePointerClickIcon },
		{ type: 'image', label: 'Image', icon: ImageIcon },
		{ type: 'list', label: 'List', icon: ListIcon },
		{ type: 'quote', label: 'Quote', icon: QuoteIcon },
		{ type: 'columns', label: '2 columns', icon: Columns2Icon },
		{ type: 'hero', label: 'Hero', icon: PanelTopIcon },
		{ type: 'social', label: 'Social', icon: Share2Icon },
		{ type: 'divider', label: 'Divider', icon: MinusIcon },
		{ type: 'spacer', label: 'Spacer', icon: MoveVerticalIcon },
		{ type: 'html', label: 'HTML', icon: CodeIcon }
	];
	const SOCIALS = ['github', 'twitter', 'linkedin', 'facebook', 'instagram', 'youtube', 'web'];

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
			case 'list':
				return { id, type, items: ['First item', 'Second item'], ordered: false };
			case 'quote':
				return { id, type, text: 'A memorable quote.' };
			case 'columns':
				return { id, type, left: 'Left column', right: 'Right column' };
			case 'hero':
				return { id, type, src: 'https://', heading: 'Big headline', text: 'Supporting text', buttonText: '', buttonHref: 'https://' };
			case 'social':
				return { id, type, items: [{ network: 'github', href: 'https://' }] };
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
	function handleDnd(e: CustomEvent<{ items: Block[] }>) {
		blocks = e.detail.items;
	}

	// Variables: built-ins we fill vs the caller's own (detected in the template,
	// minus the built-ins). Click a chip to copy its `{{ tag }}`.
	const tag = (n: string) => `{{ ${n} }}`;
	const cssPlaceholder = '.btn { color: #fff }';
	const customVars = $derived(
		extractVariables({ blocks: $state.snapshot(blocks) as Block[] }, subject).filter(
			(v) => !BUILTIN_NAMES.has(v)
		)
	);
	async function copyVar(nameStr: string) {
		await navigator.clipboard.writeText(tag(nameStr));
		toast.success(`Copied ${tag(nameStr)}`);
	}

	// Image upload → public R2 URL (email images must be publicly fetchable).
	function pickImage(apply: (url: string) => void) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/png,image/jpeg,image/gif,image/webp';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const fd = new FormData();
			fd.append('orgId', orgId);
			fd.append('file', file);
			const req = fetch('/api/template-assets', { method: 'POST', body: fd }).then(async (r) => {
				if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? 'Upload failed.');
				return (await r.json()) as { url: string };
			});
			toast.promise(req, {
				loading: 'Uploading…',
				success: 'Image uploaded.',
				error: (e) => (e instanceof Error ? e.message : 'Upload failed.')
			});
			try {
				apply((await req).url);
			} catch {
				// surfaced by toast
			}
		};
		input.click();
	}

	// Client-side MJML→HTML compile (mrml WASM, `web` target). Dynamic-imported so
	// SSR never loads the wasm.
	let engineP: Promise<{ toHtml(s: string): { type: string; content?: string } }> | null = null;
	function getEngine() {
		if (!engineP) {
			engineP = (async () => {
				const mod = await import('mrml/web/mrml_wasm.js');
				const wasmUrl = (await import('mrml/web/mrml_wasm_bg.wasm?url')).default;
				await mod.default(wasmUrl);
				return new mod.Engine();
			})();
		}
		return engineP;
	}

	async function compileDoc(doc: BlockDoc): Promise<{ html: string; variables: string[] }> {
		const engine = await getEngine();
		const out = engine.toHtml(blocksToMjml(doc));
		if (out.type !== 'success' || !out.content) throw new Error('Could not compile the template.');
		return { html: out.content, variables: extractVariables(doc, subject) };
	}

	// Live preview — recompile (debounced) whenever a block or a setting changes.
	$effect(() => {
		const doc = currentDoc();
		void subject;
		if (!doc.blocks.length) {
			previewHtml = null;
			return;
		}
		const id = setTimeout(() => void refresh(doc), 350);
		return () => clearTimeout(id);
	});

	async function refresh(doc: BlockDoc) {
		compiling = true;
		try {
			previewHtml = (await compileDoc(doc)).html;
			previewError = false;
		} catch (err) {
			// Auto-preview failures stay quiet (no toast spam) — the editor stays
			// usable; save surfaces a real error if compile is genuinely broken.
			previewError = true;
			console.error('template preview compile failed', err);
		} finally {
			compiling = false;
		}
	}

	async function save() {
		if (!name.trim()) {
			toast.error('Give the template a name.');
			return;
		}
		saving = true;
		const doc = currentDoc();
		let compiledHtml: string;
		let variablesSchema: string;
		try {
			const c = await compileDoc(doc);
			compiledHtml = c.html;
			variablesSchema = variablesSchemaJson(c.variables);
		} catch (err) {
			saving = false;
			toast.error(err instanceof Error ? err.message : 'Could not compile the template.');
			return;
		}
		const payload = { name, subjectTemplate: subject, editorJson: JSON.stringify(doc), compiledHtml, variablesSchema };
		const req = templateId
			? updateOrgTemplate({ templateId, ...payload })
			: createOrgTemplate({ orgId, ...payload });
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

<div class="flex h-full min-h-0 flex-col">
	<!-- Toolbar -->
	<header class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
		<Button variant="ghost" size="icon" class="size-8 shrink-0" onclick={() => goto(resolve('/templates'))} aria-label="Back to templates">
			<ArrowLeftIcon class="size-4" />
		</Button>
		<Input bind:value={name} placeholder="Template name" aria-label="Template name" class="h-8 w-44 shrink-0 font-medium" />
		<Input bind:value={subject} placeholder="Subject — Welcome, {'{{ name }}'}" aria-label="Subject" class="h-8 min-w-40 flex-1" />
		<div class="ml-auto flex items-center gap-2">
			{#if compiling}<LoaderIcon class="text-muted-foreground size-4 shrink-0 animate-spin" />{/if}
			<Button variant={showSettings ? 'secondary' : 'ghost'} size="icon" class="size-8 shrink-0" onclick={() => (showSettings = !showSettings)} aria-label="Template settings">
				<Settings2Icon class="size-4" />
			</Button>
			<div class="bg-muted flex shrink-0 rounded-md p-0.5">
				<button type="button" class="grid size-7 place-items-center rounded {device === 'desktop' ? 'bg-background shadow-sm' : 'text-muted-foreground'}" onclick={() => (device = 'desktop')} aria-label="Desktop preview">
					<MonitorIcon class="size-4" />
				</button>
				<button type="button" class="grid size-7 place-items-center rounded {device === 'mobile' ? 'bg-background shadow-sm' : 'text-muted-foreground'}" onclick={() => (device = 'mobile')} aria-label="Mobile preview">
					<SmartphoneIcon class="size-4" />
				</button>
			</div>
			<Button size="sm" class="shrink-0" onclick={save} disabled={saving}>{templateId ? 'Save version' : 'Create'}</Button>
		</div>
	</header>

	<!-- Template settings (background + custom CSS) -->
	{#if showSettings}
		<div class="bg-muted/30 flex flex-wrap items-start gap-x-6 gap-y-3 border-b px-3 py-3">
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium">Body background</span>
				<div class="flex items-center gap-1.5">
					<input type="color" bind:value={bodyBg} class="border-input h-8 w-9 cursor-pointer rounded-md border p-0.5" aria-label="Body background color" />
					<Input bind:value={bodyBg} placeholder="#ffffff" class="h-8 w-28" />
				</div>
			</div>
			<div class="flex min-w-60 flex-1 flex-col gap-1">
				<span class="text-xs font-medium">Custom CSS <span class="text-muted-foreground font-normal">(advanced — many clients ignore &lt;style&gt;)</span></span>
				<CodeEditor bind:value={css} language="css" rows={4} placeholder={cssPlaceholder} />
			</div>
		</div>
	{/if}

	<!-- Body: palette · canvas · preview -->
	<div class="flex min-h-0 flex-1 flex-col lg:flex-row">
		<!-- Palette -->
		<aside class="bg-muted/20 shrink-0 overflow-x-auto border-b p-2 lg:w-52 lg:overflow-y-auto lg:border-r lg:border-b-0">
			<p class="text-muted-foreground mb-2 hidden px-1 text-xs font-semibold tracking-wide uppercase lg:block">Add block</p>
			<div class="flex gap-1.5 lg:grid lg:grid-cols-2">
				{#each PALETTE as p (p.type)}
					{@const Icon = p.icon}
					<button
						type="button"
						onclick={() => addBlock(p.type)}
						class="border-input bg-background hover:border-foreground/30 hover:bg-muted flex shrink-0 flex-col items-center gap-1 rounded-lg border px-3 py-2 text-xs transition-colors"
					>
						<Icon class="size-4" />
						<span class="whitespace-nowrap">{p.label}</span>
					</button>
				{/each}
			</div>

			<!-- Merge variables: what we provide + the caller's own. Click to copy. -->
			<div class="mt-3 border-t pt-3">
				<p class="text-muted-foreground mb-1.5 px-1 text-xs font-semibold tracking-wide uppercase">Variables</p>
				<p class="text-muted-foreground mb-1 px-1 text-[11px]">Provided — click to copy</p>
				<div class="mb-2 flex flex-wrap gap-1">
					{#each BUILTIN_VARIABLES as v (v.name)}
						<button
							type="button"
							onclick={() => copyVar(v.name)}
							title={v.description}
							class="border-input bg-background hover:bg-muted rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
						>
							{tag(v.name)}
						</button>
					{/each}
				</div>
				{#if customVars.length}
					<p class="text-muted-foreground mb-1 px-1 text-[11px]">Yours — supply via API <span class="font-mono">data</span></p>
					<div class="flex flex-wrap gap-1">
						{#each customVars as v (v)}
							<button
								type="button"
								onclick={() => copyVar(v)}
								class="border-input bg-background hover:bg-muted text-foreground rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
							>
								{tag(v)}
							</button>
						{/each}
					</div>
				{:else}
					<p class="text-muted-foreground px-1 text-[11px]">
						Type <span class="font-mono">{tag('your_var')}</span> anywhere; supply it via the API <span class="font-mono">data</span> object.
					</p>
				{/if}
			</div>
		</aside>

		<!-- Canvas -->
		<section class="bg-muted/40 min-h-0 flex-1 overflow-y-auto p-3 lg:p-6">
			<div
				use:dndzone={{ items: blocks, flipDurationMs: 150 }}
				onconsider={handleDnd}
				onfinalize={handleDnd}
				class="mx-auto flex w-full max-w-xl flex-col gap-2"
			>
				{#each blocks as block (block.id)}
					<div animate:flip={{ duration: 150 }} class="bg-card flex items-start gap-2 rounded-lg border p-2.5 shadow-sm">
						<GripVerticalIcon class="text-muted-foreground mt-1 size-4 shrink-0 cursor-grab" />
						<div class="flex min-w-0 flex-1 flex-col gap-1.5">
							<Badge variant="secondary" class="w-fit capitalize">{block.type}</Badge>
							{#if block.type === 'heading'}
								<Textarea bind:value={block.text} rows={2} />
								<div class="flex gap-1.5">
									<select bind:value={block.level} class="border-input bg-background h-8 rounded-md border px-2 text-xs">
										<option value={1}>H1</option>
										<option value={2}>H2</option>
										<option value={3}>H3</option>
									</select>
									<select bind:value={block.align} class="border-input bg-background h-8 rounded-md border px-2 text-xs">
										<option value={undefined}>Left</option>
										<option value="center">Center</option>
										<option value="right">Right</option>
									</select>
								</div>
							{:else if block.type === 'text'}
								<Textarea bind:value={block.text} rows={2} />
								<select bind:value={block.align} class="border-input bg-background h-8 w-fit rounded-md border px-2 text-xs">
									<option value={undefined}>Left</option>
									<option value="center">Center</option>
									<option value="right">Right</option>
								</select>
							{:else if block.type === 'quote'}
								<Textarea bind:value={block.text} rows={2} />
							{:else if block.type === 'button'}
								<Input bind:value={block.text} placeholder="Label" />
								<Input bind:value={block.href} placeholder="https://…" />
							{:else if block.type === 'image'}
								<div class="flex gap-1.5">
									<Input bind:value={block.src} placeholder="Image URL or upload →" class="min-w-0 flex-1" />
									<Button size="sm" variant="outline" class="shrink-0" onclick={() => pickImage((url) => (block.src = url))}>
										<UploadIcon class="mr-1 size-3.5" /> Upload
									</Button>
								</div>
								<Input bind:value={block.alt} placeholder="Alt text" />
							{:else if block.type === 'list'}
								<Textarea
									value={block.items.join('\n')}
									oninput={(e) => (block.items = e.currentTarget.value.split('\n'))}
									rows={3}
									placeholder="One item per line"
								/>
								<label class="flex items-center gap-1.5 text-xs">
									<input type="checkbox" bind:checked={block.ordered} /> Numbered
								</label>
							{:else if block.type === 'columns'}
								<div class="grid grid-cols-2 gap-1.5">
									<Textarea bind:value={block.left} rows={3} placeholder="Left" />
									<Textarea bind:value={block.right} rows={3} placeholder="Right" />
								</div>
							{:else if block.type === 'hero'}
								<div class="flex gap-1.5">
									<Input bind:value={block.src} placeholder="Background image URL" class="min-w-0 flex-1" />
									<Button size="sm" variant="outline" class="shrink-0" onclick={() => pickImage((url) => (block.src = url))}>
										<UploadIcon class="mr-1 size-3.5" /> Upload
									</Button>
								</div>
								<Input bind:value={block.heading} placeholder="Heading" />
								<Input bind:value={block.text} placeholder="Subtext (optional)" />
								<div class="grid grid-cols-2 gap-1.5">
									<Input bind:value={block.buttonText} placeholder="Button label (optional)" />
									<Input bind:value={block.buttonHref} placeholder="Button URL" />
								</div>
							{:else if block.type === 'social'}
								<div class="flex flex-col gap-1.5">
									{#each block.items as item, i (i)}
										<div class="flex gap-1.5">
											<select bind:value={item.network} class="border-input bg-background h-8 rounded-md border px-2 text-xs capitalize">
												{#each SOCIALS as s (s)}<option value={s}>{s}</option>{/each}
											</select>
											<Input bind:value={item.href} placeholder="https://…" class="h-8" />
											<Button size="icon" variant="ghost" class="size-8 shrink-0" onclick={() => (block.items = block.items.filter((_, j) => j !== i))} aria-label="Remove link">
												<Trash2Icon class="size-3.5" />
											</Button>
										</div>
									{/each}
									<Button size="sm" variant="outline" class="w-fit" onclick={() => (block.items = [...block.items, { network: 'web', href: 'https://' }])}>
										+ Link
									</Button>
								</div>
							{:else if block.type === 'spacer'}
								<Input type="number" bind:value={block.height} placeholder="Height (px)" />
							{:else if block.type === 'html'}
								<CodeEditor bind:value={block.html} language="markup" rows={4} placeholder="<p>Raw HTML…</p>" />
							{:else}
								<span class="text-muted-foreground text-xs">Horizontal rule.</span>
							{/if}
							<details class="mt-0.5">
								<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] select-none">Custom CSS</summary>
								<div class="mt-1">
									<CodeEditor bind:value={block.css} language="css" rows={3} placeholder="background:#f4f4f4; padding:24px;" />
								</div>
							</details>
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
					<div class="text-muted-foreground rounded-xl border-2 border-dashed p-10 text-center text-sm">
						Pick a block from the left to start building.
					</div>
				{/if}
			</div>
		</section>

		<!-- Live preview -->
		<section class="bg-background flex min-h-0 flex-1 flex-col border-t p-3 lg:border-t-0 lg:border-l lg:p-6">
			{#if previewHtml}
				<div class="flex min-h-0 flex-1 justify-center">
					<iframe
						title="Template preview"
						srcdoc={previewHtml}
						class="h-full min-h-[24rem] w-full rounded-md border bg-white shadow-sm transition-all {device === 'mobile' ? 'max-w-[380px]' : 'max-w-2xl'}"
					></iframe>
				</div>
			{:else if previewError}
				<p class="text-muted-foreground m-auto max-w-xs text-center text-sm">
					Couldn't render the preview. Editing still works — check the browser console for details.
				</p>
			{:else}
				<p class="text-muted-foreground m-auto text-center text-sm">
					Add a block — the preview updates as you type.
				</p>
			{/if}
		</section>
	</div>
</div>
