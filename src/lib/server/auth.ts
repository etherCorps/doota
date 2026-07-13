import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { admin, lastLoginMethod } from 'better-auth/plugins';
import { getRequestEvent } from '$app/server';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { BETTER_AUTH_SECRET } from '$app/env/private';
import { ORIGIN } from '$app/env/public';

function buildAuth(db?: DrizzleD1Database<typeof schema>) {
  return betterAuth({
    user: {
      modelName: "user",
      additionalFields: {
        secondaryEmail: { type: "string", nullable: true },
      }
    },
		baseURL: ORIGIN,
		secret: BETTER_AUTH_SECRET,
    database: drizzleAdapter(db!, { provider: 'sqlite', schema }),
		emailAndPassword: { enabled: true, disableSignUp: true },
		session: {
			cookieCache: { enabled: true, maxAge: 60 * 5 }
		},
		plugins: [admin(), lastLoginMethod(), sveltekitCookies(getRequestEvent)] // sveltekitCookies must be last
	});
}

export type Auth = ReturnType<typeof buildAuth>;

let auth: Auth | undefined;

export function createAuth(db: DrizzleD1Database<typeof schema>) {
	return (auth ??= buildAuth(db));
}

/**
 * Do not use this export, it's only for better auth cli to generate schema.
 */
const authClientGen = buildAuth();
export default authClientGen;
