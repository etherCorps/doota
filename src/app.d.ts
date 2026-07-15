import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Auth } from "$lib/server/auth.js";

type SessionData = Auth["$Infer"]["Session"];
import * as schema from "$lib/server/db/schema.js";
import type { OnboardingStatus } from "$lib/server/onboarding.js";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
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
