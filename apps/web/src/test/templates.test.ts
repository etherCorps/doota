// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import {
  createTemplate,
  updateTemplate,
  archiveTemplate,
  listTemplates,
  loadTemplateForSend,
  renderTemplate,
  sensitiveKeysOf,
  slugify,
} from "$lib/server/templates.js";
import { builtinMergeData, BUILTIN_NAMES } from "$lib/mjml/variables.js";

const ORG = "org1";
const ORG2 = "org2";
const U = "u1";

async function seed(db: any) {
  for (const id of [ORG, ORG2]) {
    await db.insert(schema.organization).values({
      id, name: id, slug: id, domain: `${id}.com`, status: "active", createdAt: new Date(),
    });
  }
  await db.insert(schema.user).values({
    id: U, name: "Ana", email: "ana@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
}

let db: any;
beforeEach(async () => {
  db = await makeDb();
  await seed(db);
});

const base = {
  orgId: ORG, name: "Welcome Email",
  subjectTemplate: "Hi {{ name }}",
  compiledHtml: "<p>Hello {{ name }}, code {{ code }}</p>",
  variablesSchema: JSON.stringify({ name: { required: true }, code: { sensitive: true } }),
  userId: U,
};

describe("templates", () => {
  it("slugifies names", () => {
    expect(slugify("Welcome Email!")).toBe("welcome-email");
    expect(slugify("  ---  ")).toBe("template");
  });

  it("creates a template + v1 and renders with merge data", async () => {
    const { id, slug } = await createTemplate(db, base);
    expect(slug).toBe("welcome-email");

    const tmpl = await loadTemplateForSend(db, ORG, id);
    expect(tmpl?.version).toBe(1);
    const out = renderTemplate(tmpl!, { name: "Ana", code: "1234" });
    expect(out.subject).toBe("Hi Ana");
    expect(out.html).toContain("Hello Ana");
    expect(out.html).toContain("code 1234");
  });

  it("auto-escapes merge values (un-jinja default)", async () => {
    const { id } = await createTemplate(db, base);
    const tmpl = await loadTemplateForSend(db, ORG, id);
    const out = renderTemplate(tmpl!, { name: "<script>", code: "x" });
    expect(out.subject).not.toContain("<script>");
    expect(out.subject).toContain("&lt;script&gt;");
  });

  it("derives sensitive keys from the variables schema", async () => {
    const { id } = await createTemplate(db, base);
    const tmpl = await loadTemplateForSend(db, ORG, id);
    expect(sensitiveKeysOf(tmpl!.variablesSchema)).toEqual(["code"]);
  });

  it("update creates a new live version", async () => {
    const { id } = await createTemplate(db, base);
    const { version } = await updateTemplate(db, id, {
      subjectTemplate: "Hey {{ name }}",
      compiledHtml: "<p>v2 {{ name }}</p>",
      userId: U,
    });
    expect(version).toBe(2);
    const tmpl = await loadTemplateForSend(db, ORG, id);
    expect(tmpl?.version).toBe(2);
    expect(renderTemplate(tmpl!, { name: "Ana" }).subject).toBe("Hey Ana");
  });

  it("dedupes slugs within an org", async () => {
    const a = await createTemplate(db, base);
    const b = await createTemplate(db, base);
    expect(a.slug).toBe("welcome-email");
    expect(b.slug).toBe("welcome-email-2");
  });

  it("fills + renders built-in variables without caller data", () => {
    const b = builtinMergeData({ fromAddress: "billing@acme.com", fromName: "Billing", recipients: ["ana@x.com", "b@x.com"] });
    expect(b.recipient).toBe("ana@x.com");
    expect(b.sender_name).toBe("Billing");
    expect(b.sender_email).toBe("billing@acme.com");
    expect(b.year).toMatch(/^\d{4}$/);
    expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(BUILTIN_NAMES.has("recipient")).toBe(true);

    // Built-ins win over caller data of the same name; customs pass through.
    const merged = { recipient: "spoof@x", plan: "Pro", ...b };
    const out = renderTemplate(
      { subjectTemplate: "Hi {{ recipient }}", compiledHtml: "<p>{{ sender_name }} · {{ plan }}</p>" },
      merged,
    );
    expect(out.subject).toBe("Hi ana@x.com"); // built-in overrode caller's spoof
    expect(out.html).toContain("Billing");
    expect(out.html).toContain("Pro");
  });

  it("archived + cross-org templates don't load for send", async () => {
    const { id } = await createTemplate(db, base);
    // cross-org: same id, different org → null
    expect(await loadTemplateForSend(db, ORG2, id)).toBeNull();
    await archiveTemplate(db, id);
    expect(await loadTemplateForSend(db, ORG, id)).toBeNull();
    // still listed (archived flag), just not sendable
    const list = await listTemplates(db, ORG);
    expect(list).toHaveLength(1);
    expect(list[0].archived).toBe(true);
  });
});
