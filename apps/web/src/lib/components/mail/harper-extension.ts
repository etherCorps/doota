// SPDX-License-Identifier: Apache-2.0
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Linter, Lint } from 'harper.js';

// Harper grammar/spell check as a ProseMirror decoration layer.
//
// harper.js is a ~17 MB WASM engine. We never import it at module load: the
// linter is created on first use via dynamic import, so SSR and the cold inbox
// pay nothing and only the first composer to mount triggers the (browser-cached)
// download. One WorkerLinter is shared across every editor — the worker keeps
// the WASM off the main thread, so typing never janks.

export interface HarperSuggestion {
	text: string;
	kind: 'replace' | 'remove' | 'insert';
}
export interface HarperLint {
	from: number; // ProseMirror position, inclusive
	to: number; // ProseMirror position, exclusive
	message: string;
	kind: string; // e.g. 'Spelling', 'Grammar', 'Punctuation'
	suggestions: HarperSuggestion[];
}

let linterPromise: Promise<Linter> | null = null;
async function getLinter(): Promise<Linter> {
	if (!linterPromise) {
		linterPromise = (async () => {
			const [{ WorkerLinter }, { binary }] = await Promise.all([
				import('harper.js'),
				import('harper.js/binary')
			]);
			const linter = new WorkerLinter({ binary });
			await linter.setup();
			return linter;
		})();
	}
	return linterPromise;
}

/**
 * Flatten the doc to plaintext and remember, per character, the ProseMirror
 * position it came from. Block boundaries become newlines (position -1) so
 * Harper sees paragraph breaks and doesn't merge sentences across them.
 *
 * ponytail: offsets are UTF-16 units; Harper spans are Unicode scalar indices.
 * They agree for BMP text (all of normal prose) and drift only past astral
 * chars (emoji). Fix when someone reports a mis-underlined emoji sentence.
 */
function extractText(doc: PMNode): { text: string; map: number[] } {
	let text = '';
	const map: number[] = [];
	doc.descendants((node, pos) => {
		if (node.isText && node.text) {
			const t = node.text;
			for (let i = 0; i < t.length; i++) map[text.length + i] = pos + i;
			text += t;
		} else if (node.isBlock && text.length > 0 && text[text.length - 1] !== '\n') {
			map[text.length] = -1;
			text += '\n';
		}
		return true;
	});
	return { text, map };
}

function suggKind(k: number): HarperSuggestion['kind'] {
	return k === 1 ? 'remove' : k === 2 ? 'insert' : 'replace'; // SuggestionKind: Replace=0, Remove=1, InsertAfter=2
}

function mapLint(l: Lint, map: number[]): HarperLint | null {
	const span = l.span();
	const from = map[span.start];
	const to = span.end > 0 ? map[span.end - 1] : undefined;
	if (from == null || from < 0 || to == null || to < 0 || to + 1 <= from) return null;
	return {
		from,
		to: to + 1,
		message: l.message(),
		kind: l.lint_kind(),
		suggestions: l.suggestions().map((s) => ({ text: s.get_replacement_text(), kind: suggKind(s.kind()) }))
	};
}

export interface ActiveLint {
	lint: HarperLint;
	left: number;
	top: number;
	bottom: number;
}
export interface HarperOptions {
	debounceMs: number;
	onStatus?: (s: 'loading' | 'ready' | 'error') => void;
	onCount?: (n: number) => void;
	/** Fired when an underlined word is clicked (payload) or the click misses (null). */
	onActiveLint?: (payload: ActiveLint | null) => void;
}

interface HarperState {
	deco: DecorationSet; // grammar/spell underlines
	lints: HarperLint[];
	flash: DecorationSet; // transient green "fixed" highlights
}
type HarperMeta =
	| { type: 'lints'; deco: DecorationSet; lints: HarperLint[] }
	| { type: 'flashAdd'; deco: Decoration }
	| { type: 'flashClear' };
const harperKey = new PluginKey<HarperState>('harper');

// ponytail: one shared flash timer; a rapid second fix just fades the first early.
let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** Apply a chosen suggestion, then flash the corrected span green. */
export function applyHarperFix(view: EditorView, lint: HarperLint, s: HarperSuggestion): void {
	const tr = view.state.tr;
	let from = lint.from;
	let to = lint.from;
	if (s.kind === 'remove') {
		view.dispatch(tr.delete(lint.from, lint.to));
	} else if (s.kind === 'insert') {
		view.dispatch(tr.insertText(s.text, lint.to));
		from = lint.to;
		to = lint.to + s.text.length;
	} else {
		view.dispatch(tr.insertText(s.text, lint.from, lint.to));
		to = lint.from + s.text.length;
	}
	view.focus();
	if (to > from) {
		const fdeco = Decoration.inline(from, to, { class: 'harper-fixed' });
		view.dispatch(view.state.tr.setMeta(harperKey, { type: 'flashAdd', deco: fdeco } satisfies HarperMeta));
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(
			() => view.dispatch(view.state.tr.setMeta(harperKey, { type: 'flashClear' } satisfies HarperMeta)),
			1100
		);
	}
}

export const HarperGrammar = Extension.create<HarperOptions>({
	name: 'harperGrammar',
	addOptions() {
		return { debounceMs: 500 };
	},
	addProseMirrorPlugins() {
		const options = this.options;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let runToken = 0;
		let announcedReady = false;

		return [
			new Plugin<HarperState>({
				key: harperKey,
				state: {
					init: () => ({ deco: DecorationSet.empty, lints: [], flash: DecorationSet.empty }),
					apply(tr, value) {
						const meta = tr.getMeta(harperKey) as HarperMeta | undefined;
						// Remap both layers across the edit, then fold in any meta.
						let deco = value.deco.map(tr.mapping, tr.doc);
						let flash = value.flash.map(tr.mapping, tr.doc);
						let lints = value.lints;
						if (meta?.type === 'lints') {
							deco = meta.deco;
							lints = meta.lints;
						} else if (meta?.type === 'flashAdd') {
							flash = flash.add(tr.doc, [meta.deco]);
						} else if (meta?.type === 'flashClear') {
							flash = DecorationSet.empty;
						}
						return { deco, lints, flash };
					}
				},
				props: {
					decorations(state) {
						const s = harperKey.getState(state);
						if (!s) return undefined;
						// Merge underlines + green flash into one set for rendering.
						return s.deco.add(state.doc, s.flash.find());
					},
					handleClick(view, pos) {
						const st = harperKey.getState(view.state);
						const hit = st?.lints.find((l) => pos >= l.from && pos < l.to);
						if (!hit || !hit.suggestions.length) {
							options.onActiveLint?.(null);
							return false;
						}
						const c = view.coordsAtPos(hit.from);
						options.onActiveLint?.({ lint: hit, left: c.left, top: c.top, bottom: c.bottom });
						return false;
					}
				},
				view(view) {
					const run = async () => {
						const token = ++runToken;
						const { text, map } = extractText(view.state.doc);
						if (!text.trim()) {
							view.dispatch(view.state.tr.setMeta(harperKey, { type: 'lints', deco: DecorationSet.empty, lints: [] } satisfies HarperMeta));
							options.onCount?.(0);
							return;
						}
						try {
							const linter = await getLinter();
							if (!announcedReady) {
								announcedReady = true;
								options.onStatus?.('ready');
							}
							const raw = await linter.lint(text, { language: 'plaintext' });
							if (token !== runToken) return; // a newer run superseded this one
							const lints: HarperLint[] = [];
							const decos: Decoration[] = [];
							for (const l of raw) {
								const ml = mapLint(l, map);
								if (!ml) continue;
								lints.push(ml);
								decos.push(
									Decoration.inline(ml.from, ml.to, {
										class: `harper-underline harper-${ml.kind.toLowerCase()}`,
										nodeName: 'span'
									})
								);
							}
							const deco = DecorationSet.create(view.state.doc, decos);
							view.dispatch(view.state.tr.setMeta(harperKey, { type: 'lints', deco, lints } satisfies HarperMeta));
							options.onCount?.(lints.length);
						} catch (e) {
							options.onStatus?.('error');
							console.error('[harper] lint failed', e);
						}
					};
					const schedule = () => {
						if (timer) clearTimeout(timer);
						timer = setTimeout(run, options.debounceMs);
					};

					options.onStatus?.('loading');
					// Warm the linter at idle, off the debounce and off the main thread:
					// the 17 MB WASM downloads/compiles in the worker the moment an editor
					// mounts, so it's ready before the user finishes their first word (and the
					// pill flips to ready even on an empty composer). Idempotent — getLinter()
					// is memoised, so every editor shares one download.
					const idle =
						typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 200);
					idle(() => {
						getLinter()
							.then(() => {
								if (!announcedReady) {
									announcedReady = true;
									options.onStatus?.('ready');
								}
							})
							.catch((e) => {
								options.onStatus?.('error');
								console.error('[harper] warm failed', e);
							});
					});
					schedule(); // seed pass — a reply mounts with quoted text already present

					return {
						update(v, prev) {
							if (!prev.doc.eq(v.state.doc)) schedule();
						},
						destroy() {
							if (timer) clearTimeout(timer);
							if (flashTimer) clearTimeout(flashTimer);
						}
					};
				}
			})
		];
	}
});
