// SPDX-License-Identifier: Apache-2.0
// Attachment-preview smoke test. Drives a real Chrome against a DEPLOYED stack
// (staging by default) through the flow unit tests are blind to — the class of
// bug that only shows at runtime: CORS/opaque-origin, iframe sandbox, CSP,
// rAF throttling, color-scheme canvas, cross-frame postMessage, downloads.
//
// SKIPS CLEANLY when unconfigured (exit 0), so it never breaks `pnpm test` or a
// CI job without secrets. To run it, set:
//   SMOKE_BASE_URL   deployed origin           (default https://mail.emailer.dev)
//   SMOKE_EMAIL      login email               (required)
//   SMOKE_PASSWORD   login password            (required)
//   SMOKE_CHROME     path to a Chrome binary   (default: common OS locations)
//
//   SMOKE_EMAIL=… SMOKE_PASSWORD=… pnpm --filter @doota/web run test:e2e
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "https://mail.emailer.dev";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;

const CHROME_CANDIDATES = [
	process.env.SMOKE_CHROME,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((path) => existsSync(path));

if (!EMAIL || !PASSWORD) {
	console.log("[smoke] skipped — set SMOKE_EMAIL and SMOKE_PASSWORD to run.");
	process.exit(0);
}
if (!CHROME) {
	console.log("[smoke] skipped — no Chrome found (set SMOKE_CHROME to a binary path).");
	process.exit(0);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let failures = 0;
const check = (name, ok) => {
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
	if (!ok) failures++;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 900 });
	const client = await page.createCDPSession();
	await client.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: "/tmp",
		eventsEnabled: true,
	});
	const downloads = [];
	client.on("Browser.downloadWillBegin", (event) => downloads.push(event.suggestedFilename));

	// 1) Login.
	await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
	await sleep(1500);
	await page.type('input[type="email"], input[name="email"]', EMAIL);
	await page.type('input[type="password"]', PASSWORD);
	for (const button of await page.$$("button")) {
		const label = await button.evaluate((el) => el.textContent?.trim() ?? "");
		if (/sign in|log in|continue/i.test(label)) {
			await button.click();
			break;
		}
	}
	await sleep(6000);
	check("login lands in the app", /\/app/.test(page.url()));

	// 2) Find a thread that has a viewable attachment (walk the Sent view — the
	// smoke assumes the account has at least one attachment there).
	await page.goto(`${BASE}/app?folder=sent`, { waitUntil: "networkidle2", timeout: 60000 });
	await sleep(4000);
	// Open rows by their own click handler (a synthetic click on the row's main
	// button/link) rather than by pixel coordinates — flip-animated rows move
	// under a measured box and the click misses.
	const rowCount = await page.evaluate(() => document.querySelectorAll("[data-row]").length);
	let opened = false;
	for (let index = 0; index < Math.min(rowCount, 15) && !opened; index++) {
		await page.evaluate((rowIndex) => {
			const row = document.querySelectorAll("[data-row]")[rowIndex];
			const target =
				row?.querySelector("button:not([aria-label]), a[href*='thread'], [role='button']") ?? row;
			target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		}, index);
		// Poll for the reading pane to load attachments (lazy render).
		for (let wait = 0; wait < 8 && !opened; wait++) {
			await sleep(1000);
			opened = await page.evaluate(
				() =>
					!!document.querySelector(
						'a[download][title^="Preview"], a[download][title^="Download"]',
					),
			);
		}
	}
	check("opened a thread with an attachment", opened);

	// 3) Preview: click the first previewable tile, expect the sandboxed frame.
	const previewable = await page.evaluate(() => {
		const anchor = [...document.querySelectorAll("a[download]")].find((a) =>
			a.title?.startsWith("Preview"),
		);
		anchor?.click();
		return !!anchor;
	});
	if (previewable) {
		await sleep(12000);
		const frame = await page.evaluate(() => {
			const dialog = document.querySelector('[role="dialog"]');
			const iframe = dialog?.querySelector('iframe[title="Attachment preview"]');
			return iframe
				? { open: true, sandboxed: (iframe.getAttribute("sandbox") ?? "").includes("allow-scripts") }
				: { open: false };
		});
		check("preview opens in a sandboxed frame", frame.open && frame.sandboxed);
		await page.keyboard.press("Escape");
		await sleep(1200);
	} else {
		console.log("  – no previewable tile in this thread (skipping preview assert)");
	}

	// 4) Download: the explicit download control fires a real download.
	const clickedDownload = await page.evaluate(() => {
		const button = document.querySelector('button[aria-label^="Download"]');
		button?.click();
		return !!button;
	});
	if (clickedDownload) {
		await sleep(5000);
		check("download control triggers a browser download", downloads.length > 0);
	} else {
		console.log("  – no download control found (skipping download assert)");
	}
} finally {
	await browser.close();
}

console.log(failures === 0 ? "\n[smoke] PASS" : `\n[smoke] FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
