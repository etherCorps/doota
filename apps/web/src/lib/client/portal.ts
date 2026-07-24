// SPDX-License-Identifier: Apache-2.0
/**
 * Move the node to <body>. Needed for position:fixed overlays rendered inside
 * a transformed ancestor (e.g. the vaul drawer) — a transform makes `fixed`
 * position against the ancestor's box instead of the viewport.
 */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return { destroy: () => node.remove() };
}
