// SPDX-License-Identifier: Apache-2.0
import { defineCollection } from "astro:content";
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal("human").optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
  // Changelog is a docs-shaped collection with two extra fields. `date` drives
  // the reverse-chron sort + timeline marker; `tags` are opaque strings the
  // feed's filter derives its options from.
  changelog: defineCollection(
    docsCollection({
      base: "changelog",
      schemaFields: {
        date: z.coerce.date({
          error: (iss: { input: unknown }) =>
            iss.input === undefined
              ? 'Missing required "date" in changelog frontmatter (e.g. 2026-06-16).'
              : '"date" must be a valid date (e.g. 2026-06-16).',
        }),
        tags: z.array(z.string()).default([]),
      },
    }),
  ),
};
