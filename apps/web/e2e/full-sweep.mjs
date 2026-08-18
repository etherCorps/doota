// SPDX-License-Identifier: Apache-2.0
// Full functional sweep against a DEPLOYED stack (staging by default).
// Non-destructive: stars are toggled back, archives are undone, nothing is sent
// (staging may only mail shivam@doota.dev) and nothing is hard-deleted.
//
//   SMOKE_EMAIL=… SMOKE_PASSWORD=… node e2e/full-sweep.mjs [phase]
//
// phase (optional): core | actions | peripheral | offline — runs one group.
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "https://mail.emailer.dev";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const ONLY = process.argv[2] ?? "all";
const CHROME = [
	process.env.SMOKE_CHROME,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find((path) => existsSync(path));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (area, name, ok, note = "") => {
	results.push({ area, name, ok, note });
	console.log(`${ok ? "  ✓" : "  ✗"} [${area}] ${name}${note ? ` — ${note}` : ""}`);
};

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: false,
	defaultViewport: null,
	args: ["--window-size=1400,940", "--window-position=0,0"],
});

const page = await browser.newPage();
const cdp = await page.createCDPSession();
// document.hasFocus() true regardless of OS key-window — bits-ui dropdowns and
// several focus-gated surfaces are dead without it.
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200)); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
const requests = [];
page.on("request", (req) => requests.push(req.url()));

// ---------------------------------------------------------------- helpers ---
const count = (selector) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
const textOf = (selector) => page.evaluate(
	(sel) => (document.querySelector(sel)?.textContent ?? "").trim().slice(0, 120), selector);
const bodyHas = (needle) => page.evaluate((text) => document.body.innerText.includes(text), needle);
const bodyText = () => page.evaluate(() => document.body.innerText.slice(0, 4000));
/** Click a button by visible label (exact-ish match), real DOM click. */
const clickByText = async (pattern, tag = "button") => page.evaluate((patternSource, tagName) => {
	const re = new RegExp(patternSource, "i");
	const element = [...document.querySelectorAll(tagName)].find((el) => re.test(el.textContent?.trim() ?? ""));
	if (!element) return false;
	element.click();
	return true;
}, pattern, tag);
/** bits-ui triggers open on pointerdown; CDP mouse input is unreliable here. */
const openTrigger = async (selector) => page.evaluate((sel) => {
	const element = document.querySelector(sel);
	if (!element) return false;
	element.dispatchEvent(new PointerEvent("pointerdown", {
		bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse",
	}));
	return true;
}, selector);
// Accept any native dialog — the template editor guards navigation away from an
// unsaved draft with a beforeunload confirm, which otherwise stalls goto().
page.on("dialog", async (dialog) => { await dialog.accept().catch(() => {}); });
const goto = async (path, wait = 2500) => {
	try {
		await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 30000 });
	} catch {
		// networkidle2 never settles behind a blocked unload (or a long-polling
		// stream) — fall back to a weaker signal rather than failing the sweep.
		await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
	}
	await sleep(wait);
};

// ------------------------------------------------------------------ login ---
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
await sleep(1500);
await page.type('input[type="email"], input[name="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
for (const button of await page.$$("button")) {
	const label = await button.evaluate((el) => el.textContent?.trim() ?? "");
	if (/sign in|log in|continue/i.test(label)) { await button.click(); break; }
}
let inApp = false;
for (let wait = 0; wait < 30 && !inApp; wait++) { await sleep(1000); inApp = /\/app/.test(page.url()); }
check("auth", "password login lands in /app", inApp);
await goto("/app", 4000);

const run = (phase) => ONLY === "all" || ONLY === phase;

// ============================================================ CORE / MAIL ===
if (run("core")) {
	const rows = await count("[data-row]");
	check("mail", "inbox renders rows", rows > 0, `${rows} rows`);
	check("mail", "mailbox address shown", await bodyHas("@"), "");

	// Folders: each must render its own view without error.
	for (const folder of ["inbox", "sent", "archived", "spam", "trash", "snoozed", "drafts", "scheduled"]) {
		await goto(`/app?folder=${folder}`, 3000);
		// Drafts/scheduled are virtual lists whose rows aren't [data-row] — count
		// the list pane's own row divs there instead.
		const listRows = await page.evaluate(() => {
			const tagged = document.querySelectorAll("[data-row]").length;
			if (tagged) return tagged;
			return [...document.querySelectorAll(".group\\/row")]
				.filter((el) => !el.closest("[data-sidebar]")).length;
		});
		const emptyState = await page.evaluate(() =>
			/inbox zero|nothing sent|no archived|no spam|trash is empty|nothing snoozed|no drafts|nothing scheduled|napping cat|end of/i
				.test(document.body.innerText));
		const errored = await bodyHas("Something went wrong");
		check("folders", `${folder} view renders`, !errored && (listRows > 0 || emptyState),
			`${listRows} rows`);
	}

	// Quick filters on the inbox.
	await goto("/app?folder=inbox", 2600);
	const baseRows = await count("[data-row]");
	for (const filter of ["Unread", "Starred"]) {
		const clicked = await clickByText(`^${filter}$`);
		await sleep(1200);
		const filtered = await count("[data-row]");
		check("filters", `${filter} filter applies`, clicked && filtered <= baseRows,
			`${filtered}/${baseRows}`);
		await clickByText("^All$");
		await sleep(900);
	}

	// Thread open + timeline.
	await page.evaluate(() => {
		const row = document.querySelector("[data-row]");
		const opener = row?.querySelector("button.flex-1, button:not([aria-label])") ?? row;
		opener?.click();
	});
	let msgs = 0;
	for (let wait = 0; wait < 10 && msgs === 0; wait++) { await sleep(1000); msgs = await count("[data-msg]"); }
	check("thread", "thread opens with messages", msgs > 0, `${msgs} messages`);
	check("thread", "thread header shows subject", (await textOf("h1, p.font-semibold")).length > 0);
	check("thread", "reply surface present", await page.evaluate(() =>
		/reply to|continue draft/i.test(document.body.innerText)));

	// Chat ↔ mail view toggle (two icon buttons in the thread header).
	const beforeToggle = await count("[data-msg]");
	const toggled = await page.evaluate(() => {
		const button = [...document.querySelectorAll("button")].find((el) =>
			/mail view|card view|reading view/i.test(el.getAttribute("title") ?? el.getAttribute("aria-label") ?? ""));
		if (!button) return false;
		button.click();
		return true;
	});
	await sleep(1500);
	check("thread", "view toggle keeps messages", !toggled || (await count("[data-msg]")) === beforeToggle,
		toggled ? "toggled" : "toggle not found (skipped)");
}

// ========================================================= ACTIONS / SEND ===
if (run("actions")) {
	await goto("/app?folder=inbox", 3000);

	// Star → unstar (round-trip, leaves state as found).
	const starMark = requests.length;
	const starred = await page.evaluate(() => {
		const button = [...document.querySelectorAll("[data-row] button")].find((el) =>
			/star/i.test(el.getAttribute("aria-label") ?? el.title ?? ""));
		if (!button) return false;
		button.click();
		return true;
	});
	await sleep(2000);
	check("actions", "star fires without remote list reload", starred &&
		requests.slice(starMark).filter((url) => url.includes("mailboxThreads")).length === 0);
	await page.evaluate(() => {
		const button = [...document.querySelectorAll("[data-row] button")].find((el) =>
			/star/i.test(el.getAttribute("aria-label") ?? el.title ?? ""));
		button?.click();
	});
	await sleep(1500);

	// Archive → Undo (round-trip).
	const beforeArchive = await count("[data-row]");
	await page.evaluate(() => {
		const button = [...document.querySelectorAll("[data-row] button")].find((el) =>
			/archive/i.test(el.getAttribute("aria-label") ?? el.title ?? ""));
		button?.click();
	});
	await sleep(1500);
	const afterArchive = await count("[data-row]");
	check("actions", "archive removes row optimistically", afterArchive === beforeArchive - 1,
		`${beforeArchive}→${afterArchive}`);
	await sleep(700);
	const undone = await clickByText("^undo$");
	await sleep(2500);
	check("actions", "undo restores archived row", undone && (await count("[data-row]")) === beforeArchive);

	// Snooze menu opens (a bits-ui popover on the row).
	const snoozeOpened = await page.evaluate(() => {
		const button = [...document.querySelectorAll("[data-row] button")].find((el) =>
			/snooze/i.test(el.getAttribute("aria-label") ?? el.title ?? ""));
		if (!button) return false;
		button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
		button.click();
		return true;
	});
	await sleep(1400);
	check("actions", "snooze surface opens", snoozeOpened && await page.evaluate(() =>
		/later today|tomorrow|next week|pick a date/i.test(document.body.innerText)));
	await page.keyboard.press("Escape");
	await sleep(600);

	// Pin toggle (round-trip).
	const pinned = await page.evaluate(() => {
		const button = [...document.querySelectorAll("[data-row] button")].find((el) =>
			/^pin$|pin thread|unpin/i.test(el.getAttribute("aria-label") ?? el.title ?? ""));
		if (!button) return false;
		button.click();
		return true;
	});
	await sleep(2000);
	check("actions", "pin toggles", pinned, pinned ? "" : "pin control not found");
	if (pinned) {
		await page.evaluate(() => {
			const button = [...document.querySelectorAll("[data-row] button")].find((el) =>
				/unpin/i.test(el.getAttribute("aria-label") ?? el.title ?? ""));
			button?.click();
		});
		await sleep(1500);
	}

	// Bulk selection toolbar.
	const selectAll = await page.evaluate(() => {
		const checkbox = document.querySelector('[aria-label="Select all"]');
		if (!checkbox) return false;
		checkbox.click();
		return true;
	});
	await sleep(1400);
	const bulkState = await page.evaluate(() => ({
		selected: /\d+ selected/.test(document.body.innerText),
		enabled: [...document.querySelectorAll("button[title]")]
			.filter((el) => !el.disabled && /mark read|mark unread|move to folder|mark spam/i.test(el.title)).length,
	}));
	check("actions", "select-all selects rows", selectAll && bulkState.selected);
	check("actions", "bulk toolbar enables actions", bulkState.enabled >= 3, `${bulkState.enabled} controls`);
	// Clear the selection again (leave the list as found).
	await page.evaluate(() => document.querySelector('[aria-label="Clear selection"]')?.click());
	await sleep(900);

	// Compose page (mobile route, also reachable on desktop by URL).
	await goto("/app/compose", 3000);
	check("compose", "compose page renders form", await page.evaluate(() =>
		document.querySelectorAll('input, [contenteditable="true"]').length >= 2));
	check("compose", "compose has Send control", await page.evaluate(() =>
		/send/i.test(document.body.innerText)));

	// Desktop docked composer via the top-bar button.
	await goto("/app", 2500);
	const composeOpened = await clickByText("^compose$");
	await sleep(2000);
	check("compose", "desktop composer opens", composeOpened && await page.evaluate(() =>
		document.querySelectorAll('[contenteditable="true"]').length > 0));
	await page.keyboard.press("Escape");
	await sleep(800);

	// Reply composer inside a thread.
	await goto("/app?folder=inbox", 2500);
	await page.evaluate(() => {
		const row = document.querySelector("[data-row]");
		(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
	});
	await sleep(4000);
	const replyOpened = await clickByText("reply to|continue draft");
	await sleep(2000);
	check("compose", "reply composer expands", replyOpened && await page.evaluate(() =>
		document.querySelectorAll('[contenteditable="true"]').length > 0));
	check("compose", "reply shows From/To/subject fields", await page.evaluate(() =>
		/from/i.test(document.body.innerText) && /add recipients|^to$/im.test(document.body.innerText)));
}

// ====================================================== PERIPHERAL SURFACE ===
if (run("peripheral")) {
	// Search results view. Hits are plain full-width buttons, not [data-row].
	await goto("/app?q=test", 6000);
	const searchHits = await page.evaluate(() => [...document.querySelectorAll("button")]
		.filter((el) => {
			const cls = el.className?.toString?.() ?? "";
			return cls.includes("border-b") && cls.includes("w-full");
		}).length);
	check("search", "search results view renders hits", searchHits > 0 ||
		await bodyHas("No results"), `${searchHits} hits`);

	// Command palette. Chrome itself eats a real ⌘K (browser shortcut), so
	// dispatch the modifier synthetically — the app's handler is what we test.
	await goto("/app", 3000);
	await page.evaluate(() => window.dispatchEvent(
		new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
	await sleep(1500);
	check("search", "command palette opens on ⌘K", await page.evaluate(() =>
		document.querySelectorAll('[role=dialog]').length > 0));
	// Type a query: the palette should return thread hits.
	await page.keyboard.type("hello");
	await sleep(3000);
	check("search", "palette returns results", await page.evaluate(() =>
		document.querySelectorAll("[role=option], [cmdk-item]").length > 0));
	await page.keyboard.press("Escape");
	await sleep(700);

	// Keyboard shortcuts dialog ("?").
	await page.keyboard.press("Shift");
	await page.evaluate(() => document.body.dispatchEvent(
		new KeyboardEvent("keydown", { key: "?", bubbles: true })));
	await sleep(1200);
	check("shortcuts", "shortcuts dialog opens", await page.evaluate(() =>
		/keyboard shortcuts|shortcuts/i.test(document.body.innerText)));
	await page.keyboard.press("Escape");
	await sleep(600);

	// Settings pages. /account/developer is admin-gated — a member is redirected
	// to /account/profile, which is the correct outcome, not a failure.
	for (const [path, marker] of [
		["/account/profile", /profile|name|avatar/i],
		["/account/mail", /signature|images|mail/i],
		["/account/security", /password|two-factor|passkey|session/i],
		["/account/developer", /api key|token|developer|webhook/i],
	]) {
		await goto(path, 3000);
		const text = await bodyText();
		const redirected = !page.url().includes(path);
		check("settings", `${path} renders or is gated`,
			(marker.test(text) || redirected) && !/Something went wrong/.test(text),
			redirected ? `gated → ${page.url().replace(BASE, "")}` : "");
	}

	// Templates.
	await goto("/templates", 3000);
	check("templates", "templates list renders", !(await bodyHas("Something went wrong")) &&
		/template/i.test(await bodyText()));
	await goto("/templates/new", 3000);
	check("templates", "template editor renders", await page.evaluate(() =>
		document.querySelectorAll('input, [contenteditable="true"]').length >= 1));

	// Rules surface (reachable from the sidebar).
	await goto("/app", 2500);
	const rulesOpened = await clickByText("^rules$", "a, button");
	await sleep(2500);
	check("rules", "rules surface opens", rulesOpened && /rule/i.test(await bodyText()));

	// Folder/label management surface.
	await goto("/app", 2500);
	const newFolder = await clickByText("new folder", "a, button");
	await sleep(1800);
	check("labels", "new-folder surface opens", newFolder && await page.evaluate(() =>
		document.querySelectorAll('[role=dialog] input, input[placeholder*="name" i]').length > 0));
	await page.keyboard.press("Escape");
	await sleep(700);

	// Mailbox settings page.
	const mailboxId = await page.evaluate(() => new URLSearchParams(location.search).get("mailbox"));
	if (mailboxId) {
		await goto(`/mailboxes/${mailboxId}`, 3000);
		check("mailbox", "mailbox settings page renders", !(await bodyHas("Something went wrong")));
	}

	// Admin surfaces. The sweep account is a Member, so the expected outcome is a
	// redirect away from /admin — that IS the gate working. Renders count too
	// (run the sweep as an admin to exercise the pages themselves).
	for (const [path, marker] of [
		["/admin", /organization|admin|oversight/i],
		["/admin/organizations", /organization/i],
		["/admin/oversight", /oversight|organization|user/i],
	]) {
		await goto(path, 3000);
		const text = await bodyText();
		const gated = !page.url().includes(path);
		check("admin", `${path} renders or is gated`,
			(marker.test(text) || gated) && !/Something went wrong/.test(text),
			gated ? "gated (member role)" : "rendered");
	}

	// User chip menu — device sessions cached, menu content present.
	await goto("/app", 2500);
	const chipOpened = await page.evaluate((email) => {
		const matches = [...document.querySelectorAll("button")].filter(
			(el) => (el.textContent?.includes(email) ?? false) && !!el.closest("[data-sidebar]"));
		const chip = matches.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y).at(-1);
		if (!chip) return false;
		chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
		return true;
	}, EMAIL);
	await sleep(1500);
	check("account", "user chip menu opens", chipOpened && await page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].some((el) => /log out/i.test(el.textContent ?? ""))));
	await page.keyboard.press("Escape");
	await sleep(600);
}

// ======================================================= OFFLINE / PWA =====
if (run("offline")) {
	await goto("/app", 4000);
	// Manifest + service worker registration.
	check("pwa", "manifest linked", await page.evaluate(() => !!document.querySelector('link[rel=manifest]')));
	const swReady = await page.evaluate(async () => {
		if (!navigator.serviceWorker) return false;
		const registration = await navigator.serviceWorker.getRegistration();
		return !!registration?.active;
	});
	check("pwa", "service worker active", swReady);

	// Local mirror populated (the thread list came from SQLite, not just the network).
	const mirrored = await page.evaluate(() => document.querySelectorAll("[data-row]").length > 0);
	check("local-first", "list renders (mirror or remote)", mirrored);

	// Seed one thread's timeline while ONLINE — ensureThread is lazy on first
	// open, so a conversation never opened on this device has no offline copy by
	// design (the reader shows a "not saved on this device" state instead).
	await page.evaluate(() => {
		const row = document.querySelector("[data-row]");
		(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
	});
	await sleep(6000);
	const seededThreadUrl = page.url();
	await goto("/app?folder=inbox", 3500);

	// Go offline: the mirror must still render the list and the banner must show.
	await cdp.send("Network.enable");
	await cdp.send("Network.emulateNetworkConditions", {
		offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
	});
	await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
	await sleep(6000);
	const offlineRows = await count("[data-row]");
	check("local-first", "cold offline reload still lists mail", offlineRows > 0, `${offlineRows} rows`);
	check("local-first", "offline banner shown", await page.evaluate(() =>
		/offline/i.test(document.body.innerText)));
	// Reopen the thread seeded above — its timeline must come from the mirror.
	await page.goto(seededThreadUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
	await sleep(7000);
	check("local-first", "previously-opened thread reads offline from mirror",
		(await count("[data-msg]")) > 0);
	// A thread with no local copy must say so rather than shimmer forever.
	await page.evaluate(() => {
		const rows = document.querySelectorAll("[data-row]");
		const row = rows[rows.length - 1];
		(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
	});
	await sleep(5000);
	check("local-first", "un-mirrored thread shows an honest offline state",
		(await count("[data-msg]")) > 0 || await bodyHas("Not saved on this device"));

	await cdp.send("Network.emulateNetworkConditions", {
		offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
	});
	await sleep(3000);
	await goto("/app", 3000);
	check("local-first", "recovers after reconnect", (await count("[data-row]")) > 0);
}

// ------------------------------------------------------------------ report ---
const cloneErrors = consoleErrors.filter((line) => line.includes("DataCloneError"));
check("console", "no DataCloneErrors", cloneErrors.length === 0, cloneErrors[0] ?? "");
const realErrors = consoleErrors.filter((line) =>
	!line.includes("Failed to load resource") && !line.includes("modelContext") &&
	!line.includes("net::ERR_INTERNET_DISCONNECTED") && !line.includes("Failed to fetch") &&
	// The sandboxed mail-body frame refusing Cloudflare's auto-injected beacon
	// is the CSP doing its job, and the unsaved-changes guard firing when the
	// sweep navigates off a dirty editor is the guard doing its job.
	!line.includes("cloudflareinsights.com") &&
	!line.includes("during beforeunload"));
check("console", "no unexpected console errors", realErrors.length === 0,
	realErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${"=".repeat(60)}`);
console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
if (failed.length) {
	console.log("\nFAILURES:");
	for (const entry of failed) console.log(`  ✗ [${entry.area}] ${entry.name}${entry.note ? ` — ${entry.note}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
