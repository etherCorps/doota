// Client-side memory-leak sweep with memlab (facebook/memlab).
//
// For each page we: load a start route, SPA-navigate INTO the page (mount +
// trigger its fetches/effects), then SPA-navigate OUT (unmount). memlab
// heap-diffs across the cycle to find anything retained after unmount — detached
// DOM, un-removed listeners, effect closures. This is the class of bug that hit
// the Insights page (a self-retriggering $effect that refetched forever).
//
// back() MUST be same-document SPA navigation (a link click), never page.goto /
// reload — memlab can't diff heaps across a full page load.
//
//   pnpm --filter doota leak                 # sweep every page
//   LEAK_ONLY=insights pnpm --filter doota leak   # one page (substring match)
//
// Needs: a running app, Puppeteer's Chromium, and an admin session cookie.
// See leak/README.md.

import { run } from '@memlab/api';

const BASE = (process.env.LEAK_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const ORG = process.env.LEAK_ORG_ID || '';
const COOKIE = process.env.LEAK_SESSION_COOKIE || '';
const COOKIE_NAME = process.env.LEAK_COOKIE_NAME || 'better-auth.session_token';
const ONLY = process.env.LEAK_ONLY || '';
const HOST = new URL(BASE).hostname;

if (!ORG) {
  console.error('Set LEAK_ORG_ID to an organization id (org_…). See leak/README.md.');
  process.exit(2);
}
if (!COOKIE) {
  console.warn('⚠  No LEAK_SESSION_COOKIE — admin routes will redirect to /login and results will be meaningless.');
}

const orgBase = `/admin/organizations/${ORG}`;
const cookies = () => (COOKIE ? [{ name: COOKIE_NAME, value: COOKIE, domain: HOST, path: '/' }] : []);

// ---- in-page helpers (run in the browser via page.evaluate) -----------------
async function settle(page, ms = 900) {
  try {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 });
  } catch {
    /* best-effort */
  }
  await new Promise((r) => setTimeout(r, ms));
}

// Click the first <a>/<button> whose trimmed text contains `text` (SPA nav).
async function clickText(page, text) {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('a,button')].find((e) => (e.textContent || '').trim().includes(t));
    if (el) el.click();
    return !!el;
  }, text);
  return ok;
}

// Click the first <a> whose href contains `sub` (SPA nav).
async function clickHref(page, sub) {
  return page.evaluate((s) => {
    const a = [...document.querySelectorAll('a[href]')].find((e) => (e.getAttribute('href') || '').includes(s));
    if (a) a.click();
    return !!a;
  }, sub);
}

async function closeDialog(page) {
  await page.keyboard.press('Escape').catch(() => {});
}

// ---- per-page extra interactions (optional) ---------------------------------
const openAndClose = async (page) => {
  await clickText(page, 'Add');
  await settle(page, 400);
  await closeDialog(page);
};
const insights = async (page) => {
  for (const v of ['Email logs', 'Audit logs', 'Analytics']) {
    await clickText(page, v);
    await settle(page, 700);
  }
  for (const r of ['30d', '7d']) {
    await clickText(page, r);
    await settle(page, 500);
  }
};

// ---- pages: enter via tab label, leave back to Overview ---------------------
// `enter`/`leave` are SPA link clicks. Overview is tested by starting on Members.
const TAB = (label, interact) => ({
  start: orgBase,
  enter: (p) => clickText(p, label),
  leave: (p) => clickText(p, 'Overview'),
  interact,
});

// Account settings tab: enter/leave by href (labels like "Mail" aren't unique).
const ACCT = (slug) => ({
  start: '/account/profile',
  enter: (p) => clickHref(p, `/account/${slug}`),
  leave: (p) => clickHref(p, '/account/profile'),
});

const pages = {
  // ---- admin: org tabs (org layout TabNav) --------------------------------
  overview: { start: `${orgBase}/members`, enter: (p) => clickText(p, 'Overview'), leave: (p) => clickText(p, 'Members') },
  members: TAB('Members'),
  mailboxes: TAB('Mailboxes', openAndClose),
  suppressions: TAB('Suppressions', openAndClose),
  insights: TAB('Insights', insights),
  domain: TAB('Domain'),
  settings: TAB('Settings'),
  'mailbox-detail': {
    start: `${orgBase}/mailboxes`,
    enter: (p) => clickText(p, 'Manage'), // per-mailbox Manage link → detail route
    leave: (p) => clickText(p, 'Mailboxes'),
  },

  // ---- admin: sidebar pages -----------------------------------------------
  dashboard: { start: orgBase, enter: (p) => clickText(p, 'Dashboard'), leave: (p) => clickHref(p, `/organizations/${ORG}`) },
  organizations: { start: '/admin', enter: (p) => clickText(p, 'Organizations'), leave: (p) => clickText(p, 'Dashboard') },
  oversight: { start: '/admin', enter: (p) => clickText(p, 'Oversight'), leave: (p) => clickText(p, 'Dashboard') },

  // ---- app: account settings tabs -----------------------------------------
  'account-profile': { start: '/account/security', enter: (p) => clickHref(p, '/account/profile'), leave: (p) => clickHref(p, '/account/security') },
  'account-security': ACCT('security'),
  'account-mail': ACCT('mail'),
  'account-developer': ACCT('developer'),

  // ---- app: mail client (folder switching within /app) --------------------
  app: { start: '/app', enter: (p) => clickText(p, 'Sent'), leave: (p) => clickText(p, 'Inbox') },
};

function scenarioFor(def) {
  return {
    url: () => `${BASE}${def.start}`,
    cookies,
    action: async (page) => {
      await def.enter(page);
      await settle(page);
      if (def.interact) await def.interact(page);
    },
    back: async (page) => {
      await def.leave(page);
      await settle(page);
    },
    repeat: () => 3,
  };
}

// ---- run --------------------------------------------------------------------
const selected = Object.entries(pages).filter(([name]) => !ONLY || name.includes(ONLY));
if (!selected.length) {
  console.error(`No page matches LEAK_ONLY="${ONLY}". Known: ${Object.keys(pages).join(', ')}`);
  process.exit(2);
}

const results = [];
for (const [name, def] of selected) {
  process.stdout.write(`\n▶ ${name} … `);
  try {
    const { leaks } = await run({ scenario: scenarioFor(def) });
    results.push({ name, leaks: leaks.length });
    process.stdout.write(leaks.length ? `❌ ${leaks.length} leak(s)` : '✅ clean');
  } catch (e) {
    results.push({ name, leaks: -1, error: e?.message ?? String(e) });
    process.stdout.write(`⚠ error: ${e?.message ?? e}`);
  }
}

console.log('\n\n── memlab leak summary ─────────────────────────');
for (const r of results) {
  const status = r.leaks < 0 ? `error: ${r.error}` : r.leaks ? `${r.leaks} leak(s)` : 'clean';
  console.log(`  ${r.leaks ? '❌' : '✅'} ${r.name.padEnd(14)} ${status}`);
}
const leaked = results.filter((r) => r.leaks > 0);
console.log('────────────────────────────────────────────────');
if (leaked.length) {
  console.error(`\n${leaked.length} page(s) leaked. Inspect: npx memlab view-heap or the memlab report above.`);
  process.exit(1);
}
console.log('\nNo leaks detected.');
