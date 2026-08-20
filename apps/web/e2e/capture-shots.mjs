// SPDX-License-Identifier: Apache-2.0
// README/docs screenshots against a DEPLOYED stack, at four form factors × two
// themes. Read-only: opens views and photographs them, mutates nothing.
//
//   SMOKE_EMAIL=… SMOKE_PASSWORD=… node e2e/capture-shots.mjs [screen…]
//
// Raw PNGs land in .shots/raw/<screen>-<form>-<theme>.png at the repo root
// (gitignored) — polish them, then move the keepers into
// apps/docs/public/media/.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "https://mail.emailer.dev";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.shots/raw");
const CHROME = [
	process.env.SMOKE_CHROME,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find((path) => existsSync(path));

if (!EMAIL || !PASSWORD || !CHROME) {
	console.log("capture-shots: need SMOKE_EMAIL, SMOKE_PASSWORD and a Chrome binary.");
	process.exit(0);
}
mkdirSync(OUT, { recursive: true });

// deviceScaleFactor 2 everywhere: retina-sharp, and `sips` can halve it later
// if a file lands too heavy for the repo.
const FORMS = [
	{ key: "mobile", width: 390, height: 844, touch: true },
	{ key: "tablet", width: 834, height: 1112, touch: true },
	{ key: "laptop", width: 1440, height: 900, touch: false },
	{ key: "desktop", width: 1920, height: 1080, touch: false },
];
const ONLY = process.argv.slice(2);
const wanted = (screen) => ONLY.length === 0 || ONLY.includes(screen);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: false,
	defaultViewport: null,
	args: ["--window-size=1960,1180", "--window-position=0,0", "--hide-scrollbars"],
});
const page = await browser.newPage();
const cdp = await page.createCDPSession();
// Without focus emulation `document.hasFocus()` is false whenever Chrome isn't
// the OS key window, and several focus-gated surfaces render dead.
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

// ------------------------------------------------------------------ login ---
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
await sleep(1500);
await page.type('input[type="email"], input[name="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
for (const button of await page.$$("button")) {
	const label = await button.evaluate((el) => el.textContent?.trim() ?? "");
	if (/sign in|log in|continue/i.test(label)) { await button.click(); break; }
}
for (let wait = 0; wait < 30 && !/\/app/.test(page.url()); wait++) await sleep(1000);
if (!/\/app/.test(page.url())) { console.log("login failed"); await browser.close(); process.exit(1); }
console.log("logged in");

async function applyForm(form, theme) {
	await page.setViewport({
		width: form.width,
		height: form.height,
		deviceScaleFactor: 2,
		isMobile: form.touch,
		hasTouch: form.touch,
	});
	// mode-watcher persists the choice; emulated media covers the `system` path
	// and anything reading the media query directly (e.g. the coarse-pointer
	// font-size floor).
	await cdp.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: theme }],
	});
	await page.evaluate((mode) => localStorage.setItem("mode-watcher-mode", mode), theme);
}

const shot = async (name) => {
	const file = `${OUT}/${name}.png`;
	await page.screenshot({ path: file });
	console.log(`  → ${name}.png`);
};

/** Open list row `index`; on mobile this navigates, on desktop it fills the pane. */
const openThreadRow = (index) => page.evaluate((idx) => {
	const row = document.querySelectorAll("[data-row]")[idx];
	const opener = row?.querySelector("button.flex-1, button:not([aria-label])") ?? row;
	opener?.click();
	return Boolean(row);
}, index);

const messageCount = () => page.evaluate(() => document.querySelectorAll("[data-msg]").length);

/** Wait for a thread to paint, up to ~11s. */
async function waitForThread() {
	let messages = 0;
	for (let wait = 0; wait < 12 && messages === 0; wait++) {
		await sleep(900);
		messages = await messageCount();
	}
	return messages;
}

// The first inbox row is usually a one-message forward, which photographs as a
// mostly-empty pane — the chat timeline is the whole point, so pick the row
// with the most messages instead. Row order is stable across viewports, so one
// scan up front serves every form factor.
async function findRichestRow() {
	if (process.env.SHOT_THREAD_ROW) return Number(process.env.SHOT_THREAD_ROW);
	await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
	await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
	await sleep(3500);
	const rows = await page.evaluate(() => document.querySelectorAll("[data-row]").length);
	let best = { index: 0, messages: 0 };
	for (let index = 0; index < Math.min(rows, 8); index++) {
		await openThreadRow(index);
		const messages = await waitForThread();
		if (messages > best.messages) best = { index, messages };
	}
	console.log(`thread row ${best.index} (${best.messages} messages)`);
	return best.index;
}

const threadRow = wanted("thread") ? await findRichestRow() : 0;

for (const form of FORMS) {
	for (const theme of ["light", "dark"]) {
		await applyForm(form, theme);

		if (wanted("inbox")) {
			await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
			await sleep(3500);
			await shot(`inbox-${form.key}-${theme}`);
		}

		if (wanted("thread")) {
			await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
			await sleep(3000);
			await openThreadRow(threadRow);
			await waitForThread();
			await sleep(1200);
			await shot(`thread-${form.key}-${theme}`);
		}

		if (wanted("composer")) {
			// Two different composers by design: below the 768 shell switch it is
			// a real page (/app/compose); above it, a panel the sidebar opens.
			if (form.width < 768) {
				await page.goto(`${BASE}/app/compose`, { waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
				await sleep(3000);
			} else {
				await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
				await sleep(3000);
				const opened = await page.evaluate(() => {
					const button = [...document.querySelectorAll("button, a")]
						.find((el) => /^compose$/i.test(el.textContent?.trim() ?? ""));
					button?.click();
					return Boolean(button);
				});
				if (!opened) console.log(`  ! no Compose trigger at ${form.key}`);
				await sleep(2500);
			}
			await shot(`composer-${form.key}-${theme}`);
		}

		// The desktop panel expands to a full-screen composer. A tablet is already
		// past the shell switch but the panel fills the viewport there, so it has
		// no expand control — and below the switch compose is a whole page anyway.
		if (wanted("composer-full") && form.width >= 1024) {
			await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
			await sleep(3000);
			await page.evaluate(() => {
				const button = [...document.querySelectorAll("button, a")]
					.find((el) => /^compose$/i.test(el.textContent?.trim() ?? ""));
				button?.click();
			});
			await sleep(2000);
			const expanded = await page.evaluate(() => {
				const button = document.querySelector('button[title="Full screen"]');
				button?.click();
				return Boolean(button);
			});
			if (!expanded) console.log(`  ! no Full screen control at ${form.key}`);
			await sleep(1800);
			await shot(`composer-full-${form.key}-${theme}`);
		}
	}
	console.log(`${form.key} done`);
}

await browser.close();
console.log(`\nRaw shots in ${OUT}`);
