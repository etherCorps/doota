import { form, getRequestEvent } from '$app/server';
import { getDiceBearURL } from '$lib/utils/dice-bear.js';
import { tryCatch } from '$lib/utils/try-catch.js';
import { registerSchema } from '$lib/shared/model/auth.zod.schema.js';
import { createAuth } from '$lib/server/auth.js';
import { isServedDomain } from '$lib/server/org-domains.js';
import { getDb } from '$lib/server/db';
import { user } from '$lib/server/db/schema.js';
import { APIError } from 'better-auth/api';

export const createAdminRemoteFunction = form(
	registerSchema,
	async ({ name, email, password }) => {
		const db = getDb(getRequestEvent().platform?.env.DB!);
		// Bootstrap only: the first user is the EXTERNAL super-admin (auto-assigned
		// the superadmin role via databaseHooks). Everyone else is provisioned by
		// an admin under an organization.
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

		// Kick off primary-email verification — the first onboarding step for the
		// external super-admin. Best-effort: a mail failure must not fail creation.
		await tryCatch(
			auth.api.sendVerificationEmail({
				body: { email, callbackURL: '/onboarding' }
			})
		);

		return {
			success: true,
			message:
				'Super-admin created. Check your email to verify it, then log in to finish setup (2FA / passkey).'
		};
	}
);
