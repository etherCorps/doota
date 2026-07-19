import type { RequestHandler } from '@sveltejs/kit';
import { ImageResponse } from '@ethercorps/sveltekit-og/takumi';
import { GoogleFont, resolveFonts } from '@ethercorps/sveltekit-og/fonts';
import OgComponent from '$lib/OgCard.svelte';

// 1. Define the fonts to load — Doota's design fonts (see app.html / app.css)
const fonts = [
	// These fonts will be fetched and cached globally
	new GoogleFont('Bricolage Grotesque', { weight: 800 }), // display: headline + wordmark
	new GoogleFont('Inter', { weight: 400 }), // body
	new GoogleFont('Inter', { weight: 600 }) // labels / badges
];

// 2. Enable prerendering
export const prerender = true;

export const GET: RequestHandler = async ({ params }) => {
	const resolvedFonts = await resolveFonts(fonts);

  return new ImageResponse(
		OgComponent,
		{
			height: 630,
			width: 1200,
			fonts: resolvedFonts,
			// Aggressive Caching for static built files
			// headers: {
			// 	'Cache-Control': 'public, immutable, max-age=31536000'
			// }
		}
	);
};
