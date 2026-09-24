// SPDX-License-Identifier: Apache-2.0
// Canned responses: the stored-HTML cleaner (shared with signatures) and the
// per-user snippet store — ownership, the unique-title rule, and the cap. All
// against the real migrations so the unique index is exercised.
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import {
  cleanStoredHtml,
  normalizeSnippetTitle,
  listSnippets,
  saveSnippet,
  deleteSnippet,
  SNIPPET_LIMIT,
} from "@doota/mail-core/snippets";

describe("cleanStoredHtml", () => {
  it("keeps ordinary composer markup", () => {
    expect(cleanStoredHtml("<p>Thanks for writing in!</p>")).toBe("<p>Thanks for writing in!</p>");
  });
  it("normalizes a content-empty editor document to ''", () => {
    expect(cleanStoredHtml("")).toBe("");
    expect(cleanStoredHtml("   ")).toBe("");
    expect(cleanStoredHtml("<p></p>")).toBe("");
    expect(cleanStoredHtml("<p>&nbsp;</p><p> </p>")).toBe("");
  });
  it("keeps media-only content (an image is content)", () => {
    const out = cleanStoredHtml('<p><img src="data:image/png;base64,AAAA" alt=""></p>');
    expect(out).toContain("<img");
  });
  it("strips script and handlers on the way in", () => {
    const out = cleanStoredHtml('<p onclick="x()">Hi</p><script>alert(1)</script>')!;
    expect(out).toContain("Hi");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
  });
  it("returns null when the sanitizer refuses (oversized)", () => {
    expect(cleanStoredHtml("<p>" + "x".repeat(3_000_000) + "</p>")).toBeNull();
  });
});

describe("normalizeSnippetTitle", () => {
  it("trims and squashes inner whitespace", () => {
    expect(normalizeSnippetTitle("  Office   hours \n")).toBe("Office hours");
  });
});

const USER = "u1";
const OTHER = "u2";

async function seed(db: any) {
  await db.insert(schema.user).values([
    { id: USER, name: "Alice", email: "alice@acme.com" },
    { id: OTHER, name: "Bob", email: "bob@acme.com" },
  ]);
}

let db: any;
beforeEach(async () => {
  db = await makeDb();
  await seed(db);
});

describe("snippet store", () => {
  it("creates, lists A→Z by title (case-insensitive), and returns the row", async () => {
    const b = await saveSnippet(db, USER, { title: "bye", bodyHtml: "<p>Bye</p>" });
    const a = await saveSnippet(db, USER, { title: "Apologies", bodyHtml: "<p>Sorry</p>" });
    expect(a.ok && b.ok).toBe(true);
    const rows = await listSnippets(db, USER);
    expect(rows.map((row) => row.title)).toEqual(["Apologies", "bye"]);
    expect(rows[0]).toMatchObject({ bodyHtml: "<p>Sorry</p>" });
    expect(typeof rows[0].updatedAt).toBe("number");
  });

  it("scopes the list to the owner", async () => {
    await saveSnippet(db, USER, { title: "Mine", bodyHtml: "<p>a</p>" });
    await saveSnippet(db, OTHER, { title: "Theirs", bodyHtml: "<p>b</p>" });
    expect((await listSnippets(db, USER)).map((row) => row.title)).toEqual(["Mine"]);
    expect((await listSnippets(db, OTHER)).map((row) => row.title)).toEqual(["Theirs"]);
  });

  it("rejects a duplicate title per user (after whitespace normalization), but not across users", async () => {
    await saveSnippet(db, USER, { title: "Hours", bodyHtml: "<p>9–5</p>" });
    expect(await saveSnippet(db, USER, { title: "  hours ", bodyHtml: "<p>x</p>" })).toMatchObject({ ok: true });
    expect(await saveSnippet(db, USER, { title: " Hours  ", bodyHtml: "<p>x</p>" })).toEqual({
      ok: false,
      reason: "duplicate-title",
    });
    expect(await saveSnippet(db, OTHER, { title: "Hours", bodyHtml: "<p>x</p>" })).toMatchObject({ ok: true });
  });

  it("updates in place by id — keeping its own title is not a clash", async () => {
    const created = await saveSnippet(db, USER, { title: "Hours", bodyHtml: "<p>9–5</p>" });
    if (!created.ok) throw new Error("create failed");
    const id = created.snippet.id;
    const same = await saveSnippet(db, USER, { id, title: "Hours", bodyHtml: "<p>10–6</p>" });
    expect(same).toMatchObject({ ok: true, snippet: { id, bodyHtml: "<p>10–6</p>" } });
    const renamed = await saveSnippet(db, USER, { id, title: "Opening hours", bodyHtml: "<p>10–6</p>" });
    expect(renamed).toMatchObject({ ok: true, snippet: { id, title: "Opening hours" } });
    const rows = await listSnippets(db, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Opening hours");
  });

  it("refuses to update or delete another user's snippet", async () => {
    const created = await saveSnippet(db, USER, { title: "Mine", bodyHtml: "<p>a</p>" });
    if (!created.ok) throw new Error("create failed");
    const id = created.snippet.id;
    expect(await saveSnippet(db, OTHER, { id, title: "Hijacked", bodyHtml: "<p>z</p>" })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await deleteSnippet(db, OTHER, id)).toBe(false);
    const rows = await listSnippets(db, USER);
    expect(rows[0]).toMatchObject({ title: "Mine", bodyHtml: "<p>a</p>" });
  });

  it("deletes the owner's snippet and reports a missing one", async () => {
    const created = await saveSnippet(db, USER, { title: "Mine", bodyHtml: "<p>a</p>" });
    if (!created.ok) throw new Error("create failed");
    expect(await deleteSnippet(db, USER, created.snippet.id)).toBe(true);
    expect(await deleteSnippet(db, USER, created.snippet.id)).toBe(false);
    expect(await listSnippets(db, USER)).toEqual([]);
  });

  it("caps the per-user count, and an update still works at the cap", async () => {
    await db.insert(schema.snippet).values(
      Array.from({ length: SNIPPET_LIMIT }, (_, i) => ({
        id: `s${i}`,
        userId: USER,
        title: `Snippet ${i}`,
        bodyHtml: "<p>x</p>",
      })),
    );
    expect(await saveSnippet(db, USER, { title: "One more", bodyHtml: "<p>x</p>" })).toEqual({
      ok: false,
      reason: "limit",
    });
    expect(await saveSnippet(db, USER, { id: "s0", title: "Snippet 0", bodyHtml: "<p>y</p>" })).toMatchObject({
      ok: true,
    });
    // The cap is per user: someone else can still add.
    expect(await saveSnippet(db, OTHER, { title: "Theirs", bodyHtml: "<p>x</p>" })).toMatchObject({ ok: true });
  });
});
