import { command, form, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { recoveryEmailSchema } from '$lib/shared/model/auth.zod.schema.js';
import { isServedDomain, senderAddress, domainOf } from '$lib/server/org-domains.js';
import { sendRecoveryEmailVerification } from '$lib/server/recovery-email.js';
import { tokenStore } from '$lib/server/auth/escape-hatches.js';
import * as schema from '$lib/server/db/schema.js';
import { tryCatch } from '$lib/utils/try-catch.js';

// One verification email per user per minute. This endpoint sends mail to an
// arbitrary external address, so without a throttle it could be used to bomb a
// third party. better-auth's rate limiter only covers its own routes, not this
// remote function, so the throttle lives here (reuses the verification table).
const THROTTLE_WINDOW_MS = 60_000;

export const setRecoveryEmail = form(recoveryEmailSchema, async ({ recoveryEmail }) => {
	const { locals, request } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');

	if (await isServedDomain(locals.db, recoveryEmail)) {
		return {
			success: false,
			message: 'Recovery email must be external — not on a domain this server hosts.'
		};
	}

	const throttleId = `recovery-email-throttle:${locals.user.id}`;
	if (await tokenStore.peek(throttleId)) {
		return {
			success: false,
			message: 'Please wait a minute before requesting another verification email.'
		};
	}

	// Self-update through auth.api: the user.update databaseHook re-asserts the
	// external-address rule and resets recoveryEmailVerified/At for the new address.
	const { error: updateError } = await tryCatch(
		locals.auth.api.updateUser({ body: { recoveryEmail }, headers: request.headers })
	);
	if (updateError) {
		return { success: false, message: 'Unable to update recovery email.' };
	}

	// Throttle marker only after a successful update (mirrors prior ordering).
	await tokenStore.issue(throttleId, '1', THROTTLE_WINDOW_MS);

	// Brand from the user's own org domain when its sending path is live.
	const from = await senderAddress(locals.db, domainOf(locals.user.email));
	await sendRecoveryEmailVerification(locals.user.id, recoveryEmail, from);
	return {
		success: true,
		message: 'Verification link sent. Check that inbox to confirm the address.'
	};
});

/**
 * DEFERRED super-admin email verification. The super-admin's external email is
 * intentionally unverified at genesis (no domain → no sending path). This action
 * becomes usable only once a domain is `active`, so the verification mail has a
 * real path out. Until then the CLI (reset-admin) is the recovery floor.
 */
export const requestSuperadminEmailVerification = command(async () => {
	const { locals } = getRequestEvent();
	const user = locals.user;
	if (!user) error(401, 'Not authenticated');
	if (user.role !== 'superadmin') error(403, 'Super-admin only');
	if ((user as { emailVerified?: boolean }).emailVerified) {
		return { success: false, message: 'Your email is already verified.' };
	}

	// Require a working sending path: at least one onboarded (active) domain.
	const active = await locals.db.query.organization.findFirst({
		where: eq(schema.organization.status, 'active'),
		columns: { id: true }
	});
	if (!active) {
		return {
			success: false,
			message: 'Onboard a domain first — there is no working sending path yet.'
		};
	}

	await tryCatch(
		locals.auth.api.sendVerificationEmail({
			body: { email: user.email, callbackURL: '/admin?verified=1' }
		})
	);
	return { success: true, message: 'Verification email sent. Check your external inbox.' };
});
