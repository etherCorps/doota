// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import {
  cleanStoredHtml,
  deleteSnippet as deleteSnippetRow,
  listSnippets,
  saveSnippet as saveSnippetRow,
  SNIPPET_BODY_MAX,
  SNIPPET_TITLE_MAX,
  type Snippet,
} from "@doota/mail-core/snippets";

/**
 * Canned responses ("snippets"). Per user, so there is no mailbox gate: the
 * only authorization is "signed in", and every read/write is scoped to the
 * caller's own rows inside @doota/mail-core/snippets. Not KV-cached — the list
 * is fetched when the picker opens, not on every compose, so D1 is fine.
 */

export type { Snippet };

function requireUser() {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.user;
}

/** The caller's snippets, A→Z by title. */
export const mySnippets = query(async (): Promise<Snippet[]> => {
  const { locals } = getRequestEvent();
  return listSnippets(locals.db, requireUser().id);
});

/** Create (no `id`) or update (`id`) a snippet. HTML is sanitized on write. */
export const saveSnippet = command(
  z.object({
    id: z.string().min(1).optional(),
    title: z.string().trim().min(1, "Give the snippet a title.").max(SNIPPET_TITLE_MAX),
    bodyHtml: z.string().max(SNIPPET_BODY_MAX),
  }),
  async ({ id, title, bodyHtml }): Promise<Snippet> => {
    const { locals } = getRequestEvent();
    const user = requireUser();
    const clean = cleanStoredHtml(bodyHtml);
    if (clean === null) error(400, "Snippet is too large.");
    if (!clean) error(400, "Write something for the snippet to insert.");
    const res = await saveSnippetRow(locals.db, user.id, { id, title, bodyHtml: clean });
    if (!res.ok) {
      if (res.reason === "duplicate-title") error(409, "You already have a snippet with that title.");
      if (res.reason === "limit") error(400, "You've reached the snippet limit — delete one to add another.");
      error(404, "That snippet no longer exists.");
    }
    return res.snippet;
  },
);

export const deleteSnippet = command(z.string().min(1), async (id) => {
  const { locals } = getRequestEvent();
  const user = requireUser();
  if (!(await deleteSnippetRow(locals.db, user.id, id))) error(404, "That snippet no longer exists.");
  return { id };
});
