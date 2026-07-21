<script lang="ts">
	import { tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import UploadIcon from '@lucide/svelte/icons/upload';

	// Minimal square avatar cropper: the 256px canvas IS the crop — drag to pan,
	// slider to zoom, then export the canvas as a webp blob and upload. No lib.
	let {
		open = $bindable(false),
		image = null,
		onsaved
	}: { open?: boolean; image?: string | null; onsaved?: (image: string) => void } = $props();

	const SIZE = 256;
	let canvas = $state<HTMLCanvasElement>();
	let fileInput = $state<HTMLInputElement>();
	let img: HTMLImageElement | null = null;
	let scale = $state(1);
	let minScale = $state(1);
	let tx = 0;
	let ty = 0;
	let dragging = false;
	let lastX = 0;
	let lastY = 0;
	let hasImage = $state(false);
	let saving = $state(false);

	function render() {
		const ctx = canvas?.getContext('2d');
		if (!ctx || !img) return;
		ctx.clearRect(0, 0, SIZE, SIZE);
		ctx.drawImage(img, tx, ty, img.width * scale, img.height * scale);
	}
	function clamp() {
		if (!img) return;
		tx = Math.min(0, Math.max(SIZE - img.width * scale, tx));
		ty = Math.min(0, Math.max(SIZE - img.height * scale, ty));
	}
	function onFile(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		const im = new Image();
		im.onload = async () => {
			img = im;
			minScale = Math.max(SIZE / im.width, SIZE / im.height);
			scale = minScale;
			tx = (SIZE - im.width * scale) / 2;
			ty = (SIZE - im.height * scale) / 2;
			hasImage = true;
			// Canvas is behind {#if hasImage} — wait for it to mount before drawing.
			await tick();
			render();
		};
		im.src = URL.createObjectURL(f);
	}
	function setScale(v: number) {
		if (!img) return;
		// Zoom around the canvas center.
		const cx = (SIZE / 2 - tx) / scale;
		const cy = (SIZE / 2 - ty) / scale;
		scale = v;
		tx = SIZE / 2 - cx * scale;
		ty = SIZE / 2 - cy * scale;
		clamp();
		render();
	}
	function onDown(e: PointerEvent) {
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
		canvas?.setPointerCapture(e.pointerId);
	}
	function onMove(e: PointerEvent) {
		if (!dragging) return;
		tx += e.clientX - lastX;
		ty += e.clientY - lastY;
		lastX = e.clientX;
		lastY = e.clientY;
		clamp();
		render();
	}
	function onUp() {
		dragging = false;
	}
	async function save() {
		if (!canvas || !hasImage) return;
		saving = true;
		canvas.toBlob(
			async (blob) => {
				try {
					if (!blob) return;
					const fd = new FormData();
					fd.append('file', blob, 'avatar.webp');
					const res = await fetch('/api/avatar', { method: 'POST', body: fd });
					if (res.ok) {
						onsaved?.(((await res.json()) as { image: string }).image);
						open = false;
						hasImage = false;
						img = null;
					}
				} finally {
					saving = false;
				}
			},
			'image/webp',
			0.9
		);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Update photo</Dialog.Title>
		</Dialog.Header>

		<div class="flex flex-col items-center gap-4">
			{#if hasImage}
				<canvas
					bind:this={canvas}
					width={SIZE}
					height={SIZE}
					class="size-64 cursor-grab touch-none rounded-full border active:cursor-grabbing"
					onpointerdown={onDown}
					onpointermove={onMove}
					onpointerup={onUp}
					onpointerleave={onUp}
				></canvas>
				<input
					type="range"
					min={minScale}
					max={minScale * 3}
					step="0.01"
					value={scale}
					class="w-64"
					oninput={(e) => setScale(Number((e.target as HTMLInputElement).value))}
				/>
				<button type="button" class="text-muted-foreground hover:text-foreground text-xs" onclick={() => fileInput?.click()}>
					Choose a different image
				</button>
			{:else if image}
				<!-- Current photo as context; picking a file swaps to the cropper. -->
				<button
					type="button"
					class="group relative size-64 overflow-hidden rounded-full border"
					onclick={() => fileInput?.click()}
				>
					<img src={image} alt="Current avatar" class="size-full object-cover" />
					<span
						class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100"
					>
						<UploadIcon class="size-6" />
						<span class="text-sm">Choose new image</span>
					</span>
				</button>
			{:else}
				<button
					type="button"
					class="hover:bg-muted/60 flex size-64 flex-col items-center justify-center gap-2 rounded-full border border-dashed"
					onclick={() => fileInput?.click()}
				>
					<UploadIcon class="text-muted-foreground size-6" />
					<span class="text-muted-foreground text-sm">Choose an image</span>
				</button>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button disabled={!hasImage || saving} onclick={save}>{saving ? 'Saving…' : 'Save photo'}</Button>
		</Dialog.Footer>
		<input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={onFile} />
	</Dialog.Content>
</Dialog.Root>
