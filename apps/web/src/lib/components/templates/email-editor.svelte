<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Resend-style WYSIWYG email editor (docs/service-accounts.md § Builder).
	// Tiptap (vanilla core, mounted in Svelte) inline canvas + insert rail +
	// contextual config panel. Doc serializes to MJML → MRML → HTML on save; the
	// send path stays un-jinja only.
	import { onMount, untrack, type Component } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Link from '@tiptap/extension-link';
	import Placeholder from '@tiptap/extension-placeholder';
	import TextAlign from '@tiptap/extension-text-align';
	import { TextStyle } from '@tiptap/extension-text-style';
	import { Color } from '@tiptap/extension-color';
	import { NodeSelection } from '@tiptap/pm/state';

	// TextStyle + a fontSize attribute (Color augments the same `textStyle` mark).
	const FontSize = TextStyle.extend({
		addAttributes() {
			return {
				...this.parent?.(),
				fontSize: {
					default: null,
					parseHTML: (el: HTMLElement) => el.style.fontSize || null,
					renderHTML: (attrs: { fontSize?: string }) =>
						attrs.fontSize ? { style: `font-size:${attrs.fontSize}` } : {}
				}
			};
		}
	});
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import CodeEditor from './code-editor.svelte';
	import { EMAIL_NODES } from '$lib/mjml/tiptap-nodes';
	import { SlashCommand, type SlashItem } from '$lib/mjml/slash-command';
	import { tiptapToMjml, tiptapVariables, type TiptapDoc, type PageSettings, type Theme, type ThemeType } from '$lib/mjml/tiptap-mjml';
	import { compileMjml } from '$lib/mjml/compile.client';
	import { render as renderJinja } from '@ethercorps/un-jinja';
	import { BUILTIN_VARIABLES, variablesSchemaJson } from '$lib/mjml/variables';
	import { opfsWrite, opfsRead, opfsDelete } from '$lib/client/opfs-cache';
	import { createOrgTemplate, updateOrgTemplate } from '$lib/rpc/template.remote';
	import { sendMessage } from '$lib/rpc/send.remote';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import CodeIcon from '@lucide/svelte/icons/code';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';
	import TypeIcon from '@lucide/svelte/icons/type';
	import HeadingIcon from '@lucide/svelte/icons/heading';
	import ImageIcon from '@lucide/svelte/icons/image';
	import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
	import Columns2Icon from '@lucide/svelte/icons/columns-2';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import Columns4Icon from '@lucide/svelte/icons/columns-4';
	import PanelBottomIcon from '@lucide/svelte/icons/panel-bottom';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import PanelTopIcon from '@lucide/svelte/icons/panel-top';
	import Share2Icon from '@lucide/svelte/icons/share-2';
	import MoveVerticalIcon from '@lucide/svelte/icons/move-vertical';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import ListIcon from '@lucide/svelte/icons/list';
	import LinkIcon from '@lucide/svelte/icons/link';
	import AlignLeftIcon from '@lucide/svelte/icons/align-left';
	import AlignCenterIcon from '@lucide/svelte/icons/align-center';
	import AlignRightIcon from '@lucide/svelte/icons/align-right';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import XIcon from '@lucide/svelte/icons/x';
	import SendIcon from '@lucide/svelte/icons/send';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { page } from '$app/state';
	import { unsubscribeUrlFor } from '@doota/mail-core/unsubscribe';

	let {
		orgId,
		templateId = null,
		initialName = '',
		initialSubject = '',
		initialDoc = null,
		initialSettings = {}
	}: {
		orgId: string;
		templateId?: string | null;
		initialName?: string;
		initialSubject?: string;
		initialDoc?: TiptapDoc | null;
		initialSettings?: PageSettings;
	} = $props();

	let name = $state(untrack(() => initialName));
	let subject = $state(untrack(() => initialSubject));
	let previewText = $state(untrack(() => initialSettings.preview ?? ''));
	let background = $state(untrack(() => initialSettings.background ?? '#ffffff'));
	let width = $state(untrack(() => initialSettings.width ?? 600));
	let globalCss = $state(untrack(() => initialSettings.css ?? ''));
	let theme = $state<Theme>(untrack(() => initialSettings.theme ?? {}));
	let saving = $state(false);
	let view: 'edit' | 'code' = $state('edit');
	let codeHtml = $state('');
	const cssPlaceholder = `/* Style your email with global selectors:
   p { color: #333; }
   …or a custom class on a block:
   .cta { background: #4f46e5; } */`;

	// Selected block (a NodeSelection) → drives the contextual config panel.
	let sel = $state<{ type: string; pos: number; attrs: Record<string, unknown> } | null>(null);

	let editorEl = $state<HTMLDivElement>();
	let editor: Editor | undefined;
	// Unsaved-changes guard. `dirty` flips on any doc/name/subject/settings edit
	// (set from the Tiptap transaction hook + reactive field bindings) and clears
	// on save. `saved` tracks whether this template has ever been persisted.
	let dirty = $state(false);
	let saved = $state(untrack(() => templateId != null));
	let ready = $state(false);
	function markDirty() {
		dirty = true;
	}
	$effect(() => {
		// Touch the reactive fields so typing in name/subject/preview/settings marks dirty.
		void name;
		void subject;
		void previewText;
		void background;
		void width;
		void globalCss;
		void theme;
		if (ready) markDirty();
	});
	$effect(() => {
		if (!dirty) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	});
	beforeNavigate((nav) => {
		if (!dirty) return;
		if (!confirm('You have unsaved changes. Leave without saving?')) nav.cancel();
	});
	// The 3-pane builder can't work on a phone — gate it (see the mobile block in
	// the markup). Templates list + preview stay reachable everywhere.
	const mobile = new IsMobile();

	// OPFS draft cache — templates can be large, so persist to disk (crash-safe).
	const draftKey = untrack(() => `tmpl-draft-${templateId ?? 'new'}.json`);
	let draftTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleDraft() {
		if (draftTimer) clearTimeout(draftTimer);
		draftTimer = setTimeout(() => {
			if (!editor) return;
			void opfsWrite(draftKey, JSON.stringify({ doc: editor.getJSON(), name, subject, settings: settings() }));
		}, 900);
	}

	// `/` slash-command items — convert the current block or insert a new one.
	const SLASH_ITEMS: SlashItem[] = [
		{ title: 'Text', action: (e, range) => e.chain().focus().deleteRange(range).setParagraph().run() },
		{ title: 'Heading 1', action: (e, range) => e.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run() },
		{ title: 'Heading 2', action: (e, range) => e.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run() },
		{ title: 'Heading 3', action: (e, range) => e.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run() },
		{ title: 'Bullet list', action: (e, range) => e.chain().focus().deleteRange(range).toggleBulletList().run() },
		{ title: 'Numbered list', action: (e, range) => e.chain().focus().deleteRange(range).toggleOrderedList().run() },
		{ title: 'Image', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'emImage' }).run() },
		{ title: 'Button', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'button' }).run() },
		{ title: '2 columns', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'columns', content: [{ type: 'column', content: [{ type: 'paragraph' }] }, { type: 'column', content: [{ type: 'paragraph' }] }] }).run() },
		{ title: '3 columns', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'columns', content: [{ type: 'column', content: [{ type: 'paragraph' }] }, { type: 'column', content: [{ type: 'paragraph' }] }, { type: 'column', content: [{ type: 'paragraph' }] }] }).run() },
		{ title: 'Hero', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'hero' }).run() },
		{ title: 'Social', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'social' }).run() },
		{ title: 'Spacer', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'spacer' }).run() },
		{ title: 'Divider', action: (e, range) => e.chain().focus().deleteRange(range).setHorizontalRule().run() },
		{ title: 'Footer', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'footer' }).run() },
		{ title: 'HTML', action: (e, range) => e.chain().focus().deleteRange(range).insertContent({ type: 'htmlBlock' }).run() }
	];

	function refreshSel() {
		if (!editor) return;
		const s = editor.state.selection;
		sel =
			s instanceof NodeSelection
				? { type: s.node.type.name, pos: s.from, attrs: { ...s.node.attrs } }
				: null;
	}

	onMount(() => {
		// Mobile shows the "needs a bigger screen" gate — editorEl isn't rendered,
		// so don't spin up Tiptap. (Resize→desktop needs a reload; acceptable.)
		if (mobile.current || !editorEl) return;
		editor = new Editor({
			element: editorEl,
			extensions: [
				StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
				Link.configure({ openOnClick: false }),
				Placeholder.configure({ placeholder: "Press '/' for commands, or just start writing…" }),
				TextAlign.configure({ types: ['heading', 'paragraph'] }),
				FontSize,
				Color,
				SlashCommand.configure({ items: SLASH_ITEMS }),
				...EMAIL_NODES
			],
			content: initialDoc ?? '',
			editorProps: { attributes: { class: 'email-doc focus:outline-none' } },
			onSelectionUpdate: refreshSel,
			onTransaction: ({ transaction }) => {
				refreshSel();
				scheduleDraft();
				if (ready && transaction.docChanged) markDirty();
			}
		});
		// Restore an unsaved local draft for a NEW template (crash recovery).
		if (!initialDoc) {
			void (async () => {
				const raw = await opfsRead(draftKey);
				if (!raw || !editor) return;
				try {
					const d = JSON.parse(raw);
					if (!d?.doc?.content?.length) return;
					editor.commands.setContent(d.doc);
					if (d.name) name = d.name;
					if (d.subject) subject = d.subject;
					if (d.settings) {
						background = d.settings.background ?? background;
						width = d.settings.width ?? width;
						previewText = d.settings.preview ?? previewText;
						globalCss = d.settings.css ?? globalCss;
						if (d.settings.theme) theme = d.settings.theme;
					}
					toast.info('Restored your unsaved draft.');
				} catch {
					// ignore malformed cache
				}
			})();
		}
		ready = true;
		return () => editor?.destroy();
	});

	// ---- insert rail ----------------------------------------------------------
	function ins(node: Record<string, unknown>) {
		editor?.chain().focus().insertContent(node).run();
	}
	type MenuItem = { label: string; icon: Component; run: () => void };
	const colsN = (n: number) => ins({ type: 'columns', content: Array.from({ length: n }, () => ({ type: 'column', content: [{ type: 'paragraph' }] })) });
	// Grouped insert menus (Resend-style flyouts off the pill).
	const GROUPS: { key: string; label: string; icon: Component; items: MenuItem[] }[] = [
		{
			key: 'text',
			label: 'Text',
			icon: TypeIcon,
			items: [
				{ label: 'Text', icon: TypeIcon, run: () => ins({ type: 'paragraph' }) },
				{ label: 'Title', icon: HeadingIcon, run: () => ins({ type: 'heading', attrs: { level: 1 } }) },
				{ label: 'Subtitle', icon: HeadingIcon, run: () => ins({ type: 'heading', attrs: { level: 2 } }) },
				{ label: 'Heading', icon: HeadingIcon, run: () => ins({ type: 'heading', attrs: { level: 3 } }) },
				{ label: 'Bullet list', icon: ListIcon, run: () => editor?.chain().focus().toggleBulletList().run() },
				{ label: 'Numbered list', icon: ListIcon, run: () => editor?.chain().focus().toggleOrderedList().run() }
			]
		},
		{ key: 'media', label: 'Media', icon: ImageIcon, items: [{ label: 'Image', icon: ImageIcon, run: () => ins({ type: 'emImage' }) }] },
		{
			key: 'layout',
			label: 'Layout',
			icon: LayoutGridIcon,
			items: [
				{ label: 'Button', icon: MousePointerClickIcon, run: () => ins({ type: 'button' }) },
				{ label: 'Divider', icon: MinusIcon, run: () => editor?.chain().focus().setHorizontalRule().run() },
				{ label: '2 columns', icon: Columns2Icon, run: () => colsN(2) },
				{ label: '3 columns', icon: Columns3Icon, run: () => colsN(3) },
				{ label: '4 columns', icon: Columns4Icon, run: () => colsN(4) },
				{ label: 'Hero', icon: PanelTopIcon, run: () => ins({ type: 'hero' }) },
				{ label: 'Social', icon: Share2Icon, run: () => ins({ type: 'social' }) },
				{ label: 'Spacer', icon: MoveVerticalIcon, run: () => ins({ type: 'spacer' }) },
				{ label: 'Footer', icon: PanelBottomIcon, run: () => ins({ type: 'footer' }) },
				{ label: 'HTML', icon: CodeIcon, run: () => ins({ type: 'htmlBlock' }) }
			]
		}
	];
	let openMenu = $state<string | null>(null);
	function pick(run: () => void) {
		run();
		openMenu = null;
	}
	function insVar(nameStr: string) {
		editor?.chain().focus().insertContent({ type: 'variable', attrs: { name: nameStr } }).run();
		openMenu = null;
	}
	const customVars = $derived(
		editor ? tiptapVariables(editor.getJSON() as TiptapDoc, subject).filter((variable) => !BUILTIN_VARIABLES.some((builtin) => builtin.name === variable)) : []
	);

	// ---- contextual config ----------------------------------------------------
	function setAttr(key: string, value: unknown) {
		if (!sel || !editor) return;
		sel.attrs[key] = value;
		editor.chain().setNodeSelection(sel.pos).updateAttributes(sel.type, { [key]: value }).run();
	}
	// Block nodes that render as an mj-section → get Background/Spacing/Border controls.
	const SECTION_TYPES = new Set(['button', 'emImage', 'spacer', 'hero', 'social', 'htmlBlock', 'columns', 'footer']);
	const TYPE_LABEL: Record<string, string> = {
		button: 'Button',
		emImage: 'Image',
		spacer: 'Spacer',
		hero: 'Hero',
		social: 'Social',
		htmlBlock: 'HTML',
		variable: 'Variable',
		columns: 'Columns',
		footer: 'Footer'
	};
	// Social-network editing (the config panel's add/remove/edit rows).
	const SOCIAL_NETWORKS = ['github', 'twitter', 'x', 'facebook', 'instagram', 'linkedin', 'youtube', 'web'];
	type SocialItem = { network: string; href: string };
	function socialItems(): SocialItem[] {
		return Array.isArray(sel?.attrs.items) ? (sel!.attrs.items as SocialItem[]) : [];
	}
	function updateSocial(i: number, key: keyof SocialItem, value: string) {
		const items = socialItems().map((item, index) => (index === i ? { ...item, [key]: value } : item));
		setAttr('items', items);
	}
	function addSocial() {
		setAttr('items', [...socialItems(), { network: 'github', href: 'https://' }]);
	}
	function removeSocial(i: number) {
		setAttr('items', socialItems().filter((_, index) => index !== i));
	}
	function deleteSelected() {
		editor?.chain().focus().deleteSelection().run();
		sel = null;
	}
	function uploadInto(key: string) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/png,image/jpeg,image/gif,image/webp';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const fd = new FormData();
			fd.append('orgId', orgId);
			fd.append('file', file);
			const req = fetch('/api/template-assets', { method: 'POST', body: fd }).then(async (response) => {
				if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? 'Upload failed.');
				return (await response.json()) as { url: string };
			});
			toast.promise(req, { loading: 'Uploading…', success: 'Uploaded.', error: (e) => (e instanceof Error ? e.message : 'Upload failed.') });
			try {
				setAttr(key, (await req).url);
			} catch {
				// surfaced by toast
			}
		};
		input.click();
	}

	// ---- publish --------------------------------------------------------------
	function settings(): PageSettings {
		const th = $state.snapshot(theme);
		return { background, width: Number(width) || 600, preview: previewText || undefined, css: globalCss || undefined, theme: Object.keys(th).length ? th : undefined };
	}
	// ---- theme (per-type typography defaults) ---------------------------------
	const THEME_ROLES: { key: keyof Theme; label: string }[] = [
		{ key: 'text', label: 'Text' },
		{ key: 'title', label: 'Title' },
		{ key: 'subtitle', label: 'Subtitle' },
		{ key: 'heading', label: 'Heading' }
	];
	function setTheme(role: keyof Theme, key: keyof ThemeType, value: string | number | undefined) {
		const next: ThemeType = { ...(theme[role] ?? {}) };
		if (value === undefined || value === '' || value === 0) delete next[key];
		else (next[key] as string | number) = value;
		theme = { ...theme, [role]: next };
	}
	function cssVar(name: string, val: string | number | undefined, unit = ''): string {
		return val != null && val !== '' ? `${name}:${val}${unit}` : '';
	}
	const themeVars = $derived(
		THEME_ROLES.flatMap(({ key }) => {
			const t = theme[key] ?? {};
			const p = key === 'text' ? 'p' : key === 'title' ? 'h1' : key === 'subtitle' ? 'h2' : 'h3';
			return [
				cssVar(`--th-${p}-color`, t.color),
				cssVar(`--th-${p}-size`, t.size, 'px'),
				cssVar(`--th-${p}-weight`, t.weight),
				cssVar(`--th-${p}-lh`, t.lineHeight)
			];
		})
			.filter(Boolean)
			.join(';')
	);
	function currentDoc(): TiptapDoc {
		return (editor?.getJSON() as TiptapDoc) ?? { type: 'doc', content: [] };
	}
	async function toggleCode() {
		if (view === 'edit') {
			try {
				codeHtml = await compileMjml(tiptapToMjml(currentDoc(), settings()));
				view = 'code';
			} catch (e) {
				toast.error(e instanceof Error ? e.message : 'Could not compile.');
			}
		} else view = 'edit';
	}
	async function save() {
		if (!name.trim()) {
			toast.error('Give the template a name.');
			return;
		}
		saving = true;
		const doc = currentDoc();
		let compiledHtml: string;
		try {
			compiledHtml = await compileMjml(tiptapToMjml(doc, settings()));
		} catch (e) {
			saving = false;
			toast.error(e instanceof Error ? e.message : 'Could not compile the template.');
			return;
		}
		const variablesSchema = variablesSchemaJson(tiptapVariables(doc, subject));
		const editorJson = JSON.stringify({ v: 2, doc, settings: settings() });
		const payload = { name, subjectTemplate: subject, editorJson, compiledHtml, variablesSchema };
		const req = templateId ? updateOrgTemplate({ templateId, ...payload }) : createOrgTemplate({ orgId, ...payload });
		toast.promise(req as Promise<unknown>, {
			loading: 'Publishing…',
			success: 'Template saved.',
			error: (e) => (e instanceof Error ? e.message : 'Could not save the template.')
		});
		try {
			await req;
			void opfsDelete(draftKey); // published — drop the local draft
			dirty = false; // clear the unsaved-changes guard before navigating away
			saved = true;
			await goto(resolve('/templates'));
		} catch {
			// surfaced by toast
		} finally {
			saving = false;
		}
	}

	// ---- preview (client-side render with sample merge data) ------------------
	let showPreview = $state(false);
	let sampleData = $state<Record<string, string>>({});
	let previewHtml = $state('');
	let previewSubject = $state('');
	let previewError = $state('');
	let previewDevice = $state<'desktop' | 'mobile'>('desktop');
	const now = new Date();
	// Sensible defaults so built-in vars aren't blank in the preview.
	const SAMPLE_BUILTINS: Record<string, string> = {
		recipient: 'you@example.com',
		sender_name: 'Your Team',
		sender_email: 'team@example.com',
		year: String(now.getUTCFullYear()),
		date: now.toISOString().slice(0, 10)
	};

	function openPreview() {
		const vars = tiptapVariables(currentDoc(), subject);
		const next: Record<string, string> = {};
		for (const variable of vars) next[variable] = sampleData[variable] ?? SAMPLE_BUILTINS[variable] ?? '';
		// unsubscribe_url is host-derived at send — mirror that in the preview using
		// this page's origin so the sample link is realistic.
		if (vars.includes('unsubscribe_url') && !next.unsubscribe_url) {
			next.unsubscribe_url = unsubscribeUrlFor(page.url.origin, next.recipient || SAMPLE_BUILTINS.recipient);
		}
		sampleData = next;
		showPreview = true;
		void renderPreview();
		void loadMailboxes();
	}

	// ---- test send (reuses the interactive send path) -------------------------
	type Mbx = { id: string; address: string; displayName: string | null; isPersonal: boolean; isService: boolean; isActive: boolean };
	let mailboxes = $state<Mbx[]>([]);
	let fromId = $state('');
	let testTo = $state('');
	let sendingTest = $state(false);
	let mailboxesLoaded = false;
	async function loadMailboxes() {
		if (mailboxesLoaded) return;
		try {
			const list = (((await myMailboxes()) ?? []) as Mbx[]).filter((mailbox) => mailbox.isActive);
			mailboxes = list;
			// Default: send FROM a service mailbox if any (the template's real sender),
			// TO the user's own personal mailbox (round-trips into their inbox).
			fromId = (list.find((mailbox) => mailbox.isService) ?? list[0])?.id ?? '';
			testTo = list.find((mailbox) => mailbox.isPersonal)?.address ?? '';
			mailboxesLoaded = true;
		} catch {
			// Picker stays empty; the user can still type a recipient.
		}
	}
	async function sendTest() {
		if (!fromId) return toast.error('Pick a mailbox to send from.');
		if (!testTo.trim()) return toast.error('Enter a recipient address.');
		sendingTest = true;
		const req = sendMessage({ mailboxId: fromId, to: [testTo.trim()], subject: previewSubject || '(no subject)', html: previewHtml });
		toast.promise(req as Promise<unknown>, {
			loading: 'Sending test…',
			success: 'Test email sent.',
			error: (e) => (e instanceof Error ? e.message : 'Could not send the test.')
		});
		try {
			await req;
		} catch {
			// surfaced by toast
		} finally {
			sendingTest = false;
		}
	}
	let previewTimer: ReturnType<typeof setTimeout> | null = null;
	function schedulePreview() {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(renderPreview, 250);
	}
	async function renderPreview() {
		try {
			const html = await compileMjml(tiptapToMjml(currentDoc(), settings()));
			previewHtml = renderJinja(html, { ...sampleData });
			previewSubject = renderJinja(subject || '', { ...sampleData });
			previewError = '';
		} catch (e) {
			previewError = e instanceof Error ? e.message : 'Could not render the preview.';
		}
	}
	const previewVars = $derived(Object.keys(sampleData));
</script>

{#if mobile.current}
	<!-- The 3-pane builder is unusable on a phone — gate it with a friendly nudge. -->
	<div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
		<div class="bg-muted grid size-14 place-items-center rounded-2xl">
			<MonitorIcon class="text-muted-foreground size-7" />
		</div>
		<div class="space-y-1">
			<p class="text-base font-medium">Build on a bigger screen</p>
			<p class="text-muted-foreground mx-auto max-w-xs text-sm">The email template builder needs a desktop-sized window. Open this on a computer to design your template.</p>
		</div>
		<a href={resolve('/templates')} class="border-input hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors">Back to templates</a>
	</div>
{:else}
<div class="flex h-full min-h-0">
	<!-- Left rail -->
	<aside class="flex w-12 shrink-0 flex-col items-center gap-1 py-2 border-r">
		<button type="button" class="grid size-8 place-items-center rounded-md {view === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (view = 'edit')} aria-label="Edit">
			<PencilIcon class="size-4" />
		</button>
		<button type="button" class="grid size-8 place-items-center rounded-md {view === 'code' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}" onclick={toggleCode} aria-label="View HTML">
			<CodeIcon class="size-4" />
		</button>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- Top bar -->
		<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
			<a href={resolve('/templates')} class="text-muted-foreground hover:text-foreground hover:bg-muted grid size-8 shrink-0 place-items-center rounded-md" aria-label="Back to templates">
				<ArrowLeftIcon class="size-4" />
			</a>
			<div class="flex min-w-0 items-center gap-1.5 text-sm">
				<a href={resolve('/templates')} class="text-muted-foreground hover:text-foreground">Templates</a>
				<span class="text-muted-foreground">/</span>
				<span class="truncate font-medium">{name || 'Untitled template'}</span>
				<Badge variant="secondary">{dirty ? 'Unsaved' : saved ? 'Published' : 'Draft'}</Badge>
			</div>
			<div class="ml-auto flex items-center gap-2">
				{#if saving}<LoaderIcon class="text-muted-foreground size-4 animate-spin" />{/if}
				<Button size="sm" variant="outline" onclick={openPreview}><EyeIcon class="size-4" /> Preview</Button>
				<Button size="sm" onclick={save} disabled={saving}>Publish</Button>
			</div>
		</header>

		<div class="relative flex min-h-0 flex-1">
			<!-- Insert pill — floats over the canvas left edge (no reserved lane) -->
			<div class="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-full bg-neutral-900 p-1 shadow-lg ring-1 ring-white/10">
					{#each GROUPS as group (group.key)}
						{@const GIcon = group.icon}
						<div class="relative">
							<button type="button" onclick={() => (openMenu = openMenu === group.key ? null : group.key)} title={group.label} class="grid size-9 place-items-center rounded-full transition-colors {openMenu === group.key ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-700 hover:text-white'}">
								<GIcon class="size-4" />
							</button>
							{#if openMenu === group.key}
								<div class="absolute left-12 top-0 z-30 min-w-48 rounded-xl bg-neutral-900 p-1.5 shadow-xl ring-1 ring-white/10">
									{#each group.items as item (item.label)}
										{@const IIcon = item.icon}
										<button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700" onclick={() => pick(item.run)}>
											<IIcon class="size-4 text-neutral-400" />
											{item.label}
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
					<div class="my-0.5 h-px w-6 bg-white/10"></div>
					<div class="relative">
						<button type="button" onclick={() => (openMenu = openMenu === 'vars' ? null : 'vars')} title="Variables" class="grid size-9 place-items-center rounded-full transition-colors {openMenu === 'vars' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-700 hover:text-white'}">
							<BracesIcon class="size-4" />
						</button>
						{#if openMenu === 'vars'}
							<div class="absolute left-12 top-0 z-30 min-w-52 rounded-xl bg-neutral-900 p-1.5 shadow-xl ring-1 ring-white/10">
								<p class="px-2 py-1 text-[11px] font-semibold uppercase text-neutral-500">Provided</p>
								{#each BUILTIN_VARIABLES as variable (variable.name)}
									<button type="button" class="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-neutral-200 hover:bg-neutral-700" onclick={() => insVar(variable.name)}>{`{{ ${variable.name} }}`}</button>
								{/each}
								{#if customVars.length}
									<p class="mt-1 px-2 py-1 text-[11px] font-semibold uppercase text-neutral-500">Yours</p>
									{#each customVars as variable (variable)}
										<button type="button" class="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-neutral-200 hover:bg-neutral-700" onclick={() => insVar(variable)}>{`{{ ${variable} }}`}</button>
									{/each}
								{/if}
							</div>
						{/if}
					</div>
				</div>
			<!-- Canvas / code -->
			<section class="bg-muted/40 min-h-0 flex-1 overflow-y-auto p-6">
				<div class="mx-auto max-w-[600px]" style:display={view === 'edit' ? 'block' : 'none'}>
					<!-- The email surface stays fixed-light (it IS the email), whatever the
					     app theme. Chrome around it (rails, panels) follows the theme. -->
					<div class="overflow-hidden rounded-lg shadow-sm ring-1 ring-black/5" style:background={background || '#ffffff'}>
						<div class="flex flex-col gap-1.5 border-b border-neutral-200 px-6 py-3">
							<input bind:value={name} aria-label="Template name" placeholder="Template name" class="w-full bg-transparent text-sm font-medium text-neutral-900 outline-none placeholder:text-neutral-400" />
							<input bind:value={subject} aria-label="Subject" placeholder="Subject" class="w-full bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400" />
							<input bind:value={previewText} aria-label="Preview text" placeholder="Preview text" class="w-full bg-transparent text-xs text-neutral-500 outline-none placeholder:text-neutral-400" />
						</div>
						<!-- Inline formatting toolbar -->
						<div class="flex items-center gap-0.5 border-b border-neutral-200 px-4 py-1.5 text-neutral-600">
							{#each [['H1', () => editor?.chain().focus().toggleHeading({ level: 1 }).run()], ['H2', () => editor?.chain().focus().toggleHeading({ level: 2 }).run()]] as [label, run] (label)}
								<button type="button" class="rounded px-1.5 py-1 text-xs font-semibold hover:bg-neutral-100" onclick={run as () => void}>{label}</button>
							{/each}
							<button type="button" class="rounded p-1.5 hover:bg-neutral-100" onclick={() => editor?.chain().focus().toggleBold().run()} aria-label="Bold"><BoldIcon class="size-3.5" /></button>
							<button type="button" class="rounded p-1.5 hover:bg-neutral-100" onclick={() => editor?.chain().focus().toggleItalic().run()} aria-label="Italic"><ItalicIcon class="size-3.5" /></button>
							<button type="button" class="rounded p-1.5 hover:bg-neutral-100" onclick={() => editor?.chain().focus().toggleBulletList().run()} aria-label="Bullet list"><ListIcon class="size-3.5" /></button>
							<span class="mx-1 h-4 w-px bg-neutral-200"></span>
							<button type="button" class="rounded p-1.5 hover:bg-neutral-100" onclick={() => editor?.chain().focus().setTextAlign('left').run()} aria-label="Align left"><AlignLeftIcon class="size-3.5" /></button>
							<button type="button" class="rounded p-1.5 hover:bg-neutral-100" onclick={() => editor?.chain().focus().setTextAlign('center').run()} aria-label="Align center"><AlignCenterIcon class="size-3.5" /></button>
							<button type="button" class="rounded p-1.5 hover:bg-neutral-100" onclick={() => editor?.chain().focus().setTextAlign('right').run()} aria-label="Align right"><AlignRightIcon class="size-3.5" /></button>
							<span class="mx-1 h-4 w-px bg-neutral-200"></span>
							<select onchange={(e) => editor?.chain().focus().setMark('textStyle', { fontSize: e.currentTarget.value }).run()} class="h-7 rounded border-neutral-200 bg-transparent px-1 text-xs text-neutral-600" aria-label="Font size" title="Font size">
								<option value="">Size</option>
								{#each ['12px', '14px', '16px', '18px', '20px', '24px', '30px'] as size (size)}<option value={size}>{size.replace('px', '')}</option>{/each}
							</select>
							<label class="grid size-7 cursor-pointer place-items-center rounded hover:bg-neutral-100" title="Text color">
								<span class="text-[11px] font-bold text-neutral-600">A</span>
								<input type="color" oninput={(e) => editor?.chain().focus().setColor(e.currentTarget.value).run()} class="sr-only" aria-label="Text color" />
							</label>
							<span class="mx-1 h-4 w-px bg-neutral-200"></span>
							<button
								type="button"
								class="rounded p-1.5 hover:bg-neutral-100"
								onclick={() => {
									const url = prompt('Link URL');
									if (url) editor?.chain().focus().setLink({ href: url }).run();
								}}
								aria-label="Link"><LinkIcon class="size-3.5" /></button>
						</div>
						<div bind:this={editorEl} class="email-canvas min-h-[24rem] px-6 py-4" style={themeVars}></div>
					</div>
				</div>
				{#if view === 'code'}
					<div class="mx-auto max-w-[720px]"><CodeEditor value={codeHtml} language="markup" rows={24} /></div>
				{/if}
			</section>

			<!-- Right config panel -->
			<aside class="bg-muted/20 w-72 shrink-0 space-y-4 overflow-y-auto border-l p-4 text-sm">
				{#if sel}
					<div class="flex items-center justify-between">
						<p class="text-xs font-semibold tracking-wide uppercase">{TYPE_LABEL[sel.type] ?? sel.type}</p>
						<button type="button" class="text-muted-foreground hover:text-destructive" onclick={deleteSelected} aria-label="Delete block"><Trash2Icon class="size-4" /></button>
					</div>
					<div class="flex flex-col gap-2.5">
						{#if sel.type === 'button'}
							<Input value={String(sel.attrs.text ?? '')} oninput={(e) => setAttr('text', e.currentTarget.value)} placeholder="Label" />
							<Input value={String(sel.attrs.href ?? '')} oninput={(e) => setAttr('href', e.currentTarget.value)} placeholder="https://…" />
							<div class="flex gap-1.5">
								<select value={String(sel.attrs.align ?? 'center')} onchange={(e) => setAttr('align', e.currentTarget.value)} class="border-input bg-background h-8 flex-1 rounded-md border px-2 text-xs">
									<option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
								</select>
								<select value={String(sel.attrs.size ?? 'md')} onchange={(e) => setAttr('size', e.currentTarget.value)} class="border-input bg-background h-8 flex-1 rounded-md border px-2 text-xs" aria-label="Button size">
									<option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option>
								</select>
							</div>
							<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Fill</span><span class="flex items-center gap-1.5"><input type="color" value={String(sel.attrs.btnBg ?? '#2563eb')} oninput={(e) => setAttr('btnBg', e.currentTarget.value)} class="border-input size-7 cursor-pointer rounded border p-0.5" aria-label="Button color" /><Input value={String(sel.attrs.btnBg ?? '')} oninput={(e) => setAttr('btnBg', e.currentTarget.value)} class="h-7 w-24 font-mono text-xs" /></span></label>
							<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Text</span><input type="color" value={String(sel.attrs.btnColor ?? '#ffffff')} oninput={(e) => setAttr('btnColor', e.currentTarget.value)} class="border-input size-7 cursor-pointer rounded border p-0.5" aria-label="Text color" /></label>
							<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Radius</span><span class="flex items-center gap-1"><Input type="number" value={Number(sel.attrs.btnRadius ?? 6)} oninput={(e) => setAttr('btnRadius', Number(e.currentTarget.value))} class="h-7 w-20" /><span class="text-muted-foreground text-xs">px</span></span></label>
							<label class="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(sel.attrs.fullWidth)} onchange={(e) => setAttr('fullWidth', e.currentTarget.checked)} class="size-3.5" /><span class="text-muted-foreground">Full width</span></label>
						{:else if sel.type === 'emImage'}
							<div class="flex gap-1.5">
								<Input value={String(sel.attrs.src ?? '')} oninput={(e) => setAttr('src', e.currentTarget.value)} placeholder="Image URL" class="min-w-0 flex-1" />
								<Button size="sm" variant="outline" class="shrink-0" onclick={() => uploadInto('src')}><UploadIcon class="size-3.5" /></Button>
							</div>
							<Input value={String(sel.attrs.alt ?? '')} oninput={(e) => setAttr('alt', e.currentTarget.value)} placeholder="Alt text" />
							<Input value={String(sel.attrs.href ?? '')} oninput={(e) => setAttr('href', e.currentTarget.value)} placeholder="Link (optional)" />
							<div class="flex gap-1.5">
								<label class="flex flex-1 items-center gap-1"><Input type="number" value={sel.attrs.width != null ? Number(sel.attrs.width) : ''} oninput={(e) => setAttr('width', e.currentTarget.value ? Number(e.currentTarget.value) : null)} placeholder="auto" class="h-8" /><span class="text-muted-foreground text-xs">px</span></label>
								<select value={String(sel.attrs.align ?? 'center')} onchange={(e) => setAttr('align', e.currentTarget.value)} class="border-input bg-background h-8 flex-1 rounded-md border px-2 text-xs" aria-label="Image alignment">
									<option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
								</select>
							</div>
						{:else if sel.type === 'social'}
							{#each socialItems() as item, i (i)}
								<div class="flex items-center gap-1.5">
									<select value={item.network} onchange={(e) => updateSocial(i, 'network', e.currentTarget.value)} class="border-input bg-background h-8 shrink-0 rounded-md border px-1.5 text-xs capitalize" aria-label="Network">
										{#each SOCIAL_NETWORKS as network (network)}<option value={network}>{network}</option>{/each}
									</select>
									<Input value={item.href} oninput={(e) => updateSocial(i, 'href', e.currentTarget.value)} placeholder="https://…" class="h-8 min-w-0 flex-1" />
									<button type="button" class="text-muted-foreground hover:text-destructive shrink-0" onclick={() => removeSocial(i)} aria-label="Remove network">✕</button>
								</div>
							{/each}
							<Button size="sm" variant="outline" onclick={addSocial}>+ Add network</Button>
						{:else if sel.type === 'footer'}
							<textarea value={String(sel.attrs.text ?? '')} oninput={(e) => setAttr('text', e.currentTarget.value)} rows={3} class="border-input bg-background w-full rounded-md border p-2 text-xs" placeholder="© {'{{ year }}'} Company · Address"></textarea>
							<Input value={String(sel.attrs.unsubscribeLabel ?? '')} oninput={(e) => setAttr('unsubscribeLabel', e.currentTarget.value)} placeholder="Unsubscribe label" />
							<Input value={String(sel.attrs.unsubscribeUrl ?? '')} oninput={(e) => setAttr('unsubscribeUrl', e.currentTarget.value)} placeholder="Unsubscribe URL" class="font-mono text-xs" />
						{:else if sel.type === 'hero'}
							<div class="flex gap-1.5">
								<Input value={String(sel.attrs.src ?? '')} oninput={(e) => setAttr('src', e.currentTarget.value)} placeholder="Background image URL" class="min-w-0 flex-1" />
								<Button size="sm" variant="outline" class="shrink-0" onclick={() => uploadInto('src')}><UploadIcon class="size-3.5" /></Button>
							</div>
							<Input value={String(sel.attrs.heading ?? '')} oninput={(e) => setAttr('heading', e.currentTarget.value)} placeholder="Heading" />
							<Input value={String(sel.attrs.text ?? '')} oninput={(e) => setAttr('text', e.currentTarget.value)} placeholder="Subtext" />
							<Input value={String(sel.attrs.buttonText ?? '')} oninput={(e) => setAttr('buttonText', e.currentTarget.value)} placeholder="Button label" />
							<Input value={String(sel.attrs.buttonHref ?? '')} oninput={(e) => setAttr('buttonHref', e.currentTarget.value)} placeholder="Button URL" />
							<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Text color</span><input type="color" value={String(sel.attrs.textColor ?? '#ffffff')} oninput={(e) => setAttr('textColor', e.currentTarget.value)} class="border-input size-7 cursor-pointer rounded border p-0.5" aria-label="Hero text color" /></label>
							<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Height</span><span class="flex items-center gap-1"><Input type="number" value={Number(sel.attrs.height ?? 300)} oninput={(e) => setAttr('height', Number(e.currentTarget.value) || 300)} class="h-7 w-20" /><span class="text-muted-foreground text-xs">px</span></span></label>
						{:else if sel.type === 'spacer'}
							<label class="flex items-center gap-2"><span class="text-muted-foreground text-xs">Height</span><Input type="number" value={Number(sel.attrs.height ?? 24)} oninput={(e) => setAttr('height', Number(e.currentTarget.value))} class="h-8 w-24" /><span class="text-muted-foreground text-xs">px</span></label>
						{:else if sel.type === 'variable'}
							<Input value={String(sel.attrs.name ?? '')} oninput={(e) => setAttr('name', e.currentTarget.value)} placeholder="variable name" class="font-mono" />
						{:else if sel.type === 'htmlBlock'}
							<textarea
								value={String(sel.attrs.html ?? '')}
								oninput={(e) => setAttr('html', e.currentTarget.value)}
								rows={7}
								spellcheck="false"
								class="border-input bg-background w-full rounded-md border p-2 font-mono text-xs"
							></textarea>
						{:else}
							<p class="text-muted-foreground text-xs">No editable options for this block.</p>
						{/if}

						{#if SECTION_TYPES.has(sel.type)}
							<div class="mt-1 flex flex-col gap-2 border-t pt-3">
								<p class="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">Background</p>
								<div class="flex items-center gap-1.5">
									<input type="color" value={String(sel.attrs.bg ?? '#ffffff')} oninput={(e) => setAttr('bg', e.currentTarget.value)} class="border-input size-7 shrink-0 cursor-pointer rounded border p-0.5" aria-label="Background color" />
									<Input value={String(sel.attrs.bg ?? '')} oninput={(e) => setAttr('bg', e.currentTarget.value || null)} placeholder="none" class="h-7 flex-1 font-mono text-xs" />
									{#if sel.attrs.bg}<button type="button" class="text-muted-foreground hover:text-foreground text-xs" onclick={() => setAttr('bg', null)} aria-label="Clear background">✕</button>{/if}
								</div>
							</div>
							<div class="flex flex-col gap-2 border-t pt-3">
								<p class="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">Spacing</p>
								<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Padding</span><span class="flex items-center gap-1"><Input type="number" value={Number(sel.attrs.pad ?? 0)} oninput={(e) => setAttr('pad', Number(e.currentTarget.value) || null)} class="h-7 w-20" /><span class="text-muted-foreground text-xs">px</span></span></label>
							</div>
							<div class="flex flex-col gap-2 border-t pt-3">
								<p class="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">Border</p>
								<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Width</span><span class="flex items-center gap-1"><Input type="number" value={Number(sel.attrs.borderWidth ?? 0)} oninput={(e) => setAttr('borderWidth', Number(e.currentTarget.value) || null)} class="h-7 w-20" /><span class="text-muted-foreground text-xs">px</span></span></label>
								<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Color</span><input type="color" value={String(sel.attrs.borderColor ?? '#000000')} oninput={(e) => setAttr('borderColor', e.currentTarget.value)} class="border-input size-7 cursor-pointer rounded border p-0.5" aria-label="Border color" /></label>
								<label class="flex items-center justify-between gap-2"><span class="text-muted-foreground text-xs">Radius</span><span class="flex items-center gap-1"><Input type="number" value={Number(sel.attrs.radius ?? 0)} oninput={(e) => setAttr('radius', Number(e.currentTarget.value) || null)} class="h-7 w-20" /><span class="text-muted-foreground text-xs">px</span></span></label>
							</div>
						{/if}
					</div>
				{:else}
					<div>
						<p class="mb-2 text-xs font-semibold tracking-wide uppercase">Page style</p>
						<div class="flex flex-col gap-2.5">
							<label class="flex items-center justify-between gap-2">
								<span class="text-muted-foreground">Background</span>
								<span class="flex items-center gap-1.5">
									<input type="color" bind:value={background} class="border-input size-7 cursor-pointer rounded border p-0.5" aria-label="Background color" />
									<Input bind:value={background} class="h-7 w-24 font-mono text-xs" />
								</span>
							</label>
							<label class="flex items-center justify-between gap-2">
								<span class="text-muted-foreground">Width</span>
								<span class="flex items-center gap-1"><Input type="number" bind:value={width} class="h-7 w-20 text-xs" /><span class="text-muted-foreground text-xs">px</span></span>
							</label>
						</div>
					</div>
					<div class="border-t pt-3">
						<p class="mb-1 text-xs font-semibold tracking-wide uppercase">Theme</p>
						<p class="text-muted-foreground mb-2 text-[11px]">Default typography per text type.</p>
						<div class="space-y-2.5">
							{#each THEME_ROLES as role (role.key)}
								{@const t = theme[role.key] ?? {}}
								<div class="space-y-1">
									<p class="text-muted-foreground text-[11px] font-medium">{role.label}</p>
									<div class="flex items-center gap-1.5">
										<input type="color" value={t.color ?? '#111827'} oninput={(e) => setTheme(role.key, 'color', e.currentTarget.value)} class="border-input size-7 shrink-0 cursor-pointer rounded border p-0.5" aria-label="{role.label} color" />
										<input type="number" value={t.size ?? ''} oninput={(e) => setTheme(role.key, 'size', Number(e.currentTarget.value) || undefined)} placeholder="size" class="border-input bg-background h-7 w-14 rounded-md border px-1.5 text-xs" aria-label="{role.label} size" />
										<select value={String(t.weight ?? '')} onchange={(e) => setTheme(role.key, 'weight', Number(e.currentTarget.value) || undefined)} class="border-input bg-background h-7 flex-1 rounded-md border px-1 text-xs" aria-label="{role.label} weight">
											<option value="">weight</option>
											<option value="400">400</option><option value="500">500</option><option value="600">600</option><option value="700">700</option>
										</select>
										<input type="number" step="0.1" value={t.lineHeight ?? ''} oninput={(e) => setTheme(role.key, 'lineHeight', Number(e.currentTarget.value) || undefined)} placeholder="lh" class="border-input bg-background h-7 w-12 rounded-md border px-1.5 text-xs" aria-label="{role.label} line height" />
									</div>
								</div>
							{/each}
						</div>
					</div>
					<div class="border-t pt-3">
						<p class="mb-2 text-xs font-semibold tracking-wide uppercase">Global CSS</p>
						<CodeEditor bind:value={globalCss} language="css" rows={5} placeholder={cssPlaceholder} />
					</div>
					<p class="text-muted-foreground text-[11px]">Select a block to edit it.</p>
				{/if}
			</aside>
		</div>
	</div>
</div>
{/if}

{#if showPreview}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-50 flex bg-black/40 p-4 backdrop-blur-sm" onclick={() => (showPreview = false)}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="bg-background m-auto flex h-[85vh] w-[92vw] max-w-5xl overflow-hidden rounded-xl shadow-2xl" onclick={(e) => e.stopPropagation()}>
			<!-- Sample data -->
			<aside class="w-64 shrink-0 space-y-3 overflow-y-auto border-r p-4">
				<p class="text-sm font-semibold">Sample data</p>
				<p class="text-muted-foreground text-xs">Fill in values to preview how the merged email looks.</p>
				{#each previewVars as variable (variable)}
					<label class="block space-y-1">
						<span class="text-muted-foreground font-mono text-[11px]">{`{{ ${variable} }}`}</span>
						<Input value={sampleData[variable]} oninput={(e) => { sampleData[variable] = e.currentTarget.value; schedulePreview(); }} class="h-8" />
					</label>
				{/each}
				{#if !previewVars.length}
					<p class="text-muted-foreground text-xs">This template has no variables.</p>
				{/if}
				<div class="space-y-2 border-t pt-3">
					<p class="text-sm font-semibold">Send a test</p>
					<label class="block space-y-1">
						<span class="text-muted-foreground text-[11px]">From</span>
						<select bind:value={fromId} class="border-input bg-background h-8 w-full rounded-md border px-2 text-xs" aria-label="Send from mailbox">
							{#each mailboxes as mailbox (mailbox.id)}<option value={mailbox.id}>{mailbox.displayName || mailbox.address}</option>{/each}
						</select>
					</label>
					<label class="block space-y-1">
						<span class="text-muted-foreground text-[11px]">To</span>
						<Input value={testTo} oninput={(e) => (testTo = e.currentTarget.value)} placeholder="you@example.com" class="h-8" />
					</label>
					<Button size="sm" class="w-full" onclick={sendTest} disabled={sendingTest}>
						{#if sendingTest}<LoaderIcon class="size-4 animate-spin" />{:else}<SendIcon class="size-4" />{/if}
						Send test
					</Button>
					<p class="text-muted-foreground text-[11px]">Sends the merged email with the sample values above.</p>
				</div>
			</aside>
			<!-- Rendered email -->
			<div class="flex min-w-0 flex-1 flex-col">
				<header class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<p class="min-w-0 truncate text-sm"><span class="text-muted-foreground">Subject:</span> {previewSubject || '—'}</p>
					<div class="ml-auto flex items-center gap-0.5 rounded-md border p-0.5">
							<button type="button" onclick={() => (previewDevice = 'desktop')} class="grid size-7 place-items-center rounded {previewDevice === 'desktop' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}" aria-label="Desktop view" aria-pressed={previewDevice === 'desktop'}><MonitorIcon class="size-4" /></button>
							<button type="button" onclick={() => (previewDevice = 'mobile')} class="grid size-7 place-items-center rounded {previewDevice === 'mobile' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}" aria-label="Mobile view" aria-pressed={previewDevice === 'mobile'}><SmartphoneIcon class="size-4" /></button>
						</div>
						<button type="button" class="text-muted-foreground hover:text-foreground hover:bg-muted grid size-8 shrink-0 place-items-center rounded-md" onclick={() => (showPreview = false)} aria-label="Close preview"><XIcon class="size-4" /></button>
				</header>
				{#if previewError}
					<div class="text-destructive p-4 text-sm">{previewError}</div>
				{:else}
					<div class="bg-muted/30 flex min-h-0 flex-1 justify-center overflow-auto">
							<iframe title="Email preview" srcdoc={previewHtml} sandbox="" class="bg-white {previewDevice === 'mobile' ? 'my-4 w-[390px] shrink-0 rounded-xl shadow-lg ring-1 ring-black/10' : 'w-full'}"></iframe>
						</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.email-canvas :global(.ProseMirror) {
		outline: none;
		color: var(--th-p-color, #1f2937);
		font-size: var(--th-p-size, 15px);
		font-weight: var(--th-p-weight, 400);
		line-height: var(--th-p-lh, 1.6);
		min-height: 12rem;
	}
	.email-canvas :global(.ProseMirror h1) { font-size: var(--th-h1-size, 28px); font-weight: var(--th-h1-weight, 700); color: var(--th-h1-color, inherit); line-height: var(--th-h1-lh, normal); margin: 0.4em 0; }
	.email-canvas :global(.ProseMirror h2) { font-size: var(--th-h2-size, 22px); font-weight: var(--th-h2-weight, 700); color: var(--th-h2-color, inherit); line-height: var(--th-h2-lh, normal); margin: 0.4em 0; }
	.email-canvas :global(.ProseMirror h3) { font-size: var(--th-h3-size, 18px); font-weight: var(--th-h3-weight, 700); color: var(--th-h3-color, inherit); line-height: var(--th-h3-lh, normal); margin: 0.4em 0; }
	.email-canvas :global(.ProseMirror p) { margin: 0.5em 0; }
	.email-canvas :global(.ProseMirror ul),
	.email-canvas :global(.ProseMirror ol) { padding-left: 1.4em; margin: 0.5em 0; }
	.email-canvas :global(.ProseMirror a) { color: #2563eb; text-decoration: underline; }
	.email-canvas :global(.ProseMirror .ProseMirror-selectednode) { outline: 2px solid #2563eb; border-radius: 6px; }
	/* Custom node previews */
	.email-canvas :global(.em-block) { margin: 0.5em 0; }
	.email-canvas :global(.em-btn-inner) { display: inline-block; background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; font-size: 14px; }
	.email-canvas :global(.em-img img) { max-width: 100%; border-radius: 4px; display: block; }
	.email-canvas :global(.em-spacer) { background: repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 6px, #fff 6px, #fff 12px); border-radius: 4px; }
	.email-canvas :global(.em-hero) { background-size: cover; background-position: center; background-color: #222831; color: #fff; padding: 40px 24px; text-align: center; border-radius: 6px; }
	.email-canvas :global(.em-hero-h) { font-size: 22px; font-weight: 700; }
	.email-canvas :global(.em-hero-b) { display: inline-block; margin-top: 10px; background: #fff; color: #111; padding: 8px 14px; border-radius: 6px; font-size: 13px; }
	.email-canvas :global(.em-social) { display: flex; gap: 8px; }
	.email-canvas :global(.em-social-item) { background: #eef2ff; color: #4338ca; padding: 3px 8px; border-radius: 4px; font-size: 12px; text-transform: capitalize; }
	.email-canvas :global(.em-html) { border: 1px dashed #cbd5e1; color: #64748b; padding: 10px; border-radius: 6px; font-size: 13px; }
	.email-canvas :global(.em-footer) { text-align: center; color: #94a3b8; font-size: 12px; line-height: 1.6; }
	.email-canvas :global(.em-var) { background: #eef2ff; color: #4338ca; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.9em; }
	.email-canvas :global(.em-cols) { display: flex; gap: 12px; }
	.email-canvas :global(.em-col) { flex: 1; min-width: 0; border: 1px dashed #e5e7eb; border-radius: 6px; padding: 8px; }
	.email-canvas :global(.ProseMirror p.is-editor-empty:first-child::before) { content: attr(data-placeholder); color: #9ca3af; float: left; height: 0; pointer-events: none; }

	/* Slash-command menu (rendered at <body>, so global + app-token styled). */
	:global(.slash-menu) {
		position: fixed;
		z-index: 60;
		min-width: 12rem;
		max-height: 16rem;
		overflow-y: auto;
		padding: 4px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		scrollbar-width: thin;
		scrollbar-color: var(--border) transparent;
	}
	:global(.slash-menu::-webkit-scrollbar) {
		width: 8px;
	}
	:global(.slash-menu::-webkit-scrollbar-thumb) {
		background: var(--border);
		border-radius: 9999px;
		border: 2px solid transparent;
		background-clip: padding-box;
	}
	:global(.slash-menu::-webkit-scrollbar-track) {
		background: transparent;
	}
	:global(.slash-menu .slash-item) {
		display: block;
		width: 100%;
		border: 0;
		border-radius: 5px;
		background: transparent;
		padding: 5px 8px;
		text-align: left;
		font-size: 13px;
		color: inherit;
		cursor: pointer;
	}
	:global(.slash-menu .slash-item.is-active) {
		background: var(--accent);
		color: var(--accent-foreground);
	}
	:global(.slash-menu .slash-empty) {
		padding: 6px 8px;
		font-size: 12px;
		color: var(--muted-foreground);
	}
</style>
