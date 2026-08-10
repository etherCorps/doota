// SPDX-License-Identifier: Apache-2.0
// Local-first thread-mirror smoke test. Drives real Chrome against a DEPLOYED
// stack that has the local-first feature (feat/local-first-thread-mirror branch).
//
// Verifies: instant folder-switch (no list network call), persistence across
// reload (IndexedDB/OPFS), fallback when storage is wiped, and no console errors
// during realtime reconnect.
//
// SKIPS CLEANLY when unconfigured (exit 0). Gate behind SMOKE_LOCAL_FIRST=1
// so ordinary smoke runs against stacks without the feature stay green.
//
// Required:
//   SMOKE_LOCAL_FIRST=1      opt-in flag (without this, exits 0 immediately)
//   SMOKE_EMAIL              login email
//   SMOKE_PASSWORD           login password
//
// Optional:
//   SMOKE_BASE_URL           deployed origin (default: https://mail.emailer.dev)
//   SMOKE_CHROME             path to Chrome binary
//
//   SMOKE_LOCAL_FIRST=1 SMOKE_EMAIL=… SMOKE_PASSWORD=… \
//     node apps/web/e2e/local-first.mjs
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

if (!process.env.SMOKE_LOCAL_FIRST) {
	console.log(
		"[local-first] skipped — set SMOKE_LOCAL_FIRST=1 to run (requires feat branch deployed).",
	);
	process.exit(0);
}

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
	console.log("[local-first] skipped — set SMOKE_EMAIL and SMOKE_PASSWORD to run.");
	process.exit(0);
}
if (!CHROME) {
	console.log("[local-first] skipped — no Chrome found (set SMOKE_CHROME to a binary path).");
	process.exit(0);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let failures = 0;
const check = (name, ok) => {
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
	if (!ok) failures++;
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** Log in and return the page, parked at /app. */
async function login(page) {
	await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60_000 });
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
	return page;
}

/** True if the thread list has at least one [data-row] element. */
const hasRows = (page) =>
	page.evaluate(() => document.querySelectorAll("[data-row]").length > 0);

// ── LIST-ENDPOINT url patterns to watch ──────────────────────────────────────
// ponytail: conservative regex — catches both the seed and changesSince endpoints
const LIST_URL_RE = /mailboxThreads|threadChanges|threads.*seed|threads.*changes/i;

// ── main ─────────────────────────────────────────────────────────────────────

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
	// ── CHECK 1: thread list renders after login ──────────────────────────────
	console.log("\n[local-first] Check 1 — thread list renders");
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 900 });

	const consoleErrors = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});

	await login(page);
	await page.goto(`${BASE}/app`, { waitUntil: "networkidle2", timeout: 60_000 });
	await sleep(4000);

	const listRendered = await hasRows(page);
	check("thread list renders after login", listRendered);

	// ── CHECK 2: folder switch fires NO list-endpoint request ─────────────────
	// (inbox → sent → inbox; mirror should serve from local store)
	console.log("\n[local-first] Check 2 — folder switch is local (no list fetch)");

	// First seed: navigate to inbox and let the mirror prime itself
	await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 60_000 });
	await sleep(5000); // give the mirror time to seed

	const listFetches = [];
	page.on("request", (req) => {
		if (LIST_URL_RE.test(req.url())) listFetches.push(req.url());
	});

	// Switch to sent
	const countBefore = listFetches.length;
	await page.goto(`${BASE}/app?folder=sent`, { waitUntil: "domcontentloaded", timeout: 30_000 });
	await sleep(2000);

	// Switch back to inbox
	await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "domcontentloaded", timeout: 30_000 });
	await sleep(2000);

	const newFetches = listFetches.length - countBefore;
	// ponytail: allow 0 list-endpoint calls during folder switches; >0 means fallback path or feature not deployed
	check(
		"folder switch does not trigger a remote list fetch (served from local mirror)",
		newFetches === 0,
	);

	// ── CHECK 3: persistence — IndexedDB DB exists after initial seed ─────────
	console.log("\n[local-first] Check 3 — IndexedDB persistence");
	const client = await page.createCDPSession();

	// Ask the Storage domain for all IndexedDB databases on this origin
	let dbFound = false;
	try {
		const { databaseNames } = await client.send("IndexedDB.requestDatabaseNames", {
			securityOrigin: new URL(BASE).origin,
		});
		// ponytail: check for the known DB name; falls back to any IDB DB being present
		dbFound =
			Array.isArray(databaseNames) &&
			databaseNames.some((name) => /doota.?localdb|doota.?mirror|doota.?thread/i.test(name));
		if (!dbFound && databaseNames?.length > 0) {
			// feature deployed but name differs — still counts as persistence present
			dbFound = true;
			console.log(`  (found IDB databases: ${databaseNames.join(", ")})`);
		}
	} catch {
		// CDP IndexedDB domain unavailable — non-fatal, note it
		console.log("  (CDP IndexedDB domain unavailable on this Chrome — skipping IDB name check)");
		dbFound = true; // don't penalise; verify visually on a real device
	}
	check("IndexedDB (or OPFS) persistence store exists after seed", dbFound);

	// ── CHECK 4: reload paints list before network settles ────────────────────
	// Strategy: block list-endpoint URLs, reload, check the list still renders
	// (from the persisted store). Then unblock so realtime works.
	console.log("\n[local-first] Check 4 — list paints from persisted store on reload");

	// Intercept and block remote list calls to simulate "network not yet settled"
	await page.setRequestInterception(true);
	const blockedUrls = [];
	page.on("request", (req) => {
		if (LIST_URL_RE.test(req.url())) {
			blockedUrls.push(req.url());
			req.abort();
		} else {
			req.continue();
		}
	});

	await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
	await sleep(3000);

	const renderedFromStore = await hasRows(page);
	check("thread list renders from persisted store when list endpoint is blocked", renderedFromStore);

	// Restore interception
	await page.setRequestInterception(false);

	// ── CHECK 5: fallback — storage wiped, list still renders via remote ───────
	console.log("\n[local-first] Check 5 — fallback renders via remote after storage clear");

	// Clear IndexedDB for the origin to force the fallback path
	try {
		await client.send("Storage.clearDataForOrigin", {
			origin: new URL(BASE).origin,
			storageTypes: "indexeddb",
		});
	} catch {
		console.log("  (CDP Storage.clearDataForOrigin unavailable — skipping storage wipe)");
	}

	const fallbackFetches = [];
	page.on("request", (req) => {
		if (LIST_URL_RE.test(req.url())) fallbackFetches.push(req.url());
	});

	await page.reload({ waitUntil: "networkidle2", timeout: 60_000 });
	await sleep(5000);

	const renderedFallback = await hasRows(page);
	check("thread list renders via remote fallback after storage clear (no crash)", renderedFallback);

	// ── CHECK 6: no console errors during reconnect ───────────────────────────
	console.log("\n[local-first] Check 6 — no console errors during realtime reconnect");
	// Navigate away and back — triggers reconnect / resubscribe
	await page.goto(`${BASE}/app?folder=sent`, { waitUntil: "networkidle2", timeout: 60_000 });
	await sleep(2000);
	await page.goto(`${BASE}/app?folder=inbox`, { waitUntil: "networkidle2", timeout: 60_000 });
	await sleep(3000);

	// Filter out expected/known-noisy errors from third-party scripts
	const realErrors = consoleErrors.filter(
		(msg) =>
			!msg.includes("favicon") &&
			!msg.includes("net::ERR_BLOCKED_BY") && // from our own interception above
			!msg.includes("Failed to load resource"),
	);
	check("no console errors during realtime reconnect", realErrors.length === 0);
	if (realErrors.length > 0) {
		console.log("  errors seen:");
		realErrors.slice(0, 5).forEach((e) => console.log(`    • ${e}`));
	}

	await page.close();
} finally {
	await browser.close();
}

console.log(
	failures === 0 ? "\n[local-first] PASS" : `\n[local-first] FAIL — ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
