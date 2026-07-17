import { form, getRequestEvent } from '$app/server';
import { getDiceBearURL } from '$lib/utils/dice-bear.js';
import { tryCatch } from '$lib/utils/try-catch.js';
import { setupSchema } from '$lib/shared/model/auth.zod.schema.js';
import { createAuth } from '$lib/server/auth.js';
import { isServedDomain } from '$lib/server/org-domains.js';
import { getDb } from '$lib/server/db';
import { user } from '$lib/server/db/schema.js';
import { APIError } from 'better-auth/api';
import { SETUP_TOKEN } from '$app/env/private';

/**
 * First-run genesis wizard. Email-free by design: the super-admin's trust root
 * is deploy access (the one-time SETUP_TOKEN), never an email round-trip — at
 * genesis no domain is onboarded, so there is no path to deliver mail.
 *
 * Gated by BOTH userCount === 0 AND a matching SETUP_TOKEN. TOTP is enrolled
 * later via the onboarding secure-account step (or the CLI floor). No mail sent.
 */
export const setupRemoteFunction = form(
	setupSchema,
	async ({ name, email, password, setupToken }) => {
		if (!SETUP_TOKEN || setupToken !== SETUP_TOKEN) {
			return { success: false, message: 'Invalid or missing setup token.' };
		}

		const db = getDb(getRequestEvent().platform?.env.DB!);
		// Bootstrap only: the first user is the EXTERNAL super-admin (auto-assigned
		// the superadmin role via databaseHooks). Everyone else is provisioned by
		// an admin under an organization. This also permanently locks /setup out.
		const userCount = await db.$count(user);
		if (userCount > 0) {
			return {
				success: false,
				message: 'Setup already completed. Ask an admin to create your account.'
			};
		}

		// The super-admin is external: their login email must NOT be on a domain
		// this server hosts (at bootstrap that is just the system MAIL_DOMAIN).
		if (await isServedDomain(db, email)) {
			return {
				success: false,
				message: 'Use an external email address — not one on a domain this server hosts.'
			};
		}

		const auth = createAuth(db);
		const authCtx = await auth.$context;
		const internalAdapter = authCtx.internalAdapter;

		const { error: createError, data: createdUser } = await tryCatch(
			internalAdapter.createUser({
				email,
				name,
				image: getDiceBearURL({ seed: email }),
				createdAt: new Date(),
				updatedAt: new Date()
			})
		);

		if (createError || !createdUser) {
			const message =
				createError instanceof APIError
					? (createError.body?.message as string)
					: 'Unable to create the super-admin. Check the server logs and try again.';
			return { success: false, message };
		}

		// Password lives on the credential account, not the user row. If this
		// fails we must remove the just-created user, otherwise the userCount
		// guard wedges the bootstrap on retry (orphaned, passwordless admin).
		const { error: linkError } = await tryCatch(
			internalAdapter.linkAccount({
				providerId: 'credential',
				accountId: createdUser.id,
				userId: createdUser.id,
				password: await authCtx.password.hash(password)
			})
		);

		if (linkError) {
			await tryCatch(internalAdapter.deleteUser(createdUser.id));
			const message =
				linkError instanceof APIError
					? (linkError.body?.message as string)
					: 'Unable to set the super-admin password. The partial account was rolled back — please try again.';
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
