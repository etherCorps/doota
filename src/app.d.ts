import type { User, Session } from "better-auth/minimal";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Auth } from "$lib/server/auth.js";
import * as schema from "$lib/server/db/schema.js";

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
      user?: User;
      session?: Session;
      auth: Auth;
      db: DrizzleD1Database<typeof schema>;
    }

    // interface Error {}
    // interface PageData {}
    // interface PageState {}
  }
}

export {};
