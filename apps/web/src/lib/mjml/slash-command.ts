// SPDX-License-Identifier: Apache-2.0
/**
 * Tiptap `/` slash-command extension (Resend-style) — type `/` in the canvas to
 * open a keyboard-navigable insert menu. Items are supplied by the editor
 * component; the popup is plain DOM (styled via :global(.slash-menu) tokens in
 * email-editor.svelte) appended to <body>, positioned at the caret.
 */
import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';

export type SlashItem = {
	title: string;
	/** Run after the `/query` range is available — delete it, then insert. */
	action: (editor: Editor, range: Range) => void;
};

export const SlashCommand = Extension.create<{ items: SlashItem[] }>({
	name: 'slashCommand',
	addOptions() {
		return { items: [] };
	},
	addProseMirrorPlugins() {
		const all = () => this.options.items;
		return [
			Suggestion<SlashItem>({
				editor: this.editor,
				char: '/',
				startOfLine: false,
				allowSpaces: false,
				command: ({ editor, range, props }) => props.action(editor, range),
				items: ({ query }) =>
					all()
						.filter((i) => i.title.toLowerCase().includes(query.toLowerCase()))
						.slice(0, 12),
				render: () => {
					let popup: HTMLDivElement | null = null;
					let items: SlashItem[] = [];
					let idx = 0;
					let pick: (item: SlashItem) => void = () => {};

					const paint = () => {
						if (!popup) return;
						popup.innerHTML = '';
						if (!items.length) {
							const empty = document.createElement('div');
							empty.className = 'slash-empty';
							empty.textContent = 'No match';
							popup.appendChild(empty);
							return;
						}
						items.forEach((it, i) => {
							const b = document.createElement('button');
							b.type = 'button';
							b.className = 'slash-item' + (i === idx ? ' is-active' : '');
							b.textContent = it.title;
							b.addEventListener('mousedown', (e) => {
								e.preventDefault();
								pick(it);
							});
							b.addEventListener('mouseenter', () => {
								idx = i;
								paint();
							});
							popup!.appendChild(b);
						});
						// Keep the active item visible when arrow-navigating past the fold.
						(popup.children[idx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
					};

					const place = (rect: DOMRect | null | undefined) => {
						if (!popup || !rect) return;
						popup.style.top = `${rect.bottom + 6}px`;
						popup.style.left = `${rect.left}px`;
					};

					return {
						onStart: (props) => {
							items = props.items;
							idx = 0;
							pick = (item) => props.command(item);
							popup = document.createElement('div');
							popup.className = 'slash-menu';
							document.body.appendChild(popup);
							paint();
							place(props.clientRect?.());
						},
						onUpdate: (props) => {
							items = props.items;
							idx = 0;
							pick = (item) => props.command(item);
							paint();
							place(props.clientRect?.());
						},
						onKeyDown: (props) => {
							const e = props.event;
							const n = items.length;
							if (e.key === 'ArrowDown') {
								if (n) idx = (idx + 1) % n;
								paint();
								return true;
							}
							if (e.key === 'ArrowUp') {
								if (n) idx = (idx - 1 + n) % n;
								paint();
								return true;
							}
							if (e.key === 'Enter') {
								if (items[idx]) pick(items[idx]);
								return true;
							}
							if (e.key === 'Escape') return true;
							return false;
						},
						onExit: () => {
							popup?.remove();
							popup = null;
						}
					};
				}
			})
		];
	}
});
