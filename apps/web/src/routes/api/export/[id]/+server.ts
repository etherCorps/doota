// SPDX-License-Identifier: Apache-2.0
import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import type { RequestHandler } from "./$types";
import { verifyResourceToken } from "$lib/server/resource-token.js";
import { importKey, getDecryptedBlob } from "@doota/mail-core/crypto";
import { exportPartKey } from "@doota/mail-core/export";
import { log } from "@doota/mail-core/log";

/**
 * Capability-URL download for a finished mailbox export (build guide, Phase
 * 6). The token (minted by exportDownloadUrl, ~15 min TTL) is the sole
 * authorization — the link may be opened in a download manager without the
 * session cookie. Parts are stored encrypted at rest and decrypted here into
 * one streamed mbox: the download is plaintext by definition.
 */
export const GET: RequestHandler = async ({ params, url, locals, platform }) => {
  const env = platform?.env;
  const token = url.searchParams.get("token");
  const ok = await verifyResourceToken(env?.MAIL_SEARCH_KEY, `export:${params.id}`, token);
  if (!ok) error(403, "Invalid or expired download link.");

  const row = await locals.db.query.mailExport.findFirst({
    where: eq(schema.mailExport.id, params.id),
  });
  if (!row || row.status !== "done") error(404, "Export not found");
  if (!env?.MAIL_RAW || !env.MAIL_DEK) error(500, "Storage is not configured.");

  const ck = await importKey(env.MAIL_DEK);
  const bucket = env.MAIL_RAW;
  const { orgId, partCount, id } = row;
  log.warn("export.downloaded", { exportId: id, mailboxId: row.mailboxId });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let seq = 1; seq <= partCount; seq++) {
          const buf = await getDecryptedBlob(bucket, exportPartKey(orgId, id, seq), ck);
          if (buf) controller.enqueue(new Uint8Array(buf));
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/mbox",
      "Content-Disposition": `attachment; filename="doota-export-${id}.mbox"`,
      "Cache-Control": "no-store",
    },
  });
};
