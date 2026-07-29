// SPDX-License-Identifier: Apache-2.0
/**
 * Custom Tiptap nodes for the email builder (Resend-style). Atoms render a
 * DOM preview in the canvas; their attributes are edited in the right config
 * panel (selection-driven). All serialize to MJML via tiptap-mjml.ts.
 *
 * Every block carries shared container-style attrs (bg / padding / border /
 * radius) so the config panel's Background / Spacing / Border sections work
 * uniformly. `previewStyle` reflects them live in the canvas.
 */
import { Node, mergeAttributes } from '@tiptap/core';

const IMG_PLACEHOLDER =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="%23e5e7eb"/><text x="60" y="44" font-size="11" fill="%239ca3af" text-anchor="middle">image</text></svg>'
	);

/** Shared container-style attributes present on every block node. */
type StyleAttrs = { bg?: string | null; pad?: number | null; borderColor?: string | null; borderWidth?: number | null; radius?: number | null };
const styleAttrs = () => ({
	bg: { default: null },
	pad: { default: null },
	borderColor: { default: '#000000' },
	borderWidth: { default: null },
	radius: { default: null }
});

/** Inline CSS for the canvas preview reflecting the container-style attrs. */
function previewStyle(a: StyleAttrs, extra = ''): string {
	const s: string[] = [];
	if (extra) s.push(extra);
	if (a.bg) s.push(`background:${a.bg}`);
	if (a.pad != null && a.pad !== ('' as unknown)) s.push(`padding:${a.pad}px`);
	if (a.borderWidth) s.push(`border:${a.borderWidth}px solid ${a.borderColor ?? '#000000'}`);
	if (a.radius) s.push(`border-radius:${a.radius}px`);
	return s.join(';');
}

/** Button size → preview padding + font-size (shared with the MJML serializer). */
export const BTN_SIZE = { sm: { pad: '6px 12px', fs: '13px' }, md: { pad: '10px 18px', fs: '14px' }, lg: { pad: '14px 26px', fs: '16px' } } as const;

export const ButtonNode = Node.create({
	name: 'button',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({
		text: { default: 'Click me' },
		href: { default: 'https://' },
		align: { default: 'center' },
		btnBg: { default: '#2563eb' },
		btnColor: { default: '#ffffff' },
		size: { default: 'md' },
		btnRadius: { default: 6 },
		fullWidth: { default: false },
		...styleAttrs()
	}),
	parseHTML: () => [{ tag: 'div[data-email-button]' }],
	renderHTML: ({ node }) => {
		const a = node.attrs;
		const sz = BTN_SIZE[(a.size as keyof typeof BTN_SIZE) ?? 'md'] ?? BTN_SIZE.md;
		const inner = `background:${a.btnBg || '#2563eb'};color:${a.btnColor || '#ffffff'};border-radius:${a.btnRadius ?? 6}px;padding:${sz.pad};font-size:${sz.fs};${a.fullWidth ? 'display:block;text-align:center' : 'display:inline-block'}`;
		return [
			'div',
			{ 'data-email-button': '', class: 'em-block em-btn', style: previewStyle(a, `text-align:${a.align}`) },
			['span', { class: 'em-btn-inner', style: inner }, a.text || 'Button']
		];
	}
});

export const ImageNode = Node.create({
	name: 'emImage',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, href: { default: '' }, width: { default: null }, align: { default: 'center' }, ...styleAttrs() }),
	parseHTML: () => [{ tag: 'img[data-email-image]' }],
	renderHTML: ({ node }) => {
		const a = node.attrs;
		const m = a.align === 'left' ? '0' : a.align === 'right' ? '0 0 0 auto' : '0 auto';
		const imgStyle = `display:block;max-width:100%;margin:${m};${a.width ? `width:${Number(a.width)}px;` : ''}`;
		return [
			'div',
			{ class: 'em-block em-img', style: previewStyle(a) },
			['img', mergeAttributes({ 'data-email-image': '', src: a.src || IMG_PLACEHOLDER, alt: a.alt, style: imgStyle })]
		];
	}
});

export const SpacerNode = Node.create({
	name: 'spacer',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({ height: { default: 24 }, ...styleAttrs() }),
	parseHTML: () => [{ tag: 'div[data-email-spacer]' }],
	renderHTML: ({ node }) => [
		'div',
		{ 'data-email-spacer': '', class: 'em-block em-spacer', style: previewStyle(node.attrs, `height:${node.attrs.height}px`) }
	]
});

export const HeroNode = Node.create({
	name: 'hero',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({ src: { default: '' }, heading: { default: 'Big headline' }, text: { default: '' }, buttonText: { default: '' }, buttonHref: { default: 'https://' }, ...styleAttrs() }),
	parseHTML: () => [{ tag: 'div[data-email-hero]' }],
	renderHTML: ({ node }) => [
		'div',
		{ 'data-email-hero': '', class: 'em-block em-hero', style: previewStyle(node.attrs, node.attrs.src ? `background-image:url(${node.attrs.src})` : '') },
		['div', { class: 'em-hero-h' }, node.attrs.heading || 'Hero'],
		...(node.attrs.text ? [['div', { class: 'em-hero-t' }, node.attrs.text]] : []),
		...(node.attrs.buttonText ? [['div', { class: 'em-hero-b' }, node.attrs.buttonText]] : [])
	]
});

export const SocialNode = Node.create({
	name: 'social',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({ items: { default: [{ network: 'github', href: 'https://' }] }, ...styleAttrs() }),
	parseHTML: () => [{ tag: 'div[data-email-social]' }],
	renderHTML: ({ node }) => [
		'div',
		{ 'data-email-social': '', class: 'em-block em-social', style: previewStyle(node.attrs) },
		...(node.attrs.items as { network: string }[]).map((i) => ['span', { class: 'em-social-item' }, i.network])
	]
});

export const HtmlNode = Node.create({
	name: 'htmlBlock',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({ html: { default: '<p>Raw HTML</p>' }, ...styleAttrs() }),
	parseHTML: () => [{ tag: 'div[data-email-html]' }],
	renderHTML: ({ node }) => ['div', { 'data-email-html': '', class: 'em-block em-html', style: previewStyle(node.attrs) }, 'HTML block']
});

export const VariableNode = Node.create({
	name: 'variable',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	addAttributes: () => ({ name: { default: 'name' } }),
	parseHTML: () => [{ tag: 'span[data-email-var]' }],
	renderHTML: ({ node }) => ['span', { 'data-email-var': '', class: 'em-var' }, `{{ ${node.attrs.name} }}`]
});

export const ColumnNode = Node.create({
	name: 'column',
	content: 'block+',
	isolating: true,
	renderHTML: () => ['div', { class: 'em-col' }, 0]
});

export const ColumnsNode = Node.create({
	name: 'columns',
	group: 'block',
	content: 'column{2,4}',
	draggable: true,
	selectable: true,
	addAttributes: () => ({ ...styleAttrs() }),
	renderHTML: ({ node }) => ['div', { class: 'em-cols', style: previewStyle(node.attrs) }, 0]
});

export const FooterNode = Node.create({
	name: 'footer',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	addAttributes: () => ({
		text: { default: '© {{ year }} Company · 123 Street, City, Country' },
		unsubscribeLabel: { default: 'Unsubscribe' },
		unsubscribeUrl: { default: '{{ unsubscribe_url }}' },
		...styleAttrs()
	}),
	parseHTML: () => [{ tag: 'div[data-email-footer]' }],
	renderHTML: ({ node }) => [
		'div',
		{ 'data-email-footer': '', class: 'em-block em-footer', style: previewStyle(node.attrs) },
		`${node.attrs.text}${node.attrs.unsubscribeLabel ? ` · ${node.attrs.unsubscribeLabel}` : ''}`
	]
});

/** All custom node extensions, for the editor's extension list. */
export const EMAIL_NODES = [ButtonNode, ImageNode, SpacerNode, HeroNode, SocialNode, HtmlNode, VariableNode, FooterNode, ColumnsNode, ColumnNode];
