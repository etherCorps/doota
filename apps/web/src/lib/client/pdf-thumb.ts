// First-page PDF thumbnails, rendered entirely in the browser. pdfjs-dist is
// dynamically imported only when a PDF tile actually mounts (~350KB chunk that
// most sessions never pay for); Workers have no canvas, so server-side
// rendering was never an option. Results cached per attachment for the session.

const cache = new Map<string, Promise<string | null>>();

export function pdfThumb(attachmentId: string): Promise<string | null> {
	let p = cache.get(attachmentId);
	if (!p) {
		p = render(attachmentId).catch(() => null);
		cache.set(attachmentId, p);
	}
	return p;
}

async function render(attachmentId: string): Promise<string> {
	const [pdfjs, res] = await Promise.all([
		import('pdfjs-dist'),
		fetch(`/api/attachments/${attachmentId}`)
	]);
	if (!res.ok) throw new Error(`attachment fetch ${res.status}`);
	if (!pdfjs.GlobalWorkerOptions.workerSrc) {
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			'pdfjs-dist/build/pdf.worker.min.mjs',
			import.meta.url
		).toString();
	}
	const task = pdfjs.getDocument({ data: await res.arrayBuffer() });
	const doc = await task.promise;
	try {
		const page = await doc.getPage(1);
		const base = page.getViewport({ scale: 1 });
		// ponytail: fixed 480px-wide render — crisp enough for a tile at 2x.
		const viewport = page.getViewport({ scale: 480 / base.width });
		const canvas = document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport }).promise;
		return canvas.toDataURL('image/png');
	} finally {
		void task.destroy();
	}
}
