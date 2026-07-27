// SPDX-License-Identifier: Apache-2.0
// Generate the monochrome notification BADGE (the small status-bar icon shown
// "on top" of a push). Platforms require a white-on-transparent silhouette — a
// full-colour icon is ignored there. Draws a simple envelope, 96x96, grayscale+
// alpha PNG, using only node:zlib. Run once:  node scripts/gen-notification-badge.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 96;
const H = 96;
const a = new Uint8Array(W * H); // alpha, 0..255

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = Math.min(Math.max(x, x0 + r), x1 - r);
	const cy = Math.min(Math.max(y, y0 + r), y1 - r);
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
};
const distToSeg = (px, py, ax, ay, bx, by) => {
	const dx = bx - ax,
		dy = by - ay;
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Envelope body + a V flap carved out of the top.
const [x0, y0, x1, y1, r] = [14, 26, 82, 74, 9];
const apex = [48, y0 + 22];
for (let y = 0; y < H; y++) {
	for (let x = 0; x < W; x++) {
		if (!inRoundRect(x, y, x0, y0, x1, y1, r)) continue;
		const onFlap =
			distToSeg(x, y, x0 + 4, y0 + 4, apex[0], apex[1]) < 2 ||
			distToSeg(x, y, x1 - 4, y0 + 4, apex[0], apex[1]) < 2;
		a[y * W + x] = onFlap ? 0 : 255;
	}
}

// Encode grayscale+alpha (color type 4, depth 8): each row = filter(0) + [gray,alpha]*W.
const raw = Buffer.alloc(H * (1 + W * 2));
for (let y = 0; y < H; y++) {
	const o = y * (1 + W * 2);
	raw[o] = 0;
	for (let x = 0; x < W; x++) {
		raw[o + 1 + x * 2] = 255; // gray = white
		raw[o + 1 + x * 2 + 1] = a[y * W + x];
	}
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 4; // color type: grayscale + alpha
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk('IHDR', ihdr),
	chunk('IDAT', deflateSync(raw)),
	chunk('IEND', Buffer.alloc(0))
]);

const out = new URL('../apps/web/static/badge-96.png', import.meta.url);
writeFileSync(out, png);
console.log('wrote', out.pathname, png.length, 'bytes');
