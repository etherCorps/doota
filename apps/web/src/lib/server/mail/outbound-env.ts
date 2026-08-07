// SPDX-License-Identifier: Apache-2.0
import { error } from "@sveltejs/kit";
import { getRequestEvent } from "$app/server";
import type { OutboundEnv } from "@doota/mail-core/outbound";

/** The outbound bindings, or a 500 if the worker isn't send-configured. Shared
 * so callers (send.remote, RSVP reply) resolve them the same way — a remote
 * file can only export remote functions, so this can't live in send.remote. */
export function outboundEnv(): OutboundEnv {
  const env = getRequestEvent().platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) {
    error(500, "Outbound mail is not configured.");
  }
  return {
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
  };
}
