<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// CodeMirror 6 code field for the template builder — syntax highlighting +
	// language autocomplete (CSS properties/values, HTML tags/attrs), bracket
	// matching, line numbers. Client-only (constructed in onMount). Used for
	// per-block/global custom CSS and raw-HTML blocks.
	import { onMount } from 'svelte';
	import { EditorView, basicSetup } from 'codemirror';
	import { EditorState } from '@codemirror/state';
	import { placeholder as cmPlaceholder } from '@codemirror/view';
	import { css } from '@codemirror/lang-css';
	import { html } from '@codemirror/lang-html';

	// No `$bindable` fallback: callers bind optional fields (e.g. a block's `css`,
	// undefined until edited) — a fallback makes Svelte throw on an undefined bind.
	let {
		value = $bindable(),
		language = 'css',
		rows = 4,
		placeholder = ''
	}: {
		value?: string;
		language?: 'css' | 'markup';
		rows?: number;
		placeholder?: string;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;
	// True while WE apply an external value change, so the update listener doesn't
	// echo it back to the parent.
	let applyingExternal = false;

	onMount(() => {
		const langExt = language === 'markup' ? html() : css();
		const theme = EditorView.theme({
			'&': { fontSize: '12px', backgroundColor: 'transparent' },
			'.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '8px 0', caretColor: 'var(--foreground)' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
			'.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent)' },
			'.cm-scroller': { minHeight: `${rows * 1.5}em`, maxHeight: '18rem', overflow: 'auto' },
			'.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted-foreground)' },
			'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
			'&.cm-focused': { outline: 'none' },
			// Autocomplete dropdown → match the app's popover/menu styling.
			'.cm-tooltip': {
				backgroundColor: 'var(--popover)',
				color: 'var(--popover-foreground)',
				border: '1px solid var(--border)',
				borderRadius: '8px',
				boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)',
				overflow: 'hidden'
			},
			'.cm-tooltip.cm-tooltip-autocomplete > ul': {
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: '12px',
				maxHeight: '14rem',
				padding: '4px'
			},
			'.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
				padding: '3px 8px',
				borderRadius: '5px',
				lineHeight: '1.5'
			},
			'.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
				backgroundColor: 'var(--accent)',
				color: 'var(--accent-foreground)'
			},
			'.cm-completionMatchedText': {
				color: 'var(--primary)',
				textDecoration: 'none',
				fontWeight: '600'
			},
			'.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal' },
			'.cm-completionIcon': { color: 'var(--muted-foreground)', opacity: '0.7' }
		});
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value ?? '',
				extensions: [
					basicSetup,
					langExt,
					theme,
					cmPlaceholder(placeholder),
					EditorView.lineWrapping,
					EditorView.updateListener.of((u) => {
						if (u.docChanged && !applyingExternal) value = u.state.doc.toString();
					})
				]
			})
		});
		return () => view?.destroy();
	});

	// Reflect external value changes (e.g. an image upload setting a field) into
	// the editor without clobbering the user's cursor on their own edits.
	$effect(() => {
		const next = value ?? '';
		if (view && next !== view.state.doc.toString()) {
			applyingExternal = true;
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
			applyingExternal = false;
		}
	});
</script>

<div bind:this={host} class="border-input bg-background overflow-hidden rounded-md border"></div>
