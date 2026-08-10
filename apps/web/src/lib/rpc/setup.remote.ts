// SPDX-License-Identifier: Apache-2.0
import { form, getRequestEvent } from '$app/server';
import { getDiceBearURL } from '$lib/utils/dice-bear.js';
import { tryCatch } from '$lib/utils/try-catch.js';
import { setupSchema } from '$lib/shared/model/auth.zod.schema.js';
import { createGenesisSuperadmin } from '$lib/server/auth/escape-hatches.js';
import { isServedDomain } from '@doota/db/org-domains';
import { getDb } from '@doota/db';
import { user } from '@doota/db/schema';
import { APIError } from 'better-auth/api';
import { SETUP_TOKEN } from '$app/env/private';

/**
 * First-run genesis wizard. Email-free: the super-admin's trust root is deploy
 * access (the one-time SETUP_TOKEN), not an email round-trip. At genesis no
 * domain is onboarded, so there is no path to deliver mail.
 *
 * Gated by both userCount === 0 and a matching SETUP_TOKEN. TOTP is enrolled
 * later via the onboarding secure-account step (or the CLI floor). No mail sent.
 */
export const setupRemoteFunction = form(
	setupSchema,
	async ({ name, email, password, setupToken }) => {
		if (!SETUP_TOKEN || setupToken !== SETUP_TOKEN) {
			return { success: false, message: 'Invalid or missing setup token.' };
		}

		const db = getDb(getRequestEvent().platform?.env.DB!);
		// Bootstrap only: the first user is the external super-admin (auto-assigned
		// the superadmin role via databaseHooks). Everyone else is provisioned by
		// an admin under an organization. This also permanently locks /setup out.
		const userCount = await db.$count(user);
		if (userCount > 0) {
			return {
				success: false,
				message: 'Setup already completed. Ask an admin to create your account.'
			};
		}

		// The super-admin is external: their login email must not be on a domain
		// this server hosts (at bootstrap there are no served domains yet).
		if (await isServedDomain(db, email)) {
			return {
				success: false,
				message: 'Use an external email address — not one on a domain this server hosts.'
			};
		}

		// Genesis account creation (createUser + password + rollback) is the one
		// sanctioned escape hatch — see createGenesisSuperadmin. Role is forced to
		// superadmin by the user.create databaseHook (first user).
		const { error: createError } = await tryCatch(
			createGenesisSuperadmin({
				name,
				email,
				password,
				image: getDiceBearURL({ seed: email })
			})
		);

		if (createError) {
			const message =
				createError instanceof APIError
					? (createError.body?.message as string)
					: 'Unable to create the super-admin. Check the server logs and try again.';
			return { success: false, message };
		}

		// No verification email — genesis is email-free. Next: log in, then the
		// onboarding gate forces securing the account (2FA / passkey).
		return {
			success: true,
			message: 'Super-admin created. Log in and secure your account (2FA / passkey) to finish setup.'
		};
	}
);
