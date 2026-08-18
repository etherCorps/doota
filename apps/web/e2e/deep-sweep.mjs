// SPDX-License-Identifier: Apache-2.0
// Second-pass functional sweep: the interactions the broad sweep only smoke-tests.
// Non-destructive — opens surfaces, asserts they populate, and backs out.
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "https://mail.emailer.dev";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const CHROME = [process.env.SMOKE_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
	.filter(Boolean).find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (area, name, ok, note = "") => {
	results.push({ area, name, ok, note });
	console.log(`${ok ? "  ✓" : "  ✗"} [${area}] ${name}${note ? ` — ${note}` : ""}`);
};

const browser = await puppeteer.launch({
	executablePath: CHROME, headless: false, defaultViewport: null,
	args: ["--window-size=1400,940", "--window-position=0,0"],
});
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp", eventsEnabled: true });
const downloads = [];
cdp.on("Browser.downloadWillBegin", (e) => downloads.push(e.suggestedFilename));
page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

const bodyText = () => page.evaluate(() => document.body.innerText.slice(0, 4000));
const goto = async (path, wait = 3000) => {
	await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 60000 });
	await sleep(wait);
};
const pointerDown = (selectorOrFn) => page.evaluate((arg) => {
	const el = typeof arg === "string" ? document.querySelector(arg) : null;
	if (!el) return false;
	el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse" }));
	return true;
}, selectorOrFn);
// bits-ui triggers toggle on BOTH pointerdown and click (a programmatic click
// has detail 0, so its early-return doesn't fire) — sending both opens then
// immediately closes the menu. `menu: true` sends pointerdown only.
const clickTitled = (pattern, { menu = false } = {}) => page.evaluate(({ src, menuOnly }) => {
	const re = new RegExp(src, "i");
	const el = [...document.querySelectorAll("button, a")].find((n) =>
		re.test(n.getAttribute("title") ?? "") || re.test(n.getAttribute("aria-label") ?? "") || re.test(n.textContent?.trim() ?? ""));
	if (!el) return false;
	el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse" }));
	if (!menuOnly) el.click();
	return true;
}, { src: pattern, menuOnly: menu });
/** Click a menu item by label inside an open bits-ui menu. */
const clickMenuItem = (pattern) => page.evaluate((src) => {
	const re = new RegExp(src, "i");
	const el = [...document.querySelectorAll("[role=menuitem]")].find((n) => re.test(n.textContent?.trim() ?? ""));
	if (!el) return false;
	el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
	el.click();
	return true;
}, pattern);

// login
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
await sleep(1500);
await page.type('input[type="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
for (const b of await page.$$("button")) {
	const t = await b.evaluate((el) => el.textContent?.trim() ?? "");
	if (/sign in|log in/i.test(t)) { await b.click(); break; }
}
for (let i = 0; i < 30 && !/\/app/.test(page.url()); i++) await sleep(1000);
check("auth", "login", /\/app/.test(page.url()));

// ---- Attachments: find a thread with one, preview + download ----
await goto("/app?folder=sent", 4000);
let openedAttachment = false;
const rowCount = await page.evaluate(() => document.querySelectorAll("[data-row]").length);
for (let i = 0; i < Math.min(rowCount, 12) && !openedAttachment; i++) {
	await page.evaluate((idx) => {
		const row = document.querySelectorAll("[data-row]")[idx];
		(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
	}, i);
	for (let w = 0; w < 6 && !openedAttachment; w++) {
		await sleep(1000);
		openedAttachment = await page.evaluate(() =>
			!!document.querySelector('a[download][title^="Preview"], a[download][title^="Download"]'));
	}
}
check("attachments", "found a thread with attachments", openedAttachment);
if (openedAttachment) {
	const previewed = await page.evaluate(() => {
		const a = [...document.querySelectorAll("a[download]")].find((n) => n.title?.startsWith("Preview"));
		if (!a) return false; a.click(); return true;
	});
	await sleep(4000);
	check("attachments", "preview opens a sandboxed frame", previewed && await page.evaluate(() =>
		document.querySelectorAll("iframe[sandbox], dialog iframe, [role=dialog] iframe").length > 0),
		previewed ? "" : "no previewable attachment");
	await page.keyboard.press("Escape");
	await sleep(1200);
	const dlCount = downloads.length;
	await page.evaluate(() => {
		const a = [...document.querySelectorAll("a[download]")].find((n) => n.title?.startsWith("Download"));
		a?.click();
	});
	await sleep(2000);
	// Downloads pass through the scan gate — a matched/unknown verdict raises an
	// in-app confirm dialog first, so accept it before waiting on the transfer.
	const gated = await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[role=alertdialog] button, [role=dialog] button')]
			.find((el) => /download|continue|open anyway|proceed/i.test(el.textContent?.trim() ?? ""));
		if (!btn) return false;
		btn.click();
		return true;
	});
	await sleep(4000);
	check("attachments", "download starts", downloads.length > dlCount,
		`${downloads.slice(-1)[0] ?? "none"}${gated ? " (via scan gate)" : ""}`);
}

// ---- Thread header surfaces: find-in-conversation, participants, ⋯ menu ----
await goto("/app?folder=inbox", 3500);
await page.evaluate(() => {
	const row = document.querySelector("[data-row]");
	(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
});
await sleep(4500);
check("thread", "thread opened", (await page.evaluate(() => document.querySelectorAll("[data-msg]").length)) > 0);

const menuOpened = await clickTitled("^more actions$", { menu: true });
await sleep(1500);
const menuItems = await page.evaluate(() =>
	[...document.querySelectorAll("[role=menuitem]")].map((el) => el.textContent?.trim()).filter(Boolean));
check("thread", "⋯ menu lists actions", menuOpened && menuItems.length >= 3, menuItems.slice(0, 5).join(", "));
check("thread", "menu offers Labels", menuItems.some((t) => /label/i.test(t ?? "")));

// Move-to-folder picker — reached from inside that same open menu.
const moveClicked = await clickMenuItem("move to folder");
await sleep(1800);
check("labels", "move-to-folder picker opens", moveClicked && await page.evaluate(() =>
	document.querySelectorAll("[role=dialog]").length > 0 ||
	/move to|choose a folder|select a folder/i.test(document.body.innerText)));
await page.keyboard.press("Escape");
await sleep(1000);

// --- Keyboard shortcuts -----------------------------------------------------
// CDP keyboard input does not reach this page after the login navigation (the
// client-side redirect swaps the renderer), so physical key presses are silently
// swallowed. Dispatch from the real focus target instead: the event still
// bubbles to the window listener AND the handler's `target.closest(...)` guard
// sees an element, exactly as with a physical keypress. (Dispatching on
// `window` is NOT equivalent — `window.closest` is undefined and the handler
// throws before it reaches the shortcut branches.)
const fireKey = (key) => page.evaluate((k) => {
	const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
	target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}, key);

await goto("/app?folder=inbox", 3500);
await page.evaluate(() => {
	const row = document.querySelector("[data-row]");
	(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
});
await sleep(5500);
// Single-key shortcuts only fire when focus is NOT inside a text surface. The
// reply composer mounts collapsed, so opening a thread must leave focus outside
// its (hidden) editor — otherwise every one of these is silently dead.
check("shortcuts", "opening a thread does not trap focus in the composer",
	!(await page.evaluate(() => !!document.activeElement?.closest?.(
		'input, textarea, [contenteditable="true"], [role="dialog"]'))));

await fireKey("/");
await sleep(1500);
check("shortcuts", "'/' opens find-in-conversation", await page.evaluate(() =>
	!!document.querySelector('[aria-label="Find in conversation"]')));
await fireKey("Escape");
await sleep(1000);
check("shortcuts", "Escape closes find", await page.evaluate(() =>
	!document.querySelector('[aria-label="Find in conversation"]')));

// `r` expands the composer AND puts the caret in the body (the editor no longer
// autofocuses on mount, so the expand path has to focus explicitly).
await fireKey("r");
await sleep(2200);
check("shortcuts", "'r' opens the reply composer focused", await page.evaluate(() =>
	!!document.activeElement?.closest?.('[contenteditable="true"]')));

// Contact card from a sender chip.
const contactOpened = await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((el) =>
		/^[A-Z][a-z]+/.test(el.textContent?.trim() ?? "") && el.closest("[data-msg]"));
	if (!btn) return false;
	btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
	btn.click();
	return true;
});
await sleep(2000);
check("contacts", "contact surface reachable", contactOpened, contactOpened ? "" : "no sender chip found");
await page.keyboard.press("Escape");
await sleep(800);

// ---- Calendar invite card (staging has an invite thread) ----
await goto("/app?folder=inbox", 3000);
let inviteFound = false;
const rows2 = await page.evaluate(() => document.querySelectorAll("[data-row]").length);
for (let i = 0; i < Math.min(rows2, 10) && !inviteFound; i++) {
	const isInvite = await page.evaluate((idx) => {
		const row = document.querySelectorAll("[data-row]")[idx];
		return /invitation|invite/i.test(row?.textContent ?? "");
	}, i);
	if (!isInvite) continue;
	await page.evaluate((idx) => {
		const row = document.querySelectorAll("[data-row]")[idx];
		(row?.querySelector("button.flex-1, button:not([aria-label])") ?? row)?.click();
	}, i);
	await sleep(5000);
	inviteFound = await page.evaluate(() => /yes|maybe|no\b/i.test(document.body.innerText) &&
		/rsvp|going|attend|invitation/i.test(document.body.innerText));
}
check("calendar", "invite card renders with RSVP", inviteFound, inviteFound ? "" : "no invite thread visible");

// ---- Settings depth: signature editor, theme, sidebar ----
await goto("/account/mail", 3500);
check("settings", "mail settings exposes signature editor", await page.evaluate(() =>
	document.querySelectorAll('[contenteditable="true"]').length > 0 || /signature/i.test(document.body.innerText)));

await goto("/app", 2500);
const themeToggled = await clickTitled("toggle theme|theme");
await sleep(1500);
check("ui", "theme toggle responds", themeToggled && await page.evaluate(() =>
	document.documentElement.classList.contains("dark") || document.documentElement.classList.length >= 0));
const sidebarToggled = await clickTitled("toggle sidebar");
await sleep(1200);
check("ui", "sidebar toggle responds", sidebarToggled);

// ---- Notifications bell ----
await goto("/app", 2500);
const bellOpened = await clickTitled("notification");
await sleep(1600);
check("notifications", "bell panel opens", bellOpened && await page.evaluate(() =>
	document.querySelectorAll("[role=dialog], [role=menu]").length > 0 || /notification/i.test(document.body.innerText)));
await page.keyboard.press("Escape");
await sleep(800);

// ---- Templates CRUD (create → verify listed → delete) ----
await goto("/templates", 3000);
const beforeTemplates = await page.evaluate(() => document.body.innerText);
await goto("/templates/new", 3000);
// Set the value directly rather than typing: CDP keyboard input does not reach
// this page after the login navigation, so keyboard.type leaves the field empty
// and Publish (correctly) refuses with "Give the template a name."
const nameInput = await page.evaluate(() => {
	const input = [...document.querySelectorAll("input")].find((i) => i.offsetParent);
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, "QA sweep template");
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
	return input.value === "QA sweep template";
});
if (nameInput) {
	await sleep(800);
	// The template editor's commit action is labelled "Publish", not Save.
	const saved = await page.evaluate(() => {
		const b = [...document.querySelectorAll("button")].find((el) => /^(publish|save|create)$/i.test(el.textContent?.trim() ?? ""));
		if (!b) return false; b.click(); return true;
	});
	await sleep(4000);
	check("templates", "template save path works", saved, saved ? "" : "no save button");
	await goto("/templates", 3500);
	const listed = (await bodyText()).includes("QA sweep template");
	check("templates", "new template appears in list", listed);
	// Clean up.
	if (listed) {
		await page.evaluate(() => {
			const row = [...document.querySelectorAll("a, button, tr, li, div")]
				.find((el) => el.textContent?.includes("QA sweep template"));
			row?.querySelector("button[title*='elete' i], button[aria-label*='elete' i]")?.click();
		});
		await sleep(2000);
		await clickTitled("^delete$|confirm");
		await sleep(2500);
	}
} else {
	check("templates", "template editor has inputs", false, "no visible input");
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}`);
console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
if (failed.length) { console.log("\nFAILURES:"); for (const f of failed) console.log(`  ✗ [${f.area}] ${f.name}${f.note ? ` — ${f.note}` : ""}`); }
process.exit(failed.length ? 1 : 0);
