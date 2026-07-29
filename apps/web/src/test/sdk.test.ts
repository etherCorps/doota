// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { Doota, DootaError } from "@doota/sdk";

// Minimal shape the SDK actually sends — avoids the ambient (CF-flavored) RequestInit.
type Init = { method?: string; headers?: Record<string, string>; body?: string };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    (_url: string, _init?: Init): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
  );
}

const opts = (fetch: ReturnType<typeof fakeFetch>) => ({ baseUrl: "https://mail.acme.com/", fetch: fetch as never });

describe("Doota SDK", () => {
  it("POSTs to /api/send with bearer auth and a pruned JSON body", async () => {
    const fetch = fakeFetch(202, { submissionId: "s1", deduped: false });
    const doota = new Doota("dk_test", opts(fetch));

    const res = await doota.emails.send({ to: "ana@x.com", subject: "Hi", text: "yo" });
    expect(res).toEqual({ submissionId: "s1", deduped: false });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://mail.acme.com/api/send"); // trailing slash trimmed
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer dk_test");
    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent.to).toEqual(["ana@x.com"]); // string coerced to array
    expect(sent.subject).toBe("Hi");
    expect("cc" in sent).toBe(false); // undefined fields pruned
  });

  it("sends a templated message with data", async () => {
    const fetch = fakeFetch(202, { submissionId: "s2", deduped: false });
    const doota = new Doota("dk_test", opts(fetch));
    await doota.emails.send({ to: ["a@x.com", "b@x.com"], templateId: "tmpl_1", data: { name: "Ana" } });
    const sent = JSON.parse(fetch.mock.calls[0][1]?.body ?? "{}");
    expect(sent.templateId).toBe("tmpl_1");
    expect(sent.data).toEqual({ name: "Ana" });
    expect(sent.to).toEqual(["a@x.com", "b@x.com"]);
  });

  it("throws DootaError with the server message on failure", async () => {
    const fetch = fakeFetch(403, { message: "This key may only send as its bound mailbox" });
    const doota = new Doota("dk_test", opts(fetch));
    await expect(doota.emails.send({ to: "a@x.com", subject: "x" })).rejects.toMatchObject({
      name: "DootaError",
      status: 403,
      message: "This key may only send as its bound mailbox",
    });
  });

  it("requires an api key and a baseUrl", () => {
    expect(() => new Doota("", { baseUrl: "https://x" })).toThrow();
    // @ts-expect-error missing baseUrl
    expect(() => new Doota("dk_x", {})).toThrow();
  });

  it("DootaError carries the HTTP status", async () => {
    const fetch = fakeFetch(500, "not json");
    const doota = new Doota("dk_test", opts(fetch));
    const err = await doota.emails.send({ to: "a@x.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(DootaError);
    expect(err.status).toBe(500);
  });
});
