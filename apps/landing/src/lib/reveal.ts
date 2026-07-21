// Gentle scroll-into-view reveal. One-shot, reduced-motion aware.
// ponytail: IntersectionObserver over a scroll library — zero deps.
export function reveal(node: HTMLElement, delay = 0) {
	if (typeof IntersectionObserver === 'undefined') return;
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

	node.style.opacity = '0';
	node.style.transform = 'translateY(10px)';
	node.style.transition = `opacity 600ms var(--ease-out) ${delay}ms, transform 600ms var(--ease-out) ${delay}ms`;

	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					node.style.opacity = '1';
					node.style.transform = 'none';
					io.disconnect();
				}
			}
		},
		{ threshold: 0.15 }
	);
	io.observe(node);

	return {
		destroy() {
			io.disconnect();
		}
	};
}
