// SPDX-License-Identifier: Apache-2.0
// Generate iOS apple-touch-startup-image splash screens: the Doota logo centered
// on the brand-dark background, at every current + recent iPhone/iPad pixel size,
// portrait and landscape. iOS matches a startup image only by an exact media
// query (device CSS size + DPR + orientation), so we emit one <link> per device
// per orientation. Re-run when Apple ships a new resolution:
//   node apps/web/scripts/gen-ios-splash.mjs   (from repo root, or `node scripts/...` in apps/web)
// It writes PNGs to static/splash/ and prints the <link> block for src/app.html.
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = join(appRoot, 'static');
const outDir = join(staticDir, 'splash');
mkdirSync(outDir, { recursive: true });

const BG = { r: 0x15, g: 0x17, b: 0x1e, alpha: 1 }; // manifest background_color
const logoSvg = readFileSync(join(staticDir, 'favicon.svg'));

// [cssWidth, cssHeight, devicePixelRatio] in portrait. Covers the current iPhone
// lineup + recent legacy + the iPad sizes. Multiple models share a pixel size;
// we dedupe the images but still emit a media query per model.
const devices = [
	// iPhones
	[375, 667, 2], // SE (2/3), 8, 7, 6s
	[414, 736, 3], // 8+, 7+, 6s+
	[375, 812, 3], // X, XS, 11 Pro
	[360, 780, 3], // 12 mini, 13 mini
	[414, 896, 2], // XR, 11
	[414, 896, 3], // XS Max, 11 Pro Max
	[390, 844, 3], // 12, 12 Pro, 13, 13 Pro, 14
	[428, 926, 3], // 12 Pro Max, 13 Pro Max, 14 Plus
	[393, 852, 3], // 14 Pro, 15, 15 Pro, 16
	[430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
	[402, 874, 3], // 16 Pro
	[440, 956, 3], // 16 Pro Max
	// iPads (DPR 2)
	[768, 1024, 2], // mini, 9.7"
	[810, 1080, 2], // 10.2"
	[820, 1180, 2], // 10.9" (10th gen)
	[834, 1112, 2], // Air / Pro 10.5"
	[834, 1194, 2], // 11" Pro / Air
	[1024, 1366, 2], // 12.9" Pro
	[1032, 1376, 2] // 13" (M4)
];

const canvas = async (w, h) => {
	const logoPx = Math.round(Math.min(w, h) * 0.26);
	const logo = await sharp(logoSvg).resize(logoPx, logoPx).png().toBuffer();
	return sharp({ create: { width: w, height: h, channels: 4, background: BG } })
		.composite([{ input: logo, gravity: 'center' }])
		.png({ compressionLevel: 9 })
		.toBuffer();
};

const made = new Set();
const write = async (w, h) => {
	const name = `apple-splash-${w}x${h}.png`;
	if (!made.has(name)) {
		writeFileSync(join(outDir, name), await canvas(w, h));
		made.add(name);
	}
	return name;
};

const links = [];
for (const [cw, ch, dpr] of devices) {
	const pW = cw * dpr;
	const pH = ch * dpr;
	const portrait = await write(pW, pH);
	const landscape = await write(pH, pW);
	const q = (o, file) =>
		`\t\t<link rel="apple-touch-startup-image" media="screen and (device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${o})" href="%sveltekit.assets%/splash/${file}" />`;
	links.push(q('portrait', portrait));
	links.push(q('landscape', landscape));
}

writeFileSync(join(outDir, 'links.html'), links.join('\n') + '\n');
console.log(`Wrote ${made.size} images to static/splash/`);
console.log(`Link block (${links.length} tags) written to static/splash/links.html`);
