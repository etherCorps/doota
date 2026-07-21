import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Auth } from "$lib/server/auth.js";

type SessionData = Auth["$Infer"]["Session"];
import * as schema from "@doota/db/schema";
import type { OnboardingStatus } from "$lib/server/onboarding.js";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  // Instance secrets (Worker secrets, not in wrangler.jsonc so `wrangler types`
  // can't see them): the content DEK and the blind-search HMAC key. Never in D1.
  interface Env {
    MAIL_DEK: string;
    MAIL_SEARCH_KEY: string;
    /** Bearer secret the cron trigger presents to POST /api/cron. */
    CRON_SECRET?: string;
  }

  namespace App {
    interface Platform {
      env: Env;
      ctx: ExecutionContext;
      caches: CacheStorage;
      cf?: IncomingRequestCfProperties;
    }

    interface Locals {
      user?: SessionData["user"];
      session?: SessionData["session"];
      auth: Auth;
      db: DrizzleD1Database<typeof schema>;
      /** Set by hooks only when the user still has onboarding steps left. */
      onboarding?: OnboardingStatus;
    }

    // interface Error {}
    // interface PageData {}
    // interface PageState {}
  }
}

export {};
