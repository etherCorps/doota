// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { validateWebhookUrl } from "$lib/server/ssrf";
import { signWebhook, WEBHOOK_EVENTS } from "@doota/mail-core/webhooks";

describe("webhook URL validation (SSRF)", () => {
  it("rejects the cloud metadata address on save", () => {
    const r = validateWebhookUrl("http://169.254.169.254/");
    expect(r.ok).toBe(false);
  });

  it("requires https", () => {
    expect(validateWebhookUrl("http://hooks.example.com/x").ok).toBe(false);
    expect(validateWebhookUrl("https://hooks.example.com/x").ok).toBe(true);
  });

  it("rejects literal IPs (public and private) — a hostname is required", () => {
    for (const url of [
      "https://8.8.8.8/hook",
      "https://169.254.169.254/hook",
      "https://[::1]/hook",
      "https://192.168.0.1/hook",
    ]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("rejects internal TLDs and localhost", () => {
    for (const url of [
      "https://db.internal/hook",
      "https://svc.local/hook",
      "https://api.localhost/hook",
    ]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("rejects non-standard ports", () => {
    expect(validateWebhookUrl("https://hooks.example.com:8443/x").ok).toBe(false);
    expect(validateWebhookUrl("https://hooks.example.com:443/x").ok).toBe(true);
  });

  it("accepts a normal public https endpoint", () => {
    expect(validateWebhookUrl("https://hooks.acme.dev/doota").ok).toBe(true);
  });
});

describe("webhook HMAC signing", () => {
  it("matches a reference HMAC-SHA256 over `timestamp.body`", async () => {
    const secret = "wh_deadbeefcafef00d";
    const timestamp = 1_700_000_000_000;
    const body = JSON.stringify({ id: "ev1", type: "submission.sent", data: { submissionId: "s1" } });
    const ours = await signWebhook(secret, timestamp, body);
    const reference = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    expect(ours).toBe(reference);
  });

  it("the timestamp is part of the signed material (replay resistance)", async () => {
    const secret = "wh_x";
    const body = "{}";
    const a = await signWebhook(secret, 1000, body);
    const b = await signWebhook(secret, 2000, body);
    expect(a).not.toBe(b);
  });
});

describe("webhook events", () => {
  it("covers exactly the six documented event types", () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      [
        "mail.received",
        "submission.bounced",
        "submission.complained",
        "submission.delivered",
        "submission.failed",
        "submission.sent",
      ].sort(),
    );
  });
});
