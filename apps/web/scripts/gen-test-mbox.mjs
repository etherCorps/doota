#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Generate an mbox for exercising import by hand.
//
//   node apps/web/scripts/gen-test-mbox.mjs --to you@yourdomain.dev
//   node apps/web/scripts/gen-test-mbox.mjs --to you@x.dev --count 300 --out /tmp/big.mbox
//
// The messages are not filler: each one is a case that has broken a mail
// importer somewhere. Re-run with a fresh --tag to import the same shapes again
// without tripping Message-ID dedupe.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

const TO = arg("to", "you@example.test");
const OUT = arg("out", join(homedir(), "Downloads", "doota-import-test.mbox"));
const COUNT = Number(arg("count", "0")); // extra filler messages beyond the fixtures
const TAG = arg("tag", String(Date.now()).slice(-6));
const DOMAIN = "example.test";

const CRLF = "\r\n";
let seq = 0;

/** One mbox entry. `headers` is raw lines; `body` is already-encoded content. */
function entry({ from, fromName, subject, body, headers = [], day = 1 }) {
  const id = `doota-fixture-${TAG}-${seq++}@${DOMAIN}`;
  const date = new Date(Date.UTC(2026, 2, day, 9, 30));
  const lines = [
    // The envelope line. Not a header — the separator mbox splits on.
    `From ${from} ${date.toUTCString()}`,
    `Message-ID: <${id}>`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `From: ${fromName} <${from}>`,
    `To: ${TO}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    ...headers,
    "",
    body,
    "",
  ];
  return lines.join(CRLF) + CRLF;
}

/** mbox escaping: a body line starting "From " gets a ">" so it isn't a separator. */
const escapeBody = (text) => text.replace(/^(>*From )/gm, ">$1");

const plain = (text) => ({ headers: ["Content-Type: text/plain; charset=utf-8"], body: escapeBody(text) });

function alternative(text, html) {
  const boundary = `=_alt_${seq}`;
  return {
    headers: [`Content-Type: multipart/alternative; boundary="${boundary}"`],
    body: [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      escapeBody(text),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      `--${boundary}--`,
    ].join(CRLF),
  };
}

function withAttachment(text, filename, contents) {
  const boundary = `=_mix_${seq}`;
  return {
    headers: [`Content-Type: multipart/mixed; boundary="${boundary}"`],
    body: [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      escapeBody(text),
      `--${boundary}`,
      `Content-Type: text/plain; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(contents).toString("base64").replace(/(.{76})/g, `$1${CRLF}`),
      `--${boundary}--`,
    ].join(CRLF),
  };
}

const parts = [];

// 1 — the ordinary case.
parts.push(entry({
  from: `mira.chandra@${DOMAIN}`, fromName: "Mira Chandra", day: 1,
  subject: "Invoice for February",
  ...plain("Hi,\n\nAttaching February's invoice — same terms as last month. Let me know if\nanything looks off and I'll reissue.\n\nThanks,\nMira"),
}));

// 2 — a body line that reads exactly like a separator. The single most common
//     way an importer merges or splits messages incorrectly.
parts.push(entry({
  from: `desk@${DOMAIN}`, fromName: "The Desk", day: 2,
  subject: "Quoting a header back at you",
  ...plain("You asked what the header looked like. Verbatim:\n\nFrom the desk of nobody\nFrom: someone@elsewhere.test\n\nThat's the whole thing."),
}));

// 3 — "From " mid-line, which must NOT split.
parts.push(entry({
  from: `ops@${DOMAIN}`, fromName: "Ops", day: 3,
  subject: "Forwarded note",
  ...plain("Forwarded From someone else, but this is still one message.\nNothing here should start a new one."),
}));

// 4 — HTML. Exercises the render path, not just the text twin.
parts.push(entry({
  from: `news@${DOMAIN}`, fromName: "Weekly Roundup", day: 4,
  subject: "Three things worth reading",
  ...alternative(
    "1. The cost of an index\n2. What SQLite gets right\n3. Against dashboards",
    `<html><body style="font-family:system-ui"><h2>Three things</h2><ol><li><a href="https://example.test/a">The cost of an index</a></li><li><a href="https://example.test/b">What SQLite gets right</a></li><li>Against dashboards</li></ol><p style="color:#666">You can unsubscribe any time.</p></body></html>`,
  ),
}));

// 5 — an attachment, so the raw round-trip is visible in the UI.
parts.push(entry({
  from: `payroll@${DOMAIN}`, fromName: "Payroll", day: 5,
  subject: "Your payslip",
  ...withAttachment("Payslip attached. Reply here if the figures need a second look.", "payslip.txt",
    "Gross: 4,200.00\nDeductions: 812.40\nNet: 3,387.60\n"),
}));

// 6 + 7 — a real thread. Import must join these, not file them separately.
const rootId = `doota-fixture-${TAG}-thread-root@${DOMAIN}`;
parts.push(entry({
  from: `sam.okafor@${DOMAIN}`, fromName: "Sam Okafor", day: 6,
  subject: "Can we move Thursday's review?",
  headers: ["Content-Type: text/plain; charset=utf-8"],
  body: "Thursday's clashing with the vendor call. Friday morning work for you?",
}).replace(/^Message-ID: <[^>]+>/m, `Message-ID: <${rootId}>`));
parts.push(entry({
  from: `sam.okafor@${DOMAIN}`, fromName: "Sam Okafor", day: 7,
  subject: "Re: Can we move Thursday's review?",
  headers: [
    `In-Reply-To: <${rootId}>`,
    `References: <${rootId}>`,
    "Content-Type: text/plain; charset=utf-8",
  ],
  body: "Ignore me — Friday's booked too. Keeping Thursday, moving the vendor call.",
}));

// 8 — non-ASCII in both subject and body, unencoded UTF-8.
parts.push(entry({
  from: `réception@${DOMAIN}`, fromName: "Réception", day: 8,
  subject: "Réservation confirmée — table pour quatre",
  ...plain("Bonjour,\n\nVotre réservation est confirmée pour jeudi à 20 h 00.\n\nÀ bientôt — 🍷"),
}));

// 9 — a Doota round-trip header. This one should land in the INBOX while every
//     other message lands in Archive, which is the easiest thing to eyeball.
parts.push(entry({
  from: `priority@${DOMAIN}`, fromName: "Priority Sender", day: 9,
  subject: "This one should land in the inbox",
  headers: ["X-Doota-Placement: inbox", "Content-Type: text/plain; charset=utf-8"],
  body: "Carries X-Doota-Placement: inbox, so a Doota-to-Doota import restores it\nto the inbox instead of filing it away.",
}));

// 10 — no subject, which some clients emit and some importers choke on.
parts.push(entry({
  from: `quiet@${DOMAIN}`, fromName: "Quiet Sender", day: 10,
  subject: "",
  ...plain("No subject line at all. Should still import and thread on its own."),
}));

// Filler, for testing batching and progress on a longer run.
const SUBJECTS = [
  "Re: onboarding checklist", "Access request for the staging box", "Notes from Tuesday",
  "Renewal quote", "Broken link on the pricing page", "Holiday cover",
  "Q2 numbers", "Shipping delay", "Password reset didn't arrive", "Contract redlines",
];
for (let i = 0; i < COUNT; i += 1) {
  parts.push(entry({
    from: `person${i % 40}@${DOMAIN}`, fromName: `Person ${i % 40}`,
    day: (i % 27) + 1,
    subject: `${SUBJECTS[i % SUBJECTS.length]} #${i + 1}`,
    ...plain(`Message ${i + 1} of the filler set.\n\n${"Padding so the file has some real size. ".repeat(8)}`),
  }));
}

const mbox = parts.join("");
writeFileSync(OUT, mbox);

console.log(`Wrote ${OUT}`);
console.log(`  ${parts.length} messages, ${(mbox.length / 1024).toFixed(1)} KB, addressed to ${TO}`);
console.log(`  tag ${TAG} — re-run with a different --tag to import the same shapes again`);
console.log("");
console.log("What to look for after importing:");
console.log("  · 1 message in the INBOX (the X-Doota-Placement one), everything else in ARCHIVE");
console.log("  · all of it under a dated 'Imported …' label");
console.log("  · the two 'Thursday's review' messages in ONE thread, not two");
console.log("  · the 'Quoting a header back at you' body intact — not split into extra messages");
console.log("  · the roundup rendering as HTML, and payslip.txt downloadable");
console.log("  · re-import the same file: 0 imported, all skipped");
