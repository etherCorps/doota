// SPDX-License-Identifier: Apache-2.0
// Import chunk upload. The browser slices the mbox into PART_PLAINTEXT_BYTES
// pieces and POSTs them here one at a time; each lands as its own encrypted R2
// object. A whole archive can be gigabytes, far past the Worker request
// ceiling, so it can only arrive in pieces — and because the pieces are a fixed
// *plaintext* size, the job's byte cursor stays a simple integer.
//
// Chunks are not idempotent-by-content but are idempotent-by-index: re-POSTing
// part 7 overwrites part 7, so a retried chunk is safe.
import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey } from "@doota/mail-core/crypto";
import { putImportPart, PART_PLAINTEXT_BYTES } from "@doota/mail-core/import";
import { can } from "@doota/db/can";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
  const user = locals.user;
  if (!user) error(401, "Sign in first.");

  const importId = url.searchParams.get("importId");
  const index = Number(url.searchParams.get("index"));
  if (!importId || !Number.isInteger(index) || index < 0) error(400, "Bad chunk request.");

  const row = await locals.db.query.mailImport.findFirst({
    where: eq(schema.mailImport.id, importId),
  });
  if (!row) error(404, "Import not found.");

  // The uploader must still be allowed to write to this mailbox — an import is
  // a bulk write, so it gets the same gate a single write would.
  const grants = await locals.db.query.mailboxAccess.findMany({
    where: eq(schema.mailboxAccess.mailboxId, row.mailboxId),
  });
  const allowed = grants.some((grant) => grant.userId === user.id && grant.canManage);
  if (!allowed) error(403, "You can't import into this mailbox.");

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) error(400, "Empty chunk.");
  if (bytes.byteLength > PART_PLAINTEXT_BYTES) error(413, "Chunk is larger than the agreed part size.");

  const env = platform?.env;
  if (!env?.MAIL_RAW || !env?.MAIL_DEK) error(500, "Storage is not configured.");

  await putImportPart(locals.db, { MAIL_RAW: env.MAIL_RAW }, await importKey(env.MAIL_DEK), importId, index, bytes);
  return json({ ok: true, index });
};
