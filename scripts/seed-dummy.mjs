#!/usr/bin/env node
// Seed dummy test data into the local (or --remote) D1: one active org, a shared
// support@ mailbox, 100 member users (each with a personal mailbox), and ~100
// threads of encrypted email addressed to support@ — so the mail client, search,
// admin member list, and oversight all have realistic data to render.
//
//   node scripts/seed-dummy.mjs            # local D1 (npm run dev)
//   node scripts/seed-dummy.mjs --remote   # deployed D1  (careful!)
//
// Content is encrypted with the SAME envelope as src/lib/server/mail/crypto.ts
// and indexed with the SAME blind tokens as search.ts, using MAIL_DEK /
// MAIL_SEARCH_KEY. If those aren't set in .dev.vars/.env, fresh keys are generated
// and written to .dev.vars so the dev worker decrypts what we seed.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { webcrypto as nodeCrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashPassword } from "better-auth/crypto";

const subtle = nodeCrypto.subtle;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = process.argv.includes("--remote");
const DRY = process.argv.includes("--dry"); // write SQL only, don't touch D1

const ORG_DOMAIN = "ethercorps.io";
const ORG_NAME = "Ethercorps (seed)";
const SUPPORT = `support@${ORG_DOMAIN}`;
const N_PEOPLE = 100;
const N_THREADS = 100;
const now = Date.now();
// Shared login password for every seeded person (credential accounts below), so
// you can sign in as any dummy user. Override with SEED_PASSWORD=... if desired.
const SEED_PASSWORD = process.env.SEED_PASSWORD || "password123";

// ---- key material ------------------------------------------------------------

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function loadOrCreateKeys() {
  const env = { ...parseEnvFile(join(root, ".env")), ...parseEnvFile(join(root, ".dev.vars")), ...process.env };
  let dek = env.MAIL_DEK;
  let searchKey = env.MAIL_SEARCH_KEY;
  const created = [];
  if (!dek) {
    dek = b64(nodeCrypto.getRandomValues(new Uint8Array(32)));
    created.push(["MAIL_DEK", dek]);
  }
  if (!searchKey) {
    searchKey = b64(nodeCrypto.getRandomValues(new Uint8Array(32)));
    created.push(["MAIL_SEARCH_KEY", searchKey]);
  }
  if (created.length) {
    const devVars = join(root, ".dev.vars");
    const header = existsSync(devVars) ? "" : "# Local worker secrets (wrangler dev / vite platformProxy)\n";
    appendFileSync(devVars, header + created.map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
    // Keep secrets out of git.
    const gi = join(root, ".gitignore");
    const giTxt = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!/^\.dev\.vars$/m.test(giTxt)) appendFileSync(gi, "\n.dev.vars\n");
    console.log(`Generated ${created.map((c) => c[0]).join(" + ")} → .dev.vars (restart dev to pick up).`);
  }
  return { dek, searchKey };
}

// ---- crypto (mirrors crypto.ts + search.ts) ----------------------------------

async function importDek(base64Key) {
  const raw = Buffer.from(base64Key, "base64");
  if (raw.length !== 32) throw new Error("MAIL_DEK must be base64 of 32 bytes");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function enc(key, plaintext) {
  if (plaintext == null || plaintext === "") return null;
  const iv = nodeCrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return `v1.0.${b64(iv)}.${b64(ct)}`;
}

async function importSearchKey(base64Key) {
  return subtle.importKey("raw", Buffer.from(base64Key, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function words(text) {
  const set = new Set();
  for (const m of (text || "").toLowerCase().matchAll(/[a-z0-9]+/g)) if (m[0].length > 1) set.add(m[0]);
  return [...set];
}

async function tokensFor(hmacKey, texts) {
  const all = new Set();
  for (const t of texts) for (const w of words(t)) all.add(w);
  const out = [];
  for (const w of all) {
    const mac = new Uint8Array(await subtle.sign("HMAC", hmacKey, new TextEncoder().encode(w)));
    let hex = "";
    for (let i = 0; i < 8; i++) hex += mac[i].toString(16).padStart(2, "0");
    out.push(hex);
  }
  return out;
}

// ---- fake content ------------------------------------------------------------

const FIRST = "Ava Liam Maya Noah Zoe Kai Ivy Leo Mia Eli Nora Omar Ruby Sam Tara Umar Vera Wren Yara Zane Ada Ben Cara Dev Esha Finn Gita Hugo Isla Jai".split(" ");
const LAST = "Rao Chen Ellis Park Ortiz Shah Khan Reed Diaz Bloom Frost Vaughn Ono Mehta Lund Costa Bauer Yates Nash Wilde Ambar Sethi Roy Fox Guo Hale Iqbal Jain Kerr Lima".split(" ");
const SUBJECTS = [
  "Can't log in after the update", "Invoice question for July", "Feature request: dark mode export",
  "Bug: attachments not downloading", "How do I add a teammate?", "Refund for duplicate charge",
  "API rate limit clarification", "Onboarding call follow-up", "Data export is stuck",
  "Password reset not arriving", "Billing plan upgrade", "Webhook deliveries failing intermittently",
  "SSO setup help", "Mobile app crash on open", "Question about retention policy",
];
const BODIES = [
  "Hi team, I've been running into this since this morning. Could you take a look when you get a chance? Thanks!",
  "Just following up on my earlier message — still seeing the same behaviour on the latest build.",
  "Quick one: is this expected, or should I file it as a bug? Happy to send logs.",
  "Thanks for the fast reply. That worked. Closing this out on my end.",
  "We're evaluating for a team of 12 — wanted to confirm this is supported before we roll out.",
  "Attaching a screenshot of the error. Let me know if you need anything else.",
];
const REPLIES = [
  "Thanks for reaching out — we're looking into it now and will update you shortly.",
  "Could you share the account email and a rough timestamp? That'll help us track it down.",
  "Good news: a fix just went out. Can you retry and confirm it's resolved on your side?",
  "That's expected behaviour for now, but I've logged your feedback for the team.",
];
const pick = (arr, i) => arr[i % arr.length];
const rand = (n) => Math.floor(Math.random() * n);

function person(i) {
  const first = FIRST[i % FIRST.length];
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
  const local = `${first}.${last}${i}`.toLowerCase();
  return { id: nodeCrypto.randomUUID(), name: `${first} ${last}`, email: `${local}@${ORG_DOMAIN}` };
}

const esc = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const uuid = () => nodeCrypto.randomUUID();
const midHeader = () => `<${uuid()}@${ORG_DOMAIN}>`;

// ---- build ------------------------------------------------------------------

async function build() {
  const { dek, searchKey } = loadOrCreateKeys();
  const ck = await importDek(dek);
  const sk = await importSearchKey(searchKey);

  const orgId = uuid();
  const supportMailboxId = uuid();
  const people = Array.from({ length: N_PEOPLE }, (_, i) => person(i));
  // Same hashing better-auth uses at sign-in (see scripts/reset-admin.mjs), so
  // these credential accounts authenticate for real.
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const stmts = [];
  const P = (s) => stmts.push(s);

  // Fresh start: dropping the org cascades all its mail + memberships; then drop
  // the dummy user rows (independent of org).
  P(`DELETE FROM organization WHERE domain=${esc(ORG_DOMAIN)};`);
  P(`DELETE FROM "user" WHERE email LIKE ${esc("%@" + ORG_DOMAIN)};`);

  // Org + settings + shared mailbox.
  P(`INSERT INTO organization (id,name,slug,created_at,domain,status) VALUES (${esc(orgId)},${esc(ORG_NAME)},${esc(ORG_DOMAIN.replace(/\./g, "-"))},${now},${esc(ORG_DOMAIN)},'active');`);
  P(`INSERT INTO org_mail_settings (org_id,subaddressing_enabled,routing_subdomains,updated_at) VALUES (${esc(orgId)},0,'[]',${now});`);
  P(`INSERT INTO mailbox (id,org_id,local_part,address,display_name,is_active,is_personal,created_at) VALUES (${esc(supportMailboxId)},${esc(orgId)},'support',${esc(SUPPORT)},'Support',1,0,${now});`);

  // People: user + membership + personal mailbox + self-grant.
  for (const p of people) {
    P(`INSERT INTO "user" (id,name,email,email_verified,image,created_at,updated_at,role,recovery_email_verified,onboarded_at) VALUES (${esc(p.id)},${esc(p.name)},${esc(p.email)},1,NULL,${now},${now},'member',0,${now});`);
    // Credential account so the dummy user can actually sign in (email + SEED_PASSWORD).
    P(`INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (${esc(uuid())},${esc(p.id)},'credential',${esc(p.id)},${esc(passwordHash)},${now},${now});`);
    P(`INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (${esc(uuid())},${esc(orgId)},${esc(p.id)},'member',${now});`);
    const mbId = uuid();
    P(`INSERT INTO mailbox (id,org_id,local_part,address,display_name,is_active,is_personal,created_at) VALUES (${esc(mbId)},${esc(orgId)},${esc(p.email.split("@")[0])},${esc(p.email)},${esc(p.name)},1,1,${now});`);
    P(`INSERT INTO mailbox_access (id,user_id,mailbox_id,can_manage,can_send,created_at) VALUES (${esc(uuid())},${esc(p.id)},${esc(mbId)},1,1,${now});`);
  }

  // Grant support@ to a handful of members (a real shared mailbox) AND to every
  // existing real user (so whoever is logged into dev sees the seeded inbox).
  for (let i = 0; i < 6; i++) {
    P(`INSERT INTO mailbox_access (id,user_id,mailbox_id,can_manage,can_send,created_at) VALUES (${esc(uuid())},${esc(people[i].id)},${esc(supportMailboxId)},${i === 0 ? 1 : 0},1,${now});`);
  }
  P(`INSERT INTO mailbox_access (id,user_id,mailbox_id,can_manage,can_send,created_at)
     SELECT lower(hex(randomblob(16))), u.id, ${esc(supportMailboxId)}, 0, 1, ${now}
     FROM "user" u
     WHERE NOT EXISTS (SELECT 1 FROM mailbox_access ma WHERE ma.user_id=u.id AND ma.mailbox_id=${esc(supportMailboxId)});`);

  // Threads: person i opens a thread to support@; 0-3 replies alternate with an
  // agent reply from support (outbound). All content encrypted + FTS-indexed.
  for (let t = 0; t < N_THREADS; t++) {
    const opener = people[t % N_PEOPLE];
    const subject = `${pick(SUBJECTS, t)} #${t + 1}`;
    const threadId = uuid();
    const nMsgs = 1 + rand(4);
    const baseAt = now - (N_THREADS - t) * 3600_000 - rand(20) * 3600_000;
    let lastMid = null;
    const refs = [];
    let lastAt = baseAt;

    P(`INSERT INTO thread (id,org_id,subject_normalized,last_message_at,created_at) VALUES (${esc(threadId)},${esc(orgId)},${esc(subject.replace(/^(re|fwd):\s*/i, "").toLowerCase())},${baseAt},${baseAt});`);
    P(`INSERT INTO thread_state (id,org_id,thread_id,mailbox_id,placement,is_starred,assignee_user_id,created_at) VALUES (${esc(uuid())},${esc(orgId)},${esc(threadId)},${esc(supportMailboxId)},'inbox',${t % 11 === 0 ? 1 : 0},${t % 7 === 0 ? esc(people[t % 6].id) : "NULL"},${baseAt});`);

    for (let m = 0; m < nMsgs; m++) {
      const outbound = m % 2 === 1; // agent replies on odd turns
      const from = outbound ? SUPPORT : opener.email;
      const at = lastAt + (m + 1) * 900_000 + rand(30) * 60_000;
      lastAt = at;
      const body = outbound ? pick(REPLIES, t + m) : m === 0 ? pick(BODIES, t) : pick(BODIES, t + m);
      const mid = midHeader();
      const messageId = uuid();
      const subjEnc = await enc(ck, m === 0 ? subject : `Re: ${subject}`);
      const strippedEnc = await enc(ck, body);
      const fullEnc = await enc(ck, body);
      const kind = body.length > 800 ? "card" : "bubble";

      P(`INSERT INTO message (id,org_id,thread_id,message_id_header,in_reply_to,"references",from_addr,to_addrs,cc_addrs,reply_to,sent_at,item_type,content_kind,subject_enc,body_stripped_enc,body_full_enc,created_at) VALUES (${esc(messageId)},${esc(orgId)},${esc(threadId)},${esc(mid)},${esc(lastMid)},${esc(refs.length ? refs.join(" ") : null)},${esc(from)},${esc(JSON.stringify(outbound ? [opener.email] : [SUPPORT]))},'[]',NULL,${at},'external_message',${esc(kind)},${esc(subjEnc)},${esc(strippedEnc)},${esc(fullEnc)},${at});`);

      // Delivery into support@: inbound 'to', outbound 'from'.
      P(`INSERT INTO delivery (id,org_id,message_id,mailbox_id,role,is_read,keywords,created_at) VALUES (${esc(uuid())},${esc(orgId)},${esc(messageId)},${esc(supportMailboxId)},${outbound ? "'from'" : "'to'"},0,'[]',${at});`);

      // Blind-token FTS row.
      const toks = await tokensFor(sk, [subject, body]);
      if (toks.length) P(`INSERT INTO message_fts (message_id,org_id,tokens) VALUES (${esc(messageId)},${esc(orgId)},${esc(toks.join(" "))});`);

      refs.push(mid);
      lastMid = mid;
    }

    P(`UPDATE thread SET last_message_at=${lastAt} WHERE id=${esc(threadId)};`);

    // A couple of internal notes on early threads (shared-mailbox collab realism).
    if (t < 8) {
      const noteEnc = await enc(ck, "Looping in billing on this — will follow up by EOD.");
      P(`INSERT INTO internal_note (id,org_id,thread_id,mailbox_id,author_user_id,body_enc,updated_at,created_at) VALUES (${esc(uuid())},${esc(orgId)},${esc(threadId)},${esc(supportMailboxId)},${esc(people[0].id)},${esc(noteEnc)},${lastAt},${lastAt});`);
    }
  }

  return stmts;
}

// ---- run ---------------------------------------------------------------------

const stmts = await build();
const sqlPath = join(root, "scripts", ".seed.sql");
writeFileSync(sqlPath, "PRAGMA foreign_keys=ON;\n" + stmts.join("\n") + "\n");
console.log(`Wrote ${stmts.length} statements → ${sqlPath}`);

if (DRY) {
  console.log("--dry: SQL generated, D1 not touched.");
  process.exit(0);
}

const args = ["d1", "execute", "doota", REMOTE ? "--remote" : "--local", "--file", sqlPath, "-y"];
console.log(`Running: wrangler ${args.join(" ")}`);
execFileSync("npx", ["wrangler", ...args], { cwd: root, stdio: "inherit" });
console.log(`\nSeeded org ${ORG_DOMAIN}: ${N_PEOPLE} people, ${N_THREADS} threads into ${SUPPORT}.`);
console.log(`Login for any dummy user:  email = <their address>   password = ${SEED_PASSWORD}`);
console.log(`Example:  ava.rao0@${ORG_DOMAIN} / ${SEED_PASSWORD}`);
console.log("Or stay on your own account — support@ is granted to every user, so seeded threads show there too.");
