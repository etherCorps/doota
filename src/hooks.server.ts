import type { Handle } from "@sveltejs/kit";
import { building } from "$app/env";
import { createAuth } from "$lib/server/auth.js";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "$lib/server/db/schema.js";

const handleBetterAuth: Handle = async ({ event, resolve }) => {
  if (building) return resolve(event);

  const env = event.platform?.env;
  if (!env?.DB) {
    throw new Error(
      'D1 binding "DB" is missing. Run dev via `npm run dev` (platformProxy) after applying local migrations.',
    );
  }

  const db = drizzle(env.DB, { schema });

  const auth = createAuth(db);

  event.locals.db = db;
  event.locals.auth = auth;

  const session = await auth.api.getSession({ headers: event.request.headers });

  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;
  }

  return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
